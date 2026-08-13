# TLS 前置代理安全缺陷修复结论

日期：2026-08-13  
基线：`4517d12`  
约束：未 commit、未 stash、未 revert；未修改 `assembly.ts`、`entry.ts`、两份 runbook 或 `vitest.config.ts`。

## 结论与合入前阻塞项

两个缺陷的机制层、请求边界、配置解析和真实代理 hop 回归已完成：

- 新增显式 opt-in：`KIRO_TRUSTED_TLS_PROXY_IPS`。
- 只有实际 socket peer 命中该列表，应用才会采用 `X-Forwarded-For`，并把该请求视为“经受信 TLS 终止代理到达”。
- 面板登录、登出及密钥轮换后的清 cookie 都会在该请求上下文下带 `Secure`。
- 面板和数据代理的 IP policy 都使用解析后的真实客户端地址。
- 未 opt-in 时仍只使用 socket 地址，伪造 `X-Forwarded-For` / `X-Forwarded-Proto` 无效，普通 HTTP cookie 仍不带 `Secure`。
- 受信 peer 缺少或发送非法 `X-Forwarded-For` 时返回 400，不退回代理自身地址；非法环境变量以 `ServerConfigError(EXIT.USAGE=64)` 拒绝启动。

**但当前工作树仍有一个合入前阻塞项，归 `src/main/server/assembly.ts` owner：**

- `readServerConfig()` 已产生 `config.trustedTlsProxyIPs`，但 `readPanelConfig()` 当前在 `assembly.ts:462-477` 只覆盖 host/port，未把该列表覆盖到 `WebPanelConfig`。
- `readProxyConfig()` 当前在 `assembly.ts:495-497` 只读取盘上 `proxyConfig`，也未注入该列表。
- 因此本次真实 hop 测试通过的是请求边界能力；若装配层不接线，正式 headless 入口仍不会启用新模式。
- 装配层必须把环境变量值作为**运行时只读覆盖**同时注入面板与 `ProxyServer`，不能让盘上/UI 配置开启信任。数据代理侧可给 `ProxyConfig` 增加运行时字段，或使用明确的交叉类型；不要持久化该字段。
- `deploy/systemd/server.env.example` 也需由相应 owner 增加该变量及注释。

## 设计选择

### 单一显式声明同时授权两件事

采用 `KIRO_TRUSTED_TLS_PROXY_IPS=<IP/CIDR,...>`，含义是：

1. 这些是后端 socket **实际看到**的 TLS 终止代理源地址；
2. 仅这些 peer 写入的 `X-Forwarded-For` 可参与客户端 IP 判定；
3. 经这些 peer 到达的面板请求，其 session cookie 必须带 `Secure`。

应用不读取 `X-Forwarded-Proto` 来自行提升信任；TLS 性质来自运维的显式声明。这样客户端即使伪造 `X-Forwarded-Proto: https` 也不能获得 `Secure` cookie。相应运维合同必须保证声明的入口只代理 TLS 请求；若同一 peer 还转发明文 HTTP，配置本身就是错误的。

### 转发链算法

`resolveClientIP()` 位于 `src/main/utils/netGuard.ts:92-138`：

- 先归一化 IPv4-mapped IPv6；
- 默认忽略 forwarded header；
- peer 受信后才解析 `X-Forwarded-For`；
- 最多 32 hop，空项、非法 IP、缺失 header 均 fail closed；
- 从右向左剥离受信 hop，停在第一个不受信地址，不采用可由客户端预置的“最左值”。

该算法允许明确配置的多级代理，同时避免经典的 `X-Forwarded-For: <伪造白名单>, <真实客户端>` 最左值绕过。

### 为什么没有因“loopback + IP rules”一律拒绝启动

仅从后端状态无法区分：

- 合法的桌面/本机直连用户；
- 同机 TLS 代理后的远程用户。

两者的 socket peer 都可能是 `127.0.0.1`。在没有 opt-in 的情况下因 IP rules 存在而拒启，会破坏已有桌面和纯本机部署，也违反“未 opt-in 行为不变”。因此选择：

- 不自动推断代理；
- 声明缺省为 `[]`；
- 声明非法时拒启；
- 声明启用后，受信 peer 的转发元数据缺失/非法时逐请求明确拒绝并记录；
- runbook 必须把 opt-in 写成 TLS 前置部署的必做步骤，不能继续描述“所有地址显示 127.0.0.1 是正常限制”。

### 同机与异机代理

