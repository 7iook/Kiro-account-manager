# 侦察报告 · 挂起门闸自动定时放行(recon-auto-release)

- **日期**:2026-08-09
- **模式**:Mode R 现状侦察(决策卡前置)
- **侦察者**:plan-reality-recon(只侦察,未改任何业务代码)
- **仓库状态**:branch `main` · HEAD `4d60c44`

---

## 1. 计划假设清单(来自主 AI 背景事实,逐条待核)

| # | 假设 | 可被现实推翻的点 |
|---|---|---|
| A1 | holdGate.ts 实现 enterHold/tryResume/releaseAll/abort + 一次性 CAS + 每请求心跳 + 绝对 deadline + maxWaitMs 兜底轮询 | 结构与语义是否如述 |
| A2 | holdConfig.ts 是 hold* 归一化唯一收口,默认值 28min/10min/keep_blocking | 默认值与 clamp 区间 |
| A3 | proxyServer.runWithHold 是挂起编排主循环;release/get/emit 在 420-470 行 | 行号与职责 |
| A4 | index.ts IPC 在 6411/6422,onHeldRequestsChanged 在 698 | 行号 |
| A5 | 桌面端有「放行」按钮(1139)与挂起数徽标(168) | 行号与徽标更新机制 |
| A6 | **HoldGate 构造时拿 config 快照 → 运行中改配置需重启反代才生效** | ⛔ 这条是本轮最重要的推翻项 |
| A7 | 手机面板无任何挂起相关端点 | 是否真无 |
| A8 | 「9 分钟内手动点一次放行就能无限续下去」 | 该前提与 08-06 RCA 的 600s 结论是否相容 |

---

## 2. 现实核实(plan vs reality)

| # | 结论 | 证据锚点 |
|---|---|---|
| A1 | **[match]** 四入口 + CAS `claimed` + `pingHandle`/`deadlineHandle` + `pollHandle` 全部如述 | `src/main/proxy/holdGate.ts:82-247`;轮询启停 `holdGate.ts:99-121`,周期 `Math.max(1000, this.config.maxWaitMs)` @ `holdGate.ts:104` |
| A2 | **[match]** `HOLD_DEFAULTS` = ping 10000 / maxWait 600000 / budget 1680000 / grace 15000 / keep_blocking | `holdConfig.ts:11-18`;clamp 区间 `holdConfig.ts:21-33`(BUDGET_MAX=21600000 6h) |
| A3 | **[match]** `runWithHold` @ `proxyServer.ts:3732`;`releaseHeldRequests` 445 / `getHeldRequestsCount` 452 / `getHoldGate` 457 / `emitHeldRequestsChanged` 462 | `proxyServer.ts:445-464` |
| A4 | **[match]** IPC `proxy-release-held-requests` @ `index.ts:6408`(return 6411)、`proxy-get-held-requests` @ `index.ts:6419`(return 6422);`onHeldRequestsChanged` @ `index.ts:698` | 同左 |
| A5 | **[match]** 放行按钮 onClick @ `ProxyPanel.tsx:1138`;`heldCount` state @ `ProxyPanel.tsx:168` | 同左 |
| **A6** | **⛔[deviation:实际是热生效,不需要重启]** HoldGate 持有的不是快照,而是**同一个持久引用对象**;`updateConfig` 用 `Object.assign(this.holdRuntimeConfig, normalizeHoldConfig(this.config))` **原地更新该引用的字段**,HoldGate 内 `this.config` 指向同一对象 → 新值对之后读取该字段的代码即时可见 | 构造 `proxyServer.ts:428-435`(注释明写「持久引用」);字段声明 `proxyServer.ts:314-315`;原地更新 `proxyServer.ts:760-767`(HOLD_KEYS 白名单 762-765);HoldGate 侧 `holdGate.ts:85` `private readonly config`(readonly 只锁引用不锁字段) |
| A7 | **[match·确认无]** `git grep "api/proxy" -- src/main/webPanel/routes.ts` 仅 status/start/stop/sync-pool/active-account 五个端点;`PanelProxyStatus` 无任何 held 字段;`src/webPanel/ui/ProxyPanel.tsx` 零命中 | `routes.ts:388-427`;`panelProxyDeps.ts:66-87`;`git grep held -- src/webPanel/` 空 |
| **A8** | **⚠️[与历史结论冲突,需主 AI 裁决]** 08-06 RCA 已把「客户端 600s 处 `stream watchdog did not recover` 直接失败、且 sub 场景不恢复」标为 🟢confirmed,并**明确撤回**了「曾成功挂起 69.5min」这一读数(仪器错误)。用户本轮的「9 分钟点一次能无限续」是**新的阳性观测**,与该 🟢 结论直接矛盾 | RCA §1.5 行 F(🟢)、§1.6 结论撤回:`F:\Kiro-account-manager\.agent-workspace\.archive\2026-08-06\hold-gate-duration-limit\hold-gate-duration-limit-rca.md` |

