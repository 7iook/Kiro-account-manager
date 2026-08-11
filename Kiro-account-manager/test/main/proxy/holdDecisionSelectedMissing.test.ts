// 回归测试:UI 指定账号不在池 = 配置错误,不是账号问题 —— 必须立即报错,不许死等
//
// 现场(2026-08-11 生产日志,用户报「账号明明正常却被闸门挂起」):
//   137 次 `Selected account 30475c44-... not found in pool (pool size=1/2)`
//   → 一次上游请求都没发出(preBodyError = null)
//   → decideHoldAction 命中 `if (!lastPreBodyError) return 'hold'`
//   → HoldGate 挂起,界面显示「账号封禁或额度上限」
//
// 三处缺陷,本文件逐条锁住:
//   ① 语义混淆:`无 attempt` 被当成「账号问题」。但「UI 指定号不在池」是**配置错误** ——
//      没有任何机制会把一个不存在的 id 变进池里,挂起等于**永久死等**。
//      决定性证据:19:56:45 池已热更新到 size=2,同一秒仍报 not found in pool(size=2)
//      ⇒ 不是同步延迟,那个 id 从来不在池里。
//   ② 原因失真:holdReason 只有三档,该场景落到 `pool-empty`,界面文案说「账号封禁或额度上限」,
//      把用户排查方向引向账号状态,而真问题在配置。
//   ③ 开关失效:该挂起路径不检查 holdWhenNoAccount，用户关掉门闸后依然被挂起。
import { describe, it, expect } from 'vitest'
import { classifyNoAccountHold } from '@main/proxy/holdDecision'

describe('无号可用时的挂起决策 · 区分配置错误与账号问题', () => {
  it('UI 指定号不在池但池里有别的号 → 配置错误,立即报错(挂起是永久死等)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 2,
      selectedAccountIds: ['30475c44-5cdd-4e71-9c31-ab63b5fc08d8'],
      selectedAccountInPool: false,
      poolHasBlockedAccount: false,
      lastPreBodyError: null
    })
    expect(d.action).toBe('giveup')
    expect(d.reason).toBe('selected-account-missing')
    // 报给客户端的消息必须点名真实原因 + 可执行的下一步,不能是「账号封禁或额度上限」
    expect(d.clientMessage).toMatch(/不在|not in|同步|sync/i)
    expect(d.clientMessage).toContain('30475c44')
  })

  it('池真的空了 → 挂起等换号(这才是门闸的设计意图)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 0,
      selectedAccountIds: [],
      selectedAccountInPool: false,
      poolHasBlockedAccount: false,
      lastPreBodyError: null
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toBe('pool-empty')
  })

  it('池内有号被封禁/额度耗尽 → 挂起(等其恢复或换号)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 2,
      selectedAccountIds: [],
      selectedAccountInPool: false,
      poolHasBlockedAccount: true,
      lastPreBodyError: null
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toBe('account-blocked')
  })

  it('门闸开关关闭 → 任何情况都不挂起(用户关了就是关了)', () => {
    for (const scenario of [
      { poolSize: 0, selectedAccountInPool: false, poolHasBlockedAccount: false, selectedAccountIds: [] as string[] },
      { poolSize: 2, selectedAccountInPool: false, poolHasBlockedAccount: true, selectedAccountIds: [] as string[] },
      { poolSize: 2, selectedAccountInPool: false, poolHasBlockedAccount: false, selectedAccountIds: ['x-missing'] }
    ]) {
      const d = classifyNoAccountHold({ holdEnabled: false, lastPreBodyError: null, ...scenario })
      expect(d.action, `holdEnabled=false 场景 ${JSON.stringify(scenario)}`).toBe('giveup')
    }
  })

  it('账号级授权失效 → 挂起等换号(既有契约,不得回归)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 1,
      selectedAccountIds: [],
      selectedAccountInPool: false,
      poolHasBlockedAccount: false,
      lastPreBodyError: new Error('InvalidTokenException: token revoked')
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toBe('account-auth-failure')
  })

  it('非账号级瞬时错误(429/5xx)→ 立即报错,绝不挂起(RCA 2026-08-02/03 契约)', () => {
    for (const msg of [
      'Rate limited on AmazonQ-EU after 10 retries',
      'API error 503: unavailable',
      'API error 400: Improperly formed request'
    ]) {
      const d = classifyNoAccountHold({
        holdEnabled: true,
        poolSize: 1,
        selectedAccountIds: [],
        selectedAccountInPool: false,
        poolHasBlockedAccount: false,
        lastPreBodyError: new Error(msg)
      })
      expect(d.action, msg).toBe('giveup')
    }
  })

  it('优先级:指定号缺失的判定不被 poolHasBlockedAccount 掩盖', () => {
    // 现场就是这个组合:池里那个号被上游封了(blocked=true),而 UI 选的是另一个不存在的 id。
    // 若先命中 account-blocked 就会继续挂起 → 用户永远等不到,且原因仍然说错。
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 1,
      selectedAccountIds: ['30475c44-5cdd-4e71-9c31-ab63b5fc08d8'],
      selectedAccountInPool: false,
      poolHasBlockedAccount: true,
      lastPreBodyError: null
    })
    expect(d.action).toBe('giveup')
    expect(d.reason).toBe('selected-account-missing')
  })
})
