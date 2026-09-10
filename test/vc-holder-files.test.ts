import assert from "node:assert/strict"
import { readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import {
  holderCredentialPath,
  loadLatestCredential,
  type HolderCredentialFile,
  writeCredential,
} from "../sample/holder-files.js"

/**
 * 测试用 BID 凭证 ID（虚构占位，不是真实链上凭证）。文件名不能原样内插它：
 * `did:bid:` 前缀含 `:`，在 Windows 上属于非法文件名，直接拼接会导致 ENOENT。
 */
const REAL_CREDENTIAL_ID = "did:bid:efTestCredentialId0000000000000"

/** Windows 文件名不允许出现的字符：< > : " / \ | ? * 与控制字符。 */
const WINDOWS_ILLEGAL_FILENAME_CHARS = /[<>:"\u002f\\|?*\x00-\x1f]/

/** sample/output 下凭证文件名的统一前缀（与 sample/holder-files.ts 保持一致）。 */
const CREDENTIAL_FILE_PREFIX = "holder-credential-"

test("Given a real credential id, when deriving its holder credential path, then the file name is cross-platform safe and keeps .jws", () => {
  const fileName = path.basename(holderCredentialPath(REAL_CREDENTIAL_ID))

  assert.match(fileName, /\.jws$/)
  assert.doesNotMatch(fileName, WINDOWS_ILLEGAL_FILENAME_CHARS)
})

/**
 * 红契约：文件名编码必须注入（一对一）。仅非法字符不同的两个 ID 也必须得到
 * 不同的安全文件名 —— 否则 `a:b` 与 `a?b` 会一起被压成 `a_b`，后下载的凭证
 * 会静默覆盖先下载的凭证。
 */
test("Given two credential ids differing only by illegal filename characters, when deriving their holder credential paths, then they map to distinct Windows-safe file names", () => {
  const before = path.basename(holderCredentialPath("did:bid:a:b"))
  const after = path.basename(holderCredentialPath("did:bid:a?b"))

  assert.notEqual(before, after)
  assert.match(before, /\.jws$/)
  assert.match(after, /\.jws$/)
  assert.doesNotMatch(before, WINDOWS_ILLEGAL_FILENAME_CHARS)
  assert.doesNotMatch(after, WINDOWS_ILLEGAL_FILENAME_CHARS)
})

test("Given a real credential id, when writing the credential file then reading the latest one, then the flow round-trips without a platform path error", async () => {
  const credential: HolderCredentialFile = {
    credentialId: REAL_CREDENTIAL_ID,
    jws: "fixture.jws",
  }

  const outputDir = path.dirname(holderCredentialPath("placeholder"))
  const fixturePath = holderCredentialPath(REAL_CREDENTIAL_ID)

  // 隔离：把既有 holder-credential-*.jws 临时移走，保证 loadLatestCredential()
  // 只能看到本次写入的夹具文件，不会被 sample/output 里真实下载的旧文件污染。
  const movedAside: Array<{ from: string; backTo: string }> = []
  try {
    const entries = await readdir(outputDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(CREDENTIAL_FILE_PREFIX)) continue
      const from = path.join(outputDir, entry.name)
      const backTo = `${from}.isolated-for-test`
      await rename(from, backTo)
      movedAside.push({ from, backTo })
    }

    await writeCredential(credential)
    const latest = await loadLatestCredential()
    // 回读的解析结果里 credentialId 必须仍然是原始凭证 ID（未在编码/解码中丢失）。
    assert.equal(latest.credentialId, REAL_CREDENTIAL_ID)
    assert.equal(latest.jws, credential.jws)
  } finally {
    await rm(fixturePath, { force: true })
    for (const { from, backTo } of movedAside) {
      await rename(backTo, from)
    }
  }
})
