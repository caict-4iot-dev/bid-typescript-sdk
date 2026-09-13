import { BidConfigurationError, BidValidationError } from "../errors.js"
import { getBidSdkUrls } from "../config.js"
import { platformEnvelopeSchema, type PlatformEnvelope } from "./vc-domain.js"
import { signerFromInput, type VcSigner } from "./vc-crypto.js"

export const DEFAULT_VC_PLATFORM_ROUTES = {
  authRandom: "server/bid/auth/random",
  auth: "server/bid/auth",
  assert: "server/credential/assert",
  apply: "server/credential/apply",
  recommendList: "server/credential/recommend/list",
  templateDetail: "server/credential/template/detail",
  download: "server/credential/download",
  ownerList: "server/credential/owner/list",
  myPendingList: "server/credential/my/pending/list",
  issueBlob: "server/vc/issue/audit/blob",
  issueSubmit: "server/vc/issue/audit/submit",
  issueDisApprove: "server/vc/audit/disApprove",
  applyList: "server/vc/list",
  applyDetail: "server/vc/detail",
  revocationBlob: "server/vc/revocation/blob",
  revocationSubmit: "server/vc/revocation/submit",
  templateCreateBlob: "server/vc/create/template/blob",
  templateCreateSubmit: "server/vc/create/template/submit",
  templateManageList: "server/vc/manage/template/list",
  industryList: "server/vc/industry/list",
  categoryList: "server/vc/category/list",
  vpVerify: "server/vp/verify",
} as const

/**
 * 发证方门户（sp-fe/omp 网关）路由组：业务接口走网关 /api/omp 前缀。
 * 登录是跨主机两步：先在平台主机完成 BID 挑战登录（默认 authRandom/auth 路由不变），
 * 再到门户主机 /api/omp/sp/user/login 用 wallet JWT 换网关业务令牌（见 loginAsIssuer）。
 * 用法：sdk.vc.platform.create({ routes: ISSUER_PORTAL_ROUTES })。
 */
export const ISSUER_PORTAL_ROUTES: Readonly<Partial<VcPlatformRoutes>> = {
  issueBlob: "api/omp/credential/issue/audit/blob",
  issueSubmit: "api/omp/credential/issue/audit/submit",
  issueDisApprove: "api/omp/credential/audit/disApprove",
  applyList: "api/omp/credential/list",
  applyDetail: "api/omp/credential/detail",
  revocationBlob: "api/omp/credential/revocation/blob",
  revocationSubmit: "api/omp/credential/revocation/submit",
  templateCreateBlob: "api/omp/credential/create/template/blob",
  templateCreateSubmit: "api/omp/credential/create/template/submit",
  templateManageList: "api/omp/credential/template/list",
  industryList: "api/omp/dictionary/query/industry/list",
  categoryList: "api/omp/credential/category/list",
}

/** 发证方门户令牌交换登录（sp/user/login）：body 带 wallet 登录 JWT，换网关业务令牌。 */
export const ISSUER_PORTAL_TOKEN_EXCHANGE_ROUTE = "api/omp/sp/user/login"

export type VcPlatformRoute = keyof typeof DEFAULT_VC_PLATFORM_ROUTES

export type VcPlatformRoutes = Readonly<Record<VcPlatformRoute, string>>

export type PlatformSession = {
  readonly bid: string
  readonly accessToken: string
  readonly publicKey: string
  readonly expiresIn?: number
}

export type PlatformLoginInput = {
  readonly bid: string
  readonly privateKey?: string
  readonly signer?: VcSigner
}

export type VcPlatformConfig = {
  readonly timeoutMs?: number
  readonly fetcher?: typeof fetch
  /** 默认仅对 401 重新认证；非幂等业务请求不能因其他业务错误而自动重放。 */
  readonly shouldRetryOn?: (errorCode: number) => boolean
  /**
   * 覆盖部分平台路由（相对默认路由的 path 部分，可含多级前缀）。
   * 部署形态不同时 issuer 接口可能暴露在不同前缀下
   * （如网关 /api/omp/credential/... 或直连 /vc/...），无需改代码即可适配。
   */
  readonly routes?: Readonly<Partial<VcPlatformRoutes>>
}

