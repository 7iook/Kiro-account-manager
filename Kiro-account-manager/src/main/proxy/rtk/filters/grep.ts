// grep:把 "file:lineno:content" 洗成按文件分组的紧凑汇总(移植 9router filters/grep.js)。
//
// 信息量保留:总命中数 · 文件数 · 每文件命中数 · 前 N 条具体行号与正文。
// 注意:本 filter 有可能变长(每行一个独立文件时,分组头比原文还多) ——
// 这不在 filter 里抦:上层 compressText 的「不比输入短就保留原文」双保险统一兜住。

import { FILTERS, GREP_PER_FILE_MAX, defineFilter } from '../constants'

/** 拆一行 grep 输出 → [file, lineNo, content];形态不符返 null(只在前两个冒号处拆,对应 Rust splitn(3,':')) */
export function parseGrepLine(
  line: string
): { file: string; lineNo: string; content: string } | null {
  const first = line.indexOf(':')
  if (first === -1) return null
  const second = line.indexOf(':', first + 1)
  if (second === -1) return null
  const lineNo = line.slice(first + 1, second)
  if (!/^\d+$/.test(lineNo)) return null
  return { file: line.slice(0, first), lineNo, content: line.slice(second + 1) }
}

export const grep = defineFilter(FILTERS.GREP, (input: string): string => {
  const byFile = new Map<string, Array<{ lineNo: string; content: string }>>()
  let total = 0

  for (const line of input.split('\n')) {
    const parsed = parseGrepLine(line)
    if (!parsed) continue
    total++
    const bucket = byFile.get(parsed.file)
    if (bucket) bucket.push(parsed)
    else byFile.set(parsed.file, [parsed])
  }

  // 一条都没认出来 → 这不是 grep 输出,原文退回(绝不吞内容)
  if (total === 0) return input

  const files = Array.from(byFile.keys()).sort()
  const out: string[] = [`${total} matches in ${files.length}F:`, '']

  for (const file of files) {
    const matches = byFile.get(file)!
    out.push(`[file] ${file} (${matches.length}):`)
    for (const { lineNo, content } of matches.slice(0, GREP_PER_FILE_MAX)) {
      out.push(`  ${lineNo.padStart(4)}: ${content.trim()}`)
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out.push(`  +${matches.length - GREP_PER_FILE_MAX}`)
    }
    out.push('')
  }

  return out.join('\n')
})
