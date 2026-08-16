import { createBidSdk } from "../src/index.js"

/**
 * 运行：npm run sample
 * 写链账户需要在链上激活，把它的编码私钥放进环境变量 BID_SOURCE_PRIVATE_KEY。
 */

const sdk = createBidSdk()

// 生成密钥和 BID 地址（纯本地）。
const identity = sdk.keypair.generate()

// 构建 BID 文档，未设置字段使用默认值。
const document = sdk.document
  .create(identity.address)
  .setContext(["https://www.w3.org/ns/did/v1"])
  .setVersion("1.0.0")
  .addPublicKey({
    id: `${identity.address}#key-1`,
    type: "Ed25519",
    controller: identity.address,
    publicKeyHex: identity.publicKey,
  })
  .addAuthentication(`${identity.address}#key-1`)
  .setRecovery([`${identity.address}#key-1`])
  .setTtl(86_400)
  .setExtensionType(206)
  .build()

// 签名与验签（纯本地）。
const signer = sdk.keypair.signer(identity.privateKey)
const signature = signer.sign("deadbeef")
const verified = signer.verify("deadbeef", signature)

console.log({ address: identity.address, document, verified })

// 接入直连链节点与解析服务。
sdk.connect({
  mode: "direct",
  contractAddress: "did:bid:你的BID合约地址",
  parser: { baseUrl: "https://你的解析服务地址/bid/" },
  // 本机 TLS 证书校验失败时用于联调，生产环境请移除并使用 NODE_EXTRA_CA_CERTS。
  direct: { nodeUrl: "https://你的链节点域名", allowInsecureTls: true },
})

const sourcePrivateKey = process.env.BID_SOURCE_PRIVATE_KEY ?? identity.privateKey

try {
  const created = await sdk.bid.create(document, {
    privateKey: sourcePrivateKey,
  })
  const updated = await sdk.bid.update(document, {
    privateKey: sourcePrivateKey,
    feeLimit: 2_000_000,
  })
  await sdk.bid.reAuth({
    id: identity.address,
    authentication: [`${identity.address}#key-1`],
    transaction: { privateKey: sourcePrivateKey },
  })
  // 注意：reAuth 要求签名账户在文档 extension.recovery 中，或等于文档 id。
  // 若 sourcePrivateKey 与生成文档的 identity 不是同一账户，请先确保其地址已加入 recovery。
  // 链上确认与解析系统索引存在延迟，等待几秒再解析。
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const resolved = await sdk.bid.resolve(identity.address)
  console.log({ created, updated, resolved })
} catch (error) {
  // 星火令不足或账户未激活时，message 会提示去开放平台领取/激活。
  console.error(error instanceof Error ? error.message : error)
}