# 无头服务化迁移 · 构建侧现实侦察（Mode R）

- 日期：2026-08-09
- 侦察范围：**仅构建配置 / package.json 脚本 / 原生依赖形态 / 外部先例**。不读业务代码实现（另有 sub 负责依赖剖析与语义判定）。
- 目标：Electron 桌面应用 → Linux 服务器无界面 7×24 服务（账号池 + 反代 + 已有 Web 面板）
- 输出边界：本报告只做侦察与路径成本对比，不产出 spec/tasks/domain-model，不改任何文件。
- 工具预算：≤28 次，实际约 20 次。

## 1. 构建现状（A）

### 1.1 构建入口：3 个目标 + 1 个独立目标，共两条流水线

`package.json:19` `build` = `typecheck && electron-vite build && build:webpanel`，即**两个互不相干的构建器串联**：

| 流水线 | 配置文件 | 目标 | 产物 | 服务端是否需要 |
|---|---|---|---|---|
| electron-vite | `electron.vite.config.ts:7` `main` | 主进程 | `out/main/index.js`（+ `out/main/secureBackup-*.js` 动态分包） | ✅ 核心 |
| electron-vite | 同上 `:10` `preload` | preload | `out/preload/index.js` | ❌ 桌面端专属 |
| electron-vite | 同上 `:13` `renderer` | 桌面 UI | `out/renderer/{index.html,assets/}` | ❌ 桌面端专属 |
| 独立 vite | `vite.webPanel.config.ts` | 局域网面板 | `out/webPanel/{index.html,assets/}`（`build.outDir` 绝对路径 `:64`） | ✅ 核心 |

`npm run build:webpanel`（`package.json:29`）→ `vite build --config vite.webPanel.config.ts` → **`out/webPanel/`**。已实测存在（`out/webPanel/index.html` + `assets/`）。

### 1.2 已有的「接近纯 Node bundle」脚本：**没有**

- `scripts/` 下只有 `patch-kiro-ide.cjs` 一个文件，与服务化无关。
- `electron-builder.yml` 的 `linux.target` = `AppImage / snap / deb`，全部是**桌面**分发形态（`linux:` 段 + `deb.afterInstall: build/linux/after-install.sh`），不是服务端 tarball。
- 结论：无论走哪条路径，**都要新增一个构建入口**。这是两条路径的共同成本，不构成差异。

### 1.3 构建侧的三个硬约束（决定路径成本的真实变量）

1. **依赖被 externalize，产物不自含**。`main` / `preload` 都挂 `externalizeDepsPlugin()`（`electron.vite.config.ts:8,11`）→ `out/main/index.js` 里所有 `dependencies` 都是 `require('xxx')` 外置引用。服务端必须带 `node_modules`，不能只拷一个 js 文件。
2. **原生依赖 + 平台专属二进制，只备了 Windows**。`electron-builder.yml:28-31` `asarUnpack` 含 `koffi` / `tlsclientwrapper` / `piscina`（三者是同一条链：`tlsclientwrapper@4.2.0` 的 deps 就是 `koffi ^2.15.2` + `piscina ^5.1.4`，见其 `package.json:64-67`）；`:32-34` `extraResources` **只有** `tls-client-xgo-1.14.0-windows-amd64.dll`。
   - `resources/` 目录实测只有这一个二进制，无 `.so`。
   - 但代码侧已按平台分支拼名（`src/main/registration/registrar.ts:322` → `linux-amd64.so` / `linux-arm64.so`），且第 4 档回退是「交给 tlsclientwrapper 自动下载」（`:366` 注释 + npm README「Automatic TLS library download」）。→ **Linux 上 .so 可自动落地，但首启依赖外网可达；离线机器需预置 `.so`**。这是运维项，两条路径同样承担。
