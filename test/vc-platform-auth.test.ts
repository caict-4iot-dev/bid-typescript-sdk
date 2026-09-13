import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import { configureBidSdk } from "../src/config.js"
import { createEncSigner } from "../src/vc/vc-crypto.js"
import { parseApplyNo } from "../src/vc/vc-domain.js"
import { VcHolder } from "../src/vc/vc-holder.js"
import { VcIssuer } from "../src/vc/vc-issuer.js"
import { encodeJsonPart } from "../src/vc/vc-jws.js"
import { ISSUER_PORTAL_ROUTES, VcPlatformClient } from "../src/vc/vc-platform.js"

configureBidSdk({ directNodeUrl: "https://node.example.com", bopUrl: "https://bop.example.com", parserUrl: "https://parser.example.com/bid/", vcPlatformUrl: "https://wallet.example.com", vcCredentialUrl: "https://credential.example.com", vcVerificationUrl: "https://cross.example.com" })

test("Given a BID signer, when logging into the platform, then it signs the random challenge and stores the session", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const requests: Array<{ readonly url: string; readonly body: Readonly<Record<string, unknown>> }> = []
  const client = new VcPlatformClient({
    fetcher: async (input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Readonly<Record<string, unknown>>
      requests.push({ url: String(input), body })
      if (String(input).endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "SUCCESS", data: { randomStr: "deadbeef" } })
      assert.equal(body["publicKey"], keypair.encPublicKey)
      assert.equal(enc.verify("deadbeef", String(body["signBlob"]), keypair.encPublicKey), true)
      return json({ errorCode: 0, message: "SUCCESS", data: { accessToken: "token", expiresIn: 3600 } })
    },
  })

  const session = await client.login({ bid: signer.address, signer })

  assert.equal(session.accessToken, "token")
  assert.equal(requests.length, 2)
})

test("Given a platform session, when an authed request first fails, then it reauthenticates and replays once", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  let protectedCalls = 0
  const client = new VcPlatformClient({
    fetcher: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "SUCCESS", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "SUCCESS", data: { accessToken: `token-${protectedCalls}` } })
      protectedCalls += 1
      if (protectedCalls === 1) return json({ errorCode: 401, message: "expired" })
      assert.equal(new Headers(init?.headers).get("accessToken"), "token-1")
      return json({ errorCode: 0, message: "SUCCESS", data: { applyNo: "apply-1" } })
    },
  })
  await client.login({ bid: signer.address, signer })

  const result = await client.post("apply", { hello: "world" }, true)

  assert.deepEqual(result, { applyNo: "apply-1" })
  assert.equal(protectedCalls, 2)
})

test("Given a platform business failure, when posting an authed request, then it does not replay the request", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  let loginCalls = 0
  let protectedCalls = 0
  const client = new VcPlatformClient({
    fetcher: async (input) => {
      const url = String(input)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "SUCCESS", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) {
        loginCalls += 1
        return json({ errorCode: 0, message: "SUCCESS", data: { accessToken: "token" } })
      }
      protectedCalls += 1
      return json({ errorCode: 500, message: "business rejected" })
    },
  })
  await client.login({ bid: signer.address, signer })

  await assert.rejects(client.post("apply", { hello: "world" }, true), /business rejected/)

  assert.equal(loginCalls, 1)
  assert.equal(protectedCalls, 1)
})

test("Given path-based base URLs, when logging in, listing recommendations and issuing, then every request stays beneath its base path with the SDK-owned /server prefix", async () => {
  const requestedUrls = await runPlatformFlow({
    directNodeUrl: "https://node.example.com",
    bopUrl: "https://bop.example.com",
    parserUrl: "https://parser.example.com/bid/",
    vcPlatformUrl: "https://gateway.example.com/gateway",
    vcCredentialUrl: "https://credential.example.com/credential-server",
    vcVerificationUrl: "https://cross.example.com",
  })

  assert.deepEqual(requestedUrls, [
    "https://gateway.example.com/gateway/server/bid/auth/random",
    "https://gateway.example.com/gateway/server/bid/auth",
    "https://gateway.example.com/gateway/server/credential/recommend/list",
    "https://credential.example.com/credential-server/server/vc/issue/audit/blob",
    "https://credential.example.com/credential-server/server/vc/issue/audit/submit",
  ])
})

