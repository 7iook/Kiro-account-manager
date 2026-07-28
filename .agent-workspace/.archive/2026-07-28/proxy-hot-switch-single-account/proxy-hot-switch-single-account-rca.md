# 反代运行中切换账号不生效(单账号模式)· RCA

> 分类:🐛 Bug flow · Artifact: RCA(§5.8 八段)· 关联决策卡 `.archive/2026-07-23/hot-swap-accounts/`

---

### 🔴 1. Phenomenon & Context

- **复现步骤**:反代服务运行中 → 账号管理页点账号卡/列表行的电源图标「切换到此账号」→ 前端 active 高亮切到 B → 继续用客户端发请求 → 请求仍打在 A 上(A 继续扣额度)。停止服务 → 切账号 → 重新启动服务,才真正走 B。
- **现象锁定(单一可证伪命题)**:`反代运行中,通过账号管理页把 active 账号从 A 切到 B 后,下一次进入反代的请求所使用的账号仍是 A`。
- **成功状态(§0.16 · 来源:用户原话「a 账号额度用完了,我想要切到 b 账号」+「不用停止服务」)**:
  - **NOT** 「store 里 activeAccountId 变成 B / IPC 返回 success」,**BUT** 「用户在账号管理页点一下切到 B,不停服务,下一个经过反代的请求就由 B 的凭据出站」。
  - **不该发生**:切换后请求 503(「Selected account not found in pool」)· 切换后第二个请求又漂回 A · 切换后仍用池里 B 的过期 accessToken。
- **适用边界**:本轮只治**单账号模式**(`enableMultiAccount=false`)。多账号模式用户已确认可用分组热编辑覆盖,不在本轮范围(见 §8)。

### 🔍 1.5 Hypothesis Ledger

| ID | 假设 | 状态 | 证伪/确认证据 | 更新 |
|----|------|------|------|------|
| A | 账号管理页的切换动作从未调用任何反代 IPC | 🟢 confirmed | `git grep switchProxyActiveAccount\|setActiveProxyAccount` 全仓唯一生产 caller = `ProxyPanel.tsx:1802`;`AccountCard.tsx:262-294` / `AccountListRow.tsx:186-218` 只调 `switchAccount`(写 IDE token 文件)+ `switchAccountCli` + `setActiveAccount(id)`(渲染进程 store),零反代调用 | 07-28 |
| B | `proxyUpdateConfig` 改不到运行中的实例 | 🔴 falsified | `initProxyServer()` 是单例(`index.ts:388` `if (proxyServer) return proxyServer`);`getAvailableAccount` 每请求实时读 `this.config.selectedAccountIds`(`proxyServer.ts:1507-1509`) | 07-28 |
| C | `setActiveAccount`(热切换 IPC 的实体)在单账号模式下会生效 | 🔴 falsified | 它只改 `accountPool.currentIndex`(`accountPool.ts:127-134`),而 `currentIndex` 只被 `getNextAccount` 消费(`accountPool.ts:153`),`getNextAccount` 只在 `enableMultiAccount` 分支被调用;单账号分支走 `config.selectedAccountIds[0]`(`proxyServer.ts:1507`)。⇒ 该 IPC 在单账号模式**语义空转** | 07-28 |
| D | 会话粘性短路旧账号 | 🟡 pending(条件成立即触发) | `pickAccountWithAffinity` 在选择逻辑**之前**返回(`proxyServer.ts:1459-1472`),只校验 suspended/isAvailable,**不校验配额耗尽、不校验是否仍是 selected 账号**,条目 600s 才过期;实例重建(stop→start)才整表丢弃。需 `sessionAffinityEnabled=true`;该字段无默认值(`proxyServer.ts:335-349` 默认表无此项)⇒ 仅用户手工开启时命中 | 07-28 |
| E | 多账号 round-robin 下热切换只活一次 | 🟢 confirmed | `recordSuccess` 在非 sticky 策略下 `currentIndex = (successIndex+1) % len`(`accountPool.ts:361`) | 07-28 |
| F | 「停止→切→启动」之所以生效是因为重启重建了账号池 | 🟢 confirmed | `handleStart` 首行 `await syncAccounts()`(`ProxyPanel.tsx:344`)→ `proxy-sync-accounts` → `pool.clear()+addAccount` 全量重建 + 新 ProxyServer 会话粘性表为空;热切换路径两者都不做 | 07-28 |

