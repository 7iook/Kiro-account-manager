# RCA · HoldGate 挂起门闸误伤正常请求(卡死到客户端 600s 超时)

## 🔴 1. 现象 & Context

- 用户开启「挂起门闸」后发现:**有些正常请求也被拦截、有时会卡死**;Claude Code CLI 侧表现为 600 秒后超时。
- 配置现场(用户截图):账号池 **1/1**、**多账号轮询关**(单账号模式)、挂起门闸 **开**、放行按钮可见。
- 功能原始意图(用户原话):「在账号被封禁的时候…就直接挂着这个请求。等我换下一个账号,这期间可能是 10 分钟,也可能是 20 分钟。我有下一个账号的时候,我可以自己手动点击放行」。
- **成功状态(§0.15B · 用户视角)**:NOT «代码里加了判据»,BUT «账号被封禁时请求挂起等我手动放行;而账号只是碰上瞬时错误(限流/上游抖动)或请求本身有问题(400)时,请求立刻失败返回、不卡死»。负向条件:不再出现「正常请求被挂起到 600s 超时」。来源=用户原话。
- **现象锁**:单账号模式下,上游返回任意 pre-body 错误(含 `400 Improperly formed request`)→ 请求进入 HELD → `timeoutAction=keep_blocking` 默认不主动收尾 → 一直挂到客户端 `API_TIMEOUT_MS`(默认 600000ms)总超时。

## 🔍 1.5 假设账本

| ID | 假设 | 状态 | 证据 | 更新 |
|----|------|------|------|------|
| A | 三个 hold 接管点判据不对称:两个流式点缺 `isHoldWorthyError`,任何 pre-body 错误都能触发挂起 | 🟢 已证实 | `git grep` 定位三点:proxyServer.ts:3318(OpenAI 流式,只判 `!bodyStartSent`)、4389(Claude 流式,只判 `!messageStartSent`)、3902(JSON 非流式,**有** `isHoldWorthyError`)。单账号模式下 `pickFresh()` 因唯一号已在 `triedIds` 返 null → `waitInHold()` 无条件挂起 | 08-02 |
| B | 反代发的 SSE 心跳是注释帧 `: ping\n\n`,客户端应用层不认,故超时 | 🔴 已证伪 | `git grep sendPing` → proxyServer.ts:3988 Claude 路径**已用** Anthropic 官方协议帧 `event: ping\ndata: {"type":"ping"}\n\n`。3377 OpenAI / 3583 Gemini 用注释帧,但这两个协议本身无 ping 事件类型,注释帧是常规做法。Claude Code CLI 走 `/v1/messages` = 已经是正确帧 | 08-02 |
| C | 客户端默认超时 30s,需用户调大 `API_TIMEOUT_MS` 才能挂 10 分钟 | 🔴 部分证伪(数值错) | GitHub anthropics/claude-code#61001 原文:「`API_TIMEOUT_MS` (**default 600000 ms**) is a **total-request timeout**」。默认就是 600s = 用户观察的超时值,用户从未设过该变量。结论修正:**要挂 >10 分钟仍必须调大它**(它是总超时,ping 不重置),但「默认 30s」是错的 | 08-02 |
| D | `isHoldWorthyError` 判据过宽(含 429/5xx 瞬时错误)导致挂起 | 🟢 已证实(次要成因) | proxyServer.ts:3854 函数体含 `429 / rate limit / 500 / 502 / 503 / 504`。与 A 叠加:即使补上判据,瞬时错误仍会挂起 | 08-02 |

**结论**:根因 = **A(主)+ D(次)**,两者是同一病灶的两面 ——「换号判据」与「挂起判据」被混成一个语义。B/C 是我最初的误判,已被直接证据推翻(§0.20 CHANGE,新证据已具名)。

## 🔍 2. Root-Cause Analysis

### The Why

HoldGate 的 `pre_body_failed` 承担了**两个不同代价的语义**,但只有一个判据:

