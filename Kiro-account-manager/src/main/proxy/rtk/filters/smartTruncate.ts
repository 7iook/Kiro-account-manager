// smartTruncate:无结构大段输出的兵底——保头保尾,中段换成一行计数提示。
//
// 为何头大于尾:命令输出的语义头(命令本身、文件头、前几条记录)信息密度最高,
// 而尾部通常是汇总/退出码类的关键收尾 —— 两头都不能丢,中段重复度最高。

import {
  FILTERS,
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_MIN_LINES,
  SMART_TRUNCATE_TAIL,
  defineFilter
} from '../constants'

export const smartTruncate = defineFilter(FILTERS.SMART_TRUNCATE, (input: string): string => {
  const lines = input.split('\n')
  // 行数不够就原样返回:改写历史内容是有代价的(破 prompt cache prefix),没收益就不改
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input

  const head = lines.slice(0, SMART_TRUNCATE_HEAD)
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL)
  const cut = lines.length - head.length - tail.length
  return [...head, `... +${cut} lines truncated`, ...tail].join('\n')
})
