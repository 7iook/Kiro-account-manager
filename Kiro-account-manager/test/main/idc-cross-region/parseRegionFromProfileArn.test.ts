/**
 * Regression test: cross-region IdC user profileArn 探测
 *
 * Bug: 用户 SSO region(refresh 用)可能 ≠ profile region(数据面 API 用)
 *   - 用户 SSO 在 eu-central-1 · 组织 profile 挂在 us-east-1
 *   - 老代码只用 account.region 单 region 打 → profiles=[] → verify 403 "Invalid token"
 *
 * 修复:
 *   1. parseRegionFromProfileArn 从 arn 解真实 region
 *   2. fetchEnterpriseProfileArn 探到 primary region profiles=[] 时自动跨 region 试其他已知 CW region
 *   3. verify handler 用解析出的 dataPlaneRegion 打 usage
 *
 * RCA: .agent-workspace/.archive/2026-07-14/idc-cross-region-403/idc-cross-region-403-rca.md
 */
import { describe, it, expect } from 'vitest'
import { parseRegionFromProfileArn } from '../../../src/main/proxy/kiroApi'

describe('parseRegionFromProfileArn', () => {
  it('解析 us-east-1 profile arn', () => {
    const arn = 'arn:aws:codewhisperer:us-east-1:328646895399:profile/7KPA3EMUUUKP'
    expect(parseRegionFromProfileArn(arn)).toBe('us-east-1')
  })

  it('解析 eu-central-1 profile arn', () => {
    const arn = 'arn:aws:codewhisperer:eu-central-1:316704942615:profile/H3A4HCGR4WEC'
    expect(parseRegionFromProfileArn(arn)).toBe('eu-central-1')
  })

  it('未来其它 region 也能通用解析(比如 ap-northeast-1)', () => {
    const arn = 'arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/AAAABBBB'
    expect(parseRegionFromProfileArn(arn)).toBe('ap-northeast-1')
  })

  it('undefined 输入返 undefined', () => {
    expect(parseRegionFromProfileArn(undefined)).toBeUndefined()
  })

  it('null 输入返 undefined', () => {
    expect(parseRegionFromProfileArn(null)).toBeUndefined()
  })

  it('空字符串返 undefined', () => {
    expect(parseRegionFromProfileArn('')).toBeUndefined()
  })

  it('非 arn 格式的字符串返 undefined(不误伤)', () => {
    expect(parseRegionFromProfileArn('not-an-arn')).toBeUndefined()
    expect(parseRegionFromProfileArn('random string')).toBeUndefined()
  })

  it('service 不是 codewhisperer 的 arn 返 undefined(防误伤其他服务 arn)', () => {
    expect(parseRegionFromProfileArn('arn:aws:s3:::my-bucket')).toBeUndefined()
    expect(parseRegionFromProfileArn('arn:aws:lambda:us-east-1:123:function:foo')).toBeUndefined()
  })

  it('缺 region 段的 arn 返 undefined', () => {
    // arn 结构短于 4 段
    expect(parseRegionFromProfileArn('arn:aws:codewhisperer')).toBeUndefined()
  })
})
