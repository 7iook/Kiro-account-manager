/**
 * 账号本地记录 ID 与上游身份的不可变约束。
 *
 * `id` 是本应用的记录键，不是上游签发的身份。真正需要守住的是：
 * 同一个记录键已经有非空 userId/email 后，后续写入只能保留它们，不能清空或替换。
 * 缺失字段首次补齐允许；删除旧记录后以新 ID 新增同一身份也允许。
 */

export type AccountIdentityField = 'id' | 'userId' | 'email'

export interface AccountIdentityMutationViolation {
  accountId: string
  fields: AccountIdentityField[]
  kind: 'IDENTITY_CHANGED' | 'RECORD_KEY_ID_MISMATCH' | 'DUPLICATE_RECORD_ID'
}

export type AccountIdentityAuditCode =
  | 'RECORD_KEY_ID_MISMATCH'
  | 'DUPLICATE_RECORD_ID'
  | 'HISTORICAL_IDENTITY_MISMATCH'

export interface AccountIdentityAuditIssue {
  code: AccountIdentityAuditCode
  accountId: string
  fields: AccountIdentityField[]
  sources: Array<'currentData' | 'machineIdHistory' | 'historicalSnapshot'>
  relatedIds?: string[]
}

type UnknownRecord = Record<string, unknown>

