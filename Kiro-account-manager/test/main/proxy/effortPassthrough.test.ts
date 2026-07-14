import { describe, expect, it } from 'vitest'
import { responsesToOpenAIChat, openaiToKiro } from '@main/proxy/translator'
import type { OpenAIResponsesRequest, OpenAIChatRequest } from '@main/proxy/types'

// Codex CLI 顶层 body.reasoning.effort 透传 + GPT 家族在缺失 thinking schema 时不注入 thinking 字段
// RCA: .agent-workspace/.archive/2026-07-14/codex-effort-passthrough/codex-effort-passthrough-rca.md

describe('Codex reasoning.effort passthrough (responsesToOpenAIChat)', () => {
  it('maps body.reasoning.effort to chatRequest.reasoning_effort', () => {
    const req = {
      model: 'claude-opus-4.8',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      reasoning: { effort: 'low', summary: 'none' }
    } as unknown as OpenAIResponsesRequest

    const out = responsesToOpenAIChat(req)
    expect(out.reasoning_effort).toBe('low')
  })

  it('leaves reasoning_effort undefined when body.reasoning is absent', () => {
    const req = {
      model: 'claude-opus-4.8',
      input: [{ type: 'message', role: 'user', content: 'hi' }]
    } as unknown as OpenAIResponsesRequest

    const out = responsesToOpenAIChat(req)
    expect(out.reasoning_effort).toBeUndefined()
  })
})

describe('GPT family thinking gating (buildThinkingFields via openaiToKiro)', () => {
  const baseReq = (model: string, extras: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest => ({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...extras
  })

  it('does NOT inject additionalModelRequestFields for GPT family when Kiro schema is unknown', () => {
    const req = baseReq('gpt-5.6-sol', { reasoning_effort: 'low' })
    // 无 thinkingConfig 传入 = 模拟 Kiro schema 里 GPT 家族缺 thinking 定义
    const payload = openaiToKiro(req, undefined, undefined, undefined)
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('does NOT inject for GPT family even when client sends anthropic-style thinking', () => {
    const req = baseReq('gpt-5.6-terra')
    ;(req as unknown as { thinking?: { type: string; budget_tokens?: number } }).thinking = {
      type: 'enabled',
      budget_tokens: 8000
    }
    const payload = openaiToKiro(req, undefined, undefined, undefined)
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('KEEPS legacy fallback for Claude family when thinkingConfig is unknown', () => {
    const req = baseReq('claude-opus-4.8', { reasoning_effort: 'low' })
    const payload = openaiToKiro(req, undefined, undefined, undefined)
    expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: 'adaptive' } })
  })

  it('respects clientThinking.type=disabled regardless of family', () => {
    const req = baseReq('claude-opus-4.8')
    ;(req as unknown as { thinking?: { type: string } }).thinking = { type: 'disabled' }
    const payload = openaiToKiro(req, undefined, undefined, undefined)
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })
})
