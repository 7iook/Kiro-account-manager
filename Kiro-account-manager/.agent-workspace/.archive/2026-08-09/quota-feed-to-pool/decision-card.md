# 决策卡 · 把真实额度喂进账号池（`updateQuota` 零调用方）

> ⚠️ **本卡是开工前闸门，不是事后报告。** 未过评审 P0 不得写实现代码（Globalrules §6.0.1）。
> 2026-08-10 · 仓库 `F:\Kiro-account-manager\Kiro-account-manager` · 设计阶段**未改任何源码**
> 前序侦察：`.archive/2026-08-09/headless-server-migration/recon-autoswitch-consolidation.md`（其 §9 的 P5 即本卡）

## 📋 任务清单

> 主 AI 于 2026-08-10 按实施后真实范围回写（复审 C4 指出账本与 Update Log 互相矛盾）。验证读数为**整合态**（比各 SUB 自报更强：证明与并行改动合并后仍绿），口径为 `npx vitest run --reporter=json` 读 `numFailedTests`（**不用管道后 `$LASTEXITCODE`，该写法本轮产出过假绿**）。

- [x] T-1 `updateQuota` 漂移修正，TDD red→green
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/quotaResetAtPreserve.test.ts` 红 `2 failed / 2 passed`（红文本：`expected undefined to be 1786301134602` 与 `expected true to be false` —— 后者是用户可感知的那一半：账号过了恢复时刻仍被判耗尽）→ 绿 `4 passed` · files: `src/main/proxy/accountPool.ts:613`（`quotaResetAt: resetAt ?? account.quotaResetAt`）· `:633-659`（入口拒收 `limit<=0` / NaN / 负 used）· `src/main/proxy/types.ts:451`（新增 `quotaUpdatedAt`）· `test/main/proxy/quotaResetAtPreserve.test.ts`（新）· AC: §1 判据三分表 + §5 T-1
- [~] T-2 `remainingCredits()` + `isNearExhausted(threshold)` —— **刻意不实施（defer，非漏做）**
  - 理由：本轮无生产消费者（候选排序改动不在本卡范围），实施即构成 E-052 死代码形态。决策依据 = 本卡 §3 选项 A。复审已确认该收敛正确（「避免为架构对称实现零消费者谓词」）。
  - 归属：已转独立台账项「低额度独立谓词 + 候选排序」，与消费点（`getNextAccount` 候选排序）同轮实施。
- [x] T-3 落盘收口喂池（唯一生产调用方）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/accountService/quotaFeedWiring.test.ts test/main/proxy/quotaFeedToPool.test.ts` → 全绿 · files: `src/main/accountService/persistCheckResult.ts:73-91`（`feedQuotaToPool()` 收口：无效 usage 处理 / ISO 时间转 ms / 池不存在场景）· `:247`（单账号路径，来自 `check.ts:197`）· `:433`（批量路径，来自 `check.ts:642`）· AC: §3 owner 唯一性
- [x] T-4 接线层 —— **零改动，因契约被实施纠正**
  - **Evidence** · `commit pending` · verify: `git grep "from '../proxy" -- src/main/accountService` → **零命中**（依赖方向未变）· files: 无（`src/main/accountService/types.ts:25 ProxyServerRef` 加一个方法声明，复用既有 `deps.proxyServer.getAccountPool()`，`check.ts:243-244` 已存在该取池路径；`index.ts:3742 get proxyServer()` 已注入真实实例）· AC: §3 依赖方向单向
  - **卡片原设计被推翻**：§3 原写「注入一个可选 sink 回调」。实施时发现该机制不必要 —— accountService 已能经既有 dep 拿到池。另：仓库有**两个同名 `ProxyServerRef`**（`accountService/types.ts:25` 与 `ipc/panelProxyDeps.ts:31`），卡片未区分，改的是前者。
- [x] T-5 全量重同步不抹掉已喂额度 —— **已完成（生产四路径全覆盖，复审 C1 已闭环）**
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/poolResyncPreservesRuntime.test.ts test/main/proxy/quotaSurvivesResync.test.ts --reporter=json` → `numPassedTests=15 numFailedTests=0`；全量 `numTotalTests=1173 numPassedTests=1173 numFailedTests=0`；`typecheck:node` / `typecheck:web` EXIT=0 · files: `src/main/proxy/accountPool.ts:817`（`replaceAll` 整池重建收口 + `mergeRuntimeState`）· `src/main/index.ts:2905/3551/6205` · `src/main/ipc/panelProxyDeps.ts:174` · AC: §5 T-5
  - ✅ **复审 C1 已闭环（2026-08-10）**：生产 full resync 是 `clear()` 再 `addAccount()`，共四处（`index.ts:2902` 启动自动同步 / `:3546` replace 热替换 / `:6200` `proxy-sync-accounts` IPC / `panelProxyDeps.ts:169` 面板 syncPool）。`clear()` 把账号对象整个丢弃，故 `addAccount` 的 `prev` 保留逻辑结构上拿不到旧值。**修法未在 `addAccount` 尾部继续打补丁**，而是在整池重建的所有者处新增 `AccountPool.replaceAll()`（`accountPool.ts:817`）：清空前取快照、按 id 合并运行期状态、四个调用点全部改走它，池内 `pool.clear()` 生产调用点已归零。`quotaSurvivesResync.test.ts:96-102` 那条「清池后额度应消失」的断言（把缺陷固化为预期）已改写为「重同步走 `replaceAll` 时额度必须存活」+ 一条独立的「`clear()` 仍是显式忘掉一切」对照。
- [x] T-6 Grep gate：断言 `updateQuota` 生产调用方恰好 1 处
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/architecture/quota_feed_single_writer.test.ts` → 绿；独立核实 `git grep "\.updateQuota(" -- src/` → 仅 `persistCheckResult.ts:91` 一处生产命中 · files: `test/main/architecture/quota_feed_single_writer.test.ts`（新）· AC: §3 单写者
- [x] T-7 单测全绿 + mutation；相关性判定标 `unverified`
  - **Evidence** · `commit pending` · verify: 整合态 `npx vitest run --reporter=json` → `1151 passed / 0 failed`（2026-08-10 02:5x，池准入那路开工前）· files: 5 个新测试文件（`quotaFeedToPool` / `quotaSurvivesResync` / `quotaFeedHoldGateInteraction` / `quotaFeedWiring` / `quota_feed_single_writer`）· AC: §4
  - **门闸交互专项已验**（`quotaFeedHoldGateInteraction.test.ts`，真实 `AccountPool` + 真实 `HoldGate` 按生产方式接线）：另有可用号 → 挂起请求立即放行；全池耗尽 → 确实冻结且在 20 次复查 + 2×`maxWaitMs` 内**不抖动**；额度恢复经可用性监听唤醒挂起请求；未刷新的 `0/0` 账号不会让门闸误判池空。
  - **`unverified` 三项（实施方自标，主 AI 认可）**：E1 上游 `limit - current` 是否真能预测下一请求不撞 402 —— **故本卡只声称「真实额度已到达池、耗尽判据有了活数据源」，不声称「白赔的 402 请求已被消除」**；E2 额度仅在 `checkAccountStatus` 运行时更新，无头主 tick 用 `syncInfo=false`（`index.ts:2609`）→ 真实收益依赖换号收口后续工作；E3 未对近额度上限账号做真实反代实跑。
- [x] T-8 修复生产 full-resync 路径（复审 C1 · 新增）
  - **Evidence** · `commit pending` · verify: red `npx vitest run test/main/proxy/poolResyncPreservesRuntime.test.ts --reporter=json` → `numTotalTests=8 numPassedTests=0 numFailedTests=8`（生产路径两例红文本 `expected undefined to be 480` / `expected undefined to be 1786302873473` —— 缺陷本身，非缺符号）→ green `numPassedTests=15/15`（含 `quotaSurvivesResync`）· files: `src/main/proxy/accountPool.ts:817 replaceAll` + `:857 mergeRuntimeState` · `src/main/index.ts:2905/3551/6205` · `src/main/ipc/panelProxyDeps.ts:174` · `test/main/proxy/poolResyncPreservesRuntime.test.ts`（新，8 例）· AC: 四调用点全覆盖 + `git grep "pool.clear()" -- src/main` 生产命中归零
  - **迁移字段集（判据 = 谁是这份数据的权威源）**：入参来自 `toProxyAccountShared`（`activation.ts:223-265`），它只产出凭据与路由 ⇒ 凡它不产出的运行期字段，盘上无权威值，抹掉即凭空丢事实。迁移：额度族 `quotaUsed/quotaLimit/quotaResetAt/quotaUpdatedAt/quotaExhaustedAt` · 风控挂起族 `suspendedAt/suspendReason/suspendMessage` + 由其推导的 `isAvailable` · 断路器族 `errorCount` + `lastUsed`（**成对**，退避窗口是 `now-lastUsed < base*2^(errorCount-1)`，只迁一个会算错）· 能力探测族 `modelCapabilities/lastListModelsAt/lastListModelsStatus`。**刻意不迁**：`requestCount` 与 `accountStats` 计数（「本轮池的统计」，与 `addAccount` 既有语义一致）· `cooldownUntil`（全仓无写入点，迁一个恒 `undefined` 的字段是假装在处理它；若将来有写入点则归入断路器族）· 会话粘性（不在账号对象内，由 `invalidateSessionAffinity` 独立管理）。
  - **hot-swap 危害未重开**：`mergeRuntimeState` 里 `isAvailable` 由**合并后**的挂起状态推导（`isSuspended(merged) ? false : ...`），不按入参重算 —— 那正是 RCA §4.2b（`.archive/2026-07-28/proxy-hot-switch-single-account/`）的成因。专项测试 `replaceAll 不得静默解除运行期风控挂起` 守住。
