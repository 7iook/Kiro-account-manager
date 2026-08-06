# ADR-0001: 账号挂起门闸(Account Hold Gate)

- **Status**: Accepted (2026-07-28 · task#3 收口接线完成,三条边界已落地并有守门员测试)
- **Date**: 2026-07-28
- **Deciders**: 反代编排层维护者
- **Related**: `.agent-workspace/.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md`(Boundary Decision Card)
- **Scope**: proxy bounded context · 请求编排层(`proxyServer.ts` 流式处理 + `accountPool` 可用性判定)

---

## Context

反向代理(`/v1/messages`)对接 Claude Code。当当前账号被后端封禁
(`TEMPORARILY_SUSPENDED` / 403)或额度耗尽(402 / 429),**且账号池里已无任何
可用账号**时,现状是:`callWithRetry` 切号循环耗尽 `maxRetries` 后 `throw lastError`,
反代把错误回给客户端 → Claude Code 收到 403/5xx,触发其自身的重试/中断,用户看到
请求失败,必须手动重发。

用户的真实诉求是:"账号刚好挂了的时候,不要中断我正在跑的这条消息 —— 让它一直
等着,我在后台几分钟内换好新账号(手动放行 或 池自动检测到新号),这条消息就用新
账号接着跑完,Claude Code 全程无感,不需要我点'继续'。"

要在协议层面实现"卡住等待、换号无缝续接",必须先确立三条**不易逆转**的架构边界。
它们不是实现细节:feature flag 只能回退运行行为(挂起 vs 报错),无法撤销这些
SSE 协议时序 / 状态语义 / 内存生命周期的决策。后续若扩展到其它客户端、或改动流式
协议形态,会重新触碰它们,故以 ADR 记录:

1. **SSE bootstrap 时序边界**:现状 `handleClaudeStream` 在调用上游**之前**就
   `writeHead(200)` + 发 `message_start`(`proxyServer.ts:3341/3383`)。一旦发了
   `message_start`,客户端就认为"响应正文已开始",此后任何切号重放都会造成语义正文
   重复。为给挂起留出窗口,必须把 `message_start` **延迟**到"确认拿到上游首字节 /
   或进入挂起态先只发 ping"之后。这改变了流式响应的 bootstrap 契约。

2. **无重放(无重复输出)原则**:切号重试**只**允许发生在"尚未向客户端写入任何
   语义正文(`message_start` 之后的 text/tool delta)"之前。`ping` / 尚未发出的
   `message_start` 不算语义正文。一旦吐了正文再挂,重放会重复输出 —— 这是业界铁律
   (CLIProxyAPIPlus PR#51:"The only safe retry/failover is before any payload
   bytes are sent to the client";"No mid-stream retries.")。此原则一旦确立,
   决定了"哪些失败可无缝续接、哪些只能优雅收尾",不可轻易反转。

3. **内存态被挂起请求的生命周期 + 绝对 deadline 预算模型**:被挂起的请求以内存态
   对象存活(心跳 timer + 每请求一次性原子认领位 + 放行/自动恢复订阅)。其总时长受
   一个**从请求接收(RECEIVED)起算、全程不重置**的绝对 deadline 硬约束
   (`holdTotalBudgetMs`,默认 28min)。所有阶段(选号 / 连上游 /
   多次重试 / 多次挂起)共享同一预算 —— 而非每次挂起各自计时。这个预算模型决定了
   资源上界与"绝不永久卡死"的保证,是内存/超时管理的地基。

   > **2026-08-06 实测修正**:本 ADR 原写"默认 28min < 客户端 30min 硬顶",该前提**已被证伪**。
   > "客户端 30min"源自误读 —— `1800000` 是客户端 429 退避时长常量,不是请求超时;
   > 请求总超时是 `API_TIMEOUT_MS`(默认 600000=10min,用户可调,实测设 30min 生效)。
   > 真正掐断挂起的是**客户端 idle watchdog**:v2.1.196 起默认开启,~5min 无语义正文
   > 即断开并自动重连(探针实测 `claude-cli/2.1.220` 掐断周期恒定 310s,ping 心跳不算
   > 正文、挡不住它)。生产日志实证曾成功挂起 **4172s(69.5min)** 后放行续接,
   > 故预算上限已从 1740000(29min)放宽到 21600000(6h)。**预算不再是瓶颈,
   > 5min 一次的 watchdog 重连才是用户可感知中断的来源。**

---

## Decision

在 proxy 编排层新增一个**账号挂起门闸(Hold Gate)**,**仅作用于流式请求**
(`request.stream=true`),受配置开关 `holdWhenNoAccount` 控制(默认 **关**,关闭时
行为逐字等同现状)。形态如下:

- **落点封装**:新增独立 `HoldGate` 类(`src/main/proxy/holdGate.ts`),持有
  `heldRequests` 集合 + 心跳 timer + 每请求原子认领位 + 放行/自动恢复逻辑。
  `proxyServer` 只在"切号循环耗尽、无可用号"这一失败汇合点调用它,不把挂起状态散落
  进流式处理主体(保持 SSOT)。

- **接受边界 1(SSE 时序)**:`message_start` 从"上游调用前"延迟到"确认首字节 / 进入
  挂起态"。挂起态先只发 `event: ping` 心跳(默认每 10s,`< 45s` 客户端 watchdog),
  对客户端表现为"仍在处理中"。`ping` 是 Anthropic SSE 协议合法事件,客户端忽略它并
  用它重置 inactivity watchdog —— 保活不是欺骗,是协议内机制。

- **接受边界 2(无重放)**:挂起 + 切号只在"未写入任何语义正文"前进行。首字节后失败
  不可无缝续接,走 SSE `error` / 优雅收尾(协议硬限制)。

- **接受边界 3(生命周期 + 预算)**:被挂起请求为内存态对象,受绝对 deadline
  (`holdTotalBudgetMs`)硬约束,全程不重置。恢复通过**每请求一次性原子认领**
  (手动放行 / 自动放行 / 超时 / abort 四入口 CAS 竞争,只有第一个认领成功者能驱动
  状态转移,其余为 no-op),杜绝同一请求被转发两次。

- **状态机**:`RECEIVED → SELECTING →(有号)FORWARDING /(无号且开关开)HELD`;
  `HELD ──认领成功──> SELECTING(新号重试)`、`HELD ──deadline 剩余不足──> TIMED_OUT`、
  `HELD ──客户端断开──> ABORTED`。`SELECTING→FORWARDING→(首字节前失败)→HELD` 可
  循环多次,但绝对 deadline 只在 RECEIVED 建立一次。

- **超时收尾策略可配**(`holdTimeoutAction`):`keep_blocking`(默认,持续发 ping 直到
  客户端自身超时 / idle watchdog 断开 —— 见边界 3 的 2026-08-06 实测修正,原写"客户端
  30min 硬顶"已证伪)/ `error`(发 SSE `error` 事件,`type=overloaded_error`)/
  `graceful_stop`(提示文本 + `message_stop` 收尾)。

- **自动恢复收口**:池"从全挂 → 出现可用号"的信号统一经 `AccountPool` 的一个出口
  `notifyAvailabilityChanged()` 发出,`HoldGate.tryResume()` 只订阅这一个出口
  (详见本 ADR 同批的 `availability-paths.md` 路径核实清单),不散挂在具体写方法上。

- **非流式请求**(`stream=false`)维持现状(报错 / 自动切号),不进入挂起 —— 无 SSE
  心跳通道,硬等风险高收益低。

- **测试触发**用测试进程内 fake / 依赖注入(mock 上游返 403 `TEMPORARILY_SUSPENDED`
  或注入预置 suspended 的 AccountPool),**不新增运行时 dev-only IPC 后门**。

---

## Alternatives Considered

### A. 立即报错(现状,维持不变)
切号循环耗尽后 `throw lastError`,反代把 403/5xx 回给 Claude Code。
- **优点**:零改动;错误语义清晰;无内存态请求驻留。
- **不选原因**:直接违背用户核心诉求 —— 账号临时挂起(几分钟内可换好新号)本可无缝
  续接,却让用户看到失败、被迫手动重发,正在跑的长任务(带 prompt cache 的多轮对话)
  中断。这是本功能存在的理由,现状即"要解决的问题"本身。**保留为默认行为**
  (开关关闭时回退到此),而非唯一行为。

### B. 客户端侧重试(依赖 Claude Code 自身重试)
不在反代挂起,靠 Claude Code 收到错误后自动重发。
- **优点**:反代零状态;复杂度低。
- **不选原因**:① 客户端重试是**全新请求**,丢失反代内的切号上下文与 prompt cache
  亲和,且客户端重试次数/间隔不可控(证据:claude-code #45224 / #37080 的重试与
  超时常量);② 用户明确要"无感、不点继续",客户端重试往往表现为可见的中断/
  报错再恢复,达不到"界面一直转圈直到成功"的体验;③ 换号时机(手动放行 / 池自动检测)
  是反代侧才知道的信息,客户端无从感知,无法"等到新号就绪再重试"。

### C. 非流式请求也挂起
把挂起门闸同时应用到 `request.stream=false` 路径。
- **优点**:行为统一,覆盖面更全。
- **不选原因**:非流式响应是单次完整 body,**没有 SSE 心跳通道**可用于保活;要在
  非流式下"卡住"只能纯 TCP 硬等,而客户端/中间代理的连接读超时通常远短于我们需要的
  换号窗口,硬等极易被中途 502/超时切断,风险高、收益低。且非流式本就是一次性
  往返,重发成本远低于流式长任务。故非流式**维持现状**,挂起门闸仅作用于流式。

---

## Consequences

### 正面
- 账号临时挂起时,流式长任务不中断,换号后无缝续接,契合用户核心体验。
- 挂起编排收口在独立 `HoldGate` 类 + `AccountPool` 单一可用性出口,SSOT 清晰,
  不污染流式主体。
- 开关默认关 + 绝对 deadline 硬顶,风险可控、可回退。

### 负面 / 代价
- 引入内存态被挂起请求 + 心跳 timer,需严格管理生命周期(abort 清理、认领幂等、
  deadline 不重置),否则有 timer/内存泄漏与重复转发风险(已用 Invariant + 原子认领
  约束)。
- `message_start` 延迟改造触及流式 bootstrap 现有时序,是本次改动的核心手术点,需
  回归护栏证明"开关关闭时逐字不变"。
- 边界收窄:仅流式、仅"未吐正文前"可续接;首字节后失败仍只能优雅收尾(协议硬限制,
  非本方案缺陷)。

### 逆转成本
- **运行行为**可通过 `holdWhenNoAccount=false` 即时回退(低成本)。
- **协议/状态边界**(SSE 时序、无重放原则、生命周期模型)一旦被其它客户端适配或
  流式协议演进依赖,反转需重新评估兼容性(高成本)—— 故以本 ADR 固化。

---

## Follow-up
- 开工前:本 ADR 保持 **Proposed**,指导实现。
- 完成后:翻 **Accepted**,并把三条边界约束句同步进 proxy 模块的 `AGENTS.md`
  (`see ADR-0001`,不复制全文)。
- A4 可用性路径全覆盖核实:见同目录 `availability-paths.md`。
