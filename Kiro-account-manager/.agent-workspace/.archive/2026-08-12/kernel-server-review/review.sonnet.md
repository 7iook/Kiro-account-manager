# 六提交无头服务端独立审查

审查目标：`3354d50ff2904860cc3798f43ba5ead109371582`；范围为 `181b169`、`8687d58`、`afe80af`、`8e1099e`、`3adda90`、`3354d50`，明确排除 `94e7c76`、`7b03afb`、`75df034`、`7c63d4c`。

用户成功标准：Linux 服务端运行后，即使所有者关闭自己的电脑，reverse proxy 仍持续服务，手机 LAN web panel 仍能管理账户；不能把短时启动或尚未过期的 access token 当成最终达标。

### Strengths
- `src/main/server/assembly.ts:113-136,232-235,341-349`：缺失的 `ServerAccountApi` 采用调用即抛并在启动时明确告警，而不是 silent no-op；告警还准确限定为“token 有效期内成立、过期后不成立”。
- `src/main/accountService/check.ts:389-395`、`src/main/accountService/refresh.ts:242-247`、`src/main/webPanel/routes.ts:163-171`：检查与手动刷新都把未接线异常归一为 `{ success:false }`，HTTP 层映射为非 2xx，不会落入 `undefined -> 200 { success:true }`。
- `src/webPanel/api/client.ts:100-156`、`src/webPanel/App.tsx:113-139,297-303`：浏览器端对非 2xx 抛稳定 `PanelApiError`，`runAction()` 展示错误并清除 pending；失败后不会执行 `loadAccounts()` 或显示“Token 已刷新”。
- `src/main/proxy/proxyServer.ts:1564-1597`：续期回调失败或抛错时记录错误、`markNeedsRefresh()` 并返回 `false`，没有伪装成功。
- 定向测试的 JSON reporter 结果均为成功且无 pending：architecture 60/60、security/store 76/76、refresh 39/39、server assembly/persistence 34/34、panel UI 20/20。

### Issues

#### Critical (Must Fix · blocks merge)
- `src/main/server/entry.ts:57-77`；`src/main/server/assembly.ts:232-235,341-349` — **What**：生产 `bootstrap()` 调用 `assembleServer({ config, adminKeyStore })` 时未注入真实 `accountApi`，所以必然选择 `unwiredAccountApi()`。**Why**：现有 access token 到期后，反代无法自动续期；手机“检查账号”和“手动刷新”也只能明确报错，无法完成管理动作，直接违反关机后的长期自治成功标准。**How**：把 `index.ts` 中的刷新、usage、user/profile 与 Kiro token 文件能力抽成零 Electron 的共享上游模块，由桌面与服务端 assembly 注入同一实现；不得在服务端复制第二套刷新逻辑。**复现证据**：本轮读取生产入口确认仅传两个参数；启动告警明确写出 token 过期后不成立；`ProxyServer.doRefreshToken()` 对回调异常执行 `markNeedsRefresh()` 并返回 `false`。

#### Important (Should Fix · quality impact)
- `src/main/index.ts:34-41,3953-3967`；`src/main/accountService/backgroundRefresh.ts:1-437`；commit `3adda90` 说明中的“`src/main/index.ts` 净减 310 行” — **What**：该承重断言与提交 diff 不符；本轮 parent 对比得到 `BEFORE_LINES=6467 AFTER_LINES=6467 DELTA=0`，numstat 仅显示新增 `backgroundRefresh.ts` 437 行。**Why**：错误的交付记录会把当前 HEAD 中由排除提交 `75df0345` 完成的生产接线错误归因给 `3adda90`，妨碍后续审计与回滚。**How**：修正提交/交付说明，准确区分 `3adda90` 的模块新增与 `75df0345` 的后续接线。**复现证据**：`git show 3adda90^:Kiro-account-manager/src/main/index.ts` 与 commit 版本行数相同；`git blame` 将当前 wrapper/import 接线归于 `75df0345`。

#### Minor (Nice to Have)
- 无。

### 七阶段裁决
1. **Phase 1 · Spec Conformance：FAIL。** 六提交实现了可启动的无头服务端、面板和短期转发，但未满足 token 到期后的持续反代与账户管理；这不是“现有 token 尚有效”可替代的验收项。
2. **Phase 2 · Task-Ledger Evidence Gate：not applicable。** 正式 `server-migration-decision/decision-card.md` 不含 `## 任务清单`、`[x]` 或 `**Evidence**`；`HANDOVER-2026-08-10.md` 是会话建议表，不是六提交完成账本，不能人为升级为 Evidence Critical。
3. **Phase 3 · Code Quality：FAIL。** fail-fast、单一注入缝和错误传播质量良好，但生产依赖仍是占位实现；核心业务路径未闭合。
4. **Phase 4 · Domain-Model Consistency：not applicable。** 本轮检索未发现 `docs/domain/*-model.md`。
5. **Phase 5 · Upstream Root Cause：FAIL。** 第一处正确责任层是 `index.ts` 所持上游 API 的共享化与双宿主注入；在面板或反代尾端补 fallback、或复制第二套 token 刷新，都不是可接受修复。
6. **Phase 6 · Whole-Path Completeness：FAIL。** `assembleServer` 有生产 caller，但该 caller 没有提供真实 `accountApi`；定义被调用不等于依赖已接线。手机端失败是明确错误而非空成功，但这仍是功能不可用。
7. **Phase 7 · Business-Reality / YAGNI：FAIL（业务缺口真实，非 YAGNI）。** 具体场景是所有者关机后，服务端必须独立跨 token 到期继续转发并由手机管理；缺少共享上游实现会造成真实服务中断。必要能力应共享，复制第二套才是过度实现和第二 SSOT。