interface AccountRecordRef {
  stableId: string
  storageKey?: string
  recordId?: string
  record: UnknownRecord
  location: string
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as UnknownRecord
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function identityValue(field: 'userId' | 'email', record: UnknownRecord): string | undefined {
  const value = nonEmptyString(record[field])
  return field === 'email' ? value?.toLocaleLowerCase('en-US') : value
}

/**
 * ksk_ 导入时上游尚未给出真实 userId，`importApiKey.ts:buildApiKeyAccount` 用
 * profileArn 尾段 / tokenFingerprint 作本地占位。占位不是上游身份：首次刷新额度拿到
 * 真实 userId 属于「首次补齐」，不是「换成另一个账号」。
 *
 * 只认记录**自己**的凭据派生出的占位值；非 ksk 记录或被改过的值不豁免。
 */
function isApiKeyPlaceholderUserId(record: UnknownRecord, userId: string): boolean {
  const cred = asRecord(record.credentials) ?? {}
  const isApiKey =
    cred.authMethod === 'api_key' || cred.provider === 'ApiKey' || record.idp === 'ApiKey'
  if (!isApiKey) return false
  if (userId === nonEmptyString(cred.tokenFingerprint)) return true
  const arn = nonEmptyString(record.profileArn) ?? nonEmptyString(cred.profileArn)
  const arnTail = arn ? arn.split('/').pop() || arn.slice(-12) : undefined
  return userId === arnTail
}

/** 已建立的身份值；ksk 占位 userId 视为尚未建立。 */
function establishedIdentityValue(
  field: 'userId' | 'email',
  record: UnknownRecord
): string | undefined {
  const value = identityValue(field, record)
  if (field === 'userId' && value !== undefined && isApiKeyPlaceholderUserId(record, value)) {
    return undefined
  }
  return value
}

/**
 * 检查一条既有记录的单次变更。
 *
 * 只要旧字段已有值，新值缺失也算违反约束；否则先清空、下一次再换值就能绕过守卫。
 */
export function findAccountIdentityTransitionViolation(
  accountId: string,
  previous: unknown,
  next: unknown
): AccountIdentityMutationViolation | null {
  const before = asRecord(previous)
  const after = asRecord(next)
  if (!before || !after) return null

  const fields: AccountIdentityField[] = []
  const previousId = nonEmptyString(before.id)
  const nextId = nonEmptyString(after.id)
  if (previousId !== undefined && previousId !== nextId) fields.push('id')

  for (const field of ['userId', 'email'] as const) {
    const oldValue = establishedIdentityValue(field, before)
    if (oldValue !== undefined && oldValue !== identityValue(field, after)) fields.push(field)
  }

  return fields.length > 0
    ? { accountId, fields, kind: 'IDENTITY_CHANGED' }
    : null
}

function collectAccountRecords(blob: unknown): AccountRecordRef[] {
  const accounts = asRecord(blob)?.accounts
  if (Array.isArray(accounts)) {
    const refs: AccountRecordRef[] = []
    accounts.forEach((value, index) => {
      const record = asRecord(value)
      if (!record) return
      const recordId = nonEmptyString(record.id)
      refs.push({
        stableId: recordId ?? `@index:${index}`,
        recordId,
        record,
        location: `accounts[${index}]`
      })
    })
    return refs
  }

  const accountMap = asRecord(accounts)
  if (!accountMap) return []
  const refs: AccountRecordRef[] = []
  for (const [storageKey, value] of Object.entries(accountMap)) {
    const record = asRecord(value)
    if (!record) continue
    refs.push({
      stableId: storageKey,
      storageKey,
      recordId: nonEmptyString(record.id),
      record,
      location: `accounts.${storageKey}`
    })
  }
  return refs
}

function groupByStableId(refs: AccountRecordRef[]): Map<string, AccountRecordRef[]> {
  const grouped = new Map<string, AccountRecordRef[]>()
  for (const ref of refs) {
    const group = grouped.get(ref.stableId)
    if (group) group.push(ref)
    else grouped.set(ref.stableId, [ref])
  }
  return grouped
}

function structuralMutationViolations(blob: unknown): AccountIdentityMutationViolation[] {
  const refs = collectAccountRecords(blob)
  const violations: AccountIdentityMutationViolation[] = []

  for (const ref of refs) {
    if (ref.storageKey && ref.recordId && ref.storageKey !== ref.recordId) {
      violations.push({
        accountId: ref.storageKey,
        fields: ['id'],
        kind: 'RECORD_KEY_ID_MISMATCH'
      })
    }
  }

  const byRecordId = new Map<string, AccountRecordRef[]>()
  for (const ref of refs) {
    if (!ref.recordId) continue
    const group = byRecordId.get(ref.recordId)
    if (group) group.push(ref)
    else byRecordId.set(ref.recordId, [ref])
  }
  for (const [recordId, group] of byRecordId) {
    if (group.length > 1) {
      violations.push({
        accountId: recordId,
        fields: ['id'],
        kind: 'DUPLICATE_RECORD_ID'
      })
    }
  }

  return violations
}

function mutationViolationFingerprint(issue: AccountIdentityMutationViolation): string {
  return `${issue.kind}:${issue.accountId}:${issue.fields.join(',')}`
}

/**
 * 比较整表写入前后；返回本次写入新引入的身份漂移或 ID 结构冲突。
 *
 * 既有脏数据不会让所有无关写入永久失败：原样存在的问题交给启动审计只报告；
 * 只有身份实际发生变化，或本次新引入结构问题时才拒绝写入。
 */
export function findAccountIdentityMutationViolations(
  previousBlob: unknown,
  nextBlob: unknown
): AccountIdentityMutationViolation[] {
  const violations: AccountIdentityMutationViolation[] = []
  const beforeGroups = groupByStableId(collectAccountRecords(previousBlob))
  const afterGroups = groupByStableId(collectAccountRecords(nextBlob))

  for (const [stableId, beforeGroup] of beforeGroups) {
    const afterGroup = afterGroups.get(stableId)
    // 重复 ID 的旧数组无法无歧义配对；结构问题由下方的新问题检测处理并由启动审计报告。
    if (beforeGroup.length !== 1 || afterGroup?.length !== 1) continue
    const violation = findAccountIdentityTransitionViolation(
      stableId,
      beforeGroup[0].record,
      afterGroup[0].record
    )
    if (violation) violations.push(violation)
  }

  const oldStructural = new Set(
    structuralMutationViolations(previousBlob).map(mutationViolationFingerprint)
  )
  for (const issue of structuralMutationViolations(nextBlob)) {
    if (!oldStructural.has(mutationViolationFingerprint(issue))) violations.push(issue)
  }

  const unique = new Map<string, AccountIdentityMutationViolation>()
  for (const issue of violations) unique.set(mutationViolationFingerprint(issue), issue)
  return [...unique.values()].sort((a, b) => a.accountId.localeCompare(b.accountId))
}

export class AccountIdentityDriftError extends Error {
  readonly code = 'ACCOUNT_IDENTITY_DRIFT' as const

