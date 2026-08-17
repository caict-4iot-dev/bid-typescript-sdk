import { randomBytes } from "node:crypto"

import { BifProvider, BifSigner, buildContractInvoke, type Operation } from "@caict-bif/bif-typescript-sdk"
import { BopInterface, Config, ProviderByBop, SignerByBop } from "@caict-bif/bop-typescript-sdk"

import { transactionIdSchema, type TransactionOptions, type TransactionId } from "./domain.js"
import { TransactionSubmissionError } from "./errors.js"
import { resolveTransactionOptions, type ResolvedTransactionOptions } from "./contracts.js"

export type DirectNetworkConfig = {
  readonly nodeUrl: string
  readonly timeoutMs?: number
  readonly allowInsecureTls?: boolean
}

export type BopNetworkConfig = {
  readonly baseUrl: string
  readonly apiKey: string
  readonly apiSecret: string
}

/** 提交结果：ok 表示链上已确认成功；pending 表示 2s 内未确认，需用 hash 到浏览器核实。 */
export type SubmissionOutcome =
  | { readonly status: "ok"; readonly hash: TransactionId }
  | { readonly status: "pending"; readonly hash: TransactionId; readonly hint: string }

/** 链上交易状态。 */
export type TransactionState =
  | { readonly kind: "confirmed"; readonly errorCode: number; readonly errorDesc: string }
  | { readonly kind: "pooled" }
  | { readonly kind: "unknown" }

/** 写链统一入口：把编码好的合约 input 提交到链上，并在 2s 内确认结果。 */
export interface ChainWriter {
  readonly transport: "direct" | "bop"
  submit(input: string, transaction: TransactionOptions): Promise<SubmissionOutcome>
}

// ---------- 直连链节点 ----------

export type DirectTransactionRequest = {
  readonly sourceAddress: string
  readonly nonce: number
  readonly feeLimit: number
  readonly gasPrice: number
  readonly remarks?: string
  readonly operations: Operation[]
  readonly nonceType: 0 | 1
  readonly maxLedgerSeq: number
}

export type DirectSdk = {
  createSigner(privateKey: string): DirectSigner
  buildContractInvoke(input: { readonly contractAddress: string; readonly amount: number; readonly input: string }): Operation
  getTransactionState(hash: string): Promise<TransactionState>
}

export type DirectSigner = {
  readonly address: string
  getLedgerNumber(): Promise<number>
  sendTransaction(transaction: DirectTransactionRequest): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }>
}

