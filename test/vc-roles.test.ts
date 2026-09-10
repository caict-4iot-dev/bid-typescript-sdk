import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import { configureBidSdk } from "../src/config.js"
import { createEncSigner } from "../src/vc/vc-crypto.js"
import { signingMessageHex } from "../src/vc/vc-crypto.js"
import { parseApplyNo } from "../src/vc/vc-domain.js"
import { VcHolder } from "../src/vc/vc-holder.js"
import { VcIssuer } from "../src/vc/vc-issuer.js"
import { encodeJsonPart } from "../src/vc/vc-jws.js"
import { VcPlatformClient } from "../src/vc/vc-platform.js"

configureBidSdk({ directNodeUrl: "https://node.example.com", bopUrl: "https://bop.example.com", parserUrl: "https://parser.example.com/bid/", vcPlatformUrl: "https://wallet.example.com", vcCredentialUrl: "https://credential.example.com", vcVerificationUrl: "https://cross.example.com" })

test("Given a holder session, when applying for a credential, then the platform receives holder identity and JSON content", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  let applyBody: Readonly<Record<string, unknown>> | undefined
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "holder-token" } })
      applyBody = body
      return json({ errorCode: 0, message: "ok", data: { applyNo: "apply-1" } })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const holder = new VcHolder(platform)

  const applyNo = await holder.applyCredential(session, { templateId: "template-1", subject: { name: "Alice" } })

  assert.equal(applyNo, "apply-1")
  assert.equal(applyBody?.["bid"], signer.address)
  assert.equal(applyBody?.["publicKey"], signer.publicKey)
  assert.equal(applyBody?.["content"], JSON.stringify({ name: "Alice" }))
})

test("Given a holder session, when listing recommended credentials, then the platform receives category and paging and the response is parsed", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  let requestBody: Readonly<Record<string, unknown>> | undefined
  let sawAccessToken = false
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "holder-token" } })
      if (url.endsWith("/credential/recommend/list")) {
        requestBody = body
        const headers = new Headers(init?.headers)
        sawAccessToken = headers.get("accessToken") === "holder-token"
        return json({
          errorCode: 0,
          message: "ok",
          data: {
            recommendList: [{ certName: "身份凭证", icon: "https://example.com/icon.png", templateId: "template-identity" }],
            page: { pageStart: 1, pageSize: 10, pageTotal: 1 },
          },
        })
      }
      throw new Error(`unexpected url ${url}`)
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const holder = new VcHolder(platform)

  const result = await holder.listRecommendedCredentials(session, { pageStart: 1, pageSize: 10 })

  assert.equal(sawAccessToken, true)
  assert.equal(requestBody?.["type"], "2")
  assert.equal(requestBody?.["pageStart"], 1)
  assert.equal(requestBody?.["pageSize"], 10)
  assert.deepEqual(result.recommendList, [{ certName: "身份凭证", icon: "https://example.com/icon.png", templateId: "template-identity" }])
  assert.deepEqual(result.page, { pageStart: 1, pageSize: 10, pageTotal: 1 })
})

type OwnerListRecord = {
  readonly applyNo: string
  readonly status: string
  readonly credentialBid?: string | null
}

type OwnerListFixture = {
  readonly pageTotal: number
  readonly dataList: readonly OwnerListRecord[]
}

async function requestApplicationStatus(fixture: OwnerListFixture) {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  let requestBody: string | undefined
  let sawAccessToken = false
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: `token:${signer.address}` } })
      if (url.endsWith("/credential/owner/list")) {
        requestBody = typeof init?.body === "string" ? init.body : undefined
        sawAccessToken = new Headers(init?.headers).get("accessToken") === `token:${signer.address}`
        return json({
          errorCode: 0,
          message: "ok",
          data: {
            page: { pageStart: 1, pageSize: 2, pageTotal: fixture.pageTotal },
            dataList: fixture.dataList,
          },
        })
      }
      throw new Error(`unexpected url ${url}`)
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const holder = new VcHolder(platform)

  const status = await holder.getApplicationStatus(session, parseApplyNo("apply-1"))

  return { status, requestBody, sawAccessToken }
}

for (const scenario of [
  { status: "1", credentialBid: undefined },
  { status: "2", credentialBid: "credential-1" },
  { status: "3", credentialBid: undefined },
] as const) {
  test(`Given an authenticated owner-list application with status ${scenario.status}, when reading its status, then it maps the matching row without userBid`, async () => {
    const result = await requestApplicationStatus({
      pageTotal: 1,
      dataList: [{ applyNo: "apply-1", status: scenario.status, ...(scenario.credentialBid === undefined ? {} : { credentialBid: scenario.credentialBid }) }],
    })

    assert.equal(result.sawAccessToken, true)
    assert.equal(result.requestBody, JSON.stringify({ applyNo: "apply-1", pageStart: 1, pageSize: 2 }))
    assert.equal(result.status.status, scenario.status)
    assert.equal(result.status.credentialId, scenario.credentialBid)
  })
}

