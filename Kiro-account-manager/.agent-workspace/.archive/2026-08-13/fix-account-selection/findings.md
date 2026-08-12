# 账号选择生产接线修复记录

日期：2026-08-13  
基线：`d8f957e` (`main`)  
范围：`proxyServer.ts` 账号选择/hold 调用点、`selectedAccountFallback.ts`、`holdDecision.ts`、`test/main/proxy/selectedAccountFallback.test.ts`

## 结论

两个已复现缺陷均已通过真实 `ProxyServer.getAvailableAccount` 接线测试锁定并修复：

1. 单账号模式的直接选中、额度自动切换、偏好回退、无 UI 偏好四条候选路径，现在共用同一份准入/可用性判据；API Key 绑定、分组和 capability 准入不能被回退绕过。
2. 选中账号无论是缺失还是存在但不可用，都在读取后立即进入 `resolveSelectedPreference`，不再只有 `account === null` 才回退。
3. 绑定子集内没有可用账号时返回 `null`，交回既有 no-account 路径，由 hold 开关决定挂起或报错；绝不选绑定外账号。
4. `holdDecision` 的三个死入参及调用点的无效计算已删除。

未修改 `src/main/server/**`、`src/main/ipc/panelProxyDeps.ts`、架构接线测试或 GPT-halt SSE 区域；未 commit、未 stash、未回退其他工作树改动。

## 侦察与代码证据

- `codegraph-codegraph_explore` 追踪了 `getAvailableAccount → getAllowedAccountIds / getNextAvailableAccount / isAccountAvailable`，确认原单账号分支的三条候选路径没有统一准入。
- `codebase-context-engine-search_context` 在当前磁盘（含未跟踪文件）检索真实 ProxyServer 测试样板及 hold 调用方。
- 语义调用图确认 `classifyNoAccountHold` 的生产调用点只有 `ProxyServer.classifyHold`；其余命中为测试/历史索引，没有第二个生产调用方需要迁移。
- `AccountPool.getNextAvailableAccount` 先按池内 `isAccountAvailable` 选择，但无立即可用项时会返回最短冷却候选，因此 `resolveSelectedPreference` 不能目信任 `pickAnyUsable()`，必须再次调用同一个 `isUsable`。

## TDD：Defect 1（绑定逃逸）

### Red

先只加入“missing-selected fallback 必须留在 keyA→A 绑定内”的真实生产接线测试：

- 命令：`npx vitest run test/main/proxy/selectedAccountFallback.test.ts --reporter=json --outputFile=.agent-workspace-red-binding.json`
- 结果：`numPassedTests=8`、`numFailedTests=1`、EXIT=1
- 正确失败原因：期望 `A`，实际选中 `B`。

随后补齐直接选中、额度自动切换、绑定子集无可用项等生产路径：

- 结果：`numPassedTests=8`、`numFailedTests=5`、EXIT=1
- 实际错误分别为：missing fallback 取 `B`、无可用绑定项仍取 `B`、直接选中越权取 `B`、关闭自动切换仍返回耗尽的 `Q`、自动切换越权取 `B`。

又发现“未配置 UI 偏好”分支会目信任 selector 的最短冷却候选，先补测试：

- 结果：`numPassedTests=13`、`numFailedTests=1`、EXIT=1
- 正确失败原因：绑定内 `A` 已耗尽，预期 `null`，实际仍返回 `A`。

### Green

- `proxyServer.ts` 在单账号分支只定义一次 `isUsable`，综合 `isAllowed`、suspended、quota、`isAvailable`、不可刷新的过期 token。
- 先把不满足 `isAllowed` 的账号加入 `excludedIds` 再交给池选择。
- `selectedAccountFallback.ts` 对有偏好 fallback 和无偏好候选都再次执行同一个 `isUsable`，防止 selector 的降级候选绕过边界。
- 聚焦测试最终：`numPassedTests=14`、`numFailedTests=0`、EXIT=0。

绑定子集无可用账号的明确行为：返回 `null`。上层继续走既有 `classifyNoAccountHold`：hold 开启时按池状态挂起，关闭时立即报错；任何情况下都不允许逃到绑定外账号。

## TDD：Defect 2（present-but-unusable 不回退）

### Red

真实 `getAvailableAccount` 测试构造：

