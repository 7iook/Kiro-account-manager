// AccountPool 可用性变化通知出口(notifyAvailabilityChanged)测试
//
// 方案:.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §5 A4
//      + availability-paths.md(6 个主动写入路径)
// 设计:AccountPool 提供 setAvailabilityListener 注入出口;在"能让池从全挂→出现可用号"
//      的写入路径末尾触发监听器(带 availableCount 0→>0 去抖,避免无关字段刷新误触发)。
//      HoldGate.tryResume() 订阅此出口实现"事件即时唤醒"(时间衰减恢复由 HoldGate 轮询兜底)。
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

describe('AccountPool · notifyAvailabilityChanged 可用性变化出口', () => {
  let pool: AccountPool
  let listener: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pool = new AccountPool()
    listener = vi.fn()
    pool.setAvailabilityListener(listener)
  })

  it('addAccount 加入一个可用账号(从空池 0→1)→ 触发通知', () => {
    pool.addAccount(mk('A'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('addAccount 加入 suspended 账号(仍 0 可用)→ 不触发通知', () => {
    pool.addAccount(mk('S', { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' }))
    expect(listener).not.toHaveBeenCalled()
  })

  it('clearSuspended 解封(0→1 可用)→ 触发通知', () => {
    pool.addAccount(mk('S', { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' }))
    listener.mockClear()
    pool.clearSuspended('S')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('updateQuota 配额恢复(used<limit,从耗尽 0→1)→ 触发通知', () => {
    // 先加一个配额耗尽账号(池 0 可用)
    pool.addAccount(mk('Q', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    listener.mockClear()
    pool.updateQuota('Q', 10, 100)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('updateQuota 无恢复(仍耗尽 used>=limit)→ 不触发通知', () => {
    pool.addAccount(mk('A')) // 池已有 1 可用,保证不是"从 0 起"
    pool.addAccount(mk('Q', { quotaExhaustedAt: Date.now(), quotaUsed: 100, quotaLimit: 100 }))
    listener.mockClear()
    pool.updateQuota('Q', 100, 100)
    expect(listener).not.toHaveBeenCalled()
  })

  it('reset 全池恢复(从全挂 0→有可用)→ 触发通知', () => {
    pool.addAccount(mk('S', { suspendedAt: Date.now(), suspendReason: 'X' }))
    listener.mockClear()
    pool.reset()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('updateAccount 触及可用性字段(清 suspendedAt,0→1)→ 触发通知', () => {
    pool.addAccount(mk('S', { suspendedAt: Date.now(), suspendReason: 'X' }))
    listener.mockClear()
    pool.updateAccount('S', { suspendedAt: undefined, isAvailable: true })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('updateAccount 只改无关字段(lastUsed/requestCount)→ 不触发通知', () => {
    pool.addAccount(mk('A'))
    listener.mockClear()
    pool.updateAccount('A', { lastUsed: Date.now(), requestCount: 5 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('去抖:池已有可用号(1→2)时再加可用号 → 不重复触发(仅 0→>0 才 emit)', () => {
    pool.addAccount(mk('A'))
    listener.mockClear()
    pool.addAccount(mk('B'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('未注册监听器时写入路径不抛错', () => {
    const p2 = new AccountPool()
    expect(() => p2.addAccount(mk('A'))).not.toThrow()
  })
})
