/**
 * Architecture fitness gate: webPanel 鉴权层的结构性约束。
 *
 * 这些是**编译期拦不住**的约束,只能靜态断言:
 *   ① webPanel/ 与 utils/netGuard.ts 不得 import electron
 *      —— 面板路径无 BrowserWindow,且 vitest node env 加载不了 electron;
 *      一旦有人 import,受影响的是整个 test/main 套件而非仅新代码。
 *   ② 会话比较必须走 safeStringEq,不得出现裸 === 比 adminKey。
 *   ③ 会话 token 不得用 uuid(122 bit 且格式可预测)。
 *   ④ 会话不得落盘(electron-store)。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const PANEL_DIR = resolve(REPO_ROOT, 'src/main/webPanel')

function panelFiles(): { name: string; src: string }[] {
  return readdirSync(PANEL_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, src: readFileSync(join(PANEL_DIR, name), 'utf-8') }))
}

describe('architecture: webPanel 鉴权层约束', () => {
  it('webPanel/ 下存在待检查文件(防止 glob 空跑导致假绿)', () => {
    const files = panelFiles()
    expect(files.length, 'webPanel/ 无 .ts 文件,本闸门将无条件通过 = 假绿').toBeGreaterThan(0)
  })

  it('webPanel/ 不得 import electron', () => {
    const violations: string[] = []
    for (const { name, src } of panelFiles()) {
      if (/from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(src)) {
        violations.push(name)
      }
    }
    expect(violations, `以下文件 import 了 electron:\n${violations.join('\n')}`).toEqual([])
  })

  it('utils/netGuard.ts 不得 import electron(代理与面板共用的纯原语)', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/utils/netGuard.ts'), 'utf-8')
    expect(src).not.toMatch(/from\s+['"]electron['"]/)
  })

  it('adminKey 比较必须走 safeStringEq,不得裸比较', () => {
    const src = readFileSync(join(PANEL_DIR, 'auth.ts'), 'utf-8')
    expect(src, 'auth.ts 必须 import safeStringEq').toMatch(/safeStringEq/)
    // 禁止对 adminKey 做 === / !== 直接比较(时序泄漏)
    expect(src).not.toMatch(/adminKey\s*(===|!==)/)
    expect(src).not.toMatch(/(===|!==)\s*adminKey/)
  })

  it('会话 token 不得用 uuid(熵不足且格式可预测)', () => {
    for (const { name, src } of panelFiles()) {
      expect(src, `${name} 不应 import uuid`).not.toMatch(/from\s+['"]uuid['"]/)
    }
    const session = readFileSync(join(PANEL_DIR, 'session.ts'), 'utf-8')
    expect(session).toMatch(/randomBytes\(\s*32\s*\)/)
  })

  it('会话不得落盘(不得 import electron-store)', () => {
    for (const { name, src } of panelFiles()) {
      // 检查的是 import/require,不是注释里提及 —— auth.ts 的 AdminKeyStore 注释
      // 需要说明「由 index.ts 用 electron-store 实现并注入」,那是正确的依赖倒置,
      // 不是违规。闸门必须精确到导入语句,否则会误伤文档。
      expect(src, `${name} 不应 import electron-store`).not.toMatch(
        /from\s+['"]electron-store['"]|require\(\s*['"]electron-store['"]\s*\)/
      )
    }
  })
})
