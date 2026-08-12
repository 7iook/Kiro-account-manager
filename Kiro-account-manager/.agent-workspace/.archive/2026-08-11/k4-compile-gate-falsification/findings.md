# K-4「编译期强制内核不碰 electron」证伪验证

> 落盘 2026-08-11 · 仓库 `F:\Kiro-account-manager\Kiro-account-manager` · 分支 `main` @ `afe80af`
> 被检验的假设（由用户提出，要求证伪）：**K-4 相对模块图闸门没有增量价值，做它是洁癖而非防护。**
> 结论：**假设部分被证伪** —— 闸门有三个真实可复现的漏网形态。但证伪的落点不在 K-4：
> 补宽判定器比 K-4 便宜一个数量级，且 K-4 的两个机制中有一个在本仓**结构上无法表达内核边界**。

---

## 0. 结论速览

| 问题 | 答案 |
|---|---|
| 有真实缺口吗？ | **有，三个**，全部实测复现：`electron/main` 子路径值导入 / `electron-*` 包间接依赖 / ambient `Electron.*` 与 `process.crash()` 等 electron 注入的运行时成员 |
| 缺口是理论的还是可发生的？ | **前两个可发生**（`electron-store` 本仓已在 `src/main/index.ts` 使用，`electron-updater` 在依赖里；子路径是 electron 官方文档写法）。第三个**在本仓近乎不可发生**（全 `src/` 仅 `src/preload/index.ts` 一处用 ambient 命名空间，且 `process.crash()` 这类成员零使用） |
| K-4 的 `tsconfig types:[]` 能堵吗？ | **只堵第三个**（最不可能发生的那个）。**堵不住 `electron-store`** —— 实测 `types:[]` 下 exit 0 |
| K-4 的 eslint 规则能堵吗？ | **能堵前两个**，但**无法限定作用域到内核** —— 内核与桌面文件在同目录交错（`src/main/proxy` 19 文件里 16 内核 3 桌面），`files:` glob 表达不出这条边界 |
| 更便宜的替代？ | **有**：把闸门现有 4 条正则加宽为 4 条新判据，**全部三个缺口转红，对现有 44 文件闭包零误报**（实测） |
| 裁决 | **模块图闸门有可修的缺口，修它比 K-4 便宜** —— 见 §4 |

---

## 1. 基线事实（全部实测，非推理）

### 1.1 闸门基线

```
npx vitest run test/main/architecture/kernel_without_electron.test.ts --reporter=json
→ numTotalTests=13 numPassedTests=13 numFailedTests=0 success=True
```

### 1.2 内核闭包真实规模

以闸门自身的走图器（同正则、同解析器）独立复现，从 9 个入口出发：

- **闭包 = 44 个文件**（闸门头部注释记录 K-3 时为 40，`accountStore.conf.ts` 等加入后增长，与注释演进一致）
- **仓内 unresolved = 0**（走图器没有静默漏子树）
- **闭包内别名 import = 0 处**（`@main` / `@shared` / `@preload` 一个都没有 —— 与闸门注释「今天一个都没有，但解析器仍须认识」一致；`@shared/types/credential` 只在自检用例里被解析）
- **`src/main/proxy/index.ts` 桶文件不在闭包内**（它是 `ProxyServer` 的再导出，方向是它 import 内核，不是内核 import 它）
- **`src/main/utils/emitToRenderer.ts` 不在闭包内** —— 这一点很关键，见 §2.1

闭包引用的**第三方包只有 6 个**：`conf` / `js-tiktoken` / `node-forge` / `socks` / `undici` / `uuid`（其余全是 node: 内置：child_process, crypto, fs, fs/promises, http, https, net, os, path, tls, url）。

### 1.3 内核能否独立编译（K-4 的可行性前提）

构造一个**不继承** `tsconfig.node.json`（避免继承 `include` glob 把 `src/main/index.ts` 拉进来）的独立 program，`files` 精确列出 44 个闭包文件：

```
variant types-EMPTY       → TSC EXIT 0
variant types-NODE-ONLY   → TSC EXIT 0
```

**内核今天就能在 `types: []` 下干净编译。** 这是对 K-4 有利的事实：它不需要先做一堆修补才能落地。

---

## 2. 逐个方向的实测结果

