import { describe, expect, it } from 'vitest'
import {
  KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_SOCIAL_PROFILE_ARN,
  classifyProfileArnKind,
  getEnterpriseFallbackArn,
  resolveUsageLimitsProfileArn
} from '@main/kiroAuthSync'

const REAL = 'arn:aws:codewhisperer:us-east-1:111111111111:profile/REALPROFILE'
const V1_US = 'arn:aws:codewhisperer:us-east-1:610548660232:profile/VNECVYCYYAWN'

describe('classifyProfileArnKind', () => {
  it('拆开 BuilderId 固定 ARN 与 V1 企业废 ARN', () => {
    expect(classifyProfileArnKind(KIRO_BUILDER_ID_PLACEHOLDER_ARN)).toBe('builder_id_fixed')
    expect(classifyProfileArnKind(V1_US)).toBe('enterprise_legacy_v1')
    expect(classifyProfileArnKind(KIRO_SOCIAL_PROFILE_ARN)).toBe('social_fixed')
    expect(classifyProfileArnKind(REAL)).toBe('real')
    expect(classifyProfileArnKind(null)).toBe('none')
    expect(classifyProfileArnKind('')).toBe('none')
  })
})

describe('resolveUsageLimitsProfileArn · 身份×种类决策表', () => {
  it('builder_id 缺 ARN 或 V1 废 ARN → 注入 BuilderId 固定 ARN（file1）', () => {
    expect(resolveUsageLimitsProfileArn({ identity: 'builder_id' })).toBe(
      KIRO_BUILDER_ID_PLACEHOLDER_ARN
    )
    expect(
      resolveUsageLimitsProfileArn({ identity: 'builder_id', providedProfileArn: V1_US })
    ).toBe(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
  })

  it('builder_id 已是固定 ARN → 原样保留，不改写成企业 V2', () => {
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'builder_id',
        providedProfileArn: KIRO_BUILDER_ID_PLACEHOLDER_ARN
      })
    ).toBe(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'builder_id',
        providedProfileArn: KIRO_BUILDER_ID_PLACEHOLDER_ARN
      })
    ).not.toBe(getEnterpriseFallbackArn('us-east-1'))
  })

  it('api_key 缺 ARN / 占位 ARN → undefined（守 ksk-eu-fallback-arn）', () => {
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'api_key',
        ssoRegion: 'eu-central-1'
      })
    ).toBeUndefined()
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'api_key',
        providedProfileArn: KIRO_BUILDER_ID_PLACEHOLDER_ARN,
        ssoRegion: 'eu-central-1'
      })
    ).toBeUndefined()
  })

  it('enterprise V1 → V2；EU 缺 ARN → V2；US 缺 ARN → undefined', () => {
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'enterprise',
        providedProfileArn: V1_US,
        ssoRegion: 'us-east-1'
      })
    ).toBe(getEnterpriseFallbackArn('us-east-1'))
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'enterprise',
        ssoRegion: 'eu-central-1'
      })
    ).toBe(getEnterpriseFallbackArn('eu-central-1'))
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'enterprise',
        ssoRegion: 'us-east-1'
      })
    ).toBeUndefined()
  })

  it('social 缺 ARN → 社交固定 ARN；不注入 BuilderId 固定 ARN', () => {
    expect(resolveUsageLimitsProfileArn({ identity: 'social' })).toBe(KIRO_SOCIAL_PROFILE_ARN)
    expect(
      resolveUsageLimitsProfileArn({
        identity: 'social',
        providedProfileArn: KIRO_BUILDER_ID_PLACEHOLDER_ARN
      })
    ).toBe(KIRO_SOCIAL_PROFILE_ARN)
  })

  it('真实 ARN 对 builder_id / social / api_key / enterprise 都原样', () => {
    for (const identity of ['builder_id', 'social', 'api_key', 'enterprise'] as const) {
      expect(resolveUsageLimitsProfileArn({ identity, providedProfileArn: REAL })).toBe(REAL)
    }
  })
})