**A6 的两个重要副作用(决策卡必须写进去)**:
1. 新增的「自动放行间隔」配置项若走同一条 `holdRuntimeConfig` 通路,则**天然热生效,无需重启反代**;桌面端三个 hold 控件已刻意**不加** `disabled={isRunning}`(08-06 RCA §4.3 明确记录这是有意区别)。
2. **但热生效只对「之后才读该字段的代码」成立**。已经跑起来的 `setInterval` 不会因为字段变了就改周期 —— 现有 `pollHandle` 就是这个形态:周期在 `startPollingIfNeeded` 里一次性算好(`holdGate.ts:104`),之后改 `maxWaitMs` 对**已在跑的轮询无效**,要等集合清空、轮询停掉、下次 `enterHold` 重启才用新周期。**新调度器若也用 setInterval,会继承同一个「改了配置但当前那一轮不变」的半热生效语义** —— 这是必须在决策卡里显式裁决的点(接受 / 改配置时重建 timer)。

---

## 3. 链路完整性扫描(§0.16 · 主 AI `[交付契约]` 链接表权威源)

### 3.1 参照样本:`holdMaxWaitMs` 全链路(新配置项照抄这 7 个节点)

| # | 节点 | 生产者 file:line | 消费者 file:line |
|---|---|---|---|
| 1 | ProxyConfig 类型字段 | `src/main/proxy/types.ts:668`(含 666-667 注释) | `holdConfig.ts:52` |
| 2 | 渲染进程本地 config 类型 | `src/renderer/src/components/proxy/ProxyPanel.tsx:119` | 同文件 1340 |
| 3 | 界面控件(Input · 分钟单位) | `ProxyPanel.tsx:1333-1349`(id=`holdMaxWaitMin`,min1/max360,`disabled={!config.holdWhenNoAccount}`) | 用户操作 |
| 4 | IPC 出口(渲染→主) | `ProxyPanel.tsx:1345` `window.api.proxyUpdateConfig({ holdMaxWaitMs: ms })` | preload `proxyUpdateConfig` → `proxy-update-config` handler |
| 5 | 持久化(store) | `index.ts:5931` / `6059` / `6087` / `6112` / `6144` `store.set('proxyConfig', ...)` | 启动读回 `index.ts:513` + 合并 `index.ts:550` |
| 6 | 归一化收口(SSOT) | `holdConfig.ts:52-54`(clamp [10000,21600000] 且 ≤ totalBudgetMs) | `proxyServer.ts:428`(构造)/ `proxyServer.ts:766`(热更新 Object.assign) |
| 7 | HoldGate 内部消费 | `holdGate.ts:104` `Math.max(1000, this.config.maxWaitMs)` | `setInterval` 周期 |

