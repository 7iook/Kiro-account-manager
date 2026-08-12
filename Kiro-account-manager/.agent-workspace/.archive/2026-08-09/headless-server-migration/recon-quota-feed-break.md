# 侦察报告 · 真实额度数据如何抵达账号池（updateQuota 断链）

> 模式 R · 只读侦察 · **未改任何业务代码**
> 日期 2026-08-10 · 上游任务 headless-server-migration
> 前序侦察: `recon-autoswitch-consolidation.md`

## 1. 计划假设清单（可被现实推翻的）

| # | 上游假设 | 状态 |
|---|---|---|
| A1 | `accountPool.ts:603 updateQuota` 全仓零调用 | ✅ 已核验（双通道） |
| A2 | 池的 `isQuotaExhausted` 只能由错误路径（402）点亮 | ✅ 成立，且比描述更彻底 |
| A3 | `updateQuota` 可直接复用，缺的只是一个调用点 | ❌ **不成立** —— 函数本身有一处会抹掉 `quotaResetAt` 的缺陷 |
| A4 | `accountService/check.ts:183` 取数、`persistCheckResult.ts` 落盘 | ⚠️ 路径名对、目录/行号偏移：实为 `src/main/accountService/`（无 `services/` 层），取数编排在 `check.ts:218 performAccountStatusCheck` |
| A5 | 代理每次响应都看到 credits/usage，是第二个活数据源 | ❌ **不成立** —— `recordSuccess` 收到的只是 token 计数，不是账号额度 |
| A6 | 喂真实额度 = 驱动 `isQuotaExhausted` | ⚠️ 语义上是唯一入口，但**不能满足「剩余 N 就切」** —— 见 §4-B |

## 2. 现实核验（plan vs reality）

### A1 零调用 · 已双通道确认 🟢

- `git grep -n "updateQuota"`（已跟踪文件）：命中定义 `accountPool.ts:603`、两条注释（`:505` `:565`）、以及**仅测试**调用 `test/main/proxy/accountPoolAvailabilityNotify.test.ts:53/61`、`test/main/proxy/quotaFalsePositive429.test.ts:118`。
- `everything-search`（文件系统级，含未跟踪文件，`path:F:\Kiro-account-manager ext:ts content:"updateQuota"`）：全盘 12 文件命中，去掉 `.worktrees\hold-auto-release`、`.worktrees\proxy-safety-net`、`proxy-safety-review-isolated` 三份**副本**后，剩余正是上述 3 个真实文件。**无未跟踪的隐藏调用点。**

**比零调用更彻底的一条证据**：`git grep -n "quotaUsed\|quotaLimit" -- src` 显示这两个字段的**唯一写入点是 `updateQuota` 自己**（`accountPool.ts:611-612`），其余全是读（`:418` `:464` `:508`）与注释。→ `isQuotaExhausted` 的第三条判据（`:418` `quotaUsed >= quotaLimit`）在生产中**永远为 false**，只在单测里被点亮过。

### A2 只有 402 能点亮 · 成立且更严重

- `recordError`（`:566-582`）：`const isQuotaError = statusCode === 402` → 设 `quotaExhaustedAt = now`。生产中**唯一**点亮路径。
- 反向证据：`recordSuccess`（`:508`）用 `realQuotaUsedUp` 短路保护「真实额度数据」不被一次成功抹掉 —— 这段防御**当前永远走 else 分支**，因为 `quotaLimit` 从未被写入。测试 `quotaFalsePositive429.test.ts:118` 手动调 `updateQuota` 造出该状态所以是绿的；生产中它是死分支。

### A3 `updateQuota` 不能原样复用 —— 带一处会造成回归的缺陷 🔴

```
// accountPool.ts:603-624
updateQuota(accountId, used, limit, resetAt?) {
  ...
  quotaResetAt: resetAt,        // ← 无条件覆盖：resetAt 为 undefined 时把已有值抹成 undefined
  quotaExhaustedAt: (used < limit) ? undefined : account.quotaExhaustedAt
}
```

