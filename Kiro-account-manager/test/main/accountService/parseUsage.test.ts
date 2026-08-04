/**
 * usageBreakdownList 解析 SSOT · TDD Red→Green
 *
 * 背景:同一份解析逻辑原先在 src/main/index.ts 内联了 **三份**(不是两份):
 *   A · check-account-status      (原 :4008 parseUsageResponse)   —— 用户日常"刷新额度"
 *   B · background-batch-check    (原 :4798 内联)
 *   C · backgroundBatchRefresh    (原 :4482 内联)
 * 三份逐字段 diff 出 4 处分歧,本文件把每处分歧钉成用例,防止合并成 SSOT 时静默回归。
 *
 * 每个 it 名 = 真实业务场景。
 */

import { describe, it, expect } from 'vitest'
import {
  parseCreditUsage,
  classifySubscriptionType,
  parseSubscription,
  type RawUsageResponse
} from '../../../src/main/accountService/parseUsage'

/** 典型 Kiro GetUsageLimits 响应:基础额度 + 生效中试用 + 一条生效奖励 */
function rawUsage(overrides: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    nextDateReset: '2026-09-01T00:00:00.000Z',
    usageBreakdownList: [
      {
        resourceType: 'CREDIT',
        displayName: 'Credits',
        displayNamePlural: 'Credits',
        currency: 'USD',
        unit: 'credit',
        usageLimit: 500,
        usageLimitWithPrecision: 500.5,
        currentUsage: 100,
        currentUsageWithPrecision: 100.25,
        overageRate: 0.04,
        overageCap: 50
      }
    ],
    subscriptionInfo: { subscriptionTitle: 'KIRO PRO' },
    ...overrides
  }
}

