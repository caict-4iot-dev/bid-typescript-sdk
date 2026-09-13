import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"

import * as enc from "@caict-bif/bif-encryption"

import { configureBidSdk } from "../src/config.js"
import { createVcOperationsController } from "../src/vc/index.js"
import { parseCredentialId } from "../src/vc/vc-domain.js"
import { encodeJsonPart, parseJws, readJwsAlgorithm } from "../src/vc/vc-jws.js"
import { createMockPlatform } from "./vc-mock-platform.js"

configureBidSdk({
  directNodeUrl: "https://node.example.com",
  bopUrl: "https://bop.example.com",
  parserUrl: "https://parser.example.com/bid/",
  vcPlatformUrl: "https://mock.wallet.example",
  vcCredentialUrl: "https://mock.credential.example",
  vcVerificationUrl: "https://mock.cross.example",
})

function createTrustedVc() {
  const controller = createVcOperationsController()
  controller.connect({ issuerTrust: { isTrusted: async () => true } })
  return controller.operations
}

test("Given holder issuer and verifier roles, when they complete the mock VC flow, then verification succeeds before revocation and application status remains approved after revocation", async () => {
  const vc = createTrustedVc()
  const mock = createMockPlatform()
  const holderKeys = enc.getBidAndKeyPairBySM2()
  const issuerKeys = enc.getBidAndKeyPairBySM2()
  const holderSigner = vc.signer.fromPrivateKey(holderKeys.encPrivateKey)
  const issuerSigner = vc.signer.fromPrivateKey(issuerKeys.encPrivateKey)
  const holderPlatform = vc.platform.create({ fetcher: mock.fetcher })
  const issuerPlatform = vc.platform.create({ fetcher: mock.fetcher })
  const holder = vc.holder.create(holderPlatform)
  const issuer = vc.issuer.create(issuerPlatform)

  const holderSession = await holderPlatform.login({ bid: holderSigner.address, signer: holderSigner })
  await holder.getTemplate(holderSession, { templateId: "template-identity" })
  await holder.assertApplication(holderSession, { templateId: "template-identity" })
  const applyNo = await holder.applyCredential(holderSession, { templateId: "template-identity", subject: { name: "Alice" } })
  const issuerSession = await issuerPlatform.login({ bid: issuerSigner.address, signer: issuerSigner })
  await issuer.issue(issuerSession, { issuer: { bid: issuerSigner.address, signer: issuerSigner }, applyNo, status: 2 })
  const downloaded = await holder.downloadCredential(holderSession, { credentialId: parseCredentialId("credential-1") })

  const localResult = await vc.verifier.verifyCredential({
    jws: downloaded.jws,
    issuerPublicKeys: [issuerSigner.publicKey],
  })
  const remoteResult = await vc.verifier.verifyCredentialByPlatform({ jws: downloaded.jws }, {
    apiKey: "mock-api-key",
    apiKeyHeader: "x-api-key",
    fetcher: mock.fetcher,
  })

  assert.equal(localResult.verified, false)
  assert.equal(localResult.checks.issuerSignature, "passed")
  assert.equal(localResult.checks.disclosure, "skipped")
  assert.equal(remoteResult.verified, false)
  assert.equal(remoteResult.checks.issuerSignature, "passed")
  assert.equal(remoteResult.checks.disclosure, "skipped")
  await issuer.revoke(issuerSession, { issuer: { bid: issuerSigner.address, signer: issuerSigner }, credentialBid: "credential-1" })
  const status = await holder.getApplicationStatus(holderSession, applyNo)
  assert.equal(status.status, "2")
})