方法：把构造出的形态**前置插入** `src/main/utils/redact.ts`（闭包内叶子文件，与 owner 在飞工作无关），跑闸门，读 JSON 的 `numFailedTests`，然后按原始字节还原并**校验 SHA256 与改前一致**。每个用例都记录了改前/改后/还原后三个哈希，全部 `REVERT: OK byte-identical`。

| # | 形态 | 闸门 | 判据 |
|---|---|---|---|
| 1 | `import type { WebContents } from 'electron'` | 🔴 **红** | 正则 `\bfrom\s*['"]electron['"]` 不区分 `import` / `import type`，故类型导入照样命中 |
| 2a | `export type _P = Electron.WebContents`（零 import） | 🟢 **绿（漏）** | 源码里没有 `'electron'` 字面量 |
| 2b | `process.crash()`（零 import） | 🟢 **绿（漏）** | 同上 |
| 3 | `import { app } from 'electron/main'` + `app.getPath()` | 🟢 **绿（漏）** | 正则锚死 `['"]electron['"]`，子路径不匹配 |
| 4 | `import Store from 'electron-store'` | 🟢 **绿（漏）** | 同上；且闸门只扫仓内文件，不进 node_modules |
| 5 | `export { nothing } from './doesNotExistAnywhere'` | 🔴 **红** | `unresolved` 断言生效 —— 解析失败**响亮失败**，不是静默跳过 |
| 7 | `import(['elec','tron'].join(''))` 变量拼串 | 🟢 **绿（漏）** | 静态分析原理上看不见 |

### 2.1 类型导入：闸门抓得住，但真正的问题在别处

用户点名的 `src/main/utils/emitToRenderer.ts` 确实同时有 `import type { WebContents } from 'electron'` 和 `import { app } from 'electron'`（**后者是值导入**，第 32 行）。但实测它**不在 44 文件闭包内**，所以闸门今天对它没有意见 —— 这是正确的：它是桌面 IPC 出口守卫，服务端形态根本不加载它。

至于「类型导入本身是否算问题」：对服务端**运行时**无害（esbuild 擦除）。但**闸门抓它是对的**，理由不是运行时而是构建期：`electron` 是 devDependency，服务器上 `npm ci --omit=dev` 后 `electron.d.ts` 不存在，此时内核若还带 `import type ... from 'electron'`，`tsc` 会报 TS2307 —— 服务端形态无法通过类型检查。所以现状（红）是正确行为，无需放宽。

### 2.2 ambient 类型：真实存在，但本仓几乎不可能发生

`node_modules/electron/electron.d.ts`（25550 行）确实做了全局污染，实测确认三处：

- `declare namespace Electron`（第 12 行）—— 全局命名空间，无需 import 即可 `Electron.WebContents`
- `declare namespace NodeJS { interface Process ... }`（第 25319 行）—— 往 `process` 上挂了 **crash / hang / getBlinkMemoryInfo / getCPUUsage / getCreationTime / getHeapStatistics / getProcessMemoryInfo / getSystemMemoryInfo / getSystemVersion / setFdLimit / takeHeapSnapshot / noAsar / parentPort / resourcesPath / defaultApp** 等成员
- `interface NodeRequire { (moduleName: 'electron'): ... }` —— 连 `require('electron')` 的返回类型都被增强

这意味着**内核代码可以在零 import 的情况下写出只有 Electron 运行时才有的调用**，例如 `process.resourcesPath` 或 `process.crash()`，而当前闸门完全看不见。

`types: []` 确实堵住它，实测：

```
src/main/utils/redact.ts(1,18): error TS2503: Cannot find namespace 'Electron'.
src/main/utils/redact.ts(2,38): error TS2339: Property 'crash' does not exist on type 'Process'.
TSC EXIT (K-4 types=[]): 2
```

而**当前的 `npm run typecheck:node` 对同一份代码 exit 0** —— 因为 `tsconfig.node.json` 把 `types` 覆写成 `["electron-vite/node"]`，但 `electron` 出现在 `dependencies` 传递图里，其 `.d.ts` 的全局声明照样进 program。**这是 K-4 唯一独占的能力。**

但这个缺口在本仓的**实际发生概率极低**，实测全 `src/` 扫描：

