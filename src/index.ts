export { createBidSdk, BidSdk } from "./bid-sdk.js"
export { configureBidSdk } from "./config.js"
export type { BidSdkUrls } from "./config.js"
export type { BidSdkConnectConfig, BidDocumentOperations, BidOperations } from "./bid-sdk.js"
export { createBidDocument, DEFAULT_DOCUMENT_CONTEXTS, DEFAULT_DOCUMENT_VERSION, DEFAULT_EXTENSION_TTL, DEFAULT_EXTENSION_TYPE } from "./bid-document.js"
export type { BidDocumentBuilder } from "./bid-document.js"
export { bidKeypairOperations } from "./keypair.js"
export type { BidKeyPair, BidKeyConvertOperations, BidKeypairOperations, BidKeystoreOperations, BidSigner, KeyAlgorithm, RawKeyResult } from "./keypair.js"
export { BidConfigurationError, BidNotFoundError, BidReadError, BidValidationError, TransactionSubmissionError, classifySubmissionFailure, SUBMISSION_FAILURE_HINTS } from "./errors.js"
export type { SubmissionFailureKind } from "./errors.js"
export type { VcOperations } from "./vc/index.js"
export { VcHolder } from "./vc/vc-holder.js"
export type { CredentialApplicationInput, DownloadCredentialInput, DownloadedCredential, ParsedCredential, TemplateDetailInput } from "./vc/vc-holder.js"
export { VcIssuer } from "./vc/vc-issuer.js"
export type { IssueInput, IssueResult, IssuerKeyInput, RevokeInput } from "./vc/vc-issuer.js"
export { PlatformApiError } from "./vc/vc-platform.js"
export type { PlatformLoginInput, PlatformSession, VcPlatformConfig } from "./vc/vc-platform.js"
export type { PlatformVerifierOptions, PlatformVerifyCredentialInput, VerifyCredentialInput } from "./vc/vc-verifier.js"
export { createEncSigner } from "./vc/vc-crypto.js"
export type { VcSigner, VcSigningAlgorithm } from "./vc/vc-crypto.js"
export { algorithmFromPublicKey } from "./vc/vc-crypto.js"
export { assembleJws, encodeJsonPart, parseJws, signingInputHex, verifyJwsWithKey } from "./vc/vc-jws.js"
export { createSelectiveDisclosurePresentation, encodeCanonicalJson, signSelectiveDisclosure, verifyHashOnlySignature, verifySelectiveDisclosure } from "./vc/vc-disclosure.js"
export { selectiveDisclosureProfile } from "./vc/vc-disclosure.js"
export type { SelectiveDisclosureField, SelectiveDisclosureProfile, SelectiveDisclosureResult, SelectiveDisclosureSignInput } from "./vc/vc-disclosure.js"
export { parseApplyNo, parseCredentialId, parseTemplateId, vcPayloadSchema, vpEnvelopeSchema } from "./vc/vc-domain.js"
export type { ApplyNo, CredentialId, CredentialJws, PlatformEnvelope, TemplateId, VerificationChecks, VerificationError, VerificationResult, VcPayload, VpEnvelope } from "./vc/vc-domain.js"
export { parseBidId } from "./domain.js"
export type {
  BidExtension,
  BidId,
  BidPublicKey,
  BidService,
  BuiltBidDocument,
  DelegateSign,
  SubmittedTransaction,
  TransactionId,
  TransactionOptions,
} from "./domain.js"
