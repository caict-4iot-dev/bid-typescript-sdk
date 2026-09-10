import * as enc from "@caict-bif/bif-encryption"

import { BidValidationError } from "../errors.js"
import { algorithmFromPublicKey, utf8ToHex } from "./vc-crypto.js"

export type ParsedJws = {
  readonly headerPart: string
  readonly payloadPart: string
  readonly signaturePart: string
  readonly header: unknown
  readonly payload: unknown
}

export function parseJws(value: string): ParsedJws {
  const parts = value.split(".")
  const [headerPart, payloadPart, signaturePart] = parts
  if (parts.length !== 3 || headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    throw new BidValidationError("jws", "must contain exactly three parts")
  }
  return {
    headerPart,
    payloadPart,
    signaturePart,
    header: decodeJsonPart(headerPart, "header"),
    payload: decodeJsonPart(payloadPart, "payload"),
  }
}

export function signingInputHex(jws: Pick<ParsedJws, "headerPart" | "payloadPart">): string {
  return utf8ToHex(`${jws.headerPart}.${jws.payloadPart}`)
}

export function verifyJwsWithKey(jws: ParsedJws, publicKey: string): boolean {
  if (readJwsAlgorithm(jws) !== algorithmFromPublicKey(publicKey)) return false
  return enc.verify(signingInputHex(jws), signatureHex(jws.signaturePart), publicKey)
}

/**
 * 兼容验签：不比对 JWS header alg 与公钥算法，直接用给定公钥验证签名。
 * 用于服务端在 JWS header 中写死 alg 但实际使用另一算法签名（如 alg=SM2 实际 ED25519）的临时兼容。
 * 仅在标准 `verifyJwsWithKey` 失败后作为回退使用。
 */
export function verifyJwsSignature(jws: ParsedJws, publicKey: string): boolean {
  return enc.verify(signingInputHex(jws), signatureHex(jws.signaturePart), publicKey)
}

export function readJwsAlgorithm(jws: Pick<ParsedJws, "header">): "ED25519" | "SM2" {
  if (typeof jws.header !== "object" || jws.header === null || Array.isArray(jws.header)) {
    throw new BidValidationError("jws.header", "must be an object")
  }
  const algorithm = Object.fromEntries(Object.entries(jws.header))["alg"]
  if (algorithm === undefined || algorithm === null || algorithm === "") return "SM2"
  if (algorithm !== "ED25519" && algorithm !== "SM2") {
    throw new BidValidationError("jws.header.alg", "must be ED25519 or SM2")
  }
  return algorithm
}

/** 读取待签字符串（base64url(header).base64url(payload)）中的 JWS header alg，缺少合法 header 时拒绝。 */
export function readJwsAlgorithmFromSigningInput(signingInput: string): "ED25519" | "SM2" {
  const headerPart = signingInput.split(".")[0]
  if (headerPart === undefined || headerPart === "") {
    throw new BidValidationError("jws signing input", "must contain a base64url header part")
  }
  return readJwsAlgorithm({ header: decodeJsonPart(headerPart, "header") })
}

export function assembleJws(payloadNeedSign: string, signatureHex: string): string {
  const parts = payloadNeedSign.split(".")
  if (parts.length !== 2) throw new BidValidationError("payloadNeedSign", "must contain header and payload parts")
  return `${payloadNeedSign}.${Buffer.from(signatureHex, "hex").toString("base64url")}`
}

export function encodeJsonPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

export function signatureHex(signaturePart: string): string {
  const decoded = Buffer.from(signaturePart, "base64url")
  const text = decoded.toString("utf8")
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return text
  return decoded.toString("hex")
}

function decodeJsonPart(value: string, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    return parsed
  } catch (error) {
    throw new BidValidationError(`jws.${field}`, error instanceof Error ? "must contain base64url JSON" : "must contain base64url JSON")
  }
}
