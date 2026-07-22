// TDD Red 阶段:先写失败测试
// 目标:抽公共主进程 SWRR(与 RegisterPage.tsx:1630-1666 邮箱源 SWRR 算法一致)
// 使用场景:AccountPool.pickWeighted / ModelMapping loadbalance
import { describe, it, expect } from 'vitest'
import { SmoothWeightedRoundRobin } from '@main/utils/smoothWeightedRoundRobin'

interface Item { id: string; weight: number }

describe('SmoothWeightedRoundRobin', () => {
  it('pick_should_distribute_80_20_within_2percent_over_1000_calls', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    const cands: Item[] = [
      { id: 'A', weight: 80 },
      { id: 'B', weight: 20 }
    ]
    const counts: Record<string, number> = { A: 0, B: 0 }
    for (let i = 0; i < 1000; i++) {
      const picked = swrr.pick(cands)
      expect(picked).not.toBeNull()
      counts[picked!.id]++
    }
    expect(counts.A).toBeGreaterThanOrEqual(780)
    expect(counts.A).toBeLessThanOrEqual(820)
    expect(counts.B).toBeGreaterThanOrEqual(180)
    expect(counts.B).toBeLessThanOrEqual(220)
  })

  it('pick_should_skip_zero_weight', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    const cands: Item[] = [
      { id: 'A', weight: 100 },
      { id: 'B', weight: 0 }
    ]
    for (let i = 0; i < 100; i++) {
      const picked = swrr.pick(cands)
      expect(picked?.id).toBe('A')
    }
  })

  it('pick_should_return_null_when_all_zero_weight', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    const cands: Item[] = [
      { id: 'A', weight: 0 },
      { id: 'B', weight: 0 }
    ]
    expect(swrr.pick(cands)).toBeNull()
  })

  it('pick_should_return_null_for_empty_candidates', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    expect(swrr.pick([])).toBeNull()
  })

  it('pick_should_return_single_item_deterministically', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    const cands: Item[] = [{ id: 'A', weight: 50 }]
    for (let i = 0; i < 10; i++) {
      expect(swrr.pick(cands)?.id).toBe('A')
    }
  })

  it('pick_should_handle_dynamic_candidates', () => {
    // 模拟部分账户额度耗尽:每次调用 candidates 不同,累计比例仍按剩余候选权重
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    const full: Item[] = [
      { id: 'A', weight: 80 },
      { id: 'B', weight: 20 }
    ]
    const onlyA: Item[] = [{ id: 'A', weight: 80 }]

    // 先 500 次 full
    const counts: Record<string, number> = { A: 0, B: 0 }
    for (let i = 0; i < 500; i++) {
      const p = swrr.pick(full)!
      counts[p.id]++
    }
    // 再 500 次只有 A(B 耗尽) — 全部命中 A
    for (let i = 0; i < 500; i++) {
      const p = swrr.pick(onlyA)!
      counts[p.id]++
    }
    // B 应约 100 次 ± 20(500 * 0.2)
    expect(counts.B).toBeGreaterThanOrEqual(80)
    expect(counts.B).toBeLessThanOrEqual(120)
    // A 应约 400 + 500 = 900
    expect(counts.A).toBeGreaterThanOrEqual(880)
    expect(counts.A).toBeLessThanOrEqual(920)
  })

  it('updateWeight_should_change_distribution_without_reset', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    // 初始 A=80 B=20 跑 100 次热身(不校验)
    const cands: Item[] = [
      { id: 'A', weight: 80 },
      { id: 'B', weight: 20 }
    ]
    for (let i = 0; i < 100; i++) swrr.pick(cands)

    // 热更新权重 → A=20 B=80(手动改 candidates weight 字段 + 通知 SWRR)
    cands[0].weight = 20
    cands[1].weight = 80

    const counts: Record<string, number> = { A: 0, B: 0 }
    for (let i = 0; i < 1000; i++) {
      const p = swrr.pick(cands)!
      counts[p.id]++
    }
    // 允许一些累积 credit 遗留,但主体应反转
    expect(counts.B).toBeGreaterThan(counts.A)
    expect(counts.B).toBeGreaterThanOrEqual(700)
  })

  it('reset_should_clear_credit_state', () => {
    const swrr = new SmoothWeightedRoundRobin<Item>({
      getId: (x) => x.id,
      getWeight: (x) => x.weight
    })
    const cands: Item[] = [
      { id: 'A', weight: 100 },
      { id: 'B', weight: 1 }
    ]
    for (let i = 0; i < 10; i++) swrr.pick(cands)
    swrr.reset()
    // 重置后第一次必定选权重最大的(A)
    expect(swrr.pick(cands)?.id).toBe('A')
  })
})
