/**
 * 服务端形态的**独立** vite 构建配置（不属于 electron-vite 的三个目标）。
 *
 * 产物：`out/server/index.js`（CJS）+ sourcemap。运维跑 `npm run start:server`
 * （= `node --enable-source-maps out/server/index.js`）。
 *
 * ## 为什么是独立配置，而不是 electron.vite.config.ts 里的第四个目标
 *
 * 沿用 `vite.webPanel.config.ts` 已经确立的姿态（见该文件头段）：**它不是 Electron
 * 目标**。electron-vite 的 main 预设会做三件对服务端全都是错的事：
 *   1. 按已安装的 electron 大版本锁 `build.target`（Electron 38 → `node22.19`，见
 *      `electron-vite/dist/chunks/lib-ClgyQuZx.js:getElectronNodeTarget`）—— 服务端跑的是
 *      运维装的 node，与桌面内置的 node 无关，用 electron 版本推导目标是把一条**不存在的
 *      因果**写进构建配置。
 *   2. 预设注入 electron 相关的 define / external 语义；服务端的整个立项前提（K-1~K-4）
 *      正是「零 electron」。
 *   3. `electron-vite build` 一次跑三个目标，服务端产物会被绑上桌面构建的成败。
 *
 * 于是这里用普通 vite。`electron.vite.config.ts` **零改动** —— 桌面构建不受本文件影响。
 *
 * ## 为什么产物必须落在 `out/server/`（不是 `out/`、不是 `dist/server/`）
 *
 * `src/main/utils/webPanelAssetRoot.ts:88` 用 `__dirname/../webPanel` 定位面板静态资源，
 * 且**故意没有** `app.isPackaged` 分支（该文件头段用整节解释了为什么不加）。这条相对契约
 * 要求：**bundle 必须与 `out/webPanel/` 同级**，即落在 `out/<任意一层目录>/` 里。
 *
 *   out/server/index.js  → __dirname=out/server → ../webPanel = out/webPanel  ✓
 *   out/index.js         → __dirname=out        → ../webPanel = <repo>/webPanel ✗ 404
 *   dist/server/index.js → __dirname=dist/server→ ../webPanel = dist/webPanel  ✗ 404
 *
 * 后两种的失败形态是**面板 404**，而现场表现是「面板坏了」而不是「构建挪了位置」——
 * 排查方向会被带偏。故 `test/main/architecture/server_build_target.test.ts` 把这条
 * 相对关系钉成断言：改本文件的 outDir 而不改那个契约，闸门先红。
 *
 * ## 为什么是 CJS 而不是 ESM（这条是硬约束，不是口味）
 *
 * `webPanelAssetRoot.ts` 用的是 `__dirname`。它在 ESM 产物里**不存在** —— 而且失败方式
 * 极安静：`__dirname` 未定义会在**调用那一刻**抛 ReferenceError，即「启动看着正常、
 * 有人访问面板时才炸」。桌面 main 产物实测也是 CJS（`out/main/index.js` 开头
 * `"use strict"` + `require(` + 原生 `__dirname`），两端形态一致才不会出现
 * 「桌面能找到面板、服务端找不到」这种只在一端复现的差异。
 *
 * 代价已实测、可接受：`conf@15.0.2` 与 `uuid@13.0.0` 都是 **ESM-only** 包
 * （`"type": "module"` 且无 CJS 入口）。CJS 产物要 `require()` 它们，靠的是
 * `require(esm)` —— 它在 v22.12.0 与 v20.19.0 两条 LTS 线上都已 unflagged
 * （2025 年底标记为 stable）。实测(2026-08-12 · node v22.20.0)：
 * `require('conf')` / `require('uuid')` / `require('undici')` / `require('js-tiktoken')`
 * / `require('node-forge')` / `require('socks')` 全部成功，`require('conf').default`
 * 是可构造的 class。且这**不是服务端新引入的风险** —— 桌面 CJS 产物里已经有
 * `require("uuid")`（实测 out/main/index.js 命中 1 次），即 `require(esm)` 在桌面端
 * 早就是承重路径了。故 `engines.node` 声明 `^20.19.0 || >=22.12.0`：不是服务端
 * 单方面的要求，而是把**桌面早已隐式依赖**的下限写明（vite 自身 engines 同此）。
 *
 * ## electron / electron-updater：不是「externalize」，是**够不到**
 *
 * 这两个包**不在** external 清单里，且下方 `failOnElectronImport` 插件会在 rollup
 * 解析到它们时**直接让构建失败**。这是刻意的判定器设计：
 *   - 若写进 external：某天有人在服务端闭包里 import 了 electron，构建照绿，产物里留下
 *     一行 `require("electron")`，到 Linux 上才 MODULE_NOT_FOUND —— 而 K-1~K-4 整个
 *     立项就是为了让这件事**在编译期**不可能。
 *   - 现在的形态：够得到 = 构建失败 = 有人得来看一眼为什么服务端闭包碰了 electron。
 * 与 `test/main/architecture/kernel_without_electron.test.ts` 的源码/图级闸门互补：
 * 那条扫源文本，这条扫**真实产物的解析图**（能抓到走别名、走 re-export 绕过正则的形态）。
 */
import { defineConfig, type Plugin } from 'vite'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/** 服务端入口。由 K-5 的 W-A 落盘；本配置只依赖**路径**，不依赖其内容。 */
const SERVER_ENTRY = resolve(__dirname, 'src/main/server/entry.ts')