自查:🟢 = A / E / F(A 是本轮要治的根因,E/F 是解释现象的旁证),🔴 = B / C,🟡 = D(条件性,§8 一并加固)。

### 🔍 2. Root-Cause Analysis

- **The Why**:2026-07-23 `96a62ca` 交付的「账号池热切换」只在**反代面板自己的账号选择弹窗**接了线,而该弹窗只在 `!config.enableMultiAccount` 时渲染(`ProxyPanel.tsx:1084`)。用户真实的切换入口是**账号管理页**,那条链路的职责停在「写 Kiro IDE / CLI 凭据 + 更新渲染进程 UI 态」,从未把「当前该用哪个账号」这个事实传播到反代进程。决策卡 §5F 明文列了这个接线点(`[ ] 单账号模式在 AccountCard 加"切换到此"按钮(仅反代运行时显示)`),Update Log 却写「决策卡遗留未做项全部关闭」——实际只关了多账号 group chip 一项。11/11 单测全绿,因为它们只断言 `accountPool.setActiveAccount` 之后 `currentIndex` 的值(模块内部),没有任何门断言「账号管理页切换 → 反代跟随」(E-091 母题:门的方向对不准交付物)。
- **First Broken Point**:`src/renderer/src/components/accounts/AccountCard.tsx:294`(以及镜像实现 `AccountListRow.tsx:218`)——`setActiveAccount(account.id)` 之后链路终止,无反代传播。
- **Bug class**:`[x] Responsibility Boundary Violation`(切换动作缺少向反代传播的收口点)

### 🕵️ 3. Variant Scan (§5.3)

- **重复实现审查(先于动手)**:
  - 内部:`git grep -E "switchProxyActiveAccount|setActiveProxyAccount|updateProxyPoolMembers|proxySyncAccounts"` → store action `switchProxyActiveAccount`/`syncPoolMembersToProxy`(`store/accounts.ts:3443/3457`)与 preload API 均**已存在**,IPC `proxy-set-active-account`/`proxy-update-pool-members` 已注册(`index.ts:3221/3263`)⇒ **复用,不新建 IPC**。
  - 内部:「Account → ProxyAccount 字段映射」已存在一份内联实现(`ProxyPanel.tsx:301-322`,含 accessToken/refreshToken/profileArn/clientId/clientSecret/region/authMethod/provider/tokenEndpoint/issuerUrl/scopes/machineId/groupId/weight 共 15 字段)⇒ 本轮新增第二个消费者,按 §4.3 SSOT 抽共享 mapper,禁止复制内联(否则未来加字段必漏一处 = E-055 三收口母题)。
  - 外部:`exa` 搜索 —— 本缺陷是本仓自有接线遗漏,无外部可复用件;见 §5。
- **指纹**:「产生『当前该用哪个账号』这一事实的动作,没有把它传播到消费该事实的进程」
- **变体表**:

| 位置 | 风险 | 本轮修? | 说明 |
|---|---|---|---|
| `AccountCard.tsx:294` | 🔴 用户主路径 | ✅ | 卡片视图切换 |
| `AccountListRow.tsx:218` | 🔴 用户主路径 | ✅ | 列表视图切换(镜像实现,同一契约) |
| `store/accounts.ts:2255` 额度耗尽自动切换 | 🔴 同契约 | ✅ | 只切 IDE/CLI,反代不知情——与手动切换同一根因 |
| `ProxyPanel.tsx:1797-1802` | 🟢 已接 | 改为调收口函数 | 消除「更新 config + 热切换」的第二份实现 |
| `AccountCard.tsx:313` / `AccountListRow.tsx:247` 注销 | 🟡 | ❌ 不改 | 注销后 store active=null,反代该用谁属独立语义决策,不在本轮 |
| `ProxyPanel.tsx:301-322` 字段映射 | 🟡 重复实现 | ✅ 抽收口 | 见上,SSOT |
| `App.tsx:36-43` 托盘「切换到下一个账号」 | 🟡 同指纹 | ❌ deferred | `switchToNextAccount` 只 `setActiveAccount`,**连 Kiro IDE 凭据都不写**(更上游的既存缺陷)。只补反代传播会造出「反代切了、IDE 没切」的新不一致。登记 `ARCHITECTURE.md` 技术债,独立一轮修(需先定「托盘切换是否等价于账号页切换」的语义) |

