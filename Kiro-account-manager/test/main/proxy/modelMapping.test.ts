import { describe, expect, it } from 'vitest'
import { mapModelId } from '@main/proxy/kiroApi'

describe('mapModelId GPT 5.6 forward compatibility', () => {
  it.each([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna'
  ])('preserves Kiro GPT 5.6 model ID %s', (modelId) => {
    expect(mapModelId(modelId)).toBe(modelId)
  })

  it('preserves future versioned GPT model IDs without a static alias', () => {
    expect(mapModelId('gpt-5.7-sol')).toBe('gpt-5.7-sol')
  })

  it('keeps legacy OpenAI compatibility aliases stable', () => {
    expect(mapModelId('gpt-4')).toBe('claude-sonnet-4.5')
    expect(mapModelId('gpt-4o')).toBe('claude-sonnet-4.5')
  })

  it('still falls back for a completely unknown model', () => {
    expect(mapModelId('totally-unknown-model')).toBe('claude-sonnet-4.5')
  })
})
