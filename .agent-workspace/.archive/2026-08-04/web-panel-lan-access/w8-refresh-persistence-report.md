# W8 刷新额度持久化 · 执行报告（sub-executor · feat/w8-persist）

> 归属主任务:web-panel-lan-access 决策卡（同目录 `web-panel-decision-card.md`）异构评审 Critical 3。
> 本文件是 sub 的交付记录,主 AI 合并后可把结论并入决策卡 Update Log。

## 交付契约核对（逐字复制自下派指令,未改写）

```
成功状态: NOT「checkAccountStatus 之后调了一次 applyAccountDataMutation」,
          BUT「用户在手机上点某个账号的"刷新额度",看到新数字;
              然后**刷新浏览器页面**,数字仍是新的;
              且**桌面端那个账号的额度也变成了新值**(无需重启应用)」
          + 绝不发生: 桌面端自己刷新额度时 UI 不再逐条更新(响应性回退) /
                      服务端写入被 renderer 的防抖快照覆盖回旧值(丢更新) /
                      批量刷新中途失败导致已成功的部分全丢
```

### 链路逐格验证

| 节点 | 契约声明 | 实测 |
|---|---|---|
| 手机点"刷新额度" | `webPanel/ui/AccountCard.tsx` 已存在 | ✅ `webPanel/App.tsx:266` onCheck |
| HTTP 路由 | `webPanel/routes.ts:242` 已存在 | ✅ `routes.ts:245` singleFlight → deps.checkAccountStatus |
| 业务函数 | `check.ts:174` 返回后就结束 = 缺陷 | ✅ 确认。原 `checkAccountStatus` 三个成功返回点均只 return |
| 持久化 | 待建（共享层）→ applyAccountDataMutation | ✅ 新建 `accountService/persistCheckResult.ts`,写入经 `state.ts:147` |
| 广播 | applyAccountDataMutation 内 | ✅ 实测 `broadcasts.length===1` · revision 7→8 |
| 桌面端可见 | renderer 订阅 | ✅ `App.tsx:150` consumer 判为外部写（无 originId）→ reloadFromStorageQuiet |
| 重载后仍可见 | 盘上 accountData | ✅ 真 HTTP 重新 GET /api/accounts 断言 current=42 |

## 改了什么

- **新建 `src/main/accountService/persistCheckResult.ts`**（共享持久化层）
  - `persistCheckResult(accountId, data)` 单账号 · `persistBatchCheckResults(items)` 批量
  - 两个纯函数 `patchAccountWithCheckResult` / `patchAccountWithBatchResult` 便于逐字段固定
- **`accountService/check.ts`**:`checkAccountStatus` 拆成「取数编排 `performAccountStatusCheck`（私有）+ 落盘收口」。取数有三个成功返回点（api_key / 首次成功 / 刷新后重试），三处各写一次落盘就是 Shotgun Surgery，故收口在外层一处。`backgroundBatchCheck` 每切片落盘一次。
- **`renderer/src/store/accounts.ts`**:删掉 `checkAccountStatus` 结果合并处的 `saveToStorage()`（原 :2079）。`set()` 保留 —— 那是响应性来源。

## 1 · 持久化了哪些字段,以及怎么从 renderer 现有行为推导的

方法:读 `store/accounts.ts:2013-2073` 那次 `set()` 实际写进内存、随后被 `buildPersistBlob`(:197) 整表落盘的字段,逐字段对齐,而不是从 DTO 反推。

| 字段 | renderer 基线语义 | 落盘层 |
|---|---|---|
| `email` / `userId` | `data.x ?? acc.x` | 同 |
| `idp` | 仅识别成已知枚举才更新,未知保留原值(:2045-2054) | 同（`mapIdp` 逐分支照搬） |
| `status` | 直接取 `data.status` | 同 |
| `usage` | **从零重建**,不 spread 旧 usage(:2029) | 同 |
| `subscription` | `{ ...acc.subscription, ...data.subscription }` | 同 |
| `credentials` | 仅当 `newCredentials` 存在时更新三字段 | 同 |
| `lastCheckedAt` | `Date.now()` | 同 |
| `lastError` | `undefined`（刷新成功即清） | 同 |

**刻意不落盘**:`subscriptionTitle` / `userStatus` / `featureFlags` —— renderer 从不把它们写进账号记录（`subscription.title` 才是显示用的那个）。多存会让盘上出现桌面端从未产生过的字段。

**为什么是字段级补丁而非整条覆盖**:`checkAccountStatus` 的入参是调用方给的账号快照,可能已陈旧（手机端发起时快照来自那一刻的盘面,期间桌面端可能改了备注/分组/标签）。整条覆盖会把这些并发编辑按回旧值。故在收口的 mutator 内部**重新读盘**,只覆盖上表那几个键 —— 收口的串行锁(`state.ts:131`)让这个读-改-写原子。有测试锁死:`落盘只碰额度相关字段 · 桌面端并发写的备注 / 分组 / 标签不被覆盖`。