export type ConfirmOptions = {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

const DEFAULT_CONFIRM_OPTIONS = { timeoutMs: 2_000, intervalMs: 500 } as const

export class DirectBidWriter implements ChainWriter {
  readonly transport = "direct" as const
  private readonly confirm: Required<ConfirmOptions>

  constructor(private readonly contractAddress: string, private readonly sdk: DirectSdk, confirm?: ConfirmOptions) {
    this.confirm = { timeoutMs: confirm?.timeoutMs ?? DEFAULT_CONFIRM_OPTIONS.timeoutMs, intervalMs: confirm?.intervalMs ?? DEFAULT_CONFIRM_OPTIONS.intervalMs }
  }

  async submit(input: string, transaction: TransactionOptions): Promise<SubmissionOutcome> {
    const options = resolveTransactionOptions(transaction)
    const signer = this.sdk.createSigner(options.privateKey)
    // 使用随机 nonce，不依赖账户当前 nonce。
    const maxLedgerSeq = (await signer.getLedgerNumber()) + randomNonceRange()
    const operation = this.sdk.buildContractInvoke({ contractAddress: this.contractAddress, amount: options.amount, input })
    const result = await signer.sendTransaction({
      sourceAddress: signer.address,
      nonce: randomNonce(),
      feeLimit: options.feeLimit,
      gasPrice: options.gasPrice,
      ...(options.remarks === undefined ? {} : { remarks: options.remarks }),
      operations: [operation],
      nonceType: 1,
      maxLedgerSeq,
    })
    if (result.errorCode !== 0 || result.hash === undefined) throw new TransactionSubmissionError("direct", result.errorDescription)
    return confirmTransaction("direct", transactionIdSchema.parse(result.hash), () => this.sdk.getTransactionState(result.hash ?? ""), this.confirm)
  }
}

export function createDirectSdk(config: DirectNetworkConfig): DirectSdk {
  const provider = new BifProvider({
    baseUrl: config.nodeUrl,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.allowInsecureTls === undefined ? {} : { allowInsecureTls: config.allowInsecureTls }),
  })
  return {
    createSigner(privateKey: string): DirectSigner {
      const signer = new BifSigner(privateKey)
      return {
        address: signer.address,
        getLedgerNumber: () => provider.ledger.getLedgerNumber(),
        async sendTransaction(transaction): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }> {
          const result = await provider.transaction.sendTransaction({
            signer,
            tx: {
              sourceAddress: transaction.sourceAddress,
              nonce: transaction.nonce,
              feeLimit: transaction.feeLimit,
              gasPrice: transaction.gasPrice,
              operations: transaction.operations,
              nonceType: transaction.nonceType,
              maxLedgerSeq: transaction.maxLedgerSeq,
              ...(transaction.remarks === undefined ? {} : { metadata: new TextEncoder().encode(transaction.remarks) }),
            },
          })
          return {
            ...(result.hash === undefined ? {} : { hash: result.hash }),
            errorCode: result.error_code,
            errorDescription: result.error_desc,
          }
        },
      }
    },
    buildContractInvoke,
    async getTransactionState(hash): Promise<TransactionState> {
      const history = await provider.transaction.getTransactionHistory({ hash })
      const confirmed = findTransaction(history["transactions"], hash)
      if (confirmed !== undefined) return confirmed
      const cache = await provider.transaction.getTransactionCache({ hash })
      if (findTransaction(cache["transactions"], hash) !== undefined) return { kind: "pooled" }
      return { kind: "unknown" }
    },
  }
}

// ---------- 开放平台 ----------

export type BopOfflineTransaction = { readonly transactionBlob: string; readonly signatures: readonly { readonly publicKey: string; readonly signData: string }[] }

export type BopSdk = {
  /** 源账户未激活时先发一条激活交易，保证后续合约调用可提交。 */
  ensureAccount(privateKey: string, transaction: ResolvedTransactionOptions): Promise<void>
  buildContractInvoke(input: { readonly contractAddress: string; readonly payload: string; readonly transaction: ResolvedTransactionOptions }): Promise<BopOfflineTransaction>
  submitTransaction(transaction: BopOfflineTransaction): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }>
  getTransactionState(hash: string): Promise<TransactionState>
}

export class BopBidWriter implements ChainWriter {
  readonly transport = "bop" as const
  private readonly confirm: Required<ConfirmOptions>

  constructor(private readonly contractAddress: string, private readonly sdk: BopSdk, confirm?: ConfirmOptions) {
    this.confirm = { timeoutMs: confirm?.timeoutMs ?? DEFAULT_CONFIRM_OPTIONS.timeoutMs, intervalMs: confirm?.intervalMs ?? DEFAULT_CONFIRM_OPTIONS.intervalMs }
  }

  async submit(input: string, transaction: TransactionOptions): Promise<SubmissionOutcome> {
    const options = resolveTransactionOptions(transaction)
    await this.sdk.ensureAccount(options.privateKey, options)
    const offline = await this.sdk.buildContractInvoke({ contractAddress: this.contractAddress, payload: input, transaction: options })
    const result = await this.sdk.submitTransaction(offline)
    if (result.errorCode !== 0 || result.hash === undefined) throw new TransactionSubmissionError("bop", result.errorDescription)
    return confirmTransaction("bop", transactionIdSchema.parse(result.hash), () => this.sdk.getTransactionState(result.hash ?? ""), this.confirm)
  }
}