### Whole-Path wiring probe 原始输出
执行顺序：先对 `F:\Kiro-account-manager\Kiro-account-manager` 执行 `codegraph sync -q`，再查询 callers。原始输出如下：

```text
SYNC_EXIT=0
{
  "symbol": "assembleServer",
  "callers": [
    {
      "name": "bootstrap",
      "kind": "function",
      "filePath": "src/main/server/entry.ts",
      "startLine": 57
    },
    {
      "name": "entry.ts",
      "kind": "file",
      "filePath": "src/main/server/entry.ts",
      "startLine": 1
    },
    {
      "name": "serverAssembly.test.ts",
      "kind": "file",
      "filePath": "test/main/server/serverAssembly.test.ts",
      "startLine": 1
    }
  ]
}
ASSEMBLE_EXIT=0
{
  "symbol": "backgroundBatchRefresh",
  "callers": [
    {
      "name": "index.ts",
      "kind": "file",
      "filePath": "src/main/index.ts",
      "startLine": 1
    },
    {
      "name": "backgroundRefreshPersistence.test.ts",
      "kind": "file",
      "filePath": "test/main/accountService/backgroundRefreshPersistence.test.ts",
      "startLine": 1
    },
    {
      "name": "batchRefreshTokens",
      "kind": "function",
      "filePath": "src/renderer/src/store/accounts.ts",
      "startLine": 1909
    },
    {
      "name": "triggerBackgroundRefresh",
      "kind": "function",
      "filePath": "src/renderer/src/store/accounts.ts",
      "startLine": 3379
    },
    {
      "name": "tmp-review-inflight-window.test.ts",
      "kind": "file",
      "filePath": "tmp-review-inflight-window.test.ts",
      "startLine": 1
    }
  ]
}
BACKGROUND_EXIT=0
```

说明：`tmp-review-inflight-window.test.ts` 是未跟踪测试文件，不算生产 wiring；`backgroundBatchRefresh` 当前生产消费者存在，但 `git blame` 显示该接线来自明确排除的 `75df0345`。

### 验证证据
- `npx vitest run ... --reporter=json --outputFile=<tmp>` 的本轮 JSON：
  - architecture：16/16 suites，60/60 tests，failed=0，pending=0。
  - security/store：20/20 suites，76/76 tests，failed=0，pending=0。
  - refresh：15/15 suites，39/39 tests，failed=0，pending=0。
  - server assembly + refresh persistence：11/11 suites，34/34 tests，failed=0，pending=0。
  - panel UI：7/7 suites，20/20 tests，failed=0，pending=0。
- `src/main/server/entry.ts:77` 的生产调用与 `assembly.ts:232-235` 的缺省选择已逐行核实。
- `src/main/accountService/check.ts:389-395` 与 `refresh.ts:242-247` 的异常归一、`routes.ts:163-171` 的非 2xx 映射、`client.ts:100-156` 与 `App.tsx:113-139,297-303` 的用户错误呈现已逐层核实。因此“检查账号”和“手动刷新”是明确失败，不是空成功。
- `src/main/proxy/proxyServer.ts:1564-1597` 已逐行核实：刷新失败或异常均标记 `needsRefresh` 并返回 `false`。
- 提交断言复核原始关键输出：`BEFORE_LINES=6467 AFTER_LINES=6467 DELTA=0`；`437 0 Kiro-account-manager/src/main/accountService/backgroundRefresh.ts`。

### 验证边界
- unverified: 未在本 Reviewer 环境进行真实 Linux、systemd、POSIX `0600` 与只安装 production dependencies 的冒烟；这不影响未接线结论，因为生产入口确定选择调用即抛的占位 API。
- unverified: 未等待真实第三方 access token 自然到期做长时端到端实验；静态生产调用链和 `doRefreshToken()` 实际失败语义已直接证明到期后无法自动恢复。
- 未把定向测试通过外推为最终产品达标；229/229 只覆盖所运行的测试集合。

## VERDICT
status: NEEDS_CHANGES
critical_count: 1
important_count: 1
minor_count: 0
ready_to_merge: NO
one_line: 无头服务端已能启动并明确失败，但生产 `accountApi` 未接线使 token 到期后的反代与手机管理不可持续，尚未达到关机后长期自治目标。
