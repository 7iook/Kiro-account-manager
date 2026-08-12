# 从两个候选项目里该抄什么 —— 采纳清单

> 侦察范围：`F:\Kiro-Go-main\Kiro-Go-main`(Go · v1.1.2 · 无 .git · 真实根目录**嵌套一层**)、`F:\9router\open-sse\`(Node · 9router-app v0.5.40)。
> 两侧均**只读**，未构建、未运行。只借知识，不搬代码。
> 口径：**原样采纳 / 改造后采纳 / 我们已有 / 拒绝(理由)**。

---

## 0. 先回答最要紧的问题：挂起门闸 vs 429 耐受 —— **相邻，不是同一个，也不完全正交**

两者**意图相同**(别让用户请求失败，宁可慢)，但**触发条件互不相交、作用层级不同**：

| | 我们的挂起门闸 | Kiro-Go 的 429 耐受 |
|---|---|---|
| 层级 | **池级**(整个池没号可用) | **请求级**(当前这一个账号被限流) |
| 触发条件 | 零可用账号 —— **明确只认** `isSuspended` / `isQuotaExhausted`；`accountPool.ts:431-438` 原文：「明确**不认** errorCount 退避冷却(429 限流 / 上游 5xx 等瞬时错误触发)」 | 当前账号 429 **且无 sibling 可用**(`ratelimit_endurance.go:104-107`：有 sibling 立刻轮换、绝不等) |
| 动作 | 冻结请求 + 心跳保活 + 定时放行(`holdConfig.ts:21` `autoReleaseIntervalMs: 480000`) | 原地 sleep 后重试**同一账号**(`:118-127`) |
| 耐受时长 | 总预算 `holdTotalBudgetMs`，放行间隔 8min | 硬预算 **6 分钟**(`:69`) |

**关键**：429 在我们这里**根本进不到挂起门闸** —— 它被 `kiroApi.ts:2244-2290` 的端点内快速重试吃掉(默认 8 次 × 400ms `fast`，总耗时 ~4-6s，见 `kiroApi.ts:70-84`)，耗尽后抛 `Rate limited on <ep> after N retries` → 换下一端点 → 三端点全废才交外层。

- **不是同一个机制**：条件不相交(池空 vs 单号被限流)，一个冻结、一个重试。
- **不完全正交**：两者消耗**同一份墙上时钟预算**(客户端 `API_TIMEOUT_MS`)。同时上线必须**合并计预算**，否则「耐受 6min + 挂起 8min」会一起吃穿客户端超时。
- **结论：两个都要有**，但第二个不是照抄他们的退避曲线。**我们真实的缺口是「429 耐受总预算」这个概念本身**：他们实测 429 连续串**中位 ~388 秒**，我们单端点只扛 ~4-6 秒。

---

## 1. Kiro-Go 429 耐受(rate-limit endurance) —— 最高价值目标

**文件**：`F:\Kiro-Go-main\Kiro-Go-main\proxy\ratelimit_endurance.go`(183 行，整份就这一个机制)。

### 1.1 常量(逐字)

| 常量 | 值 | 行 | 定值理由 |
|---|---|---|---|
| `rateLimitEnduranceBudget` | `6 * time.Minute` | `:69` | 「Sized against the measured burst length (median ~388s)」—— 长到扛过典型风暴，短到请求不会无限挂 |
| `rateLimitEnduranceCap` | `20 * time.Second` | `:75` | 「with a 20s ceiling we probe at least three times a minute during a storm」 |
| `rateLimitEnduranceBase` | `1 * time.Second` | `:79` | 首个退避步长 |
| `rateLimitEnduranceFloor` | `250 * time.Millisecond` | `:145` | 「keeps a lower bound on every wait so we never busy-poll a throttled upstream」 |

前三个是 `var` 非 `const`，理由逐字：「These are variables rather than constants so tests can shrink them. A test that had to wait out the real budget would take minutes, which in practice means the behavior stops being tested at all.」

### 1.2 注释里的统计数字(逐字 —— 最贵的部分)

> With an enterprise credential shared by many people, 429 (ThrottlingException) is the dominant failure: **922 occurrences across 120 distinct minutes, peaking at 43 in a single minute.** Crucially, the bursts are LONG — a run of back-to-back 429s lasted **a median of ~388s and up to ~26 minutes** — and the upstream never sends a Retry-After header (**474/474 empty**), so there is no hint about when to come back.

> The pre-existing budget was **maxRateLimitRetries = 1 with a 500ms base backoff**, i.e. a request gave up on throttling after roughly one second. That is a reasonable policy for protecting AWS's per-account token bucket, but as a user-facing policy it is far too impatient against a burst that lasts minutes: **251 requests in the logs ended with "backing off account" and no answer.** The user then re-sent the prompt, which is exactly the "no response, just ask again" symptom — and every re-send added load to an already-throttled bucket.

### 1.3 为什么"等"是安全的 —— 三条前提(可移植性判据，非修辞)

1. 「A 429 is transient by construction. AWS's rate bucket refills; the account is healthy, has quota, and valid credentials. Nothing about the request needs to change for it to succeed later.」
2. 「Nothing has been sent to the client yet. The throttle happens before any model output, so waiting cannot duplicate or corrupt a partial answer.」
3. 「The downstream connection is already kept alive. Both streaming handlers start their SSE heartbeat BEFORE calling CallKiroAPI, so the client keeps receiving keep-alive traffic while we wait and will not time out.」

第 2、3 条我们同样成立(挂起门闸已在做心跳保活)。

### 1.4 决策树(`decideRateLimitEndurance` `:100-129`，严格此顺序)

```
1. siblingReady            → 不等，轮换   "another account is ready; rotate instead of waiting"
2. !enabled(配置开关)      → 不等，放弃   "rate-limit endurance disabled by configuration"
3. elapsed >= budget(6min) → 不等，放弃   "throttling endurance budget exhausted"
4. 有 Retry-After 且 >0    → 等 min(retryAfter, 20s)  "honoring upstream Retry-After"
5. 否则                    → 等 jitter(attempt)       "waiting for the shared credential's rate bucket to refill"
```

第 1 条理由逐字：「Spare capacity elsewhere always beats waiting: rotating serves the user now AND takes load off the throttled bucket.」
第 4 条对 Retry-After 也**夹紧到 cap**：「clamped, so a hostile or absurd value cannot park a request」—— 实测 474/474 无此头，仍按 HTTP 标准实现。

### 1.5 抖动公式(`:139-165`)

```go
window = base << min(attempt, 8)              // 1s,2s,4s,8s,16s → clamp 20s
if window <= 0 || window > cap { window = cap }
if window <= floor { return window }
delay = floor + rand.Int63n(window - floor)   // floor 之上做 FULL jitter
```

**full jitter 而非"窗口+小抖动"的理由(逐字)**：「when several people share one credential their requests are throttled at the same instant, and any narrow jitter band lets them re-synchronize and re-saturate the bucket together. Spreading each retry uniformly across the whole window decorrelates them, which is what actually lets the bucket refill.」

反面自问「WHY NOT JUST RETRY HARDER」：「Hammering a throttled bucket keeps it saturated and makes the storm last longer... The goal is to be present when capacity returns, not to poll aggressively.」

日志降噪(`:172-183`)：`attempt > 3 && attempt%5 != 0` 不打 —— 前 3 次 + 之后每 5 次，「a long storm leaves a legible trail without flooding the log」。

### 1.6 裁决：**改造后采纳(只采纳"预算"，拒绝"退避曲线")**

- **采纳**：① 请求级 429 **总预算**概念(我们现在只有**每端点** 8 次 ~4-6s，无跨端点/跨轮总预算)；② 「有 sibling 绝不等，先轮换」的优先级；③ Retry-After 夹紧上限；④ 日志降噪规则；⑤ 常量做成可调变量以便测试。
- **拒绝**：**几何退避 + 20s cap 这条曲线**。我们有**冲突的实测证据**且更贴本项目上游：`kiroApi.ts:2245-2249` 原文「429 = Kiro 后端概率式限流(不是真 QPS 上限,窗口随机开关)... 之前策略 3 次 · 2s→5s→10s(exponential)对概率窗口过慢,大部分错过窗口 → 端点全打完 → 500」，故改成 8 次 × 400ms `fast`。`accountPool.ts:569-571` 另记「实测 proxy-logs UTC 10:30-11:07 单账号 147 次 429」。Kiro-Go 的 **AWS token-bucket 模型**(退避让桶回填)与我们观察到的**随机开窗模型**(密集试探撞窗口)是两套不同的上游行为假设。未重新实测判定哪个对之前，照搬 20s 睡眠会让我们**错过开窗**，是退步。
- **落地形态建议**：保留现有 fast 密集重试作**内层**，其外加一层「总预算 + sibling 优先」的**外层耐受**(预算参照 388s 中位数，内层仍用我们的曲线)。拿他们最贵的数字(风暴有多长)，不拿他们的机制。

---

## 2. Kiro-Go 冷却分级 + 额度进入候选筛选

### 2.1 冷却分级(逐条已核实)

| 场景 | 时长 | 位置 | 备注 |
|---|---|---|---|
| 429 瞬时限流 | **15s** | `pool/account.go:323` `const rateLimitCooldown = 15 * time.Second`，由 `RecordRateLimit` `:316-320` 施加 | ✅ 与侦察一致 |
| 配额错误 | **1h** | `:299-302` `Add(time.Hour)` | ✅ 一致 |
| 账号禁用 | **24h** | `:399` `Add(24 * time.Hour)`，注释「safety net in case Reload races」 | ✅ 一致 |
| 连续 3 次错误 | **1 分钟** | `:303-306` `else if p.errorCounts[id] >= 3 { Add(time.Minute) }` | ⚠️ **侦察未提**：三振板凳只有 1 分钟 |
| 恢复 | — | `RecordSuccess` `:284-290` 同时 `delete(p.cooldowns,id)` **且** `errorCounts[id]=0` | 一次成功全清 |

**429 不计入三振**已核实。`RecordRateLimit` 注释逐字：「Unlike RecordError(id, true) — which benches the account for a full hour on the assumption its quota is exhausted — a 429 usually means the shared upstream key is being throttled by concurrent load and is still perfectly usable moments later. We apply only a short cooldown so the request rotates to another account while this one stays in circulation, and we do NOT bump errorCounts (a burst of throttles should not trip the 3-strike bench).」

**裁决：我们已有，且我们的更细。** 我们同样把 429 排除在配额判定外，理由写得更硬(`accountPool.ts:567-574`：「⚠️ 只认 402，**绝不认 429**」+ RCA 2026-08-04 + 147 次实测)。我们退避是指数(`baseCooldownMs 60000` × 至多 1440 倍 = 24h，`accountPool.ts:65-70`)，比固定三档更平滑。**不改。**

### 2.2 额度进入候选筛选 —— 侦察判断需修正

侦察说「quota 参与 `GetNext` 候选筛选(`pool/account.go:557-570`)」。实际：`:557-570` 是 `isOverUsageLimit` / `isQuotaBlocked` / `isUpstreamOverageEnabled` 三个**谓词定义处**，不是筛选点。真正调用点 **6 处**：

- `Reload():56` —— **建池时**就剔除超额号(权重展开前)
- `GetNextExcluding():118` 轮询主路径 / `:137` **兜底路径("全在冷却时返回冷却最短的")也筛**
- `GetNextForModelExcluding():236` / `:257` —— 同上两条，按模型
- `HasReadyAlternative():504` —— sibling 判定(即 §1 `siblingReady` 的来源)

`isQuotaBlocked`(`:564-566`)有两个逃生阀：**账号级**上游 Overages 开关(`OverageStatus == "ENABLED"`，大小写不敏感)或**全局** `AllowOverUsage`。

**裁决：我们已有，位置等价，不需要改。** 我们的 `isQuotaExhausted` 同样在**选择路径本身**而非只在可用性里：`accountPool.ts:323` 选号循环内、`:270` `allExhausted` 全局判定、`:277` `nonExhausted` 过滤后才取冷却最短者 —— **兜底路径同样做了额度筛选**(与他们 `:137` 等价)。唯一差异：他们在 `Reload()` **建池阶段**剔除，我们每次选号实时判。他们省 CPU 但**依赖 Reload 及时性**(自己在 `:399` 用 24h 冷却给 Reload 竞态兜底 = 承认有竞态)；我们实时判**没有这个竞态**。**这项我们更好，拒绝改造。**

---

## 3. 9router 停流看门狗(stall watchdog)

**文件**：`F:\9router\open-sse\utils\streamHandler.js` `pipeWithDisconnect` `:189`；常量 `F:\9router\open-sse\config\runtimeConfig.js`。

### 3.1 常量(已核实，侦察漏了一个)

| 常量 | 值 | 行 | 说明 |
|---|---|---|---|
| `STREAM_STALL_TIMEOUT_MS` | **360s** | `runtimeConfig.js:52` | 「Inter-chunk stall timeout (once tokens are flowing). Generous headroom so slow reasoning models aren't aborted mid-stream.」env 可覆盖 |
| `STREAM_FIRST_CHUNK_TIMEOUT_MS` | **200s** | `runtimeConfig.js:55` | ⚠️ **侦察未提**：他们**也有**首字节超时，且值与我们完全相同 |
| `FETCH_CONNECT_TIMEOUT_MS` | 60s | `:58` | 响应头都没回来就掐 |

`envMs()`(`:34-40`)只接受**正整数**，否则回落默认值 —— 防 `KIRO_...=0` 把看门狗静默关掉。

### 3.2 "看原始上游字节而非 transform 输出" —— 已确认，理由逐字

`streamHandler.js:175-181`：

> Stall watchdog tracks raw upstream byte activity, not transform output. Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE output for long stretches while partial EventStream frames keep arriving. **Measuring stall on the transform output caused false stalls and the "failed to pipe response" error in Next.**

**为什么重要**：Kiro 上游是 AWS EventStream 二进制帧。thinking 模型可能持续送**不足以解出一个完整 SSE 事件**的部分帧 —— 上游明明活着，transform 出口却零输出。测出口 = 误杀正在思考的请求。他们的实现是在 `pipeThrough(transformStream)` **之前**插一个 `upstreamTap` TransformStream(`:229-245`)，每个 chunk `armStall()` 重置计时器，`flush()` 里 `clearStall()`。

另一处值得抄的细节(`:215-227`)：他们用 `wrappedController` 包住原 controller，**让 complete/error/disconnect/abort 四条终止路径都 `clearStall()`**，注释逐字：「Without this, abort/cancel/downstream-error paths leave the timer armed and a stale abort could fire after the request has already ended.」

### 3.3 裁决：**我们已有，且已经等价**

`src/main/proxy/streamWatchdog.ts:83` `STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs('KIRO_STREAM_FIRST_CHUNK_TIMEOUT_MS', 200_000)`、`:89` `STREAM_STALL_TIMEOUT_MS = envMs('KIRO_STREAM_STALL_TIMEOUT_MS', 360_000)` —— **两个常量的值与 9router 逐一相同**(200s / 360s)，且我们也是双阈值结构、也 env 可覆盖。我们额外有 fail-open 降级(`:142-150`、`:249-270`：看门狗自身出错就放弃看守而不是掐流)，这是他们没有的。

- **不改常量**。两个独立项目在不同代码基上收敛到同样的 200s/360s，是对这两个值的独立交叉验证，不是巧合 —— 值得记进设计文档作为定值依据。
- **tap 位置已核实(与 9router 一致，没中招)**：`kiroApi.ts:2722` `wrapStreamWithStallDetection(body, onStallAbort)` 包的是 `body` 即 `response.body` **原始字节流**(`streamWatchdog.ts:129` 参数文档逐字：「上游原始字节流(kiroApi 里即 `response.body`)」)，返回的 `guardedBody` 才在 `:2724` `.getReader()` 进入 EventStream 解帧。**看门狗在解析之前，测的是原始上游字节** —— 与 9router 的 `upstreamTap` 插在 `pipeThrough(transformStream)` 之前完全同构。thinking 模型送部分帧时不会被误杀。

---

## 4. 9router 错误规则顺序缺陷 —— 反面教材 + 我方同形排查

### 4.1 缺陷已确认

`F:\9router\open-sse\config\errorConfig.js`：

- `:52` 注释自陈顺序：「Checked top-to-bottom: **text rules first (by order), then status rules.**」
- `:66` `{ text: "quota exceeded", backoff: true }` —— 文本规则区
- `:72` `{ status: 402, cooldownMs: COOLDOWN.long }` —— 状态规则区，**在其后**
- 执行处 `services/accountFallback.js:28-46`：单个 `for (const rule of ERROR_RULES)` 循环，**同一次迭代内先试 `rule.text` 再试 `rule.status`**。因为 text 规则整块排在数组前面，**任一 text 命中就 return，status 规则永远轮不到**。

**后果**：一个 402 且 body 含 "quota exceeded" 的响应，走 `backoff: true` → `getQuotaCooldown()` 指数退避(`BACKOFF_CONFIG` `:33-37`：base 2000ms、max **5 分钟**、maxLevel 15)，而**不是**本该给它的 `COOLDOWN.long` = **2 分钟**固定冷却(`:45-48`)。方向还搞反了：真正额度耗尽应该**冷却更久**，结果第一次只退 2s(比 2min 短得多)，反复撞多次后又涨到 5min。等于额度耗尽的账号被当成瞬时限流处理。

同类还有 `{ text: "rate limit" }` / `"too many requests"` / `"capacity"` / `"overloaded"` 都在 status 前 —— 文本一律 pre-empt 状态码。

**根因**：把「文本更具体所以优先」当成了通则。实际上**状态码是上游的结构化断言，文本是非结构化附带信息**；用文本盖状态码就是拿弱证据覆盖强证据。

### 4.2 我方同形排查：**没有中招，且已被 RCA 加固过**

我们的分类是 `accountPool.ts:39-56` `classifyError(statusCode, reason)` —— **入参就是状态码**，纯 switch on status，`reason` 只在 400 内部做细分(`:46-51`)。**没有任何文本规则能 pre-empt 状态码** —— 结构上不可能，因为文本从不参与顶层判定。

用户提到的 `/(\d{3})/` 事故已修复。`accountPool.ts:18-37` 的 `extractHttpStatusCode` 现在只认**带锚点的位置**：

```ts
message.match(/\b(?:API|Auth) error (\d{3})\b/)
  || message.match(/\bstatus(?:Code)?\s*[=:]\s*(\d{3})\b/i)
  || message.match(/\bHTTP\/?\s*(\d{3})\b/i)