- [x] T-9 修复 `observedAt` 因果顺序（复审 C2 · 新增）
  - **Evidence** · `commit pending` · verify: red `npx vitest run test/main/accountService/quotaObservationOrdering.test.ts --reporter=json` → `numTotalTests=3 numPassedTests=0 numFailedTests=3`（红文本 `expected 90 to be 10` = 慢的旧响应确实覆盖了快的新响应；`expected true to be false` = 陈旧观测把还能用的号判成耗尽）→ green `3/3`；铸造层 `observationClock.test.ts` `4/4`；全量 `numTotalTests=1180 numPassedTests=1180 numFailedTests=0`；`typecheck:node` / `typecheck:web` EXIT=0 · files: `src/main/utils/observationClock.ts`（新，唯一铸造点）· `src/main/accountService/check.ts:191`（单账号请求发出前铸造）· `:452`（批量逐账号铸造）· `persistCheckResult.ts:84/247/433`（`observedAt`→`observedVersion` 贯通）· `accountPool.ts:632`（参数语义注释；比较逻辑一行未动）· AC: §3 时序仲裁
  - **版本形态**：墙钟锚定的单调戳 `next = max(now, last+1)`（HLC 本地事件规则）。**不用裸 `Date.now()`**：NTP 校正 / 改表 / 虚机恢复会让它回跳，回跳后后发出的观测拿到更小值反被判迟到；同毫秒并发还会撞成相等而丢失顺序。**不用纯计数器**：`quotaUpdatedAt` 跨整池重建被 `mergeRuntimeState`（`accountPool.ts:877`）迁移，池内可能已有墙钟量级旧基线，从 1 起的计数器永远小于它 ⇒ 新观测全被静默丢弃。墙钟锚定同时满足「可与迁移来的旧基线比较」与「进程内严格单调」。
  - **铸造层 = 请求发出点**（`check.ts`），不是落盘点。落盘点的 `Date.now()` 记录的是**完成顺序**，而先发出的慢响应必然晚于后发出的快响应完成 —— 这正是缺陷本身。`now` 仍用于落盘 `lastCheckedAt`（那里要的确实是「何时刷的」），两个语义已分离。
  - **per-account 而非 per-batch**：切片内 `Promise.allSettled` 并发、各账号上游快慢不同；共用一个版本等于宣称「这一批额度是同一时刻的事实」，且同一账号在相邻两轮批量间会同分（写入侧相等即放行）而失去顺序。版本随 `BatchCheckItem.observedVersion` 随条目走。
  - **缺省降级**：`observedVersion` 可选，缺省回落到 `nextObservationVersion()`（"就当是此刻发起的观测"）—— 不劣于修复前，且绝不会因缺省而写入一个**过大**的值把新数据挡住。
  - **未改 `updateQuota` 比较语义**（派单要求核实）：`accountPool.ts:655` 的 `observedAt < quotaUpdatedAt` 丢弃、相等放行，逻辑本身正确，一行未动。缺陷全在「被比较的值在错误的层、错误的时刻产生」。
  - **双 mutation 验证**：把铸造改回 `return now`（裸 `Date.now()`）→ 铸造层 3/4 转红（`expected 1 to be 3` 同毫秒撞车 / `expected 1899999940000 to be greater than 1900000000000` 时钟回跳 / `expected 90 to be 10` 顺序判错），证明测试测的是缺陷本身而非测试写错。
  - **`quotaUpdatedAt` 语义变更的影响面已穷尽核实**：文件系统级检索（含未跟踪文件）确认它只在 `accountPool.ts`（仲裁 `:655` / 写入 `:663` / `addAccount` 迁移 `:159` / `replaceAll` 迁移 `:877`）与 `types.ts:459` 出现 —— **无任何 renderer / 面板 / preload / 序列化 / 显示路径消费它**，也没有任何地方对它做时间差运算。故「版本值可能略大于真实墙钟」不影响任何现有消费者。T-8 把它列入迁移集的理由（仲裁基线必须活过重建）在新形态下**更成立**：迁移的是同一条可比较的单调序列。


每项完成前先写回：勾 `[x]` + `**Evidence**`（commit / verify+EXIT / files / AC）+ 追加 `## Update Log` 一行。

---

## 🏗️ 1. Boundary Decisions

### Success State（§0.15B · 来源已标注 · 非自拟）

**NOT** 「`updateQuota` 有调用方了 / 测试绿了」，
**BUT** 反代在**账号真的快没额度时就已经知道**，而不是等一个请求先撞 402 失败才知道；用户在挂起日志里能看到「这个号被判额度耗尽，是真实额度数据 `used/limit` 说的，不是被标记的」。

**来源标签**：**消费者前置条件读码所得**（可独立复核，非 AI 推测）——
`proxyServer.ts:1602` 消费 `isQuotaExhausted`；`accountPool.ts:408-421` 的第三条判据依赖 `quotaUsed/quotaLimit`；而写这两个字段的唯一函数 `accountPool.ts:603 updateQuota` 零生产调用方（§2 三重取证）。
用户可感知形态由前序侦察 §6.1 确立：**每次换号先赔一个 402 失败请求**。

**Must NOT happen（负条件 · 每条都对应一个已闭合的判断）**：

1. **不得**让「快用光（剩余 ≤ 阈值）」流进 `isQuotaExhausted` / `isAccountAvailable` / `hasBlockedAccount` —— 那是把**换号判据**（便宜）与**挂起判据**（极贵）再次融合，正是 RCA 2026-08-02 修掉的病灶（`proxyServer.ts:3862` 注释记着这条教训）。
2. **不得**因为喂了额度数据，让「其实还能用的号」被挂起门闸冻结请求（RCA 2026-08-04 的用户原话形态：「账号明明正常却被拦住」）。
3. **不得**出现「一次坏数据把账号永久钉死」—— `recordSuccess` 的 `realQuotaUsedUp` 短路（`accountPool.ts:508-509`）**刻意不清除**真实额度数据，所以喂进去的 `used>=limit` **连续请求成功也翻不回来**。这是本卡最大的风险面（§1 风险裁决 D2）。
4. **不得**用占位额度（`importApiKey.ts` 写 `{current:0, limit:0}`，见 `webPanel/routes.ts:287-289` 注释）触发任何判定。
5. **不得**让 `updateQuota` 成为第二个「清除 402 耗尽标记」的权威——`recordSuccess` 已经是一个（§1 D2 仲裁）。
6. **不得**出现 `updateQuota` 覆盖掉上游给的真实 `quotaResetAt`（当前实现会，见 §1 漂移缺陷 2）。

### Q1 判定：**dead-by-drift，不是 dead-by-omission** → 工作形态是「先改写，再接线」

**git 考古结论（三条命令，全部实跑）**：

- `git log --all -S ".updateQuota("` → **唯一命中 `dab1ede`**（HoldGate 那轮），而 `git grep updateQuota dab1ede` 显示该 commit 只加了**测试**调用（`accountPoolAvailabilityNotify.test.ts:53/61`）。
- `git log -S "updateQuota(accountId" -- src/main/proxy/accountPool.ts` → 引入于 `552019f`（v1.6.0，2026-05）；`git grep updateQuota 552019f -- src` 同期**只有定义**。
- 结论：**这个函数从诞生起就没有过生产调用方**，不是「曾经有、后来被删」。

**但函数体已经与周围模型漂移**，直接加调用方会各造一个回归：

| # | 漂移缺陷 | 锚点 | 直接接线的后果 |
|---|---|---|---|
| 1 | **占位值不设防** | `:611-614` 无条件写 `quotaUsed/quotaLimit` | `importApiKey` 的 `{0,0}` 会被当额度写入。侥幸不炸只因 `:418` 要求 `quotaLimit > 0`——**靠一个远处的守卫兜住**，不是本函数的正确性 |
| 2 | **`quotaResetAt` 无条件覆盖** | `:613` `quotaResetAt: resetAt` | 常见调用是 `resetAt=undefined`（`nextResetDate` 是可选字段）→ **抹掉 `recordError` 402 刚设的真实重置时刻**（`:558-561`）→ `isQuotaExhausted` 第一条判据（时间衰减恢复，`:410-412`）失效 → 账号从「1 小时后自动恢复」变成「永不恢复」。**RCA 2026-08-04 专门在 `recordSuccess` 里保护过这个字段**（`:507` 注释），`updateQuota` 反而砸它 |
| 3 | **量纲不匹配** | `resetAt: number`（epoch ms） vs 盘上/上游 `nextResetDate?: string`（ISO） | `check.ts:55` / `parseUsage.ts:129` / `persistCheckResult.ts:220` 三处都是 `string`。直接传等于写入 `NaN`/字符串。既有正确转换先例：`verify.ts:447` `new Date(nextResetDate).getTime()` |
| 4 | **无时序仲裁** | 全函数无 `updatedAt` 概念 | `checkAccountStatus` 是并发的（`singleFlight` 只按 id 去重，跨轮次不保序）→ 迟到的旧响应可覆盖新响应 |

**另一条已核实的事实**：`toProxyAccountShared`（`activation.ts:101-142`）**完全不映射任何 quota 字段**（`git grep "quota\|usage" -- src/main/proxy/activation.ts` 零命中）。所以 `updateQuota` 确实是额度进池的**唯一**入口，不存在「入池时顺带带进来了」的第二真源 —— 这对本设计有利，但也意味着 §5 的 `addAccount` 重置会把喂进去的数据抹掉。

