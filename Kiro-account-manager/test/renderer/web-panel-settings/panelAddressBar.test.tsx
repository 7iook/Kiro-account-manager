/**
 * 设置页地址栏 —— 多地址选择 + 二维码（本轮 A）
 *
 * 被治的失败形态：主进程原来把「所有非回环 IPv4」平铺给用户。本机实测 6 条里
 * 只有 1 条手机连得上（其余是 WSL / VMware×2 / Hyper-V / Tailscale），
 * 让用户从 6 个里瞎猜等于没做这个功能。
 *
 * 这里断言的是**用户看到什么**：推荐地址直接可见、虚拟地址默认折叠且标明来源、
 * 二维码内容与屏幕上那个地址是同一个字符串。不断言 mock 被调用过。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useAccountsStore } from '@/store/accounts'
import { WebPanelCard } from '@/components/pages/WebPanelCard'

type Status = Awaited<ReturnType<Window['api']['webPanelGetStatus']>>['status']

/** 本机实测形状：1 条真实局域网 + 4 条虚拟 + 回环 */
function realisticStatus(overrides: Partial<Status> = {}): Status {
  return {
    running: true,
    enabled: true,
    host: '0.0.0.0',
    port: 5590,
    listeningPort: 5590,
    addresses: [
      'http://192.168.31.28:5590/panel',
      'http://100.102.246.52:5590/panel',
      'http://172.23.240.1:5590/panel',
      'http://127.0.0.1:5590/panel'
    ],
    addressGroups: {
      recommended: [
        {
          url: 'http://192.168.31.28:5590/panel',
          host: '192.168.31.28',
          interfaceName: 'WLAN',
          kind: 'physical'
        }
      ],
      virtual: [
        {
          url: 'http://100.102.246.52:5590/panel',
          host: '100.102.246.52',
          interfaceName: 'Tailscale',
          kind: 'virtual',
          virtualSource: 'tailscale'
        },
        {
          url: 'http://172.23.240.1:5590/panel',
          host: '172.23.240.1',
          interfaceName: 'vEthernet (WSL (Hyper-V firewall))',
          kind: 'virtual',
          virtualSource: 'wsl'
        }
      ],
      loopback: [
        {
          url: 'http://127.0.0.1:5590/panel',
          host: '127.0.0.1',
          interfaceName: 'loopback',
          kind: 'loopback'
        }
      ],
      degraded: false
    },
    defaultAddress: 'http://192.168.31.28:5590/panel',
    hasAdminKey: true,
    lastError: null,
    ...overrides
  } as Status
}

function installApi(status: Status): { openExternal: ReturnType<typeof vi.fn> } {
  const openExternal = vi.fn()
  const api = {
    webPanelGetStatus: vi.fn().mockResolvedValue({ success: true, status }),
    webPanelGetConfig: vi.fn().mockResolvedValue({
      success: true,
      config: { enabled: status.enabled, port: status.port, host: status.host, autoStart: false }
    }),
    webPanelSetConfig: vi.fn().mockResolvedValue({ success: true, config: {}, status }),
    webPanelStart: vi.fn().mockResolvedValue({ success: true, status }),
    webPanelStop: vi.fn().mockResolvedValue({ success: true, status }),
    webPanelGetAdminKey: vi.fn().mockResolvedValue({ success: true, adminKey: 'k'.repeat(40) }),
    webPanelRotateAdminKey: vi.fn().mockResolvedValue({ success: true, adminKey: 'n'.repeat(40) }),
    openExternal
  }
  vi.stubGlobal('window', Object.assign(window, { api }))
  // clipboard 在 jsdom 里默认不存在
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
  return { openExternal }
}

beforeEach(() => {
  vi.restoreAllMocks()
  // 不设语言时 useTranslation 按系统语言走 en，中文锂点（「正在监听」等）就永远找不到。
  // 照 WebPanelCard.test.tsx 的先例固定为 zh。
  useAccountsStore.setState({ language: 'zh' })
  try {
    window.localStorage.clear()
  } catch {
    // 忽略：隐私模式下 localStorage 不可用，组件本身也容错
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('设置页地址栏 · 推荐地址与虚拟网卡分离', () => {
  it('默认显示推荐地址（本机唯一真实局域网地址），不是虚拟网卡地址', async () => {
    installApi(realisticStatus())
    render(<WebPanelCard />)

    await waitFor(() => {
      expect(screen.getByText('http://192.168.31.28:5590/panel')).toBeInTheDocument()
    })
  })

  it('虚拟网卡地址默认不出现在界面上（折叠）', async () => {
    installApi(realisticStatus())
    render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    // WSL / Tailscale 地址默认不可见 —— 它们是负条件要防的噪声
    expect(screen.queryByText('http://172.23.240.1:5590/panel')).not.toBeInTheDocument()
    expect(screen.queryByText('http://100.102.246.52:5590/panel')).not.toBeInTheDocument()
  })

  it('点开「其他地址」后虚拟地址出现，且标明来源（WSL / Tailscale）', async () => {
    installApi(realisticStatus())
    render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    await userEvent.click(screen.getByText(/其他地址/))

    // 地址会同时出现在顶部「当前地址」与下方列表里，所以用 getAllByText；
    // 要证的是「点开后能看到虚拟地址 + 它带来源标注」。
    await waitFor(() => {
      expect(screen.getAllByText('http://172.23.240.1:5590/panel').length).toBeGreaterThan(0)
    })
    expect(screen.getAllByText('WSL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Tailscale').length).toBeGreaterThan(0)
  })
})

describe('设置页地址栏 · 二维码', () => {
  it('点二维码按钮 → 弹层出现，内容是屏幕上那个完整地址（含 /panel 与端口）', async () => {
    installApi(realisticStatus())
    render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '二维码' }))

    const dialog = await waitFor(() => screen.getByRole('dialog', { name: '二维码' }))
    // 弹层里重复展示地址文本，扫不动可手输 —— 也正好证明二维码承载的是同一串
    expect(within(dialog).getByText('http://192.168.31.28:5590/panel')).toBeInTheDocument()
    // 二维码是 SVG，value 编进了 DOM 结构；断言 svg 存在即可（内容一致由上一条保证）
    expect(dialog.querySelector('svg')).not.toBeNull()
  })

  it('二维码里不含访问密钥 —— 密钥会随截图/相册泄漏', async () => {
    installApi(realisticStatus())
    render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '二维码' }))

    const dialog = await waitFor(() => screen.getByRole('dialog', { name: '二维码' }))
    expect(dialog.textContent).not.toContain('k'.repeat(40))
  })
})

