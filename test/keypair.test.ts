import assert from "node:assert/strict"
import test from "node:test"

import { bidKeypairOperations } from "../src/index.js"

test("Given no input, when generating a keypair, then it returns a BID address and encoded keys", () => {
  const keypair = bidKeypairOperations.generate()

  assert.match(keypair.address, /^did:bid:/)
  assert.notEqual(keypair.privateKey, "")
  assert.notEqual(keypair.publicKey, "")
})

test("Given a generated keypair, when signing a message, then verification succeeds only for the original message", () => {
  const keypair = bidKeypairOperations.generate()
  const signer = bidKeypairOperations.signer(keypair.privateKey)
  const signature = signer.sign("deadbeef")

  assert.equal(signer.address, keypair.address)
  assert.equal(signer.verify("deadbeef", signature), true)
  assert.equal(signer.verify("deadbeee", signature), false)
})
