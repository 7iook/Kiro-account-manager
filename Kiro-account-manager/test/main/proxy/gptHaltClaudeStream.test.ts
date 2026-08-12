import { beforeEach, describe, expect, it, vi } from 'vitest'

const callKiroApiStreamMock = vi.fn()
vi.mock('@main/proxy/kiroApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/proxy/kiroApi')>()
  return {
    ...actual,
    callKiroApiStream: (...args: unknown[]) => callKiroApiStreamMock(...args)
  }
})

import { ProxyServer } from '@main/proxy/proxyServer'

interface SseEvent {
  event: string
  data: Record<string, any>
}

function makeResponse() {
  const writes: string[] = []
  const response = {
    writableEnded: false,
    headersSent: false,
    writeHead() {
      response.headersSent = true
      return response
    },
    write(chunk: string) {
      writes.push(chunk)
      return true
    },
    end() {
      response.writableEnded = true
      return response
    },
    on() {
      return response
    },
    once() {
      return response
    },
    writes
  }
  return response
}

function parseEvents(writes: string[]): SseEvent[] {
  return writes.flatMap((write) => {
    const event = write.match(/^event: ([^\n]+)/m)?.[1]
    const data = write.match(/^data: (.+)$/m)?.[1]
    return event && data ? [{ event, data: JSON.parse(data) }] : []
  })
}

function assertValidContentBlockLifecycle(events: SseEvent[]): void {
  const openIndexes = new Set<number>()
  const starts = new Map<number, number>()
  const stops = new Map<number, number>()

  for (const item of events) {
    const index = item.data.index as number
    if (item.event === 'content_block_start') {
      expect(openIndexes.has(index), `content block ${index} opened twice`).toBe(false)
      openIndexes.add(index)
      starts.set(index, (starts.get(index) ?? 0) + 1)
    } else if (item.event === 'content_block_delta') {
      expect(openIndexes.has(index), `delta references unopened content block ${index}`).toBe(true)
    } else if (item.event === 'content_block_stop') {
      expect(openIndexes.has(index), `stop references unopened content block ${index}`).toBe(true)
      openIndexes.delete(index)
      stops.set(index, (stops.get(index) ?? 0) + 1)
    }
  }

  expect([...openIndexes], 'all content blocks must be stopped').toEqual([])
  expect(Object.fromEntries(stops), 'every started block must have exactly one matching stop')
    .toEqual(Object.fromEntries(starts))
  expect(events.filter(({ event }) => event === 'message_delta')).toHaveLength(1)
  expect(events.filter(({ event }) => event === 'message_stop')).toHaveLength(1)
}

async function runHaltStream(
  emitChunks: (onChunk: (...args: any[]) => Promise<void> | void) => Promise<void> | void
): Promise<SseEvent[]> {
  callKiroApiStreamMock.mockImplementation(
    async (
      _account: unknown,
      _payload: unknown,
      onChunk: (...args: any[]) => Promise<void> | void,
      onComplete: (usage: unknown) => void
    ) => {
      await emitChunks(onChunk)
      onComplete({
        inputTokens: 10,
        outputTokens: 4,
        credits: 0,
        terminal: {
          disposition: 'complete',
          upstreamStopReason: 'END_TURN',
          shouldFail: false
        }
      })
    }
  )

  const server = new ProxyServer()
  const response = makeResponse()
  await (server as any).handleClaudeStream(
    response,
    { id: 'account-1', accessToken: 'token' },
    {},
    'gpt-5.6-sol',
    Date.now()
  )
  expect(response.writableEnded).toBe(true)
  return parseEvents(response.writes)
}

describe('GPT halt Claude SSE content-block lifecycle', () => {
  beforeEach(() => {
    callKiroApiStreamMock.mockReset()
  })

  it('keeps block events paired when completion closes an open text block before the halt nudge', async () => {
    const events = await runHaltStream(async (onChunk) => {
      await onChunk('I need to inspect')
    })

    assertValidContentBlockLifecycle(events)
  })

  it('keeps block events paired when no text block is open when the halt nudge is emitted', async () => {
    const events = await runHaltStream(async (onChunk) => {
      await onChunk('I need to inspect')
      await onChunk('internal reasoning', undefined, true)
    })

    assertValidContentBlockLifecycle(events)
  })

  it('closes text before opening a signature-only thinking block', async () => {
    const events = await runHaltStream(async (onChunk) => {
      await onChunk('I need to inspect')
      await onChunk('', undefined, true, 'signed-reasoning')
    })

    assertValidContentBlockLifecycle(events)
  })
})
