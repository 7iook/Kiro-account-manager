# toolkit 依赖迁移 devDependencies · 执行记录

任务：把 `@electron-toolkit/utils` / `@electron-toolkit/preload` 从 `dependencies` 移到
`devDependencies`，切断「prod 依赖 peer 上 electron」这条把 ~100MB electron 拖进
`npm ci --omit=dev` 树的因果链。

## 交付契约核验（§0.16）

派单未附 `[交付契约]` 块，但成功态可从**代码消费者的前置条件**读出（来源 ②，非自撰）：

成功态：**不是**「package.json 里两个包挪了位置」，**而是**运维在服务器上跑
`npm ci --omit=dev` 后得到的 `node_modules` 里没有 `electron/`，而服务端运行时依赖
（conf / undici / uuid / node-forge / socks / cbor-x / koffi / tlsclientwrapper）全部可解析。
负条件：**桌面端不得因此坏** —— `out/main/index.js` / `out/preload/index.js` 里
`electronApp` / `optimizer` / `is` / `electronAPI` 四个符号必须仍然可用（不得变成
运行时 MODULE_NOT_FOUND）。

链路表（每格已 grep 核实，见下）：

| 节点 | 生产者 | 消费者 |
|---|---|---|
| toolkit 包位置 | `package.json:36-37`(dependencies) → 迁至 devDependencies | `package-lock.json` 的 `""` root 节点 + `node_modules/@electron-toolkit/*` 节点的 `dev` 标记 |
| electron 进 prod 树的因果 | 两包 `peerDependencies.electron` (`node_modules/@electron-toolkit/utils/package.json:38`, `preload/package.json:40`) | `npm ci --omit=dev` 的解析结果（scratch 树实测） |
| 桌面 main 消费 | `src/main/index.ts:5` | `out/main/index.js` 产物 |
| 桌面 preload 消费 | `src/preload/index.ts:2` | `out/preload/index.js` 产物 |
| external 判定 | `electron.vite.config.ts:8,11` 的 `externalizeDepsPlugin()` | `node_modules/electron-vite/dist/index.js:349` 只读 `pkg.dependencies` |

## 关键侦察结论（决定了本次改动的风险形态）

**`externalizeDepsPlugin()` 只从 `pkg.dependencies` 取 external 清单**
（`node_modules/electron-vite/dist/index.js:349-373`，实测源码）。
`electron` 本身另有硬编码 external（`dist/chunks/lib-ClgyQuZx.js:280,391`
`external: ['electron', /^electron\/.+/, ...builtinModules]`），不受 dependencies 影响。

推论：把两个 toolkit 包挪进 devDependencies 后，它们**不再被 externalize，而是被 vite
内联进 `out/main/index.js` / `out/preload/index.js`**。这恰好是打包所需的正确形态 ——
electron-builder 会把 devDependencies 从 app bundle 里剪掉，若产物仍留
`require("@electron-toolkit/utils")` 就会在启动时 MODULE_NOT_FOUND。内联把这条风险
在**构建期**消掉，而不是留到启动期。

内联安全性已核实：两个包都是纯 JS、dual-format（`main: dist/index.cjs` +
`module: dist/index.mjs`）、**运行时依赖为零**（manifest 里只有 `peerDependencies.electron`，
无 `dependencies`）。即内联闭包不会牵进任何第三方包，也不会牵进 electron
（`import { app } from 'electron'` 会命中上面那条硬编码 external，仍留 `require("electron")`
—— 桌面端 electron 运行时里它是内置可解析的）。

## 改动内容

### package.json（diff 已核实，见 pkg.diff）

```
@@ dependencies @@
-    "@electron-toolkit/preload": "^3.0.2",
-    "@electron-toolkit/utils": "^4.0.0",
@@ devDependencies @@
+    "@electron-toolkit/preload": "^3.0.2",
+    "@electron-toolkit/utils": "^4.0.0",
```

（注：`pkg.diff` 里还有一行 `postinstall` 的改动 —— 那是上一个 agent 的既有工作，不是本轮。）

### package-lock.json

`npm install --package-lock-only --ignore-scripts` → EXIT=0，+74/-11 行。
不是只加两个 `dev: true` —— **约 70 个包新增 `dev: true` 标记**，即 electron 的整条传递闭包
从 prod 图里退出了。另有若干 `devOptional: true` → `dev: true` 的收紧（该包原先同时被
prod 与 dev 两条路径可达，现在只剩 dev 一条）。这正是「原缺陷把多少东西拖进了 prod 树」
的量化证据。

lockfile 实测（`probe-lock.ps1`）：

