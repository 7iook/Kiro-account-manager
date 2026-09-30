/**
 * ksk_ API Key 导入后「刷新额度」被身份守卫误拒 · 回归
 *
 * 导入时上游还没给真实 userId，`importApiKey.ts:buildApiKeyAccount` 用
 * profileArn 尾段 / tokenFingerprint 作占位 userId。首次 GetUsageLimits 返回真实
 * userId 时，这是「首次补齐」而不是「换成另一个账号」，守卫必须放行；
 * 真实 userId 一旦落盘，后续仍须被守住。
 */
import { describe, it, expect } from 'vitest'
import { findAccountIdentityMutationViolations } from '../../../src/shared/accountIdentity'

const FP = 'fp-3b1f0c9e'
const REAL = 'd-9067642ac7.7468b498-20b1-70ac-577b-178662efac77'

function apiKeyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'K',
    email: '',
    userId: FP,
    idp: 'ApiKey',
    credentials: { authMethod: 'api_key', provider: 'ApiKey', tokenFingerprint: FP },
    ...overrides
  }
}

const blob = (rec: Record<string, unknown>): unknown => ({ accounts: { K: rec } })

describe('ksk 导入占位 userId · 首次刷新额度', () => {
  it('STANDALONE ksk（占位=指纹）首次拿到真实 userId+email，允许落盘', () => {
    const before = apiKeyRecord()
    const after = apiKeyRecord({ userId: REAL, email: 'user@example.com' })
    expect(findAccountIdentityMutationViolations(blob(before), blob(after))).toEqual([])
  })

  it('带 profileArn 的 ksk（占位=ARN 尾段）首次拿到真实 userId，允许落盘', () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
    const before = apiKeyRecord({ userId: 'EHGA3GRVQMUK', profileArn: arn })
    const after = apiKeyRecord({ userId: REAL, profileArn: arn })
    expect(findAccountIdentityMutationViolations(blob(before), blob(after))).toEqual([])
  })

  it('真实 userId 已落盘后再换成别的 userId，仍然拒绝', () => {
    const before = apiKeyRecord({ userId: REAL, email: 'user@example.com' })
    const after = apiKeyRecord({ userId: 'd-other.user', email: 'user@example.com' })
    expect(findAccountIdentityMutationViolations(blob(before), blob(after))).toHaveLength(1)
  })

  it('非 ksk 账号的 userId 恰好等于指纹字符串，不享受占位豁免', () => {
    const before = {
      id: 'K',
      userId: FP,
      credentials: { authMethod: 'social', provider: 'Google', tokenFingerprint: FP }
    }
    const after = { ...before, userId: REAL }
    expect(findAccountIdentityMutationViolations(blob(before), blob(after))).toHaveLength(1)
  })

  it('ksk 记录的 userId 不是自身占位（被人手改过），换值仍拒绝', () => {
    const before = apiKeyRecord({ userId: 'user-A' })
    const after = apiKeyRecord({ userId: REAL })
    expect(findAccountIdentityMutationViolations(blob(before), blob(after))).toHaveLength(1)
  })
})
