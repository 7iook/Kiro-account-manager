# Upstream API Extraction 独立审查

审查对象：`af94451`、`8c42227`（目标 `main@8c42227`）。审查边界：只读生产代码与 Git 对象；未修改 `src/main/proxy/**`、`src/renderer/**` 或任何生产代码，未读取真实凭据，未执行 `git add` / `git commit` / `git stash`。

### Strengths
- `src/main/upstreamApi/transport.ts:138-193`：运行时 `useKProxy`、K-Proxy service、设备 ID 与 network agent 均通过 getter/单一 transport 入口读取；独立对账确认桌面 setter 与 getter 指向 `src/main/index.ts:265,277,299-307` 的同一模块变量，避免配置在 factory 创建时被快照。
- `src/main/server/accountApi.ts:69-87`：服务端复用同一个 `createUpstreamApi`，且 `getDeviceIdForUa` 来自 K-Proxy service 的 64-hex device ID，不是 `machineId.ts` UUID；这保住了 K-Proxy UA 改写承重路径。
- `src/main/upstreamApi/refresh.ts:16-33,94-157`、`transport.ts:67,162`：`MICROSOFT_TOKEN_ENDPOINT_HOSTS`、`KIRO_AUTH_ENDPOINT`、`fetchWithAppProxy` 三个 survivor 均有真实消费者；旧 `index.ts` 的 11 个范围外 `fetchWithAppProxy` 调用仍在。
- `src/main/upstreamApi/usage.ts:58-207`：`normalizeResetDate`、`fetchRestApi` 与动态 REST/CBOR 分支完整搬移；20 个目标函数经独立 TypeScript AST 节点对账全部闭合。
- `src/main/index.ts:55,299-321`、`src/main/server/entry.ts:60`：桌面与 headless server 均接入 factory；Phase 6 的 machine callers 输出也确认存在非测试生产调用方。

### Issues

#### Critical (Must Fix · blocks merge)
无。独立 AST、调用点、测试、类型检查、构建和生产 wiring 证据均未发现行为变化或静默禁用运行时设置。

#### Important (Should Fix · quality impact)
1. `.agent-workspace/.archive/2026-08-12/upstream-api-extract/classify-diff.cjs:12-15` — **What：**device-ID seam 的旧/新正则只锚定行尾，没有锚定整行，同行前缀发生任意语义变化仍会被判成合法 `SEAM`。**Why：**该脚本是“15 行差异全属预期”的主证明，却会把真实行为改动报告为 `UNEXPECTED=0`；用户可见故障可能是错误设备 ID 来源被接受，导致 UA 改写或账号绑定行为失真而审查仍假绿。**How：**改为整行精确 AST/文本配对，并加入一个“前缀被篡改时必须 exit 非零”的负向自测。**Repro：**把新行从 `const machineId = accountMachineId || deps.getDeviceIdForUa()` 改为 `const machineId = attackerControlled || deps.getDeviceIdForUa()`，现有规则仍返回 seam；本轮控制实验结果为 `badSemanticChangeStillClassifiedSeam=true`。
2. `.agent-workspace/.archive/2026-08-12/upstream-api-extract/extract-bodies.cjs:14-28,34-55,65-67` — **What：**提取器以“第一行同缩进的孤立 `}`”作为函数结束、函数集合由手写 `CASES` 决定，并直接读取工作树而非锁定 `af94451^` Git 对象。**Why：**未来重跑可截断带同缩进嵌套块的函数、漏掉未列入 CASES 的搬移函数，或因工作树漂移伪造旧基线；用户可见风险是行为变化被“完整函数体逐字节等价”证据错误放行。**How：**直接从指定 Git revision 读取源文件，用 TypeScript AST 枚举并提取完整 `FunctionDeclaration`，再双向对账删除集合。**Repro：**在目标函数中加入与声明同缩进的独立闭合块，或在旧 `index.ts` 增加第 21 个待搬移函数但不改 `CASES`；脚本会提前结束或保持 `TOTAL=20`。注：本轮缓存本身已被独立 AST 证明 20/20 正确，因此这是证明工具缺陷，不是当前生产行为缺陷。

#### Minor (Nice to Have)
1. `src/main/upstreamApi/refresh.ts:106,112,115`、`sso.ts:144`、`transport.ts:194,206`、`usage.ts:132,161,175,233,234,247,248,297,298,310,311` — **What：**17 处尾随空白使 `git diff --check` 退出 2。**Why：**不影响运行时，但会污染 diff，并在启用 whitespace gate 的流水线阻断合并。**How：**移除尾随空白，并由 AST 语义对账而不是保留空白来证明行为等价。**Repro：**运行 `git diff --check af94451^ 8c42227 -- Kiro-account-manager/src/main`。

### 7-Phase Check

