# Layer C × HoldGate 首 chunk 豁免实施报告

日期：2026-08-13

## 实施结果

- `StallDetectionOptions` 新增 `skipFirstChunkTimeout`。首 chunk 前设置该选项时 `armWait()` 不创建 TTFT timer；首个原始上游 chunk 到达、`chunkCount` 增加后，后续 pending read 仍按正常 `stallTimeoutMs` 武装 `inter_chunk` timer。
- `kiroApi` 新增请求执行期选项，并从 `callKiroApi` / `callKiroApiStream` 传到 `parseEventStream`。主解析与 `THINKING_SIGNATURE_INVALID` 重试两处都传同一个请求级选项，因此 endpoint fallback、signature retry、content-filter retry不会掉回普通 200s TTFT。
- `runWithHold` 保存请求生命周期变量 `resumedFromHold`：初值 `false`，任一成功 `waitInHold` 后置 `true`，以后不复位；每次 attempt 都收到该上下文。
- 四类上层路径全部接通：
  1. OpenAI 真流式：`runWithHold → handleOpenAIStream → callKiroApiStream`
  2. Gemini 真流式：`runWithHold → callKiroApiStream`
  3. Claude 真流式：`runWithHold → handleClaudeStream → callKiroApiStream`
  4. JSON / 伪流式：`runJsonRequestWithHold → doCall/callWithRetry → callKiroApi → callKiroApiStream`
- `holdConfig.ts` 删除重复假定的 200000 常量、安全系数、错误的“Layer C 尚未落地”说明及默认配置噪音 warning；没有导入 watchdog runtime 常量。

## TDD 证据

1. Watchdog 叶子能力：
   - Red：15 tests 中 1 failed / 14 passed；新增用例在 200s 后错误触发 `first_chunk`。
   - Green：15 / 15 passed；首 chunk 可迟到，收到 1 个原始 chunk 后静默 360s 触发 `StallError(reason='inter_chunk')`，`onStallAbort` 恰好一次。
2. kiroApi 接线：
   - Red：21 tests 中 1 failed / 20 passed；请求级选项尚未到达 watchdog，仍在 200s 触发 `first_chunk`。
   - Green：21 / 21 passed；跨过 200s 无错误，首 chunk 后 360s 明确触发 `inter_chunk`。
3. Hold 上层接线：
   - Red：16 tests 中 4 failed / 12 passed；Claude JSON、OpenAI 真流式、Gemini 真流式、Claude 真流式均未收到豁免。
   - Green：16 / 16 passed；普通首次 attempt 不带 true，成功 resume 后 attempt 带 `{ skipFirstChunkTimeout: true }`。
4. Hold 配置清理：
   - Red：14 tests 中 1 failed / 13 passed；默认配置仍输出 Layer C warning。
   - Green：14 / 14 passed；默认配置不再输出该 warning。

## 接线护栏

原 `safetyNetWiring.test.ts` 用 `/await parseEventStream\([^\n]*/`，只能读取单行调用；新增参数导致合法多行格式化时会误报。已改为：

- 统计全部 `await parseEventStream(` 起点，仍严格要求恰好两处；
- 对每处调用附近同时断言存在 `linked.abort(` 和 `executionOptions`。

这保留了“两处 parse 调用都接 linked abort”的原约束，并新增“两处都继承请求执行选项”的约束。

## 最终验证

- 相关回归组：`numPassedTests=127`，`numFailedTests=0`（41 suites 全通过）。
- `npm run typecheck:node`：EXIT=0。
- `git diff --check`：EXIT=0。
- 测试均使用 mock/fake timers，没有绑定真实资源；未修改 `vitest.config.ts`。

## 方案取舍与边界

- 没有发现比显式参数传递更小且同样可靠的缝。AsyncLocalStorage、模块全局、隐藏 payload 字段、给 `AbortSignal` 挂字段或 WeakSet 都会把并发隔离和请求重试生命周期变成隐式环境状态，因此未采用。
- 未把豁免做成单 attempt 消耗型 flag；那会让内部 retry/fallback 边界改变用户可见超时行为。
- 未区分 auto/manual/pool/poll release；所有成功 `resume` 语义一致，也无需扩大 `holdGate.ts` 的 hook 契约。
- 未整体关闭 Layer C；首 chunk 后的 360s inter-chunk 保护已有行为测试证明仍生效。
- 未改 Claude content-block 状态机，只在 `handleClaudeStream` 的参数尾和现有 `callKiroApiStream` 尾部做最小转发。
- 未提交、未 stash、未回滚或覆盖共享工作树中的无关改动。

## 动作闸门核验

- ⚡ 改 A 漏传播：已按定义与消费链枚举并逐层接通，最终由 `typecheck:node` EXIT=0、两处 parse 结构护栏及四路径行为断言共同验证。
- ⚡ 测试编号：已读取 `streamWatchdog.test.ts` 全部现有 C1-C12，占用核实后使用 C13，无编号冲突。
- ⚡ 安全网真实产出：本轮新增 watchdog/kiroApi/四路径/config 回归均先红后绿，最终 JSON 明确记录 127/127 passed，不以脚本存在代替执行证据。