`quotaResetAt` 是 `isQuotaExhausted` 的**第一条判据**（`:410`「过了重置时间就不再算耗尽」），也是 `recordError:578-581` 在 402 时按 `quotaResetMs`(1h) 顺延写入的自动恢复时刻。新调用点若在拿不到上游 `nextResetDate` 时按现签名调 `updateQuota(id, used, limit)`，就会抹掉 402 设好的 1 小时自动恢复时间 → 该账号退化成「只能靠 `used<limit` 或手动 reset 恢复」。

对比同文件 `updateAccount`（`:174`）与 `recordSuccess`（`:512-517`）都刻意保留既有可用性字段，且 `recordSuccess:507` 注释明写「`quotaResetAt`:上游给的真实配额重置时刻,**保留**供 `isQuotaExhausted` 第一条判据用」。→ **无条件覆盖与同文件既定约定相矛盾，属实现缺陷，非有意设计。**

判定：**dead-by-omission 为主 + 一处 drift**。骨架（`notifyIfBecameAvailable` 去抖包裹、恢复/耗尽双向日志）与现行约定一致；只有 `quotaResetAt` 这一行需改成条件回落（`resetAt ?? account.quotaResetAt`）。

git 考古（`git log -S`）：`updateQuota` 自 `552019f`(v1.6.0) 存在，此后仅 `cdf71f9`（2026-08-04 429 误判 RCA）与 `b10b782` 碰过注释/周边。**它从未有过调用点** —— 不是「接上后被摘掉」，而是当年写全了池 API 却只接了错误路径。

### A5 代理侧没有第二个活额度源 ❌

`recordSuccess(accountId, tokens)` 的 13 个调用点（`proxyServer.ts:2580/2906/3039/3067/3183/3354/3409/3512/3553/3713/4151/4394`）传的全是 `usage.inputTokens + usage.outputTokens` —— **本次请求消耗的 token**，不是账号剩余额度；`accountPool.ts:539-546` 把它累加进 `accountStats.tokens`（纯统计）。

额度权威数字来自 `getUsageLimits`（`kiroApi.ts:592` REST `management.{region}.kiro.dev/getUsageLimits`），只有 `accountService` 在调（`check.ts:261/286/346/464`、`verify.ts:235/423`）。**代理的流式转发路径不碰它**，响应里也没有可解析的额度头（`git grep -in "remaining-quota|creditsRemaining|usageLimit" -- src/main/proxy` 只命中 `kiroApi.ts` 自己的响应解析）。

→ **只有一个真实额度源**，不存在需要仲裁的第二活源。代理侧唯一能贡献的是「消耗速率」，那是另一个量。

### A6 池入池映射也不带额度（第三处断点）

`toProxyAccountShared`（`activation.ts:101-142`）是盘上记录 → `ProxyAccount` 的唯一共享映射，逐字段 `assign` 了 email/token/region/machineId/…，**完全没有 usage → quotaUsed/quotaLimit 的映射**。即便盘上有新鲜额度（`persistCheckResult` 确实写了 `usage.current/limit`），**入池那一刻就被丢掉**。

→ 断链是**三处**，不止「缺一个 `updateQuota` 调用」：
1. 入池映射不带额度（`activation.ts:101`）
2. 落盘后无人通知池（`persistCheckResult.ts` 无池引用）
3. `updateQuota` 无调用点（`accountPool.ts:603`）

## 3. 重复实现与可复用扫描

**内部**：
- 阈值判断已存在但只在渲染进程：`renderer/src/store/accounts.ts:3111 checkAndAutoSwitch` → `:3130 remaining = usage.limit - usage.current` → `:3134 if (remaining <= autoSwitchThreshold)`。`autoSwitchThreshold` 在 `src/main` 与 `src/webPanel` **零命中** —— 阈值这个概念主进程完全不知道。
- 池侧只有**二元**耗尽概念：`ProxyPoolConfig`（`accountPool.ts:63`）只有 `quotaResetMs`；`types.ts:581` 只有 `autoSwitchOnQuotaExhausted?: boolean`。**无任何 threshold 字段。**
- 必须复用的既有收口：`persistAccountPatch`（单账号写盘唯一收口）、`applyAccountDataMutation`（`state.ts:131` 串行锁 + revision + `accounts-data-changed` 广播）、`notifyIfBecameAvailable`（`accountPool.ts:118` 0→>0 去抖，`updateQuota` 已在用）。
- 结论：**扩展 `updateQuota` + 新增一个调用点，不新建平行实现**。渲染层 `checkAndAutoSwitch` 是同意图的第二实现，但跑在渲染进程且切的是「active 账号」而非「池内择号」，本轮**不动**（见 §7）。

