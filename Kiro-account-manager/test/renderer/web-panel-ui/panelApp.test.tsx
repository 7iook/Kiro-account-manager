/**
 * 局域网面板 UI 的行为测试 —— 断言用户看得到的结果与真实发出的 HTTP 请求，
 * 不断言内部函数调用。
 *
 * ## 为什么 mock 的是 `fetch` 而不是 `api/panel.ts`
 *
 * CSRF 头（`X-Panel-Request: 1`）是**网络边界上的事实**：服务端
 * `main/webPanel/auth.ts:guard()` 只看请求头，不看调用了哪个函数。
 * 若 mock 掉 `panel.ts`，那就成了「断言我调了自己写的函数」——
 * 恰好把唯一会真正出错的那一层（有没有把头带上）绕过去了。
 * 在 `fetch` 这一层拦，测的才是服务端实际会收到的东西。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../../src/webPanel/App'

/** 一条最小但字段齐全的账号 DTO（形状取自 `main/webPanel/dto.ts:AccountListItem`） */
function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acc-1',
    email: 'alice@example.com',
    idp: 'Google',
    status: 'active',
    isActive: false,
    tags: [],
    hasRefreshToken: true,
    canRefreshViaOidc: true,
    subscription: { type: 'Pro', title: 'KIRO PRO', daysRemaining: 20 },
    usage: { current: 250, limit: 1000, percentUsed: 0.25 },
    ...overrides
  }
}

interface StubRoute {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** 记录下来的请求 —— 断言 CSRF 头用 */
interface SeenRequest {
  url: string
  method: string
  headers: Record<string, string>
}

let seen: SeenRequest[] = []

/**
 * 按 `METHOD /path` 建立路由桩。未命中的路径一律 500 并让测试失败可见 ——
 * 静默返回空对象会让「UI 压根没发那个请求」看起来像通过。
 */
function stubFetch(routes: Record<string, StubRoute>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v
      }
      seen.push({ url: input, method, headers })

      const route = routes[`${method} ${input}`] ?? routes[`${method} *`]
      const status = route?.status ?? (route ? 200 : 500)
      const body = route?.body ?? (route ? {} : { code: 'INTERNAL_ERROR' })
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => route?.headers?.[name.toLowerCase()] ?? null },
        text: async () => JSON.stringify(body)
      } as unknown as Response
    })
  )
}

/** 已登录起步：session 通过 + 列表返回给定账号 */
function stubLoggedIn(accounts: unknown[], extra: Record<string, StubRoute> = {}): void {
  stubFetch({
    'GET /panel/api/session': { body: { ok: true, authenticated: true } },
    'GET /panel/api/accounts': { body: { accounts, revision: 1 } },
    ...extra
  })
}

beforeEach(() => {
  seen = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('登录', () => {
  it('密钥错误时显示错误提示，且不进入账号列表', async () => {
    // 服务端对「密钥错」与「未设密钥」返回同一个 401（不泄漏可利用信息）
    stubFetch({
      'GET /panel/api/session': { status: 401, body: { code: 'UNAUTHORIZED' } },
      'POST /panel/api/login': { status: 401, body: { code: 'UNAUTHORIZED' } }
    })
    render(<App />)

    const input = await screen.findByLabelText('管理密钥')
    await userEvent.type(input, 'wrong-key')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))

    // 看得见的失败提示
    expect(await screen.findByRole('alert')).toHaveTextContent(/密钥/)
    // 关键：没有前进到列表 —— 登录框仍在
    expect(screen.getByLabelText('管理密钥')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '账号列表' })).not.toBeInTheDocument()
  })

  it('未登录时启动直接显示登录页（会话端点 401 不算异常）', async () => {
    stubFetch({ 'GET /panel/api/session': { status: 401, body: { code: 'UNAUTHORIZED' } } })
    render(<App />)
    expect(await screen.findByLabelText('管理密钥')).toBeInTheDocument()
  })

  it('限流时提示稍后再试，并带上服务端给的等待秒数', async () => {
    stubFetch({
      'GET /panel/api/session': { status: 401, body: { code: 'UNAUTHORIZED' } },
      'POST /panel/api/login': {
        status: 429,
        body: { code: 'RATE_LIMITED' },
        headers: { 'retry-after': '30' }
      }
    })
    render(<App />)
    await userEvent.type(await screen.findByLabelText('管理密钥'), 'k')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/30/)
  })
})