test("Given ED25519 holder and issuer, when they complete a direct mock VC flow, then the JWS header is ED25519 and the issuer signature verifies locally", async () => {
  const vc = createTrustedVc()
  const mock = createMockPlatform()
  const holderKeys = enc.getBidAndKeyPairBySM2()
  const issuerKeys = enc.generate()
  const holderSigner = vc.signer.fromPrivateKey(holderKeys.encPrivateKey)
  const issuerSigner = vc.signer.fromPrivateKey(issuerKeys.encPrivateKey)
  assert.equal(issuerSigner.algorithm, "ED25519")
  const holderPlatform = vc.platform.create({ fetcher: mock.fetcher })
  const issuerPlatform = vc.platform.create({ fetcher: mock.fetcher })
  const holder = vc.holder.create(holderPlatform)
  const issuer = vc.issuer.create(issuerPlatform)

  const holderSession = await holderPlatform.login({ bid: holderSigner.address, signer: holderSigner })
  const applyNo = await holder.applyCredential(holderSession, { templateId: "template-identity", subject: { name: "Alice" } })
  const issuerSession = await issuerPlatform.login({ bid: issuerSigner.address, signer: issuerSigner })
  const issued = await issuer.issue(issuerSession, { issuer: { bid: issuerSigner.address, signer: issuerSigner }, applyNo, status: 2 })
  const downloaded = await holder.downloadCredential(holderSession, { credentialId: parseCredentialId("credential-1") })

  const parsed = parseJws(downloaded.jws)
  assert.equal(readJwsAlgorithm(parsed), "ED25519")
  assert.equal(issued.payloadId, "payload-1")
  assert.equal(issued.credentialId, "credential-1")
  const localResult = await vc.verifier.verifyCredential({
    jws: downloaded.jws,
    issuerPublicKeys: [issuerSigner.publicKey],
  })
  assert.equal(localResult.checks.issuerSignature, "passed")
  assert.equal(localResult.checks.disclosure, "skipped")
})

test("Given an ED25519 issuer, when issuing with selective disclosure, then the mock platform produces SHA-256 commitments and the credential verifies locally", async () => {
  const vc = createTrustedVc()
  const mock = createMockPlatform()
  const holderKeys = enc.getBidAndKeyPairBySM2()
  const issuerKeys = enc.generate()
  const holderSigner = vc.signer.fromPrivateKey(holderKeys.encPrivateKey)
  const issuerSigner = vc.signer.fromPrivateKey(issuerKeys.encPrivateKey)
  const holderPlatform = vc.platform.create({ fetcher: mock.fetcher })
  const issuerPlatform = vc.platform.create({ fetcher: mock.fetcher })
  const holder = vc.holder.create(holderPlatform)
  const issuer = vc.issuer.create(issuerPlatform)

  const holderSession = await holderPlatform.login({ bid: holderSigner.address, signer: holderSigner })
  const applyNo = await holder.applyCredential(holderSession, { templateId: "template-identity", subject: { name: "Alice" } })
  const issuerSession = await issuerPlatform.login({ bid: issuerSigner.address, signer: issuerSigner })
  await issuer.issue(issuerSession, { issuer: { bid: issuerSigner.address, signer: issuerSigner }, applyNo, status: 2, isSel: 1 })
  const downloaded = await holder.downloadCredential(holderSession, { credentialId: parseCredentialId("credential-1") })

  const parsed = parseJws(downloaded.jws)
  const payload = parsed.payload as { readonly parseType: string; readonly credentialSubject: { readonly name: { readonly value: string; readonly salt: string; readonly hash: string } } }
  assert.equal(readJwsAlgorithm(parsed), "ED25519")
  assert.equal(payload.parseType, "sel-disclose-ED25519")
  assert.equal(payload.credentialSubject.name.value, "Alice")
  assert.equal(payload.credentialSubject.name.hash, createHash("sha256").update("Alicesample-salt-001", "utf8").digest("hex"))
  const localResult = await vc.verifier.verifyCredential({
    jws: downloaded.jws,
    issuerPublicKeys: [issuerSigner.publicKey],
  })
  assert.equal(localResult.checks.issuerSignature, "passed")
  assert.equal(localResult.checks.disclosure, "passed")
})

test("Given a download response with an outer JWS, when the vc field contains the credential, then the holder parses vc and preserves the JWS", () => {
  const vc = createTrustedVc()
  const mock = createMockPlatform()
  const platform = vc.platform.create({ fetcher: mock.fetcher })
  const holder = vc.holder.create(platform)
  const credential = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "credential-1",
    type: ["VerifiableCredential"],
    issuer: "did:bid:issuer",
    issuanceDate: "2026-01-01T00:00:00Z",
    credentialSubject: { id: "did:bid:holder", name: "Alice" },
  }
  const outerJws = `${encodeJsonPart({ alg: "ED25519" })}.${encodeJsonPart({ result: "wrapped" })}.signature`
  const parsed = holder.parseDownloadedCredential({ jws: outerJws, vc: JSON.stringify(credential), issueBid: credential.issuer, issueName: "Issuer" })
  assert.deepEqual(parsed.credential, credential)
  assert.deepEqual(parsed.jws.payload, { result: "wrapped" })

  const standardJws = `${encodeJsonPart({ alg: "ED25519" })}.${encodeJsonPart(credential)}.signature`
  const fallback = holder.parseDownloadedCredential({ jws: standardJws, vc: null, issueBid: credential.issuer, issueName: "Issuer" })
  assert.deepEqual(fallback.credential, credential)
})