- **同机代理**：后端继续绑定 loopback，通常只声明实际 peer `127.0.0.1`（仅当 upstream 确实走 IPv6 时再声明 `::1`）。不要宽泛声明 `127.0.0.0/8`。任何能从同一受信地址连接后端的本机进程都处于该信任边界内，因此主机上的不受信代码不适合与服务共租。
- **异机代理**：loopback 后端不可达。服务必须绑定私网地址，主机防火墙/安全组只允许代理节点，列表填写后端实际观察到的代理源地址（注意 SNAT），最好是精确 IP；不得填写客户端网段。
- 前置代理应删除/覆盖客户端自带的 `Forwarded` / `X-Forwarded-*`。算法虽能抵抗最左预置值，入口净化仍是纵深防御和清晰运维合同。

## TDD：红 → 绿证据

所有命令均从嵌套代码目录执行，使用 default + JSON 双 reporter；失败原因取 default reporter。

### 缺陷 1：TLS 前置后的 session cookie 缺少 `Secure`

红测：

```text
npx vitest run test/main/webPanel/server.test.ts -t "经显式受信的 TLS 前置代理登录" ...
numFailedTests=1, numPassedTests=0
Received: kam_panel_sid=...; HttpOnly; SameSite=Strict; Path=/panel; Max-Age=86400
Expected cookie to contain: Secure
```

该测试先启动真实面板 HTTP server，再启动真实 front HTTP server，由 front 建立第二个 socket hop 并写入转发地址；不是对 helper 的孤立断言。

绿测覆盖：

- 受信 hop 登录 cookie 带 `Secure`；
- 登出清 cookie 同时带 `Secure; Max-Age=0`；
- 未 opt-in 时伪造 `X-Forwarded-For/Proto` 不能获得 `Secure`。

### 缺陷 2：代理后 IP policy 只看到 loopback

红测：

```text
npx vitest run test/main/proxy/trustedTlsProxy.integration.test.ts ...
numFailedTests=1, numPassedTests=1
expected 403 to be 200
[WARN][ProxyServer] Blocked request from 127.0.0.1:
IP 127.0.0.1 not in allowed list
```

该测试实际启动 `front -> ProxyServer` 两个 server；`allowedIPs=['203.0.113.42']`，front 写入该客户端地址。红测证明旧实现确实按代理 loopback 拒绝。

绿测覆盖：

- 真实代理 hop 后 `allowedIPs` 按转发客户端地址放行；
- peer 未受信时伪造 header 仍按 socket 地址拒绝；
- 从右向左剥离受信 hop，不采用最左伪造值；
- 受信 peer 缺少 `X-Forwarded-For` 返回 400，不静默降级。

### 配置红测

实现前 `trustedTlsProxyIPs` 为 `undefined`，三项均红：

```text
numFailedTests=3, numPassedTests=0
- 未声明时预期 []，实际 undefined
- 显式 IP/CIDR 列表未解析
- 非法地址未抛 ServerConfigError
```

### 最终验证

最终相关回归：

```text
Test Files  7 passed (7)
Tests       116 passed (116)
JSON: numFailedTests=0, numPassedTests=116
```

证据文件：

- `final-regression.json`
- `final-regression.log`
- `final-typecheck.log`

`npm run typecheck`：EXIT=0（node 与 web 两段均通过）。  
`prettier --check`：通过。  
`git diff --check`：通过，仅有工作树 LF→CRLF 提示。

`test/main/proxy/trustedTlsProxy.integration.test.ts` 新增了真实端口绑定，当前日志显示它被分到 `|main|`；必须由 `vitest.config.ts` owner 加入 `main-real-io` 列表。本任务按约束未修改该文件。

## 未 opt-in 用户的升级行为

- `KIRO_TRUSTED_TLS_PROXY_IPS` 未设置或为空时解析为 `[]`。
- forwarded headers 继续完全不参与安全判定。
- 直连/桌面 IP policy 继续按 socket 地址工作。
- 真正的普通 HTTP 登录 cookie 继续不带 `Secure`，不会因升级变成无法登录。
- 桌面端无需新增配置。
- 旧的 TLS 前置部署不会被自动猜测或自动改变；管理员必须按更新后的 runbook 显式 opt-in。未完成装配接线前，即使设置环境变量也不会生效，这是上面的合入阻塞项。

## 两份 runbook 必须修正

### `docs/security/network-exposure.md`

