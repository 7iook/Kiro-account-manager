# W-E / W-F 交付报告 · conf 依赖显式化 + 服务端构建目标

> 执行者 SUB · 派单来源 `.archive/2026-08-11/server-entry-recon/k5-recon.md` §2② / §6 W-E · W-F
> 仓库 `F:\Kiro-account-manager\Kiro-account-manager` · 基线 `main @ 8e1099e`
> 未 commit(派单要求)· 未 `git add` · 未用 `git stash`

## 成功状态(§0.15B · 来源:派单原文转写)

**NOT**「vite 配置文件写好了、单测绿了」,**BUT**「运维在一台没有 Electron 的 Linux 上,
跑 `npm run build:server` 得到 `out/server/index.js`,`node` 起得来,且面板静态资源能被找到」。

**负向条件**:服务端产物**不得**引用 `electron` / `electron-updater`;面板资源**不得** 404。

**本轮实证达成度**:
- ✅ 产物真跑起来了 + 面板资源真被定位到(见 §3 证据 E4,`panelAvailable: true`)
- ⚠️ **未在真实 Linux 上验证**(本机 Windows)。跨环境结论不外推 —— 见 §5 未验证项

## 1. W-E · conf 提为直接依赖

### 事实核实(派单说法 → 实测)

| 派单声明 | 实测结果 |
|---|---|
| `conf@15.0.2` 仅通过 `electron-store@11.0.2` 传递可达 | ✅ 成立。改动前 `npm ls conf` 只有 `electron-store@11.0.2 └── conf@15.0.2` 一条路径 |
| `conf` 不在 `dependencies` | ✅ 成立 |
| `accountStore.conf.ts` 直接 `import Conf from 'conf'` | ✅ 成立(该文件 :48) |

### 改动

`package.json` `dependencies` 增 `"conf": "^15.0.2"`。

**版本区间取 `^` 而非固定版本**:本仓 26 个 `dependencies` 里 25 个用 `^`,仅
`qrcode.react` 用固定版本。派单要求「match 既有约定」→ `^` 才是既有约定。且
`electron-store@11.0.2` 自身依赖 `conf: ^15.0.0`,写 `^15.0.2` 与它同区间,
npm 会 dedupe 成一份 —— 写死 `15.0.2` 反而可能在 electron-store 升级时裂成两份
`conf` 实例,而**两个 conf 实例读同一个文件**正是字节兼容性最不该出现的形态。

### 验证(不止于「manifest 改了」)

```
npm ls conf
kiro-account-manager@1.7.6
+-- conf@15.0.2                 <- 新增:直接顶层依赖
`-- electron-store@11.0.2
  `-- conf@15.0.2 deduped       <- 仍是同一份,未裂成两个实例
```

`package-lock.json` 复核(服务端 `npm i --omit=dev` 真正读的是它):
- `packages[""].dependencies.conf` = `^15.0.2` ✅
- `packages["node_modules/conf"].dev` = `false` ✅(不是 dev-only,`--omit=dev` 不会移除它)

### 服务端运行时还缺什么 —— 全闭包审计结论

写脚本从 9 个内核入口 + 服务端会加载的 7 个装配相关文件算传递闭包(58 个文件),
把每个外部 specifier 对着 `package.json` 分类:

| 分类 | 包 |
|---|---|
| **缺失(传递可达)** | `conf` ← **本轮修复,且是唯一一个** |
| 已在 dependencies | `undici` `uuid` `js-tiktoken` `node-forge` `socks` |
| node 内置 | `fs` `path` `http` `https` `net` `tls` `crypto` `os` `url` `child_process` `fs/promises` |

**结论:除 `conf` 外,服务端导入闭包不再缺任何 manifest 条目**;闭包内**零** devDependency
引用(即 `--omit=dev` 后不会有东西解析失败)。

`tlsclientwrapper` / `cbor-x` 在 `dependencies` 里但**不在服务端闭包内** —— 它们只被
`src/main/index.ts` 与 `src/main/registration/**` 使用(recon NOT.10 已把注册流程移出本轮)。
未动它们:服务端多装两个用不到的包不是缺陷,而把它们挪走会改桌面依赖。

## 2. W-F · 服务端构建目标

新增 `vite.server.config.ts`(独立 vite 配置)+ 两个 npm 脚本 + `engines` 字段。
`electron.vite.config.ts` **零改动**。

