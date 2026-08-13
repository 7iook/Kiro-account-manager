# Mode R · Reality recon：手机面板远程低风险配置（台账 #35 = C1）

> 范围只覆盖 C1；不把账号管理、代理池、日志查看、adminKey 轮换等相邻能力并入本计划。
>
> 最终校准基线：`git rev-parse HEAD` = `edcb42cdc302a705a66e636b522b00a2e48a70e6`。侦察期间 HEAD 曾从另一个同为 `edcb42c` 前缀的完整 SHA 变化到当前值，源码行号随之迁移；本报告已按最终 SHA 重扫并校正。工作树还有 `.agent-workspace/TASKS-2026-08-13.md`、`package-lock.json` 及若干未跟踪目录的并行改动；本报告未回退或纳入它们。
>
> 方法：先调用 mcphub 的 `codegraph-codegraph_explore`、`codebase-context-engine-search_context`、`fast-context-fast_context_search`。后两者成功；`codegraph-codegraph_explore` 连续返回 `Error: Not connected`。其后只对语义搜索命中的文件做定点读取/精确检索。  
> `unverified: codegraph 的图级关系无法取得，故调用关系以另两路语义搜索 + 定点源码证据交叉确认。`
>
> 侦察安全网实跑：`npx vitest run test/main/server/assemblyProductionWiring.test.ts` 在最终源码上得到 `2 tests passed`，覆盖 trust 运行时注入、手机选号写回剥离与日志 store 装配；测试体见 `test/main/server/assemblyProductionWiring.test.ts:25-128`。

## 1. Assumptions（已定事项与仍未决定的空白）

### 1.1 决策卡实际说了什么

决策卡的原话是：

> “面板配置 | 只放开低风险项（端口/API Key/日志开关）；高副作用项留配置文件 + 重启”  
> — `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:47-59`

配置链进一步写成：

> “低风险配置项（端口 / API Key / 日志开关）……待建端点 → 既有 `proxy-update-config` 归一化收口……配置热生效或明示需重启；非白名单键 → 拒绝并说明，不静默忽略”  
> “高副作用项（模型映射 / agent 模式 / payload 上限）……启动时读取；面板上只读展示 + 说明为何不可改，不隐藏”  
> — `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:256-260`

C1 的能力行又明确为：

> “运维在手机上改反代端口 / 加 API Key / 开日志”  
> “待建 `POST /api/proxy/config`（白名单键）”  
> — `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:305-308`

验收姿态是：

> “手机面板改配置（改端口 / 加 API Key / 开日志），确认生效或明示需重启；尝试改非白名单键确认被拒绝并说明”  
> — `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:402-414`

### 1.2 “分层方案已决定”的准确程度

台账若把它描述成完整的“分层方案”，会高估决策卡的精度。卡片只定了**两个粗粒度桶**：

1. 低风险、面板可改：反代端口、API Key、日志开关；
2. 高副作用、只读展示、改配置文件并重启：模型映射、agent 模式、payload 上限。

它没有给出逐字段 allow-list，也没有说明：

- “API Key”是单一 `apiKey`、多 key 的 `apiKeys[]`，还是增/删/吊销动作；
- “日志开关”具体是 `logRequests`、`logStreamEvents`、`enableAuditLog` 还是 `enablePerfDiagLog`；这些是四条不同路径，见 `src/main/proxy/types.ts:547-569,622-654`；
- 反代端口应自动重启、只写入待重启配置，还是只允许停机时修改；
- API Key / adminKey 的读回遮罩、审计载荷、失败回滚、二次确认。

卡片全文中“脱敏”的具体约束落在 C4 日志查看，不是 C1 配置读回：`.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:256-260`。因此这些细节必须由本次人类裁决补齐，不能伪装成“已经决定”。

### 1.3 侦察采用的边界假设

- 台账 #35 与 C1 是同一能力，不重复立项（用户给定事实）。
- 既定路由方法保持 `POST /api/proxy/config`，除非人类显式推翻决策卡：`decision-card.md:305-308`。
- 单一 adminKey、无多用户/角色，所以审计最多能识别“admin 主体 + 可信客户端 IP”，不能声称识别具体自然人：`decision-card.md:47-55`。
- 服务端控制面与反代数据面必须继续隔离：面板先启动且失败为致命，反代随后启动且失败只进入 DEGRADED、面板仍可运维：`src/main/server/entry.ts:142-216`。

## 2. Current Facts（当前真实链路）

### 2.1 手机面板当前没有配置链

