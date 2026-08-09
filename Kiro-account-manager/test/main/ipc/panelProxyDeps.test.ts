/**
 * 面板反代 deps 的**生产实现** —— 自动放行三字段的真正生产者
 *
 * ## 为什么单独测这一层而不是只测路由
 *
 * `proxyRoutes.test.ts` 用的是替身 deps，它证明的是「路由层不吞字段」（`sendJson`
 * 的强制脱敏会不会把新字段过滤掉）。但三字段的**产出逻辑**在
 * `buildPanelProxyDeps` 的 `status()` 里 —— 替身自己造的读数无法证明它。
 * 只测路由会得到「面板显示倒计时」这个功能全绿而生产者根本没接上（P-01 形态）。
 *
 * 这里注入的是真实的 `buildPanelProxyDeps`，只把 `ProxyServerRef` 换成可控替身。
 */
import { describe, it, expect } from 'vitest'
import { buildPanelProxyDeps, type ProxyServerRef, type PanelProxyStatus } from '../../../src/main/ipc/panelProxyDeps'
import type { ProxyConfig } from '../../../src/main/proxy/types'

interface StubOpts {
  running?: boolean
  autoReleaseEnabled?: boolean
  nextAutoReleaseAt?: number | null
  autoReleaseCount?: number
  heldCount?: number
}

function makeServerRef(opts: StubOpts = {}): ProxyServerRef & { releaseCalls: number } {
  const config = { port: 5580, host: '127.0.0.1', enableMultiAccount: false, selectedAccountIds: [] }
  let held = opts.heldCount ?? 0
  const ref = {
    releaseCalls: 0,
    isRunning: () => opts.running ?? true,
    getAccountPool: () => ({ size: 0, availableCount: 0, getAccount: () => undefined, clear: () => undefined, addAccount: () => undefined }) as never,
    getConfig: () => config as unknown as ProxyConfig,
    updateConfig: () => undefined,
    invalidateSessionAffinity: () => 0,
    start: async () => undefined,
    stop: async () => undefined,
    getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
    // 形状取自 proxyServer.ts:HoldAutoReleaseState（三字段同名，不手抄别名）
    getHoldAutoReleaseState: () => ({
      autoReleaseEnabled: opts.autoReleaseEnabled ?? false,
      nextAutoReleaseAt: opts.nextAutoReleaseAt ?? null,
      autoReleaseCount: opts.autoReleaseCount ?? 0
    }),
    releaseHeldRequests: () => {
      ref.releaseCalls++
      const n = held
      held = 0
      return n
    }
  }
  return ref
}

function deps(ref: ProxyServerRef) {
  return buildPanelProxyDeps({
    getProxyServer: () => ref,
    initProxyServer: () => ref,
    loadAccountData: () => ({}),
    persistProxyConfig: () => undefined
  })
}

describe('panelProxyDeps · 自动放行读数三字段（生产者侧）', () => {
  it('status 透出调度器真实读数，不是面板自己算的', async () => {
    const ref = makeServerRef({
      autoReleaseEnabled: true,
      nextAutoReleaseAt: 1_800_000_000_000,
      autoReleaseCount: 7
    })
    const s = (await deps(ref).proxyGetStatus()) as PanelProxyStatus
    expect(s.autoReleaseEnabled).toBe(true)
    expect(s.nextAutoReleaseAt).toBe(1_800_000_000_000)
    expect(s.autoReleaseCount).toBe(7)
  })

  it('没有下一次放行时 nextAutoReleaseAt 是 null 而非 0（0 是合法 epoch）', async () => {
    const ref = makeServerRef({ autoReleaseEnabled: true, nextAutoReleaseAt: null, autoReleaseCount: 3 })
    const s = (await deps(ref).proxyGetStatus()) as PanelProxyStatus
    expect(s.nextAutoReleaseAt).toBeNull()
    // 严格判据:不能是 0，否则前端会把它当成 1970 年并渲染出一个巨大的负倒计时
    expect(s.nextAutoReleaseAt).not.toBe(0)
  })

  it('反代未初始化时三字段是关闭态且不抛（面板启动时的正常状态）', async () => {
    const d = buildPanelProxyDeps({
      getProxyServer: () => null,
      initProxyServer: () => makeServerRef(),
      loadAccountData: () => ({}),
      persistProxyConfig: () => undefined
    })
    const s = (await d.proxyGetStatus()) as PanelProxyStatus
    expect(s.running).toBe(false)
    expect(s.autoReleaseEnabled).toBe(false)
    expect(s.nextAutoReleaseAt).toBeNull()
    expect(s.autoReleaseCount).toBe(0)
  })

  it('三字段直接来自 ProxyServer.getHoldAutoReleaseState，面板不按配置推算', async () => {
    // 承重判据:读数的真源是调度器状态。若退化成读 getConfig().holdAutoReleaseEnabled,
    // 界面会显示「自动放行已开启」而调度器根本没在跑(决策卡 §1 Must NOT #5)。
    // 这里 config 里没有任何 hold* 字段，读数却完整 —— 证明它只可能来自访问器。
    const ref = makeServerRef({ autoReleaseEnabled: true, nextAutoReleaseAt: 1_700_000_000_000, autoReleaseCount: 9 })
    const s = (await deps(ref).proxyGetStatus()) as PanelProxyStatus
    expect(s.autoReleaseEnabled).toBe(true)
    expect(s.nextAutoReleaseAt).toBe(1_700_000_000_000)
    expect(s.autoReleaseCount).toBe(9)
  })
})

describe('panelProxyDeps · 手动放行（复用既有 releaseHeldRequests，不新建第三个放行入口）', () => {
  it('放行调的是 ProxyServer.releaseHeldRequests 并回传实际放行数', async () => {
    const ref = makeServerRef({ heldCount: 4 })
    const r = (await deps(ref).proxyReleaseHeld()) as { success: boolean; released: number }
    expect(r.success).toBe(true)
    expect(r.released).toBe(4)
    // 承重判据:真的走了既有入口，而不是在面板层自己遍历挂起集合
    expect(ref.releaseCalls).toBe(1)
  })

  it('无挂起条目 → success + released=0（幂等，不是错误）', async () => {
    const ref = makeServerRef({ heldCount: 0 })
    const r = (await deps(ref).proxyReleaseHeld()) as { success: boolean; released: number }
    expect(r.success).toBe(true)
    expect(r.released).toBe(0)
  })

  it('反代未初始化 → PROXY_NOT_RUNNING，且不隐式启动反代', async () => {
    let initCalls = 0
    const d = buildPanelProxyDeps({
      getProxyServer: () => null,
      initProxyServer: () => { initCalls++; return makeServerRef() },
      loadAccountData: () => ({}),
      persistProxyConfig: () => undefined
    })
    const r = (await d.proxyReleaseHeld()) as { success: boolean; error: string }
    expect(r.success).toBe(false)
    expect(r.error).toBe('PROXY_NOT_RUNNING')
    // 放行绝不能触发惰性初始化 —— 那会绕过启动路径的空池检查
    expect(initCalls).toBe(0)
  })
})
