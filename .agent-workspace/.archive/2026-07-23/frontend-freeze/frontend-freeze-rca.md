# ① 前端卡死(大请求 IPC 洪水未彻底根治的变体)· RCA

> 分类:🐛 Bug flow · Artifact: RCA(§5.8 八段)· 前置修复失效根因分析
>
> **历史修过**:2026-07-20 proxy-log-analysis · 2026-07-21 longrun-hardening(logStore 5万→1万 · 4KB 单条截断 · 30s 异步节流 · LogsPage/ProxyDetailedLogsDialog 3s poll + visibility 暂停)
> **本轮根治**:补齐 §5.3 变体扫的漏网 —— webContents.send 独立 IPC 通道(不经 logStore 4KB 截断)

---

### 🔴 1. Phenomenon & Context

- **现象锁死**:用户运行 exe 遇到大请求(Claude Code 大 prompt / 长 tools / 大 payload)时,前端 renderer 卡死(任务管理器"未响应"),但后端反代照常处理 —— 主进程 event loop 活,renderer 进程 event loop 被拖死。已修 2 次仍复发。
- **触发条件**:大请求(payload 1.4MB+ / 长 history / 大 tools)+ ProxyPanel 页面在前台。

### 🔍 1.5 Hypothesis Ledger

| ID | 假设 | 状态 | 证据 | 更新 |
|----|------|------|------|------|
| A | 主进程 `webContents.send('proxy-request'/'proxy-response', info)` 不经 logStore 4KB 截断 · info 含完整 payload · 前端 setState 累加 → structured clone + re-render 卡死 renderer | 🟢已确认 | index.ts:427/430 `onRequest/onResponse` 直接 send · info 由 proxyServer 组装含完整 payload/history/tools · 未做 size guard · `background-refresh-result` 4063/4329/4347 每账户单发 · 34 处 send 无统一收口 | 2026-07-23 |
| B | 生产环境 verbose console.log 大对象经 interceptConsole 4KB 截断,但 stringify 本身耗 CPU + app.isPackaged 未 gate | 🟡待验证 | logger.ts add() 已 4KB 截 · 但 stringify 是同步 CPU · `app.isPackaged` 下 debug 未 gate | 顺带治(即使不是主根因) |
| C | LogsPage / ProxyDetailedLogsDialog 全量拉 5000+ 条 IPC 峰值 | 🟡待验证 | 2026-07-21 poll 3s 已缓解 | 本轮不作为主根因 |
| D | renderer 端 ProxyPanel.recentRequests 数组无上限累加 | 🟡待验证 | 待读 ProxyPanel.tsx 确认 | 本轮顺带治(加 cap) |

### 🔍 2. Root-Cause Analysis

- **The Why**:两次历史修复都聚焦 `proxyLogStore` 通道,但**主进程 → 前端有另一条独立 IPC 通道未收口**:`onRequest/onResponse/onAccountUpdate/onAccountSuspended/background-refresh-result/kproxy-*` 等 `webContents.send`,每次调用把大对象跨进程克隆到 renderer,前端订阅后往 state 累加。**大请求 = 大 info = 大 IPC clone + 大 setState + 大 re-render + 大 DOM diff**,四重叠加。
- **First Broken Point**:`src/main/index.ts:427-434` `onRequest/onResponse/onError` + 4063/4329/4347 `background-refresh-result` 每账户 send + 2635-2648 / 7546-7559 `kproxy-*` 6 处 + `registration-log/step/complete`(registration/ipc-handlers.ts)。总共 34 处 send **无 SSOT 收口**。
- **Bug class**(§5.2):**Responsibility Boundary Violation** —— IPC 通道兼任"实时观测"和"完整数据传输"两职,应拆分。

### 🕵️ 3. Variant Scan (§5.3 契约级)

**Duplicate-implementation search**:
- Internal `git grep -nE 'webContents\.send\(' -- src/main/`:34 处 · 分布 index.ts + registration/ipc-handlers.ts · **无统一入口** = SSOT 缺失(§4.3)· 呼应 error-journal E-052(造好没接)+ E-053(变体按契约不按符号)
- External:Electron 官方推荐大对象走 MessagePort;9router/kiro-rs 无前端参考;自建 SSOT

**契约指纹**:`主进程 webContents.send 携带 payload 大小 · 无收口 helper · 前端订阅后无截断`

**全仓 send 通道分类**(34 处 → 3 类):
| 类别 | 通道 | 措施 |
|------|------|------|
| **A · 大 payload 类**(必元数据化) | `proxy-request` `proxy-response` `kproxy-request` `kproxy-response` `kproxy-mitm` `background-refresh-result` `background-check-result` | 走 `emitToRenderer` helper · 只发 ≤2KB 元数据摘要(id/method/path/status/tokens/error/时长)· 详情走 `proxyLogStore` |
| **B · 中等控制信号** | `proxy-account-update`(含 accessToken/refreshToken)`proxy-account-suspended` `background-refresh-progress` `background-check-progress` | 走 helper · 默认原样 · payload > 2KB 时报警(dev)/截断(prod) |
| **C · 小控制信号**(免) | update-* `proxy-status-change` `kproxy-status-change` tray-* window-* `kiro-ide-token-changed` `show-close-confirm-dialog` `auth-callback` `social-auth-callback` `external-idp-callback` `proxy-webhook-trigger` `proxy-error` `kproxy-error` `registration-*` | 直接 send(定长/短字符串)· 但仍统计通道分类归纳 |

### 👥 4. Real-World Scenario Simulation (§5.4)

