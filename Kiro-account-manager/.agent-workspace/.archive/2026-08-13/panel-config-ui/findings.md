# #35 / C1 · 手机面板反代配置 UI 实施记录

日期：2026-08-13  
工作树：`F:\Kiro-account-manager\Kiro-account-manager`  
约束：未修改 `src/main/**`，未提交、未 stash、未回退共享工作树改动。

开工时用户给出的基线为 `edcb42c`；终验时共享工作树 HEAD 已由其它并行工作推进到 `c781f02`。本轮没有执行任何 commit 或改变 HEAD 的操作。

## 1. 交付结果

本轮完成了通用低风险配置链：

- `src/webPanel/api/panel.ts`
  - `GET /proxy/config` → `fetchProxyConfig()`
  - `POST /proxy/config` → `updateProxyConfig()`
  - 直接复用 `PanelProxyConfigView` / `PanelProxyConfigPatch` / `PanelProxyConfigResult`，没有另造浏览器 DTO。
- `src/webPanel/ui/ProxyConfigSection.tsx`
  - 唯一可编辑项是 `logRequests`。
  - 保存只发送 `{ changes: { logRequests: boolean } }`。
  - POST 成功后以响应中的 `result.config` 同时覆盖服务端投影和草稿，绝不按用户点击值乐观报成功。
  - `requiresRestart=true` 时提示“需重启反代服务后才生效”，不显示“已生效”。
  - 保存失败时保留服务端旧投影和用户未保存草稿，两者分别显示。
- `src/webPanel/ui/ProxyPanel.tsx`
  - 在现有反代状态/操作区中接入独立的“反代配置”区域。
- `src/webPanel/api/client.ts`
  - 为 `INVALID_CONFIG` 增加中文映射“配置内容无效，请检查后重试”，避免退化成通用内部错误。

没有修改 `startProxy()` 的签名或调用；配置写入只走 `/proxy/config`。

## 2. 只读项如何呈现

服务端 `readOnly` 数组中的每一项都渲染为：

1. 中文字段名（未知 key 回退显示服务端 key，不会静默丢掉）；
2. 服务端投影值；
3. “只读”标记；
4. 服务端逐项返回的 `reason`。

覆盖的冻结矩阵包括：

- 流式事件日志；
- 性能诊断日志；
- 反代审计日志；
- 模型映射；
- Agent 模式；
- 请求载荷上限。

此外，配置区单独明示面板监听、IP 规则、转发信任和部署字段属于控制面/部署信任边界，永久不能从手机面板修改，只能在本机或部署配置中调整；这些边界没有被静默隐藏，也没有暴露其内部值。

防泄漏边界：

- `apiKeys.hints` 原样逐条渲染，不在前端截取、拼接、推断或记录日志。
- API Key 区只显示 `configured`、`count` 和 hints。
- 另加防御性兜底：若服务端未来误把名称含 `apiKey` / `token` / `secret` / `password` 的项塞入 `readOnly`，页面显示“敏感值不在面板显示”，不渲染原值。

## 3. 专用动作预留

配置区保留了独立的“高影响操作”占位块，文案明确点名端口与 API Key，并说明它们必须走专用动作和二次确认，通用保存不会修改。当前没有可点击提交入口、没有 API 方法、没有猜测请求体，也没有复用 adminKey DTO。待专用动作契约由父级正式下发后，可在该位置复用“输入固定确认词”的交互模式接入。

## 4. RED → GREEN 证据

组件测试始终经过真实 `fetch` / `panelRequest` 边界，没有 mock API 模块。

关键红灯与修复：

1. 初始 UI 红灯：找不到“反代配置”区域和“保存请求日志设置”按钮；实现配置区与保存动作后转绿。
2. 重启语义红灯：服务端返回 `requiresRestart=true` 时曾错误提示“已生效”；改为优先显示“需重启才生效”后转绿。
3. 敏感值红灯：误入只读投影的 API Key 原值缺少稳定兜底；增加按敏感 key 名遮罩后转绿。
4. 字段矩阵红灯：`payloadSizeLimitKB` 曾显示原始 key；补齐“请求载荷上限”标签后转绿。
5. `INVALID_CONFIG` 专用文案：
   - RED JSON：`numPassedTests=4`、`numFailedTests=1`；期望“配置内容无效，请检查后重试”，实际为“操作失败，请稍后重试”。
   - GREEN JSON：`numPassedTests=5`、`numFailedTests=0`。
