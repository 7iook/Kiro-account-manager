# K-9 / #34 · 手机面板账号管理能力实施记录

日期：2026-08-13  
工作树：`F:\Kiro-account-manager\Kiro-account-manager`  
约束：未提交、未 stash、未回退任何共享工作树改动。

## 1. 决策卡中的权威能力清单与本轮状态

能力名称与含义取自 `server-migration-decision/decision-card.md` 的“面板需补的必需能力”表，不采用对任务的二手概述。

| 编号 | 决策卡原能力 | 本轮状态 | 说明 |
|---|---|---|---|
| C1 | **反代低风险配置**：在手机上改反代端口 / 加 API Key / 开日志 | **未触碰** | 需要先定义严格白名单、密钥读取脱敏、热生效/需重启结果，并把配置用例接入桌面与 Node 两套装配；不做只有前端或只有路由的半接线。 |
| C2 | **账号删除 / 编辑**：删掉导入错的号、改备注分组 | **已端到端完成** | 路由、revision 仲裁、落盘、运行池同步、API 类型、手机 UI、删除确认、10 分钟撤销、真实 fetch/HTTP 测试均已完成。 |
| C3 | **代理池管理**：增删改“反代自己出网用的代理” | **未触碰** | 这里是出网代理池，不是账号池选号。它需要共享 CRUD 用例、持久化与反代出网路径重载；当前所有权内无法诚实闭环。 |
| C4 | **日志查看**：在手机上看挂起原因 / 端点回落 / 429 与 402 分流判据 | **未触碰** | 需要有界日志读取端口、分页/截断语义及脱敏测试；不能把 `console` 或日志文件直接透传给浏览器。 |
| C5 | **自动换号调度** | **明确排除** | 按用户指示及决策卡结论，依赖台账 #10；未加任何看起来能开、实际不生效的开关。 |
| C6 | **adminKey 修改**：密钥疑似泄漏时更换 | **在当前集成工作树中端到端完成** | 浏览器 API + 手机 UI + 真实 HTTP 契约测试已完成；后端路由和 `rotateAdminKey()` 来自并行 sibling 的 `server.ts` / `auth.ts` 改动，合并时必须一起带上，详见 §6。 |

因此，本轮诚实完成的是 **C2 + C6**；C1、C3、C4 未做任何半成品。任务概述里提到的“文件导入、标签、权重、备份恢复”不是该表的 C1–C4/C6：

- 账号添加（粘贴 `ksk_`）原本已有，不重复造第二条导入链。
- C2 的权威措辞只有备注与分组，本轮没有擅自加入标签、权重或凭据编辑。
- 决策卡明确写明备份文件导入本轮不支持，唯一正式迁移路径是原始 `kiro-accounts.json` 直拷；因此未实现备份/恢复，也未触碰 `KIRO_BACKUP_KEY` 或明文降级边界。

## 2. C2 完成内容

### 服务端路由与契约

新增并接通：

- `GET /api/account-groups`
- `PATCH /api/accounts/:id`
- `POST /api/accounts/:id/delete`
- `POST /api/accounts/:id/restore`

关键语义：

1. 编辑只接受 `nickname` / `groupId` 与 `expectedRevision`；未知字段直接拒绝，凭据字段不会被接受。
2. 分组下拉只返回 `id/name/color/order` 白名单，不把整份 accountData 发到浏览器。
3. 写操作统一走 `applyAccountDataMutation`，使用 `expectedRevision`；桌面端并发修改时返回 `409 STALE_REVISION`，不静默覆盖。
4. 删除同时清理 `activeAccountId`（仅当目标是当前账号）和该账号的 `accountProxyBindings`，保留其他账号绑定。
5. 删除/恢复落盘后调用既有 `proxySyncPool` 重建运行池；若落盘成功但运行池同步失败，不谎报整次失败，而返回 `proxyPoolSyncPending: true`，UI 明示需要手动同步。
6. 删除和恢复后，`ProxyPanel` 重新 `GET /accounts` 与 `/proxy/status`。跨组件事件只表达“服务端数据已失效”，不携带账号快照，不形成第二个数据真源。

### 手机 UI

- “更多操作”中新增“编辑账号”和“删除账号”。
- 打开编辑框时并发重取最新账号 revision 与分组，慢链路只需两次读请求；保存后使用服务端返回值就地更新。
- 删除最终确认前再次获取最新 revision，避免用户在确认框停留期间覆盖桌面端变更。
- 删除后卡片变成撤销状态，账号选号候选立即从服务端重读，不继续展示父组件旧快照。
- 撤销入口按服务端 `undoUntil` 自动失效，过期后不再提供必败操作。

