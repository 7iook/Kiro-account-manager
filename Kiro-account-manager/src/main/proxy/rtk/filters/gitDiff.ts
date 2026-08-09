// gitDiff:压缩 unified diff(移植 9router filters/gitDiff.js · 源头是 rtk Rust git::compact_diff)
//
// 保留的信息量:哪些文件 · 哪些 hunk 头 · 增删正文 · 每文件 +X -Y 汇总。
// 丢掉的:index/---/+++ 噪声行 · 超限的 hunk 尾部 · 超总行数上限的尾部。
// 真实案例参照:28 文件 1800 行 → 文件列表 + hunk 头 + 逐文件增删数,模型仍能说出「改了什么」。

import {
  FILTERS,
  GIT_DIFF_HUNK_MAX_LINES,
  GIT_DIFF_MAX_OUTPUT_LINES,
  defineFilter
} from '../constants'

export const gitDiff = defineFilter(FILTERS.GIT_DIFF, (diff: string): string => {
  const out: string[] = []
  let currentFile = ''
  let added = 0
  let removed = 0
  let inHunk = false
  let hunkShown = 0
  let hunkSkipped = 0
  let wasTruncated = false

  /** 刷出当前 hunk 被丢掉的行数 */
  const flushHunkSkipped = (): void => {
    if (hunkSkipped > 0) {
      out.push(`  ... (${hunkSkipped} lines truncated)`)
      wasTruncated = true
      hunkSkipped = 0
    }
  }

  /** 刷出当前文件的 +X -Y 汇总(无变更则不输) */
  const flushFileSummary = (): void => {
    if (currentFile && (added > 0 || removed > 0)) {
      out.push(`  +${added} -${removed}`)
    }
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flushHunkSkipped()
      flushFileSummary()
      // "diff --git a/x b/x" → 取 " b/" 之后作为文件名(路径含空格时 join 回去)
      const parts = line.split(' b/')
      currentFile = parts.length > 1 ? parts.slice(1).join(' b/') : 'unknown'
      out.push(`\n${currentFile}`)
      added = 0
      removed = 0
      inHunk = false
      hunkShown = 0
    } else if (line.startsWith('@@')) {
      flushHunkSkipped()
      inHunk = true
      hunkShown = 0
      out.push(`  ${line}`)
    } else if (inHunk) {
      const isAdd = line.startsWith('+') && !line.startsWith('+++')
      const isDel = line.startsWith('-') && !line.startsWith('---')
      if (isAdd || isDel) {
        if (isAdd) added += 1
        else removed += 1
        // 计数无上限(汇总要准),展示有上限
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) {
          out.push(`  ${line}`)
          hunkShown += 1
        } else {
          hunkSkipped += 1
        }
      } else if (hunkShown > 0 && hunkShown < GIT_DIFF_HUNK_MAX_LINES && !line.startsWith('\\')) {
        // 上下文行:只在已经输过改动行后保留(hunk 开头的纯上下文无信息量)
        out.push(`  ${line}`)
        hunkShown += 1
      }
    }

    if (out.length >= GIT_DIFF_MAX_OUTPUT_LINES) {
      out.push('\n... (more changes truncated)')
      wasTruncated = true
      return finish(out, wasTruncated)
    }
  }

  flushHunkSkipped()
  flushFileSummary()
  return finish(out, wasTruncated)
})

function finish(out: string[], wasTruncated: boolean): string {
  if (wasTruncated) out.push('[compressed by proxy: rerun the command to see the full diff]')
  return out.join('\n')
}
