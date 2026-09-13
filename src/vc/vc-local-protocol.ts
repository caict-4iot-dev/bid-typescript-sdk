import { z } from "zod"

import * as enc from "@caict-bif/bif-encryption"

import { BidContractAddresses } from "../constants.js"
import type { VerificationChecks } from "./vc-domain.js"

const revocationEnvelopeSchema = z.object({
  errorCode: z.literal(0),
  data: z.object({
    revoked: z.boolean(),
    id: z.string().optional(),
    issuer: z.string().optional(),
  }),
})

/** DDO queryBid 返回的“文档不存在”错误（节点返回 code=5，Java 侧 10706）。链上节点 error.data 是 JSON 对象字符串。 */
const documentMissingSchema = z.object({ code: z.number().int() }).passthrough()

function isDocumentMissingError(errorText: string | undefined): boolean {
  if (errorText === undefined || errorText === "") return false
  if (errorText.startsWith("10706")) return true
  try {
    return documentMissingSchema.safeParse(JSON.parse(errorText)).success === true
  } catch {
    return false
  }
}

export type IssuerDidDocument = {
  readonly id: string
  readonly publicKey?: readonly IssuerDidPublicKey[] | undefined
  readonly authentication?: readonly string[] | undefined
}

type IssuerDidPublicKey = {
  readonly id: string
  readonly type: string
  readonly controller: string
  readonly publicKeyHex: string
}

/** 统一 DDO 合约只读查询结果中的 JS 合约 queryRets（direct/BOP 字段名可能不同，各自适配器负责规范化）。 */
export type ContractQueryRequest = {
  readonly contractAddress: string
  readonly input: string
}

export type ContractQueryResult = {
  readonly queryRets: readonly {
    readonly error?: { readonly data?: string }
    readonly result?: { readonly value?: string }
  }[]
}

export type ContractQueryReader = (request: ContractQueryRequest) => Promise<ContractQueryResult>

/** 通过 DDO 合约的 queryBid 只读调用读取发行方 DID 文档。 */
export function ddoContractIssuerDocumentReader(query: ContractQueryReader): IssuerDocumentReader {
  return {
    async get(issuer: string): Promise<IssuerDidDocument> {
      const result = await query({
        contractAddress: BidContractAddresses.DDO,
        input: JSON.stringify({ method: "queryBid", params: { id: issuer } }),
      })
      const first = result.queryRets[0]
      const errorText = first?.error?.data
      if (isDocumentMissingError(errorText)) {
        throw new Error(`issuer DID document not found on chain: ${issuer}`)
      }
      const rawValue = first?.result?.value
      if (rawValue === undefined || rawValue === "") throw new Error(`DDO queryBid returned no document for ${issuer}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(rawValue)
      } catch (error) {
        throw new Error(`DDO queryBid returned an invalid issuer DID document for ${issuer}`, { cause: error })
      }
      const document = z.object({
        id: z.string().min(1),
        publicKey: z.array(z.object({
          id: z.string().min(1),
          type: z.string(),
          controller: z.string(),
          publicKeyHex: z.string(),
        })).optional(),
        authentication: z.array(z.string().min(1)).optional(),
      }).safeParse(parsed)
      if (!document.success) throw new Error(`DDO queryBid returned an invalid issuer DID document for ${issuer}: ${JSON.stringify(document.error.issues)}`, { cause: document.error })
      return document.data
    },
  }
}

export type IssuerDocumentReader = {
  readonly get: (issuer: string) => Promise<IssuerDidDocument>
}

export function signatureCheck(
  verifiedIssuerKey: string | undefined,
  legacyPublicKeys: readonly string[] | undefined,
  issuerDocumentReader: IssuerDocumentReader | undefined,
): VerificationChecks["issuerSignature"] {
  if (verifiedIssuerKey !== undefined) return "passed"
  if (issuerDocumentReader !== undefined || legacyPublicKeys !== undefined && legacyPublicKeys.length > 0) return "failed"
  return "skipped"
}

export function eligibleIssuerKeys(issuer: string, document: IssuerDidDocument): readonly string[] {
  return (document.publicKey ?? []).flatMap((publicKey) => {
    if (!isIssuerControlledKey(publicKey, issuer, document.authentication)) return []
    const algorithm = normalizeKeyType(publicKey.type)
    if (algorithm === undefined) return []
    try {
      // 公钥以各自声明的算法转换；SM2 验证失败后再用 ED25519 候选回退验证。
      const cryptoType = algorithm === "SM2" ? enc.CRYPTO_SM2 : enc.CRYPTO_ED25519
      return [enc.rawToEncPublicKey(publicKey.publicKeyHex, cryptoType)]
    } catch {
      return []
    }
  })
}

export async function verifyRevocation(input: {
  readonly revocationBaseUrl: string
  readonly credentialId: string
  readonly issuer: string
  readonly fetcher: typeof fetch
}): Promise<VerificationChecks["revocation"]> {
  let endpoint: URL
  try {
    endpoint = new URL(input.revocationBaseUrl.endsWith("/") ? input.revocationBaseUrl : `${input.revocationBaseUrl}/`)
  } catch {
    return "failed"
  }
  try {
    const response = await input.fetcher(new URL(`/api/cred/vc/revoked/${encodeURIComponent(input.credentialId)}`, endpoint), { method: "GET" })
    if (!response.ok) return "failed"
    const envelope = revocationEnvelopeSchema.safeParse(await response.json())
    if (!envelope.success || envelope.data.data.revoked) return "failed"
    if (envelope.data.data.id !== undefined && envelope.data.data.id !== input.credentialId) return "failed"
    if (envelope.data.data.issuer !== undefined && envelope.data.data.issuer !== input.issuer) return "failed"
    return "passed"
  } catch {
    return "failed"
  }
}

function isIssuerControlledKey(
  publicKey: IssuerDidPublicKey,
  issuer: string,
  authentication: readonly string[] | undefined,
): boolean {
  return publicKey.controller === issuer
    && publicKey.controller.length > 0
    && publicKey.publicKeyHex.length > 0
    && (authentication === undefined || authentication.includes(publicKey.id))
}

function normalizeKeyType(value: string): "SM2" | "ED25519" | undefined {
  const normalized = value.replaceAll("-", "").toUpperCase()
  if (normalized === "SM2") return "SM2"
  if (normalized === "ED25519") return "ED25519"
  return undefined
}
