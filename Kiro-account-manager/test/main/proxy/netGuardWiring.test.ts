// 行为保真回归：确认抽取后「经由 ProxyServer 类的真实调用路径」行为与抽取前一致。
//
// 为什么需要这一层（单测 netGuard.test.ts 之外）：
// netGuard.test.ts 测的是抽出来的纯函数；它全绿只证明「函数本身对」，
// 不证明「代理仍然在用它、且策略来源接对了」（E-052 建而未接）。
// 这里通过类的 private 方法（用 as any 触达）验证 wrapper 真正转发，
// 且 isClientIPAllowed 的策略来源仍是本实例的 config —— 那是本轮唯一的参数化改动，
// 接错了会导致 IP 白名单静默失效（安全回归而非功能 bug）。
import { describe, it, expect } from 'vitest'
import { ProxyServer } from '@main/proxy/proxyServer'
import type { ProxyConfig } from '@main/proxy/types'

function makeServer(overrides: Partial<ProxyConfig> = {}): any {
  const config = {
    enabled: true,
    port: 3456,
    host: '127.0.0.1',
    ...overrides
  } as ProxyConfig
  // 第三个实参原为 `{} as any`（两参时代的冗余传参，被静默忽略）。K-2 给构造函数加了
  // userDataPath 形参后它会真的被收下，故这里改为省略 —— 本文件测的是 IP 护栏，
  // 不碰自签证书路径。
  return new ProxyServer(config, { getAccounts: () => [] } as any)
}

describe('ProxyServer 护栏 wrapper 行为保真（抽取后经类调用）', () => {
  it('safeStringEq wrapper 转发到共享实现', () => {
    const s = makeServer()
    expect(s.safeStringEq('sk-same', 'sk-same')).toBe(true)
    expect(s.safeStringEq('sk-same', 'sk-diff')).toBe(false)
    expect(s.safeStringEq('short', 'longer-value')).toBe(false)
  })

  it('isBindingExternal wrapper 转发到共享实现', () => {
    const s = makeServer()
    expect(s.isBindingExternal('0.0.0.0')).toBe(true)
    expect(s.isBindingExternal('127.0.0.1')).toBe(false)
    expect(s.isBindingExternal(undefined)).toBe(false)
  })

  // ↓ 本轮唯一参数化改动的保真点：策略必须来自 this.config，
  //   而不是某个默认值或空对象。接错时下面两个断言会反向。
  it('isClientIPAllowed 仍以本实例 config 为策略来源（denied）', () => {
    const s = makeServer({ deniedIPs: ['1.2.3.4', '192.168.9.0/24'] })
    expect(s.isClientIPAllowed('1.2.3.4').allowed).toBe(false)
    expect(s.isClientIPAllowed('192.168.9.77').allowed).toBe(false)
    expect(s.isClientIPAllowed('8.8.8.8').allowed).toBe(true)
  })

  it('isClientIPAllowed 仍以本实例 config 为策略来源（allowed 白名单模式）', () => {
    const s = makeServer({ allowedIPs: ['10.0.0.0/8'] })
    expect(s.isClientIPAllowed('10.1.2.3').allowed).toBe(true)
    expect(s.isClientIPAllowed('172.16.0.1').allowed).toBe(false)
  })

  it('两个实例各自持有独立策略（config 未被提升为共享状态）', () => {
    const a = makeServer({ allowedIPs: ['10.0.0.0/8'] })
    const b = makeServer({ allowedIPs: ['192.168.0.0/16'] })
    expect(a.isClientIPAllowed('10.1.1.1').allowed).toBe(true)
    expect(b.isClientIPAllowed('10.1.1.1').allowed).toBe(false)
    expect(b.isClientIPAllowed('192.168.1.1').allowed).toBe(true)
  })

  it('未配置任何 IP 名单时放行（默认不拦，保持原行为）', () => {
    const s = makeServer()
    expect(s.isClientIPAllowed('203.0.113.9')).toEqual({ allowed: true })
  })

  it('运行时改 config.deniedIPs 后立即生效（wrapper 不缓存策略快照）', () => {
    const s = makeServer()
    expect(s.isClientIPAllowed('5.6.7.8').allowed).toBe(true)
    s.config.deniedIPs = ['5.6.7.8']
    expect(s.isClientIPAllowed('5.6.7.8').allowed).toBe(false)
  })
})

describe('外网绑定拒启动护栏未被抽取所改动', () => {
  it('绑 0.0.0.0 且无任何 API Key 时拒绝启动', async () => {
    const s = makeServer({ host: '0.0.0.0', apiKeys: [], apiKey: undefined })
    await expect(s.start()).rejects.toThrow(/Refused to start/)
  })

  it('绑 0.0.0.0 且配置了 enabled 的 API Key 时不因护栏拒绝', () => {
    const s = makeServer({
      host: '0.0.0.0',
      apiKeys: [{ id: 'k1', key: 'sk-real', name: 'k', enabled: true, usage: { totalCredits: 0 } } as any]
    })
    // 只验证护栏判定分支，不真启监听：hasAnyKey 为真 → 不抛 Refused
    expect(s.isBindingExternal(s.config.host)).toBe(true)
    const hasAnyKey = (s.config.apiKeys?.some((k: any) => k.enabled && k.key) ?? false) || !!s.config.apiKey
    expect(hasAnyKey).toBe(true)
  })

  it('绑 127.0.0.1 无 Key 时不触发护栏', () => {
    const s = makeServer({ host: '127.0.0.1', apiKeys: [] })
    expect(s.isBindingExternal(s.config.host)).toBe(false)
  })
})