1. **“Canonical：Caddy”**：加入 `KIRO_TRUSTED_TLS_PROXY_IPS=127.0.0.1`（按实际 upstream peer 调整）这一必做配置；说明 Caddy/nginx 必须覆盖客户端转发头，并在 reload 后验证真实客户端 IP policy 与 `Secure` cookie。
2. **“Forwarded headers：何时才可信”**：当前“没有 trustProxy、服务不读取 headers”的描述已过时。改为显式 opt-in、socket peer 校验、右向左解析、非法链 400；强调未 opt-in 仍忽略。
3. **“Canonical：Caddy”第 56 行及 nginx 清单第 66 行**：删除“服务不会信任/所有日志为 127.0.0.1 是正常限制”的现状描述。改为“不 opt-in 时仍如此；opt-in 后应用 IP policy 使用解析地址”。
4. **“防火墙”本机验证**：启用同机 `127.0.0.1` 信任后，直接请求 backend 因没有 `X-Forwarded-For` 会得到 400。验收应走外部 HTTPS front；backend 只用 `ss` 验证 loopback 监听。不要把不带代理元数据的 direct curl 继续写成成功条件。
5. **“已知 TLS 前置限制”**：整节已过时。删除“cookie 不带 Secure”的已知缺陷，替换为新模式、错误配置风险和同机/异机信任边界。
6. 明确本实现不消费 `X-Forwarded-Proto`；`trusted TLS proxy` 声明本身就是 TLS 断言，声明的 peer 不得同时把明文入口转给同一 backend。

### `docs/deployment/linux-systemd.md`

1. **§3.3 配置**：变量表加入 `KIRO_TRUSTED_TLS_PROXY_IPS`，说明逗号分隔 IP/CIDR、默认关闭、非法值退出 64、应填后端实际 peer 而非客户端网段；环境模板同步增加示例。
2. **§4 首次密钥与就绪验证**：启用受信 loopback peer 后，当前两条 direct backend curl 不再是有效成功验收。改为经 `https://panel.../panel/` 与 `/readyz` 验证；如保留 backend 诊断，必须明确它会因缺失代理元数据返回 400。
3. **§5 监督合同**：前置代理 readiness 请求也必须携带其正常生成的 `X-Forwarded-For`；503 仍只代表数据面未就绪，400 则是受信代理元数据配置错误。
4. **§6 退出码**：退出 64 的检查项加入 `KIRO_TRUSTED_TLS_PROXY_IPS`。
5. **§8 并行文档假设**：当前引用的 `docs/deployment/tls-front-proxy.md` / `firewall-exposure.md` 与实际文件不一致；TLS/防火墙真源应指向 `docs/security/network-exposure.md`，数据迁移真源为 `docs/operations/data-migration.md`。

## 两个附加核查项

### `proxyLogStore`：报告属实，修复归装配层

证据：

- `ProxyLogStore.storePath` 初始为 `''`，只有 `initialize(userDataPath)` 才设为 `<dir>/proxy-logs.json`（`src/main/proxy/logger.ts:325-343`）。
- 每条 `proxyLogger` 日志都会进入 `proxyLogStore.add()` 并排队写盘（`:194-227,403-450`）；未初始化时最终会 `writeFile('')` 并打印失败。
- 全仓只有桌面 `src/main/index.ts:470` 和 `:2230` 调用 `proxyLogStore.initialize(...)`。
- 服务端 `src/main/server/assembly.ts:345-368` 构造代理前没有初始化，shutdown `:399-419` 也没有 `flushSaveNow()`。

建议由 `assembly.ts` owner 在服务端装配早期调用 `proxyLogStore.initialize(config.dataDir)`，并在 shutdown 中 flush。该修复不在本任务文件所有权内，故未越权修改。

### `.backup.enc` 自动恢复：真实能力缺口，但运维文档已正确披露

证据：

- 共享内核提供 `readSecureBackup()` / `writeSecureBackup()`（`src/main/secureBackup.ts`）。
- 桌面在主数据为空时调用 `readSecureBackup()` 并恢复（`src/main/index.ts:1099-1121`）。
- 服务端装配只导入/调用 `writeSecureBackup()`（`src/main/server/assembly.ts:96,507-532`），启动路径没有 `readSecureBackup()`。
- `docs/operations/backup-restore-upgrade.md` §5 已明确写明“可写，但没有已验证的无头自动恢复编排”，并要求以整目录冷备为正式恢复路径。

所以这不是误报，也不只是缺一句文档：自动恢复代码确实不存在；但当前运维文档已经准确限制了能力。按指令未自行构建恢复系统。

## 明确拒绝的方案

- **无条件给 cookie 加 `Secure`**：拒绝。`cookie.ts:45,61` 仍只按有效 TLS 上下文添加；普通 HTTP 否则会直接失效。
- **无条件读取 forwarded headers**：拒绝。`netGuard.ts:104-111` 先验证 socket peer；未 opt-in 时 header 不参与判定。
- **取 `X-Forwarded-For` 最左值**：拒绝。客户端可预置；实现从右向左剥离受信 hop，真实 hop 测试覆盖该攻击。
- **把 loopback 自动推断成受信代理**：拒绝。同一地址也代表桌面/本机直连，既可伪造又会破坏升级兼容。
- **只在文档里提醒 IP rules 失效**：拒绝。请求边界已实际解析并执行真实客户端 policy。
- **在本任务内补自动备份恢复或修改 `assembly.ts`/runbook/vitest 配置**：拒绝越权；以上均给出具体 owner 接线点与代码证据。