## 3. 破坏性操作决策

手机删除采用“两道防误触 + 有限恢复”：

1. 用户必须打开二级操作区，再进入删除对话框。
2. 必须完整输入目标邮箱（无邮箱时为账号 id），确认按钮才可用；普通一次误触无法删除。
3. 删除成功后，当前服务进程内保留 **10 分钟内存 tombstone**，页面提供撤销。
4. tombstone 不通过网络返回凭据、不另写盘，不伪装成永久回收站；服务进程重启、刷新页面或期限结束后不可恢复，UI 明示这一边界。
5. 恢复账号不会静默恢复为当前激活账号，返回并显示 `isActive: false`。

没有做持久化“回收站”，原因是当前账号整表仍是唯一权威持久化模型。另写 tombstone 文件会引入第二份含凭据的数据源，桌面端下一次整表保存还可能把它绕开；这种“看似可恢复、实际随机失效”的设计比明确的短期撤销更危险。

## 4. C6 完成内容

- `src/webPanel/api/panel.ts` 增加 `POST /admin-key/rotate` 客户端。
- `ProxyPanel` 增加“轮换管理密钥”入口。
- 用户必须输入“轮换”二次确认；文案明确所有已登录设备会立刻失效。
- 服务端成功后，新 key 只在一次性交付对话框显示。组件不会立刻通知 App 卸载页面，否则用户还没保存 key 就会被踢回登录页并锁在门外。
- 用户点击“我已保存，重新登录”后，先从 React 状态清掉 key，再切回登录页。
- 真实 HTTP 测试证明：
  - 未登录请求为 401；
  - 有会话但缺 CSRF 头仍为 401，且旧会话继续有效（无副作用）；
  - 成功响应为 `Cache-Control: no-store`，只交付 `key`；
  - 发起者旧会话立即失效；
  - 旧 adminKey 不能再登录；
  - 返回的新 key 可以重新登录。

## 5. 鉴权与数据暴露

`server.ts` 的顺序是登录例外 → 统一 `auth.guard()` → adminKey 轮换/业务路由。C2 路由都位于 `routePanelApi()` 内，C6 轮换路由也位于 guard 之后，没有旁路端点。

真实 HTTP 用例覆盖：

- 每条 C2 新路由在未登录时均为 401，且没有副作用；
- 每条 C2 写路由即使已有会话，缺 `X-Panel-Request: 1` 也为 401；
- C6 轮换的未登录与缺 CSRF 两个拒绝分支；
- C6 成功后旧会话失效、新 key 可登录。

凭据边界：

- 编辑响应只含账号元数据摘要；
- 删除响应只含 revision、撤销期限和池同步状态；
- 撤销 tombstone 只在主进程内存中保存；
- 分组响应使用白名单投影；
- 浏览器不读取或提交 access/refresh token。

## 6. 装配、配置与合并要求

### 已完成范围

C2 **不需要新依赖注入**：

- 持久化复用现有 `applyAccountDataMutation` / store ref；
- 运行池同步复用 `PanelRouteDeps.proxySyncPool`；
- 桌面端 `buildPanelRouteDeps()` 与 Node 端 `buildServerRouteDeps()` 已有这两个能力。

没有新增包、环境变量、配置项或 Vitest project 配置。真实服务器覆盖继续放在已经属于串行 `main-real-io` project 的 `test/main/webPanel/proxyRoutes.test.ts`，因此无需改 `vitest.config.ts`。

### C6 的跨 sibling 依赖（合并时必须处理）

本轮没有越权修改 `server.ts` / `auth.ts`。当前工作树中 C6 后端来自 sibling：

- `src/main/webPanel/server.ts`：`POST /api/admin-key/rotate`，位于统一 guard 之后，清 cookie、`no-store`、一次性交付新 key；
- `src/main/webPanel/auth.ts`：`PanelAuth.rotateAdminKey()`，持久化新 key 并使所有会话失效。

**父级合并时必须让这两处 sibling 改动先于或与本轮浏览器改动一起落地。** 若只拿本轮 `panel.ts` / `ProxyPanel.tsx`，C6 会得到 404，不能宣称完成。

### 一个非阻塞的父级文案修正

`src/webPanel/App.tsx` 不在本轮所有权内，其页脚仍写“账号数据仅在本页查看，不提供编辑或删除”。C2 落地后这句话已不准确。建议父级把它改成类似：