**新增字段(建议名 `holdAutoReleaseIntervalMs` + `holdAutoReleaseEnabled`)= 上述 7 节点逐一补齐。** 第 4 节点无需改 preload(`proxyUpdateConfig` 收 `Partial<ProxyConfig>`,新字段自动透传);第 5 节点无需改(整对象落盘);**第 6 节点的 HOLD_KEYS 白名单 `proxyServer.ts:762-765` 必须加新键,漏了则热更新静默失效**(这是本链路唯一的「改 A 漏传播」陷阱点)。

### 3.2 倒计时 + 累计次数的读数链路

| # | 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|---|
| 1 | HoldGate 暴露读数 | to-build(建议 `getAutoReleaseStats(): { nextAtMs, releasedCount }`) | proxyServer | ⛔ to-build |
| 2 | ProxyServer 出口 | to-build(扩 `getHeldRequestsCount` 或新增 `getHoldStatus()`) | IPC handler | ⛔ to-build |
| 3 | IPC 返回形状 | `index.ts:6419-6427` 返回 `{ count }` | `preload/index.ts:855-857` | ✅ 存在,需扩形状 |
| 4 | preload 类型 | `src/preload/index.d.ts:798` `proxyGetHeldRequests: () => Promise<{ count: number }>` | 渲染进程 | ✅ 存在,需扩 |
| 5 | 推送事件形状 | `proxyServer.ts:80` `onHeldRequestsChanged?: (info: { count: number })` → `index.ts:699` send | `preload/index.ts:1126-1133` → `index.d.ts:896` → `ProxyPanel.tsx:448` | ✅ 存在,需扩 |
| 6 | 渲染进程展示 | `ProxyPanel.tsx:168` heldCount state / 1138 放行按钮 | 用户 | ✅ 存在,需加两个读数 |
| 7 | 手机端端点 | 无 | 无 | ⛔ 完全缺失(见 §6) |

**扩展 `proxy-get-held-requests` 返回形状的影响面 = 3 个消费点**,全部向后兼容(加字段不删 `count`):`preload/index.d.ts:798`、`preload/index.ts:855`、`ProxyPanel.tsx:451`。**扩展 `onHeldRequestsChanged` 的影响面 = 4 处**:`proxyServer.ts:80`(类型)、`447`+`463`(两个发射点,**两处都得改否则字段时有时无**)、`index.ts:699`(转发,`info` 整体透传无需改)、`preload/index.ts:1126`+`index.d.ts:896`、`ProxyPanel.tsx:448`。

**最小代价方案**:倒计时**不要**走推送。推送是**事件驱动**(挂起数变化时才发),倒计时是**连续变化量**,用推送等于要么每秒发一次 IPC(噪音),要么前端拿到的倒计时立刻过期。正确做法 = 主进程只推**绝对时间戳 `nextAutoReleaseAt`(epoch ms)**,前端本地 `setInterval` 每秒自减渲染。这样推送频率不变(仍只在挂起数变化 / 放行发生时发),倒计时精度由前端本地时钟提供。**累计次数**是低频离散量,直接搭 `onHeldRequestsChanged` 的车即可。

### 3.3 桌面端徽标现有更新机制(实测机制,非推测)

**推送 + 一次性初拉,无轮询**:
- 订阅:`ProxyPanel.tsx:448-450` `window.api.onProxyHeldRequestsChanged(info => setHeldCount(info.count))`
- 初拉:`ProxyPanel.tsx:451` `void window.api.proxyGetHeldRequests().then(r => setHeldCount(r.count))`(effect 内一次,非定时)
- 发射侧:`proxyServer.ts:447`(releaseHeldRequests 后)/ `463`(emitHeldRequestsChanged);实际触发点在 `runWithHold` 内 `proxyServer.ts:3783`(settleHold)/ `3791`(enterHold 后)/ `3793`(onAbort)
- 转发:`index.ts:698-700` `mainWindow?.webContents.send('proxy-held-requests-changed', info)`

