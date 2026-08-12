/**
 * 服务端两处缝位的接线闸门（W-A 续 / W-D）。
 *
 * ## 断言选点：为什么不测 mock 被调用过
 *
 * 「反代刷出的新 token 落了盘」这条命题，只有**读回盘上的状态**才能判别。
 * 断言「`persistence.onProxyAccountUpdate` 这个 mock 被调用了」在**当前有缺陷的代码上
 * 也能绿**（缺陷正是 `entry.ts` 不传 hook，而测试自己会传一个）—— 那是 E-052 那一族
 * （测试绿 ≠ 真达标）的成因。故这里：
 *   - 用真实 `applyAccountDataMutation` 收口 + in-memory store 替身；
 *   - 触发反代的 `onAccountUpdate` 回调（从 `assembleServer` 装好的事件对象里取）；
 *   - 从 store 里**读回** accountData，断言 token 已在盘上。
 *
 * ## 为什么不真起 `ProxyServer`
 *
 * `initProxyServer()` 会 `new ProxyServer(...)` 并建 AccountPool / 各种 timer，
 * 而本文件要验的是「事件对象里那个回调的下游动作是不是落盘」。真起一台反代再想办法
 * 让它内部走到 `:1582` 需要一个真实上游 —— 那是 e2e 的事，不是这一层该做的。
 * 故取 `ProxyServer` 构造时收到的 events 对象（用一个 spy 构造参数捕获），直接调它。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assembleServer,
  defaultAccountApi,
  UNWIRED_ACCOUNT_API_METHODS,
  type AssembledServer
} from '@main/server/assembly'
import {
  createServerPersistenceHooks,
  patchAccountWithProxyUpdate,
  patchAccountWithSuspension
} from '@main/server/persistence'
import { KIRO_SOCIAL_PROFILE_ARN } from '@main/kiroAuthSync'
import { bootstrap } from '@main/server/entry'
import {
  applyAccountDataMutation,
  setLastSavedDataSetter,
  setBroadcaster
} from '@main/accountService/state'
import type { AccountStorePort } from '@main/persistence/accountStorePort'
import type { AdminKeyStore } from '@main/webPanel/auth'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `w-seams-${tag}-`))
}

function fakeAdminKeyStore(): AdminKeyStore {
  let key: string | null = 'test-admin-key-0000000000000000000001'
  return { get: () => key, set: (k) => { key = k } }
}

/** 盘上初始态：账号持有 access-v1 / refresh-v1（上游即将轮换它们） */
function initialBlob(): Record<string, unknown> {
  return {
    revision: 4,
    accounts: {
      acc1: {
        id: 'acc1',
        email: 'a@example.com',
        status: 'active',
        credentials: {
          accessToken: 'access-v1',
          refreshToken: 'refresh-v1',
          expiresAt: 1000,
          clientId: 'cid',
          region: 'us-east-1'
        }
      }
    }
  }
}

/** 反代事件对象。`ProxyServer.events` 是私有字段 —— 这里刻意读它 */
type ProxyEvents = {
  onAccountUpdate?: (account: Record<string, unknown>) => void
  onAccountSuspended?: (info: Record<string, unknown>) => void
  onCreditsUpdate?: (totalCredits: number) => void
  onTokensUpdate?: (inputTokens: number, outputTokens: number) => void
  onRequestStatsUpdate?: (
    totalRequests: number,
    successRequests: number,
    failedRequests: number
  ) => void
}

/**
 * 从真实 `ProxyServer` 实例上取装配层交给它的 events 对象。
 *
 * 为什么读私有字段而不 mock 构造函数：本文件要判别的正是「**装配层实际交给反代的**
 * 那个回调，下游动作是不是落盘」。mock 掉构造函数就只能验到我自己传进去的东西 ——
 * 那是 E-052 的形态。读真实实例上的真实引用，是唯一能判别这条命题的取样点。
 */
function eventsOf(proxy: unknown): ProxyEvents {
  return (proxy as { events: ProxyEvents }).events
}

