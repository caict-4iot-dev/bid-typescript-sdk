import { z } from "zod"

import { BidConfigurationError, BidValidationError } from "../errors.js"
import { getBidSdkUrls } from "../config.js"
import { platformEnvelopeSchema, vcPayloadSchema, type VerificationChecks, type VerificationError, type VerificationResult } from "./vc-domain.js"
import { parseJws, verifyJwsSignature, verifyJwsWithKey } from "./vc-jws.js"
import { verifyHashOnlySignature, verifyHashOnlySignatureLenient, verifySelectiveDisclosure } from "./vc-disclosure.js"
import type { IssuerPublicKeySource, IssuerTrustReader } from "./vc-trust.js"
import { eligibleIssuerKeys, signatureCheck, verifyRevocation, type IssuerDidDocument, type IssuerDocumentReader } from "./vc-local-protocol.js"

const crossBorderEnvelopeSchema = z.object({
  isIssuer: z.boolean().optional(),
  isIssuerSign: z.boolean().optional(),
  verificationExpired: z.boolean().optional(),
}).passthrough()


type LocalVerifierConfig = {
  readonly issuerTrust: IssuerTrustReader
  readonly now?: () => Date
  readonly issuerDocumentReader?: IssuerDocumentReader | undefined
  readonly issuerPublicKeySource?: IssuerPublicKeySource | undefined
  readonly revocationBaseUrl?: string | undefined
  readonly fetcher?: typeof fetch
}

export type VerifyCredentialInput = {
  readonly jws: string
  readonly issuerPublicKeys?: readonly string[]
}

export type PlatformVerifierOptions = {
  readonly apiKey?: string
  readonly apiKeyHeader?: string
  readonly timeoutMs?: number
  readonly fetcher?: typeof fetch
}

export type PlatformVerifyCredentialInput = {
  readonly jws: string
  readonly fileName?: string
}

export class LocalVcVerifier {
  private readonly issuerTrust: IssuerTrustReader
  private readonly now: () => Date
  private readonly issuerDocumentReader: IssuerDocumentReader | undefined
  private readonly issuerPublicKeySource: IssuerPublicKeySource | undefined
  private readonly revocationBaseUrl: string | undefined
  private readonly fetcher: typeof fetch
  private documentResolveError: string | undefined

  constructor(config: LocalVerifierConfig) {
    if (config?.issuerTrust === undefined) throw new BidConfigurationError("issuer trust", "is required for local VC verification")
    this.issuerTrust = config.issuerTrust
    this.now = config.now ?? (() => new Date())
    this.issuerDocumentReader = config.issuerDocumentReader
    this.issuerPublicKeySource = config.issuerPublicKeySource
    this.revocationBaseUrl = config.revocationBaseUrl
    this.fetcher = config.fetcher ?? fetch
  }

