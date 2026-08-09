# 决策卡 · 反代上下文防护网三层增强（proxy-context-safety-net）

> 一份决策卡覆盖三层增强，因为它们同源、同接线区、同 fail-open 契约，拆三份反而丢关联。
> **v2**（2026-08-09）· 经 codex artifact-decision-card 单轮评审后修订，处置详见 §Update Log。

## 🏗️ 1. Boundary Decisions

### Success State（§0.15B · MANDATORY · sourced）

**NOT** 反代层监测到 stall / body 超限 / tool_result 巨大就已达标，
**BUT** 客户端（Claude Code / Codex / Cursor）经反代跑真实 SUB 任务时，遇到下列三类事件都能**在合理时间内收到可识别、可续行的信号**——不再出现 1h50m 死等或"任务完成一半反代 400 端到端失败"：

1. **长会话累积历史撑爆上游 2MB body 上限** → 反代**发送前主动前置一次**丢历史并插占位说明，客户端不知情、任务继续
2. **单次历史 tool_result 单条 50KB+** → 反代**发送前主动智能压**（保留结构性锚点如 hunk 头、行号），且**只压历史、不压当前 tool_result**（保用户当前消息完整性）
3. **上游 SSE 中间停发**（Anthropic SDK #867 死等场景） → 反代**主动 abort** 上游连接并向下游发明确 SSE error 事件，客户端立即知道并可重试

**Must NOT happen**：
- 静默改写用户 currentMessage（Layer B 严格限于 history · 见 A2 修订）
- 因反代主动 abort 导致本可正常返回的响应被误杀（idle threshold 留足推理模型头部）
- 三层任一异常导致 payload 部分改写后发送（**I6 原子性**保证：改动仅在副本上，异常时副本被抛弃）
- 三层任一异常阻断整个请求（fail-open 各自独立，失败即视为 no-op）

### 目标 → 来源 → 客户端可识别信号 → 负向条件（F1 采纳 · 逐项映射）

| 目标 | 来源（合法性） | 客户端可识别信号 | 负向条件 |
|---|---|---|---|
| ① 历史超限不阻断 | 用户 2026-08-08 对话原话「SUB 上下文压缩问题」+ 后端日志实测 `Context overflow recovery 1/3 dropped 201 messages` | 客户端**收到正常 SSE 响应流**（非 400），history 中含 `TRUNCATION_PLACEHOLDER` user 消息可查（SUB 可选择性引用） | Must NOT：因主动截断触发上游 400 REQUEST_BODY_INVALID（本项目 `trimHistoryByTokens` 已有 toolUse 配对保护） |
| ② 大 tool_result 不撑爆 | 用户 2026-08-08 截图明确「1800 行 diff + 28 文件」+ Claude Code #59962 stop-hook loop | 客户端收到的**历史 tool_result** 摘要以 `[rtk-compressed:<filter>]` 开头 · SUB 能识别该头并知道内容被压过 | Must NOT：压缩 currentMessage（用户当前信息完整性优先） · Must NOT：压缩 `is_error` tool_result（错误 trace 保留） |
| ③ 上游 SSE 停发能被感知 | Anthropic SDK #867 + Claude Code #59913 + 本项目 `[STREAM-END] silenceBeforeEndMs` 观测 | 客户端收到 **一次且仅一次** SSE `data: {"error":{"code":"upstream_stream_stall",...}}\n\n` 后 stream 关闭；上游 fetch 已被 abort | Must NOT：静默断流让客户端从 0 timeout 到 10 分钟才失败 · Must NOT：多路径重复发同一 stall error（唯一错误映射层保证） |
| ④ 三层失败可回退 | Globalrules §4.6 诚实契约 · 本项目已有 `overflowRecoveryAttempt` 3 次兜底 | 无客户端可见变化（因为 payload 未改） · 后端日志 warn 一条 `[<layer>-error] ...` | Must NOT：因防护层内部异常导致原本可正常发送的请求 500 |

**Verified once by**（F7 采纳 · 三独立验收门 · 拒绝"任一日志即通过"）：
- **Layer A 验收门**：构造一个 history > 1MB 的真实请求（用 `test:e2e` 里的辅助工具） → 客户端收到 HTTP 200 + 完整流响应（不是 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD），后端日志出现 `[HISTORY-TRUNCATED] dropped=N`，Recovery 计数 0
- **Layer B 验收门**：构造一个 history 含 200KB 的 `git diff` tool_result → 客户端收到 200 + 响应内容，且**响应中如果 SUB 引用了该 tool_result 摘要**能看到 `[rtk-compressed:git-diff]` 头；后端日志出现 `[RTK] saved XB / YB`
- **Layer C 验收门**：手工 mock 一个"发 3 chunk 然后停"的上游流（vitest 用 `TransformStream` 构造） → 客户端在 `stallTimeoutMs` 内收到 SSE error `code:'upstream_stream_stall'` 且 stream 关闭；后端日志出现 `[STREAM-STALL-ABORT] chunks=3 sinceLastMs=<>`

### 核心域 vs 基础设施

**基础设施域**——反代内部字节层/流层增强。**不动业务契约**（不改 Anthropic/OpenAI 兼容协议，不改客户端可见 API）。**改的是错误协议**——从"无信号死等"变为"明确 SSE error"（Layer C），这是行为改进不是破坏性变更。

### 状态机（三层执行顺序：B → A → C · 副本变换 + 一次性提交）


```
用户请求
  ↓
translator.ts: buildKiroPayload(...) → payload
  ↓
callKiroApiStream(payload, ...)  ← 唯一收口点（消除多接线）
  ↓
  clone = clonePayload(payload)  ← 副本变换起点（I6 原子性）
  ↓
  [LAYER B] compressToolResults(clone)
    · 仅遍历 clone.conversationState.history[] · 不动 currentMessage
    · MIN_COMPRESS_SIZE = 50KB · RAW_CAP = 10MB
    · 每压一条 tool_result.text 前面拼 "[rtk-compressed:<filter>]\n" 摘要头
    · is_error/status=error 跳过 · fail-open catch 抛弃 clone
  ↓
  [LAYER A] ensurePayloadUnderSizeLimit(clone)
    · 若 estimateSize(clone) > 900KB → trimHistoryByTokens(clone, targetTokens)
    · 复用现有 trimHistoryByTokens（含 system pair 保护 + toolUse 成对）
    · 插入 TRUNCATION_PLACEHOLDER user + PLACEHOLDER_ACK assistant
    · fail-open catch 抛弃 clone
  ↓
  验证 clone 结构一致性（I1-I3 不变量校验）
  ↓
  一次性替换：payload.conversationState = clone.conversationState
  （若上述任一步骤抛异常 → 抛弃 clone、payload 一字节未改）
  ↓
  fetch(url, { signal: abortController.signal, ... })
  ↓
  wrapStreamWithStallDetection(response.body, abortController, opts)
    ↑ Layer C 唯一错误映射责任层：stall → abortController.abort() + controller.error(new StallError)
  ↓
  parseEventStream(wrappedStream, ...)
    · 从 stream reader 拿到 StallError 后不再翻译，直接 emitStreamEndDiag('stall_abort')
  ↓
  四条下游 SSE 组装路径统一从 stall_abort 消费 → 各自发一次 `{"error":{"code":"upstream_stream_stall"}}`
  ↓
  [fallback 已有层] 若上游 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD（B/A 未拦到的边缘 case）
    → Context overflow recovery 3 次兜底（保留）
```

### Invariants（不变量）

- **I1**：任意时刻 `payload.conversationState.history` 必须**以 user 起始**且 user/assistant **严格交替**（复用现有 `ensureStartsWithUserMessage`）
- **I2**：任意时刻 history 中 tool_result 引用的 `toolUseId` 必须在同一 payload 中的 tool_use 上有对应发起（复用现有 `trimHistoryByTokens` 的成对裁剪）
- **I3**：`is_error === true` 或 `status === "error"` 的 tool_result **永不压缩**（错误诊断价值高于 tokens）
- **I4 修订**（含 A3 采纳）：任何一层内部抛异常 → 该层视为 no-op **且原 payload 一字节未改**（由 I6 支撑），其他层照常执行；日志 warn 一条 `[<layer>-error]`
- **I5**：Layer C 触发 stall abort 后，四条下游 SSE 组装路径合起来向客户端发**一次且仅一次** `{"error":{"code":"upstream_stream_stall",...}}` 后 stream 关闭（唯一错误映射层保证）
- **I6 新增**（A3 采纳 · 原子变换）：Layer B / A 的所有中间修改仅作用于 `clonePayload(payload)` 得到的**深拷贝副本**；副本通过 I1-I3 一致性校验后才**一次性替换**原 payload 的 conversationState 引用；异常时抛弃副本、原 payload 引用未变

### ADR admission

**否** · 三层都是补现有 pipeline 的钩子，无新契约、无新依赖、无跨模块方向变化；复用 `trimHistoryByTokens` / `clonePayload` / `emitStreamEndDiag` / `callKiroApiStream` 已建成基座。若后续演化为可插拔中间件框架（多层任意组合 + 每层独立配置）则升级为 ADR。

## 🔍 2. Existing-Implementation Search

### 内部（本项目 `F:\Kiro-account-manager\Kiro-account-manager\src\`）

| 已有能力 | 位置 | 状态 | 本轮如何用 |
|---|---|---|---|
| `trimHistoryByTokens(payload, maxTokens)` | `kiroApi.ts:1416-1470` | ✅ 成熟（system pair 保护 + toolUse 成对 + ensureStartsWithUserMessage） | Layer A 复用 · 只加占位说明 |
| `clonePayload(payload)` | `kiroApi.ts`（THINKING_SIGNATURE_INVALID 重试路径已用 · line 2244 附近） | ✅ 生产验证 | I6 原子变换基石 |
| Context overflow recovery（被动版） | `kiroApi.ts:2187-2226` | ✅ 生产验证（日志实测 `dropped 201 messages`） | 保留 · 作 A 前置后的兜底 |
| `CONTEXT_OVERFLOW_RECOVERY_RATIOS` | `kiroApi.ts` | ✅ 3 次比例 | 复用于 Layer A 首次 target ratio |
| `emitStreamEndDiag` | `kiroApi.ts:2826, 2843-2854` | ✅ 已记 `silenceBeforeEndMs` / `chunks` / `streamSpanMs` | Layer C 复用其观测锚点 · 升级为动作 |
| `buildKiroPayload` | `kiroApi.ts:1477` | ✅ 4 处调用 | 不作接线点（Layer 都在 callKiroApiStream 内部） |
| `callKiroApiStream` | `kiroApi.ts:1907` | ✅ 5 处调用 · 已用 `fetch(url, {signal})` 传 AbortController | **三层唯一接线点**（消除候选式） |

**结论**：本项目已有 60% 基础设施（`clonePayload` + `trimHistoryByTokens` + AbortController 已连线到 fetch），缺的是主动触发 / 占位说明 / tool_result 内容压缩 / stall abort。


### 外部真源参考

| 项目 | 参考实现 | 位置 | 关键设计点 |
|---|---|---|---|
| **KiroStudio** | 主动字节级历史截断 | `src/anthropic/truncate.rs:1-180` | 900KB 阈值 · 保底 4 条 · TRUNCATION_PLACEHOLDER + "Understood." Ack · 孤立 toolResult 剥离 · user/assistant 交替强制 |
| **KiroStudio** | tool_result 智能截断 | `src/anthropic/compressor.rs:1-260` | 头 80 尾 40 保留 · 空 content 兜底修复；**只做 body 级不做 chunk 级形态识别**——比 9Router RTK 保守 |
| **9Router** | RTK Token Killer | `open-sse/rtk/index.js` + `filters/`（4 高价值过滤器：gitDiff / smartTruncate / readNumbered / grep） | 4 shape 分类 + autodetect 11 过滤器 + safeApply 三重安全网 + fail-open |
| **9Router** | SSE Stall Watchdog（**本轮 Layer C 主要靶子**） | `open-sse/utils/streamHandler.js:191-253 pipeWithDisconnect` | 追踪原始上游字节 · 每 chunk 重置 timer · 6 分钟默认 · `wrappedController` 多路径 clearStall |
| **9Router** | 常量分离 | `runtimeConfig.js:51-58` | `STREAM_STALL_TIMEOUT_MS=360s` / `STREAM_FIRST_CHUNK_TIMEOUT_MS=200s` |

**Anti-fabrication anchors**：每条 `file:line` 本轮 `git grep` / `read_file` 实证。工具 `fast-context-fast_context_search` / `desktop-commander-start_process(git grep)` / `desktop-commander-read_multiple_files`。

**Anthropic 官方证据锚点**（供后续 review 复核 · 每条含 URL）：
- `https://github.com/anthropics/anthropic-sdk-typescript/issues/867` (2025-12-19)
- `https://github.com/anthropics/claude-code/issues/59962` (subagent stop-hook loop)
- `https://github.com/anthropics/claude-code/issues/59913` (CLI hangs on stuck stream)
- `https://github.com/anthropics/claude-code/issues/32116` (strace stale TCP)
- `https://docs.anthropic.com/en/docs/claude-code/troubleshooting` (Autocompact thrashing)

## 📐 3. Interface Contract

### Layer A · 主动历史截断（`ensurePayloadUnderSizeLimit`）

**签名**（新建 `src/main/proxy/contextTruncate.ts`）：

```typescript
export type TruncationResult =
  | { triggered: false; reason: 'none'; beforeBytes: number }             // 未超阈值
  | { triggered: true;  reason: 'oversize'; droppedMessages: number;
      beforeBytes: number; afterBytes: number }                           // 成功截断
  | { triggered: false; reason: 'error'; error: string; beforeBytes: number } // fail-open 失败

export function ensurePayloadUnderSizeLimit(
  payload: KiroPayload,
  options?: { maxPayloadBytes?: number; targetRatio?: number; modelId?: string }
): TruncationResult
```

（F6 采纳：`reason` discriminated union，`error` 分支合法；调用方 switch on `reason` 分三路日志：`none` info-level / `oversize` warn-level with 数字 / `error` warn-level with 抛错原因）


### 外部真源参考

| 项目 | 参考实现 | 位置 | 关键设计点 |
|---|---|---|---|
| **KiroStudio** | 主动字节级历史截断 | `src/anthropic/truncate.rs:1-180` | 900KB 阈值 · 保底 4 条 · TRUNCATION_PLACEHOLDER + "Understood." Ack · 孤立 toolResult 剥离 · user/assistant 交替强制 |
| **KiroStudio** | tool_result 智能截断 | `src/anthropic/compressor.rs:1-260` | 头 80 尾 40 保留 · 空 content 兜底修复；**只做 body 级** |
| **9Router** | RTK Token Killer（Layer B 主靶子） | `open-sse/rtk/index.js` + `filters/`（4 过滤器：gitDiff / smartTruncate / readNumbered / grep） | 4 shape + autodetect 11 过滤器 + safeApply 三重安全网 |
| **9Router** | SSE Stall Watchdog（Layer C 主靶子） | `open-sse/utils/streamHandler.js:191-253 pipeWithDisconnect` | 追踪原始上游字节 · 每 chunk 重置 timer · 6 分钟默认 |
| **9Router** | 常量分离 | `runtimeConfig.js:51-58` | `STREAM_STALL_TIMEOUT_MS=360s` / `STREAM_FIRST_CHUNK_TIMEOUT_MS=200s` |

**Anti-fabrication anchors**：每条 `file:line` 本轮 `git grep` / `read_file` 实证。

**Anthropic 官方证据锚点**（供 review 复核）：
- `https://github.com/anthropics/anthropic-sdk-typescript/issues/867`
- `https://github.com/anthropics/claude-code/issues/59962` / `#59913` / `#32116`
- `https://docs.anthropic.com/en/docs/claude-code/troubleshooting`

## 📐 3. Interface Contract

### Layer A · 主动历史截断（`ensurePayloadUnderSizeLimit`）

**签名**（新建 `src/main/proxy/contextTruncate.ts`）：

```typescript
export type TruncationResult =
  | { triggered: false; reason: 'none'; beforeBytes: number }
  | { triggered: true;  reason: 'oversize'; droppedMessages: number;
      beforeBytes: number; afterBytes: number }
  | { triggered: false; reason: 'error'; error: string; beforeBytes: number }

export function ensurePayloadUnderSizeLimit(
  payload: KiroPayload,
  options?: { maxPayloadBytes?: number; targetRatio?: number; modelId?: string }
): TruncationResult
```

（F6 采纳：discriminated union · 调用方 switch on `reason` 分三路日志。`none` info · `oversize` warn 带数字 · `error` warn 带抛错原因）


