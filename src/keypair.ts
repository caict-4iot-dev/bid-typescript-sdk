import { BifSigner, generateKeyPair } from "@caict-bif/bif-typescript-sdk"

import { parseBidId, type BidId } from "./domain.js"

export type BidKeyPair = {
  readonly privateKey: string
  readonly publicKey: string
  readonly address: BidId
}

export interface BidSigner {
  readonly address: string
  readonly publicKey: string
  sign(messageHex: string): string
  verify(messageHex: string, signatureHex: string): boolean
}

export interface BidKeypairOperations {
  generate(chainCode?: string): BidKeyPair
  signer(privateKey: string): BidSigner
}

class WrappedBidSigner implements BidSigner {
  readonly address: string
  readonly publicKey: string

  constructor(private readonly signer: BifSigner) {
    this.address = signer.address
    this.publicKey = signer.publicKey
  }

  sign(messageHex: string): string { return this.signer.sign(messageHex) }
  verify(messageHex: string, signatureHex: string): boolean { return this.signer.verify(messageHex, signatureHex) }
}

export const bidKeypairOperations: BidKeypairOperations = {
  generate(chainCode?: string): BidKeyPair {
    const keypair = generateKeyPair(chainCode)
    return { privateKey: keypair.privateKey, publicKey: keypair.publicKey, address: parseBidId(keypair.address) }
  },
  signer(privateKey: string): BidSigner { return new WrappedBidSigner(new BifSigner(privateKey)) },
}
