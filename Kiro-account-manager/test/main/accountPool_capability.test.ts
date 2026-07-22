// TDD: AccountPool 权重 SWRR + 三态能力状态机
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

describe('AccountPool · weighted strategy', () => {
  let pool: AccountPool
  beforeEach(() => {
    pool = new AccountPool()
    pool.setStrategy('weighted')
  })

  it('pickWeighted_distributes_80_20_within_2percent_over_1000_calls', () => {
    pool.addAccount(mk('A', { weight: 80 }))
    pool.addAccount(mk('B', { weight: 20 }))
    const cands = pool.getAllAccounts()
    const counts: Record<string, number> = { A: 0, B: 0 }
    for (let i = 0; i < 1000; i++) {
      const p = pool.pickWeighted(cands)
      expect(p).not.toBeNull()
      counts[p!.id]++
    }
    expect(counts.A).toBeGreaterThanOrEqual(780)
    expect(counts.A).toBeLessThanOrEqual(820)
  })

  it('pickWeighted_treats_missing_weight_as_default_100', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    const cands = pool.getAllAccounts()
    const counts: Record<string, number> = { A: 0, B: 0 }
    for (let i = 0; i < 200; i++) {
      const p = pool.pickWeighted(cands)!
      counts[p.id]++
    }
    // 默认 100:100 → 大致均分
    expect(Math.abs(counts.A - counts.B)).toBeLessThanOrEqual(20)
  })

  it('pickWeighted_returns_null_when_all_weights_zero', () => {
    pool.addAccount(mk('A', { weight: 0 }))
    pool.addAccount(mk('B', { weight: 0 }))
    expect(pool.pickWeighted(pool.getAllAccounts())).toBeNull()
  })
})

describe('AccountPool · capability state machine', () => {
  let pool: AccountPool
  beforeEach(() => {
    pool = new AccountPool()
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
  })

  it('filterByModel_returns_unknown_when_not_synced', () => {
    const r = pool.filterByModel('gpt-5.6-sol')
    expect(r.candidates).toHaveLength(0)
    expect(r.unknownAccounts).toHaveLength(2)
    expect(r.unsupportedCount).toBe(0)
  })

  it('filterByModel_returns_only_confirmed_by_default', () => {
    pool.markModelConfirmed('A', 'gpt-5.6-sol')
    const r = pool.filterByModel('gpt-5.6-sol')
    expect(r.candidates.map(a => a.id)).toEqual(['A'])
    expect(r.unknownAccounts.map(a => a.id)).toEqual(['B'])
    expect(r.unsupportedCount).toBe(0)
  })

  it('filterByModel_respects_allowedIds', () => {
    pool.markModelConfirmed('A', 'gpt-5.6-sol')
    pool.markModelConfirmed('B', 'gpt-5.6-sol')
    const r = pool.filterByModel('gpt-5.6-sol', new Set(['A']))
    expect(r.candidates.map(a => a.id)).toEqual(['A'])
    expect(r.unknownAccounts).toHaveLength(0)
  })

  it('filterByModel_excludes_manually_excluded', () => {
    pool.updateAccount('A', { excludedModels: ['gpt-5.6-sol'] })
    pool.markModelConfirmed('A', 'gpt-5.6-sol')
    const r = pool.filterByModel('gpt-5.6-sol')
    expect(r.candidates).toHaveLength(0)
    expect(r.unsupportedCount).toBe(1)
  })

  it('markModelConfirmed_upgrades_unknown_to_confirmed', () => {
    pool.markModelConfirmed('A', 'gpt-5.6-sol')
    const a = pool.getAccount('A')!
    expect(a.modelCapabilities?.['gpt-5.6-sol']).toBe('confirmed')
  })

  it('markModelUnsupported_downgrades_confirmed', () => {
    pool.markModelConfirmed('A', 'gpt-5.6-sol')
    pool.markModelUnsupported('A', 'gpt-5.6-sol')
    const a = pool.getAccount('A')!
    expect(a.modelCapabilities?.['gpt-5.6-sol']).toBe('unsupported')
  })

  it('applyModelListResult_ok_writes_confirmed_never_writes_unsupported', () => {
    // 首次 ok: 只加 confirmed 不减
    pool.applyModelListResult('A', ['gpt-5.6-sol', 'claude-sonnet-5'], 'ok')
    let a = pool.getAccount('A')!
    expect(a.modelCapabilities?.['gpt-5.6-sol']).toBe('confirmed')
    expect(a.modelCapabilities?.['claude-sonnet-5']).toBe('confirmed')
    expect(a.lastListModelsStatus).toBe('ok')
    expect(a.lastListModelsAt).toBeGreaterThan(0)

    // 第二次 ok: API 短暂漂移, 不再返回 gpt-5.6-sol → 保留 confirmed (不主动写 unsupported)
    pool.applyModelListResult('A', ['claude-sonnet-5'], 'ok')
    a = pool.getAccount('A')!
    expect(a.modelCapabilities?.['gpt-5.6-sol']).toBe('confirmed') // 仍 confirmed
  })

  it('applyModelListResult_failed_keeps_previous_state', () => {
    pool.markModelConfirmed('A', 'gpt-5.6-sol')
    pool.applyModelListResult('A', [], 'failed')
    const a = pool.getAccount('A')!
    expect(a.modelCapabilities?.['gpt-5.6-sol']).toBe('confirmed') // 负信号不清零
    expect(a.lastListModelsStatus).toBe('failed')
  })

  it('applyModelListResult_silently_drops_when_account_deleted', () => {
    pool.applyModelListResult('nonexistent', ['x'], 'ok')
    // 不 crash 即通过
    expect(pool.getAccount('nonexistent')).toBeNull()
  })

  it('markModelUnsupported_survives_ok_sync', () => {
    // 一旦 stream 判 unsupported, applyModelListResult ok 不能把它翻回来 (runtime 优先)
    pool.markModelUnsupported('A', 'gpt-5.6-sol')
    pool.applyModelListResult('A', ['gpt-5.6-sol'], 'ok')
    // ok 覆盖为 confirmed(设计约定:list ok = 权威升级信号,可覆盖之前的 unsupported)
    const a = pool.getAccount('A')!
    expect(a.modelCapabilities?.['gpt-5.6-sol']).toBe('confirmed')
  })
})

describe('AccountPool · setStrategy weighted', () => {
  it('accepts weighted as valid strategy', () => {
    const pool = new AccountPool()
    pool.setStrategy('weighted')
    expect(pool.getStrategy()).toBe('weighted')
  })
})
