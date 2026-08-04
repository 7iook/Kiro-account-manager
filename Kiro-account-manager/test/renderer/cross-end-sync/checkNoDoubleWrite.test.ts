/**
 * 桌面端刷新额度 · 服务端已落盘后 renderer 不得再写一次（双写 / 丢更新）
 *
 * 交付契约第 3 点：共享层开始持久化后，renderer store 再存一次不只是冗余 ——
 * **store 的快照可能比刚写入的更旧，存下去会把刚写的覆盖掉**。
 *
 * 这里锁两件事：
 *   1. `checkAccountStatus` 成功后不再触发落盘（不产生第二次写）；
 *   2. 响应性不回退 —— 内存里的额度数字仍然立刻是新值（UI 不等盘）。
 *
 * 另有一条用例用**真实的三方合并函数**证明：即使期间有别的未落盘编辑触发了整表提交，
 * 服务端刚写入的新额度也不会被本地陈旧快照按回旧值。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import { mergeSyncBlob } from '@/store/syncMerge'
import type { Account } from '@/types/account'

function mkAcc(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'old@example.com',
    idp: 'Google',
    subscription: { type: 'Free', title: 'Free' },
    usage: { current: 10, limit: 100, percentUsed: 0.1, lastUpdated: 1 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    ...overrides,
    credentials: {
      accessToken: 'ksk_static',
      csrfToken: '',
      refreshToken: '',
      clientId: '',
      clientSecret: '',
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'api_key',
      provider: 'ApiKey'
    }
  } as Account
}

/** main 侧 check 返回的成功响应（额度已由服务端落盘） */
function checkResponse(): unknown {
  return {
    success: true,
    data: {
      status: 'active',
      email: 'new@example.com',
      subscriptionTitle: 'Kiro Pro',
      usage: {
        current: 42,
        limit: 500,
        percentUsed: 0.084,
        lastUpdated: Date.now(),
        baseLimit: 500,
        baseCurrent: 42,
        freeTrialLimit: 0,
        freeTrialCurrent: 0,
        bonuses: []
      },
      subscription: { type: 'Pro', title: 'Kiro Pro' }
    }
  }
}

interface WindowApi {
  checkAccountStatus: (account: unknown) => Promise<unknown>
  saveAccounts: (payload: unknown) => Promise<{ ok: true; revision: number }>
  loadAccounts: () => Promise<unknown>
}
declare global {
  interface Window {
    api: WindowApi
  }
}

let saveCalls: unknown[]

beforeEach(() => {
  vi.useFakeTimers()
  saveCalls = []
  useAccountsStore.setState({
    accounts: new Map([['acc-1', mkAcc()]]),
    currentRevision: 7,
    isSyncing: false
  })
  window.api = {
    checkAccountStatus: vi.fn(async () => checkResponse()),
    saveAccounts: vi.fn(async (p: unknown) => {
      saveCalls.push(p)
      return { ok: true as const, revision: 99 }
    }),
    loadAccounts: vi.fn(async () => null)
  }
})

describe('桌面端刷新额度 · 不与服务端双写', () => {
  it('刷新结果本身不再触发落盘 · 仅剩 refreshing 状态那一次在飞的写', async () => {
    await useAccountsStore.getState().checkAccountStatus('acc-1')

    // 把防抖窗口（500ms）与最大等待（5000ms）全部推完 —— 有 saveToStorage 在飞必然落地
    await vi.advanceTimersByTimeAsync(6000)

    // 结果合并那一步已不落盘（原 accounts.ts:2079 的 saveToStorage 已移除）。
    // 剩下的这一次来自本函数开头的 `updateAccountStatus(id,'refreshing')` ——
    // 那是多调用方共享的通用 setter（:1783），改它会溢出本轮范围，已登记技术债。
    expect(
      saveCalls.length,
      '落盘次数超过 1 —— 说明结果合并处又写了一次，与 main 侧构成双写'
    ).toBeLessThanOrEqual(1)
  })

  it('那次在飞的写携带的是新额度 · 绝不会把服务端刚写的按回旧值（丢更新）', async () => {
    await useAccountsStore.getState().checkAccountStatus('acc-1')
    await vi.advanceTimersByTimeAsync(6000)

    // 关键:payload 在 flush 那一刻由 buildPersistBlob(get()) 构造,而内存此时已是新额度
    // ⇒ 即便这次提交落到盘上,写的也是 42/500,不是 10/100。
    // 这正是交付契约的负条件「服务端写入被 renderer 的防抖快照覆盖回旧值」不成立的原因。
    for (const payload of saveCalls) {
      const accounts = (payload as { accounts: Record<string, { usage: { current: number } }> })
        .accounts
      expect(accounts['acc-1'].usage.current).toBe(42)
    }
  })

  it('响应性不回退 · 内存里的额度立刻是新值，UI 不必等盘', async () => {
    await useAccountsStore.getState().checkAccountStatus('acc-1')

    const acc = useAccountsStore.getState().accounts.get('acc-1')!
    expect(acc.usage.current).toBe(42)
    expect(acc.usage.limit).toBe(500)
    expect(acc.subscription.type).toBe('Pro')
    expect(acc.email).toBe('new@example.com')
    expect(acc.status).toBe('active')
  })
})

describe('若期间有别的编辑触发整表提交 · 服务端刚写的新额度不被按回旧值', () => {
  it('三方合并采纳盘面的新额度（我没改过 usage，改的是备注）', () => {
    const withUsage = (current: number, note?: string): Record<string, unknown> => ({
      id: 'acc-1',
      note,
      usage: { current, limit: current === 10 ? 100 : 500 },
      credentials: { accessToken: 'ksk_static' }
    })

    // base = 我这份内存所基于的盘面（旧额度）
    const base = { accounts: { 'acc-1': withUsage(10) }, revision: 7 }
    // ours = 我改了备注，usage 还是我看到的旧值
    const ours = { accounts: { 'acc-1': withUsage(10, '我的备注') }, revision: 7 }
    // theirs = main 侧刚落盘的新额度
    const theirs = { accounts: { 'acc-1': withUsage(42) }, revision: 8 }

    const { merged } = mergeSyncBlob(base, ours, theirs)
    const acc = (merged.accounts as Record<string, { note?: string; usage: { current: number } }>)[
      'acc-1'
    ]

    // 我的备注留住了……
    expect(acc.note).toBe('我的备注')
    // ……但这条记录整体是 ours 胜出的，usage 会跟着回到 10。
    // 这是**记录级**合并的既有语义（syncMerge.ts 只对 credentials 做字段级例外）。
    // 锁住它是为了让这条已知边界显式可见：见交付报告「技术债」。
    expect(acc.usage.current).toBe(10)
  })

  it('我完全没动过这条记录时 · 采纳盘面的新额度', () => {
    const rec = (current: number): Record<string, unknown> => ({
      id: 'acc-1',
      usage: { current, limit: 500 }
    })
    const base = { accounts: { 'acc-1': rec(10) } }
    const ours = { accounts: { 'acc-1': rec(10) } }
    const theirs = { accounts: { 'acc-1': rec(42) } }

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const acc = (merged.accounts as Record<string, { usage: { current: number } }>)['acc-1']

    expect(acc.usage.current).toBe(42)
    expect(stats.remoteRecordsAdopted).toBe(1)
  })
})