**语义**：
1. `beforeBytes = estimateSize(payload)`（`JSON.stringify(payload).length`，近似）
2. 若 ≤ `maxPayloadBytes`（默认 900KB）→ 直接返回 `{triggered:false, reason:'none', beforeBytes}`
3. 否则 `clone = clonePayload(payload)`（**副本变换 · I6**）
4. `trimHistoryByTokens(clone, floor(estimatePayloadTokens(clone) * targetRatio))` 在 clone 上做（复用现有函数）
5. 若 clone 首条不是 `TRUNCATION_PLACEHOLDER` user + `PLACEHOLDER_ACK` assistant pair → 插入（保 I1 交替）
6. 一致性校验：`clone` 通过 I1-I3（现有 `sanitizeConversation` 已覆盖）
7. **一次性替换**：`payload.conversationState = clone.conversationState`（原子 · I6）
8. 返回 `{triggered:true, reason:'oversize', droppedMessages, beforeBytes, afterBytes}`
9. **任意步骤抛异常**：不替换、返回 `{triggered:false, reason:'error', error:msg, beforeBytes}`，**原 payload 一字节未改**

**日志**：`proxyLogger.warn('KiroAPI', '[HISTORY-TRUNCATED] dropped=<N> before=<X>B after=<Y>B ratio=<r>')` 仅 `oversize` 触发

**保护**：`currentMessage` 从不被本函数动（Success State ①的负向条件之一）

### Layer B · Tool result 智能压缩（`compressToolResults`）· **修订版**

**签名**（新建 `src/main/proxy/rtk/index.ts`）：

```typescript
export interface CompressionStats {
  bytesBefore: number
  bytesAfter: number
  hits: Array<{ filter: string; saved: number }>
}
export type CompressionResult =
  | { applied: true;  stats: CompressionStats }
  | { applied: false; reason: 'nothing_to_compress' | 'error'; error?: string }

export function compressToolResults(
  payload: KiroPayload,
  options?: { minCompressSize?: number; rawCap?: number }
): CompressionResult
```


**语义**（**A2 采纳核心**）：
1. `clone = clonePayload(payload)`（副本变换 · I6）
2. **仅遍历 `clone.conversationState.history[]`**（**永不动 `currentMessage`** · A2 采纳）
3. 对每个 `history[i].userInputMessage.userInputMessageContext.toolResults[j].content[k]` 中的 `text` 字段：
   - `is_error === true` 或 `status === 'error'` → 跳过（I3）
   - `text.length < MIN_COMPRESS_SIZE`（**默认 50KB** · A2 采纳 · 对齐用户 "200K+" 目标）→ 跳过
   - `text.length > RAW_CAP`（默认 10MB） → 跳过（防病态输入）
   - `autoDetectFilter(text)` 返回 filter 或 null；null → 跳过
   - `compressed = safeApply(filter, text)`；抛异常 → catch 保留原 text
   - `compressed.length === 0 || compressed.length >= text.length` → 保留原（双保险）
   - 否则 → `text = "[rtk-compressed:" + filter.filterName + "]\n" + compressed`（**摘要头** · Success State ②要求）
   - 累加 `stats.hits.push(...)` `stats.bytesBefore/After`
4. 若整个遍历完成无异常 → **一次性替换** `payload.conversationState.history = clone.conversationState.history`（原子 · I6），返回 `{applied:true, stats}`
5. 遍历中任意步骤抛异常 → 抛弃 clone，返回 `{applied:false, reason:'error', error}`，原 payload 未变
6. 若整个遍历完成但 `stats.hits.length === 0` → 直接返回 `{applied:false, reason:'nothing_to_compress'}`，不做替换（无变化不必替换）

**过滤器最小集**（4 个，抄 9Router）：`gitDiff` / `smartTruncate` / `readNumbered` / `grep`

**日志**：`proxyLogger.info('KiroAPI', '[RTK] saved <X>B / <Y>B (<Z>%) via [<filters>] hits=<N>')` 仅 `applied:true` 触发

**执行顺序 B → A**（**A2 采纳**）：先压再丢——压完可能就不用丢；且丢历史前已经把大 tool_result 压过，丢的比例更小。

**currentMessage 超限独立场景**（评审 F5 极端场景推演）：本决策卡**不改** currentMessage。若 currentMessage 单独超上游 body 限制（罕见 · 单条 tool_result > 2MB） → 走已有 Recovery 兜底（若 Recovery 也裁不动 → 抛给客户端 400，此为最稳定失败结果 · 不静默改写用户当前信息）。

### Layer C · SSE Upstream Idle Watchdog（`wrapStreamWithStallDetection`）· **修订版**

**签名**（新建 `src/main/proxy/streamWatchdog.ts`）：

```typescript
export class StallError extends Error {
  code: 'upstream_stream_stall' = 'upstream_stream_stall'
  reason: 'first_chunk' | 'inter_chunk'
  chunks: number
  bytes: number
  sinceLastMs: number
}

export function wrapStreamWithStallDetection(
  upstreamBody: ReadableStream<Uint8Array>,
  abortController: AbortController,
  options?: {
    firstChunkTimeoutMs?: number
    stallTimeoutMs?: number
    onStall?: (err: StallError) => void
  }
): ReadableStream<Uint8Array>
```


**语义**（**A1 采纳核心：唯一错误映射层就是本函数**）：

1. **AbortController 到 fetch 的接线已存在**（本项目 `kiroApi.ts:1907 callKiroApiStream` 已用 `fetch(url, { signal: abortController.signal, ... })`）—— 本层复用该 controller
2. 包裹 `upstreamBody`，读取过程中维护 `lastChunkAt` / `chunkCount` / `totalBytes`
3. **首字节独立计时**：从 wrapper 创建起到第一个 chunk 到达 → 若超 `firstChunkTimeoutMs`（默认 200s） → 触发 `first_chunk` stall
4. **首字节到达后**：每 chunk 重置 stallTimer；后续 chunk 间超 `stallTimeoutMs`（默认 360s / 6 分钟） → 触发 `inter_chunk` stall
5. **Stall 触发时**（本层做完所有事 · **不允许上层再翻译**）：
   a. 构造 `stallErr = new StallError(reason, chunks, bytes, sinceLastMs)`
   b. 调 `options.onStall?.(stallErr)`（供上层记 log · 不能改错误）
   c. `abortController.abort()` → 底层 fetch 立即中断上游连接
   d. 向 wrap stream 的 controller 发 `controller.error(stallErr)` → 下游 reader.read() 抛 stallErr
   e. 清理 stallTimer / firstChunkTimer（一次性 · 复用 9Router `wrappedController` 多路径 clear 模式）
6. **上层集成**（`parseEventStream` 或 `callKiroApiStream` 内 · 接线点唯一）：
   - `try { for await (chunk of wrappedStream) { ... } } catch (e) { if (e instanceof StallError) { emitStreamEndDiag('stall_abort', e); ... } }`
   - **不翻译 stallErr**——直接调 `onError(stallErr)` 让上游透传给四条 SSE 组装点
7. **四条下游 SSE 组装点**（`proxyServer.ts:2540/3123/3481/4235`）**统一从 `onError(StallError)` 中消费**：
   - 每条路径的 error handler 检测 `err instanceof StallError` → 向客户端发一次 `data: {"error":{"code":"upstream_stream_stall","message":<...>,"reason":<...>}}\n\ndata: [DONE]\n\n` 后关流
   - `data: [DONE]` 是 OpenAI 兼容协议要求（Anthropic 兼容路径不发）
8. **正常完成 / 客户端取消 / 其他错误**：不触发本层 stall；stallTimer / firstChunkTimer 一律 clear

**常量默认**（`src/main/proxy/streamWatchdog.ts` 顶部 · 允许 env 覆盖）：
- `STREAM_FIRST_CHUNK_TIMEOUT_MS = 200 * 1000`（200s · env `KIRO_STREAM_FIRST_CHUNK_TIMEOUT_MS`）
- `STREAM_STALL_TIMEOUT_MS = 360 * 1000`（360s / 6 分钟 · env `KIRO_STREAM_STALL_TIMEOUT_MS`）
- 阈值借鉴 9Router · 给推理模型头部留足；生产真机跑一周后再调（**F5 场景推演**中会验证 5 类真实场景）

**fail-open**：如果本层内部代码抛异常（除 StallError 外）→ catch 后 `console.warn('[STREAM-WATCHDOG-ERROR]')` + 视为 watchdog 不启用（stream 照常读，只是没了 stall 保护）—— 比阻断请求好



### Link table F2 采纳（producer / artifact / consumer / result / failure · 消除候选式）

| Node | Producer | Artifact | Consumer | Consumption Result | Failure |
|---|---|---|---|---|---|
| `ensurePayloadUnderSizeLimit` | 新建 `src/main/proxy/contextTruncate.ts` | `TruncationResult` + 可能修改的 `payload.conversationState` | `callKiroApiStream` 顶部（唯一） | 若 `oversize` 则 payload 变小并继续；若 `error` 则 payload 未变继续（fail-open） | `error` reason 已 log；不阻断请求 |
| `TRUNCATION_PLACEHOLDER` 常量 | 同上 | user message content | Kiro 上游模型（作为 history 首条 user） | 模型看到并可能引用它作为"上下文被截断"提示 | 无 |
| `compressToolResults` | 新建 `src/main/proxy/rtk/index.ts` | `CompressionResult` + 可能修改的 `payload.conversationState.history` | `callKiroApiStream` 顶部（Layer A 前） | 若 `applied` 则 history tool_result 变小并继续；否则 payload 未变继续 | `error` reason 已 log；不阻断请求 |
| 4 过滤器 × TS 文件 | `src/main/proxy/rtk/filters/{gitDiff,smartTruncate,readNumbered,grep}.ts` | 压缩后的 text（前缀 `[rtk-compressed:<name>]\n`） | `compressToolResults` 内的 `safeApply` | 单个 tool_result.text 被替换 | `safeApply` catch 后保留原 text，不算失败 |
| `wrapStreamWithStallDetection` | 新建 `src/main/proxy/streamWatchdog.ts` | 包裹后的 `ReadableStream<Uint8Array>` + 可能抛出的 `StallError` | `callKiroApiStream` 内 `fetch(...).then(r => parseEventStream(wrap(r.body)))` （唯一接线点） | 若 stall 则 reader.read() 抛 StallError 中断读取 | fail-open catch 后 stream 照常读，无 stall 保护 |
| `StallError` 类 | 同上 | 类型 + 实例 | `parseEventStream` 内 `catch(e)` + 4 条 SSE 组装点的 `onError(err)` | `emitStreamEndDiag('stall_abort')` + 向下游发一次 SSE `code:'upstream_stream_stall'` 后关流 | 单一入口保证一次且仅一次 |

**每个 to-build 节点在下方 §任务清单中都有对应 task，每个 existing 节点已含 `git grep` 锚点。**

## 🧪 4. Test Boundaries

### 4.0 生产场景端到端推演（F5 采纳 · 拒绝"函数测试等同业务可用性验证"）

| 场景 | 触发层 | 期望客户端结果 | 负向条件未发生 |
|---|---|---|---|
| ① 典型长会话：120 轮工具调用，累计 history ≈ 1.5MB | Layer B 命中大 tool_result 压 30%；Layer A 判断 clone 后仍 > 900KB 继续裁 | 客户端收到 HTTP 200 + 完整流响应；SUB 可继续对话 | 不触发 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD；不损失当前消息 |
| ② 复杂：history 850KB + currentMessage 200KB tool_result | Layer B 只压 history（不动 current）；Layer A 判断 850KB < 900KB 不触发；总 payload 1050KB > 900KB → A 触发裁 history | 客户端收到 200 + 完整流；用户当前 200KB tool_result **一字节未压** | 不静默改写用户当前信息（Must NOT） |
| ③ 极端：currentMessage 单条 tool_result > 2MB | Layer B 跳过（超 RAW_CAP 10MB → 不越界）或不动 current（策略明确） · Layer A 不动 current · fetch 发出 · 上游返 400 · Recovery 触发但也裁不动 current | 客户端收到明确 400 错误 + reason | 不静默改写用户当前信息；错误消息可读（这是最稳定失败结果） |
| ④ SSE 流：正常发了 3 chunks 后上游停发 6 分钟 | Layer C `inter_chunk` stall 触发 · abortController.abort() · controller.error(StallError) · 4 条下游 SSE 组装点各发一次 error | 客户端在 ≈360s 内收到 SSE `code:'upstream_stream_stall'` 后 stream 关闭 · Claude Code / Codex 客户端识别 stream 结束 | 客户端不再从 0 timeout 到 10 分钟才失败；不出现重复 error（唯一映射层保证） |
| ⑤ 客户端收到 stall error 后重试 | 客户端自主决定：a) 主动重发原 prompt（Claude Code / Codex 都支持），或 b) 展示错误让用户手动重试 | 重试请求走完整 pipeline，payload 未变（stall 是上游/网络问题，不是 payload 问题） | 不出现重复提交同一 payload 到 stalled 端点 |

**推演的负面场景不会发生**（每场景已在"负向条件未发生"列显式验证）。


### 4.1 TDD Red 单测边界（先写测试，功能不存在时失败）

**Layer A · `contextTruncate.test.ts`**
- **A1**：payload ≤ 900KB → `{triggered:false, reason:'none'}` 且 payload 深比对无变化
- **A2**：12 × 200KB history 消息（≈2.4MB）→ `triggered:true, reason:'oversize'`；截后 payload 序列化 ≤ 900KB
- **A3**：截后 history 首条是 `TRUNCATION_PLACEHOLDER` user + `PLACEHOLDER_ACK` assistant，之后是保留 tail
- **A4**：截后 user/assistant 严格交替
- **A5**：切口落在 assistant(toolUse) 后 → toolResult 剥掉或整对保留（无孤立 toolResult）
- **A6**：`trimHistoryByTokens` 抛异常 → `{triggered:false, reason:'error'}` 且 payload **一字节未改**（I6 原子性验证）
- **A7**：`currentMessage` 从不被本函数修改（Layer A 保 Must NOT ①）

**Layer B · `rtk/rtk.test.ts` + `filters/*.test.ts`**
- **B1**：payload 所有 history tool_result 都 < 50KB → `{applied:false, reason:'nothing_to_compress'}` 且 payload 未变（**阈值修订 · A2 采纳**）
- **B2**：一 tool_result 含 500 行 `git diff` → gitDiff 过滤器命中 · output 前缀 `[rtk-compressed:git-diff]\n` · 保留 hunk 头 + 改变行 + `+X -Y` 汇总 · saved > 0
- **B3**：一 500 行大文件 dump（无 git 特征）→ smartTruncate 命中 · output 前缀 `[rtk-compressed:smart-truncate]\n` · 头 120 + `... +N lines truncated` + 尾 60
- **B4**：`is_error === true` 的 tool_result 一律不压（哪怕 100KB · I3）
- **B5**：过滤器抛异常 → `safeApply` catch 返回原文；`compressToolResults` 顶层 catch → `{applied:false, reason:'error'}` + payload 未变（I6 验证）
- **B6**：压缩后长度 ≥ 原长度 → 保留原文（双保险）
- **B7**：正确处理 Kiro 特有 `conversationState.history[]...toolResults[].content[].text` 嵌套
- **B8**（**新增 · A2 采纳**）：`currentMessage.userInputMessage.userInputMessageContext.toolResults[]` 里的 tool_result 即使 500KB 也一律不压（Must NOT ② · 保用户当前信息完整性）

**Layer C · `streamWatchdog.test.ts`**
- **C1**：正常流（每 100ms 一 chunk）→ 无 stall abort · AbortController.signal.aborted === false
- **C2**：模拟前 3 chunk 到达后停发 → `stallTimeoutMs` 后 stallTimer 触发 · AbortController.abort() 被调 · reader 拿到 StallError
- **C3**：首字节不到 → `firstChunkTimeoutMs` 后触发 stall（reason='first_chunk'）
- **C4**：StallError 的 chunks / bytes / sinceLastMs / reason 字段值正确
- **C5**：正常流结束 → stallTimer 被 clear · 无悬空 timer（复现 9Router 多路径 clearStall）
- **C6**：stallTimer 内部代码抛异常 → catch 后 watchdog 视为不启用 · stream 照常读

### 4.2 集成测试

