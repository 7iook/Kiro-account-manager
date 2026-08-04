/**
 * 局域网 Web 面板的**独立** vite 构建配置（不属于 electron-vite 的三个目标）。
 *
 * ## 为什么不是 electron.vite.config.ts 里的第二个 renderer entry
 *
 * 原侦察建议「renderer.build.rollupOptions.input 加一个 entry」，**实测不成立**：
 *
 * 1. **物理失败**：electron-vite 的 renderer 预设把 `config.root` 默认设为
 *    `./src/renderer`（`electron-vite/dist/chunks/lib-ClgyQuZx.js:506`）。把
 *    `src/webPanel/index.html` 作为 input 时，rollup 报
 *    `The "fileName" or "name" properties of emitted chunks and assets must be
 *    strings that are neither absolute nor relative paths, received
 *    "../webPanel/index.html"` —— 构建直接 EXIT=1。要修就得把 root 抬到 `src`，
 *    而桌面端 `src/renderer/index.html` 里写的是 root 相对的
 *    `<script src="/src/main.tsx">`，抬 root 会把它解析成 `src/src/main.tsx`，
 *    等于为了加面板去弄坏桌面端。
 *
 * 2. **构建目标错**：renderer 预设按 Electron 版本锁死 `build.target`
 *    （Electron 38 → `chrome140`，同文件 `getElectronChromeTarget`）。桌面端跑在
 *    自带的 Chrome 里，这是对的；但本面板是**发给局域网里任意手机浏览器**的，
 *    用 chrome140 当下限会给老 Safari / Android WebView 吐出它解析不了的语法 ——
 *    这类失败正是"开发机上好的，手机上白屏"。面板需要自己的 target 基线。
 *
 * 结论：面板不是 Electron renderer，是一个**经 HTTP 提供给第三方浏览器的普通网页**。
 * 用普通 vite 构建是对的工具，而不是把它塞进 Electron 的管线里再想办法压制
 * 那些 Electron 专属假设。`electron.vite.config.ts` 因此**零改动**。
 *
 * ## base 为什么是绝对的 '/panel/'
 *
 * 若用 vite 默认的 `'/'` 或 electron-vite renderer 那套 `'./'`：
 *   - `'./assets/x.js'` 在 `GET /panel/`（带斜杠）下解析成 `/panel/assets/x.js` ✓
 *   - 但在 `GET /panel`（不带斜杠）下解析成 `/assets/x.js` ✗ 404
 * 写死 `'/panel/'` 后，无论访问路径是否带尾斜杠、无论静态托管层怎么改写，
 * 资源 URL 恒为 `/panel/assets/*`。这条与决策卡 §3「前缀 /panel/*」一致，
 * 也与会话 Cookie 的 `Path=/panel` 对齐（前缀不一致会导致浏览器不发 cookie，
 * 表现为静默 401 —— 决策卡 §3 已把这列为最易误诊的坑）。
 *
 * ⚠️ 改动 base 必须同步改 `src/main/utils/webPanelAssetRoot.ts` 的 `WEB_PANEL_URL_PREFIX`
 * 与静态托管层的路由前缀，三者是同一个契约的三处消费点。
 */
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/webPanel'),
  // 见文件头「base 为什么是绝对的」
  base: '/panel/',
  resolve: {
    alias: {
      // 面板可复用桌面端 components/ui/ 的纯展示组件（零 window.api 依赖）。
      // 别名与 electron.vite.config.ts / vitest.config.ts 保持同名同指向。
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'out/webPanel'),
    emptyOutDir: true,
    // 面向手机浏览器的下限，不跟随 Electron 内置 Chrome 版本。
    // 覆盖面：iOS Safari 15.4+ / Chrome 100+ / Firefox 100+。
    target: ['es2022', 'safari15.4'],
    // 与桌面端 renderer 一致：不压缩体积报告噪声；面板走局域网，minify 收益不大
    // 但保留 minify 以减少手机端解析时间。
    reportCompressedSize: false,
    sourcemap: false
  }
})
