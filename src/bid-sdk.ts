import { createBidDocument, type BidDocumentBuilder } from "./bid-document.js"
import { createBopSdk, BopBidWriter, type BopNetworkConfig, type ChainWriter } from "./chain.js"
import { createDirectSdk, DirectBidWriter, type DirectNetworkConfig } from "./chain.js"
import { encodeCreatePayload, encodeReAuthPayload, encodeUpdatePayload } from "./contracts.js"
import type { BidId, BuiltBidDocument, SubmittedTransaction, TransactionOptions } from "./domain.js"
import { BidConfigurationError } from "./errors.js"
import { bidKeypairOperations, type BidKeypairOperations } from "./keypair.js"
import { ParserBidReader, type BidReader, type ParserConfig } from "./parser.js"

export type BidSdkConnectConfig = {
  readonly mode: "direct" | "bop"
  readonly contractAddress: string
  readonly parser: ParserConfig
  readonly direct?: DirectNetworkConfig
  readonly bop?: BopNetworkConfig
}

export interface BidDocumentOperations {
  create(id: BidId): BidDocumentBuilder
}

export interface BidOperations {
  create(document: BuiltBidDocument, transaction: TransactionOptions): Promise<SubmittedTransaction>
  update(document: BuiltBidDocument, transaction: TransactionOptions): Promise<SubmittedTransaction>
  reAuth(input: { readonly id: BidId; readonly authentication: readonly string[]; readonly transaction: TransactionOptions }): Promise<SubmittedTransaction>
  resolve(id: BidId, options?: { readonly signal?: AbortSignal }): Promise<BuiltBidDocument>
}

/** BID SDK：离线生成密钥、构建文档、签名验签；connect 后获得写链与解析能力。 */
export class BidSdk {
  readonly keypair: BidKeypairOperations = bidKeypairOperations
  readonly document: BidDocumentOperations = {
    create: (id) => createBidDocument().setId(id),
  }

  private writer: ChainWriter = offlineWriter()
  private reader: BidReader = offlineReader()

  readonly bid: BidOperations = {
    create: (document, transaction) => this.submit(encodeCreatePayload(document), transaction),
    update: (document, transaction) => this.submit(encodeUpdatePayload(document), transaction),
    reAuth: ({ id, authentication, transaction }) => this.submit(encodeReAuthPayload(id, authentication), transaction),
    resolve: (id, options) => this.reader.get(id, options),
  }

  /** 选择直连节点或开放平台，并配置解析服务；同一个 SDK 实例后续即可写链与解析。 */
  connect(config: BidSdkConnectConfig): this {
    switch (config.mode) {
      case "direct": {
        if (config.direct === undefined) throw new BidConfigurationError("connect", "mode direct requires the direct config")
        this.writer = new DirectBidWriter(config.contractAddress, createDirectSdk(config.direct))
        break
      }
      case "bop": {
        if (config.bop === undefined) throw new BidConfigurationError("connect", "mode bop requires the bop config")
        this.writer = new BopBidWriter(config.contractAddress, createBopSdk(config.bop))
        break
      }
    }
    this.reader = new ParserBidReader(config.parser)
    return this
  }

  private async submit(input: string, transaction: TransactionOptions): Promise<SubmittedTransaction> {
    const outcome = await this.writer.submit(input, transaction)
    if (outcome.status === "pending") {
      // 交易已提交但 2s 未在链上确认：打印 hash，请用户到区块链浏览器核实。
      console.warn(`[bid-sdk] ${outcome.hint}`)
    }
    return { id: outcome.hash, transport: this.writer.transport, confirmed: outcome.status === "ok" }
  }
}

function offlineWriter(): ChainWriter {
  return {
    transport: "direct",
    async submit(): Promise<never> { throw networkRequired() },
  }
}

function offlineReader(): BidReader {
  return {
    async get(): Promise<BuiltBidDocument> { throw networkRequired() },
  }
}

function networkRequired(): BidConfigurationError {
  return new BidConfigurationError("network", "is required for chain writes and BID resolution; call sdk.connect(...) first")
}

export function createBidSdk(): BidSdk { return new BidSdk() }