/**
 * 决策卡 §1 不变量 2/3 + recon-revision-sync.md §4/7 · TDD Red→Green
 *
 * 覆盖场景（每个 it 名 = 真实业务场景,非"test STALE_REVISION"这种技术描述）:
 *   1. ProactiveRenewal 刷 token 时用户同时删账号 · 删除不能丢
 *   2. web 端提交陈旧 revision · 服务端明确拒收让客户端能重取
 *   3. 两个客户端连点同一按钮 · 只能生效一次不能双写
 *   4. 广播 payload 只带 revision 与 changedIds · 绝不含 accessToken 等敏感字段
 *   5. renderer 收到自己刚发起写的广播 · 反检责任在 consumer 层（本 test 只固定 producer 语义）
 *   6. backup restore 后 revision 从 0 重启 · 客户端持旧 revision 会正确收到 STALE
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  applyAccountDataMutation,
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster,
  type BroadcastPayload,
  type AccountsBlob
} from '../../../src/main/accountService/state'

/** 极简 in-memory store,同步 API,匹配 electron-store 的 get/set 契约 */
function makeStore(initial: Record<string, unknown> = {}): {
  get: (k: string) => unknown
  set: (k: string, v: unknown) => void
  path: string
  data: Record<string, unknown>
} {
  const data = { ...initial }
  return {
    data,
    path: '/tmp/mock-store',
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => {
      data[k] = v
    }
  }
}