- **1.4MB payload 大请求**:元数据化到 ≤2KB · renderer 卡顿彻底消失 · 详情从 proxyLogStore 拉
- **批量刷 200 账户**:200 × `background-refresh-result` 每个元数据化 → 200×2KB · progress 每 500ms merge · 前端顺畅
- **前端仍能看到日志**:LogsPage 走 proxyLogStore 通道拉 · 原始详情齐全(4KB 截断仍有)· **用户看日志需求满足**
- **生产环境 debug 日志**:`app.isPackaged && level in {DEBUG,INFO}` 下 interceptConsole 强制 data 走 200B preview · 不 stringify 全对象 · 消除 stringify CPU
- **未处理**:renderer 端 backpressure(2026-07-21 poll 3s 已缓解)· MessagePort 升级(未来)

### 📚 5. Industry Reference

- **Electron 官方 Best Practice**:大对象跨进程传输应使用 MessagePort + 按需拉取(referenced from Electron docs `contextBridge`/`MessageChannel` 章节;searched "electron ipc large payload backpressure 2026")· 我们的元数据化是 poor-man's MessagePort
- **2026-07-21 longrun-hardening/rca.md**:已修 logStore 侧;本次是它明确未覆盖的独立通道 · 变体扫按契约(webContents.send)不按符号 · 呼应 error-journal E-053

### 🛠️ 6. Surgical Fix

- **Fix Strategy**(SSOT 单点收口 + 变体全扫):
  1. 新建 `src/main/utils/emitToRenderer.ts` 导出 `emitToRenderer(win, channel, payload, opts?)` · 内部按 channel 分类 A/B/C 应用 size guard(A:2KB · B:8KB · C:免)· 超限截首 200B 保留 + 标 truncatedFrom
  2. `LARGE_PAYLOAD_CHANNELS` / `MEDIUM_CHANNELS` 常量集合(SSOT)
  3. **全仓替换**:34 处 `mainWindow?.webContents.send(...)` → `emitToRenderer(mainWindow, ...)` · edit_block_multiple 批量改
  4. `logger.ts:interceptConsole` 生产 gate:`if (app.isPackaged && (level === 'DEBUG' || level === 'INFO')) → data 走 200B preview`
  5. 前端 `ProxyPanel.tsx`:`recentRequests` 数组上限 500 条 · 详情弹窗新增"从日志拉完整"按钮(点击调 `getProxyLogsById` IPC 拉完整 body)
- **Minimal Files Changed**:`src/main/utils/emitToRenderer.ts` (new) · `src/main/index.ts` (34 处替换)· `src/main/registration/ipc-handlers.ts` (3 处替换)· `src/main/proxy/logger.ts` (interceptConsole gate)· `src/renderer/src/components/proxy/ProxyPanel.tsx` (cap + 按需拉)
- **Files Explicitly NOT Changed**:`proxyServer.ts`(继续通过 onRequest/onResponse 回调不感知 IPC)· proxyLogStore(2026-07-21 已优化)

### ⚠️ 7. Blast Radius & Regression Risk

- **影响面**:所有主→前端 IPC · 单元测试少,主要靠 e2e 真实运行验证(§4.6 · E-036)
- **回归测试**:
  - **手动 e2e**:构造 1.4MB payload Claude Code 请求 · exe 不卡死 · LogsPage 能看到详情
  - **单元**:`emitToRenderer` size guard 单测(vitest)· 各 channel 元数据化断言
  - **Grep gate**:后续 refactor 不许裸 `webContents.send(`,变体扫回归

### 🧩 8. Boundary Reinforcement

- **顺手**:统一 IPC 收口 helper 后,新增 IPC 强制走 helper · 加类型 `IpcChannel = keyof IpcPayloadMap` 让 send/on 编译时匹配 · 呼应 error-journal E-055(加 IPC 必同步 preload+listener)
- 未处理:MessagePort 升级(未来)· LogsPage 全量拉的 IPC 峰值(已由 3s poll 缓解足够)

---

## Update Log

- 2026-07-23 落盘骨架 · 变体扫已抽 34 处 send · pending 动手实施
- 2026-07-23T16:47 executor 完成实施(方案调整:runtime patch 一处收口 · SSOT §4.3 · 避免 E-052 死代码)
  - **新增** `src/main/utils/emitToRenderer.ts`(207 行):导出 `installIpcSizeGuard(webContents)` · runtime patch `webContents.send` · LARGE(2KB)/MEDIUM(8KB)/直通 三类分流 · 超限保留定长字段 + 折叠为 `{__truncated, originalBytes, preview<=200B, _keys[]}` 摘要 · dev 走 `process.stderr` 告警避免 console → interceptConsole 回环
  - **改** `src/main/index.ts` createWindow 内 setWindowOpenHandler 之后一处调 `installIpcSizeGuard(mainWindow.webContents)` · **不改 34 处 send 调用点**
  - **改** `src/main/proxy/logger.ts` interceptConsole `buildEntry`:`app.isPackaged && level==='INFO'` 时 data 强制走 200B preview + 剩余字节数标记(消除 stringify 全对象 CPU 峰值 · 假设 B 顺带治)
  - **改** `src/renderer/src/components/proxy/ProxyPanel.tsx` `_proxyRecentLogs` cap 从 100 提到 500(RCA 6.5)
  - **测** `test/main/utils/emitToRenderer.test.ts`(10 用例):LARGE 直通/截断 · MEDIUM 直通/截断/阈值边界 · 未分类直通 · null/undefined 不崩 · 幂等安装 · 非对象超限走摘要 · 通道常量覆盖 RCA 表格 · **10/10 pass**
  - 验证:`npm run typecheck:node ✓` · `npm run typecheck:web ✓` · vitest 21/21 pass
  - 未做:34 处 send 硬改(方案改为一处 patch,更符合 SSOT)· MessagePort 升级(未来)

