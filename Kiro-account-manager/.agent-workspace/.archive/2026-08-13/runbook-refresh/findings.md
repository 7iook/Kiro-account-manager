# 2026-08-13 运维文档刷新结论

基线：`4517d12`，共享工作树含多名 agent 的未提交改动。  
约束遵守：未 commit、未 stash、未 revert；未修改任何测试、`vitest.config.ts` 或本任务所有权外的 `src/**`。

## 最终结论

受信代理在本任务开始核验时仍只完成配置解析与请求边界，生产装配尚未接线；工作期间 sibling 完成了 `assembly.ts` 接线。最终重新读取当前文件确认：

- 面板配置从 `ServerConfig` 取得只读 `trustedTlsProxyIPs` 覆盖（`src/main/server/assembly.ts:519-537`）；
- 数据反代通过 `readProxyRuntimeConfig()` 取得同一环境值，盘上同名字段会被剥离，写回时也不会持久化部署信任（`src/main/server/assembly.ts:380-388,555-580`）；
- 真实装配测试 `test/main/server/assemblyProductionWiring.test.ts` 通过 2/2。

因此最终文档没有把该设置标成 inert；它被写成“当前已接线，但必须显式 opt-in 且必须做真实代理 hop 验收”。没有把中途状态或另一 agent 报告中的旧行号抄进最终文档。

## 修改的文件

### `docs/security/network-exposure.md`

- 把 `KIRO_TRUSTED_TLS_PROXY_IPS` 的必做前提放到文档顶部。
- 明确未 opt-in 时的具体后果：真实客户端 allowlist 会误拒；把代理 peer 放入 allowlist 会放行该入口的所有客户端；真实客户端 denylist 不命中；登录限流聚合到代理地址。
- 更新 Caddy 合同，依赖其默认净化/重写 `X-Forwarded-*`，删除客户端 `Forwarded`；多级代理要求声明右向左剥链所需的每个受控 hop。
- 更新 nginx 清单、同机/异机信任边界、缺失/非法转发链 400、`X-Forwarded-Proto` 不被消费、受信声明本身即 TLS 断言。
- 删除“服务永不读取 forwarded headers”“TLS 前置后 cookie 必然不带 Secure”等已过时结论。
- 把启用受信 loopback 后的 backend 直连验收改为 `ss` + 外部 HTTPS front；直连缺少 `X-Forwarded-For` 返回 400 是正确 fail-closed 行为。

### `docs/deployment/linux-systemd.md`

- 环境变量表加入 `KIRO_TRUSTED_TLS_PROXY_IPS`：默认关闭、逗号分隔 IP/CIDR、客户端网段禁止、非法值退出 64。
- 区分未启用受信代理时的本机诊断与启用后的外部 HTTPS 验收。
- 明确 readiness 的 503 与代理元数据错误 400 不能混淆，也不能接成 systemd 重启条件。
- 增加账号管理/自动换号 runbook 链接。
- 把“并行文档假设”改成当前真实运行合同，并更新数据目录锁为已接线事实。

### `docs/deployment/verification.md`

- 保留并扩展 `unverified:`：真实 Caddy/nginx hop、客户端 IP policy、TLS cookie、Linux 自动换号长跑和崩溃窗口均未在本 Windows 主机验证。
- 把数据目录锁从“等待并行 owner 接入”改成“代码已接入，但本记录未做第二实例/systemd 竞争验证”。
- 没有把历史容器验证升级成当前 TLS/自动换号的验证证据。

### `docs/operations/account-management.md`（新增）

- 记录手机面板只编辑备注/分组，不把凭据发到浏览器。
- 记录删除必须输入邮箱（无邮箱时 id）、最终确认前重取 revision、删除清理 active 和代理绑定、运行池同步失败提示。
- 记录 10 分钟内存 tombstone、页面刷新失去入口、服务重启/超时失效、恢复后 `isActive:false`。
- 记录无头 scheduler 立即运行、默认 5 分钟、设置写入唤醒、single-flight、CAS 后才执行副作用。
- 记录桌面关闭后服务器仍继续推进服务器反代，但不会替关闭的桌面执行 IDE/CLI/机器码副作用。
- 记录决定信封与 applied id 的重启重放判据，以及停机先 stop scheduler 再 drain。

