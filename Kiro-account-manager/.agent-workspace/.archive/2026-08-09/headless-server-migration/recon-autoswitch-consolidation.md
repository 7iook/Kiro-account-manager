# 侦察报告 · 自动换号决策上移主进程（Mode R · 只读侦察）

> 2026-08-10 · 仓库 `F:\Kiro-account-manager\Kiro-account-manager` · **未改任何代码** · 约 25 次工具调用内收口

## 0. 结论速览（三条，其中一条修正上游前提）

1. **数据可得性不是障碍**：`checkAndAutoSwitch` 需要的每一个输入（阈值/开关/间隔、`activeAccountId`、账号表、`lastError`、`switchTarget`、凭据、最新用量）**都已在盘上 `accountData` 里，或主进程已有等价实现**。主进程定时器现在读的就是同一个 blob（`src/main/index.ts:2549` 读 `autoRefreshEnabled`）。缺的是**决策与编排**，不是数据。
2. **下半段已经上移完毕，可复用而非新建**：`activateProxyAccount`（`src/main/proxy/activation.ts:205`）就是渲染进程 `syncActiveAccountToProxy` 那三步的主进程收口，已被局域网面板接线（`src/main/ipc/panelProxyDeps.ts:194`）。IDE 换号 `switchAccountToIde`（`src/main/accountService/switch.ts:110`）同样已在主进程且面板可达。
3. **⚠️ 修正上游侦察的措辞**：headless 下不是「自动换号完全消失」，而是**主动（阈值）换号消失，被动（额度耗尽/错误）换号仍在跑**。反代自己有一层 `autoSwitchOnQuotaExhausted`（`src/main/proxy/proxyServer.ts:1602 / 1698 / 1771 / 1822`）。但它的触发判据 `isQuotaExhausted` 只被 402/错误路径写过（`accountPool.ts:577` in `recordError`）——**把轮询到的用量喂进池的那个函数 `updateQuota`（`accountPool.ts:603`）全仓零调用方**（`git grep` 确认，且 `git status --porcelain -- src` 为空，无未跟踪文件藏调用点）。所以 headless 的真实症状是：**请求先失败一次（402）才换号，用户配的「剩 N 时换」永不生效**，且换号结果不回盘、不同步 IDE/CLI。这仍是必修项，但故障形态与「静默停止」不同，影响下面的成功状态写法。

---

## 1. 计划假设清单（可被现实推翻的）

| # | 假设 | 判定 |
|---|---|---|
| A1 | token 刷新已上移，阈值决策仍在渲染进程 | ✅ 成立（§2） |
| A2 | headless 下自动换号「静默消失、无任何错误」 | ⚠️ 部分推翻 —— 主动换号消失，被动 402 换号仍在（§0.3 / §4） |
| A3 | 阈值决策所需状态是渲染进程独有的，上移要先造数据通路 | ❌ 推翻 —— 输入全部已在盘上或已有主进程镜像（§3 表） |
| A4 | 换号结果靠渲染进程写某个共享值，反代去读 | ❌ 推翻 —— 是**三步 IPC 推送**，且顺序承重（§4） |
| A5 | 主进程没有换号编排，需要新写 | ❌ 推翻 —— `activation.ts` 已收口且面板在用（§5） |
| A6 | 上移后桌面端需要新事件通道回读结果 | ❌ 通道已存在（`applyAccountDataMutation` 广播，`accountService/state.ts:186-196`）；需接线而非新建（§7） |

## 2. 现状核实 · 两个定时器的职责对照（Q1）

**主进程定时器**：`startMainPoolTokenRefresh` → `setInterval(60_000)` at `src/main/index.ts:2619`，实现体 `runMainPoolTokenRefreshTick`（`index.ts:2521-2611`）。

