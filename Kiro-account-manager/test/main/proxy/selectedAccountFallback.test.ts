// 「界面选中账号」= 偏好而非硬约束(RCA 2026-08-12)
//
// 生产现场(10290 行日志):
//   185x  Selected account d0520f20-… not found in pool (pool size=1)
//    92x  decision=giveup · reason=selected-account-missing   → 客户端 503
//     1x  一轮挂起结束 · 持续 77.6 分钟 · 原因=account-blocked  ← 挂起本身完好
// pool size=1 说明池里有健康号可用,却因为选中项指向一个已不存在的 id 而整体拒绝服务。
//
// 我此前两次修错的根源:把「选中号不在池」塞进**挂起判据**,于是它压过了
// 「有号被封 → 挂起」这条正确分支。正确的分层是:
//   本模块只答「能不能拿到号」;拿不到时的挂起/报错由 holdDecision 决定。
import { describe, it, expect } from 'vitest'
import { resolveSelectedPreference } from '@main/proxy/selectedAccountFallback'

type Acc = { id: string; usable: boolean }

function harness(accounts: Acc[], selectedId?: string) {
  const byId = new Map(accounts.map(a => [a.id, a]))
  return resolveSelectedPreference<Acc>({
    selectedId,
    getById: (id) => byId.get(id) ?? null,
    isUsable: (a) => a.usable,
    pickAnyUsable: () => accounts.find(a => a.usable) ?? null
  })
}

describe('选中账号 = 偏好,服务优先', () => {
  it('选中号可用 → 用它(尊重偏好)', () => {
    const r = harness([{ id: 'A', usable: true }, { id: 'B', usable: true }], 'A')
    expect(r.kind).toBe('selected')
    expect(r.kind === 'selected' && r.account.id).toBe('A')
  })

  it('选中 id 不存在但池里有可用号 → 回退并服务(生产现场:pool size=1 却 503)', () => {
    const r = harness([{ id: 'B', usable: true }], 'd0520f20-gone')
    expect(r.kind).toBe('fallback')
    expect(r.kind === 'fallback' && r.account.id).toBe('B')
    expect(r.kind === 'fallback' && r.why).toBe('missing')
  })

  it('选中号存在但被封/超额,池里有别的可用号 → 回退并服务', () => {
    const r = harness([{ id: 'A', usable: false }, { id: 'B', usable: true }], 'A')
    expect(r.kind).toBe('fallback')
    expect(r.kind === 'fallback' && r.account.id).toBe('B')
    expect(r.kind === 'fallback' && r.why).toBe('unusable')
  })

  it('池里一个可用号都没有 → none,交回调用方决定挂起(不在这里做决策)', () => {
    const r = harness([{ id: 'A', usable: false }], 'A')
    expect(r.kind).toBe('none')
    expect(r.kind === 'none' && r.why).toBe('unusable')
  })

  it('选中 id 不存在且池里也没有可用号 → none(why=missing)', () => {
    const r = harness([{ id: 'B', usable: false }], 'gone')
    expect(r.kind).toBe('none')
    expect(r.kind === 'none' && r.why).toBe('missing')
  })

  it('未指定选中号 → 取任意可用号', () => {
    const r = harness([{ id: 'A', usable: false }, { id: 'B', usable: true }], undefined)
    expect(r.kind).toBe('selected')
    expect(r.kind === 'selected' && r.account.id).toBe('B')
  })

  it('未指定且池空 → none(why=no-preference)', () => {
    const r = harness([], undefined)
    expect(r.kind).toBe('none')
    expect(r.kind === 'none' && r.why).toBe('no-preference')
  })

  it('回退绝不选一个不可用的号(服务优先不等于乱选)', () => {
    const r = harness([{ id: 'A', usable: false }, { id: 'C', usable: false }], 'A')
    expect(r.kind).toBe('none')
  })
})
