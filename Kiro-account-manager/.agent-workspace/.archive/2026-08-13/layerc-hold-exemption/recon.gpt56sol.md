# Layer C × Hold Gate 豁免侦察与实施计划

日期：2026-08-13  
基线：`main` / `d8f957e`  
范围：只读侦察；未修改、暂存、提交或 stash 产品代码。未读取或评价 `src/main/server/entry.ts`、`src/main/ipc/panelProxyDeps.ts` 的无关工作树改动。

## 结论

推荐语义是候选 **(b)：对“曾从 HoldGate 被放行”的请求禁用首 chunk 超时，但首个上游 chunk 到达后仍启用正常的 inter-chunk 超时**。

原因：

1. HoldGate 保护的是“尚未向客户端提交语义正文”的等待阶段；用普通 200s TTFT 预算终结该阶段，与用户已经选择的 hold 契约冲突。
2. 完全跳过 Layer C（候选 a）会连已经开始出字后的死流也放过，放弃太多保护。
3. 给 released 请求设置更长但有限的首 chunk 预算（候选 c）只是把同一种竞态推迟；它还会引入“多长才算豁免”的第二套配置关系。更重要的是，条目在 `claim()` 时已经从 held 集合删除（`src/main/proxy/holdGate.ts:580-588`），请求执行上游调用期间并不存在一个仍在运行、能在 480s 再次放行同一条目的 HoldGate timer。因此按 `480000 / 0.75` 算一个约 640s 的 released-only TTFT 并不会让“下一次自动放行”抢先发生。
4. 候选 (b) 仍保留一个诚实边界：如果上游连第一个原始 chunk 都永远不给，Layer C 不再终结它；最终仍由客户端取消/idle watchdog、请求的外部 AbortSignal 或连接断开处理。这个边界与人类已选的“hold 阶段不由 stream watchdog 治理”一致。首 chunk 一旦到达，360s inter-chunk 保护恢复。

豁免应覆盖**请求第一次被放行后的整个剩余生命周期**，包括该请求后续的端点 fallback、`THINKING_SIGNATURE_INVALID` 重试、内容过滤重试、账号重试以及再次 hold/release。它不是“下一次函数调用”的瞬时标志，而是稳定的请求来源事实。只豁免一次外层 attempt 会让 `callKiroApiStream` 内部第二个端点或签名重试重新落回 200s，行为取决于内部重试边界，既脆弱又不可解释。

## 1. Watchdog 实际接线

### 唯一生产接线点

- `src/main/proxy/kiroApi.ts:32`：导入 `wrapStreamWithStallDetection`。
- `src/main/proxy/kiroApi.ts:2801-2820`：`parseEventStream` 内部统一包裹原始 `response.body`；实际调用为 `:2817-2819`：
  - `enableProxyContextSafetyNet === true` 时调用 `wrapStreamWithStallDetection(body, onStallAbort)`；
  - 否则直接使用 `body`。
- `src/main/proxy/streamWatchdog.ts:134-153`：`wrapStreamWithStallDetection`；`KIRO_PROXY_LAYER_C=false` 在 `:108-110` 使其直接返回原流。
- `src/main/proxy/streamWatchdog.ts:142`：唯一生产调用 `buildWatchdogStream(...)`。
- `src/main/proxy/streamWatchdog.ts:155-353`：`buildWatchdogStream` 私有实现；不存在外部调用面。

`parseEventStream` 自己有两个生产调用点，故二者都自动经过同一个包装位置：

- 主路径：`src/main/proxy/kiroApi.ts:2427`。
- `THINKING_SIGNATURE_INVALID` 重试路径：`src/main/proxy/kiroApi.ts:2560`。

这也解释了语义搜索报告的“3 callers”表象：源码级 `wrapStreamWithStallDetection` 调用只有 `kiroApi.ts:2818` 一处；上游有两处 `parseEventStream` 调用。不要把调用图展开后的三条路径误写成三个文本调用点。

### 总开关读取

