import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import smCrypto from "brdc-sm-crypto"
import canonicalize from "canonicalize"

import { assembleJws, encodeJsonPart } from "../src/vc/vc-jws.js"
import { ddoContractIssuerDocumentReader, type ContractQueryReader } from "../src/vc/vc-local-protocol.js"
import { LocalVcVerifier } from "../src/vc/vc-verifier.js"

const trustedIssuer = { isTrusted: async (): Promise<boolean> => true }
const verificationNow = (): Date => new Date("2026-01-01T00:00:00Z")

test("Given a DDO queryBid response with an eligible raw SM2 key and a revoking platform reporting false, when locally verifying without caller keys, then the credential is verified", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const jws = credentialJws(keypair.encPrivateKey, keypair.encAddress, "credential / 1")
  let queryInput = ""
  let requestedUrl = ""
  let requestedMethod = ""
  const query: ContractQueryReader = async (request) => {
    queryInput = request.input
    return {
      queryRets: [{
        result: { value: JSON.stringify({
          id: keypair.encAddress,
          publicKey: [
            { id: `${keypair.encAddress}#wrong-algorithm`, type: "Ed25519", controller: keypair.encAddress, publicKeyHex: rawPublicKey },
            { id: `${keypair.encAddress}#missing-controller`, type: "SM2", controller: "", publicKeyHex: rawPublicKey },
            { id: `${keypair.encAddress}#missing-key`, type: "SM2", controller: keypair.encAddress, publicKeyHex: "" },
            { id: `${keypair.encAddress}#signing`, type: "SM2", controller: keypair.encAddress, publicKeyHex: rawPublicKey },
          ],
        }) },
      }],
    }
  }
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    revocationBaseUrl: "https://issuer-platform.example.com/",
    fetcher: async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? "GET"
      return json({ errorCode: 0, message: "ok", data: { revoked: false } })
    },
  })

  const result = await verifier.verifyCredential({ jws })

  assert.equal(result.verified, true)
  assert.equal(result.checks.issuerSignature, "passed")
  assert.equal(result.checks.revocation, "passed")
  assert.equal(queryInput, JSON.stringify({ method: "queryBid", params: { id: keypair.encAddress } }))
  assert.equal(requestedMethod, "GET")
  assert.equal(requestedUrl, "https://issuer-platform.example.com/api/cred/vc/revoked/credential%20%2F%201")
})

test("Given an issuer DID document without an eligible key, when locally verifying without caller keys, then issuer signature fails rather than being skipped", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const query: ContractQueryReader = async () => ({
    queryRets: [{
      result: { value: JSON.stringify({
        id: keypair.encAddress,
        publicKey: [{ id: `${keypair.encAddress}#wrong-algorithm`, type: "Ed25519", controller: keypair.encAddress, publicKeyHex: rawPublicKey }],
      }) },
    }],
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    revocationBaseUrl: "https://issuer-platform.example.com/",
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { revoked: false } }),
  })

  const result = await verifier.verifyCredential({ jws: credentialJws(keypair.encPrivateKey, keypair.encAddress) })

  assert.equal(result.checks.issuerSignature, "failed")
  assert.notEqual(result.checks.issuerSignature, "skipped")
})

test("Given no revocation base URL, when locally verifying, then revocation fails rather than being skipped", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const query: ContractQueryReader = async () => ({
    queryRets: [{ result: { value: JSON.stringify({ id: keypair.encAddress, publicKey: [{ id: `${keypair.encAddress}#signing`, type: "SM2", controller: keypair.encAddress, publicKeyHex: rawPublicKey }] }) } }],
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { revoked: false } }),
  })

  const result = await verifier.verifyCredential({ jws: credentialJws(keypair.encPrivateKey, keypair.encAddress) })

  assert.equal(result.checks.revocation, "failed")
  assert.notEqual(result.checks.revocation, "skipped")
})

test("Given the issuer platform reports the credential is revoked, when locally verifying, then revocation fails", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const query: ContractQueryReader = async () => ({
    queryRets: [{ result: { value: JSON.stringify({ id: keypair.encAddress, publicKey: [{ id: `${keypair.encAddress}#signing`, type: "SM2", controller: keypair.encAddress, publicKeyHex: rawPublicKey }] }) } }],
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    revocationBaseUrl: "https://issuer-platform.example.com",
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { revoked: true } }),
  })

  const result = await verifier.verifyCredential({ jws: credentialJws(keypair.encPrivateKey, keypair.encAddress) })

  assert.equal(result.checks.revocation, "failed")
  assert.notEqual(result.checks.revocation, "skipped")
})

