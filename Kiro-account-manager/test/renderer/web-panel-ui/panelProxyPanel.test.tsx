/**
 * 面板反代 UI 的行为测试 —— 锁住「运行态不乐观更新」这条不变量
 *
 * 拦 `fetch` 而不是 mock `api/panel.ts`：要证明的是「界面显示的运行中，
 * 到底是服务端说的、还是客户端自己以为的」。若 mock 掉 api 层，那就成了
 * 断言我调了自己写的函数，恰好绕过唯一会出错的那一层。
 *
 * 关键构造：让 `POST /proxy/start` 返回成功，但 `GET /proxy/status` 仍报
 * `running: false`（模拟"启动请求成功了但服务其实没绑上端口"）。UI 必须显示
 * 「未运行」—— 显示「运行中」就是乐观更新，正是桌面设置页犯过的那个 bug。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProxyPanel } from '../../../src/webPanel/ui/ProxyPanel'
import type { PanelHoldEpisode } from '../../../src/webPanel/api/panel'
import type { AccountListItem } from '../../../src/main/webPanel/dto'

function accounts(): AccountListItem[] {
  return [
    {
      id: 'acc-a',
      email: 'alice@example.com',
      status: 'active',
      isActive: false,
      tags: [],
      hasRefreshToken: true,
      canRefreshViaOidc: true,
      usage: { percentUsed: 0.3 }
    },
    {
      id: 'acc-b',
      email: 'bob@example.com',
      status: 'active',
      isActive: false,
      tags: [],
      hasRefreshToken: true,
      canRefreshViaOidc: true
    },
    {
      id: 'acc-dead',
      email: 'dead@example.com',
      status: 'error',
      isActive: false,
      tags: [],
      hasRefreshToken: false,
      canRefreshViaOidc: false
    }
  ]
}

interface StatusShape {
  running: boolean
  port?: number
  enableMultiAccount?: boolean
  selectedAccountId?: string
  selectedAccountEmail?: string
  poolSize?: number
  availableCount?: number
  totalRequests?: number
  successRequests?: number
  failedRequests?: number
  autoReleaseEnabled?: boolean
  nextAutoReleaseAt?: number | null
  autoReleaseCount?: number
  currentEpisode?: PanelHoldEpisode | null
  recentEpisodes?: PanelHoldEpisode[]
}

/** 可编程的假服务端。`statusQueue` 让每次 GET /status 返回不同读数 */
function stubServer(opts: {
  status: StatusShape | StatusShape[]
  startResponse?: { ok: boolean; body?: unknown; status?: number }
  activateResponse?: { ok: boolean; body?: unknown; status?: number }
  releaseResponse?: { ok: boolean; body?: unknown; status?: number }
}) {
  const statuses = Array.isArray(opts.status) ? [...opts.status] : [opts.status]
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = []

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string> })

    if (url.endsWith('/proxy/status')) {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0]
      return json({
        success: true,
        running: s.running,
        port: s.port ?? 5580,
        enableMultiAccount: s.enableMultiAccount ?? false,
        selectedAccountId: s.selectedAccountId,
        selectedAccountEmail: s.selectedAccountEmail,
        poolSize: s.poolSize ?? 2,
        availableCount: s.availableCount ?? 2,
        totalRequests: s.totalRequests ?? 0,
        successRequests: s.successRequests ?? 0,
        failedRequests: s.failedRequests ?? 0,
        autoReleaseEnabled: s.autoReleaseEnabled ?? false,
        // null = 没有下一次。刻意不用 ?? 0 —— 0 是合法 epoch，会渲染成巨大负倒计时
        nextAutoReleaseAt: s.nextAutoReleaseAt ?? null,
        autoReleaseCount: s.autoReleaseCount ?? 0,
        currentEpisode: s.currentEpisode ?? null,
        recentEpisodes: s.recentEpisodes ?? []
      })
    }
    if (url.endsWith('/proxy/start')) {
      const r = opts.startResponse ?? { ok: true, body: { success: true, poolSize: 2 } }
      return json(r.body ?? { success: true }, r.ok ? 200 : (r.status ?? 409))
    }
    if (url.endsWith('/proxy/stop')) return json({ success: true, running: false })
    if (url.endsWith('/proxy/sync-pool')) return json({ success: true, poolSize: 2 })
    if (url.endsWith('/proxy/release-held')) {
      const r = opts.releaseResponse ?? { ok: true, body: { success: true, released: 2 } }
      return json(r.body ?? { success: true }, r.ok ? 200 : (r.status ?? 409))
    }
    if (url.endsWith('/proxy/active-account')) {
      const r = opts.activateResponse ?? {
        ok: true,
        body: { success: true, mode: 'single', accountId: 'acc-b', email: 'bob@example.com' }
      }
      return json(r.body ?? { success: true }, r.ok ? 200 : (r.status ?? 409))
    }
    return json({ code: 'ACCOUNT_NOT_FOUND' }, 404)
  })

  return { fetchMock, calls }
}