**渲染进程定时器 A（换号）**：`startAutoSwitch`（`src/renderer/src/store/accounts.ts:3082`），周期 `autoSwitchInterval` 分钟，唯一动作是调 `checkAndAutoSwitch`（`:3112`）。
**渲染进程定时器 B（刷新+信息同步）**：`checkAndRefreshExpiringTokens`（`:3224`），与主进程用 `poolRefreshInFlightIds`（`index.ts:2472`）去重。

| 职责 | 主进程 | 渲染进程 | 主进程有等价物？ |
|---|---|---|---|
| 读盘取账号池 | `index.ts:2530` `store.get('accountData')` | 内存 `accounts` Map（同一 blob 的投影） | ✅ 同源 |
| 「token 快过期」判定 | `index.ts:2580` `expiresAt - now > leadMs` → skip | `:3244` `timeUntilExpiry <= refreshLeadMs` | ✅ 双份并存（去重集合兜底） |
| 封禁跳过 | `index.ts:2565` `isBannedAccountErrorMain`（`:2596` 定义，注释自称镜像渲染进程） | `:3235` `isBannedAccountError` | ✅ 已镜像 |
| 永久凭据错误指数退避 | `index.ts:2568-2575` + `permanentErrorBackoff`（`:2508`） | 无 | ➕ 主进程独有 |
| 批量刷 token | `index.ts:2610` `backgroundBatchRefreshImpl(..., syncInfo=false)` | `:3266` 起（`syncInfo` 可为 true） | ✅ 同一实现体 |
| **用量/订阅信息同步** | ❌ 显式不做 —— `index.ts:2609` 注释「syncInfo=false：仅刷 token；用量/订阅等信息同步由渲染进程定时器负责」 | `:3266` `autoRefreshSyncInfo \|\| autoSwitchEnabled` 时同步 | ⚠️ **能力已有**（`accountService/check.ts:183 checkAccountStatus` + `persistCheckResult.ts` 落盘），但主进程定时器不调 |
| **阈值决策 `remaining <= threshold`** | ❌ 无 | `:3129-3131` | ❌ 无等价（反代那层是被动判据，见 §5） |
| **候选账号筛选**（排除自己/封禁/余额也不足） | ❌ 无 | `:3136-3146` | ⚠️ `pool.getNextAvailableAccount` 判据不同（池可用性，非用量阈值） |
| 写 `activeAccountId` / `isActive` | ❌ 主进程全仓无写入点（`git grep activeAccountId -- src/main src/preload` 只命中注释与类型：`state.ts:24`、`webPanel/dto.ts:202`、`preload/index.d.ts:22`） | `:1137 setActiveAccount` | ❌ 无 |
| 换号连带换机器码 | 未核实（见 §9） | `:1161+` `machineIdConfig.autoSwitchOnAccountChange` | ❓ 未覆盖 |
| 写 IDE SSO 缓存 | ✅ `switch.ts:110 switchAccountToIde`，IPC `index.ts:4270`，面板亦可达（`webPanel/routes.ts:70`） | 经 `window.api.switchAccount`（`:3155`） | ✅ 已上移 |
| 写 CLI 凭据 | IPC `switchAccountCli`（渲染侧 `:3190` 调用） | 同左 | ✅ 主进程侧存在（细节未核实） |
| 推送给反代 | ✅ `activation.ts:205 activateProxyAccount`（面板在用） | `:4372 syncActiveAccountToProxy`（同样三步，渲染侧另写一份） | ⚠️ **两份并存 = 第二个顺序真源** |

> 注：`activation.ts:16-21` 的文件头注释已经预判了这个分叉：「局域网面板没有 renderer store，若在面板里重算一遍这三步，就会出现第二个顺序真源 —— 两处早晚分叉，而分叉的表现正是那种『绿灯但行为错』」。今天的状态是**主进程收口已建、渲染进程旧路径未迁**，属于 §7.1 意义上的「加了抽象层但老路仍在跑」。

## 3. `checkAndAutoSwitch` 的输入盘点（Q2）

实现体：`src/renderer/src/store/accounts.ts:3112-3218`。

