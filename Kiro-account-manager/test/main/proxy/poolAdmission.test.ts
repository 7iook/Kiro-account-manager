/**
 * 反代池准入判据 —— 红灯先行
 *
 * 已实证的失效模式：一次断网时的后台批量测活会把**完好账号**写成
 * `status:'error'`（`persistCheckResult.ts:325` 的 `!item.success` 分支不区分
 * 「被封禁」和「网当时没通」），而池的水合闸门判的正是 `status !== 'active'`。
 * 于是一次网络抖动足以把全部账号永久踢出反代池，且没有任何路径会自动把
 * `status` 写回 `'active'` —— 只有用户逐个手点才能恢复。
 *
 * 所以准入判据必须判「这个号能不能用」（有凭据 + 未被后端封禁），
 * 而不是判「上一次测活恰好成功了没有」。
 */
import { describe, it, expect } from 'vitest'
import { buildProxyAccountsFromStore } from '../../../src/main/proxy/activation'

/** 一条盘上记录：有效凭据 + 可指定 status / lastError */
function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, email: `${id}@x.com`, credentials: { accessToken: `tok-${id}` }, ...extra }
}

describe('池准入：网络抖动写下的 status:error 不得把好号钉在池外', () => {
  it('status:error + 网络形状的 lastError + 凭据有效 → 仍然入池', () => {
    const records = {
      timeout: rec('timeout', { status: 'error', lastError: 'fetch failed' }),
      dns: rec('dns', { status: 'error', lastError: 'getaddrinfo ENOTFOUND q.us-east-1.amazonaws.com' }),
      refused: rec('refused', { status: 'error', lastError: 'connect ECONNREFUSED 127.0.0.1:443' }),
      slow: rec('slow', { status: 'error', lastError: '超时 (45000ms)' })
    }
    const out = buildProxyAccountsFromStore(records).map((a) => a.id).sort()
    expect(out).toEqual(['dns', 'refused', 'slow', 'timeout'])
  })

  it('status:expired（token 过期）有 refreshToken → 入池，由池内刷新自愈', () => {
    const records = {
      exp: {
        id: 'exp',
        status: 'expired',
        lastError: 'Token 已过期，请刷新',
        credentials: { accessToken: 'tok-exp', refreshToken: 'rt-exp', expiresAt: Date.now() - 1000 }
      }
    }
    expect(buildProxyAccountsFromStore(records).map((a) => a.id)).toEqual(['exp'])
  })

  it('status:unknown（批量导入尚未测活）→ 入池，不必先跑一次测活才能用', () => {
    expect(
      buildProxyAccountsFromStore({ fresh: rec('fresh', { status: 'unknown' }) }).map((a) => a.id)
    ).toEqual(['fresh'])
  })
})

describe('池准入：真被后端封禁的号仍然排除（保住原过滤器守住的那个性质）', () => {
  it.each([
    ['AccountSuspendedException', 'AccountSuspendedException: account is suspended'],
    ['423 Locked', 'HTTP 423 account locked'],
    ['TEMPORARILY_SUSPENDED', '{"reason":"TEMPORARILY_SUSPENDED"}'],
    ['temporarily suspended', 'User ID is temporarily suspended'],
    ['中文封禁', '账户已封禁'],
    ['用户状态异常', '用户状态异常: Suspended']
  ])('封禁信号 %s → 排除在池外', (_label, lastError) => {
    const records = {
      banned: rec('banned', { status: 'error', lastError }),
      ok: rec('ok', { status: 'active' })
    }
    expect(buildProxyAccountsFromStore(records).map((a) => a.id)).toEqual(['ok'])
  })

  it('无 accessToken → 仍然排除（半个账号进池只会在首次请求时远端失败）', () => {
    const records = { noTok: { id: 'noTok', status: 'active', credentials: {} } }
    expect(buildProxyAccountsFromStore(records)).toEqual([])
  })
})
