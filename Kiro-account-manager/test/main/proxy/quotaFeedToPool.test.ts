// TDD:真实额度进池 —— updateQuota 的准入、时序仲裁,与既有判据的交互
//
// 决策卡: .agent-workspace/.archive/2026-08-09/quota-feed-to-pool/decision-card.md
// 侦察:   .agent-workspace/.archive/2026-08-09/headless-server-migration/recon-quota-feed-break.md
//
// 病灶(三重取证确认):`updateQuota` 自 v1.6.0 诞生起**零生产调用方**,于是
// quotaUsed/quotaLimit 永不被写,isQuotaExhausted 的第三条判据(:418)在生产中恒为 false ——
// 池只能靠一个 402 失败请求才知道账号没额度了,即「每次换号先赔一个失败请求」。
//
// 因为从未接线,函数体已与周围模型漂移:无准入(占位值 {0,0} 会被当额度写入)、
// 无时序仲裁(checkAccountStatus 并发,迟到的旧响应可覆盖新响应)。接线前必须先改写。
//
// ⛔ 本轮**不动** isQuotaExhausted 的判据本身,也**不引入**「剩余 ≤ 阈值」谓词 ——
// 那会污染 hasBlockedAccount(挂起门闸的可用性 SSOT),正是 RCA 2026-08-02 / 2026-08-04
// 两次误伤的病灶形态(quotaFalsePositive429.test.ts 守着它)。本轮只补数据源。
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool, ErrorType } from '@main/proxy/accountPool'
import type { ProxyAccount } from '@main/proxy/types'