  async verifyCredential(input: VerifyCredentialInput): Promise<VerificationResult> {
    const skipped = skippedChecks()
    try {
      const parsed = parseJws(input.jws)
      const payload = vcPayloadSchema.safeParse(parsed.payload)
      if (!payload.success || !payload.data.type.includes("VerifiableCredential")) {
        return invalidLocalCredentialResult("JWS payload is not a verifiable credential")
      }
      const validity = isValid(payload.data.issuanceDate, payload.data.validBefore, this.now()) ? "passed" : "failed"
      const disclosurePresent = hasDisclosurePayload(payload.data)
      const resolvedDocument = await this.resolveIssuerDocument(payload.data.issuer)
      const ddoKeys = resolvedDocument === undefined
        ? input.issuerPublicKeys
        : eligibleIssuerKeys(payload.data.issuer, resolvedDocument)
      let verifiedIssuerKey = findVerifiedIssuerKey(parsed, ddoKeys, disclosurePresent)
      // DDO 文档公钥验证失败时的兼容回退：服务端可能未把签发公钥同步到 DDO 文档，
      // 改用 TDS issuer_<bid> metadata 的 publicKey 字段作为额外候选（仍走宽松验签回退）。
      if (verifiedIssuerKey === undefined && this.issuerPublicKeySource !== undefined && resolvedDocument !== undefined) {
        const tdsPublicKey = await this.safeTdsIssuerPublicKey(payload.data.issuer)
        if (tdsPublicKey !== undefined) {
          verifiedIssuerKey = findVerifiedIssuerKey(parsed, [tdsPublicKey], disclosurePresent)
        }
      }
      const signature = signatureCheck(verifiedIssuerKey, input.issuerPublicKeys, this.issuerDocumentReader)
      const disclosure = disclosurePresent
        ? (verifiedIssuerKey === undefined ? "failed" : (verifySelectiveDisclosure(parsed, verifiedIssuerKey).valid ? "passed" : "failed"))
        : "skipped"
      const revocation = this.documentResolveError !== undefined
        ? "failed"
        : this.revocationBaseUrl === undefined
          ? "failed"
          : await verifyRevocation({ revocationBaseUrl: this.revocationBaseUrl, credentialId: payload.data.id, issuer: payload.data.issuer, fetcher: this.fetcher })
      let issuerTrust: VerificationChecks["issuerTrust"]
      let issuerTrustError: VerificationError | undefined
      try {
        issuerTrust = await this.issuerTrust.isTrusted(payload.data.issuer) ? "passed" : "failed"
        if (issuerTrust === "failed") issuerTrustError = { code: "issuer-not-trusted", message: "issuer is not registered in IAM or TDS" }
      } catch (error) {
        issuerTrust = "failed"
        issuerTrustError = {
          code: "issuer-trust-lookup-failed",
          message: error instanceof Error ? error.message : "issuer trust lookup failed",
        }
      }
      const errors: VerificationError[] = [
        ...(validity === "failed" ? [{ code: "credential-expired", message: "credential is outside its validity window" }] : []),
        ...(signature === "failed" ? [{ code: "issuer-signature-invalid", message: "issuer signature verification failed" }] : []),
        ...(signature === "skipped" ? [{ code: "issuer-key-not-provided", message: "issuer signature was not checked because no public key was supplied" }] : []),
        ...(disclosure === "failed" ? [{ code: "disclosure-hash-invalid", message: "selective disclosure hash or issuer signature verification failed" }] : []),
        ...(issuerTrustError === undefined ? [] : [issuerTrustError]),
        ...(revocation === "failed" ? [{ code: "revocation-check-failed", message: "credential revocation verification failed" }] : []),
        ...(revocation === "skipped" ? [{ code: "revocation-not-checked", message: "revocation requires a configured status resolver" }] : []),
        ...(disclosure === "skipped" ? [{ code: "disclosure-not-present", message: "credential does not contain selective disclosure fields" }] : []),
      ]
      return result({ ...skipped, format: "passed", validity, issuerTrust, issuerSignature: signature, disclosure, revocation }, errors)
    } catch (error) {
      return invalidLocalCredentialResult(error instanceof Error ? error.message : "credential JWS could not be parsed", "jws-parse-failed")
    }
  }

  private async resolveIssuerDocument(issuer: string): Promise<IssuerDidDocument | undefined> {
    if (this.issuerDocumentReader === undefined) {
      this.documentResolveError = undefined
      return undefined
    }
    try {
      const document = await this.issuerDocumentReader.get(issuer)
      this.documentResolveError = undefined
      return document
    } catch (error) {
      this.documentResolveError = error instanceof Error ? error.message : "issuer DID document resolution failed"
      return undefined
    }
  }

  private async safeTdsIssuerPublicKey(issuer: string): Promise<string | undefined> {
    if (this.issuerPublicKeySource === undefined) return undefined
    try {
      return await this.issuerPublicKeySource.getIssuerPublicKey(issuer)
    } catch {
      return undefined
    }
  }
}

export class RemoteVcVerifier {
  private readonly baseUrl: URL
  private readonly endpoint: string
  private readonly apiKey: string | undefined
  private readonly apiKeyHeader: string | undefined
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(config: PlatformVerifierOptions = {}) {
    const verificationUrl = getBidSdkUrls().vcVerificationUrl
    if (verificationUrl === undefined) throw new BidConfigurationError("vcVerificationUrl", "is required for platform verification")
    this.baseUrl = parseBaseUrl(verificationUrl)
    this.endpoint = "/credential/verification"
    this.apiKey = config.apiKey
    this.apiKeyHeader = config.apiKeyHeader
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetcher = config.fetcher ?? fetch
    if (this.apiKey !== undefined && this.apiKeyHeader === undefined) {
      throw new BidValidationError("apiKeyHeader", "is required when apiKey is provided")
    }
  }

  async verifyCredential(input: PlatformVerifyCredentialInput): Promise<VerificationResult> {
    try {
      const outerCredential = toCrossBorderCredential(input.jws)
      const response = await this.post({
        json: JSON.stringify(outerCredential),
        ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      })
      if (response.errorCode !== 0) {
        return result(skippedChecks(), [{ code: "remote-verification-failed", message: response.message }], response.data)
      }
      const data = crossBorderEnvelopeSchema.safeParse(response.data)
      if (!data.success) return result(skippedChecks(), [{ code: "remote-response-invalid", message: "remote verifier returned invalid data" }], response.data)
      // 跨境 VpBiz 的字段名沿用历史命名，但其值来自 checkValidBefore()：true 表示仍在有效期。
      const isWithinValidityWindow = data.data.verificationExpired === true
      const checks: VerificationChecks = {
        format: "passed",
        issuerTrust: data.data.isIssuer === true ? "passed" : "failed",
        issuerSignature: data.data.isIssuerSign === true ? "passed" : "failed",
        validity: isWithinValidityWindow ? "passed" : "failed",
        disclosure: "skipped",
        revocation: "skipped",
      }
      const errors: VerificationError[] = [
        ...(checks.issuerTrust === "failed" ? [{ code: "issuer-not-trusted", message: "remote verifier did not trust the issuer" }] : []),
        ...(checks.issuerSignature === "failed" ? [{ code: "issuer-signature-invalid", message: "remote verifier rejected the issuer signature" }] : []),
        ...(checks.validity === "failed" ? [{ code: "credential-expired", message: "remote verifier reported the credential is outside its validity window" }] : []),
        { code: "remote-revocation-unknown", message: "remote verifier response does not expose revocation status" },
      ]
      return result(checks, errors, response.data)
    } catch (error) {
      return result(skippedChecks(), [{
        code: "remote-request-failed",
        message: error instanceof Error ? error.message : "remote verifier request failed",
      }])
    }
  }

