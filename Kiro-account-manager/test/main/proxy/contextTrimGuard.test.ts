// 回归测试:反代出站上下文守卫
//
// 背景 RCA:.agent-workspace/.archive/2026-07-26/proxy-400-model-and-content-length/
//          proxy-400-dual-defect-rca.md
//
// 实测受控对照(同账号同分钟,变量只有模型 ctx 与尺寸):
//   claude-opus-5  1,792,972 B (ctx 1,000,000) → 200 OK
//   gpt-5.6-sol      945,144 B (ctx   272,000) → 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD
// ⇒ Kiro 后端按 **模型 token context window** 判限,不是按 payload 字节数。
//
// 缺陷:token 级裁剪 trimHistoryByTokens 实现完好(保护 system pair + toolUse/toolResult
// 成对裁剪),但被 enableTokenBufferReserve 开关默认关闭 → 整段跳过 → 超限请求原样出站
// → 三端点全 400。本文件锁住"默认开启"以及"按模型 ctx 区分裁与不裁"。

import { describe, it, expect } from 'vitest'
import {
  buildKiroPayload,
  getEnableTokenBufferReserve,
  setModelContextWindow,
  trimHistoryByTokens,
  TRUNCATION_PLACEHOLDER
} from '@main/proxy/kiroApi'
import type { KiroHistoryMessage } from '@main/proxy/types'

/** 造 N 组 user/assistant 纯文本历史,每条 chars 个字符(纯文本 = 无 tool_result 可截,复现实测场景) */
function makeTextHistory(pairs: number, chars: number): KiroHistoryMessage[] {
  const out: KiroHistoryMessage[] = []
  for (let i = 0; i < pairs; i++) {
    out.push({ userInputMessage: { content: `u${i}-${'x'.repeat(chars)}`, modelId: 'm', origin: 'AI_EDITOR' } })
    out.push({ assistantResponseMessage: { content: `a${i}-${'y'.repeat(chars)}` } })
  }
  return out
}

function payloadBytes(p: unknown): number {
  return Buffer.byteLength(JSON.stringify(p), 'utf-8')
}

describe('出站上下文守卫 · token 维度', () => {
  it('token 级裁剪必须默认开启(关闭时超限请求会原样出站导致 400)', () => {
    expect(getEnableTokenBufferReserve()).toBe(true)
  })

  it('272K 上下文模型(gpt-5.6-sol):超限时必须裁掉最旧历史', () => {
    // 实测该模型 ctx=272000;有效上限 = 272000 - 20000 buffer = 252000 tokens
    // 估算口径 byte/3.5 ⇒ 需要约 882,000 B 才触顶,这里给 ~1.05MB 确保超限
    setModelContextWindow('gpt-5.6-sol', 272000)
    const history = makeTextHistory(120, 4400)
    expect(payloadBytes(history)).toBeGreaterThan(945_144) // 至少达到实测失败样本的规模

    const payload = buildKiroPayload('go', 'gpt-5.6-sol', 'AI_EDITOR', history)

    expect(payload.conversationState.history!.length).toBeLessThan(history.length)
    // 裁完必须落在有效上限内
    expect(Math.ceil(payloadBytes(payload) / 3.5)).toBeLessThanOrEqual(252_000)
  })

  it('1M 上下文模型(claude-opus-5):1.79MB 实测可成功的请求不得被裁', () => {
    // 实测 1,792,972 B / 3.5 ≈ 512,278 tokens,远低于 1,000,000 - 20,000
    setModelContextWindow('claude-opus-5', 1000000)
    const history = makeTextHistory(120, 7400)
    const bytes = payloadBytes(history)
    expect(bytes).toBeGreaterThan(1_700_000)
    expect(bytes).toBeLessThan(2_000_000)

    const payload = buildKiroPayload('go', 'claude-opus-5', 'AI_EDITOR', history)

    expect(payload.conversationState.history!.length).toBe(history.length)
  })

  it('裁剪后不得留下 orphan toolResult(会被上游判 400 Improperly formed request)', () => {
    setModelContextWindow('gpt-5.6-sol', 272000)
    // 交错构造 assistant(toolUse) → user(toolResult) 配对,强制触发裁剪
    const history: KiroHistoryMessage[] = []
    for (let i = 0; i < 80; i++) {
      history.push({ userInputMessage: { content: `q${i}-${'x'.repeat(6000)}`, modelId: 'm', origin: 'AI_EDITOR' } })
      history.push({
        assistantResponseMessage: {
          content: '',
          toolUses: [{ toolUseId: `t${i}`, name: 'read', input: {} }]
        }
      })
      history.push({
        userInputMessage: {
          content: '',
          modelId: 'm',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: `t${i}`, status: 'success', content: [{ text: 'z'.repeat(6000) }] }]
          }
        }
      })
      history.push({ assistantResponseMessage: { content: `done${i}` } })
    }
    // 前置条件:必须真的超出有效上限(272000 - 20000),否则本测试是假绿
    expect(Math.ceil(payloadBytes(history) / 3.5)).toBeGreaterThan(252_000)

    const payload = buildKiroPayload('go', 'gpt-5.6-sol', 'AI_EDITOR', history)
    const kept = payload.conversationState.history ?? []
    expect(kept.length).toBeLessThan(history.length)

    const useIds = new Set<string>()
    for (const m of kept) {
      for (const u of m.assistantResponseMessage?.toolUses ?? []) useIds.add(u.toolUseId)
    }
    const orphans: string[] = []
    for (const m of kept) {
      for (const r of m.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        if (!useIds.has(r.toolUseId)) orphans.push(r.toolUseId)
      }
    }
    expect(orphans).toEqual([])
  })
})

