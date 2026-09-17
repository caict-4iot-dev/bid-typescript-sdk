import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  configureBidSdk,
  createBidSdk,
  createSelectiveDisclosurePresentation,
  parseApplyNo,
  parseCredentialId,
  parseJws,
  vcPayloadSchema,
  type PlatformSession,
  type TemplateDetailInput,
  type VcHolder,
  type VcPayload,
  type VcSigner,
} from "../src/index.js"
import type { VcPlatformClient } from "../src/vc/vc-platform.js"
import {
  holderApplicationPath,
  holderCredentialPath,
  holderIdentityPath,
  loadApplication,
  loadLatestCredential,
  type HolderCredentialFile,
  writeApplication,
  writeCredential,
  writeIdentity,
  writePresentation,
} from "./holder-files.js"
import { formatTemplateGuide } from "./holder-template.js"

/**
 * 持证方示例 CLI。
 * 用法：npm run sample:holder -- <command> [--key=value]
 *
 * 命令：
 *   generate        生成持证方公私钥并保存身份文件
 *   list            查询可申请的普通凭证（type=2，持证方凭证）
 *   template        查询模板详情：申请字段与可复制的 --subject 示例
 *   apply           申请凭证（templateDetail + assert + apply；缺 --subject 时打印字段指引后退出）
 *   status          查看申请进度
 *   download        下载已签发凭证
 *   export          导出凭证文件并打印绝对路径（--disclose=key1,key2 生成选择性披露版）
 *   help            显示帮助
 *
 * 每个命令都从身份文件读取私钥并重新登录平台，accessToken 不持久化。
 * generate/list/apply/status/download 需要网络与平台登录；export 是纯本地操作，
 * 只读取已下载的凭证文件并写出示文件，不访问平台。
 * 身份文件是明文私钥，仅供本地演示；sample/output 已加入 .gitignore。
 * 真实环境联调：持证方只依赖 VC 平台 HTTP 接口，不写链、不解析、不验证，
 * 因此只需在 .env.holder 配置 VC_PLATFORM_BASE_URL 主机根地址，不要包含 /server；
 * SDK 内部固定拼接 server/... 路由（凭证接口缺省复用同一地址）。
 * 请勿把真实私钥/API Key 提交到 git。
 */

type ParsedArgs = {
  readonly positionals: readonly string[]
  readonly options: Readonly<Record<string, string>>
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const options: Record<string, string> = {}
  for (const item of argv) {
    const match = /^--([a-zA-Z0-9-]+)=(.*)$/.exec(item)
    if (match !== null) {
      options[match[1]!] = match[2]!
    } else {
      positionals.push(item)
    }
  }
  return { positionals, options }
}

function readOption(options: Readonly<Record<string, string>>, name: string, envName?: string): string | undefined {
  const value = options[name] ?? (envName === undefined ? undefined : process.env[envName])
  return value === undefined || value === "" ? undefined : value
}

function requireFile(filePath: string, hint: string): void {
  if (!existsSync(filePath)) {
    console.error(`缺少文件：${filePath}\n提示：${hint}`)
    process.exit(1)
  }
}

function printSection(title: string): void {
  console.log(`\n===== ${title} =====`)
}

// ---------- SDK / 登录 ----------

async function setupHolder(): Promise<{ platform: VcPlatformClient; holder: VcHolder }> {
  configureHolderSdk()
  const sdk = createBidSdk()
  const platform = sdk.vc.platform.create()
  const holder = sdk.vc.holder.create(platform)
  return { platform, holder }
}

/** 持证方只需 VC 平台主机根地址，不要包含 /server；平台路由由 SDK 内部固定。 */
function configureHolderSdk(): void {
  const vcPlatformUrl = process.env["VC_PLATFORM_BASE_URL"]
  if (vcPlatformUrl === undefined || vcPlatformUrl === "") {
    console.error("缺少 VC_PLATFORM_BASE_URL：请在 .env.holder 里填写VC 平台主机根地址")
    process.exit(1)
  }
  configureBidSdk({ vcPlatformUrl })
}

