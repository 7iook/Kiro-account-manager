/**
 * dto.ts(白名单投影) × respond.ts(denylist 脱敏) 的**组合**正确性
 *
 * 两个模块各自的单测都绿，但**组合起来会互相破坏** —— 本轮实测发现的真实缺陷：
 *
 *   `dto.ts` 刻意输出 `hasRefreshToken: boolean`（送结论不送原料），
 *   而 `redact.ts:isSensitiveKey` 做的是**子串匹配**：`hasrefreshtoken` 含
 *   `refreshtoken` → 命中敏感键 → `true` 被打成字符串 `'***'`。
 *
 * 后果不是泄漏而是**功能损坏**：面板 UI 拿到 `'***'`（truthy 字符串），
 * 「能否刷新」永远为真，按钮对无 refreshToken 的账号也会亮。
 * 类型系统拦不住（`sendJson` 收 `unknown`），两个模块的单测也都拦不住
 * （各自都没跨过那条边）。所以这条测试盯的是**边本身**。
 *
 * 判据刻意写成**遍历 DTO 全部键**而非只测 `hasRefreshToken` 一个：
 * 将来 dto.ts 新增 `hasAccessToken` / `hasClientSecret` 这类存在性布尔时，
 * 只要忘了同步 `SAFE_KEYS`，这里立刻红 —— 而不是等面板 UI 出现诡异行为才发现。
 */
import { describe, it, expect } from 'vitest'
import { toAccountListItem, projectAccountsBlob } from '../../../src/main/webPanel/dto'
import { redactValue } from '../../../src/main/utils/redact'

const RAW_ACCOUNT = {
  id: 'acc-1',
  email: 'user@example.com',
  nickname: 'Main',
  idp: 'BuilderId',
  status: 'active',
  isActive: true,
  tags: ['work'],
  machineId: 'a'.repeat(64),
  subscription: { type: 'Pro', title: 'Kiro Pro', daysRemaining: 20 },
  usage: { current: 10, limit: 100, percentUsed: 0.1, baseLimit: 100, baseCurrent: 10 },
  credentials: {
    accessToken: 'header.payload.signature-like-value',
    refreshToken: 'refresh-secret-value',
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    csrfToken: 'csrf-secret',
    expiresAt: 1893456000000,
    authMethod: 'IdC'
  }
}

describe('dto × respond 组合: 脱敏不得破坏白名单投影的语义', () => {
  it('DTO 里所有布尔字段过 redactValue 后仍是布尔(不被打成 "***")', () => {
    const dto = toAccountListItem(RAW_ACCOUNT)
    expect(dto).not.toBeNull()
    const redacted = redactValue(dto) as Record<string, unknown>

    const booleanKeys = Object.entries(dto as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => k)
    // 投影至少产出 hasRefreshToken / canRefreshViaOidc / isActive 三个布尔
    expect(booleanKeys.length).toBeGreaterThanOrEqual(3)

    for (const key of booleanKeys) {
      expect(
        typeof redacted[key],
        `${key} 被脱敏层改写成了 ${JSON.stringify(redacted[key])} —— ` +
          `存在性布尔含敏感子串时会被 isSensitiveKey 子串命中,需加进 redact.ts 的 SAFE_KEYS`
      ).toBe('boolean')
    }
  })

  it('DTO 里的数值字段过脱敏后仍是数值(expiresAt 是时间戳,不是凭据)', () => {
    const dto = toAccountListItem(RAW_ACCOUNT) as Record<string, unknown>
    const redacted = redactValue(dto) as Record<string, unknown>
    for (const [key, value] of Object.entries(dto)) {
      if (typeof value === 'number') {
        expect(typeof redacted[key], `${key} 被脱敏层改写了`).toBe('number')
      }
    }
    expect(redacted.expiresAt).toBe(RAW_ACCOUNT.credentials.expiresAt)
  })

  it('hasRefreshToken 的真假两态都要能穿过脱敏层', () => {
    const withToken = redactValue(toAccountListItem(RAW_ACCOUNT)) as Record<string, unknown>
    expect(withToken.hasRefreshToken).toBe(true)

    const withoutToken = redactValue(
      toAccountListItem({
        ...RAW_ACCOUNT,
        credentials: { ...RAW_ACCOUNT.credentials, refreshToken: '' }
      })
    ) as Record<string, unknown>
    // 若被打成 '***' 这条会红:'***' 是 truthy,UI 的「能否刷新」就永远为真
    expect(withoutToken.hasRefreshToken).toBe(false)
  })

  it('凭据原料在组合后依然不出现(两层都在工作)', () => {
    const payload = projectAccountsBlob({ revision: 3, accounts: { 'acc-1': RAW_ACCOUNT } })
    const serialised = JSON.stringify(redactValue(payload))
    expect(serialised).not.toContain('refresh-secret-value')
    expect(serialised).not.toContain('client-secret-value')
    expect(serialised).not.toContain('csrf-secret')
    expect(serialised).not.toContain('header.payload.signature-like-value')
    // 白名单字段与 revision 必须完好
    expect(serialised).toContain('user@example.com')
    expect(JSON.parse(serialised).revision).toBe(3)
  })
})
