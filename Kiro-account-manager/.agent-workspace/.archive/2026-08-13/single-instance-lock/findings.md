# 数据目录单实例锁：实现与验证报告

日期：2026-08-13  
基线：`26dfc5765368b1e5fdb27de2eb255d10bfb4c523`  
范围：`src/main/server/entry.ts`、`src/main/server/dataDirectoryLock.ts`、`test/main/server/dataDirectoryLock.test.ts`  
提交：未提交（按任务要求）

## 结论

服务端启动现在会在任何数据目录写入之前，按**解析后的规范数据目录**获取进程锁。第二个实例会以 `EX_UNAVAILABLE (69)` 拒绝启动，错误信息包含目录、持有者 PID 和近似启动时间；正常停机只在完整 `shutdown()`（停止入口、drain 凭据、flush 统计、归档会话等）settle 后释放锁。

实现放在 `src/main/server/dataDirectoryLock.ts`，而不是 `persistence/`：这是进程生命周期和启动编排能力；它不读写账号数据，也不属于数据格式/存储端口。

## 风险锚点核实

- 对账报告 `.agent-workspace/.archive/2026-08-13/ledger-reconciliation/findings.md:63-71` 的 Deliverable 2 gap 4 明确记录：当前只有进程内写锁，两个进程可并发写同一副本。
- `src/main/accountService/state.ts:137-143` 的注释明确称现有锁为“进程内串行锁”；`state.ts:175-181` 仅在调用者显式传 `expectedRevision` 时仲裁。
- `src/main/accountService/persistAccountPatch.ts` 的权威 main 写路径明确不传 `expectedRevision`。因此两个进程之间没有 revision 或 Promise 链保护。
- 桌面入口 `src/main/index.ts:5895-5913` 已有 Electron `app.requestSingleInstanceLock()`，但它是应用级锁，不以数据目录为 key，也不与纯 Node 服务端共享锁端点。

## 机制选择

锁 key：

1. `resolve(cwd, configuredPath)` 消除相对路径、`.`、`..`、尾斜杠；
2. 对已存在的最深祖先使用 `realpathSync.native`，消除 symlink / junction 并取得实际大小写；
3. 首启目录尚不存在时，把剩余路径接回规范祖先；
4. Windows 的哈希输入额外统一小写；
5. SHA-256 只用于生成本机 IPC endpoint 名；错误信息与后续 store 均使用规范目录路径。

锁载体是内核持有的本地 IPC listener：

| 平台    | 机制                                                                                                                 | 崩溃行为                               | 本轮实测                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Windows | 命名管道 `\\.\pipe\kiro-account-manager-data-<sha256>`                                                               | 进程退出/被杀后内核释放，无落盘残留    | **已实测**：两个真实 Node 子进程互斥；`SIGKILL` 后替代进程立即获取；junction/相对路径归一；持有者 PID 可读       |
| Linux   | 抽象 Unix domain socket（首字节 NUL）                                                                                | 不产生 socket 文件；进程死亡后内核释放 | **unverified：本机仅有 Windows Node；本地 Docker 没有可用的 `node:22-alpine` 镜像，未拉取外部镜像污染/改变环境** |
| macOS   | `127.0.0.1` loopback TCP listener；目录哈希给出确定性端口遍历顺序，协议握手区分同目录 holder 与普通端口占用/哈希碰撞 | 进程死亡后内核释放；无锁文件           | **unverified：本机是 Windows，无 macOS runner**                                                                  |

本锁是同一 OS 实例内的进程锁。Linux 抽象 socket 位于 network namespace；若多个隔离 network namespace 的容器同时挂载同一数据卷，它们不会互相看到该 endpoint。当前 ADR 的目标场景是同机双开和单服务进程；若未来正式支持“多个隔离容器竞争同一卷”，应使用宿主级单实例编排或引入真正的跨 namespace 文件 advisory lock，并补容器验收。

## 陈旧锁与竞态

