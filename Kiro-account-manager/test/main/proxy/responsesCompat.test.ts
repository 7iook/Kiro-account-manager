import { describe, expect, it } from 'vitest'
import { responsesToOpenAIChat } from '@main/proxy/translator'
import type { OpenAIResponsesRequest } from '@main/proxy/types'

// Regression tests for Codex CLI (openai/codex >=0.144) responses → chat 兼容
// 参考实现: F:\9router\open-sse\translator\request\openai-responses.js
// RCA: .agent-workspace/.archive/2026-07-14/codex-responses-compat/codex-responses-compat-rca.md

describe('responsesToOpenAIChat Codex compatibility', () => {
  it('skips unknown responses input item types (Codex additional_tools) instead of throwing', () => {
    const req = {
      model: 'gpt-5.6-sol',
      input: [
        // Codex 会在多轮里塞的 hosted / 状态占位项，本地反代此前直接 400
        { type: 'additional_tools' },
        { type: 'web_search_call' },
        { type: 'message', role: 'user', content: 'hi' }
      ]
    } as unknown as OpenAIResponsesRequest

    expect(() => responsesToOpenAIChat(req)).not.toThrow()
    const out = responsesToOpenAIChat(req)
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('buffers reasoning summary/content into the next assistant message reasoning_content', () => {
    const req = {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'reasoning', summary: [{ text: 'thinking A' }, { text: 'thinking B' }] },
        { type: 'message', role: 'assistant', content: 'answer' }
      ]
    } as unknown as OpenAIResponsesRequest

    const out = responsesToOpenAIChat(req)
    expect(out.messages).toHaveLength(2)
    expect(out.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'thinking A\nthinking B'
    })
  })

  it('reasoning without a following assistant does not leak into user messages', () => {
    const req = {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'reasoning', summary: [{ text: 'orphan' }] },
        { type: 'message', role: 'user', content: 'q' }
      ]
    } as unknown as OpenAIResponsesRequest

    const out = responsesToOpenAIChat(req)
    // user 消息不能被 reasoning 污染
    expect(out.messages).toHaveLength(1)
    expect((out.messages[0] as { reasoning_content?: string }).reasoning_content).toBeUndefined()
  })

  it('filters out responses tools that carry no function name (Codex hosted tool)', () => {
    const req = {
      model: 'gpt-5.6-sol',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      tools: [
        // Codex hosted tool: 无 function.name，也没 name
        { type: 'web_search' as unknown as 'function' } as unknown as {
          type: 'function'
          function: { name: string; description: string; parameters: unknown }
        },
        // 正常 function tool
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'weather',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    } as unknown as OpenAIResponsesRequest

    const out = responsesToOpenAIChat(req)
    expect(out.tools).toBeDefined()
    expect(out.tools).toHaveLength(1)
    expect(out.tools![0].function.name).toBe('get_weather')
  })

  it('accepts unknown content part types by dropping them instead of throwing', () => {
    const req = {
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'hi' },
            { type: 'input_reasoning' } // 假的未来 part type
          ]
        }
      ]
    } as unknown as OpenAIResponsesRequest

    expect(() => responsesToOpenAIChat(req)).not.toThrow()
    const out = responsesToOpenAIChat(req)
    const parts = out.messages[0].content
    expect(Array.isArray(parts)).toBe(true)
    // 只保留识别的 input_text
    expect((parts as { type: string }[]).map(p => p.type)).toEqual(['text'])
  })
})
