import { describe, it } from 'vitest'
import { responsesToOpenAIChat, openaiToKiro } from '@main/proxy/translator'
import type { OpenAIResponsesRequest } from '@main/proxy/types'

// 证据脚本：把 Codex → responses→chat→openaiToKiro 得到的 KiroPayload.additionalModelRequestFields
// 完整打印，让人眼确认 effort 真的进了 Kiro 请求体。
// 跑：npm test -- --project main test/main/proxy/effortEvidence.test.ts --run

describe('EVIDENCE: reasoning.effort actually reaches Kiro payload', () => {
  it('Codex-style opus-4.7 with reasoning.effort=high (output_config schema)', () => {
    const codexBody = {
      model: 'claude-opus-4.7',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort: 'high', summary: 'none' }
    } as unknown as OpenAIResponsesRequest

    const chat = responsesToOpenAIChat(codexBody)
    console.log('[chat] reasoning_effort =', chat.reasoning_effort)

    // 模拟 Kiro ListAvailableModels 返回的 Claude opus schema（output_config 路径）
    const payload = openaiToKiro(chat, undefined, undefined, {
      schemaPath: 'output_config',
      efforts: ['low', 'medium', 'high', 'xhigh']
    })
    console.log('[Kiro payload] additionalModelRequestFields =',
      JSON.stringify(payload.additionalModelRequestFields, null, 2))
  })

  it('Codex-style opus-4.7 with reasoning.effort=low (reasoning schema variant)', () => {
    const codexBody = {
      model: 'claude-opus-4.7',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort: 'low' }
    } as unknown as OpenAIResponsesRequest

    const chat = responsesToOpenAIChat(codexBody)
    const payload = openaiToKiro(chat, undefined, undefined, {
      schemaPath: 'reasoning',
      efforts: ['low', 'medium', 'high']
    })
    console.log('[Kiro payload reasoning-schema] additionalModelRequestFields =',
      JSON.stringify(payload.additionalModelRequestFields, null, 2))
  })

  it('Codex-style gpt-5.6-sol with reasoning.effort=high (no schema → skip)', () => {
    const codexBody = {
      model: 'gpt-5.6-sol',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort: 'high' }
    } as unknown as OpenAIResponsesRequest

    const chat = responsesToOpenAIChat(codexBody)
    // 现实中 getThinkingConfig('gpt-5.6-sol') 返回 undefined（Kiro schema 里没定义）
    const payload = openaiToKiro(chat, undefined, undefined, undefined)
    console.log('[Kiro payload GPT] additionalModelRequestFields =',
      JSON.stringify(payload.additionalModelRequestFields ?? null, null, 2))
  })
})
