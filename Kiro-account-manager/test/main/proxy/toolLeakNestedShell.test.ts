// 回归测试:幻觉外壳(function_results)内的内层工具标记,绝不能被提升成真实工具调用。
//
// 缺陷现场(2026-08-01):filterToolLeak 里"提取内层工具"的循环排在"丢弃幻觉外壳"之前,
// 于是嵌套在外壳里的内层工具先被捞进 leakedTools,等外壳被整块丢弃时工具已经提取出去了
// → 流结束时作为真实 tool_use 注入客户端 = 模型幻觉/散文示例被提升成真实调用。
//
// 实证:一次 GPT 会话在报告正文里写示例标记,反代真的向客户端发出了 toolUseId=toolleakfix_* 的
// 调用,客户端回 "No such tool available"。若幻觉里的工具名恰好存在,就会执行一次无人意图的调用
// → 对话状态错乱(这是"跑到一半断了"的另一条路径)。
//
// 修法:交换两个循环顺序 —— 外壳先整块丢弃,其内一切永不进 leakedTools。

import { describe, it, expect, vi, afterEach } from 'vitest'

const undiciFetchMock = vi.fn()
vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  ProxyAgent: class {},
  Agent: class {}
}))
vi.mock('@main/proxy/systemProxy', () => ({
  getSystemProxy: () => null,
  safeCreateProxyAgent: () => undefined
}))

import { callKiroApiStream } from '@main/proxy/kiroApi'
import type { KiroPayload } from '@main/proxy/types'

// AWS EventStream 帧编码(与 parseEventStream 的解析格式对齐)
function encodeFrame(eventType: string, payloadObj: unknown): Uint8Array {
  const enc = new TextEncoder()
  const payload = enc.encode(JSON.stringify(payloadObj))
  const nameBytes = enc.encode(':event-type')
  const valBytes = enc.encode(eventType)
  const headersLen = 1 + nameBytes.length + 1 + 2 + valBytes.length
  const totalLen = 12 + headersLen + payload.length + 4
  const buf = new Uint8Array(totalLen)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, totalLen, false)
  dv.setUint32(4, headersLen, false)
  dv.setUint32(8, 0, false)
  let o = 12
  buf[o++] = nameBytes.length
  buf.set(nameBytes, o); o += nameBytes.length
  buf[o++] = 7
  dv.setUint16(o, valBytes.length, false); o += 2
  buf.set(valBytes, o); o += valBytes.length
  buf.set(payload, o)
  return buf
}

function stubStream(frames: Uint8Array[]): void {
  const impl = async (): Promise<Response> => new Response(
    new ReadableStream({ start(c) { for (const f of frames) c.enqueue(f); c.close() } }),
    { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } }
  )
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
}

function makeAccount() {
  return {
    id: 'acc-test', email: 't@example.com', accessToken: 'tok', refreshToken: 'r',
    region: 'us-east-1', provider: 'Google', authMethod: 'social', isAvailable: true
  } as never
}

function makePayload(): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'conv-1',
      currentMessage: { userInputMessage: { content: 'go', modelId: 'claude-opus-5', origin: 'AI_EDITOR' } },
      history: []
    }
  } as unknown as KiroPayload
}

afterEach(() => {
  vi.unstubAllGlobals()
  undiciFetchMock.mockReset()
})

describe('工具泄漏过滤 · 幻觉外壳内的工具不得被救回', () => {
  it('嵌套在 function_results 里的 tool_use 不产生任何 toolUse 回调', async () => {
    const hallucinated = '好的,我来检查。'
      + "<function_results id=\"fake1\">"
      + 'Error calling tool. ' + "<tool_use name=\"Bash\">" + '{"command":"rm -rf /tmp/x"}' + "</tool_use>"
      + "</function_results>"
      + '检查完成。'

    stubStream([
      encodeFrame('assistantResponseEvent', { content: hallucinated }),
      encodeFrame('messageMetadataEvent', { stopReason: 'END_TURN' })
    ])

    const toolCalls: unknown[] = []
    let text = ''
    const onError = vi.fn()
    await new Promise<void>((resolve) => {
      callKiroApiStream(
        makeAccount(), makePayload(),
        (t, toolUse) => { if (t) text += t; if (toolUse) toolCalls.push(toolUse) },
        () => resolve(),
        (e) => { onError(e); resolve() }
      ).catch(() => resolve())
    })

    expect(onError).not.toHaveBeenCalled()
    // 核心断言:幻觉外壳里的工具绝不能变成真实调用
    expect(toolCalls).toHaveLength(0)
    // 外壳整块被丢弃,不泄漏给客户端
    expect(text).not.toContain('rm -rf')
    expect(text).not.toContain('function_results')
    expect(text).not.toContain('tool_use')
    // 外壳前后的正常文本要保留
    expect(text).toContain('好的,我来检查。')
    expect(text).toContain('检查完成。')
  })

  it('未嵌套在外壳里的独立 tool_use 泄漏仍照常救回(不误伤原有能力)', async () => {
    const leaked = '我来执行。' + "<tool_use name=\"Bash\">" + '{"command":"ls"}' + "</tool_use>"

    stubStream([
      encodeFrame('assistantResponseEvent', { content: leaked }),
      encodeFrame('messageMetadataEvent', { stopReason: 'END_TURN' })
    ])

    const toolCalls: { name: string }[] = []
    await new Promise<void>((resolve) => {
      callKiroApiStream(
        makeAccount(), makePayload(),
        (_t, toolUse) => { if (toolUse) toolCalls.push(toolUse as { name: string }) },
        () => resolve(),
        () => resolve()
      ).catch(() => resolve())
    })

    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].name).toBe('Bash')
  })
})
