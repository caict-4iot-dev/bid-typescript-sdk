# BID TypeScript SDK

星火链 BID SDK。应用启动时先用 `configureBidSdk()` 配置当前节点 URL；`createBidSdk()` 得到 SDK 实例，
生成密钥和构建文档可离线使用，写链、解析和本地 VC 验证前调用 `sdk.connect(...)`。

```ts
import { configureBidSdk, createBidSdk } from "@caict-bif/bid-typescript-sdk"

configureBidSdk({
  bopUrl: "https://你的开放平台地址",
  parserUrl: "https://你的解析服务地址/bid/",
  vcPlatformUrl: "https://你的VC钱包平台主机根地址", // 不要包含 /server
  vcCredentialUrl: "https://你的VC凭证平台地址",
  vcVerificationUrl: "https://你的VC验证服务地址",
})

const sdk = createBidSdk()
sdk.connect({
  mode: "bop",
  apiKey: "你的开放平台 API Key",
  apiSecret: "",
})
```

完整示例见 `sample/usage.ts`，一个示例通过参数选择直连或开放平台：

```bash
npm run sample -- bop-sync
npm run sample -- bop-async
```

## 在其他项目中通过 npm 使用

```bash
npm install @caict-bif/bid-typescript-sdk
```

- 依赖会一并安装：`@caict-bif/bif-encryption`（密钥）、`@caict-bif/bif-typescript-sdk`（直连链节点）、`@caict-bif/bop-typescript-sdk`（开放平台），无需额外配置。
- 要求 Node >= 20。

最小可用代码：

```ts
import { configureBidSdk, createBidSdk } from "@caict-bif/bid-typescript-sdk"

configureBidSdk({
  bopUrl: "https://你的开放平台地址",
  parserUrl: "https://你的解析服务地址/bid/",
  vcPlatformUrl: "https://你的VC钱包平台主机根地址", // 不要包含 /server
  vcCredentialUrl: "https://你的VC凭证平台地址",
  vcVerificationUrl: "https://你的VC验证服务地址",
})

const sdk = createBidSdk()
sdk.connect({
  mode: "bop",
  apiKey: "你的开放平台 API Key",
  apiSecret: "",
})

const identity = sdk.keypair.generate()
const document = sdk.document
  .create(identity.address)
  .addAuthentication(`${identity.address}#key-1`)
  .build()

// 写链账户需要是链上已激活、有余额的账户；异步模式提交后立即返回 hash。
const created = await sdk.bid.create(document, { privateKey: "已激活账户私钥" })
console.log(created) // { id: 交易hash, transport: "bop", confirmed: true }

// 等待解析系统索引后读取文档。
const resolved = await sdk.bid.resolve(identity.address)
```

常见提醒：

- 星火链域名的证书链可能不被 Node 内置 CA 信任。生产环境请通过
  `NODE_EXTRA_CA_CERTS` 提供证书链；本机联调可临时 `NODE_TLS_REJECT_UNAUTHORIZED=0`，
  不要在代码里默认关闭证书校验。
- 写链源账户必须在链上激活且有燃料费（星火令）余额，否则错误信息会提示去开放平台
  领取/激活。
- `update`、`reAuth` 需要签名账户对文档有权限，详见下方“写链账户与文档权限”。

## 离线使用

离线 SDK 不依赖任何网络配置：

```ts
const sdk = createBidSdk()

const identity = sdk.keypair.generate()          // 生成 BID 地址与公私钥
const signer = sdk.keypair.signer(identity.privateKey)
const signature = signer.sign("deadbeef")        // 签名
const verified = signer.verify("deadbeef", signature)  // 验签

const document = sdk.document.create(identity.address) // 开始构建文档
```

## 构建文档

builder 按字段构建，未设置的字段自动使用默认值：

| 字段 | 默认值 |
| --- | --- |
| `@context` | `["https://www.w3.org/ns/did/v1"]` |
| `version` | `1.0.0` |
| `created` / `updated` | 当前时间（UTC） |
| `extension.ttl` / `extension.type` | `86400` / `206` |

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

- `publicKey`、`authentication`、`service` 是数组，可多次 `add*` 追加。
- 追加 context：`.addContext("https://example.com/extra")`。
- 给 `extension` 加自定义字段：`.setExtensionField("customField", { any: "value" })`。

## 写链与查询

写链需要有一个链上已激活、有余额的账户，私钥只在单次交易里传入：

```ts
const transaction = { privateKey: identity.privateKey }

const created = await sdk.bid.create(document, transaction)
console.log(created.id)         // 交易 hash
console.log(created.transport)  // "direct" 或 "bop"