1. **Phase 1 · Spec Conformance — FAIL（证据工具）/生产行为通过。** 独立 TypeScript AST 审计确认 20 个搬移函数完整，旧删除集合为 20 个搬移实现加 `getCurrentMachineId`、`getKProxyAgent` 两个被 DI 消除的 helper；8 个 seam 逐项同源。外部生产调用旧/新均为 19 个（`fetchWithAppProxy=11`、`refreshTokenByMethod=5`、其余各 1），callee、arity、参数顺序和参数 AST 文本完全一致。但交付要求包含可信的“零变化证明”，而两个证据脚本存在 Important 假绿风险，故整体 gate 未过。
2. **Phase 2 · Task-Ledger Evidence Gate — not applicable：**目标 artifact `upstream-api-extract/findings.md` 不含 `## 任务清单`，仓库也无 `docs/specs/*/tasks.md`；没有 `[x]` 项可核验。
3. **Phase 3 · Code Quality — PASS with Minor。** factory/transport/refresh/sso/usage 分层单向，未见平行生产实现、宽泛吞错、硬编码 secret 或死代码；`git diff --check` 因 17 处尾随空白 exit 2。
4. **Phase 4 · Domain-Model Consistency — not applicable：**仓库无 `docs/domain/*-model.md`，本轮也未改变领域 substrate/schema。
5. **Phase 5 · Upstream Root Cause — PASS。** 抽取发生在最早正确责任层：Electron God-file 中的 upstream 能力成为共享 factory，由桌面和 headless server 复用；未以 downstream fallback 或重复实现绕过。
6. **Phase 6 · Whole-Path Completeness — PASS。** `createUpstreamApi` 有桌面和服务端生产消费者；`createServerAccountApi` 有 `bootstrap` 生产消费者。19 个范围外调用点全部保持。原派单未提供独立 `[交付契约]`/§0.16 completion-report 文本，故该文档格式检查不适用；实际 user-view 目标“桌面行为不变且服务端可复用、运行时设置不得静默失效”已由生产接线、AST 对账和运行时测试覆盖。raw probe 如下。

```text
SYNC_EXIT=0
{
  "symbol": "createUpstreamApi",
  "callers": [
    {"name":"index.ts","kind":"file","filePath":"src/main/index.ts","startLine":1},
    {"name":"createServerAccountApi","kind":"function","filePath":"src/main/server/accountApi.ts","startLine":69},
    {"name":"createUpstreamApi.test.ts","kind":"file","filePath":"test/main/upstreamApi/createUpstreamApi.test.ts","startLine":1},
    {"name":"upstreamApiWithoutElectron.runtime.test.ts","kind":"file","filePath":"test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts","startLine":1},
    {"name":"review-new-index.ts","kind":"file","filePath":".agent-workspace/review-new-index.ts","startLine":1},
    {"name":"accountApi.ts","kind":"file","filePath":"src/main/server/accountApi.ts","startLine":1}
  ]
}
CALLERS_createUpstreamApi_EXIT=0
{
  "symbol": "createServerAccountApi",
  "callers": [
    {"name":"bootstrap","kind":"function","filePath":"src/main/server/entry.ts","startLine":60},
    {"name":"entry.ts","kind":"file","filePath":"src/main/server/entry.ts","startLine":1}
  ]
}
CALLERS_createServerAccountApi_EXIT=0
```

7. **Phase 7 · Business-Reality / Anti-Solution-Jumping — PASS。** 真实场景是 headless server 中账号 token 到期后必须继续刷新并查询用量；缺失会使服务端账号不可用。实现复用桌面 upstream API 的单一实现，没有新建平行 SSOT，也未给纯读路径添加人为 limiter。

### Verification Evidence
- Git 权威旧源：`git show af94451^:Kiro-account-manager/src/main/index.ts`；落盘 SHA256 `f9fafe18b090d884857ee71174f54d2e693189b703b02372622eac64c73af915`。
- 独立 AST 函数审计：`movedCount=20`；`transport=8, refresh=6, sso=1, usage=5`；`bodies/old` 20/20 等于 `af94451^` 完整 AST 节点，`bodies/new` 20/20 等于 `8c42227` 新模块 AST 节点；旧删除函数 22 个 = 20 个搬移函数 + 2 个 DI helper。
- 独立调用点审计：`AUDIT_CALL_SITES_EXIT=0`；`oldCount=19, newCount=19, onlyOld=0, onlyNew=0`，callee、arity、参数顺序和参数 AST 文本一致。
- 交付 classifier 当前真实结果：`TOTAL CHANGED LINES=15 UNEXPECTED=0 CLASSIFIER_EXIT=0`；但控制实验已证明其 machine-ID regex 可假绿，故不单独依赖该结论。
- 定向测试命令：`npx vitest run test/main/upstreamApi/createUpstreamApi.test.ts test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts --reporter=json --outputFile=.agent-workspace/.archive/2026-08-12/review-extraction/vitest.json`。JSON：11/11 suites、34/34 tests、0 failed、`success=true`。
- `npm run typecheck:node` → `EXIT=0`。
- `npm run build:server` → `EXIT=0`；server 77 modules、web panel 36 modules transformed，均构建成功。
- `codegraph sync <repo> -q` → `EXIT=0`；两个 callers probe 均 `EXIT=0`，原始输出见 Phase 6。
- `git diff --check af94451^ 8c42227 -- Kiro-account-manager/src/main` → `EXIT=2`，17 处尾随空白，已列为 Minor。

## VERDICT
status: NEEDS_CHANGES
critical_count: 0
important_count: 2
minor_count: 1
ready_to_merge: WITH_FIXES
one_line: 生产抽取、调用点与双宿主接线经独立证据确认无行为变化，但零变化证明脚本存在可放行真实语义变化的假绿缺陷，需修复后再作为可信交付证据。
