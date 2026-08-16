import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

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

test("Given an ED25519 keypair, when converting native and encrypted keys, then the round-trip restores the original keys", () => {
  const keypair = bidKeypairOperations.generate()

  const rawPrivate = bidKeypairOperations.convert.toRawPrivateKey(keypair.privateKey)
  assert.equal(rawPrivate.algorithm, "ED25519")
  assert.equal(bidKeypairOperations.convert.toEncPrivateKey(rawPrivate.keyHex, "ED25519"), keypair.privateKey)

  const rawPublic = bidKeypairOperations.convert.toRawPublicKey(keypair.publicKey)
  assert.equal(rawPublic.algorithm, "ED25519")
  assert.equal(bidKeypairOperations.convert.toEncPublicKey(rawPublic.keyHex, "ED25519"), keypair.publicKey)
})

test("Given an SM2 keypair, when converting native and encrypted keys, then it detects the SM2 algorithm and round-trips", () => {
  const sm2 = enc.getBidAndKeyPairBySM2()

  const rawPrivate = bidKeypairOperations.convert.toRawPrivateKey(sm2.encPrivateKey)
  assert.equal(rawPrivate.algorithm, "SM2")
  assert.equal(bidKeypairOperations.convert.toEncPrivateKey(rawPrivate.keyHex, "SM2"), sm2.encPrivateKey)

  const rawPublic = bidKeypairOperations.convert.toRawPublicKey(sm2.encPublicKey)
  assert.equal(rawPublic.algorithm, "SM2")
  assert.equal(rawPublic.keyHex.length, 130)
  assert.equal(bidKeypairOperations.convert.toEncPublicKey(rawPublic.keyHex, "SM2"), sm2.encPublicKey)
})

test("Given malformed raw keys, when converting, then it rejects them", () => {
  assert.throws(() => bidKeypairOperations.convert.toEncPrivateKey("abcd", "ED25519"), /32 bytes/)
  assert.throws(() => bidKeypairOperations.convert.toEncPublicKey("ab", "SM2"), /65 bytes/)
  assert.throws(() => bidKeypairOperations.convert.toRawPrivateKey("not-a-key"), /invalid privateKey/)
})