describe('额度解析(parseCreditUsage)', () => {
  it('优先采用带小数精度的字段,避免额度显示被取整', () => {
    const parsed = parseCreditUsage(rawUsage())
    expect(parsed.baseLimit).toBe(500.5)
    expect(parsed.baseCurrent).toBe(100.25)
  })

  it('精度字段缺失时回退到整数字段', () => {
    const parsed = parseCreditUsage(
      rawUsage({
        usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 300, currentUsage: 42 }]
      })
    )
    expect(parsed.baseLimit).toBe(300)
    expect(parsed.baseCurrent).toBe(42)
  })

  // 分歧 2:C(backgroundBatchRefresh)原先只认 resourceType==='CREDIT',
  // A/B 还认 displayName==='Credits'。窄判据在 resourceType 缺失时额度恒为 0。
  it('resourceType 缺失但 displayName 是 Credits 时仍能取到额度(批量刷新曾因此显示 0)', () => {
    const parsed = parseCreditUsage(
      rawUsage({
        usageBreakdownList: [{ displayName: 'Credits', usageLimit: 200, currentUsage: 20 }]
      })
    )
    expect(parsed.baseLimit).toBe(200)
    expect(parsed.baseCurrent).toBe(20)
  })

  it('账号没有任何额度条目时归零而不是抛错', () => {
    const parsed = parseCreditUsage(rawUsage({ usageBreakdownList: [] }))
    expect(parsed.totalLimit).toBe(0)
    expect(parsed.totalCurrent).toBe(0)
    expect(parsed.resourceDetail).toBeUndefined()
  })

  it('生效中的试用额度计入总额', () => {
    const parsed = parseCreditUsage(
      rawUsage({
        usageBreakdownList: [
          {
            resourceType: 'CREDIT',
            usageLimit: 100,
            currentUsage: 10,
            freeTrialInfo: {
              freeTrialStatus: 'ACTIVE',
              usageLimitWithPrecision: 50.5,
              currentUsageWithPrecision: 5.5,
              freeTrialExpiry: '2026-08-20T00:00:00.000Z'
            }
          }
        ]
      })
    )
    expect(parsed.freeTrialLimit).toBe(50.5)
    expect(parsed.freeTrialCurrent).toBe(5.5)
    expect(parsed.freeTrialExpiry).toBe('2026-08-20T00:00:00.000Z')
    expect(parsed.totalLimit).toBe(150.5)
    expect(parsed.totalCurrent).toBe(15.5)
  })

  it('已过期的试用额度不计入总额', () => {
    const parsed = parseCreditUsage(
      rawUsage({
        usageBreakdownList: [
          {
            resourceType: 'CREDIT',
            usageLimit: 100,
            currentUsage: 10,
            freeTrialInfo: { freeTrialStatus: 'EXPIRED', usageLimit: 50, currentUsage: 5 }
          }
        ]
      })
    )
    expect(parsed.freeTrialLimit).toBe(0)
    expect(parsed.freeTrialCurrent).toBe(0)
    expect(parsed.freeTrialExpiry).toBeUndefined()
    expect(parsed.totalLimit).toBe(100)
  })

  it('只有生效中的奖励额度计入总额,失效奖励被忽略', () => {
    const parsed = parseCreditUsage(
      rawUsage({
        usageBreakdownList: [
          {
            resourceType: 'CREDIT',
            usageLimit: 100,
            currentUsage: 10,
            bonuses: [
              {
                bonusCode: 'B1',
                displayName: '活动奖励',
                status: 'ACTIVE',
                usageLimitWithPrecision: 25.5,
                currentUsageWithPrecision: 5.25,
                expiresAt: '2026-08-31T00:00:00.000Z'
              },
              { bonusCode: 'B2', status: 'EXPIRED', usageLimit: 999, currentUsage: 999 }
            ]
          }
        ]
      })
    )
    expect(parsed.bonuses).toHaveLength(1)
    expect(parsed.bonuses[0]).toEqual({
      code: 'B1',
      name: '活动奖励',
      current: 5.25,
      limit: 25.5,
      expiresAt: '2026-08-31T00:00:00.000Z'
    })
    expect(parsed.totalLimit).toBe(125.5)
    expect(parsed.totalCurrent).toBe(15.25)
  })

  it('资源详情透传计费展示字段供 UI 显示单位与超额费率', () => {
    const parsed = parseCreditUsage(rawUsage())
    expect(parsed.resourceDetail).toMatchObject({
      resourceType: 'CREDIT',
      displayName: 'Credits',
      displayNamePlural: 'Credits',
      currency: 'USD',
      unit: 'credit',
      overageRate: 0.04,
      overageCap: 50
    })
  })

  it('超额开关由 overageStatus 或 overageEnabled 任一为真决定', () => {
    expect(
      parseCreditUsage(rawUsage({ overageConfiguration: { overageStatus: 'ENABLED' } }))
        .resourceDetail?.overageEnabled
    ).toBe(true)
    expect(
      parseCreditUsage(rawUsage({ overageConfiguration: { overageEnabled: true } }))
        .resourceDetail?.overageEnabled
    ).toBe(true)
    expect(
      parseCreditUsage(rawUsage({ overageConfiguration: { overageStatus: 'DISABLED' } }))
        .resourceDetail?.overageEnabled
    ).toBe(false)
  })

  it('额度重置日期原样带出供 UI 展示', () => {
    expect(parseCreditUsage(rawUsage()).nextResetDate).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('订阅类型识别(classifySubscriptionType)', () => {
  // 分歧 1(本轮唯一有意的行为修正):v1.4.5 commit d9c3784「修复 PRO+/POWER 订阅类型未
  // 正确识别的问题」补了 4 处解析点,唯独漏了 check-account-status(A)。
  // A 是用户日常"刷新额度"路径 ⇒ PRO+ 账号在这条路径上一直被降级显示为 Pro。
  it.each([
    ['KIRO PRO+', 'Pro_Plus'],
    ['KIRO PRO_PLUS', 'Pro_Plus'],
    ['KIRO PROPLUS', 'Pro_Plus'],
    ['KIRO POWER', 'Enterprise'],
    ['KIRO PRO', 'Pro'],
    ['KIRO ENTERPRISE', 'Enterprise'],
    ['KIRO TEAMS', 'Teams'],
    ['Free Tier', 'Free']
  ])('标题 %s 识别为 %s', (title, expected) => {
    expect(classifySubscriptionType(title)).toBe(expected)
  })

  it('PRO+ 必须先于 PRO 判定,否则 PRO+ 会被误降级为 Pro', () => {
    expect(classifySubscriptionType('PRO+')).toBe('Pro_Plus')
    expect(classifySubscriptionType('PRO+')).not.toBe('Pro')
  })

  it('大小写不影响识别', () => {
    expect(classifySubscriptionType('kiro pro+')).toBe('Pro_Plus')
    expect(classifySubscriptionType('kiro power')).toBe('Enterprise')
  })

  // 分歧 3:A 的兜底是 account.subscription?.type(保留账号已知类型),B/C 兜底恒为 'Free'。
  // 对 A 是承重的:标题无可识别关键词时不能把已知 Pro 账号降级成 Free。
  it('标题无可识别关键词时保留调用方已知的订阅类型,不降级', () => {
    expect(classifySubscriptionType('Some Unknown Plan', 'Pro')).toBe('Pro')
    expect(classifySubscriptionType('Some Unknown Plan')).toBe('Free')
  })

  it('标题可识别时以标题为准,不受调用方兜底影响', () => {
    expect(classifySubscriptionType('KIRO POWER', 'Pro')).toBe('Enterprise')
  })
})

describe('订阅信息解析(parseSubscription)', () => {
  it('根据重置日期算出到期时间与剩余天数', () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z')
    const parsed = parseSubscription(
      rawUsage({ nextDateReset: '2026-08-13T00:00:00.000Z' }),
      { now }
    )
    expect(parsed.expiresAt).toBe(Date.parse('2026-08-13T00:00:00.000Z'))
    expect(parsed.daysRemaining).toBe(10)
  })

  it('重置日期已过时剩余天数为 0 而不是负数', () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z')
    const parsed = parseSubscription(
      rawUsage({ nextDateReset: '2026-07-01T00:00:00.000Z' }),
      { now }
    )
    expect(parsed.daysRemaining).toBe(0)
  })

  it('没有重置日期时不产出到期时间与剩余天数', () => {
    const parsed = parseSubscription(rawUsage({ nextDateReset: undefined }))
    expect(parsed.expiresAt).toBeUndefined()
    expect(parsed.daysRemaining).toBeUndefined()
  })

  it('透传订阅能力字段供 UI 决定是否显示升级与超额入口', () => {
    const parsed = parseSubscription(
      rawUsage({
        subscriptionInfo: {
          subscriptionTitle: 'KIRO PRO',
          type: 'PAID',
          upgradeCapability: 'UPGRADABLE',
          overageCapability: 'CONFIGURABLE',
          subscriptionManagementTarget: 'AWS'
        }
      })
    )
    expect(parsed.rawType).toBe('PAID')
    expect(parsed.upgradeCapability).toBe('UPGRADABLE')
    expect(parsed.overageCapability).toBe('CONFIGURABLE')
    expect(parsed.managementTarget).toBe('AWS')
  })

  it('缺少订阅信息的账号按 Free 处理', () => {
    const parsed = parseSubscription(rawUsage({ subscriptionInfo: undefined }))
    expect(parsed.title).toBe('Free')
    expect(parsed.type).toBe('Free')
  })

  // 分歧 4:A/B 用 `?? 'Free'`(空串原样保留),C 用 `|| 'Free'`(空串兜成 'Free')。
  // 只影响 title 展示字符串,type 两者都算成 Free。显式表达而非二选一。
  it('空标题默认原样保留,调用方可选择兜底为 Free', () => {
    const raw = rawUsage({ subscriptionInfo: { subscriptionTitle: '' } })
    expect(parseSubscription(raw).title).toBe('')
    expect(parseSubscription(raw, { emptyTitleAsDefault: true }).title).toBe('Free')
    expect(parseSubscription(raw).type).toBe('Free')
  })
})
