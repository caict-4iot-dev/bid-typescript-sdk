import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import { configureBidSdk } from "../src/config.js"
import { createEncSigner } from "../src/vc/vc-crypto.js"
import { signSelectiveDisclosure } from "../src/vc/vc-disclosure.js"
import { assembleJws, encodeJsonPart, parseJws } from "../src/vc/vc-jws.js"
import { LocalVcVerifier, RemoteVcVerifier } from "../src/vc/vc-verifier.js"

configureBidSdk({ directNodeUrl: "https://node.example.com", bopUrl: "https://bop.example.com", parserUrl: "https://parser.example.com/bid/", vcPlatformUrl: "https://wallet.example.com", vcCredentialUrl: "https://credential.example.com", vcVerificationUrl: "https://cross.example.com" })

const trustedIssuer = { isTrusted: async (): Promise<boolean> => true }

test("Given no issuer trust configuration, when constructing a local verifier, then it fails fast", () => {
  assert.throws(
    () => Reflect.construct(LocalVcVerifier, []),
    /issuer trust/i,
  )
})

test("Given a malformed credential, when locally verifying, then issuer trust fails instead of being skipped", async () => {
  const verifier = new LocalVcVerifier({ issuerTrust: trustedIssuer })

  const result = await verifier.verifyCredential({ jws: "not-a-jws" })

  assert.equal(result.checks.format, "failed")
  assert.equal(result.checks.issuerTrust, "failed")
  assert.equal(result.errors.some((error) => error.code === "issuer-trust-unavailable"), true)
})

test("Given a valid signed credential and issuer key, when locally verifying it, then format validity and signature pass", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const jws = credentialJws(keypair.encPrivateKey, keypair.encAddress, "2099-01-01T00:00:00Z")
  const verifier = new LocalVcVerifier({ issuerTrust: trustedIssuer, now: () => new Date("2026-01-01T00:00:00Z") })

  const result = await verifier.verifyCredential({ jws, issuerPublicKeys: [keypair.encPublicKey] })

  assert.equal(result.verified, false)
  assert.equal(result.checks.format, "passed")
  assert.equal(result.checks.issuerSignature, "passed")
  assert.equal(result.checks.validity, "passed")
  assert.equal(result.checks.issuerTrust, "passed")
})

test("Given a selective disclosure credential with a tampered value, when locally verifying it, then disclosure and the overall result fail", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const jws = await signSelectiveDisclosure({
    header: { alg: "SM2" },
    payload: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "credential-1",
      type: ["VerifiableCredential", "identityCertification"],
      issuer: signer.address,
      issuanceDate: "2025-01-01T00:00:00Z",
      validBefore: "2099-01-01T00:00:00Z",
      credentialSubject: { id: "did:bid:efHolder", age: 18 },
    },
    signer,
    saltFactory: () => "fixed-salt",
  })
  const parsed = parseJws(jws)
  const payload = JSON.parse(Buffer.from(parsed.payloadPart, "base64url").toString("utf8")) as { credentialSubject: { age: { value: string; salt: string; hash: string } } }
  payload.credentialSubject.age.value = "19"
  const tampered = `${parsed.headerPart}.${encodeJsonPart(payload)}.${parsed.signaturePart}`
  const verifier = new LocalVcVerifier({ issuerTrust: trustedIssuer, now: () => new Date("2026-01-01T00:00:00Z") })

  const result = await verifier.verifyCredential({ jws: tampered, issuerPublicKeys: [signer.publicKey] })

  assert.equal(result.verified, false)
  assert.equal(result.checks.disclosure, "failed")
})

test("Given multiple issuer keys with the valid key after an invalid key, when locally verifying selective disclosure, then it verifies with the matching key", async () => {
  const invalidKey = enc.getBidAndKeyPairBySM2()
  const validKey = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(validKey.encPrivateKey)
  const jws = await signSelectiveDisclosure({
    header: { alg: "SM2" },
    payload: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "credential-1",
      type: ["VerifiableCredential", "identityCertification"],
      issuer: signer.address,
      issuanceDate: "2025-01-01T00:00:00Z",
      validBefore: "2099-01-01T00:00:00Z",
      credentialSubject: { id: "did:bid:efHolder", age: 18 },
    },
    signer,
    saltFactory: () => "fixed-salt",
  })
  const verifier = new LocalVcVerifier({ issuerTrust: trustedIssuer, now: () => new Date("2026-01-01T00:00:00Z") })

  const result = await verifier.verifyCredential({ jws, issuerPublicKeys: [invalidKey.encPublicKey, validKey.encPublicKey] })

  assert.equal(result.checks.issuerSignature, "passed")
  assert.equal(result.checks.disclosure, "passed")
})

