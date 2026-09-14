# BID TypeScript SDK

星火链 BID（去中心化身份标识）TypeScript SDK，覆盖密码学、DID 文档与可验证凭证（VC）三角色（发证方、持证方、验证方）。链上操作统一经开放平台（BOP）同步完成。

```bash
npm install @caict-bif/bid-typescript-sdk
```

- 依赖会一并安装：`@caict-bif/bif-encryption`（密码学）、`@caict-bif/bop-typescript-sdk`（开放平台），无需额外配置。
- 要求 Node >= 20。
- 入口：主包 `@caict-bif/bid-typescript-sdk`（全量能力）；`@caict-bif/bid-typescript-sdk/mobile`（App 轻量核验入口，见第六节）。

## 一、快速开始

应用启动时先配置节点与平台地址，再创建 SDK 实例；密钥生成与 DID 文档构建可离线使用，写链、解析和 VC 操作前需要 `connect()`：

```ts
import { configureBidSdk, createBidSdk } from "@caict-bif/bid-typescript-sdk"

configureBidSdk({
  bopUrl: "https://你的开放平台地址",
  parserUrl: "https://你的解析服务地址/bid/",
  vcPlatformUrl: "https://你的VC钱包平台主机根地址",   // 不要包含 /server
  vcCredentialUrl: "https://你的VC凭证平台地址",        // 与钱包平台同域时可省略
  vcVerificationUrl: "https://你的VC验证服务地址",
})

const sdk = createBidSdk()
sdk.connect({
  mode: "bop",
  apiKey: "你的开放平台 API Key",
  apiSecret: "",          // 没有 API Secret 时保持空值
})
```

- 星火链域名的证书链可能不被 Node 内置 CA 信任。生产环境请通过 `NODE_EXTRA_CA_CERTS` 提供证书链；本机联调可临时设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不要在代码里默认关闭证书校验。
- 写链源账户必须在链上激活且有燃料费（星火令）余额，否则错误信息会提示去开放平台领取/激活。

## 二、密码学：公私钥与助记词

密钥算法支持 ED25519 与 SM2（国密），私钥/公钥均为星火编码格式（`priSPK...` / `b0656...`），可直接用于签名、验签与身份地址推导。

### 生成密钥对

```ts
const identity = sdk.keypair.generate()
// { privateKey: "priSPK...", publicKey: "b0656...", address: "did:bid:ef..." }
```

### 签名与验签

```ts
const signer = sdk.keypair.signer(identity.privateKey)
const signature = signer.sign("deadbeef")                 // 对 hex 消息签名
const ok = signer.verify("deadbeef", signature)           // 本地验签
```

### 助记词（HD 派生）

```ts
import * as enc from "@caict-bif/bif-encryption"
import { createEncSigner } from "@caict-bif/bid-typescript-sdk"

// 生成 12 词助记词（entropy 为 16 字节随机数的 hex）
const mnemonic = enc.generateMnemonicCode("0123456789abcdef0123456789abcdef")

// 按硬化派生路径导出私钥（ED25519 要求全硬化路径）
const privateKey = enc.privateKeyFromMnemonicCode(mnemonic, "m/44'/526'/1'/0'/0'")
const signer = createEncSigner(privateKey)
signer.address    // did:bid:ef...  同一助记词 + 同一路径推导结果恒定
```

### 密钥格式转换与 Keystore

```ts
// 星火编码 <-> 原始 hex（跨系统对接时使用）
const raw = sdk.keypair.convert.toRawPrivateKey(identity.privateKey, "ED25519")
const back = sdk.keypair.convert.toEncPrivateKey(raw.keyHex, "ED25519")

// Keystore（密码加密的私钥文件）解密，密码错误会直接报错
const privateKey = sdk.keypair.keystore.toPrivateKey(keystoreJson, password)
```

SDK 不保存助记词、私钥或密码；密钥材料由调用方妥善保管，不要提交到代码仓库。

## 三、DID：文档构建与链上操作

BID 是星火链上的 DID 标识（`did:bid:ef...`）。DID 文档（DDO）描述该身份的公钥、认证方式与服务端点，上链后可被解析。

### 构建文档

builder 按字段构建，未设置的字段自动使用默认值（`@context=["https://www.w3.org/ns/did/v1"]`、`version="1.0.0"`、`extension.ttl=86400`、`extension.type=206`、`created/updated`=当前 UTC 时间）：

```ts
const document = sdk.document
  .create(identity.address)
  .addPublicKey({
    id: `${identity.address}#key-1`,
    type: "Ed25519",
    controller: identity.address,
    publicKeyHex: identity.publicKey,
  })
  .addAuthentication(`${identity.address}#key-1`)
  .addRecovery(`${identity.address}#key-1`)
  .build()
