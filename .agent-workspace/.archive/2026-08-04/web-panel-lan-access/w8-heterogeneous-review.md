# W8 三项缺口修复 · 异构独立评审

评审对象：`F:\Kiro-account-manager\Kiro-account-manager`，基线 `d5ba9b0..cabc9d5`。独立检查实际提交、源码、历史 blame、生产 caller 与测试；未采信 executor 报告作为结论依据。

## 验证证据
- `npm run typecheck:node` → EXIT=0（2.95s）。
- `npm run typecheck:web` → EXIT=0（7.41s）。
- `npm run build:webpanel` → EXIT=0（1.62s；36 modules；JS 437.08 kB）。
- `npx vitest run` → EXIT=0（87 files，924 tests，13.84s）。
- 七个定向文件 → EXIT=0（7 files，85 tests）。
- `codegraph sync F:\Kiro-account-manager\Kiro-account-manager -q` → EXIT=0；随后执行 callers 探针。
- 禁止依赖 import 检索 → `NO_FORBIDDEN_IMPORT_STATEMENTS`，EXIT=0。
- suspended 复现：`activateProxyAccount` 返回 `applied:true`，同时输出 `selected:["a"] / isSuspended:true / isAvailable:false`。
- token 旋转复现：返回 `refresh-v2` 且 `success:true`，但 `ideWrites:0`、原账号仍为 `refresh-v1`。
- 并发合并实证：`checkNoDoubleWrite.test.ts:141-167` 明确断言备注冲突后 `usage.current === 10`，而服务端新值是 42。
- `importApiKey.ts` 检测到 4 个 NUL；`git diff --numstat` 将其报告为二进制 `- -`。

## 7-Phase 结论
1. **Spec Conformance：失败。** 导入/持久化/面板代理基本链已建立，但 suspended 选号、token 旋转丢失、备注并发时额度回滚违反用户视角成功态和负条件。
2. **Task-Ledger Evidence Gate：失败。** 决策卡 8 个 `[x]` 项均无四要素 `**Evidence**:` 块；`NO_EVIDENCE_BLOCKS`。虽然所列 hash 均能解析，仍按协议为 Critical。
3. **Code Quality：失败。** 主进程新编排、renderer 旧编排、旧 IPC 与多份 Account→ProxyAccount 映射并存；架构门没有扫描这些旁路。
4. **Domain Model：不适用。** `git ls-files "docs/domain/*-model.md"` 无结果。
5. **Upstream Root Cause：失败。** 新编排只接面板，没有把桌面 producer 和旧 IPC迁到同一主进程收口；刷新凭证仍依赖 renderer 补写。
6. **Whole-Path Completeness：失败。** 核心新符号均有生产 caller，但交付卡仍把 W8 真机链标为未完成，且没有本轮 §0.16 全链回答；不能用单测替代最终 `/v1/*` sink。
7. **Business Reality：通过。** 三项能力均直接对应用户的 `ksk_ 导入→刷新额度→选账号→启动反代` 场景，非 solution-jumping。

### Strengths
- `F:\Kiro-account-manager\Kiro-account-manager\src\main\accountService\importApiKey.ts:250-381`：校验在锁外，判重与整批落盘在同一 mutation 内，并且响应只回掩码标签。
- `F:\Kiro-account-manager\Kiro-account-manager\src\main\accountService\persistCheckResult.ts:177-230`：在写入收口内重读盘面并做字段级补丁，避免陈旧 HTTP 快照覆盖备注/分组。
- `F:\Kiro-account-manager\Kiro-account-manager\src\main\accountService\check.ts:183-207`：单账号检查只在持久化成功后返回成功，重载页面不再回旧额度。
- `F:\Kiro-account-manager\Kiro-account-manager\src\main\ipc\panelProxyDeps.ts:119-224`：面板启动先同步池、空池拒绝、运行态读取真实 server 句柄，方向正确。
- `F:\Kiro-account-manager\Kiro-account-manager\src\main\proxy\activation.ts:222-236`：局部三步顺序为 upsert→单账号配置→指针/affinity，符合历史 RCA 的承重顺序。

### Issues

#### Critical (Must Fix · blocks merge)
1. `F:\Kiro-account-manager\Kiro-account-manager\src\main\proxy\activation.ts:225-244` + `F:\Kiro-account-manager\Kiro-account-manager\src\main\proxy\proxyServer.ts:1582-1601` — **What：** 新编排会对运行期 suspended 账号返回 `applied:true` 并写入 `selectedAccountIds`，而单账号取号路径只查 quota、不查 suspended/`isAvailable`；本轮实际复现输出为 `{"result":{"applied":true,"mode":"single","accountId":"a"},"selected":["a"],"isSuspended":true,"isAvailable":false}`。**Why：** 手机显示选号成功，但下一个真实 `/v1/*` 请求仍会使用已封账号，违反最终 sink。**How：** 在主进程唯一激活收口中先用 AccountPool 的权威可用性判定拒绝 suspended/unavailable，并补真实单账号选取测试。

