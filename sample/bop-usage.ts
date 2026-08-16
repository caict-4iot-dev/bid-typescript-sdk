import { createBidSdk } from "../src/index.js"

/**
 * 运行：npm run sample:bop
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

// 原生公私钥与星火编码公私钥互转（纯本地）。
const nativePrivateKeyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const encryptedPrivateKey = sdk.keypair.convert.toEncPrivateKey(nativePrivateKeyHex, "ED25519")
const restored = sdk.keypair.convert.toRawPrivateKey(encryptedPrivateKey)
// SM2 同样支持：sdk.keypair.convert.toEncPublicKey(nativePublicKeyHex, "SM2")

console.log({ address: identity.address, document, verified, encryptedPrivateKey, restored })

// 接入开放平台写链与解析服务。
sdk.connect({
  mode: "bop",
  contractAddress: "did:bid:你的BID合约地址",
  parser: { baseUrl: "https://你的解析服务地址/bid/" },
  bop: {
    baseUrl: "https://你的开放平台地址",
    apiKey: "你的API Key",
    apiSecret: "",
  },
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