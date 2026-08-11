/**
 * 服务端构建目标的结构闸门（W-F）。
 *
 * 治的是一个**沉默的**失败：`src/main/utils/webPanelAssetRoot.ts:88` 用
 * `__dirname/../webPanel` 定位面板静态资源，且刻意**没有** `app.isPackaged` 分支
 * （该文件头段用整节解释为什么不加）。于是「服务端 bundle 落在哪」与「面板能不能
 * 被找到」是同一个契约的两处消费点：
 *
 *   out/server/index.js  → __dirname=out/server → ../webPanel = out/webPanel  ✓
 *   out/index.js         → __dirname=out        → ../webPanel = <repo>/webPanel ✗
 *   dist/server/index.js → __dirname=dist/server→ ../webPanel = dist/webPanel  ✗
 *
 * 后两种的现场表现是**面板 404**，而非「构建挪了位置」—— 排查会往「面板坏了」跑，
 * 这正是 `webpanel_build_assets.test.ts` 头段记录的那类误导（已在本仓踩过两次）。
 * 故这里把「产物必须与 out/webPanel 同级」钉成断言。
 *
 * ## 本组的强度边界（诚实标注，姿态同 webpanel_build_assets.test.ts）
 *
 * | 层 | 断言对象 | 强度 | 抓不到 |
 * |---|---|---|---|
 * | L1 配置形状 | `vite.server.config.ts` 的 outDir / format / target / 入口路径 | 中（读真实配置模块，非字符串猜测） | 抓不到 vite 自身默认值变化 |
 * | L2 相对契约 | outDir 与 `getWebPanelAssetRoot()` 的 `../webPanel` 必须对上 | **强**（两个独立来源必须一致） | — |
 * | L3 真实产物 | `out/server/index.js` 真在盘上、是 CJS、有 sourcemap、零 electron | **强**（实测产物） | 产物不存在时**跳过** |
 *
 * L3 产物不存在时跳过而非报红：CI 里「先 build 再 test」与本地「只跑单测」都是正当
 * 流程，若在纯单测流程里恒红，人会去加 `skip` 而不是去 build —— 闸门反而被拆掉。
 * 跳过时打印明确原因，不假装通过。
 *
 * L1 用 `import` 真实读配置模块而不是正则扫源文本：正则扫「outDir 里有没有 server
 * 这个词」既会被注释误命中，也挡不住 `resolve(__dirname, 'out', someVar)` 这种写法。
 * 读模块拿到的是**真实生效的值**。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { describe, it, expect } from 'vitest'
import serverConfig, { SERVER_OUT_DIR_NAME } from '../../../vite.server.config'
import { WEB_PANEL_OUT_DIR_NAME } from '../../../src/main/utils/webPanelAssetRoot'

const REPO_ROOT = resolve(__dirname, '../../..')

/** `defineConfig` 可能返回函数（本仓是纯对象；断言住以免日后改成函数式后本组静默失效） */
function resolvedConfig(): Record<string, any> {
  expect(
    typeof serverConfig,
    'vite.server.config.ts 改成了函数式配置 —— 本组断言需同步改为 await 调用它'
  ).toBe('object')
  return serverConfig as Record<string, any>
}

const cfg = resolvedConfig()
const build = cfg.build as Record<string, any>

const OUT_DIR = build.outDir as string
const BUILT_ENTRY = join(OUT_DIR, 'index.js')
const built = existsSync(BUILT_ENTRY)
const SKIP_REASON =
  `未发现 ${BUILT_ENTRY} —— 先跑 \`npm run build:server\`。` +
  `本组断言校验真实产物，产物不存在时跳过而非误报。`

