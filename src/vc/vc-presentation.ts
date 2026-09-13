import { z } from "zod"

import type { VerificationChecks, VerificationError, VerificationResult } from "./vc-domain.js"
import { parseJws, type ParsedJws } from "./vc-jws.js"

/**
 * 标准 VC 出示信封（demo.json 同款）：
 * proof.jwt 为三段式 compact JWS，其余字段是 VC payload 的公开展示部分。
 * 本模块负责校验「信封外层字段」与「JWS payload」一致，防止伪造/篡改展示层。
 */

const presentationEnvelopeSchema = z.object({
  "@context": z.array(z.string()).min(1),
  credentialSubject: z.record(z.string(), z.unknown()),
  issuer: z.object({ id: z.string().min(1) }).passthrough(),
  validBefore: z.string().min(1).optional(),
  type: z.array(z.string()).min(1),
  issuanceDate: z.string().min(1),
  proof: z.object({
    jwt: z.string().min(1),
  }).passthrough(),
}).passthrough()

export type PresentationEnvelope = z.infer<typeof presentationEnvelopeSchema>

export type PresentationMismatch = {
  readonly field: string
  readonly expected: unknown
  readonly actual: unknown
}

/**
 * 比较标准 VC 信封外层字段与 JWS payload。
 * 只有信封同时提供了该字段时才比对；缺失字段不构成失败（JWS payload 才是权威）。
 * 返回所有不一致项；空数组表示一致。
 */
export function findPresentationMismatches(envelope: unknown, parsedJws: ParsedJws): PresentationMismatch[] {
  const parsed = presentationEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) return [{ field: "envelope", expected: "valid VC presentation envelope", actual: parsed.error.message }]
  const data = parsed.data
  const payload = parsedJws.payload
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [{ field: "payload", expected: "object", actual: "JWS payload is not an object" }]
  }
  const payloadRecord = payload as Readonly<Record<string, unknown>>
  const mismatches: PresentationMismatch[] = []
  const compare = (field: string, envelopeValue: unknown, payloadValue: unknown): void => {
    if (envelopeValue === undefined) return
    if (!deepEqual(envelopeValue, payloadValue)) {
      mismatches.push({ field, expected: payloadValue, actual: envelopeValue })
    }
  }
  compare("@context", data["@context"], payloadRecord["@context"])
  compare("credentialSubject", data["credentialSubject"], payloadRecord["credentialSubject"])
  compare("issuer.id", data.issuer.id, payloadRecord["issuer"])
  compare("validBefore", data.validBefore, payloadRecord["validBefore"])
  compare("type", data.type, payloadRecord["type"])
  compare("issuanceDate", data.issuanceDate, payloadRecord["issuanceDate"])
  return mismatches
}

/** 深比较两个值，忽略对象键顺序（数组保持顺序）。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  if (!leftKeys.every((key, index) => key === rightKeys[index])) return false
  return leftKeys.every((key) => deepEqual((left as Readonly<Record<string, unknown>>)[key], (right as Readonly<Record<string, unknown>>)[key]))
}

export function mismatchesToErrors(mismatches: readonly PresentationMismatch[]): VerificationError[] {
  return mismatches.map((mismatch) => ({
    code: "presentation-mismatch",
    message: `presentation field ${mismatch.field} does not match the signed JWS payload`,
    ...(typeof mismatch.field === "string" ? { field: mismatch.field } : {}),
  }))
}

export function mismatchesToChecks(): VerificationChecks {
  return {
    format: "failed",
    issuerTrust: "skipped",
    issuerSignature: "skipped",
    validity: "skipped",
    disclosure: "skipped",
    revocation: "skipped",
  }
}

/** 信封外层字段与 JWS payload 不一致时返回 failed 结果；一致返回 null（继续走正常验证）。 */
export function verifyPresentationConsistency(envelope: unknown, jws: string): VerificationResult | undefined {
  let parsedJws: ParsedJws
  try {
    parsedJws = parseJws(jws)
  } catch (error) {
    return {
      verified: false,
      checks: mismatchesToChecks(),
      errors: [{ code: "jws-parse-failed", message: error instanceof Error ? error.message : "credential JWS could not be parsed" }],
    }
  }
  const mismatches = findPresentationMismatches(envelope, parsedJws)
  if (mismatches.length === 0) return undefined
  return {
    verified: false,
    checks: mismatchesToChecks(),
    errors: mismatchesToErrors(mismatches),
  }
}