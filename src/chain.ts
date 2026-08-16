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

/** 写链统一入口：把编码好的合约 input 提交到链上。 */
export interface ChainWriter {
  readonly transport: "direct" | "bop"
  submit(input: string, transaction: TransactionOptions): Promise<TransactionId>
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
}

export type DirectSigner = {
  readonly address: string
  getLedgerNumber(): Promise<number>
  sendTransaction(transaction: DirectTransactionRequest): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }>
}

export class DirectBidWriter implements ChainWriter {
  readonly transport = "direct" as const

  constructor(private readonly contractAddress: string, private readonly sdk: DirectSdk) {}

  async submit(input: string, transaction: TransactionOptions): Promise<TransactionId> {
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
    return transactionIdSchema.parse(result.hash)
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
  }
}

// ---------- 开放平台 ----------

export type BopOfflineTransaction = { readonly transactionBlob: string; readonly signatures: readonly { readonly publicKey: string; readonly signData: string }[] }

export type BopSdk = {
  /** 源账户未激活时先发一条激活交易，保证后续合约调用可提交。 */
  ensureAccount(privateKey: string, transaction: ResolvedTransactionOptions): Promise<void>
  buildContractInvoke(input: { readonly contractAddress: string; readonly payload: string; readonly transaction: ResolvedTransactionOptions }): Promise<BopOfflineTransaction>
  submitTransaction(transaction: BopOfflineTransaction): Promise<{ readonly hash?: string; readonly errorCode: number; readonly errorDescription: string }>
}

export class BopBidWriter implements ChainWriter {
  readonly transport = "bop" as const

  constructor(private readonly contractAddress: string, private readonly sdk: BopSdk) {}

  async submit(input: string, transaction: TransactionOptions): Promise<TransactionId> {
    const options = resolveTransactionOptions(transaction)
    await this.sdk.ensureAccount(options.privateKey, options)
    const offline = await this.sdk.buildContractInvoke({ contractAddress: this.contractAddress, payload: input, transaction: options })
    const result = await this.sdk.submitTransaction(offline)
    if (result.errorCode !== 0 || result.hash === undefined) throw new TransactionSubmissionError("bop", result.errorDescription)
    return transactionIdSchema.parse(result.hash)
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
  }
}

// ---------- 随机 nonce ----------

function randomNonce(): number {
  return Number(BigInt(`0x${randomBytes(6).toString("hex")}`))
}

function randomNonceRange(): number {
  return 100 + Math.floor(Math.random() * 900)
}