### 👥 4. Real-World Scenario Simulation (§5.4)

1. **池里 B 的凭据是启动时的旧值**(主要场景)。账号页切换会走 OIDC 刷新拿到 `access_v2/refresh_v2`,旧 `refresh_v1` 已被服务端 rotate 作废;反代池里仍是启动快照 ⇒ B 到期刷新 401 → 单账号严格模式直接 503。防御:收口 action 必须**从 `get().accounts.get(accountId)` 现读**(切换成功分支已把 `refreshedCredentials` 回写 store · `AccountCard.tsx:265-285`),**禁用 caller 传入的 account 对象**(组件 prop 是渲染时快照)。
2. **切到一个不在反代池里的账号**(次要边界)。单账号模式 `syncAccounts` 推送全部 `status==='active'` 账号,B 通常已在池;仅当 B 在启动之后才导入、或曾被标 error 被过滤时才命中。此时单账号是**严格模式**:`selectedAccountIds[0]` 不在池 → 拒绝 fallback、`account=null` → 503(`proxyServer.ts:1521-1526`)。防御:先入池再写 `selectedAccountIds`,顺序不可颠倒。
2b. **入池不得洗掉运行期封禁标记**。`addAccount` 是重置式(`accountPool.ts:82-105`:按不含 `suspendedAt` 的 mapper 重算 `isAvailable=true`,并清零 errorCount/accountStats)⇒ 无条件 add 会静默解除风控封禁,还让 `index.ts:3234-3236` 的 `ACCOUNT_NOT_AVAILABLE` 守卫永不触发(add 先跑)。防御:add 分支改为「已在池 → `updateAccount` 只覆盖传入字段」。
3. **反代未运行时点切换** → 两个 IPC 均返回 `PROXY_NOT_RUNNING`,收口函数必须视为正常 no-op,禁止向用户弹错(切 IDE 本身是成功的)。
4. **连点两次 / 快速来回切 A→B→A**(幂等 + 反抖)→ `addAccount`/`setActiveAccount` 均幂等;写 `selectedAccountIds` 是覆盖语义,最后一次赢;无中间态残留。
5. **切换与「额度耗尽自动切换」并发**:`proxyServer.ts:1515/1679/1718` 会在内存里改写 `config.selectedAccountIds`,前端后到的写覆盖它 —— 语义正确(用户显式意图优先)。
6. **已知未处理**:多账号模式下「钉住某个账号」仍无能力(`currentIndex` 会被 `recordSuccess` 冲掉)—— 用户已确认走分组热编辑替代,本轮显式不做(§8)。

### 📚 5. Industry Reference

