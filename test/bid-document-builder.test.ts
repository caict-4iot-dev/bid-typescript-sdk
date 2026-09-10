import assert from "node:assert/strict"
import test from "node:test"

import {
  createBidDocument,
  DEFAULT_DOCUMENT_CONTEXTS,
  DEFAULT_DOCUMENT_VERSION,
  DEFAULT_EXTENSION_TTL,
  DEFAULT_EXTENSION_TYPE,
} from "../src/bid-document.js"
import { parseBidId } from "../src/domain.js"

const bidId = parseBidId("did:bid:efnVUgqQFfYeu97ABf6sGm3WFtVXHZB2")

test("Given only an id, when build runs, then SDK defaults apply", () => {
  const document = createBidDocument().setId(bidId).build()

  assert.deepEqual(document["@context"], [...DEFAULT_DOCUMENT_CONTEXTS])
  assert.equal(document.version, DEFAULT_DOCUMENT_VERSION)
  assert.equal(document.extension?.ttl, DEFAULT_EXTENSION_TTL)
  assert.equal(document.extension?.type, DEFAULT_EXTENSION_TYPE)
  assert.match(document.created ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(document.updated ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test("Given delegate signing data, when build runs, then it emits delegateSign without a trailing space", () => {
  const document = createBidDocument()
    .setId(bidId)
    .setContext(["https://w3.org/ns/did/v1"])
    .addContext("https://example.com/extra")
    .addAuthentication(`${bidId}#key-1`)
    .addAuthentication(`${bidId}#key-2`)
    .addRecovery(`${bidId}#key-2`)
    .setDelegateSign({ signer: `${bidId}#key-1`, signatureValue: "signature" })
    .setExtensionField("customObject", { nested: true })
    .build()

  assert.deepEqual(document["@context"], ["https://w3.org/ns/did/v1", "https://example.com/extra"])
  assert.deepEqual(document.authentication, [`${bidId}#key-1`, `${bidId}#key-2`])
  assert.deepEqual(document.extension?.recovery, [`${bidId}#key-2`])
  assert.equal(document.extension?.delegateSign?.signatureValue, "signature")
  assert.equal("delegateSign " in (document.extension ?? {}), false)
  assert.deepEqual(document.extension?.["customObject"], { nested: true })
  assert.equal("context" in document, false)
})

test("Given multiple public keys and services, when build runs, then both arrays keep every entry", () => {
  const document = createBidDocument()
    .setId(bidId)
    .addPublicKey({
      id: `${bidId}#key-1`,
      type: "Ed25519",
      controller: bidId,
      publicKeyHex: "b9906e1b50e81501369cc777979f8bcf27bd1917d794fa6d5e320b1ccc4f48bb",
    })
    .addPublicKey({
      id: `${bidId}#key-2`,
      type: "Ed25519",
      controller: bidId,
      publicKeyHex: "b9906e1b50e81501369cc777979f8bcf27bd1917d794fa6d5e320b1ccc4f48bb",
    })
    .addService({
      id: `${bidId}#subResolve`,
      type: "DIDSubResolver",
      serviceEndpoint: "http://www.baidu.com",
      protocol: 2,
      serverType: 0,
      version: "1.0.0",
    })
    .build()

  assert.equal(document.publicKey?.length, 2)
  assert.equal(document.service?.length, 1)
  assert.deepEqual(document.service?.[0], {
    id: `${bidId}#subResolve`,
    type: "DIDSubResolver",
    serviceEndpoint: "http://www.baidu.com",
    protocol: 2,
    serverType: 0,
    version: "1.0.0",
  })
})

test("Given an empty context, when build runs, then it rejects the incomplete document", () => {
  assert.throws(() => createBidDocument().setId(bidId).setContext([]).build(), /@context/)
})

test("Given a service with only fixed fields, when build runs, then optional service fields are omitted", () => {
  const document = createBidDocument()
    .setId(bidId)
    .addService({
      id: `${bidId}#subResolve`,
      type: "DIDSubResolver",
      serviceEndpoint: "http://www.baidu.com",
    })
    .build()

  const json = JSON.parse(JSON.stringify(document)) as { service: ReadonlyArray<Record<string, unknown>> }
  assert.equal("protocol" in json.service[0]!, false)
  assert.equal("serverType" in json.service[0]!, false)
  assert.equal("version" in json.service[0]!, false)
})

test("Given duplicate public key ids, when build runs, then it rejects the duplicate", () => {
  const key = {
    id: `${bidId}#key-1`,
    type: "Ed25519",
    controller: bidId,
    publicKeyHex: "b9906e1b50e81501369cc777979f8bcf27bd1917d794fa6d5e320b1ccc4f48bb",
  }
  assert.throws(() => createBidDocument().setId(bidId).addPublicKey(key).addPublicKey(key).build(), /duplicate/)
})
