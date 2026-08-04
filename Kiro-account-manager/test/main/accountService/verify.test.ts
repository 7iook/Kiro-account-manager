/**
 * verify.ts · 凭证验证与导入业务函数测试
 *
 * 覆盖点选择依据：这些函数从 ipcMain.handle 回调剥出后**首次可独立调用**，
 * 重点锁「返回形状 / 错误语义 / 副作用次数 / 调用顺序」—— 也就是 renderer 已适配、
 * 剥离时最容易被"顺手统一"破坏的部分。
 *
 * 网络依赖走注入的 VerifyApiDeps（不是 mock 高层 handler）；
 * kiroApi 的 systemProxy 会读 Windows 注册表，需屏蔽（照 validateApiKeyCredential.test.ts 先例）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@main/proxy/systemProxy', () => ({
  getSystemProxy: () => null,
  safeCreateProxyAgent: () => undefined
}))

import {
  computeTokenFingerprint,
  verifyApiKey,
  importFromSsoToken,
  verifyAccountCredentials,
  type VerifyApiDeps
} from '../../../src/main/accountService/verify'

/** 只实现被测路径需要的成员；未用到的成员抛错以暴露"意外多调了一个 API" */
function makeApiDeps(over: Partial<VerifyApiDeps> = {}): VerifyApiDeps {
  const notCalled = (name: string) => async () => {
    throw new Error(`unexpected call: ${name}`)
  }
  return {
    ssoDeviceAuth: notCalled('ssoDeviceAuth') as VerifyApiDeps['ssoDeviceAuth'],
    getUserInfo: notCalled('getUserInfo') as VerifyApiDeps['getUserInfo'],
    getUsageAndLimits: notCalled('getUsageAndLimits') as VerifyApiDeps['getUsageAndLimits'],
    refreshTokenByMethod: notCalled('refreshTokenByMethod') as VerifyApiDeps['refreshTokenByMethod'],
    ...over
  }
}

const USAGE_OK = {
  userInfo: { email: 'u@example.com', userId: 'uid-1' },
  subscriptionInfo: {
    subscriptionTitle: 'KIRO PRO+',
    type: 'Q_DEVELOPER_STANDALONE_PRO_PLUS',
    subscriptionManagementTarget: 'AWS',
    upgradeCapability: 'UPGRADABLE',
    overageCapability: 'SUPPORTED'
  },
  usageBreakdownList: [
    {
      resourceType: 'CREDIT',
      usageLimitWithPrecision: 1000,
      currentUsageWithPrecision: 250,
      bonuses: [
        { bonusCode: 'ACT', status: 'ACTIVE', usageLimitWithPrecision: 10, currentUsageWithPrecision: 1 },
        { bonusCode: 'OLD', status: 'EXPIRED', usageLimitWithPrecision: 99, currentUsageWithPrecision: 9 }
      ]
    }
  ],
  nextDateReset: new Date(Date.now() + 10 * 86400000).toISOString(),
  overageConfiguration: { overageStatus: 'ENABLED' }
}

describe('computeTokenFingerprint', () => {
  it('同一个 accessToken 得到稳定指纹（老账号补齐迁移靠它去重）', () => {
    const a = computeTokenFingerprint('token-abc')
    expect(a).toBe(computeTokenFingerprint('token-abc'))
    expect(a).toHaveLength(16)
  })

  it('不同 token 指纹不同', () => {
    expect(computeTokenFingerprint('a')).not.toBe(computeTokenFingerprint('b'))
  })

  it('空 token 直接抛错而不是静默返回空串（让调用点立刻暴露）', () => {
    expect(() => computeTokenFingerprint('')).toThrow(/non-empty string/)
    expect(() => computeTokenFingerprint(undefined as unknown as string)).toThrow(/non-empty string/)
  })
})

describe('verifyApiKey · 粘贴 ksk_ 密钥添加账号', () => {
  it('用户粘错了非 ksk_ 开头的字符串时立即给出格式提示，不发网络请求', async () => {
    const r = await verifyApiKey({ apiKey: 'sk-not-kiro' })
    expect(r).toEqual({
      state: 'INVALID',
      success: false,
      error: 'API Key 格式错误：应以 ksk_ 开头'
    })
  })

  it('用户粘贴时带了首尾空格也应能正常验证（trim 后判前缀）', async () => {
    const r = await verifyApiKey({ apiKey: '   sk_wrong   ' })
    // trim 后仍不是 ksk_ → INVALID；关键是没把空格当成合法前缀
    expect(r.state).toBe('INVALID')
  })
})

