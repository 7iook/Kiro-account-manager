// Hold Gate 配置归一化(clamp/跨字段校验)测试
//
// 方案 §3 配置校验:非有限值/越界一律 clamp 到默认并 warn,校验唯一收口在 config 归一化处(SSOT)。
//   - holdPingIntervalMs: clamp [1000, 40000];非有限→默认 10000
//   - holdMaxWaitMs / holdTotalBudgetMs: clamp [10000, 21600000];且 holdMaxWaitMs ≤ holdTotalBudgetMs
//   - holdGraceMs: clamp [1000, 60000] 且 < holdTotalBudgetMs
import { describe, it, expect } from 'vitest'
import { normalizeHoldConfig, HOLD_DEFAULTS } from '@main/proxy/holdConfig'

describe('normalizeHoldConfig · 挂起门闸配置 clamp / 跨字段校验', () => {
  it('空输入 → 全部回落默认值', () => {
    const r = normalizeHoldConfig({})
    expect(r).toEqual(HOLD_DEFAULTS)
  })

  it('holdPingIntervalMs 越下限(500)→ clamp 到 1000', () => {
    expect(normalizeHoldConfig({ holdPingIntervalMs: 500 }).pingIntervalMs).toBe(1000)
  })

  it('holdPingIntervalMs 越上限(99999)→ clamp 到 40000', () => {
    expect(normalizeHoldConfig({ holdPingIntervalMs: 99999 }).pingIntervalMs).toBe(40000)
  })

  it('holdPingIntervalMs 非有限值(NaN)→ 回落默认 10000', () => {
    expect(normalizeHoldConfig({ holdPingIntervalMs: NaN }).pingIntervalMs).toBe(10000)
  })

  it('holdTotalBudgetMs 越上限(99999999)→ clamp 到 21600000(6h)', () => {
    expect(normalizeHoldConfig({ holdTotalBudgetMs: 99999999 }).totalBudgetMs).toBe(21600000)
  })

  // 回归护栏(2026-08-06 实测):上限曾写死 1740000(29min),依据是「客户端 30min 硬顶」的误读。
  // 生产日志实证曾成功挂起 4172s(69.5min),故 1h 以上的预算必须能被接受、不得被 clamp 掉。
  it('holdTotalBudgetMs 设 2h → 原样保留(不被 clamp 回 29min)', () => {
    expect(normalizeHoldConfig({ holdTotalBudgetMs: 7200000 }).totalBudgetMs).toBe(7200000)
  })

  it('holdMaxWaitMs > holdTotalBudgetMs → maxWaitMs 收敛到 totalBudgetMs', () => {
    const r = normalizeHoldConfig({ holdMaxWaitMs: 1000000, holdTotalBudgetMs: 500000 })
    expect(r.totalBudgetMs).toBe(500000)
    expect(r.maxWaitMs).toBe(500000)
  })

  it('holdMaxWaitMs 越下限(5000)→ clamp 到 10000', () => {
    expect(normalizeHoldConfig({ holdMaxWaitMs: 5000 }).maxWaitMs).toBe(10000)
  })

  it('holdGraceMs 越上限(99999)→ clamp 到 60000', () => {
    // totalBudget 默认 1680000 > 60000,故上限生效
    expect(normalizeHoldConfig({ holdGraceMs: 99999 }).graceMs).toBe(60000)
  })

  it('holdGraceMs ≥ totalBudgetMs → grace 收敛到 totalBudgetMs-1(必须 < 预算)', () => {
    const r = normalizeHoldConfig({ holdGraceMs: 50000, holdTotalBudgetMs: 10000, holdMaxWaitMs: 10000 })
    expect(r.totalBudgetMs).toBe(10000)
    expect(r.graceMs).toBeLessThan(10000)
  })

  it('holdTimeoutAction 非法值 → 回落 keep_blocking', () => {
    // @ts-expect-error 测试非法输入
    expect(normalizeHoldConfig({ holdTimeoutAction: 'boom' }).timeoutAction).toBe('keep_blocking')
  })

  it('holdTimeoutAction 合法值(error)→ 保留', () => {
    expect(normalizeHoldConfig({ holdTimeoutAction: 'error' }).timeoutAction).toBe('error')
  })

  it('合法完整输入 → 原样通过', () => {
    const r = normalizeHoldConfig({
      holdPingIntervalMs: 8000,
      holdMaxWaitMs: 300000,
      holdTotalBudgetMs: 900000,
      holdGraceMs: 20000,
      holdTimeoutAction: 'graceful_stop'
    })
    expect(r).toEqual({
      pingIntervalMs: 8000,
      maxWaitMs: 300000,
      totalBudgetMs: 900000,
      graceMs: 20000,
      timeoutAction: 'graceful_stop'
    })
  })
})