- 模块级开关定义与 setter/getter：`src/main/proxy/kiroApi.ts:153-160`。
- `src/main/proxy/kiroApi.ts:2218-2220`：开关 ON 才为每次 fetch 创建 linked AbortController；OFF 保留调用方原始 signal。
- `src/main/proxy/kiroApi.ts:2817-2819`：开关 ON 才真正套 watchdog。
- 初始配置恢复：`src/main/index.ts:543-544` 调用 `setEnableProxyContextSafetyNet(config.enableProxyContextSafetyNet === true)`。
- 配置字段及默认 false 契约：`src/main/proxy/types.ts:601-606`。
- 开发者 Layer C kill switch：`src/main/proxy/streamWatchdog.ts:108-110`。

## 2. Held 请求如何恢复，以及现有上下文够不够

### 恢复链

1. `HoldGate.startAutoReleaseIfNeeded()` 在 `src/main/proxy/holdGate.ts:420-445` 建周期 timer；到点调用 `releaseAll('auto')`（`:435`）。
2. `releaseAll()` 在 `src/main/proxy/holdGate.ts:653-665` 遍历 held 条目。每条先经过 `claim()`，成功后调用 `entry.hooks.resume()`（`:656-658`）。
3. `claim()` 在 `src/main/proxy/holdGate.ts:580-591` 将条目标记 claimed、清 timer、从 `held` 删除，并在集合空时停止 poll/auto-release timer。
4. `runWithHold.waitInHold()` 在 `src/main/proxy/proxyServer.ts:4134-4155` 创建 `HeldRequestHooks`；当前 `resume` 只是 `settleHold(true)`（`:4142`），Promise 只解析为 boolean。
5. 主循环在 `src/main/proxy/proxyServer.ts:4217-4226` await 该 boolean，重新选账号并 `continue`。
6. 下一圈在 `src/main/proxy/proxyServer.ts:4228-4230` 调用同一个 endpoint-specific `attempt(acc, recordError)`，由它重新执行上游调用。

### 现有上下文

`runWithHold` 生命周期内已有并持续保存：

- `triedIds`：`src/main/proxy/proxyServer.ts:4118-4119`；
- `preBodyErrorRef`：`:4120-4125`；
- `acc` 与无限主循环：`:4157-4159`；
- “刚从 waitInHold 成功返回”的控制流事实：`:4217-4226`。

但这个事实**没有被保存**。`waitInHold` 只返回 boolean，`HeldRequestHooks.resume` 的签名也没有 trigger 参数（`src/main/proxy/holdGate.ts:33-41`）；`releaseAll` / `tryResume` 都调用无参 `resume()`（`src/main/proxy/holdGate.ts:639-641,653-659`）。到 `parseEventStream` 的 watchdog 接线点时，可见参数只有 body、callbacks、inputChars、signal、modelId、payloadStr（`src/main/proxy/kiroApi.ts:2801-2812`），没有任何 hold 来源事实。

结论：**不存在可在 watchdog 接线点直接读取的现成事实**。需要显式传递，但不需要把 release trigger（auto/manual/pool/poll）逐层传下去；本需求只需要“该请求曾被 HoldGate resume”这一稳定 boolean。所有成功的 `resume` 都应获得相同豁免，避免手动/池恢复/轮询形成四套隐含行为。

### 最小且类型安全的传递缝

建议新增两个小类型：

- ProxyServer 内部 `HoldAttemptContext = { resumedFromHold: boolean }`；
- kiroApi/streamWatchdog 侧使用行为型选项，例如 `skipFirstChunkTimeout`，不要让叶子 transport import HoldGate 类型。

在 `runWithHold` 内：

- 在 `src/main/proxy/proxyServer.ts:4157` 附近新增请求生命周期变量，初值 `false`；
- `waitInHold` 返回 true 后（`:4217-4218`）置为 `true`，以后不复位；
- 把 `attempt` 签名从 `src/main/proxy/proxyServer.ts:4102` 的两个参数扩为三个参数，并在 `:4230` 传 `{ resumedFromHold }`。

需要改动的签名共 **7 个**：

