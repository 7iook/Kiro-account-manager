/**
 * ksk_ 导入后额度停在 0/0 —— store 同步竞态被静默 return 吞掉
 *
 * 病灶(回归自 fce8c89 "ksk_ 导入下沉共享层"):
 *   老代码 renderer 自己 `addAccount(...)`(zustand 同步 set),返回的 newId 立刻能
 *   `accounts.get(newId)` 拿到,所以紧接着的 `void checkAccountStatus(id)` 必然命中。
 *
 *   下沉后 renderer 不再 addAccount,改为依赖主进程写盘 + `accounts-data-changed`
 *   广播 → App.tsx:150 → `reloadFromStorageQuiet` 对齐盘面。但 AddAccountDialog 在
 *   `await window.api.importApiKeys(...)` resolve 的**同一个 tick** 就调
 *   `void checkAccountStatus(r.accountId)` —— 广播 → 读盘 → 解密 → set 这条异步链
 *   往往还没跑完,`accounts.get(id)` 返回 undefined,撞上
 *
 *       if (!account) return        // ← 无日志、无报错、无重试
 *
 *   于是 IPC 从未发出、main 侧那次 applyAccountDataMutation 落盘从未发生,
 *   额度永远停在 importApiKey.ts 写的占位值 { current: 0, limit: 0 } → 界面 0/0。
 *   用户手动点「检查账户信息」却能刷出来(那时 store 已同步),与实测日志一致:
 *   region=eu-central-1 → 200 → usageBreakdownList[0] = { currentUsage 2672.06,
 *   usageLimit 10000 } —— 协议层与 parseUsage 全部正常,唯一断点就是这次 check 没跑。
 *
 * 本测试守护:store 尚未同步时,checkAccountStatus 先 reloadFromStorageQuiet 自愈再重试,
 * 不再静默放弃;确实找不到时也要留下可观测痕迹(而非无声)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'

function mkApiKeyAcc(id: string): Account {
  return {
    id,
    email: '', // ksk_ 账号导入时无邮箱(靠 check 回填)
    nickname: 'API Key abc123',
    idp: 'ApiKey',
    subscription: { type: 'Pro', title: 'KIRO POWER' },
    // 导入占位值 —— 正是用户看到的 0/0
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    credentials: {
      accessToken: 'ksk_xxx',
      csrfToken: '',
      refreshToken: '',
      region: 'eu-central-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'api_key',
      provider: 'ApiKey'
    }
  } as Account
}

/** 真实响应形态:limits 为 null,额度在 usageBreakdownList[0](实测 2026-08-05) */
const REAL_USAGE = { current: 2672.06, limit: 10000, lastUpdated: Date.now() }

function installApiMock(sink: unknown[]) {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    checkAccountStatus: vi.fn(async (acc: unknown) => {
      sink.push(acc)
      return {
        success: true,
        data: { status: 'active', usage: REAL_USAGE, subscription: { type: 'Pro', title: 'KIRO POWER' } }
      }
    }),
    saveAccounts: vi.fn(async () => {}),
    triggerWebhook: vi.fn(async () => {}),
    proxySyncAccounts: vi.fn(async () => ({ success: true }))
  }
}

beforeEach(() => {
  useAccountsStore.setState({ accounts: new Map() })
})

describe('checkAccountStatus · store 未同步时不再静默放弃', () => {
  it('accounts 里还没有该 id 时,先 reloadFromStorageQuiet 自愈再重试,额度真的落进 store', async () => {
    const calls: unknown[] = []
    installApiMock(calls)

    // 模拟真实竞态:store 为空(广播尚未处理完),reload 才把新账号带进来
    const reloadSpy = vi.fn(async () => {
      useAccountsStore.setState({ accounts: new Map([['new-1', mkApiKeyAcc('new-1')]]) })
    })
    useAccountsStore.setState({ reloadFromStorageQuiet: reloadSpy })

    await useAccountsStore.getState().checkAccountStatus('new-1')

    // 1) 触发了 reload 自愈
    expect(reloadSpy).toHaveBeenCalled()
    // 2) reload 后确实把 check 打了出去 —— 旧实现在此静默 return,这里是 0
    expect(calls.length).toBe(1)
    // 3) 真实额度落进 store,不再是 0/0
    const after = useAccountsStore.getState().accounts.get('new-1')
    expect(after?.usage.limit).toBe(10000)
    expect(after?.usage.current).toBeCloseTo(2672.06, 2)
    // 4) percentUsed 必须是 0~1 比例(与 usage-percent-ssot 口径一致),不是 26
    expect(after?.usage.percentUsed).toBeCloseTo(0.267206, 4)
  })

  it('store 已有该账号时不做多余 reload(不给正常路径加一次读盘)', async () => {
    const calls: unknown[] = []
    installApiMock(calls)

    const reloadSpy = vi.fn(async () => {})
    useAccountsStore.setState({
      accounts: new Map([['have-1', mkApiKeyAcc('have-1')]]),
      reloadFromStorageQuiet: reloadSpy
    })

    await useAccountsStore.getState().checkAccountStatus('have-1')

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(calls.length).toBe(1)
    expect(useAccountsStore.getState().accounts.get('have-1')?.usage.limit).toBe(10000)
  })

  it('reload 后依然找不到(真的不存在)→ 不发 IPC,但留下可观测告警', async () => {
    const calls: unknown[] = []
    installApiMock(calls)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reloadSpy = vi.fn(async () => {}) // reload 也带不出来
    useAccountsStore.setState({ reloadFromStorageQuiet: reloadSpy })

    await useAccountsStore.getState().checkAccountStatus('ghost-1')

    expect(reloadSpy).toHaveBeenCalled()
    expect(calls.length).toBe(0)
    // 关键:不能再是无声失败 —— 这次排查正是因为零日志才只能靠读源码定位
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('ghost-1')

    warn.mockRestore()
  })
})