### `docs/operations/data-migration.md`

- 在“Caddy 尚未启动”的隔离阶段明确要求暂不设置受信代理变量，否则 SSH tunnel/backend 直连应返回 400。
- 离线检查增加非敏感自动换号配置输出；迁入数据若已启用自动换号，首次启动可能在操作员登录前立即换号。
- 不建议靠关闭桌面电脑暂停 scheduler；若不希望服务器自动换号，应在源桌面数据中关闭后重新复制。

### `docs/operations/backup-restore-upgrade.md`

- 受信代理启用时，恢复验收改为经隔离/生产 HTTPS front，不再把 backend 直连写成成功条件。
- 更新停机顺序、readiness 和备份写入代码锚点。
- 当前 sibling 已在服务端装配初始化并最终 flush `proxyLogStore`，因此删除“空路径、`proxy-logs.json` 不可靠”的过时缺陷说明；仍保留 journald 是进程生命周期运营真源的边界。

### `docs/operations/key-handling.md`

- 当前工作树中的 runbook 已经出现轮换端点，并不存在仍写着“无头不可达”的句子；没有为迎合任务摘要虚构一次删除。
- 补全手机 UI 流程：输入“轮换”、新 key 一次显示、保存后重新登录。
- 更新会话/CSRF、先持久化后失效、清 cookie、`no-store`、写盘失败保留旧会话和环境管理模式拒绝在线轮换的当前代码锚点。

### `deploy/systemd/server.env.example`

- 增加注释化 `KIRO_TRUSTED_TLS_PROXY_IPS=127.0.0.1` 示例。
- 注释明确 immediate peer、多级受控 hop、未 opt-in 的 IP policy/cookie 后果。

### `src/webPanel/App.tsx`

- 用户给出的路径 `src/webPanel/ui/App.tsx` 实际不存在；经目录核验，真实组件是 `src/webPanel/App.tsx`。
- 只改一处文案：不再声称编辑/删除必须在桌面端；没有重构组件，最终 Git diff 为 1 行替换。

## 代码锚点

### 受信代理与 TLS cookie

- 环境变量声明、默认值、校验、退出 64：`src/main/server/config.ts:67-85,112-125,143-183`
- 生产双入口装配与持久化剥离：`src/main/server/assembly.ts:380-431,519-580`
- 默认忽略、peer 校验、最多 32 hop、右向左剥链、非法链 fail closed：`src/main/utils/netGuard.ts:92-137`
- 面板真实 IP、400 和 IP policy：`src/main/webPanel/server.ts:266-295`
- 数据反代真实 IP、400 和 IP policy：`src/main/proxy/proxyServer.ts:2251-2263,2384-2435`
- 登录/登出按受信请求上下文设置 `Secure`：`src/main/webPanel/auth.ts:158-190,223-233`
- cookie 属性生成：`src/main/webPanel/cookie.ts:34-62`

### adminKey 轮换

- 统一 guard 与轮换路由：`src/main/webPanel/server.ts:369-405`
- 先持久化、再失效全部会话：`src/main/webPanel/auth.ts:138-150`
- 环境管理模式拒绝写文件：`src/main/server/adminKeyStore.ts:864-880`
- 手机确认与一次性交付 UI：`src/webPanel/ui/ProxyPanel.tsx:494-615`
- 真实 HTTP 契约：`test/main/webPanel/adminKeyRotation.server.test.ts:59-121`

### 账号编辑、删除和撤销

- 删除清理 active/绑定、10 分钟 tombstone、编辑白名单、恢复：`src/main/webPanel/routes.ts:360-585`
- 路由分派与凭据编辑排除：`src/main/webPanel/routes.ts:852-920`
- 删除确认、最新 revision、页面撤销边界：`src/webPanel/ui/AccountCard.tsx:94-223,444-607`

