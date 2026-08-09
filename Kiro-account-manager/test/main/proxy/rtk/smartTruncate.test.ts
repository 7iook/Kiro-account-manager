// smartTruncate filter + 其 autodetect 边界

import { describe, it, expect } from 'vitest'
import { smartTruncate } from '@main/proxy/rtk/filters/smartTruncate'
import { autoDetectFilter } from '@main/proxy/rtk/autodetect'
import {
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_TAIL,
  SMART_TRUNCATE_MIN_LINES
} from '@main/proxy/rtk/constants'

function dump(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i} content`).join('\n')
}

describe('rtk/filters/smartTruncate', () => {
  it('保留头 HEAD 行 + 尾 TAIL 行,中段替换为一行截断提示', () => {
    const input = dump(1000)
    const out = smartTruncate(input)
    const lines = out.split('\n')

    expect(lines.length).toBe(SMART_TRUNCATE_HEAD + 1 + SMART_TRUNCATE_TAIL)
    expect(lines[0]).toBe('line 0 content')
    expect(lines[SMART_TRUNCATE_HEAD]).toBe(
      `... +${1000 - SMART_TRUNCATE_HEAD - SMART_TRUNCATE_TAIL} lines truncated`
    )
    expect(lines[lines.length - 1]).toBe('line 999 content')
    expect(out.length).toBeLessThan(input.length)
  })

  it('行数不足 SMART_TRUNCATE_MIN_LINES → 原样返回(不做无谓改写)', () => {
    const input = dump(SMART_TRUNCATE_MIN_LINES - 1)
    expect(smartTruncate(input)).toBe(input)
  })

  it('filterName = smart-truncate', () => {
    expect(smartTruncate.filterName).toBe('smart-truncate')
  })

  it('autodetect:无结构的大段行转储落到 smart-truncate', () => {
    expect(autoDetectFilter(dump(600))?.filterName).toBe('smart-truncate')
  })

  it('autodetect:行数不够的小块 → null(不值得动)', () => {
    expect(autoDetectFilter(dump(10))).toBeNull()
  })
})
