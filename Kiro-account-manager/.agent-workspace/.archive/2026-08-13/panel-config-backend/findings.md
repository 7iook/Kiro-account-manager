# C1 手机面板反代配置后端交付

## 结论

WP1 + WP2 + WP3 已实现。通用配置入口只允许热更新 `logRequests`；反代端口与 API Key 使用独立确认动作；未知、只读和 never-remote 字段明确拒绝且零副作用。

端口没有采用“改对象后提示重启”的假热更新方案，而是受控重启：新监听成功后才持久化并返回；apply、restart 或 persist 失败会恢复旧配置，运行中的实例会重新监听旧端口。

## 实现摘要

- 新增 `src/main/webPanel/proxyConfigPolicy.ts`
  - 固定共享 DTO `PanelProxyConfigView`、`PanelProxyConfigPatch`、`PanelProxyConfigResult`。
  - GET 只投影 `logRequests`、只读字段及原因、API Key 摘要、反代监听信息。
  - 通用 patch 是封闭 DTO，只接受 `{ changes: { logRequests: boolean } }`。
  - 拒绝数组、非普通对象、继承字段、额外顶层字段、空 patch、未知字段及错误类型。
  - `port`、API Key、`adminKey`、`trustedTlsProxyIPs` 均不能经通用 patch 修改。
- 新增 `src/main/proxy/applyProxyConfigUpdate.ts`
  - 统一 apply → restart（按模式）→ persist 顺序。
  - apply/persist 失败不返回成功；运行态和盘上值均尝试回滚。
  - 结构化错误携带失败阶段和回滚是否成功。
- 扩展 `src/main/ipc/panelProxyDeps.ts`
  - 配置写串行化，并在实际执行时读取最新配置。
  - 生成 API Key 使用 24 字节随机数（`sk-` + 48 hex）。
  - API Key hint 只由随机 id 的 SHA-256 截断值生成，不使用 key 原文。
  - 验证动作要求 `lastUsedAt >= createdAt`，即新 key 必须真实服务过数据面请求。
  - 审计固定写 `PanelConfigAudit`，不读取 `enableAuditLog`。
- 扩展 HTTP 路由及请求上下文
  - 所有新端点继续经过既有 session/auth/CSRF 闸门。
  - 审计 actor 使用 trusted-proxy 解析后的 `clientIP` 与截断、脱敏后的 `userAgent`。
  - 新增稳定错误码 `INVALID_CONFIG`；客户端无需按中文 message 分支。
  - 配置动作使用按 `PanelRouteDeps` 实例隔离的 single-flight；底层写入仍串行合并最新值。
- 装配
  - 服务端写回继续统一经过 `withoutTrustedTlsProxyIPs`。
  - 桌面端所有 `proxyConfig` 写回也先剥离 `trustedTlsProxyIPs`。
  - 桌面 `proxy-update-config` 已改用共享 apply/persist 收口；监听字段走受控重启。
  - GET/POST 不会为了读写配置隐式初始化反代。

## 专用动作的确切 HTTP 契约

所有路径均位于 `/panel/api` 命名空间内。下面列出的路径是客户端 `panelRequest` 使用的 `/api` 后半段。GET 需要有效 session；所有 POST 还需要既有 `X-Panel-Request` CSRF 头。配置响应均带 `Cache-Control: no-store`。

### 通用配置

#### `GET /api/proxy/config`

响应：`PanelProxyConfigView`

```ts
interface PanelProxyConfigView {
  editable: { logRequests: boolean }
  readOnly: Array<{ key: string; value: unknown; reason: string }>
  apiKeys: { configured: boolean; count: number; hints: string[] }
  proxyListen: { host: string; port: number; requiresRestart: boolean }
}
```

完整 API Key 永不进入该响应。

#### `POST /api/proxy/config`

请求：`PanelProxyConfigPatch`

```ts
interface PanelProxyConfigPatch {
  changes: Record<string, unknown> // 运行时严格限定为 { logRequests: boolean }
}
```

响应：`PanelProxyConfigResult`

```ts
interface PanelProxyConfigResult {
  appliedFields: string[]
  requiresRestart: boolean
  config: PanelProxyConfigView
}
```

非法/未知字段：HTTP 400，`{ code: "INVALID_CONFIG", message }`，运行态与盘上值零变化。

### 反代端口

#### `POST /api/proxy/config/port`

请求：`PanelProxyPortChangeRequest`

```ts
interface PanelProxyPortChangeRequest {
  port: number                 // 1..65535 整数
  expectedCurrentPort: number // 防陈旧确认
  confirmation: 'CHANGE_PROXY_PORT'
}
```

响应：`PanelProxyPortChangeResult`

```ts
interface PanelProxyPortChangeResult {
  previousPort: number
  port: number
  restarted: boolean
  requiresRestart: false
  config: PanelProxyConfigView
}
```

运行中的反代必须完成真实 restart 后才返回 200。新端口监听或持久化失败时返回 500，并尝试重新监听旧端口；不会返回新端口假成功。反代未运行时只更新持久态，`restarted=false`。

### API Key 列表

#### `GET /api/proxy/api-keys`

响应：`PanelProxyApiKeyListResult`

```ts
interface PanelProxyApiKeyListItem {
  id: string
  hint: string
  createdAt: number | null
  verifiedAt: number | null
}

interface PanelProxyApiKeyListResult {
  keys: PanelProxyApiKeyListItem[]
}
```

普通 key 的 hint 为 `key:<12 lowercase hex>`，只由 id 计算；旧单 key 使用 `legacy:configured`。响应不含 key、名称、usage 或其它内部字段。

