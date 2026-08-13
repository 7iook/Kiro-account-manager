# Ledger #10：无头自动换号迁移结论

日期：2026-08-13

状态：已实现、全量验证通过、未提交

## 结论

自动换号的 timer、阈值判断、候选号选择和并发收口已经从 renderer 移到
`src/main/accountService/autoSwitch.ts`。Electron main 与 headless server 现在运行同一套
决策/调度内核；renderer 只负责发送启动/配置同步信号，以及消费 main 已经决定并持久化的
命令信封，执行 IDE/CLI 等桌面专属副作用。

renderer 原有自动换号 timer 与 `checkAndAutoSwitch` 在同一工作树变更中删除。没有出现
“先增加 server scheduler、后删除 renderer scheduler”的双调度窗口。

## 侦察确认

迁移前的真实锚点位于 `src/renderer/src/store/accounts.ts`：

- `autoSwitchTimer`
- `startAutoSwitch`
- `stopAutoSwitch`
- `checkAndAutoSwitch`
- `startAutoSwitch` 先立即检查，再以 `autoSwitchInterval * 60 * 1000` 调用 `setInterval`
- `checkAndAutoSwitch` 只刷新当前账号，余额 `<= autoSwitchThreshold` 时按 Map 插入顺序取
  第一个候选号

headless 的 `src/main/server/assembly.ts` 原来没有对应调度器。服务端已有的
`persistence.drain()` 由 `shutdown()` 等待，因此新调度器必须在 drain 前停止并等完在途写入。

API-key 绑定的硬边界位于 `src/main/proxy/proxyServer.ts#getAvailableAccount`：
`allowedIds` 同时约束选中账号与 fallback，`selectedAccountFallback.ts` 还会用同一个
`isUsable/isAllowed` 做二次确认。

## 实现位置与职责

### 共享内核

新文件 `src/main/accountService/autoSwitch.ts` 是唯一决策真源：

- `decideAutoSwitch`：纯决策，保留旧 renderer 的阈值、快照和候选顺序语义。
- `createAutoSwitchScheduler`：main 侧 timer、single-flight、立即运行、唤醒与停止。
- `persistAutoSwitchDecision`：经 `applyAccountDataMutation` 原子提交
  `activeAccountId`、逐账号 `isActive`、目标账号 `lastUsedAt` 与决定信封。
- `createPersistentAutoSwitchScheduler`：Electron main 使用 accountService 的刷新/持久化原语。
- `syncDesktopAutoSwitchScheduler`：Electron main 进程内单例入口；重复信号只唤醒，不创建第二个实例。
- `getCurrentAutoSwitchDecision`：server 重启时只接受目标仍等于当前 active、账号仍存在且尚未确认应用的信封。

放在 `accountService` 而不是复制进 `server` 的原因：

1. Electron main 与 headless 都已使用这一层的 `checkAccountStatus` 和
   `applyAccountDataMutation`。
2. 该模块不依赖 Electron/window/DOM，可由两个 Node 壳直接复用。
3. timer、决策、CAS 与重启信封只有一个实现，避免以后两个壳的阈值语义漂移。

`src/main/accountService/state.ts` 新增 `getAccountDataSnapshot()`，每轮从真实 store 读取，
不使用启动时缓存，因而能看到 renderer/手机面板刚写入的设置。

### Electron desktop 如何驱动

受文件所有权限制，没有在约 5600 行的 `src/main/index.ts` 再加一条 IPC。renderer 复用现有
`background-batch-refresh` 通道发送空批次：

1. renderer 首次完成 accountData 三方合并基线初始化后发送 `([], 1, false)`。
2. `setAutoSwitch` 等待设置按现有 revision 写入收口落盘后再发信号，避免 main 读到旧阈值。
3. 跨端同步仅在启停或 interval 真变化时发信号；仅改 `switchTarget` 或仅改阈值不立即检查，
   保持旧 renderer 的触发时序。
4. `backgroundRefresh.ts` 识别这个空批次，只调用
   `syncDesktopAutoSwitchScheduler(deps)`，不做账号刷新。
5. Electron main 单例持有 timer、刷新当前账号、选择目标并提交决定。
6. renderer 收到 accountData revision 广播后读取 `autoSwitchDecision`，只按给定
   `toAccountId` 执行原有 `setActiveAccount`、IDE、CLI、反代热切换副作用；它不再重新判断
   阈值或选择账号。

