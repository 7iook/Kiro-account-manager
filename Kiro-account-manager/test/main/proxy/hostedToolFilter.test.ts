import { describe, it, expect, vi } from 'vitest'
import { claudeToKiro } from '../../../src/main/proxy/translator'
import type { ClaudeRequest } from '../../../src/main/proxy/types'

describe('Claude hosted tools filter (② hosted-tool-filter RCA)', () => {
  const baseRequest: Partial<ClaudeRequest> = {
    model: 'claude-sonnet-4.5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'test' }]
  }

  it('drops web_search_20250305 hosted tool but keeps normal function tool', () => {
    const req = {
      ...baseRequest,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as any,
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } }
        } as any
      ]
    } as ClaudeRequest

    const payload = claudeToKiro(req)
    const toolNames = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.map(
      (t: any) => t.toolSpecification?.name
    ) || []

    expect(toolNames).not.toContain('web_search')
    expect(toolNames).toContain('get_weather')
  })

  it('drops bash_20250124 / text_editor_20250124 / computer_20250124 hosted tools', () => {
    const req = {
      ...baseRequest,
      tools: [
        { type: 'bash_20250124', name: 'bash' } as any,
        { type: 'text_editor_20250124', name: 'str_replace_based_edit_tool' } as any,
        { type: 'computer_20250124', name: 'computer' } as any
      ]
    } as ClaudeRequest

    const payload = claudeToKiro(req)
    const tools = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools || []
    expect(tools.length).toBe(0)
  })

  it('drops tools with hosted name but missing input_schema (defensive)', () => {
    const req = {
      ...baseRequest,
      tools: [
        // web_search 名 · 无 input_schema(有些客户端会这么发)
        { name: 'web_search', description: '' } as any
      ]
    } as ClaudeRequest

    const payload = claudeToKiro(req)
    const tools = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools || []
    expect(tools.length).toBe(0)
  })

  it('logs dropped tools for observability', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const req = {
      ...baseRequest,
      tools: [{ type: 'web_search_20250305', name: 'web_search' } as any]
    } as ClaudeRequest
    claudeToKiro(req)
    const logged = spy.mock.calls.some(args =>
      args[0]?.toString().includes('Dropped') && args[0]?.toString().includes('web_search')
    )
    expect(logged).toBe(true)
    spy.mockRestore()
  })

  it('skips server_tool_use / web_search_tool_result blocks in history', () => {
    const req = {
      ...baseRequest,
      messages: [
        { role: 'user', content: 'search rust async' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'searching...' } as any,
            { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: 'rust async' } } as any
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_01',
              content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Rust' }]
            } as any,
            { type: 'text', text: 'continue' }
          ]
        }
      ]
    } as ClaudeRequest

    // 不应抛错;应产生 payload;history 里不应留 server_tool_use / web_search_tool_result
    const payload = claudeToKiro(req)
    expect(payload).toBeDefined()
    // history 里 assistantResponseMessage.toolUses 不应含 hosted 名
    const history = payload.conversationState.history || []
    for (const h of history) {
      if ('assistantResponseMessage' in h) {
        const uses = h.assistantResponseMessage?.toolUses || []
        for (const u of uses) {
          expect(u.name).not.toBe('web_search')
        }
      }
    }
  })
})