```

注释逐字记着三个原始误报：`Connect Timeout Error (... kiro.dev:443 ...)` → 抓成 443；`Payload size: 402913 bytes` → 抓成 402 → 判额度耗尽 → `hasBlockedAccount` → HoldGate 挂起(账号其实完全正常)；`read ECONNRESET errno -4077` → 抓成 407。提不到就返回 `undefined`，调用方按 RECOVERABLE 兜底。

`pool/account.go:352-372` 的 `hasStatusToken` 是同一个教训的 Go 版：要求状态码两侧非数字边界，「so "401" matches "HTTP 401 from ..." but not "request_401abc"」。**两个项目独立踩过同一个坑** —— 这是"裸三位数正则"这个失败家族的第三份证据。

### 4.3 裁决：**拒绝采纳(反面教材)，但采纳其教训作为不变量**

- **拒绝** 9router 的 `ERROR_RULES` 文本优先设计。
- **采纳为架构不变量**：错误分类必须 **status-first**，文本只做同一状态码内的细分，且状态码提取必须带锚点。建议按 Globalrules §4.9 Layer 1 落成一条 grep 闸门 —— 禁止 `src/main/proxy/**` 出现无锚点的 `\d{3}` 状态码提取。这条我们已经用注释守着(`accountPool.ts:18-37`)，注释是最弱的一层；这个坑已经真实伤过我们一次，值得升级成闸门。

---

## 5. 未覆盖 / 待核实(诚实清单)

1. ~~我们的 `upstreamTap` 插在 transform 之前还是之后~~ —— **已核实、已结案**，见 §3.3：`kiroApi.ts:2722` 包的是原始 `response.body`，与 9router 同构。
2. **`proxyServer.ts` 的 `isSwitchWorthyError()` / `runWithHold()` 时序** —— 未读。§0 的结论建立在 `kiroApi.ts:2244-2290`(端点内重试)+ `accountPool.ts:431-438`(429 不计入挂起条件)两处硬证据上，这两处已足以判定"429 进不到挂起门闸"。但**"端点内重试耗尽 → 换端点 → 三端点全废 → 外层轮换账号"的完整链路末端未逐行核实**；`isTransientNetworkError`(`kiroApi.ts:2081-2085`)确认 `rate limited` 判为可重试，说明会走整链重试，与结论一致、不冲突。
3. **一次 429 是否会抬高我们后续错误的指数退避基数** —— Kiro-Go 明确让 429 走独立的固定 15s 短板凳、不碰 `errorCounts`。我们是否让 429 进了 `errorCount` 序列(从而抬高后续所有错误的退避)未核实。若进了，值得按他们的做法拆开。
4. **Kiro-Go `proxy/account_failover.go` 与 `no_response_test.go`** —— 未读。前者是轮换编排，后者名字直指"无响应"，可能还藏着与挂起门闸对位的机制。
5. 9router 的 `BACKOFF_CONFIG.maxLevel = 15` / `MAX_RATE_LIMIT_COOLDOWN_MS = 30min`(「codex resets_at can be 5-6h」故硬夹到 30min)—— 记录在案，未做我方对照。

---

## 汇总裁决表

| # | 项 | 裁决 |
|---|---|---|
| 1 | 429 耐受 —— **总预算概念** + sibling 优先 + Retry-After 夹紧 + 日志降噪 | **改造后采纳** |
| 1b | 429 耐受 —— 几何退避 1s→20s 曲线 | **拒绝**(与我方"随机开窗"实测模型冲突，照搬会错过开窗) |
| 2a | 冷却分级 15s/1h/24h/1min + 429 不计三振 | **我们已有**(且指数退避更平滑) |
| 2b | 额度进入候选筛选(含兜底路径) | **我们已有**(且实时判无 Reload 竞态，优于其建池期剔除) |
| 3 | 停流看门狗 200s/360s 双阈值 + 看原始上游字节 | **我们已有**(常量逐一相同 = 独立交叉验证；tap 位置已核实同构) |
| 3b | 四条终止路径统一 `clearStall()` | **值得对照**(防陈旧 abort 迟发) |
| 4 | 文本规则优先于状态码 | **拒绝**(反面教材)；采纳其教训升级为 grep 闸门 |
