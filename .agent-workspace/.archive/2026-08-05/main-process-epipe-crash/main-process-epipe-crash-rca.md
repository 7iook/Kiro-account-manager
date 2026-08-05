# 主进程 EPIPE 崩溃弹窗 RCA（2026-08-05）

## 任务清单

- [x] T1 收口 stdio 错误：新增 `src/main/utils/stdioGuard.ts`
  **Evidence**: verify=`npx vitest run test/main/utils/stdioGuard.test.ts` 15/15 绿 · files=`src/main/utils/stdioGuard.ts` · AC=EPIPE 静默且来源可证、非管道错误上报 · commit=pending
- [x] T2 在 `src/main/index.ts` 生产路径装配（app ready 之前）
  **Evidence**: verify=产物 `out/main/index.js` 中 `installStdioGuard@21392 < app.whenReady@23368` · files=`src/main/index.ts:157-186`（顶层语句，非函数体内）· AC=生产 caller 存在且时点正确 · commit=pending
- [x] T3 TDD 单测：`test/main/utils/stdioGuard.test.ts`（红→绿）
  **Evidence**: verify=先跑得 `1 failed / no tests`（模块不存在的红）→ 实现后 9/9 绿 → p0 回归组补齐后 15/15 绿 · AC=红是"功能缺失"而非语法错 · commit=pending
- [x] T4 架构闸门：装配闭环断言（防 E-052 建而未接）
  **Evidence**: verify=`test/main/architecture/stdio_guard_wiring.test.ts` 6/6 绿 · AC=断言 import + 顶层调用 + 时点 + onFatal 三要素 + 收口唯一性 · commit=pending
- [x] T5 typecheck + test 实跑 + 重建 out/（产物新鲜度闸门）
  **Evidence**: verify=`npm run typecheck` 双段 exit 0；`npm run test` 96 文件 / 1023 测试全绿（修复前 1016，+7 为 p0 回归组）；`npm run build` 成功，产物含 `STDIO_STACK_FRAMES` / `isSyncStdioWriteFailure` · commit=pending
- [x] T6 回写仓库变更日志
  **Evidence**: 本仓无集中式 `CHANGELOG.md` / `ARCHITECTURE.md`（`git ls-files` 仅见按版本分文件的 `docs/CHANGELOG-v*.md`），§9.1.1 集中回写不适用；变更记录落在本文件 Update Log · commit=pending
- [x] T7 真实运行时受控验证（单测用假流，证明不了真 socket 路径）
  **Evidence**: 见 §7 消费锚点的实验记录 · AC=受控对照结果翻转 · commit=pending
- [x] T8 异构评审（reviewer=sonnet ≠ 作者模型）+ 清 p0/p1
  **Evidence**: 1 轮评审 REJECT · p0=1 / p1=4 / p2=1 → 已修 p0#1、p1#2、p1#3、p1#4、p2#6；p1#5 即本清单回写 · 详见 Update Log · commit=pending

## Update Log

- 2026-08-05 诊断完成，本文件建立（代码未动）。
- 2026-08-05 实现 + 装配 + 单测 + 架构闸门；typecheck 双段 exit 0，全量 96 文件 / 1016 测试绿；重建产物。
- 2026-08-05 **真实运行时受控验证**（§0.14 Gate 3）：单测用的是 EventEmitter 假流，证明不了真 socket 路径，故补一组子进程实验 —— 父进程 `spawn` 子进程后立刻 `p.stdout.destroy()` 制造真实破管，子进程持续 `console.log` 4KB × 200 条。
  - 实验组（有收口）：`exit=0`，写完全部 200 条，stderr 干净。
  - 对照组（无收口，其余完全相同）：`exit=1`，stderr 出现 `Error: EPIPE: broken pipe, write` —— **与用户弹窗完全同形**。
  - 唯一变量是收口有无，结果翻转 → 构成受控证据，而非相关性。
