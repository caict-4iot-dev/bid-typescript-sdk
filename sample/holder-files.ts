import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type HolderIdentityFile = {
  readonly bid: string
  readonly publicKey: string
  readonly privateKey: string
  readonly createdAt: string
}

export type HolderApplicationFile = {
  readonly applyNo: string
  readonly templateId: string
  readonly hold: number
  readonly createdAt: string
}

export type HolderCredentialFile = {
  readonly credentialId: string
  readonly jws: string
}

/**
 * 对外出示用的标准 VC 信封（与平台钱包/插件导出的 demo.json 同款）：
 * proof.jwt 为三段式 compact JWS，其余字段是 VC payload 的公开部分。
 */
export type HolderPresentationFile = {
  readonly "@context": readonly string[]
  readonly credentialSubject: Record<string, unknown>
  readonly issuer: { readonly id: string }
  readonly validBefore?: string
  readonly type: readonly string[]
  readonly issuanceDate: string
  readonly proof: {
    readonly type: "JwtProof2020"
    readonly jwt: string
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url))

export const holderIdentityPath = path.join(currentDir, "output", "holder-identity.json")
export const holderApplicationPath = path.join(currentDir, "output", "holder-application.json")
export const holderPresentationPath = path.join(currentDir, "output", "holder-presentation.json")

/** 文件名安全字符集：保守的 ASCII 子集。集合外的字符不会原样进入文件名。 */
const SAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]/gu

/** 集合外字符按 UTF-8 字节百分号编码（`%HH`）；字面 `%` 也会编码成 `%25`，编码是一对一的。 */
function encodeCredentialIdForFilename(credentialId: string): string {
  return credentialId.replace(SAFE_FILENAME_CHARS, (char) =>
    [...new TextEncoder().encode(char)]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  )
}

function credentialFileName(credentialId: string): string {
  return `holder-credential-${encodeCredentialIdForFilename(credentialId)}.jws`
}

export function holderCredentialPath(credentialId: string): string {
  return path.join(currentDir, "output", credentialFileName(credentialId))
}

export async function ensureOutputDir(): Promise<void> {
  await mkdir(path.join(currentDir, "output"), { recursive: true })
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<string> {
  await ensureOutputDir()
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  return filePath
}

async function writeTextFile(filePath: string, value: string): Promise<string> {
  await ensureOutputDir()
  await writeFile(filePath, `${value.trim()}\n`, "utf8")
  return filePath
}

async function readTextFile(filePath: string): Promise<string> {
  return (await readFile(filePath, "utf8")).trim()
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8")
  return JSON.parse(raw) as T
}

export async function writeIdentity(identity: HolderIdentityFile): Promise<string> {
  return writeJsonFile(holderIdentityPath, identity)
}

export async function loadIdentity(): Promise<HolderIdentityFile> {
  return readJsonFile<HolderIdentityFile>(holderIdentityPath)
}

export async function writeApplication(application: HolderApplicationFile): Promise<string> {
  return writeJsonFile(holderApplicationPath, application)
}

export async function loadApplication(): Promise<HolderApplicationFile> {
  return readJsonFile<HolderApplicationFile>(holderApplicationPath)
}

export async function writeCredential(credential: HolderCredentialFile): Promise<string> {
  return writeTextFile(holderCredentialPath(credential.credentialId), credential.jws)
}

export async function writePresentation(presentation: HolderPresentationFile): Promise<string> {
  return writeJsonFile(holderPresentationPath, presentation)
}

export async function loadLatestCredential(): Promise<HolderCredentialFile> {
  const outputDir = path.join(currentDir, "output")
  const entries = await readdir(outputDir, { withFileTypes: true })
  const credentialFiles: Array<{ filePath: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("holder-credential-") || !entry.name.endsWith(".jws")) continue
    const filePath = path.join(outputDir, entry.name)
    const entryStat = await stat(filePath)
    credentialFiles.push({ filePath, mtimeMs: entryStat.mtimeMs })
  }
  credentialFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = credentialFiles[0]
  if (latest === undefined) throw new Error("output 目录没有已下载的凭证文件，请先运行 download")
  const fileName = path.basename(latest.filePath)
  const encodedCredentialId = fileName.slice("holder-credential-".length, -".jws".length)
  return {
    credentialId: decodeURIComponent(encodedCredentialId),
    jws: await readTextFile(latest.filePath),
  }
}