**批量的字段清单是另一份**（基线也不同）:`applyBackgroundCheckResults`(:3513) 的 usage 是 `...account.usage` **再**逐字段 `??` 回落（因为批量返回的字段比单个检查少,不 spread 会抹掉字段）,email/userId 用 `||` 而非 `??`,`subscriptionManagementTarget` 存成 `managementTarget`。照搬,未统一 —— 统一是行为变更。

## 2 · 批量的决定与失败语义

**决定:每个 concurrency 切片落盘一次**（不是逐账号,也不是最后统一一次）。

- 逐账号写:1000 账号 = 1000 次 revision 递增 + 1000 条广播,每条都可能让桌面端整表 reload + re-render → 正是 2026-07-23「前端卡死」RCA 的形状（见 `utils/emitToRenderer.ts` 文件头）。
- 最后统一写:中途失败 ⇒ 已成功部分全丢,白烧一轮上游额度 → 契约明列的负条件。
- 按切片:广播数 = ⌈账号数/concurrency⌉（默认 100 ⇒ 1000 账号 10 次）,失败最多只丢当前这一片。

**失败语义:单片落盘失败不中断整个批量**。批量的价值在「尽可能多刷到」,为一片写盘失败放弃后面 900 个是更差的选择。失败记 `console.error` 继续下一片;那片结果仍已通过 `background-check-result` 到达 UI,只是没落盘,下次刷新重取。绝不静默。

实测锁死（`__RED_PROBE` 受控对照确认这 4 条离开实现即红）:
- `批量刷完 · 三个账号的新额度都在盘上`
- `第二片上游全挂 · 第一片已落盘的结果必须还在（不是全丢）`
- `每切片只广播一次 · 1000 账号不会变成 1000 条广播打爆桌面端`（3 账号/concurrency=2 ⇒ 2 条广播 · revision 3→5）
- `切片内账号已被另一端删除 · 跳过它，其余照常落盘且不复活它`

**顺带发现**:`applyBackgroundCheckResults`(:3513) 基线**根本不调 `saveToStorage`** —— 批量结果原先只靠 30 秒 autoSave 定时器兜底落盘。本轮服务端落盘顺带治了这个存量缺口。

## 3 · 桌面路径改了什么,怎么验证没有双写/丢更新

**先读了 `saveToStorage` 与 revision 仲裁怎么交互**（`accounts.ts:2562` / `:2586` / `syncMerge.ts`）,再动手:

- store 落盘是**整表覆盖 + 防抖**(500ms,最长 5000ms) → `flushSaveImmediately` 带 `expectedRevision` 提交。main 侧刚写完时 disk revision 已 +1,本窗口 currentRevision 还是旧值 ⇒ 这次提交**必然 STALE** ⇒ 走三方合并重放,白花一次 IPC + 整表序列化 + 合并,产出与盘上完全一致。
- **删掉它安全,因为 store 的一致性收敛不依赖这次写**:main 写入成功后广播 `accounts-data-changed`（不带 originId）→ `App.tsx:150` 判为外部写 → `reloadFromStorageQuiet` 对齐盘面并同时更新 `currentRevision` 与 `syncBaseSnapshot`（`deriveBaseFromDisk`,C3 三写入点语义之一）。广播万一丢失,I3 的 focus/visibilitychange/短轮询(≤6s) 兜底。

**验证不是靠论证,是靠测试**（`test/renderer/cross-end-sync/checkNoDoubleWrite.test.ts`,fake timers 推完 6000ms 全部防抖窗）:
- `刷新结果本身不再触发落盘 · 仅剩 refreshing 状态那一次在飞的写` → saveCalls ≤ 1
- `那次在飞的写携带的是新额度 · 绝不会把服务端刚写的按回旧值（丢更新）` → 断言 payload 里 `usage.current === 42`。**这是负条件「服务端写入被 renderer 的防抖快照覆盖回旧值」不成立的直接证据**:payload 在 flush 那一刻由 `buildPersistBlob(get())` 构造,而内存此时已是新额度。
- 三方合并两条:我没动过该记录 → 采纳盘面新额度（`remoteRecordsAdopted===1`）。

**残留的那一次写**:函数开头 `updateAccountStatus(id,'refreshing')`(:2006 → :1799 `saveToStorage`) 仍会落盘 —— 它把一个**瞬时 UI 状态**写进了盘。没动它:那是多调用方共享的通用 setter,改它溢出本轮范围。已登记技术债。它写 status 不写 usage,且同受上面那条合并语义保护。

## 4 · 响应性没退化

`set()` 原样保留在结果合并处,UI 不等盘。测试 `响应性不回退 · 内存里的额度立刻是新值` 断言 `checkAccountStatus` 返回后内存已是 42/500/Pro。批量路径的 `background-check-result` 事件**发射时机、channel、payload 形状一字未动**,落盘只挂在切片边界之后 —— 用户看着数字逐条更新的体验不变。

## 5 · 广播是否真的无需轮询就到达桌面端

到达,但**这一步只在单元层验证到「广播已发出 + payload 正确」**:实测 `broadcasts.length===1`、`revision===8`、payload 不含 `ksk_`。真正的 renderer 端 consumer（`App.tsx:150`）是既有代码且已有测试覆盖（`test/renderer/cross-end-sync/broadcastAndSettings.test.ts`）。