1. `runWithHold.opts.attempt`（`proxyServer.ts:4102`）；
2. `runJsonRequestWithHold.opts.doCall`（`proxyServer.ts:4384`），使 JSON/伪流式 hold 路径也能收到 context；
3. `handleOpenAIStream`（`proxyServer.ts:3438-3453`）；
4. `handleClaudeStream`（当前 hold 调用点 `proxyServer.ts:4468-4472`；签名在同文件该函数定义处）；
5. `callKiroApi`（`kiroApi.ts:3832-3836`）；
6. `callKiroApiStream`（`kiroApi.ts:2138-2149`）；
7. `parseEventStream`（`kiroApi.ts:2801-2812`）。

最深路径约五个转发边界：

`runWithHold attempt context → runJsonRequestWithHold.doCall → endpoint doCall/callWithRetry closure → callKiroApi → callKiroApiStream → parseEventStream`。

不建议用 AsyncLocalStorage、模块全局变量、给 `AbortSignal` 挂私有字段、给 payload 加隐藏属性或 WeakSet 来省参数；这些方案把并发请求隔离和重试生命周期变成环境隐式状态，风险高于七个明确签名变化。

## 3. 精确豁免行为

在 `StallDetectionOptions`（`src/main/proxy/streamWatchdog.ts:101-106`）新增 `skipFirstChunkTimeout?: boolean`。

`buildWatchdogStream.armWait()`（`src/main/proxy/streamWatchdog.ts:248-263`）的行为应是：

- `chunkCount === 0 && skipFirstChunkTimeout === true`：保持 read 正常在飞，但不创建 firstChunkTimer；
- 第一个 chunk 到达后，现有 `chunkCount++`（`:336-339`）照常发生；
- 之后每个 pending read 继续使用现有 `stallTimeoutMs`，产生 `StallError('inter_chunk', ...)`；
- 普通请求、未被 hold 放行的初次 attempts、总开关 OFF、`KIRO_PROXY_LAYER_C=false` 均保持现状。

只传行为选项，不改变 `STREAM_FIRST_CHUNK_TIMEOUT_MS` 与 `STREAM_STALL_TIMEOUT_MS` 的默认值（`streamWatchdog.ts:83,89`）。

## 4. `holdConfig.ts` 清理

Layer C 已落地后，`src/main/proxy/holdConfig.ts:43-51` 的历史前提和 `:100-111` 的告警都已失效。

实施时应：

1. 删除 `LAYER_C_FIRST_CHUNK_TIMEOUT_MS_ASSUMED`（`:49`）；
2. 删除 `LAYER_C_SAFETY_RATIO`（`:51`）；
3. 删除已经错误声称“Layer C 尚未落地”的注释（`:43-50`）；
4. 删除兼容性 warning 块（`:100-111`）；
5. 若 `proxyLogger` 因此不再使用，删除 `:9` 的 import；
6. 更新 `test/main/proxy/holdConfig.test.ts:75-76` 中“低于 Layer C 兼容阈、不触发 warn”的过时说明。

**不应从 `holdConfig.ts` import `STREAM_FIRST_CHUNK_TIMEOUT_MS`。** 豁免落地后，hold 配置归一化不再需要比较这两个时间值；导入真实 runtime/env 值只会制造一个无业务用途的跨模块依赖。真正 SSOT 继续留在 `streamWatchdog.ts:83`。若保留 warning 才需要 import runtime 值，但保留 warning 会继续对默认合法配置制造噪音，也会误导用户认为尚需手工调参。

## 5. 现有测试覆盖与影响

### Hold/release

- `test/main/proxy/holdGate.test.ts`：纯 HoldGate 定时/CAS/自动放行覆盖；包括批量自动放行约 `:666-694`、同步 re-hold 与 poll 交替 `:702-731`。它验证 timer 和 resume 次数，不经过 Layer C。
- `test/main/proxy/holdGateTimeline.test.ts:158-245`：auto/manual/pool-available trigger 及 release outcome。
- `test/main/proxy/holdReleaseObservability.test.ts:66-143`：自动放行日志出口、计数/时间线一致性。
- `test/main/proxy/holdGateSessionLifecycle.test.ts:81-227`：reset/stop 清 timer 与计数。
- `test/main/proxy/holdGateStreamWiring.test.ts:140-188`：真实 ProxyServer 控制流（mock kiroApi），held 后池恢复、用新号重跑、message_start/正文只一次；`:190-236` 覆盖首字节前 403 后 hold/release/retry。
- `test/main/proxy/holdGateFalsePositive.test.ts:270-327`：封禁进入 hold、手动放行后新号完成。

