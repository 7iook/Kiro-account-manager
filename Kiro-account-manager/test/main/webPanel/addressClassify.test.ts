/**
 * 可达地址分类 —— 纯函数单测。
 *
 * fixture 是**本机实测**的 `os.networkInterfaces()` 输出（2026-08-05，8 条 IPv4），
 * 不是编造的样本。判据要防的就是这台机器上的真实噪声：6 条非回环 IPv4 里
 * 只有 `192.168.31.28`（WLAN）是手机真能连的。
 *
 * 参照实现 `codeg-research/src-tauri/src/web/mod.rs:417` 在同样输入下会平铺全部
 * 6 条 —— 它只过滤回环 / link-local / unspecified。本测试钉住本仓比它更严。
 */
import { describe, it, expect } from 'vitest'
import {
  classifyAddresses,
  classifyOne,
  pickDefaultAddress,
  type RawInterfaceAddress
} from '../../../src/main/webPanel/addressClassify'

/** 本机 2026-08-05 实测输出（node -e "os.networkInterfaces()"） */
function realMachineInterfaces(): RawInterfaceAddress[] {
  return [
    { interfaceName: 'Tailscale', address: '100.102.246.52', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00' },
    { interfaceName: 'WLAN', address: '192.168.31.28', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' },
    { interfaceName: 'VMware Network Adapter VMnet1', address: '192.168.171.1', family: 'IPv4', internal: false, mac: '00:50:56:c0:00:01' },
    { interfaceName: 'VMware Network Adapter VMnet8', address: '192.168.239.1', family: 'IPv4', internal: false, mac: '00:50:56:c0:00:08' },
    { interfaceName: 'Loopback Pseudo-Interface 1', address: '114.132.125.146', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' },
    { interfaceName: 'Loopback Pseudo-Interface 1', address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' },
    { interfaceName: 'vEthernet (Default Switch)', address: '172.19.96.1', family: 'IPv4', internal: false, mac: '00:15:5d:1f:1c:00' },
    { interfaceName: 'vEthernet (WSL (Hyper-V firewall))', address: '172.23.240.1', family: 'IPv4', internal: false, mac: '00:15:5d:45:25:43' }
  ]
}

const url = (host: string): string => `http://${host}:5590/panel`

describe('可达地址分类 · 本机实测输入', () => {
  it('推荐组只含真实局域网地址 —— 本机应当只有 192.168.31.28', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    expect(c.recommended.map((a) => a.host)).toEqual(['192.168.31.28'])
    expect(c.degraded).toBe(false)
  })

  it('虚拟网卡被归入 virtual 且标明来源，不与真实地址混在一起', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    const bySource = c.virtual.map((a) => [a.host, a.virtualSource])
    expect(bySource).toEqual([
      ['100.102.246.52', 'tailscale'],
      ['172.19.96.1', 'hyperv'],
      ['172.23.240.1', 'wsl'],
      ['192.168.171.1', 'vmware'],
      ['192.168.239.1', 'vmware']
    ])
  })

  it('挂在 Loopback 上的公网形态 IP 不进推荐组（只看网段会漏掉这条）', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    const allNonLoopback = [...c.recommended, ...c.virtual].map((a) => a.host)
    expect(allNonLoopback).not.toContain('114.132.125.146')
    expect(c.loopback.map((a) => a.host)).toContain('114.132.125.146')
  })

  it('URL 含 /panel 前缀与端口 —— 展示文本与二维码内容是同一个字符串', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    expect(c.recommended[0].url).toBe('http://192.168.31.28:5590/panel')
  })
})

