import { z } from "zod"

import { BidContractAddresses } from "../constants.js"

export interface IssuerTrustReader {
  isTrusted(issuerBid: string): Promise<boolean>
}

export type IssuerTrustMetadataSource = {
  get(address: string, key: string): Promise<unknown>
}

type MetadataEntry = {
  readonly key: string
  readonly value: string
}

const metadataEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
})
// 直连节点 /getAccountMetaData 的真实返回：result 是 key -> {key,value} 映射；未命中时 result 为 null。
const directResultSchema = z.record(z.string(), metadataEntrySchema).or(z.null())
const bopMetadataSchema = z.object({
  errorCode: z.number(),
  errorDesc: z.string().optional(),
  result: z.array(metadataEntrySchema).optional(),
})
const adminListSchema = z.array(z.string().regex(/^did:bid:[A-Za-z0-9]+$/))

export class IssuerTrustLookupError extends Error {
  readonly name = "IssuerTrustLookupError"

  constructor(readonly reason: string, options?: ErrorOptions) {
    super(reason, options)
  }
}

abstract class MetadataIssuerTrustReader implements IssuerTrustReader {
  protected constructor(private readonly metadataSource: IssuerTrustMetadataSource) {}

  async isTrusted(issuerBid: string): Promise<boolean> {
    const admins = await this.readEntries(BidContractAddresses.IAM, "admins")
    const adminEntry = admins.find((entry) => entry.key === "admins")
    if (adminEntry !== undefined) {
      let rawAdmins: unknown
      try {
        rawAdmins = JSON.parse(adminEntry.value)
      } catch (error) {
        throw new IssuerTrustLookupError("IAM admins metadata must be a JSON array", { cause: error })
      }
      const parsedAdmins = adminListSchema.safeParse(rawAdmins)
      if (!parsedAdmins.success) throw new IssuerTrustLookupError("IAM admins metadata must contain BID strings", { cause: parsedAdmins.error })
      if (parsedAdmins.data.includes(issuerBid)) return true
    }

    const issuerKey = `issuer_${issuerBid}`
    const issuers = await this.readEntries(BidContractAddresses.TDS, issuerKey)
    return issuers.some((entry) => entry.key === issuerKey)
  }

  protected abstract readEntries(address: string, key: string): Promise<readonly MetadataEntry[]>

  protected async metadata(address: string, key: string): Promise<unknown> {
    try {
      return await this.metadataSource.get(address, key)
    } catch (error) {
      if (error instanceof IssuerTrustLookupError) throw error
      throw new IssuerTrustLookupError(error instanceof Error ? error.message : "issuer trust metadata query failed", { cause: error })
    }
  }
}

export class DirectIssuerTrustReader extends MetadataIssuerTrustReader {
  constructor(metadata: IssuerTrustMetadataSource) {
    super(metadata)
  }

  protected async readEntries(address: string, key: string): Promise<readonly MetadataEntry[]> {
    const raw = await this.metadata(address, key)
    const parsed = directResultSchema.safeParse(raw)
    if (!parsed.success) throw new IssuerTrustLookupError("direct metadata response is invalid", { cause: parsed.error })
    if (parsed.data === null) return []
    return Object.values(parsed.data)
  }
}

export class BopIssuerTrustReader extends MetadataIssuerTrustReader {
  constructor(metadata: IssuerTrustMetadataSource) {
    super(metadata)
  }

  protected async readEntries(address: string, key: string): Promise<readonly MetadataEntry[]> {
    const parsed = bopMetadataSchema.safeParse(await this.metadata(address, key))
    if (!parsed.success) throw new IssuerTrustLookupError("BOP metadata response is invalid", { cause: parsed.error })
    if (parsed.data.errorCode !== 0) throw new IssuerTrustLookupError(parsed.data.errorDesc ?? `BOP metadata query failed with code ${parsed.data.errorCode}`)
    if (parsed.data.result === undefined) throw new IssuerTrustLookupError("BOP metadata response omitted result")
    return parsed.data.result
  }
}

/**
 * 发行方公钥读取源：从 TDS 合约 `issuer_<bid>` metadata 的 value JSON 中取 publicKey 字段。
 * 用于 DDO 文档公钥验证失败时的兼容回退（服务端可能未把签发公钥同步到 DDO 文档）。
 */
export interface IssuerPublicKeySource {
  getIssuerPublicKey(issuerBid: string): Promise<string | undefined>
}

const tdsPublicKeyValueSchema = z.object({ publicKey: z.string().optional() }).passthrough()

export class DirectIssuerPublicKeySource implements IssuerPublicKeySource {
  constructor(private readonly metadata: IssuerTrustMetadataSource) {}

  async getIssuerPublicKey(issuerBid: string): Promise<string | undefined> {
    const key = `issuer_${issuerBid}`
    let raw: unknown
    try {
      raw = await this.metadata.get(BidContractAddresses.TDS, key)
    } catch {
      return undefined
    }
    const parsed = directResultSchema.safeParse(raw)
    if (!parsed.success || parsed.data === null) return undefined
    const entry = parsed.data[key]
    return parsePublicKeyFromEntry(entry)
  }
}

export class BopIssuerPublicKeySource implements IssuerPublicKeySource {
  constructor(private readonly metadata: IssuerTrustMetadataSource) {}

  async getIssuerPublicKey(issuerBid: string): Promise<string | undefined> {
    const key = `issuer_${issuerBid}`
    let raw: unknown
    try {
      raw = await this.metadata.get(BidContractAddresses.TDS, key)
    } catch {
      return undefined
    }
    const parsed = bopMetadataSchema.safeParse(raw)
    if (!parsed.success || parsed.data.errorCode !== 0 || parsed.data.result === undefined) return undefined
    const entry = parsed.data.result.find((candidate) => candidate.key === key)
    return parsePublicKeyFromEntry(entry)
  }
}

function parsePublicKeyFromEntry(entry: MetadataEntry | undefined): string | undefined {
  if (entry === undefined || entry.value === "") return undefined
  let value: unknown
  try {
    value = JSON.parse(entry.value)
  } catch {
    return undefined
  }
  const parsed = tdsPublicKeyValueSchema.safeParse(value)
  if (!parsed.success || parsed.data.publicKey === undefined || parsed.data.publicKey === "") return undefined
  return parsed.data.publicKey
}
