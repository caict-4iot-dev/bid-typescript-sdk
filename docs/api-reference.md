# 公共 API 参考

本文按 `src/index.ts` 记录 `@caict-bif/bid-typescript-sdk` 当前公开 API。内容适用于 `0.1.0`，Node.js 要求 `>= 20`。

> 本文是源码仓库中的版本化参考文档。当前 `0.1.0` npm 发布包的文件白名单仅包含 `dist/` 和 `README.md`，因此安装后的 `node_modules/@caict-bif/bid-typescript-sdk/` 中不包含本文件；请在与所用版本对应的源码仓库标签或归档中查阅。若后续需要随 npm 包分发，发布前必须将 `docs/` 加入 `package.json#files` 并用 `npm pack --dry-run` 核对内容。

普通业务使用 `configureBidSdk()` 配置节点 URL，再通过 `createBidSdk()` 返回的 `sdk.*` facade 操作。合约地址、VC 平台路由、信任读取器和本地/平台验证器实现均由 SDK 内部管理。

文中的 URL、环境变量和值均为占位符。不要把私钥、keystore 密码或平台凭证写入源码和日志。

## 1. 推荐入口

```ts
import { configureBidSdk, createBidSdk, parseBidId } from "@caict-bif/bid-typescript-sdk"

configureBidSdk({
  directNodeUrl: "https://node.example.com/",
  bopUrl: "https://bop.example.com/",
  parserUrl: "https://parser.example.com/bid/",
  vcPlatformUrl: "https://wallet.example.com/", // 主机根地址，不包含 /server
  vcCredentialUrl: "https://credential.example.com/",
  vcVerificationUrl: "https://verification.example.com/",
})

const sdk = createBidSdk()
const identity = sdk.keypair.generate()
const id = parseBidId(identity.address)

const document = sdk.document
  .create(id)
  .addPublicKey({
    id: `${id}#key-1`,
    type: "Ed25519",
    controller: id,
    publicKeyHex: identity.publicKey,
  })
  .addAuthentication(`${id}#key-1`)
  .build()
```

需要写链或解析时再连接：

```ts
sdk.connect({
  mode: "bop",
  apiKey: process.env.BID_BOP_API_KEY ?? "",
  apiSecret: process.env.BID_BOP_API_SECRET ?? "",
})

const submitted = await sdk.bid.create(document, {
  privateKey: process.env.BID_SOURCE_PRIVATE_KEY ?? "",
})
```

## 2. SDK facade

### `createBidSdk`

```ts
function createBidSdk(): BidSdk
```

创建 SDK 实例。密钥生成和文档构建可以离线使用；BID 写链、解析和默认 VC 验证前必须先配置 URL 并调用 `connect()`。

### `BidSdk`

```ts
class BidSdk {
  readonly keypair: BidKeypairOperations
  readonly vc: VcOperations
  readonly document: BidDocumentOperations
  readonly bid: BidOperations

  connect(config: BidSdkConnectConfig): this
}
```

`connect()` 在当前实例上建立 direct 或 BOP 连接，并让 BID 写链、解析和 IAM/TDS 信任查询共用该连接。合约地址由 SDK 内部固定，URL 由 `configureBidSdk()` 统一提供。

### `configureBidSdk`

```ts
type BidSdkUrls = {
  readonly directNodeUrl?: string
  readonly bopUrl?: string
  readonly parserUrl?: string
  readonly vcPlatformUrl?: string
  readonly vcCredentialUrl?: string
  readonly vcVerificationUrl?: string
  readonly vcRevocationUrl?: string
}

function configureBidSdk(urls: BidSdkUrls): BidSdkUrls
```

在使用相应功能前配置所需 URL。所有已提供字段必须是绝对 URL，SDK 会统一补齐尾部 `/`：BOP 写链需要 `bopUrl`，持证方平台操作需要 `vcPlatformUrl`（填写主机根地址，不要包含 `/server`；凭证接口缺省复用该地址），平台验证需要 `vcVerificationUrl`，本地验证的撤销状态查询需要 `vcRevocationUrl`（发证方平台地址）。`parserUrl` 仅在使用解析服务读取 BID 文档时需要；本地验证直接查询 DDO 合约，不要求解析服务。该配置只保存节点地址，不保存 API Key、私钥或 session。

### `BidSdkConnectConfig`

```ts
type BidSdkConnectConfig =
  | {
      readonly mode: "direct"
      readonly timeoutMs?: number
      readonly allowInsecureTls?: boolean
    }
  | {
      readonly mode: "bop"
      readonly apiKey: string
      readonly apiSecret: string
    }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | `"direct" \| "bop"` | 是 | BID 写链传输方式 |
| `timeoutMs` | `number` | 否 | direct 请求超时 |
| `allowInsecureTls` | `boolean` | 否 | direct 测试环境 TLS 选项，生产不应开启 |
| `apiKey` | `string` | BOP 模式 | BOP API Key |
| `apiSecret` | `string` | BOP 模式 | BOP API Secret；未分配时可为空字符串 |

### `BidDocumentOperations`

```ts
interface BidDocumentOperations {
  create(id: BidId): BidDocumentBuilder
}
```