- 选中 `Q`；
- `Q` 已 quota exhausted；
- 健康账号 `H` 在池中；
- `autoSwitchOnQuotaExhausted=false`。

Red 结果：预期 `H`，实际返回 `Q`（包含在上述 `numFailedTests=5` 的红灯中）。

### Green

读取选中账号后立刻调用 `resolveSelectedPreference`，因此 missing、suspended、quota-exhausted、授权范围外都走同一路径。Green 断言：

- 本次请求选中 `H`；
- 配置中的偏好仍为 `Q`（关闭自动切换不改写用户选择）。

## `autoSwitchOnQuotaExhausted` 决策

该设置不冗余，也没有改变其用户可见含义：

- “选中账号是偏好”决定本次请求在偏好不可用时必须尽量用健康账号服务。
- `autoSwitchOnQuotaExhausted=false`：仅本次请求回退，不改写 `selectedAccountIds`，不触发 `onAccountUpdate`。
- `autoSwitchOnQuotaExhausted=true`：本次请求安全回退后，把经相同授权/可用性过滤的回退号提升为新的 UI 偏好，并触发原有更新回调。

因此开关继续控制“是否持久提升偏好”，而不是“是否允许本次请求可用性回退”。把它解释为硬性禁止回退会恢复 `d8f957e` 明确撤销的硬约束语义。

## Defect 3（死参数清理）

这是无行为变化的接口清理，不人为制造失败业务测试：

- 删除 `NoAccountHoldInput.poolSize`、`selectedAccountIds`、`selectedAccountInPool`；
- 删除实现中的解构和三个 `void`；
- 删除 `ProxyServer.classifyHold` 为它们读取账号/计算可用性的 IIFE。

验证：

- 语义搜索确认唯一生产调用点已迁移；
- `npm run typecheck:node` → EXIT=0；
- hold 回归套件全部通过，说明 action/reason 未改变。

## 修复前后探针

修复前（评审探针，并由新增红灯独立复现）：

```text
{"scenario":"binding-fallback","allowed":["A"],"picked":"B"}
{"scenario":"unusable-selected","selected":"Q","picked":"Q","isQuotaExhausted":true}
```

修复后，同样通过真实私有生产方法运行，EXIT=0：

```text
{"scenario":"binding-fallback","allowed":["A"],"picked":"A"}
{"scenario":"unusable-selected","selected":"Q","picked":"H","configured":"Q"}
{"scenario":"binding-no-usable","allowed":["A"],"picked":null}
```

## 最终验证

命令：

```text
npx vitest run test/main/proxy/selectedAccountFallback.test.ts test/main/proxy/holdGateFallbackCrossRegion.test.ts test/main/proxy/holdGateFalsePositive.test.ts test/main/proxy/holdGateStreamWiring.test.ts test/main/proxy/holdGateMultiPathWiring.test.ts --reporter=json --outputFile=.agent-workspace-proxy-fixes-final.json
```

JSON：`numPassedTests=56`、`numFailedTests=0`、`numPendingTests=0`，EXIT=0。

`npm run typecheck:node`：EXIT=0。

## 明确拒绝的改法

- 不把 UI 选中账号恢复成硬约束：与 `d8f957e` 的产品语义及现场 92 次 503 的根因相反。
- 不让 `autoSwitchOnQuotaExhausted=false` 禁止本次请求回退：这会把设置从“是否提升偏好”偷换成“是否拒绝服务”。
- 不扩大或改写 `isQuotaExhausted`，也不把 low quota / 429 纳入 quota：hold 回归继续证明 429、5xx、400、网络错立即报错，只有账号长期不可用进入 hold。
- 不为三个死参数保留“以后日志可能用”的伪接口；若需要归因，应在日志层按需读取。
- 不改 `AccountPool` 公共 API：本轮在既有 selector 后用同一 `isUsable` 复核即可闭环，扩大所有权和公共接口属于不必要改造。

## 动作闸门核验

⚡ 已先用 codegraph 与 codebase-context-engine 语义检索列出账号选择、`resolveSelectedPreference`、`classifyNoAccountHold` 的定义/消费点（fast-context 同轮调用返回 `resource_exhausted`），再以最终 `git diff` 和类型检查核对传播；所有实际生产消费点均已迁移，未依赖只看 tracked 文件的单一搜索结论。