- `exa.web_search_exa` query: `Electron main process account pool hot swap active account renderer switch not taking effect until restart` → top 命中 **realiti4/claude-swap issue #37「Hot-reload credentials without restarting Claude Code」**(https://github.com/realiti4/claude-swap/issues/37 · closed)。该 issue 的 Root cause 与本缺陷**同一母题**:「消费方在启动时读取凭据并缓存在内存里,切号工具只重写了磁盘上的凭据存储,活着的进程继续用旧 token 直到重启」。它给的三条解法(SIGHUP 通知 / 文件监听 / 本地 IPC 通道)中,本仓已有第三条的基础设施(`proxy-set-active-account` / `proxy-update-pool-members` IPC),缺的只是**生产者侧的调用**——印证修法方向是「补通知,不是加缓存过期」。
- 次相关命中:`tinyhumansai/openhuman#2047`(把 `activeAccountId` 当 ephemeral UI 态而非持久账号态)—— 反向佐证:`activeAccountId` 是 UI 态,「反代该用谁」必须显式传播,不能靠共享持久化状态隐式对齐。
- 内部权威参照(更相关):全局 error-journal `E-052`(造好没接:测试绿只证模块自己对,不证生产主链真调它;判据 = `git grep` 真实 caller)· `E-091`(接线类交付把 mutation 打在被测模块内部而非生产装配点 → 逻辑有门、交付物无门)· `E-095`(调了新来源但结果没流到下游)。本 RCA 的 §3 变体表与 §7 消费锚点即按这三条的判据组织。

### 🛠️ 6. Surgical Fix

**策略**:在渲染进程建立唯一收口点,把「active 账号变更」这一事实传播到反代;主进程侧让热切换语义完整(顺带失效会话粘性)。

- **新增** `src/renderer/src/store/accounts.ts`:
  - `toProxyAccount(acc)` 共享 mapper(唯一字段映射真源)。
  - `syncActiveAccountToProxy(accountId)` 收口 action,顺序固定。**凭据取值硬约束**:只从 `get().accounts.get(accountId)` 现读,禁接受 caller 传入的 account 对象(§4.1)。
    1. `proxyGetStatus()` → 未运行则 no-op 返回 `{applied:false, reason:'not_running'}`；
    2. `updateProxyPoolMembers({ add:[toProxyAccount(acc)] })`(刷新池内凭据 + 兜住不在池的边界)；
    3. 单账号模式(`!cfg.enableMultiAccount`)→ `proxyUpdateConfig({ selectedAccountIds:[accountId] })`；
    4. `setActiveProxyAccount(accountId)`(指针 + 清会话粘性)。
- **改** `AccountCard.tsx` / `AccountListRow.tsx`:切换成功后调收口 action(失败只记日志,不阻塞 IDE 切换结果)。
- **改** `store/accounts.ts` 自动切换分支(2255 附近):同调收口 action。
- **改** `ProxyPanel.tsx`:`AccountSelectDialog.onSelect` 改走收口 action(消除第二份实现);`syncAccounts` 的内联映射改用 `toProxyAccount`。
- **改** `src/main/index.ts` 的 `proxy-update-pool-members` **add 分支**:已在池 → `pool.updateAccount(id, 传入字段)` 只覆盖凭据(保留 `suspendedAt`/`isAvailable`/errorCount/统计);不在池 → `addAccount`。这是决策卡声称的「add 幂等(已存在 update 不重复)」与实现的偏离,同轮修正(§4.2b)。
- **改**(class-B 加固,不计入本轮主目标验收)`src/main/proxy/proxyServer.ts`:新增 `invalidateSessionAffinity()`;`proxy-set-active-account` 成功分支调用它(显式换账号后旧会话不得继续粘旧账号 · 消除 §1.5 假设 D)。

**明确不改**:`getAvailableAccount` 的选择逻辑 · `accountPool.getNextAccount`/`recordSuccess` 指针语义 · 单账号严格模式的「不 fallback」行为(它是 v1.6.x 刻意设计,掩盖问题的反面)。

### ⚠️ 7. Blast Radius & Regression Risk