### 无头自动换号

- 重放有效性判据：`src/main/accountService/autoSwitch.ts:118-153`
- 决策、立即/周期运行、single-flight：`src/main/accountService/autoSwitch.ts:156-338`
- CAS 持久化决定：`src/main/accountService/autoSwitch.ts:343-398`
- 广播唤醒、启动前重放、scheduler 启动与停机顺序：`src/main/server/assembly.ts:351-420,447-475`
- 服务器反代副作用和 applied id：`src/main/server/assembly.ts:588-643`

## 仍未在本机验证

- unverified: Windows 主机不能验证真实 systemd PID 1、StartLimit、journal 持久化、POSIX owner/mode/ACL、UFW/nftables、云安全组和 IPv6。
- unverified: 未运行真实 Caddy/nginx TLS 部署；Caddy 配置语义已对照官方 `reverse_proxy` 文档，但证书、header 重写、真实 `Secure` cookie 和双来源 IP policy 必须在 Linux 主机验收。
- unverified: 未做自动换号长时间运行、主机重启或“决定已提交/副作用未应用”崩溃窗口的真实 Linux 故障注入。
- unverified: `.backup.enc` 仍没有已验证的无头自动恢复编排；文档继续以整目录冷备为正式恢复路径。

当前没有仍 inert 的受信代理装配项；它在收尾前已由 sibling 接线并由真实装配测试验证。上述 `unverified:` 是环境/运行态证据缺口，不是把已接线代码降级成未实现。

## 内部链接

发现并修复 `docs/deployment/linux-systemd.md` 中三个不存在的目标：

- `docs/deployment/data-migration.md`
- `docs/deployment/tls-front-proxy.md`
- `docs/deployment/firewall-exposure.md`

它们分别改为真实存在的 `docs/operations/data-migration.md` 与 `docs/security/network-exposure.md`；同时补入真实存在的 backup/account-management 合同。最终收集到 22 个 Markdown 链接：21 个内部链接的目标均由目录清单核实存在，1 个 Caddy 官方外链已成功检索。旧文件名、旧 forwarded-header 说明和旧 App 文案的最终内容搜索为 0 命中。

## 有意未改

- `deploy/systemd/kiro-account-manager.service`：unit 已通过 `EnvironmentFile=/etc/kiro-account-manager/server.env` 通用加载变量（`deploy/systemd/kiro-account-manager.service:8-17`），无需为每个新变量增加单独 `Environment=`；改它只会制造重复配置真源。
- `src/main/server/assembly.ts`：最终接线来自 sibling；本任务只读取、验证和据此更新文档，没有跨所有权修改。
- 手机面板的反代低风险配置、出网代理池管理、日志查看和自动换号设置 UI：当前没有端到端能力，本轮不把它们写成已支持。
- `.backup.enc` 自动恢复：能力仍不存在，现有明确限制正确，不在文档刷新任务中造恢复系统。
- 所有测试与 `vitest.config.ts`：只执行，不修改。

## 验证证据

- 定向回归：5 个 test file、20 个 test 全通过，覆盖可信代理真实 hop、配置解析、adminKey 轮换、自动换号装配和账号管理 UI。
- 生产装配专项：`test/main/server/assemblyProductionWiring.test.ts` 2/2 通过。
- `npm run typecheck:web`：EXIT 0。
- Prettier：8 个可解析的拥有范围文件全部通过；`server.env.example` 无可推断 parser，人工核对为注释 + `KEY=value` 模板。
- `git diff --check`（拥有范围）：EXIT 0，仅 Windows 工作树 LF→CRLF 提示。
- 未创建 commit。

⚡ 传播与安全网核验：语义检索列出受信代理定义/consumer/测试/文档/模板；最终内容搜索确认旧链接、旧 `trustProxy` 说明和旧 App 文案 0 命中；本轮实际执行的 Vitest、类型检查、Prettier 与 `git diff --check` 均产出了上述结果。
