# 无头服务器账号管理与自动换号

## 先读：删除与后台调度现在会在服务器上真实生效

- 手机面板的“删除账号”会修改服务器主数据，并同步运行中的反代账号池；它不是只隐藏一张卡片（`src/main/webPanel/routes.ts:497-528`）。
- 删除后的撤销只是当前服务进程内的 10 分钟内存安全网，不是回收站。当前页面刷新后不再提供入口，服务重启或超时后 tombstone 也会消失（`src/main/webPanel/routes.ts:384-424`；`src/webPanel/ui/AccountCard.tsx:216-228`）。
- 自动换号 timer 已在共享 main 侧运行。无头服务启动后，即使桌面电脑和 renderer 关闭，服务器仍会按已持久化的开关、阈值和间隔继续检查并推进服务器反代（`src/main/accountService/autoSwitch.ts:1-6,278-338`；`src/main/server/assembly.ts:395-420`）。

## 在手机面板编辑账号

在账号卡片展开“更多操作”后选择“编辑账号”。当前只允许修改：

- 备注 `nickname`；
- 分组 `groupId`。

登录凭据不会发送到编辑表单，也不接受凭据字段。服务端拒绝白名单外字段，并用操作前取得的 `expectedRevision` 防止手机覆盖桌面端的并发修改（`src/main/webPanel/routes.ts:427-494`；浏览器请求契约 `src/webPanel/api/panel.ts:90-105`）。

如果出现 `STALE_REVISION`，重新加载账号后再编辑；不要重复提交旧页面中的值。分组下拉只返回 `id/name/color/order`，不是完整 `accountData`（`src/main/webPanel/routes.ts:859-869`）。

## 删除与撤销账号

删除流程刻意有两道确认：

1. 展开“更多操作”并选择“删除账号”；
2. 完整输入账号邮箱；无邮箱时输入账号 id，确认按钮才会启用（`src/webPanel/ui/AccountCard.tsx:94-96,549-607`）。

最终确认时页面会重新读取最新 revision，避免确认框停留期间覆盖其他端的修改（`src/webPanel/ui/AccountCard.tsx:166-180`）。删除成功后：

- 账号从主数据移除；
- 如果它是当前账号，`activeAccountId` 被清空；
- 该账号的代理绑定被删除；
- 已初始化的运行中反代池会重建；若同步失败，页面明确提示“重新同步账号池”（`src/main/webPanel/routes.ts:360-380,497-528`；`src/webPanel/ui/AccountCard.tsx:216-228`）。

页面显示“撤销删除”时可在 `undoUntil` 前恢复。恢复账号不会静默重新设为当前激活账号；它以 `isActive: false` 回来（`src/main/webPanel/routes.ts:531-585`）。以下情况不要承诺可恢复：

- 当前页面已刷新，撤销入口丢失；
- 服务进程已重启，内存 tombstone 丢失；
- 10 分钟窗口已过；
- 同 id 账号已被重新创建。

需要永久可恢复能力时，依赖 [`backup-restore-upgrade.md`](backup-restore-upgrade.md) 的整目录冷备；不要把短期撤销当备份。

## 无头自动换号如何运行

调度器每轮读取最新持久化账号数据，不长期缓存启动时快照。`autoSwitchEnabled !== true` 时不动作；启用后启动立即检查一次，之后使用 `autoSwitchInterval` 分钟，缺失或非法正数时为 5 分钟（`src/main/accountService/autoSwitch.ts:54-78,225-275,278-338`）。

每轮顺序是：

1. 读取当前账号和阈值快照；
2. 刷新当前账号额度；刷新失败会记录告警，并按盘上最后值继续判断；
3. 当前剩余额度 `<= autoSwitchThreshold` 时，按账号插入顺序选第一个不低于阈值且未命中既有封禁判据的候选；
4. 用 `activeAccountId` 做 CAS，先原子持久化新 active、逐账号 `isActive` 和决定信封；
5. CAS 成功后才推进服务器反代副作用（`src/main/accountService/autoSwitch.ts:156-268,343-383`）。

账号或设置写入会唤醒调度器，不必等满一个周期；并发 tick 共享同一个 in-flight，不会同时形成两次决定（`src/main/server/assembly.ts:351-359,395-408`；`src/main/accountService/autoSwitch.ts:278-338`）。

### 服务器与桌面副作用的边界

无头服务器只推进服务器上的反代偏好/指针，不会替一台已关闭的桌面机执行 IDE、CLI 或机器码副作用；这些仍由桌面 renderer 消费同一决定信封时执行（`src/main/accountService/autoSwitch.ts:65-76`；服务器注入点 `src/main/server/assembly.ts:395-406`）。

反代运行时，服务器使用统一激活编排完成“账号入池/更新凭据 → 单账号选择配置 → 指针与会话粘性失效”；反代未运行时，只有单账号模式会持久化目标偏好，多账号模式保持轮询配置不变（`src/main/server/assembly.ts:588-643`）。

### 重启重放

决定与服务器副作用确认分开持久化。若进程死在“决定已提交、反代尚未应用”之间，下次装配会在启动新一轮调度前重放仍有效的决定（`src/main/server/assembly.ts:307-308,410-420`）。

只有同时满足以下条件才重放：

- 信封目标仍等于当前 `activeAccountId`；
- 目标账号仍存在；
- `autoSwitchAppliedDecisionId` 尚未确认同一个决定 id。

用户后来手动换号、目标已删除或该决定已成功应用时不会重放（`src/main/accountService/autoSwitch.ts:118-153`）。正常停机先清 timer 并等待在途决定结束，再 drain 持久化队列，避免晚到写入追在停机排空之后（`src/main/server/assembly.ts:447-462`）。

unverified: 当前 Windows 主机没有执行真实 systemd 长时间运行、主机重启或在“决定提交后/反代应用前”强制杀进程的 Linux 故障注入。代码与自动化测试锁定了重放判据和停机顺序，但生产验收仍应在隔离 Linux 主机记录决定 id、重启前后 active 账号和反代实际选中账号。

## 管理密钥不是账号凭据

面板 adminKey 轮换与账号编辑/删除是不同授权域。计划轮换请按 [`key-handling.md`](key-handling.md) 操作；不要删除账号数据来恢复 adminKey，也不要把账号 token 当作面板管理密钥。