1. **换号**(便宜):试下一个未用过的号,失败也就浪费一次请求 → 判据宽一点无害
2. **挂起**(极贵):请求冻结 10~28 分钟等人工放行 → 判据必须严

`runWithHold` 主循环把两者串成一条路径:`attempt` 返回 `pre_body_failed` → `pickFresh()` → 拿不到号就**无条件** `waitInHold()`。单账号模式(池 1/1)下 `pickFresh()` 必然返回 null(唯一号已进 `triedIds`),于是**任何**能触发 `pre_body_failed` 的错误都会挂起。

而两个流式接管点连宽判据都没有:

```ts
// proxyServer.ts:3318(OpenAI 流式)· 4389(Claude 流式)
if (!bodyStartSent && onPreBodyError?.(error)) {   // 只问「吐过正文没」,不问「换号有用吗」
```

对照非流式路径(3902)是有判据的:

```ts
if (this.isHoldWorthyError(errMsg)) return 'pre_body_failed'
```

后果:`400 Improperly formed request`(请求体本身不合法,换 100 个号都是同样结果)在流式路径下会被挂起,直到客户端 `API_TIMEOUT_MS`(600s)总超时才断开 —— 用户看到的「正常请求被拦截、卡死」。

### First Broken Point

- `src/main/proxy/proxyServer.ts:3318`(OpenAI 流式接管点)—— 首个「不该进 hold 却进了」的分叉点。
- 对称缺陷:`src/main/proxy/proxyServer.ts:4389`(Claude 流式接管点)。
- 放大器:`src/main/proxy/proxyServer.ts:3813`(`runWithHold` 主循环 `if (!acc)` 无条件 `waitInHold()`)。

### Bug 类别(§5.2)

- [x] **Responsibility Boundary Violation** —— 一个判据(`isHoldWorthyError`)同时承担「换号」与「挂起」两个代价量级差 3 个数量级的决策;三个消费点对该判据的使用还不一致(2 个漏用)。


## 🕵️ 3. 变体扫描(§5.3)

**指纹**:「hold 接管点未校验『换号是否有用』」+「拿不到号即无条件挂起」。按**契约**扫描(不按符号名),锚点 = `onPreBodyError` 调用点 + `waitInHold` 调用点。

| 位置 | 风险 | 本轮修? | 说明 |
|------|------|---------|------|
| proxyServer.ts:3318 OpenAI 流式接管点 | 🔴 高 | ✅ 是 | 补 `isSwitchWorthyError` 判据 |
| proxyServer.ts:4389 Claude 流式接管点 | 🔴 高 | ✅ 是 | 补同一判据(对称化) |
| proxyServer.ts:3902 JSON 非流式接管点 | 🟢 低 | ✅ 改名 | 已有判据,仅随重命名同步 |
| proxyServer.ts:3813 `runWithHold` 主循环 `if (!acc)` | 🔴 高 | ✅ 是 | 加 `shouldHoldForNoAccount()` 门槛,这是**根因层收口**:无论哪个端点、哪条路径进来,挂起前都过同一道门 |
| Gemini 流式路径(`holdEnabledGemini` 2564) | 🟢 低 | ✅ 自动覆盖 | 复用 `runWithHold`,主循环门槛自动生效 |
| `/v1/responses` 与 Claude 非流式 | 🟢 低 | ✅ 自动覆盖 | 复用 `runJsonRequestWithHold` → `runWithHold` |

**为什么在 `runWithHold` 收口而不是逐端点补**:5 个端点各自补判据 = shotgun surgery,新增端点必然漏。挂起决策收口到主循环一处(SSOT),端点只负责「报告 pre-body 失败」。

