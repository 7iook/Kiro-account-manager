/**
 * A6-A7: verify-account-credentials profile 决策 SSOT 测试
 *
 * 决策卡 v2 修订 2:不新建并行 IPC,扩展现有 verify-account-credentials handler。
 * SSOT: handler 内部"决定 profileArn"的分支逻辑抽为 resolveProfileArnForVerify(pure function),
 *       external_idp + IdC 都走这一个 helper —— sweep §4.8 落点收口。
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveProfileArnForVerify } from '@main/proxy/profile-selection'

describe('verify-account-credentials: resolveProfileArnForVerify (profile SSOT helper)', () => {
  it('A6: 传入 profileArn 时应优先使用它,不再调 fetchEnterpriseProfileArn(不兜底)', async () => {
    const fetcher = vi.fn().mockResolvedValue('arn:aws:codewhisperer:us-east-1:999:profile/should-not-be-used')

    const result = await resolveProfileArnForVerify(
      {
        providedProfileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/user-selected',
        isEnterprise: true,
        accessToken: 'at',
        region: 'us-east-1',
        provider: 'ExternalIdp',
        authMethod: 'external_idp'
      },
      fetcher
    )

    expect(result).toBe('arn:aws:codewhisperer:us-east-1:1:profile/user-selected')
    // 关键:传入 profileArn 时 fetcher 必须不被调用(避免多余的网络调用 + 尊重用户选择)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('A7: 未传 profileArn + isEnterprise 时应走 fetcher 兜底(保持向后兼容原行为)', async () => {
    const fetcher = vi.fn().mockResolvedValue('arn:aws:codewhisperer:us-east-1:2:profile/from-backend')

    const result = await resolveProfileArnForVerify(
      {
        providedProfileArn: undefined,
        isEnterprise: true,
        accessToken: 'at',
        region: 'us-east-1',
        provider: 'ExternalIdp',
        authMethod: 'external_idp'
      },
      fetcher
    )

    // fetcher 被调用一次,拿到后端返的 profileArn
    expect(fetcher).toHaveBeenCalledOnce()
    expect(result).toBe('arn:aws:codewhisperer:us-east-1:2:profile/from-backend')
    // 参数结构应传递(id 空,后端只用 accessToken/region/provider)
    const callArg = fetcher.mock.calls[0][0]
    expect(callArg).toMatchObject({
      accessToken: 'at',
      region: 'us-east-1',
      provider: 'ExternalIdp',
      authMethod: 'external_idp'
    })
  })

  it('A7 变体: 未传 profileArn + 非 Enterprise (BuilderId) 应返 undefined,不调 fetcher', async () => {
    const fetcher = vi.fn()

    const result = await resolveProfileArnForVerify(
      {
        providedProfileArn: undefined,
        isEnterprise: false,
        accessToken: 'at',
        region: 'us-east-1',
        provider: 'BuilderId',
        authMethod: 'IdC'
      },
      fetcher
    )

    expect(result).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('A7 变体: fetcher 抛异常时应吞异常返 undefined(与老 handler 兜底行为一致,避免登录整体失败)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network error'))

    const result = await resolveProfileArnForVerify(
      {
        providedProfileArn: undefined,
        isEnterprise: true,
        accessToken: 'at',
        region: 'us-east-1',
        provider: 'ExternalIdp',
        authMethod: 'external_idp'
      },
      fetcher
    )

    // 老 handler line 4694-4707 就是 try/catch 返 undefined —— 保持这个行为(不阻塞验证主流程)
    expect(result).toBeUndefined()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('A6 变体: providedProfileArn=空字符串时视为未传(走 fetcher)', async () => {
    const fetcher = vi.fn().mockResolvedValue('arn:aws:codewhisperer:us-east-1:3:profile/fallback')

    const result = await resolveProfileArnForVerify(
      {
        providedProfileArn: '',
        isEnterprise: true,
        accessToken: 'at',
        region: 'us-east-1',
        provider: 'Enterprise',
        authMethod: 'IdC'
      },
      fetcher
    )

    expect(result).toBe('arn:aws:codewhisperer:us-east-1:3:profile/fallback')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