- 2026-08-05 **异构评审（sonnet，≠ 作者模型）判 REJECT，p0=1 / p1=4 / p2=1**。逐条处置：
  - **p0#1 顶层兜底仅凭 `error.code` 判定，无法证明来源** —— 成立，且是本轮最重要的发现。原实现会把网络 socket / 文件流 / 原生插件抛出的 EPIPE 一并静默：既不弹窗也不落盘，应用带病继续跑，比原 bug 更隐蔽。**违反本 RCA §1 自己写的负条件**。
    修法：静默改为「来源可证」的两条通道 —— ① 流级监听放行时用 `Symbol` 在错误对象上打来源标记（异步路径，按对象身份而非错误码）；② 栈帧命中 Node stdio 写入实现帧（`node:internal/streams/writable` / `node:internal/console/constructor` / `node:net`）**且** 错误码属管道类（同步路径，两者合取）。
    回归测试补 6 条（`stdioGuard.test.ts` 第二个 describe）：非 stdio 的 EPIPE / EBADF / ERR_STREAM_DESTROYED 必须上报；stdio 栈帧上的 ENOSPC 必须上报；无 stack 的管道类错误按真错误上报（不可证来源→偏保守）。
  - **p1#2 `EBADF` / `ERR_STREAM_DESTROYED` 归类缺证据** —— 随 p0 一并解决：这两个码现在只在「来源已由事件源确定」的流级监听里生效，顶层不再单凭它们静默。
  - **p1#3 `onFatal` 的落盘承诺不成立** —— 成立。`git grep proxyLogger.configure` 全仓零命中 → 文件流默认 `enabled:false`，`proxyLogger.error()` 写不进磁盘。改走 `proxyLogStore.add()` + `flushSaveNow()`（真会写盘）；架构闸门同步改为断言这两个符号，防将来退回。
  - **p1#4 架构闸门可被死函数绕过** —— 成立。原闸门只做「文本出现 + 位置在 whenReady 之前」，把调用塞进永不执行的函数同样能过。补一条断言：`installStdioGuard(` 所在行必须行首无缩进（顶层语句）。
  - **p1#5 RCA 与代码现实不一致（清单未勾、Update Log 写"代码未动"）** —— 成立，本次回写即处置。
  - **p2#6 logger 文件写入流缺自身 error 监听** —— 采纳。`logger.ts:65` 补 `logStream.on('error')`：就地关流 + 降级为只进内存 store，避免将来启用文件日志后磁盘满/权限撤销经全局 fatal，而 `onFatal` 又回来写日志形成二次异常。
  - 评审的「进程本该退出却继续带病运行」这一顾虑：不适用。Electron `lib/browser/init.ts` 的注释即 `Don't quit on fatal error`，基线行为就是弹框后不退出；我们保持同一语义（弹窗 + 不退出），未改变退出码语义。
- 2026-08-05 修复后复验：`npm run typecheck` 双段 exit 0；全量 **96 文件 / 1023 测试全绿**（+7 为 p0 回归组）；重建产物，`out/main/index.js` 含 `STDIO_STACK_FRAMES` / `isSyncStdioWriteFailure`，`installStdioGuard@21392 < app.whenReady@23368`。
  真实运行时二次受控验证（p0 修复后新逻辑必须真跑）：A 真 stdio 破管 → `exit=0` 写完 300 条（存活）；B 非 stdio 来源的 EPIPE（栈在 `proxyServer.js`）→ `onFatal` 被调用、`FATAL:EPIPE:uncaughtException`（正确上报）。两场景均 PASS —— 既根治了原崩溃，也没退化成"吞一切 EPIPE"。
  临时验证脚本已删除（逐文件删除 + 移除空目录，未用递归删除；`Test-Path` 复验两目录均 False）。


---

### 🔴 1. 现象与上下文

用户两个 Electron 弹窗「A JavaScript error occurred in the main process · Uncaught Exception: Error: EPIPE broken pipe, write」，均指向本仓构建产物 `Kiro-account-manager/out/main/index.js`（2026-08-05 09:31:39 构建，SHA256 前缀 22B192CA）：

| 弹窗 | 产物行 | 实际代码 | 源码 |
|---|---|---|---|
| ① | `console.log` → 1710:17 | `originalLog.apply(console, args)` | `src/main/proxy/logger.ts:466` |
| ① | `runWithHold` → 11297:37 | `if (holdDebugEnabled) console.log('[HoldGate][DEBUG] attempt start …')` | `proxy/proxyServer.ts` runWithHold（产物 11206 起） |
| ① | `startClaudeStreamWithHold` 11497 / `handleClaudeMessages` 11111 | 调用链 | 产物 11437 / 11063 起 |
| ② | `Timeout._onTimeout` → 13319:22 | `process.stderr.write('[IPC-TRACE] 60s window: …')` | `src/main/utils/emitToRenderer.ts:150` |