- `PanelRouteDeps` 只有 proxy status/sync/activate/start/stop/release-held，没有 get/update config 依赖：`src/main/webPanel/routes.ts:94-125`。
- `/api/proxy/*` 的路由分发只含上述操作；不存在 `/api/proxy/config`：`src/main/webPanel/routes.ts:787-844`。
- 源码明确解释当前为什么没有通用 `proxyUpdateConfig`：副作用分支多、手机误触成本高，并把端口/API Key/模型映射留在桌面端：`src/main/webPanel/routes.ts:94-125`。
- Web 客户端同样明确让 `startProxy()` 不接收配置参数：`src/webPanel/api/panel.ts:389-406`。
- 面板的全部业务 `/api/*` 请求先走统一 adminKey/session guard；写请求的 CSRF 也由该 guard 统一检查：`src/main/webPanel/server.ts:346-416`。新端点应进入这条既有入口，不能自行再造鉴权。
- 请求侧已经从 socket peer/受信代理链计算 `clientIP`，但当前 `PanelRequestContext` 只含 method/path/body；要做变更审计，需把可信 `clientIP` 和请求头中的 `userAgent` 一起加入上下文：`src/main/webPanel/server.ts:266-295,408-416`、`src/main/webPanel/routes.ts:128-135`。

### 2.2 `proxyConfig` 的读、应用、写

服务端有效配置不是简单的盘上对象：

1. `proxyConfig` 从 store 读取，与默认值合并：`src/main/server/assembly.ts:579-584`。
2. `readProxyRuntimeConfig()` 再把 `trustedTlsProxyIPs` 作为环境派生的运行时字段叠加：`src/main/server/config.ts:66-78,143-180`、`src/main/server/assembly.ts:587-598`。
3. `ServerConfig` 的环境覆盖被明确规定为只读、绝不回写 store：`src/main/server/config.ts:14-22`。
4. `ProxyServer.updateConfig()` 接受 `Partial<ProxyConfig>` 并直接合并；只有 Hold 配置走现有 normalizer，监听字段只置 `needsRestart`：`src/main/proxy/proxyServer.ts:1023-1094`。
5. 桌面 `proxy-update-config` 另行处理 `logStreamEvents`、payload、agent、steering、token reserve、perf diag 等模块级副作用，然后把当前完整 config 写回 store：`src/main/index.ts:4735-4788`。

重要偏差：`src/main/server/assembly.ts:574-577` 的说明提到 `applyProxyRuntimeConfig()`，但仓内没有这个函数定义；桌面实际仍是在 IPC handler 内逐个调用 setter：`src/main/index.ts:4735-4778`。实施时不能调用一个不存在的“共享收口”。

### 2.3 `KIRO_TRUSTED_TLS_PROXY_IPS` 的不可破坏边界

- `withoutTrustedTlsProxyIPs()` 复制配置并删除 `trustedTlsProxyIPs`，返回才可持久化的 `ProxyConfig`：`src/main/server/assembly.ts:601-605`。
- 服务端读盘时即使旧盘上已有该字段，也先剥掉，再由环境层重新注入：`src/main/server/assembly.ts:579-598`。
- 服务端当前三类写回都保持边界：停机自动换号先读已剥离 config 再写，运行中自动换号显式剥离，面板 proxy deps 持久化也显式剥离：`src/main/server/assembly.ts:631-649,1112-1120`。
- 桌面 IPC 当前把桌面 `ProxyServer` 的 `newConfig` 原样写回；它没有服务端环境 overlay，但也不能被新服务端路径复用为持久化边界：`src/main/index.ts:4735-4783`。
- 现有生产装配测试证明：env trust 进入实际 panel/proxy consumer、不改写原盘值，且手机选号触发的写回不含该字段：`test/main/server/assemblyProductionWiring.test.ts:35-108`。

结论：新路径不能在 route 中直接 `store.set('proxyConfig', next)`；必须复用/导出同一个剥离边界，且桌面和服务端都加回归测试。

### 2.4 仓内其实已有另一条“远程配置”，但不能原样复用

反代数据面有 `/admin/config`：

- GET 返回完整 config 的变体，并显式遮罩 `apiKey`、`apiKeys[].key` 与 TLS 内容：`src/main/proxy/proxyServer.ts:2625-2647`。
- POST 用一张较宽的 allow-list 过滤输入：`src/main/proxy/proxyServer.ts:2650-2682`。
- 该 allow-list 故意排除 `port / host / apiKey / apiKeys / tls / fallbackPort / allowExternalWithoutApiKey`：`src/main/proxy/proxyServer.ts:2670-2673`。
- 未知键被静默丢弃；这与决策卡“拒绝并说明”的 C1 契约相反：`src/main/proxy/proxyServer.ts:2650-2682`、`decision-card.md:256-258`。
- POST 只调用 `updateConfig(filtered)`，没有 store 依赖，因而不持久化：`src/main/proxy/proxyServer.ts:2531-2567`。

因此可借的是“显式投影/遮罩”的思路，不能把 `/admin/config` 当作手机面板 C1 的完成品，也不应让前端绕过 panel guard 直接调用它。

### 2.5 当前校验、遮罩与审计能力

