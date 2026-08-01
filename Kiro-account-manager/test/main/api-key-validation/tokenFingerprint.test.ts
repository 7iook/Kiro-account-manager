/**
 * 单元测试:sha256Fingerprint(RCA §6 A6-R2 语义)
 *
 * 契约:
 *   - fingerprint = sha256(accessToken).slice(0, 16)
 *   - 输出 16 位小写 hex(碰撞域 2^64)
 *   - 确定性:同 token → 同 fingerprint;异 token → 异 fingerprint
 */
import { describe, it, expect } from 'vitest'
import { sha256Fingerprint } from '@main/utils/tokenFingerprint'

describe('sha256Fingerprint', () => {
  it('输出 16 位小写 hex', () => {
    const fp = sha256Fingerprint('ksk_hello_world')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('确定性:同一 accessToken 每次产生相同 fingerprint', () => {
    const fp1 = sha256Fingerprint('ksk_abc123')
    const fp2 = sha256Fingerprint('ksk_abc123')
    expect(fp1).toBe(fp2)
  })

  it('区分性:不同 accessToken 产生不同 fingerprint', () => {
    const fpA = sha256Fingerprint('ksk_alpha')
    const fpB = sha256Fingerprint('ksk_beta')
    expect(fpA).not.toBe(fpB)
  })

  it('相似但不相同的 token 产生不同 fingerprint(sha256 雪崩效应)', () => {
    // 只差一个字符,但整个前 16 位 hex 应该完全不同
    const fp1 = sha256Fingerprint('ksk_test_A')
    const fp2 = sha256Fingerprint('ksk_test_B')
    expect(fp1).not.toBe(fp2)
    // 至少半数字符不同(雪崩效应保证)
    let diff = 0
    for (let i = 0; i < 16; i++) {
      if (fp1[i] !== fp2[i]) diff++
    }
    expect(diff).toBeGreaterThan(4)
  })

  it('空字符串仍返回 16 位 hex(sha256("") 的前 16 位)', () => {
    const fp = sha256Fingerprint('')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    // sha256 空串开头是 e3b0c44298fc1c14
    expect(fp).toBe('e3b0c44298fc1c14')
  })
})