**缺口**:`emitHeldRequestsChanged` 只在挂起数**变化**时被调。若自动放行发生但**放行后立刻又挂起**(见 §8 风险 3),count 可能 1→0→1 净零变化 —— 但因为是两次独立 emit,前端仍能收到两次事件,`releasedCount` 字段不会漏。不过若前端只看 count,用户会觉得「什么都没发生」,所以**累计次数这个读数本身就是必要的可观测性补齐**,不只是锦上添花。

---

## 4. 架构 / 前提质疑 + 业务现实性核查 + 更好方案

### 4.1 🛑 前提质疑(最高优先级 · 必须主 AI/用户裁决)

**用户本轮的观测与 08-06 RCA 的 🟢confirmed 结论直接矛盾,不能两者都对。**

- RCA 结论(🟢,有用户截图 + `proxy-request-logs.json` 阴性交叉验证):真实掐断在 **600s**,sub 场景 `stream watchdog did not recover` **直接失败不恢复**,`responseTime` 全样本无一 > 600s。
- 本轮用户观测:**9 分钟内手动放行一次即可无限续**。

若本轮观测为真,则「600s 一刀切失败」这条 🟢 需要**限定条件**:放行 = `resume` = **用新号重跑一次上游请求** → 新请求会吐**真实语义正文字节** → watchdog 计时器被真正重置。这正好解释两者差异:**ping 不重置 watchdog(RCA 已证),但 resume 后的真实正文重置它**。所以「9 分钟放行一次」不是绕过 watchdog,而是**在 watchdog 到点前塞进真实正文**。

**这个机理若成立,则本功能的成功状态必须写成**:`不是「挂起时间变长」,而是「账号挂了之后我这条消息不出现可见中断,自动在客户端超时前放行续接」`。负面条件:不得让客户端看到伪造错误、不得重复输出正文。

**同时它引出一个更省的替代方案(建议,不自行改向)**:若真正需要的只是「在 watchdog 到点前塞真实正文」,那么**自动放行(releaseAll 语义)不是唯一手段**,也不一定是最优 —— 放行会**真的重跑上游请求**,在账号仍全挂时这次重跑必然又失败又挂起(空转 + 每次消耗一次上游请求配额)。成本对比见 §4.3。

### 4.2 §0.17 业务现实性核查(逐项)

| 新建能力 | ① 真实场景 | ② 缺失影响 | ③ 现有覆盖 | ④ 判级 |
|---|---|---|---|---|
| 定时自动放行调度 | 用户跑长任务时账号全挂,人不在电脑前,无法每 9 分钟手点一次放行 | 长任务直接失败,已跑的上下文全丢 | `tryResume` 只在池**恢复**时放行;账号仍全挂时不放行 → 当前无任何机制能在 600s 前塞正文 | **A 业务必需** |
| 距下次放行倒计时 | 用户看到请求卡住,需判断「是不是死了」还是「在等下一次自动放行」 | 无法区分「系统在工作」与「系统卡死」,用户会手动中断本来能成的任务 | 现有只有挂起数徽标,无时间维度 | **B 稳定性/可观测** |
| 累计放行次数 | 用户判断自动放行是否真在跑、跑了几轮 | 自动放行静默失效时无从发现(§3.3 的净零变化盲区) | 无 | **B 稳定性/可观测** |
| 手机端同等读数 + 手动放行 | 用户人不在电脑前(这正是自动放行的动机场景),想用手机确认状态 | 只能盲等 | 手机端零挂起能力 | **C 商业/优先级排期**(与自动放行本身正交,可后置) |

无 D 级项。四项均通过四问。

### 4.3 更好方案(建议 · 不自行改向)

**方案甲(用户所提):定时 `releaseAll()`**。每 N 分钟无条件放行一次。
- 代价:每轮真的重跑一次上游请求。账号仍全挂时 → 失败 → 重新 `enterHold`。每 9 分钟消耗 1 次上游请求 + 走一遍完整重试链。
- 好处:复用现成 `releaseAll` 语义,改动最小,且**确实会吐真实正文**(若新号可用则真续接成功)。