| 输入 | 现在从哪来 | 主进程可得性 |
|---|---|---|
| `autoSwitchThreshold` | store 状态，落盘在 `accountData`（`:280` `keep(...)` 持久化，`:2457` 读回） | ✅ 直接读 `accountData`，同 `index.ts:2549` 读 `autoRefreshEnabled` 的方式 |
| `autoSwitchEnabled` / `autoSwitchInterval` | 同上 | ✅ 同上 |
| `activeAccount` = `getActiveAccount()` | 依赖 `activeAccountId`（盘上字段，`preload/index.d.ts:22`） | ✅ 字段在盘上；主进程目前只是**没有读也没有写** |
| **最新用量** `usage.current` / `usage.limit` | `await checkAccountStatus(activeAccount.id)` → 网络拉取 → 写 store（`:2013-2073`）→ 落盘 | ✅ **同名主进程实现已存在**：`accountService/check.ts:183` + `persistCheckResult.ts` 负责落盘（该文件头注释明确说落盘下沉是为了让 HTTP 面板与 IPC 共用）。`webPanel/routes.ts:309/488` 已在用，带 `singleFlight` 去重 |
| 账号表（候选筛选） | store `accounts` Map | ✅ `accountData.accounts` |
| `lastError`（封禁判定） | `isBannedAccountError(acc.lastError)` | ✅ 已镜像 `isBannedAccountErrorMain`（`index.ts:2596`） |
| `switchTarget`（ide / cli / both） | store 字段，落盘 | ✅ 盘上字段（`webPanel/dto.ts:202` 列在「顶层其他设置项」内） |
| 目标账号凭据 | `availableAccount.credentials` | ✅ `activation.ts:97 toProxyAccountShared` 已实现「凭据只从盘上现读」，且注释说明**刻意不接受调用方传入的快照**（避免被 rotate 作废的 refresh v1） |
| `switchAccount` 回流的新凭据 | `switchResult.refreshedCredentials` → 回写 store（`:3169-3188`） | ⚠️ 需确认 `switchAccountToIde` 在主进程内是否已自行落盘；渲染侧这段回写存在的理由（refreshToken rotate）在主进程同样成立 |

**结论**：渲染进程独有的输入 = **零**。唯一「独有」的是 `activeAccountId` 的**写入动作**，而它写的目标本身就是盘上字段。

## 4. 换号结果的消费者（Q3）——「渲染进程写、反代读」的假设是错的

`checkAndAutoSwitch` 命中阈值后依次做 4 件事（`:3147-3214`），**没有任何一件是「写一个共享值让反代自己去读」**：

| # | 动作 | 位置 | 消费者 |
|---|---|---|---|
| 1 | `setActiveAccount(availableAccount.id)` | `:3149` → `:1137` | **渲染进程 UI 自己** + 落盘 `activeAccountId`。反代**不读**这个字段 |
| 2 | `window.api.switchAccount({...})` （`switchTarget` 为 ide/both） | `:3155` | IPC → `index.ts:4270` → `switch.ts:110 switchAccountToIde` → 写本机 Kiro IDE 的 SSO 缓存；副作用置 `lastSwitchedAccountId`（`index.ts:4277`），供主动续期 timer 用 |
| 3 | `window.api.switchAccountCli?.({...})` （cli/both） | `:3190` | 写 CLI 凭据 |
| 4 | `syncActiveAccountToProxy(availableAccount.id)` | `:3214` → `:4372` | **反代的唯一入口，走 3 次 IPC 推送** |

第 4 步展开（`:4372-4404`），顺序承重、缺一步就「绿灯但行为不变」：
1. `proxyGetStatus()` → 没跑就 `not_running` 早退；
2. `updateProxyPoolMembers({add:[toProxyAccount(acc)]})` —— 单账号是严格模式，不在池直接 503；
3. 单账号模式（`enableMultiAccount === false`）才写 `proxyUpdateConfig({selectedAccountIds:[id]})` —— **这才是单账号模式的真开关**；多账号模式**不能写**，写了等于把轮询降级成固定单号；
4. `setActiveProxyAccount(id)` —— 动 `currentIndex` + 作废会话粘性（粘性在账号选择前短路返回旧号，600s 才过期）。

