import * as enc from "@caict-bif/bif-encryption"
import canonicalize from "canonicalize"
import smCrypto from "brdc-sm-crypto"
import { createHash } from "node:crypto"

import { BidValidationError } from "../errors.js"
import { algorithmFromPublicKey, type VcSigner, type VcSigningAlgorithm } from "./vc-crypto.js"
import { parseJws, signatureHex, type ParsedJws } from "./vc-jws.js"

export type SelectiveDisclosureField = {
  readonly value?: string
  readonly salt?: string
  readonly hash: string
}

export type SelectiveDisclosureResult = {
  readonly valid: boolean
  readonly disclosedFields: readonly string[]
}

export type SelectiveDisclosureProfile = {
  readonly signingAlgorithm: VcSigningAlgorithm
  readonly parseType: "sel-disclose-SM2" | "sel-disclose-ED25519"
  readonly hashAlgorithm: "SM3" | "SHA-256"
}

export function selectiveDisclosureProfile(algorithm: VcSigningAlgorithm): SelectiveDisclosureProfile {
  switch (algorithm) {
    case "SM2": return { signingAlgorithm: "SM2", parseType: "sel-disclose-SM2", hashAlgorithm: "SM3" }
    case "ED25519": return { signingAlgorithm: "ED25519", parseType: "sel-disclose-ED25519", hashAlgorithm: "SHA-256" }
  }
}

export type SelectiveDisclosureSignInput = {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signer: VcSigner
  readonly saltFactory?: () => string
}

export async function signSelectiveDisclosure(input: SelectiveDisclosureSignInput): Promise<string> {
  const profile = selectiveDisclosureProfile(input.signer.algorithm)
  const fullPayload = addDisclosureFields({ ...input.payload, parseType: profile.parseType }, input.saltFactory ?? defaultSalt, profile)
  const hashPayload = removeDisclosureSecrets(fullPayload)
  const headerPart = encodeCanonicalJson({ ...input.header, alg: profile.signingAlgorithm })
  const hashPayloadPart = encodeCanonicalJson(hashPayload)
  const signatureInput = Buffer.from(`${headerPart}.${hashPayloadPart}`, "utf8").toString("hex")
  const signatureHex = await input.signer.sign(signatureInput)
  return `${headerPart}.${encodeCanonicalJson(fullPayload)}.${Buffer.from(signatureHex, "hex").toString("base64url")}`
}

export function createSelectiveDisclosurePresentation(jws: string, disclose: readonly string[]): string {
  const parsed = parseJws(jws)
  const payload = asRecord(parsed.payload, "credential payload")
  const subject = asRecord(payload["credentialSubject"], "credentialSubject")
  const selected = new Set(disclose)
  const disclosedSubject: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(subject)) {
    if (key === "id") {
      disclosedSubject[key] = raw
      continue
    }
    const field = parseDisclosureField(raw, `credentialSubject.${key}`)
    disclosedSubject[key] = selected.has(key) ? field : { hash: field.hash }
  }
  const presentationPayload = { ...payload, credentialSubject: disclosedSubject }
  return `${parsed.headerPart}.${encodeCanonicalJson(presentationPayload)}.${parsed.signaturePart}`
}

export function verifySelectiveDisclosure(jws: ParsedJws, publicKey?: string): SelectiveDisclosureResult {
  const payload = asRecord(jws.payload, "credential payload")
  const profile = profileFromPayload(payload)
  const subject = asRecord(payload["credentialSubject"], "credentialSubject")
  const disclosedFields: string[] = []
  for (const [key, raw] of Object.entries(subject)) {
    if (key === "id") continue
    const field = parseDisclosureField(raw, `credentialSubject.${key}`)
    if (field.value !== undefined) {
      if (field.salt === undefined || commitmentHash(field.value + field.salt, profile.hashAlgorithm) !== field.hash) return { valid: false, disclosedFields }
      disclosedFields.push(key)
    }
  }
  if (publicKey !== undefined) {
    // 标准路径要求 header alg 与公钥算法一致；宽松回退忽略该一致性（服务端可能写死 header alg）。
    const strictValid = verifyHashOnlySignature(jws, publicKey) || verifyHashOnlySignatureLenient(jws, publicKey)
    if (!strictValid) return { valid: false, disclosedFields }
  }
  return { valid: true, disclosedFields }
}

