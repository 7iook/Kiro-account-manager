# K-4 闸门加宽 · 落地与证据

> 落盘 2026-08-11 · 仓库 `F:\Kiro-account-manager\Kiro-account-manager` · 分支 `main` @ `7b03afb`
> 前置证伪报告：`findings.md`（同目录）—— 提出了三个缺口 + 加宽正则的建议，但**未真的改闸门跑完全套用例**（该报告 §5 明写「未修改闸门源文件实跑」为未验证项）。本文件闭环那步：改闸门源码 · 全形态前后对照 · 全套用例 + 类型检查红绿实录。

## 状态一览

- **闸门加宽已落地**，只改一个文件：`test/main/architecture/kernel_without_electron.test.ts`
- **闸门用例**：加宽前 13 pass，加宽后 **16 pass**（新增 3 个自检 · 见 §5）
- **全量测试**：加宽后 434 files / **1411 tests / 0 failed**（HEAD `7b03afb` 该 commit 自称基线 1408 + 本文件 +3 自检 = 1411，零回归 · 见 §7）
- **`npm run typecheck:node`**：exit 0
- **突变靶 `src/main/utils/redact.ts`**：baseline SHA256 `3D48CD2F0F95FB68B3AAB8EB115854AE790B6F171711CB577F4363513003531E` · 大小 7544B · 8 个变异形态各改各还各校，**8 次全部字节一致还原**
- **禁触碰文件**：全部未动（proxyServer.ts / kiroApi.ts / ProxyLogsDialog.tsx / rateLimitBackoffJitter.test.ts）

## 1 · 独立复核的三个承重事实（未采信 findings 的转述）

用 `require.resolve` + `readFileSync` 独立复核：

| 事实 | findings 的说法 | 我实测(2026-08-11) | 结论 |
|---|---|---|---|
| `require.resolve('electron/main')` | `MODULE_NOT_FOUND` | `MODULE_NOT_FOUND` | ✅ |
| `require.resolve('electron')` | 成功 | `-> node_modules\electron\index.js` | ✅ |
| `electron` 的 package.json 有无 `exports` | 无 | `exports = undefined`, `main=index.js` | ✅ |
| `electron.d.ts` 有几条 `declare module 'electron/*'` | 未点数 | **4 条**：`electron/main`、`electron/common`、`electron/renderer`、`electron/utility` | ⚠ findings 漏了 utility |
| electron-store 的 electron 依赖形态 | 「electron 是 peerDependency」 | `peerDependencies = undefined`（**根本没写**），只在 `index.js:3` `import electron from 'electron'` | ⚠ findings 措辞不准 —— 更糟：单靠 manifest **完全看不见** |
| 仓内 electron-store 使用点 | `src/main/index.ts` | `src/main/index.ts` 含 `electron-store` | ✅ |
| `electron.d.ts` 是否给 `NodeJS.Process` 加成员 | 是 | 第 25319-25550 行 `declare namespace NodeJS { interface Process ...}`，实测 26 个 electron 独有成员 | ✅ |

**两条修正**：
- **子路径 4 条而非 3 条**（含 `electron/utility`）—— 支持「通配子路径」而不是硬列。
- **electron-store 无 peerDependencies 字段**（隐式对等依赖）—— 支持「不能靠 manifest 扫描」的结论。

## 2 · 关键设计决策

### 2.1 子路径：一条正则通配，不枚举

```ts
// 判据 A 加宽（单一改动点）
{ name: "ESM  import ... from 'electron[/subpath]'", re: /\bfrom\s*['"]electron(?:\/[^'"]*)?['"]/ }
```

选择理由：
- 覆盖 electron.d.ts 声明的全部 4 条子路径 + 未来可能新增的
- 末尾锚 `['"]` 挡住 `electron-store` / `electron-updater` / `electron-log` / `electronify` / `my-electron` / `./electron` / `electron-store/dist`（辨别力自检见 §5 第 7 条）
- 加宽后对现有 44 文件闭包**零命中**（§3）