// ============================================================================
// Layer A:裁剪留痕 + 裁剪原子性
//
// 缺陷 1:trimHistoryByTokens 静默丢弃旧历史 —— 模型无法区分"这事没发生过"与
//   "这段被省略了",于是会重复索要它本来已有的信息,或从断口硬推。
//   修:真丢弃 ≥1 条时在切口插占位说明。占位是 user 消息,上游要求严格 user/assistant
//   交替(否则 400 REQUEST_BODY_INVALID),故必须紧跟一条 assistant ack。
// 缺陷 2:裁剪循环内逐轮 `payload.conversationState.history = history` 赋值 ——
//   中途抛异常会留下半裁状态的 payload,而该 payload 随后仍会被发出/重试。
//   修:本地累积,末尾一次性换入。
// ============================================================================

function isUser(m: KiroHistoryMessage): boolean {
  return m.userInputMessage != null
}
function isAssistant(m: KiroHistoryMessage): boolean {
  return m.assistantResponseMessage != null
}
/** 数占位对出现次数(以 user 侧占位文本为准) */
function countPlaceholders(history: KiroHistoryMessage[]): number {
  return history.filter(m => m.userInputMessage?.content === TRUNCATION_PLACEHOLDER).length
}
function makePayload(history: KiroHistoryMessage[], modelId = 'gpt-5.6-sol') {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'c1',
      currentMessage: { userInputMessage: { content: 'go', modelId, origin: 'AI_EDITOR' } },
      history: [...history]
    },
    profileArn: undefined
  } as unknown as Parameters<typeof trimHistoryByTokens>[0]
}

describe('出站上下文守卫 · 裁剪留痕(占位说明)', () => {
  it('真丢弃历史时必须插入占位说明 + assistant ack,其后接保留的尾段', () => {
    setModelContextWindow('gpt-5.6-sol', 272000)
    const history = makeTextHistory(120, 4400)
    const payload = buildKiroPayload('go', 'gpt-5.6-sol', 'AI_EDITOR', history)
    const kept = payload.conversationState.history ?? []

    expect(kept.length).toBeLessThan(history.length)

    const idx = kept.findIndex(m => m.userInputMessage?.content === TRUNCATION_PLACEHOLDER)
    expect(idx).toBeGreaterThanOrEqual(0)
    // 占位后必须紧跟 assistant ack(否则 user+user → 上游 400)
    expect(isAssistant(kept[idx + 1])).toBe(true)
    // ack 之后仍有真实保留的尾段
    expect(kept.length).toBeGreaterThan(idx + 2)
  })

  it('插入占位后 history 仍严格 user/assistant 交替且以 user 起头', () => {
    setModelContextWindow('gpt-5.6-sol', 272000)
    const history = makeTextHistory(120, 4400)
    const payload = buildKiroPayload('go', 'gpt-5.6-sol', 'AI_EDITOR', history)
    const kept = payload.conversationState.history ?? []

    expect(kept.length).toBeGreaterThan(0)
    expect(isUser(kept[0])).toBe(true)
    for (let i = 1; i < kept.length; i++) {
      const sameRole =
        (isUser(kept[i - 1]) && isUser(kept[i])) || (isAssistant(kept[i - 1]) && isAssistant(kept[i]))
      expect(sameRole, `位置 ${i - 1}/${i} 出现同角色相邻`).toBe(false)
    }
  })

  it('未触发裁剪(未超限)时不得插入占位 —— 否则污染每一个请求、破坏 prompt cache prefix', () => {
    setModelContextWindow('claude-opus-5', 1000000)
    const history = makeTextHistory(120, 7400)
    const payload = buildKiroPayload('go', 'claude-opus-5', 'AI_EDITOR', history)
    const kept = payload.conversationState.history ?? []

    expect(kept.length).toBe(history.length)
    expect(countPlaceholders(kept)).toBe(0)
    expect(kept).toEqual(history)
  })

  it('重复裁剪不得叠加重复占位(裁一次再裁一次 → 仍只有一对)', () => {
    setModelContextWindow('gpt-5.6-sol', 272000)
    const payload = makePayload(makeTextHistory(120, 4400))

    const first = trimHistoryByTokens(payload, 60_000)
    expect(first.trimmed).toBeGreaterThan(0)
    expect(countPlaceholders(payload.conversationState.history ?? [])).toBe(1)

    const second = trimHistoryByTokens(payload, 20_000)
    expect(second.trimmed).toBeGreaterThan(0)
    expect(countPlaceholders(payload.conversationState.history ?? [])).toBe(1)
  })

  it('切口落在 assistant(toolUse) 之后时,带占位也不得留下 orphan toolResult', () => {
    setModelContextWindow('gpt-5.6-sol', 272000)
    const history: KiroHistoryMessage[] = []
    for (let i = 0; i < 80; i++) {
      history.push({ userInputMessage: { content: `q${i}-${'x'.repeat(6000)}`, modelId: 'm', origin: 'AI_EDITOR' } })
      history.push({
        assistantResponseMessage: { content: '', toolUses: [{ toolUseId: `t${i}`, name: 'read', input: {} }] }
      })
      history.push({
        userInputMessage: {
          content: '',
          modelId: 'm',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{ toolUseId: `t${i}`, status: 'success', content: [{ text: 'z'.repeat(6000) }] }]
          }
        }
      })
      history.push({ assistantResponseMessage: { content: `done${i}` } })
    }
    const payload = buildKiroPayload('go', 'gpt-5.6-sol', 'AI_EDITOR', history)
    const kept = payload.conversationState.history ?? []

    expect(countPlaceholders(kept)).toBe(1)

    const useIds = new Set<string>()
    for (const m of kept) for (const u of m.assistantResponseMessage?.toolUses ?? []) useIds.add(u.toolUseId)
    const orphans: string[] = []
    for (const m of kept) {
      for (const r of m.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        if (!useIds.has(r.toolUseId)) orphans.push(r.toolUseId)
      }
    }
    expect(orphans).toEqual([])
  })
})

