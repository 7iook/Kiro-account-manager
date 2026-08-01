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
import { buildKiroPayload, getEnableTokenBufferReserve, setModelContextWindow } from '@main/proxy/kiroApi'
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
