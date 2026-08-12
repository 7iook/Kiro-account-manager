# 独立审查：桌面回归风险（8c42227）

审查对象：`8c42227cbaa74106c8efad7166bd71841d060579`
父提交：`049dd48536bf703d1913c405255bd189c9efb255`
审查范围：协调者收窄后的问题 A（删除符号是否存在第四个范围外消费者）与问题 B（工厂装配/启动顺序）。
审查方式：只读；未修改业务源码，未暂存、提交或 stash，未读取真实账号凭据。

## Strengths
- `src/main/index.ts:262-302`：`currentUsageApiType`、`useKProxyForApi` 均先于 `createUpstreamApi({...})` 初始化，且注入闭包 getter，避免模块求值期 TDZ 与状态快照固化。
- `src/main/upstreamApi/index.ts:114-130`、`transport.ts:136-139`、`usage.ts:58-207`：子工厂构造只保存或解构函数引用；真正读取 `useKProxy`/`getUsageApiType` 发生在运行期业务函数内。
- `src/main/index.ts:2222-2246`、`src/main/tray.ts:138-153,322-344`：启用托盘时，`loadTraySettings()` 先完成，`createTray()` 随即同步构建菜单并调用 `getProxyStatus()`，从而在 `createWindow()`（`index.ts:5872`）前进入 `initProxyServer()` 恢复持久化配置。
- `src/main/server/accountApi.ts:69-83`：新共享工厂存在真实 server 生产消费者，不是仅由测试调用的孤儿抽象。

## Issues

### P0 / Critical（Must Fix）
无已确认代码缺陷。

### P1 / Important（Should Fix）
无已确认代码缺陷。

### P2 / Minor（Nice to Have）
无。

### 未验证门禁（导致 UNKNOWN）
- `src/main/index.ts:296,2222-2246,5872` — **What**：目标提交替换了 Electron 主进程上游 API 装配，但没有一次真实 Electron 桌面启动证据；现有 34 个测试仅覆盖共享工厂/无 Electron 运行。**Why**：主产品的模块求值、`app.whenReady()`、托盘同步建菜单、窗口创建及 Electron 环境依赖只能由真实桌面运行验证，现有证据不足以判断是否存在目标提交引入的 P0 桌面回归。**How**：在目标提交上执行一次可复现的 Electron 桌面 smoke test，至少留下进程成功进入 `ready-to-show`、托盘创建、窗口可显示且无主进程未捕获异常的原始日志与退出状态。

## 问题 A：第四个范围外消费者
使用 `[IO.Directory]::EnumerateFiles(..., AllDirectories)` 对磁盘上的 `src/` 做了不依赖 Git 索引的检索，并按约束排除 `src/main/proxy/**` 与 `src/renderer/**`。原始结尾：

```text
FS_SCAN_ALL_FILES=244
FS_SCAN_SOURCE_FILES=93
FS_SCAN_EXIT=0
```

结论：未发现第四个必须继续保留旧 `index.ts` 本地实现的范围外消费者。三个已知保留点均仍有活消费者：
- `MICROSOFT_TOKEN_ENDPOINT_HOSTS`：`src/main/index.ts:945,3864`；共享 refresh 模块另有独立集合。
- `KIRO_AUTH_ENDPOINT`：`src/main/index.ts:55,4071,4122`。
- `fetchWithAppProxy`：`src/main/index.ts:313,321` 并由既有登录/导入路径继续消费。

其余磁盘命中均归入共享模块定义/内部调用、accountService 注入契约、server 装配、类型镜像或独立同名实现，不构成删除遗漏。该结论只覆盖静态磁盘源码检索，不替代 Electron 运行验证。

## 问题 B：工厂装配与启动顺序
1. 声明顺序：`currentUsageApiType`（`index.ts:262`）与 `useKProxyForApi`（`:274`）先于工厂（`:296`），无 TDZ。
2. 构造期：`createUpstreamApi` 依次创建 transport/refresh/sso/usage，但构造函数不调用动态 getter；`deps.useKProxy()` 首次出现在 `transport.ts:139` 的运行期函数内，`getUsageApiType()` 出现在 `usage.ts:207` 的业务调用内。
3. 启动期：`app.whenReady()`（`index.ts:2222`）先 `await loadTraySettings()`（`:2245`），再 `initTray()`（`:2246`）。托盘启用时，`createTray()` 在 `tray.ts:344` 同步执行 `buildTrayMenu()`，该函数在 `:153` 调用 `getProxyStatus()`，进而进入 `initProxyServer()`（`index.ts:466`）恢复保存的 `usageApiType/useKProxyForApi`；此过程早于 `createWindow()`（`:5872`）。
4. 父版本对照：父提交同样是 `loadTraySettings()`（旧 `index.ts:3201`）后 `initTray()`（`:3202`），且 `src/main/tray.ts` 在两提交间无变化（`git diff --quiet ... -- tray.ts` 返回 `TRAY_DIFF_EXIT=0`）。因此该迁移没有改变这段启动时序。
5. 托盘禁用分支不会由托盘触发 `initProxyServer()`；但这是父版本已存在的行为，本目标提交未引入。动态 getter 仍会在后续调用时读取届时的当前状态。