决定信封加入 renderer 的 `buildPersistBlob` / `normalizeSyncBlob` / STALE 三方合并路径。
因此决定落在本地防抖编辑窗口时不会被下一次整表提交抹掉；成功重放自己的保存后也会检查
合并进来的决定，不能依赖可能被 originId 过滤的自写广播。

### Headless server 如何驱动

`src/main/server/assembly.ts` 每个已装配 server 创建一个共享 scheduler：

- 启动后立即运行一轮，之后按持久化 interval 调度；timer 已 `unref()`。
- accountData 的服务端广播会唤醒 scheduler，手机面板改启停/间隔/账号后不必等完整周期。
- 当前账号刷新复用服务端注入的 `AccountRuntimeDeps`。
- 决定提交成功后，运行中的反代通过既有 `activateProxyAccount` 三步编排推进
  “入池/更新凭据 → 单账号 selectedAccountIds → 指针与会话粘性失效”。
- 反代未运行时只在单账号模式持久化目标偏好，下一次启动不会复活旧目标；多账号模式不写
  `selectedAccountIds`，避免把轮询降级成单账号。

服务端 scheduler 不替某个 API key 处理请求，也不自行实现 fallback。它只推进全局偏好；
真正请求到来时仍由 `ProxyServer.getAvailableAccount` 用 `allowedIds/isAllowed` 同时过滤
选中项和 fallback。绑定子集无可用账号时返回 null，不越权使用 scheduler 选出的全局目标。

## 重启与写入顺序

决定的顺序是：

1. 刷新当前账号。
2. 纯函数形成候选计划。
3. 用 `activeAccountId === fromAccountId` 做 CAS，并原子持久化决定。
4. CAS 成功后才执行不可回滚的壳副作用。

不能先执行副作用再 CAS：刷新期间用户若手动换号，CAS 会正确拒绝旧决定，但反代指针已经被
旧决定改走。对应测试先红后绿，现已锁定“陈旧决定绝不执行副作用”。

server 另存 `autoSwitchAppliedDecisionId` 作为壳副作用确认，形成最小 outbox：

- 进程死在“决定提交后、反代应用前”：信封 id 与确认 id 不同，下一次装配先重放，再启动新一轮调度。
- 已成功应用：确认 id 相同，不重复应用。
- 用户后来手动换了 active：信封目标不再等于 `activeAccountId`，旧信封失效，不覆盖用户选择。
- 目标账号已删除：不重放。

scheduler 正常启动后从持久化 active 重新判断；已切到高余额目标时结果为
`threshold-not-reached`，不会因为进程重启再切一次。

停机时 `shutdown()` 在 `persistence.drain()` 前执行 `await autoSwitchScheduler.stop()`。
`stop()` 清 timer 并等待在途刷新/决定/写入完成，drain 因而拥有固定终点，不会被晚到的
scheduler 写入追尾。

## 行为兼容与边界

对合法既有配置，桌面可观察决策语义保持不变：

- 当前余额等于阈值时切换。
- 只刷新当前账号；当前余额使用刷新后值。
- 阈值与候选集合取本轮开始快照。
- 候选号按既有插入顺序取第一个。
- `switchTarget` 在刷新后现读。
- IDE/CLI/反代副作用仍使用原有字段和顺序。

两处有意的时序硬化：

- 桌面设置先落盘再唤醒 main，避免跨进程读取旧配置；相对旧 renderer 的内存内立即调用，
  最多多一个现有保存防抖窗口。
- 多个并发 tick 合并为同一个 in-flight；旧 `setInterval` 在检查很慢时可能重叠执行，
  新实现不会对不同账号同时形成两个决定。

headless 在电脑关机后继续按相同阈值自动换号，是本任务要求的新能力，不是阈值策略改版。

## 配额、429 与长期不可用边界

- 没有修改或引用 proxy pool 的 `isQuotaExhausted`。
- “低于用户阈值”只存在于本模块的局部 `remaining <= threshold` 判断，不写
  `isQuotaExhausted` / `isSuspended`，不会污染 hold gate。
