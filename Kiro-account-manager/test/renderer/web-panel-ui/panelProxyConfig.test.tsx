/**
 * 手机面板 C1 配置行为测试。
 *
 * 与其它 web-panel-ui 用例一样，只替换浏览器的 fetch 边界，不 mock
 * `api/panel.ts`。这样 HTTP 方法、路径、CSRF 头、请求体和响应投影任一处漂移，
 * 都会在用户可见行为测试里直接暴露。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProxyPanel } from '../../../src/webPanel/ui/ProxyPanel'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const proxyStatus = {
  success: true,
  running: true,
  port: 5580,
  host: '127.0.0.1',
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
}

const configView = {
  editable: { logRequests: true },
  readOnly: [
    {
      key: 'logStreamEvents',
      value: false,
      reason: '流式事件日志可能产生大量内容，只能通过配置文件修改。'
    },
    {
      key: 'enablePerfDiagLog',
      value: false,
      reason: '性能诊断会持续写入按天文件，只能通过配置文件修改。'
    },
    {
      key: 'enableAuditLog',
      value: true,
      reason: '数据面审计开关只读，手机配置审计始终开启。'
    },
    {
      key: 'modelMappings',
      value: { configured: true, count: 3 },
      reason: '模型映射影响所有请求，需要修改配置文件并重启。'
    },
    {
      key: 'agentMode',
      value: 'vibe',
      reason: 'Agent 模式影响请求语义，只能通过配置文件修改。'
    },
    {
      key: 'payloadSizeLimitKB',
      value: 1024,
      reason: 'Payload 上限影响请求完整性，只能通过配置文件修改。'
    }
  ],
  apiKeys: {
    configured: true,
    count: 2,
    hints: ['legacy:configured', 'key:0123456789ab']
  },
  proxyListen: {
    host: '0.0.0.0',
    port: 5580,
    requiresRestart: true
  }
}

interface SeenRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

function installServer(
  options: {
    initialConfig?: typeof configView
    loadResponse?: () => Response | Promise<Response>
    saveResult?: {
      appliedFields: string[]
      requiresRestart: boolean
      config: unknown
    }
    saveError?: { status: number; code: string }
    handleRequest?: (request: SeenRequest) => Response | Promise<Response> | undefined
  } = {}
): { calls: SeenRequest[] } {
  const calls: SeenRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const request: SeenRequest = {
        method,
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {})
      }
      calls.push(request)
      const handled = options.handleRequest?.(request)
      if (handled !== undefined) return handled
      if (method === 'GET' && url.endsWith('/proxy/status')) return json(proxyStatus)
      if (method === 'GET' && url.endsWith('/proxy/config')) {
        if (options.loadResponse) return options.loadResponse()
        return json(options.initialConfig ?? configView)
      }
      if (method === 'GET' && url.endsWith('/proxy/api-keys')) {
        return json({
          keys: [
            { id: 'legacy', hint: 'legacy:configured', createdAt: null, verifiedAt: null },
            {
              id: 'key-existing',
              hint: 'key:0123456789ab',
              createdAt: 1_700_000_000_000,
              verifiedAt: 1_700_000_060_000
            }
          ]
        })
      }
      if (method === 'POST' && url.endsWith('/proxy/config') && options.saveError) {
        return json({ code: options.saveError.code }, options.saveError.status)
      }
      if (method === 'POST' && url.endsWith('/proxy/config') && options.saveResult) {
        return json(options.saveResult)
      }
      throw new Error(`未处理的测试请求：${method} ${url}`)
    })
  )
  return { calls }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('C1 · 手机反代配置', () => {
  it('配置响应为空时显示缺失说明，且选号仍可交互', async () => {
    installServer({
      loadResponse: () =>
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    expect(await screen.findByText(/服务端没有返回完整的反代配置/)).toBeInTheDocument()
    const accountPicker = screen.getByRole('button', { name: '选择账号' })
    expect(accountPicker).toBeEnabled()
    await userEvent.click(accountPicker)
    expect(screen.getByRole('dialog', { name: '选择反代账号' })).toBeInTheDocument()
  })

  it('配置请求失败时显示故障说明而不是持续转圈，且选号仍可交互', async () => {
    const onError = vi.fn()
    installServer({
      loadResponse: () => json({ code: 'INTERNAL_ERROR' }, 503)
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={onError} onSessionLost={vi.fn()} />
    )

    expect(await screen.findByText(/读取反代配置失败：.*检查电脑端面板服务/)).toBeInTheDocument()
    expect(screen.queryByText(/正在读取反代配置/)).not.toBeInTheDocument()
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/读取反代配置失败/))

    const accountPicker = screen.getByRole('button', { name: '选择账号' })
    expect(accountPicker).toBeEnabled()
    await userEvent.click(accountPicker)
    expect(screen.getByRole('dialog', { name: '选择反代账号' })).toBeInTheDocument()
  })

  it('配置仍在加载时明确显示进度，且不阻塞选号', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installServer({
      loadResponse: async () => {
        await gate
        return json(configView)
      }
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    expect(await screen.findByText(/正在读取反代配置.*其他功能仍可使用/)).toBeInTheDocument()
    const accountPicker = await screen.findByRole('button', { name: '选择账号' })
    await waitFor(() => expect(accountPicker).toBeEnabled())
    await userEvent.click(accountPicker)
    expect(screen.getByRole('dialog', { name: '选择反代账号' })).toBeInTheDocument()

    await act(async () => {
      release?.()
      await gate
    })
    expect(await screen.findByRole('checkbox', { name: '记录反代请求日志' })).toBeInTheDocument()
  })

  it('配置区块渲染异常时只替换该区块，选号仍可交互', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    installServer({
      initialConfig: {
        ...configView,
        editable: { logRequests: false }
      },
      saveResult: {
        appliedFields: ['logRequests'],
        requiresRestart: false,
        config: {
          ...configView,
          editable: { logRequests: true },
          apiKeys: undefined
        }
      }
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '反代配置' })
    await userEvent.click(within(section).getByRole('checkbox', { name: '记录反代请求日志' }))
    await userEvent.click(within(section).getByRole('button', { name: '保存请求日志设置' }))

    expect(await screen.findByText(/反代配置暂时无法显示.*其他功能仍可使用/)).toBeInTheDocument()
    expect(
      errorLog.mock.calls.some(([message]) =>
        String(message).includes('[WebPanel] 反代配置渲染失败')
      )
    ).toBe(true)
    const accountPicker = screen.getByRole('button', { name: '选择账号' })
    expect(accountPicker).toBeEnabled()
    await userEvent.click(accountPicker)
    expect(screen.getByRole('dialog', { name: '选择反代账号' })).toBeInTheDocument()
  })

  it('展示可编辑请求日志、API Key 摘要、监听地址，以及每个只读项的原因', async () => {
    installServer()
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    expect(await screen.findByRole('heading', { name: '反代配置' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '记录反代请求日志' })).toBeChecked()

    expect(screen.getByText('logStreamEvents')).toBeInTheDocument()
    expect(screen.getByText(/流式事件日志可能产生大量内容/)).toBeInTheDocument()
    expect(screen.getByText('enablePerfDiagLog')).toBeInTheDocument()
    expect(screen.getByText(/性能诊断会持续写入按天文件/)).toBeInTheDocument()
    expect(screen.getByText('enableAuditLog')).toBeInTheDocument()
    expect(screen.getByText(/数据面审计开关只读/)).toBeInTheDocument()
    expect(screen.getByText('modelMappings')).toBeInTheDocument()
    expect(screen.getByText(/模型映射影响所有请求/)).toBeInTheDocument()
    expect(screen.getByText('agentMode')).toBeInTheDocument()
    expect(screen.getByText(/Agent 模式影响请求语义/)).toBeInTheDocument()
    expect(screen.getAllByText('payloadSizeLimitKB').length).toBeGreaterThan(0)
    expect(screen.getByText('请求载荷上限')).toBeInTheDocument()
    expect(screen.getByText(/Payload 上限影响请求完整性/)).toBeInTheDocument()

    expect(screen.getByText('已配置 2 个')).toBeInTheDocument()
    expect(screen.getByText('legacy:configured')).toBeInTheDocument()
    expect(screen.getByText('key:0123456789ab')).toBeInTheDocument()
    expect(screen.getByText('0.0.0.0:5580')).toBeInTheDocument()
    expect(screen.getByText(/修改监听地址后需重启反代服务/)).toBeInTheDocument()
    expect(
      screen.getByText(/端口与 API Key 会影响连接或鉴权，必须通过专用操作二次确认/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/面板监听、IP 规则、转发信任和部署字段.*永久不能从手机面板修改/)
    ).toBeInTheDocument()
  })

  it('保存只发送 logRequests patch，并按 POST 返回的 config 显示服务端实际值', async () => {
    const initialConfig = {
      ...configView,
      editable: { logRequests: false }
    }
    const { calls } = installServer({
      initialConfig,
      // 刻意让服务端没有采用用户勾选的 true：若 UI 乐观更新，它会继续显示开启；
      // 正确行为是以这个响应投影为准，回到关闭并明确说未应用。
      saveResult: {
        appliedFields: [],
        requiresRestart: false,
        config: initialConfig
      }
    })
    const onNotice = vi.fn()
    render(
      <ProxyPanel accounts={[]} onNotice={onNotice} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '反代配置' })
    const toggle = within(section).getByRole('checkbox', { name: '记录反代请求日志' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(toggle).toBeChecked()
    await userEvent.click(within(section).getByRole('button', { name: '保存请求日志设置' }))

    await waitFor(() => {
      const request = calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/proxy/config')
      )
      expect(request).toMatchObject({
        headers: { 'x-panel-request': '1' },
        body: { changes: { logRequests: true } }
      })
      expect(Object.keys((request?.body as { changes: object }).changes)).toEqual(['logRequests'])
    })

    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(within(section).getByText('服务端当前值：已关闭')).toBeInTheDocument()
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/未应用所选值/))
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/已生效/))
  })

  it('服务端返回 requiresRestart 时只提示需重启，不谎报已经生效', async () => {
    const initialConfig = {
      ...configView,
      editable: { logRequests: false }
    }
    installServer({
      initialConfig,
      saveResult: {
        appliedFields: ['logRequests'],
        requiresRestart: true,
        config: {
          ...initialConfig,
          editable: { logRequests: true }
        }
      }
    })
    const onNotice = vi.fn()
    render(
      <ProxyPanel accounts={[]} onNotice={onNotice} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '反代配置' })
    await userEvent.click(within(section).getByRole('checkbox', { name: '记录反代请求日志' }))
    await userEvent.click(within(section).getByRole('button', { name: '保存请求日志设置' }))

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/需重启.*才生效/))
    )
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/已生效/))
  })

  it('即使敏感项误入只读投影也只显示字段与原因，不把原值写进页面', async () => {
    const originalSecret = 'full-api-key-never-render-0123456789'
    installServer({
      initialConfig: {
        ...configView,
        readOnly: [
          ...configView.readOnly,
          {
            key: 'apiKey',
            value: originalSecret,
            reason: '密钥只能通过专用二次确认动作修改。'
          }
        ]
      }
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    await screen.findByRole('region', { name: '反代配置' })
    expect(screen.getAllByText('apiKey').length).toBeGreaterThan(0)
    expect(screen.getByText(/密钥只能通过专用二次确认动作修改/)).toBeInTheDocument()
    expect(screen.getByText(/敏感值不在面板显示/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(originalSecret)
  })

  it('INVALID_CONFIG 使用配置专用中文错误，失败后仍显示服务端旧值与未保存草稿', async () => {
    installServer({
      initialConfig: {
        ...configView,
        editable: { logRequests: false }
      },
      saveError: { status: 400, code: 'INVALID_CONFIG' }
    })
    const onError = vi.fn()
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={onError} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '反代配置' })
    const toggle = within(section).getByRole('checkbox', { name: '记录反代请求日志' })
    await userEvent.click(toggle)
    await userEvent.click(within(section).getByRole('button', { name: '保存请求日志设置' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('配置内容无效，请检查后重试'))
    expect(toggle).toBeChecked()
    expect(within(section).getByText('服务端当前值：已关闭')).toBeInTheDocument()
    expect(within(section).getByText('有未保存更改')).toBeInTheDocument()
  })

  it('配置仍未加载且 API Key GET 失败时，新操作区各自显示状态，不带崩反代面板', async () => {
    let releaseConfig: (() => void) | undefined
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve
    })
    installServer({
      loadResponse: async () => {
        await configGate
        return json(configView)
      },
      handleRequest: (request) => {
        if (request.method === 'GET' && request.url.endsWith('/proxy/api-keys')) {
          return json({ code: 'INTERNAL_ERROR' }, 503)
        }
        return undefined
      }
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const portSection = await screen.findByRole('region', { name: '更改反代端口' })
    expect(within(portSection).getByText(/等待反代配置读取完成/)).toBeInTheDocument()
    const keySection = screen.getByRole('region', { name: 'API Key 生命周期' })
    expect(
      await within(keySection).findByText(/读取 API Key 列表失败.*其它反代操作仍可使用/)
    ).toBeInTheDocument()

    const accountPicker = screen.getByRole('button', { name: '选择账号' })
    expect(accountPicker).toBeEnabled()
    await userEvent.click(accountPicker)
    expect(screen.getByRole('dialog', { name: '选择反代账号' })).toBeInTheDocument()

    await act(async () => {
      releaseConfig?.()
      await configGate
    })
  })

  it('端口变更要求固定确认词，按专用 DTO 提交并以重启后的服务端投影重渲染', async () => {
    const nextConfig = {
      ...configView,
      proxyListen: { ...configView.proxyListen, port: 5599, requiresRestart: false }
    }
    const { calls } = installServer({
      handleRequest: (request) => {
        if (request.method === 'POST' && request.url.endsWith('/proxy/config/port')) {
          return json({
            previousPort: 5580,
            port: 5599,
            restarted: true,
            requiresRestart: false,
            config: nextConfig
          })
        }
        return undefined
      }
    })
    const onNotice = vi.fn()
    render(
      <ProxyPanel accounts={[]} onNotice={onNotice} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '更改反代端口' })
    const port = within(section).getByRole('spinbutton', { name: '新端口' })
    await userEvent.clear(port)
    await userEvent.type(port, '5599')
    await userEvent.click(within(section).getByRole('button', { name: '更改反代端口' }))

    const dialog = screen.getByRole('dialog', { name: '确认更改反代端口' })
    expect(within(dialog).getByText(/真实重启.*连接会短暂中断/)).toBeInTheDocument()
    expect(within(dialog).getByText(/失败.*自动回滚旧端口/)).toBeInTheDocument()
    const submit = within(dialog).getByRole('button', { name: '确认更改并应用' })
    expect(submit).toBeDisabled()
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: '输入“更改端口”以确认' }),
      '更改端口'
    )
    await userEvent.click(submit)

    await waitFor(() => expect(within(section).getByText(/当前监听.*5599/)).toBeInTheDocument())
    expect(onNotice).toHaveBeenCalledWith('反代已重启并监听新端口 5599')
    const request = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/proxy/config/port')
    )
    expect(request).toMatchObject({
      headers: { 'x-panel-request': '1' },
      body: {
        port: 5599,
        expectedCurrentPort: 5580,
        confirmation: 'CHANGE_PROXY_PORT'
      }
    })
  })

  it('反代未运行时接受服务端持久化投影，不把 restarted=false 误报为失败', async () => {
    const nextConfig = {
      ...configView,
      proxyListen: { ...configView.proxyListen, port: 5599, requiresRestart: false }
    }
    installServer({
      handleRequest: (request) => {
        if (request.method === 'POST' && request.url.endsWith('/proxy/config/port')) {
          return json({
            previousPort: 5580,
            port: 5599,
            restarted: false,
            requiresRestart: false,
            config: nextConfig
          })
        }
        return undefined
      }
    })
    const onNotice = vi.fn()
    render(
      <ProxyPanel accounts={[]} onNotice={onNotice} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '更改反代端口' })
    const port = within(section).getByRole('spinbutton', { name: '新端口' })
    await userEvent.clear(port)
    await userEvent.type(port, '5599')
    await userEvent.click(within(section).getByRole('button', { name: '更改反代端口' }))
    const dialog = screen.getByRole('dialog', { name: '确认更改反代端口' })
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: '输入“更改端口”以确认' }),
      '更改端口'
    )
    await userEvent.click(within(dialog).getByRole('button', { name: '确认更改并应用' }))

    await waitFor(() => expect(within(section).getByText(/当前监听.*5599/)).toBeInTheDocument())
    expect(onNotice).toHaveBeenCalledWith('反代当前未运行；端口已保存为 5599，下次启动将监听该端口')
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('端口重启失败时展示服务端回滚结论并重新读取旧端口，不谎报新端口生效', async () => {
    const onNotice = vi.fn()
    installServer({
      handleRequest: (request) => {
        if (request.method === 'POST' && request.url.endsWith('/proxy/config/port')) {
          return json(
            {
              code: 'INTERNAL_ERROR',
              message: '配置运行态应用失败，已恢复原配置。'
            },
            500
          )
        }
        return undefined
      }
    })
    render(
      <ProxyPanel accounts={[]} onNotice={onNotice} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: '更改反代端口' })
    const port = within(section).getByRole('spinbutton', { name: '新端口' })
    await userEvent.clear(port)
    await userEvent.type(port, '5599')
    await userEvent.click(within(section).getByRole('button', { name: '更改反代端口' }))
    const dialog = screen.getByRole('dialog', { name: '确认更改反代端口' })
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: '输入“更改端口”以确认' }),
      '更改端口'
    )
    await userEvent.click(within(dialog).getByRole('button', { name: '确认更改并应用' }))

    expect(
      await within(section).findByText('配置运行态应用失败，已恢复原配置。')
    ).toBeInTheDocument()
    expect(within(section).getByText(/当前监听.*5580/)).toBeInTheDocument()
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/5599|已重启|已生效/))
  })

  it('API Key 只按新增 → 验证 → 吊销旧 Key 流转，完整新 Key 关闭后不再显示', async () => {
    const oneTimeKey = 'sk-0123456789abcdef0123456789abcdef0123456789abcdef'
    const newId = 'new-key-id'
    const newHint = 'key:fedcba987654'
    let keys: Array<{
      id: string
      hint: string
      createdAt: number | null
      verifiedAt: number | null
    }> = [{ id: 'legacy', hint: 'legacy:configured', createdAt: null, verifiedAt: null }]
    const projectedConfig = (): typeof configView => ({
      ...configView,
      apiKeys: {
        configured: keys.length > 0,
        count: keys.length,
        hints: keys.map((item) => item.hint)
      }
    })
    const { calls } = installServer({
      initialConfig: projectedConfig(),
      handleRequest: (request) => {
        if (request.method === 'GET' && request.url.endsWith('/proxy/api-keys')) {
          return json({ keys })
        }
        if (request.method === 'POST' && request.url.endsWith('/proxy/api-keys/create')) {
          keys = [
            ...keys,
            {
              id: newId,
              hint: newHint,
              createdAt: 1_700_000_000_000,
              verifiedAt: null
            }
          ]
          return json({
            id: newId,
            key: oneTimeKey,
            hint: newHint,
            createdAt: 1_700_000_000_000,
            config: projectedConfig()
          })
        }
        if (request.method === 'POST' && request.url.endsWith('/proxy/api-keys/verify')) {
          keys = keys.map((item) =>
            item.id === newId ? { ...item, verifiedAt: 1_700_000_060_000 } : item
          )
          return json({
            id: newId,
            verified: true,
            verifiedAt: 1_700_000_060_000,
            config: projectedConfig()
          })
        }
        if (request.method === 'POST' && request.url.endsWith('/proxy/api-keys/revoke')) {
          keys = keys.filter((item) => item.id !== 'legacy')
          return json({
            revokedId: 'legacy',
            replacementId: newId,
            config: projectedConfig()
          })
        }
        return undefined
      }
    })
    render(
      <ProxyPanel accounts={[]} onNotice={vi.fn()} onError={vi.fn()} onSessionLost={vi.fn()} />
    )

    const section = await screen.findByRole('region', { name: 'API Key 生命周期' })
    expect(within(section).getByText(/新增.*真实请求.*验证.*吊销旧 Key/)).toBeInTheDocument()
    await userEvent.click(within(section).getByRole('button', { name: '新增 API Key' }))
    const createDialog = screen.getByRole('dialog', { name: '新增 API Key' })
    await userEvent.type(
      within(createDialog).getByRole('textbox', { name: '输入“新增”以确认' }),
      '新增'
    )
    await userEvent.click(within(createDialog).getByRole('button', { name: '确认新增' }))

    const delivery = await screen.findByRole('dialog', { name: '保存新的 API Key' })
    expect(within(delivery).getByText(oneTimeKey)).toBeInTheDocument()
    expect(within(delivery).getByText(/唯一一次显示/)).toBeInTheDocument()
    const createRequest = calls.find((call) => call.url.endsWith('/proxy/api-keys/create'))
    expect(createRequest).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' },
      body: { confirmation: 'CREATE_PROXY_API_KEY' }
    })

    await userEvent.click(within(delivery).getByRole('button', { name: '我已保存，关闭' }))
    expect(screen.queryByText(oneTimeKey)).not.toBeInTheDocument()
    const newItem = within(section).getByText(newHint).closest('li')
    expect(newItem).not.toBeNull()
    await userEvent.click(
      within(newItem as HTMLElement).getByRole('button', { name: '验证新 Key' })
    )
    await waitFor(() =>
      expect(within(newItem as HTMLElement).getByText(/已验证/)).toBeInTheDocument()
    )
    expect(calls.find((call) => call.url.endsWith('/proxy/api-keys/verify'))).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' },
      body: { id: newId }
    })

    const legacyItem = within(section).getByText('legacy:configured').closest('li')
    expect(legacyItem).not.toBeNull()
    await userEvent.click(
      within(legacyItem as HTMLElement).getByRole('button', {
        name: '吊销 legacy:configured'
      })
    )
    const revokeDialog = screen.getByRole('dialog', { name: '吊销 API Key' })
    await userEvent.type(
      within(revokeDialog).getByRole('textbox', { name: '输入“吊销”以确认' }),
      '吊销'
    )
    await userEvent.click(within(revokeDialog).getByRole('button', { name: '确认吊销' }))

    await waitFor(() =>
      expect(within(section).queryByText('legacy:configured')).not.toBeInTheDocument()
    )
    expect(calls.find((call) => call.url.endsWith('/proxy/api-keys/revoke'))).toMatchObject({
      method: 'POST',
      headers: { 'x-panel-request': '1' },
      body: {
        id: 'legacy',
        replacementId: newId,
        confirmation: 'REVOKE_PROXY_API_KEY'
      }
    })
  })
})
