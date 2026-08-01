/**
 * 上游 stopReason → 终止语义 契约测试(2026-08-01)
 *
 * 守护的缺陷:Kiro 后端在 metadataEvent 里给真实 stopReason(实测分布
 * END_TURN:155 / TOOL_USE:367 / CONTENT_FILTERED:4),但反代此前完全不消费该字段,
 * 四条转发路径一律按 hasToolCalls 本地推断 stop_reason
 * → 被内容过滤掐断的半截响应也被翻译成 end_turn("模型自然说完")
 * → 客户端不报错不重试,静默停止 = 用户报的"跑到一半自己断了"。
 *
 * 本测试锁定分类判据。若有人把 CONTENT_FILTERED 重新归成"正常收尾",这里会红。
 */
import { describe, it, expect } from 'vitest'
import { classifyKiroStopReason } from '@main/proxy/kiroApi'

describe('classifyKiroStopReason · 上游终止语义契约', () => {
  describe('必须让客户端明确失败(shouldFail=true)', () => {
    it('CONTENT_FILTERED(本次 RCA 确认的致断根因)→ filtered 且 shouldFail', () => {
      const r = classifyKiroStopReason('CONTENT_FILTERED', false)
      expect(r.disposition).toBe('filtered')
      expect(r.shouldFail).toBe(true)
      expect(r.upstreamStopReason).toBe('CONTENT_FILTERED')
    })

    it('CONTENT_FILTERED 即使伴随工具调用也不能算 tool_use 正常收尾', () => {
      const r = classifyKiroStopReason('CONTENT_FILTERED', true)
      expect(r.disposition).toBe('filtered')
      expect(r.shouldFail).toBe(true)
    })

    it.each(['CANCELLED', 'PAUSE_TURN', 'MODEL_CONTEXT_WINDOW_EXCEEDED', 'MALFORMED_MODEL_OUTPUT'])(
      '%s → incomplete 且 shouldFail',
      (reason) => {
        const r = classifyKiroStopReason(reason, false)
        expect(r.disposition).toBe('incomplete')
        expect(r.shouldFail).toBe(true)
      }
    )

    it('MAX_TOKENS + 已开工具调用 → incomplete(工具入参可能被截断,不可信)', () => {
      const r = classifyKiroStopReason('MAX_TOKENS', true)
      expect(r.disposition).toBe('incomplete')
      expect(r.shouldFail).toBe(true)
    })

    it('未知 stopReason 走保守路径 → incomplete(宁可报错也不静默截断)', () => {
      const r = classifyKiroStopReason('SOME_FUTURE_REASON_WE_DONT_KNOW', false)
      expect(r.disposition).toBe('incomplete')
      expect(r.shouldFail).toBe(true)
    })
  })

  describe('正常收尾(shouldFail=false)', () => {
    it('END_TURN → complete', () => {
      const r = classifyKiroStopReason('END_TURN', false)
      expect(r.disposition).toBe('complete')
      expect(r.shouldFail).toBe(false)
    })

    it('TOOL_USE → tool_use', () => {
      const r = classifyKiroStopReason('TOOL_USE', true)
      expect(r.disposition).toBe('tool_use')
      expect(r.shouldFail).toBe(false)
    })

    it('MAX_TOKENS 无工具调用 → length(客户端自己会续写,不算失败)', () => {
      const r = classifyKiroStopReason('MAX_TOKENS', false)
      expect(r.disposition).toBe('length')
      expect(r.shouldFail).toBe(false)
    })

    it('stopReason 缺失 + 有工具调用 → tool_use(回退本地推断,保持旧行为)', () => {
      const r = classifyKiroStopReason(undefined, true)
      expect(r.disposition).toBe('tool_use')
      expect(r.shouldFail).toBe(false)
    })

    it('stopReason 缺失 + 无工具调用 → complete(回退本地推断,保持旧行为)', () => {
      const r = classifyKiroStopReason(undefined, false)
      expect(r.disposition).toBe('complete')
      expect(r.shouldFail).toBe(false)
    })
  })

  describe('归一化:上游写法变体不应改变判定', () => {
    it.each([
      ['CONTENT_FILTERED', 'filtered'],
      ['content_filtered', 'filtered'],
      ['contentFiltered', 'filtered'],
      ['content-filtered', 'filtered'],
      ['  CONTENT_FILTERED  ', 'filtered'],
      ['END_TURN', 'complete'],
      ['endTurn', 'complete'],
      ['end_turn', 'complete']
    ])('%s → %s', (input, expected) => {
      expect(classifyKiroStopReason(input, false).disposition).toBe(expected)
    })
  })

  describe('回归护栏:CONTENT_FILTERED 绝不能被当成 end_turn', () => {
    it('filtered 的 disposition 不是 complete / tool_use', () => {
      const r = classifyKiroStopReason('CONTENT_FILTERED', false)
      expect(r.disposition).not.toBe('complete')
      expect(r.disposition).not.toBe('tool_use')
      expect(r.shouldFail).toBe(true)
    })
  })
})
