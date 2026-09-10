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
  revocationBlob: "server/vc/revocation/blob",
  revocationSubmit: "server/vc/revocation/submit",
  vpVerify: "server/vp/verify",
} as const

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

  constructor(config: VcPlatformConfig = {}) {
    const urls = getBidSdkUrls()
    const platformUrl = urls.vcPlatformUrl
    if (platformUrl === undefined) throw new BidConfigurationError("vcPlatformUrl", "is required for the VC platform client")
    this.baseUrl = parseBaseUrl(platformUrl, "vcPlatformUrl")
    this.credentialBaseUrl = parseBaseUrl(urls.vcCredentialUrl ?? platformUrl, "vcCredentialUrl")
    this.routes = DEFAULT_VC_PLATFORM_ROUTES
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

  async post(route: VcPlatformRoute, body: unknown, sessionRequired: boolean): Promise<unknown> {
    const first = await this.postOnce(route, body, sessionRequired)
    if (!sessionRequired || first.errorCode === 0) return readData(first)
    if (!this.shouldRetryOn(first.errorCode) || this.loginCredentials === undefined) {
      throw new PlatformApiError(first.errorCode, first.message)
    }
    await this.login(this.loginCredentials)
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

  private async postEnvelope(route: string, body: unknown, sessionRequired: boolean): Promise<PlatformEnvelope> {
    const url = new URL(route, this.baseUrl)
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

function isCredentialRoute(route: VcPlatformRoute): boolean {
  return route === "issueBlob" || route === "issueSubmit" || route === "revocationBlob" || route === "revocationSubmit" || route === "vpVerify"
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