```
node_modules/electron                         dev=True
node_modules/@electron-toolkit/utils          dev=True
node_modules/@electron-toolkit/preload        dev=True
node_modules/conf | undici | uuid | koffi | tlsclientwrapper | cbor-x | node-forge | socks
                                              dev=(空) ← 仍是 prod
root.dependencies    contains toolkit/*  : False
root.devDependencies contains toolkit/*  : True
912 packages 总计 / 711 dev=true / 197 prod-only
```

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck:node` | **EXIT=0** |
| 桌面构建 | `npm run build` | **EXIT=0** |
| lockfile 生成 | `npm install --package-lock-only --ignore-scripts` | **EXIT=0** |
| prod 树安装 | scratch 树 `npm ci --omit=dev` | **EXIT=0** · added 107 packages in 4s |
| prod 运行时 | `node probe-runtime.mjs` | **EXIT=0** · FAILCOUNT=0 |

退出码全部经 `*> file` 重定向 + `$LASTEXITCODE` 取得，无管道。

### 桌面打包风险（本任务的真风险）——已在构建期消解

派单担心的形态是「build 绿、启动炸」。核实后**结论相反，且新形态比旧形态更安全**：

改前（externalize，实测基线）：
```
out/main/index.js:32   const utils = require("@electron-toolkit/utils");
```
这一行才是隐患 —— electron-builder 从 app bundle 剪掉 devDependencies 后它会
MODULE_NOT_FOUND。若两个包留在 `dependencies`，产物就永远带着这行 require，
靠「包恰好被打进 bundle」活着。

改后（实测产物）：
```
out/main/index.js    @electron-toolkit 残留 require 命中 = 0
out/preload/index.js @electron-toolkit 残留 require 命中 = 0
out/main/index.js:543    const electronApp = { ...        ← 实现被内联
out/main/index.js:565    const optimizer = { ...
out/main/index.js:25672  electronApp.setAppUserModelId("com.kiro.account-manager");
out/main/index.js:25674  optimizer.watchWindowShortcuts(window);
out/preload/index.js:3    const electronAPI = { ...
out/preload/index.js:1065 electron.contextBridge.exposeInMainWorld("electron", electronAPI);
out/preload/index.js:1071 window.electron = electronAPI;
```

即产物**不再引用这两个包**，四个符号（`electronApp` / `optimizer` / `is` / `electronAPI`）
的实现已内联进产物本体，消费点仍在。桌面运行时不需要这两个包存在 —— 于是
electron-builder 剪不剪 devDependencies 都无关。

机制根据（非推测，读的是 electron-vite 源码）：
- `node_modules/electron-vite/dist/index.js:349-373` `externalizeDepsPlugin()` 的 external
  清单**只**来自 `pkg.dependencies`；包不在其中 → 被内联。
- `node_modules/electron-vite/dist/chunks/lib-ClgyQuZx.js:280,391` main / preload 预设
  硬编码 `external: ['electron', /^electron\/.+/, ...builtinModules]` —— `electron` 本身
  不受 dependencies 影响，产物里仍是 `require("electron")`，由桌面 Electron 运行时提供。
- 内联安全性：两包均纯 JS + dual-format + **运行时依赖为零**（manifest 只有
  `peerDependencies.electron`，无 `dependencies`），故内联闭包不牵进任何第三方包。

`electron-builder.yml` 的 `files` / `asarUnpack` 未涉及这两个包，无需改动
（`asarUnpack` 只列 resources / koffi / tlsclientwrapper / piscina 三个原生件）。

**未做真实 `build:win`**：`npm run build`（= typecheck + electron-vite build + webpanel）
已产出上述实测产物，而判定所依赖的事实是「产物里是否还引用这两个包」——
这个事实在 `electron-vite build` 阶段就已确定，`electron-builder` 之后只做封装/剪枝，
不会重新引入 require。故此处不靠「跑一次 build:win 看它绿」而靠**读产物**定论，
证据强度更高（build:win 绿也不能证明启动时符号可用，而产物无残留 require 可以）。

### prod 树无 electron（scratch 树实测）

scratch 路径 `F:\_scratch\2026-08-12\toolkit-deps-move\prodtree`（**未**动本仓 node_modules；
未复用上一个 agent 的 `F:\_scratch-postinstall\`）。只拷 `package.json` + `package-lock.json`
+ `scripts/postinstall.mjs`（后者必须拷，因为 `npm ci` 会跑它 —— 让 scratch 与真实部署路径同形）。

```
electron                         present=False
@electron-toolkit/utils          present=False
@electron-toolkit/preload        present=False
electron-builder                 present=False
app-builder-lib                  present=False
electron.exe count: 0
electron/dist dirs: 0
node_modules size MB: 150.9
残留 electron-*: electron-store / electron-updater   ← 二者是申明的 prod dep，预期保留
```

postinstall 按设计自跳过（`node_modules/.bin` 下无 electron-builder shim），install 未因此失败。

运行时解析（`probe-runtime.mjs`，`createRequire(import.meta.url)` 锚定，避免向上找到仓库完整树）：
九个服务端运行时依赖 conf / undici / uuid / node-forge / socks / cbor-x / koffi /
tlsclientwrapper / js-tiktoken **全部 OK**；`conf` 的 `.default` 可构造（对上
`vite.server.config.ts` 的 `interop:'auto'` 承重假设）；`require('electron')` 抛
**MODULE_NOT_FOUND** —— 成功态达成。

## 注释修正（7 处）

统一的准确表述：electron 不在 prod 树里，**不是**因为「它被声明为 devDependency」，
而是因为「它是 devDependency **且** `dependencies` 的传递闭包里没有任何包 peer 上它」。
第二个条件是原缺陷所在，也是唯一会被人静默推翻的那个。

| 文件:行 | 处理 |
|---|---|
| `src/main/proxy/logger.ts:7` | 展开成完整因果 + 记录历史违规（toolkit peer + npm/cli#6282）+ 指向新闸门。此处是主叙述点，其余处引用它 |
| `src/main/server/assembly.ts:18` | 补第二个条件 + 指向 logger.ts 头部 |
| `vite.server.config.ts:100`（插件报错文案） | 「且 electron 是 devDependency，又无任何 prod 依赖 peer 上它」 |
| `vite.server.config.ts:111`（`externalDeps()` 头注） | 补一段实质内容：「从 `dependencies` 读」这条正是本次迁移可行的机制根据（移出 → 自动内联而非 external），并记录 2026-08-12 的实测产物形态 |
| `test/main/architecture/kernel_without_electron.test.ts:427` | 断言消息补第二个条件 |
| `test/main/architecture/server_build_target.test.ts:246` | 断言消息补第二个条件 |
| `test/main/proxy/loggerElectronDecoupling.test.ts:6` | 补第二个条件 + 标注「曾一度不成立」+ 指向闸门 |

另核实 `kernel_without_electron.test.ts:52` 也含 `devDependency` 字样，但它讲的是
「开发机上 `require('electron')` 成功返回字符串」这一实测事实，与 prod 树无关，**未改**
（改它会把一段正确的说明改坏）。

## 新增闸门

`test/main/architecture/prod_tree_has_no_electron.test.ts`（5 条断言，全绿）

理由（对应派单里「可以论证不值得做闸门」的余地 —— 我判断值得）：
「prod 树无 electron」是一条**涌现属性**，不是声明能维持的事实。它取决于
`dependencies` 传递闭包里有没有包 peer 上 electron。任何人加一个 electron 生态的
prod 依赖都会静默推翻它，而 package.json 的 diff 看起来只是「加了个依赖」；
后果又不立刻可见（prod 树多个 electron 通常不报错，只是变大变慢，同时让上述 7 处
注释全部变成谎言）。这正是只有闸门能守、注释守不住的形状。

分层（诚实标注强度，姿态取自 `postinstall_conditional.test.ts` / `server_build_target.test.ts`）：

- **L1** 两个 toolkit 包在 devDependencies 且不在 dependencies（钉已知违规源）
- **L2** lockfile 的 `node_modules/electron` 带 dev 标记（`npm ci` 只读 lockfile）
- **L3** `dependencies` 传递闭包里无任何 electron puller —— 通用条，跟 dependencies /
  optionalDependencies / **非 optional 的** peerDependencies 三类边，读
  `node_modules/<pkg>/package.json` 的原始声明（包作者的真源，不随 npm 版本演进）
- **L4** package.json 与 lockfile root 节点分桶一致（防 lockfile 滞后 —— 本仓此前真发生过）
- **L5** 判定器自检：注入间接 peer 违规必须转红 + **反向控制**（optional peer 不该判违规）。
  没有 L5，L3 退化成「永远扫不到」时会恒绿，而恒绿与真干净在输出里同形（E-052 母题）

为什么不真跑 `npm ci --omit=dev`：合规时 4s + 网络，**违规时要下 100MB Electron**（分钟级）。
放进单测会让人去加 skip 而不是修。故断言的是决定那个结果的输入（npm 自己算的闭包结论）。

### 红证（TDD · 不是「写完就绿」）

`F:\_scratch\2026-08-12\toolkit-deps-move\verify-red.mjs` 从 `git show HEAD:` 取**改动前**的
package.json / package-lock.json 复算判定，实测 EXIT=0 · REDCOUNT=4：

```
RED  L1  @electron-toolkit/utils in old dependencies = ^4.0.0
RED  L1  @electron-toolkit/preload in old dependencies = ^3.0.2
RED  L2  old lockfile node_modules/electron dev=undefined devOptional=undefined
RED  L3  old dependencies 里 peer 上 electron 的包: ["@electron-toolkit/utils","@electron-toolkit/preload"]
```

其中 L2 那行是**独立的原缺陷直证**：改动前 lockfile 里 electron 节点既无 `dev` 也无
`devOptional` —— 它当时确实在 prod 图里。

## 最终验证汇总

| 项 | 命令 | 结果 |
|---|---|---|
| 全量类型检查 | `npm run typecheck` (node+web) | **EXIT=0** |
| 桌面构建（改注释后复跑） | `npm run build` | **EXIT=0** |
| 服务端构建 | `npm run build:server` | **EXIT=0** |
| 新闸门单跑 | `npx vitest run <gate> --reporter=json` | **5/5 passed** |
| 新闸门红证 | `node verify-red.mjs` | **REDCOUNT=4** |
| 全量测试套件 | `npx vitest run --reporter=json` | **1591 total / 1585 passed / 0 failed / 6 skipped / 483 suites / success=true** |

套件数字说明：基线 1550 → 现 1591（+41）。增量来自本轮 +5（新闸门）与并发 agent 的
adminKeyStore / postinstall 工作。**派单提到的 adminKeyStore ~12 条红已不存在** ——
实测 `adminKeyStore.test.ts status=passed · 65 tests · 0 failed`，即那两个 agent 在我跑
套件前已完成。故本轮无需单独扣减，全套 0 失败。

产物终态复核（改注释后）：
```
out/main/index.js    @electron-toolkit 命中 = 0 · const electronApp = { 定义 = 1
out/preload/index.js @electron-toolkit 命中 = 0 · const electronAPI = { 定义 = 1
out/server/index.js  require("electron")  命中 = 0
```

## Review Findings

**Tier 1 自更正（派单事实与代码不符 / 派单未预见的机制）：**

1. **派单对打包风险的判断方向相反 —— 已按代码实际机制执行。** 派单担心「devDependency
   的 import 会不会被打进 bundle」，隐含假设是「留在 dependencies 更安全」。实测
   `electron-vite/dist/index.js:349` 的 `externalizeDepsPlugin()` **只**从 `pkg.dependencies`
   取 external 清单：留在 dependencies 才是危险形态（产物带
   `require("@electron-toolkit/utils")`，实测基线 `out/main/index.js:32` 就是这一行，
   靠「electron-builder 恰好把包打进 bundle」活着）；移出后自动内联，产物不再引用该包，
   打包剪枝与否都无关。故本次改动**降低**了桌面打包风险，而非引入风险。

2. **未跑 `build:win`，改为读产物定论 —— 且这是更强的证据。** 派单允许「若判断只有真
   build:win 能定论就说出来」。我的判断是不需要：决定成败的事实（产物是否还引用这两个包）
   在 `electron-vite build` 阶段就已固化，electron-builder 之后只做封装/剪枝，不会重新
   引入 require。而 `build:win` 绿也**不能**证明启动时符号可用（它不启动 app），
   产物无残留 require + 实现已内联 + 消费点在，才是直接证据。

3. **lockfile 影响面远大于派单预期，已核实非误改。** `npm install --package-lock-only`
   产生 +74/-11：约 70 个包新增 `dev: true`，另有若干 `devOptional → dev` 收紧。
   这不是噪声，是「原缺陷把 electron 整条传递闭包拖进了 prod 图」的量化证据。
   已逐项核实九个服务端运行时依赖仍为 prod-only（`probe-lock.ps1`）。

4. **scratch 树必须补 `scripts/postinstall.mjs`。** 只拷 package.json + lockfile 会让
   `npm ci` 在跑 postinstall 时因脚本缺失而失败，那是环境假象而非真实部署形态。
   拷入后 install 走的路径与真实部署逐字相同（日志可见它按设计自跳过）。

**派单内部矛盾（已按更具体的指令执行，在此报出）：**

5. 派单第 4 项**点名要求**修 `src/main/proxy/logger.ts:7`，而 Constraints 又写
   「不要动 `src/main/proxy/**`」。我按「带行号的具体点名 > 泛化的目录禁令」执行，
   且改动**纯注释、零代码**（可从 diff 逐行核验）。若约束的本意是连注释也不许动，
   撤回该处即可，但那样 7 处虚假注释里最核心的一处会留着 —— 而其余 6 处都指向它。

**未纳入本轮的观察（不改，仅登记）：**

6. `electron-store@11` 是 prod dependency 且其 `index.js:3` 直接 `import electron from
   'electron'`（`kernel_without_electron.test.ts` 的注释已记录此活样本）。它**不**通过
   peer 拖 electron 进 prod 树（manifest 无声明），故 prod 树里它存在但不可用 ——
   现有内核闸门已覆盖「内核不得可达它」，本轮不动。

**残留风险：** 无已知阻塞项。唯一需要人确认的是第 5 条的约束意图。
