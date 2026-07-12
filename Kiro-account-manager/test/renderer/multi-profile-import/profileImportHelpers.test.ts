/**
 * 多 profile 导入 · pure fn helper 测试
 * 覆盖决策卡 v2 §4 B1(N=1 auto)/B2(N≥2 select)/B8(isAccountExists 三元组)/B10(串行 batch 失败不阻塞)
 *
 * 为什么走 helper 而非 render AddAccountDialog:
 * AddAccountDialog 2153 行,深度耦合 zustand store + i18n + window.api + 若干子 dialog。
 * 端到端挂载脆弱且难 mock。抽出 pure fn 是 §4.3 SSOT + §4.5 TDD 推荐的最小可测实体。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  pickProfileImportStrategy,
  collectAlreadyImportedArns,
  isProfileAlreadyImported,
  runBatchProfileImport
} from '@/components/accounts/profileImportHelpers'
import type { Account } from '@/types/account'

function mkAccount(overrides: Partial<Account> & { credentials?: Partial<Account['credentials']> }): Account {
  const base: Account = {
    id: overrides.id || 'acc-' + Math.random().toString(36).slice(2, 8),
    email: overrides.email ?? 'user@example.com',
    userId: overrides.userId ?? 'uid-1',
    idp: overrides.idp ?? 'ExternalIdp',
    credentials: {
      accessToken: '',
      csrfToken: '',
      refreshToken: '',
      clientId: '',
      clientSecret: '',
      region: 'us-east-1',
      expiresAt: 0,
      authMethod: 'external_idp',
      provider: 'ExternalIdp',
      ...(overrides.credentials || {})
    },
    subscription: { type: 'FREE', title: 'FREE' } as Account['subscription'],
    usage: {
      current: 0, limit: 0, percentUsed: 0, lastUpdated: 0
    } as Account['usage'],
    tags: [],
    status: 'active',
    lastUsedAt: 0
  } as Account
  return { ...base, ...overrides, credentials: base.credentials }
}

function toMap(accs: Account[]): Map<string, Account> {
  return new Map(accs.map(a => [a.id, a]))
}

describe('profileImportHelpers · pickProfileImportStrategy', () => {
  it('B1: profiles=undefined → mode=auto(走原自动导入路径)', () => {
    const strategy = pickProfileImportStrategy(undefined, new Map(), 'a@b.com')
    expect(strategy.mode).toBe('auto')
  })

  it('B1: profiles=[] → mode=auto(拿不到 profile,登录 token 仍已成功,不阻塞)', () => {
    const strategy = pickProfileImportStrategy([], new Map(), 'a@b.com')
    expect(strategy.mode).toBe('auto')
  })

  it('B1: profiles=[单元素] → mode=auto(N=1 走原路径,零 UI 变化)', () => {
    const strategy = pickProfileImportStrategy(
      [{ profileArn: 'arn:1' }],
      new Map(),
      'a@b.com'
    )
    expect(strategy.mode).toBe('auto')
  })

  it('B2: profiles=[≥2 元素] → mode=select(弹选择框)', () => {
    const strategy = pickProfileImportStrategy(
      [{ profileArn: 'arn:1', profileName: 'A' }, { profileArn: 'arn:2', profileName: 'B' }],
      new Map(),
      'a@b.com'
    )
    expect(strategy.mode).toBe('select')
    if (strategy.mode === 'select') {
      expect(strategy.profiles).toHaveLength(2)
      expect(strategy.alreadyImportedArns.size).toBe(0)
    }
  })

  it('B2/B4 依据: mode=select 应携带 alreadyImportedArns(同 email + provider 已导入的 profileArn 集合)', () => {
    const accounts = toMap([
      mkAccount({
        id: 'a1', email: 'x@y.com', userId: 'u1',
        credentials: { provider: 'ExternalIdp', profileArn: 'arn:already-1' }
      }),
      mkAccount({
        id: 'a2', email: 'x@y.com', userId: 'u2',
        credentials: { provider: 'IdC', profileArn: 'arn:already-idc' }
      }),
      // 不同 email 应被忽略
      mkAccount({
        id: 'a3', email: 'other@y.com', userId: 'u3',
        credentials: { provider: 'ExternalIdp', profileArn: 'arn:other' }
      })
    ])
    const strategy = pickProfileImportStrategy(
      [
        { profileArn: 'arn:already-1' },
        { profileArn: 'arn:new-1' },
        { profileArn: 'arn:already-idc' }
      ],
      accounts,
      'x@y.com'
    )
    expect(strategy.mode).toBe('select')
    if (strategy.mode === 'select') {
      expect(strategy.alreadyImportedArns.has('arn:already-1')).toBe(true)
      expect(strategy.alreadyImportedArns.has('arn:already-idc')).toBe(true)
      expect(strategy.alreadyImportedArns.has('arn:other')).toBe(false)
      expect(strategy.alreadyImportedArns.has('arn:new-1')).toBe(false)
    }
  })
})

describe('profileImportHelpers · collectAlreadyImportedArns', () => {
  it('只筛入同 email + provider 在允许清单里的账户,且需带 profileArn', () => {
    const accounts = toMap([
      mkAccount({ id: '1', email: 'x@y.com', credentials: { provider: 'ExternalIdp', profileArn: 'arn:a' } }),
      mkAccount({ id: '2', email: 'x@y.com', credentials: { provider: 'IdC', profileArn: 'arn:b' } }),
      mkAccount({ id: '3', email: 'x@y.com', credentials: { provider: 'BuilderId', profileArn: 'arn:c' } }),
      mkAccount({ id: '4', email: 'x@y.com', credentials: { provider: 'ExternalIdp', profileArn: '' } }),
      mkAccount({ id: '5', email: 'other@y.com', credentials: { provider: 'ExternalIdp', profileArn: 'arn:d' } })
    ])
    const result = collectAlreadyImportedArns(accounts, 'x@y.com', ['ExternalIdp', 'IdC'])
    expect(result.has('arn:a')).toBe(true)
    expect(result.has('arn:b')).toBe(true)
    expect(result.has('arn:c')).toBe(false)
    expect(result.has('arn:d')).toBe(false)
    expect(result.size).toBe(2)
  })
})

describe('profileImportHelpers · isProfileAlreadyImported (B8 renderer 侧 sweep 语义)', () => {
  it('B8: 同 email + 同 provider,不同 profileArn → 不算已存在(允许多 profile 并存)', () => {
    const accounts = toMap([
      mkAccount({
        id: '1', email: 'x@y.com', userId: 'u1',
        credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }
      })
    ])
    expect(isProfileAlreadyImported(accounts, 'x@y.com', 'ExternalIdp', 'arn:B')).toBe(false)
  })

  it('B8: 同 email + 同 provider + 同 profileArn → 判为已存在', () => {
    const accounts = toMap([
      mkAccount({
        id: '1', email: 'x@y.com', userId: 'u1',
        credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }
      })
    ])
    expect(isProfileAlreadyImported(accounts, 'x@y.com', 'ExternalIdp', 'arn:A')).toBe(true)
  })

  it('B8: 不同 email 或不同 provider → 不算已存在', () => {
    const accounts = toMap([
      mkAccount({
        id: '1', email: 'x@y.com',
        credentials: { provider: 'ExternalIdp', profileArn: 'arn:A' }
      })
    ])
    expect(isProfileAlreadyImported(accounts, 'other@y.com', 'ExternalIdp', 'arn:A')).toBe(false)
    expect(isProfileAlreadyImported(accounts, 'x@y.com', 'IdC', 'arn:A')).toBe(false)
  })
})

describe('profileImportHelpers · runBatchProfileImport (B10 串行 · 失败不阻塞)', () => {
  it('B10: 选中 M 个 profile → 串行 M 次 verify + M 次 addAccount', async () => {
    const profiles = [
      { profileArn: 'arn:1', profileName: 'A' },
      { profileArn: 'arn:2', profileName: 'B' },
      { profileArn: 'arn:3', profileName: 'C' }
    ]
    const verifyFn = vi.fn().mockImplementation(async (arn: string) => ({
      success: true,
      data: { email: 'x@y.com', userId: `uid-${arn}`, accessToken: 'at', refreshToken: 'rt', profileArn: arn }
    }))
    const addAccountFn = vi.fn()

    const result = await runBatchProfileImport({
      selected: profiles,
      verifyForProfile: verifyFn,
      addAccountForVerify: addAccountFn,
      isDuplicate: () => false
    })

    expect(verifyFn).toHaveBeenCalledTimes(3)
    expect(addAccountFn).toHaveBeenCalledTimes(3)
    expect(result.successCount).toBe(3)
    expect(result.errors).toHaveLength(0)
  })

  it('B10: 其中一个 verify 失败 → 记录错误但继续处理其余(不阻塞)', async () => {
    const profiles = [
      { profileArn: 'arn:1' },
      { profileArn: 'arn:2' },
      { profileArn: 'arn:3' }
    ]
    const verifyFn = vi.fn().mockImplementation(async (arn: string) => {
      if (arn === 'arn:2') return { success: false, error: 'verify fail' }
      return {
        success: true,
        data: { email: 'x@y.com', userId: `uid-${arn}`, accessToken: 'at', refreshToken: 'rt', profileArn: arn }
      }
    })
    const addAccountFn = vi.fn()

    const result = await runBatchProfileImport({
      selected: profiles,
      verifyForProfile: verifyFn,
      addAccountForVerify: addAccountFn,
      isDuplicate: () => false
    })

    expect(verifyFn).toHaveBeenCalledTimes(3)
    expect(addAccountFn).toHaveBeenCalledTimes(2)
    expect(result.successCount).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].profileArn).toBe('arn:2')
  })

  it('B10: verify 抛异常 → 记录错误继续下一个,不整体崩', async () => {
    const profiles = [
      { profileArn: 'arn:1' },
      { profileArn: 'arn:2' }
    ]
    const verifyFn = vi.fn().mockImplementation(async (arn: string) => {
      if (arn === 'arn:1') throw new Error('boom')
      return {
        success: true,
        data: { email: 'x@y.com', userId: `uid-${arn}`, accessToken: 'at', refreshToken: 'rt', profileArn: arn }
      }
    })
    const addAccountFn = vi.fn()

    const result = await runBatchProfileImport({
      selected: profiles,
      verifyForProfile: verifyFn,
      addAccountForVerify: addAccountFn,
      isDuplicate: () => false
    })

    expect(result.successCount).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].profileArn).toBe('arn:1')
    expect(result.errors[0].message).toContain('boom')
  })

  it('B10: isDuplicate 命中的 profile 应跳过 verify+addAccount 并进错误清单', async () => {
    const profiles = [{ profileArn: 'arn:dup' }, { profileArn: 'arn:new' }]
    const verifyFn = vi.fn().mockResolvedValue({
      success: true,
      data: { email: 'x@y.com', userId: 'uid-new', accessToken: 'at', refreshToken: 'rt', profileArn: 'arn:new' }
    })
    const addAccountFn = vi.fn()
    const isDuplicate = vi.fn().mockImplementation((profileArn: string) => profileArn === 'arn:dup')

    const result = await runBatchProfileImport({
      selected: profiles,
      verifyForProfile: verifyFn,
      addAccountForVerify: addAccountFn,
      isDuplicate
    })

    expect(verifyFn).toHaveBeenCalledTimes(1)
    expect(verifyFn).toHaveBeenCalledWith('arn:new')
    expect(addAccountFn).toHaveBeenCalledTimes(1)
    expect(result.successCount).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].profileArn).toBe('arn:dup')
  })
})