- **影响面**:渲染进程 store(新增 1 mapper + 1 action)· 2 个账号视图组件 · ProxyPanel(改为复用收口)· 主进程 `proxy-update-pool-members` add 分支 + `proxy-set-active-account` 成功分支 + ProxyServer 1 个新方法。不触碰 Kiro API 出站逻辑 / 认证 / 存储 schema。
- **持久化副作用**:`proxyUpdateConfig({selectedAccountIds})` 会写入 `store('proxyConfig')`(`index.ts:7206-7208`)⇒ 下次应用自启动也会选中 B。与用户「切到 B」的意图一致,属期望行为,显式记录。
- **显示侧**:`ProxyPanel.tsx:242-245` 的本地 `selectedAccountId` 在面板已打开时短暂滞留 A,`onProxyResponse → fetchStatus`(`ProxyPanel.tsx:445`)与 mount 时的 `fetchStatus` 会纠正;瞬态显示问题,不影响出站账号,不额外加事件推送。
- **消费锚点(§0.16)**:最终 sink = 反代出站请求实际使用的账号凭据(`proxyServer.getAvailableAccount` 的返回值)。**真跑一次的 e2e 姿势**:单账号模式启动反代 → 客户端发一次请求(日志记 A)→ 账号页切到 B(不停服务)→ 再发一次请求 → 反代请求日志/统计的账号 email 必须是 B。单测绿不算达标。
- **链路表**:

| 节点 | producer | consumer |
|---|---|---|
| active 账号变更事实 | `AccountCard.tsx:294` / `AccountListRow.tsx:218` / `store:2255`(待改) | `syncActiveAccountToProxy`(待建) |
| 账号入池 + 凭据刷新 | `syncActiveAccountToProxy`(待建) | `index.ts:3263` `proxy-update-pool-members`(existing) |
| 单账号选定 | `syncActiveAccountToProxy`(待建) | `proxyServer.ts:1507-1509`(existing) |
| 指针 + 粘性失效 | `index.ts:3221` `proxy-set-active-account`(existing, 需补 invalidate) | `accountPool.ts:153` / `proxyServer.ts:1459`(existing) |

- **回归测试**:
  - 失败用例(红):`syncActiveAccountToProxy 在单账号模式下必须先入池再写 selectedAccountIds`(断言调用顺序与入参)· `反代未运行时 no-op 且不抛错`· `多账号模式下不写 selectedAccountIds`。
  - 主进程:`proxy-set-active-account 成功后,原会话粘性不再命中旧账号`。
  - 既有守护:`test/main/hotSwapAccounts.test.ts` 11 例 + `test/main/architecture/*` fitness gate 必须保持绿。
- **回归护栏**:`AccountCard.tsx` / `AccountListRow.tsx` 中**每个 `switchAccount` 返回 success 的分支**都应能 grep 到收口 action 调用(接线判据,非仅测试绿)。注销分支(`AccountCard.tsx:313` / `AccountListRow.tsx:247`)也调 `setActiveAccount(null)`,不在护栏范围内,避免假红。

### 🧩 8. Boundary Reinforcement

- 顺带补齐的边界:`proxy-set-active-account` 原先只动指针,**显式换账号时不失效会话粘性**——这会让开启 sessionAffinity 的用户即使接线正确也仍需重启(假设 D)。本轮把「换账号 ⇒ 旧粘性作废」补成热切换语义的一部分。
- **显式不做**:多账号模式的 `pinnedAccountId`(优先级高于轮询、`recordSuccess` 不得冲掉)。用户已确认多账号场景用分组热编辑覆盖。若后续需要,单独一轮:`AccountPool` 加 `pinnedAccountId` + `getNextAccount` 优先返回 + `recordSuccess` 跳过指针推进。归档指针:本 RCA §8。


---

## Update Log