6. 永久边界说明：
   - RED JSON：`numPassedTests=4`、`numFailedTests=1`；页面缺少面板监听 / IP 规则 / 转发信任 / 部署字段的永久边界说明。
   - GREEN JSON：`numPassedTests=5`、`numFailedTests=0`；页面明确说明边界、原因和只能本机/部署侧调整。

服务端投影测试特意让用户请求关闭日志、POST 却返回 `config.editable.logRequests=true`。最终复选框仍显示开启，并提示“服务端未应用所选值，已显示实际配置”，证明页面消费服务端结果而非乐观值。

## 5. 最终测试

按指定 default + JSON 双 reporter 运行全部 `test/renderer/web-panel-ui/*.test.tsx`：

- Test suites：20 passed / 0 failed；
- `numPassedTests=53`；
- `numFailedTests=0`；
- `numPendingTests=0`。

覆盖文件：

- `test/renderer/web-panel-ui/panelProxyConfig.test.tsx`
- `test/renderer/web-panel-ui/panelProxyPanel.test.tsx`
- `test/renderer/web-panel-ui/panelAccountManagement.test.tsx`
- `test/renderer/web-panel-ui/panelApp.test.tsx`

后端并行实现落地后，额外把真实路由、policy、配置用例和装配测试放在同一轮验证：

- Test suites：16 passed / 0 failed；
- `numPassedTests=53`；
- `numFailedTests=0`；
- 覆盖 `proxyRoutes.test.ts`、`proxyConfigPolicy.test.ts`、`panelProxyConfigDeps.test.ts`、`applyProxyConfigUpdate.test.ts`。

其余验证：

- `npm run typecheck:web`：EXIT 0；
- `npm run typecheck:node`：EXIT 0；
- 本轮负责文件 ESLint：EXIT 0；
- 本轮负责文件 Prettier check：通过；
- `git diff --check`（负责范围）：EXIT 0。

并行后端落地中途，`typecheck:node` 曾因 `src/main/server/assembly.ts` 尚未适配扩展后的 `PanelRouteDeps` 而失败；本轮没有越权修改该文件。后端 executor 补齐装配后复跑已转为 EXIT 0。父级集成时仍应把后端的 `test/main/webPanel/proxyRoutes.test.ts`、配置 policy 与装配测试和本报告的四个 UI 测试放在同一最终回归中。

所有本轮 Vitest 临时 JSON/log 均已删除。

## 6. 契约缺口（仅报告，未擅自改约）

1. `PanelProxyConfigResult.requiresRestart` 与 `result.config.proxyListen.requiresRestart` 含义重复，但契约没有规定二者不一致时的优先级。当前 UI 用前者决定即时通知、后者决定持久展示，且不篡改服务端投影。
2. `readOnly[].key` 是开放的 `string`，浏览器只能维护友好标签表并为未知 key 回退；若需强制字段矩阵不漂移，可考虑服务端导出封闭 key 联合。
3. 通用 patch 没有 revision / expected-current 语义；两个面板并发修改时目前只能由服务端决定覆盖策略。`logRequests` 风险较低，因此本轮不自行扩契约。
4. 专用端口/API Key 动作的正式浏览器契约未在本任务开工时下发；共享工作树中后来虽已出现并行后端实现，本轮仍按约束没有据此猜实现，等待父级明确交接。

## 7. 本轮文件

- `src/webPanel/api/client.ts`
- `src/webPanel/api/panel.ts`
- `src/webPanel/ui/ProxyPanel.tsx`
- `src/webPanel/ui/ProxyConfigSection.tsx`（新增）
- `test/renderer/web-panel-ui/panelProxyConfig.test.tsx`（新增）
- `test/renderer/web-panel-ui/panelProxyPanel.test.tsx`
- `test/renderer/web-panel-ui/panelAccountManagement.test.tsx`
- `test/renderer/web-panel-ui/panelApp.test.tsx`
- `.agent-workspace/.archive/2026-08-13/panel-config-ui/findings.md`（本文件）
