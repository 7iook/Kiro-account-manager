# 债务现实对账（2026-08-13）

## 快照与口径

- 代码基线仍是 `HEAD 10bdf3440d3b1500821918899c8b81701be2dbda`。用户给出的“clean tree”是派单时事实；本报告最终取证时，并发 executor 已留下 14 个已跟踪文件修改及一个未跟踪门禁测试，因此下表明确区分 **HEAD 已落地** 与 **当前工作树 DONE-verify-me**。
- 当前工作树验证：
  - `npm run typecheck`：EXIT 0。
  - 四组面板/封禁定向回归：55 passed / 0 failed。
  - 状态码门禁：3 passed / 0 failed。
  - 全仓 Vitest：170 files passed / 1 skipped；1814 tests passed / 6 skipped（1820 total）；EXIT 0。
  - `git diff --check`：EXIT 0。
- 语义检索按要求调用三路：`codegraph-codegraph_explore` 返回 `Error | Not connected`；已用 `codebase-context-engine-search_context` 与 `fast-context-fast_context_search` 交叉确认，并用当前磁盘源码定点复核。C3/C4/C5 的“不存在”还分别做了文件系统当前树检索，不能由一次 `git grep` 零结果推出。
- 状态含义：
  - `DONE-verify-me`：代码/测试已能证明目标，但当前可能尚未提交；合入者仍须检查 diff 归属。
  - `OBSOLETE`：没有独立、仍成立的产品损失，建议从台账删除。
  - `DUPLICATE-of-X`：只保留 X，不再单独排期。

## Deliverable 1 — 实际还剩什么