```

- `publicKey`、`authentication`、`service` 是数组，可多次 `add*` 追加；追加 context 用 `.addContext(...)`，自定义扩展字段用 `.setExtensionField(...)`。

### 上链与解析

写链需要链上已激活、有余额的账户，私钥只在单次交易里传入；交易同步提交并等待确认：

```ts
const transaction = { privateKey: "已激活账户私钥" }

const created = await sdk.bid.create(document, transaction)
console.log(created.id)         // 交易 hash
console.log(created.transport)  // "bop"

await sdk.bid.update(document, transaction)
await sdk.bid.reAuth({ id: identity.address, authentication: [`${identity.address}#key-1`], transaction })

const resolved = await sdk.bid.resolve(identity.address)   // 读取 DID 文档
```

- `feeLimit`、`gasPrice` 有默认值（1_000_000 / 1），需要调整时在单次交易里覆盖：`{ privateKey, feeLimit: 2_000_000 }`。
- `resolve()` 读取 BID 文档：配置了 `parserUrl` 时使用解析服务，否则直接对 DDO 合约执行 `queryBid`。
- 当前合约没有删除方法，SDK 也不提供删除接口。

### 写链账户与文档权限

`update` 要求签名账户在文档 `authentication` 中；`reAuth` 要求签名账户在 `extension.recovery` 中或就是文档 id 本身。权限不符时错误信息会直接提示"当前账户无权执行该操作"。

## 四、发证方（Issuer）

发证方身份需已在平台完成注册（准入流程在 SDK 之外）。签发/撤销/建模板都会产生链上合约交易，由平台预构建（`bcTxBlob`）→ 发证方本地签名授权 → 平台广播上链；燃料费记在发证方账户上，账户需保持激活、有星火令余额。

```ts
const platform = sdk.vc.platform.create({ routes: ISSUER_PORTAL_ROUTES })
const issuer = sdk.vc.issuer.create(platform)

// 登录：两步（平台 BID 挑战登录 → 门户令牌交换，SDK 内部完成）
const session = await platform.loginAsIssuerPortal({ bid: signer.address, signer })

// 查询名下申请：status=1 待审核 / 2 已签发 / 3 已拒绝
await issuer.listApplications(session, { status: [1], pageStart: 1, pageSize: 20 })

// 申请详情（content 为持证方填写的表单，可透传为签发 auditContent）
await issuer.getApplicationDetail(session, { applyNo: "..." })

// 签发：blob → 本地签名 → submit，返回凭证 BID（certBid）
const issued = await issuer.issue(session, {
  issuer: { bid: signer.address, signer },
  applyNo,
  status: 2,
  auditContent,          // 通常透传申请详情的 content
})

// 拒绝申请（无链上交易）
await issuer.reject(session, { issuer: { bid: signer.address, signer }, applyNo })

// 创建模板（需超级节点审核通过后持证方才能申请）
await issuer.createTemplate(session, {
  issuer: { bid: signer.address, signer },
  name: "身份凭证", industryId: "A", categoryId: "socialCertification",
  version: "1.0.0", userType: "0",
  data: JSON.stringify([{ key: "name", label: "姓名", type: "2", format: "String", value: "" }]),
})
await issuer.listTemplates(session, { pageStart: 1, pageSize: 20 })   // auditStatus 0/1/2

// 撤销（从签发记录取 credentialBid）
await issuer.revoke(session, { issuer: { bid: signer.address, signer }, credentialBid: issued.credentialId! })

// 字典（建模板需要 industryId / categoryId）
await issuer.listIndustries(session)
await issuer.listCategories(session)
```

角色 CLI（真实环境完整流程）：

```bash
npm run sample:issuer -- login        # 登录自检
npm run sample:issuer -- industries   # 行业字典
npm run sample:issuer -- categories   # 凭证类别字典
npm run sample:issuer -- template --name=身份凭证 --industry-id=A --category-id=socialCertification
npm run sample:issuer -- templates    # 名下模板列表（auditStatus：0 待审/1 通过/2 拒绝）
npm run sample:issuer -- pending      # 待审核申请（拿 applyNo）
npm run sample:issuer -- approve --apply-no=<申请编号>
npm run sample:issuer -- reject --apply-no=<申请编号>
npm run sample:issuer -- issued       # 已签发列表
npm run sample:issuer -- revoke [--credential=<凭证BID>]
```

配置在 `.env.issuer`（复制自 `.env.issuer.example`）：`VC_ISSUER_PRIVATE_KEY`（发证方自己的私钥）、`VC_PLATFORM_BASE_URL`（登录主机，不含 `/server`）、`VC_CREDENTIAL_BASE_URL`（门户业务主机）。签发记录保存在 `sample/output/issuer-issuances.json` 供撤销使用。

## 五、持证方（Holder）

持证方只依赖 VC 平台 HTTP 接口（登录、推荐列表、申请、状态、下载、导出），不写链。

```ts
const platform = sdk.vc.platform.create()
const holder = sdk.vc.holder.create(platform)
const session = await platform.login({ bid: signer.address, signer })

