import { z } from "zod"

import { BidValidationError } from "../errors.js"
import { parseJws, type ParsedJws } from "./vc-jws.js"
import { parseApplyNo, vcPayloadSchema, type ApplyNo, type CredentialId, type VcPayload } from "./vc-domain.js"
import { type PlatformSession, VcPlatformClient } from "./vc-platform.js"

const applyResponseSchema = z.object({ applyNo: z.string().min(1) })
const statusResponseSchema = z.object({
  status: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  type: z.number().int().optional(),
  userBid: z.string().min(1).optional(),
})
const applicationStatusSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("1"), z.literal("2"), z.literal("3")]).transform(String)
const ownerListApplicationSchema = z.object({
  applyNo: z.string().min(1),
  status: applicationStatusSchema,
  // pending applications return credentialBid: null; normalize to absent.
  credentialBid: z.string().min(1).nullish().transform((value) => value ?? undefined),
  type: z.number().int().optional(),
})
const ownerListApplicationResponseSchema = z.object({
  page: z.object({
    pageStart: z.number().int(),
    pageSize: z.number().int(),
    pageTotal: z.number().int().nonnegative(),
  }),
  dataList: z.array(ownerListApplicationSchema),
})
const downloadedCredentialSchema = z.object({
  jws: z.string().min(1),
  vc: z.string().nullish(),
  issueBid: z.string().min(1),
  issueName: z.string().min(1),
})
const recommendedListResponseSchema = z.object({
  recommendList: z.array(z.object({
    certName: z.string(),
    icon: z.string(),
    templateId: z.string().min(1),
  })),
  page: z.object({
    pageStart: z.number().int(),
    pageSize: z.number().int(),
    pageTotal: z.number().int(),
  }),
})

export type TemplateDetailInput = {
  readonly templateId: string
  readonly lang?: string
}

/**
 * 平台凭证分类（credential_categroy.type）。
 * SDK 固定查询 type=2（持证方可申请的普通凭证）；
 * type=0 是申请成为发证方的凭证，不在持证方列表中暴露。
 */
const HOLDER_RECOMMEND_TYPE = "2"

export type RecommendListInput = {
  readonly pageStart: number
  readonly pageSize: number
}

export type RecommendedCredentialList = z.infer<typeof recommendedListResponseSchema>

export type CredentialApplicationInput = {
  readonly templateId: string
  readonly subject?: Readonly<Record<string, string | number | boolean>>
  readonly rawContent?: string
  readonly hold?: string
}

export type DownloadCredentialInput = {
  readonly credentialId: CredentialId
  readonly userBid?: string
}

export type DownloadedCredential = z.infer<typeof downloadedCredentialSchema>

export type ParsedCredential = {
  readonly jws: ParsedJws
  readonly credential: VcPayload
}

export class VcHolder {
  constructor(private readonly platform: VcPlatformClient) {}

  async getTemplate(session: PlatformSession, input: TemplateDetailInput): Promise<unknown> {
    void session
    return this.platform.post("templateDetail", {
      templateId: input.templateId,
      ...(input.lang === undefined ? {} : { lang: input.lang }),
    }, true)
  }

  async assertApplication(session: PlatformSession, input: { readonly templateId: string; readonly hold?: string }): Promise<void> {
    await this.platform.post("assert", {
      templateId: input.templateId,
      bid: session.bid,
      ...(input.hold === undefined ? {} : { hold: input.hold }),
    }, true)
  }

  async applyCredential(session: PlatformSession, input: CredentialApplicationInput): Promise<ApplyNo> {
    const content = input.rawContent ?? JSON.stringify(input.subject ?? {})
    const response = applyResponseSchema.parse(await this.platform.post("apply", {
      content,
      templateId: input.templateId,
      bid: session.bid,
      publicKey: session.publicKey,
      ...(input.hold === undefined ? {} : { hold: input.hold }),
    }, true))
    return parseApplyNo(response.applyNo)
  }

  async getApplicationStatus(session: PlatformSession, applyNo: ApplyNo): Promise<z.infer<typeof statusResponseSchema>> {
    void session
    const response = ownerListApplicationResponseSchema.parse(await this.platform.post("ownerList", {
      applyNo,
      pageStart: 1,
      pageSize: 2,
    }, true))
    const matches = response.dataList.filter((item) => item.applyNo === applyNo)
    if (response.page.pageTotal !== 1 || matches.length !== 1) {
      throw new BidValidationError("application status", "must contain exactly one matching application")
    }
    const [application] = matches
    if (application === undefined) throw new BidValidationError("application status", "must contain exactly one matching application")
    // owner-list identifies the downloadable credential as credentialBid.
    return statusResponseSchema.parse({
      status: application.status,
      ...(application.credentialBid === undefined ? {} : { credentialId: application.credentialBid }),
      ...(application.type === undefined ? {} : { type: application.type }),
    })
  }

  async listRecommendedCredentials(session: PlatformSession, input: RecommendListInput): Promise<RecommendedCredentialList> {
    void session
    return recommendedListResponseSchema.parse(await this.platform.post("recommendList", {
      type: HOLDER_RECOMMEND_TYPE,
      pageStart: input.pageStart,
      pageSize: input.pageSize,
    }, true))
  }

  async listCredentials(session: PlatformSession, input: { readonly pageStart?: number; readonly pageSize?: number; readonly issuerBid?: string; readonly status?: readonly string[] }): Promise<unknown> {
    void session
    return this.platform.post("ownerList", {
      ...(input.issuerBid === undefined ? {} : { issuerBid: input.issuerBid }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.pageStart === undefined ? {} : { pageStart: input.pageStart }),
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
    }, true)
  }

  async listPendingApplications(session: PlatformSession, input: { readonly pageStart: number; readonly pageSize: number }): Promise<unknown> {
    return this.platform.post("myPendingList", {
      applyerBid: session.bid,
      pageStart: input.pageStart,
      pageSize: input.pageSize,
    }, true)
  }

  async downloadCredential(session: PlatformSession, input: DownloadCredentialInput): Promise<DownloadedCredential> {
    return downloadedCredentialSchema.parse(await this.platform.post("download", {
      credentialId: input.credentialId,
      userBid: input.userBid ?? session.bid,
    }, true))
  }

  parseDownloadedCredential(downloaded: DownloadedCredential): ParsedCredential {
    if (downloaded.vc?.trim()) {
      let payload: unknown
      try {
        payload = JSON.parse(downloaded.vc)
      } catch {
        throw new BidValidationError("credential.vc", "must contain valid JSON")
      }
      const credential = vcPayloadSchema.safeParse(payload)
      if (!credential.success) throw new BidValidationError("credential", "downloaded vc is not a verifiable credential")
      return { jws: parseJws(downloaded.jws), credential: credential.data }
    }
    return this.parseCredential(downloaded.jws)
  }

  parseCredential(jws: string): ParsedCredential {
    const parsed = parseJws(jws)
    const credential = vcPayloadSchema.safeParse(parsed.payload)
    if (!credential.success) throw new BidValidationError("credential", "JWS payload is not a verifiable credential")
    return { jws: parsed, credential: credential.data }
  }
}