- **2026-07-28 13:35 · reviewer(claude-opus-5,独立只读复核)· status=NEEDS_CHANGES · critical=0 / important=3 / minor=5 · ready_to_merge=WITH_FIXES**
  - 已独立核实通过:根因 A(`git grep switchProxyActiveAccount` 全仓唯一生产 caller = `ProxyPanel.tsx:1802`;`AccountCard.tsx:294` / `AccountListRow.tsx:218` 链路终止;主进程 `switch-account`(`index.ts:5387`)/`switch-account-cli`(5504)全程不触碰 `proxyServer`)· B 证伪(`index.ts:389` 单例 → `index.ts:7171` `server.updateConfig` → `proxyServer.ts:663-676` 纯 merge 无白名单 → 1507-1509 每请求实时读)· C 证伪(`accountPool.ts:127-134` 仅改 `currentIndex`+`swrr.reset`;`currentIndex` 仅被 153/359-362 消费,`getNextAccount` 仅在 `enableMultiAccount` 分支调用)· D 条件成立(`proxyServer.ts:1459-1472` 粘性先于选择返回且不校验 selected;默认表 334-349 无 `sessionAffinityEnabled`)· E(`accountPool.ts:359/362`)· §2 对上一轮决策卡的指控属实(决策卡:72 未做项 vs Update Log:89「全部关闭」)· §5 外部 issue 真实存在且根因描述准确(已 crawl 验证)· §6 第 3 步可行(全部 30+ `proxyUpdateConfig` 调用均为 partial,无整份 config 覆盖回归)。
  - **Important-1**:§6 强制顺序的未分析副作用 —— `accountPool.addAccount`(`accountPool.ts:81-105`)会重置 `requestCount/errorCount/lastUsed` + 清零 `accountStats` + 按入参重算 `isAvailable`;而 `toProxyAccount` 的字段源(`ProxyPanel.tsx:301-322`)不含 `suspendedAt/suspendReason` ⇒ 每次切换会清掉目标账号的运行期 suspended 标记与会话统计,并使 `index.ts:3234-3236` 的 `ACCOUNT_NOT_AVAILABLE` 守卫失效(add 先跑已清标记)。修法:已在池则走 `pool.updateAccount` 只覆盖凭据,或 mapper 透传 suspend 字段。
  - **Important-2**:§3 变体表漏「托盘切换账户」入口 —— `index.ts:2509` `tray-switch-account` → `App.tsx:36-43 switchToNextAccount` → 仅 `setActiveAccount(id)`,同契约、同根因(该入口另有既存缺陷:连 IDE 凭据都不写)。
  - **Important-3**:§6 未规定凭据取值时机 —— `AccountCard.tsx:265-285` 是 `setState` 异步回写刷新后的 access/refresh;收口 action 必须读 `get().accounts` 的刷新后值,若用组件捕获的 `account` prop 会把已被 rotate 作废的 refreshToken v1 灌进池,导致 B 到期刷新 401 → 单账号严格模式 `account=null` → 503(`proxyServer.ts:2505`)。
  - Minor:§7 链路表缺 ProxyPanel 显示侧消费者(`ProxyPanel.tsx:242-245` 本地 `selectedAccountId` 会滞留在 A)· §7 回归护栏 grep 会误命中注销分支(`AccountCard.tsx:313`/`AccountListRow.tsx:247`)· §4.1 理由略夸大(单账号模式 `syncAccounts` 推送全部 active 账号,B 通常已在池,add 的真实价值是 §4.2 凭据新鲜度)· `invalidateSessionAffinity` 对本轮目标非必需(粘性默认关)属 class-B 加固,应标注可延后 · 未提 `proxyUpdateConfig` 会把 `selectedAccountIds` 持久化进 `store('proxyConfig')`(`index.ts:7206-7208`),影响下次自启动选账号。
  - e2e 验收姿势可执行(锚点:`kiroApi.ts:1571` `[KiroAPI][DIAG] Route plan | account=<email>`、1665 `[Perf] acc=`;`RequestLog.accountId`(`types.ts:685-698`)不含 email,建议写清用哪条日志断言)。
  - one_line:根因判定与 B/C 证伪均独立复核成立、修法方向正确且可行,但 add 覆盖语义的副作用、托盘切换变体、凭据取值时机三处需在动手前补齐。

---

## Update Log

- **2026-07-28 落盘**(动手前 RCA · 工作树无本轮实现)。
- **2026-07-28 单轮工件评审(reviewer sub · 异构模型 · 只读)** → `NEEDS_CHANGES` · critical=0 / important=3 / minor=5。逐条三步过筛处置:

