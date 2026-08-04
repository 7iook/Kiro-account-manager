/**
 * webPanel 响应出口 respond.ts · TDD Red
 *
 * 决策卡 §3：`sendJson()` 无条件过 `redactValue` 兜底（denylist 外层）。
 * 与 dto.ts（allowlist 内层）分工：白名单决定「给什么」，本层保证「什么都不漏」。
 *
 * 本层要证明的核心性质：**即使调用方偷懒把内部对象整个丢进来，凭据也不会明文出网**。
 */
import { describe, it, expect } from 'vitest'
import { sendJson, sendError } from '../../../src/main/webPanel/respond'

/** 最小 ServerResponse 替身：只记录真实副作用（写头 / 写体），不 mock 断言 */
function fakeRes(): {
  res: import('node:http').ServerResponse
  status: () => number | undefined
  headers: () => Record<string, unknown>
  body: () => string
  ended: () => boolean
} {
  let status: number | undefined
  let headers: Record<string, unknown> = {}
  let body = ''
  let ended = false
  const res = {
    writeHead(code: number, hdrs?: Record<string, unknown>) {
      status = code
      if (hdrs) headers = { ...headers, ...hdrs }
      return this
    },
    end(chunk?: string) {
      if (chunk) body += chunk
      ended = true
      return this
    }
  }
  return {
    res: res as unknown as import('node:http').ServerResponse,
    status: () => status,
    headers: () => headers,
    body: () => body,
    ended: () => ended
  }
}

describe('sendJson 是面板唯一 JSON 出口', () => {
  it('写出状态码、Content-Type 与 nosniff，并结束响应', () => {
    const f = fakeRes()
    sendJson(f.res, 200, { ok: true })
    expect(f.status()).toBe(200)
    expect(f.headers()['Content-Type']).toBe('application/json; charset=utf-8')
    expect(f.headers()['X-Content-Type-Options']).toBe('nosniff')
    expect(f.ended()).toBe(true)
    expect(JSON.parse(f.body())).toEqual({ ok: true })
  })

  it('兜底网：调用方直接丢整个内部 account 对象，凭据也不明文出网', () => {
    const f = fakeRes()
    sendJson(f.res, 200, {
      accounts: [
        {
          id: 'a1',
          email: 'u@example.com',
          credentials: {
            accessToken: 'AT-PLAINTEXT-SECRET',
            refreshToken: 'RT-PLAINTEXT-SECRET',
            clientSecret: 'CS-PLAINTEXT-SECRET',
            csrfToken: 'CSRF-PLAINTEXT-SECRET'
          }
        }
      ]
    })
    const body = f.body()
    expect(body).not.toContain('AT-PLAINTEXT-SECRET')
    expect(body).not.toContain('RT-PLAINTEXT-SECRET')
    expect(body).not.toContain('CS-PLAINTEXT-SECRET')
    expect(body).not.toContain('CSRF-PLAINTEXT-SECRET')
    // 非敏感字段仍原样保留（脱敏不能把正常响应打烂）
    expect(body).toContain('u@example.com')
    expect(body).toContain('a1')
  })

  it('ksk_ 网页密钥即使藏在非敏感键名下也被打码', () => {
    const f = fakeRes()
    sendJson(f.res, 200, { note: 'imported ksk_ABCDEFGH1234567890abcdefghijkl' })
    expect(f.body()).not.toContain('ABCDEFGH1234567890abcdefghijkl')
  })

  it('深层嵌套里的凭据同样被打码（泄漏最常存活的地方）', () => {
    const f = fakeRes()
    sendJson(f.res, 200, {
      data: { page: { items: [{ inner: { accessToken: 'DEEP-PLAINTEXT-SECRET' } }] } }
    })
    expect(f.body()).not.toContain('DEEP-PLAINTEXT-SECRET')
  })

  it('计量字段不被误伤（SAFE_KEYS 白名单仍生效）', () => {
    const f = fakeRes()
    sendJson(f.res, 200, { usage: { maxTokens: 4096, totalTokens: 128 } })
    expect(JSON.parse(f.body())).toEqual({ usage: { maxTokens: 4096, totalTokens: 128 } })
  })

  it('循环引用由 redactValue 化解，响应仍是 200 而非 500 兜底', () => {
    const f = fakeRes()
    const cyclic: Record<string, unknown> = { id: 'x' }
    cyclic.self = cyclic
    expect(() => sendJson(f.res, 200, cyclic)).not.toThrow()
    expect(f.ended()).toBe(true)
    // 关键：走的是 redactValue 的 WeakSet 化解路径（环 → '[circular]'），
    // 不是 JSON.stringify 抛异常后的 500 降级路径。若脱敏被绕过，这里会变成 500。
    expect(f.status()).toBe(200)
    expect(f.body()).toContain('[circular]')
  })
})

describe('sendError 走同一个出口', () => {
  it('输出稳定错误码，且不回传上游原始报文', () => {
    const f = fakeRes()
    sendError(f.res, 404, 'ACCOUNT_NOT_FOUND')
    expect(f.status()).toBe(404)
    const parsed = JSON.parse(f.body()) as Record<string, unknown>
    expect(parsed.code).toBe('ACCOUNT_NOT_FOUND')
  })

  it('错误消息里夹带的凭据也被打码', () => {
    const f = fakeRes()
    sendError(f.res, 502, 'TOKEN_REFRESH_FAILED', 'upstream said accessToken=AT-PLAINTEXT-SECRET')
    expect(f.body()).not.toContain('AT-PLAINTEXT-SECRET')
    expect(f.body()).toContain('TOKEN_REFRESH_FAILED')
  })
})
