// TDD: netGuard —— 网络护栏原语(从 proxyServer.ts 抽出的纯函数)
//
// 抽取动机:即将新增的局域网 Web 管理面板是同进程内的第二个 HTTP server,
// 需要复用同一套硬化机制(常数时间比较 / 外网绑定判定 / IP 访问控制),
// 但持有各自独立的授权策略(面板用 adminKey,代理用 apiKeys[])。
// 「共享机制,独立策略」= 原语参数化,不共享配置来源。
//
// 这些函数原为 ProxyServer 的 private 方法,无法单独测试;抽出后可直接钉边界。
// 行为保真是本轮硬指标:safeStringEq 守时序攻击,isIPAllowed 守网络准入,
// 任何语义漂移都是安全回归而非普通 bug。
import { describe, it, expect, vi, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { safeStringEq, isBindingExternal, ipInCidr, isIPAllowed } from '@main/utils/netGuard'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safeStringEq —— 常数时间字符串比较', () => {
  it('相同字符串返回 true', () => {
    expect(safeStringEq('sk-abc123', 'sk-abc123')).toBe(true)
  })

  it('等长不同字符串返回 false', () => {
    expect(safeStringEq('sk-abc123', 'sk-abc124')).toBe(false)
  })

  it('不等长字符串返回 false', () => {
    expect(safeStringEq('short', 'much-longer-key')).toBe(false)
  })

  it('空字符串互比返回 true(与原实现一致)', () => {
    expect(safeStringEq('', '')).toBe(true)
  })

  it('空 vs 非空返回 false', () => {
    expect(safeStringEq('', 'x')).toBe(false)
    expect(safeStringEq('x', '')).toBe(false)
  })

  it('UTF-8 多字节按字节比较(中文 key 不误判)', () => {
    expect(safeStringEq('密钥甲', '密钥甲')).toBe(true)
    expect(safeStringEq('密钥甲', '密钥乙')).toBe(false)
  })

  // ↓ 核心安全契约:比较耗时不得随「前缀匹配长度」变化。
  // 不用挂钟计时断言(CI 上必然 flaky,且噪声远大于纳秒级差异),
  // 改为断言实现结构:一律走 crypto.timingSafeEqual,绝不出现
  // 「逐字符比较提前 return」或「长度不同直接 return 而跳过比较」。
  // 前者由 timingSafeEqual 本身保证常数时间,后者由下面两个用例钉住。
  it('等长比较委托给 crypto.timingSafeEqual(而非逐字符短路比较)', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    safeStringEq('aaaaaaaa', 'aaaaaaab')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('前缀匹配长度不同的等长输入,调用次数一致(无提前退出的旁路)', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    safeStringEq('aaaaaaaa', 'bbbbbbbb') // 首字符即不同
    const callsAfterEarlyMismatch = spy.mock.calls.length
    spy.mockClear()
    safeStringEq('aaaaaaaa', 'aaaaaaab') // 仅末字符不同
    expect(spy.mock.calls.length).toBe(callsAfterEarlyMismatch)
  })

  it('长度不同时仍执行一次比较,不因长度分支跳过(防长度旁路)', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual')
    expect(safeStringEq('a', 'bbbbbbbbbb')).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('timingSafeEqual 抛错时返回 false 而非泄漏异常', () => {
    vi.spyOn(crypto, 'timingSafeEqual').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(safeStringEq('abc', 'abc')).toBe(false)
  })
})

describe('isBindingExternal —— 绑定地址是否暴露到本机以外', () => {
  it('通配地址视为外网暴露', () => {
    expect(isBindingExternal('0.0.0.0')).toBe(true)
    expect(isBindingExternal('::')).toBe(true)
    expect(isBindingExternal('*')).toBe(true)
  })

  it('回环地址不视为外网暴露', () => {
    expect(isBindingExternal('127.0.0.1')).toBe(false)
    expect(isBindingExternal('::1')).toBe(false)
    expect(isBindingExternal('localhost')).toBe(false)
  })

  it('具体网卡地址视为外网暴露', () => {
    expect(isBindingExternal('192.168.1.5')).toBe(true)
    expect(isBindingExternal('10.0.0.2')).toBe(true)
  })

  it('host 缺省时不视为外网暴露(未指定 → 不拦)', () => {
    expect(isBindingExternal(undefined)).toBe(false)
    expect(isBindingExternal('')).toBe(false)
  })

  it('大小写与首尾空格归一化', () => {
    expect(isBindingExternal('LOCALHOST')).toBe(false)
    expect(isBindingExternal('  127.0.0.1  ')).toBe(false)
    expect(isBindingExternal(' 0.0.0.0 ')).toBe(true)
  })
})

