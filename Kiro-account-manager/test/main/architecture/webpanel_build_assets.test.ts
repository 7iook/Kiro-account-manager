/**
 * 生产装配闭环闸门：局域网面板的静态产物**真的被构建出来了**，且运行时定位
 * 指向的就是它 —— 治的正是决策卡 §5 点名的「开发机上好的，装完包 404」。
 *
 * ## 这个测试的强度：分层，且诚实标注
 *
 * 打包一次要几分钟，放进单测里跑不现实。所以这里分三层，**强度递减但互补**，
 * 并明确各自抓不到什么：
 *
 * | 层 | 断言对象 | 强度 | 抓不到 |
 * |---|---|---|---|
 * | L1 产物存在 | `out/webPanel/index.html` + 被引用的 assets **真实在盘上** | **强**（真实产物，非配置推断） | 抓不到「asar 打包时把 out/ 排除了」 |
 * | L2 定位一致 | `getWebPanelAssetRoot()` 算出的路径 == 产物真实落点 | **强**（两个独立来源必须对上） | 同上 |
 * | L3 配置形状 | `electron-builder.yml` 未排除 `out/**`；build 脚本串了 `build:webpanel` | **弱**（配置推断，非实测打包） | 抓不到 electron-builder 默认规则本身变化 |
 *
 * L1/L2 依赖 `npm run build`（或 `build:webpanel`）已跑过。**产物不存在时本文件
 * 跳过而非报红** —— 理由：CI 里「先 build 再 test」和本地「只跑单测」都是正当流程，
 * 若在纯单测流程里恒红，人会去加 `skip` 而不是去 build，闸门反而被拆掉。
 * 跳过时打印明确原因，不假装通过。
 *
 * ⚠️ 真正的「装进安装包了吗」只有实跑 `npm run build:unpack` 后检查
 * `dist/win-unpacked/resources/app.asar` 能证明。本轮已实测（见任务报告），
 * 但那不适合放进单测。L3 是它在单测层的**弱替身**，不是等价物。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  getWebPanelAssetRoot,
  resolveWebPanelAssets,
  WEB_PANEL_URL_PREFIX,
  WEB_PANEL_ENTRY_HTML,
  WEB_PANEL_OUT_DIR_NAME
} from '../../../src/main/utils/webPanelAssetRoot'

const REPO_ROOT = resolve(__dirname, '../../..')
/** 产物真实落点 —— 由 `vite.webPanel.config.ts` 的 build.outDir 决定 */
const BUILT_ROOT = resolve(REPO_ROOT, 'out', WEB_PANEL_OUT_DIR_NAME)
const BUILT_ENTRY = join(BUILT_ROOT, WEB_PANEL_ENTRY_HTML)

const built = existsSync(BUILT_ENTRY)
const SKIP_REASON =
  `未发现 ${BUILT_ENTRY} —— 先跑 \`npm run build:webpanel\`。` +
  `本组断言校验真实产物，产物不存在时跳过而非误报。`