/** 等到盘上出现期望值（落盘是 fire-and-forget 的异步动作）。超时即失败，不静默 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
}

function credentialsOf(store: AccountStorePort, id: string): Record<string, unknown> {
  const blob = store.get('accountData') as
    | { accounts?: Record<string, { credentials?: Record<string, unknown> }> }
    | undefined
  return blob?.accounts?.[id]?.credentials ?? {}
}

function accountOf(store: AccountStorePort, id: string): Record<string, unknown> {
  const blob = store.get('accountData') as
    | { accounts?: Record<string, Record<string, unknown>> }
    | undefined
  return blob?.accounts?.[id] ?? {}
}

describe('W-D 反代刷出的新 token 必须落盘（治「刷了但重启用回旧的」）', () => {
  let server: AssembledServer | null = null

  beforeEach(() => {
    setLastSavedDataSetter(() => {})
    setBroadcaster(() => {})
  })

  afterEach(async () => {
    if (server) await server.shutdown()
    server = null
  })

  /**
   * 装一台服务端并把写入收口指向同一个 store。
   *
   * `assembleServer` 内部会 `setStoreRef(它自己建的 conf store)`，本函数**不覆盖**它
   * —— 那样测的就不是装配层真实接的那条写路径了。故用真实临时目录 + 真实 conf store，
   * 断言从 `server.store` 读回（它就是收口写入的那一个）。
   */
  function assemble(opts: { withPersistence: boolean }): AssembledServer {
    const dir = tempDir(opts.withPersistence ? 'wired' : 'unwired')
    const s = assembleServer({
      config: { dataDir: dir, truncateLogs: true },
      adminKeyStore: fakeAdminKeyStore(),
      persistence: opts.withPersistence ? createServerPersistenceHooks() : undefined
    })
    s.store.set('accountData', initialBlob())
    return s
  }

  it('刷新后新的 access/refresh/expiresAt 出现在盘上（读回持久化状态，不看 mock）', async () => {
    server = assemble({ withPersistence: true })
    const events = eventsOf(server.initProxyServer())

    // 反代刷新成功时交出的形状（对齐 proxyServer.ts:1581-1586）
    events.onAccountUpdate?.({
      id: 'acc1',
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresAt: 99_000
    })

    await waitFor(
      () => credentialsOf(server!.store, 'acc1').accessToken === 'access-v2',
      '盘上 accessToken 变成 access-v2'
    )
    const cred = credentialsOf(server.store, 'acc1')
    // 三个字段都必须在盘上 —— refreshToken 是承重的那个（上游轮换后旧的当场作废）
    expect(cred.refreshToken).toBe('refresh-v2')
    expect(cred.expiresAt).toBe(99_000)
    // 未涉及的字段不得被抹掉（字段级补丁，不是整条覆盖）
    expect(cred.clientId).toBe('cid')
    expect(cred.region).toBe('us-east-1')
  })

  it('token 刷新事件后立即 shutdown，返回前必须把轮换后的 refreshToken 落盘', async () => {
    server = assemble({ withPersistence: true })
    const events = eventsOf(server.initProxyServer())

    // 占住 accountData 的既有串行写锁，让 token 补丁可重复地停在队列里。
    // setImmediate 才释放：旧 shutdown 不等队列，会先返回并读到 refresh-v1；
    // 正确 shutdown 会等 drain，在释放后写完 refresh-v2 才返回。
    let releaseWrite!: () => void
    let markBlockerStarted!: () => void
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve
    })
    const blocker = applyAccountDataMutation(async (prev) => {
      markBlockerStarted()
      await writeReleased
      return prev
    })
    await blockerStarted

    events.onAccountUpdate?.({
      id: 'acc1',
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresAt: 99_000
    })

    const releaseScheduled = new Promise<void>((resolve) => {
      setImmediate(() => {
        releaseWrite()
        resolve()
      })
    })
    await server.shutdown()
    const tokenWhenShutdownReturned = credentialsOf(server.store, 'acc1').refreshToken

    // 无论断言成败都先收干净人为占住的全局写锁，避免污染本文件后续用例。
    await releaseScheduled
    await blocker
    expect(tokenWhenShutdownReturned).toBe('refresh-v2')
  })

  it('shutdown 会立即 flush 尚在防抖窗口内的额度、token 与请求统计', async () => {
    vi.useFakeTimers()
    try {
      server = assemble({ withPersistence: true })
      const events = eventsOf(server.initProxyServer())

      events.onCreditsUpdate?.(321)
      events.onTokensUpdate?.(654, 987)
      events.onRequestStatsUpdate?.(12, 10, 2)

      // 不推进 2 秒 timer：只有 shutdown 主动 flush 才能让这些值落盘。
      await server.shutdown()
      expect(server.store.get('proxyTotalCredits')).toBe(321)
      expect(server.store.get('proxyInputTokens')).toBe(654)
      expect(server.store.get('proxyOutputTokens')).toBe(987)
      expect(server.store.get('proxyTotalRequests')).toBe(12)
      expect(server.store.get('proxySuccessRequests')).toBe(10)
      expect(server.store.get('proxyFailedRequests')).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drain 超过上限会返回，并明确记录哪条 token 写入尚未确认落盘', async () => {
    server = assemble({ withPersistence: false })
    const hooks = createServerPersistenceHooks({ drainTimeoutMs: 0 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    let releaseWrite!: () => void
    let markBlockerStarted!: () => void
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve
    })
    const blocker = applyAccountDataMutation(async (prev) => {
      markBlockerStarted()
      await writeReleased
      return prev
    })
    await blockerStarted

    try {
      hooks.onProxyAccountUpdate?.({
        id: 'acc1',
        accessToken: 'access-v2',
        refreshToken: 'refresh-v2'
      })
      await hooks.drain()

      const log = error.mock.calls.map((args) => args.join(' ')).join('\n')
      expect(log).toContain('反代账号更新（id=acc1）')
      expect(log).toContain('尚未确认落盘')
      expect(log).toContain('refreshToken')
    } finally {
      releaseWrite()
      await blocker
      await waitFor(
        () => credentialsOf(server!.store, 'acc1').refreshToken === 'refresh-v2',
        '超时测试释放写锁后清空持久化队列'
      )
      error.mockRestore()
    }
  })

  it('反向对照：不注入 persistence 时新 token 确实不落盘（证明上一条断言有判别力）', async () => {
    server = assemble({ withPersistence: false })
    const events = eventsOf(server.initProxyServer())

    events.onAccountUpdate?.({
      id: 'acc1',
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresAt: 99_000
    })

    // 给足够时间让「如果会落盘」的路径跑完
    await new Promise((r) => setTimeout(r, 120))
    expect(credentialsOf(server.store, 'acc1').accessToken).toBe('access-v1')
    expect(credentialsOf(server.store, 'acc1').refreshToken).toBe('refresh-v1')
  })

  it('切号场景不带 refreshToken 时，盘上原有的 refreshToken 不得被抹成 undefined', async () => {
    // proxyServer.ts:1790/1954/2005 在切号时把整个 ProxyAccount 交出来，
    // 而该类型的 refreshToken 是可选的。直接展开会把盘上真值覆盖成 undefined
    // —— 那个账号从此再也刷不了 token，且只在生产上才看得见。
    server = assemble({ withPersistence: true })
    const events = eventsOf(server.initProxyServer())

    events.onAccountUpdate?.({ id: 'acc1', accessToken: 'access-v2' })

    await waitFor(
      () => credentialsOf(server!.store, 'acc1').accessToken === 'access-v2',
      '盘上 accessToken 变成 access-v2'
    )
    expect(credentialsOf(server.store, 'acc1').refreshToken).toBe('refresh-v1')
    expect(credentialsOf(server.store, 'acc1').expiresAt).toBe(1000)
  })

  it('profileArn 自愈同时写顶层与 credentials（两处都有读者）', async () => {
    server = assemble({ withPersistence: true })
    const events = eventsOf(server.initProxyServer())

    events.onAccountUpdate?.({ id: 'acc1', profileArn: 'arn:aws:x:1:profile/REAL' })

    await waitFor(
      () => accountOf(server!.store, 'acc1').profileArn === 'arn:aws:x:1:profile/REAL',
      '盘上顶层 profileArn 落地'
    )
    expect(credentialsOf(server.store, 'acc1').profileArn).toBe('arn:aws:x:1:profile/REAL')
  })

  it('封禁状态落盘：status/lastError/lastCheckedAt 三项与桌面措辞一致', async () => {
    server = assemble({ withPersistence: true })
    const events = eventsOf(server.initProxyServer())

    events.onAccountSuspended?.({
      accountId: 'acc1',
      email: 'a@example.com',
      reason: 'TEMPORARILY_SUSPENDED',
      message: 'account is suspended'
    })

    await waitFor(() => accountOf(server!.store, 'acc1').status === 'error', '盘上 status 变 error')
    const acc = accountOf(server.store, 'acc1')
    // 措辞必须与桌面 App.tsx:401 的 `[${reason}] ${message}` 一致 —— 两端读同一份数据
    expect(acc.lastError).toBe('[TEMPORARILY_SUSPENDED] account is suspended')
    expect(typeof acc.lastCheckedAt).toBe('number')
  })

  it('账号已被另一端删除时不重建、不抛错（零副作用中止）', async () => {
    server = assemble({ withPersistence: true })
    const events = eventsOf(server.initProxyServer())
    const before = server.store.get('accountData') as { revision: number }

    events.onAccountUpdate?.({ id: 'ghost', accessToken: 'x', refreshToken: 'y' })

    await new Promise((r) => setTimeout(r, 120))
    const after = server.store.get('accountData') as {
      revision: number
      accounts: Record<string, unknown>
    }
    // 绝不重建那条记录，且 revision 不该被一次无意义写入推高
    expect(after.accounts.ghost).toBeUndefined()
    expect(after.revision).toBe(before.revision)
  })
})