| 意见 | 处置 | 依据 |
|---|---|---|
| I-1 `add` 走 `addAccount` 是重置式:清零 accountStats/errorCount,且 mapper 不含 `suspendedAt` ⇒ 每次切换静默解除运行期封禁,并让 `index.ts:3234-3236` 的 `ACCOUNT_NOT_AVAILABLE` 守卫永不触发 | 🟢 **采纳** | 核实成立(`accountPool.ts:82-105` `isAvailable: !suspended`,suspended 由 `account.suspendedAt` 推;`ProxyPanel.tsx:301-322` mapper 无该字段)。**修法按 §5.1 往上游修**:`proxy-update-pool-members` 的 add 分支改为「已在池 → `pool.updateAccount(id, 传入字段)` 只覆盖凭据;不在池 → `addAccount`」。这同时修正决策卡自己声称的「add 幂等(已存在 update 不重复)」与实现的偏离(同一交付的契约漂移,§4.8 同轮扫类) |
| I-2 §3 漏「托盘切换账户」入口(`App.tsx:36-43` `switchToNextAccount` 仅 `setActiveAccount`) | 🟡 **deferred + 登记** | 同指纹成立,但该入口另有既存更上游缺陷:**它连 Kiro IDE 凭据都不写**。只给它补反代传播会造出「反代切了、IDE 没切」的新不一致 —— 比现状更坏。登记进 §3 变体表 + `ARCHITECTURE.md` 技术债,独立一轮修(需先定「托盘切换是否等价于账号页切换」的语义) |
| I-3 §6 未规定收口 action 的凭据取值时机,若用组件捕获的 `account` prop 会把已 rotate 作废的 refreshToken v1 灌进池 → B 到期刷新 401 → 单账号严格模式 503 | 🟢 **采纳** | 核实:`AccountCard.tsx:265-285` 切换成功后**确实**把 `refreshedCredentials` 回写 store(`useAccountsStore.setState`),但组件的 `account` prop 是渲染时快照。§6 补硬约束「收口 action 只从 `get().accounts.get(accountId)` 取凭据,禁用 caller 传入的 account 对象」+ 红灯测试断言入池入参的 refreshToken 是刷新后的值 |
| m① §7 缺 ProxyPanel 显示侧消费者(`ProxyPanel.tsx:242-245` 本地 `selectedAccountId` 滞留 A) | 🟡 采纳为注记,不加事件推送 | `ProxyPanel.tsx:445` `onProxyResponse(() => fetchStatus())` + mount 时 `fetchStatus()` 已存在 ⇒ 面板打开后任一反代响应即刷新,滞留是瞬态显示,不影响出站账号。加事件推送属 over-engineering |
| m② §7 回归护栏 grep 会误命中注销分支必假红 | 🟢 采纳 | 护栏判据改为「切换成功分支(`switchAccount` 返回 success 之后)」,排除 `AccountCard.tsx:313` / `AccountListRow.tsx:247` 注销分支 |
| m③ §4.1 理由夸大(单账号模式 `syncAccounts` 推送全部 active 账号,B 通常已在池) | 🟢 采纳 | §4.1 措辞改为:`add` 的**主要**价值是凭据新鲜度(I-3),兜「不在池」只是次要边界(B 在启动后才导入 / 曾被标 error 被过滤时才命中) |
| m④ `invalidateSessionAffinity` 对本轮目标非必需(粘性默认关),建议标 class-B 可延后 | 🟡 **HOLD · 本轮仍做,降级标注** | 依据:用户症状原文是「除非停止服务再启动」;若他恰好开了 sessionAffinity,只补接线仍需重启 = 没根治(§1.5 假设 D)。成本 3 行、语义上「显式换账号 ⇒ 旧粘性作废」本就属热切换契约的一部分。在 §8 标为 class-B 加固,不计入本轮主目标验收 |
| m⑤ 未提 `proxyUpdateConfig` 会把 `selectedAccountIds` 持久化到 `store('proxyConfig')`(`index.ts:7206-7208`) | 🟢 采纳 | 写进 §7 影响面:副作用是下次自启动也会选中 B —— 与用户「切到 B」的意图一致,属期望行为,但需显式记录 |

- **2026-07-28 §6/§7 已按上述采纳项就地覆写正文**(正文=当前真相,不与本表并存)。