describe('账号列表', () => {
  it('从接口响应渲染出账号与额度', async () => {
    stubLoggedIn([account()])
    render(<App />)

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument()
    // 额度以「已用 / 上限」呈现 —— 用户日常就看这个数
    expect(screen.getByText(/250/)).toBeInTheDocument()
    expect(screen.getByText(/1,?000/)).toBeInTheDocument()
    expect(screen.getByText('KIRO PRO')).toBeInTheDocument()
  })

  it('空列表时给出「去桌面端导入」的说明，而不是一片空白', async () => {
    stubLoggedIn([])
    render(<App />)
    expect(await screen.findByText(/桌面端/)).toBeInTheDocument()
  })

  it('渲染多个账号，各自独立', async () => {
    stubLoggedIn([
      account(),
      account({
        id: 'acc-2',
        email: 'bob@example.com',
        usage: { current: 900, limit: 1000, percentUsed: 0.9 }
      })
    ])
    render(<App />)
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('bob@example.com')).toBeInTheDocument()
  })

  it('不渲染任何凭据字段（DTO 不给 token，UI 也不得显示存在性以外的东西）', async () => {
    stubLoggedIn([account()])
    render(<App />)
    await screen.findByText('alice@example.com')
    expect(document.body.textContent).not.toMatch(/accessToken|refreshToken|eyJ/)
  })
})

describe('写操作', () => {
  it('刷新额度的请求带上 CSRF 头 X-Panel-Request: 1', async () => {
    stubLoggedIn([account()], {
      'POST /panel/api/accounts/acc-1/check': {
        body: { success: true, data: { usage: { current: 400, limit: 1000, percentUsed: 0.4 } } }
      }
    })
    render(<App />)
    await screen.findByText('alice@example.com')

    await userEvent.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => {
      const write = seen.find((r) => r.url === '/panel/api/accounts/acc-1/check')
      expect(write, '刷新按钮没有发出 check 请求').toBeTruthy()
      // 缺这个头服务端就是 401 —— 这是本测试的全部理由
      expect(write!.headers['x-panel-request']).toBe('1')
    })
  })

  it('刷新后就地更新额度显示（服务端不落盘，重拉列表只会拿回旧值）', async () => {
    stubLoggedIn([account()], {
      'POST /panel/api/accounts/acc-1/check': {
        body: { success: true, data: { usage: { current: 400, limit: 1000, percentUsed: 0.4 } } }
      }
    })
    render(<App />)
    await screen.findByText('alice@example.com')
    expect(screen.getByText(/250/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '刷新额度' }))

    expect(await screen.findByText(/400/)).toBeInTheDocument()
  })

  it('读操作不带 CSRF 头（与服务端 READ_METHODS 判据一致）', async () => {
    stubLoggedIn([account()])
    render(<App />)
    await screen.findByText('alice@example.com')
    const read = seen.find((r) => r.url === '/panel/api/accounts')
    expect(read!.headers['x-panel-request']).toBeUndefined()
  })

  it('写操作失败时显示错误码对应的文案，不静默', async () => {
    stubLoggedIn([account()], {
      'POST /panel/api/accounts/acc-1/check': {
        status: 502,
        body: { code: 'TOKEN_REFRESH_FAILED' }
      }
    })
    render(<App />)
    await screen.findByText('alice@example.com')
    await userEvent.click(screen.getByRole('button', { name: '刷新额度' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/刷新 Token 失败/)
  })
})

describe('会话失效', () => {
  it('写操作返回 401 时退回登录页', async () => {
    stubLoggedIn([account()], {
      'POST /panel/api/accounts/acc-1/check': { status: 401, body: { code: 'UNAUTHORIZED' } }
    })
    render(<App />)
    await screen.findByText('alice@example.com')

    await userEvent.click(screen.getByRole('button', { name: '刷新额度' }))

    // 观察点是「用户又看到登录框了」，不是某个内部 state
    expect(await screen.findByLabelText('管理密钥')).toBeInTheDocument()
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument()
  })

  it('列表读取返回 401 时同样退回登录页', async () => {
    stubFetch({
      'GET /panel/api/session': { body: { ok: true, authenticated: true } },
      'GET /panel/api/accounts': { status: 401, body: { code: 'UNAUTHORIZED' } }
    })
    render(<App />)
    expect(await screen.findByLabelText('管理密钥')).toBeInTheDocument()
  })
})

describe('桌面端专属能力', () => {
  it('没有「添加账号」按钮，而是说明需在桌面端导入', async () => {
    stubLoggedIn([account()])
    render(<App />)
    await screen.findByText('alice@example.com')
    expect(screen.queryByRole('button', { name: /添加账号/ })).not.toBeInTheDocument()
    expect(screen.getByText(/桌面端/)).toBeInTheDocument()
  })
})
