import * as enc from "@caict-bif/bif-encryption"

import { parseBidId, type BidId } from "../domain.js"
import { BidValidationError } from "../errors.js"

export interface VcSigner {
  readonly address: BidId
  readonly publicKey: string
  readonly algorithm: VcSigningAlgorithm
  sign(messageHex: string): string | Promise<string>
}

export type VcSigningAlgorithm = "ED25519" | "SM2"

export function algorithmFromPublicKey(publicKey: string): VcSigningAlgorithm {
  const tag = enc.getCryptoTypeFromPubKey(publicKey)
  if (tag === enc.CRYPTO_ED25519) return "ED25519"
  if (tag === enc.CRYPTO_SM2) return "SM2"
  throw new BidValidationError("publicKey", "uses an unsupported signing algorithm")
}

export function createEncSigner(privateKey: string): VcSigner {
  const account = enc.privateKeyManagerByKey(privateKey)
  return {
    address: parseBidId(account.encAddress),
    publicKey: account.encPublicKey,
    algorithm: algorithmFromPublicKey(account.encPublicKey),
    sign(messageHex: string): string {
      return enc.sign(messageHex, privateKey)
    },
  }
}

export function utf8ToHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex")
}

export function signingMessageHex(value: string): string {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0 ? value : utf8ToHex(value)
}

export function assertSingleSigner(input: { readonly privateKey?: string; readonly signer?: VcSigner }, field: string): void {
  if ((input.privateKey === undefined) === (input.signer === undefined)) {
    throw new BidValidationError(field, "requires exactly one of privateKey or signer")
  }
}

export function signerFromInput(input: { readonly privateKey?: string; readonly signer?: VcSigner }, field: string): VcSigner {
  assertSingleSigner(input, field)
  if (input.signer !== undefined) return input.signer
  if (input.privateKey === undefined) throw new BidValidationError(field, "privateKey is required")
  return createEncSigner(input.privateKey)
}