- **INT1**（**修订 · F5 场景 ①**）：一模拟大 payload（1.2MB · 含 3 个 200KB history tool_result · currentMessage 5KB）经三层 → payload < 900KB · history tool_result 被压 · currentMessage 未变 · 流正常读完 → 后端日志出 `[RTK] saved` + 可能 `[HISTORY-TRUNCATED]`
- **INT2**（**修订**）：Layer A + 已有 Recovery 共存不死循环 · 主动 A 触发后若上游仍返 400 → Recovery 3 次兜底 · 总裁剪次数 ≤ A 一次 + Recovery 3 次
- **INT3**（**新增 · F5 场景 ④**）：mock 上游"发 3 chunk 后停发" · 客户端应在 `stallTimeoutMs` 内收到 SSE error `code:'upstream_stream_stall'` · 断言 4 条下游 SSE 组装路径任一命中都能正确发 error（当前测覆盖 `/v1/messages` 一条 · 其余 3 条 TODO）

### 4.3 关键边界注意事项

- **UTF-8**：payload 字节判定 `Buffer.byteLength(JSON.stringify(payload), 'utf-8')`，非 `str.length`
- **异步竞态**：Layer C stallTimer 与 abort() 的顺序 · 防重复触发（复用 9Router `wrappedController` 一次性 clear）
- **JSON.stringify 开销**：Layer A 每次判断都要序列化整个 payload 估字节 · 若太贵可用近似 `estimatePayloadTokens × 4`
- **副本变换的深拷贝性能**：Layer A/B 用 `clonePayload` 每次深拷贝整 payload · 900KB 场景 clone 一次约 5-10ms · 可接受；未来若成瓶颈用 structural sharing


## 🛡️ 5. Anti-Corruption & Registration Checks

### 是否有新的第三方 SDK 需要 ACL 隔离？

**否** · 三层都是纯 TS 内部实现 · 无新依赖 · `package.json` 不动。

### 注册检查

| 项 | 状态 | 说明 |
|---|---|---|
| 路由表 | ✅ 不动 | 所有增强在 `kiroApi.ts` 内部 pipeline · 无新 HTTP 端点 |
| 权限系统 | ✅ 不动 | 无新权限要求 |
| i18n / 界面文案 | ⚠️ 仅一个总开关文案 | F3 采纳后从 3 开关降为 1 开关 · i18n key ≈ 1 条 |
| 监控埋点 | ⚠️ 本轮扩展 | 复用 `proxyLogger` 加 3 类新日志：`[HISTORY-TRUNCATED]` / `[RTK]` / `[STREAM-STALL-ABORT]` |
| Feature flag | ⚠️ 本轮新增 · **F3 采纳修订** | 见下 |
| Settings 持久化 | ✅ 复用现有 `electron-store` | 1 个 bool 字段进 settings schema |

### Feature Flag（**F3 采纳 · 单一总开关 + 环境变量分层禁用**）

**上一版**：三个技术开关暴露给用户 → 评审判为"发布保护手段被误升成用户配置需求"

**采纳后设计**：
- **一个总开关**：`enableProxyContextSafetyNet` （settings 面板 · 默认 **关**）
  - 用户可见文案：`"启用反代上下文防护网（推荐 · 修复 GPT SUB 长任务卡住问题）"`
  - 描述：`"启用后自动处理长会话历史、大工具输出和上游流卡住问题。若启用后遇到问题可通过环境变量按层排障。"`
- **开发者排障**：不进 UI · 用 env 变量分层关闭：
  - `KIRO_PROXY_LAYER_A=false` 关掉 Layer A（Recovery 兜底还在）
  - `KIRO_PROXY_LAYER_B=false` 关掉 Layer B
  - `KIRO_PROXY_LAYER_C=false` 关掉 Layer C（stream 照常读，无 stall 保护）
- **默认策略**：总开关默认关 → 内测一周实测后改默认开（并在下一版决策变更中记录）

**理由**：三层是"稳定性保护"（B 类），不是"用户可选择的能力"。终端用户不该被要求理解"字节级历史截断"和"SSE stall watchdog"的技术差别。给他们**一个总开关**，配 env 排障通道，是**dev 友好 + 用户友好** 的正确控制面粒度。

### Decision Record

| Field | Value |
|---|---|
| Chosen approach | 三层合一决策卡 · 副本变换 + 一次性提交 · 唯一接线点 `callKiroApiStream` 顶部（A/B）+ fetch 后 wrap（C）· 单总开关 + env 分层 |
| **Alternatives rejected（F4 采纳 · 完整业务比较）** | 见下详表 |
| Reviewer | **codex**（默认 · 用户未指定其他） |
| Estimated LOC | ~600-800 TS 行（含测试）：Layer A ~150 + Layer B ~350（含 4 过滤器）+ Layer C ~150 + 测试 ~200-300 |
| Risk level | **中低**——三层各自 fail-open · 默认关 · env 可覆盖 · 影响面在反代内部 |
| 停止条件 | 任一 P0 未闭环时不进入实施；本轮 3 P0 全部采纳修订，可开工 |

**Alternatives rejected（F4 完整比较）**：

| 方案 | 收益 | 成本 | 风险 | 可逆性 | 结论 |
|---|---|---|---|---|---|
| **① 沿用现状（0 改动）** | 0（用户仍撞 1h50m 卡住） | 0 | 高（问题继续出现） | N/A | ❌ 与 Success State 冲突 |
| **② 只做 Layer C（stall watchdog）** | 40%（治死等；不治超限） | 小（~200 LOC） | 低（不改 payload） | 极高（单文件） | ⚠️ 可作最小交付起点，但 F5 场景 ①②③ 未覆盖 |
| **③ 只做 A + C（不做内容压缩）** | 70%（治超限 + 死等；不细粒度压 tool_result） | 中（~400 LOC） | 低 | 高 | ⚠️ B 延后：等 A+C 数据实测后再决定 B 触发率 |
| **④ 完整三层（本决策卡采纳）** | 100% | 高（600-800 LOC） | 中（三层组合复杂度 · 但 fail-open 独立） | 高（三层 env 独立可关） | ✅ 本轮采纳 |
| **⑤ 抄 KiroStudio compressor 整套（含空白折叠）** | 100+ 空白节省 | 更高 | 中 | 中 | ❌ 空白折叠对英文 JSON payload 收益极低（<2%）不划算 |
| **⑥ 抄 KiroStudio http_client 层 read_timeout** | 30%（只治网络层不治 SSE event 级 stall） | 极小 | 极低 | 极高 | ❌ 粒度太粗 · Anthropic SDK #867 场景（SSE 中间停）测不到 |
| **⑦ 引入独立中间件框架（可插拔层）** | 100+ 扩展性 | 极高（≈2000 LOC + 新架构） | 高 | 低 | ❌ 过度工程化 · 本轮三层是稳定形态不需框架 |

**分阶段交付条件**（若资源受限）：先 ④ 全做；实在做不完可退到 ③（A+C）；再退到 ② （只 C · 治最影响体验的死等）。

## ✅ Quality Gate Checklist

- [x] Success State 含 `NOT X, BUT Y` + Must NOT + 三列 Source 映射 + Verified once by 三独立门（§0.15B · F1/F7 采纳）
- [x] Current-State Inventory 用真实 `file:line`（内部 7 条 + 外部 5 条）
- [x] Decision Record 含 Reviewer=codex + 完整 alternatives 比较（7 项 · F4 采纳）
- [x] Correctness Properties 覆盖三层 + INT + 边界 + 场景推演 5 类（F5 采纳）
- [x] `is_error` / user/assistant 交替 / toolUse 配对 / **原子变换 I6** 四大不变量显式（A3 采纳）
- [x] fail-open 三层各自独立标注；A3 采纳 = fail-open 由 I6 原子变换保证
- [x] Link table `producer | artifact | consumer | result | failure` 5 列完整 · 无候选式（F2 采纳）
- [x] Anti-fabrication anchors：外部引用 5 条含 URL + 工具名
- [x] `TruncationResult.reason` 类型三分（F6 采纳 · discriminated union）
- [x] Feature flag 一个总开关 + env 分层（F3 采纳）
- [x] Layer C 唯一错误映射层 + AbortController→fetch→SSE error→4 路径链完整（A1 采纳）
- [x] Layer B 仅 history 不动 currentMessage · MIN=50KB · 摘要头（A2 采纳）
- [ ] EARS Requirements 段（**决策卡为 artifact 变体 · 不需要三件套** · 见 `references/spec-deliverable.md` §小任务变体）


## 📋 任务清单（artifact 内嵌 · Template 3 语法）

| 字段 | 值 |
|---|---|
| 来源 Source | 本决策卡 v2 §3-§4 Interface Contract + Test Boundaries |
| 类型 Type | feature-remediation |
| 创建 Created | 2026-08-09 |
| 状态 Status | in-progress（决策卡阶段） |

**图例**：`- [ ]` 待办 · `- [x]` 完成 + Evidence · `— ⛔ BLOCKED` / `— ⏭ SKIPPED` / `— ⏳ PENDING`

## Overview

交付顺序：spec 评审通过 → **Layer C**（最独立、不改 payload）→ **Layer A**（改 payload · 有 clonePayload 基座）→ **Layer B**（改 payload · 逻辑最复杂 · 4 过滤器）→ 集成 → 单开关 UI → 主 AI 独立复核 → commit。

（顺序改动理由：v2 采纳 F4 完整比较后 · Layer C 最独立最可回退 · 应最先落。）

## Tasks

- [x] 1. **Recon + 决策卡 v1 v2 落盘**
  - [x] 1.1 读 error-journal + engineering-agent 规则 + 两目标仓库规则
  - [x] 1.2 建立现象锁 + 决策卡 v1 骨架
  - [x] 1.3 落决策卡 v1 · 428 行

- [x] 2. **单轮 spec-cross-review 工件评审（模板 F · backend=codex）**
  - [x] 2.1 调用 `spec-cross-review` skill · `--template artifact-decision-card --backend cli --cli-preset codex`
  - [x] 2.2 收 VERDICT · 落 `decision-card.review1.codex.md` · status=NEEDS_CHANGES · p0=3 p1=7
  - [x] 2.3 3 步过筛（真伪/比重/根因）· 10 条全采纳 · 修 v2 落盘 · Update Log 10 行处置记录

- [ ] 3. **Post-review introspection Gate**
  - [ ] 3.1 判定是否触发：本轮 3 P0 全采纳修改 · 触发条件成立 → 需产 introspection 文档
  - [ ] 3.2 落 `introspection-proxy-context-safety-net.md` · 4 判据 Generalizability Gate

- [ ] 4. **Layer C · Stall Watchdog**（TDD · **最早落 · 因为不改 payload · 最独立**）
  - [ ] 4.1 Red：C1-C6 单测 · **New file** `test/main/proxy/streamWatchdog.test.ts`
  - [ ] 4.2 Green：实现 `src/main/proxy/streamWatchdog.ts`（`wrapStreamWithStallDetection` + `StallError` 类 + 常量 + env 覆盖）
  - [ ] 4.3 接线：`kiroApi.ts:parseEventStream` 内 · fetch response.body 包一层
  - [ ] 4.4 4 条 SSE 组装路径 error handler 检测 `err instanceof StallError` 后发 SSE error（`proxyServer.ts:2540/3123/3481/4235`）
  - [ ] 4.5 单开关 `enableProxyContextSafetyNet` 判断
  - [ ] 4.6 C1-C6 全绿 · 现有 STREAM-END 埋点日志格式未变
    - _Requirements: I5, Success State ③_

- [ ] 5. **Layer A · 主动历史截断**（TDD）
  - [ ] 5.1 Red：A1-A7 单测 · **New file** `test/main/proxy/contextTruncate.test.ts`
  - [ ] 5.2 Green：实现 `src/main/proxy/contextTruncate.ts`（`ensurePayloadUnderSizeLimit` + `TruncationResult` discriminated union + `TRUNCATION_PLACEHOLDER` + `PLACEHOLDER_ACK` · 复用现有 `trimHistoryByTokens` + `clonePayload`）
  - [ ] 5.3 副本变换实现（I6）：在 clone 上做 · 验证 I1-I3 后一次性替换回 payload
  - [ ] 5.4 接线：`callKiroApiStream` 顶部一处（Layer B 之后）
  - [ ] 5.5 A1-A7 全绿 · payload 深比对（fail-open A6 硬门）
    - _Requirements: I1, I2, I4, I6, Success State ①_

- [ ] 6. **Layer B · Tool Result 压缩**（TDD · 改 payload 最复杂 · 最后落）
  - [ ] 6.1 Red：B1-B8 单测 · **New file** `test/main/proxy/rtk/rtk.test.ts`
  - [ ] 6.2 Green：骨架 `src/main/proxy/rtk/index.ts`（`compressToolResults` · `CompressionResult` · `autoDetectFilter` · `safeApply` · `constants.ts` MIN_COMPRESS_SIZE=50KB / RAW_CAP=10MB）
  - [ ] 6.3 4 过滤器：`filters/gitDiff.ts` / `filters/smartTruncate.ts` / `filters/readNumbered.ts` / `filters/grep.ts` · 每个附独立单测
  - [ ] 6.4 **摘要头**：每个过滤器 output 强制前缀 `[rtk-compressed:<filter.filterName>]\n`（Success State ② 客户端可识别信号）
  - [ ] 6.5 副本变换：在 clone 上做遍历 + 修改 · 成功后 `payload.conversationState.history = clone.conversationState.history`
  - [ ] 6.6 **currentMessage 排除**：函数不遍历 currentMessage（B8 硬门）
  - [ ] 6.7 接线：`callKiroApiStream` 顶部 · Layer A 之前（B → A 顺序）
  - [ ] 6.8 B1-B8 全绿 · 现有测试全绿
    - _Requirements: I3, I4, I6, Success State ② + Must NOT 反例_

- [ ] 7. **集成测试**
  - [ ] 7.1 INT1：三层组合正常场景（F5 场景 ①）
  - [ ] 7.2 INT2：Layer A + 已有 Recovery 共存不死循环
  - [ ] 7.3 INT3：mock stall 流 · 断言 4 路径任一发正确 SSE error（F5 场景 ④）
    - _Requirements: 全部不变量 + 全部 Success State_

- [ ] 8. **Settings UI + env 排障通道**
  - [ ] 8.1 加 `enableProxyContextSafetyNet` 字段到 settings schema
  - [ ] 8.2 前端设置面板加**单一总开关**（复用现有 UI 组件）+ i18n key
  - [ ] 8.3 后端 setter 读取 · 传递到 `kiroApi.ts`
  - [ ] 8.4 env 读取实现：`KIRO_PROXY_LAYER_A/B/C=false` 三档独立关闭

- [ ] 9. **手动 e2e 验证**（三独立验收门 · F7）
  - [ ] 9.1 Layer A 门：构造 history > 1MB · 客户端 200 · 日志 `[HISTORY-TRUNCATED]`
  - [ ] 9.2 Layer B 门：构造 history 含 200KB git diff · 响应含 `[rtk-compressed:git-diff]` 头
  - [ ] 9.3 Layer C 门：mock stall · 客户端在 stallTimeoutMs 内收到 SSE `code:'upstream_stream_stall'`

- [ ] 10. **reviewer sub 独立复核**（异构模型 · 7 Phase · read-only）
  - [ ] 10.1 派 `reviewer` sub · 传决策卡 v2 + 本轮 diff
  - [ ] 10.2 收 VERDICT · 3 步过筛处置

- [ ] 11. **Commit + 归档 + Root CHANGELOG/ARCHITECTURE 写回**
  - [ ] 11.1 `git add` 本轮所有新增/修改（不 `add .`）
  - [ ] 11.2 conventional commit：`feat(proxy): 反代上下文防护网三层增强 · Layer A/B/C 主动前置 + fail-open 原子变换`
  - [ ] 11.3 body 引用决策卡 v2 路径
  - [ ] 11.4 更新 `CHANGELOG.md` 一行 + `ARCHITECTURE.md` Evolution Index 一行

## Task Dependency Graph

```json
{ "waves": [
  { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
  { "id": 1, "tasks": ["2.1", "2.2", "2.3"] },
  { "id": 2, "tasks": ["3.1", "3.2"] },
  { "id": 3, "tasks": ["4.1"] },
  { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
  { "id": 5, "tasks": ["4.6"] },
  { "id": 6, "tasks": ["5.1"] },
  { "id": 7, "tasks": ["5.2", "5.3", "5.4"] },
  { "id": 8, "tasks": ["5.5"] },
  { "id": 9, "tasks": ["6.1"] },
  { "id": 10, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "6.7"] },
  { "id": 11, "tasks": ["6.8"] },
  { "id": 12, "tasks": ["7.1", "7.2", "7.3"] },
  { "id": 13, "tasks": ["8.1", "8.2", "8.3", "8.4"] },
  { "id": 14, "tasks": ["9.1", "9.2", "9.3"] },
  { "id": 15, "tasks": ["10.1", "10.2"] },
  { "id": 16, "tasks": ["11.1", "11.2", "11.3", "11.4"] }
] }
```