3. **面板资源路径契约把「产物位置」焊死在 `out/main` → `../webPanel` 的相对关系上**。`src/main/utils/webPanelAssetRoot.ts:96` `resolve(join(__dirname,'..','webPanel'))`，且该文件头部明确写了「故意不写 `app.isPackaged` 分支」，因为 dev 与打包下这条相对路径恒等。→ **服务端 bundle 只要维持 `<root>/main/index.js` + `<root>/webPanel/` 的目录形状，此文件零改动**；若把服务端产物拍平成单目录，这里就要改，并连带 `WEB_PANEL_URL_PREFIX`（`:52`）的三处消费点契约（配置 `base` / 静态托管前缀 / Cookie Path，同文件已标注）。

### 1.4 electron 依赖面的量化底数（供两条路径共用）

`src/main/` 共 80 个 `.ts` 文件 / 35,974 行。`git grep "from 'electron'"` 命中 **11 个文件 12 处**（`src/preload/index.ts` 另计，服务端不需要）：

| 文件:行 | 用到的 electron API | 服务端替代难度 |
|---|---|---|
| `index.ts:1` | `app, shell, BrowserWindow, ipcMain, dialog, globalShortcut` | 高（6628 行 + 133 个 `ipcMain.handle`） |
| `ipc/proxyPool.ts:6` | `ipcMain` | 低（纯注册层） |
| `ipc/webPanelWiring.ts:14` | `ipcMain` | 低（且该文件已把 `AdminKeyStore` 做成注入端口，`:100` 注释明说 `auth.ts` 刻意不 import electron） |
| `kproxy/index.ts:2` | `app`（`app.getPath` ×1） | 低（换路径提供者） |
| `machineId.ts:11` | `app, dialog`（`getPath` ×3） | 中（`dialog` 在服务端无处可弹） |
| `proxy/logger.ts:4` | `app`（`getPath` ×1） | 低 |
| `registration/ipc-handlers.ts:1` | `ipcMain, BrowserWindow` | 中 |
| `registration/proton-mail-window.ts:16` | `BrowserWindow, session` | **高（真要浏览器）** |
| `secureBackup.ts:9` | `safeStorage`（7 处） | 中（需换 OS keyring 或口令派生） |
| `tray.ts:2` | `Tray, Menu, nativeImage, app, BrowserWindow, dialog` | 无（服务端不需要托盘，整个文件不加载） |
| `utils/emitToRenderer.ts:31,32` | `WebContents`（type）, `app` | 低（事件广播换 EventEmitter/SSE） |
| `registration/registrar.ts:317` | `require('electron')` 动态取 `app.getPath('userData')` | 低（但注意这是 **runtime require，grep `from 'electron'` 抓不到**） |

`app.getPath` 全仓 13 处，分布 7 个文件（`index.ts` 3 / `machineId.ts` 3 / `proxy/proxyServer.ts` 3 / `kproxy` 1 / `proxy/logger.ts` 1 / `proxy/selfSignedCert.ts` 1 / `registration/registrar.ts` 1）。→ **`app.getPath` 是最高频的单一 electron 耦合点，也是最容易一次收口的**（一个 `paths` 端口即可）。

`electron-store` 只在 `index.ts:1958` 动态 import 一次，其余全是「最小接口签名 + 注入」形态（`accountService/state.ts:15` / `accountService/types.ts:235` / `ipc/webPanelWiring.ts:27`）。→ 持久化层**已经是端口化的**，换实现成本低。

子目录规模（供拆包定量）：`proxy` 18 文件/13,876 行 · `registration` 14/4,666 · `accountService` 18/4,240 · `webPanel` 10/2,358 · `kproxy` 4/1,056 · `ipc` 3/800 · `index.ts` 6,628 行。

---

## 2. 路径 A「抽取共享内核」成本

### 2.1 要改什么（file 锚点）