**外部**：未检索。本轮结论全部来自项目内部源码与 git 历史交叉验证；「把配额喂给连接池」不是需要选型的通用能力（无库可复用）。按 anti-fabrication 红线，此处**明确写「未检索外部」而非编造锚点**。

## 4. 架构/前提质疑 + 业务现实检查 + 更优做法

### A · 业务现实检查（§0.17）

1. **真实场景**：用户在无渲染进程的场景（headless / web 面板 / 桌面窗口关闭但反代在跑）用反代批量跑请求，希望某号快见底时**提前**换号，而非撞一次失败再换。
2. **缺失代价**：当前每次换号**必然烧掉一次真实请求**（`proxyServer.ts:1602` 反应式切换要先失败）；流式请求下用户看到中断/报错。**真实用户损失**，不是「接口不对称」。
3. **既有覆盖**：反应式切换已工作（`:1602/1698/1771/1822`），「最终会换号」能力在；缺的是**提前**。渲染进程 `checkAndAutoSwitch` 覆盖桌面端开窗场景，覆盖不到 headless。
4. **分类：A（业务必需）**。

### B · 前提质疑（会改变本轮改动形状）

**上游把两件事绑在一起，但它们需要不同机制：**

| 目标 | 需要的机制 | `updateQuota` 能否满足 |
|---|---|---|
| 池知道真实额度、耗尽时**不再被选中**（而非撞 402 才知道） | 二元 `isQuotaExhausted` | ✅ 正是它的设计 |
| **剩余 ≤ N 就提前切**（N 为正数） | **阈值择号**：`isQuotaExhausted` 之外的一层「软不可用/降权」 | ❌ **不能** |

原因：`isQuotaExhausted`（`:408-421`）是硬布尔，`used >= limit` 才算耗尽。若为实现阈值把它改成 `used >= limit - N`，会**污染两个共享判据**：
- `hasBlockedAccount`（`:436`）→ 挂起门闸 SSOT
- `availableCount`（`:714`）→ `isPoolAvailable`（`proxyServer.ts:432`）

即**把「还剩 N 次可用」的号谎报成「已耗尽」** —— 正是 2026-08-02 / 2026-08-04 两轮 RCA 反复在治的病灶形状（判据混用 → 挂起误伤）。

→ **架构级建议**：本轮**只做二元真实额度喂入**（消灭「撞一次才知道」）；阈值提前切换作为**第二层**走独立字段/独立判据，绝不改 `isQuotaExhausted` 语义。

### C · 更优做法（建议 · 方向由主 AI/用户定）

阈值层最小正确形状：加一个与 `isQuotaExhausted` **平行且更弱**的谓词（如 `isQuotaLow(account, threshold)`），只被**择号优先级**消费（`getNextAccount` 把 low 号排到候选末尾 / SWRR 降权），**不进** `isAccountAvailable`、**不进** `hasBlockedAccount`、**不进** `availableCount`。
- 好处：低额度号仍是「可用兜底」（全池皆低时仍能服务，不会变空池挂起），但只要有健康号就不会被选中 —— 这才是用户说的「提前切」。
- 代价：`getNextAccount` 候选排序需改（当前是 `currentIndex` 单向轮询 `:252-264`），是本轮真正的设计工作量。

## 5. 真实改动范围（三处断点 + 一处缺陷，不是「加一个调用」）