- ambient `Electron.*` 命名空间引用：**仅 1 处**，`src/preload/index.ts`（`Electron.IpcRendererEvent`）—— preload 永远不进内核
- electron 注入的 `process.*` 成员：**4 处**，`src/main/index.ts`（`defaultApp`）、`registration/registrar.ts`、`tray.ts`（`resourcesPath`）、`src/preload/index.ts`（`contextIsolated`）—— **44 文件闭包内 0 处**

也就是说：这个形态在本仓不是「有人正在这么写」，而是「理论上写得出来」。**它是一个真实的机制缺口，但不是一个正在发生的风险。**

### 2.3 子路径导入：最有说服力的缺口

`import { app } from 'electron/main'` 是 **electron 官方文档推荐的写法**（`electron.d.ts` 第 25272 行 `declare module 'electron/main'` 就是为它准备的），一个不了解本仓约定的贡献者写出它完全自然。而它：

- **闸门绿**（正则锚死 `['"]electron['"]`）
- **`types:[]` 红** → `error TS2307: Cannot find module 'electron/main'`
- **eslint `patterns: ['electron/*']` 红**
- **运行时比 `'electron'` 更糟**：实测 `require.resolve('electron/main')` 直接 `MODULE_NOT_FOUND`（electron 的 package.json 无 `exports` 字段，只有 `main: index.js`），而 `require.resolve('electron')` 在开发机上是成功的。所以这个形态**在纯 node 下加载即死**，且死法比闸门注释里描述的 `app === undefined` 更早、更硬。

### 2.4 包间接依赖：闸门与 tsconfig **双双失守**

闸门只扫仓内文件（`isInternalSpecifier` 把非 `.` / 非别名的 specifier 直接 `continue`），这一点已核实。所以「内核 import 了 X，X 运行时 require electron」这条路径闸门完全看不见。

我审计了闭包 6 个直接包的**完整已安装依赖闭包 = 28 个包**（conf, ajv, ajv-formats, atomically, base64-js, debounce-fn, dot-prop, env-paths, fast-deep-equal, fast-json-stable-stringify, ip-address, js-tiktoken, json-schema-traverse, json-schema-typed, mimic-function, node-forge, punycode, semver, smart-buffer, socks, stubborn-fs, stubborn-utils, type-fest, uint8array-extras, undici, uri-js, uuid, when-exit）：

- manifest 里 `electron*` 依赖 / peerDependency：**零**
- 这 28 个包的已发布 JS/d.ts 源文本里 `from 'electron'` / `require('electron')` / `import('electron')`：**零**

**当前闭包在包层面是干净的。** 但这个形态**已经在本仓有活体样本**：`electron-store@11.0.2` 的 `index.js` 第 3 行就是 `import electron from 'electron'`，而它的 manifest 里 `dependencies` 只有 `conf` 和 `type-fest`（electron 是 **peerDependency**）。闸门现有的一条自检用例已经手写死了「`accountStorePort.ts` / `accountStore.conf.ts` 不应依赖 `electron-store`」—— 也就是说**闸门作者已经意识到这个形态，但用的是「手列两个文件名 + 手列一个包名」的方式**，而这正是该文件头部注释花了三段篇幅批判的「清单式闸门」：新增内核文件时没人记得加名字，闸门照绿。

实测确认：往 `redact.ts`（闭包内、不在那两个手列文件里）插入 `import Store from 'electron-store'`，**闸门 13/13 全绿**。

**并且 `types: []` 也堵不住它** —— 实测 exit 0。原因是 `electron-store` 自带 `.d.ts`，类型上自洽；它对 electron 的依赖发生在**运行时** require，TypeScript 没有理由报错。这是 K-4 的 tsconfig 机制在本方向上的**明确失守**。

### 2.5 变量拼串：两种静态方案等价失守

`import(['elec','tron'].join(''))` 闸门绿。`types:[]` 也绿（`import(变量)` 的类型是 `any`，无从检查）。eslint `no-restricted-imports` 也绿（它只看字面量）。

按用户预先说明的口径，这条**证伪的是「编译期更好」，不是主假设** —— 如实报告：这个形态两种机制都挡不住，只有运行时断言（`kernelWithoutElectron.runtime.test.ts` 那一侧）或 code review 能覆盖。它也不是现实风险：本仓无插件加载器、无字符串拼路径的 require。

---

## 3. K-4 两个机制的逐一评估

### 3.1 `tsconfig` + `types: []`

