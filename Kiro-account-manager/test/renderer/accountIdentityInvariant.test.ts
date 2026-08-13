/**
 * 账号记录 ID 一旦绑定上游身份，编辑与完整导入都不得把同一个 ID 原地换成另一个账号。
 *
 * 这两条测试直接调用 zustand store 的真实写入口，不测纯 helper：
 *   - 编辑保存走 updateAccount
 *   - 完整备份导入走 importFromExportData
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import type { Account, AccountExportData } from '@/types/account'

function account(id: string, email: string, userId: string): Account {
  return {
    id,
    email,
    userId,
    idp: 'BuilderId',
    credentials: {
      accessToken: `access-${userId}`,
      csrfToken: '',
      refreshToken: `refresh-${userId}`,
      expiresAt: Date.now() + 3_600_000,
      authMethod: 'social',
      provider: 'BuilderId'
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 50, percentUsed: 0, lastUpdated: Date.now() },
    tags: [],
    status: 'active',
    isActive: false,
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  window.api = {
    saveAccounts: vi.fn(async () => ({ ok: true as const, revision: 1 })),
    loadAccounts: vi.fn(async () => null)
  } as typeof window.api
  useAccountsStore.setState({
    accounts: new Map([['record-A', account('record-A', 'a@example.com', 'user-A')]]),
    currentRevision: 0,
    isSyncing: false
  })
})

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
})

describe('账号 ID 身份不漂移 · renderer 真实写入口', () => {
  it('编辑 A 时验证结果属于 B，保存被拒且 A 的记录与磁盘写入都不变', async () => {
    const result = useAccountsStore.getState().updateAccount('record-A', {
      email: 'b@example.com',
      userId: 'user-B',
      credentials: {
        ...useAccountsStore.getState().accounts.get('record-A')!.credentials,
        accessToken: 'access-user-B',
        refreshToken: 'refresh-user-B'
      }
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'ACCOUNT_IDENTITY_DRIFT'
    })
    expect(useAccountsStore.getState().accounts.get('record-A')).toMatchObject({
      id: 'record-A',
      email: 'a@example.com',
      userId: 'user-A',
      credentials: {
        accessToken: 'access-user-A',
        refreshToken: 'refresh-user-A'
      }
    })

    await vi.advanceTimersByTimeAsync(6_000)
    expect(window.api.saveAccounts).not.toHaveBeenCalled()
  })

  it('完整导入项的 ID 撞上不同身份，拒绝该项而不是覆盖现有记录', async () => {
    const imported = account('record-A', 'b@example.com', 'user-B')
    const data: AccountExportData = {
      version: '1',
      exportedAt: Date.now(),
      accounts: [{ ...imported, isActive: undefined } as unknown as Omit<Account, 'isActive'>],
      groups: [],
      tags: []
    }

    const result = useAccountsStore.getState().importFromExportData(data)

    expect(result).toMatchObject({ success: 0, failed: 1 })
    expect(result.errors).toContainEqual({
      id: 'record-A',
      error: expect.stringContaining('ID')
    })
    expect(useAccountsStore.getState().accounts.get('record-A')).toMatchObject({
      email: 'a@example.com',
      userId: 'user-A'
    })

    await vi.advanceTimersByTimeAsync(6_000)
    expect(window.api.saveAccounts).toHaveBeenCalledTimes(1)
    const persisted = vi.mocked(window.api.saveAccounts).mock.calls[0][0] as {
      accounts: Record<string, Account>
    }
    expect(persisted.accounts['record-A']).toMatchObject({
      email: 'a@example.com',
      userId: 'user-A'
    })
  })

  it('导入 ID 冲突优先于普通 userId 判重，email 不一致必须明确拒绝而非静默跳过', () => {
    const imported = account('record-A', 'b@example.com', 'user-A')
    const data: AccountExportData = {
      version: '1',
      exportedAt: Date.now(),
      accounts: [{ ...imported, isActive: undefined } as unknown as Omit<Account, 'isActive'>],
      groups: [],
      tags: []
    }

    const result = useAccountsStore.getState().importFromExportData(data)

    expect(result).toMatchObject({ success: 0, failed: 1 })
    expect(result.errors).toContainEqual({
      id: 'record-A',
      error: expect.stringContaining('email')
    })
    expect(useAccountsStore.getState().accounts.get('record-A')?.email).toBe('a@example.com')
  })
})
