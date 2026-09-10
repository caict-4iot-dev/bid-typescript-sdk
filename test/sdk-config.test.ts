import assert from "node:assert/strict"
import test from "node:test"

import { configureBidSdk } from "../src/config.js"

test("Given all node URLs, when configuring the SDK, then normalized URLs are returned", () => {
  const configured = configureBidSdk({
    bopUrl: "https://bop.example.com",
    parserUrl: "https://parser.example.com/bid",
    vcPlatformUrl: "https://wallet.example.com",
    vcCredentialUrl: "https://credential.example.com",
    vcVerificationUrl: "https://verify.example.com",
  })

  assert.deepEqual(configured, {
    bopUrl: "https://bop.example.com/",
    parserUrl: "https://parser.example.com/bid/",
    vcPlatformUrl: "https://wallet.example.com/",
    vcCredentialUrl: "https://credential.example.com/",
    vcVerificationUrl: "https://verify.example.com/",
  })
})

test("Given a relative URL, when configuring the SDK, then it rejects the configuration", () => {
  assert.throws(() => configureBidSdk({
    bopUrl: "/bop",
    parserUrl: "https://parser.example.com/bid/",
    vcPlatformUrl: "https://wallet.example.com/",
    vcCredentialUrl: "https://credential.example.com/",
    vcVerificationUrl: "https://verify.example.com/",
  }))
})