- `isAutoSwitchBannedError` 是旧 renderer 最小封禁字符串集合的迁移：
  AccountSuspended、temporarily suspended、中文封禁与独立 423。
- 429 不在该集合，也不参与额度判断。单测明确证明带 `HTTP 429 Too Many Requests`
  的高余额候选号仍可被选择。

## 无双调度窗口的证明

`test/renderer/autoSwitchSchedulerOwnership.test.ts` 是结构门禁：

- 全文件禁止 `autoSwitchTimer`。
- 禁止 renderer store 再出现 `startAutoSwitch`、`stopAutoSwitch`、`checkAndAutoSwitch`。
- 自动换号 section 禁止 `setInterval` 和递归 `setTimeout`。
- 要求 renderer 只存在经现有 IPC 发往 main 的同步信号。

如果以后有人把 renderer timer 按原名或在自动换号 section 重新加入，该测试会直接失败。

此外：

- `test/main/server/autoSwitchAssembly.test.ts` 锁定 server 确实启动共享 scheduler，并在
  drain 前停止，且重启先对账未确认信封。
- scheduler 单测锁定并发 tick single-flight。
- renderer 决定执行测试锁定“main 给目标、renderer 不重新选号”和 STALE 防抖窗口。

renderer timer 的删除、server scheduler 的增加、生产装配与上述结构门禁都在同一未提交
working-tree change 中。

## TDD 红 → 绿证据

所有 Vitest 命令均从 `F:\Kiro-account-manager\Kiro-account-manager` 执行，使用双 reporter；
每次同时检查 JSON 的 `numPassedTests/numFailedTests` 与默认 reporter 日志。临时报告在记录
计数后按要求删除。

### 第一轮：所有权与生产装配

命令覆盖：

- `test/renderer/autoSwitchSchedulerOwnership.test.ts`
- `test/main/server/autoSwitchAssembly.test.ts`

RED：

- JSON：`numPassedTests=0`，`numFailedTests=5`
- 默认 reporter：5 tests failed
- 失败原因包括 renderer 仍含 `autoSwitchTimer`、不存在 main 同步信号、server 未创建共享
  scheduler、shutdown 未在 drain 前等待 scheduler。

GREEN 后与行为/同步测试合跑：

- JSON：`numPassedTests=31`，`numFailedTests=0`
- 默认 reporter：5 files passed，31 tests passed

### 第二轮：共享行为内核

RED：

- JSON：suite failed，`Cannot find module '../../../src/main/accountService/autoSwitch'`
- 默认 reporter：1 failed suite，0 tests collected

创建共享内核后单元测试先达到 9 passed / 0 failed；后续加入 CAS、重启和确认语义，最终纳入
全量结果。

### 第三轮：陈旧决定不能先产生副作用

先修改测试要求“commit CAS → apply shell”：

- RED JSON：`numPassedTests=9`，`numFailedTests=3`
- 默认 reporter 明确显示旧顺序为 `refresh → apply → commit`，并证明 commit 拒绝时
  `applySwitch` 已被调用一次。
- GREEN JSON：`numPassedTests=12`，`numFailedTests=0`

### 第四轮：server 重启对账

- RED JSON：`numPassedTests=16`，`numFailedTests=2`
- 失败原因：缺 `getCurrentAutoSwitchDecision`，assembly 没有启动前对账。
- GREEN JSON：`numPassedTests=18`，`numFailedTests=0`

### 第五轮：已应用确认，避免重启覆盖后续人工选择

- RED JSON：`numPassedTests=16`，`numFailedTests=2`
- 失败原因：已确认的同 id 信封仍会返回、assembly 尚未读写确认 id。
- GREEN JSON：`numPassedTests=18`，`numFailedTests=0`

## 最终验证

### 拥有范围回归

命令：

`npx vitest run "test/main/accountService" "test/main/server" "test/renderer" --reporter=default --reporter=json --outputFile.json=<tmp>.json *> <tmp>.log`

- JSON：`numPassedTests=538`，`numFailedTests=0`
- 默认 reporter：49 files passed，538 tests passed

### 全量回归

命令：

`npx vitest run --reporter=default --reporter=json --outputFile.json=<tmp>.json *> <tmp>.log`