describe('服务端构建目标 · L1 配置形状', () => {
  it('产物落在 out/server/（不是 out/ 根，也不是 dist/）', () => {
    expect(OUT_DIR).toBe(resolve(REPO_ROOT, 'out', SERVER_OUT_DIR_NAME))
  })

  it('入口指向 src/main/server/entry.ts', () => {
    // 入口文件由 W-A 落盘。这里断言的是**构建配置指向哪**，不是文件是否已存在 ——
    // 两件事分开断言，才能在入口还没写时也守住配置不漂。
    expect(build.lib?.entry).toBe(resolve(REPO_ROOT, 'src/main/server/entry.ts'))
  })

  it('产物文件名是 index.js（npm run start:server 与运维文档都指向它）', () => {
    // 断言 `entryFileNames` 而**不是** `lib.fileName`：实测(2026-08-12 · vite 7.2.6)
    // 在 `build.ssr: true` 下 `lib.fileName` 不生效，产物名由 rollup 的
    // `entryFileNames` 决定（不设时按入口文件名 → 会得到 `entry.js`）。
    // 若断言错的那个键，配置改坏时本条仍绿 —— 那正是这个闸门要消灭的假绿。
    expect(build.rollupOptions?.output?.entryFileNames).toBe('index.js')
    // 同时钉住「没人把不生效的 lib.fileName 加回来」：它的存在会误导后来者
    // 以为改它就能改产物名。
    expect(
      build.lib?.fileName,
      'lib.fileName 在 build.ssr 下不生效 —— 加回它会误导后来者，改用 entryFileNames'
    ).toBeUndefined()
  })

  it('输出格式是 CJS —— ESM 产物里没有 __dirname，面板定位会在运行时炸', () => {
    // webPanelAssetRoot.ts:88 用 __dirname。改成 ESM 后它未定义，且失败发生在
    // **有人访问面板那一刻**（启动看着正常）—— 最难归因的一类。
    expect(build.lib?.formats).toEqual(['cjs'])
  })

  it('sourcemap 开启（服务端故障要靠 journalctl 读栈）', () => {
    expect(build.sourcemap).toBe(true)
  })

  it('单文件产物（inlineDynamicImports）—— 多 chunk 时漏拷兄弟文件即 MODULE_NOT_FOUND', () => {
    expect(build.rollupOptions?.output?.inlineDynamicImports).toBe(true)
  })

  it('构建目标不跟随 electron 内置 node 版本，且不高于 engines.node 下限', () => {
    // 服务端跑运维装的 node。用 electron 大版本推导 target 是把一条不存在的因果
    // 写进配置（那是 electron-vite main 预设的行为，见 vite.server.config.ts 头段）。
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.engines?.node, 'engines.node 缺失 —— require(esm) 的下限没被声明').toBeTruthy()
    // 产物语法下限必须 ≤ 运行时下限：engines 允许 node 20.19 时，产物不能是 node22 语法。
    expect(build.target).toBe('node20')
    expect(pkg.engines.node).toContain('20.19')
  })

  it('emptyOutDir 只清 out/server/，不清整个 out/（否则服务端构建会删掉桌面产物）', () => {
    expect(build.emptyOutDir).toBe(true)
    expect(OUT_DIR.endsWith(SERVER_OUT_DIR_NAME)).toBe(true)
    expect(OUT_DIR).not.toBe(resolve(REPO_ROOT, 'out'))
  })
})

