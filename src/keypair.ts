import { BifSigner, generateKeyPair } from "@caict-bif/bif-typescript-sdk"
import * as enc from "@caict-bif/bif-encryption"

import { parseBidId, type BidId } from "./domain.js"
import { BidValidationError } from "./errors.js"

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

export type KeyAlgorithm = "ED25519" | "SM2"

/** 原生公私钥与星火编码公私钥互转结果。 */
export type RawKeyResult = {
  readonly algorithm: KeyAlgorithm
  readonly keyHex: string
}

export interface BidKeyConvertOperations {
  /** 原生私钥（hex）转星火编码私钥；ED25519 与 SM2 私钥均为 32 字节。 */
  toEncPrivateKey(rawPrivateKeyHex: string, algorithm: KeyAlgorithm): string
  /** 原生公钥（hex）转星火编码公钥；ED25519 为 32 字节，SM2 为 65 字节（04 开头）。 */
  toEncPublicKey(rawPublicKeyHex: string, algorithm: KeyAlgorithm): string
  /** 星火编码私钥转原生私钥。 */
  toRawPrivateKey(encPrivateKey: string): RawKeyResult
  /** 星火编码公钥转原生公钥。 */
  toRawPublicKey(encPublicKey: string): RawKeyResult
}

export interface BidKeystoreOperations {
  /** 本地解密 keystore，返回星火编码明文私钥；调用方应仅临时使用返回值。 */
  toPrivateKey(keystoreContent: string | object, password: string): string
}

export interface BidKeypairOperations {
  generate(chainCode?: string): BidKeyPair
  signer(privateKey: string): BidSigner
  /** 原生密钥与星火编码密钥互转。 */
  convert: BidKeyConvertOperations
  /** keystore 本地解密；返回值可继续传给现有需要 privateKey 的 API。 */
  keystore: BidKeystoreOperations
}

const ALGORITHM_TAG = { ED25519: enc.CRYPTO_ED25519, SM2: enc.CRYPTO_SM2 } as const

function toAlgorithm(tag: number): KeyAlgorithm {
  if (tag === enc.CRYPTO_ED25519) return "ED25519"
  if (tag === enc.CRYPTO_SM2) return "SM2"
  throw new Error("unsupported crypto type")
}

const bidKeyConvert: BidKeyConvertOperations = {
  toEncPrivateKey(rawPrivateKeyHex, algorithm): string {
    return enc.rawToEncPrivateKey(rawPrivateKeyHex, ALGORITHM_TAG[algorithm])
  },
  toEncPublicKey(rawPublicKeyHex, algorithm): string {
    return enc.rawToEncPublicKey(rawPublicKeyHex, ALGORITHM_TAG[algorithm])
  },
  toRawPrivateKey(encPrivateKey) {
    const result = enc.encToRawPrivateKey(encPrivateKey)
    return { algorithm: toAlgorithm(result.cryptoType), keyHex: result.rawPrivateKey }
  },
  toRawPublicKey(encPublicKey) {
    const result = enc.encToRawPublicKey(encPublicKey)
    return { algorithm: toAlgorithm(result.cryptoType), keyHex: result.rawPublicKey }
  },
}

const bidKeystoreOperations: BidKeystoreOperations = {
  toPrivateKey(keystoreContent, password): string {
    const privateKey = enc.decipherKeyStore(keystoreContent, password)
    if (typeof privateKey !== "string") throw new BidValidationError("keystore", "did not decrypt to a private key")
    return privateKey
  },
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
  convert: bidKeyConvert,
  keystore: bidKeystoreOperations,
}
