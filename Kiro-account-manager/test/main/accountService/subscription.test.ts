/**
 * normalizeSubscriptionType · 订阅标题 → 规范化订阅类型 的 SSOT
 *
 * 为什么单独测：这段 if-else 链在 index.ts 里有 4 份逐字复制（:3848 / :4536 / :4861 / :5236）,
 * 且**检查顺序本身就是业务约定**（PRO+ 必须先于 PRO，否则 "KIRO PRO+" 会被判成 Pro）。
 * 顺序一旦被"顺手整理"就会静默改变用户看到的订阅徽章 → 用表驱动把顺序钉死。
 */
import { describe, it, expect } from 'vitest'
import { normalizeSubscriptionType } from '../../../src/main/accountService/subscription'

describe('normalizeSubscriptionType · 订阅徽章分类', () => {
  it('Pro+ 用户不能被降级显示成 Pro（PRO+ 判定必须先于 PRO）', () => {
    expect(normalizeSubscriptionType('KIRO PRO+')).toBe('Pro_Plus')
    expect(normalizeSubscriptionType('Q_DEVELOPER_STANDALONE_PRO_PLUS')).toBe('Pro_Plus')
    expect(normalizeSubscriptionType('kiro proplus')).toBe('Pro_Plus')
  })

  it('POWER 档用户显示为 Enterprise（历史约定：POWER 并入 Enterprise）', () => {
    expect(normalizeSubscriptionType('KIRO POWER')).toBe('Enterprise')
    expect(normalizeSubscriptionType('Q_DEVELOPER_STANDALONE_POWER')).toBe('Enterprise')
  })

  it('普通 Pro / Enterprise / Teams 各归各位', () => {
    expect(normalizeSubscriptionType('KIRO PRO')).toBe('Pro')
    expect(normalizeSubscriptionType('KIRO ENTERPRISE')).toBe('Enterprise')
    expect(normalizeSubscriptionType('KIRO TEAMS')).toBe('Teams')
  })

  it('无法识别的标题（含两个调用点各自的默认值 KIRO / Free）落到 Free', () => {
    expect(normalizeSubscriptionType('KIRO')).toBe('Free')
    expect(normalizeSubscriptionType('Free')).toBe('Free')
    expect(normalizeSubscriptionType('')).toBe('Free')
  })
})