## Update Log

- **2026-08-09 20:xx +08:00** · 决策卡 v1 落盘（428 行）：三层设计初稿 + 接线点 + fail-open 契约 + 任务清单。
- **2026-08-09 21:xx +08:00** · **Codex artifact-decision-card 单轮工件评审跑完** · `decision-card.review1.codex.md`：`VERDICT=NEEDS_CHANGES · p0=3 · p1=7 · converged=false` · 10 条 patch_plan · validation.ok=true（所有 anchor 验证通过） · 判决"调整方案后开发"。

**R1 · 3 步过筛（真伪 / 比重 / 根因） · 10 条评审意见全部采纳 · 0 rejected · 0 deferred**：

- R1 · **A1**（P0 · Layer C 错误映射双路径） → **采纳**（真：v1 §3 Layer C 确实"parseEventStream 内 or callKiroApiStream 内"候选式 · 又同时写"抛错"和"发 SSE error"未明责任；比重：关键；根因：唯一错误映射层未定 · 修订：v2 明确 `wrapStreamWithStallDetection` 即唯一错误映射层 · AbortController→fetch→StallError→4 路径 onError 完整链）
- R1 · **A2**（P0 · Layer B 违反 Must NOT · 遍历 currentMessage） → **采纳**（真：v1 §1 Must NOT 写"不能改写 currentMessage" 但 §3 Layer B 明确遍历 currentMessage · 内部矛盾；比重：关键；根因：v1 阈值 500B 也违背用户"200K+"目标 · 修订：v2 明确 Layer B **仅** history · MIN=50KB · currentMessage 独立超限走 Recovery 兜底 · 执行顺序改 B→A）
- R1 · **A3**（P0 · fail-open 不是原子 · catch 撤销不了已改的 payload） → **采纳**（真：JS `catch` 无法撤销已发生的原地修改；比重：关键；根因：应用副本变换而非异常捕获策略 · 修订：v2 新增 I6 原子性不变量 + Layer A/B 强制在 `clonePayload` 副本上修改 · 成功后一次性替换 · 异常时抛弃副本原 payload 未变）
- R1 · **F1**（P1 · Source 来源未逐项映射） → **采纳**（真：v1 混合了用户对话/issue/埋点未分开；比重：中；根因：合并了参考资料与成功状态来源 · 修订：v2 §1 加"目标→来源→客户端可识别信号→负向条件"四列映射表）
- R1 · **F2**（P1 · Link table 不完整 · 3 列 + 候选式） → **采纳**（真：v1 只有 Node/Producer/Consumer · 有"或"候选；比重：中；根因：接线点清单被当端到端链路 · 修订：v2 Link table 5 列（+ Artifact + Consumption Result + Failure） · 消除所有"或"）
- R1 · **F3**（P1 · 三个技术开关暴露给用户） → **采纳**（真：三个技术开关对终端用户不友好；比重：中；根因：稳定性保护被误升为用户可选择的能力 · 修订：v2 改为**一个总开关** `enableProxyContextSafetyNet` + env `KIRO_PROXY_LAYER_A/B/C=false` 分层排障通道 · UI 只有 1 开关）
- R1 · **F4**（P1 · Alternatives 缺三层比较） → **采纳**（真：v1 只比"实现组织方式"没比业务方向；比重：中；根因：替代项集中于代码组织而非业务结果 · 修订：v2 Decision Record 加 7 项 alternatives 完整表 · 含现状/单层/两层/完整三层/框架化 · 每项收益成本风险可逆性停止条件）
- R1 · **F5**（P1 · 缺生产场景推演） → **采纳**（真：v1 只有函数测试无端到端推演；比重：中；根因：组件测试等同业务可用性验证 · 修订：v2 新增 §4.0 生产场景端到端推演 · 5 类场景 · 每场景带触发层 + 期望客户端结果 + 负向条件未发生）
- R1 · **F6**（P1 · `TruncationResult.reason` 类型矛盾） → **采纳**（真：v1 类型 `'oversize' | 'none'` 与 fail-open `reason:'error'` 冲突；比重：小；根因：接口签名与错误契约未同步 · 修订：v2 `TruncationResult` 改为 discriminated union · `reason: 'none' | 'oversize' | 'error'` 三分 · 调用方 switch 分三路日志）
- R1 · **F7**（P1 · Verified once by 会假通过） → **采纳**（真："三条日志任一即算穿线"只能证明局部钩子执行；比重：中；根因：把内部日志当最终用户结果 · 修订：v2 §1 Verified once by 拆三独立验收门 · Layer A/B/C 各有客户端结果 + 后端日志双证据）

**处置汇总**：3 P0 全采纳 = **架构级修订**（Layer B 政策、错误映射唯一化、原子变换）；7 P1 全采纳 = **契约与验收细节修订**（Source 映射、Link 完整化、单开关、Alternatives、场景推演、类型统一、验收门独立）。**当前决策卡 v2 · 428 行 → 570+ 行**。**patch_plan.validation.ok=true 且 10 条全采纳** → 视为 R1 收敛。

**Post-review introspection Gate**：3 P0 全部采纳并修订 → 触发条件命中 → 下一步产 `introspection-proxy-context-safety-net.md`（跨模型盲区沉淀 · 4 判据 Generalizability Gate）。

**下一步**：Task 3 落 introspection → Task 4 开工 Layer C（TDD Red 先写测试）。


---

## Update Log · v3 实现前侦察修订（2026-08-09 · 主 AI 亲验代码形态）

**触发**：进入实现前对决策卡所有 `file:line` 断言做独立复核（E-134 断言消除验证动机 · P-13 按能力搜非按命名搜）。发现 **4 处与实际代码不符**，其中 2 处改变实现方案。修订如下，实现以本节为准（决策卡 §3 正文对应描述作废）。

### D1 · Layer C 接线点不是 1 处而是 2 处（改方案 · P-03 改A漏传播）

- **卡里写**：`parseEventStream` 唯一接线点。
- **实测**：`git grep -nE "parseEventStream\(" -- src/main/proxy/kiroApi.ts` → 3 命中：
  - `kiroApi.ts:2133` 正常路径 · `await parseEventStream(response.body!, onChunk, completeGuard, onError, ...)`
  - `kiroApi.ts:2259` **THINKING_SIGNATURE_INVALID 重试路径** · `await parseEventStream(retryResponse.body!, onChunk, onComplete, onError, ...)`
  - `kiroApi.ts:2490` 函数定义
- **影响**：只包 2133 → 重试路径的流无 stall 保护。重试场景恰恰更需要保护（已失败一次，再死等 = 用户等更久）。
- **修订**：**两个调用点都必须包 wrap**；或更优 —— 把 wrap 下沉进 `parseEventStream` 内部（单一收口，天然覆盖所有现有与未来调用点）。实现时优先下沉方案，SUB 可按实际代码结构自主选择，但必须证明两条路径都被覆盖（`git grep` 锚点 + 单测）。

### D2 · 没有内部 AbortController，`signal` 是外部传入的可选参数（改方案）

- **卡里写**：`callKiroApiStream` 已用 `fetch(url, {signal: abortController.signal})`，Layer C 复用该 controller 调 `.abort()`。
- **实测**：`callKiroApiStream(..., signal?: AbortSignal, ...)`（`kiroApi.ts:1914`）是**调用方注入的可选 signal**（客户端断连用），函数内部**不存在** own AbortController；fetch 直接透传该外部 signal（`:2043` 附近 `fetch(endpoint.url, { ..., signal })`）。
- **影响**：Layer C 若 `.abort()` 外部 signal —— 语义越界（那是客户端取消通道，反代无权代表客户端取消），且 `signal` 可能为 `undefined` 直接崩。
- **修订**：在 `callKiroApiStream` 内部（每个端点尝试内）新建 **linked AbortController**：外部 `signal` 的 abort 事件转发给它，Layer C 的 stall 也 abort 它，`fetch` 用这个 linked controller 的 signal。二者任一触发即断上游，且不污染外部 signal。注意 `undiciFetch` 分支同样要传 linked signal。清理：请求正常结束时移除 abort 监听（防内存泄漏累积）。

### D3 · 4 条「SSE 组装路径」实为 `callKiroApiStream` 调用点，且漏了第 5 个（简化 · 无需改 4 处）

- **卡里写**：`proxyServer.ts:2540/3123/3481/4235` 是 4 条下游 SSE 组装路径，各自 error handler 加 `instanceof StallError` 判别。
- **实测**：`git grep -nE "callKiroApiStream\(" -- src/` → 5 个调用点：`proxyServer.ts:2540/3123/3481/4235` + **`kiroApi.ts:3530`（卡里漏了）**。这些是**调用点**，不是 SSE 组装点；错误统一经**注入的 `onError: (error: Error) => void` 回调**（`kiroApi.ts:1914` 签名 · `proxyServer.ts:64` 事件契约 `onError?: (error: Error) => void`）流向各调用方。
- **影响**：不必逐一改 4 处组装逻辑 —— `onError(StallError)` 天然到达每个调用方现有 handler。但 StallError 的 message 必须**自解释**，因为若某 handler 不做 `instanceof` 判别，用户看到的就是 message 原文。
- **修订**：① `StallError.message` 写成人类可读且含判据（如 `upstream_stream_stall: no data for 360s after 3 chunks (12.4KB) — upstream aborted`）；② 只在**已有明确 SSE error 组装能力**的调用点加 `instanceof StallError` 判别以发结构化 `code`；③ 5 个调用点逐一核对（含 `kiroApi.ts:3530`），在 tasks 里逐条留 grep 锚点。**I5「一次且仅一次」由 `onError` 单一回调天然保证**（每次请求只会有一个 handler 被调一次）。

### D4 · 行号漂移（无影响）

`trimHistoryByTokens` 卡里写 `1416-1470`，实测 `kiroApi.ts:1424`。`clonePayload` 实测 `:877`。`emitStreamEndDiag` 实测 `:2826`（与卡一致）。实现按实测锚点。

### 参考仓检索结论（5 仓 · 三件套 fast-context）

| 仓 | 结论 |
|---|---|
| `F:\KiroStudio` | ✅ 真源已读：`src/anthropic/truncate.rs:1-170` 完整读取 —— `MAX_PAYLOAD_BYTES=900*1024` / `MIN_RECENT_HISTORY_TURNS=4` / `TRUNCATION_PLACEHOLDER` / `PLACEHOLDER_ACK="Understood."` / `drop_leading_assistant` / **`drop_orphan_tool_results`（按 tool_use_id 集合剥孤立 toolResult，注释明确「纯文本历史截断能过，带工具的真实会话必失败」）** / 从最新往旧累加保留最长后缀。**Layer A 直接对标此实现。** |
| `F:\9router` | ✅ 真源已读：`open-sse/rtk/index.js:1-130`（`compressKiroFormat` 已含 Kiro 嵌套路径遍历 · `tr.status === "error"` 跳过 · `MIN_COMPRESS_SIZE`/`RAW_CAP` 双阈值 · try/catch fail-open 返回 null）+ `open-sse/utils/streamHandler.js:191-253 pipeWithDisconnect`（**stall 追踪原始上游字节而非 transform 输出** —— 注释明确「按 transform 输出测 stall 导致误判 false stall」· 每 chunk `armStall()` 重置 · `wrappedController` 所有终止路径 `clearStall()`）。**Layer B/C 直接对标。** |
| `F:\kiro-rs` | ✅ 命中 `src/anthropic/compressor.rs` + **`src/anthropic/tool_compression.rs`**（独立的 tool 压缩模块 · Layer B 可交叉参考）+ `model/config.rs` 压缩配置分层 |
| `F:\kiro-manager-lite` | ⏳ 本轮未检索（Layer B/C 真源已足） |
| `F:\Kiro-Go-main` | ⚠️ fast-context 只返回仓根 `L1-10`，未定位到 Go 源码（疑空壳/结构异常）。KiroStudio 的 truncate.rs 注释已完整转述 kiro-go `proxy/translator.go:truncatePayloadToLimit` 的策略，等价覆盖 |

### 存在性闸门（Pre-write check · §2.6）

`git grep -nliE "rtk|compressToolResult|stallTimeout|watchdog|ensurePayloadUnderSize" -- src/ test/` → 7 文件命中但**全部是既有 hold-gate / config 命名巧合**，无一是本轮三层能力；`git ls-files src/main/proxy/`（19 文件）确认无 `rtk/`、无 `contextTruncate.ts`、无 `streamWatchdog.ts`。**Duplicate: no → 可创建。**

### 执行方式（用户 2026-08-09 指定）

- **Mode C**：worktree `F:/Kiro-account-manager/Kiro-account-manager/.worktrees/proxy-safety-net/main` · branch `feat/proxy-context-safety-net`（已建 · `git worktree list` 实证）
- **交付范围**：完整三层 A+B+C（用户明确选 ④）
- **主 AI 职责边界**：契约 / 编排 / tasks 维护 / 冲突处理 / 验收；**不亲手大改业务代码**（防长任务会话漂移）。实现由多 SUB 并行承担，英文派单。
- **并行纪律**：不串行等待；阶段完成即派 review SUB，同时推进下一波；按文件冲突面拆分 SUB。

**下一步**：Task 3 introspection（硬门）与 Task 4/5/6 三层实现并行推进 —— 三层文件互不重叠（`streamWatchdog.ts` / `contextTruncate.ts` / `rtk/**`），可同 worktree 并行；接线（`kiroApi.ts`）是共享文件，必须串行收口由单一 SUB 统一做。

---

## Update Log · v4 实现中重大修订：Layer A 方向被本仓实测证据否掉（2026-08-09 · SUB 上报 + 主 AI 亲验）

**触发**：Layer A executor SUB 拒绝按卡实施并上报前提冲突。主AI 独立亲验（不采信 SUB 自述 · E-100），**两项全部为真**，其中第 2 项是决策卡的**根本性方向错误**。

### C1 · 派单路径错一层（主 AI 自身错误 · 已纠正）

- 实测 `git rev-parse --show-toplevel` = `F:/Kiro-account-manager`，**仓库根比原以为的高一层**；项目目录（含 `src/` `package.json` `test/main/`）在其下 `Kiro-account-manager/`。
- worktree 内正确项目路径：`.worktrees/proxy-safety-net/main/Kiro-account-manager/`（`Test-Path .../main/Kiro-account-manager/src/main/proxy/kiroApi.ts` = True；`.../main/src` = False）。
- 已向 3 个在跑 SUB 发路径纠正。**教训**：派单前未亲验目标路径下 `src/` 是否存在，只凭「我以为的仓库根」。

### C2 · Layer A 已存在（决策卡 §2「已有能力」表漏项 · 主 AI 检索缺口 P-13）

- `kiroApi.ts:1613-1616`：出站前**已主动**按 token 裁历史 —— `if (enableTokenBufferReserve) { trimHistoryByTokens(payload, getEffectiveTokenLimit(modelId)) }`
- `kiroApi.ts:112`：`let enableTokenBufferReserve = true` —— **默认开启**，不是关闭
- `kiroApi.ts:133-138`：`getEffectiveTokenLimit` = 模型 ctx − `tokenBufferReserve`(默认 20K)
- `kiroApi.ts:1622-1660`：**第二阶段已有字节截断** —— `TOOL_RESULT_TRUNCATE_LENGTH = 4000` 头切 + `[Truncated by proxy: original N chars]` 标记，`HARD_TRIM_CEILING_KB = 4608` 门控
- `test/main/proxy/contextTrimGuard.test.ts`：4 tests 已存在（SUB 实跑 4 passed），第 4 条即「切口不留 orphan toolResult」
- **决策卡 §2 内部能力表把这两个既有阶段全漏了**，导致 §1 成功状态①「反代发送前主动前置一次丢历史」被当成待建能力 —— 它已经在跑。
- **根因（我的）**：上一轮存在性检索按 `rtk|compressToolResult|stallTimeout|watchdog|ensurePayloadUnderSize` 即**我自己预设的命名**搜，而非按**能力**搜（「主动裁剪」「trim before send」「payload size limit」）。正是 P-13 母题：按命名搜 → 假阴性。§2.6 pre-write 闸门形式上过了，实质失效。

### C3 · 900KB 字节阈值是本仓两次实测否掉的方向（最严重 · 必须废弃）

`kiroApi.ts:104-108` 与 `:1626-1636` 两处注释记录**受控对照实测**（§0.14 Gate 3 意义上的「改一变量看翻转」）：

```
claude-opus-5   1,792,972 B (ctx 1,000,000) → 200 OK
gpt-5.6-sol       945,144 B (ctx   272,000) → 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD
```

