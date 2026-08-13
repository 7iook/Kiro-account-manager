# 手机面板解封与专用动作交付

## 结论

本轮已打通三条手机操作链：

1. `POST /api/accounts/:id/unsuspend` 会清除持久态中由共享封禁分类器确认的封禁标记，并调用既有 `AccountPool.clearSuspended()` 清运行期闩锁；响应固定携带 `upstreamVerified: false`，不会把本地放行冒充为上游恢复。
2. 反代端口操作接入既有专用端点，按服务端返回投影显示实际端口；运行中会明确提示真实重启，未运行时明确提示只保存、下次启动生效。
3. API Key 按“新增 → 用新 Key 发真实请求 → 验证 → 吊销旧 Key”流转；完整 Key 只留在 create 后的一次性交付弹窗，列表始终只消费服务端 hint。

手机新区块均置于 `PanelSectionBoundary` 下，并各自处理加载、失败与缺失状态；配置未加载或 API Key GET 失败不会带崩反代面板。

## 解封交互与语义

- 入口只在共享 `isAccountSuspensionError()` 判定为封禁时显示，未另造关键词集合。
- 点击“强制解除封禁”后弹出高级操作确认框，要求输入目标账号的邮箱（无邮箱则账号 ID）。
- 弹窗固定展示：
  - “此操作只会清除本机封禁标记，不会向上游验证账号是否恢复。”
  - “结果仍是未验证状态，账号可能立刻再次被封。”
- 客户端随后按 DTO 发送固定确认值 `FORCE_UNSUSPEND`；服务端拒绝缺失、错误或带额外字段的确认体。
- 成功后 UI 使用响应中的账号投影与运行态重渲染，并继续显示“上游状态未验证，可能立刻再次被封”。
- 持久态只清理由 `src/shared/accountSuspension.ts` 确认的封禁错误。直接调用端点处理普通网络错误时返回 `cleared: false`，不会顺手删除普通 `lastError` 或把 `status` 改成 active。
- 已初始化反代会重建账号池；同步失败时响应带 `proxyPoolSyncPending: true`，UI 要求用户手动重新同步，不谎报“已回池”。

## 端口变更与回滚呈现

- 确认框要求输入“更改端口”，并明示真实重启会短暂中断现有连接。
- 请求严格按既有 DTO 发送：
  - `port`
  - `expectedCurrentPort`
  - `confirmation: "CHANGE_PROXY_PORT"`
- 只接受服务端返回的 `config.proxyListen.port` 作为下一帧状态，不做乐观写入。
- `restarted: true` 时提示“反代已重启并监听新端口 …”。
- `restarted: false` 时不误判失败，提示“反代当前未运行；端口已保存为 …，下次启动将监听该端口”。
- 重启或持久化失败时：
  1. 直接展示服务端经脱敏出口返回的回滚结论，例如“配置运行态应用失败，已恢复原配置。”
  2. 关闭确认框。
  3. 重新 GET 配置并刷新代理运行状态。
  4. 输入框和“当前监听”回到服务端实际端口；不会显示新端口已生效。

## API Key 生命周期

- `GET /api/proxy/api-keys` 只渲染服务端返回的 `id`、不可逆 `hint` 与验证状态。
- “新增”需要输入固定确认词；完整新 Key 只进入 create 后的临时弹窗状态，不并入列表、配置投影或日志。关闭弹窗后页面不再显示完整值。
- “验证新 Key”只提交服务端 ID；界面先要求用户用新 Key 发起真实数据面请求，后端再按已有 `lastUsedAt >= createdAt` 规则验证。
- 只有存在另一个已验证 Key 时才出现旧 Key 的“吊销”入口；吊销请求携带旧 ID、替代 ID 与固定确认值。
- create、verify、revoke 成功后都采用响应中的服务端配置投影并重读 hint 列表。

## 红 → 绿证据

初始红态：

- 新解封路由的认证请求返回 404，证明面板尚未到达 `clearSuspended`。
- UI 用例找不到“强制解除封禁”、端口操作区与 API Key 生命周期操作区。

实现后的定向结果：

- 解封后端路由：34/34 通过。
- 两个手机 UI 文件：19/19 通过。
- 追加边界测试先得到 2 failed / 46 passed：
  - `restarted: false` 被错误当作端口变更失败。
  - 对非封禁账号直接调用 unsuspend 会误删普通错误。
- 修正后同组为 48/48，JSON `numFailedTests: 0`。

最终验证：

- `npm run typecheck:node`：EXIT 0。
- `npm run typecheck:web`：EXIT 0。
- 本轮 14 个变更代码/测试文件的 ESLint：EXIT 0。
- `npm run build:webpanel`：EXIT 0，重新生成手机实际收到的静态产物。
- 全量 Vitest：1821 total / 1815 passed / 0 failed / 6 skipped；170 个测试文件通过、1 个跳过。

全量第一次只红了构建新鲜度门禁（面板产物时间早于源码），不是功能测试失败；执行 `npm run build:webpanel` 后全量转绿。

## 驳回或停下来的点

- 没有引入临时/永久封禁状态机、TTL 或自动恢复探测；这些方向按裁决保持不做。
- 没有修改 `src/main/proxy/**`、`src/main/server/**`、`src/main/index.ts`、`src/renderer/**`、`vitest.config.ts` 或 `package.json`。
- 为把生产 `panelRouteImpl` 中的新方法送进 Electron 面板路由，最小扩展了 `src/main/ipc/webPanelWiring.ts` 的既有适配器；否则在禁止修改 `src/main/index.ts` 的前提下桌面壳会丢掉该依赖。
- 未执行会改动真实部署端口和真实 API Key 的非测试 E2E。当前环境没有提供可操作部署的 adminKey、可牺牲账号/旧 Key 及允许中断的端口窗口；贸然轮换会打断现有客户端。真 HTTP + 真 `AccountPool` 的集成测试已跑通，但不把它冒充为部署 E2E。上线前仍应在隔离部署按“登录 → 解封并确认回池 → 改端口并从新监听访问 → create → 用新 Key 发数据面请求 → verify → revoke 旧 Key”跑一次。
- 未提交任何改动；仓内与本任务无关的既有未跟踪文件保持原样。最终检查时另有并发修改的已跟踪文件 `.agent-workspace/TASKS-2026-08-13.md`，本轮未读取、未编辑、未回退。
