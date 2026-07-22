/**
 * Architecture fitness gate: sharedModelCatalog 禁止用于账户能力路由决策路径.
 *
 * 背景: 决策卡 §附录 A Bug 3 明确禁止将跨账户共享的 sharedModelCatalog 用作
 * per-account 能力信号 - 它是 UI 展示兜底,不区分账号 provider/region,
 * 会把 A 账户支持的 GPT 错误路由到只有 Claude 的 B 账户.
 *
 * 白名单: proxyServer.handleModels 是 GET /v1/models 的 UI 层合并入口,
 * 允许读取 getSharedModelCatalogSnapshot() 来展示"曾拉到过的完整清单"给用户,
 * 但绝不参与账户选择决策 (getAvailableAccount 路径).
 *
 * 详见: .agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/decision-card.md §4.3
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

describe('architecture: sharedModelCatalog forbidden in routing paths', () => {
  it('accountPool.ts must not reference shared catalog', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/proxy/accountPool.ts'), 'utf-8')
    // 路由核心不允许出现任何 catalog 引用 (变量、getter、setter、renamed 版本)
    expect(src).not.toMatch(/sharedModelCatalog/)
    expect(src).not.toMatch(/getSharedModelCatalog/)
  })

  it('proxyServer.ts routing methods must not reference shared catalog (only handleModels allowed)', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/proxy/proxyServer.ts'), 'utf-8')
    const lines = src.split(/\r?\n/)
    const violations: string[] = []
    // 跟踪是否在 handleModels 方法体内部 (白名单):
    //   规则:遇到 `private async handleModels(` 起点 → inHandleModels=true;
    //         用花括号深度追踪函数体,深度归零 → 退出白名单.
    let inHandleModels = false
    let braceDepth = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/private\s+async\s+handleModels\s*\(/.test(line)) {
        inHandleModels = true
        braceDepth = 0
      }
      if (inHandleModels) {
        braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        // handleModels 的第一个 `{` 出现在其签名/参数行或紧接的行;braceDepth 落回 0 表示方法结束
        if (braceDepth <= 0 && /\}/.test(line)) {
          // 允许当前行(可能是 handleModels 的结束 `}`);之后行退出白名单
          inHandleModels = false
          continue
        }
      }
      if (!inHandleModels && /sharedModelCatalog|getSharedModelCatalog/.test(line)) {
        violations.push(`${i + 1}: ${line.trim()}`)
      }
    }
    expect(violations, `发现路由路径引用 sharedModelCatalog:\n${violations.join('\n')}`).toEqual([])
  })
})