- **2026-07-28 实施完成(主 AI 直接实施 · executor sub 被服务限流)**

  改动清单:
  - `src/main/proxy/accountPool.ts` 新增 `upsertAccount(account): 'added' | 'updated'`(已在池只覆盖凭据类字段,剔除 `isAvailable`/`suspendedAt`/`suspendReason`/`suspendMessage`/`requestCount`/`errorCount`/`lastUsed`)
  - `src/main/index.ts` `proxy-update-pool-members` 的 add 分支 → `pool.upsertAccount(acc)`;`proxy-set-active-account` 成功分支 → `proxyServer.invalidateSessionAffinity()` + 日志
  - `src/main/proxy/proxyServer.ts` 新增 `invalidateSessionAffinity(accountId?): number`
  - `src/renderer/src/store/accounts.ts` 新增 `ProxyAccountPayload` 类型 + `toProxyAccount(acc)` 共享 mapper(SSOT)+ `syncActiveAccountToProxy(accountId)` 收口 action;额度耗尽自动切换分支接线
  - `src/renderer/src/components/accounts/AccountCard.tsx:298` / `AccountListRow.tsx:221` 切换成功分支接线
  - `src/renderer/src/components/proxy/ProxyPanel.tsx` `onSelect` 改走收口(消除第二份实现)+ `syncAccounts` 内联映射改用 `toProxyAccount`(删 22 行重复)

  新增测试:
  - `test/main/hotSwapUpsert.test.ts`(4 例):不在池等价 add / 已在池只覆盖凭据 / 保留 `suspendedAt`+`isAvailable=false` 不静默解封 / 保留 errorCount·requestCount·lastUsed·统计
  - `test/main/proxy/sessionAffinityInvalidate.test.ts`(3 例):清全部 / 按账号清 / 无匹配返回 0
  - `test/renderer/proxy-hot-switch/syncActiveAccountToProxy.test.ts`(5 例):未运行 no-op / 单账号模式调用顺序(add → selectedAccountIds → setActive)/ 入池入参取自 store 现值 / 多账号模式不写 selectedAccountIds / 无凭据 no-op

  验证读数(原始退出码):
  - 红灯:`npx vitest run <本轮 2 文件>` → `EXIT=1`,`2 failed / 9 tests failed`,失败原因 `upsertAccount is not a function` / `syncActiveAccountToProxy is not a function`(因功能缺失而红,非语法错)
  - 绿灯:`npx vitest run <本轮 3 文件>` → `EXIT=0`,`Test Files 3 passed / Tests 12 passed`
  - 全量:`npm test` → `Test Files 1 failed | 25 passed`,`Tests 1 failed | 167 passed`。唯一失败 = `test/main/proxy/holdGate.test.ts`,**与本轮无关**:`holdGate.ts` + `holdGate.test.ts` 均为工作区**未跟踪的在途新文件**(`git status` 显示 `??`),其 import 只有 `@main/proxy/holdGate`,与本轮改动文件集零交集
  - `npm run typecheck:node` → `EXIT=0`;`npm run typecheck:web` → `EXIT=0`(首跑 `EXIT=2`,两个错误:ProxyPanel 未使用的旧 action 引用 + mapper 返回类型过宽,已分别改为收口 action 引用与 `ProxyAccountPayload`)
  - 接线判据(E-052):`git grep syncActiveAccountToProxy -- src` → 4 个生产 caller(`AccountCard.tsx:298` / `AccountListRow.tsx:221` / `ProxyPanel.tsx:1778` / `store/accounts.ts:2381`),非仅定义与测试
  - 变体再扫(§5.6):`git grep "setActiveAccount(" -- src/renderer` 剩余 3 处均已定性 —— `App.tsx:42` 托盘入口(deferred,见 §3)+ 两处 `setActiveAccount(null)` 注销(§3 明确不在范围)

  **未验证**:§7 声明的 e2e(真实账号发两次请求比对日志 `account=`)需用户在真机执行 —— 单测只证收口 action 的契约,不证达标(§4.6 / E-036)。
