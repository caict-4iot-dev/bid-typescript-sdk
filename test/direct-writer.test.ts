import assert from "node:assert/strict"
import test from "node:test"

import type { Operation } from "@caict-bif/bif-typescript-sdk"

import { DirectBidWriter, type DirectSdk, type DirectSigner, type DirectTransactionRequest, type TransactionState } from "../src/chain.js"

const contractAddress = "did:bid:efTEST0000000000000000000"

test("Given a direct writer, when submitting a confirmed transaction, then it uses RANDOM_NONCE and returns status ok", async () => {
  const sdk = new FakeDirectSdk({ kind: "confirmed", errorCode: 0, errorDesc: "" })
  const writer = new DirectBidWriter(contractAddress, sdk)

  const outcome = await writer.submit('{"method":"create","params":{}}', { privateKey: "private-key" })

  const request = sdk.lastRequest
  assert.ok(request !== undefined)
  assert.equal(request.nonceType, 1)
  assert.equal(typeof request.nonce, "number")
  assert.ok(request.nonce > 0)
  assert.ok(request.maxLedgerSeq >= 1_000)
  assert.equal(request.operations.length, 1)
  assert.equal(sdk.ledgerQueries, 1)
  assert.equal(outcome.status, "ok")
  assert.equal(outcome.hash.length, 64)
})

test("Given a confirmed failure on chain, when submitting, then it throws the chain error with a user hint", async () => {
  const sdk = new FakeDirectSdk({ kind: "confirmed", errorCode: 1, errorDesc: "Insufficient balance" })
  const writer = new DirectBidWriter(contractAddress, sdk)

  await assert.rejects(writer.submit("input", { privateKey: "private-key" }), /星火开放平台领取星火令/)
})

test("Given a transaction still in the pool, when submitting, then it returns pending with the hash after the timeout", async () => {
  const sdk = new FakeDirectSdk({ kind: "pooled" })
  const writer = new DirectBidWriter(contractAddress, sdk, { timeoutMs: 50, intervalMs: 10 })

  const outcome = await writer.submit("input", { privateKey: "private-key" })

  assert.equal(outcome.status, "pending")
  assert.match(outcome.hint, new RegExp(outcome.hash))
  assert.match(outcome.hint, /区块链浏览器/)
})

class FakeDirectSdk implements DirectSdk {
  ledgerQueries = 0
  lastRequest?: DirectTransactionRequest

  constructor(private readonly state: TransactionState) {}

  createSigner(): DirectSigner {
    return {
      address: "did:bid:efAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      getLedgerNumber: async () => {
        this.ledgerQueries += 1
        return 1_000
      },
      sendTransaction: async (transaction: DirectTransactionRequest) => {
        this.lastRequest = transaction
        return { hash: "a".repeat(64), errorCode: 0, errorDescription: "" }
      },
    }
  }

  buildContractInvoke(): Operation {
    return { type: 7, pay_coin: {} }
  }

  async getTransactionState(): Promise<TransactionState> {
    return this.state
  }
}