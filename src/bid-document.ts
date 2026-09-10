import {
  bidDocumentSchema,
  type BidId,
  type BidPublicKey,
  type BidService,
  type BuiltBidDocument,
  type DelegateSign,
} from "./domain.js"
import { BidValidationError } from "./errors.js"

export const DEFAULT_DOCUMENT_CONTEXTS = ["https://www.w3.org/ns/did/v1"] as const
export const DEFAULT_DOCUMENT_VERSION = "1.0.0" as const
export const DEFAULT_EXTENSION_TTL = 86_400 as const
export const DEFAULT_EXTENSION_TYPE = 206 as const

type BuilderState = {
  id?: BidId
  context: string[]
  version?: string
  publicKeys: BidPublicKey[]
  authentication: string[]
  services: BidService[]
  created?: string
  updated?: string
  recovery: string[]
  ttl?: number
  delegateSign?: DelegateSign
  extensionType?: number
  extensionFields: Readonly<Record<string, unknown>>
}

/**
 * 按字段构建 BID 文档。未设置的字段使用默认值：
 * @context=["https://www.w3.org/ns/did/v1"]、version=1.0.0、
 * created/updated=当前时间、extension.ttl=86400、extension.type=206。
 */
export interface BidDocumentBuilder {
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
  /** 向 extension 添加任意自定义字段。 */
  setExtensionField(key: string, value: unknown): this
  build(): BuiltBidDocument
}

class Builder implements BidDocumentBuilder {
  private readonly state: BuilderState = {
    context: [...DEFAULT_DOCUMENT_CONTEXTS],
    publicKeys: [],
    authentication: [],
    services: [],
    recovery: [],
    extensionFields: {},
  }

  setId(id: BidId): this { this.state.id = id; return this }
  setContext(context: readonly string[]): this { this.state.context = [...context]; return this }
  addContext(context: string): this { this.state.context.push(context); return this }
  setVersion(version: string): this { this.state.version = version; return this }
  setPublicKeys(publicKeys: readonly BidPublicKey[]): this { this.state.publicKeys = [...publicKeys]; return this }
  addPublicKey(publicKey: BidPublicKey): this { this.state.publicKeys.push(publicKey); return this }
  setAuthentication(authentication: readonly string[]): this { this.state.authentication = [...authentication]; return this }
  addAuthentication(authentication: string): this { this.state.authentication.push(authentication); return this }
  setServices(services: readonly BidService[]): this { this.state.services = [...services]; return this }
  addService(service: BidService): this { this.state.services.push(service); return this }
  setCreated(created: string): this { this.state.created = created; return this }
  setUpdated(updated: string): this { this.state.updated = updated; return this }
  setRecovery(recovery: readonly string[]): this { this.state.recovery = [...recovery]; return this }
  addRecovery(recovery: string): this { this.state.recovery.push(recovery); return this }
  setTtl(ttl: number): this { this.state.ttl = ttl; return this }
  setDelegateSign(delegateSign: DelegateSign): this { this.state.delegateSign = delegateSign; return this }
  setExtensionType(type: number): this { this.state.extensionType = type; return this }
  setExtensionField(key: string, value: unknown): this {
    this.state.extensionFields = { ...this.state.extensionFields, [key]: value }
    return this
  }

  build(): BuiltBidDocument {
    const { id, context } = this.state
    if (id === undefined) throw new BidValidationError("id", "is required")
    if (context.length === 0) throw new BidValidationError("@context", "must contain at least one entry")
    assertUnique("publicKey", this.state.publicKeys.map((key) => key.id))
    assertUnique("service", this.state.services.map((service) => service.id))
    const now = new Date().toISOString()
    return bidDocumentSchema.parse({
      id,
      "@context": context,
      version: this.state.version ?? DEFAULT_DOCUMENT_VERSION,
      ...(this.state.publicKeys.length === 0 ? {} : { publicKey: this.state.publicKeys }),
      ...(this.state.authentication.length === 0 ? {} : { authentication: this.state.authentication }),
      ...(this.state.services.length === 0 ? {} : { service: this.state.services }),
      created: this.state.created ?? now,
      updated: this.state.updated ?? now,
      extension: this.buildExtension(),
    })
  }

  private buildExtension(): object {
    const { recovery, ttl, delegateSign, extensionType, extensionFields } = this.state
    return {
      ...(recovery.length === 0 ? {} : { recovery }),
      ttl: ttl ?? DEFAULT_EXTENSION_TTL,
      type: extensionType ?? DEFAULT_EXTENSION_TYPE,
      ...(delegateSign === undefined ? {} : { delegateSign }),
      ...extensionFields,
    }
  }
}

function assertUnique(field: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new BidValidationError(field, "contains duplicate ids")
}

export function createBidDocument(): BidDocumentBuilder { return new Builder() }