describe('分类判据', () => {
  it('VMware OUI 00:50:56 判为 vmware', () => {
    expect(
      classifyOne({ interfaceName: 'Ethernet 2', address: '10.0.0.5', family: 'IPv4', internal: false, mac: '00:50:56:aa:bb:cc' })
    ).toEqual({ kind: 'virtual', virtualSource: 'vmware' })
  })

  it('Hyper-V OUI 00:15:5d 判为 hyperv（即便网卡名被改过）', () => {
    expect(
      classifyOne({ interfaceName: 'MyNet', address: '10.0.0.6', family: 'IPv4', internal: false, mac: '00:15:5d:aa:bb:cc' })
    ).toEqual({ kind: 'virtual', virtualSource: 'hyperv' })
  })

  it('OUI 不认识但网卡名含 WSL → 按名字判 wsl', () => {
    expect(
      classifyOne({ interfaceName: 'vEthernet (WSL)', address: '10.0.0.7', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff' })
    ).toEqual({ kind: 'virtual', virtualSource: 'wsl' })
  })

  it('真实物理网卡（普通 OUI + 普通名字）判为 physical', () => {
    expect(
      classifyOne({ interfaceName: 'Ethernet', address: '192.168.1.10', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' })
    ).toEqual({ kind: 'physical' })
  })
})

describe('过滤与去重', () => {
  it('IPv6 / link-local / 0.0.0.0 全部剔除', () => {
    const c = classifyAddresses(
      [
        { interfaceName: 'WLAN', address: 'fe80::1', family: 'IPv6', internal: false, mac: 'f4:ce:23:07:85:e6' },
        { interfaceName: 'WLAN', address: '169.254.10.1', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' },
        { interfaceName: 'WLAN', address: '0.0.0.0', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' },
        { interfaceName: 'WLAN', address: '192.168.31.28', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' }
      ],
      url
    )
    expect(c.recommended.map((a) => a.host)).toEqual(['192.168.31.28'])
    expect(c.virtual).toEqual([])
  })

  it('同一地址出现两次只保留一条', () => {
    const c = classifyAddresses(
      [
        { interfaceName: 'WLAN', address: '192.168.31.28', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' },
        { interfaceName: 'WLAN 2', address: '192.168.31.28', family: 'IPv4', internal: false, mac: 'f4:ce:23:07:85:e6' }
      ],
      url
    )
    expect(c.recommended).toHaveLength(1)
  })
})

describe('降级：判据认不出任何物理网卡', () => {
  /** 全是虚拟网卡的机器（例如程序跑在虚拟机里） */
  function allVirtual(): RawInterfaceAddress[] {
    return [
      { interfaceName: 'vEthernet (WSL)', address: '172.23.240.1', family: 'IPv4', internal: false, mac: '00:15:5d:45:25:43' },
      { interfaceName: 'Loopback Pseudo-Interface 1', address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }
    ]
  }

  it('推荐组为空时打 degraded 标记，UI 据此退回平铺', () => {
    const c = classifyAddresses(allVirtual(), url)
    expect(c.recommended).toEqual([])
    expect(c.degraded).toBe(true)
  })

  it('降级时虚拟地址仍然保留 —— 不能滤掉唯一可能可用的地址', () => {
    const c = classifyAddresses(allVirtual(), url)
    expect(c.virtual.map((a) => a.host)).toEqual(['172.23.240.1'])
  })

  it('只有回环时不算降级（没有非回环地址可推荐，属正常的仅本机场景）', () => {
    const c = classifyAddresses(
      [{ interfaceName: 'Loopback Pseudo-Interface 1', address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }],
      url
    )
    expect(c.degraded).toBe(false)
  })
})

describe('默认地址选取', () => {
  it('优先用用户上次选的 host', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    const picked = pickDefaultAddress(c, { savedHost: '172.23.240.1' })
    expect(picked?.host).toBe('172.23.240.1')
  })

  it('上次选的 host 已不存在时不卡住，退到下一优先级', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    const picked = pickDefaultAddress(c, { savedHost: '10.9.9.9' })
    expect(picked?.host).toBe('192.168.31.28')
  })

  it('降级时用探测到的默认路由 host（比 OUI 更直接的可达证据）', () => {
    const c = classifyAddresses(
      [
        { interfaceName: 'vEthernet (WSL)', address: '172.23.240.1', family: 'IPv4', internal: false, mac: '00:15:5d:45:25:43' },
        { interfaceName: 'vEthernet (Other)', address: '172.19.96.1', family: 'IPv4', internal: false, mac: '00:15:5d:1f:1c:00' }
      ],
      url
    )
    expect(c.degraded).toBe(true)
    const picked = pickDefaultAddress(c, { probedHost: '172.19.96.1' })
    expect(picked?.host).toBe('172.19.96.1')
  })

  it('非降级时默认给推荐组首个', () => {
    const c = classifyAddresses(realMachineInterfaces(), url)
    expect(pickDefaultAddress(c)?.host).toBe('192.168.31.28')
  })

  it('一个地址都没有时返回 null 而不是崩', () => {
    expect(pickDefaultAddress(classifyAddresses([], url))).toBeNull()
  })
})