const noop = (): void => undefined

function renderPanel(overrides: Partial<Parameters<typeof ProxyPanel>[0]> = {}) {
  const onNotice = vi.fn()
  const onError = vi.fn()
  const onSessionLost = vi.fn()
  render(
    <ProxyPanel
      accounts={accounts()}
      onNotice={onNotice}
      onError={onError}
      onSessionLost={onSessionLost}
      {...overrides}
    />
  )
  return { onNotice, onError, onSessionLost }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('反代面板 · 运行态来自服务端读数（不乐观更新）', () => {
  it('启动请求成功但服务端仍报未运行 → 界面显示未运行，不显示运行中', async () => {
    // 第一次 status（挂载时）= 未运行；启动后再查仍然是未运行
    const { fetchMock } = stubServer({ status: { running: false } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '启动' }))

    // 判据：启动请求确实发了，但界面仍是「未运行」——
    // 若这里显示「运行中」，就是拿"我发过请求"当运行态，即已知的那个 bug
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/proxy/start'))).toBe(true)
    })
    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy())
    expect(screen.queryByText(/运行中/)).toBeNull()
  })

  it('服务端报运行中 → 显示运行中与真实端口', async () => {
    const { fetchMock } = stubServer({ status: { running: true, port: 5581 } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中 · 端口 5581/)).toBeTruthy())
  })

  it('每次写操作后都重新查一次真实状态', async () => {
    const { fetchMock, calls } = stubServer({
      status: [{ running: false }, { running: true }, { running: true }]
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: '启动' }))
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())

    const statusCalls = calls.filter((c) => c.url.endsWith('/proxy/status'))
    // 挂载 1 次 + 启动后 1 次
    expect(statusCalls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('反代面板 · 空池启动被如实呈现', () => {
  it('池为空导致启动失败 → 报「没有可用账号」，且不显示运行中', async () => {
    const { fetchMock } = stubServer({
      status: { running: false, poolSize: 0, availableCount: 0 },
      startResponse: { ok: false, status: 409, body: { code: 'EMPTY_POOL' } }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onError } = renderPanel({ accounts: [] })

    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '启动' }))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(String(onError.mock.calls[0][0])).toContain('没有可用账号')
    expect(screen.queryByText(/运行中/)).toBeNull()
  })
})