`sdk.document.create(id)` 返回已设置 id 的 builder。

### `BidOperations`

```ts
interface BidOperations {
  create(
    document: BuiltBidDocument,
    transaction: TransactionOptions,
  ): Promise<SubmittedTransaction>

  update(
    document: BuiltBidDocument,
    transaction: TransactionOptions,
  ): Promise<SubmittedTransaction>

  reAuth(input: {
    readonly id: BidId
    readonly authentication: readonly string[]
    readonly transaction: TransactionOptions
  }): Promise<SubmittedTransaction>

  resolve(
    id: BidId,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BuiltBidDocument>
}
```

行为：

- `create`、`update`、`reAuth` 需要先 `connect()`。
- `resolve` 只访问配置的解析服务，不直接查询链节点。
- 未连接时抛 `BidConfigurationError`。
- 交易构建、提交或链上执行失败时抛 `TransactionSubmissionError`。
- 解析请求和响应错误见 `BidReadError`、`BidNotFoundError`、`BidValidationError`。

## 3. BID 文档

### `createBidDocument`

```ts
function createBidDocument(): BidDocumentBuilder
```

创建未设置 id 的 builder。普通使用建议调用 `sdk.document.create(id)`。

### 文档默认值常量

```ts
const DEFAULT_DOCUMENT_CONTEXTS: readonly ["https://www.w3.org/ns/did/v1"]
const DEFAULT_DOCUMENT_VERSION: "1.0.0"
const DEFAULT_EXTENSION_TTL: 86400
const DEFAULT_EXTENSION_TYPE: 206
```

`build()` 未收到对应设置时使用这些值，并把 `created`、`updated` 设为当前 UTC ISO 时间。

### `BidDocumentBuilder`

```ts
interface BidDocumentBuilder {
  setId(id: BidId): this
  setContext(context: readonly string[]): this
  addContext(context: string): this
  setVersion(version: string): this
  setPublicKeys(publicKeys: readonly BidPublicKey[]): this
  addPublicKey(publicKey: BidPublicKey): this
  setAuthentication(authentication: readonly string[]): this
  addAuthentication(authentication: string): this
  setServices(services: readonly BidService[]): this
  addService(service: BidService): this
  setCreated(created: string): this
  setUpdated(updated: string): this
  setRecovery(recovery: readonly string[]): this
  addRecovery(recovery: string): this
  setTtl(ttl: number): this
  setDelegateSign(delegateSign: DelegateSign): this
  setExtensionType(type: number): this
  setExtensionField(key: string, value: unknown): this
  build(): BuiltBidDocument
}
```

`set*` 替换对应集合，`add*` 追加一项。`setDelegateSign()` 是协议兼容方法，不是普通业务的推荐能力。

`build()` 可能抛 `BidValidationError` 或 Zod 校验错误。它要求 id 存在、context 非空，并拒绝重复的 public key id 或 service id。

### BID 文档类型

#### `BidId` 与 `parseBidId`

```ts
type BidId = string & z.$brand<"BidId">
function parseBidId(value: string): BidId
```

接受格式 `did:bid:` 加一个或多个 ASCII 字母或数字。不符合格式时抛 Zod 校验错误。

#### `BidPublicKey`

```ts
type BidPublicKey = {
  id: string
  type: string
  controller: string
  publicKeyHex: string
}
```

四个字段都必须是非空字符串。

#### `BidService`

```ts
type BidService = {
  id: string
  type: string
  serviceEndpoint: string
  protocol?: number
  serverType?: number
  version?: string
}
```

| 字段 | 约束 |
| --- | --- |
| `id`、`type`、`serviceEndpoint` | 非空字符串 |
| `protocol`、`serverType` | 可选整数 |
| `version` | 可选非空字符串 |

#### `BidExtension`

```ts
type BidExtension = {
  recovery?: string[]
  ttl?: number
  delegateSign?: DelegateSign
  type?: number
  readonly [key: string]: unknown
}
```

`recovery` 元素必须是非空字符串，`ttl` 必须是非负安全整数，`delegateSign` 必须符合 `DelegateSign` 结构，`type` 必须是整数。额外字段允许透传。正确 wire 键为 `delegateSign`，不带尾随空格。

#### `DelegateSign`，高级兼容类型

```ts
type DelegateSign = {
  signer: string
  signatureValue: string
}
```

两个字段都必须是非空字符串。普通用户不应依赖此兼容扩展。

#### `BuiltBidDocument`

```ts
type BuiltBidDocument = {
  "@context": string[]
  version?: string
  id: BidId
  publicKey?: BidPublicKey[]
  authentication?: string[]
  extension?: BidExtension
  service?: BidService[]
  created?: string
  updated?: string
}
```

这是经过 schema 解析的品牌类型，应由 builder 生成。`@context` 至少一项且每项是 URL，时间字段必须是带时区偏移的 datetime 字符串。

## 4. 密钥和签名

### `bidKeypairOperations`

```ts
const bidKeypairOperations: BidKeypairOperations
```

与 `sdk.keypair` 是同一组能力。普通使用建议从 facade 访问。

### `BidKeypairOperations`

