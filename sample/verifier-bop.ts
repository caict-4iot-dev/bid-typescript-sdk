import { readFile } from "node:fs/promises"

import { z } from "zod"

import { configureBidSdk, createBidSdk } from "../src/index.js"
import { verifyPresentationConsistency } from "../src/vc/vc-presentation.js"

/**
 * 本地验证方示例 CLI（开放平台 BOP 版）。
 * 用法：npm run sample:verifier-bop -- --file=sample/output/holder-presentation.json
 *
 * 与直连版 verifier.ts 使用同一套本地核验逻辑（format/issuerTrust/issuerSignature/
 * validity/disclosure/revocation 与 verified 判定共用同一实现），区别仅在传输层：
 * 本 sample 通过开放平台（BOP）查询 IAM/TDS 信任与 DDO 合约中的 issuer DID 公钥，
 * 撤销状态仍查询发证方平台地址（VC_REVOCATION_BASE_URL）。
 *
 * 输入可以是：
 *  - 标准 VC 信封 JSON（export 输出，如 holder-presentation.json），从中读取 proof.jwt；
 *  - 三段式 compact JWS 文本文件（holder-credential-<id>.jws）。
 * 不从环境变量读取凭证、私钥或 issuer 公钥。
 * 撤销检查是在线 issuer-service 状态，不是独立的链上状态证明。
 */

const presentationEnvelopeSchema = z.object({
  proof: z.object({
    jwt: z.string().trim().min(1, "jwt must be a non-empty string"),
  }),
}).passthrough()

function printHelp(): void {
  console.error("用法：npm run sample:verifier-bop -- --file=<holder-presentation.json|holder-credential-<id>.jws>")
  console.error("配置：在 .env.verifier 设置 BID_BOP_URL、BID_BOP_API_KEY、BID_BOP_API_SECRET 与 VC_REVOCATION_BASE_URL；保持默认 TLS 校验。")
  console.error("本地验证通过开放平台查询 IAM/TDS 和 DDO 合约中的 issuer DID 公钥；撤销状态查询发证方平台地址。")
  console.error("注意：撤销检查是在线 issuer-service 状态，不是独立的链上状态证明。")
}

function parseFilePath(argv: readonly string[]): string | undefined {
  if (argv.length === 1 && (argv[0] === "help" || argv[0] === "--help")) return undefined
  if (argv.length !== 1) throw new Error("只接受一个 --file=<path> 参数")
  const argument = argv[0]
  if (argument === undefined) throw new Error("缺少 --file=<path> 参数")
  const match = /^--file=(.+)$/.exec(argument)
  const filePath = match?.[1]
  if (filePath === undefined) throw new Error("缺少 --file=<path> 参数")
  return filePath
}

function requireConfig(): { readonly bopUrl: string; readonly apiKey: string; readonly apiSecret: string; readonly vcRevocationUrl: string } {
  const bopUrl = process.env["BID_BOP_URL"]
  const apiKey = process.env["BID_BOP_API_KEY"]
  const apiSecret = process.env["BID_BOP_API_SECRET"] ?? ""
  const vcRevocationUrl = process.env["VC_REVOCATION_BASE_URL"]
  if (bopUrl === undefined || bopUrl === "") {
    throw new Error("缺少 BID_BOP_URL：请在 .env.verifier 中填写开放平台 HTTPS 地址")
  }
  if (apiKey === undefined || apiKey === "") {
    throw new Error("缺少 BID_BOP_API_KEY：请在 .env.verifier 中填写开放平台 API Key")
  }
  if (vcRevocationUrl === undefined || vcRevocationUrl === "") {
    throw new Error("缺少 VC_REVOCATION_BASE_URL：请在 .env.verifier 中填写发证方平台地址")
  }
  return { bopUrl, apiKey, apiSecret, vcRevocationUrl }
}

type ExtractedInput = {
  readonly jws: string
  readonly presentation?: unknown
}

function extractJws(raw: string): ExtractedInput {
  const trimmed = raw.trim()
  // 标准 VC 信封 JSON：校验外层字段与 JWS payload 一致后取 proof.jwt。
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const envelope = presentationEnvelopeSchema.safeParse(parsed)
    if (envelope.success) return { jws: envelope.data.proof.jwt, presentation: parsed }
  } catch {
    // 不是 JSON，按纯 JWS 文本处理。
  }
  if (trimmed === "") throw new Error("凭证文件必须是非空 JWS 或 VC 信封 JSON")
  return { jws: trimmed }
}

async function run(filePath: string): Promise<boolean> {
  const raw = await readFile(filePath, "utf8")
  const input = extractJws(raw)
  if (input.presentation !== undefined) {
    const inconsistent = verifyPresentationConsistency(input.presentation, input.jws)
    if (inconsistent !== undefined) {
      console.log(JSON.stringify({ verified: inconsistent.verified, checks: inconsistent.checks, errors: inconsistent.errors }, null, 2))
      return inconsistent.verified
    }
  }
  const config = requireConfig()
  configureBidSdk({
    bopUrl: config.bopUrl,
    vcRevocationUrl: config.vcRevocationUrl,
  })
  const sdk = createBidSdk()
  sdk.connect({
    mode: "bop",
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
  })
  const result = await sdk.vc.verifier.verifyCredential({ jws: input.jws })
  console.log(JSON.stringify({ verified: result.verified, checks: result.checks, errors: result.errors }, null, 2))
  return result.verified
}

async function main(argv: readonly string[]): Promise<void> {
  const filePath = parseFilePath(argv)
  if (filePath === undefined) {
    printHelp()
    return
  }
  if (!(await run(filePath))) process.exitCode = 1
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})