1. `accountPool.ts:603 updateQuota` —— 修 `quotaResetAt` 无条件覆盖。**必须先修**，否则任何新调用点都引入「抹掉 402 自动恢复时刻」的回归。
2. 新增落盘 → 池的通知路径（**单一 owner，见下**）。
3. `activation.ts:101 toProxyAccountShared` —— 入池时映射盘上 `usage.current/limit` 进 `quotaUsed/quotaLimit`（冷启动/热切换那一刻就有额度）。⚠️ `upsertAccount`（`:200-215`）刻意剔除运行期字段，需判定 quota 属「凭据类」还是「运行期类」—— 建议归运行期（已在池的号不被入池映射覆盖，由 owner 统一喂）。
4. 阈值层（§4-C）—— **建议独立一轮**，与 1-3 解耦。

### 调用点归属判定：唯一 owner = `persistCheckResult`（落盘收口）

| 候选 | 判定 | 理由 |
|---|---|---|
| 主进程 60s tick（`index.ts:2521-2611`） | ❌ | 它是**token 刷新**调度器，`:2606` 明确注释「syncInfo=false：仅刷 token；用量/订阅信息同步由渲染进程负责，避免主进程跑重活」。在此加额度同步 = 推翻它的既定职责决策。 |
| **`persistCheckResult`（`accountService/persistCheckResult.ts:173`）** | ✅ **唯一 owner** | 文件头自证是收口：「这是 IPC 与 web 面板共用的持久化点」。所有学到新鲜额度的路径（桌面单查 `check.ts:197`、web 面板 HTTP、批量 `:412`）**已全部汇流到这里**。在收口喂池 = 一次改动覆盖全部入口，且天然只有一个写者。 |
| 代理 success 路径（`recordSuccess`） | ❌ | 手里只有 token 计数，没有账号额度（§2-A5）。要拿额度得在转发路径额外打 `getUsageLimits` —— 给热路径加外部往返，且只覆盖「正在被用的号」。 |

**双写者陷阱已规避**：若 tick 与 persist 同时调，池会有两个写者、freshness 不同、无仲裁。选 persist 收口后**写者恒为一个**（所有取数路径都先经它落盘）。

装配细节（不是障碍，但决定改动形状）：`persistCheckResult` / `persistAccountPatch` 当前**完全无池引用**（对这两文件 grep `proxyServer|accountPool` 零命中），而 `check.ts` 有（`deps.proxyServer`，类型 `types.ts:25 ProxyServerRef` 目前只暴露 `getAccountPool().getAccount()`）。喂池要么扩 `ProxyServerRef` 加 `updateQuota` 并把池引用注入 persist 层；要么在 `check.ts:197` 落盘成功后紧邻调用（仍是单点，但批量路径 `:412` 需同样处理 → 变两处，逊于前者）。**建议扩 `ProxyServerRef` + 在 persist 收口调用。**

## 6. 可执行拆分

| # | 范围 | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| P1 | `accountPool.ts:603` + `test/main/proxy/` | 修 `quotaResetAt` 无条件覆盖；补「不传 resetAt 不得抹掉既有值」红→绿用例 | 无 | ✅ | 1 |
| P2 | `accountService/types.ts:25` + `persistCheckResult.ts` + `persistAccountPatch.ts` | 扩 `ProxyServerRef`，落盘收口喂 `updateQuota`；单账号 + 批量两条路径都覆盖 | **依赖 P1** | ❌ 串行 | 1 |
| P3 | `activation.ts:101` + `upsertAccount` 边界 | 入池映射带 quota；判定 quota 属运行期字段 | 与 P2 同改可用性字段 → 串行 | ❌ | 1 |
| P4 | 阈值层（`isQuotaLow` + 择号排序 + 配置项 + 面板配置面） | 「剩余 ≤ N 提前切」 | 依赖 P1-P3 | ❌ | **独立一轮，先出决策卡** |

## 7. 风险交叉区与派发建议

- **`accountPool.ts` 是 P1/P2/P3 共同触点** → 冲突点，必须**串行**（P1 → P2 → P3），不要并行派发。
- **判据污染红线**：任何一包**不得**修改 `isQuotaExhausted` / `hasBlockedAccount` / `availableCount` 的语义。这三者是挂起门闸 SSOT，被 2026-08-02、2026-08-04 两轮 RCA 用回归用例锁死（`quotaFalsePositive429.test.ts:118`「成功不得覆盖真实额度数据」正是守这个）。
- **渲染层 `checkAndAutoSwitch`（`accounts.ts:3111`）本轮不动**：它切「active 账号」（IDE/桌面语义），池切「反代择号」，目标不同。P4 若引入池侧阈值，需明确二者是否共用一个配置值 —— **这是需用户裁决的业务问题**（同一个「剩余 N」是否既管桌面切号又管反代择号），不由 AI 定。
- 派发顺序：P1 单独先落（含回归），验证绿后派 P2，P3 随后；P4 回主 AI 出决策卡。

