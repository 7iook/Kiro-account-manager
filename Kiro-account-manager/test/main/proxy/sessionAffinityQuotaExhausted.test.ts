// TDD:会话粘性必须校验额度耗尽(否则 402 换号后客户端仍粘在死号上最长 600s)
//
// 侦察: .agent-workspace/.archive/2026-08-09/headless-server-migration/recon-machineid-switch-sideeffect.md §P3-4
//
// 缺陷形态:
//   pickAccountWithAffinity(proxyServer.ts:4784)的可用性校验只认
//   `!isSuspended(account) && account.isAvailable !== false`,**漏了 isQuotaExhausted**。
//   于是账号 402 额度耗尽后:粘性条目存活 → 带固定 session id 的客户端每个请求先命中
//   旧号 → 发一发注定 402 的上游调用 → 进重试循环再换号,持续到 600s TTL 过期
//   (proxyServer.ts:4771-4772)。
//
// 为什么判定它是缺陷而非有意设计:
//   同一个 if 里 suspend 分支**自愈**(isSuspended 被校验,粘性自动清),额度分支不自愈 ——
//   两个分支对「长期不可用」的判定不一致。而池自己的 SSOT(hasBlockedAccount:436 /
//   isAccountAvailable:323)都是 suspended + quotaExhausted 二者并列。
//   反应式换号路径(:1670 等)绕过 activation.ts,不调 invalidateSessionAffinity,
//   所以没有任何下游机制能抵消这一格。
//
// 修法取舍:补齐这一处判据(而非在三处换号点各插一次 invalidateSessionAffinity)——
// 一个谓词、一个地方,且让 402 与 suspend 两分支判定一致。
import { describe, it, expect, beforeEach } from 'vitest'
import { ProxyServer } from '@main/proxy/proxyServer'
import { ErrorType } from '@main/proxy/accountPool'
import type { ProxyAccount } from '@main/proxy/types'

type AffinityMap = Map<string, { accountId: string; lastAt: number }>

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

describe('ProxyServer · 会话粘性的可用性判据', () => {
  let server: ProxyServer
  let affinity: AffinityMap
  let pick: (hint: string) => ProxyAccount | null

  beforeEach(() => {
    server = new ProxyServer({ sessionAffinityEnabled: true })
    affinity = (server as unknown as { sessionAffinity: AffinityMap }).sessionAffinity
    pick = (hint: string) =>
      (
        server as unknown as {
          pickAccountWithAffinity(h: string | undefined): ProxyAccount | null
        }
      ).pickAccountWithAffinity(hint)
  })

  it('额度耗尽的账号不得再被粘性命中(否则每请求烧一发注定 402 的上游调用)', () => {
    const pool = server.getAccountPool()
    pool.addAccount(mk('A'))
    affinity.set('sess-1', { accountId: 'A', lastAt: Date.now() })
    // 走真实的 402 路径 —— 生产中唯一点亮 quotaExhaustedAt 的入口
    pool.recordError('A', ErrorType.RECOVERABLE, 402)
    expect(pool.isQuotaExhausted(pool.getAccount('A')!)).toBe(true)

    expect(pick('sess-1')).toBeNull()
  })

  it('命中已耗尽账号后必须清掉该粘性条目(与 suspend 分支行为一致)', () => {
    const pool = server.getAccountPool()
    pool.addAccount(mk('B'))
    affinity.set('sess-2', { accountId: 'B', lastAt: Date.now() })
    pool.recordError('B', ErrorType.RECOVERABLE, 402)

    pick('sess-2')
    expect(affinity.has('sess-2')).toBe(false)
  })

  it('真实额度数据用尽(quotaUsed>=quotaLimit)同样不得被粘性命中', () => {
    // 第三条判据的入口:上游权威额度数据,不经 402 也能点亮
    const pool = server.getAccountPool()
    pool.addAccount(mk('C', { quotaUsed: 100, quotaLimit: 100 }))
    affinity.set('sess-3', { accountId: 'C', lastAt: Date.now() })

    expect(pick('sess-3')).toBeNull()
  })

  it('额度已过重置时刻的账号必须恢复粘性命中(不得因补判据把自愈号误杀)', () => {
    const pool = server.getAccountPool()
    // quotaResetAt 已过期 → isQuotaExhausted 第一条判据放行
    pool.addAccount(mk('D', { quotaExhaustedAt: Date.now() - 7_200_000, quotaResetAt: Date.now() - 1000 }))
    affinity.set('sess-4', { accountId: 'D', lastAt: Date.now() })

    expect(pick('sess-4')?.id).toBe('D')
  })

  it('健康账号仍必须被粘性命中并续期(既有行为,不得回退)', () => {
    const pool = server.getAccountPool()
    pool.addAccount(mk('E'))
    affinity.set('sess-5', { accountId: 'E', lastAt: Date.now() - 5000 })

    expect(pick('sess-5')?.id).toBe('E')
    expect(affinity.get('sess-5')!.lastAt).toBeGreaterThan(Date.now() - 1000)
  })

  it('被封禁账号不得被粘性命中(既有行为,回归保护)', () => {
    const pool = server.getAccountPool()
    pool.addAccount(mk('F', { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' }))
    affinity.set('sess-6', { accountId: 'F', lastAt: Date.now() })

    expect(pick('sess-6')).toBeNull()
    expect(affinity.has('sess-6')).toBe(false)
  })
})
