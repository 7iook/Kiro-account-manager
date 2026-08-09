// Layer B · tool_result 智能压缩(RTK)
//
// 解决的真实问题:一个 SUB 任务把 28 文件 1800 行的 git diff 作为单条 tool_result 返回,
// 这类块在 history 里累积 → 撑爆上游体积上限;而其信息量(哪些文件、哪些 hunk、大致改了
// 什么)扛得住重度压缩。本层按输出形态选 filter 做语义压缩,而不是盲截字符串。
//
// 硬边界(测试逐条锁死,改动前先读 test/main/proxy/rtk/rtk.test.ts):
//   1. 只压 conversationState.history[],**绝不碰 currentMessage** —— 用户当前消息必须逐
//      字节原样出站。若 currentMessage 单条就超上游上限,交给既有反应式恢复、最终一个明确
//      的上游 400,这比悄悄改写用户刚发的东西要好。
//   2. 出错的 tool_result 不压(错误栈诊断价值高)。
//   3. 压完不比原文短 → 保留原文。
//   4. 原子性:全程只改深拷贝,走完才单次赋值换入;任何抛错 → 丢弃拷贝,原 payload 一个
//      字节都不许被改。就地改 + try/catch 做不到这一点 —— 抛错时前半段已经改了,这正是
//      必须用拷贝的原因。
//   5. 真压缩过的块加 [rtk-compressed:<filter>] 前缀,让模型看得见「这块被压过」,而不是
//      默默收下一个被截断的谎。
//
// 与既有 byte 维度兵底(kiroApi.ts:1638 起,超限时把 tool_result 盲截到 4000 字符)的关系:
// 本层是它的上游 —— 先语义压缩,可能压完就不必截了;真要截也截的是更小的东西。

import type { KiroPayload, KiroToolResult } from '../types'
import { MIN_COMPRESS_SIZE, RAW_CAP, compressedPrefix } from './constants'
import type { FilterName } from './constants'
import { autoDetectFilter } from './autodetect'
import { safeApply } from './applyFilter'

export interface CompressionStats {
  bytesBefore: number
  bytesAfter: number
  hits: Array<{ filter: string; saved: number }>
}

export type CompressionResult =
  | { applied: true; stats: CompressionStats }
  | { applied: false; reason: 'nothing_to_compress' | 'error'; error?: string }

export interface CompressOptions {
  minCompressSize?: number
  rawCap?: number
}

const NOTHING: CompressionResult = { applied: false, reason: 'nothing_to_compress' }

/**
 * 压缩 history 里的大 tool_result。命中则原地换入压缩结果并返回 stats;否则原 payload 不动。
 */