## 8. 领域模型对账

`accountPool.ts:174` 注释引用 `availability-paths.md §0`，但 `git ls-files` 中**该文档不存在**（`docs/domain/` 亦不存在）。→ 领域模型文档缺失但**确有需要**（可用性判定是典型 cross-cutting 中间层，已被三轮 RCA 反复触碰）。

从活代码重建的最小基线（供主 AI 决定是否落成 `docs/domain/account-pool-availability-model.md`）：

- **边界**：`AccountPool` 持运行期账号状态（内存，不持久化）；盘上 `accountData` 是另一个 SSOT，两者**目前无同步通道**（本报告病灶）。
- **可用性字段**（`accountPool.ts:178-180` 的 `AVAILABILITY_FIELDS`）：`isAvailable / suspendedAt / quotaExhaustedAt / quotaResetAt / expiresAt / refreshToken`。→ **`quotaUsed` / `quotaLimit` 不在列表里，却经 `isQuotaExhausted:418` 实际影响可用性** = 既有模型漏洞。`updateQuota` 自己包了 `notifyIfBecameAvailable` 所以行为正确，但字段清单不完整。**本轮应把这两字段补进 `AVAILABILITY_FIELDS`。**
- **不变量**：① 一次成功不得抹掉真实额度数据 / 封禁 / 真实重置时刻（`:504-509` + 回归用例）；② 429 不得标记额度耗尽（`:574`）；③ 挂起判据只认 suspended + quotaExhausted，不认 errorCount 退避（`:429-434`）。
- **状态机**（额度维度）：`正常 --402--> exhausted(quotaExhaustedAt) --到 quotaResetAt / used<limit--> 正常`。`updateQuota` 是「真实数据」入口，`recordError` 是「推断」入口 —— 当前**只有推断入口通电**。

## 9. 未覆盖清单（需跑代码或另一轮才能定）

- **未运行任何测试/构建**（只读侦察）。P1 的 `quotaResetAt` 缺陷是**读码判定**，尚未用失败用例证明 —— 属「可被一个红测试证伪」的强假设，实施时必须先红。
- 批量路径（`persistCheckResult.ts:180+` / `check.ts:412`）喂池时机未细读到行级：按切片写盘，喂池是否也按切片、会否造成 N 次 `notifyIfBecameAvailable` 广播风暴（该文件头明确警告过广播风暴形状），**需 P2 实施时确认**。
- `getUsageLimits` 返回的 `nextResetDate`（`parseUsage.ts:211` / `persistCheckResult.ts:117`）是字符串，转 `quotaResetAt`(ms) 的解析与时区语义未核。
- 上游是否在响应头给过额度信息 —— 只查源码解析，**未抓真实响应验证**。
- `src/main/index.ts` 与 `proxyServer.ts` 均按硬限制只读切片（各 ≤120 行），未通读；`onAccountUpdate`（`index.ts:641`）落地行为未展开。

---

## Update Log

### 2026-08-10 · executor(sub) · P1 落地 + 会话粘性判据补齐(§P3 遗留项)

**执行者**:sub 执行 AI。分支 `feat/hold-gate-auto-release`,worktree `.worktrees/hold-auto-release/main/`。**未 commit**(按派发约定)。

**改了两处,各一格,均先红后绿:**

1. `src/main/proxy/accountPool.ts:613` —— `quotaResetAt: resetAt` → `resetAt ?? account.quotaResetAt`。
   本报告 §A3 的读码判定**已被失败用例证实**:红态报错 `expected undefined to be 1786301134602`,
   且 `isQuotaExhausted(acc, resetAt + 1)` 为 `true`(账号过了恢复时刻仍判耗尽)。
   新增 `test/main/proxy/quotaResetAtPreserve.test.ts`(4 例:不传不得抹 / 到点必自愈 /
   显式传以上游为准 / 本无值不得凭空造)。红 2 失败 2 通过 → 绿 4/4。
   §9 未覆盖清单里「P1 尚未用失败用例证明」这一条**已结清**。