反代真正取号的地方：`proxyServer.ts:1597-1599` 在 `enableMultiAccount === false` 时读 `config.selectedAccountIds[0]`，**`currentIndex` 在这条路径上根本不被消费**（2026-07-28 RCA 的根因，`activation.ts:8-18` 完整记录）。

**Q3 答案**：反代不读渲染进程写的任何东西；换号是**推送式（IPC 三步 + 顺序约束）**，不是共享状态式。因此上移的实质是「把这条推送序列的**发起者**从渲染定时器换成主进程定时器」，而序列本身在主进程已有实现（`activateProxyAccount` 一次调用等价于上面 2-4 步，`panelProxyDeps.ts:194` 已在用）。

## 5. 重复实现 & 可复用扫描（Q4）

按能力检索（非按名字），三处命中：

**5.1 换号编排 —— 已有，可直接复用（不是新代码）**
- `src/main/proxy/activation.ts:205 activateProxyAccount(accountId, host, ctx)`，返回 `{applied:true, mode:'single'|'multi', accountId, email}` 或 `{applied:false, reason}`，不抛。
- 内部即上述三步，且比渲染版更严谨：用 `pool.upsertAccount` 而非 `addAccount`（`:225-228` 注释：后者是重置式，会「切一下账号就静默解除运行期风控封禁」）。
- 宿主注入接口 `ProxyActivationHost`（`:60-71`）已由 `panelProxyDeps.ts:makeActivationHost` 实现。
- **判定：主进程侧的换号执行层是「复用」，不是「新建」。渲染侧 `syncActiveAccountToProxy` 是应当被收敛掉的第二份。**

**5.2 阈值判定 —— 主进程有一层「形似而判据不同」的，不能直接当阈值决策用**
- `proxyServer.ts:1602`：单账号模式下 `isQuotaExhausted(account) && config.autoSwitchOnQuotaExhausted` → `getNextAvailableAccount` → 改写 `selectedAccountIds` + `onAccountUpdate`。另有 `:1698 / :1771 / :1822` 三处（多账号、重试路径）。
- 判据 `accountPool.ts:407-421 isQuotaExhausted`：`quotaExhaustedAt > 0` **或** `quotaLimit > 0 && quotaUsed >= quotaLimit`。语义是「**已经用光**」，不是「**剩 N 就换**」。
- **关键缺口**：写 `quotaUsed/quotaLimit` 的唯一函数 `accountPool.ts:603 updateQuota` **全仓零调用方**（`git grep 'updateQuota('` 仅命中定义；`git grep 'quotaUsed:'` 仅命中 `:611` 自身；`git status --porcelain -- src` 为空，排除未跟踪文件藏调用点）。于是 `isQuotaExhausted` 实际只能靠 `recordError`（`:545`，`:577` 处 `quotaExhaustedAt = now`，402 才标、429 刻意不标）触发 —— **即「先失败一次才换号」**。
- 这层换号还只改内存 `config.selectedAccountIds`，**不落盘、不同步 IDE/CLI**、不写 `activeAccountId`。
- **判定：这是被动兜底，与阈值主动决策互补而非替代。可考虑顺手接线 `updateQuota`（把 `checkAccountStatus` 拿到的用量喂进池），但那是独立的一件事，须先过 §0.17 业务校验。**

**5.3 用量拉取 + 落盘 —— 已有，可复用**
- `accountService/check.ts:183 checkAccountStatus` + `accountService/persistCheckResult.ts`（字段清单逐字段对齐渲染基线，见其文件头表格）。`webPanel/routes.ts:309/488` 已在用，配 `singleFlight(\`check:${id}\`)` 防并发。

