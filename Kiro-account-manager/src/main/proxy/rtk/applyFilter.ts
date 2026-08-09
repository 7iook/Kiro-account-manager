// 单个 filter 的安全网(移植 9router applyFilter.js · 对应 rtk Rust 的 catch_unwind)
//
// 为何不让 filter 抛错冒到上层:压缩是途而非目的。单个 filter 在某种奇形输入上爆了,
// 正确处置是「这块不压、原文透传」,而不是让整次请求失败。注意这不是「吞异常」:
// 异常会带 filter 名落到 console.warn,且返回值语义明确(原文 = 本块未压缩),
// 调用方 compressText 会因「结果不比输入短」而不计 hit。

import type { RtkFilter } from './constants'

export function safeApply(filter: RtkFilter, text: string): string {
  try {
    const out = filter(text)
    // filter 契约是返 string;非 string 一律当作「未压缩」处理,不让异形值流入请求体
    if (typeof out !== 'string') return text
    return out
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[RTK] filter '${filter.filterName}' threw — passing through raw output: ${message}`
    )
    return text
  }
}