### Q2 判定：**唯一调用方 = 落盘收口 `persistCheckResult`**（三候选逐条裁决）

| 候选 | 裁决 | 理由（带锚点） |
|---|---|---|
| 主进程 60s 池 tick（`index.ts:2521-2611`） | ❌ **驳回** | 它**刻意** `syncInfo=false`（`:2609` 注释：「仅刷 token；用量/订阅等信息同步由渲染进程定时器负责，避免主进程跑重活」）。要它喂额度，必须先让它去拉额度 = 推翻一条有明文理由的既有决定，且把「N 个账号 × 一次上游往返」加进 60s 循环。**这是前序侦察 P1-P4 那条主线的事，不是本卡的事。** |
| **落盘收口 `persistCheckResult`（`persistCheckResult.ts:173`）** | ✅ **采纳** | ① 它是「刚从上游拿到真实额度」的**唯一**汇聚点 —— 上游 `checkAccountStatus`（`check.ts:197`）与批量（`:642`）都经它；② 它的文件头注释（`:139-150`）已明确自己是「IPC 与 web 面板共用的持久化点」，本就是为「多前端共用一份权威值」而下沉的；③ 它已经在 `applyAccountDataMutation` 的串行锁内（`state.ts:131`），写盘与喂池能在同一逻辑时刻发生，不产生「盘上已更新、池还是旧值」的窗口；④ **不需要新增任何定时器**。 |
| 反代 per-response 路径 | ❌ **驳回** | 上游响应体**不含额度余量**（`parseUsage.ts` 的输入是独立的 usage 接口，不是推理响应）。要在这条路上拿额度只能额外发请求 = 每个请求配一次额度查询。且它只覆盖「正在被用的号」，而阈值换号恰恰需要知道**候选号**的额度。 |

**两写者陷阱的正面回答**：本卡钉死 **`persistCheckResult` 是 `updateQuota` 的唯一生产调用方**，用 T-6 grep gate 机械保证（`git grep -n "\.updateQuota(" -- src` 必须恰好 1 处）。理由不是洁癖：`quotaUsed/quotaLimit` 与 `quotaExhaustedAt` 是**同一状态机的三个字段**，而 `recordError`（402 写标记）/ `recordSuccess`（清误标记）已经是两个写者。再加第三、第四个不同新鲜度的写者，就会出现「A 说 90/100、B 说 20/100，谁赢取决于调度顺序」—— 而 §1 负条件 3 说明**赢错一次的代价是账号被永久钉死**。

**依赖方向**：`accountService` **不允许** import `proxy/accountPool`（会造成 accountService→proxy 反向依赖）。故采用**依赖注入**：`persistCheckResult` 接受一个可选 sink 回调，由 `index.ts` 接线层注入实际的池写入（与 `activation.ts:60-71 ProxyActivationHost` 的既有做法同构）。反代未运行时 sink 为 no-op。

### Q3 判定：**`isQuotaExhausted` 不是本卡该驱动的旗标** —— 判据三分，各归其位

**危险交互实测确认存在**。完整链路（每一跳已 grep 核实）：

```
updateQuota 写 quotaUsed/quotaLimit
  → isQuotaExhausted 第三条判据 (accountPool.ts:418)
  → isAccountAvailable 直接 return false (accountPool.ts:322-325)
  → availableCount getter (accountPool.ts:713-722)
  → proxyServer.ts:432  isPoolAvailable: () => availableCount > 0
  → holdGate.ts:203     tryResume(): if (!isPoolAvailable()) return   ← 请求继续冻结
并且另一条：
  → hasBlockedAccount (accountPool.ts:436-441)
  → proxyServer.ts:3895 shouldHoldForNoAccount
  → decideHoldAction 第一条命中 → 挂起
```

**本设计是否重开两份 RCA 已闭合的判断？——不重开，且给出机械理由：**

| 两份 RCA 闭合的是什么 | 本卡的关系 |
|---|---|
| **2026-08-02**：`hasBlockedAccount` 只认 `isSuspended` / `isQuotaExhausted`，**明确不认** `errorCount` 退避冷却（`accountPool.ts:432-434` 注释）。病灶 = 换号判据与挂起判据混用 | 本卡**一行不改** `hasBlockedAccount` / `isAccountAvailable` / `decideHoldAction`。「剩余 ≤ 阈值」走**独立谓词**，不接入这条链 |
| **2026-08-04**：429 不得标 `quotaExhausted`（误标 → 挂起门闸误伤 1 小时）；`recordSuccess` 清误标但**保留真实额度数据** | 本卡喂的正是那条注释里所说的「`updateQuota` 从上游权威写入的真实额度数据」（`accountPool.ts:505`）。**RCA 2026-08-04 已经预设了这个写者存在** —— 本卡是补上它，而非引入新语义 |

**但存在一个 RCA 2026-08-04 没有预料到的方向**：它保护真实额度数据的前提是「这个数据是权威的」。当 `updateQuota` 从未被调用时，`realQuotaUsedUp` 短路（`:508-509`）是**死代码**，从未生效。本卡接线后它**第一次真正生效** —— 于是「一次错误的 `used>=limit` 会让账号连续请求成功也无法自愈，只能等 `quotaResetAt`」这条路径从理论变成现实。

**三分判据表（本卡的核心边界产物，回应前序侦察 §11 的「需补模型行」）**：

| # | 判据 | 语义 | 数据源 | 谁消费 | 代价 | 本卡动它？ |
|---|---|---|---|---|---|---|
| 1 | `isSuspended` | 被后端封禁，需人工 | `suspendedAt` | 可用性 + 挂起门闸 | 极高（冻结请求） | ❌ 一行不动 |
| 2 | `isQuotaExhausted` | **已经用光** | `quotaExhaustedAt`(402) / `quotaUsed>=quotaLimit` | 可用性 + 挂起门闸 | 极高 | ⚠️ **只补数据源，判据本身不动** |
| 3 | **`isNearExhausted(threshold)`（新增）** | **快用光**（剩余 ≤ 阈值） | `quotaUsed/quotaLimit` | **仅**主动换号决策 | 低（换个号，失败也就浪费一次） | ✅ 新建，**刻意不接入 1/2 的消费链** |

**优先级**：1 > 2 > 3。第 3 条**永不**导致账号「不可用」或请求挂起 —— 它只回答「该主动换掉吗」。命名上强制区分（沿用 2026-08-02 用 `isSwitchWorthyError` vs `shouldHoldForNoAccount` 强制分离的做法）。

### 风险裁决（三项，理由留痕）

| # | 议题 | 裁决 | 理由 |
|---|---|---|---|
| **D1** | 喂进去的 `used>=limit` 是否应该让账号立即不可用？ | **是，但仅当数据可信** —— 加**准入三条件**：`limit>0` 且 `used>=0` 且**非占位**（不是 `{0,0}`）。不满足则 `updateQuota` 直接 return，不写任何字段 | 真的用光了就该跳过，这是 `isQuotaExhausted` 第三条判据的原本设计意图；风险全在「数据不可信」，所以守在准入而非守在判据 |
| **D2** | `updateQuota` 写入 `used<limit` 时，是否清除 402 设的 `quotaExhaustedAt`？ | **保留现有行为（清除），但语义收紧为「以上游权威额度为准」** + 必须记录 `quotaUpdatedAt` 供日志自证 | 当前 `:615` 已经这么做。上游明说「你还有额度」比本地一个 402 推断更权威——这与 `recordSuccess` 清误标是**同一方向**（RCA 2026-08-04），不构成第二个矛盾真源。但必须能在日志里说出「谁清的、依据什么数据」，否则重演 2026-08-04「用户报障后端查不到现场」 |
| **D3** | 阈值决策是否在本卡实现？ | **不实现**。本卡只交付 `isNearExhausted` 谓词 + 数据通路，**不接 tick、不改换号编排** | 前序侦察 §9 已把「主进程阈值决策 + 定时驱动」列为 P1-P4 主线（依赖 P0 三个未核实点，含机器码连带副作用）。本卡是它标注的「P5 独立可并行」。把 P1-P4 塞进来会让两件事都过不了评审 |

### ADR admission

**需要：否** —— 一行理由：本卡不引入新边界、不改依赖方向（sink 注入沿用 `ProxyActivationHost` 既有形状）、不做技术选型；补的是一个既有函数的唯一调用方 + 一个不接入现有判据链的新谓词。**但** §1 的「判据三分表」必须同步进 `docs/architecture/ADR-0001-account-hold-gate.md` 的相关段落或 `accountPool.ts` 类注释（见 §5 注册清单）—— 那张表是本卡真正的长期资产，它防的是后人再把第 3 条接进第 1/2 条的消费链。

---

## 🔍 2. 既有实现检索（§2.2 · 反造轮子）

### 零调用方的三重取证（承重前提，本卡全部结论建立在此）