**方案乙:定时发一次「真实正文帧」保活(不放行)**。挂起期间周期性发一个零宽字符 / 极短文本 delta,而不是 ping。
- 代价:**污染输出**(客户端会看到多余字符)、违反 08-06 RCA 明确划的边界(`ADR-0001` 边界 1/2 保持,不动 SSE 时序)、且负面条件「不得重复输出正文」被踩。
- 判定:**不建议**。

**方案丙(推荐给主 AI 评估):定时 `releaseAll()`,但在放行前先查池 —— 池可用则真放行(等价 tryResume),池仍全挂则仍放行但记一次「空转放行」**。
- 与甲的差别只在可观测性:把「有效放行」和「空转放行」分开计数,用户能看出「系统在转但号还是没好」。
- 代价与甲相同,多一个计数字段。

**语义合并问题(主 AI 明确要求判断)**:`tryResume`(池恢复即放行)与 `releaseAll`(不管池状态都放)**不应合并**。它们的代价量级差一个数量级,而这正是 RCA 2026-08-02 的病灶原型 —— 那次事故的根因就是「换号判据」与「挂起判据」被混成一个语义(`proxyServer.ts:3862` 注释明确写着这条教训)。合并后必然要加一个 boolean 参数区分,而 boolean 参数区分两个不同代价的语义 = 同一个错误的新形态。**新调度器应调 `releaseAll()`(已有,语义正确),不新增第三个放行入口。**

---

## 5. 真实修改范围

**比计划少的部分**:
- 无需为「热更新」做任何重启机制(A6 已推翻)—— 只需把新键加进 `proxyServer.ts:762-765` 的 HOLD_KEYS。
- 无需新建放行入口 —— `releaseAll()` @ `holdGate.ts:207` 语义正确可直接复用。
- 无需改 preload 的 `proxyUpdateConfig`(泛型透传)。

**比计划多的部分**:
- HOLD_KEYS 白名单(易漏,漏则热更新静默失效)。
- `onHeldRequestsChanged` 有**两个**发射点(`proxyServer.ts:447` + `463`),扩形状要两处都改。
- 倒计时需推**绝对时间戳**而非剩余毫秒(§3.2 理由)。
- 已在跑的 `setInterval` 不随配置改变周期(§2 副作用 2)—— 需显式裁决。
- 成功状态需按 §4.1 重写,并把与 08-06 RCA 的矛盾登记为待验证项。

**明确不改**:`holdGate.ts` 的 CAS/deadline/abort 语义、`decideHoldAction`(`proxyServer.ts:3946`)、SSE 时序、`tryResume` 语义。

---

## 6. 可执行拆分

| # | 工作包 | 范围(文件) | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|---|
| P1 | HoldGate 自动放行调度器 + 统计 | `src/main/proxy/holdGate.ts`、`test/main/proxy/holdGate.test.ts` | 新增可配间隔的定时 `releaseAll`;暴露 `nextAutoReleaseAt` / `autoReleasedCount`;启停随 held 集合空满(照 `startPollingIfNeeded`/`stopPollingIfIdle` 形态) | 无 | ✅ | 1 |
| P2 | 配置链路 7 节点 | `types.ts`、`holdConfig.ts`、`test/main/proxy/holdConfig.test.ts`、`proxyServer.ts:762-765` HOLD_KEYS | 新增 `holdAutoReleaseEnabled` / `holdAutoReleaseIntervalMs` 全链路 + clamp + 跨字段校验(间隔必须 < totalBudgetMs) | 无 | ✅ 与 P1 并行(共享 `HoldGateRuntimeConfig` 接口,需先约定字段名) | 1 |
| P3 | ProxyServer 出口 + IPC 形状扩展 | `proxyServer.ts:80/447/463` + 新 getter、`index.ts:6419-6427`、`preload/index.ts:855/1126`、`preload/index.d.ts:798/896` | 读数上到渲染进程 | **P1**(要 P1 的 getter 签名) | ❌ 串行于 P1 | 1 |
| P4 | 桌面端 UI | `renderer/.../ProxyPanel.tsx`(118-122 类型、168 state、1138 按钮区、1310-1349 控件区) | 两个新控件 + 倒计时(本地 1s 自减)+ 累计次数展示 | **P2 + P3** | ❌ | 1 |
| P5 | 手机面板端点 + UI | `main/webPanel/routes.ts`、`main/ipc/panelProxyDeps.ts`、`webPanel/api/panel.ts`、`webPanel/ui/ProxyPanel.tsx` | 见 §6 提案 | **P3** | ✅ 与 P4 并行(零文件重叠) | 1 |