2. `src/main/proxy/proxyServer.ts:4796` `pickAccountWithAffinity` —— 可用性校验补 `isQuotaExhausted`。
   采纳 `recon-machineid-switch-sideeffect.md §P3-5` 的建议修法(补单点判据,而非在三处换号点
   各插 `invalidateSessionAffinity`)。新增 `test/main/proxy/sessionAffinityQuotaExhausted.test.ts`
   (6 例:402 耗尽不得命中 / 命中后须清条目 / 真实额度用尽同样不得命中 / 过了重置时刻须恢复命中 /
   健康号仍命中并续期 / 封禁号回归保护)。红 3 失败 3 通过 → 绿 6/6。

**验证证据(实跑,非推断):**

| 命令 | 结果 |
|---|---|
| `npx vitest run test/main/proxy/quotaResetAtPreserve.test.ts`(修前) | EXIT=1 · 2 failed / 2 passed |
| 同上(修后) | EXIT=0 · 4 passed |
| `npx vitest run test/main/proxy/sessionAffinityQuotaExhausted.test.ts`(修前) | EXIT=1 · 3 failed / 3 passed |
| 同上(修后) | EXIT=0 · 6 passed |
| `npx vitest run test/main/proxy/`(全代理套件) | **EXIT=0 · 26 文件 / 252 例全绿** |
| `npx tsc --noEmit -p tsconfig.node.json` | EXIT=0(该配置 include `src/main/**/*`,覆盖两个改动文件) |

**判据污染红线已守住**:未动 `isQuotaExhausted` / `hasBlockedAccount` / `availableCount` 的语义
(仅在粘性处**消费**已有谓词)。`quotaFalsePositive429.test.ts` 与 `holdGate*.test.ts` 全绿且未改一字。

**一处需上游修正的事实**:派发指令称「Fix 2 是 latent,因为 `isQuotaExhausted` 生产中永不为真」——
**不成立**。`recordError` 在 402 时写 `quotaExhaustedAt`(`accountPool.ts:577`),这是活的生产路径,
本报告 §A2 自己也写明「生产中唯一点亮路径」。永不为真的只是**第三条判据**(`quotaUsed >= quotaLimit`,
依赖零调用的 `updateQuota`)。→ 粘性缺判据是**当前就在发生**的缺陷,不是待 P2 落地才通电:
只要 `sessionAffinityEnabled` 开 + 客户端带固定 session id,402 换号后最长 600s 内每请求
多烧一发注定 402 的上游调用。这提升了 Fix 2 的优先级,也是它值得独立于 P2 先落的理由。

**同根因变体扫描(§5.3)**:
- `quotaResetAt` 无条件覆盖:全仓仅 `updateQuota` 一处写点(`git grep quotaResetAt -- src`),
  `recordError:578` / `recordSuccess:507` / `AVAILABILITY_FIELDS:182` 均已正确保留。无变体。
- 「校验可用性时漏 `isQuotaExhausted`」:`git grep "isSuspended(" -- src/main` 9 处命中,
  逐一核后仅 `index.ts:3472`(热切换 IPC 前置校验)是同形态 —— 它只查 suspended 不查额度耗尽,
  可能允许把已耗尽账号设为 active。**本轮未改**(不在派发范围,且语义待裁决:用户手动指定
  已耗尽账号是否该被拒?这是业务问题,非技术缺陷)。**登记给主 AI 裁决。**

**遗留**:P2(落盘收口喂 `updateQuota`)/ P3(入池映射带 quota)/ P4(阈值层)未动,依赖关系与
本报告 §6 一致。§8 建议的「`quotaUsed`/`quotaLimit` 补进 `AVAILABILITY_FIELDS`」本轮**未做**
(属 P2/P3 范围,单独改会与其它 SUB 在同文件冲突)。