**外部检索**：本次未做 exa 外部检索 —— 这是纯内部架构收敛（把已有主进程能力接到已有主进程定时器上），无「是否有成熟库」可谈。记为 §9 未覆盖项而非「已验证无可复用」。

## 6. 架构/前提质疑 + 业务现实校验 + 更优做法

### 6.1 🛑 前提修正（承重·必须先裁决）
上游侦察写的成功状态是「headless 下自动换号静默停止」。核实后应改为：

> **不是**「自动换号完全不工作」，**而是**「用户在设置里配的『剩余额度 ≤ N 时换号』在无渲染进程时永不触发；反代仍会在**请求已经失败**（402/额度标记）后被动换号，且那次换号只改反代内存配置，不落盘 `activeAccountId`、不同步 IDE/CLI」。
> 负条件：不得出现「面板显示自动换号已开启，而阈值分支从未被执行」。

来源标签：**消费者前置条件读码所得**（`proxyServer.ts:1602` + `accountPool.ts:407` + `updateQuota` 零调用方三条证据）。这不是 AI 推测，可独立复核。
**为何要改**：若按原措辞写规格，执行者可能去「让换号恢复工作」——而它部分在工作，容易做成第三份并存实现。

### 6.2 §0.17 业务现实校验（对本轮唯一的新建物）
本轮唯一真正的新建 = **主进程侧的阈值决策 + 定时驱动**。
- ① 真实场景：把本程序部署在无头服务器/局域网当反代网关的用户，账号池靠「剩 N 换号」保证不撞额度；此刻他根本没有桌面窗口。
- ② 缺失影响：**真实损失** —— 每次换号必须先赔一个 402 失败请求（被动路径），且换号后 IDE/CLI 与盘上 `activeAccountId` 不同步，桌面端再开时看到的是旧号。不是「接口列表不完整」类整洁性诉求。
- ③ 既有覆盖：`autoSwitchOnQuotaExhausted` 覆盖的是「已用光」，不覆盖「剩 N」；两者判据不同，不构成重复建设。执行层（`activation.ts` / `switchAccountToIde` / `checkAccountStatus`）已存在 → 复用。
- ④ 分类：**A 业务必需**。

### 6.3 更优做法建议（供主 AI / 用户裁决，侦察不自行改向）

**建议 A（推荐）：决策收口成纯函数 + 复用既有执行层，不新建执行代码。**
新增一个 `src/main/accountService/autoSwitch.ts`，只含两块：
- 纯决策函数 `decideAutoSwitch(blob, now) → {shouldSwitch, fromId, toId, reason}`：入参是盘上 blob（可 vitest 直测，无 electron 依赖，与 `activation.ts` 抽 host 接口的既有做法同构）；
- 编排 `runAutoSwitchTick()`：读盘 → `checkAccountStatus`（复用，带 `singleFlight`）→ `decideAutoSwitch` → 命中则 `applyAccountDataMutation` 写 `activeAccountId`/`isActive` → `switchAccountToIde` / CLI（按 `switchTarget`）→ `activateProxyAccount`。
挂到**已有的 60s 主定时器**（`index.ts:2619`），按 `autoSwitchInterval` 做节流计数，**不新增第二个定时器**（新定时器 = 与刷新 tick 竞态取盘的新来源）。
渲染侧 `checkAndAutoSwitch` / `syncActiveAccountToProxy` 改为**调用同一主进程入口**（IPC），删掉本地那份三步 —— 这才满足 §7.1 真解耦（移除新抽象后老路不应还能独立跑通）。

**建议 B（顺手，但须单独裁决）**：接线 `updateQuota` —— 每次 `checkAccountStatus` 成功后把 `used/limit` 喂进池，让 `isQuotaExhausted` 有主动数据源，被动兜底不再依赖「先失败一次」。这是**独立缺陷**（一个函数写好了从没被调用），可以并行，但不要塞进本轮 A 里混为一谈。

