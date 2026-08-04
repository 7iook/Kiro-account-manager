// 回归测试:429 限流 ≠ 额度耗尽 · 请求成功必须能清除额度耗尽误标
//
// RCA: .agent-workspace/.archive/2026-08-04/hold-gate-429-quota-false-positive/
//
// 缺陷现场(2026-08-04 用户报「账号是正常的,闸门却把它拦起来了」):
//   proxy-logs.json UTC 10:30-11:07 实测 u623f5f2c@yahoo.com:471 次请求 / 324 次 200 /
//   147 次 429,其中 **146 次(99.3%)在 60 秒内同一账号就有 200 成功** ——
//   429 在 Kiro 后端是概率式限流窗口(项目自己的注释:「不是真 QPS 上限,窗口随机开关」),
//   几乎从不代表账号真的不可用。
//
// 误伤链条:
//   429 → proxyServer callWithRetry 硬编码 recordError(id, RECOVERABLE, 429)
//       → accountPool isQuotaError=(402||429) → quotaExhaustedAt=now, quotaResetAt=now+1h
//       → isQuotaExhausted() 持续 1 小时为 true
//       → hasBlockedAccount() → true
//       → decideHoldAction() 第一条 if 命中 → hold
//   后果:此后 1 小时内**任何** pre-body 错误(哪怕 400 malformed)都被挂起。
//
// 讽刺的是 hasBlockedAccount 的注释明确写着「明确不认 429 限流触发的退避冷却」——
// 2026-08-02 那次修复(holdGateFalsePositive.test.ts)只切断了 errorCount 这条路,
// 429 从 quotaExhaustedAt 这条后门绕了进来。那个测试的盲区是:它验证了
// 「429 + 池里无号被封禁 → 不 hold」,却没验证「429 本身会不会把池变成『有号额度耗尽』」。
//
// 第二个缺陷:recordSuccess 只重置 errorCount,不清 quotaExhaustedAt ——
// 请求成功(上游放行该账号的最硬证据)什么都翻转不了,只能干等那 1 小时走完。
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool, ErrorType, extractHttpStatusCode } from '@main/proxy/accountPool'
import type { ProxyAccount } from '@main/proxy/types'

function mk(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    isAvailable: true,
    ...extra
  }
}

describe('AccountPool · 429 限流不是额度耗尽', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('429 不得把账号标记为额度耗尽(实测 147 次 429 有 146 次同号 60s 内成功)', () => {
    pool.addAccount(mk('A'))
    pool.recordError('A', ErrorType.RECOVERABLE, 429)

    const acc = pool.getAccount('A')!
    expect(pool.isQuotaExhausted(acc)).toBe(false)
    // 这条是 HoldGate 的权威判据 —— 一旦为真,后续任何 pre-body 错误都会被挂起
    expect(pool.hasBlockedAccount()).toBe(false)
  })

  it('429 的退避冷却仍要生效(只是不该升级成「额度耗尽」)', () => {
    pool.addAccount(mk('A2'))
    pool.recordError('A2', ErrorType.RECOVERABLE, 429)

    const acc = pool.getAccount('A2')!
    // errorCount 指数退避是 429 的正确处置方式,必须保留 ——
    // recordError 只写 errorCount,退避时长由 isAccountAvailable 按 errorCount
    // 动态算(baseCooldownMs * 2^(n-1)),不写 cooldownUntil 字段。
    expect(acc.errorCount).toBeGreaterThan(0)
    // 但不得升级成「额度耗尽」那种 1 小时级的池级封锁
    expect(pool.isQuotaExhausted(acc)).toBe(false)
  })

  it('402 额度不足仍必须标记(修 429 不能把真额度问题一起放过)', () => {
    pool.addAccount(mk('B'))
    pool.recordError('B', ErrorType.RECOVERABLE, 402)

    const acc = pool.getAccount('B')!
    expect(pool.isQuotaExhausted(acc)).toBe(true)
    expect(pool.hasBlockedAccount()).toBe(true)
  })

  it('ThrottlingException 类限流同样不得标记额度耗尽(同族语义)', () => {
    // callWithRetry 把 429 / ThrottlingException / rate limit 归一为 statusCode=429 上报,
    // 把 402 / quota / limit exceeded 归一为 402 —— 它们分属限流与额度两族
    pool.addAccount(mk('B2'))
    pool.recordError('B2', ErrorType.RECOVERABLE, 429)
    expect(pool.hasBlockedAccount()).toBe(false)
  })
})