**成功状态**（来源：用户原话「进行修复」+ 崩溃的反义）：
NOT「代码里加了 try-catch」，BUT「stdout/stderr 管道断开后，应用继续运行、日志继续落盘，用户看不到崩溃弹窗」。
负条件：不得吞掉 EPIPE 以外的错误，不得吞掉真正的程序 bug（那会把可诊断崩溃变成静默失败）。

**现象锁定**（单一可证伪命题）：主进程向已断开的 stdio 管道写日志时，`EPIPE` 以未处理异常形式到达 Electron 顶层，触发 `A JavaScript error occurred in the main process` 模态弹窗；进程随后不可用。

### 🔍 1.5 假设台账

| ID | 假设 | 状态 | 证伪/确认证据 |
|----|------|------|------|
| A | 缺 `process.stdout/stderr` 的 `'error'` 监听 + 缺 `uncaughtException` 兜底，EPIPE 冒到顶层 | 🟢 确认 | `git grep "uncaughtException\|unhandledRejection\|stdout\.on(\|stderr\.on("` -- src → **零命中**（本轮实跑）。Node 流的 `'error'` 若无监听即由 `emitErrorNT` 抛为未捕获异常。外部同构证据：electron#40781、marktext#4153（「There is no error handler on process.stdout or process.stderr, so it bubbles up as an uncaught exception and shows the error dialog」）、protoMaker#788（已合并，修法一致：main.ts 顶部挂 stdout/stderr EPIPE handler，非 EPIPE 仍抛） |
| B | `emitToRenderer.ts:150` 那圈 `try/catch` 本该拦住，是 catch 写漏了 | 🔴 证伪 | 该 `try/catch` 实际存在（本轮读源码 120-160 行确认）却仍崩溃 —— 说明 EPIPE 不是同步抛出，而是写入排队后由流在后续 tick `emit('error')`；同步 catch 结构上拦不到。**弹窗堆栈是 Error 构造点（write 调用栈），不是抛出点**。此假设被证伪的同时反向加固 A |
| C | 根因是 `logger.ts` 的 console 拦截器实现有缺陷（如递归/重入） | 🔴 证伪 | 拦截器有 `_isWriting` 重入闸（`logger.ts:122/144`），且弹窗 ② 完全不经过 console（直接 `process.stderr.write`）。两个弹窗共享的唯一环节是「写 stdio」，不是「走 console」 |
| D | Electron 38 的 backgroundThrottling patch bug（本仓 index.ts:118 注释记载过的老坑） | 🔴 证伪 | 那条是 UI 无响应（visibility desync），无 EPIPE、无弹窗；本次堆栈全在 Node stream 层，与 blink 无关 |

判据自检：A 唯一 🟢，B/C/D 均 🔴，A 的证据是本轮实跑的全仓 grep 零命中（直接针对目标命题）。

### 🔍 2. 根因分析

**The Why**：Node 中 `process.stdout` / `process.stderr` 指向管道（非 TTY）时是异步 `net.Socket`。写入先入队，失败在后续 tick 通过 `'error'` 事件报出。`EventEmitter` 对无监听的 `'error'` 一律 `throw` → 主进程未处理异常 → Electron 弹模态框。因此：

1. **调用点包 try-catch 无效**（假设 B 实证）——错误不在同步栈里。
2. **每一条主进程日志都是潜在崩溃点** —— `logger.ts:466/471/476` 三个 `original*.apply` 无条件写；`emitToRenderer.ts` 五处 `process.stderr.write`。管道一断，下一条日志即崩。

**First Broken Point**：`src/main/index.ts` 启动序列缺失 stdio 错误收口 —— 不是某个写入点写错了，而是**进程级契约（"写 stdio 可能异步失败"）从未被承接**。

**Bug 类别**（§5.2 七类）：**Responsibility Boundary Violation** —— 进程级 I/O 失效属于全局边界职责，现被隐式下放给每个日志调用点，而调用点在结构上无法承接（异步事件）。

