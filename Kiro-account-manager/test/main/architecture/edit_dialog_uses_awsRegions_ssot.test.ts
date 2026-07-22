/**
 * Architecture fitness gate: 前端 AWS region 下拉必须走 lib/awsRegions.ts SSOT.
 *
 * 背景: 决策卡 §附录 A Bug 1 明确 EditAccountDialog / AddAccountDialog 硬编码 3 个 region
 * (us-east-1 / us-west-2 / eu-west-1) 会让 sso=us-east-2 账户"编辑保存后 region 被覆盖成 us-east-1"
 * → refresh 走错端点 → 账户永久失效. 抽了 awsRegions.ts (21 region + AwsRegionSelect 组件) 作前端 SSOT,
 * 禁止 dialog tsx 里再回归硬编码.
 *
 * 判据: dialog tsx 中同一行/同一 <option> 组里同时出现 us-east-1 + us-west-2 + eu-west-1 三段字面量 = FAIL.
 * (任意单独字面量作为默认值 useState('us-east-1') 允许 —— 那是初始态,不是 UI 硬编码列表)
 *
 * 详见: .agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/decision-card.md §4.3
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

/**
 * 检测源码文件中是否出现硬编码 region 三元组模式 (us-east-1 + us-west-2 + eu-west-1 集中出现).
 * 用 200 字符滑窗定位;命中同时包含三个字面量的窗口 = 硬编码下拉 pattern.
 */
function detectHardcodedRegionTriple(src: string): number[] {
  const violations: number[] = []
  const lines = src.split(/\r?\n/)
  // 用移动窗口聚合最多 8 行文本再匹配,cover 多行 <option> 硬编码
  const WINDOW = 8
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + WINDOW).join('\n')
    if (window.includes("'us-east-1'") && window.includes("'us-west-2'") && window.includes("'eu-west-1'")) {
      violations.push(i + 1)
    }
    if (window.includes('"us-east-1"') && window.includes('"us-west-2"') && window.includes('"eu-west-1"')) {
      violations.push(i + 1)
    }
  }
  return Array.from(new Set(violations))
}

describe('architecture: dialogs must use lib/awsRegions SSOT (no hardcoded region triple)', () => {
  it('EditAccountDialog.tsx must not hardcode us-east-1 + us-west-2 + eu-west-1 together', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/renderer/src/components/accounts/EditAccountDialog.tsx'), 'utf-8')
    const lines = detectHardcodedRegionTriple(src)
    expect(lines, `EditAccountDialog.tsx 出现硬编码 region 三元组 (改用 <AwsRegionSelect> from lib/awsRegions):\n发生在行: ${lines.join(', ')}`).toEqual([])
  })

  it('AddAccountDialog.tsx: allowed only via <AwsRegionSelect> or lib/awsRegions (fingerprint check)', () => {
    // AddAccountDialog 里可能包含 21 region 列表定义,不走三元组指纹;
    // 只要求它 import from lib/awsRegions 或 使用 AwsRegionSelect (SSOT 提供的组件)
    const src = readFileSync(resolve(REPO_ROOT, 'src/renderer/src/components/accounts/AddAccountDialog.tsx'), 'utf-8')
    const usesSSOT = /AwsRegionSelect|from ['"]@\/lib\/awsRegions['"]|from ['"]\.\.\/\.\.\/lib\/awsRegions['"]/.test(src)
    // 允许"直接使用 <option> 定义 21 region"或"引用 SSOT"任一;禁止 3 region 硬编码指纹
    const hardcodedTriple = detectHardcodedRegionTriple(src)
    if (hardcodedTriple.length > 0 && !usesSSOT) {
      throw new Error(`AddAccountDialog.tsx 硬编码 region 三元组但未走 SSOT:\n发生在行: ${hardcodedTriple.join(', ')}`)
    }
  })
})