**内部复用检索(§2 双方向)**:
- 内部:`code lookup_symbols` 查到 `accountPool.isSuspended` / `isQuotaExhausted` 已存在且语义精确匹配「真·长期不可用」→ 直接复用,新增 `hasBlockedAccount()` 只是遍历聚合,**不新造并行判据**。
- 外部:`exa` 搜 Claude Code 超时机制(query: `Claude Code API_TIMEOUT_MS reset per event streaming idle vs total timeout SSE`)→ top1 = anthropics/claude-code#61001,确认 `API_TIMEOUT_MS` 是总超时且默认 600000ms;另 #37080 / #66393 给出 `CLAUDE_ENABLE_STREAM_WATCHDOG`(默认关)/ `CLAUDE_STREAM_IDLE_TIMEOUT_MS`(默认最小 300000)两个 idle 看门狗旋钮。结论:**ping 只能防 idle 看门狗,防不了总超时**。

## 👥 4. Real-World Scenario Simulation(§5.4)

- **单账号 + 请求体不合法(主场景)**:400 Improperly formed request → 修复前挂 600s;修复后 `isSwitchWorthyError` 不命中 → 原样报错,客户端立即看到失败原因。
- **单账号 + 真封禁(核心场景不能被削弱)**:403 TEMPORARILY_SUSPENDED → `markSuspended` 已在接管点之前跑过 → `hasBlockedAccount()` = true → 照常挂起等手动放行。
- **单账号 + 上游 502 抖动**:`classifyError(502)=FATAL` → `recordError` 早返回不累加 → `hasBlockedAccount()` = false → 不挂起,报错让客户端重试。
- **网络层错误(无 HTTP 状态码)**:`fetch failed: ECONNRESET` → 连 `isSwitchWorthyError` 都不命中 → 走原有报错路径,不进 hold。
- **多账号池、部分号封禁**:池里还有健康号 → `pickFresh()` 拿得到 → 根本走不到挂起分支(修复对该路径零影响)。
- **多账号池全额度耗尽**:`hasBlockedAccount()` = true → 挂起 + `quotaResetAt` 到点由兜底轮询自动放行(既有能力保留)。
- **挂起中客户端主动断开**:`signal.abort` → `holdGate.abort()` 认领作废,不触发 resume/error(既有 Invariant 2 未改动)。
- **明确不处理**:`accountPool.recordError` 把 429 判为额度耗尽(`isQuotaError = statusCode === 402 || 429`)→ 429 仍会挂起。见 §8。

## 📚 5. Industry Reference

- **anthropics/claude-code#61001** — 「`API_TIMEOUT_MS` (default 600000 ms) is a total-request timeout. It did **not** fire on this mid-stream stall」(searched via exa: `Claude Code API_TIMEOUT_MS reset per event streaming idle vs total timeout SSE`;top1 = github.com/anthropics/claude-code/issues/61001)。**这是「600s 不是巧合、是官方默认值」的直接证据**,也据此推翻了我最初「默认 30s」的判断。
- **anthropics/claude-code#37080** — 从 minified cli.js 反出的超时常量:`uF9 = 1800000`(30min 最大操作超时)/ `mF9 = 600000`(10min fallback);并明确「Anthropic API 会发周期性 SSE ping,但没有 watchdog 检测 ping 停止时,ping 提供不了保护」→ 佐证 ping ≠ 能延长总超时。
- **anthropics/claude-code#66393** — `CLAUDE_ENABLE_STREAM_WATCHDOG`(默认关)/ `CLAUDE_STREAM_IDLE_TIMEOUT_MS`(默认且最小 300000ms)。若启用,SSE 事件(含 ping)会 kick 该看门狗 —— 这是 ping 唯一真正起作用的地方。
- **ollama/ollama#14902** — 第三方实现里「tool_call 组装期间发 ping events 避免 Claude Code 超时,this works for me on a local build」→ 佐证 ping 对 idle 类超时有效、对总超时无效。

## 🛠️ 6. Surgical Fix

**Fix Strategy**:把混在一起的两个语义拆开,并把挂起决策收口到 `runWithHold` 一处(SSOT)。