2. `F:\Kiro-account-manager\Kiro-account-manager\src\main\webPanel\routes.ts:461-467` + `F:\Kiro-account-manager\Kiro-account-manager\src\main\accountService\refresh.ts:109-214` + `F:\Kiro-account-manager\Kiro-account-manager\src\webPanel\App.tsx:297-302` — **What：** Web 直接暴露会旋转 refresh token 的函数，但函数不写 accountData；非当前 IDE 账号时也不写 IDE token 文件，UI却重拉旧列表并提示“Token 已刷新”。实测返回 `refresh-v2/success:true`，同时 `ideWrites=0`、账号仍是 `refresh-v1`。**Why：** 服务端已作废旧 refresh token 后唯一新 token 丢失，下一次刷新需要重新登录。**How：** 在共享主进程用例内原子持久化新 credentials 后才返回成功，并让 IPC/HTTP 共用该用例；不要依赖 renderer 补写。

3. `F:\Kiro-account-manager\Kiro-account-manager\test\renderer\cross-end-sync\checkNoDoubleWrite.test.ts:141-167` + `F:\Kiro-account-manager\Kiro-account-manager\src\renderer\src\store\syncMerge.ts:77-117` — **What：** 当桌面端改备注与手机刷新额度并发时，记录级 ours-wins 会把服务端新额度42回滚到10；测试明确把该回滚锁成期望。**Why：** 直接违反“服务端写入不得被 renderer 防抖快照覆盖回旧值”，用户刷新后仍可丢新额度。**How：** 在上游三方合并模型为服务端权威字段定义字段级合并（至少 usage/subscription/check状态），并把测试改为备注保留且 usage=42。

4. `F:\Kiro-account-manager\.agent-workspace\.archive\2026-08-04\web-panel-lan-access\web-panel-decision-card.md:165-180` — **What：** 8 个 `[x]` 任务均无 `**Evidence**:` 四要素块；实际命令输出为 `NO_EVIDENCE_BLOCKS`。**Why：** Phase 2 强制门无法解析每项 verify/EXIT/files/AC，现有裸 commit 虽都可解析仍不满足证据协议。**How：** 为每个完成项补 `commit`、真实运行的 `verify → EXIT`、`files:path:lines`、`AC` 并复核。

#### Important (Should Fix · quality impact)
1. `F:\Kiro-account-manager\Kiro-account-manager\src\renderer\src\store\accounts.ts:4330-4357` + `F:\Kiro-account-manager\Kiro-account-manager\src\main\index.ts:3418-3454` + `F:\Kiro-account-manager\Kiro-account-manager\test\main\architecture\proxy_orchestration_wiring.test.ts:88-153` — **What：** 桌面端仍自行复制三步并走只动指针的旧 IPC；三个 await 不检查失败返回却最终 `applied:true`，架构门只扫面板文件而漏掉这两个旁路。**Why：** 所谓主进程“唯一收口”不成立，任一步业务失败可被桌面端谎报成功，后续演进继续分叉。**How：** 让旧 IPC直接调用 `activateProxyAccount`，renderer 只调该入口并检查结果，门扫描全生产树禁止第二套判据/写序。

2. `F:\Kiro-account-manager\Kiro-account-manager\src\main\proxy\activation.ts:101-143` 对比 `F:\Kiro-account-manager\Kiro-account-manager\src\main\index.ts:681-713,2803-2840` 与 `F:\Kiro-account-manager\Kiro-account-manager\src\renderer\src\store\accounts.ts:974-998` — **What：** “统一映射”新增后仍有至少三份生产映射；lazy-sync 那份缺 `weight/groupId`，renderer 那份缺 `proxyUrl`。**Why：** 代理启动方式不同会得到不同池成员字段，SWRR、分组过滤和绑定出口行为漂移。**How：** 把所有主进程同步路径收口到 `buildProxyAccountsFromStore/toProxyAccountShared`，再决定是否移除 renderer 传整账号的旧协议。

3. `F:\Kiro-account-manager\.agent-workspace\.archive\2026-08-04\web-panel-lan-access\web-panel-decision-card.md:1,40-44,180` — **What：** 状态仍写“UI/静态服务在途”，成功态只到“刷新额度新数字”，而日常链又要求启动反代到外部 `/v1/*`，W8 真机 E2E仍未完成。**Why：** delivery contract 与现实/本轮完成状态漂移，缺少最终 sink 证据。**How：** 就地更新状态与逐跳 link table，并完成一次手机登录→导入→刷新→选号→启动→外部请求的 E2E后关闭 W8。

#### Minor (Nice to Have)
1. `F:\Kiro-account-manager\Kiro-account-manager\src\main\accountService\importApiKey.ts:154,226` — **What：** 副键分隔符写成了4个真实 NUL，Git把整个 TypeScript 文件识别为 binary（`numstat: - -`）。**Why：** diff/blame/审计工具无法逐行审查该安全敏感导入逻辑。**How：** 改为可见转义分隔或长度前缀编码，确保源文件仍是普通UTF-8文本。