- JSON：`numPassedTests=1757`，`numFailedTests=0`，`numPendingTests=6`
- 默认 reporter：163 files passed，1 skipped；1757 tests passed，6 skipped
- 当前总数高于任务开始时基线，是同一 working tree 中并行 sibling 变更新增测试所致；没有失败。

### 类型与补丁

- `npm run typecheck:node`：EXIT=0
- `npm run typecheck:web`：EXIT=0
- `git diff --check`（本任务拥有范围）：EXIT=0

本任务新增测试均为纯函数、fake timer、mock renderer 或静态生产接线门禁；不监听真实端口、
不生成子进程，因此不需要加入 `main-real-io`，也未修改 `vitest.config.ts`。

## 保留但未偷偷修正的旧 renderer 可疑语义

这些是迁移前已有行为，本轮用测试钉住或原样保留，没有夹带策略改版：

1. 候选号只排除当前号、明确封禁 lastError 和低余额；不要求候选号有 credentials。
   因此可能先把 active 提交到无凭据账号，随后 IDE/反代副作用失败。
2. 候选号额度不在本轮刷新，使用开始时快照；快照陈旧时可能选到实际上刚降到阈值以下的号。
3. 缺失/非法 usage 会算出 `NaN`；旧判断 `NaN <= threshold` 为 false，因而候选号可能被当成
   “没有低于阈值”。当前纯函数刻意保持这一点。
4. CLI 切换是 fire-and-forget，只记录失败日志，不参与整次决定的成功确认。
5. 旧路径先更新 active 再做 IDE/CLI/反代副作用；本轮仍保持“决定先持久化”的外部语义，
   只增加 active CAS 防止刷新期间的人工换号被陈旧决定覆盖。壳副作用运行期失败仍不会在
   同一进程立即重新选号；server 会留未确认信封并在重启时重放。

若要修这些，应另立行为变更任务并先确定产品语义，不能藏在“把 timer 搬到 main”里。

## 明确拒绝的方案

1. **把 `checkAndAutoSwitch` 复制一份到 server**：会形成第二决策真源；拒绝，改为共享内核。
2. **server scheduler 与 renderer timer 并存过渡**：会基于不同快照双重换号；拒绝，删除与装配
   同一变更，并加结构门禁。
3. **把低阈值写进 `isQuotaExhausted`**：会污染 pool/hold gate 的长期不可用语义；拒绝，阈值
   只做局部判断。
4. **把 429 当额度或封禁信号**：与已有测量和旧判据冲突；拒绝，并加显式测试。
5. **scheduler 自己按 API key 重新选号**：一个全局决定无法代表多个绑定子集，且会复制
   proxy 授权逻辑；拒绝，授权继续留在每请求 `isAllowed` 边界。
6. **先执行反代副作用、再持久化 CAS**：人工换号竞态下会产生“盘上拒绝、指针已改”的分叉；
   红灯实证后改为先 CAS。
7. **重启只看 active、不记录壳确认**：无法区分“决定已应用”和“死在提交后应用前”，也可能
   覆盖后续人工 proxy 选择；拒绝，使用决定信封 + 应用确认。
8. **为了新 IPC 修改 `src/main/index.ts`**：不在本任务所有权内且会扩大高冲突面；复用已有
   空批次通道，仅在 accountService 内识别。

## 文件清单

实现：

- `src/main/accountService/autoSwitch.ts`（新增）
- `src/main/accountService/backgroundRefresh.ts`
- `src/main/accountService/state.ts`
- `src/main/server/assembly.ts`
- `src/renderer/src/store/accounts.ts`

测试：

- `test/main/accountService/autoSwitch.test.ts`（新增）
- `test/main/server/autoSwitchAssembly.test.ts`（新增）
- `test/renderer/autoSwitchDecisionExecution.test.ts`（新增）
- `test/renderer/autoSwitchSchedulerOwnership.test.ts`（新增）
- `test/renderer/cross-end-sync/broadcastAndSettings.test.ts`
- `test/renderer/cross-end-sync/fixtures.ts`

未修改禁止范围中的 `src/main/server/entry.ts`、`src/main/server/config.ts`、
`src/main/proxy/**`、`src/main/utils/netGuard.ts`、`src/main/webPanel/**`、
`src/webPanel/**` 与 `vitest.config.ts`。工作树中这些路径若有变化，来自并行 sibling，不属于
本任务。
