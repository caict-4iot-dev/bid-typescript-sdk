import assert from "node:assert/strict"
import test from "node:test"

import {
  classifySubmissionFailure,
  SUBMISSION_FAILURE_HINTS,
  TransactionSubmissionError,
} from "../src/index.js"

test("Given an account-missing error, when classifying, then it detects an inactive account", () => {
  assert.equal(classifySubmissionFailure("The object does not exist, such as not being able to query accounts"), "account-not-active")
  assert.equal(classifySubmissionFailure("account not found"), "account-not-active")
})

test("Given an insufficient balance error, when classifying, then it detects missing fuel", () => {
  assert.equal(classifySubmissionFailure("Insufficient balance"), "insufficient-balance")
  assert.equal(classifySubmissionFailure("transaction fee exceeds account balance"), "insufficient-balance")
})

test("Given an unrelated error, when classifying, then it stays unknown without hints", () => {
  assert.equal(classifySubmissionFailure("contract method threw"), "unknown")
  assert.equal(SUBMISSION_FAILURE_HINTS.unknown, "")
})

test("Given a contract permission error, when classifying, then it detects a permission denial", () => {
  assert.equal(classifySubmissionFailure("sender had no right update"), "permission-denied")
  assert.equal(classifySubmissionFailure("Caller is not the owner"), "permission-denied")
})

test("Given a permission denial, when throwing, then it explains the authentication requirement", () => {
  const error = new TransactionSubmissionError("bop", "sender had no right update")

  assert.equal(error.hint, SUBMISSION_FAILURE_HINTS["permission-denied"])
  assert.match(error.message, /authentication 或 recovery/)
})

test("Given an inactive account submission failure, when throwing, then the message reminds activating on the open platform", () => {
  const error = new TransactionSubmissionError("bop", "The object does not exist, such as not being able to query accounts")

  assert.equal(error.hint, SUBMISSION_FAILURE_HINTS["account-not-active"])
  assert.match(error.message, /星火开放平台激活账户/)
})

test("Given an insufficient balance submission failure, when throwing, then the message reminds claiming fuel on the open platform", () => {
  const error = new TransactionSubmissionError("direct", "Insufficient balance")

  assert.equal(error.hint, SUBMISSION_FAILURE_HINTS["insufficient-balance"])
  assert.match(error.message, /星火开放平台领取星火令/)
})

test("Given an unknown submission failure, when throwing, then no hint is appended", () => {
  const error = new TransactionSubmissionError("bop", "contract method threw")

  assert.equal(error.hint, "")
  assert.match(error.message, /contract method threw/)
  assert.doesNotMatch(error.message, /星火/)
})