// 查询可申请凭证（SDK 固定查询 type=2 持证方普通凭证）
await holder.listRecommendedCredentials(session, { pageStart: 1, pageSize: 20 })

// 申请：subject 用模板通用的 attributes 结构
const applyNo = await holder.applyCredential(session, {
  templateId: "did:bid:ef...",
  subject: {
    attributes: [
      { key: "name", label: "姓名", type: "2", format: "String", value: "张三" },
    ],
  },
})

// 进度（1 申请中 / 2 已通过 / 3 已拒绝；2 时返回 credentialId）
await holder.getApplicationStatus(session, applyNo)

// 下载与解析
const downloaded = await holder.downloadCredential(session, { credentialId })
const parsed = holder.parseCredential(downloaded.jws)
```

角色 CLI：

```bash
npm run sample:holder -- generate    # 生成持证方密钥并保存身份文件
npm run sample:holder -- list        # 可申请凭证列表
npm run sample:holder -- template --template-id=<模板ID>  # 查询模板字段并生成 subject 示例
npm run sample:holder -- apply --template-id=<模板ID> --subject='{...attributes...}'
npm run sample:holder -- status
npm run sample:holder -- download
npm run sample:holder -- export      # 导出标准 VC 出示信封（demo.json 同款）
```

- 配置在 `.env.holder`（复制自 `.env.holder.example`）：只需 `VC_PLATFORM_BASE_URL`。
- 申请前可先运行 `template` 查询模板详情；`apply` 也会在提交前自动查询并打印实际字段及可复制的 `--subject` 示例。不传 `--subject` 时只显示指引，不会提交申请。
- `--subject` 必须是非空 JSON 对象；Windows PowerShell 下 JSON 引号会被 npm run 剥掉，需直接执行 `node --env-file=.env.holder --import tsx sample/holder.ts apply ...`（见实战指南）。
- 身份/申请/凭证文件都在 `sample/output/`（已被 gitignore），不要提交私钥。

## 六、验证方（Verifier）

验证方独立核验凭证：读 DDO 合约取发行方公钥验签、查 IAM/TDS 合约信任名单、查询发证方平台撤销状态、校验选择性披露——不依赖平台自证。

```ts
// 方式一：SDK facade（复用 configureBidSdk + connect 配置）
const result = await sdk.vc.verifier.verifyCredential({ jws })
// { verified, checks: { format, issuerTrust, issuerSignature, validity, disclosure, revocation }, errors }

// 方式二：App 轻量入口（React Native / 浏览器，不加载写链与开放平台依赖）
import { createDirectVcVerifier } from "@caict-bif/bid-typescript-sdk/mobile"

const verifier = createDirectVcVerifier({
  directNodeUrl: "https://bif.example.com",
  vcRevocationUrl: "https://vc-issuer.example.com",
  fetcher: fetch,   // RN 传入网络层 fetch
})
const result = await verifier.verifyCredential({ jws })
```

- 撤销检查是在线 issuer-service 状态，不是独立的链上状态证明。
- 出示信封（export 输出的 JSON）会先校验外层字段与 `proof.jwt` 内 JWS payload 一致，任一字段被篡改即返回 `presentation-mismatch` 终止验证。

角色 CLI（BOP 传输）：

```bash
npm run sample:verifier-bop -- --file=sample/output/holder-presentation.json
```

配置在 `.env.verifier`（复制自 `.env.verifier.example`）：`BID_BOP_URL`、`BID_BOP_API_KEY`、`BID_BOP_API_SECRET`、`VC_REVOCATION_BASE_URL`。输出 `{ verified, checks, errors }`，验证不通过时以非零状态退出。

## 开发验证

```bash
npm run check        # typecheck + 全量单测
npm run check:vc     # VC 模块 typecheck + 测试（覆盖三角色流程，不需要真实链节点）
npm run build
```

真实环境示例：`npm run sample:issuer -- login`、`npm run sample:holder -- list`（需先填好对应 `.env.*` 凭据）。