describe('importFromSsoToken · 粘贴 SSO Bearer Token 导入', () => {
  it('SSO 授权失败时错误以 { message } 形状返回（renderer 已按此形状适配，不得改成裸 string）', async () => {
    const deps = makeApiDeps({
      ssoDeviceAuth: async () => ({ success: false, error: '设备授权被拒' })
    })
    const r = await importFromSsoToken(deps, 'bearer-x')
    expect(r).toEqual({ success: false, error: { message: '设备授权被拒' } })
  })

  it('授权成功但没拿到 accessToken 时按失败处理，不返回半份凭证', async () => {
    const deps = makeApiDeps({ ssoDeviceAuth: async () => ({ success: true }) })
    const r = await importFromSsoToken(deps, 'bearer-x')
    expect(r.success).toBe(false)
  })

  it('导入成功时返回凭证 + 归一化的订阅与额度', async () => {
    const deps = makeApiDeps({
      ssoDeviceAuth: async () => ({
        success: true,
        accessToken: 'at',
        refreshToken: 'rt',
        clientId: 'cid',
        clientSecret: 'csec',
        region: 'us-east-1',
        expiresIn: 3600
      }),
      getUserInfo: async () => ({ email: 'fallback@example.com', idp: 'BuilderId', status: 'ACTIVE' }),
      getUsageAndLimits: async () => USAGE_OK
    })
    const r = await importFromSsoToken(deps, 'bearer-x')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      email: 'u@example.com', // usage 里的 email 优先于 getUserInfo
      userId: 'uid-1',
      subscriptionType: 'Pro_Plus',
      subscriptionTitle: 'KIRO PRO+'
    })
    // 本路径不过滤 EXPIRED bonus（与 verify 路径有意不同）
    const usage = r.data.usage as { limit: number; bonuses: unknown[] }
    expect(usage.bonuses).toHaveLength(2)
    expect(usage.limit).toBe(1000 + 10 + 99)
  })

  it('两个 API 都挂掉时仍然把已拿到的凭证返回（额度归零，不整体失败）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeApiDeps({
      ssoDeviceAuth: async () => ({ success: true, accessToken: 'at', refreshToken: 'rt' }),
      getUserInfo: async () => {
        throw new Error('boom')
      },
      getUsageAndLimits: async () => {
        throw new Error('boom')
      }
    })
    const r = await importFromSsoToken(deps, 'bearer-x')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.accessToken).toBe('at')
    // 没拿到订阅信息时标题默认 'KIRO'（本路径的既有默认值，非 'Free'）
    expect(r.data.subscriptionTitle).toBe('KIRO')
    expect(r.data.subscriptionType).toBe('Free')
    expect(r.data.daysRemaining).toBeUndefined()
    errSpy.mockRestore()
  })

  it('ssoDeviceAuth 本身抛异常时归一为 { message } 失败，不把异常抛给前端', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeApiDeps({
      ssoDeviceAuth: async () => {
        throw new Error('network down')
      }
    })
    const r = await importFromSsoToken(deps, 'bearer-x')
    expect(r).toEqual({ success: false, error: { message: 'network down' } })
    errSpy.mockRestore()
  })
})

