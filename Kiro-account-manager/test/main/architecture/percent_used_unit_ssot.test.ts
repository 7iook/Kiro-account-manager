/**
 * Architecture fitness gate: `percentUsed` 的单位必须是 0~1 小数，唯一口径。
 *
 * 背景（本轮修的缺陷）: 这个字段曾经**同名两种单位并存** ——
 * `accountService/check.ts:127` 等写入点存 `current / limit`（小数），而
 * `RegisterPage.tsx` 四处存 `Math.round((current/limit) * 100)`（百分数）。
 * 显示层于是也分裂：`AccountCard` 乘 100、面板 `ProxyPanel` 不乘。
 * 用户看到的是「已用永远 0%」（小数账号走到不乘的显示点，0.42 被 round 成 0）。
 *
 * 为什么要静态闸门而不只是改代码: 缺陷形态是「写入侧单位漂移」，改完一遍不加
 * 约束，下一个人再写一次 `Math.round(x * 100)` 存进去就复现，且症状远离改动点
 * （在另一个界面显示 8500%）。这类问题靠 code review 抓不住 —— 单看那一行是对的。
 *
 * 判据: 禁止把含 `* 100` 的表达式赋给 `percentUsed`。
 * 允许: 读出后 `* 100` 用于**显示**（那是正确的换算方向，且已收口到
 * `_helpers.ts:usagePercentValue` / `webPanel/ui/format.ts:formatPercent`）。
 *
 * 输出有界: 违规行截断到前 20 条 + 折叠计数，避免失败信息淹没终端。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

/** 被扫描的写入侧文件（`percentUsed` 的所有已知赋值位置所在文件） */
const WRITE_SIDE_FILES = [
  'src/main/accountService/check.ts',
  'src/main/accountService/persistCheckResult.ts',
  'src/main/webPanel/dto.ts',
  'src/renderer/src/store/accounts.ts',
  'src/renderer/src/components/pages/RegisterPage.tsx',
  'src/renderer/src/components/accounts/AddAccountDialog.tsx',
  'src/renderer/src/components/accounts/EditAccountDialog.tsx'
]

/**
 * 匹配「给 percentUsed 赋一个含 *100 的表达式」。
 *
 * 只看 `percentUsed:` 之后到行尾（或下一个字段前）的片段里是否出现 `* 100`。
 * 跨行的三元表达式（本仓 RegisterPage 就是这种）单行匹配不到，所以下面对
 * 每个匹配点额外向后看 3 行 —— 赋值表达式跨行不会超过这个跨度。
 */
const ASSIGN_REGEX = /percentUsed\s*:/
const TIMES_100_REGEX = /\*\s*100\b/

const MAX_REPORTED = 20

function scanFile(relPath: string): string[] {
  const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
  const lines = src.split(/\r?\n/)
  const violations: string[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!ASSIGN_REGEX.test(lines[i])) continue
    // 纯注释行提及字段名不算赋值
    if (/^\s*(\*|\/\/)/.test(lines[i])) continue

    // 赋值表达式可能跨行，取当前行 + 后 3 行作为窗口
    const window = lines.slice(i, i + 4).join('\n')
    // 窗口里若含注释行，先剔掉注释再判断 —— 注释里解释「曾写 *100」是允许的
    const codeOnly = window
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n')

    if (TIMES_100_REGEX.test(codeOnly)) {
      violations.push(`${relPath}:${i + 1}: ${lines[i].trim()}`)
    }
  }
  return violations
}

function formatViolations(all: string[]): string {
  const shown = all.slice(0, MAX_REPORTED)
  const folded = all.length - shown.length
  const tail = folded > 0 ? `\n…另有 ${folded} 处未列出（共 ${all.length} 处）` : ''
  return shown.join('\n') + tail
}

describe('architecture: percentUsed 单位语义唯一（0~1 小数）', () => {
  it('写入侧禁止把 `* 100` 的结果存进 percentUsed', () => {
    const all = WRITE_SIDE_FILES.flatMap(scanFile)
    expect(
      all,
      `percentUsed 必须存 0~1 小数（\`current / limit\`），不得存百分数。\n` +
        `显示时才乘 100，且要走共用 helper（_helpers.ts:usagePercentValue / ` +
        `webPanel/ui/format.ts:formatPercent）。违规:\n${formatViolations(all)}`
    ).toEqual([])
  })

  it('sanity: 扫描目标文件都存在且确实含 percentUsed 赋值（防判定器空转）', () => {
    // 若某文件被重命名/删除，上一条会因为「零违规」而假绿。这里钉住扫描面非空。
    const filesWithAssignment = WRITE_SIDE_FILES.filter((p) => {
      const src = readFileSync(resolve(REPO_ROOT, p), 'utf-8')
      return ASSIGN_REGEX.test(src)
    })
    expect(filesWithAssignment.length).toBe(WRITE_SIDE_FILES.length)
  })
})
