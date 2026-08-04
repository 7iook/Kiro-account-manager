/**
 * redact.ts 两处缺口的回归测试（决策卡 §3「输出脱敏与照搬豁免」· W5 recon §3.2）
 *
 * 缺口 1：`csrfToken` 未列入 SENSITIVE_KEYS —— 它是 `AccountCredentials` 的必填字段
 *         （`src/renderer/src/types/account.ts:16`），却不会被键名匹配命中。
 * 缺口 2：`ksk_` 网页密钥无**值级**识别 —— 它靠值前缀而非键名标识，
 *         若作为裸值出现在非敏感键名下（note / raw / message），不会被打码。
 *
 * 同时锁定既有行为不回退：SAFE_KEYS 计量字段不得被误伤。
 */
import { describe, it, expect } from 'vitest'
import { redactString, redactValue } from '../../../src/main/utils/redact'

describe('redact 缺口 1：csrfToken', () => {
  it('csrfToken 作为键名时整体打码', () => {
    const out = redactValue({ csrfToken: 'abcdef0123456789xyz' }) as Record<string, unknown>
    expect(out.csrfToken).not.toBe('abcdef0123456789xyz')
    expect(String(out.csrfToken)).not.toContain('def0123456789')
  })

  it('csrf_token 蛇形命名同样命中', () => {
    const out = redactValue({ csrf_token: 'abcdef0123456789xyz' }) as Record<string, unknown>
    expect(String(out.csrf_token)).not.toContain('def0123456789')
  })

  it('嵌套在 credentials 下的 csrfToken 也被打码（真实 account 形状）', () => {
    const account = {
      id: 'a1',
      email: 'u@example.com',
      credentials: { accessToken: 'AT-plaintext-value', csrfToken: 'CSRF-plaintext-value' }
    }
    const serialised = JSON.stringify(redactValue(account))
    expect(serialised).not.toContain('CSRF-plaintext-value')
    expect(serialised).not.toContain('AT-plaintext-value')
  })

  it('已被 JSON.stringify 成裸串后的 csrfToken 键值也兜底打码', () => {
    const out = redactString('{"csrfToken":"abcdef0123456789xyz"}')
    expect(out).not.toContain('def0123456789')
  })
})

describe('redact 缺口 2：ksk_ 值级识别', () => {
  it('裸值形式的 ksk_ 密钥在非敏感键名下也被打码', () => {
    const out = redactValue({ note: 'imported key ksk_ABCDEFGH1234567890abcdefgh ok' }) as Record<
      string,
      unknown
    >
    expect(String(out.note)).not.toContain('ABCDEFGH1234567890abcdefgh')
  })

  it('日志消息里的 ksk_ 密钥被打码', () => {
    const out = redactString('verify failed for ksk_ABCDEFGH1234567890abcdefgh')
    expect(out).not.toContain('ABCDEFGH1234567890abcdefgh')
  })

  it('不误伤只提及前缀的文案（错误提示 / 注释里的 "ksk_ 开头"）', () => {
    const msg = 'API Key 格式错误：应以 ksk_ 开头'
    expect(redactString(msg)).toBe(msg)
  })

  it('不误伤短的测试夹具值（ksk_test / ksk_x）', () => {
    expect(redactString('validateApiKeyCredential(ksk_test)')).toBe(
      'validateApiKeyCredential(ksk_test)'
    )
    expect(redactString('a@b.c,ksk_x')).toBe('a@b.c,ksk_x')
  })
})

describe('既有行为不回退', () => {
  it('SAFE_KEYS 计量字段不被误伤', () => {
    const out = redactValue({
      maxTokens: 4096,
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46
    }) as Record<string, unknown>
    expect(out).toEqual({ maxTokens: 4096, inputTokens: 12, outputTokens: 34, totalTokens: 46 })
  })

  it('accessToken / refreshToken / clientSecret 仍然被打码', () => {
    const out = redactValue({
      accessToken: 'AT-plaintext',
      refreshToken: 'RT-plaintext',
      clientSecret: 'CS-plaintext'
    })
    const s = JSON.stringify(out)
    expect(s).not.toContain('AT-plaintext')
    expect(s).not.toContain('RT-plaintext')
    expect(s).not.toContain('CS-plaintext')
  })

  it('URL 账密与 JWT 仍被打码（redactString 既有能力）', () => {
    expect(redactString('http://user:sekret@proxy:8080')).toContain('user:***@')
    const jwt = 'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM'
    expect(redactString(`token=${jwt}`)).not.toContain(jwt)
  })
})