test("Given the issuer platform responds with a protocol error or a network failure, when locally verifying, then revocation fails rather than being skipped", async (context) => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const jws = credentialJws(keypair.encPrivateKey, keypair.encAddress)
  const query: ContractQueryReader = async () => ({
    queryRets: [{ result: { value: JSON.stringify({ id: keypair.encAddress, publicKey: [{ id: `${keypair.encAddress}#signing`, type: "SM2", controller: keypair.encAddress, publicKeyHex: rawPublicKey }] }) } }],
  })
  const failures: readonly { readonly name: string; readonly fetcher: typeof fetch }[] = [
    { name: "a nonzero DataResp errorCode", fetcher: async () => json({ errorCode: 7, message: "unavailable" }) },
    { name: "a malformed DataResp envelope", fetcher: async () => json({ data: { revoked: false } }) },
    { name: "a network error", fetcher: async () => { throw new Error("network unavailable") } },
  ]

  for (const failure of failures) await context.test(`Given ${failure.name}, when checking revocation, then it fails`, async () => {
    const verifier = new LocalVcVerifier({
      issuerTrust: trustedIssuer,
      now: verificationNow,
      issuerDocumentReader: ddoContractIssuerDocumentReader(query),
      revocationBaseUrl: "https://issuer-platform.example.com",
      fetcher: failure.fetcher,
    })

    const result = await verifier.verifyCredential({ jws })

    assert.equal(result.checks.revocation, "failed")
    assert.notEqual(result.checks.revocation, "skipped")
  })
})

test("Given the issuer platform identifies a different credential or issuer, when locally verifying, then revocation fails only for those present mismatches", async (context) => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const jws = credentialJws(keypair.encPrivateKey, keypair.encAddress)
  const query: ContractQueryReader = async () => ({
    queryRets: [{ result: { value: JSON.stringify({ id: keypair.encAddress, publicKey: [{ id: `${keypair.encAddress}#signing`, type: "SM2", controller: keypair.encAddress, publicKeyHex: rawPublicKey }] }) } }],
  })
  const mismatches: readonly { readonly name: string; readonly data: Readonly<Record<string, boolean | string>> }[] = [
    { name: "a credential id mismatch", data: { revoked: false, id: "another-credential" } },
    { name: "an issuer mismatch", data: { revoked: false, issuer: "did:bid:efAnotherIssuer" } },
  ]

  for (const mismatch of mismatches) await context.test(`Given ${mismatch.name}, when checking revocation, then it fails`, async () => {
    const verifier = new LocalVcVerifier({
      issuerTrust: trustedIssuer,
      now: verificationNow,
      issuerDocumentReader: ddoContractIssuerDocumentReader(query),
      revocationBaseUrl: "https://issuer-platform.example.com",
      fetcher: async () => json({ errorCode: 0, message: "ok", data: mismatch.data }),
    })

    const result = await verifier.verifyCredential({ jws })

    assert.equal(result.checks.revocation, "failed")
    assert.notEqual(result.checks.revocation, "skipped")
  })
})

test("Given DDO queryBid reports the document is missing, when locally verifying, then signature and revocation fail rather than being skipped", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const query: ContractQueryReader = async () => ({
    queryRets: [{ error: { data: "10706,The bid document is not existed" } }],
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    revocationBaseUrl: "https://issuer-platform.example.com",
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { revoked: false } }),
  })

  const result = await verifier.verifyCredential({ jws: credentialJws(keypair.encPrivateKey, keypair.encAddress) })

  assert.equal(result.checks.issuerSignature, "failed")
  assert.equal(result.checks.revocation, "failed")
})

test("Given DDO queryBid returns an invalid document, when constructing the local verifier reader, then it rejects without exposing raw response", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const query: ContractQueryReader = async () => ({
    queryRets: [{ result: { value: "not-json" } }],
  })
  const reader = ddoContractIssuerDocumentReader(query)

  await assert.rejects(
    reader.get(keypair.encAddress),
    /invalid issuer DID document/,
  )
})