/**
 * 产物目录名。与 `webPanelAssetRoot.ts` 的 `__dirname/../webPanel` 契约耦合：
 * 只要产物在 `out/` 下**恰好一层**，该契约即成立（见文件头段）。
 */
export const SERVER_OUT_DIR_NAME = 'server'

/** 桌面独有、服务端不该够到的包。够到即构建失败（见文件头段）。 */
const ELECTRON_ONLY = ['electron', 'electron-updater']

const isElectronOnly = (id: string): boolean =>
  ELECTRON_ONLY.some((p) => id === p || id.startsWith(p + '/'))

/**
 * 解析到 electron / electron-updater 就让构建失败。
 *
 * `enforce: 'pre'` 是必需的：要在 vite 自己的解析与 external 判定**之前**拦下，
 * 否则 electron 作为已安装的 devDependency 会被正常解析、悄悄打进产物。
 */
function failOnElectronImport(): Plugin {
  return {
    name: 'server-build:fail-on-electron-import',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!isElectronOnly(source)) return null
      throw new Error(
        `服务端产物闭包里出现了 electron 依赖：'${source}'\n` +
          `  引入方: ${importer ?? '(入口)'}\n` +
          `服务端跑在纯 node 下（Linux 服务器，且 electron 是 devDependency，` +
          `--omit=dev 后压根不存在）。\n` +
          `平台差异应推到装配层（见 src/main/utils/webPanelAssetRoot.ts 头部注释的既有姿态），` +
          `不要把它加进 external 让构建变绿 —— 那只是把 MODULE_NOT_FOUND 推迟到线上。`
      )
    }
  }
}

/**
 * 运行时依赖一律 external（姿态同 `electron.vite.config.ts` 的 `externalizeDepsPlugin()`）：
 * 只打包本仓源码，第三方包由 `npm i --omit=dev` 在服务器上装。
 *
 * 刻意**从 `dependencies` 读**而非手列：手列清单会随 package.json 漂移，而漂移的
 * 失败方式是「某个包被打进产物」——安静且难查。`ELECTRON_ONLY` 在此被剔除，
 * 让上面那个插件去抓它们。
 */
function externalDeps(): (string | RegExp)[] {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
  const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => !isElectronOnly(d))
  return [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
    ...deps,
    // 子路径导入（`undici/types` 等）
    ...deps.map((d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
  ]
}

export default defineConfig({
  // 服务端产物不经浏览器；关掉 vite 面向 web 的默认注入
  appType: 'custom',
  resolve: {
    // 与 vitest.config.ts / tsconfig.node.json 同名同指向。今天 src/main 里零别名 import，
    // 但解析器仍必须认识它们 —— 不认的话哪天有人用 `@shared/x` 写服务端代码，
    // 会静默解析失败或走错分支。
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@preload': resolve(__dirname, 'src/preload')
    }
  },
  plugins: [failOnElectronImport()],
  build: {
    outDir: resolve(__dirname, `out/${SERVER_OUT_DIR_NAME}`),
    // 只清自己这一层。`out/` 下还住着 main / preload / renderer / webPanel，
    // 清整个 out/ 会把桌面产物与面板产物一起删掉 —— 那正是「服务端构建弄坏桌面」。
    emptyOutDir: true,
    // 运维装的 node，与桌面内置 node 无关（见文件头段）。下限取 `engines.node`
    // 声明的 `^20.19.0 || >=22.12.0` 中的**较低**者 —— 那正是 `require(esm)` 被
    // unflagged 的两条 LTS 线（v20.19.0 / v22.12.0，实测见文件头段）。
    // 用 node20 而非 node22 是刻意的：产物语法下限低于运行时下限是安全的，反之
    // 会在 node 20 上吐出它解析不了的语法，而 `engines` 说它是支持的。
    target: 'node20',
    ssr: true,
    // 服务端故障要靠 journalctl 读栈；不给 sourcemap 就只能读打包后的行号。
    // 独立 .map 文件（非 inline）：产物本体不因此变大，`--enable-source-maps` 才读它。
    sourcemap: true,
    minify: false,
    reportCompressedSize: false,
    lib: {
      entry: SERVER_ENTRY,
      formats: ['cjs']
      // 注意：这里**故意不写** `fileName`。实测(2026-08-12 · vite 7.2.6)在
      // `build.ssr: true` 下 `lib.fileName` **不生效** —— 产物名由
      // `rollupOptions.output.entryFileNames` 决定（不设时按入口文件名，
      // 即会得到 `entry.js` 而不是 `index.js`）。写一个不生效的 `fileName`
      // 比不写更糟：日后有人改它、以为改了产物名，而实际没变。
    },
    rollupOptions: {
      external: externalDeps(),
      output: {
        // 产物名的**真正**决定者（见上方 lib 段的实测说明）。
        // 必须是 index.js：`npm run start:server` 与运维文档都指向这个名字。
        entryFileNames: 'index.js',
        // 单文件产物：服务端没有 code-splitting 的消费者（不存在按需加载的浏览器），
        // 而多 chunk 会让 `node out/server/index.js` 依赖同目录的兄弟文件，
        // 拷贝产物时少拷一个就是运行时 MODULE_NOT_FOUND。
        inlineDynamicImports: true
      }
    }
  }
})