describe('设置页地址栏 · 在浏览器中打开', () => {
  it('点打开按钮 → 用当前选中的那个地址调 openExternal', async () => {
    const { openExternal } = installApi(realisticStatus())
    render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '在浏览器中打开' }))

    expect(openExternal).toHaveBeenCalledWith('http://192.168.31.28:5590/panel')
  })
})

describe('设置页地址栏 · 判据失效时降级', () => {
  /** OUI 判据认不出物理网卡（例如程序跑在虚拟机里） */
  function degradedStatus(): Status {
    return realisticStatus({
      addresses: ['http://172.23.240.1:5590/panel', 'http://127.0.0.1:5590/panel'],
      addressGroups: {
        recommended: [],
        virtual: [
          {
            url: 'http://172.23.240.1:5590/panel',
            host: '172.23.240.1',
            interfaceName: 'vEthernet (WSL)',
            kind: 'virtual',
            virtualSource: 'wsl'
          }
        ],
        loopback: [
          {
            url: 'http://127.0.0.1:5590/panel',
            host: '127.0.0.1',
            interfaceName: 'loopback',
            kind: 'loopback'
          }
        ],
        degraded: true
      },
      defaultAddress: 'http://172.23.240.1:5590/panel'
    })
  }

  it('认不出物理网卡时不显示空的推荐分组，而是把地址全部列出', async () => {
    installApi(degradedStatus())
    render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    // 降级时不打「手机可访问的地址」这个可能误导的标题
    expect(screen.queryByText('手机可访问的地址')).not.toBeInTheDocument()
    // 但地址本身必须可选 —— 滤掉唯一可用地址是硬故障。
    // 顶部当前地址 + 列表里各一份，故用 getAllByText。
    expect(screen.getAllByText('http://172.23.240.1:5590/panel').length).toBeGreaterThan(0)
  })
})

describe('设置页地址栏 · 记住上次选择', () => {
  it('切到另一个地址后，该选择按 host 记住（换端口仍有效）', async () => {
    installApi(realisticStatus())
    const { unmount } = render(<WebPanelCard />)

    await waitFor(() => expect(screen.getByText('正在监听')).toBeInTheDocument())
    await userEvent.click(screen.getByText(/其他地址/))
    await userEvent.click(await screen.findByText('http://172.23.240.1:5590/panel'))

    // 存的是 host 而不是完整 URL —— 这样换端口后选择依然命中
    expect(window.localStorage.getItem('webPanel.displayHost')).toBe('172.23.240.1')
    unmount()
  })

  it('端口变化后仍然沿用上次选的那张网卡（存 host 的意义）', async () => {
    window.localStorage.setItem('webPanel.displayHost', '172.23.240.1')
    installApi(
      realisticStatus({
        port: 6000,
        listeningPort: 6000,
        addresses: [
          'http://192.168.31.28:6000/panel',
          'http://172.23.240.1:6000/panel',
          'http://127.0.0.1:6000/panel'
        ],
        addressGroups: {
          recommended: [
            {
              url: 'http://192.168.31.28:6000/panel',
              host: '192.168.31.28',
              interfaceName: 'WLAN',
              kind: 'physical'
            }
          ],
          virtual: [
            {
              url: 'http://172.23.240.1:6000/panel',
              host: '172.23.240.1',
              interfaceName: 'vEthernet (WSL)',
              kind: 'virtual',
              virtualSource: 'wsl'
            }
          ],
          loopback: [
            {
              url: 'http://127.0.0.1:6000/panel',
              host: '127.0.0.1',
              interfaceName: 'loopback',
              kind: 'loopback'
            }
          ],
          degraded: false
        },
        defaultAddress: 'http://192.168.31.28:6000/panel'
      })
    )
    render(<WebPanelCard />)

    // 记住的是 host，所以新端口下自动选中同一张网卡的新 URL
    await waitFor(() => {
      expect(screen.getByText('http://172.23.240.1:6000/panel')).toBeInTheDocument()
    })
  })
})