test("Given a JWS whose header alg mismatches the actual signing algorithm, when locally verifying with the matching algorithm key, then issuer signature passes via the lenient fallback", async () => {
  const keypair = enc.generate() // ED25519
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  // 服务端兼容场景：header alg 写死为 SM2，但实际使用 ED25519 私钥签名。
  const unsigned = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "credential-lenient",
    type: ["VerifiableCredential", "identityCertification"],
    issuer: keypair.encAddress,
    issuanceDate: "2025-01-01T00:00:00Z",
    validBefore: "2099-01-01T00:00:00Z",
    credentialSubject: { id: "did:bid:efHolder", name: "Alice" },
  })}`
  const jws = assembleJws(unsigned, enc.sign(Buffer.from(unsigned, "utf8").toString("hex"), keypair.encPrivateKey))
  const query: ContractQueryReader = async () => ({
    queryRets: [{ result: { value: JSON.stringify({ id: keypair.encAddress, publicKey: [{ id: `${keypair.encAddress}#signing`, type: "Ed25519", controller: keypair.encAddress, publicKeyHex: rawPublicKey }] }) } }],
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    revocationBaseUrl: "https://issuer-platform.example.com",
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { revoked: false } }),
  })

  const result = await verifier.verifyCredential({ jws })

  assert.equal(result.checks.issuerSignature, "passed")
  // 撤销不受 alg 回退影响，仍正常通过。
  assert.equal(result.checks.revocation, "passed")
})

test("Given DDO document keys fail to verify and the TDS issuer public key verifies, when locally verifying a selective-disclosure credential, then signature and disclosure pass via the TDS fallback", async () => {
  const keypair = enc.generate() // ED25519 签发私钥
  const wrongKeypair = enc.generate() // DDO 文档登记了错误的公钥
  const wrongRaw = enc.encToRawPublicKey(wrongKeypair.encPublicKey).rawPublicKey
  const subject: Readonly<Record<string, { readonly value: string; readonly salt: string; readonly hash: string }>> = {
    age: { value: "18", salt: "salt-1", hash: smCrypto.sm3("18salt-1") },
    name: { value: "Alice", salt: "salt-2", hash: smCrypto.sm3("Alicesalt-2") },
  }
  const fullPayload = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "credential-tds-fallback",
    type: ["VerifiableCredential", "identityCertification"],
    issuer: keypair.encAddress,
    issuanceDate: "2025-01-01T00:00:00Z",
    validBefore: "2099-01-01T00:00:00Z",
    parseType: "sel-disclose-SM2",
    credentialSubject: { id: "did:bid:efHolder", ...subject },
  }
  const hashSubject: Record<string, unknown> = { id: "did:bid:efHolder" }
  for (const [k, v] of Object.entries(subject)) {
    hashSubject[k] = { hash: v.hash }
  }
  const headerPart = encodeJsonPart({ alg: "SM2" })
  const hashPart = Buffer.from(canonicalize({ ...fullPayload, credentialSubject: hashSubject }) ?? "", "utf8").toString("base64url")
  const signingInput = Buffer.from(`${headerPart}.${hashPart}`, "utf8").toString("hex")
  const fullPart = encodeJsonPart(fullPayload)
  const jws = `${headerPart}.${fullPart}.${Buffer.from(enc.sign(signingInput, keypair.encPrivateKey), "hex").toString("base64url")}`
  const query: ContractQueryReader = async () => ({
    queryRets: [{
      result: { value: JSON.stringify({
        id: keypair.encAddress,
        publicKey: [{ id: `${keypair.encAddress}#signing`, type: "Ed25519", controller: keypair.encAddress, publicKeyHex: wrongRaw }],
      }) },
    }],
  })
  const verifier = new LocalVcVerifier({
    issuerTrust: trustedIssuer,
    now: verificationNow,
    issuerDocumentReader: ddoContractIssuerDocumentReader(query),
    issuerPublicKeySource: { getIssuerPublicKey: async () => keypair.encPublicKey },
    revocationBaseUrl: "https://issuer-platform.example.com",
    fetcher: async () => json({ errorCode: 0, message: "ok", data: { revoked: false } }),
  })

  const result = await verifier.verifyCredential({ jws })

  assert.equal(result.checks.issuerSignature, "passed")
  assert.equal(result.checks.disclosure, "passed")
  assert.equal(result.checks.revocation, "passed")
  assert.equal(result.verified, true)
})

function credentialJws(privateKey: string, issuer: string, id = "credential-1"): string {
  const unsigned = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id,
    type: ["VerifiableCredential", "identityCertification"],
    issuer,
    issuanceDate: "2025-01-01T00:00:00Z",
    validBefore: "2099-01-01T00:00:00Z",
    credentialSubject: { id: "did:bid:efHolder", name: "Alice" },
  })}`
  return assembleJws(unsigned, enc.sign(Buffer.from(unsigned, "utf8").toString("hex"), privateKey))
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}