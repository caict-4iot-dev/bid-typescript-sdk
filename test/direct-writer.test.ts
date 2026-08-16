import assert from "node:assert/strict"
import test from "node:test"

import type { Operation } from "@caict-bif/bif-typescript-sdk"

import { DirectBidWriter, type DirectSdk, type DirectSigner, type DirectTransactionRequest } from "../src/chain.js"

const contractAddress = "did:bid:efTEST0000000000000000000"

test("Given a direct writer, when submitting a transaction, then it uses RANDOM_NONCE without querying account nonce", async () => {
  const sdk = new FakeDirectSdk()
  const writer = new DirectBidWriter(contractAddress, sdk)

  const id = await writer.submit('{"method":"create","params":{}}', { privateKey: "private-key" })

  const request = sdk.lastRequest
  assert.ok(request !== undefined)
  assert.equal(request.nonceType, 1)
  assert.equal(typeof request.nonce, "number")
  assert.ok(request.nonce > 0)
  assert.ok(request.maxLedgerSeq >= 1_000)
  assert.equal(request.operations.length, 1)
  assert.equal(sdk.ledgerQueries, 1)
  assert.match(id, /^[0-9a-f]{64}$/)
})

test("Given a direct writer and a chain rejection, when submitting, then it maps the failure reason", async () => {
  const sdk = new FakeDirectSdk("Insufficient balance")
  const writer = new DirectBidWriter(contractAddress, sdk)

  await assert.rejects(writer.submit("input", { privateKey: "private-key" }), /星火开放平台领取星火令/)
})

class FakeDirectSdk implements DirectSdk {
  ledgerQueries = 0
  lastRequest?: DirectTransactionRequest

  constructor(private readonly failure?: string) {}

  createSigner(): DirectSigner {
    return {
      address: "did:bid:efAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      getLedgerNumber: async () => {
        this.ledgerQueries += 1
        return 1_000
      },
      sendTransaction: async (transaction: DirectTransactionRequest) => {
        this.lastRequest = transaction
        if (this.failure !== undefined) return { errorCode: 1, errorDescription: this.failure }
        return { hash: "a".repeat(64), errorCode: 0, errorDescription: "" }
      },
    }
  }

  buildContractInvoke(): Operation {
    return { type: 7, pay_coin: {} }
  }
}