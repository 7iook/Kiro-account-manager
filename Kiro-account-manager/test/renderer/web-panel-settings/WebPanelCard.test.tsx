/**
 * W6 · 设置页「网页管理面板」区块
 *
 * 契约权威源：`src/main/ipc/webPanelWiring.ts`（7 条 `web-panel:*` 通道，已合入 main）。
 * 本测试按**真实返回形状**构造 stub：`{ success, status }` / `{ success, config, status }` /
 * `{ success:false, error, status }`，`status` 用主进程的 `WebPanelStatus`
 * （`running` / `listeningPort` / `addresses: string[]` / `hasAdminKey` / `lastError`）。
 *
 * 被治的两个具体失败形态（决策卡 §5 场景 S3 + §3「轮换/退出」）：
 *
 *   1. **开关显示「已开启」而服务器根本没在监听**。端口被占 / 外网绑定无 adminKey 被
 *      安全红线拒绝时，配置里的 `enabled` 仍是 true 而 `running` 是 false。
 *      ⇒ 断言开关的 aria-checked 跟随 `running`，且屏幕上出现真实失败原因。
 *
 *   2. **重新生成密钥前不警告**。轮换立即失效所有会话，所有已连接手机被登出。
 *      ⇒ 断言 confirm 被调用；用户取消时轮换 IPC 绝不被调用。
 *
 * 不断言 mock 的存在，只断言用户看得到什么 / 系统真的做了什么。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useAccountsStore } from '@/store/accounts'
import { WebPanelCard, type WebPanelStatus } from '@/components/pages/WebPanelCard'

/** 已停止（干净初态：默认关闭、仅本机、5590、从未生成密钥） */
function stoppedStatus(overrides: Partial<WebPanelStatus> = {}): WebPanelStatus {
  return {
    running: false,
    enabled: false,
    host: '127.0.0.1',
    port: 5590,
    listeningPort: null,
    addresses: [],
    hasAdminKey: false,
    lastError: null,
    ...overrides
  }
}

/** 真的在监听（绑定通配地址 ⇒ 主进程枚举出非回环 IPv4 完整 URL） */
function listeningStatus(overrides: Partial<WebPanelStatus> = {}): WebPanelStatus {
  return {
    running: true,
    enabled: true,
    host: '0.0.0.0',
    port: 5590,
    listeningPort: 5590,
    addresses: ['http://192.168.1.7:5590/panel'],
    hasAdminKey: true,
    lastError: null,
    ...overrides
  }
}

const ADMIN_KEY = 'kEy-abcdefghijklmnopqrstuvwxyz0123456789AB'

interface ApiStub {
  webPanelGetStatus: ReturnType<typeof vi.fn>
  webPanelGetConfig: ReturnType<typeof vi.fn>
  webPanelSetConfig: ReturnType<typeof vi.fn>
  webPanelStart: ReturnType<typeof vi.fn>
  webPanelStop: ReturnType<typeof vi.fn>
  webPanelGetAdminKey: ReturnType<typeof vi.fn>
  webPanelRotateAdminKey: ReturnType<typeof vi.fn>
}

let apiStub: ApiStub

/**
 * 只挂本卡片用到的 7 个方法 —— 不复制整个 window.api，
 * 这样「组件调了没声明的通道」会当场 TypeError 而不是被掩盖。
 */
function installApi(initial: WebPanelStatus): void {
  apiStub = {
    webPanelGetStatus: vi.fn().mockResolvedValue({ success: true, status: initial }),
    webPanelGetConfig: vi.fn().mockResolvedValue({
      success: true,
      config: { enabled: initial.enabled, port: initial.port, host: initial.host, autoStart: false }
    }),
    // 默认：写配置成功、状态原样返回（具体用例按需覆盖）
    webPanelSetConfig: vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({
      success: true,
      config: { enabled: initial.enabled, port: initial.port, host: initial.host, ...patch },
      status: initial
    })),
    webPanelStart: vi.fn().mockResolvedValue({ success: true, status: initial }),
    webPanelStop: vi.fn().mockResolvedValue({ success: true, status: stoppedStatus() }),
    webPanelGetAdminKey: vi.fn().mockResolvedValue({ success: true, adminKey: ADMIN_KEY }),
    webPanelRotateAdminKey: vi.fn()
  }
  ;(globalThis.window as unknown as { api: unknown }).api = apiStub
}