**手机端最小改动提案(P5)**:
- **读**:不新增端点,扩 `PanelProxyStatus`(`panelProxyDeps.ts:66-87`)加 `heldCount` / `nextAutoReleaseAt` / `autoReleasedCount` 三个可选字段,`status()` @ `panelProxyDeps.ts:140-180` 填充。理由 = 面板已有 `/api/proxy/status` 单一读端点(`routes.ts:388`),前端 `refresh()` 已在拉它;加字段零新路由、零新前端拉取逻辑。
- **写**:新增 `case '/api/proxy/release-held':` @ `routes.ts:396` switch 内,走 `singleFlight('proxy-release-held', () => deps.proxyReleaseHeld())` —— 与 `proxy-start`/`proxy-stop` 同形态(`routes.ts:398-403`),手机连点天然去重。
- 前端:`webPanel/api/panel.ts` 加 `releaseHeldRequests()`(照 `stopProxy()` @ `panel.ts:269-271` 形态)+ `ProxyStatus` 接口(`panel.ts:228`)加三字段;`webPanel/ui/ProxyPanel.tsx` 加一个按钮走现成 `run()` 包装(`ProxyPanel.tsx:87-107`,已自带 busy 互斥 + 失败后重拉状态)。
- ⚠️ 注意 `routes.ts:364-378` 的既有设计纪律:**面板刻意不接受任何配置参数**(端口/模型映射/日志开关留桌面端)。故手机端**只做「看 + 手动放行」,不做「改自动放行间隔」** —— 加配置端点会破坏这条已写明的边界。

**风险交叉区**:`proxyServer.ts` 被 P2(762-765)与 P3(80/447/463 + getter)同时触碰,**但行段不重叠**(相距 300 行)。建议 P2 与 P3 由**同一个执行者串行**,或严格约定 P2 只改 HOLD_KEYS 数组、P3 不碰 762-765。`test/main/proxy/holdGate.test.ts` 只有 P1 碰。

---

## 7. 风险交叉区与派单建议

**串行链**:P1 → P3 → (P4 ∥ P5)。P2 可与 P1 并行但**必须先统一字段名**(建议主 AI 在决策卡里钉死 `holdAutoReleaseEnabled` / `holdAutoReleaseIntervalMs`,避免两个执行者各取一名)。

**并行度上限 = 2**(P1+P2 同时,然后 P3 单点瓶颈,最后 P4+P5 同时)。派 5 个 AI 并行没有收益。

**建议**:P1+P2 一轮(2 AI),P3 一轮(1 AI),P4+P5 一轮(2 AI)。

---

## 8. 历史坑与风险(git log + 三份 RCA)

**git 考古**:`holdGate.ts` 只有 1 次提交(`dab1ede` 初版),**从未被修改过** —— 三次 hold 相关 RCA 的修复全部落在 `proxyServer.ts` / `accountPool.ts` / `holdConfig.ts`,`holdGate.ts` 的编排语义至今零改动。这说明它的抽象是稳的,**也说明本轮是第一次动它,没有历史修复可参照,风险相应更高**。`holdConfig.ts` 2 次提交(`dab1ede` + `3bcf255` 上限修正)。

