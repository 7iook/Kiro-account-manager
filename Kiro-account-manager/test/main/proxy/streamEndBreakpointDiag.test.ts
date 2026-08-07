// 断点形态取证埋点(2026-08-07)
//
// 现场:用户报「GPT 经反代跑到一半莫名断掉,最后一句说个『继续』就没了,
// 且只有 GPT,Claude 没遇到过」。与 9router `short_future_action`(模型正常收尾
// 但内容只宣告下一步)**形态不同** —— 那种提示词可能影响,这种是流中途硬断,
// 模型根本没走到「决定怎么收尾」那一步,提示词无关。
//
// 既有埋点(2026-08-01 [STREAM-END])能答「断在哪」:exit 四态 + residualBytes。
// 答不了「断之前上游是发完了还是被掐断」—— 而这两者处置完全相反:
//   · 上游发完才关流 → 模型行为,反代侧无解(只能提示词/换模型)
//   · 传输中被掐断   → 传输层,可重试
// 本文件锁住这两组新读数真的会产出,不是「加了但不生效」(E-100)。
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

import { callKiroApiStream, sampleTailShape } from '@main/proxy/kiroApi'
import type { KiroPayload } from '@main/proxy/types'

/**
 * 构造一帧 AWS Event Stream(与 contentFilterRetry.test.ts 同法)。
 * 生产解析器不校验 CRC,两处填 0 即可走完整解析链路。
 */
function frame(eventType: string, payload: unknown): Uint8Array {
  const nameBytes = new TextEncoder().encode(':event-type')
  const typeBytes = new TextEncoder().encode(eventType)
  const headersLen = 1 + nameBytes.length + 1 + 2 + typeBytes.length
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const total = 12 + headersLen + payloadBytes.length + 4
  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, total, false)
  dv.setUint32(4, headersLen, false)
  dv.setUint32(8, 0, false)
  let o = 12
  buf[o++] = nameBytes.length
  buf.set(nameBytes, o)
  o += nameBytes.length
  buf[o++] = 7
  buf[o++] = (typeBytes.length >> 8) & 0xff
  buf[o++] = typeBytes.length & 0xff
  buf.set(typeBytes, o)
  o += typeBytes.length
  buf.set(payloadBytes, o)
  dv.setUint32(total - 4, 0, false)
  return buf
}

/** 把若干帧拼成流;lastPartial 为真时最后一帧只发前半截 —— 模拟上游硬掐断 */
function streamOf(frames: Uint8Array[], lastPartial = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      frames.forEach((f, i) => {
        const isLast = i === frames.length - 1
        if (isLast && lastPartial) {
          controller.enqueue(f.slice(0, Math.max(16, Math.floor(f.length / 2))))
        } else {
          controller.enqueue(f)
        }
      })
      controller.close()
    }
  })
}

function res(frames: Uint8Array[], lastPartial = false): Response {
  return new Response(streamOf(frames, lastPartial), { status: 200 }) as Response
}

/**
 * 装 mock:必须同时 mock undici.fetch **和** 全局 fetch。
 * 生产代码的 proxyFetch 会 patch 全局 fetch,只 mock undici 会漏到真实网络 → 403。
 * (与 contentFilterRetry.test.ts 同法)
 */
function stubFetch(frames: () => Uint8Array[], lastPartial = false): void {
  const impl = async (): Promise<Response> => res(frames(), lastPartial)
  undiciFetchMock.mockImplementation(impl)
  vi.stubGlobal('fetch', vi.fn(impl))
}

function makeAccount() {
  return {
    id: 'acc-diag',
    email: 'diag@example.com',
    accessToken: 't',
    refreshToken: 'r',
    region: 'us-east-1',
    provider: 'Google',
    authMethod: 'social',
    isAvailable: true
  } as never
}

function makePayload(): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'c1',
      currentMessage: {
        userInputMessage: { content: 'go', modelId: 'gpt-5.6-sol', origin: 'AI_EDITOR' }
      },
      history: []
    }
  } as unknown as KiroPayload
}

/** 捕获 console.log 里的 [STREAM-END] 行 */
function captureStreamEndLine(): { get line(): string; restore: () => void } {
  const original = console.log
  let captured = ''
  console.log = (...args: unknown[]): void => {
    const s = args.map(a => String(a)).join(' ')
    if (s.includes('[STREAM-END]')) captured = s
  }
  return {
    get line() { return captured },
    restore: () => { console.log = original }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  undiciFetchMock.mockReset()
  vi.restoreAllMocks()
})

