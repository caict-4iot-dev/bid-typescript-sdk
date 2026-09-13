import path from "node:path"
import { fileURLToPath } from "node:url"

import { ensureOutputDir, readJsonFile, writeJsonFile } from "./holder-files.js"

/**
 * 签发记录：approve 成功后保存，revoke 时读取。
 * credentialBid 来自平台 issueSubmit 返回的 certBid；撤销只需要它（txHash/blob 由平台生成）。
 */
export type IssuerIssuanceFile = {
  readonly applyNo: string
  readonly credentialBid: string
  readonly payloadId: string
  readonly createdAt: string
}

/** 模板创建记录：createTemplate 成功后保存，供后续 templates 查询与持证方申请使用。 */
export type IssuerTemplateFile = {
  readonly templateBid: string
  readonly name: string
  readonly createdAt: string
}

const currentDir = path.dirname(fileURLToPath(import.meta.url))

export const issuerIssuancePath = path.join(currentDir, "output", "issuer-issuances.json")
export const issuerTemplatePath = path.join(currentDir, "output", "issuer-template.json")

export async function appendIssuance(issuance: IssuerIssuanceFile): Promise<string> {
  await ensureOutputDir()
  const existing = await readJsonFile<IssuerIssuanceFile[]>(issuerIssuancePath).catch(() => [] as IssuerIssuanceFile[])
  const merged = [...existing.filter((item) => item.credentialBid !== issuance.credentialBid), issuance]
  return writeJsonFile(issuerIssuancePath, merged)
}

export async function loadIssuances(): Promise<IssuerIssuanceFile[]> {
  return readJsonFile<IssuerIssuanceFile[]>(issuerIssuancePath).catch(() => [] as IssuerIssuanceFile[])
}

export async function loadIssuanceByCredential(credentialBid: string): Promise<IssuerIssuanceFile | undefined> {
  const issuances = await loadIssuances()
  return issuances.find((item) => item.credentialBid === credentialBid)
}

export async function writeTemplate(template: IssuerTemplateFile): Promise<string> {
  return writeJsonFile(issuerTemplatePath, template)
}
