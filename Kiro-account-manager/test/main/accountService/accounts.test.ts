/**
 * loadAccounts / saveAccounts · 账号数据读写业务函数（IPC 与 HTTP 面板共用）
 *
 * 抽取来源：index.ts:3540 (load-accounts) / :3555 (save-accounts) 的 handler 回调体。
 * 关键行为必须逐字保留（renderer 26 个组件已适配这些形状，"顺手统一"会全线炸）：
 *   - load 失败返回 null（不抛），日志前缀 'Failed to load accounts:'
 *   - save 走 applyAccountDataMutation 收口（revision 乐观锁），不得新开 store.set 路径
 *   - expectedRevision / originId 是仲裁参数，不入盘
 *   - 仅 ok 时才 setLastSavedData + createBackup（STALE 时不备份陈旧快照）
 *   - save 失败向上抛（renderer 依赖 reject 分支）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadAccounts, saveAccounts } from '../../../src/main/accountService/accounts'
import {
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster
} from '../../../src/main/accountService/state'
import type { AccountRuntimeDeps, AccountStoreRef } from '../../../src/main/accountService/types'

function makeStore(initial: Record<string, unknown> = {}): AccountStoreRef & { data: Record<string, unknown> } {
  const data = { ...initial }
  return {
    data,
    path: '/tmp/mock-store',
    get: (k: string, dv?: unknown) => (k in data ? data[k] : dv),
    set: (k: string, v: unknown) => {
      data[k] = v
    }
  }
}

describe('loadAccounts / saveAccounts · 账号数据读写', () => {
  let store: ReturnType<typeof makeStore>
  let deps: AccountRuntimeDeps
  let backups: unknown[]
  let lastSaved: unknown[]
  let ensureCalls: number

  beforeEach(() => {
    store = makeStore({ accountData: { accounts: { A: { id: 'A' } }, revision: 3 } })
    backups = []
    lastSaved = []
    ensureCalls = 0
    setStoreRef(store)
    setLastSavedDataSetter((d) => lastSaved.push(d))
    setBroadcaster(() => {})
    deps = {
      getStore: () => store,
      ensureStore: async () => {
        ensureCalls++
      },
      createBackup: async (d) => {
        backups.push(d)
      },
      setLastSavedData: (d) => lastSaved.push(d)
    }
  })

  it('打开账号列表时读到盘上的账号数据', async () => {
    const data = await loadAccounts(deps)
    expect(data).toMatchObject({ accounts: { A: { id: 'A' } }, revision: 3 })
    // 惰性 init 必须被触发过：HTTP 面板可能在窗口就绪前先发起请求
    expect(ensureCalls).toBe(1)
  })

  it('盘上还没有账号数据时返回 null，让前端走空列表而不是崩溃', async () => {
    store = makeStore({})
    deps.getStore = () => store
    setStoreRef(store)
    expect(await loadAccounts(deps)).toBeNull()
  })

  it('读盘异常时返回 null 而不是把异常抛给前端（保留既有容错）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.ensureStore = async () => {
      throw new Error('store corrupt')
    }
    expect(await loadAccounts(deps)).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('保存账号后 revision 递增，并留下崩溃恢复备份', async () => {
    const r = await saveAccounts(deps, {
      accounts: { A: { id: 'A' }, B: { id: 'B' } },
      expectedRevision: 3,
      originId: 'win-1'
    })
    expect(r).toEqual({ ok: true, revision: 4 })
    const persisted = store.data.accountData as Record<string, unknown>
    expect(persisted.revision).toBe(4)
    expect(Object.keys(persisted.accounts as object)).toEqual(['A', 'B'])
    expect(backups).toHaveLength(1)
  })

  it('仲裁参数 expectedRevision / originId 绝不落盘（否则盘上多出前端内部字段）', async () => {
    await saveAccounts(deps, { accounts: {}, expectedRevision: 3, originId: 'win-1' })
    const persisted = store.data.accountData as Record<string, unknown>
    expect(persisted).not.toHaveProperty('expectedRevision')
    expect(persisted).not.toHaveProperty('originId')
  })

  it('手机端与桌面端并发保存时，持陈旧 revision 的一方被拒且不覆盖对方数据', async () => {
    const r = await saveAccounts(deps, { accounts: {}, expectedRevision: 1 })
    expect(r).toEqual({ ok: false, code: 'STALE_REVISION', currentRevision: 3 })
    // 被拒的写入不能污染盘上数据，也不能留下"陈旧快照的备份"
    expect((store.data.accountData as Record<string, unknown>).revision).toBe(3)
    expect(Object.keys((store.data.accountData as { accounts: object }).accounts)).toEqual(['A'])
    expect(backups).toHaveLength(0)
  })

  it('未传 expectedRevision 时降级为直写（兼容旧 renderer 调用点）', async () => {
    const r = await saveAccounts(deps, { accounts: { Z: { id: 'Z' } } })
    expect(r).toEqual({ ok: true, revision: 4 })
  })

  it('写盘异常向上抛，让前端能显示保存失败而不是静默成功', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.ensureStore = async () => {
      throw new Error('disk full')
    }
    await expect(saveAccounts(deps, { accounts: {} })).rejects.toThrow('disk full')
    errSpy.mockRestore()
  })

  it('saveAccounts 不修改调用方传入的 payload 对象（防止 renderer 侧快照被就地篡改）', async () => {
    const payload = { accounts: { A: { id: 'A' } }, expectedRevision: 3, originId: 'w' }
    const snapshot = JSON.stringify(payload)
    await saveAccounts(deps, payload)
    expect(JSON.stringify(payload)).toBe(snapshot)
  })

  it('启动加载发现记录身份与既有机器码历史不符时点名报告，且绝不改数据', async () => {
    store = makeStore({
      accountData: {
        accounts: {
          A: { id: 'A', email: 'b@example.com', userId: 'user-B' }
        },
        machineIdHistory: [
          {
            id: 'machine-history-1',
            machineId: 'a'.repeat(64),
            timestamp: 1,
            action: 'bind',
            accountId: 'A',
            accountEmail: 'a@example.com'
          }
        ],
        revision: 3
      }
    })
    deps.getStore = () => store
    setStoreRef(store)
    const before = JSON.stringify(store.data.accountData)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await loadAccounts(deps)
      await loadAccounts(deps)

      const auditCalls = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('[AccountIdentityAudit]')
      )
      expect(auditCalls).toHaveLength(1)
      expect(String(auditCalls[0][0])).toContain('A')
      expect(String(auditCalls[0][0])).toContain('report-only')
      expect(JSON.stringify(store.data.accountData)).toBe(before)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('历史已记录 email 而当前记录将其清空时同样报告，不让“先清空”逃过审计', async () => {
    store = makeStore({
      accountData: {
        accounts: {
          A: { id: 'A', userId: 'user-A' }
        },
        machineIdHistory: [
          {
            accountId: 'A',
            accountEmail: 'a@example.com'
          }
        ],
        revision: 3
      }
    })
    deps.getStore = () => store
    setStoreRef(store)
    const before = JSON.stringify(store.data.accountData)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await loadAccounts(deps)

      const auditCalls = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('HISTORICAL_IDENTITY_MISMATCH')
      )
      expect(auditCalls).toHaveLength(1)
      expect(String(auditCalls[0][0])).toContain('fields=email')
      expect(JSON.stringify(store.data.accountData)).toBe(before)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('启动加载发现多条记录指向同一 id 时点名报告，且不按 id 外形猜测或清理', async () => {
    store = makeStore({
      accountData: {
        accounts: {
          slot1: { id: 'shared-record-id', email: 'a@example.com', userId: 'user-A' },
          slot2: { id: 'shared-record-id', email: 'b@example.com', userId: 'user-B' }
        },
        revision: 3
      }
    })
    deps.getStore = () => store
    setStoreRef(store)
    const before = JSON.stringify(store.data.accountData)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await loadAccounts(deps)

      const duplicateCalls = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('DUPLICATE_RECORD_ID')
      )
      expect(duplicateCalls).toHaveLength(1)
      expect(String(duplicateCalls[0][0])).toContain('shared-record-id')
      expect(JSON.stringify(store.data.accountData)).toBe(before)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