**内核侧（几乎零改动，这是本项目最大的既有资产）**
- `src/main/accountService/`（18 文件/4240 行）、`src/main/webPanel/`（10 文件/2358 行）整体不 import electron —— 已确认（`git grep "from 'electron'"` 在这两目录零命中）。`webPanel/auth.ts:23` 明确写着「adminKey 持久化端口，由 index.ts 用 electron-store 实现并注入」，`ipc/webPanelWiring.ts:100` 补上「`auth.ts` 刻意不 import electron」。→ **这是有意做的端口化，路径 A 不是新发明架构，是把既有设计走完最后一步。**
- `src/main/utils/webPanelAssetRoot.ts` 已刻意基于 `__dirname` 而非 `app.getAppPath()`，文件头注释：「让本函数在纯 node 下（单元测试）可直接调用 —— 不需要 mock electron 模块」。→ **零改动**（前提：服务端 bundle 保持 `<root>/main/` + `<root>/webPanel/` 目录形状，见 §1.3-3）。

**需要新建的薄壳与端口（数量级：新增 4-7 个文件）**
1. `paths` 端口：替掉 13 处 `app.getPath`（7 个文件）。桌面壳用 `app.getPath`，服务端壳用 `XDG_*` / `--data-dir`。
2. `secrets` 端口：替 `secureBackup.ts` 的 7 处 `safeStorage`。**这是路径 A 唯一的语义风险点**：`safeStorage` 在 Linux 上本身依赖 libsecret/kwallet，服务器上无 keyring；服务端需换成口令派生（KDF + 环境变量/文件）——**行为不等价，是产品决策不是技术细节**，必须上报。
3. `events` 端口：替 `utils/emitToRenderer.ts`（桌面 → `WebContents.send`；服务端 → EventEmitter/SSE，面板已有 HTTP 通道）。
4. 服务端入口 `src/server/main.ts`：不注册 `ipcMain`，直接组装 accountService + proxy + webPanel server + 信号处理（SIGTERM 优雅退出）。
5. 新构建入口（`vite.server.config.ts` 或 tsup），产物 `out/server/`。
6. `registration/proton-mail-window.ts`（BrowserWindow + session 做真实浏览器流程）→ **服务端不提供该能力，或降级**。这条也是产品决策。

**要动的既有文件（数量级：11-18 个）**
- 11 个 import electron 的文件里，`tray.ts` 整个不加载（0 改动）、`ipc/*.ts` 3 个是注册层（服务端不加载，0 改动）、`registration/proton-mail-window.ts` 走降级 → **真正要改的是 `index.ts` + `machineId.ts` + `kproxy/index.ts` + `proxy/logger.ts` + `proxy/proxyServer.ts` + `proxy/selfSignedCert.ts` + `secureBackup.ts` + `utils/emitToRenderer.ts` + `registration/registrar.ts:317`（runtime require）约 9 个**。
- 其中 `index.ts` 6628 行 / 133 个 `ipcMain.handle` 是**最大单点**：它同时是 IPC 注册地和「组装图」。路径 A 的实际工作量集中在把「组装」从「IPC 注册」里剥出来，而不是逐个 handler 迁移（handler 本身是桌面端专属，服务端不要）。

### 2.2 对现有桌面端的回归风险

- **中等，且可控**。风险不在内核（内核本来就不碰 electron），而在**桌面端从「直接调 `app.getPath`」改成「经端口调」**这一步：13 个调用点若有任一处路径语义漂移（如 `userData` vs `appData`），桌面端的账号数据/证书/日志就落到新位置 → 表现为「升级后账号全没了」。
- `registrar.ts:317` 的 `require('electron')` 是 **runtime require**，`grep "from 'electron'"` 抓不到；同类隐藏耦合可能还有（本次未穷尽扫 `require('electron')`，见 §6）。漏掉一处 → 服务端启动即崩，但桌面端无感 → **CI 里必须有一条「纯 node 加载内核」的冒烟测试**，否则回归靠人肉。
- 缓解：端口默认实现保持与现状字节级一致的路径；改动前后跑一次 `app.getPath` 各 key 的实际值对账。

### 2.3 运维成本

