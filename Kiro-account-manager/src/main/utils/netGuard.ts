// 网络护栏原语（共享机制层）
//
// 来源：原为 `src/main/proxy/proxyServer.ts` 的 private 方法（P0-2 / P0-3 / P0-4 三条安全护栏）。
// 抽取动机：局域网 Web 管理面板是同一主进程内的第二个 HTTP server，需要复用同一套硬化，
// 而不是重新实现一遍（重实现 = 两份会漂移的安全代码）。
//
// 设计边界 —— **共享机制，不共享策略**：
//   - 这里只放「怎么判定」的纯函数（常数时间比较 / 外网绑定判定 / IP 准入判定）。
//   - 「用什么凭据、准入名单是谁」属于各自授权域的策略，由调用方以入参传入：
//     代理侧传 `this.config`（apiKeys 是调用侧凭据），面板侧传自己的配置（adminKey 是管理员身份）。
//     两者正交，绝不可共用同一把 key —— 否则任何能调 /v1/* 的人自动获得管理权（权限提升）。
//
// 本文件内所有函数必须保持纯：不读全局状态、不读 config 单例、不产生副作用。
// 一旦某个函数需要「知道自己服务于谁」，那它就是策略，不属于这里。
import crypto from 'node:crypto'

/** IP 准入策略：调用方各自持有一份，本模块不关心它从哪来 */
export interface IPAccessPolicy {
  /** 允许访问的客户端 IP 列表（CIDR 或单 IP）；配置后即转白名单模式 */
  allowedIPs?: string[]
  /** 拒绝访问的客户端 IP 列表（CIDR 或单 IP）；优先级高于 allowedIPs */
  deniedIPs?: string[]
}

/** IP 准入判定结果 */
export interface IPAccessResult {
  allowed: boolean
  reason?: string
}

/**
 * 常数时间字符串比较（防时序攻击）
 * 长度不同时返回 false 但仍走一次 timingSafeEqual 防止旁路
 *
 * ⚠️ 不要「优化」成 `a === b` 或长度不等就直接 return：
 * 那会让比较耗时随前缀匹配长度变化，攻击者可据此逐字符猜出密钥。
 * 长度不等分支里那次自比也是刻意的，不是冗余代码。
 */
export function safeStringEq(a: string, b: string): boolean {
  // Buffer.from 处理 UTF-8 编码
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // 仍执行一次比较保证常数时间（用 a 自身比，结果不影响）
    try { crypto.timingSafeEqual(ab, ab) } catch { /* ignore */ }
    return false
  }
  try {
    return crypto.timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/**
 * 检测当前绑定地址是否会暴露到本机以外
 * 0.0.0.0 / :: / 网卡地址 → true；127.0.0.1 / ::1 / localhost → false
 *
 * 注意：这里只回答「是否暴露」这一个机制问题。
 * 「暴露了但没配凭据要不要拒启动」是各自的策略判定（凭据的定义各不相同），
 * 调用方自己写那几行 if，不要试图把它塞进这个函数。
 */
export function isBindingExternal(host?: string): boolean {
  if (!host) return false
  const h = host.toLowerCase().trim()
  return h === '0.0.0.0' || h === '::' || h === '*' || (
    h !== '127.0.0.1' && h !== '::1' && h !== 'localhost'
  )
}

/**
 * 简化 IPv4/IPv6 CIDR 匹配（不依赖外部库）
 * IPv4 CIDR：1.2.3.0/24；IPv6 CIDR：仅前缀逐 bit 比较
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/')
  const bits = parseInt(bitsStr, 10)
  if (!Number.isFinite(bits)) return false

  const isV4 = ip.includes('.') && range.includes('.')
  if (isV4) {
    const ipNum = ipv4ToInt(ip)
    const rangeNum = ipv4ToInt(range)
    if (ipNum < 0 || rangeNum < 0) return false
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (ipNum & mask) === (rangeNum & mask)
  }
  // IPv6 简化：转字节数组 + 前缀逐 bit 比较
  const ipBytes = ipv6ToBytes(ip)
  const rangeBytes = ipv6ToBytes(range)
  if (!ipBytes || !rangeBytes) return false
  let bitsLeft = bits
  for (let i = 0; i < 16 && bitsLeft > 0; i++) {
    if (bitsLeft >= 8) {
      if (ipBytes[i] !== rangeBytes[i]) return false
      bitsLeft -= 8
    } else {
      const mask = (0xff << (8 - bitsLeft)) & 0xff
      if ((ipBytes[i] & mask) !== (rangeBytes[i] & mask)) return false
      bitsLeft = 0
    }
  }
  return true
}

/** IPv4 点分十进制 → 无符号 32 位整数；非法输入返回 -1 */
export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(p => parseInt(p, 10))
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255)) return -1
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/** IPv6 字符串 → 16 字节数组（支持 :: 缩写）；非法输入返回 null */
export function ipv6ToBytes(ip: string): Uint8Array | null {
  try {
    // 简化处理：支持 :: 缩写
    const parts = ip.split('::')
    let head: string[] = []
    let tail: string[] = []
    if (parts.length === 1) {
      head = parts[0].split(':')
    } else if (parts.length === 2) {
      head = parts[0] ? parts[0].split(':') : []
      tail = parts[1] ? parts[1].split(':') : []
    } else {
      return null
    }
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    const segments = [...head, ...new Array(missing).fill('0'), ...tail]
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 8; i++) {
      const v = parseInt(segments[i] || '0', 16)
      if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null
      bytes[i * 2] = (v >> 8) & 0xff
      bytes[i * 2 + 1] = v & 0xff
    }
    return bytes
  } catch {
    return null
  }
}

/**
 * IP 访问控制
 * - deniedIPs 优先：命中即拒绝
 * - allowedIPs 配置后：必须在列表内（白名单模式）
 * - 都未配置：允许
 * 支持单 IP 和 CIDR（IPv4 / IPv6 简化处理）
 *
 * 策略以入参传入，本函数不知道也不该知道调用方是代理还是面板。
 */
export function isIPAllowed(clientIP: string, policy: IPAccessPolicy): IPAccessResult {
  if (!clientIP) return { allowed: true }
  // 规范化（::ffff:1.2.3.4 → 1.2.3.4）
  const ip = clientIP.startsWith('::ffff:') ? clientIP.slice(7) : clientIP

  const matchEntry = (entry: string): boolean => {
    const e = entry.trim()
    if (!e) return false
    // CIDR
    if (e.includes('/')) {
      return ipInCidr(ip, e)
    }
    return e === ip
  }

  const denied = policy.deniedIPs?.find(matchEntry)
  if (denied) return { allowed: false, reason: `IP ${ip} matches denied entry ${denied}` }

  const allowList = policy.allowedIPs
  if (allowList && allowList.length > 0) {
    const allowed = allowList.some(matchEntry)
    if (!allowed) return { allowed: false, reason: `IP ${ip} not in allowed list` }
  }
  return { allowed: true }
}