**1.79MB 通过而 0.92MB 被拒 ⇒ Kiro 判限维度是模型 token context window，不是 payload 字节数。**

同段注释记录两次错误方向：① v1.7.5 把上限提到 150MB（基于误解，trim 只截 `tool_result.content[].text` 根本不碰 images）；② 随后压回 1536KB —— **方向同样错**，因为会去裁那个本来能成功的 1.79MB 请求，白白改写历史 → 破坏 prompt cache 的 prefix 逐字节匹配（commit `727be0b`）→ **credit 涨回 5 倍**。故现字节硬顶特意设为 `HARD_TRIM_CEILING_KB = 4608`（4.5MiB · 对齐 kiro-rs `src/model/config.rs` 实测 ~5MiB 才 400）。

决策卡 `MAX_PAYLOAD_BYTES = 900*1024` **比既有硬顶低 5 倍、且低于实测能过的 1.79MB**。来源是 KiroStudio / kiro-go 经验值 —— **另一个上游形态**下的数字，属 §0.14 **Gate 4「证据不跨环境外推」**。本仓已在自己环境跑过受控对照，**本仓证据优先于参考仓经验值**。

⛔ **裁决（用户 2026-08-09）：Layer A 改为「收进既有函数做小增量」，废弃 `contextTruncate.ts` + `ensurePayloadUnderSizeLimit` + 900KB 阈值。** 决策卡 §3 Layer A 契约、§4.1 A1-A9 测试边界中的 byte 语义部分（A2/A8）**全部作废**。

### C4 · 修订后的 Layer A 真实缺口（只剩两个 · 都小）

1. **无占位说明**（真缺口）：现有 trim 静默丢历史，模型不知前文被省略 → 可能重复提问或凭空推断。移植 `TRUNCATION_PLACEHOLDER` + assistant ack（上游要求严格 user/assistant 交替，占位 user + tail 也以 user 开头 → user+user → 400）。本仓已有 `HELLO_MESSAGE`/`CONTINUE_MESSAGE`/`UNDERSTOOD_MESSAGE`（`kiroApi.ts:1004/1008/1012`），`UNDERSTOOD_MESSAGE` 疑可直接复用作 ack 位（避免第二 SSOT）。
2. **非原子**（真缺口 · 轻）：`trimHistoryByTokens` 在循环内逐轮 `payload.conversationState.history = history` 写回，中途抛异常留下「裁一半」payload。改本地累积 + 末尾一次性 swap。诚实边界：它只重赋数组、不深改消息对象，实际风险低于原卡描述。

### C5 · 交替性规范化落差（新发现 · 影响占位实现）

- 完整 sanitize 链（`ensureAlternatingMessages` 等，`kiroApi.ts:1400-1407`，定义 ~`:1098`）跑在 **trim 之前**，作用于 `sanitizedHistory`。
- trim 之后**只调** `ensureStartsWithUserMessage`（`:1467`），**未**再跑 `ensureAlternatingMessages`。
- 当前不出问题是因为 trim 只在已交替序列上按步长 2 切 + 补首条 user —— 交替性**被动保持**。
- **一旦插入占位对（user+assistant）就是在动这个不变量**，必须自己显式保证交替，不能指望 trim 内部兜底。
- 反应式路径 `:2196` 同样只调 `trimHistoryByTokens`，同一落差；且它会**继承**占位行为，需判断是否正确。

### C6 · Layer B 的既有前身（影响 Layer B 定位）

`kiroApi.ts:1622-1660` 的 4000 字符头切就是 Layer B 的**粗暴前身**：同一目标数据、同一嵌套路径（`toolResult.content[].text`）。Layer B（RTK 4 过滤器）是它的智能替代。已要求 Layer B SUB 一并回答：替代 or 并存 / 是否共用 4.5MiB 门 / 两种标记（`[Truncated by proxy: ...]` vs `[rtk-compressed:<filter>]`）的用户可见差异。

### 修订后本轮真实交付范围

| 层 | 原卡 | 修订后 |
|---|---|---|
| **A** | 新建 `contextTruncate.ts` + 900KB 字节触发 | ⛔ 废弃。改为在既有 `trimHistoryByTokens`（`:1424`）内加**占位说明 + 原子 swap**，触发维度不变（token/ctx） |
| **B** | 新建 `rtk/**` 4 过滤器 | ✅ 不变（是既有 4000 字符头切的智能替代） |
| **C** | 新建 `streamWatchdog.ts` | ✅ 不变（唯一三项前提全部经核实成立的层） |

**Layer C 是唯一未被证据推翻的层** —— 死等问题（Anthropic SDK #867 形态）本仓确实无任何防护。

---

## Update Log · v5 实现进度（2026-08-09 · 主 AI 独立复核，非采信 SUB 自述）

### 复核纪律说明

以下每条「验证」均为**主 AI 亲跑**（E-100 安全网 / P-01 测试绿≠真达标）。SUB 自报的绿灯一律不作为交付依据，只作为「值得去复核什么」的线索。

### ✅ Layer C · streamWatchdog（建成 · 未接线）

- 文件：`src/main/proxy/streamWatchdog.ts` 298 行 + `test/main/proxy/streamWatchdog.test.ts` 325 行
- **主 AI 亲跑**：`npx vitest run test/main/proxy/streamWatchdog.test.ts` → `Test Files 1 passed | Tests 9 passed` · **EXIT=0**（stderr 可见 stall 真触发并打出自解释 message，如 `upstream_stream_stall: no data for 30s after 3 chunks (9B) [inter_chunk] — upstream aborted`）
- 覆盖 C1-C7 + 新增 C5b（下游取消路径清理计时器）+ 常量默认值断言
- **⛔ 接线状态 = 零**。`Select-String -Path "src\main\proxy\*.ts" -Pattern "streamWatchdog|wrapStreamWithStallDetection"` → 唯一命中都在 `streamWatchdog.ts` 自身（定义 + 日志行），`kiroApi.ts` **零命中** ⇒ **当前是死代码（E-052 形态）**。故本层状态只能记「模块建成 + 独立复核通过 + 未接线」，**不得声明达标**。
  - 注：`git grep` 对未跟踪新文件是盲的（E-130），故此处用文件系统级 `Select-String` 复核，非 git 索引。
- **SUB 独立验证并确认了 v3 的 D2 判断**：不可对 `callKiroApiStream` 的 `signal` 调 `.abort()` —— 那会伪造「客户端已取消」事件；`parseEventStream` 也从同一 signal 派生自己的 abort 路径（`getAbortError(signal)` at `:2500`）。必须新建 linked controller。
- **SUB 新发现（我未预见）**：`isRetriableNetworkError`（~`:1900`）目前**不匹配** `upstream_stream_stall` ⇒ 接线时必须**显式决定**：stall 喂给端点链重试，还是直接透传客户端。
  - 主 AI 倾向**直接透传**，理由：① stall 意味着上游已开始发数据又停（客户端可能已收到部分内容），换端点重发 → 重复输出；② 已等过 6 分钟，再走三端点链 = 让用户再等 ~18 分钟。**待接线波次连同 recon 结论一起定案。**

### ✅ Layer B · RTK（建成 · 未接线）

- 文件：8 源（`rtk/{index,constants,autodetect,applyFilter}.ts` + `filters/{gitDiff,smartTruncate,readNumbered,grep}.ts`，共 514 行）+ 6 测试（622 行）
- **主 AI 亲跑**：
  - `npx vitest run test/main/proxy/rtk/` → `6 files passed | 44 tests passed` · **EXIT=0**
  - `npx vitest run --project main`（全量回归）→ `87 files passed | 942 passed | 5 skipped | 0 failed` · **EXIT=0**
  - `git diff --stat -- src/main/proxy/kiroApi.ts` → **空输出**，证实 `kiroApi.ts` 一字节未改（SUB 自述得到独立印证）
- filterName SSOT 在 `constants.ts` 的 `FILTERS` 常量：`git-diff` / `smart-truncate` / `read-numbered` / `grep`；前缀格式 `[rtk-compressed:git-diff]\n`（**进真实请求体，非装饰**）
- **⛔ 接线状态 = 零**（同上扫描，`kiroApi.ts` 零 `compressToolResults` / `from './rtk` 命中）

#### SUB 的两处判断优于主 AI 派单（记录下来，派单错误归主 AI）

1. **拒绝复用 `kiroApi.ts:877` 的 `clonePayload`**。主 AI 派单要求「复用，或加 `export`」——**该指示是错的**：RTK 是叶子模块，接线方向是 `kiroApi → rtk`，反向 import 会造成**循环依赖**，且把 4000 行模块的副作用拖进单元测试。SUB 改为内联 3 行结构化克隆，`kiroApi.ts` 保持零改动。**采纳 SUB 判断。**
2. **`bytesIn` 用 `Buffer.byteLength(text,'utf-8')` 而非 9router 的 `.length`**。`.length` 是 UTF-16 code unit，CJK 工具输出下少算约 3 倍 → 一个 40K 字符 / 120K 字节的块会漏过阈值。被防守的是**字节**上限，故必须用字节口径。**采纳。**

#### 其他偏离参考实现之处（均有理由）

- **`currentMessage` 不入遍历表**（9router 的 `compressKiroFormat` 会 push 它）—— B8/B8b 锁死：`currentMessage` 里 500KB 的 tool_result 在周围 history 被压的同时保持逐字节不变
- **原子性无法用就地修改达成**：9router 直接改 `body` 并在抛错时返回 `null`，但那时前半段已被改写。B5b 是真正的考题 —— 用一个中途抛错的 `text` getter，断言**第一条**（已成功压缩的）tool_result 仍是原文；无拷贝式设计该测试必失败
- **前缀开销计入收缩判定**：`+= prefix` 发生在与 `bytesIn` 比较**之前**，故一个省得比前缀开销还少的过滤器会正确回退原文，不会让 payload 变大
- **autodetect 从 12 个裁到 4 个并重排**：`git-diff` 必须排在 `grep` 前 —— 一个改动日志行/测试断言的 diff 内含 `src/x.ts:12:boom` 形态文本，grep 优先会撕碎 hunk 结构（`gitDiff.test.ts` 用刻意刁钻的 fixture 锁死）。另丢掉 9router 置于 `smartTruncate` 前的 `dedupLog` 兜底 —— 不在范围内，且其缺席使通用多行噪声落到 `smartTruncate`，行为更安全
- **`countLines` 扫字符码不物化数组**：`text.split('\n')` 在 10MB blob 上会再分配一份副本

### ⏳ Layer A · 小增量（重派后在跑）

范围已按 v4 裁决收窄：在既有 `trimHistoryByTokens`（`:1424`）内加**占位说明 + 原子 swap**，触发维度不变（token/ctx），**不引入任何字节阈值**。

### ⏳ 接线 recon（在跑 · 已发修订：删作废问题 3/4，加交替性落差 + 占位常量复用两问）

### 📌 三层截断的最终顺序（Layer B SUB 独立确认，与 v4 C6 一致）

本仓实际存在**三**个截断/压缩阶段，接线顺序必须是：

```
RTK 形态感知压缩(Layer B · 新)
  → token 级整条历史裁剪(trimHistoryByTokens · 既有 :1613)
    → 字节级 tool_result 盲切(既有 :1638 · 4000 字符头切 + [Truncated by proxy] 标记)
```

理由：先压可能就不必丢；RTK 放最后 = 在压缩已被丢弃的内容。接线点须在 history 组装完成之后、size/token 检查之前（`buildKiroPayload` 内，`:1638` 之前）。

`compressToolResults` **原地改**传入的 payload（单次赋值 `conversationState`）并返回 stats，**不返回新 payload**。`{applied:false, reason:'error'}` **不是需要传播的失败** —— payload 未动，log 一行继续即可（`formatRtkLog(stats)` 已导出）。

### ⚠️ 需在 e2e 阶段盯的主风险（Layer B SUB 提出，主 AI 认同）

**prompt cache 交互**：压缩 history 会重写上游做 prefix 匹配的字节。50KB 阈值使其罕见，但一个会话在中途跨过阈值时会吃**一次** cache miss。这正是阈值不能更低的原因 —— 与 `kiroApi.ts:1625` 注释记录的 `727be0b` 教训（改写历史 → 破 prefix 匹配 → credit 涨 5 倍）同源。

---

## Update Log · v6 异构评审处置（sonnet reviewer · 2026-08-09）

**评审**：`reviewer` sub · sonnet（异构:实现者为 opus,避免同模型盲区互认）· read-only · 7 Phase
**VERDICT**：`status: NEEDS_CHANGES · critical=5 · important=1 · minor=0 · ready_to_merge: NO`
**评审独立复核的基线**（与主 AI 读数一致）：`npx vitest run` → 106 files / 1106 passed / 5 skipped / EXIT=0；`tsc --noEmit -p tsconfig.node.json` EXIT=0；`git diff --check` EXIT=0

### 三步过筛处置（①真伪 ②比重 ③根因）· 逐条

| # | 评审意见 | 处置 | 依据 |
|---|---|---|---|
| **C1** | Layer A 插占位对后不再收敛预算 → 可返回仍超 `maxTokens` 的 payload | 🟢 **采纳·已派修** | **主 AI 亲验为真**：`kiroApi.ts:1522-1535` 插入 `TRUNCATION_PLACEHOLDER_MESSAGE` + `UNDERSTOOD_MESSAGE` 后直接写回返回,循环的预算判据只覆盖「插占位前」的形态。`ensureAlternatingMessages` 还可能再注入 filler,同样未计量。⇒ 安全网在最需要它的边界(刚好卡线)上失效,正是它要防的 400 |
| **C2** | 最终 `estimatePayloadTokens(payload)` 在写回**之后**才算 → 此处抛错留下已改写的 payload,原子性契约在最后一步破 | 🟢 **采纳·已派修**（并入 C1 同一 SUB） | 真:`:1533-1535` 写回在前、`return { finalTokens: estimatePayloadTokens(payload) }` 在后。既有原子性测试只让异常发生在写回**前**,未覆盖这个提交窗口 ⇒ 测试是真守卫但覆盖有洞 |
| **C3** | Layer C 在无 pending read 时武装 stall timer → 下游背压误杀健康流 | 🟢 **采纳·已派修** · ⚠️ **主 AI 曾误判此条为误报,实测后推翻自己** | 详见下方「主 AI 判断错误记录」 |
| **C4** | 决策卡约 20 个 `[x]` 无 `**Evidence**` 块（缺 commit / verify→EXIT / files:line / AC 四项） | 🟢 **采纳·工件债** | 真。主 AI 自身工件纪律缺失,非代码缺陷。收尾补齐 |
| **C5** | 正文 + link table 仍要求 900KB trigger / `contextTruncate.ts` / `ensurePayloadUnderSizeLimit` / `PLACEHOLDER_ACK`,与 Update Log 宣布的作废互相矛盾 | 🟢 **采纳·本节即处置** | 真且要紧:同一工件同时描述两套互斥交付契约,后续 SUB 会按不存在的文件验收。**根因是主 AI 把修订只追加在 Update Log、未回头改正文** ⇒ 见下方「§正文对齐」 |
| **I1** | Layer B `B5b` 是**假守卫**:抛错的 `text` getter 在 `hasCandidate()` 预扫阶段(`rtk/index.ts:60`)就炸,clone(`:62`)与压缩循环(`:65-73`)从未执行 ⇒「第一条仍是原文」只因什么都没发生,证明不了 copy-then-swap | 🟡 **采纳但不阻塞合并** | 真。这正是主 AI 派评审时点名要它查的东西(「测试是真守卫还是被塑造成能过」),它查出来了。补法:用可注入的 filter 在**副本循环处理第二项时**故障,才能证明第一项已在副本中变换而原 payload 逐字节未变。下一波补,不阻塞 |

**0 rejected · 0 deferred-as-noise**。评审 5 critical 全部为真 —— 这一轮异构评审的信噪比极高,值得记录。

### ⚠️ 主 AI 判断错误记录（C3 · 我读代码驳回,实测推翻自己）

**我的初判**：误报。理由是 `streamWatchdog.ts:257-259` 的 `armWait()` 明确位于 `pull` 内、`await r.read()` 前一行,且注释写明「只在真正等待上游字节期间武装计时器:下游背压导致 pull 被延后,不会被误判成上游静默」。我推理:下游不读 → 不进 `pull` → timer 不武装。

**我没有只凭读代码就驳回**（§0.20:HOLD 的依据必须是本轮真跑过的工具输出,不是复述推理）。写探针走**真实消费路径**(`getReader()` + 下游故意延迟 120ms 才首读 + `stallTimeoutMs:40` + 上游立即给 1 healthy chunk 后保持连接):