**已否决方案**：枚举 3 或 4 条子路径 —— 那是「按名字查、不按能力查」（error-journal P-13），未来新子路径会静默漏掉。

### 2.2 electron 可达的第三方包：**计算，不手列**

引入 `packageReachesElectron(spec)`：对给定说明符，先看它本包发布文件里有没有 `from 'electron'` 或子路径；没有则递归到 `dependencies` + `peerDependencies` + `optionalDependencies` 的传递闭包。命中即视为「可达 electron」。

选择理由：
- **electron-store 是活样本**：manifest 里没写任何 electron 相关字段，但源文本第一行就 import。**只有源文本扫得见**。
- 令新增的 `electron-XYZ` 包**自动纳管**，不用回来加名字。
- 成本可承受：闭包引用的传递包 38 个 · 扫 551 个文件 / 27 MB / **~190 ms**（测于本机 node v22.20.0）—— 单元测试可承受。

**反漂移自检（§5 第 8 条）**：内嵌一条 `expect(packageReachesElectron('electron-store').reached).toBe(true)`。若哪天 electron-store 换实现不再 import electron，此条转红 —— findings 要求的「dead entries 不能静默积累」在此以「活样本仍活着」的反面锚点体现。

**已否决方案**：手列包名黑名单（`electron-store` / `electron-updater` / ...）—— 那正是本文件头段自己批的清单式做法，且 findings.md 已用手列的两个文件名 + 一个包名把这个坑复现过一次。

### 2.3 Ambient globals：**明确不加，作为已知边界写进头段注释**

拒绝理由（全在头段 §「已知边界」第 2 条里明写）：
- **零现存问题**：44 文件闭包内 `Electron.X` 命中 0 · `process.<electron 独有>` 命中 0（全 `src/` 命中 5 处全部在闭包外的桌面装配层 / preload）
- **误报面真实存在**：
  - `Electron.X` 正则会被字符串 `"see Electron.App docs"` 之类命中（实测）
  - `process.<成员>` 里，成员名如 `type` / `mas` / `chrome` / `electron` / `contextId` / `sandboxed` / `noDeprecation` 太通用；且判据无法可靠区分 global `process` 与业务里同名的局部包装对象
- **隐性维护清单**：electron.d.ts 里 `Process` 的成员会随大版本变（我实测 26 个 electron 独有成员）—— 硬编码进正则形同头段所批的「按名字维护」

「不加」是**有据的决定**，不是遗漏 —— 若日后内核**真出现**这种写法（哪怕一次），此判据就有明确驱动事实再引入。任务书允许「an argued not worth it is an acceptable answer」，本项走的正是这条。

## 3 · 加宽前 vs 加宽后：8 形态突变对照表（这是本任务的核心证据）

- 突变靶：`src/main/utils/redact.ts`（闭包内叶子文件，**非**owner 在飞的四个禁触碰文件）
- 方法：前置插入变异 → 跑 `npx vitest run <闸门文件> --reporter=json --outputFile=<tmp>.json` → 读 `numFailedTests` / `numPassedTests` → 记突变前 / 后 / 还原后 SHA256

| # | 形态（前置插入片段） | 加宽前<br>(13 total) | 加宽后<br>(16 total) | 期望 | 还原字节一致 |
|---|---|---|---|---|---|
| 1 | `import type { WebContents } from 'electron'` | 🔴 1 failed | 🔴 2 failed（导入侧 + 包审计） | 红 | ✅ |
| 2 | `import { app } from 'electron/main'` + `app.getPath('userData')` | 🟢 0 failed（**漏**） | 🔴 2 failed | 红 | ✅ |
| 3 | `import { app } from 'electron/utility'` + `app.getPath('userData')` | 🟢 0 failed（**漏**） | 🔴 2 failed | 红 | ✅ |
| 4 | `import Store from 'electron-store'` + `new Store<{k:string}>()` | 🟢 0 failed（**漏**） | 🔴 1 failed（包审计） | 红 | ✅ |
| 5 | `export type _T = Electron.WebContents`（ambient 命名空间） | 🟢 0 failed | 🟢 0 failed | 绿（已知边界 · §2.3） | ✅ |
| 6 | `export const _rp = process.resourcesPath`（ambient process 成员） | 🟢 0 failed | 🟢 0 failed | 绿（已知边界 · §2.3） | ✅ |
| 7 | `export { nothing } from './doesNotExistAnywhere'`（不可解析仓内说明符） | 🔴 1 failed | 🔴 1 failed | 红（响亮失败，不静默跳过子树） | ✅ |
| 8 | `import(['elec','tron'].join(''))`（变量拼串） | 🟢 0 failed | 🟢 0 failed | 绿（已知边界 · 静态分析看不见） | ✅ |