**覆盖**：ambient 命名空间 ✅ / `process.*` 注入成员 ✅ / 子路径导入 ✅ / **`electron-*` 包间接依赖 ❌** / 变量拼串 ❌

**成本**：

- 内核**今天就能在 `types:[]` 下编译**（exit 0），无需前置修补。这是低成本信号。
- 但需要**一份 44 项的 `files` 清单**，或一个能表达内核边界的 `include` glob。而 glob **不存在** —— 见 3.3。手列 44 项 = 闸门头部注释明确批判过的清单式做法，且会与闸门的入口清单形成**第二份需要同步维护的边界定义**（两处 SSOT）。
- `npm run typecheck` 需要新增一条 `typecheck:kernel`，进 CI / pre-commit。

**关键否证**：它的独占能力（ambient 类型）对应的是**本仓 44 文件闭包内 0 处、全仓 5 处且全在永不进内核的文件里**的形态；而它**堵不住**唯一有活体样本的形态（`electron-store`）。**独占能力落在最不可能发生的方向上，这是「洁癖」判断成立的地方。**

### 3.2 eslint `no-restricted-imports`

实测（把规则临时注入仓库真实 `eslint.config.mjs`，用其已配好的 TS parser，改后按字节还原并校验哈希）：

| 形态 | eslint |
|---|---|
| `import type ... from 'electron'` | 🔴 红 |
| `import { app } from 'electron'` | 🔴 红 |
| `import { app } from 'electron/main'`（`patterns: ['electron/*']`） | 🔴 红 |
| `import Store from 'electron-store'`（`paths` 列名） | 🔴 红 |
| ambient `Electron.*` / `process.crash()` | 🟢 **绿（漏）** |

**覆盖**：三个导入类形态全中，**ambient 完全看不见**（它只分析 import 语句）。

**致命成本 —— 作用域无法表达**：eslint flat config 靠 `files:` glob 选文件。而内核与桌面文件**在同一批目录里交错**（实测）：

| 目录 | 总 .ts | 内核 | 非内核 |
|---|---|---|---|
| `src/main` | 8 | 3 | 5（index.ts, machineId.ts, oidcRefresh.ts, secureBackupCipher.safeStorage.ts, tray.ts） |
| `src/main/accountService` | 18 | 6 | **12** |
| `src/main/proxy` | 19 | **16** | 3（activation.ts, clientConfig.ts, index.ts） |
| `src/main/utils` | 8 | 4 | 4（emitToRenderer.ts, observationClock.ts, stdioGuard.ts, webPanelAssetRoot.ts） |
| `src/main/kproxy` / `persistence` / `proxy/rtk` / `proxy/rtk/filters` / `src/shared/types` | 4/2/4/4/1 | 全部 | 0 |

`src/main/**` 作用域的规则会命中**12 个正当使用 electron 的桌面文件**（accountService/index.ts, index.ts, ipc/proxyPool.ts, ipc/webPanelWiring.ts, machineId.ts, proxy/logger.ts, registration/ipc-handlers.ts, registration/proton-mail-window.ts, registration/registrar.ts, secureBackupCipher.safeStorage.ts, tray.ts, utils/emitToRenderer.ts）。

> 注：`proxy/logger.ts` 出现在这 12 个里是**我那次扫描的口径问题**，已核实：该文件对 electron 的全部提及都在**注释**里（第 3/6/7/12 行，正是「为什么这里没有 `import { app } from 'electron'`」的说明段），零可执行引用。我的 cost 扫描没有剥注释，故误列。闸门本身剥注释，判定正确。**真正需要 electron 的桌面文件是 11 个，不是 12 个。**

要让 eslint 只管内核，唯一出路是**逐文件 `files: [44 条路径]`** —— 第三份需要同步维护的边界清单，且它的 44 项与 tsconfig 的 44 项、闸门的 9 个入口三者必须手工保持一致。**这不是防护，这是三份会漂移的副本。**

### 3.3 `test/**` 排除的含义（用户要求核实）

实测 `tsc -p tsconfig.node.json --listFilesOnly`：仓内非 node_modules 文件 **98 个，其中 `test/` 下 0 个，`src/webPanel/` 下 0 个**。`tsconfig.web.json` 的 include 里也没有 `test/**`。

