/**
 * A4-A5: complete-external-idp-login 返回体 shape 测试
 *
 * 决策卡 v2 §3: profiles 数组作为主字段,profileArn = profiles[0].profileArn 向后兼容
 * (renderer 旧代码只读 profileArn 的路径 N=1 时仍能正常工作)。
 *
 * SSOT: handler 内部的返回体拼装逻辑抽为 buildCompleteLoginResult(pure function),
 *       handler 只做 IPC 编排,便于单元测试且避免拉起 electron。
 */
import { describe, it, expect } from 'vitest'
import { buildCompleteLoginResult } from '@main/proxy/profile-selection'
import type { KiroProfile } from '@main/proxy/kiroApi'

const savedState = {
  tokenEndpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
  issuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
  clientId: 'aad-client-id',
  scopes: ['openid', 'email', 'profile'],
  email: 'user@example.com'
}

const tokenData = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-def',
  expiresIn: 3600
}

describe('complete-external-idp-login: buildCompleteLoginResult', () => {
  it('A4: 单 profile 场景应返 profiles=[单元素] 且 profileArn=profiles[0].profileArn(向后兼容)', () => {
    const profiles: KiroProfile[] = [
      { profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/only', profileName: 'Only', accountName: 'AcctA' }
    ]

    const result = buildCompleteLoginResult(tokenData, profiles, savedState)

    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('access-abc')
    expect(result.refreshToken).toBe('refresh-def')
    expect(result.expiresIn).toBe(3600)
    expect(result.tokenEndpoint).toBe(savedState.tokenEndpoint)
    expect(result.issuerUrl).toBe(savedState.issuerUrl)
    expect(result.clientId).toBe(savedState.clientId)
    expect(result.scopes).toBe('openid email profile')
    expect(result.email).toBe(savedState.email)

    // 关键:profiles 完整 + profileArn = profiles[0].profileArn(N=1 向后兼容)
    expect(result.profiles).toEqual(profiles)
    expect(result.profileArn).toBe('arn:aws:codewhisperer:us-east-1:1:profile/only')
  })

  it('A5: 多 profile 场景应返完整 profiles 数组且 profileArn=profiles[0].profileArn(旧字段向后兼容)', () => {
    const profiles: KiroProfile[] = [
      { profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/first', profileName: 'First' },
      { profileArn: 'arn:aws:codewhisperer:us-east-1:2:profile/second', profileName: 'Second' },
      { profileArn: 'arn:aws:codewhisperer:eu-central-1:3:profile/third', profileName: 'Third' }
    ]

    const result = buildCompleteLoginResult(tokenData, profiles, savedState)

    expect(result.success).toBe(true)
    // profiles 完整,不自动挑选
    expect(result.profiles).toHaveLength(3)
    expect(result.profiles).toEqual(profiles)
    // profileArn 保向后兼容 = profiles[0].profileArn
    expect(result.profileArn).toBe('arn:aws:codewhisperer:us-east-1:1:profile/first')
  })

  it('A4 补: 无 refreshToken 也应产合法结果(refreshToken 空字符串兜底,与老 handler 一致)', () => {
    const profiles: KiroProfile[] = [
      { profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/x' }
    ]
    const result = buildCompleteLoginResult({ accessToken: 'a', expiresIn: 1200 }, profiles, savedState)
    expect(result.refreshToken).toBe('')
    expect(result.expiresIn).toBe(1200)
  })
})