拒绝了 PID lockfile / `open('wx')` 文件方案：

- SIGKILL、断电会永久留下文件；
- “读 PID → 判断已死 → 删除旧锁”不是 compare-and-swap：两个启动者可把对方刚创建的新锁当旧锁删除；
- PID 复用又可能把陈旧锁误判为活锁。

当前方案不做“陈旧检测/删除”。`bind/listen` 是内核原子裁决，listener 的生命周期绑定进程；崩溃恢复等价于等待内核释放 endpoint 后重新 bind。测试真实杀死 holder 后，由独立替代进程成功获取，不依赖任何进程内状态或人工清理。

## 启动与关闭位置

`entry.ts` 的顺序更新为：

1. 读环境变量；
2. 获取规范数据目录锁；
3. 数据 preflight；
4. adminKey 引导；
5. store/服务装配；
6. 面板；
7. 反代；
8. 信号处理器。

锁位于配置解析之后，因为 key 必须来自真实 `KIRO_DATA_DIR`；位于 preflight/adminKey/store 之前，因为这些步骤之后可能创建目录、密钥或数据文件。获取成功后把 `config.dataDir` 改为锁返回的规范路径，避免“锁按 A、写盘仍按别名 B”的装饰性锁。

启动中途任一步失败，`finally` 会释放锁。启动成功后，`attachDataDirectoryLock` 包装 `server.shutdown()`，仅在原 shutdown settle 后于 `finally` 释放；测试用未完成的 shutdown promise 证明 drain 未结束时 release 尚未调用。

## 退出码与文案

选择现有 `EXIT.UNAVAILABLE = 69`（BSD `EX_UNAVAILABLE`），不新增退出码：

- 数据内容没有坏，故不是 `EX_DATAERR (65)`；
- 配置格式没有错，故不是 `EX_USAGE (64)` / `EX_CONFIG (78)`；
- 也不是无法创建数据文件的权限问题，故不是 `EX_CANTCREAT (73)`；
- 当前是运行资源被另一个实例暂时占用，语义最接近服务暂不可用。

systemd 单元的 sibling agent 需要知道：**同目录锁冲突退出码为 69**。若单元对 69 配了自动重启，应避免无界快速重启（应有 restart backoff）。

失败文案示意：

> 数据目录已被另一个 Kiro Account Manager 实例占用：\<规范目录\>  
> 持有者：PID \<pid\>（启动于 \<time\>）。  
> 拒绝启动 —— 两个进程并发写同一份账号数据会造成静默覆盖。  
> 请先停止持有该目录的实例再重试；若它刚刚崩溃，无需删除任何锁文件，操作系统会自动释放锁。

## 桌面端覆盖

本轮未改 `src/main/index.ts`（不在文件 ownership 内）。

桌面端当前确实调用 Electron `requestSingleInstanceLock()`，所以**两个普通桌面实例**已被应用级锁阻止；它比“按数据目录”更强地禁止同一应用双开。但它不是本模块的数据目录锁：

- 不按规范 dataDir key；
- 不向用户展示冲突目录/holder；
- 不与纯 Node 服务端协调。

因此“桌面进程 + 手工把服务端 `KIRO_DATA_DIR` 指向桌面 userData”仍不共享同一把锁。若批准架构要求覆盖该跨 shell 场景，后续 owner 应在 Electron `app.ready` 前把桌面 `app.getPath('userData')` 接入本模块，或明确禁止服务端直接指向活跃桌面目录；接入时需协调现有 `requestSingleInstanceLock()` 的协议 URL/聚焦行为，不能直接删除它。

## TDD 红 → 绿证据

所有 Vitest 命令均使用任务指定的双 reporter，并从 JSON 读取 `numFailedTests`；临时 JSON 已删除。

### Red 1：功能缺失

命令：

`npx vitest run test/main/server/dataDirectoryLock.test.ts --reporter=default --reporter=json --outputFile.json=.agent-workspace-single-lock-red.json`