describe('反代面板 · 选号', () => {
  it('反代未运行时选号按钮禁用，并说明原因', async () => {
    const { fetchMock } = stubServer({ status: { running: false } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy())
    expect(screen.getByRole('button', { name: '选择账号' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('选择账号需要反代处于运行状态')).toBeTruthy()
  })

  it('选号弹窗列出全部账号(候选范围与桌面端一致,不按 status 二层过滤)', async () => {
    // 旧行为(已推翻):只列 status==='active',理由写的是「其余服务端会拒,列出来让用户白点」。
    // 实测推翻(2026-08-05 用户报「手机上选择账号什么都列不出来」):真实环境 7 个账号里
    // 6 个 status='error',却全部能正常刷出额度 —— status 不可靠到不能拿来当「能不能选」
    // 的判据;过滤后候选只剩 1 个(恰好是当前已选中的那个)= 功能完全不可用。
    // 桌面端 AccountSelectDialog 全文不用 status 筛选(只有搜索框过滤),两端必须一致,
    // 否则同一个号在桌面能选、在手机上凭空消失。
    const { fetchMock } = stubServer({ status: { running: true } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '选择账号' }))

    const dialog = screen.getByRole('dialog', { name: '选择反代账号' })
    expect(within(dialog).getByText('alice@example.com')).toBeTruthy()
    expect(within(dialog).getByText('bob@example.com')).toBeTruthy()
    // status='error' 的账号**也必须列出** —— 选了不可用的号失败是一次可恢复的报错,
    // 而看不到号、无法选择是死路
    expect(within(dialog).getByText('dead@example.com')).toBeTruthy()
  })

  it('选号只发一个请求（三步顺序在服务端，客户端不拆开编排）', async () => {
    const { fetchMock, calls } = stubServer({
      status: [{ running: true }, { running: true, selectedAccountId: 'acc-b', selectedAccountEmail: 'bob@example.com' }]
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onNotice } = renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: '选择账号' }))
    await userEvent.click(screen.getByRole('button', { name: /bob@example\.com/ }))

    await waitFor(() => expect(onNotice).toHaveBeenCalled())
    const writeCalls = calls.filter((c) => c.method === 'POST')
    // 只有 active-account 一条写请求：客户端若自己拆成"入池 + 写配置 + 移指针"，
    // 就成了第二个顺序真源
    expect(writeCalls.map((c) => c.url.split('/api')[1])).toEqual(['/proxy/active-account'])
  })

  it('写操作带 CSRF 头（缺了服务端一律 401）', async () => {
    const { fetchMock, calls } = stubServer({ status: { running: true } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '停止' }))

    await waitFor(() => {
      const stop = calls.find((c) => c.url.endsWith('/proxy/stop'))
      expect(stop?.headers['X-Panel-Request']).toBe('1')
    })
  })

  it('多账号轮询模式下明确说明选号只移动轮询起点', async () => {
    const { fetchMock } = stubServer({ status: { running: true, enableMultiAccount: true } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText('多账号轮询中')).toBeTruthy())
    expect(screen.getByText(/只会让轮询从该账号开始/)).toBeTruthy()
  })

  it('显示当前账号（手机上要能看到正在用哪个号）', async () => {
    const { fetchMock } = stubServer({
      status: { running: true, selectedAccountId: 'acc-a', selectedAccountEmail: 'alice@example.com' }
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeTruthy())
  })
})

describe('反代面板 · 停止的在飞请求提示', () => {
  it('运行中时显示已服务次数，让用户自己判断现在停是否合适', async () => {
    const { fetchMock } = stubServer({
      status: { running: true, totalRequests: 42, failedRequests: 3 }
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/停止会中断正在进行的请求。已服务 42 次/)).toBeTruthy())
  })

  it('会话失效（401）上报给 App，由顶层踢回登录页', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onSessionLost } = renderPanel()
    await waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })
})

/** 消除未使用告警：noop 保留给将来需要空回调的用例 */
void noop