### Watchdog

- `test/main/proxy/streamWatchdog.test.ts:92-171`：正常流、inter-chunk stall、first-chunk stall；
- `:191-324`：错误字段、timer 清理、fail-open、`KIRO_PROXY_LAYER_C=false`、默认常量；
- 后续 `:327-555`：背压与真实 timer/计时起点边界。
- `test/main/proxy/safetyNetWiring.test.ts:95-153`：总开关 ON/OFF、linked abort 不污染 caller signal；
- `:538-559`：两个 `parseEventStream` 调用都传 linked abort，所有 fetch 使用 attempt signal。

### Hold config

- `test/main/proxy/holdConfig.test.ts:10-91` 只有 clamp/default/完整对象测试；**没有 warning 次数或 warning 文案断言**。`:11-14` 的默认配置测试会触发现有噪音，但不捕获它。

### 正确实现会破坏哪些现有测试

行为上不应破坏上述任何测试：

- 普通 Layer C 默认行为不变；
- HoldGate 的 timer/CAS/trigger 不变；
- call 次数与 SSE 正文次数不变；
- 删除 holdConfig warning 没有现有断言依赖。

可能需要机械更新：

- `safetyNetWiring.test.ts:538-547` 的源码结构正则若 `parseEventStream` 调用因新增选项被格式化为多行，当前 `/await parseEventStream\([^\n]*/` 会误判；应改成行为断言或能跨行的结构断言。
- 各 `callKiroApiStream` mock 通常允许忽略新增尾参数，不应因运行时多一个参数失败；若某处精确断言完整参数数组，需要补预期。语义检索未发现这类精确数组断言。`unverified: 未执行全仓文本枚举，专用 rg 工具的仓库检索闸门未识别已完成的 MCP 语义检索。`

## 6. TDD 顺序与具体实施计划

### 第一条红测试

先在 `test/main/proxy/streamWatchdog.test.ts` 增加一个叶子行为测试（建议编号 C13）：

1. 创建首 chunk 延迟超过普通 firstChunkTimeout 的流；
2. 通过一个带额外字段的局部变量传 `{ skipFirstChunkTimeout: true, firstChunkTimeoutMs: 20_000, stallTimeoutMs: 30_000 }`，避免红灯只来自 TypeScript excess-property 编译错误；
3. 推进超过 20s，断言没有 `first_chunk` 错误、没有调用 `onStallAbort`；
4. 送入第一个 chunk；
5. 再让上游静默超过 30s，断言仍抛 `StallError(reason='inter_chunk')` 且 abort 一次。

这是最先写的 red：当前实现会在第 3 步以 `first_chunk` 失败，精确证明缺失行为，不依赖 ProxyServer 复杂 mock。

### 实施顺序

1. **叶子能力**：修改 `streamWatchdog.ts` 的 `StallDetectionOptions` 和 `armWait()`，让上述 red 变绿；跑 `streamWatchdog.test.ts`。
2. **kiroApi 转发**：
   - 给 `parseEventStream` 增加尾部 watchdog options，并在 `:2818` 传给 wrapper；
   - 两个调用点 `:2427,:2560` 必须传同一个请求 execution option；
   - 给 `callKiroApiStream` 与 `callKiroApi` 增加尾部 execution options，保持所有旧 caller 默认行为。
3. **Hold 来源事实**：修改 `runWithHold`，在第一次成功 resume 后把 `resumedFromHold` 永久置 true，并传给每次后续 attempt。
4. **四类上层路径全部穿线**：
   - OpenAI 真流式：`startOpenAIChatWithHold` 的 attempt（`proxyServer.ts:3671-3679`）→ `handleOpenAIStream`；
   - Gemini 真流式：`startGeminiWithHold`（`:3830-3885`）→ `callKiroApiStream`；
   - Claude 真流式：`startClaudeStreamWithHold`（`:4450-4478`）→ `handleClaudeStream`；
   - JSON/伪流式：`runJsonRequestWithHold`（`:4376-4417`）→ 每个 `doCall` → `callKiroApi`。
