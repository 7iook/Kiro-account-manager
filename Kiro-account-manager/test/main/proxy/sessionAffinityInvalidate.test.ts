// TDD:显式换账号 ⇒ 旧会话粘性作废(否则开了 sessionAffinity 的用户仍需重启服务)
// RCA §1.5 假设 D:.archive/2026-07-28/proxy-hot-switch-single-account/
//
// pickAccountWithAffinity 在账号选择逻辑**之前**短路返回旧账号,只校验 suspended/isAvailable,
// 不校验配额耗尽、也不校验它是否仍是当前选定账号;条目 600s 才过期,只有实例重建(stop→start)
// 才整表丢弃 —— 这正是「必须重启才生效」的隐藏成因之一。
import { describe, it, expect, beforeEach } from 'vitest'
import { ProxyServer } from '@main/proxy/proxyServer'

type AffinityMap = Map<string, { accountId: string; lastAt: number }>

describe('ProxyServer · invalidateSessionAffinity', () => {
  let server: ProxyServer
  let affinity: AffinityMap

  beforeEach(() => {
    server = new ProxyServer({ sessionAffinityEnabled: true })
    affinity = (server as unknown as { sessionAffinity: AffinityMap }).sessionAffinity
    affinity.set('sess-1', { accountId: 'A', lastAt: Date.now() })
    affinity.set('sess-2', { accountId: 'A', lastAt: Date.now() })
    affinity.set('sess-3', { accountId: 'B', lastAt: Date.now() })
  })

  it('不传 accountId → 清全部,返回清理条数', () => {
    expect(server.invalidateSessionAffinity()).toBe(3)
    expect(affinity.size).toBe(0)
  })

  it('传 accountId → 只清指向该账号的条目', () => {
    expect(server.invalidateSessionAffinity('A')).toBe(2)
    expect(affinity.size).toBe(1)
    expect(affinity.get('sess-3')?.accountId).toBe('B')
  })

  it('无匹配条目 → 返回 0,不影响其它条目', () => {
    expect(server.invalidateSessionAffinity('NOPE')).toBe(0)
    expect(affinity.size).toBe(3)
  })
})