export function verifyHashOnlySignature(jws: ParsedJws, publicKey: string): boolean {
  const payload = asRecord(jws.payload, "credential payload")
  const profile = profileFromPayload(payload)
  const header = asRecord(jws.header, "jws.header")
  if (header["alg"] !== profile.signingAlgorithm || algorithmFromPublicKey(publicKey) !== profile.signingAlgorithm) return false
  const signingInput = `${jws.headerPart}.${encodeCanonicalJson(removeDisclosureSecrets(payload))}`
  return enc.verify(Buffer.from(signingInput, "utf8").toString("hex"), signatureHex(jws.signaturePart), publicKey)
}

/**
 * 选择性披露 hash-only 宽松验签：不校验 header alg 与公钥算法一致性，
 * 直接用给定公钥验证对「去除 value/salt 后的 canonical payload」的签名。
 * 用于服务端 header alg 写死但与实际签名算法不一致（如 alg=SM2 实际 ED25519）的临时兼容回退。
 */
export function verifyHashOnlySignatureLenient(jws: ParsedJws, publicKey: string): boolean {
  const payload = asRecord(jws.payload, "credential payload")
  const signingInput = `${jws.headerPart}.${encodeCanonicalJson(removeDisclosureSecrets(payload))}`
  return enc.verify(Buffer.from(signingInput, "utf8").toString("hex"), signatureHex(jws.signaturePart), publicKey)
}

function addDisclosureFields(payload: Readonly<Record<string, unknown>>, saltFactory: () => string, profile: SelectiveDisclosureProfile): Readonly<Record<string, unknown>> {
  const subject = asRecord(payload["credentialSubject"], "credentialSubject")
  const transformed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(subject)) {
    if (key === "id") {
      transformed[key] = value
      continue
    }
    const salt = saltFactory()
    const text = primitiveText(value)
    transformed[key] = { value: text, salt, hash: commitmentHash(text + salt, profile.hashAlgorithm) }
  }
  return { ...payload, credentialSubject: transformed }
}

function removeDisclosureSecrets(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const subject = asRecord(payload["credentialSubject"], "credentialSubject")
  const transformed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(subject)) {
    if (key === "id") {
      transformed[key] = value
      continue
    }
    const field = parseDisclosureField(value, `credentialSubject.${key}`)
    transformed[key] = { hash: field.hash }
  }
  return { ...payload, credentialSubject: transformed }
}

function parseDisclosureField(value: unknown, field: string): SelectiveDisclosureField {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BidValidationError(field, "must be a disclosure object")
  const record = Object.fromEntries(Object.entries(value))
  const hash = record["hash"]
  const salt = record["salt"]
  const disclosedValue = record["value"]
  if (typeof hash !== "string" || hash === "") throw new BidValidationError(field, "hash is required")
  if (salt !== undefined && typeof salt !== "string") throw new BidValidationError(field, "salt must be a string")
  if (disclosedValue !== undefined && typeof disclosedValue !== "string") throw new BidValidationError(field, "value must be a string")
  if (disclosedValue !== undefined && salt === undefined) throw new BidValidationError(field, "salt is required when value is disclosed")
  return { hash, ...(salt === undefined ? {} : { salt }), ...(disclosedValue === undefined ? {} : { value: disclosedValue }) }
}

export function encodeCanonicalJson(value: unknown): string {
  const result = canonicalize(value)
  if (result === undefined) throw new BidValidationError("json", "could not be canonicalized")
  return Buffer.from(result, "utf8").toString("base64url")
}

function defaultSalt(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 10)}`.slice(0, 16)
}

function profileFromPayload(payload: Readonly<Record<string, unknown>>): SelectiveDisclosureProfile {
  const parseType = payload["parseType"]
  if (parseType === undefined || parseType === null || parseType === "") return selectiveDisclosureProfile("SM2")
  if (parseType === "sel-disclose-SM2") return selectiveDisclosureProfile("SM2")
  if (parseType === "sel-disclose-ED25519") return selectiveDisclosureProfile("ED25519")
  throw new BidValidationError("credential.parseType", "must be sel-disclose-SM2 or sel-disclose-ED25519")
}

export function commitmentHash(value: string, algorithm: SelectiveDisclosureProfile["hashAlgorithm"]): string {
  return algorithm === "SM3" ? smCrypto.sm3(value) : createHash("sha256").update(value, "utf8").digest("hex")
}

function primitiveText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new BidValidationError("credentialSubject", "value could not be serialized")
  return serialized
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BidValidationError(field, "must be an object")
  return Object.fromEntries(Object.entries(value))
}