describe('verifyAccountCredentials · 添加账号时验证凭证', () => {
  it('没填 Refresh Token 时先做本地校验，不浪费一次网络刷新', async () => {
    const refresh = vi.fn()
    const r = await verifyAccountCredentials(
      makeApiDeps({ refreshTokenByMethod: refresh as unknown as VerifyApiDeps['refreshTokenByMethod'] }),
      { refreshToken: '', clientId: 'c', clientSecret: 's' }
    )
    expect(r).toEqual({ success: false, error: '请填写 Refresh Token' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('IdC 账号缺 Client ID / Secret 时拒绝，且不发网络请求', async () => {
    const refresh = vi.fn()
    const r = await verifyAccountCredentials(
      makeApiDeps({ refreshTokenByMethod: refresh as unknown as VerifyApiDeps['refreshTokenByMethod'] }),
      { refreshToken: 'rt', clientId: '', clientSecret: '', authMethod: 'IdC' }
    )
    expect(r).toEqual({ success: false, error: '请填写 Client ID 和 Client Secret' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('社交登录账号只有 refreshToken 也允许继续验证（社交无 clientSecret 概念）', async () => {
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: true, accessToken: 'at', refreshToken: 'rt2', expiresIn: 3600 }),
      getUsageAndLimits: async () => USAGE_OK
    })
    const r = await verifyAccountCredentials(deps, {
      refreshToken: 'rt',
      clientId: '',
      clientSecret: '',
      authMethod: 'social',
      provider: 'Google'
    })
    expect(r.success).toBe(true)
  })

  it('Token 刷新失败时错误以裸 string 返回（与 SSO 导入的 { message } 形状有意不同）', async () => {
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: false, error: 'invalid_grant' })
    })
    const r = await verifyAccountCredentials(deps, {
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's'
    })
    expect(r).toEqual({ success: false, error: 'Token 刷新失败: invalid_grant' })
  })

  it('验证成功时只累计生效中的赠送额度（与 SSO 导入路径有意不同）', async () => {
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: true, accessToken: 'at', refreshToken: 'rt2', expiresIn: 3600 }),
      getUsageAndLimits: async () => USAGE_OK
    })
    const r = await verifyAccountCredentials(deps, {
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's'
    })
    expect(r.success).toBe(true)
    if (!r.success) return
    const usage = r.data.usage as { limit: number; bonuses: unknown[] }
    expect(usage.bonuses).toHaveLength(1)
    expect(usage.limit).toBe(1010) // 不含 EXPIRED 的 99
    expect(r.data).toMatchObject({
      email: 'u@example.com',
      subscriptionType: 'Pro_Plus',
      refreshToken: 'rt2' // 刷新后的新 refreshToken 优先
    })
  })

  it('刷新没返回新 refreshToken 时回落到用户填的那个（避免把 undefined 存进账号）', async () => {
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: true, accessToken: 'at', expiresIn: 3600 }),
      getUsageAndLimits: async () => ({ userInfo: {} })
    })
    const r = await verifyAccountCredentials(deps, {
      refreshToken: 'rt-original',
      clientId: 'c',
      clientSecret: 's'
    })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.refreshToken).toBe('rt-original')
  })

  it('用户已选定 profileArn 时数据面 region 跟随 profileArn 而非 SSO region（跨区用户）', async () => {
    const calls: unknown[][] = []
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: true, accessToken: 'at', refreshToken: 'rt2' }),
      getUsageAndLimits: async (...args: unknown[]) => {
        calls.push(args)
        return USAGE_OK
      }
    })
    await verifyAccountCredentials(deps, {
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's',
      region: 'eu-central-1',
      provider: 'Enterprise',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/P'
    })
    // getUsageAndLimits 第 5 个参数 = ssoRegion(数据面 region)
    expect(calls[0][4]).toBe('us-east-1')
    // 第 3 个参数 = profileArn，必须透传（否则 400 Improperly formed request）
    expect(calls[0][2]).toBe('arn:aws:codewhisperer:us-east-1:123:profile/P')
  })

  it('用量接口抛异常时归一为失败字符串，不把异常抛给前端', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: true, accessToken: 'at' }),
      getUsageAndLimits: async () => {
        throw new Error('usage 500')
      }
    })
    const r = await verifyAccountCredentials(deps, {
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's'
    })
    expect(r).toEqual({ success: false, error: 'usage 500' })
    errSpy.mockRestore()
  })

  it('不修改调用方传入的 credentials 对象', async () => {
    const deps = makeApiDeps({
      refreshTokenByMethod: async () => ({ success: true, accessToken: 'at', refreshToken: 'rt2' }),
      getUsageAndLimits: async () => USAGE_OK
    })
    const input = { refreshToken: 'rt', clientId: 'c', clientSecret: 's', region: 'us-east-1' }
    const snapshot = JSON.stringify(input)
    await verifyAccountCredentials(deps, input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
