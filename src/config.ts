import { BidConfigurationError } from "./errors.js"

export type BidSdkUrls = {
  readonly directNodeUrl?: string
  readonly bopUrl?: string
  readonly parserUrl?: string
  readonly vcPlatformUrl?: string
  readonly vcCredentialUrl?: string
  readonly vcVerificationUrl?: string
  readonly vcRevocationUrl?: string
}

let configuredUrls: BidSdkUrls | undefined

/** 配置当前运行环境的节点 URL。应用启动时调用一次；只保存提供的字段。 */
export function configureBidSdk(urls: BidSdkUrls): BidSdkUrls {
  const result: BidSdkUrls = {
    ...(urls.directNodeUrl === undefined ? {} : { directNodeUrl: normalizeUrl(urls.directNodeUrl, "directNodeUrl") }),
    ...(urls.bopUrl === undefined ? {} : { bopUrl: normalizeUrl(urls.bopUrl, "bopUrl") }),
    ...(urls.parserUrl === undefined ? {} : { parserUrl: normalizeUrl(urls.parserUrl, "parserUrl") }),
    ...(urls.vcPlatformUrl === undefined ? {} : { vcPlatformUrl: normalizeUrl(urls.vcPlatformUrl, "vcPlatformUrl") }),
    ...(urls.vcCredentialUrl === undefined ? {} : { vcCredentialUrl: normalizeUrl(urls.vcCredentialUrl, "vcCredentialUrl") }),
    ...(urls.vcVerificationUrl === undefined ? {} : { vcVerificationUrl: normalizeUrl(urls.vcVerificationUrl, "vcVerificationUrl") }),
    ...(urls.vcRevocationUrl === undefined ? {} : { vcRevocationUrl: normalizeUrl(urls.vcRevocationUrl, "vcRevocationUrl") }),
  }
  configuredUrls = result
  return configuredUrls
}

export function getBidSdkUrls(): BidSdkUrls {
  if (configuredUrls === undefined) throw new BidConfigurationError("SDK URLs", "must be configured with configureBidSdk(...) first")
  return configuredUrls
}

function normalizeUrl(value: string, field: keyof BidSdkUrls): string {
  try {
    const url = new URL(value)
    return url.href.endsWith("/") ? url.href : `${url.href}/`
  } catch (error) {
    throw new BidConfigurationError(field, "must be an absolute URL", { cause: error })
  }
}
