/**
 * 上游账号封禁文本的唯一分类入口。
 *
 * 这里只回答“这条错误是否代表账号被上游封禁”，不推断临时/永久期限，不做 TTL、
 * 退避或恢复探测。运行期闩锁、重启准入、选号与展示必须消费同一个答案。
 */
export type AccountSuspensionReason =
  | 'TEMPORARILY_SUSPENDED'
  | 'ACCOUNT_SUSPENDED'
  | 'PERMANENTLY_SUSPENDED'
  | 'ACCOUNT_LOCKED'
  | 'AccountSuspendedException'

export interface AccountSuspensionInfo {
  reason: AccountSuspensionReason
  message: string
}

const REASON_TOKEN =
  'TEMPORARILY_SUSPENDED|ACCOUNT_SUSPENDED|PERMANENTLY_SUSPENDED|ACCOUNT_LOCKED'

function normalizeReason(reason: string): AccountSuspensionReason {
  if (reason.toLowerCase() === 'accountsuspendedexception') {
    return 'AccountSuspendedException'
  }
  return reason.toUpperCase() as AccountSuspensionReason
}

function extractMessage(errorText: string): string {
  return errorText.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || errorText
}

export function classifyAccountSuspension(error: unknown): AccountSuspensionInfo | null {
  if (typeof error !== 'string' || error.length === 0) return null

  // 上游 JSON reason（运行期权威入口原有格式）。
  const jsonReason = error.match(
    new RegExp(`"reason"\\s*:\\s*"(${REASON_TOKEN})"`, 'i')
  )
  if (jsonReason) {
    return {
      reason: normalizeReason(jsonReason[1]),
      message: extractMessage(error)
    }
  }

  // onAccountSuspended 落盘格式：`[reason] message`。重启水合必须认识运行期产物。
  const persistedEnvelope = error.match(
    new RegExp(`^\\s*\\[(${REASON_TOKEN}|AccountSuspendedException)\\]\\s*(.*)$`, 'i')
  )
  if (persistedEnvelope) {
    return {
      reason: normalizeReason(persistedEnvelope[1]),
      message: persistedEnvelope[2] || error
    }
  }

  // 保留仓内既有纯 token 记录（后台检查/旧数据可能没有 JSON 或方括号信封）。
  const reasonToken = error.match(new RegExp(`\\b(${REASON_TOKEN})\\b`, 'i'))
  if (reasonToken) {
    return {
      reason: normalizeReason(reasonToken[1]),
      message: extractMessage(error)
    }
  }

  const userSuspended = /User\s+ID\s+is\s+(temporarily\s+)?suspended/i.exec(error)
  if (userSuspended) {
    return {
      reason: userSuspended[1] ? 'TEMPORARILY_SUSPENDED' : 'ACCOUNT_SUSPENDED',
      message: extractMessage(error)
    }
  }

  if (/temporarily\s+suspended/i.test(error)) {
    return {
      reason: 'TEMPORARILY_SUSPENDED',
      message: extractMessage(error)
    }
  }

  if (/AccountSuspendedException|Account\s+suspended/i.test(error)) {
    return {
      reason: 'AccountSuspendedException',
      message: extractMessage(error)
    }
  }

  // 既有本地持久化文案：统一识别，但仍只产出同一个“封禁”布尔语义。
  if (/已封禁|用户状态异常/i.test(error)) {
    return {
      reason: 'ACCOUNT_SUSPENDED',
      message: error
    }
  }

  // 裸 423 可能只是载荷大小、耗时等数字；必须同时带 locked/suspended 语义。
  if (/\b423\b/.test(error) && /locked|suspended/i.test(error)) {
    return {
      reason: 'ACCOUNT_LOCKED',
      message: error
    }
  }

  return null
}

export function isAccountSuspensionError(error: unknown): boolean {
  return classifyAccountSuspension(error) !== null
}