`unverified: 未在真实 Electron 双端进程里跑过一次「手机点刷新 → 桌面端数字变化」`。原因:需要真实 electron 主进程 + BrowserWindow,本仓单测栈是 node/jsdom（`vitest.config.ts` 明确「不启 electron」）。链路的每一跳都有测试,但端到端跨进程那一次要人工验。

## 6 · 抗拒的地方

- **`checkAccountStatus` 落盘失败时返回 `success:false`** 而不是「取到了就算成功」。本轮交付的成功状态是用户视角的「重载后数字仍在」,落不了盘就交付不了,返回 success 只会让用户看到一个重载即消失的数字 —— 正是在修的那个 bug,只是更隐蔽。
- **账号已被另一端删除时不重建**。走 `SkipPersist` 哨兵在 mutator 内抛出,使 `storeRef.set` 与广播都不执行 ⇒ 零副作用中止（返回原样会白递增一次 revision + 一条广播）。有测试锁死「不得复活」。
- **没顺手统一单个/批量两份字段合并语义**。它们基线本就不同,统一等于行为变更。

## 7 · 新技术债

1. **`refreshAccountToken` 是同一缺陷的变体,未修**（`accountService/refresh.ts:47`）。它返回新 access/refresh/expiresAt 却不落盘,持久化同样只长在 renderer(`accounts.ts:1811`)。面板 `App.tsx:280` 刷完 token 后调 `loadAccounts()` 想拿新 `expiresAt` —— **拿不到**。没在本轮修的两个理由:① `refresh.ts` 与 `webPanel/routes.ts` 属 W8a 文件集,并行改会撞车;② 它写的是**凭证**,而凭证有明确的非 renderer 权威源与字段级合并例外（`syncMerge.ts:mergeRecordWithCredentialException`）,落盘时机错了会让 store 与 IDE 磁盘 token 文件分叉、旧 refreshToken 被作废 ⇒ 可能需要用户重新登录。**建议单独一轮,先定凭证写入的权威顺序**。
2. `updateAccountStatus` 把瞬时 `'refreshing'` 状态落盘（`accounts.ts:1783`）。多调用方共享,单独一轮清。
3. 单个检查与批量检查的 usage 合并语义不同（重建 vs spread）。基线如此,统一需要行为变更评审。
4. `BroadcastPayload.changedIds` 仍恒为 undefined ⇒ 每条广播都让桌面端整表重取。批量按切片写已把广播数从 N 降到 N/concurrency,但真要「只刷某几行」需要兑现 changedIds（`state.ts:107` 已写明 defer 理由）。

## 验证证据

| 项 | 命令 | 结果 |
|---|---|---|
| 基线（改动前） | `npx vitest run` | 817 passed / 4 skipped (821) / 79 files · EXIT=0 |
| Red（单账号) | `npx vitest run test/main/accountService/checkPersistence.test.ts` | 3 failed —— `expected {current:10,limit:100} to match {current:42,limit:500}` / `expected 7 to be 8` |
| Red（批量,受控探针) | 同上 + `__RED_PROBE=1` 短路落盘 | 4 failed —— 同类陈旧值断言 |
| Green | 同上 | 11 passed |
| Green（renderer 双写) | `npx vitest run test/renderer/cross-end-sync/checkNoDoubleWrite.test.ts` | 5 passed |
| typecheck | `npm run typecheck:node` / `:web` | 双 EXIT=0 |
| 全量（改动后） | `npx vitest run` | **833 passed / 4 skipped (837) / 81 files · EXIT=0** |

差值 +16 tests / +2 files,零回归。

## 文件

- `src/main/accountService/persistCheckResult.ts`（新建 · 402 行含注释）
- `src/main/accountService/check.ts`（改 · +93/-12）
- `src/renderer/src/store/accounts.ts`（改 · 删 1 行 saveToStorage + 注释说明为何不能双写）
- `test/main/accountService/checkPersistence.test.ts`（新建 · 11 用例 · 真 http.Server + 真 fetch）
- `test/renderer/cross-end-sync/checkNoDoubleWrite.test.ts`（新建 · 5 用例）

未 commit,待主 AI 合并。

## Update Log

- 2026-08-04 · sub-executor(W8 持久化) · 落盘层建成并接入 IPC + HTTP 两个调用方;桌面端去双写。证据:全量 833 passed/4 skipped/81 files EXIT=0(基线 817/4/79),双 typecheck EXIT=0。踩到的坑:① 首次写测试把 blob 直接当 store 根,导致 5 条以 TypeError 假红 —— Red 必须因「功能缺失」而红,已修正后重跑确认是陈旧值断言红;② 批量测试写在实现之后,故用 `__RED_PROBE=1` 受控短路补验其真红;③ 自查 `Test-Path <inner>\.git` 报 False 一度误判仓库受损 —— 实际 repo 根是 `F:\Kiro-account-manager`,inner 目录从来没有自己的 .git。node_modules 联接已按链接删除(裸 rmdir),主仓 node_modules(587 项)与 .git 完好。