describe('AccountPool · 请求成功必须能清除额度耗尽误标', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('成功后必须清除 quotaExhausted 误标(成功是上游放行该账号的最硬证据)', () => {
    pool.addAccount(mk('C'))
    // 用 402 制造一个「真的被标记」的状态,再验证成功能否翻转
    pool.recordError('C', ErrorType.RECOVERABLE, 402)
    expect(pool.hasBlockedAccount()).toBe(true)

    pool.recordSuccess('C')

    const acc = pool.getAccount('C')!
    expect(pool.isQuotaExhausted(acc)).toBe(false)
    expect(pool.hasBlockedAccount()).toBe(false)
  })

  it('成功也必须重置 errorCount 退避(既有行为,不得回退)', () => {
    pool.addAccount(mk('C2'))
    pool.recordError('C2', ErrorType.RECOVERABLE, 500)
    expect(pool.getAccount('C2')!.errorCount).toBeGreaterThan(0)

    pool.recordSuccess('C2')
    expect(pool.getAccount('C2')!.errorCount).toBe(0)
  })

  it('成功不得覆盖真实额度数据(quotaUsed>=quotaLimit 由 updateQuota 权威写入)', () => {
    // 真实额度用尽不是误标 —— 一次成功不能把它抹掉,否则会反复去撞真的没额度的号
    pool.addAccount(mk('D', { quotaUsed: 100, quotaLimit: 100 }))
    expect(pool.hasBlockedAccount()).toBe(true)

    pool.recordSuccess('D')
    expect(pool.hasBlockedAccount()).toBe(true)
  })

  it('成功不得解封被封禁账号(封禁需人工或后端解除)', () => {
    pool.addAccount(mk('E', { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' }))
    expect(pool.hasBlockedAccount()).toBe(true)

    pool.recordSuccess('E')
    expect(pool.hasBlockedAccount()).toBe(true)
  })
})

describe('extractHttpStatusCode · 状态码只认 HTTP 语义位置', () => {
  // 同根因变体(§4.8):误标链条的另一个入口 —— 状态码提取错了,后面的分类和
  // quotaExhausted 标记全跟着错。旧实现是裸的 `error.message.match(/(\d{3})/)`,
  // 抓消息里第一个连续 3 位数字,不看它是不是状态码。proxyServer 有 4 处这样写。
  it('正确提取 kiroApi 抛错格式的状态码', () => {
    expect(extractHttpStatusCode('API error 429: {"message":"..."}')).toBe(429)
    expect(extractHttpStatusCode('Auth error 401: expired')).toBe(401)
    expect(extractHttpStatusCode('API error 400: {"reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}')).toBe(400)
    expect(extractHttpStatusCode('API error 503: unavailable')).toBe(503)
  })

  it('绝不把端口号当状态码(实测 EU 超时错误里的 :443)', () => {
    expect(
      extractHttpStatusCode('Connect Timeout Error (attempted address: runtime.eu-central-1.kiro.dev:443, timeout: 10000ms)')
    ).toBeUndefined()
  })

  it('绝不把 payload size 当状态码 —— 402913 会被抓成 402 → 直接触发额度耗尽误标', () => {
    expect(extractHttpStatusCode('Payload size: 402913 bytes exceeds limit')).toBeUndefined()
    expect(extractHttpStatusCode('payload 429184 bytes rejected')).toBeUndefined()
  })

  it('绝不把 errno 当状态码', () => {
    expect(extractHttpStatusCode('read ECONNRESET errno -4077')).toBeUndefined()
  })

  it('无状态码的传输层错误返回 undefined(交给调用方按 RECOVERABLE 兜底)', () => {
    expect(extractHttpStatusCode('fetch failed')).toBeUndefined()
    expect(extractHttpStatusCode('Rate limited on KiroRuntime-EU after 10 retries')).toBeUndefined()
    expect(
      extractHttpStatusCode('Client network socket disconnected before secure TLS connection was established')
    ).toBeUndefined()
  })

  it('兼容 status= / statusCode: / HTTP NNN 等常见措辞', () => {
    expect(extractHttpStatusCode('request failed status=503')).toBe(503)
    expect(extractHttpStatusCode('statusCode: 502 bad gateway')).toBe(502)
    expect(extractHttpStatusCode('HTTP 504 gateway timeout')).toBe(504)
  })

  it('超出 HTTP 范围的数字不当状态码', () => {
    expect(extractHttpStatusCode('API error 999: weird')).toBeUndefined()
    expect(extractHttpStatusCode('API error 099: weird')).toBeUndefined()
  })

  it('空串 / 无匹配不炸', () => {
    expect(extractHttpStatusCode('')).toBeUndefined()
    expect(extractHttpStatusCode('something went wrong')).toBeUndefined()
  })
})

describe('AccountPool · describeBlockedAccounts 可观测性出口', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('判据与 hasBlockedAccount 一致:没有被封禁/额度耗尽的号时返回空数组', () => {
    pool.addAccount(mk('OK1'))
    pool.addAccount(mk('OK2'))
    pool.recordError('OK2', ErrorType.RECOVERABLE, 429) // 429 只退避,不算 blocked
    expect(pool.hasBlockedAccount()).toBe(false)
    expect(pool.describeBlockedAccounts()).toEqual([])
  })

  it('列出被封禁的号及封禁原因', () => {
    pool.addAccount(mk('S', { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' }))
    const out = pool.describeBlockedAccounts()
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('S@example.com')
    expect(out[0]).toContain('suspended')
    expect(out[0]).toContain('TEMPORARILY_SUSPENDED')
  })

  it('额度耗尽要能区分「真实额度数据」与「仅有标记」两种来源', () => {
    // 真实额度数据用尽 —— 权威,不是误标
    pool.addAccount(mk('Real', { quotaUsed: 100, quotaLimit: 100 }))
    // 仅有耗尽标记(402 上报打的)—— 日志要能看出它没有真实额度依据
    pool.addAccount(mk('Marked'))
    pool.recordError('Marked', ErrorType.RECOVERABLE, 402)

    const out = pool.describeBlockedAccounts()
    expect(out).toHaveLength(2)
    const real = out.find((s) => s.includes('Real@'))!
    const marked = out.find((s) => s.includes('Marked@'))!
    expect(real).toContain('quotaUsed=100/100')
    expect(marked).toContain('markedAt=')
    expect(marked).toContain('resetAt=')
  })

  it('每个 blocked 号只输出一条(封禁优先,不与额度耗尽重复计)', () => {
    pool.addAccount(mk('Both', {
      suspendedAt: Date.now(),
      suspendReason: 'TEMPORARILY_SUSPENDED',
      quotaUsed: 100,
      quotaLimit: 100
    }))
    expect(pool.describeBlockedAccounts()).toHaveLength(1)
  })
})
