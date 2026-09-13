import { createBidDocument, type BidDocumentBuilder } from "./bid-document.js"
import { createBopSdk, BopBidWriter, type BopNetworkConfig, type ChainWriter } from "./chain.js"
import { createDirectSdk, DirectBidWriter, type DirectNetworkConfig } from "./chain.js"
import { getBidSdkUrls } from "./config.js"
import { BidContractAddresses } from "./constants.js"
import { encodeCreatePayload, encodeReAuthPayload, encodeUpdatePayload } from "./contracts.js"
import { type BidId, type BuiltBidDocument, type SubmittedTransaction, type TransactionOptions } from "./domain.js"
import { BidConfigurationError } from "./errors.js"
import { bidKeypairOperations, type BidKeypairOperations } from "./keypair.js"
import type { BidReader, ParserConfig } from "./parser.js"
import { ParserBidReader } from "./parser.js"
import { createVcOperationsController, type VcOperations } from "./vc/index.js"
import { DirectIssuerPublicKeySource, DirectIssuerTrustReader, type IssuerPublicKeySource, type IssuerTrustReader } from "./vc/vc-trust.js"
import { ddoContractIssuerDocumentReader } from "./vc/vc-local-protocol.js"
import { DdoDocumentReader } from "./ddo-document.js"

export type BidSdkConnectConfig =
  | { readonly mode: "direct"; readonly timeoutMs?: number; readonly allowInsecureTls?: boolean }
  | { readonly mode: "bop"; readonly apiKey: string; readonly apiSecret: string }

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
  private readonly vcController = createVcOperationsController()
  readonly vc: VcOperations = this.vcController.operations
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
    const urls = getBidSdkUrls()
    let issuerTrust: IssuerTrustReader
    let issuerPublicKeySource: IssuerPublicKeySource
    let contractQuery: (input: { readonly contractAddress: string; readonly input: string }) => Promise<import("./chain.js").ContractQueryResult>
    switch (config.mode) {
      case "direct": {
        if (urls.directNodeUrl === undefined) throw new BidConfigurationError("directNodeUrl", "is required for direct mode")
        const directConfig: DirectNetworkConfig = {
          nodeUrl: urls.directNodeUrl,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
          ...(config.allowInsecureTls === undefined ? {} : { allowInsecureTls: config.allowInsecureTls }),
        }
        const direct = createDirectSdk(directConfig)
        this.writer = new DirectBidWriter(BidContractAddresses.DDO, direct)
        issuerTrust = new DirectIssuerTrustReader({ get: direct.getAccountMetadata })
        issuerPublicKeySource = new DirectIssuerPublicKeySource({ get: direct.getAccountMetadata })
        contractQuery = (input) => direct.queryContract(input)
        break
      }
      case "bop": {
        if (urls.bopUrl === undefined) throw new BidConfigurationError("bopUrl", "is required for bop mode")
        const bopConfig: BopNetworkConfig = { baseUrl: urls.bopUrl, apiKey: config.apiKey, apiSecret: config.apiSecret }
        const bop = createBopSdk(bopConfig)
        this.writer = new BopBidWriter(BidContractAddresses.DDO, bop)
        issuerTrust = new DirectIssuerTrustReader({ get: bop.getAccountMetadata })
        issuerPublicKeySource = new DirectIssuerPublicKeySource({ get: bop.getAccountMetadata })
        contractQuery = (input) => bop.queryContract(input)
        break
      }
    }
    // DID 文档解析：有 parserUrl 时继续用解析服务（向后兼容），否则直读 DDO 合约 queryBid。
    if (urls.parserUrl === undefined) {
      this.reader = new DdoDocumentReader(contractQuery)
    } else {
      const parserConfig: ParserConfig = { baseUrl: urls.parserUrl }
      this.reader = new ParserBidReader(parserConfig)
    }
    this.vcController.connect({
      issuerTrust,
      issuerPublicKeySource,
      issuerDocumentReader: ddoContractIssuerDocumentReader(contractQuery),
      ...(urls.vcRevocationUrl === undefined ? {} : { revocationBaseUrl: urls.vcRevocationUrl }),
    })
    return this
  }

  private async submit(input: string, transaction: TransactionOptions): Promise<SubmittedTransaction> {
    const outcome = await this.writer.submit(input, transaction)
    if (outcome.status === "pending") {
      // 交易已提交但 3s 未在链上确认：打印 hash，请用户到区块链浏览器核实。
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
