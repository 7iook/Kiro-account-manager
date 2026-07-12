/**
 * B9: store.importFromExportData 内 isAccountExists 副键扩为三元组
 * (email, provider, profileArn) — 同 email + 同 provider + 不同 profileArn 不算重复
 *
 * 直接测 store 行为(不是测 helper),因为 isAccountExists 是 importFromExportData 内的闭包函数,
 * 抽出需要更大重构 —— 决策卡明确 SSOT 收敛下轮做。本轮扩键并用行为测证明。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'

function mkAcc(overrides: Partial<Account> & { credentials?: Partial<Account['credentials']> }): Account {
  return {
    id: overrides.id || `acc-${Math.random()}`,
    email: overrides.email ?? '',
    userId: overrides.userId,
    idp: overrides.idp ?? 'ExternalIdp',
    credentials: {
      accessToken: '',
      csrfToken: '',
      refreshToken: '',
      clientId: '',
      clientSecret: '',
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'external_idp',
      provider: 'ExternalIdp',
      ...(overrides.credentials || {})
    },
    subscription: { type: 'FREE', title: 'FREE' },
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    ...overrides
  } as Account
}

beforeEach(() => {
  // 重置 store 到空账户(直接 setState,不触发持久化)
  useAccountsStore.setState({ accounts: new Map() })
})

describe('store.importFromExportData · isAccountExists 三元组扩键 (B9)', () => {
  it('B9: 同 email + 同 provider + 不同 profileArn → 不判重复,新账户应入库', () => {
    // 已有一个 profileArn=A 的账户
    useAccountsStore.setState({
      accounts: new Map([
        ['a1', mkAcc({
          id: 'a1', email: 'x@y.com', userId: 'u-existing',
          credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }
        })]
      ])
    })

    const newAccount = mkAcc({
      id: 'a2', email: 'x@y.com', userId: 'u-new',
      credentials: { provider: 'ExternalIdp', profileArn: 'arn:B' }
    })
    const result = useAccountsStore.getState().importFromExportData({
      version: '1',
      exportedAt: Date.now(),
      accounts: [newAccount],
      groups: [],
      tags: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(result.success).toBe(1)
    expect(result.failed).toBe(0)
    // store 里应新增
    const accounts = useAccountsStore.getState().accounts
    expect(accounts.size).toBe(2)
    expect(Array.from(accounts.values()).some(a => a.credentials.profileArn === 'arn:B')).toBe(true)
  })

  it('B9: 同 email + 同 provider + 同 profileArn → 判为重复,skip', () => {
    useAccountsStore.setState({
      accounts: new Map([
        ['a1', mkAcc({
          id: 'a1', email: 'x@y.com', userId: 'u-existing',
          credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }
        })]
      ])
    })

    const newAccount = mkAcc({
      id: 'a2', email: 'x@y.com', userId: 'u-new',  // 不同 userId
      credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }  // 同 profileArn
    })
    const result = useAccountsStore.getState().importFromExportData({
      version: '1',
      exportedAt: Date.now(),
      accounts: [newAccount],
      groups: [],
      tags: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(result.success).toBe(0)
    expect(useAccountsStore.getState().accounts.size).toBe(1)
  })

  it('B9 主键保留: 同 userId 无论 profileArn 如何都判重复', () => {
    useAccountsStore.setState({
      accounts: new Map([
        ['a1', mkAcc({
          id: 'a1', email: 'x@y.com', userId: 'u-primary',
          credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }
        })]
      ])
    })

    const newAccount = mkAcc({
      id: 'a2', email: 'other@z.com', userId: 'u-primary',  // 同 userId
      credentials: { provider: 'ExternalIdp', profileArn: 'arn:VERY-DIFFERENT' }
    })
    const result = useAccountsStore.getState().importFromExportData({
      version: '1',
      exportedAt: Date.now(),
      accounts: [newAccount],
      groups: [],
      tags: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(result.success).toBe(0)
    expect(useAccountsStore.getState().accounts.size).toBe(1)
  })

  it('B9 向后兼容: 无 profileArn 的旧账户 → 副键仍是 (email, provider),同 email+provider 判重复', () => {
    useAccountsStore.setState({
      accounts: new Map([
        ['a1', mkAcc({
          id: 'a1', email: 'legacy@y.com', userId: 'u-old',
          credentials: { provider: 'BuilderId', profileArn: undefined }
        })]
      ])
    })

    const newAccount = mkAcc({
      id: 'a2', email: 'legacy@y.com', userId: 'u-new',
      credentials: { provider: 'BuilderId', profileArn: undefined }
    })
    const result = useAccountsStore.getState().importFromExportData({
      version: '1',
      exportedAt: Date.now(),
      accounts: [newAccount],
      groups: [],
      tags: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(result.success).toBe(0)
    expect(useAccountsStore.getState().accounts.size).toBe(1)
  })
})
