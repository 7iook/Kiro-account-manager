# Readiness 与管理员密钥轮换修复报告

## 结论

两个 review finding 均成立。

1. 面板端口此前同时被当作 liveness 与 readiness；反代自启动失败后，面板仍监听且
   `bootstrap()` 正常返回，没有机器可读信号区分“可运维”与“可服务”。
2. `PanelAuth.rotateAdminKey()` 只有 Electron IPC 生产调用点，无头 Web 面板没有 HTTP
   调用点；首启日志要求“登录后立刻轮换”的补救因此无法通过无头服务执行。

本次没有把反代启动失败改成进程退出。那会同时杀掉唯一管理面，违背“故障后仍可从手机
排查和重试”的既定设计。

## Finding 1：readiness 设计

- liveness 仍由进程监督器 / 面板 TCP 监听承担；它只回答“进程和管理面是否活着”。
- 新增匿名 `GET /panel/readyz`：
  - 反代真实 `ProxyServer.isRunning()` 为 `true` 时返回 `200 {"status":"ready"}`；
  - 未初始化、未自启、启动失败或已停止时返回 `503 {"status":"not_ready"}`。
- 判据读取真实反代句柄，不读取 `enabled` / `autoStart` 期望配置；从面板手动启动成功后，
  同一 probe 会立即变为 ready，无需重启面板。
- endpoint 不要求登录。前置 Caddy/nginx/容器探针不应持有面板会话和 CSRF 凭据；匿名响应
  只泄露一个“当前是否接流”的布尔值，不返回端口、账号数、失败原因或统计。IP allow/deny
  门禁仍在它之前。详细运行态继续只从已鉴权的 `/panel/api/proxy/status` 获取。
- 没有复用代理数据端口现有 `/health`：该端点返回账号数、可用账号数、请求/Token/uptime
  等业务指标，匿名暴露面过大，而且代理根本没监听时无法借管理面表达明确的 503。
- 反代自动启动 catch 现在输出带分隔线的 `🔴 DEGRADED` 块，并明确“仅管理面板可用、
  readiness=503、不得导入业务流量”；`main()` 也不再无条件打印“就绪”。

### 运维应如何配置

- systemd：进程存活仍是 liveness；不要因为 readiness=503 杀进程，否则会失去管理面。
- 前置反代 / 流量入口：轮询
  `http://127.0.0.1:<KIRO_PANEL_PORT>/panel/readyz`，仅 200 时导入业务流量。
- 容器 `HEALTHCHECK` 若用于服务发现/摘流，同样轮询上述 URL，例如
  `curl -fsS http://127.0.0.1:${KIRO_PANEL_PORT}/panel/readyz`。若编排器会自动重启
  unhealthy 容器，应把“重启判据”仍设为进程/TCP liveness，不能拿 readiness 代替，
  否则反代端口冲突会形成重启循环并让面板不可用。

## Finding 2：轮换语义

- 新增 `POST /panel/api/admin-key/rotate`，位置在既有统一 guard 之后；必须同时具备有效
  session cookie 和 `X-Panel-Request: 1`，未登录或缺 CSRF 均为 401。没有新增任何匿名
  reset/recovery 路径。
- handler 只调用 `PanelAuth.rotateAdminKey()`，没有绕过鉴权域直接写 store。
- 成功顺序：
  1. 生成新密钥；
  2. `AdminKeyStore.set()` 持久化；
  3. 持久化成功后失效全部既存会话；
  4. 清除发起浏览器的旧 session cookie；
  5. 以 `Cache-Control: no-store` 的响应体 `{"key":"..."}` 交付新密钥一次。
- 响应字段刻意不用 `adminKey`：统一 `sendJson` 会把该敏感键名遮盖，导致合法的一次性交付
  只剩掩码。`key` 是这个已认证、no-store、TLS 后置条件下的窄豁免。生产代码不打印该值，
  因而不会像首启 stdout 那样进入 journal/docker logs。常规 access log 只记录 URL/状态；
  若外层代理被配置为记录响应体，仍必须关闭该危险配置。
- 轮换后旧密钥不能登录，所有旧 session（包括调用者）立即失效；调用者必须保存响应里的
  新密钥并重新登录。
- 写入失败时 `rotateAdminKey()` 在 session invalidation 之前抛错，HTTP 返回脱敏的 500，
  旧密钥和旧 session 保持有效。服务端文件 store 自身已有“临时文件 → 0600 校验 →
  rename → 回读复校 → 失败回滚”事务，权限不得宽于 0600 的既有约束未被绕过。