> 凭据不会发送到浏览器；账号备注、分组与删除操作由服务器完成。

这不影响 API/交互功能，但应在合并时修正，避免产品文案否认页面上真实存在的能力。

## 7. 为何 C1 / C3 / C4 没有半做

- **C1**：不能直接把通用 `proxy-update-config` 暴露给手机。应先做一个只接受端口/API Key/日志开关的共享用例，明确 API Key 读侧只返回“已配置/掩码”，每个字段返回热生效或需重启结果，未知键拒绝。随后需扩展 `PanelRouteDeps`，并在 `src/main/ipc/panelProxyDeps.ts`、`src/main/ipc/webPanelWiring.ts`、桌面 `src/main/index.ts` 与 Node `src/main/server/assembly.ts` 两端接线。
- **C3**：需要复用桌面端的出网代理定义/绑定语义，写入后还必须让运行中的反代出网路径实际变化。只做 CRUD 页面或只改 accountData 都会是假完成。
- **C4**：需要注入有界日志读取能力（分页/尾部读取/截断），并在日志存储入口与 HTTP 响应出口双重脱敏。直接返回文件内容会把 API Key、token 或代理账密带到手机。

这些能力应各自再走完整的“真实最终消费者先红 → 共享用例与两套装配 → 路由/API/UI → 绿”闭环。

## 8. RED → GREEN 证据

### 后端 C2

先增加真实 HTTP 测试后，账号编辑/删除/恢复/分组路由返回 **404（期望 200）**。实现路由、revision 仲裁和持久化后转绿；随后增加真实 `AccountPool` 断言，证明删除后池中账号确实消失、恢复后确实回来，而不只断言 HTTP 200。

### 手机 UI C2 / C6

先写真实 fetch 边界测试：

- 初始 RED：找不到“编辑账号”和“轮换管理密钥”按钮。
- 实现 UI/API 后转绿。

### 最终消费者旧快照

先写“删除后反代选号重读账号”测试：

- RED：期望第二次 `GET /accounts`，实际只有 1 次；
- GREEN：删除和恢复分别触发服务端重读，测试 4/4 通过。

### 撤销到期

先写短期限测试：

- RED：`numPassedTests=4`、`numFailedTests=1`，到期后按钮仍未禁用（expected `true`, received `false`）；
- GREEN：加入按 `undoUntil` 的定时失效后，`numPassedTests=5`、`numFailedTests=0`。

C6 的后端 HTTP 契约测试是在 sibling 路由已出现在共享工作树后补上的，因此它是集成契约锁，不冒充本代理制造的后端 RED；C6 浏览器 UI 本身有上述先红证据。

## 9. 最终验证

严格按指定的 default + JSON 双 reporter 命令运行四个定向文件，并读取 JSON 数字：

- Test files：4 passed / 0 failed
- `numPassedTests=79`
- `numFailedTests=0`
- `numPendingTests=0`

覆盖文件：

- `test/main/webPanel/proxyRoutes.test.ts`
- `test/main/webPanel/server.test.ts`
- `test/renderer/web-panel-ui/panelProxyPanel.test.tsx`
- `test/renderer/web-panel-ui/panelAccountManagement.test.tsx`

其余验证：

- `npm run typecheck:node`：EXIT 0
- `npm run typecheck:web`：EXIT 0
- 本轮 7 个负责文件的 ESLint：EXIT 0
- 本轮 7 个负责文件的 Prettier check：通过
- `npm run build:webpanel`：通过（37 modules transformed）
- `git diff --check`（负责范围）：通过

所有临时 JSON/log 验证文件均已删除。没有运行全仓 Vitest，因此不声称重验了用户给出的 1712 全量基线；共享工作树同时包含三个 sibling 的未完成改动，最终全量回归应由父级在合并点统一执行。

## 10. 本轮文件

- `src/main/webPanel/routes.ts`
- `src/webPanel/api/panel.ts`
- `src/webPanel/ui/AccountCard.tsx`
- `src/webPanel/ui/ProxyPanel.tsx`
- `src/webPanel/ui/accountDataEvents.ts`（新增；只传“失效”事件，不传数据）
- `test/main/webPanel/proxyRoutes.test.ts`
- `test/renderer/web-panel-ui/panelAccountManagement.test.tsx`（新增）
- `.agent-workspace/.archive/2026-08-13/panel-account-capabilities/findings.md`（本文件）