**管道为何断开**：属环境侧（父终端关闭 / electron-vite 父进程先退 / 继承的 handle 失效）。`unverified: 弹窗信息不足以判定具体触发方式`。**但这不影响修复** —— 修复目标是"管道断了不崩"，不是"管道不断"。

**放大因素**：弹窗 ① 需 `holdDebugEnabled`（`HOLD_DEBUG=1` 或 UI 调过 `setHoldDebug`），弹窗 ② 需 `ipcTraceEnabled`（`IPC_TRACE=1`，否则 60s timer 不启动）。调试开关开着 → 写管道频率上升 → 撞上概率上升。

### 🕵️ 3. 变体扫描

**重复实现审查**：
- 内部：`git grep "uncaughtException|unhandledRejection|stdout.on(|stderr.on(" -- src` → **verified absent**，全仓无任何同类收口，无重复实现风险。`src/main/utils/netGuard.ts` 是网络护栏（纯判定函数），职责不同，不可混入。
- 外部：`exa` 查 `Electron main process EPIPE broken pipe console.log stdout uncaught exception` → protoMaker#788（已合并）与 marktext#4153/PR#4154 给出同一修法：入口顶部挂 stdout/stderr `'error'` 监听，EPIPE 静默、其余重抛。结论：**无需引库，十几行原生代码即可，社区已验证该修法**。

**指纹**：`进程级异步 I/O 失效无收口 → 任一写入点成为崩溃点`。

**变体清单**：

| 位置 | 风险 | 本轮修复 | 说明 |
|---|---|---|---|
| `proxy/logger.ts:466/471/476` `original{Log,Warn,Error}.apply` | 高（每条主进程日志） | ✅ 被上游收口覆盖 | 不逐点改 —— 逐 sink 打补丁且对异步无效 |
| `utils/emitToRenderer.ts:135/150/158/268` 四处 `process.stderr.write` | 高（60s timer + burst + 截断告警） | ✅ 被上游收口覆盖 | 现有 try-catch 保留（防同步 ERR_STREAM_DESTROYED），但不是主防线 |
| `logger.ts` 文件流 `this.logStream.write` | 中 | ⬜ 不改 | 目标是文件非管道，EPIPE 不适用；且落盘失败应可见 |
| 全仓其余 `console.*`（数百处） | 高 | ✅ 被上游收口覆盖 | 正是"单点收口 vs 逐点补丁"的分野 |

无未收拢变体。

### 👥 4. 真实场景模拟

1. **父终端中途关闭**（`npm run dev` 后关掉 PowerShell 窗口）：管道 handle 失效 → 下一条 `console.log` 触发异步 EPIPE。防御：stdout/stderr `'error'` 监听吞 EPIPE，进程存活，文件日志与 `proxyLogStore` 不受影响。
2. **打包版从资源管理器双击启动**（无 TTY，stdio 可能是 nul/已关闭）：与 protoMaker#788 场景同构。防御：同上；且必须在 **app ready 之前**装配，否则启动早期的日志仍会崩。
3. **长会话高频日志 + 管道缓冲写满后对端消失**：EPIPE 连续多次触发。防御：监听器无状态、幂等，不重复注册（`installed` 闸），不因高频而堆内存。
4. **真 bug 混入**（如 `TypeError`）：**必须仍然可见**。防御：仅吞 `EPIPE` / `ERR_STREAM_DESTROYED`，其余原样重抛；`uncaughtException` 兜底走文件日志后再抛，不静默。

**本轮不处理**：管道断开的根本触发（环境侧，见 §2 unverified）；`logStream` 写盘失败（应可见，不该吞）。

### 📚 5. 行业参考

- `exa.web_search_exa` query: `Electron main process EPIPE broken pipe console.log stdout uncaught exception`
  - top1 `https://github.com/electron/electron/issues/40781` —— Electron 官方 issue，确认 console.log 可抛 write EPIPE 弹主进程错误框。
  - `https://github.com/marktext/marktext/issues/4153` —— 明确根因表述：无 stdout/stderr error handler → 冒为 uncaught exception → 弹框；PR#4154 修复。
  - `https://github.com/proto-labs-ai/protoMaker/pull/788`（**已 merged**）—— 修法与本方案一致：入口顶部挂 handler、非 EPIPE 重抛、+13 行单文件。
- 结论：这是 Electron 生态**已知共性缺陷**，标准修法为进程入口单点收口，无可复用库（十几行原生代码，引库反而增依赖面）。

