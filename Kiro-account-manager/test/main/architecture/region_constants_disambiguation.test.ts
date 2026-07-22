/**
 * Architecture fitness gate: 区分 KNOWN_CW_DATA_REGIONS vs KNOWN_SSO_OIDC_REGIONS 概念,
 * 禁止在 SSO OIDC 场景引用已弃用的 KNOWN_CW_REGIONS 别名.
 *
 * 背景: 决策卡 §附录 A Bug 2 明确二者语义不同 —— KNOWN_CW_DATA_REGIONS 只有 2 个 CW profile region,
 * 而 KNOWN_SSO_OIDC_REGIONS 覆盖 21 个 AWS 区域. 在 refresh OIDC token / IAM SSO 探测时用错者
 * 会让 sso=us-east-2 的账户 refresh 探不到目标 region → 永久失效.
 *
 * 白名单: kiroApi.ts 里的 alias 定义 `export const KNOWN_CW_REGIONS = KNOWN_CW_DATA_REGIONS`
 * 及 JSDoc / 注释文本 允许保留;新增业务代码禁引用此别名.
 *
 * 详见: .agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/decision-card.md §4.3
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

const FORBIDDEN_ALIAS_REGEX = /KNOWN_CW_REGIONS(?!_DATA)/

describe('architecture: region constants disambiguation', () => {
  it('index.ts must not import or use KNOWN_CW_REGIONS (SSO OIDC path)', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/index.ts'), 'utf-8')
    const lines = src.split(/\r?\n/)
    const violations: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 允许纯注释行提及历史概念,过滤代码级引用
      if (/^\s*\*|^\s*\/\//.test(line)) continue
      if (FORBIDDEN_ALIAS_REGEX.test(line)) {
        violations.push(`${i + 1}: ${line.trim()}`)
      }
    }
    expect(violations, `index.ts 引用 KNOWN_CW_REGIONS (应改用 KNOWN_SSO_OIDC_REGIONS 或 KNOWN_CW_DATA_REGIONS):\n${violations.join('\n')}`).toEqual([])
  })

  it('oidcRefresh.ts must not reference KNOWN_CW_REGIONS in runtime code', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/oidcRefresh.ts'), 'utf-8')
    const lines = src.split(/\r?\n/)
    const violations: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 允许注释解释历史(oidcRefresh.ts 顶部有一段警示注释)
      if (/^\s*\*|^\s*\/\//.test(line)) continue
      if (FORBIDDEN_ALIAS_REGEX.test(line)) {
        violations.push(`${i + 1}: ${line.trim()}`)
      }
    }
    expect(violations, `oidcRefresh.ts 引用 KNOWN_CW_REGIONS:\n${violations.join('\n')}`).toEqual([])
  })

  it('kiroApi.ts alias definition is allowed (backward compat only)', () => {
    // sanity: 别名定义存在 + 明确弃用注释,防误删导致下游 breakage
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/proxy/kiroApi.ts'), 'utf-8')
    expect(src).toMatch(/@deprecated[\s\S]{0,400}KNOWN_CW_REGIONS/)
    expect(src).toMatch(/export const KNOWN_CW_REGIONS[^=\n]*=\s*KNOWN_CW_DATA_REGIONS/)
  })
})
