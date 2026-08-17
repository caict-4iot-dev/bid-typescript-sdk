import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_TRANSACTION_OPTIONS, resolveTransactionOptions } from "../src/contracts.js"

test("Given only a private key, when resolving transaction options, then SDK defaults are applied", () => {
  const options = resolveTransactionOptions({ privateKey: "private-key" })

  assert.deepEqual(options, { privateKey: "private-key", ...DEFAULT_TRANSACTION_OPTIONS, async: false })
})

test("Given custom chain options, when resolving transaction options, then custom values override SDK defaults", () => {
  const options = resolveTransactionOptions({ privateKey: "private-key", feeLimit: 9, gasPrice: 8, amount: 7 })

  assert.deepEqual(options, { privateKey: "private-key", feeLimit: 9, gasPrice: 8, amount: 7, async: false })
})

test("Given the async flag, when resolving transaction options, then it is passed through", () => {
  const options = resolveTransactionOptions({ privateKey: "private-key", async: true })

  assert.equal(options.async, true)
})