test("Given root base URLs without a path, then routes resolve under the SDK-owned /server prefix", async () => {
  const requestedUrls = await runPlatformFlow({
    directNodeUrl: "https://node.example.com",
    bopUrl: "https://bop.example.com",
    parserUrl: "https://parser.example.com/bid/",
    vcPlatformUrl: "https://wallet.example.com",
    vcCredentialUrl: "https://credential.example.com",
    vcVerificationUrl: "https://cross.example.com",
  })

  assert.deepEqual(requestedUrls, [
    "https://wallet.example.com/server/bid/auth/random",
    "https://wallet.example.com/server/bid/auth",
    "https://wallet.example.com/server/credential/recommend/list",
    "https://credential.example.com/server/vc/issue/audit/blob",
    "https://credential.example.com/server/vc/issue/audit/submit",
  ])
})

async function runPlatformFlow(urls: Parameters<typeof configureBidSdk>[0]): Promise<string[]> {
  configureBidSdk(urls)
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const requestedUrls: string[] = []
  const blobPayload = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({ hello: "world" })}`
  const platform = new VcPlatformClient({
    fetcher: async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "token" } })
      if (url.endsWith("/credential/recommend/list")) return json({ errorCode: 0, message: "ok", data: { recommendList: [], page: { pageStart: 1, pageSize: 10, pageTotal: 0 } } })
      if (url.endsWith("/vc/issue/audit/blob")) return json({ errorCode: 0, message: "ok", data: { payload: blobPayload, payloadId: "payload-1", bcTxBlob: "7472616e73616374696f6e" } })
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const holder = new VcHolder(platform)
  await holder.listRecommendedCredentials(session, { pageStart: 1, pageSize: 10 })
  const issuer = new VcIssuer(platform)
  await issuer.issue(session, { issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 2 })
  return requestedUrls
}

test("Given issuer business routes, when the issuer client calls them, then every business request goes to the credential host while login stays on the platform host", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const requestedUrls: string[] = []
  const platform = new VcPlatformClient({
    fetcher: async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      if (url.endsWith("/vc/create/template/blob")) return json({ errorCode: 0, message: "ok", data: { blobId: "tpl-1", blob: "626c6f62" } })
      if (url.endsWith("/vc/create/template/submit")) return json({ errorCode: 0, message: "ok", data: { templateBid: "did:bid:efTemplate" } })
      return json({ errorCode: 0, message: "ok", data: {} })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const issuer = new VcIssuer(platform)
  const issuerId = { bid: signer.address, signer }

  await issuer.reject(session, { issuer: issuerId, applyNo: parseApplyNo("apply-1") })
  await issuer.listApplications(session, { pageStart: 1, pageSize: 10 })
  await issuer.getApplicationDetail(session, { applyNo: "apply-1" })
  await issuer.listTemplates(session, { pageStart: 1, pageSize: 10 })
  await issuer.listIndustries(session)
  await issuer.listCategories(session)
  await issuer.createTemplate(session, { issuer: issuerId, name: "身份凭证", industryId: "A", categoryId: "1", version: "1.0.0", data: "[]", userType: "0" })

  // 登录链路只打到平台主机（vcPlatformUrl）。
  assert.deepEqual(requestedUrls.filter((url) => url.startsWith("https://wallet.example.com/")), [
    "https://wallet.example.com/server/bid/auth/random",
    "https://wallet.example.com/server/bid/auth",
  ])
  // 全部 issuer 业务路由（含新增 8 条）都打到凭证主机（vcCredentialUrl）。
  assert.deepEqual(
    requestedUrls.filter((url) => url.startsWith("https://credential.example.com/")).sort(),
    [
      "https://credential.example.com/server/vc/audit/disApprove",
      "https://credential.example.com/server/vc/category/list",
      "https://credential.example.com/server/vc/create/template/blob",
      "https://credential.example.com/server/vc/create/template/submit",
      "https://credential.example.com/server/vc/detail",
      "https://credential.example.com/server/vc/industry/list",
      "https://credential.example.com/server/vc/list",
      "https://credential.example.com/server/vc/manage/template/list",
    ],
  )
})

test("Given a route override for a gateway deployment, when listing applications, then the request goes to the overridden path on the credential host", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  let listUrl = ""
  const platform = new VcPlatformClient({
    routes: { applyList: "api/omp/credential/list" },
    fetcher: async (input) => {
      const url = String(input)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "issuer-token" } })
      listUrl = url
      return json({ errorCode: 0, message: "ok", data: { dataList: [], page: { pageStart: 1, pageSize: 10, pageTotal: 0 } } })
    },
  })
  const session = await platform.login({ bid: signer.address, signer })
  const issuer = new VcIssuer(platform)

  await issuer.listApplications(session, { pageStart: 1, pageSize: 10 })

  assert.equal(listUrl, "https://credential.example.com/api/omp/credential/list")
})

test("Given the issuer portal routes, when logging in as the issuer portal, then it exchanges the wallet token for a gateway token on the credential host and retries failed sessions through both steps", async () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const signer = createEncSigner(keypair.encPrivateKey)
  const requestedUrls: string[] = []
  let gatewayToken = "gateway-token-1"
  let firstListAttempt = true
  const platform = new VcPlatformClient({
    routes: ISSUER_PORTAL_ROUTES,
    fetcher: async (input, init) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.endsWith("/bid/auth/random")) return json({ errorCode: 0, message: "ok", data: { randomStr: "deadbeef" } })
      if (url.endsWith("/bid/auth")) return json({ errorCode: 0, message: "ok", data: { accessToken: "wallet-jwt" } })
      if (url.endsWith("/sp/user/login")) return json({ errorCode: 0, message: "ok", data: { accessToken: gatewayToken, expiresIn: 7200 } })
      if (url.endsWith("/api/omp/credential/list")) {
        // 第一次用旧网关令牌被网关拒（100003），重登（两步）换新令牌后成功。
        if (firstListAttempt) {
          firstListAttempt = false
          gatewayToken = "gateway-token-2"
          return json({ errorCode: 100003, message: "无效令牌", data: {} })
        }
        assert.equal(new Headers(init?.headers).get("accessToken"), "gateway-token-2")
        return json({ errorCode: 0, message: "ok", data: { dataList: [], page: { pageStart: 1, pageSize: 10, pageTotal: 0 } } })
      }
      throw new Error(`unexpected url ${url}`)
    },
    shouldRetryOn: (errorCode) => errorCode === 100003 || errorCode === 401,
  })
  const issuer = new VcIssuer(platform)

  const session = await platform.loginAsIssuerPortal({ bid: signer.address, signer })
  assert.equal(session.accessToken, "gateway-token-1")

  await issuer.listApplications(session, { pageStart: 1, pageSize: 10 })

  // 登录两步在平台主机，令牌交换与业务在凭证主机。
  assert.deepEqual(requestedUrls.filter((url) => url.startsWith("https://wallet.example.com/")), [
    "https://wallet.example.com/server/bid/auth/random",
    "https://wallet.example.com/server/bid/auth",
    "https://wallet.example.com/server/bid/auth/random",
    "https://wallet.example.com/server/bid/auth",
  ])
  assert.deepEqual(requestedUrls.filter((url) => url.startsWith("https://credential.example.com/")), [
    "https://credential.example.com/api/omp/sp/user/login",
    "https://credential.example.com/api/omp/credential/list",
    "https://credential.example.com/api/omp/sp/user/login",
    "https://credential.example.com/api/omp/credential/list",
  ])
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}