### 关键设计判定(每条都有实测支撑)

#### 产物落 `out/server/index.js` —— 由面板资源契约**倒推**,不是习惯

`webPanelAssetRoot.ts:88` = `resolve(join(__dirname, '..', 'webPanel'))`,且该文件头段
明确说明**故意不加** `app.isPackaged` 分支。于是产物位置不是自由选择:

```
out/server/index.js  → __dirname=out/server → ../webPanel = out/webPanel   ✓
out/index.js         → __dirname=out        → ../webPanel = <repo>/webPanel ✗ 404
dist/server/index.js → __dirname=dist/server→ ../webPanel = dist/webPanel  ✗ 404
```

约束是「必须在 `out/` 下**恰好一层**」。已钉成断言(见 §3)。

#### 输出格式 CJS —— 这条是硬约束

`webPanelAssetRoot.ts` 用 `__dirname`,它在 ESM 产物里不存在。失败形态极安静:
**启动看着正常,有人访问面板时才抛 ReferenceError**。桌面 main 产物实测也是 CJS
(`out/main/index.js` 开头 `"use strict"` + `require(` + 原生 `__dirname`),两端同形。

代价已实测:`conf@15.0.2` 与 `uuid@13.0.0` 都是 **ESM-only**(`"type":"module"` 无 CJS 入口)。
CJS `require()` 它们靠 `require(esm)`。实测(node v22.20.0)`conf`/`uuid`/`undici`/
`js-tiktoken`/`node-forge`/`socks` 全部 require 成功,`require('conf').default` 是可构造 class。
**且这不是服务端新引入的风险** —— 桌面 CJS 产物里已有 `require("uuid")`(实测命中 1 次),
`require(esm)` 在桌面端早就是承重路径。

#### `engines.node` = `^20.19.0 || >=22.12.0`

初版我写 `>=22.12.0`,**自我纠正**:查证(tavily)`require(esm)` 在 v22.12.0 **与 v20.19.0**
两条 LTS 线都已 unflagged(2025 末标记 stable)。而 `vite` 自身 engines 就是
`^20.19.0 || >=22.12.0` —— 写 `>=22.12.0` 会无理由地把桌面支持面收窄到比现有依赖更严。
`build.target` 相应取 `node20`(产物语法下限 ≤ 运行时下限才安全,反之会在 node 20 上吐它解析不了的语法)。

#### electron / electron-updater:**够不到**,不是 externalize

派单要求判定这一点。答案是**够不到**,且我把它做成了**编译期判定器**而非文档声明:
`failOnElectronImport` 插件(`enforce: 'pre'`)在 rollup 解析到 electron 时**直接让构建失败**。

为什么不写进 external:那样某天有人在服务端闭包里 import electron,**构建照绿**,
产物里留一行 `require("electron")`,到 Linux 上才 MODULE_NOT_FOUND —— 而 K-1~K-4
整个立项就是要让这件事在编译期不可能。

**已跑负向对照证明这个闸门真的会拦**(不是装饰):造一个 `import { app } from 'electron'`
的临时入口 → 构建失败,真实退出码 1,零产物输出。正向入口同一配置退出码 0。

#### 与 electron-vite main 预设的分工

不复用 main 预设,因为它按已安装 electron 大版本锁 `build.target`
(实测 `electron-vite/dist/chunks/lib-ClgyQuZx.js:getElectronNodeTarget`:Electron 38 → `node22.19`)。
服务端跑运维装的 node,用 electron 版本推导目标是把**一条不存在的因果**写进构建配置。
姿态与 `vite.webPanel.config.ts` 头段已确立的判断一致(面板同样不是 Electron 目标)。

### 运维接口

| 项 | 值 |
|---|---|
| 构建 | `npm run build:server`(= typecheck:node + vite build + **build:webpanel**) |
| 启动 | `npm run start:server`(= `node --enable-source-maps out/server/index.js`) |
| 产物 | `out/server/index.js` + `index.js.map` |
| 最低 node | 20.19.0 / 22.12.0(`require(esm)` 下限) |

`build:server` **串了 `build:webpanel`**:服务端也托管面板,不连带构建面板产物,
起来就是 404。sourcemap 独立 `.map` 文件 + `--enable-source-maps`,让 journalctl 里的栈有源码行号。

**Dockerfile / systemd unit 未做**(派单明确划归后续任务)。

