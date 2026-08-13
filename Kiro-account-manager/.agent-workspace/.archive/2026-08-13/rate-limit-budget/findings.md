# 429 总耐受预算核验

> 成功状态: NOT「加个总重试计数器」, BUT「上游持续 429 时，反代不会在同一波请求里无限地把 429 往上游砸，而是有一个可观测的总耐受上限，到顶就按既有语义收尾(报错/换号/挂起)；而单账号偶发 429 的既有快速穿透行为一个不变」
>           不该发生：引入任何退避曲线(多人共用一把 key，退避=把并发让给还在打的人)；不该发生：把 429 重新变成额度信号或让它污染 isQuotaExhausted
>           来源: 台账 #37「429 总耐受预算 —— 采纳概念、拒绝其退避曲线，我方有相反实地证据」

## 结论

**STOP：本派单所描述的“同一波请求会无限打 429”在当前代码中不成立，现有机制已经有限收尾；本轮不新增预算字段、计数器或退避。**

作用域裁决是**不新增任何一层预算**：

- 每客户端请求：端点内 429 循环、端点集合、`callWithRetry` 外层循环和 `runWithHold` 的账号去重都已有有限边界。
- 每账号：端点内次数已有上限；端点链耗尽后还会进入 `errorCount` 冷却。再加同义计数会重复。
- 全局跨请求：这会把独立客户端耦合成一把全局闸门，属于新的入站限流/熔断产品语义；多人共享 key 时还可能让先到请求消耗掉后来请求的机会，没有本任务授权。

若未来另有明确证据证明“有限但过大”并给出可接受的固定阈值，唯一合理的新作用域应是**每客户端请求、跨端点/跨账号共享**；不能做成每账号或全局滑窗。但当前没有这样的损失证据或阈值裁决，不能为了关闭台账硬造。

## 交付契约逐格核验

| 节点 | 结果 | 真实代码 |
|---|---|---|
| 单次调用重试 | **部分不符** | `proxyServer.ts:1962-2134` 的 `callWithRetry` 确有 `maxRetries` 有限循环、token 刷新、封禁检测和切号；但真正的端点遍历与 429 内层重试在 `kiroApi.ts:1991-2045,2228-2389`。七个所列调用点存在。 |
| 429 撞爆判据 | **符合** | `proxyServer.ts:4265-4278` 对 `Rate limited on ...` 做大小写不敏感匹配，消费者是 `runJsonRequestWithHold` → `runWithHold` 的切号/最终 giveup 路径。 |
| 每端点重试配置 | **producer 符合、consumer 不符** | 字段在 `types.ts:673-684`；实际消费者是 `kiroApi.ts:76-103,2331-2351`，不是 `callWithRetry`。 |
| 按账号退避 | **机制符合、时长描述不符** | `accountPool.ts:357-376,575-616`；默认基数是 `60000ms`（`:67-71`），不是“几秒级”。429 只增 `errorCount`，不写 `quotaExhaustedAt`。 |
| 总耐受预算待建 | **拒绝建造** | 找不到同一请求的无界 429 循环；新增固定总计数只会叠在现有有限边界上。 |
| 最终 sink | **符合且已存在** | 非 Hold 路径抛错收尾；Hold 路径先切未试账号，429 无兄弟号时由 `classifyNoAccountHold` 判 `transient-error` 并 giveup；只有封禁/额度/明确授权失效走既有挂起。 |
| 真跑 E2E 姿势 | **以诊断探针验证现状** | 临时集成测试走真实 `handleClaudeMessages → callWithRetry → callKiroApiStream`，仅 mock 最低层 HTTP 为持续 429；EU 两端点、每端点 1 次重试时严格 4 次 fetch 后收尾，未挂起、未标额度。探针已删除。 |

## 为什么当前请求不会无限打

1. `kiroApi.ts:2334-2384` 的 429 `while` 受 `retried < maxRetries` 约束；配置 setter 在 `:90-99` 把每端点重试夹到 `[1,50]`。
2. `getSortedEndpoints` 在 `:1991-2045` 返回有限集合：AmazonQ CLI 1 个、EU 2 个、US 3 个。因此单次 `callKiroApiStream` 在持续 429 下最多发出 `端点数 × (1 + rateLimitRetryMaxAttempts)` 次 HTTP 请求；默认分别是 9 / 18 / 27。
3. 更关键的实跑修正：端点链耗尽抛出的文案是 `Rate limited on ...`。`callWithRetry` 的 429 分支 `proxyServer.ts:2079-2110` 使用大小写敏感的 `includes('rate limit')`，并不命中该文案，所以当前真实链在第一个 outer attempt 后即走“其他错误”收尾，不会再跑默认 3 轮。派单把 `callWithRetry` 写成 429 内层 owner 是错误的。
4. 即使上层直接抛出能命中该分支的 `API error 429`，`callWithRetry` 仍受 `for (attempt < maxRetries)` 限制，且 `triedIds` 防止在同一个外层循环里反复切回旧账号。
5. Hold 路径的 `runWithHold` 也维护请求级 `triedIds`（`proxyServer.ts:4127-4143,4240-4253`）。429 本身不满足长期不可用判据；无新号时 `holdDecision.ts:99-106` 立即 giveup。若同时存在独立的封禁/额度账号而进入 Hold，仍受从请求接收起算、不重置的 `holdTotalBudgetMs` 绝对 deadline 约束。
6. 新的客户端请求当然可以重新尝试；那是多个请求，不是同一请求无界循环。要跨请求封顶必须新增全局入站限流/熔断语义，不能伪装成 #37 的“请求级预算”。