describe('反代面板 · 自动放行读数与手动放行（决策卡 §3 手机端契约）', () => {
  it('显示倒计时与累计放行次数', async () => {
    const { fetchMock } = stubServer({
      status: {
        running: true,
        autoReleaseEnabled: true,
        // 距今 125 秒 → 2:05
        nextAutoReleaseAt: Date.now() + 125_000,
        autoReleaseCount: 6
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    await waitFor(() => expect(screen.getByText('2:05')).toBeTruthy())
    // 累计次数是「本次启动以来的周期次数」，不是条目数
    await waitFor(() => expect(screen.getByText('6')).toBeTruthy())
  })

  it('时间线使用服务端总数，截断后披露缺失行且保留真实序号', async () => {
    const releases = Array.from({ length: 50 }, (_, i) => ({
      at: 1_800_000_000_000 + i * 1000,
      trigger: 'auto' as const,
      outcome: 're-held' as const,
      outcomeAt: 1_800_000_000_500 + i * 1000
    }))
    const episode: PanelHoldEpisode = {
      id: 7,
      reason: 'pool-empty',
      detail: [],
      startedAt: releases[0].at,
      endedAt: null,
      totalReleaseCount: 60,
      totalAutoReleaseCount: 60,
      releases
    }
    const { fetchMock } = stubServer({
      status: { running: true, currentEpisode: episode }
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    await waitFor(() => expect(screen.getByText('已放行 60 次')).toBeTruthy())
    expect(screen.getByText('仅显示最近 50 条，前 10 条已省略')).toBeTruthy()
    expect(screen.getByText('#60')).toBeTruthy()
    expect(screen.getByText('#11')).toBeTruthy()
    expect(screen.queryByText('#10')).toBeNull()
  })

  it('倒计时本地自减，不靠轮询服务端拿数值', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { fetchMock, calls } = stubServer({
        status: {
          running: true,
          autoReleaseEnabled: true,
          nextAutoReleaseAt: Date.now() + 125_000,
          autoReleaseCount: 1
        }
      })
      vi.stubGlobal('fetch', fetchMock)
      renderPanel()
      await waitFor(() => expect(screen.getByText('2:05')).toBeTruthy())
      const statusCallsBefore = calls.filter((c) => c.url.endsWith('/proxy/status')).length

      // 推进假时钟必须包在 act 里：这一步会触发倒计时心跳的 setNow，
      // 那是组件内的状态更新。不包住 React 会打 "not wrapped in act(...)" 告警，
      // 而告警噪声会掩盖以后真正的异步缺陷（届时新告警混在旧告警里看不出来）。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      // 承重判据：数字自己走了，且期间**没有**新的 status 请求 ——
      // 若靠轮询，服务端请求数会随倒计时刷新率增长（决策卡：推送只给绝对时间戳）
      await waitFor(() => expect(screen.getByText('2:02')).toBeTruthy())
      expect(calls.filter((c) => c.url.endsWith('/proxy/status')).length).toBe(statusCallsBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有下一次放行时不显示 0 或负倒计时', async () => {
    const { fetchMock } = stubServer({
      status: { running: true, autoReleaseEnabled: true, nextAutoReleaseAt: null, autoReleaseCount: 3 }
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()

    await waitFor(() => expect(screen.getByText(/自动放行/)).toBeTruthy())
    // null 必须显示成「-」而不是 0:00 —— 0 是合法 epoch，把「无」当 0 会渲染 1970 年
    expect(screen.queryByText('0:00')).toBeNull()
    expect(screen.queryByText(/-\d/)).toBeNull()
  })

  it('时间戳已过期（时钟回拨/事件延迟）→ 显示「即将放行」而不是负数', async () => {
    const { fetchMock } = stubServer({
      status: {
        running: true,
        autoReleaseEnabled: true,
        nextAutoReleaseAt: Date.now() - 5000,
        autoReleaseCount: 2
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText('即将放行')).toBeTruthy())
  })

  it('点放行 → 只发一个 POST /proxy/release-held，且回报实际放行数', async () => {
    const { fetchMock, calls } = stubServer({
      status: { running: true, autoReleaseEnabled: true, nextAutoReleaseAt: Date.now() + 60_000 },
      releaseResponse: { ok: true, body: { success: true, released: 3 } }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onNotice } = renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: '立即放行' }))

    await waitFor(() => expect(onNotice).toHaveBeenCalled())
    expect(String(onNotice.mock.calls[0][0])).toContain('3')
    const releaseCalls = calls.filter((c) => c.url.endsWith('/proxy/release-held'))
    expect(releaseCalls.length).toBe(1)
    expect(releaseCalls[0].method).toBe('POST')
    // 写操作必须带 CSRF 头，否则服务端一律 401
    expect(releaseCalls[0].headers['X-Panel-Request']).toBe('1')
  })

  it('放行了 0 个不当失败处理（幂等语义，只是当时没东西可放）', async () => {
    const { fetchMock } = stubServer({
      status: { running: true, autoReleaseEnabled: true, nextAutoReleaseAt: Date.now() + 60_000 },
      releaseResponse: { ok: true, body: { success: true, released: 0 } }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onNotice, onError } = renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: '立即放行' }))

    await waitFor(() => expect(onNotice).toHaveBeenCalled())
    // released=0 走的是提示而非错误出口
    expect(onError).not.toHaveBeenCalled()
  })

  it('反代未运行 → 放行按钮禁用（服务端会 409，先把原因说在前面）', async () => {
    const { fetchMock } = stubServer({ status: { running: false } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy())
    expect(screen.getByRole('button', { name: '立即放行' }).hasAttribute('disabled')).toBe(true)
  })

  it('放行失败（409）经统一错误出口上报，组件不自渲染 alert', async () => {
    const { fetchMock } = stubServer({
      status: { running: true },
      releaseResponse: { ok: false, status: 409, body: { code: 'PROXY_NOT_RUNNING' } }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onError } = renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: '立即放行' }))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    // 组件刻意不渲染自己的 role="alert"（App 顶部那一个是错误展示的唯一收口点）
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('放行按钮是手机可点的触控尺寸（h-11，与其它控件一致）', async () => {
    const { fetchMock } = stubServer({ status: { running: true } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())
    expect(screen.getByRole('button', { name: '立即放行' }).className).toContain('h-11')
  })
})

describe('反代面板 · 跨放行周期后与服务端重新对齐', () => {
  /**
   * 承重用例：本地倒计时走过 `nextAutoReleaseAt` 之后，界面必须显示**服务端的新读数**，
   * 而不是永久停在「即将放行 + 旧次数」。
   *
   * 这是手机面板与桌面端的结构性差异：桌面端消费推送事件
   * (`onProxyHeldRequestsChanged`) 所以周期一过自然拿到新值；面板没有这条推送通道，
   * 挂载后若不重新取数，它对服务端状态的认知就永久停在挂载那一刻。
   *
   * 判据刻意选**服务端独有的信息**（T2 时刻 + 次数 N+1）：这两个值本地无从推算，
   * 只可能来自一次新的 `GET /proxy/status`。若断言「即将放行」消失就够，
   * 那本地清空状态也能骗过测试。
   */
  it('倒计时到点后重新取数，显示服务端的新周期与新次数（不停在「即将放行」）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const t0 = Date.now()
      const { fetchMock, calls } = stubServer({
        status: [
          // 挂载读数：T1 = 2 秒后放行，已放行 4 次
          { running: true, autoReleaseEnabled: true, nextAutoReleaseAt: t0 + 2000, autoReleaseCount: 4 },
          // 服务端在 T1 放行了一次并排好下一周期：T2 = 挂载后 62 秒，次数 5
          { running: true, autoReleaseEnabled: true, nextAutoReleaseAt: t0 + 62_000, autoReleaseCount: 5 }
        ]
      })
      vi.stubGlobal('fetch', fetchMock)
      renderPanel()

      await waitFor(() => expect(screen.getByText('0:02')).toBeTruthy())
      const statusCallsBefore = calls.filter((c) => c.url.endsWith('/proxy/status')).length

      // 走过 T1（本地时钟越过 nextAutoReleaseAt）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000)
      })

      // 判据一：确实又问了一次服务端
      await waitFor(() =>
        expect(calls.filter((c) => c.url.endsWith('/proxy/status')).length).toBeGreaterThan(
          statusCallsBefore
        )
      )
      // 判据二：显示的是服务端的新次数（5），不是挂载时那个 4
      await waitFor(() => expect(screen.getByText('5')).toBeTruthy())
      // 判据三：新周期的倒计时重新走起来，而不是永久「即将放行」
      await waitFor(() => expect(screen.queryByText('即将放行')).toBeNull())
      expect(screen.getByText(/^0?5[0-8]$|^0:5\d$/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