- 产物 = `out/server/` + `node_modules`（externalize 决定，见 §1.3-1）+ `out/webPanel/`。运行时 = **纯 Node ≥18**（`tlsclientwrapper` 声明 `engines.node >=18`）。
- 无 X11、无 Chromium、无 xvfb。内存 = Node 基线 + piscina worker 池（`registration/tlsClientPool.ts` 是共享池，`registrar.ts:297` 注释「首次注册才真正 open(DLL+worker pool)，之后所有注册秒级复用」）。
- 唯一原生件：`tls-client-xgo-1.14.0-linux-amd64.so`（自动下载或预置）+ `koffi` 预编译 binding。
- systemd 单元直接可写，无 wrapper。

## 3. 路径 B「无头 Electron」成本

### 3.1 要改什么

代码侧改动最小：不 `new BrowserWindow`、不建 Tray、`app.whenReady` 后直接起服务。数量级 **1-3 个文件**（`index.ts` 加一个 `--headless` 分支 + `tray.ts` 跳过 + `main` 字段/启动参数）。`electron-builder.yml` 需加 linux 服务端 target 或直接用 `linux-unpacked`。

**但这是「改动少」而不是「成本低」——成本转移到了运行时与运维。**

### 3.2 决定性事实：Electron 官方不支持原生 headless，且已明确放弃

- Electron 官方文档至今只给一个答案：装 Xvfb + 设 `$DISPLAY`（`https://electronjs.org/docs/latest/tutorial/testing-on-headless-ci`，原文「Electron requires a display driver to function. If Chromium can't find a display driver, Electron will fail to launch」）。
- 原生 headless 的 PR **`electron/electron#38126` "feat: enable new headless mode" 于 2025-11-26 被维护者 georgexu99 关闭**，理由原文：「headless mode is something that the maintainers do not have the capacity for supporting as it ... is a rather large undertaking」。此前 `MarshallOfSound` 指出 Chromium 自己的 `--headless` 默认仍是 `--headless=old`（另一套 `Shell` 实现），`zcbenz` 指出「Chromium 在 headless 下不会禁掉 GTK，禁掉会 break lots of things」。
- 关联 issue `electron/electron#29164` 被标记为 `#228` 的重复项并关闭 —— **这个需求从 2021 年提到 2025 年，结论是不做**。
- ⚠️ 判据含义：路径 B 的「配 headless 参数」这个选项**不存在**，只剩 xvfb 一条路。而 xvfb 不是官方支持面，是社区 workaround。

### 3.3 运维成本（实测先例）

从 `stablyai/orca` 的 `docs/reference/headless-linux-server.md`（同类需求：Electron 应用 `serve` 模式跑 VPS）抄出的真实依赖清单与坑：
- 需装：`xvfb` + AppImage 运行时依赖（`curl file jq zlib1g-dev`），Ubuntu 22.04 还要 `libfuse2`（24.04/Debian 是 `libfuse2t64`）。
- **Docker 里通常没有 FUSE 设备** → 必须 `--appimage-extract` 或 `--appimage-extract-and-run`；而 extract-and-run 会在启动前往 stdout 打印路径，**污染需要「stdout 只有 ready JSON」的自动化**。
- 需要 `LIBGL_ALWAYS_SOFTWARE=1`。
- 该项目选择「`orca serve` 时若无 `DISPLAY` 就自动拉起 Xvfb」，即**把 xvfb 生命周期管理写进了应用自己**（否则 systemd 里要套 `xvfb-run`）。

`electron/electron#26974`「Crash on startup when running headless in Docker」给出 Electron 11 起在 Docker+xvfb 下 **`Received signal 11 SEGV_MAPERR`** 崩溃的实例，同时报 `Failed to connect to the bus: /var/run/dbus/system_bus_socket: No such file or directory` —— 即除 xvfb 外还牵出 **D-Bus** 这条依赖（`orca` 文档说自己不需要独立 D-Bus session，但这本身说明它是个需要逐环境验证的变量，不是恒真）。

Docker 里 Electron 的常见依赖集（同 issue 的 Dockerfile 原文）：`xvfb libgbm1 libxss1 libnss3 libgtk-3-dev libasound2-dev`。