export function createBopSdk(config: BopNetworkConfig): BopSdk {
  const provider = new ProviderByBop(new BopInterface(new Config(config.baseUrl, config.apiKey, config.apiSecret)))
  return {
    async ensureAccount(privateKey, transaction): Promise<void> {
      const signer = new SignerByBop(privateKey).connect(provider)
      const sourceAddress = signer.getAddress()
      const account = await provider.account.getAccount(sourceAddress)
      if (account.errorCode === 0) return
      const activate = await provider.transaction.buildAccountCreateTx({
        destAddress: sourceAddress,
        initBalance: 0,
        params: {
          gasPrice: transaction.gasPrice,
          feeLimit: transaction.feeLimit,
          nonceType: 1,
        },
      }, [signer])
      if (activate.errorCode !== 0 || activate.result === undefined) throw new TransactionSubmissionError("bop", activate.errorDesc ?? "account activation construction failed")
      const result = await provider.transaction.submitTransaction({ items: [activate.result] })
      const first = result.results?.[0]
      if (first === undefined || (first.errorCode ?? -1) !== 0) throw new TransactionSubmissionError("bop", first?.errorDesc ?? "account activation submission failed")
    },
    async buildContractInvoke(input): Promise<BopOfflineTransaction> {
      const signer = new SignerByBop(input.transaction.privateKey).connect(provider)
      const offline = await provider.transaction.buildContractInvokeTx({
        contractAddress: input.contractAddress,
        amount: input.transaction.amount,
        input: input.payload,
        params: {
          gasPrice: input.transaction.gasPrice,
          feeLimit: input.transaction.feeLimit,
          nonceType: 1,
          ...(input.transaction.remarks === undefined ? {} : { remarks: input.transaction.remarks }),
        },
      }, [signer])
      if (offline.errorCode !== 0 || offline.result === undefined) throw new TransactionSubmissionError("bop", offline.errorDesc ?? "offline transaction construction failed")
      const { transactionBlob, signatures } = offline.result
      if (transactionBlob === undefined || signatures === undefined) throw new TransactionSubmissionError("bop", "offline transaction omitted blob or signatures")
      return { transactionBlob, signatures }
    },
    async submitTransaction(transaction): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }> {
      const response = await provider.transaction.submitTransaction({ items: [transaction] })
      const first = response.results?.[0]
      if (first === undefined) return { errorCode: -1, errorDescription: "submission returned no result" }
      return { hash: first.hash, errorCode: first.errorCode ?? -1, errorDescription: first.errorDesc ?? "submission failed" }
    },
    async getTransactionState(hash): Promise<TransactionState> {
      const history = await provider.transaction.getTransactionHistory(undefined, undefined, undefined, hash)
      const historyTxs = history.result?.transactions ?? []
      const confirmed = historyTxs.find((entry: { hash?: string; errorCode?: number; errorDesc?: string }) => entry.hash === hash)
      if (confirmed !== undefined) return { kind: "confirmed", errorCode: confirmed.errorCode ?? -1, errorDesc: confirmed.errorDesc ?? "" }
      const pool = await provider.transaction.getTxPoolTransactions(undefined, undefined, hash)
      const poolTxs = pool.result?.transactions ?? []
      const pooled = poolTxs.find((entry: { hash?: string }) => entry.hash === hash)
      if (pooled !== undefined) return { kind: "pooled" }
      return { kind: "unknown" }
    },
  }
}

// ---------- 提交确认 ----------

/** 提交后轮询（查交易记录与缓存池），确认成功/失败；超时返回 pending 并提示用 hash 去浏览器核实。 */
async function confirmTransaction(
  transport: "direct" | "bop",
  hash: TransactionId,
  getState: () => Promise<TransactionState>,
  options: Required<ConfirmOptions>,
): Promise<SubmissionOutcome> {
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
    await sleep(options.intervalMs)
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms) }) }

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return false
  return value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))
}

/** 在直连节点返回的交易列表（snake_case）中查找 hash，并读取执行结果。 */
function findTransaction(value: unknown, hash: string): TransactionState | undefined {
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

// ---------- 随机 nonce ----------

function randomNonce(): number {
  return Number(BigInt(`0x${randomBytes(6).toString("hex")}`))
}

function randomNonceRange(): number {
  return 100 + Math.floor(Math.random() * 900)
}