export class PlatformApiError extends Error {
  readonly name = "PlatformApiError"

  constructor(readonly errorCode: number, message: string) {
    super(message)
  }
}

export class VcPlatformClient {
  private readonly routes: VcPlatformRoutes
  private readonly baseUrl: URL
  private readonly credentialBaseUrl: URL
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch
  private readonly shouldRetryOn: (errorCode: number) => boolean
  private session: PlatformSession | undefined
  private loginCredentials: { readonly bid: string; readonly signer: VcSigner } | undefined
  private portalLoginCredentials: { readonly bid: string; readonly signer: VcSigner } | undefined

  constructor(config: VcPlatformConfig = {}) {
    const urls = getBidSdkUrls()
    const platformUrl = urls.vcPlatformUrl
    if (platformUrl === undefined) throw new BidConfigurationError("vcPlatformUrl", "is required for the VC platform client")
    this.baseUrl = parseBaseUrl(platformUrl, "vcPlatformUrl")
    this.credentialBaseUrl = parseBaseUrl(urls.vcCredentialUrl ?? platformUrl, "vcCredentialUrl")
    this.routes = { ...DEFAULT_VC_PLATFORM_ROUTES, ...config.routes }
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetcher = config.fetcher ?? fetch
    this.shouldRetryOn = config.shouldRetryOn ?? ((errorCode) => errorCode === 401)
  }

  async login(input: PlatformLoginInput): Promise<PlatformSession> {
    const signer = signerFromInput(input, "platform login")
    if (signer.address !== input.bid) throw new BidValidationError("platform login", "signer address must match bid")
    const random = await this.postEnvelope(this.routes.authRandom, { bid: input.bid }, false)
    const randomStr = readString(readObject(random.data, "auth random data"), "randomStr")
    const signBlob = await signer.sign(randomStr)
    const response = await this.postEnvelope(this.routes.auth, {
      randomStr,
      signBlob,
      publicKey: signer.publicKey,
    }, false)
    const data = readObject(response.data, "auth data")
    const expiresIn = readOptionalNumber(data, "expiresIn")
    const session: PlatformSession = {
      bid: input.bid,
      accessToken: readString(data, "accessToken"),
      publicKey: signer.publicKey,
      ...(expiresIn === undefined ? {} : { expiresIn }),
    }
    this.session = session
    this.loginCredentials = { bid: input.bid, signer }
    return session
  }

  /**
   * 发证方门户两步登录：
   *   ① 平台主机 BID 挑战登录（同 login），拿到 wallet JWT；
   *   ② 凭证主机 sp/user/login 令牌交换，用 wallet JWT 换网关业务令牌。
   * 交换后的网关令牌写入会话，后续 issuer 业务请求（credential 路由组）用它。
   * 令牌过期重登（shouldRetryOn）会完整重放这两步。
   */
  async loginAsIssuerPortal(input: PlatformLoginInput): Promise<PlatformSession> {
    const walletSession = await this.login(input)
    const exchange = await this.postEnvelope(ISSUER_PORTAL_TOKEN_EXCHANGE_ROUTE, {
      accessToken: walletSession.accessToken,
    }, false, this.credentialBaseUrl)
    const data = readObject(exchange.data, "issuer portal login data")
    const expiresIn = readOptionalNumber(data, "expiresIn")
    const session: PlatformSession = {
      bid: input.bid,
      accessToken: readString(data, "accessToken"),
      publicKey: walletSession.publicKey,
      ...(expiresIn === undefined ? {} : { expiresIn }),
    }
    this.session = session
    this.portalLoginCredentials = { bid: input.bid, signer: signerFromInput(input, "platform login") }
    return session
  }