| id | one line | status | evidence anchor | what remains |
|---|---|---|---|---|
| K-9 / #34 | “面板六项能力”的总括项 | DUPLICATE-of-C1..C6 | `.agent-workspace/TASKS-2026-08-13.md:491-511` 校正了真实 C1～C6；`.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:295-316` 给出逐项损失 | 删除总括任务，只跟踪 C1～C6 子项 |
| #35 | 手机面板开放低风险反代配置 | DUPLICATE-of-C1 | `TASKS-2026-08-13.md:508,571-587` 明确 #35 就是 C1 | 删除 #35 独立计数 |
| C1 | 手机改 `logRequests`、受控改端口、创建/验证/吊销 API Key | DONE-verify-me | 当前工作树 `src/main/webPanel/routes.ts:958-1028`；`src/webPanel/ui/ProxyConfigSection.tsx:294-305,333-352,563-608`；`test/main/webPanel/proxyRoutes.test.ts:1116+`；本轮 55/55、全仓 1814/1814 非 skipped 通过 | 代码已闭环；14 文件在飞批次尚未提交，需独立 diff review 后落地 |
| C2 / C6 | 手机账号编辑删除与 adminKey 轮换 | DONE-verify-me | `test/main/webPanel/proxyRoutes.test.ts:404,877-1035`；全仓回归通过 | 无工程剩余；从开放台账移除 |
| C3 | 手机管理“反代自己出网用的代理池” | OPEN | 桌面能力在 `src/renderer/src/components/pages/ProxyPoolPage.tsx:290-422`；`src/main/webPanel/**` 对 `/api/proxy-pool` / CRUD / validate 检索为 0，语义检索也只找到账号池同步而非出网代理 CRUD | 复用现有持久化与验证语义，补 DTO、鉴权 CRUD/validate、账号绑定影响、手机 UI 与 E6 |
| C4 | 手机查看反代日志 | OPEN | 日志真源已存在：`src/main/proxy/logger.ts:325-477`；服务端初始化/flush：`src/main/server/assembly.ts:348,501`；`src/main/webPanel/**` 对日志 route/deps 检索为 0 | 补分页/上限、筛选、强制脱敏的 GET；若开放 clear，需确认动作与审计；补手机日志页与 E7 |
| #10 | 自动换号唯一调度器迁入 main/server，renderer 周期决策已移除 | DONE-verify-me | `src/main/accountService/autoSwitch.ts:152-191`；`src/main/server/assembly.ts:420-445`；`test/main/server/autoSwitchAssembly.test.ts:17-78`；`test/renderer/autoSwitchSchedulerOwnership.test.ts:18-40` | 无内核工作；C5 只剩手机配置入口 |
| C5 | 手机查看/修改自动换号开关、阈值、间隔、目标 | PARTIAL | server 真正消费 `autoSwitchEnabled/Threshold/Interval`：`src/main/accountService/autoSwitch.ts:20-27,152-191`；`src/webPanel/**` 对四字段检索为 0 | 新增安全投影与白名单写入，复用 `applyAccountDataMutation` 广播唤醒 scheduler；补手机控件 |
| K-10 / P3-5 | 可部署合同已建，但批准的真实 Linux/手机成功状态尚未完成验收 | PARTIAL | `docs/deployment/verification.md:30-88` 已真跑 release、Linux 容器 prod install、readyz 降级态、SIGTERM；`:90-111` 明列真实 systemd、TLS 手机、真实账号请求、重启/升级/回滚/恢复、长跑与双实例仍未验 | 在 fresh Linux/systemd + 真实域名/TLS + 真实账号上执行控制面和数据面验收；最终 E2E 需等 C3/C4/C5 |
| #16 | AccountPool 再造“低额度谓词 + 候选排序” | OBSOLETE | #10 已在唯一调度器里按同一阈值排除低额度候选：`autoSwitch.ts:91-104,152-191`；再在 `AccountPool` 建第二策略 owner 没有独立验收结果 | 关闭；保持 `isQuotaExhausted` 只表达硬耗尽 |
| #26 | 临时/永久/未知封禁状态机、TTL 或自动恢复探测 | OBSOLETE | `src/main/proxy/accountPool.ts:382-421` 的人工闩锁与 hold/switch 恢复契约一致；`TASKS-2026-08-13.md:618-637` 已记录用户否决发明新状态机 | 关闭，不加 TTL/backoff |
| #27 | 手机强制清除本地封禁标记 | DONE-verify-me | 当前工作树 `src/main/webPanel/routes.ts:631-689,1148-1150`；`src/webPanel/ui/AccountCard.tsx:496-598`；`test/main/webPanel/proxyRoutes.test.ts:1038+`；本轮 55/55 与全仓回归通过 | 仅剩当前在飞批次 review/落地；文案已明确“上游未验证，可能立刻再封” |
| #30 | 封禁判定收口到共享分类器并阻止关键词再扩散 | DONE-verify-me | `src/shared/accountSuspension.ts:33-110`；当前工作树 `test/main/proxy/accountSuspensionArchitecture.test.ts` 2/2 通过；全仓回归通过 | 仅剩当前在飞批次 review/落地 |
| #31 | 取证问题：“同一本地 account.id 能否跨两个上游身份复用” | DONE-verify-me | 答案是 YES，且不依赖 UUID 碰撞：编辑 A 时可验证 B 的新凭据，再按旧 `account.id` 覆盖 `email/userId/credentials`：`src/renderer/src/components/accounts/EditAccountDialog.tsx:117-219`、`src/renderer/src/store/accounts.ts:1196-1207`；完整导入也是第二条确定路径：`:1811-1885` | 关闭取证项；把实际修复跟踪为 NEW-ID-INVARIANT |
| NEW-ID-INVARIANT | 本地记录 id 没有身份代际，A→B 同 id 会触发静默覆盖、迟到写回与授权别名化 | OPEN | 迟到 patch 只按 id 回写：`src/main/accountService/persistAccountPatch.ts:62-107`、`persistRefreshBatchResults.ts:160-218`；池按同 id 迁移 quota/suspension/errorCount：`src/main/proxy/accountPool.ts:771-896`；API-key 白名单仍按 id 授权：`src/main/proxy/types.ts:643-650`、`proxyServer.ts:1675-1683` | fail closed 阻止编辑跨上游身份；导入 id 与身份冲突时拒绝或 remint；给异步写回增加身份代际/指纹仲裁；覆盖 ABA、池迁移与授权边界测试 |
| #33 | 笼统的“继续加强登录安全/多用户化” | OBSOLETE | 当前已具备单 adminKey、强度/0600、登录节流、session+CSRF、可信 TLS 前置、轮换失效全部会话：`src/main/server/adminKeyStore.ts:82-145`、`src/main/webPanel/auth.ts:68-98,187-231`、`test/main/webPanel/proxyRoutes.test.ts:404+` | 关闭模糊债务；未来若要多用户/RBAC/审计主体，应作为新产品需求立项 |
| #36 | 480s 自动放行与 200s Layer C 首块超时冲突 | DONE-verify-me | `src/main/proxy/streamWatchdog.ts:103,255`；`src/main/proxy/proxyServer.ts:3675-4547` 对 hold-resumed 请求传 `skipFirstChunkTimeout` | 无剩余；从开放台账移除 |
| #37 | 跨端点/账号的请求级 429 总耐受预算与 sibling 优先 | OPEN | 当前只有每端点预算：`src/main/proxy/kiroApi.ts:2318-2389`，耗尽即换下一个 endpoint；尚无跨端点/跨轮总预算。既有 `AttemptCounter` 只观测：`src/main/proxy/kiroApi.ts:107-118` | 保留 fast 密集重试；增加有界总墙钟预算、sibling 优先、客户端取消/总超时合同与行为测试，禁止引入指数退避 |
| #38 | 裸三位数状态码提取防扩散门禁 | DONE-verify-me | 当前未跟踪 `test/main/architecture/status_code_extraction_gate.test.ts:224-275`；本轮 3/3 通过，受控 mutant 能红；全仓回归也通过 | 测试文件尚未跟踪；review 后单独落地 |
| #39 | 核实 429 是否抬高 `errorCount` | DONE-verify-me | `src/main/proxy/accountPool.ts:576-612` 明确每次 `recordError` 加一并计算冷却；`src/main/proxy/proxyServer.ts:2079-2094` 的真实 429 调该入口 | 研究问题已回答；不再单独排期，结论作为 #37 设计约束 |
| N-1 / N-2 | TLS 前置后的 Secure cookie 与真实客户端 IP | DONE-verify-me | `src/main/webPanel/server.ts:266-284` 只接受显式可信 peer 后的 forwarded 链；`src/main/webPanel/auth.ts:187,231` 据 `viaTrustedTlsProxy` 加 Secure cookie | 无代码剩余；真实 Caddy/nginx hop 归 K-10 验收 |
| N-3 | server 未初始化/flush `proxyLogStore` | DONE-verify-me | `src/main/server/assembly.ts:348,501` | 无剩余；C4 可直接消费 |
| N-4 | `.backup.enc` 无头自动恢复编排 | OBSOLETE | 决策卡正式迁移工件是原始数据文件直拷；`docs/operations/data-migration.md` 与冷备 runbook 是当前恢复合同 | 不为“与桌面对称”增加第二条恢复链；若未来明确要求 RTO/RPO，再立灾备产品需求 |
| D-1 | 桌面托盘/IPC 手动启动前也 eager hydrate 账号池 | OBSOLETE | `src/main/index.ts:1881-1887,4640-4647` 仍依赖懒补；`test/main/architecture/proxy_orchestration_wiring.test.ts:246-300` 将两处列为刻意桌面豁免 | 服务器成功状态不依赖它，且桌面有人在场、已有功能兜底；无实测故障前关闭 |
| NEW-HYGIENE | 未跟踪调查物、旧快照、临时 probe 与 detached worktree 混在仓根 | OPEN | 本轮最终 `git status --short --branch` 仍列出四个 wip-copy、review JSON、tmp probe、会话 txt、`.codegraph/` 与 `proxy-safety-review-isolated/`；`git worktree list` 证实后者是注册 worktree | 所有并发任务结束后做 manifest/hash/归档；只用安全清理脚本，禁止裸递归删除 |
| §20 npm lifecycle gate | 自动验证 lifecycle 引用文件都进入 server 制品 | OBSOLETE | `package.json:18,28-30`；`test/main/architecture/server_delivery_contract.test.ts:85-100`；已有真实 Linux `npm ci --omit=dev` 验证。`TASKS-2026-08-13.md:550-558` 已定“第二次复发再建” | 当前不建；保留 release smoke |
| server-specific manifest | 为 server 另造 `package.json`/lockfile | OBSOLETE | 现有 release 复用单一 lockfile，Linux prod install 已证明不安装 Electron：`docs/deployment/verification.md:30-53` | 不制造双 manifest 漂移；只有制品体积/安装时长出现量化损失时再评估 |

