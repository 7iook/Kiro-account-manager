/**
 * 手机面板 C2/C6 行为测试。
 *
 * 与 panelProxyPanel.test.tsx 一样只替换真实 `fetch` 边界，不 mock `api/panel.ts`：
 * 这样路径、HTTP 方法、CSRF 头和 JSON body 任一层漂移都会直接让用例失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AccountCard } from '../../../src/webPanel/ui/AccountCard'
import { ProxyPanel } from '../../../src/webPanel/ui/ProxyPanel'
import type { AccountListItem } from '../../../src/webPanel/api/panel'

interface SeenRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

const account: AccountListItem = {
  id: 'acc-a',
  email: 'alice@example.com',
  nickname: '旧备注',
  groupId: 'g1',
  status: 'active',
  isActive: true,
  tags: [],
  hasRefreshToken: true,
  canRefreshViaOidc: true,
  usage: { current: 20, limit: 100, percentUsed: 0.2 }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const proxyConfigView = {
  editable: { logRequests: false },
  readOnly: [
    { key: 'logStreamEvents', value: false, reason: '只能通过配置文件修改。' },
    { key: 'enablePerfDiagLog', value: false, reason: '只能通过配置文件修改。' },
    { key: 'enableAuditLog', value: false, reason: '手机配置审计始终开启。' },
    {
      key: 'modelMappings',
      value: { configured: false, count: 0 },
      reason: '模型映射只读。'
    },
    { key: 'agentMode', value: 'vibe', reason: 'Agent 模式只读。' },
    { key: 'payloadSizeLimitKB', value: null, reason: 'Payload 上限只读。' }
  ],
  apiKeys: { configured: false, count: 0, hints: [] },
  proxyListen: { host: '127.0.0.1', port: 5580, requiresRestart: false }
}

function normaliseHeaders(input: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(input)
  return Object.fromEntries(
    [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value])
  )
}

function installAccountServer(options: { undoWindowMs?: number } = {}): { calls: SeenRequest[] } {
  const calls: SeenRequest[] = []
  let deleted = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const request: SeenRequest = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url: String(input),
        headers: normaliseHeaders(init?.headers),
        ...(rawBody ? { body: rawBody as Record<string, unknown> } : {})
      }
      calls.push(request)

      if (request.url.endsWith('/accounts') && request.method === 'GET') {
        return response({ revision: deleted ? 8 : 7, accounts: deleted ? [] : [account] })
      }
      if (request.url.endsWith('/proxy/status')) {
        return response({
          success: true,
          running: true,
          port: 5580,
          enableMultiAccount: false,
          poolSize: deleted ? 0 : 1,
          availableCount: deleted ? 0 : 1,
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          autoReleaseEnabled: false,
          nextAutoReleaseAt: null,
          autoReleaseCount: 0,
          currentEpisode: null,
          recentEpisodes: []
        })
      }
      if (request.url.endsWith('/proxy/config') && request.method === 'GET') {
        return response(proxyConfigView)
      }
      if (request.url.endsWith('/account-groups')) {
        return response({
          groups: [
            { id: 'g1', name: '主力', color: '#10b981', order: 1 },
            { id: 'g2', name: '备用', color: '#64748b', order: 2 }
          ]
        })
      }
      if (request.url.endsWith('/accounts/acc-a') && request.method === 'PATCH') {
        return response({
          success: true,
          revision: 8,
          account: { id: 'acc-a', nickname: '手机备注', groupId: 'g2', isActive: true }
        })
      }
      if (request.url.endsWith('/accounts/acc-a/delete')) {
        deleted = true
        return response({
          success: true,
          revision: 8,
          undoUntil: Date.now() + (options.undoWindowMs ?? 600_000),
          proxyPoolSyncPending: false
        })
      }
      if (request.url.endsWith('/accounts/acc-a/restore')) {
        deleted = false
        return response({
          success: true,
          revision: 9,
          account: { id: 'acc-a', nickname: '旧备注', groupId: 'g1', isActive: false },
          proxyPoolSyncPending: false
        })
      }
      return response({ code: 'ACCOUNT_NOT_FOUND' }, 404)
    })
  )
  return { calls }
}

function renderAccountCard(item: AccountListItem = account): void {
  render(
    <AccountCard
      item={item}
      pending={null}
      onCheck={vi.fn()}
      onRefreshToken={vi.fn()}
      onSwitch={vi.fn()}
      onSwitchCli={vi.fn()}
      onToggleOverage={vi.fn()}
      onOpenSubscription={vi.fn()}
    />
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('C2 · 手机编辑账号备注和分组', () => {
  it('从真实列表快照取 revision，只发送白名单补丁并就地显示服务端结果', async () => {
    const { calls } = installAccountServer()
    renderAccountCard()
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(screen.getByRole('button', { name: '编辑账号' }))

    const dialog = await screen.findByRole('dialog', { name: '编辑账号' })
    const nickname = within(dialog).getByRole('textbox', { name: '账号备注' })
    await userEvent.clear(nickname)
    await userEvent.type(nickname, '手机备注')
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: '账号分组' }), 'g2')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByText('手机备注')).toBeTruthy())
    const patch = calls.find(
      (call) => call.method === 'PATCH' && call.url.endsWith('/accounts/acc-a')
    )
    expect(patch).toMatchObject({
      headers: { 'x-panel-request': '1' },
      body: { expectedRevision: 7, nickname: '手机备注', groupId: 'g2' }
    })
    expect(Object.keys(patch?.body ?? {}).sort()).toEqual([
      'expectedRevision',
      'groupId',
      'nickname'
    ])
  })
})

describe('C2 · 手机删除账号的确认与撤销', () => {
  it('必须输入目标邮箱才能删除，删除后当前页面提供 10 分钟撤销', async () => {
    const { calls } = installAccountServer()
    renderAccountCard()
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(screen.getByRole('button', { name: '删除账号' }))

    const dialog = screen.getByRole('dialog', { name: '确认删除账号' })
    const confirmButton = within(dialog).getByRole('button', { name: '确认删除' })
    expect(confirmButton.hasAttribute('disabled')).toBe(true)
    const confirmation = within(dialog).getByRole('textbox', {
      name: '输入 alice@example.com 以确认'
    })
    await userEvent.type(confirmation, 'alice')
    expect(confirmButton.hasAttribute('disabled')).toBe(true)
    await userEvent.clear(confirmation)
    await userEvent.type(confirmation, 'alice@example.com')
    expect(confirmButton.hasAttribute('disabled')).toBe(false)
    await userEvent.click(confirmButton)

    await waitFor(() => expect(screen.getByText(/账号已删除/)).toBeTruthy())
    const deletion = calls.find((call) => call.url.endsWith('/accounts/acc-a/delete'))
    expect(deletion).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' },
      body: { expectedRevision: 7 }
    })

    await userEvent.click(screen.getByRole('button', { name: '撤销删除' }))
    await waitFor(() => expect(screen.getByText('旧备注')).toBeTruthy())
    const restore = calls.find((call) => call.url.endsWith('/accounts/acc-a/restore'))
    expect(restore).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' }
    })
  })

  it('删除和恢复后反代选号重新读取服务端账号，不继续展示父组件旧快照', async () => {
    const { calls } = installAccountServer()
    render(
      <>
        <ProxyPanel
          accounts={[account]}
          onNotice={vi.fn()}
          onError={vi.fn()}
          onSessionLost={vi.fn()}
        />
        <AccountCard
          item={account}
          pending={null}
          onCheck={vi.fn()}
          onRefreshToken={vi.fn()}
          onSwitch={vi.fn()}
          onSwitchCli={vi.fn()}
          onToggleOverage={vi.fn()}
          onOpenSubscription={vi.fn()}
        />
      </>
    )
    await screen.findByText('运行中 · 端口 5580')

    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(screen.getByRole('button', { name: '删除账号' }))
    const confirmDialog = screen.getByRole('dialog', { name: '确认删除账号' })
    await userEvent.type(
      within(confirmDialog).getByRole('textbox', {
        name: '输入 alice@example.com 以确认'
      }),
      'alice@example.com'
    )
    await userEvent.click(within(confirmDialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.endsWith('/accounts'))
      ).toHaveLength(2)
    )

    await userEvent.click(screen.getByRole('button', { name: '选择账号' }))
    let picker = screen.getByRole('dialog', { name: '选择反代账号' })
    expect(within(picker).getByText('暂无账号')).toBeTruthy()
    await userEvent.click(within(picker).getByRole('button', { name: '取消' }))

    await userEvent.click(screen.getByRole('button', { name: '撤销删除' }))
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.endsWith('/accounts'))
      ).toHaveLength(3)
    )
    await userEvent.click(screen.getByRole('button', { name: '选择账号' }))
    picker = screen.getByRole('dialog', { name: '选择反代账号' })
    expect(within(picker).getByText('alice@example.com')).toBeTruthy()
  })

  it('撤销入口按服务端 undoUntil 自动失效，不继续提供必败操作', async () => {
    installAccountServer({ undoWindowMs: 50 })
    renderAccountCard()
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(screen.getByRole('button', { name: '删除账号' }))
    const dialog = screen.getByRole('dialog', { name: '确认删除账号' })
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: '输入 alice@example.com 以确认' }),
      'alice@example.com'
    )
    await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))

    const undo = await screen.findByRole('button', { name: '撤销删除' })
    expect(undo.hasAttribute('disabled')).toBe(false)
    await waitFor(() => expect(undo.hasAttribute('disabled')).toBe(true))
    expect(screen.getByText(/撤销窗口已结束/)).toBeTruthy()
  })
})

describe('台账 #27 · 手机强制解除账号封禁', () => {
  it('必须输入目标标识二次确认，并明确告知未验证上游且可能立刻再次被封', async () => {
    const suspendedAccount: AccountListItem = {
      ...account,
      status: 'error',
      lastError: '[TEMPORARILY_SUSPENDED] Account blocked by upstream'
    }
    const calls: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request: SeenRequest = {
          method: (init?.method ?? 'GET').toUpperCase(),
          url: String(input),
          headers: normaliseHeaders(init?.headers),
          ...(typeof init?.body === 'string'
            ? { body: JSON.parse(init.body) as Record<string, unknown> }
            : {})
        }
        calls.push(request)
        if (request.method === 'POST' && request.url.endsWith('/accounts/acc-a/unsuspend')) {
          return response({
            success: true,
            cleared: true,
            upstreamVerified: false,
            account: {
              ...account,
              status: 'active'
            },
            runtime: {
              proxyInitialized: true,
              inProxyPool: true,
              suspended: false,
              proxyPoolSyncPending: false
            }
          })
        }
        return response({ code: 'ACCOUNT_NOT_FOUND' }, 404)
      })
    )

    renderAccountCard(suspendedAccount)
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }))
    await userEvent.click(screen.getByRole('button', { name: '强制解除封禁' }))

    const dialog = screen.getByRole('dialog', { name: '强制解除账号封禁' })
    expect(within(dialog).getByText(/不会向上游验证/)).toBeTruthy()
    expect(within(dialog).getByText(/未验证.*可能立刻再次被封/)).toBeTruthy()

    const confirm = within(dialog).getByRole('button', { name: '确认强制解除' })
    expect(confirm).toBeDisabled()
    const input = within(dialog).getByRole('textbox', {
      name: '输入 alice@example.com 以确认强制解除'
    })
    await userEvent.type(input, 'alice')
    expect(confirm).toBeDisabled()
    expect(calls).toHaveLength(0)
    await userEvent.clear(input)
    await userEvent.type(input, 'alice@example.com')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)

    await waitFor(() => expect(screen.getByText('正常')).toBeTruthy())
    expect(
      screen.getByText(/本机封禁标记已清除.*已回到反代池.*上游状态未验证.*可能立刻再次被封/)
    ).toBeTruthy()
    const request = calls.find((call) => call.url.endsWith('/accounts/acc-a/unsuspend'))
    expect(request).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' },
      body: { confirmation: 'FORCE_UNSUSPEND' }
    })
    expect(calls.some((call) => call.url.endsWith('/accounts/acc-a/check'))).toBe(false)
  })
})

describe('C6 · 手机轮换 adminKey', () => {
  it('二次确认后只展示一次新密钥，用户确认保存前不离开页面', async () => {
    const nextKey = 'new-admin-key-shown-exactly-once-0123456789'
    const calls: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request: SeenRequest = {
          method: (init?.method ?? 'GET').toUpperCase(),
          url: String(input),
          headers: normaliseHeaders(init?.headers)
        }
        calls.push(request)
        if (request.url.endsWith('/proxy/status')) {
          return response({
            success: true,
            running: false,
            enableMultiAccount: false,
            poolSize: 1,
            availableCount: 1,
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            autoReleaseEnabled: false,
            nextAutoReleaseAt: null,
            autoReleaseCount: 0,
            currentEpisode: null,
            recentEpisodes: []
          })
        }
        if (request.url.endsWith('/proxy/config') && request.method === 'GET') {
          return response(proxyConfigView)
        }
        if (request.url.endsWith('/admin-key/rotate')) return response({ key: nextKey })
        return response({ code: 'ACCOUNT_NOT_FOUND' }, 404)
      })
    )
    const onSessionLost = vi.fn()
    render(
      <ProxyPanel
        accounts={[account]}
        onNotice={vi.fn()}
        onError={vi.fn()}
        onSessionLost={onSessionLost}
      />
    )
    await screen.findByText('未运行')

    await userEvent.click(screen.getByRole('button', { name: '轮换管理密钥' }))
    const confirmDialog = screen.getByRole('dialog', { name: '轮换管理密钥' })
    const rotate = within(confirmDialog).getByRole('button', { name: '确认轮换' })
    expect(rotate.hasAttribute('disabled')).toBe(true)
    await userEvent.type(
      within(confirmDialog).getByRole('textbox', { name: '输入“轮换”以确认' }),
      '轮换'
    )
    await userEvent.click(rotate)

    const delivery = await screen.findByRole('dialog', { name: '保存新的管理密钥' })
    expect(within(delivery).getByText(nextKey)).toBeTruthy()
    expect(onSessionLost).not.toHaveBeenCalled()
    const request = calls.find((call) => call.url.endsWith('/admin-key/rotate'))
    expect(request).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' }
    })

    await userEvent.click(within(delivery).getByRole('button', { name: '我已保存，重新登录' }))
    expect(onSessionLost).toHaveBeenCalledTimes(1)
  })
})