  async post(route: VcPlatformRoute, body: unknown, sessionRequired: boolean): Promise<unknown> {
    const first = await this.postOnce(route, body, sessionRequired)
    if (!sessionRequired || first.errorCode === 0) return readData(first)
    if (!this.shouldRetryOn(first.errorCode) || this.loginCredentials === undefined) {
      throw new PlatformApiError(first.errorCode, first.message)
    }
    // 发证方门户会话用两步登录重建，普通会话用挑战登录重建。
    if (this.portalLoginCredentials !== undefined) {
      await this.loginAsIssuerPortal(this.portalLoginCredentials)
    } else {
      await this.login(this.loginCredentials)
    }
    return readData(await this.postOnce(route, body, true))
  }

  getSession(): PlatformSession | undefined {
    return this.session
  }

  private async postOnce(route: VcPlatformRoute, body: unknown, sessionRequired: boolean): Promise<PlatformEnvelope> {
    if (sessionRequired && this.session === undefined) throw new BidConfigurationError("platform session", "login is required")
    const url = new URL(this.routes[route], isCredentialRoute(route) ? this.credentialBaseUrl : this.baseUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sessionRequired && this.session !== undefined ? { accessToken: this.session.accessToken } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new PlatformApiError(response.status, `platform returned HTTP ${response.status}`)
      const envelope = platformEnvelopeSchema.safeParse(await response.json())
      if (!envelope.success) throw new PlatformApiError(-1, "platform returned an invalid response envelope")
      return envelope.data
    } finally {
      clearTimeout(timeout)
    }
  }

  private async postEnvelope(route: string, body: unknown, sessionRequired: boolean, baseUrl: URL = this.baseUrl): Promise<PlatformEnvelope> {
    const url = new URL(route, baseUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sessionRequired && this.session !== undefined ? { accessToken: this.session.accessToken } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new PlatformApiError(response.status, `platform returned HTTP ${response.status}`)
      const envelope = platformEnvelopeSchema.safeParse(await response.json())
      if (!envelope.success) throw new PlatformApiError(-1, "platform returned an invalid response envelope")
      if (envelope.data.errorCode !== 0) throw new PlatformApiError(envelope.data.errorCode, envelope.data.message)
      return envelope.data
    } finally {
      clearTimeout(timeout)
    }
  }
}

/** 挂在凭证平台主机（vcCredentialUrl）上的路由：issuer 业务 + 远程核验。 */
const CREDENTIAL_ROUTES: ReadonlySet<VcPlatformRoute> = new Set([
  "issueBlob",
  "issueSubmit",
  "issueDisApprove",
  "applyList",
  "applyDetail",
  "revocationBlob",
  "revocationSubmit",
  "templateCreateBlob",
  "templateCreateSubmit",
  "templateManageList",
  "industryList",
  "categoryList",
  "vpVerify",
])

function isCredentialRoute(route: VcPlatformRoute): boolean {
  return CREDENTIAL_ROUTES.has(route)
}

function parseBaseUrl(value: string, field: string): URL {
  try {
    return new URL(value.endsWith("/") ? value : `${value}/`)
  } catch {
    throw new BidValidationError(field, "must be an absolute URL")
  }
}

function readData(envelope: PlatformEnvelope): unknown {
  if (envelope.errorCode !== 0) throw new PlatformApiError(envelope.errorCode, envelope.message)
  return envelope.data
}

function readObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BidValidationError(field, "must be an object")
  return Object.fromEntries(Object.entries(value))
}

function readString(value: Readonly<Record<string, unknown>>, field: string): string {
  const result = value[field]
  if (typeof result !== "string" || result === "") throw new BidValidationError(field, "must be a non-empty string")
  return result
}

function readOptionalNumber(value: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const result = value[field]
  if (result === undefined) return undefined
  if (typeof result !== "number") throw new BidValidationError(field, "must be a number")
  return result
}
