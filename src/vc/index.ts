import { BidConfigurationError } from "../errors.js"
import { createEncSigner } from "./vc-crypto.js"
import type { VcSigner } from "./vc-crypto.js"
export { createEncSigner }
import { VcHolder } from "./vc-holder.js"
import { VcIssuer } from "./vc-issuer.js"
import { VcPlatformClient, type VcPlatformConfig } from "./vc-platform.js"
import type { VerificationResult } from "./vc-domain.js"
import { LocalVcVerifier, RemoteVcVerifier, type PlatformVerifierOptions, type PlatformVerifyCredentialInput, type VerifyCredentialInput } from "./vc-verifier.js"
import type { IssuerPublicKeySource, IssuerTrustReader } from "./vc-trust.js"
import { parseApplyNo, parseCredentialId, parseTemplateId, vcPayloadSchema, type VcPayload } from "./vc-domain.js"
import { parseJws } from "./vc-jws.js"

export { parseApplyNo, parseCredentialId, parseTemplateId, parseJws, vcPayloadSchema }
export type { VerificationResult, VcPayload }

export type VcOperations = {
  readonly signer: {
    fromPrivateKey(privateKey: string): VcSigner
  }
  readonly platform: {
    create(config?: VcPlatformConfig): VcPlatformClient
  }
  readonly holder: {
    create(platform: VcPlatformClient): VcHolder
  }
  readonly issuer: {
    create(platform: VcPlatformClient): VcIssuer
  }
  readonly verifier: {
    verifyCredential(input: VerifyCredentialInput): Promise<VerificationResult>
    verifyCredentialByPlatform(input: PlatformVerifyCredentialInput, options?: PlatformVerifierOptions): Promise<VerificationResult>
  }
}

export type VcConnection = {
  readonly issuerTrust: IssuerTrustReader
  readonly issuerPublicKeySource?: IssuerPublicKeySource | undefined
  readonly issuerDocumentReader?: {
    readonly get: (issuer: string) => Promise<{
      readonly id: string
      readonly publicKey?: readonly {
        readonly id: string
        readonly type: string
        readonly controller: string
        readonly publicKeyHex: string
      }[] | undefined
      readonly authentication?: readonly string[] | undefined
    }>
  } | undefined
  readonly revocationBaseUrl?: string | undefined
}

export type VcOperationsController = {
  readonly operations: VcOperations
  connect(connection: VcConnection): void
}

export function createVcOperationsController(): VcOperationsController {
  let connection: VcConnection | undefined
  const operations: VcOperations = {
    signer: {
      fromPrivateKey: createEncSigner,
    },
    platform: {
      create: (config) => new VcPlatformClient(config),
    },
    holder: {
      create: (platform) => new VcHolder(platform),
    },
    issuer: {
      create: (platform) => new VcIssuer(platform),
    },
    verifier: {
      verifyCredential: (input) => {
        if (connection === undefined) throw new BidConfigurationError("VC verifier", "requires sdk.connect(...) first")
        return new LocalVcVerifier({
          issuerTrust: connection.issuerTrust,
          issuerPublicKeySource: connection.issuerPublicKeySource,
          issuerDocumentReader: connection.issuerDocumentReader,
          revocationBaseUrl: connection.revocationBaseUrl,
        }).verifyCredential(input)
      },
      verifyCredentialByPlatform: (input, options) => new RemoteVcVerifier(options).verifyCredential(input),
    },
  }
  return {
    operations,
    connect(value): void {
      connection = value
    },
  }
}

export function createVcOperations(): VcOperations {
  return createVcOperationsController().operations
}