describe('服务端构建目标 · L2 与面板资源的相对契约（最承重）', () => {
  it('产物目录的 ../webPanel 就是面板产物真实落点', () => {
    // 这条是本文件存在的理由。两个独立来源：
    //   - OUT_DIR 由 vite.server.config.ts 决定
    //   - WEB_PANEL_OUT_DIR_NAME + vite.webPanel.config.ts 的 outDir 决定面板落点
    // 它们必须对上，否则 getWebPanelAssetRoot() 在服务端算出一个不存在的目录。
    const panelFromServerBundle = resolve(join(OUT_DIR, '..', WEB_PANEL_OUT_DIR_NAME))
    const panelRealRoot = resolve(REPO_ROOT, 'out', WEB_PANEL_OUT_DIR_NAME)
    expect(
      panelFromServerBundle,
      `服务端 bundle 的 __dirname/../${WEB_PANEL_OUT_DIR_NAME} 指不到面板产物。\n` +
        `  bundle 目录: ${OUT_DIR}\n` +
        `  它算出的面板路径: ${panelFromServerBundle}\n` +
        `  面板真实落点: ${panelRealRoot}\n` +
        `后果: 面板全部资源 404，而现场表现是「面板坏了」不是「构建挪了位置」。\n` +
        `修法: 让服务端产物落在 out/ 下恰好一层（见 src/main/utils/webPanelAssetRoot.ts 头段）。`
    ).toBe(panelRealRoot)
  })

  it('产物必须在 out/ 下恰好一层（多一层或少一层都会让相对契约失效）', () => {
    expect(dirname(OUT_DIR)).toBe(resolve(REPO_ROOT, 'out'))
  })

  it('vite.webPanel.config.ts 的面板 outDir 未从 out/ 搬走', () => {
    // 上一条只证明两个**计算值**一致；若面板产物整体搬去别处，两边可以「自洽地」
    // 一起漂移。故这里额外锚住面板配置里的字面落点。
    const cfgSrc = readFileSync(resolve(REPO_ROOT, 'vite.webPanel.config.ts'), 'utf-8')
    expect(cfgSrc).toContain(`'out/${WEB_PANEL_OUT_DIR_NAME}'`)
  })
})

/**
 * 产物里 electron 引用的四种形态判据。抽成模块级常量,让「真实产物断言」与
 * 「判定器自检」用**同一份**正则 —— 各写一份的话,自检绿而真断言用的是另一份
 * 写错的正则,那正是自检存在的意义被抹掉。
 */
const ELECTRON_FORMS: Array<{ name: string; re: RegExp }> = [
  { name: "ESM from 'electron[/sub]'", re: /\bfrom\s*['"]electron(?:-updater)?(?:\/[^'"]*)?['"]/ },
  { name: "ESM import 'electron[/sub]'", re: /\bimport\s*['"]electron(?:-updater)?(?:\/[^'"]*)?['"]/ },
  {
    name: "CJS require('electron[/sub]')",
    re: /\brequire\s*\(\s*['"]electron(?:-updater)?(?:\/[^'"]*)?['"]\s*\)/
  },
  {
    name: "动态 import('electron[/sub]')",
    re: /\bimport\s*\(\s*['"]electron(?:-updater)?(?:\/[^'"]*)?['"]\s*\)/
  }
]

/**
 * 剥掉注释,并把**字符串字面量的内容**打码后再判定 electron 引用。
 *
 * ## 为什么必须处理（实测驱动,非洁癖）
 *
 * 首次 `npm run build:server` 真跑后本断言报红,而**零处真 import** —— 唯一命中是
 * 一行注释:`// 自签证书落盘目录（K-2）：装配层注入，内核不自己 require('electron')`。
 * 即闸门退化成「禁止在代码里解释为什么这里没有 electron」,逼后人删掉最该留的注释。
 *
 * 这与 `test/main/proxy/loggerElectronDecoupling.test.ts` 的 L1 门禁是**同一道题**:
 * `logger.ts` 文件头刻意逐字写出 `import { app } from 'electron'` 来解释它的缺席,
 * 裸扫会命中说明文字。那条门禁的解法就是先 `stripComments` 再断言。此处照同一形态,
 * 但因为判定对象是**构建产物**（注释与用户可见文案都原样进 bundle）,还要多处理字符串。
 *
 * ## 为什么不能「把字符串整个剥空」（这是我第一版的错,实测证伪）
 *
 * `import { app } from 'electron'` 里的 `'electron'` **本身就是字符串字面量**。
 * 把所有字符串剥空会得到 `import { app } from ''` —— **真实依赖变得完全不可见**,
 * 判定器从此对最该抓的东西失明。实测(2026-08-12)该写法下受控样本
 * 「真 import」命中数 0,断言直接失去意义。
 *
 * ## 实际做法:保护说明符,打码其余字符串
 *
 * 两步:① 先把「模块说明符位置」的字符串（`from '...'` / `import '...'` /
 * `require('...')` / `import('...')`）替换成不含引号的哨兵保护起来 —— 它们正是
 * 判定目标;② 再把**其余**字符串字面量的内容清空（运维文案 / 设计说明所在之处）;
 * ③ 最后还原哨兵。于是两类同时成立:真依赖仍可见,文案里的 electron 不再误报。
 *
 * 顺序刻意是「注释 → 说明符 → 其余字符串」:注释里可能含引号
 * （`require('electron')`）,先动字符串会把注释里的引号当字面量起点、吃掉后面的
 * 真代码 —— 那会让判定器静默漏扫（假绿）。
 */
