import { describe, expect, it } from 'vitest'
import { mapModelId } from '@main/proxy/kiroApi'
import { getModelContextLength } from '@main/proxy/tokenCounter'

// 上游真实行为(2026-08-12 受控对照实测 · EU ksk + 7897 代理 ·
// runtime.eu-central-1.kiro.dev / KiroRuntimeService.GenerateAssistantResponse):
//   gpt-5.6-sol   → 200 出流      claude-opus-5 → 200 出流   ← 对照锚点,证明通道正常
//   gpt-5.6       → 400 INVALID_MODEL_ID
//   gpt-5         → 400 INVALID_MODEL_ID
//   gpt-4o        → 400 INVALID_MODEL_ID
//   gpt-5.7-sol   → 400 INVALID_MODEL_ID   ← 证伪「未知 GPT 名原样透传可前向兼容」
// 结论:Kiro 只认 ListAvailableModels 白名单内的 canonical id,任何裸名/未来名必须先落到真实档。
describe('mapModelId · GPT tier 归一', () => {
  it.each([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
  ])('canonical id %s 原样保留', (modelId) => {
    expect(mapModelId(modelId)).toBe(modelId)
  })

  it('裸名 gpt-5.6 / gpt-5 映射到 Sol(旗舰档 · 用户 2026-08-12 决策)', () => {
    expect(mapModelId('gpt-5.6')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-5-6')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-5')).toBe('gpt-5.6-sol')
  })

  it('GPT-4 老名映射到同厂商 Sol,不再跨厂商静默换成 Claude', () => {
    expect(mapModelId('gpt-4')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-4o')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-4-turbo')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-3.5-turbo')).toBe('gpt-5.6-sol')
  })

  it('未在白名单的 GPT 名不得原样透传(会吃上游 400),归一到 Sol', () => {
    // gpt-5.7-sol 实测 400 —— 旧的「原样透传做前向兼容」假设被证伪
    expect(mapModelId('gpt-5.7-sol')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-6')).toBe('gpt-5.6-sol')
    expect(mapModelId('gpt-4.1')).toBe('gpt-5.6-sol')
  })

  it('已知 GPT tier 变体大小写不敏感', () => {
    expect(mapModelId('GPT-5.6-TERRA')).toBe('gpt-5.6-terra')
  })

  it('完全未知的非 GPT model 仍兜底到 default', () => {
    expect(mapModelId('totally-unknown-model')).toBe('claude-sonnet-4.5')
  })

  it('Claude 家族动态透传不受影响', () => {
    expect(mapModelId('claude-opus-5')).toBe('claude-opus-5')
    expect(mapModelId('claude-opus-4-8')).toBe('claude-opus-4.8')
  })
})

// 兜底窗口必须与 ListAvailableModels 实测值一致,否则长上下文被提前误判超限。
// 实测 tokenLimits: gpt-5.6 三档 maxInputTokens=272000;
//   claude-opus-5 / sonnet-5 / opus-4.8 / opus-4.7 / opus-4.6 / sonnet-4.6 = 1000000;
//   opus-4.5 / sonnet-4.5 / sonnet-4 / haiku-4.5 = 200000。
describe('getModelContextLength · 兜底窗口对齐上游实测值', () => {
  it.each([
    ['gpt-5.6-sol', 272000],
    ['gpt-5.6-terra', 272000],
    ['gpt-5.6-luna', 272000]
  ])('%s → %i', (id, expected) => {
    expect(getModelContextLength(id as string)).toBe(expected)
  })

  it.each([
    ['claude-opus-5', 1000000],
    ['claude-sonnet-5', 1000000],
    ['claude-opus-4.8', 1000000],
    ['claude-opus-4.6', 1000000],
    ['claude-sonnet-4.6', 1000000]
  ])('%s → %i (1M 档不得落 200K)', (id, expected) => {
    expect(getModelContextLength(id as string)).toBe(expected)
  })

  it.each([
    ['claude-opus-4.5', 200000],
    ['claude-sonnet-4.5', 200000],
    ['claude-sonnet-4', 200000],
    ['claude-haiku-4.5', 200000]
  ])('%s → %i (200K 档保持不变)', (id, expected) => {
    expect(getModelContextLength(id as string)).toBe(expected)
  })
})