async function loginAndSigner(platform: VcPlatformClient, privateKey: string): Promise<{ session: PlatformSession; signer: VcSigner }> {
  const sdk = createBidSdk()
  const signer = sdk.vc.signer.fromPrivateKey(privateKey)
  const session = await platform.login({ bid: signer.address, signer })
  return { session, signer }
}

async function requireIdentity(): Promise<{ bid: string; publicKey: string; privateKey: string }> {
  requireFile(holderIdentityPath, "请先运行 npm run sample:holder -- generate")
  const raw = await readFile(holderIdentityPath, "utf8")
  return JSON.parse(raw) as { bid: string; publicKey: string; privateKey: string; createdAt: string }
}

async function loadStoredApplyNo(): Promise<string> {
  requireFile(holderApplicationPath, "请先运行 npm run sample:holder -- apply")
  const app = await loadApplication()
  return app.applyNo
}

// ---------- 命令 ----------

async function cmdGenerate(): Promise<void> {
  printSection("生成持证方身份")
  const sdk = createBidSdk()
  const keypair = sdk.keypair.generate()
  const identity = {
    bid: keypair.address,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    createdAt: new Date().toISOString(),
  }
  const path = await writeIdentity(identity)
  console.log({ bid: identity.bid, publicKey: identity.publicKey, identityFile: path })
  console.log("身份已保存，后续命令会自动读取该文件并重新登录。")
}

async function cmdList(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("查询可申请凭证（type=2，SDK 固定持证方普通凭证）")
  const identity = await requireIdentity()
  const { platform, holder } = await setupHolder()
  const { session } = await loginAndSigner(platform, identity.privateKey)
  const pageSize = Number(readOption(options, "page-size") ?? "20")
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    console.error("page-size 必须是正整数")
    process.exit(1)
  }
  const list = await holder.listRecommendedCredentials(session, {
    pageStart: 1,
    pageSize,
  })
  console.log(JSON.stringify(list, null, 2))
}