## Verification Evidence

### Git / diff
```text
8c42227 feat(server): 服务端能自己刷 token 了 —— index.ts 切到共享模块 · accountApi 接线
 Kiro-account-manager/src/main/index.ts             | 1050 +-------------------
 Kiro-account-manager/src/main/server/accountApi.ts |   92 ++
 Kiro-account-manager/src/main/server/assembly.ts   |   77 +-
 Kiro-account-manager/src/main/server/entry.ts      |   15 +
 4 files changed, 200 insertions(+), 1034 deletions(-)
SHOW_EXIT=0
DIFF_CHECK_EXIT=0
```

### 专项测试
命令：`npx vitest run test/main/upstreamApi/createUpstreamApi.test.ts test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts --reporter=json --outputFile=.../vitest-upstream-api-rerun.json`

```text
VITEST_EXIT=0
{"success":true,"numTotalTestSuites":11,"numPassedTestSuites":11,"numFailedTestSuites":0,"numTotalTests":34,"numPassedTests":34,"numFailedTests":0}
```

此证据只证明共享工厂与无 Electron 运行测试通过。`unverified: Electron 桌面应用未实际启动，故无法证明真实桌面启动、托盘、窗口及交互链无回归。`

### Phase 6 wiring probe 原始输出
```text
SYNC_EXIT=0
{
  "symbol": "createUpstreamApi",
  "callers": [
    {
      "name": "index.ts",
      "kind": "file",
      "filePath": "src/main/index.ts",
      "startLine": 1
    },
    {
      "name": "createServerAccountApi",
      "kind": "function",
      "filePath": "src/main/server/accountApi.ts",
      "startLine": 69
    },
    {
      "name": "createUpstreamApi.test.ts",
      "kind": "file",
      "filePath": "test/main/upstreamApi/createUpstreamApi.test.ts",
      "startLine": 1
    },
    {
      "name": "upstreamApiWithoutElectron.runtime.test.ts",
      "kind": "file",
      "filePath": "test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts",
      "startLine": 1
    },
    {
      "name": "review-new-index.ts",
      "kind": "file",
      "filePath": ".agent-workspace/review-new-index.ts",
      "startLine": 1
    },
    {
      "name": "accountApi.ts",
      "kind": "file",
      "filePath": "src/main/server/accountApi.ts",
      "startLine": 1
    }
  ]
}
CALLERS_EXIT=0
```

## 七阶段适用性
1. **Phase 1 · Spec Conformance：未通过。** 收窄后的 A/B 静态验收均满足，但原始门禁明确要求不得用 build/typecheck/单测替代 Electron 运行证据；真实桌面尚未启动，故完整桌面回归要求未获证明。
2. **Phase 2 · Task-Ledger Evidence Gate：not applicable。** 协调者确认本仓没有 `docs/specs/`，本轮无任务账本。
3. **Phase 3 · Code Quality：通过（限本轮范围）。** 未发现并行旧实现残留、构造期 getter 读取、宽泛异常吞噬或新增硬编码秘密；`git diff --check` 为 EXIT=0。
4. **Phase 4 · Domain-Model Consistency：not applicable。** 文件系统查询未发现 `docs/domain/*-model.md`，且本轮未审查领域模型变更。
5. **Phase 5 · Upstream Root Cause：not applicable。** 本轮没有确认待修代码缺陷；审查对象是迁移完整性与启动顺序，未提出下游补丁。
6. **Phase 6 · Whole-Path Completeness：生产接线通过，整体门禁未通过。** 上述原始输出显示 `src/main/index.ts` 与 `src/main/server/accountApi.ts` 均为生产消费者；但最终 Electron 桌面 sink 未实跑，因此不能宣称 whole-path 完成。未提供独立的交付契约/§0.16 完成报告，相关合同字段 `unverified: 本轮输入未提供可核对文本`。
7. **Phase 7 · Business Reality / YAGNI：not applicable。** 收窄审查仅判断迁移消费者与启动顺序，不评估或新增业务能力；共享模块本身来自前序提交 `af94451`。

## VERDICT
status: UNKNOWN
critical_count: 0
important_count: 0
minor_count: 0
ready_to_merge: NO
one_line: 静态范围扫描、启动顺序和生产 wiring 均未发现目标提交缺陷，但缺少真实 Electron 桌面启动证据，当前证据不足以判断主产品是否存在 P0 回归。