function normalizeForElectronScan(src: string): string {
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释 / JSDoc
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 URL 里的 `://`）

  // 保护说明符位置的字符串（判定目标）：临时替换成不含引号的哨兵。
  const sentinels: string[] = []
  const protectSpecifiers = noComments.replace(
    /\b(?:from|import|require)\s*\(?\s*(['"])([^'"]*)\1/g,
    (whole) => {
      sentinels.push(whole)
      return ` SPEC${sentinels.length - 1} `
    }
  )

  // 其余字符串：内容打码（保留引号/反引号，避免破坏后续解析）。
  // 这正是运维文案 / 设计说明所在之处 —— 它们不是依赖。
  const masked = protectSpecifiers
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/"(?:[^"\\\n]|\\[\s\S])*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\[\s\S])*'/g, "''")

  // 还原说明符
  return masked.replace(/ SPEC(\d+) /g, (_, i) => sentinels[Number(i)])
}

describe('服务端构建目标 · L3 真实产物（需已 build:server）', () => {
  it.skipIf(!built)('产物存在且非空', () => {
    expect(statSync(BUILT_ENTRY).size, SKIP_REASON).toBeGreaterThan(0)
  })

  it.skipIf(!built)('产物是 CJS（有 require / 无顶层 import）且能用原生 __dirname', () => {
    const txt = readFileSync(BUILT_ENTRY, 'utf-8')
    expect(/\brequire\(/.test(txt), '产物里没有 require —— 不是 CJS').toBe(true)
    expect(/^import\s/m.test(txt), '产物里有顶层 import —— 是 ESM，__dirname 将未定义').toBe(false)
  })

  it.skipIf(!built)('产物不引用 electron / electron-updater', () => {
    // 与 kernel_without_electron.test.ts 互补：那条扫**源码**，这条扫**真实产物**——
    // 能抓到走别名 / re-export / 第三方包间接引入而源码正则漏掉的形态。
    //
    // 判定前先归一化（见 normalizeForElectronScan 头部说明）：
    // 闸门要管的是**依赖**，不是运维文案与设计说明。
    const raw = readFileSync(BUILT_ENTRY, 'utf-8')
    const code = normalizeForElectronScan(raw)

    const hits = ELECTRON_FORMS.filter((f) => f.re.test(code)).map((f) => f.name)
    expect(
      hits,
      `服务端产物引用了 electron 包。服务端跑在纯 node 下（electron 是 devDependency，\n` +
        `且无任何 prod 依赖 peer 上它，--omit=dev 后不存在）—— 这在 Linux 上是启动即\n` +
        `MODULE_NOT_FOUND。\n` +
        `（注释与非说明符字符串已归一化，故此处命中是真实依赖，不是文案。）`
    ).toEqual([])
  })

  it.skipIf(!built)('自检：归一化真的在工作（否则「永远匹配不到」= 假绿）', () => {
    // 没有这条，normalizeForElectronScan 若哪天失效（剥过头把产物清空 / 正则写错）
    // 上一条会**永远报绿**，而「永远报绿」与「产物真干净」在输出里完全同形
    // （本仓 E-052 母题）。姿态取自 loggerElectronDecoupling.test.ts 的剥离自检。
    const raw = readFileSync(BUILT_ENTRY, 'utf-8')
    const code = normalizeForElectronScan(raw)

    // ① 前提：本产物**确实**含那行提到 require('electron') 的注释
    //    （首次 build 误报的元凶；它若哪天被删，本自检的驱动事实就消失了，应转红提醒）
    expect(raw, "前提:产物应含注释形态的 require('electron')").toMatch(
      /require\('electron'\)/
    )
    // ② 归一化确实生效：该注释形态不再以「可判定的依赖」形式存在
    expect(
      ELECTRON_FORMS.some((f) => f.re.test(code)),
      '归一化后注释里的 require(electron) 仍被判为依赖 —— 剥离失效'
    ).toBe(false)
    // ③ 没剥过头：真代码必须留下（否则判定器是在空字符串上恒绿）
    expect(code.length, '归一化后产物几乎为空 —— 剥过头了，判定器等于空转').toBeGreaterThan(10000)
    expect(code, '归一化后应仍有真实 require 调用').toMatch(/\brequire\(/)
    // ④ 关键：归一化**没有**破坏说明符位置 —— 真实第三方依赖仍然可见。
    //    这条是第一版缺陷（把所有字符串剥空导致真 import 隐形）的回归锚。
    expect(code, "归一化把说明符也剥掉了 —— 真实依赖将不可见").toMatch(
      /require\(\s*['"]conf['"]\s*\)/
    )
  })

  it('自检：electron 判定器对三类受控样本有辨别力（注释 / 文案不红 · 真依赖必红）', () => {
    // 这条**不带 skipIf** —— 验的是判定器本身，与产物是否存在无关。
    // 三类样本对应本轮真实踩到的三种处境。
    const detect = (src: string): string[] =>
      ELECTRON_FORMS.filter((f) => f.re.test(normalizeForElectronScan(src))).map((f) => f.name)

    // ① 注释里的 require('electron') —— 首次 build 真实误报的那一行，不得红
    expect(
      detect(`// 自签证书落盘目录（K-2）：装配层注入，内核不自己 require('electron')`),
      '注释里的 require(electron) 被判为依赖 —— 闸门退化成「禁止解释设计」'
    ).toEqual([])
    expect(
      detect(`/**\n * 也不 import electron(保持 kernel 可在无 Electron 环境下运行)。\n */`)
    ).toEqual([])

    // ② 字符串文案里的 electron —— 产物里真实存在的运维报错，不得红
    expect(
      detect(`throw new Error("userDataPath 缺失：桌面端为 Electron 的 userData 目录")`),
      '错误文案里的 Electron 被判为依赖'
    ).toEqual([])
    expect(detect('const warn = `复用桌面编排（实测零 electron）`')).toEqual([])
    expect(
      detect(`const hint = "内核不自己 require('electron')"`),
      '字符串里逐字写出 require(electron) 仍不该算依赖'
    ).toEqual([])

    // ③ 真依赖 —— 四种形态必须全红
    for (const s of [
      "import { app } from 'electron'",
      "import { autoUpdater } from 'electron-updater'",
      "import { x } from 'electron/main'",
      "import 'electron'",
      'const { app } = require("electron")',
      "const m = await import('electron')"
    ]) {
      expect(detect(s).length, `真实 electron 依赖未被判定器抓到: ${s}`).toBeGreaterThan(0)
    }

    // ④ 辨别力：名字里带 electron 的无关包不得误命中
    for (const s of [
      "import Store from 'electron-store'",
      "import x from './electron'",
      "import x from 'my-electron'"
    ]) {
      expect(detect(s), `判定器误伤了非 electron 依赖: ${s}`).toEqual([])
    }
  })

  it.skipIf(!built)('产物带 sourcemap 文件（journalctl 里的栈才有源码行号）', () => {
    expect(
      existsSync(BUILT_ENTRY + '.map'),
      `缺 ${BUILT_ENTRY}.map —— 线上栈只有打包后行号`
    ).toBe(true)
  })

  it.skipIf(!built)('产物里的第三方依赖是 external 的（未被打进 bundle）', () => {
    // conf 必须以 require('conf') 的形态留在产物里 —— 它被打进 bundle 反而危险：
    // conf 是 ESM-only，内联进 CJS 产物会引入难查的互操作差异，且失去 npm 的版本管理。
    const txt = readFileSync(BUILT_ENTRY, 'utf-8')
    // 只在产物真的用到 conf 时才断言（入口未接账号 store 时不该硬性要求）
    if (/\bconf\b/.test(txt)) {
      expect(
        /require\(\s*["']conf["']\s*\)/.test(txt),
        'conf 被打进了 bundle 而非 external —— 应由服务器上 npm i 提供'
      ).toBe(true)
    }
  })
})

describe('服务端构建目标 · 脚本与依赖装配', () => {
  it('package.json 有 build:server 与 start:server', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts['build:server'], 'build:server 脚本缺失').toBeTruthy()
    expect(pkg.scripts['build:server']).toContain('vite.server.config.ts')
    // 服务端也要托管面板 → 构建服务端必须连带构建面板产物，否则起来就是 404。
    expect(
      pkg.scripts['build:server'],
      'build:server 未串 build:webpanel —— 服务端起来后面板 404'
    ).toContain('build:webpanel')
    expect(pkg.scripts['start:server'], 'start:server 脚本缺失').toBeTruthy()
    expect(pkg.scripts['start:server']).toContain(`out/${SERVER_OUT_DIR_NAME}/index.js`)
    // sourcemap 构建出来了但运行时不读 = 白给
    expect(
      pkg.scripts['start:server'],
      'start:server 未开 --enable-source-maps —— 构建的 sourcemap 不被读取'
    ).toContain('--enable-source-maps')
  })

  it('桌面构建脚本未被服务端改动波及', () => {
    // 服务端是**新增**目标,不该改动既有桌面链路。这条锚住「没顺手改坏桌面」。
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts.build).toBe(
      'npm run typecheck && electron-vite build && npm run build:webpanel'
    )
    expect(pkg.scripts.build).not.toContain('build:server')
    expect(pkg.main).toBe('./out/main/index.js')
  })

  it('conf 是直接 dependency（服务端账号 store 的 import 才解析得开）', () => {
    // W-E。accountStore.conf.ts 直接 `import Conf from 'conf'`,而 conf 原先只是
    // electron-store 的传递依赖 —— 服务端安装若不含 electron 侧包,该 import 解析失败。
    // 且这条兼容性承载的是 ADR-0002 Decision 3 唯一正式迁移工件(原始数据文件直拷)。
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(
      pkg.dependencies?.conf,
      'conf 不在 dependencies —— 服务端 import Conf from "conf" 将解析失败'
    ).toBeTruthy()
    expect(pkg.devDependencies?.conf, 'conf 不该在 devDependencies（服务端运行时需要它）').toBeUndefined()
  })

  it('electron / electron-updater 仍不是服务端运行时依赖', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'))
    // electron 必须留在 devDependencies —— K-1~K-4 的整个前提
    expect(pkg.devDependencies?.electron, 'electron 应在 devDependencies').toBeTruthy()
    expect(pkg.dependencies?.electron, 'electron 不得进 dependencies').toBeUndefined()
    // electron-updater 是桌面 dependency(自动更新),服务端够不到它 ——
    // 由 vite.server.config.ts 的 failOnElectronImport 插件在构建期保证。
    const cfgSrc = readFileSync(resolve(REPO_ROOT, 'vite.server.config.ts'), 'utf-8')
    expect(cfgSrc).toContain('failOnElectronImport')
    expect(cfgSrc).toContain('electron-updater')
  })
})
