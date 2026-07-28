// TDD 红灯:账号管理页切换账号 → 反代实时跟随(单账号模式)
// RCA: .agent-workspace/.archive/2026-07-28/proxy-hot-switch-single-account/
//
// 根因:AccountCard.tsx:294 / AccountListRow.tsx:218 / store 自动切换分支只更新渲染进程
// store 的 activeAccountId,从未把「当前该用哪个账号」传播到主进程反代 ⇒ 请求继续打旧账号,
// 只有 stop→start(重建账号池)才生效。本文件锁住收口 action 的契约。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'

function mkAcc(overrides: Partial<Account> & { credentials?: Partial<Account['credentials']> }): Account {
  return {
    id: overrides.id || 'acc-1',
    email: overrides.email ?? 'b@example.com',
    idp: 'BuilderId',
    credentials: {
      accessToken: 'at-v2',
      csrfToken: '',
      refreshToken: 'rt-v2',
      clientId: 'cid',
      clientSecret: 'csec',
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'sso',
      provider: 'BuilderId',
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

type Call = { name: string; arg?: unknown }

function installApi(opts: { running: boolean; enableMultiAccount?: boolean }): Call[] {
  const calls: Call[] = []
  const api = {
    proxyGetStatus: vi.fn(async () => {
      calls.push({ name: 'proxyGetStatus' })
      return {
        running: opts.running,
        config: { enableMultiAccount: opts.enableMultiAccount ?? false, selectedAccountIds: ['acc-OLD'] },
        stats: null
      }
    }),
    updateProxyPoolMembers: vi.fn(async (payload: unknown) => {
      calls.push({ name: 'updateProxyPoolMembers', arg: payload })
      return { success: true }
    }),
    proxyUpdateConfig: vi.fn(async (cfg: unknown) => {
      calls.push({ name: 'proxyUpdateConfig', arg: cfg })
      return { success: true }
    }),
    setActiveProxyAccount: vi.fn(async (id: string) => {
      calls.push({ name: 'setActiveProxyAccount', arg: id })
      return { success: true }
    })
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window =
    (globalThis as unknown as { window?: Record<string, unknown> }).window || {}
  ;((globalThis as unknown as { window: Record<string, unknown> }).window as { api?: unknown }).api = api
  return calls
}

beforeEach(() => {
  useAccountsStore.setState({ accounts: new Map([['acc-1', mkAcc({ id: 'acc-1' })]]) })
})

describe('store.syncActiveAccountToProxy · 把 active 账号传播到反代', () => {
  it('反代未运行 → no-op,不抛错,不动配置', async () => {
    const calls = installApi({ running: false })
    const r = await useAccountsStore.getState().syncActiveAccountToProxy('acc-1')
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('not_running')
    expect(calls.map(c => c.name)).toEqual(['proxyGetStatus'])
  })

  it('单账号模式 → 顺序必须是 先入池 → 写 selectedAccountIds → setActive', async () => {
    const calls = installApi({ running: true, enableMultiAccount: false })
    const r = await useAccountsStore.getState().syncActiveAccountToProxy('acc-1')
    expect(r.applied).toBe(true)
    expect(r.mode).toBe('single')
    expect(calls.map(c => c.name)).toEqual([
      'proxyGetStatus',
      'updateProxyPoolMembers',
      'proxyUpdateConfig',
      'setActiveProxyAccount'
    ])
    expect(calls.find(c => c.name === 'proxyUpdateConfig')?.arg).toEqual({ selectedAccountIds: ['acc-1'] })
    expect(calls.find(c => c.name === 'setActiveProxyAccount')?.arg).toBe('acc-1')
  })

  it('入池入参取自 store 现值(刷新后的 refreshToken),而非调用方传入的旧快照', async () => {
    const calls = installApi({ running: true, enableMultiAccount: false })
    await useAccountsStore.getState().syncActiveAccountToProxy('acc-1')
    const payload = calls.find(c => c.name === 'updateProxyPoolMembers')?.arg as {
      add: Array<{ id: string; accessToken: string; refreshToken: string; clientSecret?: string }>
    }
    expect(payload.add).toHaveLength(1)
    expect(payload.add[0].id).toBe('acc-1')
    expect(payload.add[0].accessToken).toBe('at-v2')
    expect(payload.add[0].refreshToken).toBe('rt-v2')
    expect(payload.add[0].clientSecret).toBe('csec')
  })

  it('多账号模式 → 不写 selectedAccountIds(轮询范围由分组决定)', async () => {
    const calls = installApi({ running: true, enableMultiAccount: true })
    const r = await useAccountsStore.getState().syncActiveAccountToProxy('acc-1')
    expect(r.applied).toBe(true)
    expect(r.mode).toBe('multi')
    expect(calls.map(c => c.name)).not.toContain('proxyUpdateConfig')
  })

  it('账号不存在 / 无 accessToken → no-op 返回 no_credentials', async () => {
    const calls = installApi({ running: true, enableMultiAccount: false })
    const r = await useAccountsStore.getState().syncActiveAccountToProxy('acc-NOPE')
    expect(r.applied).toBe(false)
    expect(r.reason).toBe('no_credentials')
    expect(calls.map(c => c.name)).toEqual(['proxyGetStatus'])
  })
})