beforeEach(() => {
  useAccountsStore.setState({ language: 'zh' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('网页面板区块 · 开关必须反映服务器真实状态,不是配置意图', () => {
  it('配置 enabled=true 但服务器没在监听（端口被占）:开关必须为关,并显示真实失败原因', async () => {
    // 主进程实测形状：启动失败后 enabled 仍是 true,running 是 false,lastError 带原因
    installApi(
      stoppedStatus({
        enabled: true,
        running: false,
        lastError: 'listen EADDRINUSE: address already in use 0.0.0.0:5590'
      })
    )

    render(<WebPanelCard />)

    // 用户看到的是真实原因原文（含端口,可据此行动）
    await waitFor(() => {
      expect(screen.getByText(/EADDRINUSE/)).toBeInTheDocument()
    })

    // 开关跟随 running,不能因 enabled=true 而显示开
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('正在监听')).not.toBeInTheDocument()
    expect(screen.getByText('启动失败')).toBeInTheDocument()
  })

  it('外网绑定但没配密钥被安全红线拒绝:原因里的 adminKey 说明要能看到', async () => {
    installApi(
      stoppedStatus({
        enabled: true,
        host: '0.0.0.0',
        lastError:
          '[Security] Refused to start: host=0.0.0.0 exposes the panel to the network but no adminKey is configured. Generate an adminKey in settings, or bind to 127.0.0.1.'
      })
    )

    render(<WebPanelCard />)

    await waitFor(() => {
      expect(screen.getByText(/no adminKey is configured/)).toBeInTheDocument()
    })
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('真的在监听时:开关为开,并显示可在手机输入的完整地址', async () => {
    installApi(listeningStatus())

    render(<WebPanelCard />)

    await waitFor(() => {
      expect(screen.getByText('正在监听')).toBeInTheDocument()
    })
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('http://192.168.1.7:5590/panel')).toBeInTheDocument()
  })

  it('点开关启用后主进程返回启动失败:开关必须弹回关闭并显示原因,不停留在「开」', async () => {
    installApi(stoppedStatus())
    const failedStatus = stoppedStatus({
      enabled: true,
      running: false,
      lastError: 'listen EADDRINUSE: address already in use 0.0.0.0:5590'
    })
    apiStub.webPanelSetConfig.mockResolvedValue({
      success: true,
      config: { enabled: true, port: 5590, host: '127.0.0.1' },
      status: stoppedStatus({ enabled: true })
    })
    apiStub.webPanelStart.mockResolvedValue({
      success: false,
      error: 'listen EADDRINUSE: address already in use 0.0.0.0:5590',
      status: failedStatus
    })

    render(<WebPanelCard />)
    await waitFor(() => expect(apiStub.webPanelGetStatus).toHaveBeenCalled())

    await userEvent.click(screen.getByRole('switch'))

    await waitFor(() => {
      expect(screen.getByText(/EADDRINUSE/)).toBeInTheDocument()
    })
    // 关键：不是乐观地留在「开」
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('启用走「写配置 + 启动」两步（主进程没有把两者合成一条通道）', async () => {
    installApi(stoppedStatus())
    apiStub.webPanelSetConfig.mockResolvedValue({
      success: true,
      config: { enabled: true, port: 5590, host: '0.0.0.0' },
      status: stoppedStatus({ enabled: true })
    })
    apiStub.webPanelStart.mockResolvedValue({ success: true, status: listeningStatus() })

    render(<WebPanelCard />)
    await waitFor(() => expect(apiStub.webPanelGetStatus).toHaveBeenCalled())

    await userEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(apiStub.webPanelStart).toHaveBeenCalledTimes(1))
    expect(apiStub.webPanelSetConfig).toHaveBeenCalledWith({ enabled: true })
    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
  })

  it('仅绑定 127.0.0.1 时提示其他设备无法访问（判据是 host,不是地址列表为空）', async () => {
    // 主进程对非通配 host 会返回**恰好一条**地址,列表非空但那是回环地址
    installApi(
      listeningStatus({
        host: '127.0.0.1',
        addresses: ['http://127.0.0.1:5590/panel']
      })
    )

    render(<WebPanelCard />)

    await waitFor(() => {
      expect(screen.getByText(/其他设备无法访问/)).toBeInTheDocument()
    })
  })
})

describe('网页面板区块 · 重新生成密钥必须先警告会断开所有设备', () => {
  it('用户在确认框里取消 ⇒ 绝不调用轮换 IPC（密钥没被换掉）', async () => {
    installApi(listeningStatus())
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<WebPanelCard />)
    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /重新生成/ }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // 警告文案必须明确说「会被登出 / 断开」,不能只说「确定吗」
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/登出|断开/)
    expect(apiStub.webPanelRotateAdminKey).not.toHaveBeenCalled()
  })

  it('用户确认后才轮换,并用返回的新密钥更新界面', async () => {
    installApi(listeningStatus())
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    const rotated = 'nEw-KEY-9876543210zyxwvutsrqponmlkjihgfedcba'
    apiStub.webPanelRotateAdminKey.mockResolvedValue({ success: true, adminKey: rotated })

    render(<WebPanelCard />)
    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /重新生成/ }))

    await waitFor(() => expect(apiStub.webPanelRotateAdminKey).toHaveBeenCalledTimes(1))
    // 轮换返回的新 key 直接进界面（无需再点「显示」）
    await waitFor(() => {
      expect(screen.getByDisplayValue(rotated)).toBeInTheDocument()
    })
  })

  it('界面上必须常驻「会断开所有已连接设备」的警告,不能只在确认框里才说', async () => {
    installApi(listeningStatus())

    render(<WebPanelCard />)

    await waitFor(() => {
      expect(screen.getByText(/会立即断开所有已连接的设备/)).toBeInTheDocument()
    })
  })
})

