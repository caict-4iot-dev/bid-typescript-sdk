import { z } from "zod"

import { BidValidationError } from "../errors.js"
import { signerFromInput, signingMessageHex, type VcSigner } from "./vc-crypto.js"
import { type ApplyNo } from "./vc-domain.js"
import { readJwsAlgorithmFromSigningInput } from "./vc-jws.js"
import { type PlatformSession, type VcPlatformClient } from "./vc-platform.js"

const issueBlobSchema = z.object({
  payload: z.string().min(1).optional(),
  payloadId: z.string().min(1),
  bcTxBlob: z.string().min(1).optional(),
})
const revocationBlobSchema = z.object({
  blobId: z.string().min(1),
  blob: z.string().min(1),
  // 平台可能返回 txHash: null（撤销 blob 由服务端生成，不引用历史交易）。
  txHash: z.string().nullish().transform((value) => value ?? undefined),
})
const templateCreateBlobSchema = z.object({
  blobId: z.string().min(1),
  blob: z.string().min(1),
  txHash: z.string().nullish().transform((value) => value ?? undefined),
})
const templateCreateSubmitSchema = z.object({
  templateBid: z.string().min(1),
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
  /** 签发的凭证 BID（服务端 certBid），供撤销与下载使用。 */
  readonly credentialId?: string
  readonly payload?: string
  readonly bcTxBlob?: string
  readonly submitResult: unknown
}

export type RevokeInput = {
  readonly issuer: IssuerKeyInput
  readonly credentialBid: string
  readonly auditNodeAddress?: string
  readonly remark?: string
}

export type ListApplicationsInput = {
  /** 1 待审核 / 2 已签发 / 3 已拒绝；不传则查全部。 */
  readonly status?: readonly number[]
  readonly applyNo?: string
  readonly userBid?: string
  readonly pageStart: number
  readonly pageSize: number
}

export type ApplicationDetailInput = {
  readonly applyNo?: string
  readonly credentialBid?: string
  readonly lang?: string
}

export type CreateTemplateInput = {
  readonly issuer: IssuerKeyInput
  readonly name: string
  readonly industryId: string
  readonly categoryId: string
  readonly version: string
  /** 模板元数据（含凭证字段定义）；平台按 JSON 字符串存储。 */
  readonly data: string
  readonly userType: string
  readonly remark?: string
}

export type ListTemplatesInput = {
  readonly pageStart: number
  readonly pageSize: number
  readonly auditStatus?: number
  readonly templateName?: string
}

export class VcIssuer {
  constructor(private readonly platform: VcPlatformClient) {}

  /** 签发凭证：blob → 本地签名（payload 与 bcTxBlob）→ submit；链上交易由平台广播。 */
  async issue(session: PlatformSession, input: IssueInput): Promise<IssueResult> {
    const signer = this.requireSigner(session, input.issuer)
    const blob = issueBlobSchema.parse(await this.platform.post("issueBlob", {
      applyNo: input.applyNo,
      status: input.status,
      auditBid: input.issuer.bid,
      ...(input.isSel === undefined ? {} : { isSel: input.isSel }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      alg: signer.algorithm,
      ...(input.auditContent === undefined ? {} : { auditContent: input.auditContent }),
    }, true))
    if (blob.payload === undefined || blob.bcTxBlob === undefined) {
      throw new BidValidationError("issue blob", "must contain payload and bcTxBlob for signing")
    }
    // 发证方门户（OMP 网关）会把待签 payload 做 HEX 编码（65794a68... 解码后才是 base64url JWS）。
    const payload = decodeHexIfHex(blob.payload)
    // 服务端 JWS header 的 alg 存在写死 SM2 的历史缺陷（与实际签名算法无关），
    // 这里不做等值拦截；签名用的是发证方自己的密钥，算法由 keypair 决定。
    readJwsAlgorithmFromSigningInput(payload)
    const submitResult = readSubmitResult(await this.platform.post("issueSubmit", {
      auditBid: input.issuer.bid,
      payloadId: blob.payloadId,
      signPayload: await signer.sign(signingMessageHex(payload)),
      signBcTxBlob: await signer.sign(signingMessageHex(blob.bcTxBlob)),
      publicKey: signer.publicKey,
    }, true))
    return {
      payloadId: blob.payloadId,
      ...readCertBid(submitResult),
      payload,
      bcTxBlob: blob.bcTxBlob,
      submitResult,
    }
  }

  /** 撤销凭证：blob 由平台生成（按 credentialBid 定位链上记录），本地签名授权后由平台广播。 */
  async revoke(session: PlatformSession, input: RevokeInput): Promise<void> {
    const signer = this.requireSigner(session, input.issuer)
    const blob = revocationBlobSchema.parse(await this.platform.post("revocationBlob", {
      auditBid: input.issuer.bid,
      credentialBid: input.credentialBid,
      ...(input.auditNodeAddress === undefined ? {} : { auditNodeAddress: input.auditNodeAddress }),
      ...(input.remark === undefined ? {} : { remark: input.remark }),
    }, true))
    await this.platform.post("revocationSubmit", {
      blobId: blob.blobId,
      signBlob: await signer.sign(signingMessageHex(blob.blob)),
      publicKey: signer.publicKey,
    }, true)
  }

  /** 拒绝申请（不签发凭证）：status 置 3，无链上交易。 */
  async reject(session: PlatformSession, input: { readonly issuer: IssuerKeyInput; readonly applyNo: ApplyNo; readonly reason?: string }): Promise<void> {
    const signer = this.requireSigner(session, input.issuer)
    await this.platform.post("issueDisApprove", {
      applyNo: input.applyNo,
      status: 3,
      auditBid: input.issuer.bid,
      alg: signer.algorithm,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }, true)
  }

  /** 发证方查询名下申请列表（vc/list）：status=1 待审核、2 已签发、3 已拒绝。 */
  async listApplications(session: PlatformSession, input: ListApplicationsInput): Promise<unknown> {
    void session
    return this.platform.post("applyList", {
      ...(input.status === undefined ? {} : { status: [...input.status] }),
      ...(input.applyNo === undefined ? {} : { applyNo: input.applyNo }),
      ...(input.userBid === undefined ? {} : { userBid: input.userBid }),
      issuerBid: session.bid,
      pageStart: input.pageStart,
      pageSize: input.pageSize,
    }, true)
  }

  /** 申请详情（vc/detail）：content 为持证方申请时填写的表单，可透传作为签发的 auditContent。 */
  async getApplicationDetail(_session: PlatformSession, input: ApplicationDetailInput): Promise<unknown> {
    if (input.applyNo === undefined && input.credentialBid === undefined) {
      throw new BidValidationError("application detail", "requires applyNo or credentialBid")
    }
    return this.platform.post("applyDetail", {
      ...(input.applyNo === undefined ? {} : { applyNo: input.applyNo }),
      ...(input.credentialBid === undefined ? {} : { credentialBid: input.credentialBid }),
      ...(input.lang === undefined ? {} : { lang: input.lang }),
    }, true)
  }

  /** 创建模板：blob → 本地签名 → submit；返回 templateBid。需超级节点审核通过后持证方才能申请。 */
  async createTemplate(session: PlatformSession, input: CreateTemplateInput): Promise<{ readonly templateBid: string }> {
    const signer = this.requireSigner(session, input.issuer)
    const blob = templateCreateBlobSchema.parse(await this.platform.post("templateCreateBlob", {
      name: input.name,
      industryId: input.industryId,
      categoryId: input.categoryId,
      version: input.version,
      data: input.data,
      userType: input.userType,
      issuerBid: input.issuer.bid,
      ...(input.remark === undefined ? {} : { remark: input.remark }),
    }, true))
    const submitted = templateCreateSubmitSchema.parse(await this.platform.post("templateCreateSubmit", {
      blobId: blob.blobId,
      signBlob: await signer.sign(signingMessageHex(blob.blob)),
      publicKey: signer.publicKey,
    }, true))
    return { templateBid: submitted.templateBid }
  }

  /** 发证方查询名下模板列表（manage/template/list）：auditStatus 0 待审/1 通过/2 拒绝。 */
  async listTemplates(session: PlatformSession, input: ListTemplatesInput): Promise<unknown> {
    void session
    return this.platform.post("templateManageList", {
      issuerBid: session.bid,
      ...(input.auditStatus === undefined ? {} : { auditStatus: input.auditStatus }),
      ...(input.templateName === undefined ? {} : { templateName: input.templateName }),
      pageStart: input.pageStart,
      pageSize: input.pageSize,
    }, true)
  }

  /** 行业字典（vc/industry/list）：创建模板需要 industryId。 */
  async listIndustries(session: PlatformSession): Promise<unknown> {
    void session
    return this.platform.post("industryList", {}, true)
  }

  /** 凭证类别字典（vc/category/list）：创建模板需要 categoryId。 */
  async listCategories(session: PlatformSession): Promise<unknown> {
    void session
    return this.platform.post("categoryList", {}, true)
  }

  /** 签名账户必须与登录会话一致，防止用别人的 session 签自己的授权。 */
  private requireSigner(session: PlatformSession, issuer: IssuerKeyInput): VcSigner {
    const signer = signerFromInput(issuer, "issuer")
    if (signer.address !== issuer.bid) throw new BidValidationError("issuer", "signer address must match issuer bid")
    if (session.bid !== issuer.bid) throw new BidValidationError("issuer", "signer address must match the login session bid")
    return signer
  }
}

/** issueSubmit 返回 DataResp<BasicInfoRespDto>，凭证 BID 在 certBid 字段。 */
function readSubmitResult(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BidValidationError("issue submit", "must return an object")
  }
  return Object.fromEntries(Object.entries(raw))
}

/** 纯偶数长度 hex 字符串（无点号、非 base64url 字符集）按 hex 解码为原文；否则原样返回。 */
function decodeHexIfHex(value: string): string {
  if (value.includes(".") || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return value
  const decoded = Buffer.from(value, "hex").toString("utf8")
  // 解出来必须是待签 JWS（两段式）；不是则维持原值，让后续解析报出可读错误。
  return decoded.includes(".") ? decoded : value
}

function readCertBid(submitResult: Readonly<Record<string, unknown>>): { readonly credentialId?: string } {
  const certBid = submitResult["certBid"]
  return typeof certBid === "string" && certBid !== "" ? { credentialId: certBid } : {}
}
