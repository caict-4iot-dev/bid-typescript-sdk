export class BidValidationError extends Error {
  readonly name = "BidValidationError"

  constructor(readonly field: string, readonly reason: string) {
    super(`${field}: ${reason}`)
  }
}

export class BidConfigurationError extends Error {
  readonly name = "BidConfigurationError"

  constructor(readonly field: string, readonly reason: string) {
    super(`${field}: ${reason}`)
  }
}

export class BidReadError extends Error {
  readonly name = "BidReadError"

  constructor(readonly reason: string, options?: ErrorOptions) {
    super(reason, options)
  }
}

export class BidNotFoundError extends Error {
  readonly name = "BidNotFoundError"

  constructor(readonly id: string) {
    super(`BID document not found: ${id}`)
  }
}

export type SubmissionFailureKind = "insufficient-balance" | "account-not-active" | "permission-denied" | "unknown"

export const SUBMISSION_FAILURE_HINTS: Readonly<Record<SubmissionFailureKind, string>> = {
  "insufficient-balance": "源账户燃料费（星火令）不足，请登录星火开放平台领取星火令后重试。",
  "account-not-active": "源账户未激活或在链上不存在，请先在星火开放平台激活账户后重试。",
  "permission-denied": "当前账户无权执行该操作：写链账户必须已在该文档的 authentication 或 recovery 列表中。请改用文档持有者的私钥提交，或先把当前账户加入 authentication/recovery。",
  "unknown": "",
}

export function classifySubmissionFailure(reason: string): SubmissionFailureKind {
  const lower = reason.toLowerCase()
  if (/(not exist|not found|not activated|unactivated|no account|account.*missing)/.test(lower)) return "account-not-active"
  if (/(no right|no access|permission|not the owner|forbidden)/.test(lower)) return "permission-denied"
  if (/(balance|insufficient|insufficientfunds|fee|fuel|gas|星火令|xht)/.test(lower)) return "insufficient-balance"
  return "unknown"
}

export class TransactionSubmissionError extends Error {
  readonly name = "TransactionSubmissionError"
  readonly hint: string

  constructor(readonly transport: "direct" | "bop", readonly reason: string, options?: ErrorOptions) {
    const hint = SUBMISSION_FAILURE_HINTS[classifySubmissionFailure(reason)]
    super(`${transport} transaction submission failed: ${reason}${hint === "" ? "" : `。${hint}`}`, options)
    this.hint = hint
  }
}
