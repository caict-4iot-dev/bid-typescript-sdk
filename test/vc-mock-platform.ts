import * as enc from "@caict-bif/bif-encryption"
import { z } from "zod"

import { assembleJws } from "../src/vc/vc-jws.js"
import { algorithmFromPublicKey, signingMessageHex, type VcSigningAlgorithm } from "../src/vc/vc-crypto.js"
import { commitmentHash, encodeCanonicalJson } from "../src/vc/vc-disclosure.js"

/** SDK 内部相对 /server 前缀：调用方只配置主机根，所有 VcPlatformClient 路由固定挂在 /server 之下。 */
const SERVER_PREFIX = "/server"

type Application = {
  readonly applyNo: string
  readonly holderBid: string
  readonly holderPublicKey: string
  readonly content: string
}

type IssuedCredential = {
  readonly credentialId: string
  readonly jws: string
  readonly issuerBid: string
  readonly issuerPublicKey: string
  revoked: boolean
}

type PendingPayload = {
  readonly signPayload: string
  readonly fullPayload: string
  readonly bcTxBlob: string
  readonly application: Application
  readonly profile: SigningProfile
}

type SigningProfile = {
  readonly algorithm: VcSigningAlgorithm
  readonly parseType: "sel-disclose-SM2" | "sel-disclose-ED25519"
  readonly hashAlgorithm: "SM3" | "SHA-256"
}

const signingProfiles: Readonly<Record<VcSigningAlgorithm, SigningProfile>> = {
  SM2: { algorithm: "SM2", parseType: "sel-disclose-SM2", hashAlgorithm: "SM3" },
  ED25519: { algorithm: "ED25519", parseType: "sel-disclose-ED25519", hashAlgorithm: "SHA-256" },
}

export type MockPlatform = {
  readonly walletBaseUrl: string
  readonly credentialBaseUrl: string
  readonly remoteBaseUrl: string
  readonly fetcher: typeof fetch
  getCredential(): IssuedCredential | undefined
}