describe('出站上下文守卫 · 裁剪原子性', () => {
  it('裁剪中途抛异常时 payload 必须保持原样(不得留下半裁状态被发出/重试)', () => {
    setModelContextWindow('gpt-5.6-sol', 272000)
    const payload = makePayload(makeTextHistory(120, 4400))
    const snapshot = JSON.stringify(payload)

    // 在第 2 轮迭代时抛错:给一条消息挂上 toJSON 陷阱,JSON.stringify 到它就炸。
    // estimatePayloadTokens 每轮都会 JSON.stringify 整个 payload,故必然被触发。
    let calls = 0
    const bomb = payload.conversationState.history![10] as Record<string, unknown>
    Object.defineProperty(bomb, 'toJSON', {
      value: () => {
        calls++
        if (calls > 2) throw new Error('boom mid-trim')
        return { userInputMessage: { content: 'x'.repeat(4400), modelId: 'm', origin: 'AI_EDITOR' } }
      },
      enumerable: false,
      configurable: true
    })

    expect(() => trimHistoryByTokens(payload, 60_000)).toThrow('boom mid-trim')

    // 拆掉陷阱后比对:payload 必须与调用前逐字节一致
    delete (bomb as { toJSON?: unknown }).toJSON
    expect(JSON.stringify(payload)).toBe(snapshot)
  })
})

// ============================================================================
// Layer A 缺陷 3:预算判定跑在「中间形态」上 —— 占位对与规范化补齐的 token 从未计入。
//   裁剪循环把「纯历史」收敛到 <= maxTokens 后,才插入占位(user)+ack(assistant) 并跑
//   ensureAlternatingMessages / ensureStartsWithUserMessage,之后不再复检预算。
//   于是恰好收敛到预算线的请求,被占位对(固定开销)推回超限,而函数报告成功 →
//   安全网自己交出一个仍然超限的 payload,正是它存在的目的所要防的 400。
//   修:循环里估算的候选必须**已经是最终形态**(含占位对 + 规范化补齐),一直裁到
//   最终形态装得下,或到保护下限再也裁不动为止。
//
// 缺陷 4:返回语句里的 estimatePayloadTokens(payload) 跑在写回**之后** —— 它抛异常
//   会留下已被改写的 payload,而该 payload 随后仍被发出/重试。
//   修:最终估算在本地候选上算完,写回是全程真正的最后一个动作。
// ============================================================================

/** 独立复算 payload 估算 token(与实现同口径:UTF-8 字节 / 3.5) */
function actualTokens(p: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(p), 'utf-8') / 3.5)
}

