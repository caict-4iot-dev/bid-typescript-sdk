import type { VerificationResult } from "./vc-domain.js"
import { LocalVcVerifier, type VerifyCredentialInput } from "./vc-verifier.js"
import { DirectIssuerPublicKeySource, DirectIssuerTrustReader } from "./vc-trust.js"
import { ddoContractIssuerDocumentReader } from "./vc-local-protocol.js"
import { createDirectNodeClient } from "./direct-node.js"

export type DirectVcVerifierOptions = {
  /** 直连链节点 HTTP 地址（如 https://bif.example.com）。 */
  readonly directNodeUrl: string
  /** 发证方平台撤销状态查询根地址（如 https://vc-issuer.example.com）。 */
  readonly vcRevocationUrl: string
  /** 自定义 fetch 实现；默认使用全局 fetch。RN/浏览器传入自己的 fetch。 */
  readonly fetcher?: typeof fetch
  /** 链节点请求超时（毫秒），默认 30000。 */
  readonly timeoutMs?: number
}

export type DirectVcVerifier = {
  readonly verifyCredential: (input: VerifyCredentialInput) => Promise<VerificationResult>
}

/**
 * 轻量本地核验入口（跨平台，供 React Native / 浏览器等 App 使用）。
 *
 * 只组装：
 *   - LocalVcVerifier（JWS/签名/披露/有效期/IAM-TDS 信任/撤销状态）
 *   - DirectIssuerTrustReader、DirectIssuerPublicKeySource（IAM/TDS metadata）
 *   - ddoContractIssuerDocumentReader（DDO 合约 queryBid 读取发行方 DID 文档）
 * 不经过 bid-sdk.ts / keypair.ts / chain.ts，不引入开放平台 SDK、undici 或写链依赖；
 * 链上查询通过标准 fetch 直连节点 HTTP 接口。
 *
 * 核验结果与 `sdk.vc.verifier.verifyCredential` 完全一致（verified / checks / errors）。
 */
export function createDirectVcVerifier(options: DirectVcVerifierOptions): DirectVcVerifier {
  const node = createDirectNodeClient({
    baseUrl: options.directNodeUrl,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: new DirectIssuerTrustReader({ get: node.getAccountMetadata }),
    issuerPublicKeySource: new DirectIssuerPublicKeySource({ get: node.getAccountMetadata }),
    issuerDocumentReader: ddoContractIssuerDocumentReader((request) => node.queryContract(request)),
    revocationBaseUrl: options.vcRevocationUrl,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  })
  return {
    verifyCredential: (input) => verifier.verifyCredential(input),
  }
}

export { createDirectNodeClient }
export type { DirectNodeClient, DirectNodeClientOptions } from "./direct-node.js"