**说明**：
- 加宽前 `#2/#3/#4` 都是**漏**（该红却绿）—— 正是 findings 点名的三个缺口。加宽后**全部转红**。
- `#1` 加宽后从 1 failed 变 2 failed，是因为 `'electron'` 说明符也会被包审计送去检查，而 electron 本身自然可达 electron —— 双维度都命中并不错，只是更响亮。
- `#5/#6/#8` 保持绿是**故意**：`#5/#6` 走的是 §2.3 的「不加 ambient 判据」决策；`#8` 是变量拼串，静态分析原理上看不见（headline 里已列为「已知边界 · 由 runtime 侧测试兜」）。

## 4 · 类型检查

```
npm run typecheck:node → exit 0
```

（`tsc --noEmit -p tsconfig.node.json --composite false`）

## 5 · 加宽后的完整用例清单（16 条）

原有 13 条保留；新增 3 条：
1. **内核可达的任何第三方包，其自身或依赖闭包不得 import electron** —— 主判据 §2.2
2. **判据不会误伤名字里带 electron 的无关包（辨别力）** —— 用 7 个反例验证末尾锚正确（`electron-store` / `electron-updater` / `electron-log` / `electronify` / `my-electron` / `./electron` / `electron-store/dist` 都不命中）
3. **包审计对不涉 electron 的包不误报（辨别力）** + **包审计能识别 electron-store（活样本 · 反漂移锚）** —— 前者对 6 个真实使用的包（conf / uuid / undici / js-tiktoken / node-forge / socks）验证 clean；后者是 findings 要求的「dead entries 不能静默积累」的反面锚点：若 electron-store 换实现，此条转红。

原有的「判据能抓到违规写法」自检也扩展了：从 4 条样本扩到 10 条（含所有 4 条子路径 × ESM/require/dynamic 三形态）。

## 6 · 零误报证明

按 findings 未做的方向：**对 44 文件闭包逐个跑加宽后判据**（内嵌到闸门自检 `内核入口的传递闭包里没有任何文件直接依赖 electron` + `内核可达的任何第三方包... 不得 import electron`）：

- 直接 import 判据：0 命中
- 包审计判据：0 命中（闭包引用的传递包 38 个中，`electron-store` / `electron-updater` 等**均不在**闭包内）

对 44 文件的验证由闸门自身完成 —— 加宽后 baseline 16/16 pass 即证明。

**结论**：加宽的两条判据对现有闭包**零误报**。

## 7 · 全量测试

```
npx vitest run --reporter=json → 434 files / 1411 tests / 0 failed / success=true
```

- 加宽前基线（HEAD `7b03afb` commit 消息自称）：131 files / 1408 tests
- 差 = 1411 - 1408 = 3 = 我新加的 3 条自检
- **除加宽新增的自检外，零回归**

> 注：任务书写 1413 是针对 commit `afe80af` 的；HEAD 已推进到 `7b03afb`（+1 commit），后者自称 1408。这不是差错。

## 8 · 复核诚实标注

