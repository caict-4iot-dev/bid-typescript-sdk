import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import { assembleJws, encodeJsonPart } from "../src/vc/vc-jws.js"
import { createDirectVcVerifier } from "../src/vc/mobile.js"

const ISSUER = "did:bid:efIssuerMobile1234567890"
const CREDENTIAL_ID = "did:bid:efCredentialMobile123456789"

test("Given a direct node with trust, DDO document and no revocation, when verifying through the mobile entry, then the credential is verified with the same checks", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const jws = credentialJws(keypair.encPrivateKey, ISSUER, CREDENTIAL_ID)

  const requests: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (url.includes("/getAccountMetaData")) {
      const search = new URL(url).searchParams
      const key = search.get("key") ?? ""
      if (key === "admins") {
        return json({ error_code: 0, result: { admins: { key: "admins", value: JSON.stringify([ISSUER]) } } })
      }
      if (key.startsWith("issuer_")) {
        return json({ error_code: 0, result: { [key]: { key, value: JSON.stringify({ publicKey: keypair.encPublicKey }) } } })
      }
      return json({ error_code: 0, result: null })
    }
    if (url.includes("/callContract")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (String(body["input"]).includes("queryBid")) {
        return json({
          error_code: 0,
          result: {
            query_rets: [{
              result: { type: "string", value: JSON.stringify({
                id: ISSUER,
                publicKey: [{ id: `${ISSUER}#key-1`, type: "SM2", controller: ISSUER, publicKeyHex: rawPublicKey }],
              }) },
            }],
          },
        })
      }
      return json({ error_code: 0, result: { query_rets: [] } })
    }
    if (url.includes("/api/cred/vc/revoked/")) {
      return json({ errorCode: 0, message: "ok", data: { revoked: false, id: CREDENTIAL_ID, issuerBid: ISSUER } })
    }
    throw new Error(`unexpected url ${url}`)
  }

  const verifier = createDirectVcVerifier({
    directNodeUrl: "https://node.example.com",
    vcRevocationUrl: "https://issuer.example.com",
    fetcher,
  })

  const result = await verifier.verifyCredential({ jws })

  assert.equal(result.verified, true)
  assert.equal(result.checks.format, "passed")
  assert.equal(result.checks.issuerTrust, "passed")
  assert.equal(result.checks.issuerSignature, "passed")
  assert.equal(result.checks.validity, "passed")
  assert.equal(result.checks.disclosure, "skipped")
  assert.equal(result.checks.revocation, "passed")
  // 非选择性披露凭证会带 disclosure-not-present 提示，不构成失败。
  assert.equal(result.errors.filter((error) => error.code !== "disclosure-not-present").length, 0)
  // 直连节点接口确实被调用。
  assert.equal(requests.some((url) => url.includes("/getAccountMetaData")), true)
  assert.equal(requests.some((url) => url.includes("/callContract")), true)
  assert.equal(requests.some((url) => url.includes("/api/cred/vc/revoked/")), true)
})

test("Given a direct node reporting the credential revoked, when verifying through the mobile entry, then revocation fails and verified is false", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const rawPublicKey = enc.encToRawPublicKey(keypair.encPublicKey).rawPublicKey
  const jws = credentialJws(keypair.encPrivateKey, ISSUER, CREDENTIAL_ID)
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes("/getAccountMetaData")) {
      const key = new URL(url).searchParams.get("key") ?? ""
      if (key === "admins") return json({ error_code: 0, result: { admins: { key: "admins", value: JSON.stringify([ISSUER]) } } })
      return json({ error_code: 0, result: null })
    }
    if (url.includes("/callContract")) {
      return json({
        error_code: 0,
        result: { query_rets: [{ result: { type: "string", value: JSON.stringify({ id: ISSUER, publicKey: [{ id: `${ISSUER}#key-1`, type: "SM2", controller: ISSUER, publicKeyHex: rawPublicKey }] }) } }] },
      })
    }
    if (url.includes("/api/cred/vc/revoked/")) {
      return json({ errorCode: 0, message: "ok", data: { revoked: true, id: CREDENTIAL_ID, issuerBid: ISSUER } })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const verifier = createDirectVcVerifier({
    directNodeUrl: "https://node.example.com",
    vcRevocationUrl: "https://issuer.example.com",
    fetcher,
  })

  const result = await verifier.verifyCredential({ jws })

  assert.equal(result.verified, false)
  assert.equal(result.checks.revocation, "failed")
})

function credentialJws(privateKey: string, issuer: string, id: string): string {
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