## 既有收尾与单账号穿透证据

- 持续 429：临时集成探针配置 `maxAttempts=1`，EU 两端点各“初始 + 1 重试”，日志显示 4 次真实上游尝试后 `API call failed (attempt 1/3): Rate limited on AmazonQ-EU after 1 retries`，随后响应结束；`numFailedTests=0`。
- 429 仍不是额度：`accountPool.ts:592` 只认 `statusCode === 402`；定向回归证明 `isQuotaExhausted=false`、`hasBlockedAccount=false`。
- 偶发 429 快速穿透逻辑未改：`kiroApi.ts:2335-2391` 的 fast + jitter 循环一字未动；本轮没有生产代码修改。
- 既有最终语义未改：`Rate limited on ...` 在 Hold 路径命中换号判据；无兄弟号后按 transient error 原样报错，不因 429 挂起。

## 验证

### 持续 429 诊断探针（临时文件，已删除）

命令：

```text
npx vitest run "test/main/proxy/__tmp_rateLimitExistingBound.test.ts" --reporter=default --reporter=json --outputFile.json="<tmp>.json" *> "<tmp>.log"
```

结果：`1 passed / 0 failed`，JSON `numFailedTests=0`。真实路径观察到 4 次 fetch 后收尾。

注：探针初稿曾按派单假设预期 `callWithRetry` 再跑 3 轮（12 次），实际只得到 4 次；日志直接证明 `Rate limited on ...` 不命中 `callWithRetry` 的大小写敏感分支。这是调查纠偏，不是功能 red→green。

### 429 / Hold 回归

命令：

```text
npx vitest run "test/main/proxy/quotaFalsePositive429.test.ts" "test/main/proxy/holdGateFalsePositive.test.ts" "test/main/proxy/holdGateFallbackCrossRegion.test.ts" --reporter=default --reporter=json --outputFile.json="<tmp>.json" *> "<tmp>.log"
```

结果：`47 passed / 0 failed`，JSON `numFailedTests=0`。

### 类型检查

`npm run typecheck`：EXIT 0。

全仓 Vitest 未重跑：本轮按 STOP 结论没有生产代码或永久测试改动；派单给出的基线为 1821 total / 1815 passed / 0 failed / 6 pending。

TDD red→green：**not applicable**，因为契约要求在现有机制已覆盖时停止，未实施功能。临时诊断探针仅用于验证真实控制流，已删除。

## Review Findings

1. Tier 1 纠偏：派单把端点切换/429 内层重试归给 `callWithRetry`；真实 owner 是 `kiroApi.callKiroApiStream`。
2. Tier 1 纠偏：派单把 `rateLimitRetry*` 的 consumer 写成 `callWithRetry`；真实 consumer 是 `kiroApi.ts` 的内层循环。
3. Tier 1 纠偏：`callWithRetry` 虽接收 `endpointIndex`，七个生产回调都没有消费第二参数；它本身的 `endpointIndex` 翻转不控制真实端点顺序。
4. Tier 1 纠偏：账号池默认 429 冷却基数为 60 秒，不是派单所称“几秒级”；同时有 10% 概率重试。
5. 隐藏风险（未改）：`callWithRetry` 的限流字符串判据与 `isSwitchWorthyError` 不同；后者能识别 `Rate limited on ...`，前者不能。这让非 Hold 与 Hold 路径的外层重试/切号次数不同。它不造成无界重试，反而更早失败；是否统一属于另一个成功率语义决策，不能顺手改。
6. 触及文件：仅本报告；临时诊断测试和所有临时 JSON/log 已删除。生产源码与永久测试均未修改。
7. 收尾时发现工作树已出现其他并发任务的改动（两个 `accountService` 测试被修改，并新增若干 webPanel/renderer 测试）；它们不属于本任务，我未读取、修改或清理。`git diff --check` 仍为 EXIT 0。

## Update Log

- 2026-08-13 · executor：核实 #37 的真实调用链与边界；持续 429 集成探针证明当前请求有限收尾，定向 47/47 与 typecheck 通过；按契约 STOP，不新增重复预算或退避。
