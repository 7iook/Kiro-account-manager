/**
 * accountService/switch.ts · 切号 / 退出登录的可复用业务函数
 *
 * 为什么这些测试存在:这批逻辑原先内联在 ipcMain.handle 回调里,只有 IPC 通道能触达。
 * 抽出后 web 面板(决策卡 §3「每个端点一对一映射到现有 IPC handler 背后的 main 侧实现」)
 * 才可能复用同一份实现,而不是照着抄第二份。
 *
 * 每个 it 名 = 真实业务场景。重点锁 v1.7.3(commit 5a2d54f)修掉的四个真实故障,
 * 它们全都是「切号后 Kiro IDE 约一小时被强制登出」的成因,抽离时最容易被"顺手简化"掉:
 *   bug A · OIDC 轮换过的 refreshToken 必须落盘(旧值已被服务端作废)
 *   bug C · expiresAt 用真实 expiresIn,不硬编码 3600
 *   bug D · refresh 失败必须拒绝写盘(不给 IDE 留半坏 token)
 *   bug F · 回传 refreshedCredentials 让 renderer 同步反代 store
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  switchAccountToIde,
  logoutAccount,
  type SwitchAccountDeps,
  type LogoutAccountDeps
} from '../../../src/main/accountService/switch'

/** 记录 deps 侧被写入的模块级状态,断言"谁在什么时候写了什么" */
function makeSwitchDeps(
  refresh: SwitchAccountDeps['refreshTokenByMethod'],
  overrides: Partial<SwitchAccountDeps> = {}
): SwitchAccountDeps & {
  writes: { switchedId: (string | null)[]; signature: (string | null)[] }
  written: Array<Record<string, unknown>>
  scheduled: Array<{ accountId: string; expiresAtMs: number }>
} {
  const writes = { switchedId: [] as (string | null)[], signature: [] as (string | null)[] }
  const written: Array<Record<string, unknown>> = []
  const scheduled: Array<{ accountId: string; expiresAtMs: number }> = []
  return {
    writes,
    written,
    scheduled,
    refreshTokenByMethod: refresh,
    writeKiroAuthTokenFile: async (input) => {
      written.push({ ...input })
      return { tokenPath: '/home/u/.aws/sso/cache/kiro-auth-token.json' }
    },
    setLastSwitchedAccountId: (id) => writes.switchedId.push(id),
    setLastWrittenTokenSignature: (sig) => writes.signature.push(sig),
    resolveProfileArnForWrite: (input) => input.profileArn,
    isProactiveRenewalEnabled: () => false,
    scheduleProactiveRenewal: (accountId, expiresAtMs) =>
      scheduled.push({ accountId, expiresAtMs }),
    ...overrides
  }
}

const baseCredentials = {
  accessToken: 'access-v1',
  refreshToken: 'refresh-v1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  accountId: 'acc-1'
}

