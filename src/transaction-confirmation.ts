import type { TransactionId } from "./domain.js"
import { TransactionSubmissionError } from "./errors.js"

export type TransactionState =
  | { readonly kind: "confirmed"; readonly errorCode: number; readonly errorDesc: string }
  | { readonly kind: "pooled" }
  | { readonly kind: "unknown" }

export type ConfirmOptions = {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

export type ResolvedConfirmOptions = Required<ConfirmOptions>

export const DEFAULT_CONFIRM_OPTIONS = { timeoutMs: 3_000, intervalMs: 500 } as const

export async function confirmTransaction(
  transport: "direct" | "bop",
  hash: TransactionId,
  getState: () => Promise<TransactionState>,
  options: ResolvedConfirmOptions,
): Promise<
  | { readonly status: "ok"; readonly hash: TransactionId }
  | { readonly status: "pending"; readonly hash: TransactionId; readonly hint: string }
> {
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    const state = await getState()
    if (state.kind === "confirmed") {
      if (state.errorCode !== 0) throw new TransactionSubmissionError(transport, state.errorDesc === "" ? `transaction ${hash} failed on chain` : state.errorDesc)
      return { status: "ok", hash }
    }
    if (Date.now() >= deadline) {
      return {
        status: "pending",
        hash,
        hint: `交易 ${hash} 已提交，但 ${options.timeoutMs}ms 内未在链上确认，可能仍在交易池处理中。请使用该 hash 在区块链浏览器查询最终结果。`,
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, options.intervalMs) })
  }
}

/** 在节点返回的交易列表中查找 hash，并读取执行结果。 */
export function findTransaction(value: unknown, hash: string): TransactionState | undefined {
  if (!isRecordArray(value)) return undefined
  for (const item of value) {
    if (item["hash"] !== hash) continue
    const errorCode = item["error_code"] ?? item["errorCode"]
    const errorDesc = item["error_desc"] ?? item["errorDesc"]
    const code = typeof errorCode === "number" ? errorCode : typeof errorCode === "string" ? Number(errorCode) : -1
    return { kind: "confirmed", errorCode: code, errorDesc: typeof errorDesc === "string" ? errorDesc : "" }
  }
  return undefined
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return false
  return value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))
}
