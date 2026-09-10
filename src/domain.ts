import { z } from "zod"

export const bidIdSchema = z.string().regex(/^did:bid:[A-Za-z0-9]+$/).brand<"BidId">()
export type BidId = z.infer<typeof bidIdSchema>

export const transactionIdSchema = z.string().min(1).brand<"TransactionId">()
export type TransactionId = z.infer<typeof transactionIdSchema>

export const bidPublicKeySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  controller: z.string().min(1),
  publicKeyHex: z.string().min(1),
})
export type BidPublicKey = z.infer<typeof bidPublicKeySchema>

export const bidServiceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  serviceEndpoint: z.string().min(1),
  protocol: z.number().int().optional(),
  serverType: z.number().int().optional(),
  version: z.string().min(1).optional(),
})
export type BidService = z.infer<typeof bidServiceSchema>

export const delegateSignSchema = z.object({
  signer: z.string().min(1),
  signatureValue: z.string().min(1),
})
export type DelegateSign = z.infer<typeof delegateSignSchema>

/** extension 允许携带未预定义的新字段或对象。 */
export const bidExtensionSchema = z.object({
  recovery: z.array(z.string().min(1)).optional(),
  ttl: z.number().int().nonnegative().safe().optional(),
  delegateSign: delegateSignSchema.optional(),
  type: z.number().int().optional(),
}).passthrough()
export type BidExtension = z.infer<typeof bidExtensionSchema> & { readonly [key: string]: unknown }

export const bidDocumentSchema = z.object({
  "@context": z.array(z.string().url()).min(1),
  version: z.string().min(1).optional(),
  id: bidIdSchema,
  publicKey: z.array(bidPublicKeySchema).min(1).optional(),
  authentication: z.array(z.string().min(1)).min(1).optional(),
  extension: bidExtensionSchema.optional(),
  service: z.array(bidServiceSchema).min(1).optional(),
  created: z.string().datetime({ offset: true }).optional(),
  updated: z.string().datetime({ offset: true }).optional(),
}).brand<"BuiltBidDocument">()
export type BuiltBidDocument = z.infer<typeof bidDocumentSchema>

export type TransactionOptions = {
  readonly privateKey: string
  readonly feeLimit?: number
  readonly gasPrice?: number
  readonly amount?: number
  readonly remarks?: string
  /** true 时不等待上链确认，提交后直接返回交易 hash；默认等待 3s 确认结果。 */
  readonly async?: boolean
}

export type SubmittedTransaction = {
  readonly id: TransactionId
  readonly transport: "direct" | "bop"
  /** true 表示链上已确认成功；false 表示提交后 3s 内未确认，需用 id 到浏览器核实。 */
  readonly confirmed: boolean
}

export function parseBidId(value: string): BidId {
  return bidIdSchema.parse(value)
}
