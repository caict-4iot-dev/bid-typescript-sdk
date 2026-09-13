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

test("Given a logged-in issuer, when issuing and revoking, then it signs each platform-provided blob after validating the returned JWS header and carries the access token", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const submitted: Readonly<Record<string, unknown>>[] = []
  const blobBodies: Readonly<Record<string, unknown>>[] = []
  const sawTokenOn: string[] = []
  const blobPayload = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({ hello: "world" })}`
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      if (new Headers(init?.headers).get("accessToken") === "issuer-token") sawTokenOn.push(url)
      if (url.endsWith("/vc/issue/audit/blob")) {
        blobBodies.push(body)
        return json({ errorCode: 0, message: "ok", data: { payload: blobPayload, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      }
      if (url.endsWith("/vc/issue/audit/submit")) {
        submitted.push(body)
        return json({ errorCode: 0, message: "ok", data: { certBid: "did:bid:efCredentialIssued", bid: "did:bid:efHolder", trustedFlag: false } })
      }
      if (url.endsWith("/vc/revocation/blob")) return json({ errorCode: 0, message: "ok", data: { blobId: "revoke-1", blob: "7265766f6b65", txHash: "" } })
      submitted.push(body)
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const issuer = new VcIssuer(platform)

  const issued = await issuer.issue(session, { issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 2 })
  await issuer.revoke(session, { issuer: { bid: signer.address, signer }, credentialBid: "did:bid:efCredentialIssued" })

  assert.equal(issued.credentialId, "did:bid:efCredentialIssued")
  assert.equal(blobBodies[0]?.["alg"], "SM2")
  assert.equal(submitted.length, 2)
  assert.equal(enc.verify(signingMessageHex(blobPayload), String(submitted[0]?.["signPayload"]), signer.publicKey), true)
  assert.equal(enc.verify("7472616e73616374696f6e", String(submitted[0]?.["signBcTxBlob"]), signer.publicKey), true)
  assert.equal(enc.verify("7265766f6b65", String(submitted[1]?.["signBlob"]), signer.publicKey), true)
  // 所有 issuer 业务请求都必须带 accessToken（服务端校验登录态）。
  for (const route of ["/vc/issue/audit/blob", "/vc/issue/audit/submit", "/vc/revocation/blob"]) {
    assert.equal(sawTokenOn.some((url) => url.endsWith(route)), true, `missing accessToken on ${route}`)
  }
})

test("Given a logged-in ED25519 issuer, when issuing, then it requests the signer algorithm and submits ED25519-verifiable signatures", async () => {
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
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      if (url.endsWith("/vc/issue/audit/blob")) {
        blobBodies.push(body)
        return json({ errorCode: 0, message: "ok", data: { payload: blobPayload, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      }
      submitted.push(body)
      return json({ errorCode: 0, message: "ok", data: { certBid: "did:bid:efCredentialIssued" } })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const issuer = new VcIssuer(platform)

  await issuer.issue(session, { issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 2 })

  assert.equal(blobBodies[0]?.["alg"], "ED25519")
  assert.equal(submitted.length, 1)
  assert.equal(enc.verify(signingMessageHex(blobPayload), String(submitted[0]?.["signPayload"]), signer.publicKey), true)
  assert.equal(enc.verify("7472616e73616374696f6e", String(submitted[0]?.["signBcTxBlob"]), signer.publicKey), true)
})

test("Given a logged-in ED25519 issuer, when the portal blob hex-encodes the payload and the JWS header alg is hardcoded SM2, then it still signs and submits after decoding", async () => {
  const keypair = enc.generate()
  const signer = createEncSigner(keypair.encPrivateKey)
  assert.equal(signer.algorithm, "ED25519")
  const blobPayload = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({ hello: "world" })}`
  const hexPayload = Buffer.from(blobPayload, "utf8").toString("hex")
  const suppliedBodies: Readonly<Record<string, unknown>>[] = []
  const submitCalls: Readonly<Record<string, unknown>>[] = []
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      if (url.endsWith("/vc/issue/audit/blob")) {
        suppliedBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>)
        return json({ errorCode: 0, message: "ok", data: { payload: hexPayload, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      }
      submitCalls.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>)
      return json({ errorCode: 0, message: "ok", data: { certBid: "did:bid:efHexCredential" } })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const issuer = new VcIssuer(platform)

  // 服务端把 header alg 写死 SM2（历史缺陷，与实际签名算法无关），SDK 不做等值拦截。
  const issued = await issuer.issue(session, { issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 2 })

  assert.equal(suppliedBodies[0]?.["alg"], "ED25519")
  assert.equal(issued.credentialId, "did:bid:efHexCredential")
  // 签名的是 hex 解码后的原始 JWS 文本。
  assert.equal(enc.verify(signingMessageHex(blobPayload), String(submitCalls[0]?.["signPayload"]), signer.publicKey), true)
})

