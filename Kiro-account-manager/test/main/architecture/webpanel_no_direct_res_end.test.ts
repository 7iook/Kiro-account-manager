/**
 * Architecture fitness gate: `src/main/webPanel/` 下禁止直接调用 `res.end(` / `res.write(`,
 * 一律经 `respond.ts` 的 `sendJson()` / `sendError()` 出口。
 *
 * ## 为什么这条闸门是承重的，不是锦上添花
 *
 * `accountService/accounts.ts:20 loadAccounts()` 返回 `Promise<unknown>` —— 整表 blob
 * （含全量明文凭据）原样出盘。这意味着：
 *
 *   res.end(JSON.stringify(await loadAccounts(deps)))   // ← TypeScript 完全不报错
 *
 * `unknown` 让编译期**零保护**：把内部对象直接丢给 socket 是合法 TS。
 * 而 `sendJson()` 只是个约定 —— 约定是可选的，可选的东西必然被绕过
 * （下一个写 `/panel/api/accounts/:id/export` 的人完全可以不调它）。
 *
 * 所以静态断言是唯一能把"不得绕过咽喉点"从愿望变成事实的机制（Globalrules §4.9 Layer-1）。
 *
 * ## 白名单
 *
 * `respond.ts` 自身必须调 `res.end()` —— 它就是那个唯一出口。
 *
 * 详见：`.agent-workspace/.archive/2026-08-03/web-panel-lan-access/web-panel-decision-card.md` §3
 *      `recon-http-layer.md` §3.3 / §3.4
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const WEBPANEL_DIR = resolve(REPO_ROOT, 'src/main/webPanel')

/** 唯一允许直接操作 socket 的文件 —— 它就是咽喉点本身 */
const ALLOWED_FILES = new Set(['respond.ts'])

/** 失败输出上限：违规多时只列前 N 条 + 折叠计数，避免刷屏淹没真正的信息 */
const MAX_REPORTED = 10

/** 直接写 socket 的调用：`res.end(` / `res.write(` / `response.end(` / `writeHead(` */
const DIRECT_SOCKET_WRITE = /\b(?:res|response|serverResponse)\s*\.\s*(?:end|write|writeHead)\s*\(/

interface Violation {
  file: string
  line: number
  text: string
}

/** 递归收集 webPanel 目录下的 .ts 文件（相对 webPanel 的路径） */
function collectTsFiles(dir: string, prefix = ''): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // 目录尚不存在（本轮之前 webPanel 还没落地）→ 无文件可查
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full, `${prefix}${name}/`))
    } else if (name.endsWith('.ts')) {
      out.push(`${prefix}${name}`)
    }
  }
  return out
}

function scanViolations(): { violations: Violation[]; scanned: string[] } {
  const files = collectTsFiles(WEBPANEL_DIR)
  const violations: Violation[] = []
  for (const rel of files) {
    if (ALLOWED_FILES.has(rel)) continue
    const src = readFileSync(resolve(WEBPANEL_DIR, rel), 'utf-8')
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 跳过注释行：文档里提到 `res.end(` 作为反面教材是合法的
      if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue
      if (DIRECT_SOCKET_WRITE.test(line)) {
        violations.push({ file: rel, line: i + 1, text: line.trim() })
      }
    }
  }
  return { violations, scanned: files }
}

function formatViolations(violations: Violation[]): string {
  const shown = violations.slice(0, MAX_REPORTED)
  const lines = shown.map((v) => `  ${v.file}:${v.line}  ${v.text}`)
  if (violations.length > MAX_REPORTED) {
    lines.push(`  …以及另外 ${violations.length - MAX_REPORTED} 处（共 ${violations.length} 处）`)
  }
  return lines.join('\n')
}

describe('architecture: webPanel 必须经 sendJson 出口', () => {
  it('webPanel/ 下（respond.ts 除外）不得直接调用 res.end / res.write / res.writeHead', () => {
    const { violations } = scanViolations()
    expect(
      violations,
      `webPanel 下发现绕过 sendJson() 的直接 socket 写入 —— ` +
        `loadAccounts() 返回 unknown，编译期拦不住内部对象直出，这条闸门是唯一防线：\n${formatViolations(violations)}`
    ).toEqual([])
  })

  it('闸门自身有观测对象：webPanel 目录存在且含 respond.ts（防闸门空跑）', () => {
    // 这条断言治的是"闸门存在、看起来正确、但结构上无法观测它声称检查的东西"：
    // 若 webPanel 目录被移走 / 改名，上一条会因扫到 0 个文件而永远绿。
    const files = collectTsFiles(WEBPANEL_DIR)
    expect(files.length, 'webPanel 目录为空 —— 上一条闸门在空跑').toBeGreaterThan(0)
    expect(files).toContain('respond.ts')
  })

  it('respond.ts 确实是唯一出口：它自己调 res.end 且过 redactValue', () => {
    const src = readFileSync(resolve(WEBPANEL_DIR, 'respond.ts'), 'utf-8')
    expect(src).toMatch(/res\.end\(/)
    // 兜底脱敏必须在场；被删掉时这条会红（Layer-1 守住 respond.ts 自身不退化）
    expect(src).toMatch(/redactValue\s*\(/)
    expect(src).toMatch(/from '\.\.\/utils\/redact'/)
  })
})