- 面板 `readJsonBody()` 只保证 JSON object 和 256 KiB 上限，不提供字段 schema：`src/main/webPanel/server.ts:35-36,433-468`。
- `ProxyServer.updateConfig()` 对任意 `Partial<ProxyConfig>` 直接合并；除 Hold normalizer 外没有字段级网络输入校验：`src/main/proxy/proxyServer.ts:1023-1072`。
- `sendJson()` 会递归调用 `redactValue()`，是最后一道通用保险：`src/main/webPanel/respond.ts:54-72`。
- 通用 redactor 按敏感键名和值形状处理；`password/token/secret/apiKey/...` 会隐藏，JWT、`ksk_` 等值也会隐藏：`src/main/utils/redact.ts:11-17,55-91,114-155`。但数组元素中的普通字段名 `key` 不在敏感键集合，故不能只依赖它遮罩 `apiKeys[].key`。
- `ProxyServer` 的既有 audit log 仅在 `enableAuditLog` 为 true 时写、最多 200 条、驻留内存：`src/main/proxy/proxyServer.ts:387-388,5253-5260,5324-5333`。
- `proxyLogStore` 则是最多 10000 条的持久滚动日志；每条先走脱敏再入 store，服务器启动初始化其数据目录、停机强制 flush：`src/main/proxy/logger.ts:193-226,320-458`、`src/main/server/assembly.ts:340-344,493-499`。
- perf diag 是独立的每日 append-only JSONL，默认关闭；配置模型只有开关、没有留存期字段，源码按天切文件，语义也是性能诊断而非配置审计：`src/main/proxy/types.ts:557-569`、`src/main/proxy/perfDiag.ts:1-2,130-215`。

### 2.6 真正可能把所有者锁在控制面外的设置

“敏感”与“锁面板”不是同一分类。按代码实证：

| 设置 | 真实影响 | 远程策略 |
|---|---|---|
| `webPanelConfig.host` / `port` | 面板启动失败是致命错误，整个服务退出：`src/main/server/entry.ts:142-155` | **通用远程配置永久拒绝** |
| `webPanelConfig.allowedIPs` / `deniedIPs` | 在登录前按客户端 IP 拒绝；可把当前管理端自封：`src/main/webPanel/server.ts:266-295` | **永久拒绝** |
| `trustedTlsProxyIPs` / `KIRO_TRUSTED_TLS_PROXY_IPS` | 同时决定是否采用 forwarded 客户端地址、以及 session cookie 是否带 Secure；它是部署期环境事实：`src/main/utils/netGuard.ts:31-49,102-137`、`src/main/webPanel/auth.ts:74-78,183-188`、`src/main/server/config.ts:66-78` | **永久拒绝，且永不持久化** |
| `adminKey` | 唯一控制面凭据；轮换先持久化再使全部会话失效（含发起者）：`src/main/webPanel/auth.ts:141-150`、`src/main/webPanel/server.ts:393-404` | **禁止进入 C1 通用 DTO**；若保留既有 C6，只走专用轮换流程 |
| `KIRO_ADMIN_KEY` / key file | env 管理时运行时写文件会造成 env/file 冲突，所以下次启动会拒启；现有 store 已明确拒绝：`src/main/server/adminKeyStore.ts:853-895` | **永久拒绝进入 C1** |
| `dataDir`、账户库加密前置 | 数据目录锁/数据 preflight/adminKey 引导都发生在面板启动前，失败即没有控制面：`src/main/server/entry.ts:80-112` | **部署期只读，永久拒绝** |
| `webPanelConfig.enabled` / `autoStart` | 若可改为 false 会消灭唯一控制面；服务端当前刻意强制二者为 true：`src/main/server/assembly.ts:543-560` | **永久拒绝** |
| `allowExternalWithoutAdminKey` | 主要是未鉴权暴露而非自锁；外部绑定无 adminKey 默认拒启：`src/main/webPanel/server.ts:51-69,141-161` | **永久拒绝** |

另外：

- `ProxyConfig.host/port/tls/fallbackPort` 只改变**反代数据面**。反代启动失败不会带死已经运行的面板：`src/main/server/entry.ts:164-216`。它们会造成业务客户端断联，但不能按现有架构直接把所有者锁出手机面板。
- `ProxyConfig.apiKey/apiKeys/allowedIPs/deniedIPs` 同样只保护反代数据面：`src/main/proxy/types.ts:547-552,622-630`。错误配置可令全部 API 客户端失败，但不会令 panel session 失效。
- `PANEL_PATH_PREFIX` 确实承重：路由前缀与 cookie Path 分叉会表现为登录后全 401；但它当前是代码常量而非配置项，不属于远程 allow-list 候选：`src/main/webPanel/cookie.ts:19-23,38-45`、`src/main/webPanel/server.ts:301-310`。

因此必须区分两级拒绝：

- **任何远程端点都不得改**：全部 `WebPanelConfig` 字段、`trustedTlsProxyIPs`、数据目录/加密/部署 env、`allowExternalWithoutAdminKey`。这些直接控制唯一管理入口或启动前置，确认弹窗不能把不可恢复操作变安全：`src/main/webPanel/server.ts:51-69,141-161,266-310`、`src/main/server/entry.ts:80-155`。
- **不得进入 C1 通用 patch，但可由人类裁决专用动作**：adminKey、proxy port/host/TLS/fallback、proxy API keys、proxy IP ACL、`allowExternalWithoutApiKey`。其中 adminKey 已有 C6 专用动作；其余只会切断数据面，不会切断 panel，但影响面足以禁止“一键普通保存”：`src/main/webPanel/server.ts:393-404`、`src/main/proxy/types.ts:547-552,578-581,622-654`。
- 所以用户列出的“端口/API keys”若指**反代**字段，证据不支持把它们与 panel host/port/adminKey/forwarded trust 放在同一个“控制面锁死”类别。它们仍因高影响、误触与密钥语义而不宜进入通用 patch；是否做专用确认动作由人类决定。