**明确不建议**：在渲染侧继续加逻辑，或在主进程重写一份三步顺序（`activation.ts:16-21` 已经用 RCA 证据钉死了「第二个顺序真源」的代价）。

## 7. 真实修改范围（Q5 爆炸半径）

**必改**
1. 新增 `src/main/accountService/autoSwitch.ts`（决策纯函数 + tick 编排）。
2. `src/main/index.ts`：在 `runMainPoolTokenRefreshTick` 附近接线（约 `:2521-2620` 区域），复用现有 timer；注意 `index.ts:2443` 那条「渲染进程定时器保留做信息同步/自动换号」的注释同步改掉，否则留下与代码矛盾的注释。
3. 新增 IPC + 面板 HTTP 入口（供两个前端触发/查询），沿 `panelProxyDeps.ts` + `webPanel/routes.ts` 既有形状。
4. `src/renderer/src/store/accounts.ts`：`checkAndAutoSwitch`（`:3112-3218`）改为薄代理调主进程；`startAutoSwitch`/`stopAutoSwitch`（`:3082/:3105`）在桌面端应**停止自带定时器**（否则两个定时器都在决策 → 双重换号 / 抢同一 refreshToken）；`syncActiveAccountToProxy`（`:4372`）收敛到 `activateProxyAccount`。

**桌面端会不会坏（Q5 正面回答）**
- UI 读的是 store 的 `activeAccountId` / `accounts`，**不是自己算的**（`:1137` 只是写这两个）。所以决策上移后 UI 只需**回读盘面**。
- 回读通道**已存在**：`applyAccountDataMutation` 写盘后广播 `{revision, changedIds, originId}`（`accountService/state.ts:186-196`），且带 `originId` 精确判自写回声、`expectedRevision` 乐观并发仲裁（`:167-174`）。主进程换号只要经这个收口写盘，桌面端就能收到 —— **不需要新建事件通道**，需要确认渲染侧是否已订阅该广播并 reload（未核实，见 §9）。
- 另有 `background-refresh-result`（`index.ts:3910/4120/4138` → `preload/index.ts:97`）是既有的「主进程算完→渲染进程持久化」回流通道，可作为形状先例，但换号结果**不应**再走「主进程算、渲染进程落盘」——那会在无渲染时又断一次。
- 真实风险点：`setActiveAccount` 里的连带副作用（换机器码 `machineIdConfig.autoSwitchOnAccountChange`，`:1161+`）在主进程侧是否有等价能力 —— **未核实**，是本轮最大的未知（§9）。

## 8. 链路完整性扫描（`[交付契约]` 权威源）

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| 定时触发（无渲染） | `src/main/index.ts:2619`（60s timer，已有） | 待建 tick | ⛔ 断：tick 不存在 |
| 阈值配置读取 | 盘上 `accountData`（`store/accounts.ts:280` 落盘） | 待建 `decideAutoSwitch` | ⛔ 断：主进程无读点 |
| 最新用量 | `src/main/accountService/check.ts:183` + `persistCheckResult.ts` | 待建 `decideAutoSwitch` | ⛔ 断：主定时器 `index.ts:2609` 显式 `syncInfo=false` |
| 阈值决策 | 现仅 `src/renderer/src/store/accounts.ts:3129` | — | ⛔ 断：无渲染即无生产者 |
| 写 `activeAccountId` | 现仅 `src/renderer/src/store/accounts.ts:1137` | UI + 盘 | ⛔ 断：主进程零写点（已 grep 确认） |
| 写盘 + 广播 | `src/main/accountService/state.ts:186-196`（已有） | 渲染侧订阅（未核实） | ⚠️ 生产者在，消费者待确认 |
| 同步 IDE | `src/main/accountService/switch.ts:110`（已有，面板可达 `webPanel/routes.ts:70`） | Kiro IDE SSO 缓存 | ✅ 完整 |
| 同步 CLI | IPC `switchAccountCli`（渲染侧 `:3190` 调用） | CLI 凭据 | ⚠️ 主进程侧存在性未逐行核实 |
| 推送反代（三步） | `src/main/proxy/activation.ts:205`（已有，`panelProxyDeps.ts:194` 在用） | `proxyServer.ts:1597` 读 `selectedAccountIds[0]` | ✅ 完整（渲染侧 `:4372` 是应收敛的第二份） |
| 被动兜底判据数据源 | `accountPool.ts:603 updateQuota` | `accountPool.ts:407 isQuotaExhausted` → `proxyServer.ts:1602` | ⛔ 断：`updateQuota` 零调用方（建议 B） |