  private async post(body: unknown): Promise<z.infer<typeof platformEnvelopeSchema>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(new URL(this.endpoint, this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey === undefined || this.apiKeyHeader === undefined ? {} : { [this.apiKeyHeader]: this.apiKey }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`remote verifier returned HTTP ${response.status}`)
      const envelope = platformEnvelopeSchema.safeParse(await response.json())
      if (!envelope.success) throw new Error("remote verifier returned an invalid response envelope")
      return envelope.data
    } finally {
      clearTimeout(timeout)
    }
  }
}

function toCrossBorderCredential(jws: string): object {
  const parsed = parseJws(jws)
  const payload = vcPayloadSchema.parse(parsed.payload)
  if (payload.validBefore === undefined) throw new BidValidationError("credential.validBefore", "is required by the remote verifier")
  return {
    "@context": payload["@context"],
    type: payload.type,
    issuer: { id: payload.issuer },
    issuanceDate: payload.issuanceDate,
    validBefore: payload.validBefore,
    credentialSubject: payload.credentialSubject,
    proof: {
      type: "JsonWebSignature2020",
      jwt: jws,
    },
  }
}

function findVerifiedIssuerKey(jws: ReturnType<typeof parseJws>, publicKeys: readonly string[] | undefined, disclosure: boolean): string | undefined {
  if (publicKeys === undefined) return undefined
  // 标准路径：header alg 与公钥算法必须一致。
  const strictMatch = publicKeys.find((publicKey) => disclosure ? verifyHashOnlySignature(jws, publicKey) : verifyJwsWithKey(jws, publicKey))
  if (strictMatch !== undefined) return strictMatch
  // 兼容回退：服务端可能把 JWS header alg 写死（如 alg=SM2）但实际用另一算法签名，
  // 此时忽略 header alg 声明，改用宽松验签逐钥尝试；成功即视为可用发行方公钥。
  return publicKeys.find((publicKey) => disclosure ? verifyHashOnlySignatureLenient(jws, publicKey) : verifyJwsSignature(jws, publicKey))
}

function isValid(issuanceDate: string, validBefore: string | undefined, now: Date): boolean {
  const issued = Date.parse(issuanceDate)
  if (Number.isNaN(issued) || issued > now.getTime()) return false
  if (validBefore === undefined) return true
  const expires = Date.parse(validBefore)
  return !Number.isNaN(expires) && now.getTime() < expires
}

function hasDisclosurePayload(payload: z.infer<typeof vcPayloadSchema>): boolean {
  return Object.values(payload.credentialSubject).some((value) => typeof value === "object" && value !== null && !Array.isArray(value) && "hash" in value)
}

function skippedChecks(): VerificationChecks {
  return {
    format: "skipped",
    issuerTrust: "skipped",
    issuerSignature: "skipped",
    validity: "skipped",
    disclosure: "skipped",
    revocation: "skipped",
  }
}

function invalidLocalCredentialResult(message: string, formatCode = "invalid-credential"): VerificationResult {
  return result({ ...skippedChecks(), format: "failed", issuerTrust: "failed" }, [
    { code: formatCode, message },
    { code: "issuer-trust-unavailable", message: "issuer trust could not be checked because the credential format is invalid" },
  ])
}

function result(checks: VerificationChecks, errors: readonly VerificationError[], raw?: unknown): VerificationResult {
  const verified = checks.format === "passed"
    && checks.issuerTrust === "passed"
    && checks.issuerSignature === "passed"
    && checks.validity === "passed"
    && checks.disclosure !== "failed"
    && checks.revocation === "passed"
  return { verified, checks, errors, ...(raw === undefined ? {} : { raw }) }
}

function parseBaseUrl(value: string): URL {
  try {
    return new URL(value.endsWith("/") ? value : `${value}/`)
  } catch {
    throw new BidValidationError("baseUrl", "must be an absolute URL")
  }
}