- **闭包外**的 ambient 使用（preload / 桌面装配层）是**故意不管的**（§2.3 已论证）；如果日后有人把 preload 的 `Electron.IpcRendererEvent` 类型引用**误挪进内核**，本闸门看不见。但 preload 与内核的隔离由 electron-vite 的独立 bundle + 装配层调用约定保障，不是本闸门的职责边界。
- **包审计层不区分 dev/optional/peer**：一个包只要 manifest 里列了 electron 依赖闭包中的任何包，都会被判定可达。这是**故意宽松**：node 的 require 会真的解析这些位置，"仅 dev 依赖" 在生产环境往往仍会被解析（peer 更是主动要求宿主提供）。若日后出现「明显不应视为可达」的包，需要更精细的过滤，再单独引入 —— 今天没有活样本。
- **包审计只扫已发布产物的 `.js` / `.cjs` / `.mjs` / `.d.ts` / `.d.mts` / `.d.cts`**，不扫源码中的 `.ts`。这符合 npm 包发布约定：node_modules 里的 TypeScript 源码通常已编译到 `.js`，且 `.d.ts` 会声明 module。若某包发布了裸 `.ts`（罕见），将漏扫 —— 但那种包 node 本来也加载不了。
- **突变靶 `redact.ts` 每次变异都是前置插入**，从未修改文件已有代码；每次还原都是把 `BASE_BYTES` 完整写回；8 次还原全部字节一致（SHA256 = `3D48CD2F0F95FB68B3AAB8EB115854AE790B6F171711CB577F4363513003531E`）。
- **禁触碰的 4 个文件全程未动**：`kiroApi.ts` / `proxyServer.ts` / `ProxyLogsDialog.tsx` / `rateLimitBackoffJitter.test.ts`（`git status --porcelain -- test/ src/` 只有本次修改的闸门文件本身在列）。
- **无 `git stash` / `git add` / `git commit`**。全程零 destructive git 操作。

## 9 · 修改与还原记录

| 文件 | Baseline SHA256 | 当前 SHA256 | 状态 |
|---|---|---|---|
| `src/main/utils/redact.ts` | `3D48CD2F0F95FB68B3AAB8EB115854AE790B6F171711CB577F4363513003531E` | 同左 | ✅ 已还原（8 次变异全部字节一致） |
| `test/main/architecture/kernel_without_electron.test.ts` | 16427 B（原始） | 580 行新版 | ⚙ 有意修改 —— 本任务的交付物 |
| `src/main/proxy/kiroApi.ts` / `src/main/proxy/proxyServer.ts` / `src/renderer/src/components/proxy/ProxyLogsDialog.tsx` / `test/main/proxy/rateLimitBackoffJitter.test.ts` | 未取 | 未改 | ✅ 全程未动 |

`git status --porcelain -- test/ src/` 最终输出：只有 `M Kiro-account-manager/test/main/architecture/kernel_without_electron.test.ts` 一条。

## 10 · Review Findings（Sub-task Executor 视角）

- **task doc 有一处需自主修正**：findings.md 措辞「electron 是 peerDependency」不精确。实测 `electron-store@11.0.2` 的 manifest 里 `peerDependencies` 字段就没有 —— 是**未申明的隐式对等依赖**。这不动本任务方向，但影响判据设计：即便把 peerDependencies 也扫上（我确实扫了），仍抓不到 electron-store，只有**源文本扫**能。已在实现中体现。
- **findings 建议的 electron-* 包名正则**已否决：那是 P-13「按名字查」反模式的复刻。改为**按能力查**（`packageReachesElectron` 递归 + 源文本），并配一条反漂移锚 —— 让 findings 要求的「dead entries 不能静默积累」有可执行的实现，而非放弃执行。
- **subpath 数目 findings 报少了一条**（漏 `electron/utility`）—— 直接支撑「通配子路径正则」而非枚举，进一步印证反枚举决策。
- **findings 的 D 判据（26 个 process 成员并集正则）已否决**：见 §2.3 三条否决理由。这与 findings 的建议方向部分冲突 —— 我据实测证据（零现存问题 · 真实误报面 · 隐性维护清单）选择不加，并把「不加」明写为已知边界（任务书允许）。
- **未跨 domain 编辑**：只改一个文件，即闸门文件本身。突变靶 `redact.ts` 是**闸门验收所需临时物**，每次改后立即还原至字节一致；`git status` 佐证。
- **没有对 owner 在飞文件动手**：`git status` 佐证。
