// readNumbered filter + 其 autodetect 边界(命中率阈值)

import { describe, it, expect } from 'vitest'
import { readNumbered } from '@main/proxy/rtk/filters/readNumbered'
import { autoDetectFilter } from '@main/proxy/rtk/autodetect'
import {
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_TAIL,
  SMART_TRUNCATE_MIN_LINES
} from '@main/proxy/rtk/constants'

/** 行号文件转储:"  N|content" */
function numbered(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `${String(i + 1).padStart(5)}|const v${i} = ${i}`
  ).join('\n')
}

describe('rtk/filters/readNumbered', () => {
  it('保留头尾行号段,中段给出「文件继续」提示', () => {
    const input = numbered(900)
    const out = readNumbered(input)
    const lines = out.split('\n')

    expect(lines.length).toBe(SMART_TRUNCATE_HEAD + 1 + SMART_TRUNCATE_TAIL)
    expect(lines[0]).toContain('|const v0 = 0')
    expect(lines[SMART_TRUNCATE_HEAD]).toContain('lines truncated (file continues)')
    expect(lines[lines.length - 1]).toContain('|const v899 = 899')
    expect(out.length).toBeLessThan(input.length)
  })

  it('行数不足 → 原样返回', () => {
    const input = numbered(SMART_TRUNCATE_MIN_LINES - 1)
    expect(readNumbered(input)).toBe(input)
  })

  it('filterName = read-numbered', () => {
    expect(readNumbered.filterName).toBe('read-numbered')
  })

  it('autodetect:行号转储判 read-numbered(而非 smart-truncate)', () => {
    expect(autoDetectFilter(numbered(600))?.filterName).toBe('read-numbered')
  })

  it('autodetect:命中率低于阈值 → 不判 read-numbered,退回 smart-truncate', () => {
    const lines: string[] = []
    for (let i = 0; i < 600; i++) {
      lines.push(i % 2 === 0 ? `${i}|numbered ${i}` : `plain prose line ${i}`)
    }
    expect(autoDetectFilter(lines.join('\n'))?.filterName).toBe('smart-truncate')
  })

  it('尾行不足 TAIL 时也不越界', () => {
    const out = readNumbered(numbered(SMART_TRUNCATE_MIN_LINES))
    expect(out.split('\n').length).toBe(SMART_TRUNCATE_HEAD + 1 + SMART_TRUNCATE_TAIL)
  })
})
