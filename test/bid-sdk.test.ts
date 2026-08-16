import assert from "node:assert/strict"
import test from "node:test"

import { BidConfigurationError, createBidSdk, parseBidId } from "../src/index.js"

const id = parseBidId("did:bid:efnVUgqQFfYeu97ABf6sGm3WFtVXHZB2")

test("Given no network configuration, when generating an identity and document, then offline APIs work", () => {
  const sdk = createBidSdk()
  const identity = sdk.keypair.generate()
  const document = sdk.document.create(identity.address).build()

  assert.equal(document.id, identity.address)
})

test("Given no network configuration, when submitting a document, then it explains network configuration is required", async () => {
  const sdk = createBidSdk()
  const identity = sdk.keypair.generate()
  const document = sdk.document.create(identity.address).build()

  await assert.rejects(sdk.bid.create(document, { privateKey: identity.privateKey }), BidConfigurationError)
  await assert.rejects(sdk.bid.resolve(id), BidConfigurationError)
})

test("Given direct connection config, when connect runs, then the same SDK gains write and resolve ability", () => {
  const sdk = createBidSdk()

  const result = sdk.connect({
    mode: "direct",
    contractAddress: "did:bid:efTEST0000000000000000000",
    parser: { baseUrl: "http://localhost:8088" },
    direct: { nodeUrl: "https://test-node.example.com" },
  })

  assert.equal(result, sdk)
})

test("Given bop connection config, when connect runs, then the same SDK uses the open platform", () => {
  const sdk = createBidSdk()

  const result = sdk.connect({
    mode: "bop",
    contractAddress: "did:bid:efTEST0000000000000000000",
    parser: { baseUrl: "http://localhost:8088" },
    bop: {
      baseUrl: "https://bop.example.com",
      apiKey: "api-key",
      apiSecret: "api-secret",
    },
  })

  assert.equal(result, sdk)
})

test("Given a BID id, when a document is created, then SDK defaults apply without any extra input", () => {
  const sdk = createBidSdk()

  const document = sdk.document.create(id).build()

  assert.deepEqual(document["@context"], ["https://www.w3.org/ns/did/v1"])
  assert.equal(document.version, "1.0.0")
})