5. **接线回归测试**：
   - 在 `holdGateStreamWiring.test.ts` 增加断言：普通首次 attempt 不带豁免；从 hold resume 后的 attempt 带 `skipFirstChunkTimeout: true`，后续再次 attempt 仍为 true；
   - 在 `safetyNetWiring.test.ts` 增加真实 `callKiroApiStream` 行为测试：带 released execution option 时跨过 200s 不报 first_chunk，收到首 chunk 后跨过 360s 报 inter_chunk；
   - 保留并必要时修正 `:538-547` 两个 parse 路径的接线护栏。
6. **配置清理**：按上一节删除 `holdConfig.ts` 的假定常量、过时注释与 warning；更新 `holdConfig.test.ts:75-76` 注释。可新增 logger spy，断言 `normalizeHoldConfig({})` 不再发 Layer C 兼容 warning，防止噪音回归。
7. **验证命令**：
   - `npx vitest run test/main/proxy/streamWatchdog.test.ts test/main/proxy/safetyNetWiring.test.ts test/main/proxy/holdConfig.test.ts test/main/proxy/holdGate.test.ts test/main/proxy/holdGateStreamWiring.test.ts test/main/proxy/holdGateTimeline.test.ts test/main/proxy/holdGateSessionLifecycle.test.ts test/main/proxy/holdReleaseObservability.test.ts --reporter=json --outputFile=<tmp>.json`
   - 从 JSON 读取 `numFailedTests`，再删除临时 JSON；
   - 最后跑项目 typecheck，重点捕获七个签名的漏传。

## 7. 风险与验收边界

1. **漏掉非流式路径**：`callKiroApi` 内部也调用 `callKiroApiStream`（`kiroApi.ts:3850-3893`）；只修 SSE handler 会让 Claude/OpenAI JSON 与 `/v1/responses` 仍在 released 后被首 chunk watchdog 终结。
2. **只修主 parse 路径**：`THINKING_SIGNATURE_INVALID` 的第二次 parse 在 `kiroApi.ts:2560`，必须继承同一豁免。
3. **把豁免做成单次 attempt**：端点 fallback/内部重试会恢复 200s，产生时序依赖。
4. **误把 inter-chunk 一并关掉**：验收必须证明首 chunk 后的 stall 仍在 360s 被终结。
5. **release trigger 丢失不是 blocker**：当前 `resume()` 无参；本需求不需要区分 auto/manual/pool/poll。若实现者只想豁免 auto，就必须额外修改 `HeldRequestHooks.resume(trigger)`、`tryResume`、`releaseAll`，会扩大范围且与“exempt held requests”的人类决策不符。
6. **客户端 310s 观测冲突**：提供的事实同时写有“约 10min”和“恒定 310s”，而默认 auto-release 是 480s。此计划不改这些人类已定参数；首 chunk 永不出现时，客户端可能先于 auto-release/hold 预算断开。`unverified: 310s 测量对应的客户端版本、是否包含自动重连及“release 产生语义 body”的具体字节证据不在本次代码侦察范围。`
7. **测试状态**：本次未运行 Vitest，避免在共享工作树产生临时输出并因没有代码变更而增加干扰。`unverified: 当前相关测试基线是否全绿。`

## 验收标准

- 普通请求：Layer C ON 时仍在 200s 首 chunk stall、360s inter-chunk stall；OFF/kill switch 行为不变。
- 任一 HoldGate resume 后：整个请求剩余生命周期不再触发 `first_chunk` StallError。
- released 请求收到至少一个原始上游 chunk 后：后续 360s 静默仍触发 `inter_chunk` StallError。
- 主 parse 与 thinking-signature retry 两条路径一致。
- Claude/OpenAI/Gemini 真流式及所有 `runJsonRequestWithHold` 路径一致。
- `normalizeHoldConfig({})` 不再输出 Layer C 兼容 warning，且不再存在重复的 200000 常量。