## 3. 验证证据

新增 `test/main/architecture/server_build_target.test.ts`(20 条),分三层并诚实标注强度
(姿态沿用既有 `webpanel_build_assets.test.ts`):L1 配置形状 / L2 相对契约 / L3 真实产物。

L3 在产物不存在时**跳过而非报红** —— 理由同既有文件:若纯单测流程里恒红,人会去加
`skip` 而不是去 build,闸门反而被拆掉。**已实测该跳过行为**(删掉产物后 15 passed / 5 skipped,
不是假绿)。

| # | 证据 | 结果 |
|---|---|---|
| E1 | `npx vitest run .../server_build_target.test.ts --reporter=json` | **20 passed / 0 failed** |
| E2 | 同上,删除产物后 | 15 passed / **5 skipped** / 0 failed(跳过是诚实的) |
| E3 | 探针入口构建 `vite build`(真实退出码) | **0**,产出 `out/server/index.js` 7.55 kB + map 40 kB |
| E4 | **`node --enable-source-maps out/server/index.js` 真跑** | 退出码 **0**,输出 `{"dirname":"...\out\server","panelRoot":"...\out\webPanel","panelAvailable":true,...}` |
| E5 | 产物形态实测 | `has_require=True` / `has_toplevel_import=False` / `has_dirname=True` / `requires_conf=True` / `requires_electron=False` |
| E6 | **负向对照**:入口 import electron | 构建失败,真实退出码 **1**,零产物 |
| E7 | `npm run typecheck:node`(改动后 · W-C 介入前) | **0** |
| E8 | `npm run typecheck:web` | **0** |
| E9 | **桌面构建** `npx electron-vite build` | **0**;`out/` 仍是 `main,preload,renderer,webPanel` 四目录;main bundle 1064887 字节、`__dirname` 与 `require("electron")` 均在 |
| E10 | `npm ls conf` + lockfile 复核 | 直接依赖 + deduped + `dev:false` |

退出码一律用 `*> file` 重定向后读 `$LASTEXITCODE`,**不用管道 + 字符串匹配**(派单点名的假绿来源;
本轮实测到同一现象:管道下负向对照显示 `EXITCODE=0`,重定向后真实值是 `1`)。

### 全套件

`npx vitest run --reporter=json`:**1472 total / 1439 passed / 28 failed**。

28 条失败**全部**落在另外两个 agent 在飞的文件,与本轮改动无关:
- `test/main/server/adminKeyStore.test.ts` 27 条(W-B)—— 其 `src/main/server/adminKeyStore.ts`
  尚未导出测试所 import 的工厂函数,即 TDD 红态中
- `test/main/accountService/backgroundRefreshPersistence.test.ts` 1 条(W-C)

排除这两个在飞文件后复跑:**1473 total / 1446 passed / 22 failed**(失败数随 W-B 推进从 28 降到 22,
进一步印证是它在飞而非我造成)。**已核实这两个测试文件不引用我的任何改动**
(检索 `vite.server.config` / `build:server` / `out/server` / `SERVER_OUT_DIR_NAME` 在 `test/` 零命中)。

基线 1411 → 现 1472,增量 = 本轮 20 条 + 其他 agent 新增。

## 4. Review Findings(派单校核 · 我纠正了什么)

### Tier 1 · 自行纠正后继续

1. **`tsconfig.node.json` 漏收新配置文件(派单未提,我发现并修)**
   该文件 `include` 逐个列出 `electron.vite.config.*` / `vite.webPanel.config.*`,
   **不含** `vite.server.config.*`。实测 `tsc --listFiles` 确认新配置**在 typecheck 程序之外**。
   于是 `npm run typecheck:node` 会对它的类型错误完全失明。已补入 include,补后 typecheck 仍 0。
   这是 E-060 同族(改 A 漏传播):新增一个同类文件,而消费点是**手列清单**。

2. **`lib.fileName` 在 `build.ssr` 下不生效(我自己的初版缺陷,实测发现)**
   初版写 `lib: { fileName: () => 'index.js' }`,构建实际吐出 **`entry.js`**。
   做了受控对照实验(只改一个变量):加 `rollupOptions.output.entryFileNames='index.js'` →
   产物变 `index.js`。结论:vite 7.2.6 在 `build.ssr: true` 下由 `entryFileNames` 决定产物名。
   已改用 `entryFileNames`,**并删掉不生效的 `fileName`** —— 留着它比不写更糟(后来者会以为改它有用)。
   测试同步改为断言 `entryFileNames`,**并加一条断言钉住 `lib.fileName` 必须 undefined**:
   若断言错的那个键,配置改坏时闸门仍绿,那正是它要消灭的假绿。
   (值得注意:是我自己写的测试先抓到了这个不一致,而非我读配置读出来的。)