### 🛠️ 6. 手术式修复

**策略**：在最上游、最早时点单点收口，覆盖全部下游写入点。**静默必须来源可证** —— 见 Update Log 的 p0 处置。

- 新增 `src/main/utils/stdioGuard.ts`：`installStdioGuard()`
  - **流级**（异步路径）：给 stdout/stderr 挂 `'error'`；管道类错误码（EPIPE/ERR_STREAM_DESTROYED/EBADF）静默并在错误对象上打 `Symbol` 来源标记；其余重抛。此处可按码判定，因为来源已由事件源本身确定。
  - **顶层兜底**（同步路径 + 兜底）：`uncaughtException` / `unhandledRejection`。静默条件是「来源可证」二选一：① 带流级来源标记（按对象身份）；② 栈帧命中 Node stdio 写入实现帧 **且** 错误码属管道类。**绝不单凭错误码** —— 否则网络/文件流的 EPIPE 会被一并吞掉。
  - 非管道类真错误交给装配侧 `onFatal`，**不在处理器内 throw**（那会让 Node 硬退，把可见崩溃变成静默猝死）。
  - 幂等；不 import electron（可在 node 环境单测）。
- `src/main/index.ts`：`app.commandLine.appendSwitch` 一带、**app ready 之前**顶层调用一次；`onFatal` 负责 `proxyLogStore.add()` + `flushSaveNow()` 落盘（`proxyLogger` 的文件流默认关闭，写不进磁盘）+ `dialog.showErrorBox` 补回被抑制的弹窗。
- `src/main/proxy/logger.ts:65`：文件写入流补自身 `'error'` 监听（就地关流 + 降级为只进内存 store），避免将来启用文件日志时与 `onFatal` 形成二次异常。

**明确不改**：`logger.ts` 三个 `original*.apply`、`emitToRenderer.ts` 四处 `stderr.write`（下游诱人补丁点，逐点加 try-catch 对异步 EPIPE 无效，且会造第二个收口真源）。

### ⚠️ 7. 影响面与回归风险

- 影响面：主进程全局（进程级监听）。不改任何业务逻辑、不改 IPC 契约、不改渲染进程。
- 风险点：**过度吞噬** —— 这正是异构评审抓到的 p0。最终形态：流级按码（来源已确定）+ 顶层要求来源可证（标记或栈帧），非管道类一律交 `onFatal` 弹窗 + 落盘。6 条 p0 回归测试正向锁定"非 stdio 来源的 EPIPE 必须上报"。
- 回归测试：`test/main/utils/stdioGuard.test.ts` 15 条（先红：模块不存在 → 绿）；`test/main/architecture/stdio_guard_wiring.test.ts` 6 条（生产 caller 存在 + 顶层语句 + 时点在 ready 之前 + onFatal 三要素 + 收口唯一性）。全量 96 文件 / 1023 测试绿。
- **消费锚点**：最终 sink = 主进程 `process` 对象的监听器表。链路 `stdio 管道断开 [外部] → process.stdout 'error' 事件 [Node] → stdioGuard 监听器 [src/main/utils/stdioGuard.ts] → 静默(来源可证)/交 onFatal [同上] → 应用存活 [用户可见]`。生产 caller = `src/main/index.ts:166` 顶层语句（产物 `out/main/index.js:21392`，早于 `app.whenReady` 的 23368）。
- **端到端实测（已跑，非单测）**：子进程 `spawn` 后立刻 `p.stdout.destroy()` 制造真实破管 —— 有收口 `exit=0` 写完全部日志；无收口对照组 `exit=1` 且 stderr 出现与用户弹窗同形的 `Error: EPIPE: broken pipe, write`。二次验证（p0 修复后）：真 stdio 破管存活，非 stdio 来源的 EPIPE 正确走 `onFatal`。
- **未实测**：真实 Electron GUI 下关闭父终端的完整场景（需 GUI 交互，`unverified: 需用户在真实启动方式下确认`）。Node 层受控实验已覆盖同一失效机制。

### 🧩 8. 边界加固

顺带补上了主进程从未有过的 `uncaughtException` / `unhandledRejection` 兜底 —— 此前任何未捕获异常都直接弹框崩溃，无文件留痕，事后无从诊断。