| # | 历史坑 | 来源 | 新功能可能怎么破坏它 |
|---|---|---|---|
| 1 | **Invariant 3:绝对 deadline 从 receivedAt 起算,跨多次挂起不重置** | `holdGate.ts:11`、`holdGate.ts:140-146`、`proxyServer.ts:3730` | **⚠️ 关键交互,但结论是「不冲突」**:自动放行走 `releaseAll` → `resume` → `runWithHold` 主循环 `continue` → 重新 `enterHold({ receivedAt: startTime })`(`proxyServer.ts:3790`,`startTime` 是循环外常量)→ deadline 仍从原 `receivedAt` 起算,**不重置**。**但这意味着自动放行不能无限续**:总预算 28min 到点后 `onTimeout` 按 `keep_blocking` 不认领(`holdGate.ts:183-187`),自动放行仍会继续 —— 因为 `keep_blocking` 下条目**留在 held 集合里**,`releaseAll` 仍能认领它。⚠️ **这是一个需要主 AI 明确裁决的语义**:预算已耗尽的请求,自动放行还该不该放?若该放,则 `holdTotalBudgetMs` 对 keep_blocking 实际上失去意义;若不该放,需在调度器里加 deadline 检查(现有 `releaseAll` 无此检查)。 |
| 2 | 一次性 CAS 认领(Invariant 2) | `holdGate.ts:154-166` | 新调度器**必须**走 `releaseAll` → `claim`,不得绕过直接调 hooks。绕过会与 abort/timeout 竞争同一条目 → 重复 resume / 已断连接上写数据。 |
| 3 | **timer 泄漏 / 空转** | `holdGate.ts:113-121`、测试 `holdGate.test.ts:411-422`(断言 `activeTimerCount()` 回到 before) | 新调度 timer 必须同样在 `claim`(`holdGate.ts:161`)与集合空时停掉。现有 `stopPollingIfIdle` 只管 `pollHandle`,**新 handle 不会被它自动清** —— 漏了就是每次挂起泄漏一个 interval。 |
| 4 | **RCA 2026-08-02**:换号判据与挂起判据混为一谈 → 正常请求被挂 600s | `proxyServer.ts:3862` 注释、`decideHoldAction` @ `3946` | 见 §4.3:**不要**把 `tryResume` 与 `releaseAll` 合并成带 boolean 的单函数,那是同一个错误的新形态。 |
| 5 | **RCA 2026-08-03 cross-region**:`recordError` 漏调则退化为「未知错误 → 挂起」 | `proxyServer.ts:3752-3757` | 自动放行使空转重试次数上升 → **漏调 recordError 的路径会被放大**(原来挂一次,现在每 N 分钟挂一次)。不改这块,但要意识到自动放行是这类缺陷的**放大器**。 |
| 6 | **RCA 2026-08-04 429-quota**:429 曾被误判额度耗尽 → `shouldHoldForNoAccount` 恒真 → 持续误伤;修复含「成功可清误标」 | `cdf71f9`、`accountPool.ts:501` | 自动放行每轮都发真实上游请求 → **若账号池仍全挂,每轮多一次 429**,可能反过来加深误标。需确认 `accountPool` 的 429 处理不会因放行频率上升而退化。**建议决策卡里把「自动放行间隔下限」clamp 得保守些(≥ 60s,建议默认 480s=8min)**,不要允许用户设成 10s。 |
| 7 | **08-06 RCA 的仪器教训**:日志无个体标识 + 终结动作是批量的 → 任何基于时间戳配对的时长结论无效 | RCA §1.6 | 自动放行会让 `releaseAll` 批量放行**更频繁**,`proxyLogger.info('HoldGate','挂起请求被放行')`(`proxyServer.ts:3786`)仍**无请求 ID** → 日志更难读。**建议顺手给挂起/放行日志加请求标识**(§4.8 顺手治类),否则下次排查会重演同一个仪器错误。 |
| 8 | 已在跑的 setInterval 不随配置改周期 | `holdGate.ts:104` 现有形态 | 用户改「自动放行间隔」后当轮不生效,会以为配置坏了。需裁决:接受(文档说明)/ 改配置时重建 timer。 |