describe('网页面板区块 · 密钥展示遵循页面既有敏感值约定', () => {
  it('默认遮蔽,点「显示」才拉取并明文（拉取即生成,故不在加载时预取）', async () => {
    installApi(listeningStatus())

    render(<WebPanelCard />)
    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())

    // 加载阶段绝不能碰 get-admin-key —— 那会让「尚未生成」永远看不到
    expect(apiStub.webPanelGetAdminKey).not.toHaveBeenCalled()

    // 遮蔽的判据是 input 的 type 属性 —— 不能用 queryByDisplayValue 判「看不见」,
    // 因为 testing-library 读的是 value 属性,对 type=password 一样能匹配到。
    const masked = screen.getByDisplayValue('****************')
    expect(masked).toHaveAttribute('type', 'password')

    await userEvent.click(screen.getByRole('button', { name: /显示/ }))

    await waitFor(() => expect(apiStub.webPanelGetAdminKey).toHaveBeenCalledTimes(1))
    const revealed = screen.getByDisplayValue(ADMIN_KEY)
    expect(revealed).toHaveAttribute('type', 'text')
  })

  it('从未生成过密钥时提示「首次启用时自动生成」,不显示空框让人以为坏了', async () => {
    installApi(stoppedStatus({ hasAdminKey: false }))

    render(<WebPanelCard />)

    await waitFor(() => {
      expect(screen.getByText(/首次启用面板时自动生成/)).toBeInTheDocument()
    })
  })
})
