import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"
import smCrypto from "brdc-sm-crypto"

import { createEncSigner } from "../src/vc/vc-crypto.js"
import { createSelectiveDisclosurePresentation, signSelectiveDisclosure, verifySelectiveDisclosure } from "../src/vc/vc-disclosure.js"
import { encodeJsonPart, parseJws } from "../src/vc/vc-jws.js"

test("Given a credential payload, when signing selective disclosure, then value and salt are retained while the signature covers hash-only payload", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const jws = await signSelectiveDisclosure({
    header: { alg: "SM2" },
    payload: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "credential-1",
      type: ["VerifiableCredential", "identityCertification"],
      issuer: keypair.encAddress,
      issuanceDate: "2026-01-01T00:00:00Z",
      validBefore: "2099-01-01T00:00:00Z",
      credentialSubject: { id: "did:bid:efHolder", age: 18, country: "CN" },
    },
    signer,
    saltFactory: () => "fixed-salt",
  })

  const parsed = parseJws(jws)
  const payload = parsed.payload as { readonly credentialSubject: { readonly age: { readonly value: string; readonly salt: string; readonly hash: string } } }
  assert.equal(payload.credentialSubject.age.value, "18")
  assert.equal(payload.credentialSubject.age.salt, "fixed-salt")
  assert.equal(payload.credentialSubject.age.hash, smCrypto.sm3("18fixed-salt"))
  assert.deepEqual(verifySelectiveDisclosure(parsed, signer.publicKey), { valid: true, disclosedFields: ["age", "country"] })
})

test("Given a selective disclosure credential, when presenting only one field, then undisclosed fields contain hash only and tampering fails", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const jws = await signSelectiveDisclosure({
    header: { alg: "SM2" },
    payload: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "credential-1",
      type: ["VerifiableCredential", "identityCertification"],
      issuer: keypair.encAddress,
      issuanceDate: "2026-01-01T00:00:00Z",
      validBefore: "2099-01-01T00:00:00Z",
      credentialSubject: { id: "did:bid:efHolder", age: 18, country: "CN" },
    },
    signer,
    saltFactory: () => "fixed-salt",
  })
  const presented = createSelectiveDisclosurePresentation(jws, ["age"])
  const parsed = parseJws(presented)
  const subject = parsed.payload as { readonly credentialSubject: { readonly age: unknown; readonly country: unknown } }
  assert.deepEqual(subject.credentialSubject.country, { hash: smCrypto.sm3("CNfixed-salt") })
  assert.equal(verifySelectiveDisclosure(parsed, signer.publicKey).valid, true)

  const tamperedPayload = JSON.parse(Buffer.from(parsed.payloadPart, "base64url").toString("utf8")) as { credentialSubject: { age: { value: string; salt: string; hash: string }; country: unknown } }
  tamperedPayload.credentialSubject.age.value = "19"
  const tampered = `${parsed.headerPart}.${encodeJsonPart(tamperedPayload)}.${parsed.signaturePart}`
  assert.equal(verifySelectiveDisclosure(parseJws(tampered), signer.publicKey).valid, false)
})

test("Given a legacy credential without parseType, when checking disclosure hashes, then it uses the SM3 profile", () => {
  const payload = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "credential-legacy",
    type: ["VerifiableCredential", "identityCertification"],
    issuer: "did:bid:efLegacy",
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: {
      id: "did:bid:efHolder",
      age: { value: "18", salt: "fixed-salt", hash: smCrypto.sm3("18fixed-salt") },
    },
  }
  const headerPart = encodeJsonPart({ alg: "SM2" })
  const payloadPart = encodeJsonPart(payload)

  const result = verifySelectiveDisclosure(parseJws(`${headerPart}.${payloadPart}.AA`))

  assert.deepEqual(result, { valid: true, disclosedFields: ["age"] })
})