function readSubject(options: Readonly<Record<string, string>>, guide: string): Record<string, string | number | boolean> {
  const raw = readOption(options, "subject")
  if (raw === undefined) {
    console.error("缺少 --subject：请按下方模板字段构造申请主体后重新执行 apply。")
    console.error(guide)
    console.error("注意：Windows PowerShell 下不要通过 npm run 传 JSON（引号会被剥掉），请直接执行 node --env-file=.env.holder --import tsx sample/holder.ts apply ...")
    process.exit(1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error("--subject 不是合法 JSON。若是 PowerShell/npm 剥掉了引号（如 {name:Alice}），请直接执行 node 命令，见上方说明。")
    process.exit(1)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("--subject 必须是 JSON 对象")
    process.exit(1)
  }
  const record = parsed as Record<string, string | number | boolean>
  if (Object.keys(record).length === 0) {
    console.error("--subject 不能是空对象：平台模板要求具体申请字段（attributes 结构），空对象会让服务端构建凭证时崩溃。")
    process.exit(1)
  }
  return record
}

/** 登录后查询模板详情并生成申请指引（--lang 可选，透传平台语言参数）。 */
async function fetchTemplateGuide(holder: VcHolder, session: PlatformSession, input: TemplateDetailInput): Promise<string> {
  const detail = await holder.getTemplate(session, input)
  return formatTemplateGuide(detail)
}

async function cmdApply(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("申请凭证")
  const identity = await requireIdentity()
  const templateId = readOption(options, "template-id")
  if (templateId === undefined) {
    console.error("缺少 templateId：请用 --template-id=... 指定申请模板")
    process.exit(1)
  }
  const hold = readOption(options, "hold") === "1" ? "1" : undefined
  const lang = readOption(options, "lang")
  const { platform, holder } = await setupHolder()
  const { session } = await loginAndSigner(platform, identity.privateKey)
  // 申请前先查模板：用户按真实字段构造 --subject，而不是猜 key。
  const guide = await fetchTemplateGuide(holder, session, { templateId, ...(lang === undefined ? {} : { lang }) })
  console.log(guide)
  const subject = readSubject(options, guide)
  await holder.assertApplication(session, { templateId, ...(hold === undefined ? {} : { hold }) })
  const applyNo = await holder.applyCredential(session, {
    templateId,
    subject,
  })
  const application = { applyNo, templateId, hold: hold === "1" ? 1 : 0, createdAt: new Date().toISOString() }
  const path = await writeApplication(application)
  console.log({ applyNo, applicationFile: path })
}

async function cmdTemplate(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("查询凭证模板字段")
  const identity = await requireIdentity()
  const templateId = readOption(options, "template-id")
  if (templateId === undefined) {
    console.error("缺少 templateId：请用 --template-id=... 指定模板（可先用 list 查看可申请模板）")
    process.exit(1)
  }
  const lang = readOption(options, "lang")
  const { platform, holder } = await setupHolder()
  const { session } = await loginAndSigner(platform, identity.privateKey)
  const guide = await fetchTemplateGuide(holder, session, { templateId, ...(lang === undefined ? {} : { lang }) })
  console.log(guide)
}

const statusEnumMap: Readonly<Record<string, string>> = {
  "1": "申请中",
  "2": "已通过",
  "3": "已拒绝",
}

function formatStatus(status: { readonly status: string; readonly credentialId?: string | undefined }): string {
  return JSON.stringify({
    applyStatus: status.status,
    applyStatusText: statusEnumMap[status.status] ?? "未知",
    credentialId: status.credentialId,
  }, null, 2)
}

async function cmdStatus(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("查看申请进度")
  const identity = await requireIdentity()
  const applyNo = readOption(options, "apply-no") ?? await loadStoredApplyNo()
  const { platform, holder } = await setupHolder()
  const { session } = await loginAndSigner(platform, identity.privateKey)
  const status = await holder.getApplicationStatus(session, parseApplyNo(applyNo))
  console.log(formatStatus(status))
}

async function cmdDownload(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("下载凭证")
  const identity = await requireIdentity()
  const applyNo = readOption(options, "apply-no") ?? await loadStoredApplyNo()
  const { platform, holder } = await setupHolder()
  const { session } = await loginAndSigner(platform, identity.privateKey)
  const status = await holder.getApplicationStatus(session, parseApplyNo(applyNo))
  const credentialId = readOption(options, "credential-id") ?? status.credentialId
  if (credentialId === undefined) {
    console.error("申请尚未签发成功（没有 credentialId），无法下载。请确认审核状态后再试。")
    process.exit(1)
  }
  const downloaded = await holder.downloadCredential(session, { credentialId: parseCredentialId(credentialId) })
  const parsed = holder.parseCredential(downloaded.jws)
  if (parsed.credential.id !== credentialId) {
    throw new Error("平台返回的凭证编号与 JWS 内容不一致，拒绝保存")
  }
  const credential: HolderCredentialFile = {
    credentialId: parsed.credential.id,
    jws: downloaded.jws,
  }
  const path = await writeCredential(credential)
  console.log({ credentialId, issueBid: downloaded.issueBid, issueName: downloaded.issueName, file: path })
}

async function loadLatestCredentialWithPath(): Promise<{ filePath: string; credential: HolderCredentialFile }> {
  const credential = await loadLatestCredential()
  const filePath = holderCredentialPath(credential.credentialId)
  requireFile(filePath, "请先运行 npm run sample:holder -- download")
  return { filePath, credential }
}

/** credentialSubject 中除 id 外的可披露字段名列表。 */
function disclosableFields(payload: VcPayload): string[] {
  return Object.entries(payload.credentialSubject)
    .filter(([key, value]) => key !== "id" && typeof value === "object" && value !== null && !Array.isArray(value) && "hash" in value)
    .map(([key]) => key)
}

/**
 * 校验 --disclose 字段列表：
 *  - 必须都是凭证里实际存在的选择性披露字段；
 *  - 值为空（未填）的字段无法披露。
 */
function resolveDiscloseList(payload: VcPayload, option: string | undefined): string[] | undefined {
  if (option === undefined) return undefined
  const requested = option.split(",").map((item) => item.trim()).filter((item) => item !== "")
  if (requested.length === 0) return undefined
  const available = disclosableFields(payload)
  const unknown = requested.filter((key) => !available.includes(key))
  if (unknown.length > 0) {
    console.error(`--disclose 中的字段不在凭证可选择披露字段里：${unknown.join(", ")}；可披露字段：${available.join(", ") || "（无）"}`)
    process.exit(1)
  }
  const empty = requested.filter((key) => {
    const field = payload.credentialSubject[key] as { value?: unknown } | undefined
    return field?.value === undefined || field?.value === ""
  })
  if (empty.length > 0) {
    console.error(`以下字段值为空，无法披露：${empty.join(", ")}`)
    process.exit(1)
  }
  return requested
}

async function cmdExport(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("导出凭证")
  const { filePath, credential } = await loadLatestCredentialWithPath()
  // 与平台钱包/插件导出的标准 VC 信封保持一致（参考 demo.json）：
  // proof.jwt 是原始三段式 compact JWS，其余字段来自 VC payload 的公开部分。
  let jws = credential.jws
  const fullPayload = vcPayloadSchema.parse(parseJws(jws).payload)
  const disclose = resolveDiscloseList(fullPayload, readOption(options, "disclose"))
  if (disclose !== undefined) {
    // 选择性披露：未选中的字段只保留 hash（值与盐不进入出示 JWS），复用发行方原签名。
    jws = createSelectiveDisclosurePresentation(jws, disclose)
    console.log(`选择性披露字段：${disclose.join(", ")}`)
    console.log(`未披露字段（仅保留 hash）：${disclosableFields(fullPayload).filter((key) => !disclose.includes(key)).join(", ") || "（无）"}`)
  }
  const payload = vcPayloadSchema.parse(parseJws(jws).payload)
  const presentation = {
    "@context": payload["@context"],
    credentialSubject: payload.credentialSubject as Record<string, unknown>,
    issuer: { id: payload.issuer },
    ...(payload.validBefore === undefined ? {} : { validBefore: payload.validBefore }),
    type: payload.type,
    issuanceDate: payload.issuanceDate,
    proof: { type: "JwtProof2020" as const, jwt: jws },
  }
  const path = await writePresentation(presentation)
  console.log({ sourceFile: filePath, presentationFile: path })
  console.log(`绝对路径：${resolve(path)}`)
}

// ---------- 入口 ----------

const commands: Readonly<Record<string, (options: Readonly<Record<string, string>>) => Promise<void>>> = {
  generate: cmdGenerate,
  list: cmdList,
  template: cmdTemplate,
  apply: cmdApply,
  status: cmdStatus,
  download: cmdDownload,
  export: cmdExport,
}

function printHelp(): void {
  console.error("用法：npm run sample:holder -- <command> [--key=value]")
  console.error("命令：generate | list | template | apply | status | download | export | help")
  console.error("常用参数：--page-size=... --template-id=... --lang=... --subject='{\"key\":\"value\"}' --hold=1 --apply-no=... --credential-id=... --disclose=key1,key2")
  console.error("配置：在 .env.holder 设置不含 /server 的 VC_PLATFORM_BASE_URL 主机根地址；平台路由由 SDK 固定")
  console.error("export --disclose 只披露指定字段（其余字段仅保留 hash），生成的出示信封仍可用 verifier sample 验证")
}

async function main(argv: readonly string[]): Promise<void> {
  const { positionals, options } = parseArgs(argv)
  const command = positionals[0]
  const run = command === undefined || command === "help" ? undefined : commands[command]
  if (run === undefined) {
    printHelp()
    process.exit(command === "help" ? 0 : 1)
  }
  await run(options)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