**Minimal Files Changed**:

1. `src/main/proxy/accountPool.ts` — 新增 `hasBlockedAccount(now?)`:遍历池,只认 `isSuspended(suspendedAt>0) || isQuotaExhausted(...)`,**明确不认** `errorCount` 退避冷却。这是「挂起是否合理」的权威判据(约 20 行,含 doc)。
2. `src/main/proxy/proxyServer.ts`
   - `isHoldWorthyError` → **重命名** `isSwitchWorthyError`(函数体一字未改;语义收窄为「只管换号」)
   - 新增 `shouldHoldForNoAccount()` → 委托 `accountPool.hasBlockedAccount()`
   - `runWithHold` opts 新增可选 `onNoHoldGiveUp?: () => void`(缺省回落 `onTimeoutError`,5 个调用点无需改)
   - `runWithHold` 主循环 `if (!acc)` 分支:挂起前过 `shouldHoldForNoAccount()` 门槛,不过 → `console.warn` + `onNoHoldGiveUp()` + `recordRequestFailed()` + return
   - 3318 / 4389 两个流式接管点补 `this.isSwitchWorthyError(error.message) &&`
3. `test/main/proxy/holdGateFalsePositive.test.ts` — 新增 15 个用例(311 行)

**Files Explicitly NOT Changed**(下游诱人补丁点保留):

- `holdGate.ts` —— 一行未动。它是纯编排(认领/心跳/deadline),「该不该进来」不是它的职责,在它内部加判据会污染其可测性(依赖注入设计)。
- `holdConfig.ts` 默认值 —— 不调 `maxWaitMs` / `timeoutAction`。误伤修好后,挂起时长本就该由用户按换号节奏决定。
- `accountPool.recordError` 的 `isQuotaError` 判据 —— 见 §8,影响面超出本轮范围。
- OpenAI / Gemini 的 `: ping` 注释帧 —— 这两个协议无 ping 事件类型,注释帧是常规做法(假设 B 已证伪)。

## ⚠️ 7. Blast Radius & Regression Risk

**影响面**:

- 5 个走 HoldGate 的端点(Claude 流式/非流式、OpenAI chat 流式/非流式、`/v1/responses`、Gemini 流式)全部经 `runWithHold` 主循环 → 门槛统一生效。
- **行为收窄方向安全**:改动只会让「本来会挂起的请求」变成「立即报错」,不会产生新的挂起。核心场景(封禁/额度耗尽)判据不变。
- 挂起门闸关闭时(`holdWhenNoAccount=false`,默认)完全不走这些路径 → 零影响。

**回归测试**(全部真跑,证据见 §Update Log):

- 新增 `holdGateFalsePositive.test.ts` 15 例:7 例锁 `hasBlockedAccount` 判据(含「纯 errorCount 冷却 → false」防误伤核心断言)、6 例端到端锁挂起/不挂起分界、1 例锁 429 既有契约、1 例锁完整放行链路(封禁→注入新号→自动 resume→`message_start` 恰好 1 次、正文无重复)。
- 既有 HoldGate 测试(`holdGate.test.ts` / `holdGateStreamWiring.test.ts` / `holdConfig.test.ts` / `accountPoolAvailabilityNotify.test.ts`)全部保持绿 → 无重放/无重复正文等 ADR-0001 边界未被破坏。

**消费锚点(§0.15B)**:最终 sink = 客户端行为。真实 e2e 姿态 = 用户在 Claude Code CLI 侧发一个会触发 400 的请求(或人为让唯一账号 400),**观察是否立即返回错误而非卡 600s**;以及账号被封时是否仍能挂起 + 手动放行续接。**此项待用户侧真机验证,尚未执行 → 标记 `unverified: 需用户侧真机操作`**。

### 消费链路