## 3. Existing Reuse Map（复用地图）

### 内部可直接复用

- 唯一鉴权/CSRF 入口：`WebPanelServer.routeApi()`，`src/main/webPanel/server.ts:346-416`。
- 路由错误和响应脱敏出口：`sendJson()` / `sendError()`，`src/main/webPanel/respond.ts:54-100`。
- 反代配置实例 API：`getConfig()` / `updateConfig()` / `needsRestart()`，`src/main/proxy/proxyServer.ts:1023-1094`。
- 面板 proxy 的最小依赖注入层和持久化 callback：`src/main/ipc/panelProxyDeps.ts:32-89,323-385`。
- 服务端 config 合并、环境覆盖和持久化剥离边界：`src/main/server/assembly.ts:543-605,631-649,1112-1120`。
- 通用脱敏与持久日志：`src/main/utils/redact.ts:11-17,55-91,114-155`、`src/main/proxy/logger.ts:193-226,320-458`。
- HTTP 级测试夹具（真 panel server + 真 guard + proxy stub）：`test/main/webPanel/proxyRoutes.test.ts:17-30,74-126`。

### 只能提炼后复用

- 桌面 `proxy-update-config` 的运行态副作用列表应提炼成真实共享函数；现在它嵌在 `index.ts`，不能从裸 Node 服务端导入 Electron 装配文件：`src/main/index.ts:4735-4788`。
- `/admin/config` 的字段投影/遮罩可作参考，但其 allow-list 太宽、未知键静默忽略、POST 不持久化：`src/main/proxy/proxyServer.ts:2531-2567,2625-2682`。
- 现有 `ProxyServer.auditLog` 可继续服务数据面 admin API，但 C1 的控制面变更审计不应受远程可关闭的 `enableAuditLog` 控制：`src/main/proxy/proxyServer.ts:5324-5333`。

### 外部复用

本任务不需要新增包。仓内没有运行时 schema validator 依赖，依赖清单见 `package.json:35-55`；字段很少时，用类型化字段表 + 严格手写 validator 更符合当前代码形态，避免仅为 1 个 DTO 引入依赖。

## 4. Architecture / Premise Challenge

### 4.1 真正问题

真正问题不是“把整个 `ProxyConfig` 放到网页表单”，而是：

> 在不允许控制面自锁、环境部署事实泄盘、敏感值回显的前提下，让所有者无需 SSH 完成一小组已裁决的日常反代变更，并能证明变更已应用、已持久化、可追责。

现有控制面/数据面分离是正确架构，不需要重写：面板先起且必须可用，反代失败可降级但不带死面板：`src/main/server/entry.ts:142-216`。

### 4.2 不应采用的捷径

- 不接受 `Partial<ProxyConfig>` 作为网络 DTO；该接口包含监听、安全、TLS、模型映射、payload、限流、Hold Gate 等数十个字段：`src/main/proxy/types.ts:547-681`。
- 不把 `/admin/config` 代理到 panel；它的过滤和持久化语义不满足 C1：`src/main/proxy/proxyServer.ts:2531-2567,2650-2682`。
- 不在 route 里直接写 store；这会绕过运行态副作用与 trust stripping：`src/main/index.ts:4735-4788`、`src/main/server/assembly.ts:601-605`。
- 不把“读回时跑一次 `redactValue()`”当作 secret DTO 设计；`apiKeys[].key` 已证明需要显式遮罩：`src/main/proxy/proxyServer.ts:2625-2642`。
- 不允许 unknown key 静默成功；决策卡明确要求拒绝并说明：`decision-card.md:256-258`。

### 4.3 人类必须裁决的决策（实施前置）

1. **最终 allow-list（阻塞）**
   - 当前代码下唯一可直接推荐为“低风险、热生效、无密钥”的字段是 `logRequests`：它是布尔值，`updateConfig()` 合并后请求路径直接现读：`src/main/proxy/proxyServer.ts:1026-1040,2463-2468`。
   - `logStreamEvents` 不是同一路径；桌面靠模块级 `setLogStreamEvents()` 单独应用，服务端没有共享收口：`src/main/index.ts:4739-4744`。
   - `enablePerfDiagLog` 会打开每日 append-only 文件，且配置模型没有留存期字段：`src/main/proxy/types.ts:557-569`、`src/main/proxy/perfDiag.ts:130-215`，不宜默认归入“开日志”。
   - `enableAuditLog` 决定既有审计记录，本次远程变更审计不能允许被它关闭：`src/main/proxy/proxyServer.ts:5324-5333`。
   - 模型映射、agent 模式、payload 上限按决策卡保持只读：`decision-card.md:256-258`。