// ============ A · 尾部形态取样(纯函数,判「话说完了」vs「被掐断」)============
describe('sampleTailShape · 断点尾部形状', () => {
  it('句末标点收束 → sentence_end(强烈暗示上游把话说完了)', () => {
    expect(sampleTailShape('分析完成,结论如上。').tailClass).toBe('sentence_end')
    expect(sampleTailShape('All checks passed.').endsSentence).toBe(true)
    expect(sampleTailShape('结果见下表;').endsSentence).toBe(true)
  })

  it('停在逗号 → comma(话没说完,用户报的「说个继续就断了」正是此类)', () => {
    const r = sampleTailShape('接下来我会继续排查,')
    expect(r.tailClass).toBe('comma')
    expect(r.endsSentence).toBe(false)
  })

  it('停在汉字中间 → han(传输被掐断的典型形态)', () => {
    const r = sampleTailShape('现在开始验证第二个假设的具体表现形')
    expect(r.tailClass).toBe('han')
    expect(r.endsSentence).toBe(false)
  })

  it('停在半个英文词 → latin', () => {
    expect(sampleTailShape('Let me verif').tailClass).toBe('latin')
  })

  it('停在 markdown/代码标记里 → markup', () => {
    expect(sampleTailShape('见下面的代码:\n```').tailClass).toBe('markup')
    expect(sampleTailShape('强调一下 **').tailClass).toBe('markup')
  })

  it('尾部空白不影响判定(先 trim 再看末字符)', () => {
    expect(sampleTailShape('已完成。\n\n  ').tailClass).toBe('sentence_end')
  })

  it('空输出 → empty(不误判成句子结束)', () => {
    expect(sampleTailShape('')).toEqual({ endsSentence: false, tailClass: 'empty', tailLen: 0 })
    expect(sampleTailShape('   \n ').tailClass).toBe('empty')
  })

  it('绝不回传原文 —— 只有形状字段,防日志外泄用户正文', () => {
    const secret = '用户的私密内容 sk-abcdef123456'
    const r = sampleTailShape(secret)
    expect(JSON.stringify(r)).not.toContain('sk-abcdef')
    expect(JSON.stringify(r)).not.toContain('私密')
    expect(Object.keys(r).sort()).toEqual(['endsSentence', 'tailClass', 'tailLen'])
  })
})

// ============ B · 埋点真的产出读数(E-100:安全网必须验它这一轮真跑出东西)============
describe('[STREAM-END] 断点形态读数真的落盘', () => {
  it('正常收尾:尾部判 sentence_end + 时间轴与 chunk 数都有真实读数', async () => {
    stubFetch(() => [
      frame('assistantResponseEvent', { content: '排查完成,根因是上游过滤器。' }),
      frame('metadataEvent', { stopReason: 'END_TURN' })
    ])
    const cap = captureStreamEndLine()
    try {
      await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, () => {})
    } finally {
      cap.restore()
    }
    expect(cap.line).toContain('[STREAM-END]')
    expect(cap.line).toContain('exit=clean_eof')
    expect(cap.line).toContain('tailClass=sentence_end')
    expect(cap.line).toContain('tailEndsSentence=true')
    // chunks/时间轴必须是真实读数,不能是「加了字段但恒为占位值」
    expect(cap.line).toMatch(/chunks=[1-9]\d*/)
    expect(cap.line).toMatch(/streamSpanMs=\d+/)
    expect(cap.line).toMatch(/silenceBeforeEndMs=\d+/)
    expect(cap.line).not.toContain('chunks=0')
    expect(cap.line).not.toContain('streamSpanMs=-1')
  })

  it('中途硬断(用户报的形态):尾部判非句末 + tailLen 反映已吐长度', async () => {
    // 模拟「最后一句说个『继续』就没了」:正文停在逗号,之后没有 metadataEvent
    stubFetch(() => [
      frame('assistantResponseEvent', { content: '我先确认这一处,接下来继续排查,' })
    ])
    const cap = captureStreamEndLine()
    try {
      await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, () => {})
    } finally {
      cap.restore()
    }
    expect(cap.line).toContain('tailClass=comma')
    expect(cap.line).toContain('tailEndsSentence=false')
    expect(cap.line).toMatch(/tailLen=[1-9]\d*/)
    // 上游连 stopReason 都没给 —— 这正是「莫名其妙断掉」的可观测特征
    expect(cap.line).toContain('upstreamStopReason=ABSENT')
  })

  it('半截帧 EOF:exit=eof_with_truncated_frame 且 residualBytes>0', async () => {
    stubFetch(() => [
      frame('assistantResponseEvent', { content: '已经吐出的部分' }),
      frame('metadataEvent', { stopReason: 'END_TURN' })
    ], true)  // 最后一帧只发半截
    const cap = captureStreamEndLine()
    try {
      await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, () => {})
    } finally {
      cap.restore()
    }
    expect(cap.line).toContain('exit=eof_with_truncated_frame')
    expect(cap.line).toMatch(/residualBytes=[1-9]\d*/)
  })

  it('零输出:tailClass=empty,且不把空输出误判成正常收尾', async () => {
    stubFetch(() => [
      frame('metadataEvent', { stopReason: 'CONTENT_FILTERED' })
    ])
    const cap = captureStreamEndLine()
    try {
      await callKiroApiStream(makeAccount(), makePayload(), () => {}, () => {}, () => {})
        .catch(() => {})  // filtered 会 reject,本例只关心埋点
    } finally {
      cap.restore()
    }
    expect(cap.line).toContain('tailClass=empty')
    expect(cap.line).toContain('tailEndsSentence=false')
    expect(cap.line).toContain('semanticOutput=false')
  })
})
