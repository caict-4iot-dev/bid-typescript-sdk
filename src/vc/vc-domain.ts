import { z } from "zod"

export const credentialIdSchema = z.string().min(1).brand<"CredentialId">()
export type CredentialId = z.infer<typeof credentialIdSchema>

export const templateIdSchema = z.string().min(1).brand<"TemplateId">()
export type TemplateId = z.infer<typeof templateIdSchema>

export const applyNoSchema = z.string().min(1).brand<"ApplyNo">()
export type ApplyNo = z.infer<typeof applyNoSchema>

export const credentialJwsSchema = z.string().min(1).brand<"CredentialJws">()
export type CredentialJws = z.infer<typeof credentialJwsSchema>

export const vcPayloadSchema = z.object({
  "@context": z.array(z.string()).min(1),
  id: z.string().min(1),
  type: z.array(z.string()).min(1),
  issuer: z.string().regex(/^did:bid:[A-Za-z0-9]+$/),
  issuanceDate: z.string().min(1),
  templateId: z.string().min(1).optional(),
  validBefore: z.string().min(1).optional(),
  credentialSubject: z.object({ id: z.string().min(1) }).passthrough(),
  revocationId: z.string().optional(),
  parseType: z.string().min(1).optional(),
}).passthrough()
export type VcPayload = z.infer<typeof vcPayloadSchema>

export const vpEnvelopeSchema = z.object({
  "@context": z.array(z.string()).min(1),
  type: z.array(z.string()).min(1),
  credentialRequest: z.object({ jws: z.string().min(1) }),
  credentialParse: z.array(z.object({
    parseType: z.string().min(1),
    format: z.string().min(1).optional(),
  })),
  verifiableCredential: z.array(z.object({
    jws: z.string().min(1).optional(),
    "@id": z.string().min(1).optional(),
  }).passthrough()),
  proofs: z.object({ composeType: z.string().min(1).optional() }).passthrough().optional(),
}).passthrough()
export type VpEnvelope = z.infer<typeof vpEnvelopeSchema>

export const verificationCheckStateSchema = z.enum(["passed", "failed", "skipped"])
export type VerificationCheckState = z.infer<typeof verificationCheckStateSchema>

export type VerificationError = {
  readonly code: string
  readonly message: string
  readonly field?: string
}

export type VerificationChecks = {
  readonly format: VerificationCheckState
  readonly issuerTrust: VerificationCheckState
  readonly issuerSignature: VerificationCheckState
  readonly validity: VerificationCheckState
  readonly disclosure: VerificationCheckState
  readonly revocation: VerificationCheckState
}

export type VerificationResult = {
  readonly verified: boolean
  readonly checks: VerificationChecks
  readonly errors: readonly VerificationError[]
  readonly raw?: unknown
}

export const platformEnvelopeSchema = z.object({
  errorCode: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
}).passthrough()
export type PlatformEnvelope = z.infer<typeof platformEnvelopeSchema>

export function parseCredentialId(value: string): CredentialId {
  return credentialIdSchema.parse(value)
}

export function parseTemplateId(value: string): TemplateId {
  return templateIdSchema.parse(value)
}

export function parseApplyNo(value: string): ApplyNo {
  return applyNoSchema.parse(value)
}
