import type { ContractQueryResult } from "./vc-local-protocol.js"

/**
 * 轻量直连节点客户端：用标准 fetch 直接调用链节点 HTTP 接口。
 * 仅依赖全局 fetch，不引入 undici、node:buffer、写链 SDK 或开放平台 SDK，
 * 可运行于 React Native / 浏览器等无 Node 内置模块的环境。
 */

export type DirectNodeClientOptions = {
  readonly baseUrl: string
  readonly fetcher?: typeof fetch
  readonly timeoutMs?: number
}

export type DirectNodeClient = {
  /** GET /getAccountMetaData：返回 result（key -> {key,value} 映射）或 null（未命中）。 */
  getAccountMetadata(address: string, key: string): Promise<unknown>
  /** POST /callContract：只读合约调用（opt_type=2），返回规范化的 queryRets。 */
  queryContract(input: { readonly contractAddress: string; readonly input: string }): Promise<ContractQueryResult>
}

export function createDirectNodeClient(options: DirectNodeClientOptions): DirectNodeClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  async function requestJson(input: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(input, { ...init, signal: controller.signal })
      if (!response.ok) throw new Error(`direct node returned HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async getAccountMetadata(address, key) {
      const url = new URL("/getAccountMetaData", `${baseUrl}/`)
      url.searchParams.set("address", address)
      url.searchParams.set("key", key)
      url.searchParams.set("check_chain_code", "true")
      const envelope = (await requestJson(url.toString())) as { readonly error_code?: number; readonly error_desc?: string; readonly result?: unknown }
      if (typeof envelope.error_code === "number" && envelope.error_code !== 0) {
        throw new Error(typeof envelope.error_desc === "string" ? envelope.error_desc : `getAccountMetaData failed with code ${envelope.error_code}`)
      }
      return envelope.result ?? null
    },

    async queryContract(input) {
      const url = new URL("/callContract", `${baseUrl}/`)
      const envelope = (await requestJson(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contract_address: input.contractAddress,
          code: "",
          input: input.input,
          opt_type: 2,
        }),
      })) as {
        readonly error_code?: number
        readonly error_desc?: string
        readonly result?: {
          readonly query_rets?: readonly { readonly error?: { readonly data?: unknown }; readonly result?: { readonly value?: unknown } }[]
          readonly queryRets?: readonly { readonly error?: { readonly data?: unknown }; readonly result?: { readonly value?: unknown } }[]
        }
      }
      if (typeof envelope.error_code === "number" && envelope.error_code !== 0) {
        throw new Error(typeof envelope.error_desc === "string" ? envelope.error_desc : `callContract failed with code ${envelope.error_code}`)
      }
      const rawRets = envelope.result?.query_rets ?? envelope.result?.queryRets
      if (!Array.isArray(rawRets)) return { queryRets: [] }
      return {
        queryRets: rawRets.map((entry) => {
          const errorData = entry?.error?.data
          const resultValue = entry?.result?.value
          return {
            ...(errorData === undefined ? {} : { error: { data: typeof errorData === "string" ? errorData : JSON.stringify(errorData) } }),
            ...(typeof resultValue !== "string" ? {} : { result: { value: resultValue } }),
          }
        }),
      }
    },
  }
}