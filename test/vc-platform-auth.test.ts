import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import { configureBidSdk } from "../src/config.js"
import { createEncSigner } from "../src/vc/vc-crypto.js"
import { parseApplyNo } from "../src/vc/vc-domain.js"
import { VcHolder } from "../src/vc/vc-holder.js"
import { VcIssuer } from "../src/vc/vc-issuer.js"
import { encodeJsonPart } from "../src/vc/vc-jws.js"
import { VcPlatformClient } from "../src/vc/vc-platform.js"

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
  await issuer.issue({ issuer: { bid: signer.address, signer }, applyNo: parseApplyNo("apply-1"), status: 1 })
  return requestedUrls
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}