**最终 sink**：外部 HTTP 请求实际打到了新账号（`proxyServer.ts:1597` 取号）。
**必须真跑一次的 e2e**：单元测试绿 ≠ 接通。需在**关掉渲染窗口/headless** 下，把某账号用量做到阈值以下，观察 ① 日志出现阈值分支、② 盘上 `activeAccountId` 变了、③ 下一个反代请求打到新号。**这一条只能靠运行验证，读码无法确认。**

## 9. 可执行拆分

| # | 范围 | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| P0 | 先补 §10 的三个未核实点（`switchAccountCli` 主进程侧、机器码连带副作用、渲染侧是否订阅 `accountData` 广播） | 消除规格里的假设 | 无 | 与 P1 可并行 | 1（可由主 AI 自查，20 分钟量级） |
| P1 | 新增 `src/main/accountService/autoSwitch.ts`：纯函数 `decideAutoSwitch(blob, now)` + vitest（阈值边界 / 无候选 / 全部低于阈值 / 封禁排除 / 无 active） | 决策逻辑可独立测 | 无 | ✅ | 1 |
| P2 | tick 编排 + 接线到 `index.ts:2619` 既有 timer（按 `autoSwitchInterval` 节流），复用 `checkAccountStatus` / `applyAccountDataMutation` / `switchAccountToIde` / `activateProxyAccount` | headless 下阈值换号真的会触发并落盘 | P1（消费其纯函数）、P0（机器码结论） | ❌ 串行于 P1 | 1 |
| P3 | IPC + 面板 HTTP 入口（手动触发 + 读当前状态），沿 `panelProxyDeps.ts` / `webPanel/routes.ts` 形状 | 两个前端共用同一入口 | P2 | ❌ | 1 |
| P4 | 渲染侧收敛：`checkAndAutoSwitch` 改薄代理、停掉本地 `autoSwitchTimer`、`syncActiveAccountToProxy` 收敛到 `activateProxyAccount`；补 grep gate 断言渲染侧不再有第二份三步 | 真解耦（移除新层后老路不应还能独立跑） | P3 | ❌ | 1 |
| P5（独立） | 接线 `accountPool.updateQuota`（`checkAccountStatus` 成功后喂用量进池） | 被动兜底不再依赖「先失败一次」 | 无 | ✅ 与 P1-P4 全程并行 | 1 |

**并行度实话**：主线 P1→P2→P3→P4 本质是串行（每一步的输出是下一步的前提），塞多个执行者只会在同一批文件上抢锁。**真正能并行的只有 P0 / P1 / P5 三路**，建议峰值 2-3 个执行者，不要按包数派人。

## 10. 风险交叉区 & 派发建议

**冲突点**
- `src/main/index.ts:2521-2620`：P2 会改这里，任何其他侦察线（如 electron 解耦）若也动这段 → 必须串行。
- `src/renderer/src/store/accounts.ts`：P4 改 `:1137` / `:3082` / `:3112` / `:4372` 四处，跨度大（4585 行文件），**必须独占**，不可与其他渲染侧任务并行。
- `accountPool.ts`：P5 只加调用方不改判据；若同期有人改 `isQuotaExhausted` 判据 → 串行。

