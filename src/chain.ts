import { randomBytes } from "node:crypto"

import { BifApiError, BifProvider, BifSigner, buildContractInvoke, type Operation } from "@caict-bif/bif-typescript-sdk"
import { BopInterface, Config, ProviderByBop, SignerByBop } from "@caict-bif/bop-typescript-sdk"

import { transactionIdSchema, type TransactionOptions, type TransactionId } from "./domain.js"
import { TransactionSubmissionError } from "./errors.js"
import { resolveTransactionOptions, type ResolvedTransactionOptions } from "./contracts.js"
import {
  confirmTransaction,
  DEFAULT_CONFIRM_OPTIONS,
  findTransaction,
  type ConfirmOptions,
  type TransactionState,
} from "./transaction-confirmation.js"

export type { ConfirmOptions, TransactionState } from "./transaction-confirmation.js"

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

/** 提交结果：ok 表示链上已确认成功；submitted 表示异步提交成功（未确认）；pending 表示 3s 内未确认，需用 hash 到浏览器核实。 */
export type SubmissionOutcome =
  | { readonly status: "ok"; readonly hash: TransactionId }
  | { readonly status: "submitted"; readonly hash: TransactionId }
  | { readonly status: "pending"; readonly hash: TransactionId; readonly hint: string }

/** 写链统一入口：把编码好的合约 input 提交到链上，并在 3s 内确认结果。 */
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
  getAccountMetadata(address: string, key: string): Promise<unknown>
  /** 合约只读调用（opt_type=2），返回规范化的 queryRets。 */
  queryContract(input: { readonly contractAddress: string; readonly input: string }): Promise<ContractQueryResult>
}

export type DirectSigner = {
  readonly address: string
  getLedgerNumber(): Promise<number>
  sendTransaction(transaction: DirectTransactionRequest): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }>
}

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
    const hash = transactionIdSchema.parse(result.hash)
    // 异步模式：提交成功即返回，不等待上链确认。
    if (options.async) return { status: "submitted", hash }
    return confirmTransaction("direct", hash, () => this.sdk.getTransactionState(result.hash ?? ""), this.confirm)
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
    // 底层 unwrapResult 对 result:null 抛 BifApiError(0,"missing result...")，
    // 对直连 metadata 查询，result:null 表示该 key 未命中，视为空结果返回而不是抛错。
    async getAccountMetadata(address: string, key: string): Promise<unknown> {
      try {
        return await provider.account.getAccountMetaData(address, key)
      } catch (error) {
        if (error instanceof BifApiError && error.code === 0) return null
        throw error
      }
    },
    async queryContract(input): Promise<ContractQueryResult> {
      const response = await provider.contract.callContract({
        contract_address: input.contractAddress,
        input: input.input,
        opt_type: 2,
      })
      return normalizeQueryRets(response)
    },
    async getTransactionState(hash): Promise<TransactionState> {
      // 交易刚提交未打包时，直连节点对历史/缓存池查询会返回“结果不存在”错误，
      // 这里按“未确认”处理，交给上层继续轮询。
      let historyTransactions: unknown
      try {
        historyTransactions = (await provider.transaction.getTransactionHistory({ hash }))["transactions"]
      } catch {
        historyTransactions = undefined
      }
      const confirmed = findTransaction(historyTransactions, hash)
      if (confirmed !== undefined) return confirmed
      let cacheTransactions: unknown
      try {
        cacheTransactions = (await provider.transaction.getTransactionCache({ hash }))["transactions"]
      } catch {
        cacheTransactions = undefined
      }
      if (findTransaction(cacheTransactions, hash) !== undefined) return { kind: "pooled" }
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
  getAccountMetadata(address: string, key: string): Promise<unknown>
  /** 合约只读调用（opt_type=2），返回规范化的 queryRets。 */
  queryContract(input: { readonly contractAddress: string; readonly input: string }): Promise<ContractQueryResult>
}