3. **`engines` 初版过严,查证后放宽**
   见 §2。`>=22.12.0` → `^20.19.0 || >=22.12.0`,依据是 `require(esm)` 的真实 unflagged 版本线
   + `vite` 自身 engines。这是「改共享作用域默认值」(P-12),影响面远离改动点,故查证而非凭直觉。

### Tier 2 · 无

未遇到需要上报裁决的方向冲突。派单的两个技术前提(conf 仅传递可达 / 产物相对路径契约)
**实测全部成立**,recon §2② 与假设 ⑧ 判断正确。

### 其他发现(不属本轮范围,报告不处置)

- **`test/**` 不在任何 tsconfig 的 include 里** —— 即 `npm run typecheck` 完全不覆盖测试代码
  (实测 `git grep "test/" -- tsconfig*.json` 零命中)。测试文件的类型错误只有跑 vitest 时才暴露。
  不是本轮职责,也不该顺手改(会一次性暴露全部既有测试的类型问题,影响面远超 W-F)。**留给主 AI 裁决**。
- **`src/main/index.ts` 当前有真实类型错误**(W-C 在飞):
  `TS2440: Import declaration conflicts with local declaration of 'BackgroundRefreshAccount'` (L38)
  + `TS6192: All imports in import declaration are unused` (L41)。
  它让 `npm run typecheck:node` 从 0 变成崩溃(**tsc 解析器栈溢出 `RangeError: Maximum call stack
  size exceeded`,不是普通类型错误** —— 用 `node --stack-size=4000` 跑 tsc 才显出真错误行)。
  我不改 `index.h`(派单禁止 · W-C owner)。**已用 `--exclude src/main/index.ts` 的临时 tsconfig
  证明:排除该在飞文件后 typecheck 退出码 0,即我的改动本身干净**。临时文件已删。
  **请 W-C 收尾时修掉这两行。**

## 5. 未验证 / 边界(诚实标注)

1. **`src/main/server/entry.ts` 不存在**(W-A 在飞),故:
   - `npm run build:server` **未整条跑过**(会在缺入口处失败)
   - 构建配置是对着**路径**设计的,不依赖入口内容
   - 端到端验证用的是**临时探针入口**(放在 `src/tmp-server-build-probe/`,**刻意不占用
     `src/main/server/` 路径**以免与 W-A 撞车),它 import 了真实的 `webPanelAssetRoot` 与
     `accountStore.conf`。探针文件与临时配置**已全部删除并经文件系统复验**。
   - W-A 落盘 `entry.ts` 后,`npm run build:server` 应可直接跑通;**那一步仍需有人真跑一次**。
2. **未在真实 Linux 上验证**。本机 Windows。`--omit=dev` 后的真实安装、0600 权限语义、
   systemd 下的行为均 `unverified`。跨环境证据不外推(这正是决策卡把 Linux smoke test 列为收尾项的理由)。
3. **未验证打包进 asar 的服务端形态** —— 服务端不走 electron-builder,不适用。
4. **`inlineDynamicImports: true` 与真实入口的兼容性未验**:若 W-A 的 entry 用了多入口
   或 code-splitting 语义,该选项会冲突。探针入口未触发。

## 改动文件清单

| 文件 | 性质 |
|---|---|
| `package.json` | 改:`dependencies` 加 `conf`;加 `build:server` / `start:server`;加 `engines` |
| `package-lock.json` | 改:npm 重新物化(conf 提为 root dep) |
| `tsconfig.node.json` | 改:`include` 加 `vite.server.config.*` |
| `vite.server.config.ts` | 新增:服务端构建配置 |
| `test/main/architecture/server_build_target.test.ts` | 新增:22 条闸门 |

`electron.vite.config.ts` / `vite.webPanel.config.ts` / `src/**` 生产代码 **零改动**。
未 commit · 未 `git add` · 未用 `git stash`。

## Update Log

