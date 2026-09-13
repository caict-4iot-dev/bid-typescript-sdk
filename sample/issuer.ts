import {
  configureBidSdk,
  createBidSdk,
  parseApplyNo,
  ISSUER_PORTAL_ROUTES,
  type PlatformSession,
  type VcIssuer,
  type VcSigner,
} from "../src/index.js"
import type { VcPlatformClient } from "../src/vc/vc-platform.js"
import {
  appendIssuance,
  loadIssuanceByCredential,
  loadIssuances,
  writeTemplate,
} from "./issuer-files.js"

/**
 * 发证方示例 CLI。
 * 用法：npm run sample:issuer -- <command> [--key=value]
 *
 * 命令：
 *   login        验证发证方身份可登录平台（快速自检）
 *   industries   查询行业字典（创建模板需要 industryId）
 *   categories   查询凭证类别字典（创建模板需要 categoryId）
 *   template     创建模板（blob→本地签名→submit，返回 templateBid；需超级节点审核）
 *   templates    查询名下模板列表（auditStatus：0 待审/1 通过/2 拒绝）
 *   pending      查询待审核的持证方申请（拿到 applyNo）
 *   approve      审核通过并签发凭证（保存签发记录供撤销使用）
 *   reject       拒绝申请
 *   issued       查询已签发凭证列表
 *   revoke       撤销凭证（从签发记录取 credentialBid）
 *   help         显示帮助
 *
 * 发证方身份需已在平台完成发证方注册（准入流程在 sample 之外）；
 * 签发/撤销/建模板的链上交易由平台中转广播（本地只做授权签名），
 * 因此本 sample 只依赖 VC 平台 HTTP 接口，不直连链节点。
 * 发证方账户需保持激活、有星火令余额（中转交易的燃料费记在发证方账户上）。
 * 每个命令用 .env.issuer 的私钥重新登录，accessToken 不持久化。
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

function readOption(options: Readonly<Record<string, string>>, name: string): string | undefined {
  const value = options[name]
  return value === undefined || value === "" ? undefined : value
}

function printSection(title: string): void {
  console.log(`\n===== ${title} =====`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// ---------- SDK / 登录 ----------

function configureIssuerSdk(): void {
  const vcPlatformUrl = process.env["VC_PLATFORM_BASE_URL"]
  if (vcPlatformUrl === undefined || vcPlatformUrl === "") {
    fail("缺少 VC_PLATFORM_BASE_URL：请在 .env.issuer 里填写平台登录主机根地址（不含 /server）")
  }
  const vcCredentialUrl = process.env["VC_CREDENTIAL_BASE_URL"]
  configureBidSdk({
    vcPlatformUrl,
    ...(vcCredentialUrl === undefined || vcCredentialUrl === "" ? {} : { vcCredentialUrl }),
  })
}

async function requireIssuerKey(): Promise<{ bid: string; privateKey: string }> {
  const privateKey = process.env["VC_ISSUER_PRIVATE_KEY"]
  if (privateKey === undefined || privateKey === "") {
    fail("缺少 VC_ISSUER_PRIVATE_KEY：请在 .env.issuer 里填写发证方自己的私钥（其 BID 已在平台注册为发证方）")
  }
  const sdk = createBidSdk()
  const signer: VcSigner = sdk.vc.signer.fromPrivateKey(privateKey)
  return { bid: signer.address, privateKey }
}

async function setup(): Promise<{ platform: VcPlatformClient; issuer: VcIssuer; session: PlatformSession; bid: string; privateKey: string }> {
  configureIssuerSdk()
  const { bid, privateKey } = await requireIssuerKey()
  const sdk = createBidSdk()
  // 发证方门户路由组：业务接口走网关 /api/omp/credential/*，
  // 登录为两步（平台挑战登录 → sp/user/login 令牌交换）。
  const platform = sdk.vc.platform.create({ routes: ISSUER_PORTAL_ROUTES })
  const issuer = sdk.vc.issuer.create(platform)
  const signer = sdk.vc.signer.fromPrivateKey(privateKey)
  const session = await platform.loginAsIssuerPortal({ bid, signer })
  return { platform, issuer, session, bid, privateKey }
}

// ---------- 命令 ----------

async function cmdLogin(): Promise<void> {
  printSection("发证方登录自检")
  const { session, bid } = await setup()
  console.log({ bid, login: "ok", accessTokenPreview: `${session.accessToken.slice(0, 8)}...`, expiresIn: session.expiresIn })
}

async function cmdIndustries(): Promise<void> {
  printSection("行业字典（创建模板需要 industryId）")
  const { issuer, session } = await setup()
  console.log(JSON.stringify(await issuer.listIndustries(session), null, 2))
}

async function cmdCategories(): Promise<void> {
  printSection("凭证类别字典（创建模板需要 categoryId）")
  const { issuer, session } = await setup()
  console.log(JSON.stringify(await issuer.listCategories(session), null, 2))
}

async function cmdTemplate(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("创建模板")
  const name = readOption(options, "name")
  const industryId = readOption(options, "industry-id")
  const categoryId = readOption(options, "category-id")
  const version = readOption(options, "version") ?? "1.0.0"
  const data = readOption(options, "data") ?? JSON.stringify([{ key: "name", label: "姓名", format: "String", type: "3" }])
  const userType = readOption(options, "user-type") ?? "0"
  const remark = readOption(options, "remark")
  if (name === undefined) fail("缺少 --name=<模板名称>")
  if (industryId === undefined) fail("缺少 --industry-id=<行业ID>（先运行 industries 查询）")
  if (categoryId === undefined) fail("缺少 --category-id=<类别ID>（先运行 categories 查询）")
  const { issuer, session, bid, privateKey } = await setup()
  const sdk = createBidSdk()
  const signer = sdk.vc.signer.fromPrivateKey(privateKey)
  const created = await issuer.createTemplate(session, {
    issuer: { bid, signer },
    name,
    industryId,
    categoryId,
    version,
    data,
    userType,
    ...(remark === undefined ? {} : { remark }),
  })
  const path = await writeTemplate({ templateBid: created.templateBid, name, createdAt: new Date().toISOString() })
  console.log({ templateBid: created.templateBid, templateFile: path })
  console.log("模板需超级节点审核通过（auditStatus=1）后，持证方才能对它申请凭证；可用 templates 命令查看审核状态。")
}

async function cmdTemplates(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("名下模板列表（auditStatus：0 待审 / 1 通过 / 2 拒绝）")
  const auditStatus = readOption(options, "audit-status")
  const parsedAuditStatus = auditStatus === undefined ? undefined : Number(auditStatus)
  if (parsedAuditStatus !== undefined && !Number.isInteger(parsedAuditStatus)) fail("--audit-status 必须是整数")
  const { issuer, session } = await setup()
  const result = await issuer.listTemplates(session, {
    pageStart: 1,
    pageSize: Number(readOption(options, "page-size") ?? "20"),
    ...(parsedAuditStatus === undefined ? {} : { auditStatus: parsedAuditStatus }),
  })
  console.log(JSON.stringify(result, null, 2))
}

async function cmdPending(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("待审核的持证方申请（status=1）")
  const { issuer, session } = await setup()
  const result = await issuer.listApplications(session, {
    status: [1],
    pageStart: 1,
    pageSize: Number(readOption(options, "page-size") ?? "20"),
  })
  console.log(JSON.stringify(result, null, 2))
}

async function cmdApprove(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("审核通过并签发凭证")
  const applyNo = readOption(options, "apply-no")
  if (applyNo === undefined) fail("缺少 --apply-no=<申请编号>（先运行 pending 查询）")
  const reason = readOption(options, "reason")
  const isSelOption = readOption(options, "is-sel")
  if (isSelOption !== undefined && isSelOption !== "0" && isSelOption !== "1") fail("--is-sel 只能是 0 或 1")
  const isSel = isSelOption === undefined ? undefined : (Number(isSelOption) as 0 | 1)
  const auditContentOverride = readOption(options, "audit-content")
  const { issuer, session, bid, privateKey } = await setup()
  const sdk = createBidSdk()
  const signer = sdk.vc.signer.fromPrivateKey(privateKey)

  // 默认透传申请单里持证方填写的表单内容作为 auditContent。
  let auditContent = auditContentOverride
  if (auditContent === undefined) {
    const detail = await issuer.getApplicationDetail(session, { applyNo }) as Readonly<Record<string, unknown>>
    const content = detail["content"]
    if (typeof content === "string" && content !== "") auditContent = content
  }

  const issued = await issuer.issue(session, {
    issuer: { bid, signer },
    applyNo: parseApplyNo(applyNo),
    status: 2,
    ...(isSel === undefined ? {} : { isSel }),
    ...(reason === undefined ? {} : { reason }),
    ...(auditContent === undefined ? {} : { auditContent }),
  })
  if (issued.credentialId === undefined) {
    console.log({ payloadId: issued.payloadId, note: "平台未返回 certBid；撤销前请用 issued 命令确认凭证 BID" })
    return
  }
  const path = await appendIssuance({
    applyNo,
    credentialBid: issued.credentialId,
    payloadId: issued.payloadId,
    createdAt: new Date().toISOString(),
  })
  console.log({ credentialBid: issued.credentialId, payloadId: issued.payloadId, issuanceFile: path })
  console.log("签发记录已保存；持证方可运行 download/export，撤销用 revoke --credential=<凭证BID>。")
}

async function cmdReject(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("拒绝申请")
  const applyNo = readOption(options, "apply-no")
  if (applyNo === undefined) fail("缺少 --apply-no=<申请编号>（先运行 pending 查询）")
  const reason = readOption(options, "reason")
  const { issuer, session, bid, privateKey } = await setup()
  const sdk = createBidSdk()
  const signer = sdk.vc.signer.fromPrivateKey(privateKey)
  await issuer.reject(session, {
    issuer: { bid, signer },
    applyNo: parseApplyNo(applyNo),
    ...(reason === undefined ? {} : { reason }),
  })
  console.log({ applyNo, status: "3（已拒绝）" })
}

async function cmdIssued(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("已签发凭证列表（status=2）")
  const { issuer, session } = await setup()
  const result = await issuer.listApplications(session, {
    status: [2],
    pageStart: 1,
    pageSize: Number(readOption(options, "page-size") ?? "20"),
  })
  console.log(JSON.stringify(result, null, 2))
}

async function cmdRevoke(options: Readonly<Record<string, string>>): Promise<void> {
  printSection("撤销凭证")
  const credential = readOption(options, "credential")
  const remark = readOption(options, "remark")
  const credentialBid = credential ?? (await latestIssuedCredentialBid())
  const record = await loadIssuanceByCredential(credentialBid)
  if (record === undefined) {
    console.log(`本地没有 ${credentialBid} 的签发记录；直接按 credentialBid 撤销（平台按链上记录定位）。`)
  }
  const { issuer, session, bid, privateKey } = await setup()
  const sdk = createBidSdk()
  const signer = sdk.vc.signer.fromPrivateKey(privateKey)
  await issuer.revoke(session, {
    issuer: { bid, signer },
    credentialBid,
    ...(remark === undefined ? {} : { remark }),
  })
  console.log({ credentialBid, revoked: true })
}

async function latestIssuedCredentialBid(): Promise<string> {
  const issuances = await loadIssuances()
  const latest = issuances.at(-1)
  if (latest === undefined) {
    fail("没有可撤销的凭证：请用 --credential=<凭证BID> 指定，或先运行 approve 产生签发记录")
  }
  return latest.credentialBid
}

// ---------- 入口 ----------

const commands: Readonly<Record<string, (options: Readonly<Record<string, string>>) => Promise<void>>> = {
  login: cmdLogin,
  industries: cmdIndustries,
  categories: cmdCategories,
  template: cmdTemplate,
  templates: cmdTemplates,
  pending: cmdPending,
  approve: cmdApprove,
  reject: cmdReject,
  issued: cmdIssued,
  revoke: cmdRevoke,
}

function printHelp(): void {
  console.error("用法：npm run sample:issuer -- <command> [--key=value]")
  console.error("命令：login | industries | categories | template | templates | pending | approve | reject | issued | revoke | help")
  console.error("常用参数：--apply-no=... --credential=<凭证BID> --name=... --industry-id=... --category-id=... --data='[...]' --user-type=0 --is-sel=1 --reason=... --remark=...")
  console.error("配置：.env.issuer 设置 VC_ISSUER_PRIVATE_KEY / VC_PLATFORM_BASE_URL（可选 VC_CREDENTIAL_BASE_URL）")
}

async function main(argv: readonly string[]): Promise<void> {
  const { positionals, options } = parseArgs(argv)
  const command = positionals[0]
  if (command === undefined || command === "help") {
    printHelp()
    process.exit(command === "help" ? 0 : 1)
    return
  }
  const run = commands[command]
  if (run === undefined) {
    printHelp()
    process.exit(1)
  }
  await run(options)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
