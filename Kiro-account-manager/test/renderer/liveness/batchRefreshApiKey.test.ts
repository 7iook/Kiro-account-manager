/**
 * batchRefreshTokens: API Key(ksk_)账号不能走 token 刷新（无 refreshToken），
 * 但产品设计上"点刷新即刷新额度"——单账号 refreshAccountToken 已支持（委托 checkAccountStatus），
 * 批量路径原先 `!refreshToken → continue` 会静默跳过它们，
 * 表现为"分组里选中一批 API Key 账号点批量刷新毫无反应"。
 *
 * 本测试守护：批量刷新对 API Key 账号改走 checkAccountStatus(拉额度)，不再静默跳过。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'

function mkApiKeyAcc(id: string, email: string): Account {
  return {
    id,
    email,
    idp: 'ApiKey',
    subscription: { type: 'Free', title: 'Free' },
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    credentials: {
      accessToken: 'ksk_xxx',
      csrfToken: '',
      refreshToken: '', // API Key 账号无 refreshToken
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'api_key',
      provider: 'ApiKey'
    }
  } as Account
}

function mkSocialAcc(id: string, email: string): Account {
  return {
    id,
    email,
    idp: 'Google',
    subscription: { type: 'Free', title: 'Free' },
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    credentials: {
      accessToken: 'access-tok',
      csrfToken: '',
      refreshToken: 'r-tok',
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'social',
      provider: 'Google'
    }
  } as Account
}

beforeEach(() => {
  useAccountsStore.setState({ accounts: new Map() })
})

describe('store.batchRefreshTokens · API Key 账号不再被静默跳过', () => {
  it('全是 API Key 账号时，批量刷新走 checkAccountStatus 拉额度（不再无反应）', async () => {
    const checkStatusCalls: unknown[] = []
    const bgRefreshCalls: unknown[] = []
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      // checkAccountStatus 内部调用：返回可用额度
      checkAccountStatus: vi.fn(async (acc: unknown) => {
        checkStatusCalls.push(acc)
        return { success: true, data: { status: 'active', usage: { current: 1, limit: 100, lastUpdated: Date.now() } } }
      }),
      backgroundBatchRefresh: vi.fn(async (accs: unknown) => {
        bgRefreshCalls.push(accs)
        return { successCount: 0, failedCount: 0 }
      }),
      saveAccounts: vi.fn(async () => {}),
      triggerWebhook: vi.fn(async () => {}),
      proxySyncAccounts: vi.fn(async () => ({ success: true }))
    }

    useAccountsStore.setState({
      accounts: new Map([
        ['k1', mkApiKeyAcc('k1', 'k1@x.com')],
        ['k2', mkApiKeyAcc('k2', 'k2@x.com')]
      ])
    })

    const result = await useAccountsStore.getState().batchRefreshTokens(['k1', 'k2'])

    // 关键：2 个 API Key 账号都走了 checkAccountStatus（旧逻辑会全部跳过 → success 0）
    expect(checkStatusCalls.length).toBe(2)
    expect(result.success).toBe(2)
    // 不应把 API Key 账号塞进 token 刷新路径
    expect(bgRefreshCalls.length).toBe(0)
  })

  it('API Key 与社交账号混合时，各走各的刷新路径', async () => {
    const checkStatusIds: string[] = []
    let bgRefreshPayload: Array<{ id: string }> = []
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      checkAccountStatus: vi.fn(async (acc: { id: string }) => {
        checkStatusIds.push(acc.id)
        return { success: true, data: { status: 'active' } }
      }),
      backgroundBatchRefresh: vi.fn(async (accs: Array<{ id: string }>) => {
        bgRefreshPayload = accs
        return { successCount: accs.length, failedCount: 0 }
      }),
      saveAccounts: vi.fn(async () => {}),
      triggerWebhook: vi.fn(async () => {}),
      proxySyncAccounts: vi.fn(async () => ({ success: true }))
    }

    useAccountsStore.setState({
      accounts: new Map([
        ['k1', mkApiKeyAcc('k1', 'k1@x.com')],
        ['s1', mkSocialAcc('s1', 's1@x.com')]
      ])
    })

    const result = await useAccountsStore.getState().batchRefreshTokens(['k1', 's1'])

    // API Key 走 checkAccountStatus
    expect(checkStatusIds).toContain('k1')
    // 社交账号走 token 刷新
    expect(bgRefreshPayload.map((a) => a.id)).toContain('s1')
    expect(bgRefreshPayload.map((a) => a.id)).not.toContain('k1')
    // 合并结果：1 token + 1 api key = 2 成功
    expect(result.success).toBe(2)
  })
})
