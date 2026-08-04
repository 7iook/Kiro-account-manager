/**
 * normalizeCreditUsage · 用量额度归一化 SSOT
 *
 * 抽取来源：index.ts 内两份近乎逐字相同的额度合并代码
 *   :3861~:3886 (import-from-sso-token) 与 :5245~:5290 (verify-account-credentials)。
 * **两者存在一处真实差异**：verify 路径只累计 `status === 'ACTIVE'` 的 bonus，
 * sso-import 路径累计全部 bonus。这不是笔误也不是可"顺手统一"的：统一任何一边
 * 都会改变用户看到的额度数字。故用 `filterActiveBonuses` 显式参数保留差异，
 * 并用测试把「两个调用点各自的既有行为」分别钉死。
 */
import { describe, it, expect } from 'vitest'
import { normalizeCreditUsage, computeDaysRemaining } from '../../../src/main/accountService/usage'
import type { UsageApiShape } from '../../../src/main/accountService/types'

const usageWithBonuses: UsageApiShape = {
  usageBreakdownList: [
    {
      resourceType: 'CREDIT',
      displayName: 'credit',
      displayNamePlural: 'credits',
      currency: 'USD',
      unit: 'credit',
      overageRate: 0.04,
      overageCap: 100,
      usageLimit: 500,
      usageLimitWithPrecision: 500.5,
      currentUsage: 100,
      currentUsageWithPrecision: 100.25,
      freeTrialInfo: {
        freeTrialStatus: 'ACTIVE',
        usageLimitWithPrecision: 50.5,
        currentUsageWithPrecision: 10.25,
        freeTrialExpiry: '2026-09-01T00:00:00Z'
      },
      bonuses: [
        { bonusCode: 'B1', displayName: 'active bonus', status: 'ACTIVE', usageLimitWithPrecision: 20, currentUsageWithPrecision: 5, expiresAt: '2026-10-01' },
        { bonusCode: 'B2', displayName: 'expired bonus', status: 'EXPIRED', usageLimitWithPrecision: 7, currentUsageWithPrecision: 3 }
      ]
    }
  ],
  nextDateReset: '2026-09-01T00:00:00Z',
  overageConfiguration: { overageStatus: 'ENABLED' }
}

describe('normalizeCreditUsage · 额度合并', () => {
  it('添加账号(verify 路径)只把生效中的赠送额度计入总额 —— 过期赠送不能虚增用户可用额度', () => {
    const u = normalizeCreditUsage(usageWithBonuses, { filterActiveBonuses: true })
    expect(u.bonuses.map((b) => b.code)).toEqual(['B1'])
    // 500.5 (base) + 50.5 (trial) + 20 (B1) —— 不含 EXPIRED 的 7
    expect(u.limit).toBeCloseTo(571, 6)
    expect(u.current).toBeCloseTo(115.5, 6)
  })

  it('SSO Token 导入路径保留「全部赠送额度都计入」的既有行为（与 verify 路径有意不同）', () => {
    const u = normalizeCreditUsage(usageWithBonuses, { filterActiveBonuses: false })
    expect(u.bonuses.map((b) => b.code)).toEqual(['B1', 'B2'])
    expect(u.limit).toBeCloseTo(578, 6) // 多出 EXPIRED 的 7
    expect(u.current).toBeCloseTo(118.5, 6)
  })

  it('优先取带精度的小数字段，避免账号列表把 100.25 额度显示成 100', () => {
    const u = normalizeCreditUsage(usageWithBonuses, { filterActiveBonuses: true })
    expect(u.baseLimit).toBe(500.5)
    expect(u.baseCurrent).toBe(100.25)
  })

  it('试用期未激活时不计入试用额度（freeTrialStatus 非 ACTIVE）', () => {
    const inactive: UsageApiShape = {
      usageBreakdownList: [
        {
          resourceType: 'CREDIT',
          usageLimit: 100,
          currentUsage: 1,
          freeTrialInfo: { freeTrialStatus: 'EXPIRED', usageLimit: 999, currentUsage: 111 }
        }
      ]
    }
    const u = normalizeCreditUsage(inactive, { filterActiveBonuses: true })
    expect(u.freeTrialLimit).toBe(0)
    expect(u.freeTrialCurrent).toBe(0)
    expect(u.freeTrialExpiry).toBeUndefined()
    expect(u.limit).toBe(100)
  })

  it('后端没有返回 CREDIT 明细时归零，不抛错（账号卡显示 0/0 而不是白屏）', () => {
    const u = normalizeCreditUsage({}, { filterActiveBonuses: true })
    expect(u).toMatchObject({ current: 0, limit: 0, baseLimit: 0, baseCurrent: 0, bonuses: [] })
    expect(u.resourceDetail).toBeUndefined()
  })

  it('overage 开关同时认 overageStatus==="ENABLED" 与 overageEnabled===true 两种后端表达', () => {
    const byStatus = normalizeCreditUsage(usageWithBonuses, { filterActiveBonuses: true })
    expect(byStatus.resourceDetail?.overageEnabled).toBe(true)

    const byFlag = normalizeCreditUsage(
      { usageBreakdownList: [{ resourceType: 'CREDIT' }], overageConfiguration: { overageEnabled: true } },
      { filterActiveBonuses: true }
    )
    expect(byFlag.resourceDetail?.overageEnabled).toBe(true)

    const off = normalizeCreditUsage(
      { usageBreakdownList: [{ resourceType: 'CREDIT' }], overageConfiguration: { overageStatus: 'DISABLED' } },
      { filterActiveBonuses: true }
    )
    expect(off.resourceDetail?.overageEnabled).toBe(false)
  })

  it('不修改传入的 API 响应对象（防止调用方后续读到被篡改的 usageBreakdownList）', () => {
    const snapshot = JSON.stringify(usageWithBonuses)
    normalizeCreditUsage(usageWithBonuses, { filterActiveBonuses: true })
    expect(JSON.stringify(usageWithBonuses)).toBe(snapshot)
  })
})

describe('computeDaysRemaining · 额度重置剩余天数', () => {
  it('未来的重置日期向上取整成剩余天数', () => {
    const future = new Date(Date.now() + 3.2 * 86400000).toISOString()
    expect(computeDaysRemaining(future)).toBe(4)
  })

  it('已过期的重置日期返回 0 而不是负数（UI 不应显示 -3 天）', () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString()
    expect(computeDaysRemaining(past)).toBe(0)
  })

  it('后端没返回重置日期时为 undefined（UI 隐藏该行，而不是显示 0 天）', () => {
    expect(computeDaysRemaining(undefined)).toBeUndefined()
    expect(computeDaysRemaining('')).toBeUndefined()
  })
})