**含义**：闸门测试文件本身不被任何 `tsc` 覆盖。这对本议题有两个后果：

1. **对 K-4 不利**：如果 K-4 的执行力依赖 `npm run typecheck`，那么它保护的是 `src/**`，而**判定逻辑（闸门）自己不被类型检查** —— 两者不在同一执行面上。
2. **对闸门中立**：闸门是 vitest 用例，走 `npm test`，本来就不依赖 typecheck。它的执行力来自测试套件，而测试套件是本仓 1180 用例的既有强制面。

---

## 4. 更便宜的替代：把闸门的判定器加宽

我构造了 4 条新判据并**同时**测了「能否抓住缺口」与「对现有 44 文件闭包是否误报」：

```js
// A: electron 及其所有子路径（四种语法）
/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]electron(?:\/[^'"]*)?['"]/
// B: electron-* 包族（electron-store / electron-updater / ...）
/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]electron-[^'"]*['"]/
// C: ambient Electron.* 命名空间
/(?<![\w.'"`])Electron\s*\.\s*[A-Z]\w+/
// D: electron 注入 process 的成员
/\bprocess\s*\.\s*(?:crash|hang|getBlinkMemoryInfo|getCPUUsage|getCreationTime|getHeapStatistics|getSystemMemoryInfo|getProcessMemoryInfo|takeHeapSnapshot|setFdLimit|resourcesPath|defaultApp|contextIsolated|noAsar|parentPort|windowsStore|mas|isMainFrame|getSystemVersion)\b/
```

用闸门的真实走图器（同解析、同注释剥离），在内存中注入各形态后的对照结果：

| 形态 | 当前判定器 | 加宽后 |
|---|---|---|
| 基线（无注入） | green | **green**（零误报） |
| ambient `Electron.WebContents` | green | **RED** |
| `process.crash()` | green | **RED** |
| `import from 'electron/main'` | green | **RED** |
| `import 'electron-store'` | green | **RED** |
| `import 'electron-updater'` | green | **RED** |
| type-only `from 'electron'` | RED | RED |

**四条新判据把全部三个缺口转红，且对现有 44 文件闭包零误报**（逐文件跑过 4 条判据，无一命中）。

代价对比：

| 方案 | 改动 | 新增需同步维护的边界清单 | 覆盖三缺口 |
|---|---|---|---|
| 加宽闸门判定器 | **1 个文件、约 4 行正则 + 对应自检用例** | **0**（入口清单不变，闭包自己长） | **3/3** |
| K-4 tsconfig `types:[]` | 新 tsconfig + 新 npm script + CI 接线 | **+1**（44 项 files 清单） | 2/3（漏 electron-store） |
| K-4 eslint 规则 | 改 eslint.config.mjs | **+1**（44 项 files glob，且 glob 表达不出边界） | 2/3（漏 ambient） |

加宽方案还有一个结构性优势：它**沿用闸门已有的传递闭包**，所以新增内核文件自动纳管 —— 这正是闸门头部注释论证过的、清单式方案没有的性质。

**关于「包间接依赖」的补强**：加宽的 B 条只抓 `electron-*` 命名形式。一个叫别的名字、内部 require electron 的包仍会漏。若要真正封住这一类，需要的是「对闭包引用的第三方包做 manifest + 源文本审计」——我这次是**手工**跑了这个审计（28 包全清），把它做成闸门里的一条用例是可行的（复用我的 `deps.mjs` 逻辑），成本约 40 行，但**这条同样与 K-4 无关**：K-4 的两个机制都覆盖不了它。列为可选加固，不列为本轮必需。

---

## 5. 诚实标注：未验证 / 未穷尽项

- **`src/main/proxy/logger.ts` 已核实，非风险项**：它对 electron 的全部提及都在注释里（第 3/6/7/12 行），零可执行引用。加宽判据 A/B/C/D 对它不会误报（§4 的逐文件扫描已剥注释，结果零命中）。
- **加宽判据只在「注入到 redact.ts」与「静态扫 44 文件」两种口径下验证**，没有真的改闸门文件跑一次全套 13 用例。若采纳，需按 TDD 先红后绿实测。`unverified: 未修改闸门源文件实跑`
- **eslint 规则的评估基于我临时注入的规则形状**（`paths: ['electron','electron-store'] + patterns: ['electron/*']`），不是某个已定稿的 K-4 规则文本。若 K-4 打算用别的形状（如 `no-restricted-modules` 或自定义规则），结论需重测。
- **28 包依赖审计基于当前 `node_modules` 实际安装状态**，不是 lockfile 解析。包升级后需重跑。
- 未评估 `electron-vite` 构建期是否会以别的方式把 electron 注入内核产物（K-6 的范畴，不在本次问题域）。

---

## 6. 裁决

**「模块图闸门有可修的缺口，修它比 K-4 便宜」** —— 用户假设的**结论方向成立，但理由需要修正**。

三条论据，各自的证据：

1. **K-4 不是零价值的** —— 它独占 ambient 类型 / `process.*` 注入成员这一类（实测 `types:[]` 报 TS2503 + TS2339，而当前 `typecheck:node` exit 0）。所以「K-4 无任何增量价值」这个措辞被证伪。
2. **但 K-4 的独占价值落在本仓最不可能发生的方向**（闭包内 0 处、全仓 5 处且全在 preload / 桌面专属文件），**而它堵不住唯一有活体样本的方向**（`electron-store` 在 `types:[]` 下 exit 0，而该包本仓正在 `src/main/index.ts` 使用）。价值与风险不对齐。
3. **同样的三个缺口，加宽闸门 4 条正则即可全部转红且零误报**（实测），代价是 1 文件约 4 行，且不新增需同步维护的边界清单；而 K-4 两个机制各需一份 44 项清单，其中 eslint 的作用域**在本仓结构上无法表达**（内核与桌面文件同目录交错，`src/main/proxy` 16:3、`src/main/accountService` 6:12）。

**建议**：K-4 按原规格**不做**。改为在现有闸门上加宽判定器（A/B/C/D 四条），并按 TDD 先构造红用例。若日后内核真出现 ambient 类型或第三方包间接依赖的现实压力，再单独引入 `types:[]` 的内核 program —— 那时它会有明确的、可指名的驱动事实，而不是「编译期听起来更硬」。

**明确不采纳的答案**：「两者都有价值、纵深防御」。实测下两个机制在三个缺口上的覆盖是 **3/3（加宽闸门）对 2/3 + 2/3（K-4 两机制）**，且 K-4 引入两份会漂移的边界副本 —— 这不是纵深，是把一条边界的定义摊到三个地方。

---

## 附录 A · 复现命令

闸门基线与各用例：

```powershell
# 基线
cd F:\Kiro-account-manager\Kiro-account-manager
npx vitest run test/main/architecture/kernel_without_electron.test.ts --reporter=json --outputFile=$env:TEMP\k4.json
# 读 numFailedTests，勿用管道字符串匹配