  constructor(readonly violations: AccountIdentityMutationViolation[]) {
    const ids = [...new Set(violations.map((issue) => issue.accountId))].join(', ')
    super(`账号记录身份不可原地替换（${ids}）；这是另一个账号，请改用新增`)
    this.name = 'AccountIdentityDriftError'
  }
}

export function assertAccountIdentityInvariant(previousBlob: unknown, nextBlob: unknown): void {
  const violations = findAccountIdentityMutationViolations(previousBlob, nextBlob)
  if (violations.length > 0) throw new AccountIdentityDriftError(violations)
}

function structuralAuditIssues(blob: unknown): AccountIdentityAuditIssue[] {
  const refs = collectAccountRecords(blob)
  const issues: AccountIdentityAuditIssue[] = []

  for (const ref of refs) {
    if (ref.storageKey && ref.recordId && ref.storageKey !== ref.recordId) {
      issues.push({
        code: 'RECORD_KEY_ID_MISMATCH',
        accountId: ref.storageKey,
        fields: ['id'],
        sources: ['currentData'],
        relatedIds: [ref.recordId]
      })
    }
  }

  const byRecordId = new Map<string, AccountRecordRef[]>()
  for (const ref of refs) {
    if (!ref.recordId) continue
    const group = byRecordId.get(ref.recordId)
    if (group) group.push(ref)
    else byRecordId.set(ref.recordId, [ref])
  }
  for (const [recordId, group] of byRecordId) {
    if (group.length > 1) {
      issues.push({
        code: 'DUPLICATE_RECORD_ID',
        accountId: recordId,
        fields: ['id'],
        sources: ['currentData'],
        relatedIds: group.map((ref) => ref.location)
      })
    }
  }

  return issues
}

function addAuditIssue(
  output: Map<string, AccountIdentityAuditIssue>,
  issue: AccountIdentityAuditIssue
): void {
  const key = `${issue.code}:${issue.accountId}:${issue.fields.join(',')}`
  const existing = output.get(key)
  if (!existing) {
    output.set(key, issue)
    return
  }
  existing.sources = [...new Set([...existing.sources, ...issue.sources])]
  existing.relatedIds = [...new Set([...(existing.relatedIds ?? []), ...(issue.relatedIds ?? [])])]
}

/**
 * 启动只读审计。不会根据 UUID/email-时间戳等 ID 外形猜测，也不会修改传入数据。
 *
 * 可用历史来源：
 *   1. 当前 blob 内已有的 machineIdHistory.accountEmail；
 *   2. 装配层可选提供的历史快照（例如可解密备份）。
 */
export function inspectAccountIdentityAudit(
  currentBlob: unknown,
  historicalBlobs: readonly unknown[] = []
): AccountIdentityAuditIssue[] {
  const output = new Map<string, AccountIdentityAuditIssue>()
  for (const issue of structuralAuditIssues(currentBlob)) addAuditIssue(output, issue)

  const currentGroups = groupByStableId(collectAccountRecords(currentBlob))
  const machineHistory = asRecord(currentBlob)?.machineIdHistory
  if (Array.isArray(machineHistory)) {
    for (const value of machineHistory) {
      const entry = asRecord(value)
      const accountId = nonEmptyString(entry?.accountId)
      const historicalEmail = nonEmptyString(entry?.accountEmail)?.toLocaleLowerCase('en-US')
      if (!accountId || !historicalEmail) continue
      const current = currentGroups.get(accountId)
      if (current?.length !== 1) continue
      const currentEmail = identityValue('email', current[0].record)
      // 历史已证明 email 曾建立后，当前被清空同样是漂移；不能只报“换值”而漏掉“先清空”。
      if (currentEmail !== historicalEmail) {
        addAuditIssue(output, {
          code: 'HISTORICAL_IDENTITY_MISMATCH',
          accountId,
          fields: ['email'],
          sources: ['machineIdHistory']
        })
      }
    }
  }

  for (const historicalBlob of historicalBlobs) {
    const historicalGroups = groupByStableId(collectAccountRecords(historicalBlob))
    for (const [accountId, historical] of historicalGroups) {
      const current = currentGroups.get(accountId)
      if (historical.length !== 1 || current?.length !== 1) continue
      const transition = findAccountIdentityTransitionViolation(
        accountId,
        historical[0].record,
        current[0].record
      )
      if (!transition) continue
      addAuditIssue(output, {
        code: 'HISTORICAL_IDENTITY_MISMATCH',
        accountId,
        fields: transition.fields,
        sources: ['historicalSnapshot']
      })
    }
  }

  return [...output.values()].sort(
    (a, b) => a.accountId.localeCompare(b.accountId) || a.code.localeCompare(b.code)
  )
}