## Deliverable 2 — 按 owner 实际损失排序

### 1. NEW-ID-INVARIANT（#31 取证所得）：先堵住跨身份复用与 ABA

- **损失**：这不是只需手改 JSON 的边角。操作者可在 A 的正常编辑 UI 填入 B 的有效凭据并保存，记录仍用 A 的 id；B 随即继承 A 的 usage、subscription、lastError、机器码、出口代理、池 suspension/quota/errorCount。A 的在途刷新还可迟到写进 B；API-key 账号白名单、会话粘性和 active/selected 引用也会把 B 当成原授权对象。这是静默数据错误兼授权边界别名，优先于单纯缺功能。
- **依赖**：无；#31 的研究问题已由静态生产链回答 YES，不需要上游唯一性合同或 UUID 碰撞统计。
- **文件**：`src/renderer/src/components/accounts/EditAccountDialog.tsx`、`src/renderer/src/store/accounts.ts`；`src/main/accountService/persistAccountPatch.ts`、`persistRefreshBatchResults.ts`，必要时增加最小身份代际字段；AccountPool/授权链以回归测试守住，不应顺手重写。
- **并行**：可与 webPanel 工作并行；不碰 `routes.ts`/`panel.ts`/webPanel UI 热点。内部 persistence 文件需单 owner。