export function compressToolResults(
  payload: KiroPayload,
  options?: CompressOptions
): CompressionResult {
  if (!isLayerBEnabled()) return NOTHING
  if (!payload?.conversationState?.history?.length) return NOTHING

  const minSize = options?.minCompressSize ?? MIN_COMPRESS_SIZE
  const rawCap = options?.rawCap ?? RAW_CAP

  try {
    // 预扫(不拷贝):没有任何候选就直接退出,免掉大 payload 的深拷贝开销
    if (!hasCandidate(payload, minSize, rawCap)) return NOTHING

    const clone = clonePayload(payload)
    const stats: CompressionStats = { bytesBefore: 0, bytesAfter: 0, hits: [] }

    for (const message of clone.conversationState.history ?? []) {
      for (const toolResult of eligibleToolResults(
        message.userInputMessage?.userInputMessageContext?.toolResults
      )) {
        for (const part of toolResult.content) {
          if (typeof part.text !== 'string') continue
          part.text = compressText(part.text, stats, minSize, rawCap)
        }
      }
    }

    if (stats.hits.length === 0) return NOTHING

    // 单次赋值换入 —— 在此之前原 payload 未被触碰
    payload.conversationState = clone.conversationState
    return { applied: true, stats }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[RTK] compressToolResults failed, leaving payload untouched: ${message}`)
    return { applied: false, reason: 'error', error: message }
  }
}

/** 格式化一行日志,给调用方打点用 */
export function formatRtkLog(stats: CompressionStats): string | null {
  if (!stats.hits.length) return null
  const saved = stats.bytesBefore - stats.bytesAfter
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : '0'
  const filters = Array.from(new Set(stats.hits.map((h) => h.filter))).join(',')
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`
}

/** KIRO_PROXY_LAYER_B=false 显式关闭;其余情况(含未设)默认开启 */
function isLayerBEnabled(): boolean {
  return process.env.KIRO_PROXY_LAYER_B !== 'false'
}

/**
 * 深拷贝。故意不复用 kiroApi.ts:877 的同名私有函数:rtk 是叶子模块,后续接线是
 * kiroApi → rtk 的方向,反向 import 会成环,且会把 4000+ 行的 kiroApi 模块副作用
 * 拖进本层单测。三行的结构化拷贝不构成值得共享的 SSOT。
 */
function clonePayload(payload: KiroPayload): KiroPayload {
  return JSON.parse(JSON.stringify(payload)) as KiroPayload
}

/** 出错的 tool_result 一律跳过:status='error'(Kiro 形状)与 is_error=true(Claude 形状泄漏防御) */
function isErrored(toolResult: KiroToolResult): boolean {
  if (toolResult.status === 'error') return true
  return (toolResult as KiroToolResult & { is_error?: boolean }).is_error === true
}

/** 可压的 tool_result:非出错 + content 是数组 */
function eligibleToolResults(toolResults: KiroToolResult[] | undefined): KiroToolResult[] {
  if (!Array.isArray(toolResults)) return []
  return toolResults.filter((tr) => tr && !isErrored(tr) && Array.isArray(tr.content))
}

/** 预扫:history 里是否存在尺寸落在 [minSize, rawCap] 区间的非出错 tool_result 文本 */
function hasCandidate(payload: KiroPayload, minSize: number, rawCap: number): boolean {
  for (const message of payload.conversationState.history ?? []) {
    for (const toolResult of eligibleToolResults(
      message.userInputMessage?.userInputMessageContext?.toolResults
    )) {
      for (const part of toolResult.content) {
        if (typeof part.text !== 'string') continue
        const bytes = Buffer.byteLength(part.text, 'utf-8')
        if (bytes >= minSize && bytes <= rawCap) return true
      }
    }
  }
  return false
}

/** 压一段文本;任何一道闸门不过就原样返回(并如实计入 bytesAfter) */
function compressText(
  text: string,
  stats: CompressionStats,
  minSize: number,
  rawCap: number
): string {
  const bytesIn = Buffer.byteLength(text, 'utf-8')
  stats.bytesBefore += bytesIn

  const keep = (): string => {
    stats.bytesAfter += bytesIn
    return text
  }

  // 闸门 1:太小不值得动(改写历史会破 prompt cache prefix);太大是病态输入,不喂给 filter
  if (bytesIn < minSize || bytesIn > rawCap) return keep()

  // 闸门 2:认不出形态就不压 —— 宁可原样出站,也不拿未知结构去猜
  const filter = autoDetectFilter(text)
  if (!filter) return keep()

  // 闸门 3:单个 filter 抛错时退化为原文(safeApply 内部兜住)
  const out = safeApply(filter, text)

  const marked = out.length > 0 ? compressedPrefix(filter.filterName as FilterName) + out : ''
  const bytesOut = marked.length > 0 ? Buffer.byteLength(marked, 'utf-8') : 0

  // 闸门 4:空结果或没变短(含加前缀后反而更长)→ 保留原文
  if (bytesOut === 0 || bytesOut >= bytesIn) return keep()

  stats.bytesAfter += bytesOut
  stats.hits.push({ filter: filter.filterName, saved: bytesIn - bytesOut })
  return marked
}
