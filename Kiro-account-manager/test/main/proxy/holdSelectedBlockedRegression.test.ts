// 回归:被封/超额账号「暂时不在池」不得被判成「用户配错了 id」
//
// 现场(2026-08-12 用户报「挂起功能倒退,之前能挂 2 小时,现在 20 分钟就 503」):
//   API Error: 503 Hold timeout: no account became available in time (HOLD_TIMEOUT)
//   · Retrying in 8s · attempt 5/10   ← 不是超时,是每次立刻 giveup 后客户端重试 10 次
//
// 根因是我 7c63d4c 引入的回归。那次修的是「UI 选中一个已删除的残留 id」,判据写成
// `selectedAccountInPool = !!pool.getAccount(id)`,并且**优先于** poolHasBlockedAccount。
// 但账号被上游封禁 / 额度耗尽时,它也可能不在池里(实测日志:
//   `lazy-refill: N 个账号未入反代池 —— xxx@outlook.com: 已被上游拒绝([TEMPORARILY_SUSPENDED])`)
// 于是「账号被封」被误判成「配置错误」→ giveup,而这恰恰是门闸最该挂起的场景。
//
// 两种成因的正确处置相反,必须分开:
//   账号存在但当前不可用(封禁/超额/冷却) → 挂起等恢复
//   id 在账号总表里根本不存在(残留旧 id)   → 立即报错
import { describe, it, expect } from 'vitest'
import { classifyNoAccountHold } from '@main/proxy/holdDecision'

const SELECTED = '30475c44-5cdd-4e71-9c31-ab63b5fc08d8'

describe('被封账号 vs 不存在的 id · 挂起决策不得混淆', () => {
  it('选中账号因封禁/超额而不可用 → 必须挂起(不是配置错误)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 1,
      selectedAccountIds: [SELECTED],
      // 关键区分:id 在账号总表里**存在**,只是当前不可用
      selectedAccountExists: true,
      selectedAccountInPool: false,
      poolHasBlockedAccount: true,
      lastPreBodyError: null
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toBe('account-blocked')
  })

  it('选中账号不可用、池里也没有别的号被标记 → 仍挂起(等它自己恢复)', () => {
    // lazy-refill 场景:被封号根本没进池,所以池内「没有被标记的号」——
    // 但选中的那个号确实存在且确实不可用,挂起等恢复才是对的。
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 0,
      selectedAccountIds: [SELECTED],
      selectedAccountExists: true,
      selectedAccountInPool: false,
      poolHasBlockedAccount: false,
      lastPreBodyError: null
    })
    expect(d.action).toBe('hold')
  })

  it('id 在账号总表里不存在(残留旧 id)→ 立即报错(7c63d4c 的原始场景,不得回归)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 2,
      selectedAccountIds: [SELECTED],
      selectedAccountExists: false,   // 总表里也没有 → 真的是配置问题
      selectedAccountInPool: false,
      poolHasBlockedAccount: false,
      lastPreBodyError: null
    })
    expect(d.action).toBe('giveup')
    expect(d.reason).toBe('selected-account-missing')
    expect(d.clientMessage).toContain('30475c44')
  })

  it('id 不存在时,即使池里有号被封也要报错(配置问题优先于账号问题)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: true,
      poolSize: 1,
      selectedAccountIds: [SELECTED],
      selectedAccountExists: false,
      selectedAccountInPool: false,
      poolHasBlockedAccount: true,
      lastPreBodyError: null
    })
    expect(d.action).toBe('giveup')
    expect(d.reason).toBe('selected-account-missing')
  })

  it('未指定账号 → 走原有池状态判据', () => {
    const blocked = classifyNoAccountHold({
      holdEnabled: true, poolSize: 2, selectedAccountIds: [],
      selectedAccountExists: true, selectedAccountInPool: true,
      poolHasBlockedAccount: true, lastPreBodyError: null
    })
    expect(blocked.action).toBe('hold')
    expect(blocked.reason).toBe('account-blocked')

    const empty = classifyNoAccountHold({
      holdEnabled: true, poolSize: 0, selectedAccountIds: [],
      selectedAccountExists: true, selectedAccountInPool: true,
      poolHasBlockedAccount: false, lastPreBodyError: null
    })
    expect(empty.action).toBe('hold')
    expect(empty.reason).toBe('pool-empty')
  })

  it('门闸关闭仍然一律不挂(不得因本次修复被绕过)', () => {
    const d = classifyNoAccountHold({
      holdEnabled: false, poolSize: 1, selectedAccountIds: [SELECTED],
      selectedAccountExists: true, selectedAccountInPool: false,
      poolHasBlockedAccount: true, lastPreBodyError: null
    })
    expect(d.action).toBe('giveup')
    expect(d.reason).toBe('hold-disabled')
  })
})
