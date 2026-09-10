import assert from "node:assert/strict"
import test from "node:test"

import {
  BopIssuerTrustReader,
  DirectIssuerTrustReader,
  IssuerTrustLookupError,
} from "../src/vc/vc-trust.js"

const issuer = "did:bid:efIssuer123"
test("Given an exact IAM admin entry, when checking trust through direct metadata, then the issuer is trusted without querying TDS", async () => {
  const calls: string[] = []
  // 直连节点真实返回：result 是 key -> {key,value} 映射。
  const reader = new DirectIssuerTrustReader({
    async get(address, key) {
      calls.push(`${address}:${key}`)
      return { admins: { key: "admins", value: JSON.stringify([issuer, `${issuer}Suffix`]), version: 1 } }
    },
  })

  assert.equal(await reader.isTrusted(issuer), true)
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? "", /:admins$/)
})

test("Given only a BID prefix collision in IAM, when TDS contains the exact issuer key, then trust comes from TDS", async () => {
  const reader = new DirectIssuerTrustReader({
    async get(_address, key) {
      if (key === "admins") return { admins: { key, value: JSON.stringify([`${issuer}Suffix`]) } }
      return { [`issuer_${issuer}`]: { key, value: "{}" } }
    },
  })

  assert.equal(await reader.isTrusted(issuer), true)
})

test("Given no IAM admin entry and TDS misses the issuer key, when checking trust through direct metadata, then the issuer is untrusted", async () => {
  const reader = new DirectIssuerTrustReader({
    async get(address, key) {
      if (key === "admins") return { admins: { key, value: JSON.stringify([`${issuer}Suffix`]) } }
      // 未命中时直连节点返回 result: null。
      if (address === "did:bid:ef3bXwGBcqmJyw314ZWh5jadKq7X48nf") return null
      return { [`issuer_${issuer}`]: { key, value: "{}" } }
    },
  })

  assert.equal(await reader.isTrusted(issuer), false)
})

test("Given no exact IAM or TDS key, when checking trust through BOP metadata, then the issuer is untrusted", async () => {
  const reader = new BopIssuerTrustReader({
    async get(_address, key) {
      return key === "admins"
        ? { errorCode: 0, errorDesc: "ok", result: [{ key, value: "[]" }] }
        : { errorCode: 0, errorDesc: "ok", result: [{ key: "issuer_someone-else", value: "{}" }] }
    },
  })

  assert.equal(await reader.isTrusted(issuer), false)
})

test("Given malformed IAM metadata, when checking trust, then it reports a protocol lookup error", async () => {
  const reader = new DirectIssuerTrustReader({ get: async () => ({ admins: { key: "admins", value: "not-json" } }) })

  await assert.rejects(() => reader.isTrusted(issuer), IssuerTrustLookupError)
})

test("Given a nonzero BOP response, when checking trust, then it reports a transport lookup error", async () => {
  const reader = new BopIssuerTrustReader({ get: async () => ({ errorCode: 4, errorDesc: "account not found" }) })

  await assert.rejects(() => reader.isTrusted(issuer), /account not found/)
})