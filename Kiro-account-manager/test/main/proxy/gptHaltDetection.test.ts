// GPT 半途收工的判定(RCA 2026-08-12)
//
// 现场:GPT 跑 agent 任务常做到一半就停,Opus 无此现象。
// 生产日志 302 条 STREAM-END 的模型对照给出决定性证据:
//   gpt-5.6-sol  TOOL_USE=0  END_TURN=35  (100%)
//   opus-4.7     TOOL_USE=163 END_TURN=17 (9.4%)
// 且 GPT 那 38 次全部 clean_eof + residualBytes=0 ⇒ 上游流正常结束,
// 不是限流/掐断/网络 —— 是 GPT 把「我还要继续」表达成了普通 END_TURN,
// 客户端据此判「讲完了」→ 收工。
//
// 判据必须同时防两头:
//   漏判 → 用户继续遇到半途断;
//   误判 → 给真正讲完的对话强行追加提示(用户明确要求「无害」,所以宁可漏不可乱)。
import { describe, it, expect } from 'vitest'
import { detectGptHalt, isGptModel, GPT_HALT_NUDGE } from '@main/proxy/gptHalt'

const base = {
  model: 'gpt-5.6-sol',
  upstreamStopReason: 'END_TURN',
  toolCallCount: 0,
  outputChars: 400,
  tailEndsSentence: false,
  tailClass: 'comma'
}

describe('GPT 半途收工判定', () => {
  it('命中:GPT + END_TURN + 无工具调用 + 尾部话没说完', () => {
    const v = detectGptHalt(base)
    expect(v.suspected).toBe(true)
    expect(v.reason).toBe('gpt-end-turn-unfinished')
  })

  it('Opus/Sonnet 一律放行(用户明确:只针对 GPT,Opus 没这个问题)', () => {
    for (const model of ['claude-opus-5', 'claude-opus-4.7', 'claude-sonnet-4.5', 'claude-opus-4-7']) {
      const v = detectGptHalt({ ...base, model })
      expect(v.suspected, model).toBe(false)
      expect(v.passedBy, model).toBe('not-gpt')
    }
  })

  it('有工具调用 → 放行(客户端会继续驱动下一轮)', () => {
    const v = detectGptHalt({ ...base, toolCallCount: 1 })
    expect(v.suspected).toBe(false)
    expect(v.passedBy).toBe('has-tool-calls')
  })

  it('以句末标点收束 → 放行(这是防误伤的主闸门)', () => {
    const v = detectGptHalt({ ...base, tailEndsSentence: true, tailClass: 'sentence_end' })
    expect(v.suspected).toBe(false)
    expect(v.passedBy).toBe('sentence-complete')
  })

  it('其它终止态不插手(各有专属处置路径,不得双重处置)', () => {
    for (const sr of ['CONTENT_FILTERED', 'MAX_TOKENS', 'CANCELLED', 'MALFORMED_MODEL_OUTPUT']) {
      const v = detectGptHalt({ ...base, upstreamStopReason: sr })
      expect(v.suspected, sr).toBe(false)
      expect(v.passedBy, sr).toBe('other-stop-reason')
    }
  })

  it('stopReason 缺失也算 END_TURN 类(实测有 ABSENT 样本)', () => {
    const v = detectGptHalt({ ...base, upstreamStopReason: undefined })
    expect(v.suspected).toBe(true)
  })

  it('空输出 → 放行(那是已有 emptyOutput 透明重试路径管的事)', () => {
    const v = detectGptHalt({ ...base, outputChars: 0 })
    expect(v.suspected).toBe(false)
    expect(v.passedBy).toBe('empty-output')
  })

  it('模型识别:只认 gpt 前缀,不误伤名字里含 gpt 的 claude 模型', () => {
    expect(isGptModel('gpt-5.6')).toBe(true)
    expect(isGptModel('gpt-5.6-sol')).toBe(true)
    expect(isGptModel('GPT-5.6')).toBe(true)
    expect(isGptModel('gpt5')).toBe(true)
    expect(isGptModel('claude-opus-5')).toBe(false)
    expect(isGptModel('claude-gpt-hybrid')).toBe(false)  // 不以 gpt 开头
    expect(isGptModel('')).toBe(false)
  })

  it('提示措辞:不断言任务未完成,把判断权交回模型', () => {
    // 断言「未完成」会让真的做完了的模型凭空续写 —— 这是本设计的核心约束
    expect(GPT_HALT_NUDGE).not.toMatch(/任务未完成(?!,)/)
    expect(GPT_HALT_NUDGE).toContain('若任务尚未完成')
    expect(GPT_HALT_NUDGE).toContain('若已完成')
    expect(GPT_HALT_NUDGE).toContain('系统提示')  // 模型需能分辨这不是用户新指令
    expect(GPT_HALT_NUDGE.length).toBeLessThan(200)  // 会占输出 token 且在界面显示
  })
})
