import { BidContractAddresses } from "./constants.js"
import type { ContractQueryResult } from "./chain.js"
import { bidDocumentSchema, type BidId, type BuiltBidDocument } from "./domain.js"
import { BidNotFoundError, BidReadError } from "./errors.js"
import type { BidReader } from "./parser.js"

/** DDO 合约 queryBid 只读查询接口（由 direct/BOP 传输适配器提供）。 */
export type DdoContractQuery = (input: { readonly contractAddress: string; readonly input: string }) => Promise<ContractQueryResult>

/**
 * 通过 DDO 合约的 queryBid 只读调用读取 BID 文档，不依赖解析服务。
 * 与 Java bid-parser-server 的链上回退逻辑一致：
 * queryRets[0].error.data 以 "10706" 开头表示文档不存在，
 * 否则 queryRets[0].result.value 是文档 JSON 字符串。
 */
export class DdoDocumentReader implements BidReader {
  constructor(
    private readonly query: DdoContractQuery,
    private readonly contractAddress: string = BidContractAddresses.DDO,
  ) {}

  async get(id: BidId): Promise<BuiltBidDocument> {
    let result: ContractQueryResult
    try {
      result = await this.query({
        contractAddress: this.contractAddress,
        input: JSON.stringify({ method: "queryBid", params: { id } }),
      })
    } catch (error) {
      throw new BidReadError("DDO queryBid request failed", { cause: error })
    }
    const first = result.queryRets[0]
    const errorData = first?.error?.data
    if (errorData !== undefined && errorData.startsWith("10706")) throw new BidNotFoundError(id)
    const rawValue = first?.result?.value
    if (rawValue === undefined || rawValue === "") throw new BidReadError("DDO queryBid returned no document value")
    let parsed: unknown
    try {
      parsed = JSON.parse(rawValue)
    } catch (error) {
      throw new BidReadError("DDO queryBid returned invalid JSON", { cause: error })
    }
    const document = bidDocumentSchema.safeParse(parsed)
    if (!document.success) throw new BidReadError("DDO queryBid returned an invalid BID document", { cause: document.error })
    return document.data
  }
}