2. **反代端口：专用二次确认还是拒绝**
   - 决策卡明确允许“反代端口”：`decision-card.md:305-308`；本次 brief 又把 port 列为明显不应远程设置候选。两者冲突，不能由 executor 猜。
   - 推荐：不进入普通保存；若保留卡片决定，做“专用动作 + 显示旧/新连接串 + 明确需重启 + 二次确认”。面板端口永远拒绝。
3. **反代 API Key：专用二次确认还是拒绝**
   - 它不会锁手机面板，但会一次性使所有反代客户端失效。
   - 推荐：不接受通用字符串替换；若保留卡片决定，先裁决单 key 还是多 key，采用“新增 key → 展示一次 → 验证/迁移 → 吊销旧 key”的专用动作。不要在普通 GET 中回显。
4. **adminKey 的边界**
   - C1 通用 config 应永远拒绝；C6 已有专用轮换且会主动注销所有会话：`src/main/webPanel/auth.ts:141-150`、`src/main/webPanel/server.ts:393-404`。
   - 人类需确认“never remotely settable”是指 C1 通用入口，还是要推翻已有 C6 产品决定。两者不能同时成立。
5. **只读展示的粒度**
   - 决策卡要求高副作用项“只读展示 + 解释”：`decision-card.md:256-258`。
   - 需裁决 API key 只显示 `{configured,count}`，还是允许显示不可逆 hint（例如首尾字符）；推荐前者。
6. **审计留存要求**
   - 最小实现可写入现有、已脱敏、持久化的 `proxyLogStore`：`src/main/proxy/logger.ts:193-226,320-458`。
   - 若要求不可由常规日志清理、独立保留期或防篡改，则需专用 append-only audit 文件；这超出现有 audit 能力，不能假称已具备。

二次确认的推荐结论是：`logRequests` 不需要；proxy port/API key 若被允许则必须专用二次确认；已有 adminKey 轮换继续保留“输入确认词 + 新 key 一次性交付”；控制面监听/IP/trust/部署字段一律拒绝，不能用二次确认绕开。

## 5. True Modification Scope（按依赖顺序的实施计划）

### Wave 0 — 冻结产品契约（人类，先于编码）

输出一张字段矩阵，每一字段只允许一个结论：

`editable-hot` / `editable-restart-required` / `dedicated-confirmed-action` / `read-only` / `never-remote`

至少明确：`logRequests`、`logStreamEvents`、`enablePerfDiagLog`、proxy `port`、`apiKey`、`apiKeys`、模型映射、agent 模式、payload 上限，以及第 2.6 节所有控制面部署字段。没有这张矩阵，不允许 executor 自选 allow-list。

### Wave 1 — 建立窄 DTO 与纯策略层

新增 `src/main/webPanel/proxyConfigPolicy.ts`（`to-build`）：

- 定义网络 DTO，而不是暴露 `ProxyConfig`：
  - GET：`editable`、`readOnly`、`requiresRestart`、`reasons`；
  - POST：`{ changes: Record<string, unknown>, confirmation?: ... }`；
  - 成功：`{ appliedFields, requiresRestart, config: safeProjection }`。
- 用唯一字段表同时驱动 allow-list、类型/范围校验、是否 secret、应用模式、只读原因，避免前后端各手抄一张名单。
- 严格拒绝：
  - 未知顶层键；
  - 未知 `changes` 键；
  - 类型不符、非有限数、越界、空 secret；
  - 原型继承值或数组冒充 object。
- 只接受 patch；在 single-flight 内基于**最新** config 合并，前端不得回传完整快照，避免两个 session 互相覆盖无关字段。
- GET 只构造显式安全投影。secret 只返回状态/数量；即便 `sendJson()` 仍会二次脱敏，也不让原值先进入响应对象：`src/main/webPanel/respond.ts:54-72`。

新增 `test/main/webPanel/proxyConfigPolicy.test.ts`（`to-build`），先覆盖 allow/deny、边界值、未知键、secret 不回显。

### Wave 2 — 提炼共享的“应用 + 持久化”收口

新增 `src/main/proxy/applyProxyConfigUpdate.ts`（`to-build`），把桌面 IPC 中已存在的模块级副作用提炼成纯 Node 可导入的共享函数；桌面与服务端装配各注入持久化 callback，不能让共享模块 import Electron。依据是当前副作用散落在 `src/main/index.ts:4735-4788`。

收口应保证：

1. 策略层先完整验证，验证失败零副作用；
2. 获取最新运行态/盘上配置并生成 `next`；
3. 对已初始化 `ProxyServer` 应用 hot 字段及对应模块级 setter；
4. 持久化**完整 next 的可持久化投影**；
5. 任一步失败时，不返回“成功”；恢复旧运行态/旧盘值，或明确返回 `APPLY_FAILED` / `PERSIST_FAILED`；
6. 成功后才写审计事件。

配置读写不能为了 GET/POST 隐式初始化反代：当前 panel deps 明确把初始化限定在启动路径，避免把“未运行”伪装成“已初始化”：`src/main/ipc/panelProxyDeps.ts:71-84`。共享收口应由装配层注入：