- `KIRO_ADMIN_KEY` 环境变量托管的密钥按既有 store 契约拒绝运行时轮换；正确操作仍是更新
  secret/环境变量并重启，避免制造 env 与文件冲突。

## TDD 证据

### Red

- readiness：
  `npx vitest run test/main/webPanel/readiness.server.test.ts --reporter=default --reporter=json --outputFile.json=.tmp-readiness-red.json`
  → EXIT=1，JSON `numFailedTests=1`, `numPassedTests=0`。真实原因是 `/readyz` 仍落入静态层，
  返回 `text/plain`，而测试要求 JSON readiness 契约。
- rotation：
  `npx vitest run test/main/webPanel/adminKeyRotation.server.test.ts --reporter=default --reporter=json --outputFile.json=.tmp-rotation-red.json`
  → EXIT=1，JSON `numFailedTests=2`, `numPassedTests=1`。已登录的成功与写失败场景都得到
  404（endpoint 不存在），分别期望 200 / 500；未登录和缺 CSRF 已被既有统一 guard 拒绝。

### Green 与回归

- 两个新文件合跑：EXIT=0，JSON `numPassedTests=4`, `numFailedTests=0`。
- 鉴权、AdminKeyStore、自启动及新用例：EXIT=0，JSON
  `numPassedTests=100`, `numFailedTests=0`。
- WebPanel 服务与架构闸门：EXIT=0，JSON `numPassedTests=37`, `numFailedTests=0`。
- `npm run typecheck:node`：EXIT=0。

## 未越权修改与后续

- 未修改 `routes.ts` / `auth.ts`：现有统一 HTTP guard 和 `PanelAuth.rotateAdminKey()` 的
  “先持久化、后失效 session”语义已经正确，重复搬到 route deps 会制造第二个鉴权真源。
- 未修改 `src/main/proxy/**`、`assembly.ts`、`persistence.ts`、`ipc/**` 或任何禁止修改的
  既有测试。
- `vitest.config.ts` 当前已有 `REAL_IO_TESTS` 列表，而两个新测试会绑定真实端口，但列表
  尚未包含：
  - `test/main/webPanel/readiness.server.test.ts`
  - `test/main/webPanel/adminKeyRotation.server.test.ts`
  
  该配置由另一 agent 持有，需其把这两个文件加入 real-resource project，避免全套测试中
  与普通并行 worker 抢端口。
- 语义消费者扫描只找到 Electron 设置页的轮换按钮，没有找到无头浏览器 UI 对新 endpoint
  的调用者。HTTP remediation 已可执行，但首启文案所承诺的“在面板内点一次轮换”要真正
  成为手机端一键操作，还需 Web 面板前端增加确认、调用、一次性展示/复制、清内存并跳回
  登录页的 UI；这些文件不在本任务 ownership 内，不能在此越权修改。

## 驳回的方案

- **反代失败就退出非零**：驳回。会把唯一管理面一起杀掉，端口冲突时只剩 SSH。
- **直接把面板端口当 readiness**：驳回。它只能证明管理面存活，正是本 finding 的根因。
- **复用代理 `/health`**：驳回。它泄露业务指标，且代理未监听时没有管理面上的 503 信号。
- **readiness 要求 panel session**：驳回。前置反代无法稳定维护 session + CSRF，且布尔
  ready/not-ready 没有值得用管理员凭据保护的业务信息。
- **匿名 reset/recovery**：驳回。它允许未认证调用者重置认证本身，是自指授权漏洞。
- **新增第二套密钥写盘/权限逻辑**：驳回。现有 `AdminKeyStore.set()` 已事务化并执行权限
  闸门；HTTP 层重复实现会产生漂移和半写状态。

## 检索闸门说明

已先用三种语义索引扫描 production/test/untracked 消费点，并形成
`WebPanelServerOptions`、所有 `new WebPanelServer`、`readyz`、`rotateAdminKey` 的消费清单。
随后尝试执行动作闸门要求的 `git grep`，但本机搜索闸门错误地仍判定“未做语义检索”并拒绝
命令；没有用关闭闸门的逃生环境变量绕过。语义索引已确认本次可选构造参数不破坏现有调用点，
类型检查与 100+37 条回归提供了传播证据。