### 2. Review 并落地当前 C1 + #27 + #30 在飞批次

- **损失**：这些代码不进入 HEAD，手机仍无法在端口冲突/API Key 泄漏/本地封禁时自救；分类器漂移也仍可能重现。
- **依赖**：无。当前证据已是 typecheck 全绿、55/55 定向、1814 passed / 0 failed / 6 skipped。
- **文件**：当前 14 个修改文件，热点是 `src/main/webPanel/routes.ts`、`src/webPanel/api/panel.ts`、`src/webPanel/ui/**`；另含 `panelProxyDeps.ts`、DTO/wiring 和测试。
- **并行**：不要与 C3/C4/C5 同时写；三者命中同一热点。#38 可独立 review。

### 3. K-10/P3-5：先做真实控制面防锁出演练，再做最终 E2E

- **损失**：代码/容器绿不能证明真实 Caddy/systemd/公网手机链不会把 owner 锁在面板外。
- **依赖**：fresh Linux VM、真实域名/TLS、真实账号、维护窗口。控制面 smoke 可在 C3～C5 前先跑；最终“全部可从手机管理”验收依赖 C3/C4/C5 完成。
- **文件**：主要是 `deploy/systemd/**`、`docs/deployment/**`、`docs/operations/**` 和验收脚本/记录；发现真实缺陷时才回产品代码。
- **并行**：环境准备与 #31/#37 可并行；最终演练需使用固定 release。

### 4. C3：手机出网代理池管理

- **损失**：一个代理 IP 被上游封时，其下所有账号同时不可用，owner 在手机上既看不出是哪条代理，也无法替换。
- **依赖**：等待当前 C1/#27 批次释放热点；复用盘上 `proxyPool`、现有 validate/diagnose 与账号绑定合同。
- **文件**：`src/main/webPanel/dto.ts`、`routes.ts`、`src/main/ipc/panelProxyDeps.ts`，可能导出现有 `src/main/ipc/proxyPool.ts` 校验；`src/webPanel/api/panel.ts`、新 UI section 与测试。
- **并行**：核心校验提取可并行侦察；最终 routes/panel/UI 与 C4/C5 串行。

### 5. C4：手机日志查看

- **损失**：任何请求失败都只能 SSH 查原因；这使“手机是唯一管理入口”在故障时失效。
- **依赖**：N-3 已完成；等待当前热点释放。必须通过既有脱敏出口，不可直接返回 `proxyLogStore.getAll()`。
- **文件**：`src/main/webPanel/dto.ts`、`routes.ts`、`respond.ts`/deps、`src/webPanel/api/panel.ts`、日志 UI 与测试。
- **并行**：后端 DTO/脱敏契约可预先设计；最终与 C3/C5 串行。

### 6. #37：长 429 风暴的总耐受预算

