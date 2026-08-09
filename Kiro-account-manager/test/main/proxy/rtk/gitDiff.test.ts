// gitDiff filter + 其 autodetect 边界

import { describe, it, expect } from 'vitest'
import { gitDiff } from '@main/proxy/rtk/filters/gitDiff'
import { autoDetectFilter } from '@main/proxy/rtk/autodetect'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@ function a()',
  ' const keep = 1',
  '-const old = 2',
  '+const neo = 2',
  '+const extra = 3',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,2 +10,2 @@ function b()',
  '-let x',
  '+let y'
].join('\n')

describe('rtk/filters/gitDiff', () => {
  it('保留文件名与 hunk 头,给出 +X -Y 汇总', () => {
    const out = gitDiff(DIFF)
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/b.ts')
    expect(out).toContain('@@ -1,3 +1,4 @@ function a()')
    expect(out).toContain('@@ -10,2 +10,2 @@ function b()')
    expect(out).toContain('+2 -1') // a.ts:2 增 1 删
    expect(out).toContain('+1 -1') // b.ts:1 增 1 删
  })

  it('丢掉 index / --- / +++ 噪声行,保留增删正文', () => {
    const out = gitDiff(DIFF)
    expect(out).not.toContain('index 1111111')
    expect(out).not.toContain('--- a/src/a.ts')
    expect(out).not.toContain('+++ b/src/a.ts')
    expect(out).toContain('-const old = 2')
    expect(out).toContain('+const neo = 2')
  })

  it('单 hunk 超过 GIT_DIFF_HUNK_MAX_LINES → 截断并注明丢了多少行', () => {
    const lines = ['diff --git a/big.ts b/big.ts', '@@ -1,400 +1,400 @@']
    for (let i = 0; i < 200; i++) {
      lines.push(`-old${i}`)
      lines.push(`+new${i}`)
    }
    const out = gitDiff(lines.join('\n'))
    expect(out).toMatch(/\.\.\. \(\d+ lines truncated\)/)
    expect(out).toContain('+200 -200') // 汇总仍统计全量
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('输出行数触顶 → 尾部给出「更多改动被截断」提示', () => {
    const lines: string[] = []
    for (let f = 0; f < 40; f++) {
      lines.push(`diff --git a/f${f}.ts b/f${f}.ts`)
      lines.push('@@ -1,40 +1,40 @@')
      for (let i = 0; i < 20; i++) {
        lines.push(`-o${i}`)
        lines.push(`+n${i}`)
      }
    }
    const out = gitDiff(lines.join('\n'))
    expect(out).toContain('more changes truncated')
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('filterName = git-diff', () => {
    expect(gitDiff.filterName).toBe('git-diff')
  })

  it('autodetect:git diff 必须被 gitDiff 抓走,不许被 grep 抢', () => {
    expect(autoDetectFilter(DIFF)?.filterName).toBe('git-diff')
  })

  it('autodetect:只有 @@ hunk 头、没有 diff --git 也判 git-diff', () => {
    const hunkOnly = ['@@ -1,2 +1,2 @@', '-a', '+b'].join('\n')
    expect(autoDetectFilter(hunkOnly)?.filterName).toBe('git-diff')
  })

  it('autodetect:带 file:line: 形态正文的 git diff 仍判 git-diff(优先级硬序)', () => {
    const tricky = [
      'diff --git a/log.ts b/log.ts',
      '@@ -1,2 +1,2 @@',
      '-src/x.ts:12:boom',
      '+src/x.ts:13:boom'
    ].join('\n')
    expect(autoDetectFilter(tricky)?.filterName).toBe('git-diff')
  })
})
