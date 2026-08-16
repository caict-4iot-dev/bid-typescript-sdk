import assert from "node:assert/strict"
import test from "node:test"

import { createBidDocument } from "../src/bid-document.js"
import { encodeCreatePayload } from "../src/contracts.js"
import { parseBidId } from "../src/domain.js"

test("Given a built document, when encoding create, then it uses the native contract envelope", () => {
  const id = parseBidId("did:bid:efnVUgqQFfYeu97ABf6sGm3WFtVXHZB2")
  const document = createBidDocument().setId(id).setContext(["https://www.w3.org/ns/did/v1"]).build()

  assert.deepEqual(JSON.parse(encodeCreatePayload(document)), {
    method: "create",
    params: { document },
  })
})
