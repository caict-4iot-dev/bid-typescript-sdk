import type { BidId, BuiltBidDocument, TransactionOptions } from "./domain.js"

/** 写链费用等参数的默认值。 */
export const DEFAULT_TRANSACTION_OPTIONS = {
  feeLimit: 1_000_000,
  gasPrice: 100,
  amount: 0,
} as const

export type ResolvedTransactionOptions = {
  readonly privateKey: string
  readonly feeLimit: number
  readonly gasPrice: number
  readonly amount: number
  readonly remarks?: string
}

/** 补全交易参数默认值：feeLimit/gasPrice/amount 未传时用 SDK 默认。 */
export function resolveTransactionOptions(options: TransactionOptions): ResolvedTransactionOptions {
  return {
    privateKey: options.privateKey,
    feeLimit: options.feeLimit ?? DEFAULT_TRANSACTION_OPTIONS.feeLimit,
    gasPrice: options.gasPrice ?? DEFAULT_TRANSACTION_OPTIONS.gasPrice,
    amount: options.amount ?? DEFAULT_TRANSACTION_OPTIONS.amount,
    ...(options.remarks === undefined ? {} : { remarks: options.remarks }),
  }
}

// BID 合约 input 编码：method 为 create/update/reAuth/updateBaseInfo。

export function encodeCreatePayload(document: BuiltBidDocument): string {
  return JSON.stringify({ method: "create", params: { document } })
}

export function encodeUpdatePayload(document: BuiltBidDocument): string {
  return JSON.stringify({ method: "update", params: { document } })
}

export function encodeReAuthPayload(id: BidId, authentication: readonly string[]): string {
  return JSON.stringify({ method: "reAuth", params: { id, authentication } })
}

export function encodeUpdateBaseInfoPayload(key: "owner", value: string): string {
  return JSON.stringify({ method: "updateBaseInfo", params: { key, value } })
}