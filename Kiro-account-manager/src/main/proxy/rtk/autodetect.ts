// autodetect:看文本开头判它是什么形态的工具输出,选对应 filter。
//
// 检测顺序是硬序,不可随意调(移植 9router autodetect.js 的优先级):
//   git-diff → grep → read-numbered → smart-truncate → null
// 关键冲突点:git diff 的正文里很可能含 "src/x.ts:12:boom" 这种形态(改日志行、改测试断言),
// 若先判 grep 就会把 diff 当 grep 洗掉 → hunk 结构全毁。所以 git-diff 必须在最前。
//
// 本层只带 4 个 filter(交付范围),没命中就返 null = 这块不压。

import { DETECT_WINDOW, READ_NUMBERED_MIN_HIT_RATIO, SMART_TRUNCATE_MIN_LINES } from './constants'
import type { RtkFilter } from './constants'
import { gitDiff } from './filters/gitDiff'
import { grep, parseGrepLine } from './filters/grep'
import { readNumbered, READ_NUMBERED_LINE_RE } from './filters/readNumbered'
import { smartTruncate } from './filters/smartTruncate'

const RE_GIT_DIFF_HEADER = /^diff --git /m
const RE_GIT_DIFF_HUNK = /^@@ /m

export function autoDetectFilter(text: string): RtkFilter | null {
  // 只在开头窗口跑正则:MB 级文本上全文正则是 CPU 陷阱
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text

  // 1) git diff 最先判 —— 它的正文可能伪装成其他形态
  if (RE_GIT_DIFF_HEADER.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff

  const headLines = head.split('\n')
  const nonEmpty = headLines.filter((l) => l.trim().length > 0)

  // 2) grep:前 5 行非空行里任一命中 "file:number:content"
  if (nonEmpty.slice(0, 5).some((line) => parseGrepLine(line) !== null)) return grep

  const totalLines = countLines(text)

  // 3) 行号文件转储:要求足够长 + 采样命中率达阈
  if (totalLines >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(headLines)) return readNumbered

  // 4) 兵底:够长的无结构大段 → 保头保尾截中间
  if (totalLines >= SMART_TRUNCATE_MIN_LINES) return smartTruncate

  return null
}

/** 数总行数(不建数组,避免在 MB 级文本上多分配一份) */
function countLines(text: string): number {
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}

/** 采样开头至多 100 行,看「N|content」命中率是否达阈 */
function isLineNumbered(lines: string[]): boolean {
  let hits = 0
  let nonEmpty = 0
  for (const line of lines.slice(0, 100)) {
    if (line.length === 0) continue
    nonEmpty++
    if (READ_NUMBERED_LINE_RE.test(line)) hits++
  }
  if (nonEmpty < 5) return false
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO
}