```ts
interface BidKeypairOperations {
  generate(chainCode?: string): BidKeyPair
  signer(privateKey: string): BidSigner
  convert: BidKeyConvertOperations
  keystore: BidKeystoreOperations
}
```

### `BidKeyPair`

```ts
type BidKeyPair = {
  readonly privateKey: string
  readonly publicKey: string
  readonly address: BidId
}
```

`generate()` 返回星火编码密钥和 BID 地址。私钥只应短暂驻留在内存中。

### `BidSigner`

```ts
interface BidSigner {
  readonly address: string
  readonly publicKey: string
  sign(messageHex: string): string
  verify(messageHex: string, signatureHex: string): boolean
}
```

消息参数是十六进制字符串。构造 signer 或签名时，底层密钥库错误会直接向外抛出。

### `KeyAlgorithm`

```ts
type KeyAlgorithm = "ED25519" | "SM2"
```

### `RawKeyResult`

```ts
type RawKeyResult = {
  readonly algorithm: KeyAlgorithm
  readonly keyHex: string
}
```

### `BidKeyConvertOperations`

```ts
interface BidKeyConvertOperations {
  toEncPrivateKey(rawPrivateKeyHex: string, algorithm: KeyAlgorithm): string
  toEncPublicKey(rawPublicKeyHex: string, algorithm: KeyAlgorithm): string
  toRawPrivateKey(encPrivateKey: string): RawKeyResult
  toRawPublicKey(encPublicKey: string): RawKeyResult
}
```

- ED25519 和 SM2 原生私钥均为 32 字节。
- ED25519 原生公钥为 32 字节。
- SM2 原生公钥为 65 字节，通常以 `04` 开头。
- 长度、编码或算法不合法时，底层加密库会抛错。

### `BidKeystoreOperations`

```ts
interface BidKeystoreOperations {
  toPrivateKey(keystoreContent: string | object, password: string): string
}
```

本地解密 keystore 并返回星火编码私钥。SDK 不保存 keystore、密码或返回的私钥。解密结果不是字符串时抛 `BidValidationError`，其他解密错误由底层库抛出。

## 5. 交易类型与确认语义

### `TransactionOptions`

```ts
type TransactionOptions = {
  readonly privateKey: string
  readonly feeLimit?: number
  readonly gasPrice?: number
  readonly amount?: number
  readonly remarks?: string
  readonly async?: boolean
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `privateKey` | 无 | 单次交易签名私钥 |
| `feeLimit` | `1_000_000` | 交易费用上限 |
| `gasPrice` | `1` | gas 单价 |
| `amount` | `0` | 合约调用 amount |
| `remarks` | 不发送 | 交易备注 |
| `async` | `false` | `true` 时提交后立即返回，不等待确认 |

### `TransactionId`

```ts
type TransactionId = string & z.$brand<"TransactionId">
```

非空交易 hash 品牌类型。

### `SubmittedTransaction`

```ts
type SubmittedTransaction = {
  readonly id: TransactionId
  readonly transport: "direct" | "bop"
  readonly confirmed: boolean
}
```

确认语义：

- 默认轮询最多 3 秒，每 500 ms 查询一次。
- 链上确认成功才返回 `confirmed: true`。
- `async: true` 提交成功后立即返回 `confirmed: false`。
- 默认模式在 3 秒内未确认，也返回 `confirmed: false`。交易可能仍在池中，需用 `id` 查询最终结果。
- 明确的提交失败或链上执行失败会抛 `TransactionSubmissionError`，不会返回 `confirmed: false` 代替错误。

## 6. BID 错误

### `BidValidationError`

```ts
class BidValidationError extends Error {
  readonly name: "BidValidationError"
  constructor(readonly field: string, readonly reason: string)
}
```

`message` 格式为 `${field}: ${reason}`。

### `BidConfigurationError`

```ts
class BidConfigurationError extends Error {
  readonly name: "BidConfigurationError"
  constructor(readonly field: string, readonly reason: string)
}
```

用于缺少网络、模式配置或平台 session 等运行配置错误。

### `BidReadError`

```ts
class BidReadError extends Error {
  readonly name: "BidReadError"
  constructor(readonly reason: string, options?: ErrorOptions)
}
```

用于 BID 解析请求、HTTP、JSON、envelope 或服务端业务错误。

### `BidNotFoundError`

```ts
class BidNotFoundError extends Error {
  readonly name: "BidNotFoundError"
  constructor(readonly id: string)
}
```

解析服务明确返回 BID 不存在时抛出。

### `TransactionSubmissionError`

```ts
class TransactionSubmissionError extends Error {
  readonly name: "TransactionSubmissionError"
  readonly hint: string

  constructor(
    readonly transport: "direct" | "bop",
    readonly reason: string,
    options?: ErrorOptions,
  )
}
```

`hint` 可能给出余额不足、账户未激活或权限不足的用户提示，未知错误时为空字符串。

### `SubmissionFailureKind`

```ts
type SubmissionFailureKind =
  | "insufficient-balance"
  | "account-not-active"
  | "permission-denied"
  | "unknown"
