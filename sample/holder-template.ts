/**
 * 持证方申请前的模板详情解析与展示辅助。
 * 平台 templateDetail 返回的对象里，`data` 是 JSON 字符串，常见内容为
 * 申请字段定义数组（key/label/type/format/value，与 --subject 的 attributes
 * 结构一致）。这里安全解析：结构无法识别时不抛错，回退为打印原始详情。
 */

/** 模板详情 data 中解析出的申请字段定义（平台 attributes 结构的单个字段）。 */
export type TemplateField = {
  readonly key: string
  readonly label?: string
  readonly type?: string
  readonly format?: string
  readonly value?: string
}

export type TemplateDetail = {
  /** 模板元数据（除 data 外的原始键值，如 templateName/issuerBid）。 */
  readonly metadata: Readonly<Record<string, unknown>>
  /** data 解析出的字段定义；无法识别时为 undefined，调用方回退打印原始详情。 */
  readonly fields: readonly TemplateField[] | undefined
}

export function parseTemplateDetail(detail: unknown): TemplateDetail {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return { metadata: {}, fields: undefined }
  }
  const record = detail as Readonly<Record<string, unknown>>
  const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "data"))
  return { metadata, fields: parseFields(record["data"]) }
}

/** data 只接受「JSON 字符串 → 非空字段对象数组」这一已知形态，其余一律回退。 */
function parseFields(data: unknown): readonly TemplateField[] | undefined {
  if (typeof data !== "string" || data.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  const fields: TemplateField[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined
    const record = item as Readonly<Record<string, unknown>>
    const key = record["key"]
    if (typeof key !== "string" || key === "") return undefined
    const label = optionalString(record, "label")
    const type = optionalString(record, "type")
    const format = optionalString(record, "format")
    const value = optionalString(record, "value")
    fields.push({
      key,
      ...(label === undefined ? {} : { label }),
      ...(type === undefined ? {} : { type }),
      ...(format === undefined ? {} : { format }),
      ...(value === undefined ? {} : { value }),
    })
  }
  return fields
}

function optionalString(record: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = record[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** 由模板字段生成可直接复制、改 value 后提交的 --subject JSON 示例。 */
export function buildSubjectExample(fields: readonly TemplateField[]): string {
  return JSON.stringify({
    attributes: fields.map((field) => ({
      key: field.key,
      ...(field.label === undefined ? {} : { label: field.label }),
      ...(field.type === undefined ? {} : { type: field.type }),
      ...(field.format === undefined ? {} : { format: field.format }),
      value: field.value === undefined || field.value === "" ? `请填写${field.label ?? field.key}` : field.value,
    })),
  })
}

/** 生成申请前打印的模板指引：元数据 + 字段清单 + 可复制的 --subject 示例。 */
export function formatTemplateGuide(detail: unknown): string {
  const { metadata, fields } = parseTemplateDetail(detail)
  const lines: string[] = []
  if (Object.keys(metadata).length > 0) {
    lines.push("模板信息：")
    for (const [key, value] of Object.entries(metadata)) {
      lines.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    }
  }
  if (fields === undefined) {
    lines.push("未能识别模板字段结构，原始详情如下（请据此构造 --subject）：")
    lines.push(indent(JSON.stringify(detail, null, 2)))
    return lines.join("\n")
  }
  lines.push("申请字段（--subject 需按这些 key 填写）：")
  for (const field of fields) {
    const parts = [
      `key=${field.key}`,
      field.label === undefined ? undefined : `label=${field.label}`,
      field.type === undefined ? undefined : `type=${field.type}`,
      field.format === undefined ? undefined : `format=${field.format}`,
      field.value === undefined ? undefined : `value=${field.value}`,
    ].filter((part): part is string => part !== undefined)
    lines.push(`  - ${parts.join("  ")}`)
  }
  lines.push("可复制的 --subject 示例（把 value 换成真实值后再提交）：")
  lines.push(`  --subject='${buildSubjectExample(fields)}'`)
  return lines.join("\n")
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}