- 2026-08-12 · W-E + W-F 落盘。W-E 完整交付(conf 提为直接依赖 + 闭包审计确认它是唯一缺失项)。
  W-F 配置 + 闸门交付并端到端验证(探针入口跑通 + 负向对照证明 electron 闸门有效),
  但整条 `build:server` 待 W-A 的 `entry.ts` 落盘后才能真跑。
  自纠三处:tsconfig 漏收新配置 / `lib.fileName` 在 ssr 下不生效 / `engines` 过严。
  发现并上报(不处置):`test/**` 未被 typecheck 覆盖;W-C 在飞的 `index.ts` 有两处类型错误。

- 2026-08-12(第二轮 · 应主 AI 要求验证 L3 自跳过的可靠性)· **抓到并修掉自己闸门里的一个真实检测缺口**。

  主 AI 问:① 自跳过条件是否可靠(产物存在时不会误跳)② 产物真存在时断言是否真会跑、真会失败。
  这两问之前我**只验了 ①**,②「真会失败」未验 —— 属实,当时那是个**未验证的闸门**。本轮用三态受控实验补上:

  | 态 | 造法 | 结果 |
  |---|---|---|
  | **A 无产物** | 删掉 `out/server/` | 15 passed / **5 skipped** / 0 failed · vitest exit **0** |
  | **B 坏产物** | 手写一个违规 bundle(ESM 顶层 import + `import {app} from 'electron'` + 无 .map) | 18 passed / 0 skipped / **2 failed** · vitest exit **1** |
  | **C 好产物** | 用**真实** `vite.server.config.ts`(仅覆盖 entry)构建 | **21 passed / 0 skipped / 0 failed** · vitest exit **0** · 且 `node out/server/index.js` 退出码 0、`panelAvailable: true` |

  → ① **自跳过条件可靠**:判据是 `existsSync(join(OUT_DIR,'index.js'))`,产物存在时 skipped 从 5 变 0,不误跳。
  → ② **断言真的会跑、真的会失败**(B 态 2 条红、C 态全绿),不是恒绿装饰。

  **但 B 态暴露了我自己的缺陷**:那个坏产物含 `import { app } from 'electron'`,而
  「产物不引用 electron」这条**报绿**了 —— 我初版只扫 `require("electron")` 一种形态。
  这正是本仓 `kernel_without_electron.test.ts` 头段早已记录过的教训(`git grep "from 'electron'"`
  只匹配 ESM、漏掉两个 CJS 承重文件),我在**产物层**把同一个错又犯了一遍。
  已改为四形态同扫(ESM from / bare import / CJS require / 动态 import,末尾锚防误伤
  `electron-store`),并**新增一条不带 `skipIf` 的判定器自检**(六个违规样本必须命中、
  三个近似包必须不命中)—— 没有它,该断言可以因正则写错而永远报绿,而「永远报绿」与
  「产物真干净」在测试输出里完全同形。修后同一坏产物:**2 failed → 3 failed**,缺口关闭。

  测试数 20 → **21**(新增判定器自检)。所有探针文件/临时配置/产物已删并经文件系统复验;
  `out/` 仍为 `main,preload,renderer,webPanel` 四目录,`.git` 完好。

- 2026-08-12(仓库事实修正)· 主 AI 快照称 `typecheck:node` 现为 exit 0,**实测已失效**:
  现为 **exit 2**,错误在并行 agent 新落盘的 `src/main/server/config.ts`
  (L40 `TS6192: All imports in import declaration are unused`、L48 `TS6133: 'readFileSync' 声明未用`)。
  非我文件(`?? src/main/server/`),不处置,报给主 AI。
  上一轮记录的 `src/main/index.ts` 两处类型错误已被 W-C 修掉。

  全套件亦已变化:**1486 total / 1463 passed / 18 failed / 5 skipped**。
  W-B 的 `adminKeyStore.test.ts` 已全绿(与主 AI 说的 30/30 一致);
  18 条失败**全部**落在 `test/main/proxy/**` 六个文件,对应 owner 在飞的
  `src/main/proxy/kiroApi.ts` / `types.ts` 修改 + 新增 `perfDiag.ts` —— 派单明令我不得触碰,
  且实测这些测试对我的改动**零引用**(检索 `vite.server.config` / `build:server` /
  `out/server` / `SERVER_OUT_DIR_NAME` 在 `test/main/proxy/` 零命中)。