- `getLatestConfig()`：已有实例则读 `server.getConfig()`，否则从 store + env runtime overlay 读取；
- `getProxyServer()`：未初始化时返回 null；
- `persist(next)`：服务端必须走 `withoutTrustedTlsProxyIPs()`；
- `applyRuntime(patch)`：实例存在时热应用；实例不存在时只持久化，后续构造必须消费该值。

若最终 allow-list 含任何模块级 setter 字段，server 的初次 `initProxyServer()` 也必须调用同一 runtime apply 函数；当前 assembly 只有一段提到 `applyProxyRuntimeConfig` 的注释、没有实现：`src/main/server/assembly.ts:574-577`。否则会出现“手机保存成功，重启后 store 有值，但裸 Node 模块级行为仍是默认值”。

对 `restart-required` 字段，不能直接调用当前 `updateConfig()` 后仅提示重启，因为 `getConfig()` 会立刻显示新 port，而现有 socket 仍监听旧 port；`needsRestart()` 只是标志，不维护 active/pending 两套配置：`src/main/proxy/proxyServer.ts:1023-1094`。若 Wave 0 允许 port，应实现 pending-vs-active 状态或专用受控重启/失败回滚，不能制造“状态显示新端口、实际还在旧端口”的假成功。

修改：

- `src/main/index.ts:4735-4788`：桌面 IPC 调共享收口；桌面装配注入自己的持久化 callback，不让共享函数猜平台。
- `src/main/server/assembly.ts:579-605,631-649,1112-1120`：导出/复用单一 `toPersistedProxyConfig()`（现 `withoutTrustedTlsProxyIPs`），并把 server 装配的 get/apply/persist 回调接给 panel deps。
- `src/main/ipc/panelProxyDeps.ts:71-89,323-385`：扩展最小接口，提供 config 安全读和 policy 后的 update；不让 route 持有 store。

如果 Wave 0 最终只允许 `logRequests`，这一层可以很薄；若允许 `logStreamEvents` / payload / agent 等，则共享副作用提炼是硬依赖。

### Wave 3 — 接入 panel HTTP 路由和审计

修改：

- `src/main/webPanel/routes.ts:94-135,770-845`
  - 增加 `proxyGetConfig` / `proxyUpdateConfig` 依赖；
  - 增加 `GET /api/proxy/config` 与决定卡指定的 `POST /api/proxy/config`；
  - POST 放入 `singleFlight('proxy-config-update', ...)`；
  - unknown/invalid 返回 400 + 稳定 code + 字段级说明，绝不静默忽略；
  - persistence/apply 失败返回 500，响应仍走 `sendError()`。
- `src/main/webPanel/respond.ts:32-51,91-100`
  - 增加配置专用稳定错误码（至少 `INVALID_CONFIG`）；不能滥用 `INVALID_CREDENTIAL`，也不能让前端按 message 文案分支。
- `src/main/webPanel/server.ts:266-295,408-416`
  - 把经过 trusted-proxy 处理后的 `clientIP` 传入 route context；
  - 不记录 session token 或 adminKey。

审计事件至少包含：

- `timestamp`、固定 actor=`admin`、可信 `clientIP`、`userAgent`；
- 成功/拒绝/失败；
- 变更字段名；
- 非 secret 字段的 before/after；
- secret 字段只记 `{operation, configuredBefore, configuredAfter}`，不记值或 hint；
- `requiresRestart` 与 apply/persist 结果。

默认写 `proxyLogger` 的固定 category（例如 `PanelConfigAudit`），因为它会先脱敏再进入持久 store：`src/main/proxy/logger.ts:193-226,320-458`。该审计**不得受 `ProxyConfig.enableAuditLog` 控制**。

修改/新增测试：

- `test/main/webPanel/proxyRoutes.test.ts`：真 HTTP 验证登录、CSRF、GET 安全投影、POST 成功、unknown/invalid 零副作用、并发 single-flight、原始响应不含 secret。该文件已有相同层级的 auth/CSRF/脱敏测试模式：`test/main/webPanel/proxyRoutes.test.ts:625-650,684-705`。
- `test/main/server/assemblyProductionWiring.test.ts`：从新远程写回路径重复证明 env trust 运行时可见、盘上不可见；现有对应夹具在 `test/main/server/assemblyProductionWiring.test.ts:35-108`。
- `test/main/proxy/applyProxyConfigUpdate.test.ts`（`to-build`）：apply/persist 任一路失败的回滚，以及桌面/服务端共享副作用一致。

### Wave 4 — Web 客户端与手机 UI

修改：

- `src/webPanel/api/panel.ts:389-406` 附近：增加 typed GET/POST 方法；API key 类值不进入普通 config model。
- `src/webPanel/api/client.ts:97-117`：原则上无需改；现有 client 已自动携带 CSRF 和 credentials。
  - 若新增 `INVALID_CONFIG`，同步补其中文错误映射；请求发送逻辑本身无需改。