| 节点 | 生产者 | 消费者 |
|------|--------|--------|
| 上游 pre-body 错误 | kiroApi `callKiroApiStream` onError(existing) | 3318 / 4389 接管点(changed) |
| `pre_body_failed` 信号 | 两个流式接管点 + JSON attempt(changed) | `runWithHold` 主循环(changed) |
| 「池里有号被封禁/额度耗尽」 | `accountPool.hasBlockedAccount()`(**new**) | `shouldHoldForNoAccount()`(**new**) |
| 挂起 / 不挂起决策 | `runWithHold` 主循环(changed) | `holdGate.enterHold` 或 `onNoHoldGiveUp`(existing) |
| 放行 | UI 放行按钮 → IPC → `releaseHeldRequests`(existing) | `holdGate.releaseAll` → resume(existing) |

## 🧩 8. Boundary Reinforcement

**顺手接顶的边界**:

- 「挂起是否合理」现在有唯一权威出口 `accountPool.hasBlockedAccount()`,并在 doc 里写死不变式:**只认封禁/额度耗尽,不认 errorCount 退避冷却**。后续新增端点无需再想「要不要判」——主循环已经判了。
- 「换号判据」与「挂起判据」在命名上被强制区分(`isSwitchWorthyError` vs `shouldHoldForNoAccount`),防止后人再把两者混用。

**登记为待决策(不在本轮修)**:

- `accountPool.recordError()` 把 `statusCode === 402 || statusCode === 429` 判为 `isQuotaError` 并设 `quotaExhaustedAt`。后果:429 经 `rateLimitRetryConfig` 10 次重试(约 2 秒)后仍失败 → 账号被标额度耗尽 → 触发挂起。**若认为「2 秒 429 突发」不该挂起,需改该判据,但影响面更广**(同时影响账号可用性轮询、`getNextAccount` 的 allExhausted 分支、UI 额度显示),应单独一轮处理。本轮以测试**忠实锁定现状契约**并在测试注释里写明 rationale,不做静默改动。

**客户端侧配置(不是代码问题,但是达成用户目标的必要条件)**:

- 要让挂起真的能等 10~20 分钟,客户端 `API_TIMEOUT_MS` 必须大于挂起时长(它是**总请求超时**,SSE ping 不重置)。已在 `C:\Users\7\.claude\settings.json` 的 `env` 块设 `API_TIMEOUT_MS=1800000`(30 分钟)。反代侧 `holdMaxWaitMs` 默认 600000(10 分钟)、`holdTotalBudgetMs` 默认 1680000(28 分钟),现在客户端 30 分钟 > 服务端 28 分钟,预算关系正确。

## Update Log

- 2026-08-02 18:35 · 检索定位根因(A/D 证实,B/C 证伪),`fast_context_search` + `git grep` 双向确认三个接管点判据不对称。
- 2026-08-02 18:45 · 核心修复落地:`accountPool.hasBlockedAccount()` 新增;`isHoldWorthyError` → `isSwitchWorthyError`;`shouldHoldForNoAccount()` 新增;`runWithHold` 加门槛 + `onNoHoldGiveUp`;两个流式接管点补判据。`npm run typecheck` EXIT=0(node+web)。
- 2026-08-02 18:42 · 首轮测试 13/14,唯一失败暴露既有契约:`recordError` 把 429 判为额度耗尽。**未改生产代码去迁就测试**,而是核实 `accountPool.ts` recordError 源码后,把该用例改为忠实锁定现状 + 注释写明 rationale,并登记为 §8 待决策项。
- 2026-08-02 18:50 · 验证证据:`holdGateFalsePositive.test.ts` 15/15 绿;`test/main` 全量 **32 文件 / 254 用例全绿**;全量含 renderer **39 文件 / 294 用例全绿**;`npm run typecheck` EXIT=0。
- 2026-08-02 23:30 · 落 RCA。真机端到端验证 `unverified: 需用户侧在 Claude Code CLI 操作`。commit: pending。