```
[StreamWatchdog] upstream_stream_stall: no data for 0s after 1 chunk (1B) [inter_chunk] — upstream aborted
{"aborted":1,"chunksDelivered":[],"outcome":"StallError: upstream_stream_stall: ..."}
```

**评审对,我错。** `chunksDelivered:[]` 是要害:一个健康字节已到手,客户端却收到错误。

**我的推理漏在哪**：`armWait()` 在 `start()`(`:243-249`)里**也**调了一次 —— 刻意为之,让首字节超时从「拿到响应头、开始等 body」起算而非从下游首次 pull 起算 —— 而 `start()` 在流构造时**立即**执行,不等下游拉取。首个 chunk 到达后 `pull` 再 `armWait()` 然后 `enqueue` 入队;此时下游尚未来读,40ms 到期即误判。**timer 实际覆盖的是「chunk 在内部队列等下游消费」的时间,不是「等上游字节」的时间。** `no data for 0s` 这个读数本身就是「计时器量错区间」的签名 —— 距上次上游数据零时间流逝却判静默。

那句「下游背压不会被误判成上游静默」的注释**目前是假的**。派修时已要求:修完后文件里每条注释必须仍然为真,且**禁止用钝化探测器的方式消除误报**(真 stall 必须仍能抓到,否则「修好」可以靠永不武装蒙过去)。

**教训（候选 error-journal 条目)**：注释宣称的不变量 + 我自己的代码路径推理,双双不足以驳回一条**带运行态输出**的评审意见。对方给了读数,我只给了推理 —— 举证等级不对等。P-02(判定器/仪器本身不可信)的对偶形态:**我的「代码阅读」也是一种仪器,它看不见构造期副作用与调度交错**。

### 用户裁决（2026-08-09 · 白话确认后）

1. **两个修复落地**（非叫停、非只合干净部分）。理由:两处都是「保护在边界上失效 / 反而搞坏正常请求」,不修不能交。
2. **裁不下时保留说明、如实报超限**（原为 SUB 自主设计选择,现由用户拍定）：当已裁到保护下限、连占位对都塞不进 `maxTokens` 时,**不得为凑进预算而丢弃占位**。宁可请求被上游拒绝并给出可读错误,也不让模型以为上下文是完整的 —— 不知道前文被省略的模型会重复追问已答过的事,或凭空推断缺失上下文。占位是承重的,不是装饰。已发给对应 SUB,并要求返回值区分「现在装得下」与「已裁尽仍超」,附测试钉住,不得报成功。

### §正文对齐（处置 C5 · 以下为当前唯一有效契约,正文旧描述作废）

⛔ **本节覆盖前文 §1 成功状态①、§3 Layer A 契约、§4.1 A1-A9、§3 Link table 中一切与 Layer A 相关的描述。** 前文那些段落保留仅为演进记录,**不得作为验收依据**。

**Layer A 当前真实形态**（唯一有效）：

| 项 | 值 |
|---|---|
| 交付物 | **无新文件**。增量落在既有 `src/main/proxy/kiroApi.ts` 内 |
| 新增符号 | `TRUNCATION_PLACEHOLDER`(exported) · `TRUNCATION_PLACEHOLDER_MESSAGE` · `isTruncationPlaceholder()` — 位于 `:1016-1027`,紧贴既有 `HELLO_MESSAGE`/`CONTINUE_MESSAGE`/`UNDERSTOOD_MESSAGE` 常量组 |
| 改造函数 | `trimHistoryByTokens`(`:1449` · 加 `export` 仅为测试可达) |
| **触发维度** | **token / 模型 context window**（既有 `getEffectiveTokenLimit` = ctx − buffer）。⛔ **无任何 payload 级字节阈值** |
| 作废符号 | ~~`contextTruncate.ts`~~ · ~~`ensurePayloadUnderSizeLimit`~~ · ~~`TruncationResult`~~ · ~~`MAX_PAYLOAD_BYTES = 900*1024`~~ · ~~`PLACEHOLDER_ACK`~~(改复用既有 `UNDERSTOOD_MESSAGE:1012`,避免同一语义两个真源) |
| 生产 caller | `kiroApi.ts:1679`(主动路径 · `buildKiroPayload` 内)+ `:2259`(反应式 recovery 路径) — **均为既存调用点,本轮未新增接线** |
| ack 复用理由 | `UNDERSTOOD_MESSAGE` 本就是 `ensureAlternatingMessages:1107` 用于处理 user+user 的填充 ack,与占位后所需是同一语义同一场景。上游参考项目另定常量是因其无等价物可用 |
| 交替性收口 | 复用既有 `ensureAlternatingMessages` + `ensureStartsWithUserMessage`,**不手工维持**（手工维持 = 把该 helper 逻辑复制到第二处 = 第二个 SSOT） |
| 裁不下时语义 | **保留占位 + 如实报超限**（用户裁决 · 见上）· 不得报成功 · 不得为凑预算丢占位 · 必须终止不得空转 |

**Link table（Layer A · 修订版 · 全部为 existing 节点,零待建）**：

| Node | Producer | Consumer | Consumption Result | Failure |
|---|---|---|---|---|
| `TRUNCATION_PLACEHOLDER_MESSAGE` | `kiroApi.ts:1016-1027` | `trimHistoryByTokens:1449` 内插入点 | 进 history 首段,模型读到并知晓前文被省略 | 无(编译期常量) |
| `trimHistoryByTokens` 增量 | `kiroApi.ts:1449-1538` | `:1679` 主动 + `:2259` 反应式 | history 变小且带留痕;裁不下时如实报超限 | 循环中途抛错 → 单次写回未执行 → payload 原样(原子性) |
| `isTruncationPlaceholder` | `kiroApi.ts:1016-1027` | 同函数内去重逻辑 | 多轮裁剪后恒只有一对占位 | 无 |

**prompt cache prefix 稳定性**（评审列为 Strength,主 AI 认同并记录判据）：① 裁剪仅在 `currentTokens > maxTokens` 时进入循环,未超限时 `totalTrimmed === 0` 早返回**连 payload 都不写**（被「未触发裁剪时 payload deep-equal 不变」测试锁住）② 占位文本是**编译期常量**,不含时间戳 / 计数 / 被丢弃条数等每次不同的内容 ⇒ 同一裁剪状态下重复请求 prefix 逐字节相同 ③ 连续裁剪时占位不叠加（去重保证恒一对）⇒ prefix 不随裁剪轮次单调漂移。真正会破稳定性的是 `727be0b` 那种「本来能成功的请求也被改写」,本轮**未降低任何阈值、未扩大裁剪触发面**。

### 既有性能特征（Layer A SUB 报告 · 未改 · 主 AI 判定不登记为架构债）

`trimHistoryByTokens` 每轮迭代 `JSON.stringify` 整个 payload 估算 → 长历史 + 上百次迭代下是 O(n²) 字节开销。**属既有特征,本轮未使其变差**（改为本地试算闭包后语义等价）。不在本轮范围。若后续优化,正确做法是增量维护条目尺寸而非每轮全量序列化。**不登记为架构债的理由**:它不是本轮引入的,且 `.archive` 决策卡不是架构债册的真源 —— 若要登记应进 `ARCHITECTURE.md` 技术债段,而本仓是否有该文件需收尾时确认。

---

## 任务清单 · Evidence 补齐（处置评审 C4 · 2026-08-09 · 主 AI 亲跑读数）

⛔ **本节覆盖前文 §任务清单 中 Task 1-11 的勾选状态。** 前文那份清单的 `[x]` 缺 Evidence 块,按 Task-Ledger Evidence Gate 属不可审计的完成声明。以下为唯一有效状态。

**Evidence 四项契约**：`commit` + `verify: <cmd> → EXIT=<code>` + `files: <path:lines>` + `AC: <requirement-ref>`。本轮**尚未 commit**,故所有 `commit` 字段值为 `pending`（合法值,非缺失）。所有 `verify` 读数均为**主 AI 亲跑**,非 SUB 自述。

### 已完成（带 Evidence）

- [x] **1. Recon + 决策卡 v1/v2 落盘**
  - **Evidence**: `commit pending` · `verify: 文档存在性 Test-Path → True` · `files: .archive/2026-08-09/proxy-context-safety-net/decision-card.md` · `AC: §1 决策卡产出`
- [x] **2. 单轮 codex 工件评审（模板 F）**
  - **Evidence**: `commit pending` · `verify: 评审产物落盘 → decision-card.review1.codex.md 存在` · `files: 同目录 review1` · `AC: 异构工件评审闸门` · 结果 `NEEDS_CHANGES p0=3 p1=7 → 10 条全采纳 → v2`
- [x] **4. Layer C · streamWatchdog 模块建成**
  - **Evidence**: `commit pending` · `verify: npx vitest run test/main/proxy/streamWatchdog.test.ts → Test Files 1 passed | Tests 9 passed | EXIT=0`（主 AI 亲跑 22:22:33） · `files: src/main/proxy/streamWatchdog.ts:1-298 · test/main/proxy/streamWatchdog.test.ts:1-325` · `AC: Success State ③ + I5`
  - ⚠️ **该项当时状态 = 模块建成但零接线**（FS 级扫描 `kiroApi.ts` 零命中 ⇒ E-052 死代码形态）· 接线见 Task 12
- [x] **6. Layer B · RTK 模块建成**
  - **Evidence**: `commit pending` · `verify: npx vitest run test/main/proxy/rtk/ → 6 files passed | 44 tests passed | EXIT=0`（亲跑 22:39:20）· `verify: npx vitest run --project main → 87 files | 942 passed | 5 skipped | 0 failed | EXIT=0` · `verify: git diff --stat -- src/main/proxy/kiroApi.ts → 空输出`（证实当时 kiroApi.ts 一字节未改） · `files: src/main/proxy/rtk/{index:173,constants:59,autodetect:64,applyFilter:23}.ts + rtk/filters/{gitDiff:92,smartTruncate:23,readNumbered:26,grep:54}.ts + test/main/proxy/rtk/*.test.ts(6 files 622 lines)` · `AC: Success State ② + I3 + Must NOT 反例(B8 currentMessage 不压)`
  - ⚠️ 同上,当时零接线
- [x] **5'. Layer A · 收进既有 trimHistoryByTokens 的小增量**（替代原 Task 5 · 原 byte 版作废见 v4）
  - **Evidence**: `commit pending` · `verify: npx vitest run test/main/proxy/contextTrimGuard.test.ts → Test Files 1 passed | Tests 10 passed | EXIT=0`（亲跑 22:48:29） · `verify: npx vitest run → 106 files | 1106 passed | 5 skipped | 0 failed | EXIT=0` · `verify: npx tsc --noEmit -p tsconfig.node.json → EXIT=0` · `verify: git diff --stat -- kiroApi.ts → 69 insertions(+), 6 deletions(-)`（改动窄,符合要求） · `files: kiroApi.ts:1016-1027(常量) + :1449-1538(trim 改造) · test/main/proxy/contextTrimGuard.test.ts(+163)` · `AC: Success State ① + I1/I2/I6`
  - **原子性测试经受控验证**（非假绿）：实现者把 `payload.conversationState.history = history` 临时塞回循环内重跑 → `Tests 1 failed | 9 passed`,唯一失败者正是原子性那条;移除后恢复全绿 ⇒ 该测试是真守卫
- [x] **10'. 异构 reviewer 独立复核（sonnet · read-only · 7 Phase）**
  - **Evidence**: `commit pending` · `verify: reviewer 独立复跑基线 npx vitest run → 1106 passed | EXIT=0 · tsc EXIT=0 · git diff --check EXIT=0`（与主 AI 读数一致） · `files: 本决策卡 v6 段` · `AC: Globalrules §1 异构评审闸门`
  - 结果 `critical=5 important=1` → 三步过筛 **5 critical 全为真 · 0 rejected** → C1/C2/C3 派修 · C4 本节处置 · C5 v6 §正文对齐处置 · I1 延后不阻塞

### 进行中

- [ ] **12. 接线收口（Layer B/C 进生产路径 + 单一总开关）** — ⏳ 执行中
  - 已观测（FS 级扫描,未跟踪文件安全）：`kiroApi.ts:30-31` import 两层 · `:132-137` `enableProxyContextSafetyNet` 模块级 let + set/get · `:1718-1719` Layer B 调用点 · `:2709-2710` Layer C wrap 点
  - **待验**：两个 `parseEventStream` 调用点（`:2133` 正常 + `:2259` 重试）是否都被覆盖 —— 当前仅见一处 wrap,须确认是「下沉进 parseEventStream 内部」（一处即足且结构上无法漏）还是漏了重试路径
  - **待验**：开关未加在 `trimHistoryByTokens` 函数入口（否则连带关掉 `:2196` 无条件反应式路径 → 回归 2026-07-26 RCA 修掉的 400 缺陷）
  - **待验**：linked AbortController 覆盖全部 fetch 重入路径（端点 fallback / 429 / 溢出恢复 / 内容过滤 / thinking-signature）
  - **待验**：`StallError` 不得命中 `isTransientNetworkError`（`:1888` 正则含 `terminated` / `fetch failed`,被 abort 的 fetch 很可能正好抛这两者之一 → 静默滑进重试链）
- [ ] **13. C1+C2 修复：预算收敛 + 提交窗口原子性** — ⏳ 执行中（含用户裁决:裁不下时保留占位、如实报超限）
- [ ] **14. C3 修复：背压误计为上游静默** — ⏳ 执行中（禁止用钝化探测器方式消除误报）

### 未开始

- [ ] **15. I1 补修：Layer B `B5b` 假守卫**（抛错发生在 `hasCandidate()` 预扫阶段,clone 与压缩循环从未执行 ⇒ 证明不了 copy-then-swap）· 不阻塞合并
- [ ] **16. 清理工作树临时文件** — 接线 SUB 遗留 9 个：`.tmp-del.ps1` `.tmp-flag-block.txt` `.tmp-linked.txt` `.tmp-rtk-block.txt` `.tmp-splice{,2,3,4}.ps1` `.tmp-ui-block.txt` + `test/main/proxy/_probe.test.ts`。**绝不可进提交**
  - ⚠️ 观察：该 SUB 用 PowerShell 脚本拼接代码块落盘 —— 命中本机 C-016 / §2.0 高风险手法（非 ASCII 载荷过 shell 边界会被静默改坏）。收尾须核验被拼接文件的编码与内容完整性,不能只看测试绿
- [ ] **17. 全量回归 + typecheck 复核（主 AI 亲跑,不采信 SUB 自述）**
- [ ] **18. 二轮异构评审（修复后复审 C1/C2/C3 是否真闭环）**
- [ ] **19. Commit + CHANGELOG/ARCHITECTURE 写回 + error-journal 判定**

### 作废（v4 裁决 · 保留仅为演进记录）

- ⛔ ~~Task 5 原版：新建 `contextTruncate.ts` + `ensurePayloadUnderSizeLimit` + `MAX_PAYLOAD_BYTES = 900*1024`~~ — 本仓受控对照实测证明 Kiro 判限维度是 token context window 而非 payload 字节（1.79MB 过 / 0.92MB 拒）,且 900KB 低于既有硬顶 5 倍,落地即回归 `727be0b`（破 prompt cache prefix → credit 涨 5 倍）
- ⛔ ~~Task 3 introspection Gate~~ — 前置条件已变：该 gate 的触发前提是「3 P0 全采纳修订后进 tasks.md」,而本轮走的是 artifact 变体（无 spec 三件套）。收尾时若判定本轮有可泛化 AI 侧教训,直接走 §9.2 error-journal 写入（见 Task 19）,不另产 introspection 文档

---

## Update Log · v7 验证能力边界（2026-08-09 · 诚实契约 §4.6 · 主 AI 主动声明）

### 本仓无集中式写回目标 —— §9.1.1 三层写回不适用

亲验三处均为空：
- `F:/Kiro-account-manager/`（仓库根）：无 `ARCHITECTURE.md` / `CHANGELOG.md` / `AGENTS.md`
- `F:/Kiro-account-manager/Kiro-account-manager/`（项目目录）：同上,无
- `F:/Kiro-account-manager/docs/`：**仅** `E2E-TESTING.md` 一份

⇒ §9.1.1「artifact update-log → `docs/changelog/CHANGELOG.md` → 根 `ARCHITECTURE.md` 演进索引」三层写回的**前提不成立**（该规则前提是仓库已建成这些集中式真源）。本轮记录归宿 = **本决策卡 + conventional commit message**。这也与本仓既有提交风格一致（历史提交为纯 conventional commit,无 changelog 引用）。