**双定时器竞态（最容易被漏的一条）**：P2 上线而 P4 未做的窗口期内，**渲染定时器与主进程 tick 会同时决策换号**。两边都会走 OIDC 刷新，`poolRefreshInFlightIds`（`index.ts:2472`）只去重 token 刷新，**不去重换号编排** → 可能出现「两次换号打到不同目标」。建议 P2 落地时**同一轮就把渲染侧定时器关掉**（把 P4 的「停 timer」那一小步提前到 P2），而不是留到 P4。

**派发建议**：P0 由主 AI 自查（避免把假设写进规格）；P1+P2+（提前的停 timer）交同一个执行者一轮做完（同一心智模型，且避开竞态窗口）；P5 另派一人并行；P3/P4 待 P2 验证通过后再派。

## 11. 领域模型对账

本任务触碰横切中间层（账号池调度 / 状态机 / 持久化）。仓内**无 `docs/domain/` 目录**（`git ls-files docs/domain` 空），但已有等价物：
- `docs/architecture/ADR-0001-account-hold-gate.md`（挂起门闸）；
- `accountPool.ts:180` 引用的 `availability-paths.md §0` 列了可用性字段权威表：`isAvailable / suspendedAt / quotaExhaustedAt / quotaResetAt / expiresAt / refreshToken`（**该文档本体位置本轮未定位**，见 §12）。

**对账结论 [需补模型行]**：本轮引入的是**第三种「账号不可用/该换掉」判据**——
1. 池可用性（`isAvailable` / `suspendedAt`，运行期风控）；
2. 额度耗尽（`isQuotaExhausted`，「已用光」）；
3. **新增：阈值剩余（`limit - current <= threshold`，「快用光」）**。

三者必须写进同一张判据表并说明优先级，否则会重演 `activation.ts` 头注释里那类「两处判据分叉 → 绿灯但行为错」。**建议主 AI 在产出规格时，把这三条判据的关系落成一张表**（放进决策卡 §1 或新建 `docs/domain/account-pool-model.md`）。侦察不代产该文档。

**ADR 准入建议**：倾向 **需要** —— 「阈值决策的唯一真源在主进程、渲染进程只做展示与代理」是边界性、难回退的决定，日后必然有人问「为什么不在渲染侧算」。由主 AI 在决策卡里定。

## 12. 未覆盖清单（明确的诚实边界）

1. **`switchAccountCli` 主进程侧实现**未逐行核实（只确认渲染侧 `:3190` 在调）。若主进程侧只有 IPC handler 而无可复用业务函数，P2 需额外抽一层。
2. **换号连带换机器码**（`store/accounts.ts:1161+`，`machineIdConfig.autoSwitchOnAccountChange` / `bindMachineIdToAccount` / `changeMachineId`）在主进程是否有等价能力 —— **未核实，本轮最大未知**。若无，headless 换号会缺这一步语义，需单独一个工作包。
3. **渲染侧是否已订阅 `applyAccountDataMutation` 的广播并 reload** —— 未核实。这决定 Q5 是「接线」还是「新建订阅」。
4. **`availability-paths.md` 文档本体位置**未定位（只见 `accountPool.ts:180` 的引用）。
5. **`autoSwitchThreshold` 的量纲**未核实：`remaining = usage.limit - usage.current` 是**次数**还是**其他单位**，UI 上填的是什么。影响决策函数的边界测试。
6. **外部检索（exa/tavily）未做** —— 判断本任务是纯内部架构收敛，无外部库可比。记为未做，不记为「已验证无可复用」。
7. **`onAccountUpdate`（`index.ts:641`）在被动换号时做了什么**未读 —— 可能已有部分「反代换号 → 回流」通路，值得 P2 前扫一眼。
8. **只能靠运行验证、读码无法确认的**：headless 下阈值分支是否真被执行、换号后下一个请求是否真打到新号、双定时器窗口期是否真会双重换号。这三条必须实跑，不接受「代码看起来对」。