test("Given an authenticated owner-list application in pending status with credentialBid null, when reading its status, then it reports pending without a credentialId", async () => {
  const result = await requestApplicationStatus({
    pageTotal: 1,
    dataList: [{ applyNo: "apply-1", status: "1", credentialBid: null }],
  })

  assert.equal(result.sawAccessToken, true)
  assert.equal(result.requestBody, JSON.stringify({ applyNo: "apply-1", pageStart: 1, pageSize: 2 }))
  assert.equal(result.status.status, "1")
  assert.equal(result.status.credentialId, undefined)
})

test("Given an authenticated owner-list response with no matching application, when reading its status, then it rejects instead of mapping another row", async () => {
  await assert.rejects(
    requestApplicationStatus({ pageTotal: 1, dataList: [{ applyNo: "apply-other", status: "2", credentialBid: "credential-other" }] }),
    /application status/i,
  )
})

test("Given an authenticated owner-list response with duplicate application rows and pageTotal two, when reading its status, then it rejects the ambiguous match", async () => {
  await assert.rejects(
    requestApplicationStatus({
      pageTotal: 2,
      dataList: [
        { applyNo: "apply-1", status: "1" },
        { applyNo: "apply-1", status: "2", credentialBid: "credential-1" },
      ],
    }),
    /application status/i,
  )
})

test("Given an issuer, when issuing and revoking, then it signs each platform-provided blob after validating the returned JWS header", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const submitted: Readonly<Record<string, unknown>>[] = []
  const blobBodies: Readonly<Record<string, unknown>>[] = []
  const blobPayload = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({ hello: "world" })}`
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (url.endsWith("/vc/issue/audit/blob")) {
        blobBodies.push(body)
        return json({ errorCode: 0, message: "ok", data: { payload: blobPayload, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      }
      if (url.endsWith("/vc/revocation/blob")) return json({ errorCode: 0, message: "ok", data: { blobId: "revoke-1", blob: "7265766f6b65", txHash: "" } })
      submitted.push(body)
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const issuer = new VcIssuer(platform)

  await issuer.issue({ issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 1 })
  await issuer.revoke({ issuer: { bid: signer.address, signer }, credentialBid: "did:bid:efCredential", txHash: "hash", blob: "request-blob" })

  assert.equal(blobBodies[0]?.["alg"], "SM2")
  assert.equal(submitted.length, 2)
  assert.equal(enc.verify(signingMessageHex(blobPayload), String(submitted[0]?.["signPayload"]), signer.publicKey), true)
  assert.equal(enc.verify("7472616e73616374696f6e", String(submitted[0]?.["signBcTxBlob"]), signer.publicKey), true)
  assert.equal(enc.verify("7265766f6b65", String(submitted[1]?.["signBlob"]), signer.publicKey), true)
})

test("Given an ED25519 issuer, when issuing, then it requests the signer algorithm and submits ED25519-verifiable signatures", async () => {
  const keypair = enc.generate()
  const signer = createEncSigner(keypair.encPrivateKey)
  assert.equal(signer.algorithm, "ED25519")
  const submitted: Readonly<Record<string, unknown>>[] = []
  const blobBodies: Readonly<Record<string, unknown>>[] = []
  const blobPayload = `${encodeJsonPart({ alg: "ED25519" })}.${encodeJsonPart({ hello: "world" })}`
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (url.endsWith("/vc/issue/audit/blob")) {
        blobBodies.push(body)
        return json({ errorCode: 0, message: "ok", data: { payload: blobPayload, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      }
      submitted.push(body)
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const issuer = new VcIssuer(platform)

  await issuer.issue({ issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 1 })

  assert.equal(blobBodies[0]?.["alg"], "ED25519")
  assert.equal(submitted.length, 1)
  assert.equal(enc.verify(signingMessageHex(blobPayload), String(submitted[0]?.["signPayload"]), signer.publicKey), true)
  assert.equal(enc.verify("7472616e73616374696f6e", String(submitted[0]?.["signBcTxBlob"]), signer.publicKey), true)
})

test("Given an ED25519 issuer, when the platform returns a blob whose JWS header alg does not match, then it rejects before signing or submitting", async () => {
  const keypair = enc.generate()
  const signer = createEncSigner(keypair.encPrivateKey)
  const suppliedBodies: Readonly<Record<string, unknown>>[] = []
  const submitCalls: Readonly<Record<string, unknown>>[] = []
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/vc/issue/audit/blob")) {
        suppliedBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>)
        return json({ errorCode: 0, message: "ok", data: { payload: `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({ hello: "world" })}`, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      }
      submitCalls.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>)
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const issuer = new VcIssuer(platform)

  await assert.rejects(
    issuer.issue({ issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 1 }),
    /does not match/,
  )

  assert.equal(suppliedBodies[0]?.["alg"], "ED25519")
  assert.equal(submitCalls.length, 0)
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}