function mk(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@example.com`,
    accessToken: 't-' + id,
    refreshToken: 'r-' + id,
    isAvailable: true,
    ...extra
  }
}

describe('AccountPool.updateQuota · 准入(坏数据一律不写)', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('占位额度 {used:0, limit:0} 必须被拒收,不写入任何 quota 字段', () => {
    // importApiKey 导入 ksk_ 后额度是占位的 {current:0, limit:0}
    //(webPanel/routes.ts:297 注释:「导入后由调用方触发 check」)——
    // 那不是「额度为零」,是「还没查过」。写进去等于凭空造一个额度事实。
    pool.addAccount(mk('P'))
    pool.updateQuota('P', 0, 0)

    const acc = pool.getAccount('P')!
    expect(acc.quotaUsed).toBeUndefined()
    expect(acc.quotaLimit).toBeUndefined()
  })

  it('从未刷新过用量的账号(limit=0)绝不能被判为额度耗尽', () => {
    // 承重反向用例:若把 limit=0 当「上限 0 ⇒ 已用满」,一池未刷新的新账号会整池
    // 看起来全部耗尽 → availableCount 归零 → 挂起门闸冻结所有请求。
    pool.addAccount(mk('Fresh'))
    pool.updateQuota('Fresh', 0, 0)

    const acc = pool.getAccount('Fresh')!
    expect(pool.isQuotaExhausted(acc)).toBe(false)
    expect(pool.hasBlockedAccount()).toBe(false)
    expect(pool.availableCount).toBe(1)
  })

  it('limit 为 NaN / 负数时拒收,账号原状态不变', () => {
    pool.addAccount(mk('N', { quotaUsed: 10, quotaLimit: 100 }))

    pool.updateQuota('N', 50, Number.NaN)
    pool.updateQuota('N', 50, -5)

    const acc = pool.getAccount('N')!
    // 原有的可信数据不得被坏数据覆盖
    expect(acc.quotaUsed).toBe(10)
    expect(acc.quotaLimit).toBe(100)
  })

  it('used 为 NaN / 负数时拒收(NaN 会让 used>=limit 恒 false,静默失效)', () => {
    pool.addAccount(mk('N2', { quotaUsed: 10, quotaLimit: 100 }))

    pool.updateQuota('N2', Number.NaN, 100)
    pool.updateQuota('N2', -1, 100)

    const acc = pool.getAccount('N2')!
    expect(acc.quotaUsed).toBe(10)
    expect(acc.quotaLimit).toBe(100)
  })

  it('合法数据必须被写入(证明准入不是「一律不写」)', () => {
    pool.addAccount(mk('OK'))
    pool.updateQuota('OK', 42, 100)

    const acc = pool.getAccount('OK')!
    expect(acc.quotaUsed).toBe(42)
    expect(acc.quotaLimit).toBe(100)
  })

  it('账号已被移出池后迟到的喂入不得抛错,也不得重建账号', () => {
    pool.addAccount(mk('Gone'))
    pool.removeAccount('Gone')

    expect(() => pool.updateQuota('Gone', 10, 100)).not.toThrow()
    expect(pool.getAccount('Gone')).toBeNull()
  })
})

describe('AccountPool.updateQuota · 时序仲裁(并发刷新不保序)', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('迟到的旧响应(observedAt 更早)不得覆盖更新的数据', () => {
    // checkAccountStatus 是并发的,singleFlight 只按 id 去重、跨轮次不保序。
    // 没有仲裁时,一个慢响应回来就能把新数字按回旧值。
    pool.addAccount(mk('T'))
    const t1 = 1_000_000
    pool.updateQuota('T', 90, 100, undefined, t1)
    // 更早发出、更晚到达的响应
    pool.updateQuota('T', 10, 100, undefined, t1 - 5000)

    expect(pool.getAccount('T')!.quotaUsed).toBe(90)
  })

  it('更新的响应必须覆盖旧数据', () => {
    pool.addAccount(mk('T2'))
    const t1 = 1_000_000
    pool.updateQuota('T2', 10, 100, undefined, t1)
    pool.updateQuota('T2', 95, 100, undefined, t1 + 5000)

    expect(pool.getAccount('T2')!.quotaUsed).toBe(95)
  })

  it('observedAt 相等时允许写入(同毫秒不该被当成迟到)', () => {
    pool.addAccount(mk('T3'))
    const t = 1_000_000
    pool.updateQuota('T3', 10, 100, undefined, t)
    pool.updateQuota('T3', 20, 100, undefined, t)

    expect(pool.getAccount('T3')!.quotaUsed).toBe(20)
  })

  it('记录数据观测时刻(供日志自证「这个判定基于何时的数据」)', () => {
    pool.addAccount(mk('T4'))
    const t = 1_700_000_000_000
    pool.updateQuota('T4', 10, 100, undefined, t)

    expect(pool.getAccount('T4')!.quotaUpdatedAt).toBe(t)
  })
})

describe('AccountPool · 真实额度进池后与既有判据的交互', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('真实额度用尽 → 该号不再计入 availableCount(本轮的收益)', () => {
    pool.addAccount(mk('A'))
    pool.addAccount(mk('B'))
    expect(pool.availableCount).toBe(2)

    pool.updateQuota('A', 100, 100)

    expect(pool.isQuotaExhausted(pool.getAccount('A')!)).toBe(true)
    expect(pool.availableCount).toBe(1)
    // 取号必须绕开它
    const picked = pool.getNextAccount()
    expect(picked?.id).toBe('B')
  })

  it('一个号耗尽但池里还有别的可用号 → 请求绝不该被挂起', () => {
    // 最关键的反向用例:确认本轮不重演 RCA 2026-08-04「账号明明正常却被拦住」。
    // hasBlockedAccount 为 true 是对的(确有号耗尽),但只要 availableCount > 0,
    // 挂起门闸的 tryResume 就会立刻放行 —— 请求不被冻结。
    pool.addAccount(mk('X'))
    pool.addAccount(mk('Y'))

    pool.updateQuota('X', 100, 100)

    expect(pool.hasBlockedAccount()).toBe(true)
    expect(pool.availableCount).toBeGreaterThan(0)
  })

  it('喂入 used<limit 时清除 402 打的耗尽标记(上游权威额度优先于本地推断)', () => {
    pool.addAccount(mk('R'))
    pool.recordError('R', ErrorType.RECOVERABLE, 402)
    expect(pool.isQuotaExhausted(pool.getAccount('R')!)).toBe(true)

    pool.updateQuota('R', 10, 100)

    expect(pool.getAccount('R')!.quotaExhaustedAt).toBeUndefined()
  })

  it('喂入额度不得影响 429 造成的退避计数(跨 RCA 回归)', () => {
    pool.addAccount(mk('Q'))
    pool.recordError('Q', ErrorType.RECOVERABLE, 429)
    const before = pool.getAccount('Q')!.errorCount

    pool.updateQuota('Q', 10, 100)

    expect(pool.getAccount('Q')!.errorCount).toBe(before)
    // 429 仍不得升级成额度耗尽
    expect(pool.isQuotaExhausted(pool.getAccount('Q')!)).toBe(false)
  })

  it('挂起日志对喂入的真实数据输出 quotaUsed=X/Y,而非 markedAt=…', () => {
    // describeBlockedAccounts 的 byRealData 分支此前是死代码(没有写者),
    // 接线后第一次会真出现 —— 用户报障时后端能自证「这是真实额度说的」。
    pool.addAccount(mk('Real'))
    pool.updateQuota('Real', 100, 100)

    const out = pool.describeBlockedAccounts()
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('quotaUsed=100/100')
    expect(out[0]).not.toContain('markedAt=')
  })
})

describe('AccountPool · 整池耗尽是设计预期,不得抖动', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
  })

  it('池内唯一账号真实额度耗尽 → availableCount 归零(挂起门闸据此冻结,是有意的)', () => {
    // 诚实锁定这个用户可见后果:真的没号可用时挂起等换号/等额度恢复,
    // 正是 hasBlockedAccount 注释与 ADR-0001 确立的语义,不是缺陷。
    pool.addAccount(mk('Only'))
    pool.updateQuota('Only', 100, 100)

    expect(pool.availableCount).toBe(0)
    expect(pool.hasBlockedAccount()).toBe(true)
  })

  it('整池耗尽时可用数稳定为 0,不随重复读数抖动(概率重试不得渗入统计口径)', () => {
    pool.addAccount(mk('E1'))
    pool.addAccount(mk('E2'))
    pool.updateQuota('E1', 100, 100)
    pool.updateQuota('E2', 100, 100)

    const readings = new Set<number>()
    for (let i = 0; i < 50; i++) readings.add(pool.availableCount)
    expect([...readings]).toEqual([0])
  })

  it('额度恢复时刻到点后整池自愈,且触发可用性通知唤醒挂起请求', () => {
    // 反向锁定「不得永久钉死」:喂入 used>=limit 后,若上游给了 resetAt,
    // 到点必须能自愈,否则挂起门闸会一直认为池是空的。
    let notified = 0
    pool.setAvailabilityListener(() => {
      notified++
    })
    pool.addAccount(mk('Z'))
    const resetAt = Date.now() + 3_600_000
    pool.updateQuota('Z', 100, 100, resetAt)
    expect(pool.availableCount).toBe(0)

    const acc = pool.getAccount('Z')!
    expect(pool.isQuotaExhausted(acc, resetAt - 1)).toBe(true)
    expect(pool.isQuotaExhausted(acc, resetAt + 1)).toBe(false)

    // 到点后一次合法喂入(下一轮刷新)必须能把池叫醒
    pool.updateQuota('Z', 0, 100, undefined, Date.now() + 1)
    expect(pool.availableCount).toBe(1)
    expect(notified).toBeGreaterThan(0)
  })
})
