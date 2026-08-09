// safeApply:单个 filter 抛错时的安全网(压缩失败必须退化为原文,而不是丢内容)

import { describe, it, expect, vi, afterEach } from 'vitest'
import { safeApply } from '@main/proxy/rtk/applyFilter'
import type { RtkFilter } from '@main/proxy/rtk/constants'

function asFilter(fn: (input: string) => unknown, name: string): RtkFilter {
  return Object.assign(fn as (input: string) => string, { filterName: name })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rtk/applyFilter · safeApply', () => {
  it('filter 抛错 → 返回原文,不抛给上层', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boom = asFilter(() => {
      throw new Error('filter exploded')
    }, 'boom')

    expect(safeApply(boom, 'raw payload')).toBe('raw payload')
    expect(console.warn).toHaveBeenCalled()
  })

  it('filter 返回非字符串 → 返回原文', () => {
    const weird = asFilter(() => 42, 'weird')
    expect(safeApply(weird, 'raw')).toBe('raw')
  })

  it('filter 正常 → 返回其输出', () => {
    const ok = asFilter((input: string) => input.slice(0, 3), 'ok')
    expect(safeApply(ok, 'abcdef')).toBe('abc')
  })
})