test("Given a logged-in issuer, when rejecting, listing and creating templates, then each platform request carries the session and issuer identity", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const requests: { readonly url: string; readonly body: Readonly<Record<string, unknown>>; readonly token: string | null }[] = []
  const platform = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      requests.push({ url, body, token: new Headers(init?.headers).get("accessToken") })
      if (url.endsWith("/vc/audit/disApprove")) return json({ errorCode: 0, message: "ok", data: {} })
      if (url.endsWith("/vc/list")) return json({ errorCode: 0, message: "ok", data: { dataList: [], page: { pageStart: 1, pageSize: 10, pageTotal: 0 } } })
      if (url.endsWith("/vc/detail")) return json({ errorCode: 0, message: "ok", data: { applyNo: "apply-1", content: "{\"name\":\"Alice\"}", status: "1" } })
      if (url.endsWith("/vc/create/template/blob")) return json({ errorCode: 0, message: "ok", data: { blobId: "tpl-1", blob: "74656d706c6174652d626c6f62" } })
      if (url.endsWith("/vc/create/template/submit")) return json({ errorCode: 0, message: "ok", data: { templateBid: "did:bid:efTemplate0000000000000001" } })
      if (url.endsWith("/vc/manage/template/list")) return json({ errorCode: 0, message: "ok", data: { list: [], page: { pageStart: 1, pageSize: 10, pageTotal: 0 } } })
      if (url.endsWith("/vc/industry/list")) return json({ errorCode: 0, message: "ok", data: { list: [{ code: "A", name: "政务" }] } })
      if (url.endsWith("/vc/category/list")) return json({ errorCode: 0, message: "ok", data: { list: [{ issuCategoId: "1", issuCategoName: "身份" }] } })
      throw new Error(`unexpected url ${url}`)
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const issuer = new VcIssuer(platform)
  const issuerId = { bid: signer.address, signer }

  await issuer.reject(session, { issuer: issuerId, applyNo: parseApplyNo("apply-1"), reason: "材料不全" })
  await issuer.listApplications(session, { status: [1], pageStart: 1, pageSize: 10 })
  const detail = await issuer.getApplicationDetail(session, { applyNo: "apply-1" }) as Readonly<Record<string, unknown>>
  const template = await issuer.createTemplate(session, {
    issuer: issuerId,
    name: "身份凭证",
    industryId: "A",
    categoryId: "1",
    version: "1.0.0",
    data: JSON.stringify([{ key: "name", label: "姓名", format: "String", type: "3" }]),
    userType: "0",
  })
  await issuer.listTemplates(session, { pageStart: 1, pageSize: 10 })
  await issuer.listIndustries(session)
  await issuer.listCategories(session)

  const byRoute = (suffix: string) => requests.filter((request) => request.url.endsWith(suffix))
  // 拒绝：disApprove 带 applyNo/status=3/auditBid 与 alg。
  const rejectBody = byRoute("/vc/audit/disApprove")[0]?.body
  assert.equal(rejectBody?.["applyNo"], "apply-1")
  assert.equal(rejectBody?.["status"], 3)
  assert.equal(rejectBody?.["auditBid"], signer.address)
  assert.equal(rejectBody?.["alg"], "SM2")
  // 申请列表：issuerBid 来自登录会话。
  assert.equal(byRoute("/vc/list")[0]?.body["issuerBid"], signer.address)
  assert.deepEqual(byRoute("/vc/list")[0]?.body["status"], [1])
  // 申请详情返回原始 content，供 approve 透传。
  assert.equal(detail["content"], JSON.stringify({ name: "Alice" }))
  // 创建模板两步都带 issuerBid / 签名 publicKey；submit 返回 templateBid。
  assert.equal(byRoute("/vc/create/template/blob")[0]?.body["issuerBid"], signer.address)
  assert.equal(template.templateBid, "did:bid:efTemplate0000000000000001")
  const submitBody = byRoute("/vc/create/template/submit")[0]?.body
  assert.equal(submitBody?.["blobId"], "tpl-1")
  assert.equal(enc.verify(signingMessageHex("74656d706c6174652d626c6f62"), String(submitBody?.["signBlob"]), signer.publicKey), true)
  // 模板列表带 issuerBid；字典查询不带业务参数。
  assert.equal(byRoute("/vc/manage/template/list")[0]?.body["issuerBid"], signer.address)
  assert.equal(byRoute("/vc/industry/list").length, 1)
  // 全部 issuer 业务请求带 accessToken。
  assert.equal(requests.every((request) => request.token === "issuer-token"), true)
})

test("Given an issuer whose signer does not match the login session, when issuing, then it rejects before calling the platform", async () => {
  const loginKeypair = enc.getBidAndKeyPairBySM2()
  const otherKeypair = enc.getBidAndKeyPairBySM2()
  const loginSigner = createEncSigner(loginKeypair.encPrivateKey)
  const otherSigner = createEncSigner(otherKeypair.encPrivateKey)
  let businessCalls = 0
  const platform = new VcPlatformClient({
    fetcher: async (input) => {
      const url = String(input)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      businessCalls += 1
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const session = await platform.login({ bid: loginSigner.address, signer: loginSigner })
  const issuer = new VcIssuer(platform)

  await assert.rejects(
    issuer.issue(session, { issuer: { bid: otherSigner.address, signer: otherSigner }, applyNo: parseApplyNo("apply-1"), status: 2 }),
    /session bid/,
  )
  assert.equal(businessCalls, 0)
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}
