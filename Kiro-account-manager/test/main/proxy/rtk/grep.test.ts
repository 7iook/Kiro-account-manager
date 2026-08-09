// grep filter + 其 autodetect 边界

import { describe, it, expect } from 'vitest'
import { grep } from '@main/proxy/rtk/filters/grep'
import { autoDetectFilter } from '@main/proxy/rtk/autodetect'
import { GREP_PER_FILE_MAX } from '@main/proxy/rtk/constants'

const GREP_OUT = [
  'src/a.ts:12:  const hit = 1',
  'src/a.ts:34:  const hit = 2',
  'src/b.ts:7:  hit again',
  'noise line without pattern'
].join('\n')

describe('rtk/filters/grep', () => {
  it('按文件分组并给出总命中数', () => {
    const out = grep(GREP_OUT)
    expect(out.startsWith('3 matches in 2F:')).toBe(true)
    expect(out).toContain('[file] src/a.ts (2):')
    expect(out).toContain('[file] src/b.ts (1):')
    expect(out).toContain('12: const hit = 1')
  })

  it('单文件命中超过 GREP_PER_FILE_MAX → 只留前 N 条并注明剩余数', () => {
    const lines = Array.from(
      { length: GREP_PER_FILE_MAX + 5 },
      (_, i) => `src/x.ts:${i + 1}:hit ${i}`
    )
    const out = grep(lines.join('\n'))
    expect(out).toContain(`[file] src/x.ts (${GREP_PER_FILE_MAX + 5}):`)
    expect(out).toContain('+5')
    expect(out).not.toContain(`hit ${GREP_PER_FILE_MAX + 4}`)
  })

  it('零命中 → 原样返回(不吞内容)', () => {
    const input = 'nothing\nlooks\nlike grep here'
    expect(grep(input)).toBe(input)
  })

  it('冒号只出现一次或行号非数字 → 该行不算命中', () => {
    const input = 'src/a.ts:notanumber:x\nsrc/b.ts only-one-colon:\nsrc/c.ts:9:real'
    const out = grep(input)
    expect(out.startsWith('1 matches in 1F:')).toBe(true)
    expect(out).toContain('src/c.ts')
  })

  it('filterName = grep', () => {
    expect(grep.filterName).toBe('grep')
  })

  it('autodetect:grep 形态判 grep', () => {
    const many = Array.from({ length: 300 }, (_, i) => `src/f${i % 5}.ts:${i}:hit ${i}`).join('\n')
    expect(autoDetectFilter(many)?.filterName).toBe('grep')
  })

  it('autodetect:行号转储不许被 grep 抢(  N|content 不是 file:line:)', () => {
    const numbered = Array.from({ length: 600 }, (_, i) => `${i + 1}|const v = ${i}`).join('\n')
    expect(autoDetectFilter(numbered)?.filterName).toBe('read-numbered')
  })
})
