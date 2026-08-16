import assert from "node:assert/strict"
import test from "node:test"

import { BidNotFoundError, parseBidId } from "../src/index.js"
import { ParserBidReader } from "../src/parser.js"

const bidId = parseBidId("did:bid:efnVUgqQFfYeu97ABf6sGm3WFtVXHZB2")

test("Given a successful parser response, when get runs, then it returns the document", async () => {
  const reader = new ParserBidReader({
    baseUrl: "https://parser.example",
    fetcher: async () => new Response(JSON.stringify({
      errorCode: 0,
      message: "Success",
      data: { didDocument: { id: bidId, "@context": ["https://www.w3.org/ns/did/v1"] } },
    })),
  })

  const document = await reader.get(bidId)
  assert.equal(document.id, bidId)
})

test("Given a parser not-found response, when get runs, then it throws BidNotFoundError", async () => {
  const reader = new ParserBidReader({
    baseUrl: "https://parser.example",
    fetcher: async () => new Response(JSON.stringify({ errorCode: 100000, message: "Missing" })),
  })

  await assert.rejects(reader.get(bidId), BidNotFoundError)
})