export function createMockPlatform(): MockPlatform {
  const randomByBid = new Map<string, string>()
  const applications = new Map<string, Application>()
  const payloadById = new Map<string, PendingPayload>()
  let credential: IssuedCredential | undefined

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = parseBody(init)
    if (url.pathname === `${SERVER_PREFIX}/bid/auth/random`) {
      const bid = readString(body, "bid")
      const randomStr = "6465616462656566"
      randomByBid.set(bid, randomStr)
      return response({ errorCode: 0, message: "SUCCESS", data: { randomStr } })
    }
    if (url.pathname === `${SERVER_PREFIX}/bid/auth`) {
      const randomStr = readString(body, "randomStr")
      const signBlob = readString(body, "signBlob")
      const publicKey = readString(body, "publicKey")
      const bid = enc.publicToAddress(publicKey)
      if (randomByBid.get(bid) !== randomStr || !enc.verify(randomStr, signBlob, publicKey)) {
        return response({ errorCode: 401, message: "invalid signature" })
      }
      return response({ errorCode: 0, message: "SUCCESS", data: { accessToken: `token:${bid}`, expiresIn: 3600 } })
    }
    if (url.pathname === `${SERVER_PREFIX}/credential/recommend/list`) {
      return response({
        errorCode: 0,
        message: "SUCCESS",
        data: {
          recommendList: [{ certName: "身份凭证", icon: "https://example.com/icon.png", templateId: "template-identity" }],
          page: { pageStart: 1, pageSize: 10, pageTotal: 1 },
        },
      })
    }
    if (url.pathname === `${SERVER_PREFIX}/credential/template/detail`) {
      return response({ errorCode: 0, message: "SUCCESS", data: { templateBid: "template-identity", templateName: "身份凭证", issuerBid: "did:bid:issuer", data: "[]" } })
    }
    if (url.pathname === `${SERVER_PREFIX}/credential/assert`) return response({ errorCode: 0, message: "SUCCESS", data: {} })
    if (url.pathname === `${SERVER_PREFIX}/credential/apply`) {
      const applyNo = "apply-1"
      applications.set(applyNo, {
        applyNo,
        holderBid: readString(body, "bid"),
        holderPublicKey: readString(body, "publicKey"),
        content: readString(body, "content"),
      })
      return response({ errorCode: 0, message: "SUCCESS", data: { applyNo } })
    }
    if (url.pathname === `${SERVER_PREFIX}/credential/download`) {
      if (credential === undefined) return response({ errorCode: 404, message: "credential not issued" })
      const payload = JSON.parse(Buffer.from(credential.jws.split(".")[1] ?? "", "base64url").toString("utf8"))
      return response({ errorCode: 0, message: "SUCCESS", data: { jws: credential.jws, vc: JSON.stringify(payload), issueBid: credential.issuerBid, issueName: "Mock Issuer" } })
    }
    if (url.pathname === `${SERVER_PREFIX}/credential/owner/list`) {
      const applyNo = readString(body, "applyNo")
      const application = applications.get(applyNo)
      if (application === undefined) {
        return response({ errorCode: 0, message: "SUCCESS", data: { page: { pageStart: readNumber(body, "pageStart"), pageSize: readNumber(body, "pageSize"), pageTotal: 0 }, dataList: [] } })
      }
      const accessToken = new Headers(init?.headers).get("accessToken")
      if (accessToken !== `token:${application.holderBid}` || "userBid" in body) return response({ errorCode: 401, message: "invalid owner-list authentication" })
      return response({
        errorCode: 0,
        message: "SUCCESS",
        data: {
          page: { pageStart: readNumber(body, "pageStart"), pageSize: readNumber(body, "pageSize"), pageTotal: 1 },
          dataList: [{
            applyNo,
            status: credential === undefined ? "1" : "2",
            ...(credential === undefined ? {} : { credentialBid: credential.credentialId }),
          }],
        },
      })
    }
    if (url.pathname === `${SERVER_PREFIX}/credential/my/pending/list`) return response({ errorCode: 0, message: "SUCCESS", data: { page: { pageStart: 1, pageSize: 10, pageTotal: credential === undefined ? 1 : 0 }, applyList: credential === undefined ? [{ applyNo: "apply-1" }] : [] } })
    if (url.pathname === `${SERVER_PREFIX}/vc/issue/audit/blob`) {
      const application = applications.get(readString(body, "applyNo"))
      if (application === undefined) return response({ errorCode: 404, message: "application not found" })
      const issuerBid = readString(body, "auditBid")
      const profile = signingProfile(body)
      const isSelective = readNumber(body, "isSel") === 1
      const subject = { id: application.holderBid, ...parseRecord(application.content, "application content") }
      const fullSubject = isSelective ? addDisclosureFields(subject, profile) : subject
      const fullPayload = {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        id: "credential-1",
        type: ["VerifiableCredential", "identityCertification"],
        issuer: issuerBid,
        issuanceDate: "2026-01-01T00:00:00Z",
        validBefore: "2099-01-01T00:00:00Z",
        templateId: "template-identity",
        credentialSubject: fullSubject,
        parseType: isSelective ? profile.parseType : "direct",
      }
      const headerPart = encodeCanonicalJson({ alg: profile.algorithm })
      const fullPayloadPart = encodeCanonicalJson(fullPayload)
      const signingPayload = isSelective
        ? encodeCanonicalJson({ ...fullPayload, credentialSubject: disclosureHashOnly(fullPayload.credentialSubject) })
        : fullPayloadPart
      const payload = `${headerPart}.${signingPayload}`
      const fullPayloadText = `${headerPart}.${fullPayloadPart}`
      payloadById.set("payload-1", { signPayload: payload, fullPayload: fullPayloadText, bcTxBlob: "74782d626c6f622d31", application, profile })
      return response({ errorCode: 0, message: "SUCCESS", data: { payload, payloadId: "payload-1", bcTxBlob: "74782d626c6f622d31" } })
    }
    if (url.pathname === `${SERVER_PREFIX}/vc/issue/audit/submit`) {
      const stored = payloadById.get(readString(body, "payloadId"))
      if (stored === undefined) return response({ errorCode: 404, message: "payload not found" })
      const issuerBid = readString(body, "auditBid")
      const publicKey = readString(body, "publicKey")
      if (algorithmFromPublicKey(publicKey) !== stored.profile.algorithm) {
        return response({ errorCode: 401, message: "publicKey algorithm does not match issue blob alg" })
      }
      if (!enc.verify(signingMessageHex(stored.signPayload), readString(body, "signPayload"), publicKey) || !enc.verify(signingMessageHex(stored.bcTxBlob), readString(body, "signBcTxBlob"), publicKey)) {
        return response({ errorCode: 401, message: "invalid issuer signature" })
      }
      credential = { credentialId: "credential-1", jws: assembleJws(stored.fullPayload, readString(body, "signPayload")), issuerBid, issuerPublicKey: publicKey, revoked: false }
      return response({ errorCode: 0, message: "SUCCESS", data: { certBid: credential.credentialId, bid: stored.application.holderBid, trustedFlag: false } })
    }
    if (url.pathname === `${SERVER_PREFIX}/vc/revocation/blob`) return response({ errorCode: 0, message: "SUCCESS", data: { blobId: "revoke-1", blob: "7265766f6b652d63726564656e7469616c", txHash: "" } })
    if (url.pathname === `${SERVER_PREFIX}/vc/revocation/submit`) {
      if (credential === undefined) return response({ errorCode: 404, message: "credential not found" })
      const publicKey = readString(body, "publicKey")
      if (!enc.verify(signingMessageHex("7265766f6b652d63726564656e7469616c"), readString(body, "signBlob"), publicKey)) return response({ errorCode: 401, message: "invalid revoke signature" })
      credential.revoked = true
      return response({ errorCode: 0, message: "SUCCESS", data: {} })
    }
    if (url.pathname === "/credential/verification") {
      const wrapped = remoteCredentialSchema.parse(parseJson(readString(body, "json"), "remote credential"))
      const jws = wrapped.proof.jwt
      const verified = credential !== undefined && jws === credential.jws && !credential.revoked
      return response({ errorCode: 0, message: "SUCCESS", data: { isIssuer: verified, isIssuerSign: verified, verificationExpired: verified } })
    }
    return response({ errorCode: 404, message: `unhandled mock route ${url.pathname}` })
  }

  return {
    walletBaseUrl: "https://mock.wallet.example",
    credentialBaseUrl: "https://mock.credential.example",
    remoteBaseUrl: "https://mock.cross.example",
    fetcher,
    getCredential: () => credential,
  }
}

