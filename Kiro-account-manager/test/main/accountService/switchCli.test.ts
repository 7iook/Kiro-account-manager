/**
 * accountService/switchCli.ts · 切号到 Kiro CLI 的可复用业务函数
 *
 * 重点锁三件抽离时最易被破坏的事:
 *   1. 与 IDE 切号**有意不同** —— refresh 失败仍用旧 token 继续写(不是 bug,是既有语义)
 *   2. token key 的三分支选择 + 清掉其他优先级旧 key(否则 CLI 读到上一个账号的 token)
 *   3. state 表 profileArn 只含 arn + profile_name 两键(多写字段会让 kiro-cli serde 判无效)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  switchAccountToCli,
  type SwitchAccountCliDeps
} from '../../../src/main/accountService/switchCli'

function makeDeps(
  overrides: Partial<SwitchAccountCliDeps> = {}
): SwitchAccountCliDeps & { executed: string[][] } {
  const executed: string[][] = []
  return {
    executed,
    refreshTokenByMethod: async () => ({
      success: true,
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      expiresIn: 3600
    }),
    resolveProfileArnForWrite: (input) => input.profileArn,
    resolveCliDbPath: async () => '/home/u/.local/share/kiro-cli/data.sqlite3',
    execSqlite: async (_dbPath, statements) => {
      executed.push(statements)
    },
    ...overrides
  }
}

/** 取本次执行的 SQL 批次 */
function sqlOf(deps: { executed: string[][] }): string[] {
  expect(deps.executed).toHaveLength(1)
  return deps.executed[0]
}

/** 从 INSERT 语句里抠出写进 auth_kv 的 token JSON */
function tokenJsonOf(sql: string[], key: string): Record<string, unknown> {
  const stmt = sql.find((s) => s.includes(`INTO auth_kv`) && s.includes(`'${key}'`))
  expect(stmt, `no INSERT for key ${key}`).toBeTruthy()
  const m = /VALUES \('[^']*', '(.*)'\);$/.exec(stmt as string)
  expect(m).toBeTruthy()
  return JSON.parse((m as RegExpExecArray)[1].replace(/''/g, "'")) as Record<string, unknown>
}

const base = {
  accessToken: 'access-v1',
  refreshToken: 'refresh-v1',
  clientId: 'client-1',
  clientSecret: 'secret-1'
}