describe('webPanel 构建产物（L1/L2 · 需已 build）', () => {
  it.skipIf(!built)('入口 HTML 存在于 out/webPanel/', () => {
    expect(existsSync(BUILT_ENTRY), SKIP_REASON).toBe(true)
  })

  it.skipIf(!built)('入口 HTML 引用的 JS/CSS 资源在盘上真实存在', () => {
    // 只断言 index.html 存在是不够的：assets 目录没生成 / 被清空同样是线上白屏。
    const html = readFileSync(BUILT_ENTRY, 'utf-8')
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith(WEB_PANEL_URL_PREFIX))

    expect(refs.length, '入口 HTML 未引用任何 /panel/ 前缀资源 —— bundle 没被注入').toBeGreaterThan(0)

    const missing = refs.filter((url) => {
      const rel = url.slice(WEB_PANEL_URL_PREFIX.length)
      return !existsSync(join(BUILT_ROOT, rel))
    })
    expect(missing, `HTML 引用了不存在的资源(装完包必然 404):\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it.skipIf(!built)('资源 URL 用绝对 /panel/ 前缀,不是相对路径', () => {
    // 相对路径在 `GET /panel`(无尾斜杠)下会解析到站点根 → 404。
    // 这条锁死 vite.webPanel.config.ts 的 base，防它被改回 './'。
    const html = readFileSync(BUILT_ENTRY, 'utf-8')
    const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => /\.(?:js|css)$/.test(u))
    expect(assetRefs.length).toBeGreaterThan(0)
    for (const url of assetRefs) {
      expect(url, `资源 URL 必须以 ${WEB_PANEL_URL_PREFIX} 开头,否则无尾斜杠访问时 404`).toMatch(
        new RegExp(`^${WEB_PANEL_URL_PREFIX}`)
      )
    }
  })

  it.skipIf(!built)('运行时解析器指向的就是真实产物目录(dev 姿态)', () => {
    // 单测在 test/main/architecture 下跑,__dirname 不是 out/main,
    // 故这里不比较 getWebPanelAssetRoot() 的绝对值(那会是错的比较),
    // 而是校验它的**相对契约**:相对 bundle 目录向上一级 + webPanel。
    // 该契约成立 ⇔ out/main/index.js 能找到 out/webPanel。
    const fromOutMain = resolve(join(REPO_ROOT, 'out', 'main'), '..', WEB_PANEL_OUT_DIR_NAME)
    expect(fromOutMain).toBe(BUILT_ROOT)

    const assets = resolveWebPanelAssets()
    expect(assets.root.endsWith(WEB_PANEL_OUT_DIR_NAME)).toBe(true)
    expect(assets.entryHtml).toBe(join(assets.root, WEB_PANEL_ENTRY_HTML))
  })
})

describe('webPanel 打包配置形状（L3 · 弱断言,恒可跑）', () => {
  it('electron-builder.yml 未排除 out/**（否则产物进不了 asar）', () => {
    const yml = readFileSync(resolve(REPO_ROOT, 'electron-builder.yml'), 'utf-8')
    // electron-builder 默认 files 规则包含 out/**;本仓库 files 全是 `!` 排除项。
    // 只要没人加一条排除 out 的规则,产物就会被打进 asar。
    const excludesOut = /^\s*-\s*['"]?!.*\bout\b/m.test(yml)
    expect(
      excludesOut,
      'electron-builder.yml 出现了排除 out 的规则 —— 面板资源将不进安装包,装完包必然 404'
    ).toBe(false)
  })

  it('electron-builder.yml 未把 out/ 加进 asarUnpack（面板资源不需解包）', () => {
    const yml = readFileSync(resolve(REPO_ROOT, 'electron-builder.yml'), 'utf-8')
    const asarUnpackBlock = yml.match(/^asarUnpack:\n((?:\s+-\s.*\n)+)/m)?.[1] ?? ''
    expect(
      /\bout\b/.test(asarUnpackBlock),
      'out/ 被加入 asarUnpack —— 会改变产物真实位置,getWebPanelAssetRoot() 的无分支实现将失效'
    ).toBe(false)
  })

  it('npm run build 串了 build:webpanel（否则 build 产物缺面板）', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts['build:webpanel'], 'build:webpanel 脚本缺失').toBeTruthy()
    expect(pkg.scripts.build, 'npm run build 未串 build:webpanel').toContain('build:webpanel')
  })

  it('所有平台打包脚本都经 npm run build（防某平台漏掉面板）', () => {
    // build:mac / build:linux 原先直接调 electron-vite build,绕过了面板构建 ——
    // 那会让 mac/linux 安装包静默缺面板。这条锁住修复不被改回去。
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    for (const name of ['build:unpack', 'build:win', 'build:mac', 'build:linux']) {
      expect(pkg.scripts[name], `${name} 脚本缺失`).toBeTruthy()
      expect(
        pkg.scripts[name],
        `${name} 未经 npm run build —— 该平台安装包会缺少面板资源`
      ).toMatch(/npm run build\b/)
    }
  })

  it('vite.webPanel.config.ts 的 outDir 与运行时解析目录名一致', () => {
    // 构建产物落点与运行时查找点是同一契约的两处消费点,漂移即 404。
    const cfg = readFileSync(resolve(REPO_ROOT, 'vite.webPanel.config.ts'), 'utf-8')
    expect(cfg).toContain(`'out/${WEB_PANEL_OUT_DIR_NAME}'`)
    expect(cfg).toContain(`base: '${WEB_PANEL_URL_PREFIX}'`)
    expect(getWebPanelAssetRoot().endsWith(WEB_PANEL_OUT_DIR_NAME)).toBe(true)
  })
})
