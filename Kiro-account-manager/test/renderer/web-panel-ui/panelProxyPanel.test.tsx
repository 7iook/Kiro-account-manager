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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProxyPanel } from '../../../src/webPanel/ui/ProxyPanel'
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
      usage: { percentUsed: 30 }
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
}

/** 可编程的假服务端。`statusQueue` 让每次 GET /status 返回不同读数 */
function stubServer(opts: {
  status: StatusShape | StatusShape[]
  startResponse?: { ok: boolean; body?: unknown; status?: number }
  activateResponse?: { ok: boolean; body?: unknown; status?: number }
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
        failedRequests: s.failedRequests ?? 0
      })
    }
    if (url.endsWith('/proxy/start')) {
      const r = opts.startResponse ?? { ok: true, body: { success: true, poolSize: 2 } }
      return json(r.body ?? { success: true }, r.ok ? 200 : (r.status ?? 409))
    }
    if (url.endsWith('/proxy/stop')) return json({ success: true, running: false })
    if (url.endsWith('/proxy/sync-pool')) return json({ success: true, poolSize: 2 })
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

  it('选号弹窗只列状态正常的账号（其余服务端会拒，列出来只会让用户白点）', async () => {
    const { fetchMock } = stubServer({ status: { running: true } })
    vi.stubGlobal('fetch', fetchMock)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/运行中/)).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '选择账号' }))

    const dialog = screen.getByRole('dialog', { name: '选择反代账号' })
    expect(within(dialog).getByText('alice@example.com')).toBeTruthy()
    expect(within(dialog).getByText('bob@example.com')).toBeTruthy()
    // status='error' 的账号不该出现
    expect(within(dialog).queryByText('dead@example.com')).toBeNull()
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
