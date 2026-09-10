import { z } from "zod"

import { BidValidationError } from "../errors.js"
import { signerFromInput, signingMessageHex, type VcSigner } from "./vc-crypto.js"
import { type ApplyNo } from "./vc-domain.js"
import { readJwsAlgorithmFromSigningInput } from "./vc-jws.js"
import { type VcPlatformClient } from "./vc-platform.js"

const issueBlobSchema = z.object({
  payload: z.string().min(1).optional(),
  payloadId: z.string().min(1),
  bcTxBlob: z.string().min(1).optional(),
})
const revocationBlobSchema = z.object({
  blobId: z.string().min(1),
  blob: z.string().min(1),
  txHash: z.string().optional(),
})

export type IssuerKeyInput = {
  readonly bid: string
  readonly privateKey?: string
  readonly signer?: VcSigner
}

export type IssueInput = {
  readonly issuer: IssuerKeyInput
  readonly applyNo: ApplyNo
  readonly status: number
  /** 1 表示按模板/申请记录启用选择性披露，0 表示直接披露；最终以平台 DTO 约定为准。 */
  readonly isSel?: 0 | 1
  readonly reason?: string
  readonly auditContent?: string
}

export type IssueResult = {
  readonly payloadId: string
  readonly payload?: string
  readonly bcTxBlob?: string
  readonly submitResult: unknown
}

export type RevokeInput = {
  readonly issuer: IssuerKeyInput
  readonly credentialBid: string
  readonly txHash: string
  readonly blob: string
  readonly auditNodeAddress?: string
  readonly remark?: string
}

export class VcIssuer {
  constructor(private readonly platform: VcPlatformClient) {}

  async issue(input: IssueInput): Promise<IssueResult> {
    const signer = signerFromInput(input.issuer, "issuer")
    if (signer.address !== input.issuer.bid) throw new BidValidationError("issuer", "signer address must match issuer bid")
    const blob = issueBlobSchema.parse(await this.platform.post("issueBlob", {
      applyNo: input.applyNo,
      status: input.status,
      auditBid: input.issuer.bid,
      ...(input.isSel === undefined ? {} : { isSel: input.isSel }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      alg: signer.algorithm,
      ...(input.auditContent === undefined ? {} : { auditContent: input.auditContent }),
    }, false))
    if (blob.payload === undefined || blob.bcTxBlob === undefined) {
      throw new BidValidationError("issue blob", "must contain payload and bcTxBlob for signing")
    }
    const payloadAlg = readJwsAlgorithmFromSigningInput(blob.payload)
    if (payloadAlg !== signer.algorithm) {
      throw new BidValidationError("issue blob", `JWS header alg ${payloadAlg} does not match signer algorithm ${signer.algorithm}`)
    }
    const submitResult = await this.platform.post("issueSubmit", {
      auditBid: input.issuer.bid,
      payloadId: blob.payloadId,
      signPayload: await signer.sign(signingMessageHex(blob.payload)),
      signBcTxBlob: await signer.sign(signingMessageHex(blob.bcTxBlob)),
      publicKey: signer.publicKey,
    }, false)
    return {
      payloadId: blob.payloadId,
      payload: blob.payload,
      bcTxBlob: blob.bcTxBlob,
      submitResult,
    }
  }

  async revoke(input: RevokeInput): Promise<void> {
    const signer = signerFromInput(input.issuer, "issuer")
    if (signer.address !== input.issuer.bid) throw new BidValidationError("issuer", "signer address must match issuer bid")
    const blob = revocationBlobSchema.parse(await this.platform.post("revocationBlob", {
      txHash: input.txHash,
      blob: input.blob,
      auditBid: input.issuer.bid,
      credentialBid: input.credentialBid,
      ...(input.auditNodeAddress === undefined ? {} : { auditNodeAddress: input.auditNodeAddress }),
      ...(input.remark === undefined ? {} : { remark: input.remark }),
    }, false))
    await this.platform.post("revocationSubmit", {
      blobId: blob.blobId,
      signBlob: await signer.sign(signingMessageHex(blob.blob)),
      publicKey: signer.publicKey,
    }, false)
  }
}