- `src/webPanel/ui/ProxyPanel.tsx:300-511`：在现有反代卡片中增加配置入口、editable/read-only 分区、保存中/失败/成功/需重启状态。不要把配置塞进 `startProxy()`；该方法当前“不接受任何参数”是刻意契约：`src/webPanel/api/panel.ts:389-406`。
- 若 Wave 0 允许专用高影响动作，复用现有 adminKey 轮换的“输入固定确认词 + 一次性交付”交互模式，但不要复用其 DTO：`src/webPanel/ui/ProxyPanel.tsx:260-269,528-586`。

UI 必须显示只读字段及原因，满足决策卡“不隐藏”：`decision-card.md:256-258`。保存后使用服务端返回的安全投影，不做乐观假成功。

### Wave 5 — 证明工作成立

自动证据：

1. policy 单测：最终名单的每个字段都有 allow/deny 用例；unknown key 返回 400，不静默过滤。
2. HTTP 集成：未登录 401、缺 CSRF 401、合法 patch 200、非法 patch 零运行态/零盘上变化。
3. secret 测试直接对原始 response text 和持久 audit 文件断言，确保不存在完整 key。
4. persistence：改后重建 server assembly，GET 与运行态仍读到新值。
5. trust boundary：以 `KIRO_TRUSTED_TLS_PROXY_IPS` 启动，远程修改并落盘后，盘上仍无 `trustedTlsProxyIPs`，重启后 env 值仍生效。
6. audit：成功、拒绝、apply 失败、persist 失败四态都有事件；重启重新加载后成功事件仍存在；`enableAuditLog=false` 不影响它。
7. 若允许 restart-required：新端口真正监听、旧端口释放；启动失败时旧端口仍工作且 panel 全程可访问。
8. 运行 `npm test`、`npm run typecheck`、`npm run build:server`；脚本定义见 `package.json:9-30`。

人工 E4：

1. 真实 Linux/容器、无 Electron runtime；
2. 手机登录；
3. 改每个 editable 字段，刷新页面并重启进程确认持久；
4. 对 restart-required 字段确认 UI 明示；
5. 尝试 `host`、panel port、adminKey、`trustedTlsProxyIPs`、模型映射等非白名单键，确认明确拒绝；
6. 查看审计，不含 secret；
7. 关掉桌面端，重复上述步骤。

这与决策卡 E4/E9 的最终 sink 对齐：`decision-card.md:402-418`。

### Link Completeness Scan

| 节点 | producer | consumer | 当前状态 |
|---|---|---|---|
| 手机配置表单 | `to-build` | `to-build` `src/webPanel/api/panel.ts` config 方法 | broken |
| Web API client | `src/webPanel/api/client.ts:95-117` | `src/main/webPanel/server.ts:346-416` | complete |
| 统一 auth/CSRF | `src/main/webPanel/server.ts:346-416` | `src/main/webPanel/routes.ts:787-844` | complete |
| `GET/POST /api/proxy/config` | `to-build` | `to-build` policy / panel deps | broken |
| 严格字段策略 | `to-build` | `to-build` shared apply sink | broken |
| 运行态应用 | `src/main/proxy/proxyServer.ts:1023-1094` + `src/main/index.ts:4735-4778` | ProxyServer / 模块级配置消费者 | partial；需共享收口 |
| 持久化 | `src/main/ipc/panelProxyDeps.ts:83-84` callback | `src/main/server/assembly.ts:1112-1120` store | complete，但新 update 尚未接入 |
| trust stripping | `src/main/server/assembly.ts:601-605` | 所有 server `proxyConfig` 写回 | complete，必须保持 |
| 安全读回 | `to-build` explicit projection | `src/main/webPanel/respond.ts:54-72` 二次脱敏 | broken |
| 持久审计 | `to-build` config audit event | `src/main/proxy/logger.ts:193-226,320-458` | partial；载体存在、事件未接 |

## 6. Recommended Split（依赖与并行派发）

| Work package | 内容 | 依赖 | 可并行性 |
|---|---|---|---|
| WP0 | 人类冻结字段矩阵、port/API key/adminKey/审计裁决 | 无 | 阻塞全部编码 |
| WP1 | policy DTO、validator、安全投影及单测 | WP0 | 单独先做；它是前后端共同合同 |
| WP2 | 共享 apply/persist 收口；桌面 + server 装配；trust 回归 | WP1 | 与 WP3 不并行改 `panelProxyDeps.ts` |
| WP3 | panel routes、context clientIP、HTTP/审计测试 | WP1、WP2 的接口 | 可与 WP4 在合同冻结后并行 |
| WP4 | Web API + ProxyPanel UI + 组件测试 | WP1 | 与 WP3 并行 |
| WP5 | 集成回归、Linux 真跑 E4/E9、证据归档 | WP2-WP4 | 最后串行 |

建议最多两名 executor：一名负责 WP1-WP3（主进程/持久化/安全），一名负责 WP4（Web UI）。WP2 涉及 `index.ts`、`assembly.ts`、`panelProxyDeps.ts`，应由同一人串行完成，避免两个持久化真源。

## 7. Risk & Conflict Notes