# 单个形态（改前/改后/还原三哈希 + 自动还原）
pwsh -NoProfile -File <tmp>\mutate.ps1 -CaseName "3-subpath" `
  -TargetFile "src\main\utils\redact.ts" `
  -InsertText "import { app } from 'electron/main'`nexport const _p3 = app.getPath('userData')"
```

内核独立编译（K-4 可行性）：`<tmp>\k4tc.ps1 -CaseName baseline` —— 生成不继承 `tsconfig.node.json` 的独立 program（`files` = 44 项闭包），跑 `types:[]` 与 `types:["node"]` 两个变体。

## 附录 B · 修改与还原记录

本次调查全程只读，唯二被临时改动的文件，每次改动后均按原始字节还原并校验 SHA256：

| 文件 | 基线 SHA256 | 还原后 |
|---|---|---|
| `src/main/utils/redact.ts` | `3D48CD2F0F95FB68B3AAB8EB115854AE790B6F171711CB577F4363513003531E` | 同值 ✅（每个用例逐次校验） |
| `eslint.config.mjs` | `AAF0CA8961ACECC49A8247D8E61B7761920D1D47A0E53B2F4B1A3199BE39A2B3` | 同值 ✅ |

`git status --porcelain` 对 `src/` 与 `eslint.config.mjs` **零输出**。临时生成的 `tsconfig.k4probe.json` / `eslint.k4probe.config.mjs` / `.eslintcache` 均已删除。全程未 `git add` / `git commit` / `git stash`。`src/main/proxy/kiroApi.ts` 与 `test/main/proxy/rateLimitBackoffJitter.test.ts` **未触碰**。