内存：一个 Chromium 主进程 + zygote + GPU 进程（即便软件渲染）+ Xvfb 进程，量级是纯 Node 的数倍；7×24 场景下 Electron/Chromium 的长期驻留内存增长也需要额外看护（本次未实测数字，见 §6）。

### 3.4 对现有桌面端的回归风险

**低**。桌面端代码路径基本不动，只是多一个启动分支。这是路径 B 唯一的真实优势。

### 3.5 一个被忽略的第三选项：`ELECTRON_RUN_AS_NODE`

`ELECTRON_RUN_AS_NODE=1` 让 electron 二进制退化成 node（先例：StackOverflow 57641267、snapcraft 论坛 31389 的 `pdf-generator` snap 就同时配了这两种 app）。**但这时 `electron` 模块不可用** —— 即 `app` / `safeStorage` / `BrowserWindow` 全部拿不到，等于**必须先做路径 A 的端口化**才能用。所以它不是第三条路，而是「路径 A 完成后可选的运行时载体」（好处：原生模块 ABI 与桌面端一致，不用为 node 与 electron 各编一份 koffi）。

## 4. 外部先例（可核验锚点）

| 结论 | 工具 | 原始 query | top1 锚点 |
|---|---|---|---|
| Electron 官方要求 display driver，只给 xvfb 方案 | exa `web_search_exa` | `run Electron app headless on Linux server production xvfb long-running service` | `https://electronjs.org/docs/latest/tutorial/testing-on-headless-ci` — "Testing on Headless CI Systems" |
| 原生 headless PR 被维护者以「无力支持」关闭（2025-11-26） | exa `crawling_exa` | url `https://github.com/electron/electron/pull/38126` | PR #38126 "feat: enable new headless mode" · state closed |
| 同需求 issue 被判重复并关闭 | exa `crawling_exa` | url `https://github.com/electron/electron/issues/29164` | issue #29164 · closed · duplicate of #228 |
| 真实项目在 VPS 跑 Electron 的完整依赖与坑（AppImage/FUSE/LIBGL/自动拉 Xvfb） | exa `web_search_exa` | 同上 | `https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md` |
| **有项目明确提供「Node-only daemon，无窗口无 Xvfb」作为生产推荐路径，把 headless Electron 列为次选** | exa `web_search_exa` | 同上 | `https://github.com/CoWork-OS/CoWork-OS/blob/main/docs/vps-linux.md` — 三条安装路径，原文把 packaged server release / `coworkd-node` 排在 "Headless Electron daemon from source: closer to desktop parity, but requires Electron runtime deps + Xvfb" 之前 |
| Docker + xvfb 下 Electron SEGV + D-Bus 缺失实例 | tavily `tavily_search` | `Electron headless Linux server xvfb docker memory overhead production 24/7` | `https://github.com/electron/electron/issues/26974` — "Crash on startup when running headless in Docker" |
| xvfb 自身运维脆弱性（display 占用 / lock 文件残留） | tavily `tavily_search` | 同上 | `https://github.com/cypress-io/xvfb/issues/98` — "Xvfb is completely ruining my life and job." |
| Electron 已切 Wayland-native，X11 在主流发行版正被移除 | tavily `tavily_search` | `Electron main process no BrowserWindow still requires X11 display Linux --headless flag not supported` | `https://electronjs.org/blog/tech-talk-wayland` — "KDE Plasma and GNOME are in the process of dropping X11 support completely" |
| `ELECTRON_RUN_AS_NODE` 作为逃逸口的先例 | exa `web_search_exa` | 同上 | `https://stackoverflow.com/questions/57641267/electron-as-system-service-with-electron-run-as-node` |
| tlsclientwrapper 自动下载 TLS 库 / koffi+piscina 依赖链 | exa `web_search_exa` | `tlsclientwrapper koffi tls-client shared library linux .so download automatic` | `https://www.npmjs.com/package/tlsclientwrapper` — "🔌 Automatic TLS library download and management" |