## Phase 6 wiring probe raw output

```text
SYNC_EXIT=0
{"symbol":"persistCheckResult","callers":[{"name":"checkAccountStatus","kind":"function","filePath":"src/main/accountService/check.ts","startLine":183},{"name":"check.ts","kind":"file","filePath":"src/main/accountService/check.ts","startLine":1}]}
{"symbol":"persistBatchCheckResults","callers":[{"name":"backgroundBatchCheck","kind":"function","filePath":"src/main/accountService/check.ts","startLine":414},{"name":"check.ts","kind":"file","filePath":"src/main/accountService/check.ts","startLine":1}]}
{"symbol":"buildPanelProxyDeps","callers":[{"name":"index.ts","kind":"file","filePath":"src/main/index.ts","startLine":1}]}
{"symbol":"toProxyAccountShared","callers":[{"name":"buildProxyAccountsFromStore","kind":"function","filePath":"src/main/proxy/activation.ts","startLine":174},{"name":"activateProxyAccount","kind":"function","filePath":"src/main/proxy/activation.ts","startLine":205},{"name":"proxyActivation.test.ts","kind":"file","filePath":"test/main/proxy/proxyActivation.test.ts","startLine":1}]}
{"symbol":"buildProxyAccountsFromStore","callers":[{"name":"syncPool","kind":"function","filePath":"src/main/ipc/panelProxyDeps.ts","startLine":119},{"name":"proxyActivation.test.ts","kind":"file","filePath":"test/main/proxy/proxyActivation.test.ts","startLine":1},{"name":"makeProxyStub","kind":"function","filePath":"test/main/webPanel/proxyRoutes.test.ts","startLine":65}]}
{"symbol":"activateProxyAccount","callers":[{"name":"buildPanelProxyDeps","kind":"function","filePath":"src/main/ipc/panelProxyDeps.ts","startLine":133},{"name":"proxyActivation.test.ts","kind":"file","filePath":"test/main/proxy/proxyActivation.test.ts","startLine":1},{"name":"proxyDeps","kind":"function","filePath":"test/main/webPanel/proxyRoutes.test.ts","startLine":105}]}
{"symbol":"apiKeyImportCodeText","callers":[{"name":"AddAccountDialog","kind":"function","filePath":"src/renderer/src/components/accounts/AddAccountDialog.tsx","startLine":70}]}
{"symbol":"fetchProxyStatus","callers":[{"name":"ProxyPanel","kind":"function","filePath":"src/webPanel/ui/ProxyPanel.tsx","startLine":60}]}
{"symbol":"startProxy","callers":[{"name":"ProxyPanel","kind":"function","filePath":"src/webPanel/ui/ProxyPanel.tsx","startLine":60}]}
{"symbol":"stopProxy","callers":[{"name":"ProxyPanel","kind":"function","filePath":"src/webPanel/ui/ProxyPanel.tsx","startLine":60}]}
{"symbol":"syncProxyPool","callers":[{"name":"ProxyPanel","kind":"function","filePath":"src/webPanel/ui/ProxyPanel.tsx","startLine":60}]}
{"symbol":"setProxyActiveAccount","callers":[{"name":"ProxyPanel","kind":"function","filePath":"src/webPanel/ui/ProxyPanel.tsx","startLine":60}]}
{"symbol":"ImportPanel","callers":[{"name":"App","kind":"function","filePath":"src/webPanel/App.tsx","startLine":51}]}
{"symbol":"ProxyPanel","callers":[{"name":"ProxyPage","kind":"function","filePath":"src/renderer/src/components/pages/ProxyPage.tsx","startLine":5},{"name":"App","kind":"function","filePath":"src/webPanel/App.tsx","startLine":51},{"name":"renderPanel","kind":"function","filePath":"test/renderer/web-panel-ui/panelProxyPanel.test.tsx","startLine":121}]}
```

说明：类型/接口不要求运行时 caller；其余新增公开符号经同步后均有生产 caller。`importApiKeys` 名称有浏览器同名符号歧义，另以生产 `git grep` 核到 `index.ts:4356` 注入共享用例、`routes.ts:282` 调用，以及桌面 `AddAccountDialog.tsx:1451` 调 preload。

## 未验证边界
- 未执行真实手机/真实外部客户端 `/v1/*` 物理 E2E；决策卡也明确 W8 未完成。
- 未运行 Electron 安装包回放；只验证了独立 WebPanel Vite 构建。
- 未对924项测试逐项 mutation；已深读并复现与三项交付直接相关的关键门。

## VERDICT
status: NEEDS_CHANGES
critical_count: 4
important_count: 3
minor_count: 1
ready_to_merge: NO
one_line: 三项能力已有生产接线且924项测试全绿，但 suspended选号、Web token旋转丢失、并发额度回滚及任务证据门缺失仍阻断交付。
