import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import { assembleJws, encodeJsonPart, parseJws, signingInputHex, verifyJwsWithKey } from "../src/vc/vc-jws.js"

test("Given an SM2 JWS, when parsing and verifying it, then its payload and signature are valid", () => {
  const keypair = enc.getBidAndKeyPairBySM2()
  const unsigned = `${encodeJsonPart({ alg: "SM2" })}.${encodeJsonPart({ hello: "world" })}`
  const jws = assembleJws(unsigned, enc.sign(Buffer.from(unsigned, "utf8").toString("hex"), keypair.encPrivateKey))

  const parsed = parseJws(jws)

  assert.deepEqual(parsed.payload, { hello: "world" })
  assert.equal(signingInputHex(parsed), Buffer.from(unsigned, "utf8").toString("hex"))
  assert.equal(verifyJwsWithKey(parsed, keypair.encPublicKey), true)
})

test("Given a malformed JWS, when parsing it, then it rejects the format", () => {
  assert.throws(() => parseJws("only.two"), /three parts/)
  assert.throws(() => parseJws("%%%.$$$.sig"), /base64url JSON/)
})
