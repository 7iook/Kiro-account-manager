/**
 * 生产装配闭环闸门 —— 防 E-052「建而未接」
 *
 * 这个项目反复出现的失败模式是:模块写好了、单测全绿、**生产路径没有任何调用者**。
 * `webPanel/` 六个模块在本轮之前正是这个状态(零 production caller)。
 *
 * 单测绿 ≠ 接通。所以这条闸门用**静态断言**检查 `src/main/index.ts` 里确实存在
 * 生产调用点,而不是相信「我记得接了」。判据全部排除 `tests/` 目录 ——
 * 只在测试里被调用的代码就是死代码。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const INDEX_TS = resolve(REPO_ROOT, 'src/main/index.ts')
const WIRING_TS = resolve(REPO_ROOT, 'src/main/ipc/webPanelWiring.ts')

function readIndex(): string {
  return readFileSync(INDEX_TS, 'utf-8')
}

/** 去掉行注释与块注释，避免「注释里提到了」被当成真实调用 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('装配闭环: webPanel 在生产路径上确有调用者', () => {
  it('index.ts 确实 import 了 WebPanelWiring(不是只存在于测试)', () => {
    const src = stripComments(readIndex())
    expect(src).toMatch(/import\s*\{[^}]*WebPanelWiring[^}]*\}\s*from\s*'\.\/ipc\/webPanelWiring'/)
  })

  it('index.ts 确实构造了 WebPanelWiring 并注册了 IPC', () => {
    const src = stripComments(readIndex())
    expect(src, 'WebPanelWiring 未被 new —— 模块建了但没装配').toMatch(/new\s+WebPanelWiring\s*\(/)
    expect(src, 'registerIpcHandlers 未被调用 —— 设置页无法开关面板').toMatch(
      /webPanelWiring\.registerIpcHandlers\s*\(\s*\)/
    )
  })

  it('AdminKeyStore 经 electron-store 实现并注入(auth.ts 刻意不依赖 electron)', () => {
    const wiring = stripComments(readFileSync(WIRING_TS, 'utf-8'))
    // 装配方必须提供 get/set 两侧,并把它交给 PanelAuth 构造
    expect(wiring).toMatch(/createAdminKeyStore\s*\(\s*\)\s*:\s*AdminKeyStore/)
    expect(wiring).toMatch(/new\s+PanelAuth\s*\(\s*this\.createAdminKeyStore\s*\(\s*\)/)
    // 读写走的是 store 的同一个键,否则「显示了密钥但盘上没有」
    expect(wiring).toMatch(/ADMIN_KEY_STORE_KEY/)
  })

  it('自启动挂在 ready-to-show 上(照反代先例),且在生产路径而非测试里', () => {
    const src = stripComments(readIndex())
    expect(src).toMatch(/autoStartIfConfigured\s*\(\s*\)/)
    // 自启动调用必须出现在 ready-to-show 回调之后
    const readyIdx = src.indexOf("ready-to-show")
    const autoIdx = src.indexOf('autoStartIfConfigured')
    expect(readyIdx, 'ready-to-show 钩子不存在').toBeGreaterThan(-1)
    expect(autoIdx, '自启动调用点不存在').toBeGreaterThan(readyIdx)
  })

  it('退出清理挂在 will-quit 上,且在 preventDefault 分支之外', () => {
    const src = stripComments(readIndex())
    const quitIdx = src.indexOf("app.on('will-quit'")
    expect(quitIdx, 'will-quit 钩子不存在').toBeGreaterThan(-1)
    // 只在 will-quit 回调这一段里找 —— `if (lastSavedData && store)` 在本文件里出现两次
    // (另一处是关窗 flush),全局 indexOf 会命中错的那个并给出假失败。
    const quitBlock = src.slice(quitIdx)
    const disposeIdx = quitBlock.indexOf('webPanelWiring?.dispose()')
    const branchIdx = quitBlock.indexOf('if (lastSavedData && store)')
    expect(disposeIdx, 'dispose 调用点不在 will-quit 内 —— server 与 timer 会泄漏').toBeGreaterThan(
      -1
    )
    expect(branchIdx, 'will-quit 内未找到 preventDefault 分支').toBeGreaterThan(-1)
    expect(
      disposeIdx,
      'dispose 落在 preventDefault 分支内 —— lastSavedData 为空时不会执行'
    ).toBeLessThan(branchIdx)
  })

  it('dispose 真的收了三样:server / 会话清扫 / 限流清扫', () => {
    const wiring = stripComments(readFileSync(WIRING_TS, 'utf-8'))
    expect(wiring).toMatch(/async\s+dispose\s*\(\s*\)/)
    expect(wiring).toMatch(/this\.server\.stop\s*\(/)
    expect(wiring).toMatch(/sessionStore\.stopSweeping\s*\(\s*\)/)
    // 限流 timer 的停止在 server.stop() 内(stopTimers),这里断言那条链确实存在
    const serverSrc = stripComments(
      readFileSync(resolve(REPO_ROOT, 'src/main/webPanel/server.ts'), 'utf-8')
    )
    expect(serverSrc).toMatch(/loginThrottle\.sweep\s*\(\s*\)/)
    expect(serverSrc).toMatch(/stopTimers\s*\(\s*\)/)
  })

  it('密钥重新生成必须走 rotateAdminKey(直写 store 会让轮换变成装样子)', () => {
    const wiring = stripComments(readFileSync(WIRING_TS, 'utf-8'))
    expect(wiring).toMatch(/rotate-admin-key/)
    expect(wiring).toMatch(/this\.auth\.rotateAdminKey\s*\(\s*\)/)
    // 反面:轮换处不得绕过 auth 直接写 store
    const rotateBlock = wiring.slice(
      wiring.indexOf("'web-panel:rotate-admin-key'"),
      wiring.indexOf("'web-panel:rotate-admin-key'") + 600
    )
    expect(rotateBlock).not.toMatch(/store\.set\s*\(/)
  })

  it('面板默认关闭(决策卡 §5 注册清单第一条)', () => {
    const wiring = stripComments(readFileSync(WIRING_TS, 'utf-8'))
    expect(wiring).toMatch(/DEFAULT_WEB_PANEL_CONFIG[\s\S]{0,200}enabled:\s*false/)
  })

  it('路由前缀用 PANEL_PATH_PREFIX 常量,不得写 /panel 字面量', () => {
    const serverSrc = stripComments(
      readFileSync(resolve(REPO_ROOT, 'src/main/webPanel/server.ts'), 'utf-8')
    )
    expect(serverSrc).toMatch(/PANEL_PATH_PREFIX/)
    // cookie 的 Path 与路由前缀一旦分叉 → 浏览器静默不发 cookie → 「登录成功后全 401」
    expect(serverSrc, "server.ts 不得出现 '/panel' 字面量").not.toMatch(/['"]\/panel['"]/)
  })
})
