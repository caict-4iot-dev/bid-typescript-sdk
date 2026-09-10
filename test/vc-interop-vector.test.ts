import assert from "node:assert/strict"
import test from "node:test"

import * as enc from "@caict-bif/bif-encryption"

import {
  commitmentHash,
  createSelectiveDisclosurePresentation,
  encodeCanonicalJson,
  verifyHashOnlySignature,
  verifySelectiveDisclosure,
} from "../src/vc/vc-disclosure.js"
import { parseJws, readJwsAlgorithm, signatureHex, signingInputHex, verifyJwsWithKey } from "../src/vc/vc-jws.js"
import { hashAlgorithmFor, keyFor, readVectorSuite, type VectorEntry, type VectorSuite } from "./vc-vector-fixture.js"

test("Given fixed Java test keys, when deriving keys in TypeScript, then the encoded keys and addresses match", () => {
  const suite = readVectorSuite()

  for (const [name, rawPrivateKeyHex, cryptoType] of [
    ["sm2", suite.keys.sm2.rawPrivateKeyHex, enc.CRYPTO_SM2],
    ["ed25519", suite.keys.ed25519.rawPrivateKeyHex, enc.CRYPTO_ED25519],
  ] as const) {
    const key = suite.keys[name]
    assert.equal(enc.rawToEncPrivateKey(rawPrivateKeyHex, cryptoType), key.encPrivateKey)
    const account = enc.privateKeyManagerByKey(key.encPrivateKey)
    assert.equal(account.encPublicKey, key.encPublicKey)
    assert.equal(account.encAddress, key.encAddress)
  }
})

test("Given the Java SM2 direct vector, when verifying with the TS SDK, then canonical encoding and signature are valid", () => {
  const suite = readVectorSuite()
  const vector = vectorByName(suite, "SM2-direct")
  const key = keyFor(suite.keys, vector.alg)

  assertParsedJwsMatches(vector, vector.jwsVcWire)
  assert.equal(signatureHex(vector.jwsVcWire.split(".")[2] as string).length, 128)
  assert.equal(encodeCanonicalJson(JSON.parse(vector.headerJson) as unknown), vector.headerPart)
  assert.equal(encodeCanonicalJson(JSON.parse(vector.payloadJson) as unknown), vector.payloadPart)
  assert.equal(vector.signingInput, `${vector.headerPart}.${vector.payloadPart}`)
  assert.equal(
    vector.signingInputHex.toLowerCase(),
    Buffer.from(vector.signingInput, "utf8").toString("hex"),
  )

  assert.equal(verifyJwsWithKey(parseJws(vector.jwsVcWire), key.encPublicKey), true)

  // VP wire (base64url of raw signature bytes) must decode to the same signature hex.
  const vpParsed = parseJws(vector.jwsVpWire)
  assert.equal(signatureHex(vpParsed.signaturePart).toLowerCase(), vector.signatureHex.toLowerCase())
  assert.equal(verifyJwsWithKey(vpParsed, key.encPublicKey), true)
})

test("Given the Java ED25519 direct vector, when verifying with the TS SDK, then signature bytes are deterministic and match", () => {
  const suite = readVectorSuite()
  const vector = vectorByName(suite, "ED25519-direct")
  const key = keyFor(suite.keys, vector.alg)

  assertParsedJwsMatches(vector, vector.jwsVcWire)
  assert.equal(encodeCanonicalJson(JSON.parse(vector.payloadJson) as unknown), vector.payloadPart)
  assert.equal(verifyJwsWithKey(parseJws(vector.jwsVcWire), key.encPublicKey), true)

  // ED25519 is deterministic: the TypeScript signer reproduces the exact Java signature bytes.
  assert.equal(enc.sign(vector.signingInputHex, key.encPrivateKey).toLowerCase(), vector.signatureHex.toLowerCase())
})

