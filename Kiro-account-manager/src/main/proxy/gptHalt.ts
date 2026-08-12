/**
 * GPT 系模型「任务做到一半自己收工」的判定与介入(RCA 2026-08-12)。
 *
 * ## 现场与取证
 *
 * 用户报:GPT 模型跑 agent 任务时常做到一半就停,Opus 没有这个现象。
 * 生产日志(302 条 STREAM-END,跨 6 个模型)给出决定性对照:
 *
 * ```
 *   模型                TOOL_USE 结尾   END_TURN 结尾   END_TURN 占比
 *   claude-opus-4.7          163            17          9.4%
 *   claude-opus-5             47            11         19.0%
 *   gpt-5.6-sol                0            35        100.0%   ←
 *   gpt-5.6                    0             3        100.0%   ←
 * ```
 *
 * **GPT 38 次流全部以 END_TURN 结束,一次 TOOL_USE 都没有。** 且全部 `clean_eof`
 * + `residualBytes=0` ⇒ 上游流是完整正常结束的:**不是限流、不是掐断、不是网络**。
 * 2026-08-07 埋的半截帧告警 `[STREAM-TRUNCATED-FRAME]` 一次都没命中。
 *
 * ## 机制
 *
 * GPT 在 Kiro 网关下不发 `TOOL_USE` 停止信号 —— 它把「我还打算继续」表达成了普通
 * `END_TURN`。`classifyKiroStopReason` 于是归为 `complete`,转发层写 `stop_reason: end_turn`,
 * 客户端(Claude Code)据此判定「模型讲完了」→ 收工。用户看到的就是「说了句『我需要先读取』
 * 然后半途出」。这与 1d74a05 修掉的 CONTENT_FILTERED 静默断流是同一类病灶(把不完整
 * 伪装成正常完成),但成因在**模型行为**而非传输层。
 *
 * ## 介入方式(为什么是注入提示,而不是改 stop_reason)
 *
 * 本项目 `clientDrivenToolExecution: true` —— 工具由客户端执行,服务端没有多轮循环,
 * 反代**无法替客户端跑下一轮**。所以两条看似直接的路都不可行:
 *   - 把 END_TURN 改判成 `tool_use`:客户端会去找工具调用,而这一轮根本没有 → 协议撕裂;
 *   - 服务端自动续写:没有工具执行能力,续不出真实进展。
 *
 * 可行且无害的介入:在流收尾前**追加一段中性提示正文**,由模型下一轮自己判断。
 * 提示不预设「任务未完成」这个结论(那是我们猜的),而是把判断权交回模型:
 * 未完成就继续推进,已完成就向调用方汇报。这样即使判据误伤(其实真的做完了),
 * 代价也只是多一句无害的自检提示,不会扭曲协议、不会伪造工具调用。
 *
 * ## 判据为什么这么定
 *
 * 只在**四个条件同时满足**时介入,任一不满足即放行:
 *   1. 模型是 GPT 系 —— Opus/Sonnet 的 TOOL_USE 语义正常,不该被打扰(用户明确要求)
 *   2. 上游 stopReason 是 END_TURN(或缺失)—— 其它终止态各有专属处置路径
 *   3. 本轮**没有任何工具调用** —— 有工具调用说明客户端会继续驱动,无需介入
 *   4. 尾部形态显示「话没说完」—— 复用 `sampleTailShape`(2026-08-07 为诊断本问题而建)
 *
 * 第 4 条是防误伤的关键:以句末标点收束 = 模型确实把话讲完了,不介入。
 */

/** 判定输入。字段与 `parseEventStream` 收尾处已有的读数一一对应,不新增采集。 */
export interface GptHaltInput {
  /** 请求的模型 id(如 `gpt-5.6-sol`) */
  model: string
  /** 上游真实 stopReason(缺失时传 undefined) */
  upstreamStopReason: string | undefined
  /** 本轮工具调用总数(结构化 toolUseEvent + 救回的泄漏工具) */
  toolCallCount: number
  /** 本轮语义正文字符数 */
  outputChars: number
  /** `sampleTailShape().endsSentence` —— 是否以句末标点收束 */
  tailEndsSentence: boolean
  /** `sampleTailShape().tailClass` —— 末字符类别(仅用于日志归因) */
  tailClass: string
}

export interface GptHaltVerdict {
  /** 是否判定为「疑似半途收工」 */
  suspected: boolean
  /** 归因(日志/落盘用;`none` = 未命中) */
  reason: 'gpt-end-turn-unfinished' | 'none'
  /** 未命中时说明是哪一条判据把它放行的 —— 便于事后确认判据是否过紧/过松 */
  passedBy?: 'not-gpt' | 'has-tool-calls' | 'other-stop-reason' | 'sentence-complete' | 'empty-output'
}

/** GPT 系模型识别。只认前缀,避免把 `claude-*` 里偶然含 gpt 的名字误判。 */
export function isGptModel(model: string): boolean {
  return /^gpt[-.]?\d/i.test((model || '').trim())
}

/**
 * 判定本轮是否是「GPT 半途收工」。
 *
 * 纯函数,无副作用 —— 判据要能被单测穷举(这是上一轮 RCA 的教训:判据内联在转发
 * 逻辑里就只能靠端到端复现)。
 */
export function detectGptHalt(input: GptHaltInput): GptHaltVerdict {
  const { model, upstreamStopReason, toolCallCount, outputChars, tailEndsSentence, tailClass } = input

  if (!isGptModel(model)) return { suspected: false, reason: 'none', passedBy: 'not-gpt' }

  // 有工具调用 → 客户端会继续驱动下一轮,不需要介入
  if (toolCallCount > 0) return { suspected: false, reason: 'none', passedBy: 'has-tool-calls' }

  // 只处理 END_TURN / 缺失。其它终止态(CONTENT_FILTERED / max_tokens / cancelled …)
  // 各有专属处置路径(SSE error / max_tokens),不在这里插手。
  const norm = String(upstreamStopReason || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const isEndTurnish = norm === '' || norm === 'end_turn' || norm === 'stop' || norm === 'stop_sequence'
  if (!isEndTurnish) return { suspected: false, reason: 'none', passedBy: 'other-stop-reason' }

  // 一个字都没吐 → 是「空响应」问题(已有 emptyOutput 判据与透明重试路径),不是半途收工
  if (outputChars === 0) return { suspected: false, reason: 'none', passedBy: 'empty-output' }

  // 以句末标点收束 → 模型确实把话讲完了。这是防误伤的主闸门。
  if (tailEndsSentence) return { suspected: false, reason: 'none', passedBy: 'sentence-complete' }

  void tailClass  // 仅日志归因用,不参与判定
  return { suspected: true, reason: 'gpt-end-turn-unfinished' }
}

/**
 * 介入提示正文。
 *
 * 措辞原则(用户 2026-08-12 明确要求「无害的提示」):
 *   - **不断言**任务未完成 —— 那是我们的推测,断错会让模型凭空续写
 *   - 把判断权交回模型:未完成→继续推进,已完成→向调用方汇报
 *   - 标明这是系统提示,模型不会把它当成用户的新指令去执行
 *   - 简短:它会占用输出 token,且要在客户端界面里显示出来
 */
export const GPT_HALT_NUDGE =
  '\n\n[系统提示] 本轮回复在未给出明确结论处结束。若任务尚未完成,请直接继续推进下一步;'
  + '若已完成,请向调用方给出明确的完成汇报与结果摘要。'