test("Given an expired credential, when locally verifying it, then validity fails", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const verifier = new LocalVcVerifier({ issuerTrust: trustedIssuer, now: () => new Date("2026-01-01T00:00:00Z") })

  const result = await verifier.verifyCredential({ jws: credentialJws(keypair.encPrivateKey, keypair.encAddress, "2025-01-01T00:00:00Z") })

  assert.equal(result.verified, false)
  assert.equal(result.checks.validity, "failed")
})

test("Given an issuer absent from IAM and TDS, when locally verifying, then issuer trust fails", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const verifier = new LocalVcVerifier({
    issuerTrust: { isTrusted: async () => false },
    now: () => new Date("2026-01-01T00:00:00Z"),
  })

  const result = await verifier.verifyCredential({
    jws: credentialJws(keypair.encPrivateKey, keypair.encAddress, "2099-01-01T00:00:00Z"),
    issuerPublicKeys: [keypair.encPublicKey],
  })

  assert.equal(result.checks.issuerTrust, "failed")
  assert.equal(result.errors.some((error) => error.code === "issuer-not-trusted"), true)
})

test("Given an issuer trust lookup error, when locally verifying, then it reports a trust lookup failure", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const verifier = new LocalVcVerifier({
    issuerTrust: {
      isTrusted: async () => {
        throw new Error("metadata unavailable")
      },
    },
    now: () => new Date("2026-01-01T00:00:00Z"),
  })

  const result = await verifier.verifyCredential({
    jws: credentialJws(keypair.encPrivateKey, keypair.encAddress, "2099-01-01T00:00:00Z"),
    issuerPublicKeys: [keypair.encPublicKey],
  })

  assert.equal(result.checks.issuerTrust, "failed")
  assert.equal(result.errors.some((error) => error.code === "issuer-trust-lookup-failed" && error.message.includes("metadata unavailable")), true)
  assert.equal(result.errors.some((error) => error.code === "jws-parse-failed"), false)
  assert.equal("mode" in result, false)
})

test("Given a credential JWS, when calling the remote verifier, then it sends the cross-border proof.jwt envelope", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const jws = credentialJws(keypair.encPrivateKey, keypair.encAddress, "2099-01-01T00:00:00Z")
  let request: Readonly<Record<string, unknown>> | undefined
  const verifier = new RemoteVcVerifier({
    apiKey: "api-key",
    apiKeyHeader: "x-api-key",
    fetcher: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-api-key"), "api-key")
      request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      return json({ errorCode: 0, message: "ok", data: { isIssuer: true, isIssuerSign: true, verificationExpired: true } })
    },
  })

  const result = await verifier.verifyCredential({ jws, fileName: "credential.json" })
  const wrapped = JSON.parse(String(request?.["json"])) as { readonly issuer: { readonly id: string }; readonly proof: { readonly jwt: string } }

  assert.equal(wrapped.issuer.id, keypair.encAddress)
  assert.equal(wrapped.proof.jwt, jws)
  assert.equal(result.verified, false)
  assert.equal(result.checks.issuerSignature, "passed")
  assert.equal(result.checks.issuerTrust, "passed")
  assert.equal(result.checks.revocation, "skipped")
  assert.equal("mode" in result, false)
})

test("Given a cross-border response with false validity flag, when remotely verifying, then it reports failed validity", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const verifier = new RemoteVcVerifier({
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { isIssuer: true, isIssuerSign: true, verificationExpired: false } }),
  })

  const result = await verifier.verifyCredential({ jws: credentialJws(keypair.encPrivateKey, keypair.encAddress, "2099-01-01T00:00:00Z") })

  assert.equal(result.verified, false)
  assert.equal(result.checks.validity, "failed")
})

function credentialJws(privateKey: string, issuer: string, validBefore: string): string {
  const unsigned = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "credential-1",
    type: ["VerifiableCredential", "identityCertification"],
    issuer,
    issuanceDate: "2025-01-01T00:00:00Z",
    validBefore,
    credentialSubject: { id: "did:bid:efHolder", name: "Alice" },
  })}`
  return assembleJws(unsigned, enc.sign(Buffer.from(unsigned, "utf8").toString("hex"), privateKey))
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}