1. **决策冲突最高风险**：旧卡明确允许反代 port/API Key，本次 brief 把 port/API keys 列入明显禁止候选。编码前必须裁决，不能折中成模糊开关：`decision-card.md:305-308`。
2. **trust 泄盘回归**：任何新增 `store.set('proxyConfig', ...)` 都可能绕过剥离。唯一允许的 server 写回 API 必须命名并测试其 invariant：`src/main/server/assembly.ts:601-605,631-649,1112-1120`。
3. **假热更新**：`updateConfig()` 会立刻改 config object，但监听字段需要 restart；若 UI 读回新 port，实际 socket 仍旧，会制造假成功：`src/main/proxy/proxyServer.ts:1023-1094`。
4. **双重远程配置语义**：数据面的 `/admin/config` 与新 panel endpoint 若维护两张 allow-list，会漂移。应共享“字段元数据”，但保留不同权限/持久化边界：`src/main/proxy/proxyServer.ts:2650-2682`。
5. **`enableAuditLog` 自我关闭**：现有 audit 被该字段 gate；不能拿它证明 C1 审计完整：`src/main/proxy/proxyServer.ts:5324-5333`。
6. **secret 二次暴露**：通用 redactor 不足以遮住 `apiKeys[].key`；响应 DTO 和 audit DTO 都须先天不含原值：`src/main/utils/redact.ts:11-17,88-91`、`src/main/proxy/proxyServer.ts:2625-2642`。
7. **大文件冲突**：`src/main/index.ts` 是高冲突装配文件，`panelProxyDeps.ts` 的既有设计也明确要求把逻辑留在独立模块、让 index 只做薄接线：`src/main/ipc/panelProxyDeps.ts:1-18`。
8. **`assembly.ts` 是近期安全热点**：trusted proxy、server override、持久化均集中在 `src/main/server/assembly.ts:543-649,1112-1120`；不要让 UI executor 同时修改。
9. **基线并行漂移**：侦察期间完整 HEAD SHA 发生变化但短 SHA 仍为 `edcb42c`，且工作树出现新的并行改动。执行者必须记录完整 SHA、按 owner 隔离，不得清理、reset 或顺手纳入。
10. **图搜索不可用**：`unverified: codegraph-codegraph_explore 未连接；若合并前该服务恢复，建议再跑一次从 panel route → deps → store/runtime sink 的图级 reachability 复核。`

## 8. Domain Model（本能力需要的最小配置领域模型）

仓内没有 `docs/domain/**/*.md`。该能力跨网络 DTO、运行态、持久态、环境覆盖与 secret 边界，实施前应由主任务决定建立小型领域文档；至少固化以下模型。

### 8.1 配置来源与所有者

| 类别 | producer | 真源/生命周期 | consumer | 可否远程写 |
|---|---|---|---|---|
| DeploymentConfig | env / CLI | 进程启动期，只读：`src/main/server/config.ts:14-22,66-78,143-180` | server assembly / panel | 否 |
| PersistedProxyConfig | desktop 或受控 panel sink | `store.proxyConfig`：`src/main/server/assembly.ts:579-584` | desktop + headless ProxyServer | 仅 policy allow-list |
| ProxyRuntimeOverlay | `KIRO_TRUSTED_TLS_PROXY_IPS` | 运行时叠加，不回写：`src/main/server/assembly.ts:587-605` | ProxyServer / WebPanelServer | 否 |
| WebPanelConfig | defaults + env override | server assembly：`src/main/server/assembly.ts:543-560` | WebPanelServer | 否 |
| AdminCredential | env 或独立 key file | `src/main/server/adminKeyStore.ts:18-43,853-895` | PanelAuth | 不经 C1；仅专用 C6 |
| PanelProxyConfigView | `to-build` safe projection | 每次 GET 从最新有效 config 投影 | 手机 UI | 只读响应 |
| PanelProxyConfigPatch | `to-build` strict DTO | 单次请求 | policy → shared apply sink | 仅字段矩阵允许项 |
| ConfigAuditEvent | `to-build` | 持久日志或专用 audit store | owner / 运维 | append-only 语义 |

### 8.2 必须成为测试不变量的规则

1. 任何网络输入都不能直接成为 `Partial<ProxyConfig>`。
2. 任何持久化 `proxyConfig` 都不含 `trustedTlsProxyIPs`；环境覆盖也不回写。
3. 控制面配置、adminKey 与部署加密配置永远不经过 C1。
4. 任何 secret 都不出现在 GET/POST 响应、error、audit、console。
5. 非白名单键明确失败且零副作用。
6. apply + persist 对用户只有成功或明确失败，不能出现部分成功。
7. 反代配置失败不能令 panel 退出或失联。
8. 高副作用字段即使不可编辑，也按决策卡展示“当前摘要 + 为什么不可改”。
9. 审计不受被审计配置项控制。
10. 一切 success 都来自真实 sink 读数，不来自前端乐观状态；现有 proxy status 已采用同一原则：`src/main/ipc/panelProxyDeps.ts:300-320,347-369`。

### 8.3 交付边界

该任务值得一份持久 spec（跨前后端、持久化、安全边界且有人类决策），但本侦察不创建 spec 或业务代码。执行前的最小输入是 Wave 0 字段矩阵；执行完成的最小证据是第 5 节自动测试 + 决策卡 E4/E9 真跑记录。