describe('ipInCidr —— IPv4 / IPv6 CIDR 匹配', () => {
  it('IPv4 /24 网段内外', () => {
    expect(ipInCidr('192.168.1.42', '192.168.1.0/24')).toBe(true)
    expect(ipInCidr('192.168.2.42', '192.168.1.0/24')).toBe(false)
  })

  it('IPv4 /32 精确匹配', () => {
    expect(ipInCidr('10.1.2.3', '10.1.2.3/32')).toBe(true)
    expect(ipInCidr('10.1.2.4', '10.1.2.3/32')).toBe(false)
  })

  it('IPv4 /0 匹配任意地址', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true)
    expect(ipInCidr('192.168.1.1', '0.0.0.0/0')).toBe(true)
  })

  it('IPv4 非 8 的整数倍前缀(/25 边界两侧)', () => {
    expect(ipInCidr('192.168.1.127', '192.168.1.0/25')).toBe(true)
    expect(ipInCidr('192.168.1.128', '192.168.1.0/25')).toBe(false)
  })

  it('IPv4 高位地址不因符号位溢出误判(>= 128.0.0.0)', () => {
    expect(ipInCidr('200.1.2.3', '200.1.2.0/24')).toBe(true)
    expect(ipInCidr('255.255.255.255', '255.255.255.0/24')).toBe(true)
    expect(ipInCidr('128.0.0.1', '128.0.0.0/8')).toBe(true)
  })

  it('非法 IPv4 八位组返回 false', () => {
    expect(ipInCidr('192.168.1.999', '192.168.1.0/24')).toBe(false)
    expect(ipInCidr('192.168.1', '192.168.1.0/24')).toBe(false)
  })

  it('前缀位数非数字返回 false', () => {
    expect(ipInCidr('192.168.1.1', '192.168.1.0/abc')).toBe(false)
    expect(ipInCidr('192.168.1.1', '192.168.1.0/')).toBe(false)
  })

  it('IPv6 /32 网段内外', () => {
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true)
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false)
  })

  it('IPv6 :: 缩写在头/中/尾都能解析', () => {
    expect(ipInCidr('::1', '::1/128')).toBe(true)
    expect(ipInCidr('fe80::1', 'fe80::/10')).toBe(true)
    expect(ipInCidr('2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64')).toBe(true)
  })

  it('IPv6 非 8 的整数倍前缀(/12 边界两侧)', () => {
    expect(ipInCidr('fe80::1', 'fe80::/12')).toBe(true)
    expect(ipInCidr('ff00::1', 'fe80::/12')).toBe(false)
  })

  it('IPv6 /128 精确匹配', () => {
    expect(ipInCidr('2001:db8::abcd', '2001:db8::abcd/128')).toBe(true)
    expect(ipInCidr('2001:db8::abce', '2001:db8::abcd/128')).toBe(false)
  })

  it('IPv6 段数超限返回 false', () => {
    expect(ipInCidr('1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8/64')).toBe(false)
    expect(ipInCidr('1::2::3', '1::/64')).toBe(false)
  })

  it('IPv6 段值超 0xffff 返回 false', () => {
    expect(ipInCidr('12345:db8::1', '12345:db8::/32')).toBe(false)
  })
})

describe('isIPAllowed —— IP 访问控制策略(参数化后的 isClientIPAllowed)', () => {
  it('两个列表都未配置时放行', () => {
    expect(isIPAllowed('1.2.3.4', {})).toEqual({ allowed: true })
  })

  it('clientIP 为空时放行(取不到来源地址不拦)', () => {
    expect(isIPAllowed('', { allowedIPs: ['10.0.0.1'] })).toEqual({ allowed: true })
  })

  it('denied 命中即拒绝,并给出命中的条目', () => {
    const r = isIPAllowed('1.2.3.4', { deniedIPs: ['1.2.3.4'] })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('1.2.3.4')
  })

  it('denied 优先于 allowed(同时命中两边时拒绝)', () => {
    const r = isIPAllowed('1.2.3.4', { allowedIPs: ['1.2.3.4'], deniedIPs: ['1.2.3.4'] })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('denied')
  })

  it('配置 allowed 后转白名单模式:列表外拒绝', () => {
    expect(isIPAllowed('9.9.9.9', { allowedIPs: ['10.0.0.0/8'] }).allowed).toBe(false)
    expect(isIPAllowed('10.1.2.3', { allowedIPs: ['10.0.0.0/8'] }).allowed).toBe(true)
  })

  it('allowed 为空数组时不启用白名单模式(放行)', () => {
    expect(isIPAllowed('9.9.9.9', { allowedIPs: [] })).toEqual({ allowed: true })
  })

  it('IPv4-mapped IPv6 归一化后再匹配(::ffff:1.2.3.4 → 1.2.3.4)', () => {
    expect(isIPAllowed('::ffff:10.1.2.3', { allowedIPs: ['10.0.0.0/8'] }).allowed).toBe(true)
    expect(isIPAllowed('::ffff:1.2.3.4', { deniedIPs: ['1.2.3.4'] }).allowed).toBe(false)
  })

  it('CIDR 与单 IP 条目混用', () => {
    const policy = { deniedIPs: ['192.168.5.0/24', '8.8.8.8'] }
    expect(isIPAllowed('192.168.5.77', policy).allowed).toBe(false)
    expect(isIPAllowed('8.8.8.8', policy).allowed).toBe(false)
    expect(isIPAllowed('8.8.4.4', policy).allowed).toBe(true)
  })

  it('条目含首尾空格与空行时容错(照搬 UI 逐行输入的现实形态)', () => {
    const policy = { deniedIPs: ['  1.2.3.4  ', '', '   '] }
    expect(isIPAllowed('1.2.3.4', policy).allowed).toBe(false)
    expect(isIPAllowed('5.6.7.8', policy).allowed).toBe(true)
  })

  it('拒绝理由不回显策略全文(只提命中条目,避免把整张名单写进日志)', () => {
    const r = isIPAllowed('1.2.3.4', { deniedIPs: ['1.2.3.4', '9.9.9.9', '10.0.0.0/8'] })
    expect(r.allowed).toBe(false)
    expect(r.reason).not.toContain('9.9.9.9')
  })

  it('同一策略对象可被两个授权域各自持有(共享机制,独立策略)', () => {
    const proxyPolicy = { allowedIPs: ['10.0.0.0/8'] }
    const panelPolicy = { allowedIPs: ['192.168.0.0/16'] }
    expect(isIPAllowed('10.1.1.1', proxyPolicy).allowed).toBe(true)
    expect(isIPAllowed('10.1.1.1', panelPolicy).allowed).toBe(false)
    expect(isIPAllowed('192.168.1.1', panelPolicy).allowed).toBe(true)
    expect(isIPAllowed('192.168.1.1', proxyPolicy).allowed).toBe(false)
  })
})