function parseBody(init: RequestInit | undefined): Readonly<Record<string, unknown>> {
  if (typeof init?.body !== "string") return {}
  return parseRecord(init.body, "mock body")
}

const remoteCredentialSchema = z.object({
  proof: z.object({ jwt: z.string().min(1) }),
})

function parseRecord(value: string, field: string): Readonly<Record<string, unknown>> {
  const parsed = parseJson(value, field)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${field} must be an object`)
  return Object.fromEntries(Object.entries(parsed))
}

function parseJson(value: string, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    throw new Error(`${field} must be valid JSON`)
  }
}

function readString(value: Readonly<Record<string, unknown>>, key: string): string {
  const result = value[key]
  if (typeof result !== "string" || result === "") throw new Error(`mock expected string ${key}`)
  return result
}

function readNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  const result = value[key]
  return typeof result === "number" ? result : 0
}

function disclosureHashOnly(subject: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(subject).map(([key, value]) => {
    if (key === "id") return [key, value]
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [key, value]
    const record = Object.fromEntries(Object.entries(value))
    return [key, { hash: record["hash"] }]
  }))
}

function signingProfile(body: Readonly<Record<string, unknown>>): SigningProfile {
  const profile = signingProfiles[readAlgorithm(body)]
  if (profile === undefined) throw new Error("mock expected alg SM2 or ED25519")
  return profile
}

function readAlgorithm(body: Readonly<Record<string, unknown>>): VcSigningAlgorithm {
  const value = body["alg"]
  if (value === undefined) return "SM2"
  if (value === "SM2" || value === "ED25519") return value
  throw new Error("mock expected alg SM2 or ED25519")
}

function addDisclosureFields(subject: Readonly<Record<string, unknown>>, profile: SigningProfile): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(subject).map(([key, value]) => {
    if (key === "id") return [key, value]
    const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)
    const salt = "sample-salt-001"
    return [key, { value: text, salt, hash: commitmentHash(text + salt, profile.hashAlgorithm) }]
  }))
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}