describe('applyAccountDataMutation · 决策卡 §1 不变量 2/3 收口', () => {
  let store: ReturnType<typeof makeStore>
  let lastSaved: unknown
  let broadcasts: BroadcastPayload[]

  beforeEach(() => {
    store = makeStore({
      accountData: {
        accounts: { A: { id: 'A', credentials: { accessToken: 'old-token' } } },
        revision: 5
      }
    })
    lastSaved = null
    broadcasts = []
    setStoreRef(store)
    setLastSavedDataSetter((d) => {
      lastSaved = d
    })
    setBroadcaster((p) => {
      broadcasts.push(p)
    })
  })

  it('ProactiveRenewal 刷 token 时用户同时删账号 · 删除不能丢', async () => {
    // 场景：桌面端定时器 B（ProactiveRenewal）在刷 A 的 token,web/UI 端 A 同时删 A。
    //  - A 端持有 expectedRevision=5,mutate 成 { accounts: {} }（删掉）
    //  - B 端无 expectedRevision（main 侧权威源自刷）,mutate 改 credentials
    // 期望:两次都成功（串行执行）,revision 严格递增,最终结果视调度顺序但不能丢更新。
    //  - 若删除先跑,B 后跑,B 的 mutator 读到的 prev.accounts 已是 {},它写入的对象只反映
    //    "刷新 credentials" 的意图,但因为 A 已删,mutator 无对象可改（这是真实业务里
    //    ProactiveRenewal 会先查 accounts[id] 是否还在,再决定写不写）
    //  - 若刷新先跑,删除后跑,删除结果生效 → 最终 accounts={}
    // 这个测试关键点:**并发调用互不干扰,revision 单调 +1**,不会出现两个 mutator 都读到
    // 同一 prev 各自 set 后其中一个被覆盖。

    let bRanAfterA = false

    // 用同一 tick 并发发起,让 A 先入队再 B 入队,验证串行锁
    const pA = applyAccountDataMutation(
      () => ({ accounts: {} } as AccountsBlob),
      { expectedRevision: 5 }
    )
    const pB = applyAccountDataMutation((prev) => {
      // 关键断言:B 跑到时 prev.revision 已经是 A 写完的 6,不是原来的 5
      // → 证明"读到 A 已删的最新状态",不会覆盖 A 的写
      bRanAfterA = prev.revision === 6
      // 真实业务:ProactiveRenewal 只有在 accounts[id] 存在时才 mutate;
      // 这里模拟"账号被删了,mutator 检查后什么都不改",返回原样
      return prev as AccountsBlob
    })

    const [rA, rB] = await Promise.all([pA, pB])

    expect(rA.ok).toBe(true)
    if (rA.ok) expect(rA.revision).toBe(6)
    expect(rB.ok).toBe(true)
    if (rB.ok) expect(rB.revision).toBe(7)

    expect(bRanAfterA).toBe(true)

    // 最终盘面:accounts 已被删除（A 的意图保留）,revision=7
    const persisted = store.get('accountData') as AccountsBlob & {
      revision: number
      accounts: Record<string, unknown>
    }
    expect(persisted.accounts).toEqual({})
    expect(persisted.revision).toBe(7)
  })

  it('web 端提交陈旧 revision · 服务端明确拒收让客户端能重取', async () => {
    // 场景:store 现在 revision=5,web 端页面停留在几分钟前 revision=3 的快照,现在点删除。
    // 期望:收口返回 STALE_REVISION + currentRevision=5,不改动 store,让 web 端能 reload 后重放。
    const result = await applyAccountDataMutation(
      () => ({ accounts: {} } as AccountsBlob),
      { expectedRevision: 3 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('STALE_REVISION')
      expect(result.currentRevision).toBe(5)
    }

    // store 未被修改
    const persisted = store.get('accountData') as AccountsBlob & { revision: number }
    expect(persisted.revision).toBe(5)
    expect((persisted as { accounts: Record<string, unknown> }).accounts).toHaveProperty('A')

    // 广播也不能发出（拒收不算成功写）
    expect(broadcasts.length).toBe(0)
  })

  it('两个客户端连点同一按钮 · 只能生效一次不能双写', async () => {
    // 场景:web 端网络抖动,同一个"删除 A"请求发了两次,都带 expectedRevision=5。
    // 期望:先到者胜（成功 → revision 从 5 到 6）,后到者 STALE。
    const p1 = applyAccountDataMutation(
      () => ({ accounts: {} } as AccountsBlob),
      { expectedRevision: 5 }
    )
    const p2 = applyAccountDataMutation(
      () => ({ accounts: {} } as AccountsBlob),
      { expectedRevision: 5 }
    )

    const [r1, r2] = await Promise.all([p1, p2])

    // 一个成功一个失败
    const ok = [r1, r2].filter((r) => r.ok)
    const stale = [r1, r2].filter((r) => !r.ok)
    expect(ok.length).toBe(1)
    expect(stale.length).toBe(1)
    if (!stale[0].ok) {
      expect(stale[0].code).toBe('STALE_REVISION')
      expect(stale[0].currentRevision).toBe(6)
    }

    // 只广播一次
    expect(broadcasts.length).toBe(1)
  })

  it('广播 payload 只带 revision / changedIds / originId · 绝不含 accessToken 等敏感字段', async () => {
    // 场景:main 侧 ProactiveRenewal 刷新 A 的 token,mutator 里改了 accessToken/refreshToken。
    // 期望:即便 mutator 处理了敏感字段,广播 payload 也只包含白名单三个 key。
    // originId 是 A-I2 返修新增（consumer 用它精确判自写回声,取代不可靠的 isSyncing 时间窗）,
    // 它只是一个不透明的窗口标识,不含任何账号数据。
    await applyAccountDataMutation(
      () =>
        ({
          accounts: {
            A: {
              id: 'A',
              email: 'a@example.com',
              credentials: {
                accessToken: 'super-secret-new-jwt',
                refreshToken: 'top-secret-refresh',
                clientSecret: 'secret-client'
              }
            }
          }
        } as AccountsBlob),
      { originId: 'renderer-test-window' }
    )

    expect(broadcasts.length).toBe(1)
    const payload = broadcasts[0]
    const keys = Object.keys(payload).sort()

    // 白名单校验:只允许 revision / changedIds / originId 三个 key
    expect(keys).toEqual(['changedIds', 'originId', 'revision'].sort())

    // originId 原样带回,供 consumer 反检
    expect(payload.originId).toBe('renderer-test-window')

    // 显式反向断言:凭证字段绝不能出现在 payload 里
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('super-secret-new-jwt')
    expect(serialized).not.toContain('top-secret-refresh')
    expect(serialized).not.toContain('secret-client')
    expect(serialized).not.toContain('accessToken')
    expect(serialized).not.toContain('refreshToken')
    expect(serialized).not.toContain('clientSecret')

    // revision 是有效数字
    expect(typeof payload.revision).toBe('number')
    expect(payload.revision).toBe(6)
  })

  it('main 侧自动写路径不带 originId · 所有窗口都视为外部写并同步（A-I2 前提）', async () => {
    // 场景:ProactiveRenewal / 关窗 flush / 退出 flush / 解封 —— 这些是 main 侧权威源,
    // 不属于任何 renderer 窗口。期望 originId 为 undefined,使每个窗口的 consumer 都判定
    // 「这不是我的回声」并真正同步。若这里误带了某个窗口的 originId,那个窗口会永久错过这次改动。
    await applyAccountDataMutation((prev) => prev as AccountsBlob)

    expect(broadcasts.length).toBe(1)
    expect(broadcasts[0].originId).toBeUndefined()
  })

  it('main 侧无 expectedRevision 时降级为无仲裁直写 · lastSavedData 同步更新', async () => {
    // 场景:ProactiveRenewal / 关窗 flush / 退出 flush 等 main 侧权威源写路径。
    // 期望:不传 expectedRevision → 直接写入 + revision +1 + lastSavedData 与磁盘一致。
    const result = await applyAccountDataMutation(
      (prev) => ({
        ...prev,
        accounts: { ...(prev.accounts as Record<string, unknown>), B: { id: 'B' } }
      })
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.revision).toBe(6)

    const persisted = store.get('accountData') as AccountsBlob & {
      revision: number
      accounts: Record<string, unknown>
    }
    expect(persisted.revision).toBe(6)
    expect(persisted.accounts).toHaveProperty('A')
    expect(persisted.accounts).toHaveProperty('B')

    // lastSavedData 由收口内部同步,应与刚写盘的对象一致（W1 评审 M1 指出：
    // 内存 lastSavedData 与磁盘 accountData revision 必须一致）
    expect((lastSaved as AccountsBlob).revision).toBe(6)
  })

  it('store 未注入时抛错 · 不静默 no-op（§4.4 分层错误 · 不吞异常）', async () => {
    // 场景:装配次序 bug——applyAccountDataMutation 被调用但 setStoreRef 还没跑。
    // 期望:抛明确错误让上层立刻看见,不返回假成功。
    setStoreRef(null as unknown as ReturnType<typeof makeStore>)
    await expect(
      applyAccountDataMutation(() => ({ accounts: {} } as AccountsBlob))
    ).rejects.toThrow(/store not initialized/i)
  })

  it('backup restore 后 revision 从 0 重启 · 客户端持旧 revision 会正确收到 STALE', async () => {
    // 场景:磁盘 store 损坏 → 从 backup 恢复 → initStore bootstrap 强制写 revision:0
    // renderer 端可能持有崩溃前的 revision（比如 8）→ 下次 saveAccounts 带 expectedRevision=8
    // 期望:收口返回 STALE_REVISION + currentRevision=0 → renderer 走 reload 路径拿新数据
    store = makeStore({
      accountData: {
        accounts: { A: { id: 'A' } },
        revision: 0 // backup restore 写回的初始值
      }
    })
    setStoreRef(store)

    const result = await applyAccountDataMutation(
      () => ({ accounts: {} } as AccountsBlob),
      { expectedRevision: 8 } // renderer 崩溃前的记忆
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('STALE_REVISION')
      expect(result.currentRevision).toBe(0)
    }

    // 第二次:renderer 收到 STALE 后 reload,拿到 revision=0,重放时正确传 expectedRevision=0
    const retry = await applyAccountDataMutation(
      () => ({ accounts: {} } as AccountsBlob),
      { expectedRevision: 0 }
    )
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.revision).toBe(1) // 从 0 递增到 1
  })

  it('broadcaster 未注入时 · 收口仍然成功 · 静默跳过广播（非关键路径）', async () => {
    // 场景:装配次序问题 / 单测里没调 setBroadcaster。
    // 期望:写入照常成功,不因广播缺失而回滚。
    setBroadcaster(null as unknown as (p: BroadcastPayload) => void)
    // 用 vi.fn() 覆盖不好——直接 reset 到 null 的方式没有对外 API,只能通过重新调 setBroadcaster
    // 但 setBroadcaster 内部就是覆盖赋值,传 null 会让 broadcasts 收不到 → 达到目的
    // （TypeScript 上 setBroadcaster 参数类型不允许 null,cast 一下）
    ;(setBroadcaster as unknown as (fn: null) => void)(null)

    const result = await applyAccountDataMutation(
      () => ({ accounts: {}, revision: 999 } as AccountsBlob)
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.revision).toBe(6)
  })

  it('广播 emitter 抛错 · 不影响写入本身（精准 catch · 不吞持久化异常）', async () => {
    // 场景:renderer 已关闭 / IPC guard 拦截,broadcaster throw。
    // 期望:写入照常成功,warn 日志留痕,不冒泡到调用者。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setBroadcaster(() => {
      throw new Error('renderer gone')
    })

    const result = await applyAccountDataMutation(() => ({ accounts: {} } as AccountsBlob))
    expect(result.ok).toBe(true)

    // 磁盘 revision 已经 +1
    const persisted = store.get('accountData') as { revision: number }
    expect(persisted.revision).toBe(6)

    // warn 日志留了痕
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('任一壳层把同一记录 ID 写成另一个身份时，统一收口拒绝且零落盘副作用', async () => {
    store = makeStore({
      accountData: {
        accounts: {
          A: { id: 'A', email: 'a@example.com', userId: 'user-A' }
        },
        revision: 5
      }
    })
    setStoreRef(store)

    await expect(
      applyAccountDataMutation(
        () => ({
          accounts: {
            A: { id: 'A', email: 'b@example.com', userId: 'user-B' }
          }
        }),
        { expectedRevision: 5 }
      )
    ).rejects.toMatchObject({ code: 'ACCOUNT_IDENTITY_DRIFT' })

    expect(store.get('accountData')).toEqual({
      accounts: {
        A: { id: 'A', email: 'a@example.com', userId: 'user-A' }
      },
      revision: 5
    })
    expect(broadcasts).toHaveLength(0)
  })

  it('旧记录缺少身份字段时允许首次补齐，不把历史兼容数据锁死', async () => {
    const result = await applyAccountDataMutation((prev) => ({
      ...prev,
      accounts: {
        A: {
          ...(prev.accounts as Record<string, Record<string, unknown>>).A,
          email: 'a@example.com',
          userId: 'user-A'
        }
      }
    }))

    expect(result).toEqual({ ok: true, revision: 6 })
    expect(
      (store.get('accountData') as { accounts: Record<string, Record<string, unknown>> })
        .accounts.A
    ).toMatchObject({ id: 'A', email: 'a@example.com', userId: 'user-A' })
  })

  it('删除旧记录后以新 ID 重加同一身份属于正常新增，不误判为身份漂移', async () => {
    store = makeStore({
      accountData: {
        accounts: {
          A: { id: 'A', email: 'same@example.com', userId: 'same-user' }
        },
        revision: 5
      }
    })
    setStoreRef(store)

    const result = await applyAccountDataMutation(() => ({
      accounts: {
        B: { id: 'B', email: 'same@example.com', userId: 'same-user' }
      }
    }))

    expect(result).toEqual({ ok: true, revision: 6 })
    expect(
      Object.keys(
        (store.get('accountData') as { accounts: Record<string, unknown> }).accounts
      )
    ).toEqual(['B'])
  })
})