| # | 手段 | 命令 | 结果 |
|---|---|---|---|
| 1 | git 索引 | `git grep -n "updateQuota" -- .` | 6 命中：**定义 1**（`accountPool.ts:603`）+ **注释 2**（`:505` / `:565`）+ **测试 3 处**（`accountPoolAvailabilityNotify.test.ts:49/53/57/61`、`quotaFalsePositive429.test.ts:118`）。**生产调用方 0** |
| 2 | **文件系统级**（含未跟踪 / 被 ignore） | `Get-ChildItem -Recurse -Include *.ts,*.tsx,*.js,*.mjs,*.cjs \| Select-String 'updateQuota' -SimpleMatch`（排除 `node_modules` / `dist` / `out` / `.git` / `.worktrees` / `release`） | **8 命中，与①逐行一致**；另有 8 命中位于 `F:\Kiro-account-manager\proxy-safety-review-isolated\Kiro-account-manager\` —— 该路径是**本仓的隔离评审副本**（同名相对路径 + 同行号），非调用方 |
| 3 | 全历史 | `git log --all --oneline -S ".updateQuota("` | **唯一命中 `dab1ede`**，且 `git grep updateQuota dab1ede` 显示该 commit 只加测试调用 → **从未有过生产调用方**（Q1 判据） |

**判定**：零调用方成立。且不是「曾有后删」，是**建好从未接线**（E-052 母题的活体样本）。

### 内部检索

| 查什么 | 工具 + query | 结果 |
|---|---|---|
| 额度进池是否有第二条路 | `git grep -n "quotaUsed\|quotaLimit" -- src` | **仅 `accountPool.ts` 与 `types.ts:448-449`**。`toProxyAccountShared`（`activation.ts:101`）零 quota 映射 → `updateQuota` 是唯一入口 |
| 是否已有「剩余额度」谓词 | `git grep -n "remaining\|nearExhaust" -- src/main/proxy` | 零命中 → `isNearExhausted` **需新建**，非重复实现 |
| 阈值计算是否已有实现 | 读 `store/accounts.ts:3131` | `remaining = usage.limit - usage.current` —— **渲染进程有一份**。本卡新增的是主进程侧**同公式**谓词；两份公式并存是 P1-P4 收敛的事，本卡在注释里指向它，不复制逻辑 |
| 落盘收口是否适合挂 sink | 读 `persistCheckResult.ts:139-172` | 文件头注释自述「IPC 与 web 面板共用的持久化点」「无仲裁直写：main 侧刚从上游拿到的额度就是权威值」→ **语义完全对齐**，挂在这里不是硬塞 |
| 依赖注入先例 | 读 `activation.ts:60-71` | `ProxyActivationHost` 宿主注入接口，`panelProxyDeps.ts:194` 实现 → **照此形状**，不新造机制 |
| ISO→epoch 转换先例 | `git grep -n "new Date(nextResetDate)"` | `verify.ts:447` `nextResetDate ? new Date(nextResetDate).getTime() : undefined` → **复用该写法**，不自创解析 |
| 池成员重同步是否会抹掉额度 | `git grep -n "addAccount(\|upsertAccount(" -- src/main` | `addAccount` **6 个生产调用点**（`index.ts:752/2885/3530/6157/6184` + `panelProxyDeps.ts:124`），全部**重置式**（`accountPool.ts:139-152`：按入参重算，入参无 quota 字段 ⇒ 额度被抹）→ §5 T-5 必做 |

### 外部检索

| query | 工具 | 结论 |
|---|---|---|
| — | **未做** | 本卡是纯内部架构接线（给一个既有内部函数补唯一调用方 + 一个内部谓词），无「是否有成熟库」可谈。**明确记为「未做外部检索」，不记为「已验证无可复用」**（§5 反捏造红线） |

---

## 📐 3. 接口契约

### `updateQuota` 改写后的签名与准入（T-1）

```ts
updateQuota(accountId: string, used: number, limit: number, resetAt?: number, observedAt?: number): void
```

**准入三条件（不满足 → 直接 return，不写任何字段）**：

| 条件 | 拒收理由 |
|---|---|
| `limit > 0` 且 `Number.isFinite(limit)` | `{0,0}` 是 `importApiKey` 的**占位值**（`webPanel/routes.ts:287-289` 注释），不是「额度为零」 |
| `used >= 0` 且 `Number.isFinite(used)` | `NaN` 写进去会让 `used >= limit` 恒为 false，静默失效 |
| `observedAt >= account.quotaUpdatedAt`（缺省 `Date.now()`） | 迟到的旧响应不得覆盖新响应（`checkAccountStatus` 并发，`singleFlight` 只按 id 去重、不保序） |

**字段写入规则（修正漂移缺陷 2 —— 本卡最容易被漏、后果最重的一条）**：

| 字段 | 规则 |
|---|---|
| `quotaUsed` / `quotaLimit` | 直写（已过准入） |
| **`quotaResetAt`** | **`resetAt ?? account.quotaResetAt`** —— ⚠️ **绝不无条件覆盖**。当前 `:613` 写 `quotaResetAt: resetAt`，`resetAt=undefined` 时会抹掉 `recordError` 402 刚设的真实重置时刻（`:558-561`），使 `isQuotaExhausted` 的时间衰减恢复判据（`:410-412`）失效 → 账号由「1 小时后自愈」变「永不自愈」。RCA 2026-08-04 专门在 `recordSuccess` 保护过这个字段（`:507`） |
| `quotaExhaustedAt` | `used < limit → undefined`（保留现行为，D2 裁决）；否则原值不动 |
| **`quotaUpdatedAt`（新增）** | `observedAt` —— 时序仲裁依据 + 日志自证「这个判定基于何时的数据」 |

**调用方的量纲责任**：`resetAt` 是 **epoch ms**；上游/盘上 `nextResetDate` 是 **ISO string**（`check.ts:55` / `parseUsage.ts:129` / `persistCheckResult.ts:220`）。转换在**调用方**做（`new Date(s).getTime()`，无效日期 → `undefined`），沿 `verify.ts:447` 既有写法。**不在 `updateQuota` 内接受字符串** —— 那会让池层认识盘上的数据形状。

**阈值量纲（Q4 答案，已核实到 UI 文案）**：

| 项 | 事实 | 锚点 |
|---|---|---|
| 单位 | **credits（额度点数）**，不是请求数、不是 token | `parseUsage.ts:165-207`：`totalLimit = baseLimit + freeTrialLimit + bonusLimit`，取自上游 `usageBreakdownList` 里 `resourceType === 'CREDIT'` 条目的 `usageLimitWithPrecision`（**带小数精度**） |
| 公式 | `remaining = usage.limit - usage.current` | `store/accounts.ts:3131` |
| 聚合口径 | `limit`/`current` 已含 **base + ACTIVE 试用 + ACTIVE 奖励**（过期的不计，`parseUsage.ts:172/186`） | 同上 |
| 用户在哪设 | 桌面端 设置页 → 自动换号 → **「余额阈值」** 数字输入框，`min=0`，`parseInt` | `SettingsPage.tsx:905-917` |
| UI 文案宣称 | 中：**「余额低于此值时自动切换」**；英：`Switch when balance below this`。开关副标题：「余额不足时自动切换到其他可用账号」 | `SettingsPage.tsx:907-908` / `:893` |
| ⚠️ 文案 vs 实现偏差 | 文案说 **below**（`<`），实现是 `remaining <= autoSwitchThreshold`（`<=`） | `store/accounts.ts:3134` |
| ⚠️ 精度陷阱 | 阈值经 `parseInt` 是**整数**，而 credits 带小数（`*WithPrecision`）→ 阈值 0 时 `remaining=0.4` 判为 `false`（0.4 <= 0 不成立），账号会被用到真正 402 才换 | `SettingsPage.tsx:915` + `parseUsage.ts:169-170` |

**本卡对这两处偏差的处置**：**只记录、不修改**。`isNearExhausted` 严格沿用 `<=` 与既有公式（与渲染侧行为一致，避免两份判据分叉）；两处偏差登记为 §5 遗留项，交由 P1-P4 阈值决策上移那一轮统一裁决（改 `<=`/`<` 或允许小数是**产品语义决定**，需用户裁决，不是本卡的实现细节）。

### `isNearExhausted` 契约（T-2）

```ts
remainingCredits(account: ProxyAccount): number | null   // null = 无可信额度数据
isNearExhausted(account: ProxyAccount, threshold: number): boolean
```

- `quotaLimit` 缺失/≤0 或 `quotaUsed` 缺失 → `remainingCredits` 返回 **`null`**（**不是 0**）。`0` 意为「真的没额度了」，`null` 意为「不知道」—— 把「不知道」当「没额度」正是 §1 负条件 2 的形态。
- `isNearExhausted` 在 `remainingCredits() === null` 时返回 **`false`**（不知道 ⇒ 不主动换号，让请求正常走；真没额度会由 402 兜底）。
- **禁止**在 `isAccountAvailable` / `isQuotaExhausted` / `hasBlockedAccount` / `availableCount` 内调用（T-6 grep gate 断言）。

### 生产者→消费者链路表（**已按实施结果结晶** · 主 AI 2026-08-10 回写 · 复审 C5）

> 原表第 4/5 跳写的「注入 sink 回调 + 接线层实现」**已被实施推翻**：accountService 早已能经既有 `deps.proxyServer.getAccountPool()` 拿到池（`check.ts:243-244`），故装配层零改动、依赖方向未变（`git grep "from '../proxy" -- src/main/accountService` 零命中）。下表为当前生产真实锚点。

| # | 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|---|
| 1 | 上游真实额度 | `accountService/parseUsage.ts:165 parseCreditUsage` | `check.ts:135` | ✅ 既有 |
| 2 | check 结果 | `check.ts:183 checkAccountStatus` | `check.ts:197`（单账号）/ `:642`（批量） | ✅ 既有 |
| 3 | 落盘 | `persistCheckResult.ts:173` | 盘上 `accountData` | ✅ 既有 |
| 4 | **喂池收口（唯一生产写者）** | `persistCheckResult.ts:73 feedQuotaToPool()`（含无效 usage 处理 / ISO→epoch / 池不存在场景） | `accountPool.updateQuota` | ✅ **已建** |
| 5 | **两条调用路径** | `persistCheckResult.ts:247`（单账号，来自 `check.ts:197`）· `:433`（批量，来自 `check.ts:642`） | 同上 | ✅ **已建** · 取池经 `ProxyServerRef.getAccountPool()`（`accountService/types.ts:25` 加一个方法声明，**非新建注入机制**） |
| 6 | 池内额度字段 | `accountPool.ts:633 updateQuota`（已改写：`quotaResetAt` 保留 / 拒收 `limit<=0`·NaN·负 used / 新增 `quotaUpdatedAt` 仲裁） | `accountPool.ts:418 isQuotaExhausted` 第三条判据 | ✅ **已建** |
| 7 | 已用光 → 不可用 | `accountPool.ts:418` | `:322-325 isAccountAvailable` → `:713 availableCount` → `proxyServer.ts:457` → `holdGate.ts:314 tryResume` | ✅ 既有（本卡不改）· **门闸交互已专项验证**：`quotaFeedHoldGateInteraction.test.ts`（真实池 + 真实门闸按生产接线）—— 另有可用号即时放行 / 全池耗尽确实冻结且 20 次复查 + 2×maxWaitMs 内不抖动 / 额度恢复经可用性监听唤醒 / 未刷新 `0/0` 账号不致误判池空 |
| 8 | 已用光 → 被动换号 | `accountPool.ts:418` | `proxyServer.ts:1602` `autoSwitchOnQuotaExhausted` | ✅ 既有 —— **本卡主收益跳：该判据第一次有主动数据源**（此前只能由 402 错误路径点亮） |
| 9 | 挂起原因自证 | `accountPool.ts:454 describeBlockedAccounts`（`:464-467` 区分「真实额度数据」vs「仅有标记」） | `proxyServer.ts:3822` hold 日志 | ✅ 既有 —— **本卡接线后 `byRealData` 分支第一次会真出现** |
| 10 | 单写者门禁 | `test/main/architecture/quota_feed_single_writer.test.ts` | CI / pre-commit | ✅ **已建**（独立核实：`git grep "\.updateQuota(" -- src/` 仅 `persistCheckResult.ts:91` 一处生产命中） |
| 11 | ~~快用光谓词~~ | ~~`accountPool.ts` to-build~~ | ~~本轮无消费者~~ | **⏭ 已按选项 A 移出本卡**（见 T-2）—— 与消费点 `getNextAccount` 候选排序同轮交付，避免 E-052 死代码 |

**最终 sink 与实跑姿态**：
- 最终 sink = ① `proxyServer.ts:1602` 的被动换号决策（本卡主收益）② `proxyServer.ts:3822` 的挂起原因日志（`byRealData` 分支）③ 两端界面的「可用/总数」读数
- **本轮实跑**：整合态全套件连跑两次 `1164 passed / 0 failed`；门闸交互按生产方式接线专项验证（见第 7 跳）
- **未实跑（`unverified`）**：上游 `limit - current` 是否真能预测下一请求不撞 402（E1）· 无头形态下额度何时更新（E2，主 tick `syncInfo=false`）· 近额度上限账号的真实反代实跑（E3）

**⛔ 本表尚存的真实断裂（复审 C1/C2，已转独立台账项）**：
- **第 6 跳在 full-resync 后被清空**：生产 `clear()` + `addAccount()` 四处（`index.ts:2895`/`:3539`/`:6193`/`panelProxyDeps.ts:169`）丢弃整个账号对象，已喂额度与 402 标记一并消失 → 修复进行中（T-8）
- **第 4/5 跳的 `observedAt` 表示完成顺序而非因果顺序**：慢返回的旧请求会覆盖快返回的新数据 → 待修（T-9）

**默认取 A** —— 交一个本轮就完全接通的东西，而不是一半接通、一半等下一轮。若主 AI 选 B，须把「谓词无生产 caller」写进交付报告，不得声明「已接入」。

### 最终 sink + 必须真跑一次的 e2e

**sink**：外部 HTTP 请求的实际结果 —— **换号发生在 402 失败之前，而不是之后**。
**真跑姿态**：单测绿 ≠ 接通。需在**反代运行中**，把某账号用到接近上限，然后 ① 手动/定时触发一次「刷新额度」（`checkAccountStatus`），② 观察 `describeBlockedAccounts` 日志出现 `quotaUsed=X/Y` 形态（而非 `markedAt=...`），③ 确认下一个请求**没有先吃一个 402** 就换到了新号。**这一条只能靠运行验证，读码无法确认。**

---

## 🧪 4. Test Boundaries（TDD Red）

失败测试名（描述真实业务场景）。新建 `test/main/proxy/quotaFeedToPool.test.ts`；既有基线 `accountPoolAvailabilityNotify.test.ts`（含 2 例 `updateQuota` 用例）+ `quotaFalsePositive429.test.ts`（`:118` 反向用例）**必须保持绿**。

**准入与漂移（T-1）**
1. `占位额度 {used:0, limit:0} 被拒收，不写入任何 quota 字段`（覆盖负条件 4）
2. `limit 为 NaN / 负数时拒收，账号原状态不变`
3. `resetAt 缺省时不得抹掉已有 quotaResetAt`（**覆盖漂移缺陷 2 · 本卡最重的一条**）
4. `resetAt 给出时覆盖旧值`（反向对照，证明第 3 条不是"永不写入"）
5. `迟到的旧响应（observedAt 更早）不得覆盖新数据`（时序仲裁）
6. `observedAt 相等时允许写入`（边界：同毫秒不该被当成迟到）

**与既有判据的交互（承重反向用例，锁 §1 三分表）**
7. `真实额度用尽（used>=limit）→ isQuotaExhausted 为 true → 该号不计入 availableCount`（正向：本卡的收益）
8. `🟢 单个账号真实额度用尽、池内还有别的可用号 → hasBlockedAccount 为 true 但 availableCount > 0 → 请求不被挂起`（**最关键**：确认本卡不重演 RCA 2026-08-04「账号正常却被拦」）
9. `⚠️ 池内唯一账号真实额度用尽 → availableCount 归零 → isPoolAvailable false → 挂起门闸确实会冻结请求`（**诚实锁定这个后果**：这是设计预期而非缺陷 —— 真的没号可用时挂起等换号正是用户要的，`hasBlockedAccount` 注释与 ADR-0001 已确立。写成测试让后人知道这是有意的）
10. `喂入 used<limit 时清除 402 的 quotaExhaustedAt`（锁 D2 裁决）
11. `429 造成的错误计数不受 updateQuota 影响`（跨 RCA 回归：确认没顺手动到 errorCount 退避）
12. `describeBlockedAccounts 对喂入的真实数据输出 quotaUsed=X/Y 形态，而非 markedAt=...`（锁第 9 跳可观测性 —— 用户报障时能自证）

**谓词（T-2，若采用 §3 选项 A 则本组随 T-2 移出本卡）**
13. `remainingCredits 在缺 quotaLimit 时返回 null 而非 0`（锁「不知道 ≠ 没额度」）
14. `isNearExhausted 在无可信数据时返回 false`（锁负条件 2 的谓词侧）

**双 mutation（验证测试真的在测缺陷，而非测试写错）**
- **Mutation A**：把 `quotaResetAt` 改回无条件覆盖 → **测试 3 必须转红，测试 4 必须保持绿**。
- **Mutation B**：去掉占位值准入 → **测试 1 必须转红，测试 7 必须保持绿**。

**只能实跑、读码无法确认的（§4.6 诚实边界 · 全部标 `unverified`）**

| # | 场景 | 为什么读码不够 |
|---|---|---|
| E1 | 上游 `usage.limit/current` 与「下一个请求会不会吃 402」的**真实相关性** | 上游可能按不同口径计费（如 credits 扣减滞后、并发请求未结算）。`limit-current>0` 不保证下一个请求成功；反之亦可能。**这是整个功能价值的承重假设，且本卡无法验证它** |
| E2 | 喂入频率是否足够 | 额度只在 `checkAccountStatus` 被调用时更新。headless 下主 tick `syncInfo=false`（`index.ts:2609`）⇒ **可能根本没人调** → 池里的额度数据长期陈旧。**本卡交付后在 headless 下可能仍无实际改善**，改善依赖 P1-P4 |
| E3 | `addAccount` 重置窗口的实际影响 | 6 个调用点在真实使用中的触发频率未知（重启反代 / 改配置 / 面板启动）。若频繁，喂进去的额度会被反复抹掉 |

**E1 是本卡的承重未验假设**：若上游额度余量与实际可用性弱相关，则「提前知道额度」并不能消除 402，本卡收益归零。**处置**：本卡**不预设它成立**，交付报告只能写「额度数据已进池、判据第一次有主动数据源」，**不得写「消除了先失败一次」**。若 E1 实测为弱相关 → 停止在此方向加工，按 §0.12 报用户（候选：改用 402 后的快速重试 / 接受一次失败 / 改用上游其它信号）。

**边界场景（§5.4）**：并发两次 `checkAccountStatus` 同账号（`singleFlight` 只按 id 去重、跨轮不保序）· 反代未运行时 sink 为 no-op 不得抛 · 账号已从池移除后迟到的 sink 回调（`updateQuota` 首行 `if (!account) return` 已兜住，测试锁定）· 落盘成功但 sink 抛异常时**不得**让 `persistCheckResult` 失败（额度已经落盘是既成事实，喂池失败只该留痕）。

---

## 🛡️ 5. 注册检查清单

| 项 | 状态 | 说明 |
|---|---|---|
| `quotaUpdatedAt` 加入 `ProxyAccount`（`types.ts:448-449` 附近） | ⛔ 必做 | 漏了时序仲裁无处存放 |
| **`quotaUpdatedAt` 是否要进 `AVAILABILITY_FIELDS`**（`accountPool.ts:180-182`） | ⛔ **必做判断：不加** | 该数组决定是否走 `notifyIfBecameAvailable` 去抖通知。`quotaUpdatedAt` 本身不影响可用性；但 `quotaUsed`/`quotaLimit` **影响**却**也不在**该数组里 —— `updateQuota` 自己已经包了 `notifyIfBecameAvailable`（`:608`），所以走 `updateQuota` 的路径无缺口。⚠️ **但 `updateAccount` 若被传入 quota 字段则不会触发通知** —— 登记为遗留风险（本卡不改，因本卡不经 `updateAccount` 写 quota） |
| **`addAccount` 重置抹掉已喂额度**（6 个生产调用点：`index.ts:752/2885/3530/6157/6184` + `panelProxyDeps.ts:124`） | ⛔ **必做（T-5）** | `addAccount`（`:139-152`）是重置式，入参（`toProxyAccountShared`）**无 quota 字段** ⇒ 每次全量重同步都把喂进去的额度抹回 `undefined`。**这是「本轮改完、下次重启就失效」的静默失效点**。处置对齐 `upsertAccount` 既有做法（`:201-219` 剔除运行期状态字段）：把 `quotaUsed/quotaLimit/quotaResetAt/quotaUpdatedAt` 也视为运行期状态予以保留 |
| 判据三分表写入 `accountPool.ts` 类注释或 `docs/architecture/ADR-0001-account-hold-gate.md` | ⛔ 必做 | 本卡真正的长期资产；防后人把第 3 条接进第 1/2 条消费链 |
| **Grep gate（T-6）**：`updateQuota` 生产调用方恰好 1 处 | ⛔ 必做 | `git grep -n "\.updateQuota(" -- src` 必须恰好 1 命中；`isNearExhausted` 不得出现在 `isAccountAvailable`/`isQuotaExhausted`/`hasBlockedAccount`/`availableCount` 函数体内 |
| `persistCheckResult` 的 sink 为**可选**注入，缺省 no-op | ⛔ 必做 | 既有单测不传 sink 必须照旧通过；反代未运行时不得抛 |
| 依赖方向：`accountService` **不得** import `proxy/accountPool` | ⛔ 必做 | 沿 `ProxyActivationHost`（`activation.ts:60-71`）注入形状 |
| 批量路径（`persistBatchCheckResults`，`persistCheckResult.ts:327`）是否也喂池 | ⛔ **必做判断：是** | 批量检查同样拿到真实额度。漏了会表现为「单个刷新有效、批量刷新无效」的诡异不一致 |
| 第三方 SDK 隔离 | N/A | 无新依赖 |
| 界面/i18n | N/A | 本卡无 UI 改动（阈值控件已存在于 `SettingsPage.tsx:905-917`） |
| 反代热更新白名单 | N/A | 本卡不新增 `ProxyConfig` 字段 |

### 遗留登记（本轮不修，明确交接）

1. **UI 文案 vs 实现的比较符偏差**：文案「余额**低于**此值」（`<`）vs 实现 `remaining <= threshold`（`store/accounts.ts:3134`）。
2. **阈值精度陷阱**：阈值 `parseInt` 为整数（`SettingsPage.tsx:915`），credits 带小数（`parseUsage.ts:169-170` `*WithPrecision`）⇒ 阈值 0 时 `remaining=0.4` 不触发。
3. **两份 remaining 公式并存**：渲染侧 `store/accounts.ts:3131` 与本卡主进程谓词。收敛属 P1-P4。
4. **`updateAccount` 传 quota 字段不触发可用性通知**（`AVAILABILITY_FIELDS` 不含 quota 字段）。本卡不经该路径，故不改。
5. **headless 下无人调 `checkAccountStatus`**（`index.ts:2609` `syncInfo=false`）⇒ 本卡的数据源可能长期不被触发。**本卡的实际收益依赖 P1-P4**，交付报告必须写明这层依赖。

---

## Update Log

- 2026-08-10 · 初稿（设计 SUB · 未改任何源码）。
  - **零调用方三重取证完成**：git grep（6 命中全为定义/注释/测试）+ 文件系统级 `Select-String`（含未跟踪文件，与 git 结果逐行一致；另 8 命中位于本仓隔离评审副本 `proxy-safety-review-isolated\`，非调用方）+ **全历史 `git log --all -S ".updateQuota("`（唯一命中 `dab1ede` 且只加测试调用）**。承重前提成立。
  - **Q1 判定 dead-by-drift**：函数从 `552019f`(v1.6.0) 诞生起从未有生产调用方，且已漂移出 4 个缺陷（占位值不设防 / `quotaResetAt` 无条件覆盖 / 量纲 ISO-vs-epoch / 无时序仲裁）。工作形态 = 先改写再接线。
  - **Q2 判定唯一调用方 = `persistCheckResult`**，60s tick 与 per-response 均驳回（各带明文理由）；两写者陷阱以 grep gate 机械收口。
  - **Q3 判定判据三分**：`isNearExhausted` 刻意不接入 `isAccountAvailable`/`hasBlockedAccount` 消费链。危险交互链路已逐跳 grep 核实（`:418 → :322 → :713 → proxyServer:432 → holdGate:203`）。两份 RCA 的判断**不重开**；但发现 RCA 2026-08-04 的 `realQuotaUsedUp` 短路（`:508-509`）此前是**死代码**，本卡接线后首次生效 —— 已作为负条件 3 + 测试 9 显式锁定。
  - **待裁决（阻塞 T-2）**：`isNearExhausted` 本轮无生产消费者（E-052 形态）。§3 已给选项 A（谓词移出本卡，随 P1-P4 交付 · 推荐）/ 选项 B（留卡内并显式 defer）。**主 AI 未裁决前不得开工 T-2。**
  - 外部检索：**未做**（纯内部接线，无外部库可比）—— 明确记为未做，非「已验证无可复用」。

- 2026-08-10 · 实现落地（执行 SUB · worktree `.worktrees/hold-auto-release/main`，分支 `feat/hold-gate-auto-release`，**未 commit**）。

  **Success State（逐字照抄本卡 §1，未改写成实现视角）**：
  > **NOT** 「`updateQuota` 有调用方了 / 测试绿了」，**BUT** 反代在**账号真的快没额度时就已经知道**，而不是等一个请求先撞 402 失败才知道；用户在挂起日志里能看到「这个号被判额度耗尽，是真实额度数据 `used/limit` 说的，不是被标记的」。

  **交付范围裁决**：取 §3 **选项 A** —— 只交 T-1/T-3/T-4/T-5/T-6，**T-2（`remainingCredits` / `isNearExhausted`）不实现**。理由与卡内一致：本轮无生产消费者（阈值决策属 P1-P4），交一个「一半接通」的谓词就是 E-052 形态。派单指令亦明确禁止引入阈值谓词。

  **契约与卡内设计的一处偏差（已核实，非擅自改动）**：卡 §3 说「`persistCheckResult` 接受一个可选 sink 回调，由 `index.ts` 注入」。实测 `accountService` **已经**通过 `deps.proxyServer.getAccountPool()` 访问池（`check.ts:243-244` 查绑定出口代理），故无需新造 sink 机制 —— 只在既有 `ProxyServerRef`（`accountService/types.ts:25`）的池形状上补一个 `updateQuota` 方法声明即可，依赖方向仍是 `accountService` 零 import `proxy/*`（`git grep "from '../proxy" -- src/main/accountService` 零命中）。`index.ts:3742 get proxyServer()` 注入的是真实 `ProxyServer`，结构化类型天然满足，接线层**零改动**。另注：仓内有**两个**同名 `ProxyServerRef`（`accountService/types.ts:25` 与 `ipc/panelProxyDeps.ts:31`），卡内未区分；本轮改的是前者。

  **落地清单**：
  - T-1 `updateQuota` 改写（`accountPool.ts:633`）：准入三条件（`limit>0` 且有限 / `used>=0` 且有限 / `observedAt >= quotaUpdatedAt`）+ 新增 `quotaUpdatedAt`（`proxy/types.ts:451`）。漂移缺陷 2（`quotaResetAt` 无条件覆盖）本 worktree 已先行修复，本轮**在其之上构建，未回退**。
  - T-3/T-4 唯一生产写者：`feedQuotaToPool`（`persistCheckResult.ts:73`）→ 单账号 `:247` / 批量 `:433`；调用方 `check.ts:197` / `:642` 传 `deps.proxyServer`。ISO→epoch 转换在 sink 内（沿 `verify.ts:447` 写法），无效日期 → `undefined`，不写 NaN。**只在 `outcome.persisted` 后才喂**；喂池异常只记日志，不让「刷新额度」失败（额度已落盘是既成事实）。
  - T-5 `addAccount` 不再抹掉运行期额度（`accountPool.ts:139`）：`quotaUsed/quotaLimit/quotaResetAt/quotaUpdatedAt/quotaExhaustedAt` 五字段用 `??` 保留池内既有值（入参自带则以入参为准，保住启动复原语义）。**实测确认这是真缺陷**：修前 4 例红，含「402 打的耗尽标记被重同步抹掉」。这一格是「本轮改完、下次重启就静默失效」的那个点。
  - T-6 Grep gate（`test/main/architecture/quota_feed_single_writer.test.ts`）：断言 `updateQuota` 生产调用方恰好 1 处 + 四个可用性判据函数体内不得出现 `remainingCredits/isNearExhausted/nearExhaust`。**两条判据都做了反向验证**（插第二个写者 → 红；在 `hasBlockedAccount` 里引用谓词名 → 红）。
  - ⛔ `isQuotaExhausted` / `isAccountAvailable` / `hasBlockedAccount` / `decideHoldAction` **一行未动**（gate 机械保证）。

  **验证证据（全部实跑）**：
  - 新增红→绿：`quotaFeedToPool.test.ts` 红 6/18（准入缺失 → `expected +0 to be undefined`；无仲裁 → `expected 10 to be 90`；无 `quotaUpdatedAt` → `expected undefined to be 1700000000000`）→ 绿 18/18。`quotaFeedWiring.test.ts` 红 4/8（全为 `expected undefined to be 42/77/…` = 喂池缺失）→ 绿 8/8。`quotaSurvivesResync.test.ts` 红 4/6 → 绿 6/6。
  - 双 mutation 均命中：**A** `quotaResetAt` 改回无条件覆盖 → `quotaResetAtPreserve` 2 红 + 新 wiring 用例 1 红，其反向对照「显式传 resetAt 以上游为准」保持绿；**B** 去掉占位值准入 → `quotaFeedToPool` 2 红。（B 的副产物：挂起门闸那条占位用例**仍绿**，因为 `isQuotaExhausted:418` 要求 `quotaLimit>0` —— 印证卡 §1 漂移缺陷 1「靠一个远处的守卫兜住」的判断，故准入必须守在入口。）
  - `npx vitest run test/main/proxy/` → **EXIT=0 · 30 files · 286 passed**（基线 252，+34 新增）。
  - `npx vitest run` → **EXIT=0 · 108 files · 1143 passed**。
  - `npm run typecheck:node` → **EXIT=0**；`npm run typecheck:web` → **EXIT=0**。
  - **`quotaFalsePositive429.test.ts` 全绿**（含 `:118` 反向用例「成功不得覆盖真实额度数据」）；`quotaResetAtPreserve.test.ts` 全绿。

  **用户可见行为变化（诚实标注）**：额度耗尽的号从此会从 `availableCount` 消失 → 桌面端与面板的「可用/总数」数字会变小 → `isPoolAvailable`（`proxyServer.ts:457`）→ 挂起门闸 `tryResume`（`holdGate.ts:314`）判定池空的时机随之改变。已按派单要求显式验证该交互（`quotaFeedHoldGateInteraction.test.ts` 6 例，用真实 `AccountPool` + 真实 `HoldGate` 按生产装配接线）：① 还有别的可用号 ⇒ 挂起请求立刻放行（防 RCA 2026-08-04 误伤）；② 整池用光 ⇒ 确实冻结（设计预期，已写成测试让后人知道是有意的）；③ 反复复查 20 次 + 推进 2×maxWaitMs **不抖动**；④ 下一轮刷新发现额度恢复 ⇒ 监听器直接唤醒挂起请求；⑤ 未刷新过的占位 0/0 账号**不得**让门闸误判池空。

  **仍未验证（读码无法确认，`unverified`）**：
  - **E1 承重未验假设**：上游 `usage.limit/current` 与「下一个请求会不会吃 402」的真实相关性。故本报告只声明「真实额度已进池、判据第一次有主动数据源」，**不声明「消除了先失败一次」**。
  - **E2 喂入频率**：额度只在 `checkAccountStatus` 被调用时更新，headless 下主 tick `syncInfo=false`（`index.ts:2609`）⇒ 可能长期无人触发。**本轮的实际收益依赖 P1-P4**。
  - **E3 真跑姿态未做**：反代运行中把某号用到接近上限 → 触发刷新 → 观察 `describeBlockedAccounts` 出现 `quotaUsed=X/Y` 形态 → 确认下一个请求没先吃 402。单测绿 ≠ 接通，这一条只能实跑。

---

- **2026-08-10 · executor（T-8 生产 full-resync 路径修复）· commit pending**

  **修了什么**：复审 C1 指出的缺口 —— 生产的整池重同步是 `clear()` 然后 `addAccount()`，而 `clear()` 把 `accounts` 整个清空，故上一轮加在 `addAccount` 里的 `prev ??` 保留法**结构上已经无源可读**。用户可感知形态：面板点一次「同步池」或改一次配置，刚喂进池的真实额度和 402 打的耗尽标记一起消失，已耗尽的号重新进入轮询，挂起门闸的「池是不是空了」从一份被抹干净的状态上算出来。

  **修在哪一层（刻意不在 `addAccount` 尾部继续打补丁）**：新增 `AccountPool.replaceAll(accounts)`（`accountPool.ts:817`）作为整池重建的唯一入口 —— 清空**之前**取快照，按 id 合并运行期状态，`notifyIfBecameAvailable` 在最外层包一次（避免嵌套在池已清空的中间态上算 `availableCount`）。字段取舍收口在私有 `mergeRuntimeState`（`:857`）。四个调用点全部改走它：`index.ts:2905`（自启动，含 retrySync 复用）/ `:3551`（replace 热替换）/ `:6205`（`proxy-sync-accounts` IPC）/ `panelProxyDeps.ts:174`（面板 syncPool）。`clear()` 保留但加了指向 `replaceAll` 的警告注释 —— 「忘掉一切」本身是合法语义（测试 / 显式清池），只是不该被重同步用。

  **调用点复核（P-03 改 A 漏传播）**：`git grep -n "addAccount\|upsertAccount" -- src/` 枚举出全部 6 个入池点。四处是 clear-then-add（已全改）；`index.ts:760` 是 lazy-refill，**不清池**，上一轮的 `prev ??` 已覆盖，不属本缺陷；`index.ts:6175` 是单账号 `proxy-add-account`，语义是「加一个号」不是重建，不动。改后 `git grep "pool.clear()" -- src/main` 生产命中**归零**（剩余 `.clear()` 是 `pendingStoreWrites` / `proxyLogStore` 等无关对象）。

  **测试改动（唯一一处「改测试是对的」，明确记录改前改后）**：`quotaSurvivesResync.test.ts:96-102` 原断言
  「`clear()` 后重建则不保留 → `expect(pool.getAccount('F')!.quotaUsed).toBeUndefined()`」
  —— 这条把缺陷冻成了预期行为：生产走的正是 clear→addAccount，于是「额度活不过一次同步」被测试认证为正确。已改写为两条：① 「生产的全量重同步走 `replaceAll`，额度必须跨整池重建存活」（断言 `quotaUsed=500` 且 `isQuotaExhausted=true`）② 独立对照「`clear()` 是显式的忘掉一切，其语义不变」（断言 `getAccount` 为 null、`size=0`）。拆成两条是为了保住 `clear()` 原语的语义不被这次修改悄悄改掉。

  **hot-swap 危害未重开（派单硬约束 2）**：`mergeRuntimeState` 里 `isAvailable` 由**合并后**的挂起状态推导（`isSuspended(merged) ? false : (入参 ?? 旧值 ?? true)`），不按入参重算 —— 按入参算就会因为盘上映射不带 `suspendedAt` 而得出 `true`，那正是 `accountPool.ts:212-217` 注释所警告、RCA §4.2b 记录的成因。风控挂起三件套与额度**同等对待**（都是「只有运行期知道、抹掉会让坏号被选中」的状态），并有专项测试 `replaceAll 不得静默解除运行期风控挂起` 守住。

  **验证证据（全部实跑，用 `--reporter=json` 读 `numFailedTests`，不用管道 + `$LASTEXITCODE`）**：
  - 红：`npx vitest run test/main/proxy/poolResyncPreservesRuntime.test.ts --reporter=json` → `numTotalTests=8 numPassedTests=0 numFailedTests=8`。承重的两条是**生产路径**红文本 `AssertionError: expected undefined to be 480`（面板 syncPool 重建后额度没了）与 `expected undefined to be 1786302873473`（402 耗尽标记没了）—— 是缺陷本身，不是缺符号。另 6 条为 `pool.replaceAll is not a function`（新原语未建）。
  - 绿：同文件 + `quotaSurvivesResync.test.ts` → `numTotalTests=15 numPassedTests=15 numFailedTests=0`。
  - 全量：`npx vitest run --reporter=json` → `numTotalTestSuites=357 numTotalTests=1173 numPassedTests=1173 numFailedTests=0 numPendingTests=0`。**零失败**，另一个 SUB 在途的 4 例（`proxyActivation` / `proxyRoutes`）在本轮收尾时已由其自行修复转绿，非本轮改动所致。
  - 回归守卫：`quotaFalsePositive429.test.ts` **20 例全绿**（编码两次生产事故，派单点名必须保持）；`proxyActivation.test.ts` 17 · `proxyRoutes.test.ts` 20 · `panelProxyDeps.test.ts` 7 · `test/main/architecture/` 全 12 文件（含 `proxy_orchestration_wiring` 13 例、`quota_feed_single_writer` 3 例）→ 合计 `numPassedTests=132 numFailedTests=0`。
  - `npm run typecheck:node` → **EXIT=0**；`npm run typecheck:web` → **EXIT=0**。

  **迁移字段集与刻意丢弃项**：判据是「谁是这份数据的权威源」。入参来自 `toProxyAccountShared`（`activation.ts:223-265`），它只产出凭据与路由（token / region / profileArn / proxyUrl / weight / groupId），所以凡它不产出的运行期字段，盘上就没有权威值，抹掉等于凭空丢事实。**迁移**：额度族五字段（`quotaUpdatedAt` 必须一起迁，否则时序仲裁失去基准，一个迟到的旧响应就能把新数字按回去）· 风控挂起三件套 + 推导出的 `isAvailable` · 断路器 `errorCount` + `lastUsed`（**成对**，退避窗口是 `now-lastUsed < base*2^(errorCount-1)`，只迁一个会把窗口算错）· 能力探测三字段（否则已探明的号退回 unknown 态并重探一轮）。**刻意丢弃**：`requestCount` 与 `accountStats` 的 requests/tokens/errors（「本轮池的统计」，重建整池即新一轮，与 `addAccount` 既有语义一致；但 `accountStats.lastUsed` 跟随账号对象上的退避时钟迁移，避免两处时间基准分叉）· `cooldownUntil`（全仓**无写入点** —— 只在 `describeBlockedAccounts:498` / `getQuotaStatus:691` 读、`reset():742` 清，迁一个恒为 `undefined` 的字段是假装在处理它；已在注释里写明若将来有了写入点它归属断路器族应一起迁）· 会话粘性（不在账号对象内，由 `proxyServer.invalidateSessionAffinity` 独立管理，各调用点换号语义不同，不该由池代劳）。

  **遗留**：T-9（`observedAt` 因果顺序）未动，不在本轮派单范围。

---

- **2026-08-10 · executor（T-9 `observedAt` 因果顺序）· commit pending**

  **Success State（逐字照抄本卡 §1，未改写成实现视角）**：
  > **NOT** 「`updateQuota` 有调用方了 / 测试绿了」，**BUT** 反代在**账号真的快没额度时就已经知道**，而不是等一个请求先撞 402 失败才知道；用户在挂起日志里能看到「这个号被判额度耗尽，是真实额度数据 `used/limit` 说的，不是被标记的」。

  **修了什么**：复审 C2 指出的缺口 —— 版本戳记录的是**完成顺序**而非**因果顺序**。`persistCheckResult` 在落盘时刻才 `Date.now()`（原 `:237` 单账号 / `:405` 批量），把它当「这份数据的观测时刻」喂给池。于是先发出但上游慢的请求 A，最终因为完成得晚而拿到更大的值，池侧仲裁认为 A 更新，用 A 的旧额度覆盖了后发出、已先落盘的 B 的新额度。用户可感知形态：陈旧数据把一个还能用的号判成耗尽 → `availableCount` 归零 → `isPoolAvailable` → 挂起门闸冻结请求；或反向把一个真耗尽的号复活成可用。

  **修在哪一层**：铸造点上移到**请求发出点**（`check.ts:191` 单账号 / `:452` 批量逐账号），落盘层只负责把它透传下去。池侧比较逻辑（`accountPool.ts:655`）**一行未动** —— 复核确认该比较（更小即丢弃、相等放行）本身正确，缺陷全在被比较的值产生于错误的层、错误的时刻。落盘的 `now` 保留用于 `lastCheckedAt`（那里要的确实是「何时刷的」），两个语义至此分离。

  **版本形态与两个被否掉的选项（判据 = 这个值唯一的用途是互相比较）**：采用墙钟锚定的单调戳 `next = max(now, last + 1)`，即 HLC 的本地事件规则（CockroachDB / MongoDB / YugabyteDB 用它替代墙钟 last-write-wins；Kulkarni & Demirbas 2014，Martin Fowler «Hybrid Clock»）。收口在新建的 `src/main/utils/observationClock.ts`（唯一铸造点）。
  - **裸 `Date.now()` 不行**：① 不单调 —— NTP 校正 / 用户改表 / 虚机挂起恢复都能让它往回跳，回跳后**后**发出的观测拿到更小的值，反被判成迟到的旧响应而丢弃，恰好是仲裁本该防止的后果；② 分辨率不足 —— 同毫秒内发出的两次观测撞成相等，顺序信息直接丢失。
  - **纯计数器不行（这是决定性约束，读码才发现）**：`quotaUpdatedAt` 会跨整池重建被 T-8 的 `mergeRuntimeState`（`accountPool.ts:877`）**迁移**，且既有测试/调用方留下过墙钟量级的基线（`poolResyncPreservesRuntime.test.ts:125` 传 `Date.now()-1000`、`quotaFeedHoldGateInteraction.test.ts:177` 传 `Date.now()+1`）。一个从 1 开始的计数器永远小于这类基线 ⇒ 新观测被全部静默丢弃，会把 T-9 修成一个更隐蔽的缺陷。墙钟锚定同时满足「能与迁移来的旧基线比较」与「进程内严格单调」。
  - 单进程单调即足够：这个值只在主进程内产生与比较（池活在主进程内存，不跨进程复制、不做多副本合并），故不需要 HLC 的节点分量或向量时钟。

  **per-account 而非 per-batch（派单要求给出理由）**：切片内是 `Promise.allSettled` 并发，各账号上游快慢不同。共用一个批级版本等于宣称「这一批的额度是同一时刻的事实」；更实际的害处是同一账号在**相邻两轮批量**间会拿到可比性受损的值 —— 若两轮同分，写入侧「相等即放行」会让后写的赢，退化回完成顺序。版本因此随条目走（`BatchCheckItem.observedVersion`）。

  **缺省降级**：`observedVersion` 为可选参数，缺省时回落到 `nextObservationVersion()`（语义：「就当它是此刻发起的观测」）。这比缺省 `Date.now()` 更安全 —— 它取的是当前单调序列的下一个值，绝不会凭空写入一个**过大**的值把后续真实观测长期挡在门外。旧调用方 / 未改动的路径行为不劣于修复前。

  **`quotaUpdatedAt` 语义变更的影响面（派单点名要核实）**：用文件系统级检索（含未跟踪文件，git grep 会漏）穷尽确认该字段只出现在 `accountPool.ts`（仲裁 `:655`、写入 `:663`、`addAccount` 迁移 `:159`、`replaceAll` 迁移 `:877`）与 `types.ts:459`。**无任何 renderer / web 面板 / preload / 序列化 / 显示路径消费它**（`proxyServer.ts:2342` 的 `/admin/accounts` 与 `index.ts:6220` 的 `proxy-get-accounts` 都不含该字段），也没有任何地方对它做时间差运算。故「版本值在同毫秒并发时可能略大于真实墙钟」不影响任何现有消费者。已在 `types.ts` 与 `accountPool.ts:632` 注释里写明它**只可比较、不是时间**，禁止用于显示或算时间差。T-8 把它列入迁移集的理由（仲裁基线必须活过整池重建，否则一个迟到的旧响应就能把新数字按回去）在新形态下更成立：迁移的是同一条可比较的单调序列。

  **验证证据（全部实跑，用 `--reporter=json` 读 `numFailedTests`，不用管道后 `$LASTEXITCODE`）**：
  - 红（因果形态，非症状）：`npx vitest run test/main/accountService/quotaObservationOrdering.test.ts --reporter=json` → `numTotalTests=3 numPassedTests=0 numFailedTests=3`。红文本 `AssertionError: expected 90 to be 10`（先发出的慢响应确实覆盖了后发出的快响应，单账号与批量各一例）与 `expected true to be false`（陈旧观测把还能用的号判成 `isQuotaExhausted`）—— 是缺陷本身，不是缺符号。测试用手控 deferred 让「发出顺序」与「完成顺序」严格相反。
  - 绿：同文件 `3/3`；铸造层 `test/main/accountService/observationClock.test.ts` `4/4`。
  - **铸造层是既有测试的盲区**（派单要求补的那一层）：既有池测试全部手写 `t1`/`t2` 常量喂给 `updateQuota`，只验「比较对不对」，于是「生产铸造出的值全都相等」或「时钟回跳导致后发出的值更小」这两类缺陷在池测试里完全不可见 —— 那正是本缺陷能长期存在的原因。
  - **双 mutation 均命中**：把铸造改回 `return now`（裸 `Date.now()`）→ 铸造层 3/4 转红：`expected 1 to be 3`（同毫秒撞车，3 个值退化成 1 个）/ `expected 1899999940000 to be greater than 1900000000000`（时钟回跳后不再递增）/ `expected 90 to be 10`（顺序判错）。证明测试测的是缺陷本身而非测试写错。已还原实现。
  - 全量：`npx vitest run --reporter=json` → `numTotalTestSuites=363 numTotalTests=1180 numPassedTests=1180 numFailedTests=0 numPendingTests=0`。基线 1173 + 本轮 7 例，**零失败、零跳过**。
  - 回归守卫（派单点名必须保持绿）：`quotaFalsePositive429` / `poolResyncPreservesRuntime` / `quotaSurvivesResync` / `architecture/quota_feed_single_writer` 四文件合计 `numPassedTests=38 numFailedTests=0`。单写者门禁仍绿 ⇒ 未新增第二个 `updateQuota` 生产写者。
  - `npm run typecheck:node` → **EXIT=0**；`npm run typecheck:web` → **EXIT=0**。

  **仍未验证（`unverified`）**：本轮修的是「哪份观测更新」的判据，**不触及** E1/E2/E3 三项承重未验假设（上游余量与 402 的真实相关性 / headless 下额度多久才被刷一次 / 真实反代实跑）。另：真实并发下「上游响应体现的额度事实顺序是否与请求发出顺序一致」本身是一个假设 —— 若上游存在扣减滞后，先发出的请求可能反而携带更新的结算结果。读码无法证伪，标 `unverified`；本轮只声称「版本戳表示因果顺序而非完成顺序」，不声称「池里的额度永远是最新事实」。
