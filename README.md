# BID TypeScript SDK

星火链 BID SDK。`createBidSdk()` 先得到一个离线 SDK，可以生成密钥、构建 BID 文档、签名验签；
需要写链或解析时再调用 `sdk.connect(...)`，可选直连节点或通过开放平台。

```ts
import { createBidSdk } from "@caict-bif/bid-typescript-sdk"

const sdk = createBidSdk()
sdk.connect({
  mode: "direct",                                    // 或 "bop"
  contractAddress: "did:bid:你的BID合约地址",
  parser: { baseUrl: "https://你的解析服务地址/bid/" },
  direct: { nodeUrl: "https://你的链节点域名" },      // bop 模式换成下方 bop 配置
})
```

完整示例见 `sample/usage.ts`，一个示例通过参数选择直连或开放平台：

```bash
npm run sample -- direct   # 直连链节点
npm run sample -- bop      # 开放平台
```

## 在其他项目中通过 npm 使用

```bash
npm install @caict-bif/bid-typescript-sdk
```

- 依赖会一并安装：`@caict-bif/bif-encryption`（密钥）、`@caict-bif/bif-typescript-sdk`（直连链节点）、`@caict-bif/bop-typescript-sdk`（开放平台），无需额外配置。
- 要求 Node >= 20。

最小可用代码：

```ts
import { createBidSdk } from "@caict-bif/bid-typescript-sdk"

const sdk = createBidSdk()
sdk.connect({
  mode: "bop",                       // 或用 mode: "direct" 配 direct 节点
  contractAddress: "did:bid:你的BID合约地址",
  parser: { baseUrl: "https://你的解析服务地址/bid/" },
  bop: {
    baseUrl: "https://你的开放平台地址",
    apiKey: "你的开放平台 API Key",
    apiSecret: "",                   // 无秘钥可留空
  },
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

- `resolve()` 只请求配置的解析服务，SDK 不会调链上 `queryBid`。
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

## 开发验证

```bash
npm run check
npm run build
```