- 2026-08-12(第三轮 · W-A 落盘后首次真实 `build:server`)· **闸门首次真开火,抓到一个假阳性;
  修它时我自己又造了一个更严重的缺陷,已实测证伪并改正。**

  ### 假阳性:闸门退化成「禁止解释设计」

  主 AI 首跑 `npm run build:server` 成功后,我那 5 条 skip 第一次真跑,其中
  「产物不引用 electron」**报红**。自行取证(不采信转述):写脚本对真实产物逐形态扫描,
  结果四种形态里**只有 `CJS require` 命中 1 处**,就是
  `out/server/index.js:15121` 的一行**注释**:
  `// 自签证书落盘目录（K-2）：装配层注入，内核不自己 require('electron')`。
  另有 6 处 `electron` 字样全在注释与运维文案字符串里(KProxyService 的 userDataPath
  缺失报错、服务端未接线告警等)。**零处真 import** —— 主 AI 判断正确。

  即闸门退化成「禁止在代码里解释为什么这里没有 electron」,逼后人删掉最该留的注释。
  这与本仓 `test/main/proxy/loggerElectronDecoupling.test.ts` 的 L1 门禁是**同一道题**
  (`logger.ts` 文件头刻意逐字写 `import { app } from 'electron'` 解释它的缺席),
  那条门禁的解法就是先 `stripComments` 再断言 + 给剥离逻辑加自检。已照同一形态修。

  ### 我自己造的更严重缺陷:把说明符也剥掉,真依赖变隐形

  第一版修法是「剥注释 + **把所有字符串字面量剥空**」(理由:产物里文案也会命中)。
  **这个方向是错的,且错得比原问题严重** —— 实测立刻证伪:

  ```
  输入: import { app } from 'electron'
  剥完: import { app } from ''        ← 说明符本身就是字符串字面量
  ```

  即**真实依赖完全不可见**,判定器对最该抓的东西失明。受控样本「真 import」命中数 0。
  是我自己写的两条自检把它抓出来的(`真实 electron 依赖未被判定器抓到`),
  不是我读代码读出来的 —— 这已是本任务第二次由自检发现我的实现缺陷。

  改为三步归一化 `normalizeForElectronScan`:① 剥注释 → ② **先把说明符位置的字符串
  用哨兵保护起来**(它们正是判定目标)→ ③ 再把其余字符串内容清空 → ④ 还原哨兵。
  顺序刻意如此:注释里含引号(`require('electron')`),先动字符串会把注释里的引号
  当字面量起点、吃掉后面真代码 → 静默漏扫。

  ### 主 AI 要求的三类受控样本,全部验过

  | 样本类 | 期望 | 实测 |
  |---|---|---|
  | 注释里的 `require('electron')`(真实误报元凶那一行) | 不红 | ✅ 不红 |
  | 字符串文案里的 electron(含**逐字**写出 `require('electron')` 的字符串) | 不红 | ✅ 不红 |
  | **真** `require('electron')` / 四种 import 形态 | **必红** | ✅ 全红 |
  | 近似包 `electron-store` / `./electron` / `my-electron` | 不红 | ✅ 不红 |

  除受控样本外,还做了**真产物负向对照**:往真实 649KB 产物尾部追加一行
  `const __probe = require('electron');` → **转红 2 条**(主断言 + 归一化自检);
  还原后 SHA256 与备份**逐字节一致**,且已 `npm run build:server` 从源码重建,
  不让任何下游继承我的临时改动。

  自检也加强了:新增第 ④ 条断言「归一化后 `require('conf')` 仍可见」—— 这是第一版
  缺陷的**回归锚**,若哪天有人再把说明符一起剥掉,它先红。

  ### 最终计数(全绿)

  - 我的文件:**22 passed / 0 failed / 0 skipped**(pending 从 5 归 0,符合三态实验预测)
  - 全套件:**1509 total / 1509 passed / 0 failed / 0 pending** · `success: true`
  - `npm run typecheck:node`:**exit 0**
  - `npm run build:server`:**exit 0**(端到端首次跑通 —— 上两轮的 `unverified` 现已解除)
  - `require('out/server/index.js')` 在纯 node 下:**LOADED_OK**(无 MODULE_NOT_FOUND,
    即 `conf` 解析成功、零 electron 可达)

  测试数 21 → **22**。临时探针脚本全部删除。