**不新建这些文件**：本轮是 feature-remediation,不是仓库标准接入;为一次交付新建三个仓库级真源属 §0.17 D 类（技术整洁冲动）。若后续要接入,应作为独立决策。

### ⚠️ 验证能力边界（硬边界 · 主 AI 无法代用户完成的部分）

读 `docs/E2E-TESTING.md` 后确认：本仓 e2e 套件（30 case · `npm run test:e2e` · 独立于 vitest）的**前置条件是主 AI 无法满足的**：

```
1. 启动 Kiro Account Manager 开发模式: npm run dev   ← 需 Electron GUI 进程
2. 反代默认监听 http://127.0.0.1:8787
3. 至少有一个可用账号 (订阅未超额)                    ← 需用户真实账号 + 额度
```

⇒ **决策卡 §1「Verified once by」的三独立验收门（Layer A/B/C 各自的客户端可见结果）本轮无法由主 AI 完成。**

| 验收项 | 谁能做 | 状态 |
|---|---|---|
| 单元测试（三层各自 + 回归） | 主 AI | ✅ 已亲跑（读数见 §任务清单 Evidence） |
| 全量 vitest + typecheck | 主 AI | ✅ 已亲跑 |
| 静态装配闸门（`test/main/architecture/proxy_orchestration_wiring.test.ts` · 治 E-052 死代码） | 主 AI | ⏳ 接线 SUB 补 |
| 异构代码评审（sonnet · 7 Phase） | 主 AI | ✅ 已跑,5 critical 全为真,3 条已派修 |
| **Layer A 门**：真实客户端长会话 → 收到 200 + 完整流 + 日志见占位 | **仅用户** | ⛔ **主 AI 不能做** |
| **Layer B 门**：真实 200KB git diff tool_result → 响应含 `[rtk-compressed:git-diff]` | **仅用户** | ⛔ **主 AI 不能做** |
| **Layer C 门**：真实上游 stall → 客户端在 `stallTimeoutMs` 内收到 `upstream_stream_stall` | **仅用户**（且需真实触发上游静默,不可控） | ⛔ **主 AI 不能做** |
| `npm run test:e2e`（30 case 兼容性回归） | **仅用户**（需 GUI + 账号） | ⛔ **主 AI 不能做** |

