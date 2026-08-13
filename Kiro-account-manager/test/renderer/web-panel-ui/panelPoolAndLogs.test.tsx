import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyPanel } from '../../../src/webPanel/ui/ProxyPanel'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const statusProjection = {
  running: false,
  hasServer: false,
  host: '127.0.0.1',
  port: 18080,
  poolSize: 0,
  healthyAccounts: 0,
  currentAccountId: null,
  currentAccountEmail: null,
  currentAccountRemaining: null,
  currentAccountCapacity: null,
  currentAccountPercent: null,
  currentAccountResetsAt: null,
  strategy: 'round-robin',
  heldRequests: 0,
  holdGate: false,
  autoReleaseEnabled: false,
  nextAutoReleaseAt: null,
  autoReleaseCount: 0,
  currentEpisode: null,
  recentEpisodes: []
}

const configProjection = {
  editable: { logRequests: false },
  readOnly: [],
  apiKeys: { configured: false, count: 0, hints: [] },
  proxyListen: { host: '127.0.0.1', port: 18080, requiresRestart: false }
}

function standardResponse(url: string): Response | null {
  if (url.endsWith('/api/proxy/status')) return jsonResponse(statusProjection)
  if (url.endsWith('/api/proxy/config')) return jsonResponse(configProjection)
  if (url.endsWith('/api/proxy/api-keys')) return jsonResponse({ keys: [] })
  return null
}

function renderPanel(): void {
  render(
    <ProxyPanel
      accounts={[]}
      onError={() => undefined}
      onNotice={() => undefined}
      onSessionLost={() => undefined}
    />
  )
}

describe('手机面板日志与上游代理池区块', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('两个 GET 返回缺失投影时分别显示不可用态，反代主区块仍可渲染', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const standard = standardResponse(url)
        if (standard) return standard
        if (url.includes('/api/proxy/upstreams')) return jsonResponse({})
        if (url.includes('/api/proxy/logs')) return jsonResponse({})
        throw new Error(`unexpected fetch: ${url}`)
      })
    )

    renderPanel()

    expect(await screen.findByText('代理池数据不可用，请重试')).toBeInTheDocument()
    expect(await screen.findByText('日志数据不可用，请重试')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '反代服务' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '启动' })).toBeEnabled()
  })

  it('两个 GET 失败时分别显示失败态，不把整张页面带崩', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const standard = standardResponse(url)
        if (standard) return standard
        if (url.includes('/api/proxy/upstreams') || url.includes('/api/proxy/logs')) {
          return jsonResponse({ code: 'INTERNAL_ERROR', message: 'probe failure' }, 503)
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
    )

    renderPanel()

    expect(await screen.findByText(/代理池加载失败/)).toBeInTheDocument()
    expect(await screen.findByText(/日志加载失败/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '反代服务' })).toBeInTheDocument()
  })

  it('经真实 fetch 边界增改删代理，只用服务端安全投影重渲染且 DOM 不出现密码', async () => {
    const password = 'ui-upstream-password-987654'
    const username = 'ui-panel-user'
    let revision = 3
    let entries: Array<Record<string, unknown>> = []
    const writes: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const standard = standardResponse(url)
        if (standard) return standard
        if (url.includes('/api/proxy/logs')) {
          return jsonResponse({ total: 0, nextCursor: null, entries: [] })
        }
        if (url.endsWith('/api/proxy/upstreams') && (!init.method || init.method === 'GET')) {
          return jsonResponse({ revision, entries })
        }

        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        writes.push({ url, init, body })
        if (url.endsWith('/api/proxy/upstreams') && init.method === 'POST') {
          expect(body.url).toContain(password)
          revision = 4
          entries = [
            {
              id: 'upstream-1',
              protocol: 'socks5',
              host: '127.0.0.1',
              port: 1080,
              label: '服务端新增投影',
              status: 'untested',
              enabled: true,
              hasCredentials: true,
              usedCount: 0,
              failCount: 0
            }
          ]
          return jsonResponse({ revision, entries, accountPoolSyncPending: false })
        }
        if (url.endsWith('/api/proxy/upstreams/upstream-1') && init.method === 'PATCH') {
          revision = 5
          entries = [{ ...entries[0], label: '服务端规范化标签', enabled: false }]
          return jsonResponse({ revision, entries, accountPoolSyncPending: false })
        }
        if (url.endsWith('/api/proxy/upstreams/upstream-1/delete') && init.method === 'POST') {
          revision = 6
          entries = []
          return jsonResponse({ revision, entries, accountPoolSyncPending: false })
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
    )

    renderPanel()
    await screen.findByText('尚未配置上游代理')

    fireEvent.change(screen.getByLabelText('代理 URL（含凭据）'), {
      target: { value: `socks5://${username}:${password}@127.0.0.1:1080` }
    })
    fireEvent.change(screen.getByLabelText('代理标签'), { target: { value: '客户端标签' } })
    fireEvent.click(screen.getByRole('button', { name: '新增代理' }))

    expect(await screen.findByText('服务端新增投影')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(password)
    expect(document.body.textContent).not.toContain(username)
    expect(screen.getByLabelText('代理 URL（含凭据）')).toHaveValue('')
    expect(screen.getByText(/已配置凭据（不回显）/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑 upstream-1' }))
    fireEvent.change(screen.getByLabelText('编辑标签'), { target: { value: '客户端编辑值' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    expect(await screen.findByText('服务端规范化标签')).toBeInTheDocument()
    expect(screen.queryByText('客户端编辑值')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '删除 upstream-1' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除 upstream-1' }))
    expect(await screen.findByText('尚未配置上游代理')).toBeInTheDocument()

    expect(writes).toHaveLength(3)
    for (const write of writes) {
      expect(write.init.headers).toMatchObject({ 'X-Panel-Request': '1' })
    }
  })

  it('按服务端 cursor 加载更早日志，页面不请求整仓 10000 条', async () => {
    const requestedUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        requestedUrls.push(url)
        const standard = standardResponse(url)
        if (standard) return standard
        if (url.includes('/api/proxy/upstreams')) {
          return jsonResponse({ revision: 1, entries: [] })
        }
        if (url.includes('/api/proxy/logs') && url.includes('cursor=2')) {
          return jsonResponse({
            total: 3,
            nextCursor: null,
            entries: [
              {
                timestamp: '2026-08-13T10:00:00.000Z',
                level: 'INFO',
                category: 'Proxy',
                message: '更早一条'
              }
            ]
          })
        }
        if (url.includes('/api/proxy/logs')) {
          return jsonResponse({
            total: 3,
            nextCursor: 2,
            entries: [
              {
                timestamp: '2026-08-13T12:00:00.000Z',
                level: 'WARN',
                category: 'Proxy',
                message: '最新一条'
              }
            ]
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
    )

    renderPanel()
    expect(await screen.findByText('最新一条')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加载更早日志' }))
    expect(await screen.findByText('更早一条')).toBeInTheDocument()
    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes('/api/proxy/logs?limit=50'))).toBe(true)
      expect(requestedUrls.some((url) => url.includes('cursor=2'))).toBe(true)
      expect(requestedUrls.every((url) => !url.includes('limit=10000'))).toBe(true)
    })
  })
})