describe('switchAccountToIde · 切号写入 Kiro IDE 磁盘凭证', () => {
  it('OIDC 轮换了 refreshToken 时,落盘的必须是轮换后的新值(否则 IDE 约55分钟后用作废的旧值刷新→401→强制登出)', async () => {
    const deps = makeSwitchDeps(async () => ({
      success: true,
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresIn: 3600
    }))

    const result = await switchAccountToIde(deps, { ...baseCredentials })

    expect(result.success).toBe(true)
    expect(deps.written).toHaveLength(1)
    expect(deps.written[0].refreshToken).toBe('refresh-v2')
    expect(deps.written[0].accessToken).toBe('access-v2')
  })

  it('OIDC 没有返回新 refreshToken 时,沿用传入的旧值', async () => {
    const deps = makeSwitchDeps(async () => ({
      success: true,
      accessToken: 'access-v2',
      expiresIn: 3600
    }))

    await switchAccountToIde(deps, { ...baseCredentials })

    expect(deps.written[0].refreshToken).toBe('refresh-v1')
  })

  it('expiresAt 用 OIDC 返回的真实 expiresIn 计算,不写死一小时', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    try {
      const deps = makeSwitchDeps(async () => ({
        success: true,
        accessToken: 'access-v2',
        refreshToken: 'refresh-v2',
        expiresIn: 900
      }))

      await switchAccountToIde(deps, { ...baseCredentials })

      // 900s 而非默认 3600s
      expect(deps.written[0].expiresAtIso).toBe('2026-08-03T00:15:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('刷新失败时拒绝写盘并回报原因,不给 IDE 留下半坏的 token', async () => {
    const deps = makeSwitchDeps(async () => ({ success: false, error: 'invalid_grant' }))

    const result = await switchAccountToIde(deps, { ...baseCredentials })

    expect(result.success).toBe(false)
    expect(result.error).toContain('invalid_grant')
    // 关键:一个字节都不能落盘,模块级状态也不能动
    expect(deps.written).toHaveLength(0)
    expect(deps.writes.switchedId).toHaveLength(0)
    expect(deps.writes.signature).toHaveLength(0)
  })

  it('切号成功后回传刷新过的凭证,让 renderer 能同步反代 store', async () => {
    const deps = makeSwitchDeps(async () => ({
      success: true,
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresIn: 1200
    }))

    const result = await switchAccountToIde(deps, { ...baseCredentials })

    expect(result.refreshedCredentials).toEqual({
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresIn: 1200
    })
  })

  it('带 accountId 时记录"IDE 当前是哪个账号"与 token 签名,供 watcher 反向同步识别与防回环', async () => {
    const deps = makeSwitchDeps(async () => ({
      success: true,
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresIn: 3600
    }))

    await switchAccountToIde(deps, { ...baseCredentials, accountId: 'acc-42' })

    expect(deps.writes.switchedId).toEqual(['acc-42'])
    // 签名 = 刚写盘的那一对,watcher 见到同签名即判定"是自己写的",跳过反向同步
    expect(deps.writes.signature).toEqual(['access-v2|refresh-v2'])
  })

  it('不带 accountId 时不记录任何模块级状态(无从判断是哪个账号,记了会让 watcher 错配)', async () => {
    const deps = makeSwitchDeps(async () => ({
      success: true,
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresIn: 3600
    }))
    const { accountId: _drop, ...noId } = { ...baseCredentials }

    await switchAccountToIde(deps, noId)

    expect(deps.writes.switchedId).toHaveLength(0)
    expect(deps.writes.signature).toHaveLength(0)
  })

  it('主动续期开启时按刚写入的过期时间排下一次续期;关闭时不排', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    try {
      const on = makeSwitchDeps(
        async () => ({ success: true, accessToken: 'a2', refreshToken: 'r2', expiresIn: 600 }),
        { isProactiveRenewalEnabled: () => true }
      )
      await switchAccountToIde(on, { ...baseCredentials, accountId: 'acc-7' })
      expect(on.scheduled).toEqual([
        { accountId: 'acc-7', expiresAtMs: Date.parse('2026-08-03T00:10:00.000Z') }
      ])

      const off = makeSwitchDeps(async () => ({
        success: true,
        accessToken: 'a2',
        refreshToken: 'r2',
        expiresIn: 600
      }))
      await switchAccountToIde(off, { ...baseCredentials, accountId: 'acc-7' })
      expect(off.scheduled).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有 refreshToken 时跳过刷新直接写盘(纯 accessToken 导入的账号)', async () => {
    const refresh = vi.fn()
    const deps = makeSwitchDeps(refresh as unknown as SwitchAccountDeps['refreshTokenByMethod'])

    const result = await switchAccountToIde(deps, { ...baseCredentials, refreshToken: '' })

    expect(refresh).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(deps.written[0].accessToken).toBe('access-v1')
  })

  it('api_key 账号写盘时 authMethod 落成 IdC(Kiro IDE 不认识 api_key 这个值)', async () => {
    const deps = makeSwitchDeps(async () => ({
      success: true,
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresIn: 3600
    }))

    await switchAccountToIde(deps, { ...baseCredentials, authMethod: 'api_key' })

    expect(deps.written[0].authMethod).toBe('IdC')
  })

  it('写盘抛错时收敛为失败结果,不把异常抛给调用方', async () => {
    const deps = makeSwitchDeps(
      async () => ({ success: true, accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600 }),
      {
        writeKiroAuthTokenFile: async () => {
          throw new Error('EACCES: permission denied')
        }
      }
    )

    const result = await switchAccountToIde(deps, { ...baseCredentials })

    expect(result.success).toBe(false)
    expect(result.error).toBe('EACCES: permission denied')
  })
})

describe('logoutAccount · 退出登录清除本机 SSO 缓存', () => {
  let deps: LogoutAccountDeps & {
    order: string[]
    cleared: (string | null)[]
    signatures: (string | null)[]
  }

  beforeEach(() => {
    const order: string[] = []
    const cleared: (string | null)[] = []
    const signatures: (string | null)[] = []
    deps = {
      order,
      cleared,
      signatures,
      clearProactiveRenewal: (reason) => order.push(`clearRenewal:${reason}`),
      setLastSwitchedAccountId: (id) => {
        order.push('setSwitchedId')
        cleared.push(id)
      },
      setLastWrittenTokenSignature: (sig) => {
        order.push('setSignature')
        signatures.push(sig)
      },
      listSsoCacheFiles: async () => {
        order.push('listFiles')
        // 完整路径 —— 与 index.ts 注入的实现一致(失败日志需打完整路径)
        return ['/home/u/.aws/sso/cache/kiro-auth-token.json', '/home/u/.aws/sso/cache/abc123.json']
      },
      deleteSsoCacheFile: async (name) => {
        order.push(`delete:${name}`)
      }
    }
  })

  it('删除 SSO 缓存下的每个文件并回报删除数量', async () => {
    const result = await logoutAccount(deps)

    expect(result).toEqual({ success: true, deletedCount: 2 })
    expect(deps.order).toContain('delete:/home/u/.aws/sso/cache/kiro-auth-token.json')
    expect(deps.order).toContain('delete:/home/u/.aws/sso/cache/abc123.json')
  })

  it('先停掉主动续期与"IDE 当前账号"记忆,再动磁盘 —— 否则续期定时器可能在删文件途中把凭证写回去', async () => {
    await logoutAccount(deps)

    const clearIdx = deps.order.indexOf('clearRenewal:logout-account')
    const stateIdx = Math.max(deps.order.indexOf('setSwitchedId'), deps.order.indexOf('setSignature'))
    const diskIdx = deps.order.indexOf('listFiles')

    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(clearIdx).toBeLessThan(diskIdx)
    expect(stateIdx).toBeLessThan(diskIdx)
    expect(deps.cleared).toEqual([null])
    expect(deps.signatures).toEqual([null])
  })

  it('SSO 缓存目录不存在时按空目录处理,不报错', async () => {
    deps.listSsoCacheFiles = async () => []

    const result = await logoutAccount(deps)

    expect(result).toEqual({ success: true, deletedCount: 0 })
  })

  it('个别文件删不掉(被 IDE 占用)不影响整体成功,剩下的继续删', async () => {
    const attempted: string[] = []
    deps.deleteSsoCacheFile = async (name) => {
      attempted.push(name)
      if (name.endsWith('kiro-auth-token.json')) throw new Error('EBUSY')
    }

    const result = await logoutAccount(deps)

    expect(attempted).toEqual([
      '/home/u/.aws/sso/cache/kiro-auth-token.json',
      '/home/u/.aws/sso/cache/abc123.json'
    ])
    expect(result).toEqual({ success: true, deletedCount: 2 })
  })

  it('清除状态即便在磁盘操作失败时也已经生效', async () => {
    deps.listSsoCacheFiles = async () => {
      throw new Error('EPERM')
    }

    const result = await logoutAccount(deps)

    expect(result.success).toBe(false)
    expect(result.error).toBe('EPERM')
    expect(deps.cleared).toEqual([null])
    expect(deps.signatures).toEqual([null])
  })
})