**未搜到对题结果的项**：Electron 长期驻留（7×24 月级）在 xvfb 下的内存增长实测数字 —— searched `Electron headless Linux server xvfb docker memory overhead production 24/7`，返回结果全是 CI/测试场景，无生产长跑内存基准。**不编造数字**，见 §6。

---

## 5. 对比表 + 推荐（C）

### 5.1 对比表

| 维度 | 路径 A 抽取共享内核 | 路径 B 无头 Electron + xvfb |
|---|---|---|
| 改动文件数量级 | 新建 4-7 · 改动约 9（11 个 electron 文件里 `tray.ts` / `ipc/*` 服务端不加载） | 1-3（`index.ts` 加分支 · 跳过 `tray.ts` · builder target） |
| 最大单点 | `index.ts` 6628 行 / 133 个 `ipcMain.handle` —— 剥「组装」而非迁 handler | 无 |
| 内核是否已就绪 | **是**：`accountService/`(4240行) `webPanel/`(2358行) 零 electron 引用，`webPanel/auth.ts:23` 已端口化 | 不适用 |
| 桌面端回归风险 | **中**：13 处 `app.getPath` 换端口若路径语义漂移 → 账号数据丢失级故障；`registrar.ts:317` 是 runtime require 类隐藏耦合 | **低**：桌面路径基本不动 |
| 服务端运行时 | 纯 Node ≥18 | Chromium + Xvfb（+ 可能 D-Bus） |
| 服务端依赖包 | `node_modules` + 1 个 `.so`（自动下载/预置） | 上述 + `xvfb libgbm1 libxss1 libnss3 libgtk-3-dev libasound2-dev`（+ Ubuntu22 `libfuse2`） |
| 内存量级 | Node 基线 + piscina 池 | Node 基线 + Chromium 多进程 + Xvfb（数倍；**长跑数字未实测**） |
| 官方支持面 | 完整（普通 Node 服务） | **无**：PR #38126 已于 2025-11-26 被官方以「无力支持」关闭；issue #29164 判重关闭 |
| 已知运维坑 | 首启需外网下 `.so`（离线需预置）；`safeStorage` 无 keyring 需换方案 | SEGV in Docker(#26974)、D-Bus 缺失、FUSE 缺失需 appimage-extract、extract-and-run 污染 stdout、xvfb display 占用/lock 残留(#98)、X11 正被发行版移除 |
| 长期方向对齐 | 与 Electron 官方无关，不受其影响 | 逆风：Electron 已 Wayland-native，X11 在 GNOME/KDE 正被移除 |
| 功能等价性缺口 | `proton-mail-window.ts`（BrowserWindow+session）服务端无法等价 → 需降级决策 | 无缺口（这是 B 的真实优势） |

### 5.2 推荐：路径 A，但分两步走，第一步先用 B 换时间

**推荐路径 A**，理由挂在三个可核对锚点上：

1. **内核已经端口化了，A 不是新架构而是把既有设计走完**。`accountService/`(18 文件 4240 行) 与 `webPanel/`(10 文件 2358 行) 对 `from 'electron'` 零命中，`webPanel/auth.ts:23` 写着「持久化端口，由 index.ts 注入」、`ipc/webPanelWiring.ts:100` 写着「`auth.ts` **刻意**不 import electron」、`utils/webPanelAssetRoot.ts` 头部写着「让本函数在纯 node 下可直接调用 —— 不需要 mock electron」。**前人已经按 A 的方向铺了路**；选 B 等于把这些注释作废。
2. **B 的核心前提被官方否掉了**。`electron/electron#38126` 2025-11-26 关闭 + `#29164` 判重关闭 → 「配 headless 参数」不存在，只有 xvfb workaround；而 Electron 官方正走 Wayland-native、X11 在主流发行版被移除。B 的运维面**只会越来越窄**，A 的运维面（纯 Node 服务）是零风险面。
3. **B 的「改动少」是账面便宜，成本被推到了运维与故障排查**。`stablyai/orca` 与 `CoWork-OS` 两个同类项目的文档都实打实列了 FUSE/LIBGL/Xvfb 生命周期这套；`CoWork-OS` 更直接把 "Node-only daemon ... no Xvfb" 列为**生产 VPS 推荐**，把 headless Electron 排在最后并注明 "requires Electron runtime deps + Xvfb"。同类项目做过一遍这个选择，结论与 A 一致。
4. **A 的最大工作量项其实不用做**。`index.ts` 6628 行里 133 个 `ipcMain.handle` 是桌面端专属，服务端不需要它们 —— A 的工作是把「组装图」从「IPC 注册」里剥出来，不是逐个迁 133 个 handler。这一点会让 A 的实际成本显著低于「6628 行大文件」给人的第一印象。

**分步建议（如果服务端上线时间紧）**：先用 B 起一个不对外承诺的临时形态换时间（改动 1-3 文件），同时按 A 推进端口化；A 完成后可选择用 `ELECTRON_RUN_AS_NODE` 承载（原生模块 ABI 与桌面端一致，不用为 node/electron 各编一份 koffi）。**但需明确：B 是脚手架不是终点**，否则 xvfb 会长成永久债。

### 5.3 必须上报给用户的产品决策（不由 AI 决定 · Globalrules §0.12 / §0.17）

这三项都不是实现细节，是**服务端行为与桌面端不等价**，两条路径都要面对（B 也一样，因为服务器上同样没有 keyring / 没人点弹窗）：

1. **`secureBackup.ts` 的 `safeStorage`（7 处）在服务器上无 OS keyring**。服务端必须换成口令派生/环境变量密钥，**加密强度与信任模型都变了**。要问用户：服务端备份是否仍需加密、密钥由谁保管。
2. **`registration/proton-mail-window.ts`（BrowserWindow + session）是真实浏览器流程**，服务端无等价物。要问用户：服务端是否需要注册能力，还是只跑「已有账号池 + 反代」。（**这条是路径 A 与 B 的分水岭**：若服务端必须保留浏览器注册流程，B 的 xvfb 就从「运维负担」变成「刚需」，推荐会翻转 —— 需先确认。）
3. **`machineId.ts` 的 `dialog`（错误时弹窗）在服务端无处可弹**，需改成「记日志 + 拒绝启动」还是「降级继续」。

## 6. 未覆盖 / 待确认

- **未穷尽扫 `require('electron')` 动态引用**。已确认 `registrar.ts:317` 存在这一形态（`git grep "from 'electron'"` **抓不到**），同类隐藏耦合可能还有。→ 交给依赖剖析 sub 或补一次 `git grep "require('electron')"` + everything-search（覆盖未跟踪文件）。
- **Electron+xvfb 7×24 长跑内存实测数字缺失**。searched `Electron headless Linux server xvfb docker memory overhead production 24/7`，返回全是 CI/测试场景，无生产长跑基准 —— 报告中只写「数倍量级」，未编造具体 MB 数。若要作为决策依据需自建实验。
- **未读业务代码实现**（本任务硬约束）。§1.4 的「服务端替代难度」列是基于 import 面与调用计数的构建侧推断，语义判定归另一个 sub。
- **未验证 Linux 下 koffi 预编译 binding 是否覆盖目标发行版 glibc**。`npmRebuild: false`（`electron-builder.yml:100`）说明当前不做原生重编译；Linux 服务端若 glibc 过旧，koffi/piscina 可能需要额外处理。
- **未测 `out/webPanel/` 产物在纯 Node 静态托管下是否真能提供**（`webPanelAssetRoot.ts` 的路径推导已读，逻辑上 dev/packaged 恒等，但服务端 bundle 目录形状是新场景，需实测一次）。
- **未评估 `secureBackup-BfbGHsbZ.js` 动态分包对服务端 bundle 的影响**（`out/main/` 下存在这个独立 chunk，说明 `secureBackup` 是动态 import 出去的；服务端若走新构建入口需确认分包行为一致）。