await sdk.bid.update(document, transaction)
await sdk.bid.reAuth({
  id: identity.address,
  authentication: [`${identity.address}#key-1`],
  transaction,
})

const resolved = await sdk.bid.resolve(identity.address)
```

`feeLimit`、`gasPrice` 有默认值（1_000_000 / 1），需要调整时在单次交易里覆盖即可：

```ts
await sdk.bid.create(document, { privateKey: identity.privateKey, feeLimit: 2_000_000 })
```

- `resolve()` 读取 BID 文档：配置了 `parserUrl` 时使用解析服务，否则直接对 DDO 合约执行 `queryBid`。
- 星火令不足或账户未激活时，错误信息会提示去开放平台领取/激活。
- 当前合约没有删除方法，SDK 也不提供删除接口。

### 写链账户与文档权限

`document.id`、`authentication`、`recovery` 里的地址对应“文档身份”。`update`、`reAuth`
交易的签名账户必须已有相应权限，否则被合约拒绝：

- `update`：签名账户在文档 `authentication` 中。
- `reAuth`：签名账户在文档 `extension.recovery` 中，或签名账户就是文档 id 本身。

例如文档用私钥 A 生成，之后想用私钥 B 执行 `update`/`reAuth`，B 的地址不在
`authentication`/`recovery` 里就会被拒绝。发生这类拒绝时，错误信息会直接提示
“当前账户无权执行该操作”。

## 高级扩展

普通使用只需要 `createBidSdk()`。写链（直连/开放平台）与解析读取在 SDK 内部按模块
组织，后续接入 VC 时沿用同一套结构扩展，不会改变上述用法。

## 可验证凭证（VC）

`sdk.vc` 是现有 BID SDK 的附加能力，已有 `sdk.keypair`、`sdk.document`、`sdk.bid` 和 `sdk.connect()` 的行为不变。它当前覆盖：

```text
持证方：BID 登录、查询推荐凭证列表、查询模板、申请凭证、下载凭证、完整/选择性披露出示
发证方：签发 Blob → 本地签名 → Submit、撤销 Blob → 本地签名 → Submit
验证方：本地 JWS 结构/有效期/issuer DID 签名、IAM/TDS 信任和发证方平台撤销检查，或远程跨境核验
```

### 持证方 sample（角色 CLI）

按角色拆分后的持证方示例，使用方式：

```bash
npm run sample:holder -- generate    # 生成持证方公私钥并保存身份文件
npm run sample:holder -- list        # 查询可申请的普通凭证（SDK 固定查询 type=2 持证方凭证）
npm run sample:holder -- apply       # 申请凭证（assert + apply）
npm run sample:holder -- status      # 查看申请进度
npm run sample:holder -- download    # 下载已签发凭证
npm run sample:holder -- export      # 导出凭证文件并打印绝对路径
```

- 每个命令从 `sample/output/holder-identity.json` 读取私钥并重新登录平台，accessToken 不持久化。
- 身份/申请/凭证文件都在 `sample/output/`，该目录已被 `.gitignore` 忽略，不要提交私钥。
- 推荐列表固定查询 `type=2`（持证方普通凭证）由 SDK 内部写死；`type=0` 是申请成为发证方的凭证，不属于持证方入口。
- **持证方只依赖 VC 平台 HTTP 接口，不需要配置 BOP/开放平台。** `.env.holder` 只需填写：
  - `VC_PLATFORM_BASE_URL`（必填，填写 VC 平台主机根地址，不要包含 `/server`；SDK 内部固定拼接 `server/...` 路由）
- 申请参数通过命令行直接传入，不写入配置：
  - `apply --template-id=<模板ID>` 必填
  - `apply --subject='{"name":"Alice"}'` 可选表单主体
  - `apply --hold=1` 可选，表示已持有同类凭证（默认 0）
- `status` 使用登录后的 owner list，按 `applyNo` 查询当前 token 对应持证方的申请；状态 `1/2/3` 分别表示申请中、已通过、已拒绝。
- 状态查询要求结果中恰好有一条匹配申请，无匹配或多条匹配都会报错。owner list 的 `credentialBid` 会映射为公开结果的 `credentialId`，供 `download` 使用。
- 发证方签发成功后，持证方才能下载；同一流程需要先由发证方完成签发。
- 完整的真实平台流程、PowerShell JSON 参数、状态与本地文件协议，以及示例 App 实现边界见 [持证方 sample 实战指南](docs/holder-sample-guide.md)。

### 本地验证方 sample（直连节点）

将 `.env.verifier.example` 复制为 `.env.verifier`，只需填写以下 HTTPS 地址：

```text
BID_DIRECT_NODE_URL=
VC_REVOCATION_BASE_URL=
```

随后从仓库根目录验证持证方导出的出示 JWS 或凭证 JWS：

```powershell
npm run sample:verifier -- --file=sample/output/holder-presentation.jws
```

该 sample 只接受 `--file=<path>`，把文件内容作为非空 compact JWS 读取，不读取私钥、issuer 公钥、BOP 配置、解析服务或平台验证 URL；`help` / `--help` 不需要 `.env.verifier` 或网络。它保持默认 TLS 证书校验，直连节点查询 IAM/TDS 发行方信任，并直接对 DDO 合约执行 `queryBid` 读取 issuer DID 文档与公钥（不经过解析服务）。撤销状态通过发证方平台地址（`VC_REVOCATION_BASE_URL`）下的 `GET /api/cred/vc/revoked/{credentialId}` 查询。**撤销检查是在线 issuer-service 状态，不是独立的链上状态证明。** 输出只包含 `{ verified, checks, errors }`，验证不通过时以非零状态退出。

### Keystore 转私钥

keystore 在本地解密，返回的星火编码私钥可直接传给既有 API。SDK 不保存 keystore、密码或私钥。

```ts
const privateKey = sdk.keypair.keystore.toPrivateKey(keystoreJson, password)
const signer = sdk.vc.signer.fromPrivateKey(privateKey)
```

### 平台 BID 登录

平台认证复用钱包插件的挑战签名流程：

```text
POST /server/bid/auth/random { bid }
  → randomStr
  → 本地私钥/硬件钱包签名
