/**
 * 桌面端不回归 · 主进程开始落盘后，渲染进程那条路仍然正确
 *
 * 交付契约要求「桌面端必须仍然在盘上得到正确的 token」。本轮把落盘搬进主进程后，
 * 桌面端同一份事实有了两个出口:
 *   ① 主进程 `backgroundBatchRefresh` → `persistBatchRefreshResults`（新增，权威）
 *   ② 渲染进程 `applyBackgroundRefreshResults`（既有，只改 zustand 内存）
 *
 * ## 为什么②保留、而且不构成双写
 *
 * 实测(本文件第一组用例)：`applyBackgroundRefreshResults` 尾部**没有** `saveToStorage()` ——
 * 它与其余 25 个 store 写入口不同，本来就只更新内存。所以它:
 *   - **不是**第二个写盘者 ⇒ 不存在「renderer 的陈旧整表快照把 main 刚写的按回旧值」;
 *   - 是桌面端「刷完立刻看到新过期时间」的响应性来源 ⇒ 删掉它 UI 会等到下一次
 *     reload 才更新，是纯回归。
 *
 * 因此结论是**保留②不动**（recon 的建议是「保留 renderer 的 saveToStorage 作为兜底」——
 * 那条建议的前提不成立：那里压根没有 saveToStorage 可保留）。
 *
 * ## 内存与盘面的收敛
 *
 * 主进程写盘成功后广播 `accounts-data-changed`，App.tsx 的 consumer 判定为外部写 →
 * `reconcilePendingExternalRevision` 对齐盘面;广播万一丢失，focus / visibilitychange /
 * 短轮询兜底。故②的内存值与①的盘面值最终一致，且**凭据字段**在三方合并里有
 * `syncMerge.ts:mergeRecordWithCredentialException` 的字段级例外保护:
 * 「我没改过凭据而别人改了」⇒ 采纳 theirs ⇒ 新 refreshToken 不会被本地陈旧快照回滚。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import { mergeSyncBlob } from '@/store/syncMerge'
import type { Account } from '@/types/account'

function mkAcc(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'a@example.com',
    idp: 'Google',
    subscription: { type: 'Free', title: 'Free' },
    usage: { current: 10, limit: 100, percentUsed: 0.1, lastUpdated: 1 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    ...overrides,
    credentials: {
      accessToken: 'access-v1',
      csrfToken: '',
      refreshToken: 'refresh-v1',
      clientId: 'cid',
      clientSecret: 'csec',
      region: 'us-east-1',
      expiresAt: 1_000,
      authMethod: 'social',
      provider: 'Google'
    }
  } as Account
}

interface WindowApi {
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
    saveAccounts: vi.fn(async (p: unknown) => {
      saveCalls.push(p)
      return { ok: true as const, revision: 99 }
    }),
    loadAccounts: vi.fn(async () => null)
  }
})

describe('渲染进程处理后台刷新结果 · 不与主进程双写', () => {
  it('结果合并只改内存、不触发落盘（主进程已是权威写者）', async () => {
    useAccountsStore.getState().applyBackgroundRefreshResults([
      {
        id: 'acc-1',
        success: true,
        data: { accessToken: 'access-v2', refreshToken: 'refresh-v2', expiresIn: 3600 }
      }
    ])

    // 把防抖窗口（500ms）与最大等待（5000ms）全部推完 —— 有 saveToStorage 在飞必然落地
    await vi.advanceTimersByTimeAsync(6000)

    expect(
      saveCalls,
      'applyBackgroundRefreshResults 触发了落盘 —— 与主进程构成双写，' +
        '且 renderer 的整表快照可能比 main 刚写的更旧（丢更新）'
    ).toHaveLength(0)
  })

  it('响应性不回退 · 内存里立刻是新 token，UI 不必等盘', () => {
    useAccountsStore.getState().applyBackgroundRefreshResults([
      {
        id: 'acc-1',
        success: true,
        data: { accessToken: 'access-v2', refreshToken: 'refresh-v2', expiresIn: 3600 }
      }
    ])

    const acc = useAccountsStore.getState().accounts.get('acc-1')!
    expect(acc.credentials.accessToken).toBe('access-v2')
    expect(acc.credentials.refreshToken).toBe('refresh-v2')
    expect(acc.credentials.expiresAt).toBeGreaterThan(Date.now())
    expect(acc.status).toBe('active')
  })

  it('刷新失败 ⇒ 内存标错误，同样不落盘（失败原因由主进程写盘）', async () => {
    useAccountsStore
      .getState()
      .applyBackgroundRefreshResults([{ id: 'acc-1', success: false, error: 'invalid_grant' }])
    await vi.advanceTimersByTimeAsync(6000)

    const acc = useAccountsStore.getState().accounts.get('acc-1')!
    expect(acc.status).toBe('error')
    expect(acc.lastError).toBe('invalid_grant')
    expect(saveCalls).toHaveLength(0)
  })
})

describe('若期间有别的编辑触发整表提交 · 主进程刚写的新凭据不被按回旧值', () => {
  it('凭据字段级例外：我没改过凭据而 main 改了 ⇒ 采纳盘面的新 refreshToken', () => {
    const rec = (access: string, refresh: string, note?: string): Record<string, unknown> => ({
      id: 'acc-1',
      note,
      credentials: { accessToken: access, refreshToken: refresh }
    })

    // base = 我这份内存所基于的盘面（旧凭据）
    const base = { accounts: { 'acc-1': rec('access-v1', 'refresh-v1') }, revision: 7 }
    // ours = 我只改了备注，凭据还是我看到的旧值
    const ours = { accounts: { 'acc-1': rec('access-v1', 'refresh-v1', '我的备注') }, revision: 7 }
    // theirs = 主进程后台刷新刚落盘的新凭据
    const theirs = { accounts: { 'acc-1': rec('access-v2', 'refresh-v2') }, revision: 8 }

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const acc = (
      merged.accounts as Record<
        string,
        { note?: string; credentials: { accessToken: string; refreshToken: string } }
      >
    )['acc-1']

    // 我的备注留住了……
    expect(acc.note).toBe('我的备注')
    // ……而凭据采纳了 main 刚写的新值（这正是「不需要重新登录」的保证）
    expect(acc.credentials.refreshToken).toBe('refresh-v2')
    expect(acc.credentials.accessToken).toBe('access-v2')
    expect(stats.remoteCredentialsAdopted).toBe(1)
  })
})