test("Given the Java SM2 selective-disclosure vector, when verifying with the TS SDK, then SM3 commitments and hash-only signature are valid", async () => {
  const suite = readVectorSuite()
  const vector = vectorByName(suite, "SM2-selective")
  const key = keyFor(suite.keys, vector.alg)

  assertParsedJwsMatches(vector, vector.jwsVcWire)
  assert.equal(vector.parseType, "sel-disclose-SM2")
  assert.equal(hashOnlySigningPart(vector), vector.signingPayloadPart)
  assert.equal(vector.signingInput, `${vector.headerPart}.${vector.signingPayloadPart}`)

  for (const commitment of Object.values(vector.commitments ?? {})) {
    assert.equal(commitmentHash(commitment.value + commitment.salt, hashAlgorithmFor(vector.alg)), commitment.hash.toLowerCase())
  }

  assert.equal(verifyHashOnlySignature(parseJws(vector.jwsVcWire), key.encPublicKey), true)
  assert.deepEqual(verifySelectiveDisclosure(parseJws(vector.jwsVcWire), key.encPublicKey), {
    valid: true,
    disclosedFields: ["age", "country", "name"],
  })

  // Creating a presentation that reveals a subset must stay verifiable.
  const presented = parseJws(createSelectiveDisclosurePresentation(vector.jwsVcWire, ["age"]))
  assert.deepEqual(verifySelectiveDisclosure(presented, key.encPublicKey), {
    valid: true,
    disclosedFields: ["age"],
  })
})

test("Given the Java ED25519 selective-disclosure vector, when verifying with the TS SDK, then SHA-256 commitments and deterministic signature are valid", () => {
  const suite = readVectorSuite()
  const vector = vectorByName(suite, "ED25519-selective")
  const key = keyFor(suite.keys, vector.alg)

  assertParsedJwsMatches(vector, vector.jwsVcWire)
  assert.equal(vector.parseType, "sel-disclose-ED25519")
  assert.equal(hashOnlySigningPart(vector), vector.signingPayloadPart)

  for (const commitment of Object.values(vector.commitments ?? {})) {
    assert.equal(commitmentHash(commitment.value + commitment.salt, hashAlgorithmFor(vector.alg)), commitment.hash.toLowerCase())
  }

  assert.equal(verifyHashOnlySignature(parseJws(vector.jwsVcWire), key.encPublicKey), true)
  assert.deepEqual(verifySelectiveDisclosure(parseJws(vector.jwsVcWire), key.encPublicKey), {
    valid: true,
    disclosedFields: ["age", "country", "name"],
  })

  // Deterministic re-signing of the hash-only signing input reproduces the Java signature.
  assert.equal(
    enc.sign(vector.signingInputHex, key.encPrivateKey).toLowerCase(),
    vector.signatureHex.toLowerCase(),
  )
})

function assertParsedJwsMatches(vector: VectorEntry, jws: string): void {
  const parsed = parseJws(jws)
  assert.equal(parsed.headerPart, vector.headerPart)
  assert.equal(parsed.payloadPart, vector.payloadPart)
  assert.deepEqual(parsed.header, JSON.parse(vector.headerJson) as unknown)
  assert.deepEqual(parsed.payload, JSON.parse(vector.payloadJson) as unknown)
  assert.equal(readJwsAlgorithm(parsed), vector.alg)
  if (vector.payloadPart === vector.signingPayloadPart) {
    // Direct disclosure: the JWS parts themselves form the signing input.
    assert.equal(
      signingInputHex(parsed).toLowerCase(),
      vector.signingInputHex.toLowerCase(),
      "signing input hex must match the Java vector",
    )
  }
  assert.equal(
    signatureHex(parsed.signaturePart).toLowerCase(),
    vector.signatureHex.toLowerCase(),
    "signature hex must decode from the wire part",
  )
}

const hashOnlySigningPart = (vector: VectorEntry): string =>
  encodeCanonicalJson(JSON.parse(vector.signingPayloadJson) as unknown)

function vectorByName(suite: VectorSuite, name: string): VectorEntry {
  const vector = suite.vectors.find((candidate) => candidate.name === name)
  if (vector === undefined) throw new Error(`missing vector: ${name}`)
  return vector
}