**业界参考(tavily 实取,exa 502 不可用)**:
- `github.com/anthropics/claude-code/issues/57088` — 原文含 `Agent stalled: no progress for 600s (stream watchdog did not recover)`,与 08-06 RCA 的 🟢F 行完全一致,**独立第三方佐证 600s 阈值真实存在**。
- `github.com/anthropics/claude-code/issues/54434` — SSE 流中途停止不发 `message_stop`,客户端 `[Stall]` 遥测(`stream_idle_partial`)捕获;佐证「客户端 watchdog 认的是正文字节」。
- `github.com/anthropics/claude-code/issues/25979` — 请求客户端加 read timeout,佐证 60-120s 量级的 stall 判据。

**外部方案检索结论**:未检索到「反代侧定时放行挂起请求」的现成开源实现(这是本项目特有的账号池 + 挂起门闸组合场景)—— **必须自建**,但自建的调度器形态**应复用仓库内已有的 `startPollingIfNeeded`/`stopPollingIfIdle` 模式**(§6 P1)。

---

## 9. 测试基线

- `test/main/proxy/holdGate.test.ts`:**17 个用例**,9 个 describe(进入挂起 / 心跳 / 自动放行 / 手动放行 / 超时三态 / deadline 不重置 / 一次性认领 / abort 不泄漏 / 多请求并发隔离 / 兜底轮询)。
- **FakeClock 形态**:自建注入式类(`holdGate.test.ts:19-67`),**不用** `vi.useFakeTimers`。实现 `HoldClock` 全部 5 个方法,`advance(ms)` 按 due 顺序执行(interval 自动重排,带 100000 次死循环护栏),另有 `activeTimerCount()` 专供泄漏断言。
- **新增定时调度的测试挂点**:`holdGate.test.ts` 尾部新增 `describe('HoldGate · 定时自动放行')`,紧跟现有「兜底轮询」describe(`:388`)之后 —— 那个 describe 就是同类形态的最佳模板(`:394-409` 演示了「推进时钟 → 断言 resume 被调」,`:411-422` 演示了 timer 泄漏断言)。必测:①间隔到点即放行(池仍不可用也放,与 tryResume 区分);②累计次数递增;③集合空后 timer 归零(`activeTimerCount()` 回到 before);④与 abort 竞争时不重复 resume;⑤deadline 已过的条目行为(见 §8 风险 1 的裁决结果)。
- **实测命令与退出码**:

```
npx vitest run test/main/proxy/holdGate.test.ts test/main/proxy/holdConfig.test.ts
→ Test Files 2 passed (2) · Tests 30 passed (30) · EXITCODE=0
```

(holdGate 17 + holdConfig 13 = 30。基线绿。注:`--reporter=basic` 在本仓库 vitest v4.1.10 下不存在会直接 startup error,用默认 reporter。)

---

## 10. 领域模型对账

**不适用**。本任务不触及 `docs/domain/<subsystem>-model.md` 形态的跨切面中间层文档(仓库内 `docs/domain/` 不存在)。挂起门闸的边界/状态机/不变量的权威源是 `docs/architecture/ADR-0001-account-hold-gate.md`(08-06 RCA §6 已对其做过实测修正)。**建议主 AI 在决策卡里评估:自动放行是否构成 ADR-0001 的边界变更**(它改变了「放行的触发者」这一决策)—— 若是,ADR 需补一条 Accepted 修正块,而非只写决策卡。