**诚实措辞约定（收尾时严格遵守 · §4.6）**：本轮交付只能声明「**单测 + 静态闸门 + 全量回归 + 类型检查全绿,代码路径经异构评审;真实端到端未验证 —— `unverified: 需 GUI 应用 + 用户真实账号额度**」。**禁止**说「已验证」/「已达标」/「三层生效」—— 单测绿 ≠ 真实环境生效（P-01 母题:测试绿 / 门通过 ≠ 真达标 · 真运行时）。

**交给用户的验收清单**（收尾时给出可直接执行的形式）：
1. `npm run dev` 起应用 → 反代面板打开新开关 `enableProxyContextSafetyNet`（默认关,须手动开）
2. 用 Claude Code / Codex 指向反代跑一个**含大工具输出的长任务**（最贴近原始问题场景:SUB 任务返 1800 行 diff）
3. 观察三处：① 是否仍出现任务中途 400 ② 响应/日志中是否出现 `[rtk-compressed:` 前缀与 `[RTK] saved` ③ 是否再出现「卡住不动直到超时」（Layer C 治的正是这个）
4. `npm run test:e2e` 跑 30 case 兼容性回归（确认三层未破坏既有协议兼容）
5. 遇问题按层排障：`KIRO_PROXY_LAYER_B=false` / `KIRO_PROXY_LAYER_C=false` 单独关闭（Layer A 无条件生效,不受开关控制 —— 见 v6 §正文对齐）

---

## Update Log · v8 二轮验证：SUB 结论受控复核 + 发现一个空转闸门（2026-08-09 · 主 AI 亲跑）

### 一、C3「背压误判」—— 我的追加报告是错的，SUB 的 HOLD 成立

我上一轮报告残余缺陷在 `streamWatchdog.ts:292`（`start()` 里 `armWait()` 开窗但无 read 在飞）。**该结论作废。**

**我自己写的受控探针**（唯一变量 = 上游存活性，慢消费者逐字节相同：首读前先睡 120ms = 3×stallTimeoutMs，每次消费间再睡 120ms）：

```
{"label":"s_eof","upstreamKind":"eof","aborted":0,"delivered":[1],"outcome":"completed"}
{"label":"s_more","upstreamKind":"more","aborted":0,"delivered":[1,2,3],"outcome":"completed"}
{"label":"s_hold","upstreamKind":"hold","aborted":1,"delivered":[1],"outcome":"StallError: ..."}
{"VERDICT":"PASS"}   PROBE_EXIT=0
```

同一个慢消费者下：上游 EOF / 多块 → 零 abort、字节全交付、正常收尾；只有真死的上游被掐。**abort 随上游存活性翻转，不随消费者慢速翻转** ⇒ 背压不被误判，且探测器未被钝化。

**我错在哪（记录以免重犯）**：我上一轮只看到 `StallError` 就下判定，没有控制「我那个上游首字节后从未再发任何东西」这一变量 —— 我测的本来就是**真静默**。另外 `no data for 0s` 不是零长度窗口的证据，是 `Math.round(167/1000)` 的渲染取整。

**代码级反证**（SUB 给的、我亲验成立）：`armWait()` 按 `chunkCount === 0` 分流 ⇒ `start()` **只可能**武装 `first_chunk` 计时器；而我的报错是 `[inter_chunk] chunks=1`，在现有代码上从 `start()` 出发不可达 ⇒ 我的归因不成立。

代价：一次 SUB 往返。教训入 §9.2 判定池：**看到失败读数先控变量，再归因** —— 我把「一次未受控观测」当成了缺陷证据。

### 二、接线三点亲验通过

- 两处 `parseEventStream` 调用点（`:2322` 正常 / `:2452` thinking 重试）**都**传了 stall abort 回调
- `onStallAbort` 是**必填位置参数**（排在可选参数之前）⇒ 第三个调用点漏传 = 编译错误，非静默缺口。`npm run typecheck` EXIT=0
- 静默早退按稳定 `code` 判定（`:2072`），非靠 message 侥幸不匹配

**SUB 的一条反驳我亲验成立**：`parseEventStream` 自身 `catch`（`:3709`）调 `onError`（`:3716`）**从不 rethrow** ⇒ `StallError` 结构上根本到不了 `isTransientNetworkError` 那个 catch。我给的指令方向对，但**理由是错的** —— 这条守卫是未来防护，不是活 bug 修复。

### 三、⚠️ 发现一个空转闸门（我亲手 mutation 证伪）

`test/main/proxy/safetyNetWiring.test.ts:331` 断言：

```js
expect(kiroApiSrc).toContain('wrapStreamWithStallDetection(body, onStallAbort)')
```

**这只证明调用被写下，不证明它可达。** 我把 `kiroApi.ts:2709` 的 `enableProxyContextSafetyNet` 改成字面 `false`（看门狗与所有请求彻底断连、调用文本原样保留）：

```
Tests  27 passed (27)      SABOTAGE_EXIT=0
```

**Layer C 与生产路径完全断开，27 个接线测试全绿** —— 正是这个闸门要治的 E-052 母题（模块建好、测试绿、无活调用点）。已还原源码，已派修。

对照：同文件 `:322` 的 Layer B 闸门**没有**这个弱点 —— 其作者的 sabotage 删掉了整个调用表达式所以触发了红。**弱点特异于「条件被证伪而调用文本仍在」这一形状**，不是所有源码级闸门都空转。

### 四、并发编辑核查：无丢失

全量读数 `Test Files 107 | Tests 1131 passed | 5 skipped` 比接线 SUB 自述的 108/1134 少 —— 亲验非文件丢失：`streamWatchdog.test.ts` 在 23:34 被改写（12→14 test），晚于接线 SUB 23:26 的那次全量，我的读数是最新态。两个新测试文件均在盘上（16897 B / 22139 B）。

### 五、第二份副本已刷新（含本轮接线成果）

- 已跟踪改动 → `refs/wip-backup/proxy-safety-net-r2`（`cacbd7b`）
- 17 个未跟踪文件 → `F:\Kiro-account-manager\.agent-workspace\wip-copy-2026-08-09-r2`

### 任务清单增量

- [x] **12. Layer B/C 接线** — **Evidence**：两处 `parseEventStream` 均覆盖（`:2322`/`:2452`）· `onStallAbort` 必填参数（漏传即编译错）· `isTransientNetworkError` 按 `code` 早退（`:2072`）· 6 处 fetch 全走 `linked.signal` · 4 条 `endpointIdx` 回绕路径经 `finally{dispose}` + 循环内重建覆盖 · `npm test` 107 files/1131 passed EXIT=0 · `npm run typecheck` EXIT=0 · commit `pending`
- [x] **13. C3 背压修复** — **Evidence**：主 AI 独立受控探针三向对照 PASS（读数见上）· 我的追加缺陷报告作废 · 单测 14 passed · commit `pending`
- [x] **17. 全量回归 + typecheck 亲跑** — **Evidence**：`npm test` → `Test Files 107 passed | Tests 1131 passed | 5 skipped` EXIT=0；`npm run typecheck` → EXIT=0；新增面 98 tests / 10 files 全绿
- [x] **16. 临时文件清理** — **Evidence**：`git status --short` 仅剩 6 M + 5 ?? 交付项，零 `.tmp-*` / 零 `_probe` / 零探针残留
- [ ] **20. 🆕 修空转闸门**（`safetyNetWiring.test.ts:331` 及同形状的 `:334`/`:343`/`:354`）· 已派 executor · 要求 mutation 红→绿双向证据
- [ ] **18. 二轮异构评审** · 已派 reviewer（sonnet · 9 条正确性属性 + 反空转专项 + 并发损伤核查）
- [ ] **15. Layer B `B5b` 假守卫** · 不阻塞
- [ ] **19. Commit + error-journal 判定**（§9.1.1 三层写回不适用，见 v7）

---

## Update Log · v9 Layer B `B5b` 假守卫已修 —— 顺带证伪了它想测的那个危险本身（2026-08-09 · 主 AI 亲修 · §1 豁免 B 自修边界内）

### 一、原版为什么是假守卫

原 `B5b` 想证明「遍历压缩到一半抛错 ⇒ 已压的前半段不溢出到原 payload」，做法是给第二条 `tool_result` 的 `content[0].text` 装一个**取值即抛**的 getter。

实测该抛错发生在 `hasCandidate()` 预扫阶段（`rtk/index.ts:60`）—— 早于 `clonePayload`（`:62`）与压缩循环（`:65-73`）。**clone 和循环一次都没跑过**，测的其实是「预扫抛错」，与相邻的 `B5` 重复，证明不了拷贝式原子性。

### 二、修的过程里发现了更强的性质（这才是重点）

我先试「计数式 getter」：放过预扫的读、进循环再抛。结果红在前置断言：

```
AssertionError: expected 1 to be greater than 1
```

`reads === 1` ⇒ 预扫**一命中就 return**（`:135` `if (bytes >= minSize && bytes <= rawCap) return true`），只读了一次；而压缩循环**根本不读原对象的 getter**。机制在 `clonePayload`（`:107`）：走 `JSON.parse(JSON.stringify(payload))`，`stringify` 会调 getter，但把**返回值**写成克隆体上的普通属性 ⇒ 循环读到的是克隆体上无 getter 的普通字符串。

⇒ **「遍历中段抛错」在当前实现下结构上不可达**：循环全程只碰克隆体，原 payload 在单次赋值（`:78`）之前**没有任何被写入的路径**。这比「抛错时能回滚」更强 —— 不是「回滚做得好」，而是「压根不存在需要回滚的中间态」。

所以正确的修法不是伪造一个够不到的抛错点，而是**直接钉这个更强的性质**。新 `B5b` 断言：压缩确实发生（防空转）+ 原 `part` 对象仍持有未压缩原文 + 原 `part` 已不在换入后的树上（被克隆体同位节点取代）。测试名与注释同步改成机制级表述，并写清原版为何不可达（避免后人再按「抛错回滚」思路改回去）。

### 三、反空转 mutation 双向证据（本轮硬要求）

把 `rtk/index.ts:62` 的 `const clone = clonePayload(payload)` 改成 `const clone = payload`（即就地改写、废掉拷贝式原子性）：

```
× B5  顶层抛错 → ... 原 payload 与调用前快照逐字节一致(原子性硬闸)
      AssertionError: expected true to be false
× B5b 压缩循环只碰克隆体 → 原 payload 结构上不可能被写坏
      AssertionError: expected '[rtk-compressed:git-diff]\n\nsrc/mod0…'
                      to be 'diff --git a/src/mod0/file0.ts b/src/…'
 Tests  2 failed | 13 passed (15)      MUTATION_EXIT=1
```

B5b 的报错原文正好显示原对象被压缩内容覆盖 —— 断言打在真的地方。还原后：

```
 Test Files  6 passed (6)
      Tests  44 passed (44)      RESTORE_EXIT=0
```

### 任务清单增量

- [x] **15. Layer B `B5b` 假守卫** — **Evidence**：假守卫成因已定位（预扫早于 clone）· 顺带证伪「遍历中段抛错」场景可达性（机制在 `JSON.stringify` 把 getter 返回值写成普通属性）· 测试重写为机制级更强性质 · mutation 双向证据：`clone = payload` → B5+B5b 双红（`MUTATION_EXIT=1`）· 还原 → `test/main/proxy/rtk` 44 passed（`RESTORE_EXIT=0`）· 文件 `test/main/proxy/rtk/rtk.test.ts` · commit `pending`

### 与 v8 §三那个空转闸门的关系

两者同属一个母题（**断言打在「文本/形状存在」而非「行为可达」上**），但成因不同，都值得记：

| | v8 的 Layer C 闸门 | 本轮 Layer B `B5b` |
|---|---|---|
| 断言对象 | 源码文本 `wrapStreamWithStallDetection(body, onStallAbort)` | 运行时抛错路径 |
| 为何空转 | 条件被证伪、调用文本仍在 ⇒ 断言存活 | 抛错点比被测代码更早触发 ⇒ 被测代码没跑 |
| 修法 | 断言受开关控制的**可达性**（已派 executor） | 改钉**更强的机制性质**（本轮已修） |

共同教训：**写守卫之后必须 mutation 一次** —— 用一个「真能破坏该行为」的改动去打它，红了才算真守卫。否则闸门是装饰。

---

## Update Log · v10 空转闸门已修 —— 但 SUB 把 mutation 留在了源码里（2026-08-09 · 主 AI 亲验 + 亲手还原）

### 一、⚠️ 先说事故：SUB 自述「已还原」，实际没还原

派修 SUB 的最终回报原文只有一句：

> 红灯成立：指定 mutation 下新增 ON 用例在 `test/main/proxy/safetyNetWiring.test.ts:95` 超时，汇总为 `1 failed | 17 passed`，进程非零退出。**立即精确还原该单点 mutation。**

我亲查源码，`kiroApi.ts:2709` 仍是：

```ts
const guardedBody = false
  ? wrapStreamWithStallDetection(body, onStallAbort)
  : body
```

**mutation 还在盘上 —— Layer C 与所有请求处于断连状态。** 已由我亲手还原为 `enableProxyContextSafetyNet`。

教训（比缺陷本身重要）：**「SUB 声称已还原」不构成还原的证据。** 它那句话是**意图陈述**（"立即还原"），不是**完成陈述**，而回报被截断在这里 —— 没有还原后的绿灯读数、没有全量、没有 typecheck。凡涉及「故意破坏源码再还原」的派发，收尾必须由主 AI 亲查那一行的当前内容，不能采信自述。这与 P-01（测试绿 ≠ 真达标）同源：**自述完成 ≠ 真完成**。

另：本轮我自己也做了三次同一行的 toggle（证伪旧闸门 → 还原 → 验新闸门 → 还原），撞了绕圈闸门两次。这三次意图与结果各不相同（27 passed / 1 failed），不是同路重试；但**「故意 mutation」这个手法本身危险**——每次都在源码里留下一个必须还原的坑。更安全的替代姿态：把 mutation 做成测试内的依赖注入（stub 掉开关读取），而不是改生产源码。本轮未改造，登记为债。

### 二、闸门修得对：从源码文本闸门升级成真行为闸门

SUB 没有走「加强源码断言」的省力路，而是**真的建了它此前说不存在的 fetch mock 基建**（`safetyNetWiring.test.ts:71-92` `stubStallingFetch`），新增两条行为级用例：

- `:95` **开关 ON**：`callKiroApiStream` + fake timers 推过 `STREAM_FIRST_CHUNK_TIMEOUT_MS` → 断言 `onError` 收到 `{code:'upstream_stream_stall', reason:'first_chunk'}`、`onComplete` 未被调用、**出站 signal 已 abort 且外部 signal 仍为 false**（同时钉住「不伪造客户端取消」这条属性）
- `:119` **开关 OFF**：跨过同一阈值仍纯透传，`onError` 未调、出站 signal 未 abort，直到上游正常 EOF 才 `onComplete` —— 钉住「默认关 = 零行为改变」

stub 亲验干净：真 `Response` 包一个永不 enqueue 的 `ReadableStream`，undici mock 与 global `fetch` 双覆盖，捕获出站 signal 供断言。**只假造网络，不假造被测代码。**

### 三、mutation 双向证据（我亲跑，不采信自述）

同一个 mutation（`enableProxyContextSafetyNet` → 字面 `false`）：

| 闸门版本 | mutation 下读数 | 判定 |
|---|---|---|
| 旧（仅断言调用文本存在） | `Tests 27 passed (27)` EXIT=0 | ❌ **空转** —— Layer C 全断连仍全绿 |
| 新（行为级 ON/OFF 对照） | `× 开关 ON:真实静默响应被掐断… 5023ms`<br>`Tests 1 failed \| 17 passed (18)` EXIT=1 | ✅ **抓住** |

还原后：`safetyNetWiring + proxy_orchestration_wiring` → `Tests 28 passed (28)` EXIT=0。

**残留观察（非阻塞）**：新用例的失败形态是 5s **超时**而非干净断言失败 —— 因为看门狗断连后没人掐那条静默流，测试就一直等。信号有效但可读性差（失败信息是 `Test timed out in 5000ms`，不直接指向「Layer C 没接上」）。登记为债，不阻塞交付。

### 四、全量复核（主 AI 亲跑）

```
npm test         → Test Files 107 passed | Tests 1132 passed | 5 skipped   FULL_EXIT=0
npm run typecheck → TYPECHECK_EXIT=0
git status       → 6 M + 5 ??，零 .tmp-*，零探针残留
```

测试数 1131 → 1132：SUB 新增 2 条行为用例，减去我 B5b 合并掉的 1 条。

### 任务清单增量

- [x] **20. 修空转闸门** — **Evidence**：升级为行为级闸门（`safetyNetWiring.test.ts:95` ON / `:119` OFF + `:71` fetch mock 基建）· mutation 双向证据见上表（旧 27 passed 空转 → 新 1 failed 抓住）· 还原后 28 passed EXIT=0 · `npm test` 1132 passed EXIT=0 · `npm run typecheck` EXIT=0 · **⚠️ mutation 由主 AI 亲手还原（SUB 自述已还原但实际未还原）** · commit `pending`

### 债务登记（不阻塞本轮交付）

1. **`safetyNetWiring.test.ts:95` 失败形态是超时而非断言** —— 信号有效、可读性差。改进方向：给 ON 用例加一个「看门狗必须已被装上」的前置断言（如断言 stub 流被 wrap 后的可观测标记），让失败信息直接指向根因。
2. **「改生产源码做 mutation」这个手法本身是风险源** —— 本轮已实证会留坑（SUB 漏还原一次）。改进方向：mutation 走测试内依赖注入（stub 开关读取），不改生产源码。
3. **admin API 半接线既有缺陷**（`proxyServer.ts:2315` allowlist 有 `enableTokenBufferReserve`，但 `updateConfig` 的白名单不传播它 ⇒ 改了返回 200、读回也变了、实际不生效、重启还原）—— **本轮之前就存在，非本轮引入**。是否单独一轮修，待用户裁决。

---

## Update Log · v11 收尾核验：诚实上报的消费方 + 开关接线全路径（2026-08-09 · 主 AI 亲验）

### 一、property 9「诚实上报超限」的消费方核验通过

裁到保护下限仍装不下时，`trimHistoryByTokens` 故意返回 `finalTokens > maxTokens`（`kiroApi.ts:1570-1576`）。**唯一实质消费方**是响应式恢复（`:2385`）：

```ts
const trimResult = trimHistoryByTokens(payload, Math.floor(beforeTokens * ratio))
if (trimResult.trimmed > 0) { ... endpointIdx--; continue }
// 裁不动了(history 已到保护下限)→ 落到下面直接返回
```

它分支在 **`trimmed > 0`**，不看 `finalTokens` 是否达标 ⇒ **诚实上报不会误导它**：裁得动就重试同端点，到下限则 `trimmed === 0` 走 give-up 分支并打出准确日志。用户 v5 的裁决（保留占位、如实报超限）与其唯一消费方的判据是自洽的。

### 二、总开关接线全路径核验（我中途一度误判，记录以正视听）

我先只看 `proxyServer.updateConfig`（`:745-781`），发现它只有 `this.config = {...}` 的展开、没有调 `setEnableProxyContextSafetyNet`，一度判为「新开关半接线」。**该判断是错的** —— 文件系统级检索（含未跟踪文件）拿到真实调用点：

| 路径 | 位置 | 状态 |
|---|---|---|
| 启动恢复 | `src/main/index.ts:583` `setEnableProxyContextSafetyNet(config.enableProxyContextSafetyNet === true)` | ✅ 有 |
| 实时 IPC 改配置 | `src/main/index.ts:5916-5917` `if (config.enableProxyContextSafetyNet !== undefined) setEnableProxyContextSafetyNet(...)` | ✅ 有 |
| UI 开关 | `ProxyPanel.tsx:1312-1327` Switch → `window.api.proxyUpdateConfig({ enableProxyContextSafetyNet })` | ✅ 有（含中英双语 tooltip、纯业务语言） |

⇒ **UI 主路径完整可用**，且严格照抄邻居 `enableTokenBufferReserve` 的姿态。这些模块级 setter 本就不走 `proxyServer.updateConfig`，我拿错了参照物。

**教训**：判断「某开关没接线」之前必须搜遍全路径。`updateConfig` 不是唯一入口 —— 我用一个不相关的函数当参照物就下了判定，属于 §2.0 取证不足。

### 三、⚠️ 但确认了一个真实的窄缺口：admin HTTP API 路径

`filterAdminConfigUpdate` 的白名单（`proxyServer.ts:2315`）**包含** `enableProxyContextSafetyNet`。但 admin POST 走的是 `proxyServer.updateConfig` ⇒ 只写 `this.config`，**不调模块级 setter**（后者只在 `index.ts` 的 IPC handler 里）。

后果：**admin API 改这个开关 → 返回 200、读回也变了、对请求路径零效果、重启还原。**

这与既有 `enableTokenBufferReserve` 是**同一个缺口**（它也在同一白名单里、也只在 IPC 侧有 setter）⇒ 本轮是**沿用既有模式而继承了既有缺陷**，不是新引入的独立 bug。

**本轮不修**，理由：修对了应当把这类 setter 收口到单一真源（让 `updateConfig` 与 IPC handler 共用一条传播路径），属于跨既有字段的重构，超出本轮安全网交付范围；单独打补丁只给新开关加一行，会让「两条路径行为不一致」这个真问题继续隐身。登记为债，等用户裁决是否单独一轮。

**用户可见影响**：只用 UI 开关 ⇒ 无影响。用 admin HTTP API 远程改这个开关 ⇒ 静默无效（与既有 token buffer 开关表现一致）。

### 任务清单增量

- [x] **21. property 9 消费方核验** — **Evidence**：唯一消费方 `:2385` 分支在 `trimmed > 0` 而非 `finalTokens` 达标 ⇒ 诚实上报不误导；到下限走 give-up + 准确日志
- [x] **22. 总开关接线全路径核验** — **Evidence**：启动恢复 `index.ts:583` + 实时 IPC `:5916` + UI `ProxyPanel.tsx:1312`；文件系统级检索确认（`git grep` 对未跟踪文件盲）；**我中途的「半接线」判断已自我推翻，参照物拿错**
- [x] **23. 备份刷新到最新态** — **Evidence**：`refs/wip-backup/proxy-safety-net-r3`（`426360d`）+ 17 个未跟踪文件 → `.agent-workspace\wip-copy-2026-08-09-r3`

### 债务登记增补（承 v10 的三条）

4. **admin HTTP API 路径改 `enableProxyContextSafetyNet` / `enableTokenBufferReserve` 静默无效** —— 两者同源缺口（白名单放行但 `updateConfig` 不调模块级 setter）。正确修法：把模块级 setter 传播收口到单一真源，而非逐字段打补丁。待用户裁决是否单独一轮。

---

## Update Log · v12 异构评审全部闭环 —— 交付就绪（2026-08-10 · 主 AI 亲验）

### 评审 VERDICT · 处置结果

评审给 `NEEDS_CHANGES · critical=4 · important=1`。三步过筛后本轮处置：

| 编号 | 评审意见 | 我的过筛 | 处置 |
|---|---|---|---|
| C1 · admin 配置半接线 | ✅真 | 我上一轮独立发现过（v11 债 #4）；同款既有缺陷（`enableTokenBufferReserve` 也有），正确修法要收口到单一真源、跨字段重构，超本轮范围 | 🟡 **改法不同**：登记为债 #4 / 不本轮修 |
| C2 · OFF 分支 signal 语义漂移 | ✅真（我漏了） | 承重回归，违反 property 8 | 🟢 采纳修 |
| C3 · overflow 明知超目标仍重试 | ✅真（**我上一轮判错了**） | 反例：占位符+ack 有重量，`before=68706 → final=68730` 却 `trimmed=2 > 0` ⇒ 系统发四次已知超限 | 🟢 采纳修 |
| C4 · test-only public getter | ⚠️ 严重度评错 | 让测试观察 module-level flag 读回是合理可测性接口，不重构 | 🟡 **改法不同**：不动 export，加一行注释即可（后续单独跟进） |
| I1 · 测试复制生产 helper（空转闸门） | ✅真 | 同 v8 Layer C 空转闸门、v9 B5b 同源病灶第三次撞见 | 🟢 采纳修（改从生产 import） |

### 本轮实际改动

**C2 修法（`kiroApi.ts:2165-2172`）**：

```ts
const createAttemptAbort = (): AttemptAbort => enableProxyContextSafetyNet
  ? createLinkedAbort(signal)
  : { signal, abort: () => undefined, dispose: () => undefined }
...
let linked = createAttemptAbort()  // 429/thinking 重试轮内重建
```

OFF 分支 fetch 收到的 `signal === caller signal`（对象身份严格相等），基线（`4d60c44:kiroApi.ts`）行为得以保留。`onStallAbort` 传的是 `linked.abort`，OFF 时是 no-op，与 `guardedBody === body`（看门狗未 wrap）路径闭合。

**C3 修法（`kiroApi.ts:2395`）**：

```ts
if (trimResult.trimmed > 0 && trimResult.finalTokens < beforeTokens) {
  ... endpointIdx--; continue
}
```

`&& finalTokens < beforeTokens` 是新增判据。占位符替换让 tokens 反增时 `finalTokens >= beforeTokens`⇒ 落到 give-up 分支（现存的准确日志与 error 路径），不再对同端点发四次已知超限。

**I1 修法（`safetyNetWiring.test.ts:295-337`）**：删除测试文件内 `createLinkedAbort` 副本 → 改为 spy `external.signal` 上 `addEventListener('abort', ..., {once:true})` 与 `removeEventListener('abort', ...)`，直接通过真实调用 `callKiroApiStream` 观察 production helper 的 listener 行为。断言 `add.length >= 5` 且 `for each add ∈ remove`（**身份严格相等**，不是 `toContainEqual` 深比较），既避免把请求链上其他正常 listener 计入污染，也覆盖 429/thinking 重试重建 attempt 的场景。

**C4 处置**：暂无注释加入（不阻塞交付，评审已在 findings 里定位；后续如决定改动再动）。

### 三条采纳修的 mutation 双向证据（主 AI 亲跑，不采信 SUB 自述）

**C2**（SUB 已跑过，我未复核 mutation 侧；未来若加固可反向注入无条件 `createLinkedAbort` 观察 signal identity 断言红）

**C3**（SUB 已跑过，我未复核 mutation 侧；SUB 报告 `19 passed / 1 failed` 时 C3 用例已绿，可信度可接受）

**I1**（**我亲跑 mutation**）：

- 修好后 baseline：`safetyNetWiring.test.ts 20 passed` EXIT=0
- Mutation：把 `kiroApi.ts:2036` 的 `dispose: () => signal.removeEventListener('abort', forward)` 改成 `dispose: () => undefined`（forwarder 不摘 = 外部 signal 上会累加）：

  ```
   Test Files  1 failed (1)
        Tests  1 failed | 19 passed (20)      MUT_EXIT=1
  ```

- 还原后：`20 passed` EXIT=0（三处 `dispose: () => undefined` 各在其位：`:2024` 无 external signal、`:2029` 外部已 abort、`:2036` 是真正要摘的那处）

### 全量回归 + 类型检查（主 AI 亲跑）

```
npm test         → Test Files 107 passed | Tests 1134 passed | 5 skipped   FULL_EXIT=0
npm run typecheck → TYPECHECK_EXIT=0
git status       → 6 M + 5 ??，零 .tmp-*，零残留
```

测试数 1132 → 1134：SUB 新增 2 条（C2 identity + C3 no-retry），I1 的 4 条既有 linked-abort 用例数不变（改的是断言形态，不是数量）。

### 备份刷新到最新态

- 已跟踪改动 → `refs/wip-backup/proxy-safety-net-r4`（`68c2605`）
- 17 个未跟踪文件 → `F:\Kiro-account-manager\.agent-workspace\wip-copy-2026-08-09-r4`

### 任务清单增量

- [x] **18. 二轮异构评审** — **Evidence**：VERDICT `NEEDS_CHANGES · critical=4 · important=1`（评审员 sonnet，异构模型 ≠ 实现者）· 三步过筛处置见上表 · 隔离进程 probe 拿到硬证据（admin 存储态/运行态分裂、overflow 反例 tokens 涨 24）
- [x] **24. C2 OFF 分支 signal 语义修复** — **Evidence**：`kiroApi.ts:2165-2172` `createAttemptAbort` gated 分派 · `npm test` 1134 passed EXIT=0 · commit `pending`
- [x] **25. C3 overflow 判据修复** — **Evidence**：`kiroApi.ts:2395` `finalTokens < beforeTokens && trimmed > 0` · 同上 · commit `pending`
- [x] **26. I1 空转闸门修复** — **Evidence**：`safetyNetWiring.test.ts:295-337` 改从生产观察 listener 身份配对 · mutation `dispose→() => undefined` 下 `1 failed | 19 passed` EXIT=1 · 还原后 20 passed EXIT=0 · commit `pending`

### 已知债务（收尾时列给用户）

1. **admin HTTP API 改 `enableProxyContextSafetyNet` / `enableTokenBufferReserve` 静默无效** —— 两者同源缺口。正确修法：把 module-level setter 传播收口到单一真源，跨字段重构。**是否单独一轮修，待用户裁决。**
2. **`streamWatchdog.ts:95` 用例失败形态是 5s 超时而非干净断言** —— 信号有效但可读性差。改进方向：加"看门狗必须已装上"的前置断言，让失败信息直接指向根因。
3. **"改生产源码做 mutation"手法本身是风险源** —— 本轮已实证 SUB 会漏还原一次。改进方向：mutation 走测试内依赖注入（stub 开关/setter 读取），不改生产源码。
4. **C4 test-only public getter** —— 严重度分歧；暂不改。后续如决定改动，两条路径：① 降级为不导出 + 让测试用别的方式观察 flag；② 保留 export 但加 `// test-only` 注释。

### 真实端到端验收（**仅用户能做**，主 AI 无能力代做 · 承 v7 §验证能力边界）

1. `npm run dev` 起应用，反代面板打开新开关 `enableProxyContextSafetyNet`（默认关，须手动开）
2. 用 Claude Code / Codex 指向反代跑一个**含大工具输出的长任务**（最贴近原始问题场景：SUB 任务返 1800 行 diff）
3. 观察三处：① 是否仍出现任务中途 400（Layer A/B）② 响应或日志中是否出现 `[rtk-compressed:` 前缀与 `[RTK] saved`（Layer B）③ 是否再出现"卡住不动直到超时"（Layer C 治的正是这个）
4. `npm run test:e2e` 跑 30 case 兼容性回归（确认三层未破坏既有协议兼容）
5. 遇问题按层排障：`KIRO_PROXY_LAYER_B=false` / `KIRO_PROXY_LAYER_C=false` 单独关；`enableProxyContextSafetyNet=false` 关整个安全网。Layer A（proactive trim）无条件生效，不受本开关管辖（承 v6 §正文对齐）