- **损失**：当前每端点约 4～6 秒 fast 重试后就换端点；同一共享 key 的长风暴仍会过早失败，直接损失请求成功率。
- **依赖**：#39 已回答；必须与客户端总超时/取消共用墙钟上限，并保持“429 不是 quota/hold、不得指数退避”。
- **文件**：优先 `src/main/proxy/kiroApi.ts`、`types.ts` 与聚焦测试；若把最终计数上报到外层才碰 `proxyServer.ts`。
- **并行**：可与 webPanel 工作并行；若要动 `proxyServer.ts`，先锁定 owner。

### 7. C5：手机自动换号设置

- **损失**：无头调度器已运行，但 owner 关机后不能从手机改开关/阈值/周期；只能继续使用迁移前的持久化值。
- **依赖**：#10 已完成；等待 C3/C4 共享热点释放。
- **文件**：`src/main/webPanel/dto.ts`、`routes.ts`、panel deps；`src/webPanel/api/panel.ts`、UI 与测试。`applyAccountDataMutation` 的 broadcaster 已会唤醒 scheduler。
- **并行**：与 C3/C4 最终写入串行。

### 8. #38 与仓库卫生

- **#38**：产品当前无新增损失，但门禁防止已发生两次的裸状态码回归；未跟踪测试应独立小批落地，可与功能开发并行 review。
- **卫生**：最后做。活跃工作树/临时取证尚在产生，提前清理有丢成果和跟随 junction 的风险。

## Deliverable 3 — 不值得做、应关闭

1. **#16 的第二套 AccountPool 低额度策略**：#10 已实现唯一阈值决策与候选过滤；再做只会产生两个 policy owner。
2. **#26 临时/永久封禁状态机、TTL、恢复探测或退避**：没有已证实的业务语义，且用户已否决；会改变现有 hold/switch 合同。
3. **#33 模糊的“继续加强登录安全”**：当前单管理员模型已有完整防线。多用户/RBAC 不是修债，是新产品。
4. **N-4 `.backup.enc` 自动恢复**：正式支持的是原始数据目录冷备/直拷。为对称性维护第二条恢复链成本高、失败模型更多。
5. **npm lifecycle 架构 gate**：已有发布契约测试与真实 `npm ci --omit=dev`；一次被 review 提前拦住的近失不值得立即加设施，按既定规则等第二次复发。
6. **server-specific manifest/lockfile**：当前同一 lockfile 已在 Linux 证明 prod closure 不带 Electron；双 manifest 更容易漂移。
7. **把日志 20 MiB safety net 升级为严格逐字节配额**：已有 10,000 条上限、`data` 4 KiB 截断与覆盖写；无观测到的真实磁盘损失。
8. **给所有 panel DTO 一次性引入统一 runtime decoder**：C1 关键边界已有 decoder 与 section boundary；其余按真实 malformed 事故增量补，不做全域重构。
9. **桌面两个手动启动点 eager hydration**：不影响 approved headless 成功状态，且有懒补功能兜底；无实测损失。
10. **Electron shell 与手工 server 共用同一 dataDir 的跨 shell 锁**：已冻结的数据模型是两端独立副本；支持同目录共写反而违背合同。
11. **仅为“SSOT 对称”抽取两个 `isAccountExists` helper**：NEW-ID-INVARIANT 应修身份代际与冲突行为；纯 helper 合并没有独立用户结果。
12. **现在加自动 `npm audit` lifecycle gate**：本轮 `npm audit --omit=dev --registry=https://registry.npmjs.org` 为 0；默认 `npmmirror` audit endpoint 实际返回 404。安全审计应放 release/CI 并固定可用 registry，不应阻断每次本地安装。

## Deliverable 4 — 真正需要人类产品裁决的事项

**没有。**

- C1 字段矩阵已经冻结。
- C3/C4 的业务目标与消费者已经在 decision card 冻结。
- C5 只是把既有四个持久化设置安全地暴露给手机。
- NEW-ID-INVARIANT 的 fail-closed 数据完整性、#37 的预算实现、路由拆分与测试形状都是工程选择。
- #33 不应继续用“等用户定范围”占着债务台账；若未来需要多用户，再以新需求立项。

仍需 owner 提供的只是 **验收输入/操作授权**，不是产品决策：真实 Linux 主机、域名/TLS、测试账号与维护窗口；以及仓库卫生清理前的归档/删除授权。