describe('switchAccountToCli · 切号写入 kiro-cli 的 SQLite', () => {
  it('轮换后的 refreshToken 必须写进 SQLite(否则下次 CLI 自刷用已作废的旧值)', async () => {
    const deps = makeDeps()

    const result = await switchAccountToCli(deps, { ...base })

    expect(result).toEqual({
      success: true,
      dbPath: '/home/u/.local/share/kiro-cli/data.sqlite3'
    })
    const token = tokenJsonOf(sqlOf(deps), 'kirocli:odic:token')
    expect(token.access_token).toBe('access-v2')
    expect(token.refresh_token).toBe('refresh-v2')
  })

  it('刷新失败时仍用旧 token 继续写盘 —— 与 IDE 切号(拒绝写盘)有意不同,不要统一', async () => {
    const deps = makeDeps({
      refreshTokenByMethod: async () => ({ success: false, error: 'invalid_grant' })
    })

    const result = await switchAccountToCli(deps, { ...base })

    expect(result.success).toBe(true)
    const token = tokenJsonOf(sqlOf(deps), 'kirocli:odic:token')
    expect(token.access_token).toBe('access-v1')
    expect(token.refresh_token).toBe('refresh-v1')
  })

  it('社交账号写 social token key,并清掉其他优先级的旧 key(否则 CLI 读到上个账号的 token)', async () => {
    const deps = makeDeps()

    await switchAccountToCli(deps, { ...base, provider: 'Google', profileArn: 'arn:aws:x:1' })

    const sql = sqlOf(deps)
    expect(sql.some((s) => s.includes(`INTO auth_kv`) && s.includes(`'kirocli:social:token'`))).toBe(
      true
    )
    expect(sql).toContain(`DELETE FROM auth_kv WHERE key = 'kirocli:odic:token';`)
    expect(sql).toContain(`DELETE FROM auth_kv WHERE key = 'kirocli:external-idp:token';`)
    expect(sql).toContain(`DELETE FROM auth_kv WHERE key = 'codewhisperer:odic:token';`)
    // 自己那把不能被删
    expect(sql).not.toContain(`DELETE FROM auth_kv WHERE key = 'kirocli:social:token';`)
  })

  it('Azure AD 账号写 external-idp token key 并补齐微软元数据字段', async () => {
    const deps = makeDeps()

    await switchAccountToCli(deps, {
      ...base,
      provider: 'AzureAD',
      profileArn: 'arn:aws:x:1',
      tokenEndpoint: 'https://login.microsoftonline.com/t/oauth2/v2.0/token',
      issuerUrl: 'https://login.microsoftonline.com/t/v2.0',
      audience: 'aud-1'
    })

    const token = tokenJsonOf(sqlOf(deps), 'kirocli:external-idp:token')
    expect(token.auth_method).toBe('external_idp')
    expect(token.provider).toBe('ExternalIdp')
    expect(token.token_endpoint).toBe('https://login.microsoftonline.com/t/oauth2/v2.0/token')
    expect(token.issuer).toBe('https://login.microsoftonline.com/t/v2.0')
    expect(token.issuer_url).toBe('https://login.microsoftonline.com/t/v2.0')
    expect(token.audience).toBe('aud-1')
  })

  it('social/external_idp 的 state profile 严格只含 arn 与 profile_name 两键(多写会让 kiro-cli 判 profileArn 无效)', async () => {
    const deps = makeDeps()

    await switchAccountToCli(deps, { ...base, provider: 'Github', profileArn: 'arn:aws:x:9' })

    const stmt = sqlOf(deps).find((s) => s.includes(`INTO state`))
    expect(stmt).toBeTruthy()
    const m = /VALUES \('[^']*', '(.*)'\);$/.exec(stmt as string)
    const profile = JSON.parse((m as RegExpExecArray)[1].replace(/''/g, "'"))
    expect(Object.keys(profile).sort()).toEqual(['arn', 'profile_name'])
    expect(profile).toEqual({ arn: 'arn:aws:x:9', profile_name: 'Social_Default_Profile' })
  })

  it('BuilderId(无 ARN)不写 state profile,而是清掉上个账号的残留', async () => {
    const deps = makeDeps({ resolveProfileArnForWrite: () => undefined })

    await switchAccountToCli(deps, { ...base, provider: 'BuilderId' })

    const sql = sqlOf(deps)
    expect(sql).toContain(`DELETE FROM state WHERE key = 'api.codewhisperer.profile';`)
    expect(sql.some((s) => s.includes(`INTO state`))).toBe(false)
    // 占位符 ARN 不能进 token JSON(实测会触发 REST 端点 403)
    expect(tokenJsonOf(sql, 'kirocli:odic:token').profile_arn).toBeUndefined()
  })

  it('IdC 账号写 device-registration;社交账号不写(它不需要)', async () => {
    const idc = makeDeps()
    await switchAccountToCli(idc, { ...base })
    expect(
      sqlOf(idc).some((s) => s.includes(`'kirocli:odic:device-registration'`))
    ).toBe(true)

    const social = makeDeps()
    await switchAccountToCli(social, { ...base, provider: 'Google', profileArn: 'arn:1' })
    expect(
      sqlOf(social).some((s) => s.includes(`'kirocli:odic:device-registration'`))
    ).toBe(false)
  })

  it('凭证里的单引号被转义,不会截断 SQL 语句', async () => {
    const deps = makeDeps({
      refreshTokenByMethod: async () => ({
        success: true,
        accessToken: "tok'with'quote",
        refreshToken: 'r2',
        expiresIn: 3600
      })
    })

    await switchAccountToCli(deps, { ...base })

    const stmt = sqlOf(deps).find((s) => s.includes(`'kirocli:odic:token'`)) as string
    expect(stmt).toContain("''")
    // 能被解回原值 = 转义正确
    expect(tokenJsonOf(sqlOf(deps), 'kirocli:odic:token').access_token).toBe("tok'with'quote")
  })

  it('SQLite 执行失败时收敛为失败结果,不抛异常给调用方', async () => {
    const deps = makeDeps({
      execSqlite: async () => {
        throw new Error('sqlite3 not available')
      }
    })

    const result = await switchAccountToCli(deps, { ...base })

    expect(result).toEqual({ success: false, error: 'sqlite3 not available' })
  })

  it('没有 refreshToken 时跳过刷新直接写盘', async () => {
    const refresh = vi.fn()
    const deps = makeDeps({
      refreshTokenByMethod: refresh as unknown as SwitchAccountCliDeps['refreshTokenByMethod']
    })

    await switchAccountToCli(deps, { ...base, refreshToken: '' })

    expect(refresh).not.toHaveBeenCalled()
    expect(tokenJsonOf(sqlOf(deps), 'kirocli:odic:token').access_token).toBe('access-v1')
  })

  it('expires_at 用刷新返回的真实 expiresIn 计算', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    try {
      const deps = makeDeps({
        refreshTokenByMethod: async () => ({
          success: true,
          accessToken: 'a2',
          refreshToken: 'r2',
          expiresIn: 1800
        })
      })

      await switchAccountToCli(deps, { ...base })

      expect(tokenJsonOf(sqlOf(deps), 'kirocli:odic:token').expires_at).toBe(
        '2026-08-03T00:30:00.000Z'
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