### 新增 API Key

#### `POST /api/proxy/api-keys/create`

请求：`PanelProxyApiKeyCreateRequest`

```ts
interface PanelProxyApiKeyCreateRequest {
  confirmation: 'CREATE_PROXY_API_KEY'
}
```

响应：`PanelProxyApiKeyCreateResult`

```ts
interface PanelProxyApiKeyCreateResult {
  id: string
  key: string       // 只在本次成功响应出现
  hint: string
  createdAt: number
  config: PanelProxyConfigView
}
```

调用方不能提交自定义 key。完整 key 仅创建成功时交付一次，后续 GET、普通 POST、错误、日志和审计均不回显。

### 验证 API Key

#### `POST /api/proxy/api-keys/verify`

请求：`PanelProxyApiKeyVerifyRequest`

```ts
interface PanelProxyApiKeyVerifyRequest {
  id: string
}
```

响应：`PanelProxyApiKeyVerifyResult`

```ts
interface PanelProxyApiKeyVerifyResult {
  id: string
  verified: true
  verifiedAt: number
  config: PanelProxyConfigView
}
```

如果该 key 尚未成功服务过真实数据面请求，返回 HTTP 409 + `INVALID_CONFIG`。

### 吊销 API Key

#### `POST /api/proxy/api-keys/revoke`

请求：`PanelProxyApiKeyRevokeRequest`

```ts
interface PanelProxyApiKeyRevokeRequest {
  id: string            // 普通 id 或 "legacy"
  replacementId: string // 必须是不同且已验证的新 key
  confirmation: 'REVOKE_PROXY_API_KEY'
}
```

响应：`PanelProxyApiKeyRevokeResult`

```ts
interface PanelProxyApiKeyRevokeResult {
  revokedId: string
  replacementId: string
  config: PanelProxyConfigView
}
```

替代 key 未真实验证时返回 HTTP 409 + `INVALID_CONFIG`。旧版单 key 被移除；多 key 条目被置为 disabled。

## 审计契约

固定 category：`PanelConfigAudit`。

每个已进入配置用例的成功、拒绝和失败事件包含：

- `timestamp`
- 固定 `actor: "admin"`
- 可信 `clientIP`
- 脱敏、截断后的 `userAgent`
- `outcome`
- `fields`
- `requiresRestart`
- `apply` / `persist` / `rollback`
- 非 secret 的 before/after

API Key 的 `change` 只允许：

```ts
{
  operation: 'create' | 'verify' | 'revoke'
  configuredBefore: boolean
  configuredAfter: boolean
}
```

事件不含 key、id、hint、名称或 usage；`enableAuditLog=false` 不会关闭此审计。

## 红 → 绿证据

1. 初始 HTTP 测试中 `GET /api/proxy/config` 为 404；接入真实 route deps 后转绿。
2. policy 初始实现缺少只读原因且校验过宽；补齐封闭 DTO、原型/额外字段/未知字段拒绝后，policy 8/8 通过。
3. apply 初始失败抛普通 `Error`；改为阶段化 `ProxyConfigUpdateError` 并补回滚后，apply 7/7 通过。
4. 一次定向回归为 53/55：
   - 嵌套 `config.apiKeys` 被响应兜底整体遮成 `"***"`；
   - 端口结果的旧快照被可变测试实现改写，错误返回 `previousPort=5599`。
   修复为仅递归恢复封闭安全摘要、读取配置时复制顶层快照后，最终定向回归 56/56。
5. 真装配 E2E：真实 panel server 登录 → POST `logRequests=false` → shutdown → 同 dataDir 重建 assembly → GET 仍为 false；运行态也为 false，盘上无 `trustedTlsProxyIPs`。该文件 3/3 通过。
6. 生产装配静态闸门 17/17 通过。
7. `npm run typecheck`：EXIT=0（node + web 均通过）。

## 全量回归现状与停下点

最终全量：1807 total / 1797 passed / 4 failed / 6 pending，另有 3 个 unhandled errors。

四个失败均位于明确禁止本 executor 修改的并行 UI 工作：

- `test/renderer/usage-percent-ssot/percentUsedUnit.test.tsx` 三例：新 `ProxyConfigSection` 在旧测试未提供 config 时读取 `undefined.logRequests`，并产生 3 个 unhandled errors。
- `test/main/architecture/webpanel_build_assets.test.ts` 一例：并行新增的 `src/webPanel/ui/ProxyConfigSection.tsx` 晚于现有构建产物，需要 UI owner 完成修复后运行 `npm run build:webpanel`。

后端定向回归、装配 E2E、生产装配闸门和 typecheck 均绿。按文件所有权要求，没有修改 `src/webPanel/**`、renderer 或构建产物，也没有替 UI executor 修复上述失败。

## 明确驳回/未采用

- 未放开 `logStreamEvents`、`enablePerfDiagLog`、`enableAuditLog`、模型映射、agent 模式或 payload 上限。
- 未允许任何 `WebPanelConfig`、`trustedTlsProxyIPs`、dataDir/加密/部署 env、`allowExternalWithoutAdminKey` 或 `adminKey` 经 C1 修改。
- 未调用仓内不存在的 `applyProxyRuntimeConfig`。
- 未采用 pending/active 的大改；端口使用更薄的受控重启 + 失败回滚。
- 未修改既有 C6 adminKey 轮换。
- 未提交 commit。

工作期间发现 HEAD 已由交付说明中的 `edcb42c` 前移到 `c781f02`（并行工作所致）；未 reset、未回退或提交他人改动。
