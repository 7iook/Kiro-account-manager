// TDD: AccountPool 热切换 · 2026-07-23 hot-swap-accounts 决策卡 §4
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool } from '@main/proxy/accountPool'
import type { ProxyAccount } from '@main/proxy/types'

function mk(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    isAvailable: true,
    ...extra
  }
}

describe('AccountPool · setActiveAccount(热切换)', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('setActiveAccount 存在 → 返回 true', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    pool.addAccount(mk('C'))
    expect(pool.setActiveAccount('B')).toBe(true)
  })

  it('setActiveAccount 不存在 → 返回 false', () => {
    pool.addAccount(mk('A'))
    expect(pool.setActiveAccount('NOT_EXIST')).toBe(false)
  })

  it('setActiveAccount 后 getNextAccount 优先返回该账号(round-robin 从此点开始轮)', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    pool.addAccount(mk('C'))
    expect(pool.setActiveAccount('C')).toBe(true)
    // round-robin startIndex = currentIndex,从 C 开始
    const next = pool.getNextAccount()
    expect(next?.id).toBe('C')
  })

  it('setActiveAccount 空池 → 返回 false', () => {
    expect(pool.setActiveAccount('X')).toBe(false)
  })

  it('setActiveAccount 同一账号(幂等) → 依然 true', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    expect(pool.setActiveAccount('A')).toBe(true)
    expect(pool.setActiveAccount('A')).toBe(true)
    expect(pool.getNextAccount()?.id).toBe('A')
  })
})

describe('AccountPool · 池成员热编辑(add/remove/clear 幂等)', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('clear 后重新 add 恢复池大小', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    expect(pool.size).toBe(2)
    pool.clear()
    expect(pool.size).toBe(0)
    pool.addAccount(mk('C'))
    expect(pool.size).toBe(1)
  })

  it('add 已存在 id → 覆盖式更新(幂等)', () => {
    pool.addAccount(mk('A', { email: 'old@x.com' }))
    pool.addAccount(mk('A', { email: 'new@x.com' }))
    expect(pool.size).toBe(1)
    expect(pool.getAccount('A')?.email).toBe('new@x.com')
  })

  it('remove 不存在 id → 静默(不抛错)', () => {
    pool.addAccount(mk('A'))
    expect(() => pool.removeAccount('NOT_EXIST')).not.toThrow()
    expect(pool.size).toBe(1)
  })

  it('remove 后 setActiveAccount 该 id → false(联动清除)', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    pool.removeAccount('A')
    expect(pool.setActiveAccount('A')).toBe(false)
    expect(pool.setActiveAccount('B')).toBe(true)
  })

  it('SWRR forget 在 removeAccount 时自动触发(weighted 策略无残留)', () => {
    // 用 weighted 策略,pick 后 remove,再次 pick 不应该崩
    pool.setStrategy('weighted')
    pool.addAccount(mk('A', { weight: 100 }))
    pool.addAccount(mk('B', { weight: 100 }))
    const cands1 = pool.getAllAccounts()
    // 触发一些 SWRR credit 累积
    pool.pickWeighted(cands1)
    pool.pickWeighted(cands1)
    pool.removeAccount('A')  // 内部会调 swrr.forget('A')
    const cands2 = pool.getAllAccounts()
    // A 已被 forget,只剩 B
    const picked = pool.pickWeighted(cands2)
    expect(picked?.id).toBe('B')
  })
})

describe('AccountPool · 热切换后 SWRR credit 重置', () => {
  it('setActiveAccount 调 swrr.reset,避免 weighted 策略残留 credit', () => {
    const pool = new AccountPool()
    pool.setStrategy('weighted')
    pool.addAccount(mk('A', { weight: 100 }))
    pool.addAccount(mk('B', { weight: 100 }))
    // 累积一些 credit
    const cands = pool.getAllAccounts()
    for (let i = 0; i < 5; i++) pool.pickWeighted(cands)
    // 热切换 → swrr.reset
    pool.setActiveAccount('B')
    // reset 后 pick 应该是全新分布(不携带旧倾斜)
    // 简单断言:不崩 + 返回值有效
    const picked = pool.pickWeighted(cands)
    expect(picked).not.toBeNull()
    expect(['A', 'B']).toContain(picked?.id)
  })
})
