/**
 * 局域网 Web 面板静态资源根目录的**唯一**解析点（SSOT）。
 *
 * 静态托管层（W5）只问这一个函数「资源在哪」，不自己拼路径。放在独立模块而非
 * server 文件里，是因为「产物落在哪」由构建配置决定（`vite.webPanel.config.ts`），
 * 与「怎么把文件发出去」是两件事 —— 构建路径改动只应触达本文件。
 *
 * ## 为什么不用 tray.ts 那套 `app.isPackaged` 分支
 *
 * `tray.ts:14` 分支到 `process.resourcesPath/app.asar.unpacked/resources/...` 是**必须的**，
 * 因为托盘图标在 `resources/`，而 `electron-builder.yml:29 asarUnpack: resources/**`
 * 把该目录解包到了 asar **外面** —— 打包后它的真实位置与 `__dirname` 的相对关系变了。
 *
 * 面板资源不同：产物在 `out/webPanel/`，`out/**` 走 electron-builder 默认规则
 * **打进 asar 内部**、不解包。而主进程入口自身就是 asar 内的 `out/main/index.js`，
 * 所以两者的相对关系 `out/main` → `../webPanel` 在开发与打包下**完全一致**：
 *
 *   dev      : <repo>/out/main/index.js          → <repo>/out/webPanel
 *   packaged : .../app.asar/out/main/index.js    → .../app.asar/out/webPanel
 *
 * Electron 重写了 fs 层，asar 内路径对 `readFile` / `createReadStream` 透明，
 * 无需特殊 API。因此这里**故意不写 `app.isPackaged` 分支** —— 加一个恒等的分支
 * 不是「遵循既有模式」，而是凭空造一条永远走不到的路径，日后必然腐烂成误导。
 * （反过来说：若哪天面板资源被移出 `out/`，或被加进 `asarUnpack`，本函数就必须
 * 改回分支形态 —— 那时 `webPanelAssetRoot` 的断言测试会先红。）
 *
 * ## 开发模式
 *
 * `npm run dev`（`electron-vite dev`）**不构建**面板产物 —— 它只管 main/preload/renderer。
 * 因此开发时面板资源可能压根不存在，两种正当解法：
 *   1. 跑一次 `npm run build:webpanel` 生成 `out/webPanel/`（静态，改代码需重跑）
 *   2. 另起 `npx vite --config vite.webPanel.config.ts` 拿 HMR，并把
 *      `KIRO_WEB_PANEL_DEV_URL` 指向它，由静态托管层改为反代/302 到 dev server
 *
 * 本模块只**如实报告**两者的状态（见 `resolveWebPanelAssets`），不替托管层决策，
 * 也不在资源缺失时假装成功 —— 静默返回一个不存在的目录，就会退化成线上 404。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 面板 URL 前缀。与三处强耦合，改一处必须同步改三处：
 *   - `vite.webPanel.config.ts` 的 `base`（决定产物里资源 URL 的写法）
 *   - 静态托管层的路由前缀
 *   - 会话 Cookie 的 `Path`（决策卡 §3：前缀不一致 → 浏览器不发 cookie → 静默 401）
 */
export const WEB_PANEL_URL_PREFIX = '/panel/'

/** 构建产物目录名（`vite.webPanel.config.ts` 的 `build.outDir` 末段） */
export const WEB_PANEL_OUT_DIR_NAME = 'webPanel'

/** 入口 HTML 文件名 */
export const WEB_PANEL_ENTRY_HTML = 'index.html'

/** 开发模式下指向面板 vite dev server 的环境变量名 */
export const WEB_PANEL_DEV_URL_ENV = 'KIRO_WEB_PANEL_DEV_URL'

export interface WebPanelAssets {
  /**
   * 静态资源根目录的绝对路径。打包后为 asar 内路径
   * （`...\app.asar\out\webPanel`）—— fs 层透明，可直接读。
   */
  root: string
  /** 入口 HTML 的绝对路径（`root/index.html`） */
  entryHtml: string
  /**
   * 产物是否真实存在（实测 `entryHtml` 而非仅目录 —— 空目录同样是 404）。
   * `false` 时托管层应返回可诊断的错误，**不要**静默 404：
   * 「面板资源未构建，请运行 npm run build:webpanel」远比一个裸 404 有用。
   */
  available: boolean
  /**
   * 面板 vite dev server 的 URL（仅当设置了 `KIRO_WEB_PANEL_DEV_URL` 时）。
   * 非空时托管层应优先反代/重定向到它以获得 HMR，忽略 `root`。
   */
  devServerUrl?: string
}

/**
 * 面板静态资源根目录。dev 与 packaged 同一条相对路径（见文件头说明）。
 *
 * 之所以基于 `__dirname` 而非 `app.getAppPath()`：本模块被主进程打包进
 * `out/main/index.js`，`__dirname` 恒为该 bundle 所在目录，与 Electron 的
 * app 路径语义解耦，也让本函数在纯 node 下（单元测试）可直接调用 —— 不需要
 * mock electron 模块。
 */
export function getWebPanelAssetRoot(): string {
  return resolve(join(__dirname, '..', WEB_PANEL_OUT_DIR_NAME))
}

/**
 * 静态托管层的入口。一次性返回路径 + 可用性 + dev server URL，
 * 让调用方在一个地方拿到全部事实，而不是分三次问、各自判断。
 */
export function resolveWebPanelAssets(): WebPanelAssets {
  const root = getWebPanelAssetRoot()
  const entryHtml = join(root, WEB_PANEL_ENTRY_HTML)
  const devServerUrl = process.env[WEB_PANEL_DEV_URL_ENV]?.trim()

  return {
    root,
    entryHtml,
    available: existsSync(entryHtml),
    ...(devServerUrl ? { devServerUrl } : {})
  }
}
