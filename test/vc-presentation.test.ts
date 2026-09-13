import assert from "node:assert/strict"
import test from "node:test"

import { encodeJsonPart } from "../src/vc/vc-jws.js"
import { findPresentationMismatches, mismatchesToErrors, verifyPresentationConsistency } from "../src/vc/vc-presentation.js"

const PAYLOAD = {
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  id: "did:bid:efCredential1234567890abcdef",
  type: ["VerifiableCredential", "identityCertification"],
  issuer: "did:bid:efIssuer1234567890abcdef",
  issuanceDate: "2025-01-01T00:00:00Z",
  validBefore: "2099-01-01T00:00:00Z",
  credentialSubject: {
    id: "did:bid:efHolder1234567890abcdef",
    age: { hash: "aa", salt: "bb", value: "123" },
    name: { hash: "cc", salt: "dd", value: "Alice" },
  },
}

const ISSUER = PAYLOAD.issuer as string

/** 构造与 PAYLOAD 一致的出示信封（credentialSubject 键序刻意与 payload 不同，验证忽略键序）。 */
function consistentEnvelope(): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: PAYLOAD.id,
    type: ["VerifiableCredential", "identityCertification"],
    issuer: { id: ISSUER },
    issuanceDate: "2025-01-01T00:00:00Z",
    validBefore: "2099-01-01T00:00:00Z",
    credentialSubject: {
      age: { hash: "aa", salt: "bb", value: "123" },
      id: "did:bid:efHolder1234567890abcdef",
      name: { hash: "cc", salt: "dd", value: "Alice" },
    },
    proof: { type: "JwtProof2020", jwt: jwsOf(PAYLOAD) },
  }
}

/** 用给定 payload 构造合法三段 compact JWS（签名段只要求可解析，不参与一致性校验）。 */
function jwsOf(payload: unknown): string {
  return `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart(payload)}.c2lnbmF0dXJl`
}

test("Given a presentation envelope matching the JWS payload with different key order, when checking consistency, then no mismatch is reported", () => {
  const envelope = consistentEnvelope()
  const mismatches = findPresentationMismatches(envelope, { ...emptyJws(), payload: PAYLOAD })
  assert.deepEqual(mismatches, [])
})

test("Given a presentation envelope with a tampered issuer id, when checking consistency, then only issuer.id is reported", () => {
  const envelope = consistentEnvelope()
  ;(envelope["issuer"] as { id: string }).id = "did:bid:efAnotherIssuer00000000000"
  const mismatches = findPresentationMismatches(envelope, { ...emptyJws(), payload: PAYLOAD })
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0]?.field, "issuer.id")
})

test("Given a presentation envelope with a tampered credentialSubject value, when checking consistency, then only credentialSubject is reported", () => {
  const envelope = consistentEnvelope() as { credentialSubject: Record<string, unknown> }
  const subject = envelope.credentialSubject["age"] as { value: string }
  subject.value = "999"
  const mismatches = findPresentationMismatches(envelope, { ...emptyJws(), payload: PAYLOAD })
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0]?.field, "credentialSubject")
})

test("Given a presentation envelope omitting optional comparison fields, when checking consistency, then only present fields are compared", () => {
  const envelope = consistentEnvelope() as Record<string, unknown>
  delete envelope["validBefore"]
  const mismatches = findPresentationMismatches(envelope, { ...emptyJws(), payload: PAYLOAD })
  assert.deepEqual(mismatches, [])
})

test("Given a consistent envelope, when verifying presentation consistency, then undefined is returned to continue normal verification", () => {
  const result = verifyPresentationConsistency(consistentEnvelope(), jwsOf(PAYLOAD))
  assert.equal(result, undefined)
})

test("Given a tampered envelope, when verifying presentation consistency, then a failed result with presentation-mismatch errors is returned", () => {
  const envelope = consistentEnvelope() as { type: string[] }
  envelope.type = ["VerifiableCredential", "premiumCertification"]
  const result = verifyPresentationConsistency(envelope, jwsOf(PAYLOAD))
  assert.notEqual(result, undefined)
  assert.equal(result?.verified, false)
  assert.equal(result?.checks.format, "failed")
  assert.deepEqual(result?.errors.map((error) => error.code), ["presentation-mismatch"])
  assert.equal(result?.errors[0]?.field, "type")
})

test("Given a malformed JWS, when verifying presentation consistency, then a jws-parse-failed result is returned", () => {
  const result = verifyPresentationConsistency(consistentEnvelope(), "not-a-jws")
  assert.notEqual(result, undefined)
  assert.equal(result?.verified, false)
  assert.equal(result?.errors[0]?.code, "jws-parse-failed")
})

test("mismatchesToErrors keeps field codes for downstream diagnostics", () => {
  const errors = mismatchesToErrors([{ field: "issuer.id", expected: "a", actual: "b" }])
  assert.equal(errors[0]?.code, "presentation-mismatch")
  assert.equal(errors[0]?.field, "issuer.id")
})

function emptyJws() {
  return {
    headerPart: "",
    payloadPart: "",
    signaturePart: "",
    header: {},
    payload: undefined as unknown,
  }
}
