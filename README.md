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

完整示例见 `sample/bif-usage.ts`（直连）和 `sample/bop-usage.ts`（开放平台），
用 `npm run sample` / `npm run sample:bop` 运行。

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

`feeLimit`、`gasPrice` 有默认值，需要调整时在单次交易里覆盖即可：

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