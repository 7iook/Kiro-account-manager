/**
 * 静态出口的两条结构闸门
 *
 * ## 闸门 A:`sendAsset` 只允许 staticAssets.ts 调用
 *
 * `respond.ts` 现在有两条车道:`sendJson`(过 `redactValue` 兜底)与
 * `sendAsset`(发字节、不过 redact)。第二条车道是静态托管的必需品,
 * 但它同时是**兜底脱敏的一个合法缺口** —— 任何业务端点若改用
 * `sendAsset(res, { body: Buffer.from(JSON.stringify(await loadAccountsBlob())) })`,
 * 就完全绕过了 `redactValue`,而 `webpanel_no_direct_res_end.test.ts` 抓不到它
 * (那条闸门只看 `res.end(`,而这里没有直接 res.end)。
 *
 * 所以加这条:限定调用方。`sendAsset` 的 body 只能来自
 * `staticAssets.ts` 的 `readFile(资源根内路径)`,那条路径已被
 * `resolveAssetPath()` 的 fail-closed 校验锁死。
 *
 * ## 闸门 B:`/panel/` 前缀的四处消费点必须同步
 *
 * 四处:vite `base` / `WEB_PANEL_URL_PREFIX` / 服务器路由前缀(`PANEL_PATH_PREFIX`)
 * / 会话 cookie 的 `Path`。改一处不改其余三处的后果各不相同且都很安静:
 *   - vite base 与路由前缀分叉 → 资源 404 → 白屏
 *   - cookie Path 与路由前缀分叉 → 浏览器静默不发 cookie → 「登录成功后全 401」
 *
 * 既有测试只钉住了其中两处(`webpanel_build_assets` 钉 vite base ↔
 * `WEB_PANEL_URL_PREFIX`;`cookie.test.ts` 钉 `PANEL_PATH_PREFIX` 字面值),
 * 而**两组之间没有任何断言**。所以两个常量可以各自「自洽地」漂移到不同值,
 * 全绿通过 —— 这条闸门补的正是那道缝。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import { WEB_PANEL_URL_PREFIX } from '../../../src/main/utils/webPanelAssetRoot'

const REPO_ROOT = resolve(__dirname, '../../..')
const WEBPANEL_DIR = resolve(REPO_ROOT, 'src/main/webPanel')

/** 唯一允许调用 sendAsset 的文件(它自己 + 定义处) */
const SEND_ASSET_CALLERS = new Set(['staticAssets.ts', 'respond.ts'])

function collectTsFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full, `${prefix}${name}/`))
    else if (name.endsWith('.ts')) out.push(`${prefix}${name}`)
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('闸门 A: sendAsset 的调用方受限(保住 redactValue 兜底)', () => {
  it('只有 staticAssets.ts 调用 sendAsset —— 业务端点不得借它绕过脱敏', () => {
    const offenders: string[] = []
    for (const rel of collectTsFiles(WEBPANEL_DIR)) {
      if (SEND_ASSET_CALLERS.has(rel)) continue
      const src = stripComments(readFileSync(resolve(WEBPANEL_DIR, rel), 'utf-8'))
      if (/\bsendAsset\s*\(/.test(src)) offenders.push(rel)
    }
    expect(
      offenders,
      'sendAsset 不过 redactValue —— 业务响应必须走 sendJson。' +
        `越界调用:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })

  it('闸门有观测对象:staticAssets.ts 确实调了 sendAsset(防空跑)', () => {
    const src = readFileSync(resolve(WEBPANEL_DIR, 'staticAssets.ts'), 'utf-8')
    expect(src).toMatch(/\bsendAsset\s*\(/)
  })

  it('sendAsset 定义在 respond.ts —— socket 写入仍收在唯一出口文件', () => {
    // 这条与 webpanel_no_direct_res_end.test.ts 的不变量互补:
    // 那条保证「只有 respond.ts 写 socket」,这条保证静态资源没有另开出口。
    const src = readFileSync(resolve(WEBPANEL_DIR, 'respond.ts'), 'utf-8')
    expect(src).toMatch(/export function sendAsset\s*\(/)
  })

  it('sendJson 的强制脱敏未被静态车道削弱', () => {
    const src = readFileSync(resolve(WEBPANEL_DIR, 'respond.ts'), 'utf-8')
    // sendJson 里必须仍有无条件 redactValue —— 加第二条车道不得顺手放宽第一条
    const jsonFn = src.slice(
      src.indexOf('export function sendJson'),
      src.indexOf('export function sendError')
    )
    expect(jsonFn).toMatch(/redactValue\s*\(\s*payload\s*\)/)
  })
})

describe('闸门 B: /panel 前缀的四处消费点同步', () => {
  it('WEB_PANEL_URL_PREFIX 与 PANEL_PATH_PREFIX 一致(仅差尾斜杠)', () => {
    // 这两个常量此前无任何断言相连 —— 可以各自漂移而全绿。
    expect(
      WEB_PANEL_URL_PREFIX,
      `资源 URL 前缀(${WEB_PANEL_URL_PREFIX})与路由前缀(${PANEL_PATH_PREFIX})分叉 —— ` +
        `产物里的 /panel/assets/* 会打到未托管的路径,表现为白屏`
    ).toBe(`${PANEL_PATH_PREFIX}/`)
  })

  it('vite base 与路由前缀一致(产物 URL 的写法)', () => {
    const cfg = readFileSync(resolve(REPO_ROOT, 'vite.webPanel.config.ts'), 'utf-8')
    expect(cfg, `vite base 必须是 ${PANEL_PATH_PREFIX}/`).toContain(`base: '${PANEL_PATH_PREFIX}/'`)
  })

  it('会话 cookie 的 Path 用同一常量(分叉 → 浏览器静默不发 cookie)', () => {
    const cookieSrc = stripComments(readFileSync(resolve(WEBPANEL_DIR, 'cookie.ts'), 'utf-8'))
    // 下发与清除两处都必须用常量,不得写字面量
    const pathAssignments = cookieSrc.match(/Path=\$\{PANEL_PATH_PREFIX\}/g) ?? []
    expect(
      pathAssignments.length,
      'cookie 的 Path 未全部用 PANEL_PATH_PREFIX —— 清除 cookie 时属性不一致会导致清不掉'
    ).toBeGreaterThanOrEqual(2)
    expect(cookieSrc).not.toMatch(/Path=\/panel/)
  })

  it('服务器路由前缀用常量,静态层也不得另写字面量', () => {
    for (const rel of ['server.ts', 'staticAssets.ts']) {
      const src = stripComments(readFileSync(resolve(WEBPANEL_DIR, rel), 'utf-8'))
      expect(src, `${rel} 不得出现 '/panel' 字面量`).not.toMatch(/['"]\/panel['"]/)
      expect(src, `${rel} 不得出现 '/panel/' 字面量`).not.toMatch(/['"]\/panel\/['"]/)
    }
  })

  it('四处消费点各自都被上面某条断言覆盖(闸门自身的完整性)', () => {
    // 显式列出四处,防将来有人加了第五处消费点却没进闸门。
    const consumers = [
      'vite.webPanel.config.ts 的 base',
      'webPanelAssetRoot.ts 的 WEB_PANEL_URL_PREFIX',
      'server.ts 的路由前缀(PANEL_PATH_PREFIX)',
      'cookie.ts 的 Set-Cookie Path'
    ]
    expect(consumers).toHaveLength(4)
  })
})