describe('出站上下文守卫 · 预算判定必须针对最终形态', () => {
  it('裁剪收敛后**最终写回**的 payload(含占位对 + 规范化补齐)必须 <= maxTokens', () => {
    // 占位对是固定开销:循环只测「纯裁剪后」的中间形态时,收敛到恰好 <= 预算,
    // 再插占位 → 最终越界。单个 maxTokens 取值容易碰巧躲开这个窗口(占位对只有
    // 几十 token 宽),故扫一段预算值:只要有一个取值在「已裁剪、且远未到保护下限」
    // 时最终形态越界,就是本缺陷。
    const overBudget: string[] = []
    for (let maxTokens = 320; maxTokens <= 1200; maxTokens += 7) {
      const payload = makePayload(makeTextHistory(40, 40))
      const r = trimHistoryByTokens(payload, maxTokens)
      if (r.trimmed === 0) continue
      const kept = payload.conversationState.history ?? []
      if (kept.length <= 6) continue // 已触保护下限,装不下是诚实结果,不算缺陷
      // finalTokens 必须诚实反映真正写回的形态
      const actual = actualTokens(payload)
      expect(r.finalTokens, `maxTokens=${maxTokens}: finalTokens 与实际写回形态不符`).toBe(actual)
      if (actual > maxTokens) {
        overBudget.push(`maxTokens=${maxTokens} → 实际 ${actual}(超 ${actual - maxTokens},保留 ${kept.length} 条)`)
      }
    }
    expect(overBudget, `以下预算下裁剪「成功」后 payload 仍超限:\n${overBudget.join('\n')}`).toEqual([])
  })
})

describe('出站上下文守卫 · 最终估算的原子性', () => {
  it('最后一次 token 估算抛异常时 payload 仍必须逐字节原样(估算不得跑在写回之后)', () => {
    const MAX = 600
    const TARGET = 74 // 裁剪后仍在尾段的消息 → 必然参与最后一次估算
    const build = () => makePayload(makeTextHistory(40, 40))

    // 第一轮:只数估算次数。toJSON 返回与真身逐字节等价的副本,不扰动裁剪轨迹。
    let total = 0
    {
      const payload = build()
      const msg = payload.conversationState.history![TARGET] as Record<string, unknown>
      const real = JSON.parse(JSON.stringify(msg))
      Object.defineProperty(msg, 'toJSON', {
        value: () => { total++; return real },
        enumerable: false,
        configurable: true
      })
      const r = trimHistoryByTokens(payload, MAX)
      expect(r.trimmed).toBeGreaterThan(0)
    }
    expect(total).toBeGreaterThan(1)

    // 第二轮:在**最后一次**估算处引爆。
    // 修好后:最后一次估算在写回之前 → payload 原样。
    // 缺陷形态(最终估算挪回写回之后):最后一次估算已在写回之后 → payload 已被改写 → 本测试红。
    const payload = build()
    const msg = payload.conversationState.history![TARGET] as Record<string, unknown>
    const real = JSON.parse(JSON.stringify(msg))
    const snapshot = JSON.stringify(payload)
    let calls = 0
    Object.defineProperty(msg, 'toJSON', {
      value: () => {
        calls++
        if (calls >= total) throw new Error('boom final-estimate')
        return real
      },
      enumerable: false,
      configurable: true
    })

    expect(() => trimHistoryByTokens(payload, MAX)).toThrow('boom final-estimate')

    delete (msg as { toJSON?: unknown }).toJSON
    expect(JSON.stringify(payload)).toBe(snapshot)
  })
})

describe('出站上下文守卫 · 保护下限', () => {
  it('裁到保护下限仍装不下时:必须返回并诚实报告超限,不得空转', () => {
    // 2 组巨大历史 + 极小预算:裁掉 1 组即触保护下限(剩余 < 4 条),仍远超预算。
    const payload = makePayload(makeTextHistory(2, 20_000))
    const r = trimHistoryByTokens(payload, 100)

    expect(r.iterations).toBeLessThan(100) // 没有耗尽迭代上限空转
    expect(r.trimmed).toBeGreaterThan(0)

    // 诚实:不谎报达标,finalTokens 就是真正写回形态的估算
    expect(r.finalTokens).toBeGreaterThan(100)
    expect(r.finalTokens).toBe(actualTokens(payload))

    // 装不下也不牺牲留痕:占位对仍在(丢掉它只省几十 token,却退回静默丢弃)
    const kept = payload.conversationState.history ?? []
    expect(countPlaceholders(kept)).toBe(1)
    expect(isUser(kept[0])).toBe(true)
    for (let i = 1; i < kept.length; i++) {
      const sameRole =
        (isUser(kept[i - 1]) && isUser(kept[i])) || (isAssistant(kept[i - 1]) && isAssistant(kept[i]))
      expect(sameRole, `位置 ${i - 1}/${i} 出现同角色相邻`).toBe(false)
    }
  })
})