- EXIT=1；
- JSON：`numFailedTests=0`，但 suite failed；
- console 原因：`Cannot find package '@main/server/dataDirectoryLock'`。

这是预期的“生产锁模块尚不存在”，不是测试语法错误。

### Green 1：真实跨进程锁

同路径命令：

- EXIT=0；
- JSON：`numFailedTests=0`；
- 初次 5/5 passed：第二进程拒绝、canonical alias 互斥、崩溃恢复、不同目录并行、正常释放重取。

测试将**生产 TypeScript 源码**转译成临时 CommonJS，并启动真实独立 Node 子进程；没有用同一进程 Map/单例假装跨进程锁。

### Red 2：关闭顺序

加入“drain 未完成不得释放”测试后：

- EXIT=1；
- JSON：`numFailedTests=1`；
- console 原因：`TypeError: attachDataDirectoryLock is not a function`。

### Green 2 与最终针对性回归

- 新测试最终：7/7 passed，`numFailedTests=0`；包含真实 `bootstrap()` 第二实例拒绝接线；
- 最终相关回归：`dataDirectoryLock + serverSeamsWiring + serverAssembly` 共 48/48 passed，`numFailedTests=0`；
- `npm run typecheck:node`：EXIT=0（格式化后复跑仍为 0）；
- `git diff --check`：EXIT=0。

### 全套状态（如实记录）

完整套件跑了两次，均未全绿，但失败均是**未修改的 5 秒超时测试**：

1. 第一次 JSON：`numFailedTests=1, numPassedTests=1710, numPendingTests=6`；`upstreamApiWithoutElectron.runtime.test.ts` import 超时；
2. 第二次 JSON：`numFailedTests=2, numPassedTests=1709, numPendingTests=6`；同一 upstream import 与 `postinstall_conditional.test.ts` 子进程判定超时。

两个失败文件分别按相同双 reporter 单独复跑：

- upstream：4/4 passed，`numFailedTests=0`；
- postinstall：10/10 passed，`numFailedTests=0`。

这不能宣称“完整套件绿色”；证据表明是全套并行负载下的既有 5 秒 timeout 波动，而非锁断言失败。新测试自身会启动多个真实子进程和真实面板，因此必须完成下面的 Vitest 分组 follow-up 后再取最终全绿证据。

## 必需 follow-up

`test/main/server/dataDirectoryLock.test.ts` 会启动真实子进程、命名管道和面板端口，必须加入 `vitest.config.ts` 的 `main-real-io` 列表。按任务约束，本轮**未编辑** `vitest.config.ts`。这既是资源测试分类正确性要求，也很可能消除它与 main 并行池争抢 CPU、放大其它 5 秒超时的情况。

## 拒绝的方案

- **PID/exclusive lockfile + 删除 stale**：崩溃残留，且 stale reclaim 自身存在删除新 owner 的竞态。
- **只依赖端口冲突**：面板/代理端口可配置为不同值，不能证明 dataDir 相同。
- **固定单个 TCP 端口哈希**：不同目录哈希碰撞或普通服务占用会误拒；macOS fallback 使用协议握手 + 完整确定性换位。
- **只保留 Electron `requestSingleInstanceLock()`**：纯 Node 服务端不可用，也不是 dataDir key。
- **新增 npm native 文件锁依赖**：`package.json` 由 sibling agent 持有，且当前依赖中没有可直接复用的 advisory-lock 包；为了这个任务擅自改依赖会越 ownership。

## 传播检查

⚡ 已用 codegraph、codebase-context-engine、fast-context 三路语义检索列出并核对 `bootstrap`、`shutdown`、`dataDir`、Electron 单实例和写入仲裁消费点；随后检查本任务完整 diff 与相关回归。工作区的强制 `git grep` 包装器仍错误地报告“未跑语义检索”并拒绝执行，因此未伪造 grep 成功结论。