/** 契约查询结果统一形态（JS 合约）：queryRets[].result.value 为返回的 JSON 字符串。 */
export type ContractQueryResult = {
  readonly queryRets: readonly {
    readonly error?: { readonly data?: string }
    readonly result?: { readonly value?: string }
  }[]
}

function normalizeQueryRets(raw: unknown): ContractQueryResult {
  if (typeof raw !== "object" || raw === null) return { queryRets: [] }
  const record = raw as Readonly<Record<string, unknown>>
  // 直连节点返回 query_rets（snake），BOP SDK 返回 queryRets（camel）且内层 result 可能被 JSON.stringify 字符串化。
  const queryRets = Array.isArray(record["queryRets"]) ? record["queryRets"] : record["query_rets"]
  if (!Array.isArray(queryRets)) return { queryRets: [] }
  return {
    queryRets: queryRets.map((entry) => {
      if (typeof entry !== "object" || entry === null) return {}
      const entryRecord = entry as Readonly<Record<string, unknown>>
      const error = typeof entryRecord["error"] === "object" && entryRecord["error"] !== null
        ? (entryRecord["error"] as Readonly<Record<string, unknown>>)
        : undefined
      const result = entryRecord["result"]
      const errorData = error?.["data"]
      const resultValue = resolveQueryResultValue(result)
      return {
        ...(errorData === undefined ? {} : { error: { data: typeof errorData === "string" ? errorData : JSON.stringify(errorData) } }),
        ...(resultValue === undefined ? {} : { result: { value: resultValue } }),
      }
    }),
  }
}

/** BOP SDK 可能把 result 序列化成字符串（如 '{"type":"string","value":"..."}'）；这里统一取 value 字段。 */
function resolveQueryResultValue(result: unknown): string | undefined {
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result)
      if (typeof parsed === "object" && parsed !== null) {
        const value = (parsed as Readonly<Record<string, unknown>>)["value"]
        return typeof value === "string" ? value : undefined
      }
    } catch {
      return result
    }
    return undefined
  }
  if (typeof result === "object" && result !== null) {
    const value = (result as Readonly<Record<string, unknown>>)["value"]
    return typeof value === "string" ? value : undefined
  }
  return undefined
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
    const hash = transactionIdSchema.parse(result.hash)
    // 异步模式：提交成功即返回，不等待上链确认。
    if (options.async) return { status: "submitted", hash }
    return confirmTransaction("bop", hash, () => this.sdk.getTransactionState(result.hash ?? ""), this.confirm)
  }
}

export function createBopSdk(config: BopNetworkConfig): BopSdk {
  const bopInterface = new BopInterface(new Config(config.baseUrl, config.apiKey, config.apiSecret))
  const provider = new ProviderByBop(bopInterface)
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
    getAccountMetadata: async (address, key) => {
      // BOP SDK 的 account.getAccountMetadata 走 base_getAccount（对 metadata 查询返回 9999/500）。
      // 这里改用开平台底层 BaseService.getAccountMetaData（走 /getAccountMetaData 接口），
      // 返回与直连同构的 result 映射（未命中为 null）。
      const response = await bopInterface.getBaseService().getAccountMetaData({ address, key })
      if (typeof response.errorCode === "number" && response.errorCode !== 0) {
        throw new Error(typeof response.errorDesc === "string" ? response.errorDesc : `BOP getAccountMetaData failed with code ${response.errorCode}`)
      }
      if (response.result === undefined || response.result === null) return null
      const result = response.result as Readonly<Record<string, unknown>>
      const entries: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(result)) {
        if (typeof v === "object" && v !== null) entries[k] = v
      }
      return entries
    },
    async queryContract(input): Promise<ContractQueryResult> {
      const response = await provider.contract.callContract({
        contractAddress: input.contractAddress,
        input: input.input,
        optType: 2,
      })
      return normalizeQueryRets(response.result)
    },
  }
}

// ---------- 随机 nonce ----------

function randomNonce(): number {
  return Number(BigInt(`0x${randomBytes(6).toString("hex")}`))
}

function randomNonceRange(): number {
  return 100 + Math.floor(Math.random() * 900)
}
