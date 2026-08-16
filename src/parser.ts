import { z } from "zod"

import { bidDocumentSchema, type BidId, type BuiltBidDocument } from "./domain.js"
import { BidNotFoundError, BidReadError, BidValidationError } from "./errors.js"

const envelopeSchema = z.object({
  errorCode: z.number().int(),
  message: z.string(),
  data: z.object({ didDocument: z.unknown() }).optional(),
})

export type ParserConfig = {
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly fetcher?: typeof fetch
}

export interface BidReader {
  get(id: BidId, options?: { readonly signal?: AbortSignal }): Promise<BuiltBidDocument>
}

/** 从 BID 解析服务读取文档：GET {baseUrl}/{bid}。 */
export class ParserBidReader implements BidReader {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(config: ParserConfig) {
    this.baseUrl = parseBaseUrl(config.baseUrl)
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetcher = config.fetcher ?? fetch
  }

  async get(id: BidId, options: { readonly signal?: AbortSignal } = {}): Promise<BuiltBidDocument> {
    const url = new URL(encodeURIComponent(id), this.baseUrl)
    const signal = options.signal ?? AbortSignal.timeout(this.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(url, { method: "GET", signal })
    } catch (error) {
      throw new BidReadError("parser request failed", { cause: error })
    }
    if (!response.ok) throw new BidReadError(`parser returned HTTP ${response.status}`)
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (error) {
      throw new BidReadError("parser returned invalid JSON", { cause: error })
    }
    const envelope = envelopeSchema.safeParse(body)
    if (!envelope.success) {
      const reason = text.length > 300 ? `${text.slice(0, 300)}…` : text
      throw new BidReadError(`parser returned an invalid response envelope (HTTP ${response.status}): ${reason}`, { cause: envelope.error })
    }
    return parseEnvelope(id, envelope.data)
  }
}

function parseBaseUrl(value: string): URL {
  try { return new URL(value.endsWith("/") ? value : `${value}/`) }
  catch (error) { throw new BidValidationError("parser.baseUrl", "must be an absolute URL") }
}

function parseEnvelope(id: BidId, envelope: z.infer<typeof envelopeSchema>): BuiltBidDocument {
  switch (envelope.errorCode) {
    case 0:
      if (envelope.data === undefined) throw new BidReadError("parser success response omitted data")
      return bidDocumentSchema.parse(envelope.data.didDocument)
    case 1:
      throw new BidValidationError("bid", envelope.message)
    case 100_000:
      throw new BidNotFoundError(id)
    case 400_000:
      throw new BidReadError(envelope.message)
    default:
      throw new BidReadError(`parser error ${envelope.errorCode}: ${envelope.message}`)
  }
}