POST /server/bid/auth { randomStr, signBlob, publicKey }
  → accessToken
```

```ts
const platform = sdk.vc.platform.create()

const session = await platform.login({
  bid: signer.address,
  signer,
})
```

`accessToken` 仅保存在 PlatformClient 内存中。鉴权请求失败时，SDK 最多重新认证并重放原请求一次。

默认只会对平台返回的 `errorCode=401` 重新认证；其他业务错误不会自动重放，避免重复申请、签发或撤销。

### 三角色 sample

VC 角色样例按持证方、发证方、验证方拆分，均直连真实平台。当前已实现持证方；命令与完整使用说明见上方“持证方 sample（角色 CLI）”及[持证方 sample 实战指南](docs/holder-sample-guide.md)。

真实环境的 URL 统一填写在 `configureBidSdk()`；`vcPlatformUrl` 填主机根地址，不要包含 `/server`，平台 `server/...` 路由由 SDK 内部固定。持证方和发证方私钥通过环境变量或硬件钱包 Signer 提供，不要写入 sample、配置代码或日志。

### 验证模式

```ts
const localResult = await sdk.vc.verifier.verifyCredential({ jws })

const platformResult = await sdk.vc.verifier.verifyCredentialByPlatform({ jws }, {
  apiKey: process.env.VC_REMOTE_API_KEY,
  apiKeyHeader: 'x-api-key',
})
```

`verifyCredential()` 默认在 SDK 内完成本地验证，并复用 `sdk.connect()` 建立的连接查询 IAM/TDS，以及直接查询 DDO 合约得到 issuer DID 公钥（不经过解析服务）；用户不需要提供 issuer 公钥或单独配置 trust。只有主动调用 `verifyCredentialByPlatform()` 时才会请求平台验证服务。撤销状态通过发证方平台地址（`vcRevocationUrl`）在线查询，**不是独立的链上状态证明**；验证结果只描述检查项和错误，不暴露 local/remote 实现模式。

跨境服务响应中的 `verificationExpired` 是历史字段名；其现有实现写入的是“是否仍在有效期”的结果，`true` 表示有效，SDK 已按这一实际语义映射。

### VC 开发验证

```bash
npm run check:vc
npm run sample:holder -- generate
npm run sample:holder -- list
```

`check:vc` 使用测试夹具覆盖 direct/BOP 的 IAM/TDS 查询、DDO 合约 issuer DID 读取、发证方平台撤销查询、选择性披露及角色流程，不需要真实链节点。真实运行时，IAM/TDS 与 DDO 合约都自动复用 `sdk.connect()` 建立的直连/BOP 连接，issuer DID 通过 DDO 合约 `queryBid` 读取，撤销状态通过发证方平台地址在线查询。持证方角色 CLI 直连真实平台，需要先按要求填写凭据。

## 开发验证

```bash
npm run check
npm run build
```
