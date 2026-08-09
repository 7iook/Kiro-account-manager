// readNumbered:行号文件转储("  12|const x = 1")—— read_file 类工具的典型输出。
//
// 策略同 smartTruncate(保头保尾),差异在提示语尾巴明确写「file continues」——
// 对文件转储而言「中间还有正文」比「日志被截」更要紧:模型得知道它看到的不是完整文件,
// 不能拿这份输出当「文件就这么长」去推结论。

import {
  FILTERS,
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_MIN_LINES,
  SMART_TRUNCATE_TAIL,
  defineFilter
} from '../constants'

/** 行号行形态:可选缩进 + 数字 + 竖线。autodetect 复用此正则做命中率判定 */
export const READ_NUMBERED_LINE_RE = /^\s*\d+\|/

export const readNumbered = defineFilter(FILTERS.READ_NUMBERED, (input: string): string => {
  const lines = input.split('\n')
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input

  const head = lines.slice(0, SMART_TRUNCATE_HEAD)
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL)
  const cut = lines.length - head.length - tail.length
  return [...head, `... +${cut} lines truncated (file continues)`, ...tail].join('\n')
})