describe('W-A 四个自由方法已接线（不再抛「未接线」）', () => {
  /**
   * 断言选点：从**装配层的默认 accountApi** 上取那四个成员，调用它们，确认抛出的不是
   * 「未接线」那个装配错误。
   *
   * 为什么不断言业务返回值：`fetchEnterpriseProfileArn` / `writeKiroAuthTokenFile` 会真的
   * 碰网络与 `~/.aws/sso/cache` —— 那是 e2e 的事。这一层要判别的命题只有一个：
   * 「装配层交出来的这个函数，是缝位的 throw 桩，还是真实现」。故对能安全真跑的两个
   * 额外断言真实行为，对另外两个只断言「不是那个 throw 桩」。
   */
  const api = defaultAccountApi()

  it('resolveProfileArnForWrite 走到真实现（social → 固定 ARN，不是 throw 桩）', () => {
    // kiroAuthSync.ts:92-94：social / Github / Google → KIRO_SOCIAL_PROFILE_ARN
    const arn = api.resolveProfileArnForWrite({ authMethod: 'social' })
    expect(arn).toBe(KIRO_SOCIAL_PROFILE_ARN)
    // 反向对照：换成 IdC 分支要给出**不同**的值 —— 否则可能是个恒返回同值的桩
    expect(api.resolveProfileArnForWrite({ authMethod: 'IdC' })).not.toBe(arn)
  })

  it('readKiroAuthTokenFile 走到真实现（文件不存在 → null，而不是抛「未接线」）', async () => {
    // 服务器上 ~/.aws/sso/cache/kiro-auth-token.json 正常缺席 ⇒ null 是期望值。
    // 该函数把「不存在 / 读不了 / JSON 坏」全归一成 null（kiroAuthSync.ts:233，
    // 另有独立任务在治那个吞错形态）—— 在服务端形态下这不改变可观察行为。
    await expect(api.readKiroAuthTokenFile()).resolves.not.toThrow()
  })

  it('fetchEnterpriseProfileArn / writeKiroAuthTokenFile 不再是 throw 桩', async () => {
    // 它们会真去碰网络 / 文件系统，故只断言「失败原因不是装配未接线」。
    for (const call of [
      () =>
        api.fetchEnterpriseProfileArn({
          id: 'x',
          accessToken: 'bad-token',
          region: 'us-east-1'
        }),
      () =>
        api.writeKiroAuthTokenFile({
          accessToken: 'a',
          refreshToken: 'r',
          expiresAtIso: new Date().toISOString(),
          authMethod: 'social',
          provider: 'Google'
        })
    ]) {
      let message = ''
      try {
        await call()
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).not.toContain('账号上游 API 未接线')
    }
  })

  it('剩下三个上游 HTTP 方法仍显式抛（不静默 no-op —— 否则失败看起来像上游故障）', () => {
    expect(() => api.refreshTokenByMethod('t', 'c', 's')).toThrow(/账号上游 API 未接线/)
    expect(() => api.getUsageAndLimits('t')).toThrow(/账号上游 API 未接线/)
    expect(() => api.getUserInfo('t')).toThrow(/账号上游 API 未接线/)
  })

  it('未接线清单只剩三个上游 HTTP 方法（四个自由方法已移出缺口）', () => {
    expect(UNWIRED_ACCOUNT_API_METHODS).toEqual([
      'getUsageAndLimits',
      'getUserInfo',
      'refreshTokenByMethod'
    ])
    for (const freed of [
      'fetchEnterpriseProfileArn',
      'readKiroAuthTokenFile',
      'writeKiroAuthTokenFile',
      'resolveProfileArnForWrite'
    ]) {
      expect(UNWIRED_ACCOUNT_API_METHODS as readonly string[]).not.toContain(freed)
    }
  })

  it('启动告警只点名剩下三个方法（运维据此判断还缺什么）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dir = tempDir('warn')
      assembleServer({
        config: { dataDir: dir, truncateLogs: true },
        adminKeyStore: fakeAdminKeyStore()
      })
      const text = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(text).toContain('refreshTokenByMethod')
      expect(text).toContain('getUsageAndLimits')
      expect(text).toContain('getUserInfo')
      // 四个已接线的方法不该再出现在「缺的是」那句话里
      expect(text).not.toMatch(/缺的是[^\n]*fetchEnterpriseProfileArn/)
      expect(text).not.toMatch(/缺的是[^\n]*readKiroAuthTokenFile/)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('W-D 补丁纯函数（逐字段固定，防日后「顺手整理」改掉语义）', () => {
  it('patchAccountWithProxyUpdate 只写 patch 真带来的字段', () => {
    const before = {
      id: 'a',
      status: 'active',
      lastError: 'old-error',
      credentials: { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1, clientId: 'c' }
    }
    const after = patchAccountWithProxyUpdate(before, { id: 'a', accessToken: 'a2' })

    expect((after.credentials as Record<string, unknown>).accessToken).toBe('a2')
    expect((after.credentials as Record<string, unknown>).refreshToken).toBe('r1')
    expect((after.credentials as Record<string, unknown>).clientId).toBe('c')
    // 刻意**不**碰 status / lastError：onAccountUpdate 也在切号时触发，
    // 那时把 status 按成 active、清掉真实 lastError 是没有依据的副作用
    expect(after.status).toBe('active')
    expect(after.lastError).toBe('old-error')
    // 入参对象不被原地改动（纯函数）
    expect((before.credentials as Record<string, unknown>).accessToken).toBe('a1')
  })

  it('patchAccountWithProxyUpdate 对无 credentials 的历史记录也成立', () => {
    const after = patchAccountWithProxyUpdate({ id: 'a' }, { id: 'a', accessToken: 'a2' })
    expect((after.credentials as Record<string, unknown>).accessToken).toBe('a2')
  })

  it('patchAccountWithSuspension 写三项且不动凭据', () => {
    const after = patchAccountWithSuspension(
      { id: 'a', credentials: { accessToken: 'a1' } },
      { id: 'a', reason: 'R', message: 'M', suspendedAt: 555 }
    )
    expect(after.status).toBe('error')
    expect(after.lastError).toBe('[R] M')
    expect(after.lastCheckedAt).toBe(555)
    expect((after.credentials as Record<string, unknown>).accessToken).toBe('a1')
  })
})

/**
 * `entry.ts` 的真实装配调用 —— 本轮 W-D 的**病灶就在这一行**。
 *
 * 上面那组测试验的是 `assembleServer({persistence})` 的语义；但 `entry.ts:77` 原先根本
 * **不传** `persistence`，于是那组测试全绿而服务端照样丢 token。故这里走真实 `bootstrap()`
 * （它是 `node out/server/index.js` 实际跑的那条路），取真实反代实例上的真实回调，
 * 断言盘上的 token 真的变了。少了这一条，上面那组就是「验了语义、没验接线」（E-052）。
 */
describe('W-D entry.ts 的真实启动路径必须把 persistence 接上', () => {
  let started: AssembledServer | null = null

  afterEach(async () => {
    if (started) await started.shutdown()
    started = null
  })

  it('bootstrap() 起的服务端，反代刷出的新 token 落到盘上', async () => {
    const dir = tempDir('bootstrap')
    started = await bootstrap({
      KIRO_DATA_DIR: dir,
      // 端口 0 = 内核分配，避免与本机既有服务撞车（config.ts 明确允许 0）
      KIRO_PANEL_PORT: '0',
      KIRO_ADMIN_KEY: 'bootstrap-test-admin-key-000000000001'
    })
    started.store.set('accountData', initialBlob())

    const events = eventsOf(started.initProxyServer())
    events.onAccountUpdate?.({
      id: 'acc1',
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresAt: 99_000
    })

    await waitFor(
      () => credentialsOf(started!.store, 'acc1').refreshToken === 'refresh-v2',
      '经 bootstrap 起的服务端把新 refreshToken 落到盘上'
    )
    expect(credentialsOf(started.store, 'acc1').accessToken).toBe('access-v2')
  })
})