```

### `classifySubmissionFailure`

```ts
function classifySubmissionFailure(reason: string): SubmissionFailureKind
```

按错误文本归类提交失败。它是提示辅助函数，不应替代底层错误码判断。

### `SUBMISSION_FAILURE_HINTS`

```ts
const SUBMISSION_FAILURE_HINTS: Readonly<Record<SubmissionFailureKind, string>>
```

面向最终用户的中文提示映射。应用可按分类展示，也可直接读取 `TransactionSubmissionError.hint`。

## 7. VC facade

### `VcOperations`

```ts
type VcOperations = {
  readonly signer: {
    fromPrivateKey(privateKey: string): VcSigner
  }
  readonly platform: {
    create(config?: VcPlatformConfig): PlatformClient
  }
  readonly holder: {
    create(platform: PlatformClient): VcHolder
  }
  readonly issuer: {
    create(platform: PlatformClient): VcIssuer
  }
  readonly verifier: {
    verifyCredential(input: VerifyCredentialInput): Promise<VerificationResult>
    verifyCredentialByPlatform(
      input: PlatformVerifyCredentialInput,
      options?: PlatformVerifierOptions,
    ): Promise<VerificationResult>
  }
}
```

## 8. VC 平台客户端

平台 `server/...` 相对路由是 SDK 内部协议常量，不提供用户覆盖配置。`vcPlatformUrl` 只配置主机根地址，不要包含 `/server`。认证固定调用 `/server/bid/auth/random` 和 `/server/bid/auth`。

### `VcPlatformConfig`

```ts
type VcPlatformConfig = {
  readonly timeoutMs?: number
  readonly fetcher?: typeof fetch
  readonly shouldRetryOn?: (errorCode: number) => boolean
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `10000` | 单次请求超时 |
| `fetcher` | 全局 `fetch` | 自定义请求实现 |
| `shouldRetryOn` | 仅 `errorCode === 401` | session 请求是否重新认证并重放一次 |

### `PlatformLoginInput`

```ts
type PlatformLoginInput = {
  readonly bid: string
  readonly privateKey?: string
  readonly signer?: VcSigner
}
```

`privateKey` 与 `signer` 必须恰好提供一个。Signer 地址必须等于 `bid`。

### `PlatformSession`

```ts
type PlatformSession = {
  readonly bid: string
  readonly accessToken: string
  readonly publicKey: string
  readonly expiresIn?: number
}
```

### `PlatformApiError`

```ts
class PlatformApiError extends Error {
  readonly name: "PlatformApiError"
  constructor(readonly errorCode: number, message: string)
}
```

HTTP 错误使用 HTTP 状态码，非法 envelope 使用 `-1`，平台业务错误使用平台 `errorCode`。

`sdk.vc.platform.create()` 返回平台客户端对象，供登录及 `holder.create()`、`issuer.create()` 使用。其底层路由和通用 `post()` 属于内部实现，不作为包级公共入口。成功登录后，客户端只在内存中保留 session 和重新认证用 signer。

安全示例：

```ts
const platform = sdk.vc.platform.create()

const signer = sdk.vc.signer.fromPrivateKey(
  process.env.VC_PRIVATE_KEY ?? "",
)
const session = await platform.login({ bid: signer.address, signer })
```

## 9. 持证方 API

### 输入和结果类型

```ts
type TemplateDetailInput = {
  readonly templateId: string
  readonly lang?: string
}

type CredentialApplicationInput = {
  readonly templateId: string
  readonly subject?: Readonly<Record<string, string | number | boolean>>
  readonly rawContent?: string
  readonly hold?: string
}

type RecommendListInput = {
  readonly pageStart: number
  readonly pageSize: number
}

type DownloadCredentialInput = {
  readonly credentialId: CredentialId
  readonly userBid?: string
}

type DownloadedCredential = {
  jws: string
  vc: string
  issueBid: string
  issueName: string
}

type ParsedCredential = {
  readonly jws: ParsedJws
  readonly credential: VcPayload
}
```

`ParsedJws` 是 `parseJws()` 的返回结构，但该类型名没有从包入口导出。调用方通常直接使用 `ParsedCredential.jws` 或 `ReturnType<typeof parseJws>`。

### `VcHolder`

```ts
class VcHolder {
  constructor(platform: PlatformClient)

  getTemplate(
    session: PlatformSession,
    input: TemplateDetailInput,
  ): Promise<unknown>

  assertApplication(
    session: PlatformSession,
    input: { readonly templateId: string; readonly hold?: string },
  ): Promise<void>

  applyCredential(
    session: PlatformSession,
    input: CredentialApplicationInput,
  ): Promise<ApplyNo>

  getApplicationStatus(
    session: PlatformSession,
    applyNo: ApplyNo,
  ): Promise<{
    status: string
    credentialId?: string
    type?: number
    userBid?: string
  }>

  listRecommendedCredentials(
    session: PlatformSession,
    input: RecommendListInput,
  ): Promise<{
    recommendList: Array<{
      certName: string
      icon: string
      templateId: string
    }>
    page: {
      pageStart: number
      pageSize: number
      pageTotal: number
    }
  }>

  listCredentials(
    session: PlatformSession,
    input: {
      readonly pageStart?: number
      readonly pageSize?: number
      readonly issuerBid?: string
      readonly status?: readonly string[]
    },
  ): Promise<unknown>

  listPendingApplications(
    session: PlatformSession,
    input: { readonly pageStart: number; readonly pageSize: number },
  ): Promise<unknown>

  downloadCredential(
    session: PlatformSession,
    input: DownloadCredentialInput,
  ): Promise<DownloadedCredential>

  parseCredential(jws: string): ParsedCredential
}
```

注意：

- `getTemplate()`、`listCredentials()`、`listPendingApplications()` 返回平台数据的 `unknown` 透传，SDK 没有声明稳定 DTO。
- `listRecommendedCredentials()` 固定查询持证方普通凭证分类 `type=2`，调用方只提供分页参数。
- `applyCredential()` 优先发送 `rawContent`。未提供时发送 `JSON.stringify(subject ?? {})`。
- `getApplicationStatus()` 调用需要登录的 `/server/credential/owner/list`，请求固定为 `{ applyNo, pageStart: 1, pageSize: 2 }`。持证方身份由 access token 确定，SDK 再按 `applyNo` 精确过滤，并要求分页总数和匹配数都恰好为 1；无匹配或多条匹配均抛 `BidValidationError`。状态 `1/2/3` 分别表示申请中、已通过、已拒绝。
- owner list 行中的 `credentialBid` 映射为 `getApplicationStatus()` 返回的 `credentialId`，可直接传给 `downloadCredential()`。旧 `/server/credential/status` 未实现，当前状态查询不使用该路由。
- `downloadCredential()` 的 `userBid` 默认使用 session 中的 bid。
- `parseCredential()` 只做本地 JWS 与 VC payload 解析，不代表签名、信任或撤销验证通过。

## 10. 发证方 API

### `IssuerKeyInput`

```ts
type IssuerKeyInput = {
  readonly bid: string
  readonly privateKey?: string
  readonly signer?: VcSigner
}
```

私钥与 signer 必须恰好提供一个，且 signer 地址必须等于 `bid`。

### `IssueInput`

```ts
type IssueInput = {
  readonly issuer: IssuerKeyInput
  readonly applyNo: ApplyNo
  readonly status: number
  readonly isSel?: 0 | 1
  readonly reason?: string
  readonly auditContent?: string
}
```

`isSel` 的 `1` 表示按模板或申请记录启用选择性披露，`0` 表示直接披露，最终含义仍以平台协议为准。

### `IssueResult`

```ts
type IssueResult = {
  readonly payloadId: string
  readonly payload?: string
  readonly bcTxBlob?: string
  readonly submitResult: unknown
}
```

`submitResult` 是平台签发提交结果的未知透传值，没有公开 DTO 保证。

### `RevokeInput`

```ts
type RevokeInput = {
  readonly issuer: IssuerKeyInput
  readonly credentialBid: string
  readonly txHash: string
  readonly blob: string
  readonly auditNodeAddress?: string
  readonly remark?: string
}
```

### `VcIssuer`

```ts
class VcIssuer {
  constructor(platform: PlatformClient)
  issue(input: IssueInput): Promise<IssueResult>
  revoke(input: RevokeInput): Promise<void>
}
```

`issue()` 请求平台生成 payload 和链交易 blob，在本地分别签名后提交。平台返回的 JWS 算法必须与 signer 算法一致，否则抛 `BidValidationError`。`revoke()` 请求撤销 blob、本地签名并提交，不负责查询最终撤销状态。

## 11. VC 签名器，高级 API

### `VcSigningAlgorithm`

```ts
type VcSigningAlgorithm = "ED25519" | "SM2"
```

### `VcSigner`

```ts
interface VcSigner {
  readonly address: BidId
  readonly publicKey: string
  readonly algorithm: VcSigningAlgorithm
  sign(messageHex: string): string | Promise<string>
}
```

允许同步软件签名器或异步硬件签名器。

### `createEncSigner`

```ts
function createEncSigner(privateKey: string): VcSigner
```

从星火编码私钥创建软件 signer。普通使用可调用 `sdk.vc.signer.fromPrivateKey()`。

### `algorithmFromPublicKey`

```ts
function algorithmFromPublicKey(publicKey: string): VcSigningAlgorithm
```

读取星火编码公钥算法。不支持的算法抛 `BidValidationError`，非法编码可能由底层加密库抛错。

## 12. 凭证验证

### 配置和输入

```ts
type VerifyCredentialInput = {
  readonly jws: string
  readonly issuerPublicKeys?: readonly string[]
}

type PlatformVerifierOptions = {
  readonly apiKey?: string
  readonly apiKeyHeader?: string
  readonly timeoutMs?: number
  readonly fetcher?: typeof fetch
}

type PlatformVerifyCredentialInput = {
  readonly jws: string
  readonly fileName?: string
}
```

平台验证固定调用 `/credential/verification`，超时默认 10 秒。提供 `apiKey` 时必须同时提供 `apiKeyHeader`，否则抛 `BidValidationError`。

### 默认验证

```ts
sdk.vc.verifier.verifyCredential(
  input: VerifyCredentialInput,
): Promise<VerificationResult>
```

这是默认验证入口，在 SDK 内执行 JWS/VC 格式、发行方信任、有效期、可选发行方签名和选择性披露检查。发行方信任自动复用 `sdk.connect()` 的连接；未连接时抛 `BidConfigurationError`。撤销状态和 holder proof 当前仍为 `skipped`。

IAM/TDS 查询规则与 Java SDK 一致：先读取固定 IAM 合约的 `admins` metadata，再读取固定 TDS 合约的 `issuer_<issuerBid>` metadata。合约地址和读取器是内部实现，用户不配置。

### 主动调用平台验证

```ts
sdk.vc.verifier.verifyCredentialByPlatform(
  input: PlatformVerifyCredentialInput,
  options?: PlatformVerifierOptions,
): Promise<VerificationResult>
```

只有用户显式调用该方法时才请求平台验证服务。VC 必须包含 `validBefore`；请求失败、响应格式错误和平台业务失败都转换为 `VerificationResult`，不会自动切换到默认验证。

### `VerificationChecks`

```ts
type VerificationChecks = {
  readonly format: "passed" | "failed" | "skipped"
  readonly issuerTrust: "passed" | "failed" | "skipped"
  readonly issuerSignature: "passed" | "failed" | "skipped"
  readonly validity: "passed" | "failed" | "skipped"
  readonly disclosure: "passed" | "failed" | "skipped"
  readonly revocation: "passed" | "failed" | "skipped"
}
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `passed` | SDK 实际执行并通过 |
| `failed` | SDK 实际执行但失败 |
| `skipped` | 当前模式没有执行，不能视为通过 |

`holderSignature` 检查已被移除：SDK 默认验证发行方签名，不验证持证方 proof。

### `VerificationError`

```ts
type VerificationError = {
  readonly code: string
  readonly message: string
  readonly field?: string
}
```

`errors` 既包含失败原因，也可能包含“未提供公钥”“撤销未检查”等跳过说明。本地 issuer 信任为强制检查，不再产生“信任未检查”。

### `VerificationResult`

```ts
type VerificationResult = {
  readonly verified: boolean
  readonly checks: VerificationChecks
  readonly errors: readonly VerificationError[]
  readonly raw?: unknown
}
```

`raw` 是平台验证服务数据的未知透传值。默认验证通常不包含该字段。

`verified` 代表完整验证结论。它要求格式、发行方信任、发行方签名、有效期和撤销都为 `passed`，且披露不能为 `failed`。本地验证会解析 issuer DID（直读 DDO 合约 `queryBid`）、查询 IAM/TDS 信任，并通过 `vcRevocationUrl`（发证方平台地址）查询撤销状态；远程模式仍跳过披露和撤销，所以结果通常为 `false`。

正确读取方式：

```ts
const result = await sdk.vc.verifier.verifyCredential({
  jws,
})

if (result.checks.issuerSignature === "failed") {
  throw new Error("发行方签名校验失败")
}

if (result.checks.revocation === "failed") {
  throw new Error("撤销状态校验失败")
}
```

### `VcPayload`

```ts
type VcPayload = {
  "@context": string[]
  id: string
  type: string[]
  issuer: string
  issuanceDate: string
  templateId?: string
  validBefore?: string
  credentialSubject: { id: string; [key: string]: unknown }
  revocationId?: string
  parseType?: string
  [key: string]: unknown
}
```

`issuer` 必须符合 BID 格式。schema 允许额外字段透传。

### `VpEnvelope`

```ts
type VpEnvelope = {
  "@context": string[]
  type: string[]
  credentialRequest: { jws: string }
  credentialParse: Array<{ parseType: string; format?: string }>
  verifiableCredential: Array<{
    jws?: string
    "@id"?: string
    [key: string]: unknown
  }>
  proofs?: { composeType?: string; [key: string]: unknown }
  [key: string]: unknown
}
```

### `PlatformEnvelope`

```ts
type PlatformEnvelope = {
  errorCode: number
  message: string
  data?: unknown
  [key: string]: unknown
}
```

`data` 明确为 `unknown`。只有具体 API 另有 schema 时才能当成已知 DTO。

## 13. VC 品牌值和 schema

### 品牌类型

```ts
type CredentialId = string & z.$brand<"CredentialId">
type TemplateId = string & z.$brand<"TemplateId">
type ApplyNo = string & z.$brand<"ApplyNo">
type CredentialJws = string & z.$brand<"CredentialJws">
```

四种类型都要求非空字符串。

### 解析函数

```ts
function parseCredentialId(value: string): CredentialId
function parseTemplateId(value: string): TemplateId
function parseApplyNo(value: string): ApplyNo
```

空字符串会抛 Zod 校验错误。

### 公共 schema

```ts
const vcPayloadSchema: z.ZodObject<...>
const vpEnvelopeSchema: z.ZodObject<...>
```

两者可用于应用边界的 `parse()` 或 `safeParse()`。schema 均允许协议扩展字段透传。

## 14. JWS 工具，高级 API

### `parseJws`

```ts
function parseJws(value: string): {
  readonly headerPart: string
  readonly payloadPart: string
  readonly signaturePart: string
  readonly header: unknown
  readonly payload: unknown
}
```

要求正好三段，并把 header、payload 作为 base64url JSON 解码。格式错误抛 `BidValidationError`。

### `signingInputHex`

```ts
function signingInputHex(jws: {
  readonly headerPart: string
  readonly payloadPart: string
}): string
```

返回 `headerPart.payloadPart` 的 UTF-8 十六进制字符串。

### `verifyJwsWithKey`

```ts
function verifyJwsWithKey(
  jws: ReturnType<typeof parseJws>,
  publicKey: string,
): boolean
```

先比较 JWS header 算法和公钥算法，再调用底层验签。算法不匹配返回 `false`，非法 header 或公钥可能抛错。

### `assembleJws`

```ts
function assembleJws(payloadNeedSign: string, signatureHex: string): string
```

`payloadNeedSign` 必须正好包含 header 和 payload 两段。函数把十六进制签名转成 base64url 后组装完整 JWS。

### `encodeJsonPart`

```ts
function encodeJsonPart(value: unknown): string
```

使用 `JSON.stringify()` 后转 UTF-8 base64url。它不是 canonical JSON 编码；选择性披露请使用 `encodeCanonicalJson()`。

## 15. 选择性披露工具，高级 API

### 类型

```ts
type SelectiveDisclosureField = {
  readonly value?: string
  readonly salt?: string
  readonly hash: string
}

type SelectiveDisclosureProfile = {
  readonly signingAlgorithm: VcSigningAlgorithm
  readonly parseType: "sel-disclose-SM2" | "sel-disclose-ED25519"
  readonly hashAlgorithm: "SM3" | "SHA-256"
}

type SelectiveDisclosureResult = {
  readonly valid: boolean
  readonly disclosedFields: readonly string[]
}

type SelectiveDisclosureSignInput = {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signer: VcSigner
  readonly saltFactory?: () => string
}
```

### `selectiveDisclosureProfile`

```ts
function selectiveDisclosureProfile(
  algorithm: VcSigningAlgorithm,
): SelectiveDisclosureProfile
```

| 算法 | parseType | hash |
| --- | --- | --- |
| `SM2` | `sel-disclose-SM2` | `SM3` |
| `ED25519` | `sel-disclose-ED25519` | `SHA-256` |

### `signSelectiveDisclosure`

```ts
function signSelectiveDisclosure(
  input: SelectiveDisclosureSignInput,
): Promise<string>
```

把 `credentialSubject.id` 之外的字段转成披露对象，并对只含 hash 的 canonical payload 签名。自定义 `saltFactory` 主要用于可重复测试，生产应使用不可预测且满足业务安全要求的盐来源。

### `createSelectiveDisclosurePresentation`

```ts
function createSelectiveDisclosurePresentation(
  jws: string,
  disclose: readonly string[],
): string
```

为指定字段保留 `value`、`salt`、`hash`，其他 subject 字段只保留 `hash`。输入必须是符合选择性披露结构的 JWS。

### `verifySelectiveDisclosure`

```ts
function verifySelectiveDisclosure(
  jws: ReturnType<typeof parseJws>,
  publicKey?: string,
): SelectiveDisclosureResult
```

检查已披露字段的 `value + salt` 承诺。提供公钥时还检查 hash-only payload 签名。未提供公钥时，`valid: true` 只代表披露 hash 结构有效，不代表发行方签名已验证。

### `verifyHashOnlySignature`

```ts
function verifyHashOnlySignature(
  jws: ReturnType<typeof parseJws>,
  publicKey: string,
): boolean
```

移除披露秘密后重建 canonical signing input，并验证发行方签名。

### `encodeCanonicalJson`

```ts
function encodeCanonicalJson(value: unknown): string
```

按 canonical JSON 序列化，再转 UTF-8 base64url。无法 canonicalize 时抛 `BidValidationError`。

## 16. 已知限制

- 没有 BID 删除 API。
- `resolve()` 只读解析服务，解析索引可能晚于链上确认。
- 交易公共返回值只区分已确认成功和未确认。`confirmed: false` 不是失败证明。
- 交易确认窗口和轮询间隔没有公共配置项。
- `BidSdkConnectConfig` 的嵌套配置类型不能从包入口单独导入，只能结构化配置。
- 若干 VC 平台方法和 `IssueResult.submitResult` 返回 `unknown`，SDK 不保证平台业务 DTO。
- 本地验证已实现 direct/BOP 的 IAM/TDS metadata 信任查询；真实环境需要配置节点或 BOP 连接及 IAM/TDS 合约地址。
- 本地验证仍未实现撤销状态和 holder proof。
- 远程验证不暴露撤销状态，也不自动降级到本地验证。
- `VerificationResult.verified` 是完整验证结论。检查项被跳过时通常为 `false`。
- 高级 JWS 与选择性披露函数面向协议互操作，普通业务优先使用 `sdk.vc` 的角色和验证器 facade。

## 17. 完整导出索引

以下清单与当前 `src/index.ts` 对齐。

### 值、函数和类

| 导出 | 分类 |
| --- | --- |
| `createBidSdk` | 推荐 facade 工厂 |
| `BidSdk` | facade 类 |
| `configureBidSdk` | 全局节点 URL 配置 |
| `createBidDocument` | BID builder 工厂 |
| `DEFAULT_DOCUMENT_CONTEXTS` | BID 默认常量 |
| `DEFAULT_DOCUMENT_VERSION` | BID 默认常量 |
| `DEFAULT_EXTENSION_TTL` | BID 默认常量 |
| `DEFAULT_EXTENSION_TYPE` | BID 默认常量 |
| `bidKeypairOperations` | 密钥操作对象 |
| `BidConfigurationError` | 错误类 |
| `BidNotFoundError` | 错误类 |
| `BidReadError` | 错误类 |
| `BidValidationError` | 错误类 |
| `TransactionSubmissionError` | 错误类 |
| `classifySubmissionFailure` | 错误分类函数 |
| `SUBMISSION_FAILURE_HINTS` | 错误提示映射 |
| `VcHolder` | 高级角色类 |
| `VcIssuer` | 高级角色类 |
| `PlatformApiError` | VC 平台错误类 |
| `createEncSigner` | 高级 signer 工厂 |
| `algorithmFromPublicKey` | 高级算法识别函数 |
| `assembleJws` | 高级 JWS 工具 |
| `encodeJsonPart` | 高级 JWS 工具 |
| `parseJws` | 高级 JWS 工具 |
| `signingInputHex` | 高级 JWS 工具 |
| `verifyJwsWithKey` | 高级 JWS 工具 |
| `createSelectiveDisclosurePresentation` | 高级披露工具 |
| `encodeCanonicalJson` | 高级披露工具 |
| `signSelectiveDisclosure` | 高级披露工具 |
| `verifyHashOnlySignature` | 高级披露工具 |
| `verifySelectiveDisclosure` | 高级披露工具 |
| `selectiveDisclosureProfile` | 高级披露配置函数 |
| `parseApplyNo` | VC 品牌值解析 |
| `parseCredentialId` | VC 品牌值解析 |
| `parseTemplateId` | VC 品牌值解析 |
| `vcPayloadSchema` | VC schema |
| `vpEnvelopeSchema` | VP schema |
| `parseBidId` | BID 品牌值解析 |

### 类型和接口

| 导出 | 分类 |
| --- | --- |
| `BidSdkConnectConfig` | SDK 连接配置 |
| `BidSdkUrls` | 全局节点 URL 配置 |
| `BidDocumentOperations` | facade 文档接口 |
| `BidOperations` | facade BID 接口 |
| `BidDocumentBuilder` | BID builder |
| `BidKeyPair` | 密钥结果 |
| `BidKeyConvertOperations` | 密钥转换接口 |
| `BidKeypairOperations` | 密钥 facade |
| `BidKeystoreOperations` | keystore 接口 |
| `BidSigner` | BID signer |
| `KeyAlgorithm` | BID 密钥算法 |
| `RawKeyResult` | 原生密钥结果 |
| `SubmissionFailureKind` | 提交错误分类 |
| `VcOperations` | VC facade |
| `CredentialApplicationInput` | 持证方输入 |
| `DownloadCredentialInput` | 持证方输入 |
| `DownloadedCredential` | 下载结果 |
| `ParsedCredential` | 本地解析结果 |
| `TemplateDetailInput` | 模板查询输入 |
| `IssueInput` | 签发输入 |
| `IssueResult` | 签发结果 |
| `IssuerKeyInput` | 发证方 signer 输入 |
| `RevokeInput` | 撤销输入 |
| `PlatformLoginInput` | 平台登录输入 |
| `PlatformSession` | 平台 session |
| `VcPlatformConfig` | 平台客户端配置 |
| `VerifyCredentialInput` | 默认凭证验证输入 |
| `PlatformVerifyCredentialInput` | 平台验证输入 |
| `PlatformVerifierOptions` | 平台验证选项 |
| `VcSigner` | VC signer |
| `VcSigningAlgorithm` | VC 签名算法 |
| `SelectiveDisclosureField` | 披露字段 |
| `SelectiveDisclosureProfile` | 披露 profile |
| `SelectiveDisclosureResult` | 披露校验结果 |
| `SelectiveDisclosureSignInput` | 披露签名输入 |
| `ApplyNo` | 申请编号品牌类型 |
| `CredentialId` | 凭证 ID 品牌类型 |
| `CredentialJws` | JWS 品牌类型 |
| `PlatformEnvelope` | 平台基础 envelope |
| `TemplateId` | 模板 ID 品牌类型 |
| `VerificationChecks` | 验证检查明细 |
| `VerificationError` | 验证问题项 |
| `VerificationResult` | 验证结果 |
| `VcPayload` | VC payload |
| `VpEnvelope` | VP envelope |
| `BidExtension` | BID 扩展 |
| `BidId` | BID 品牌类型 |
| `BidPublicKey` | BID 公钥项 |
| `BidService` | BID 服务项 |
| `BuiltBidDocument` | 已构建 BID 文档 |
| `DelegateSign` | 高级兼容类型 |
| `SubmittedTransaction` | 交易提交结果 |
| `TransactionId` | 交易 ID 品牌类型 |
| `TransactionOptions` | 单次交易选项 |
