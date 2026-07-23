# ③ 账号池热切换 · 决策卡

> 分类:✨ Feature flow · Artifact: 决策卡(§6.6 五段)

---

### 🏗️ 1. Boundary Decisions

- **Bounded context**:反代账号管理层(AccountPool + ProxyServer)· 不涉及 Kiro API / 认证 / 存储
- **State machine**:账号池运行时状态扩展
  - **原**:`stopped ↔ running` · 只有 stopped→running 之间可改账号池成员(UI disable while running)
  - **新**:`running` 内部支持 3 类原子操作,不 stop
    - `activateAccount(id)`(单账号模式生效):`pool.setCurrentIndex` 到指定账号 · 触发 `syncPool` · 无 stop
    - `addPoolMembers([acc])`(多账号模式):`pool.addAccount` 循环 · 幂等(id 已存在则 updateAccount)
    - `removePoolMembers([id])`(多账号模式):`pool.removeAccount` 循环 · pool 空则拒绝
    - `replacePoolMembers([acc])`(多账号模式):批量同步的原子形态
- **Invariants**:
  - 反代运行中账号池非空(至少 1 available)· 违反 → 拒绝
  - 端口/host/TLS 变更仍需 stop→start(底层 socket bind 无法热切)
  - `currentIndex` / `SWRR credit` 成员变化后正确(不指向已删账号)· 由 `SmoothWeightedRoundRobin.forget(id)` 联动
- **ADR admission**:no · 属运行时状态机小扩展,不涉跨模块/对外契约,RCA + 决策卡足够

### 🔍 2. Existing-Implementation Search (§2.2)

- **Internal**:
  - `AccountPool.addAccount/removeAccount/updateAccount/clear`:热的,不 stop(accountPool.ts:135-162)
  - `SmoothWeightedRoundRobin.forget(id)`:removeAccount 联动
  - `syncAccountsToPool`(index.ts:2610+ 自启动路径本地函数)+ ProxyPanel 侧的 sync IPC(待读 ProxyPanel.tsx 定位现有 handler)
  - `proxy-set-active-account` / `proxy-update-pool-members`:全仓 grep 无同名 · 新建
- **External**:kiro-rs / 9router 无 UI 无参考 · 自建

### 📐 3. Interface Contract

#### IPC 1: `proxy-set-active-account`
- **Input**:`{ accountId: string }`
- **Output**:`{ success: boolean, error?: string, account?: { id, email, isAvailable } }`
- **Validation**:accountId 存在于 pool · account.isAvailable(非 suspended)· pool.size ≥ 1
- **Error codes**:`ACCOUNT_NOT_IN_POOL` / `ACCOUNT_NOT_AVAILABLE` / `POOL_EMPTY`
- **语义**:强制下一次请求使用该账号 · round-robin 模式下"从此账号开始轮"
- **Idempotent**:是(切到同一账号 no-op)

#### IPC 2: `proxy-update-pool-members`
- **Input**:`{ add?: ProxyAccount[], remove?: string[], replace?: ProxyAccount[] }`(add/remove/replace 互斥,replace 优先)
- **Output**:`{ success, addedCount, removedCount, poolSize, error? }`
- **Validation**:操作后 pool.size ≥ 1(replace 空数组拒绝)· ProxyAccount 结构完整
- **Error codes**:`WOULD_EMPTY_POOL` / `INVALID_ACCOUNT_SHAPE`
- **Idempotent**:add 是(已存在 update 不重复)· remove 是(不存在跳过)

#### 主进程包装:`syncPoolMembers` helper
- 建议路径:直接内联在 index.ts 的 ipcMain.handle 里(职责简单,不新建独立文件避免过设计)· 若 3 处以上复用再抽 `src/main/proxy/poolSync.ts`

### 🧪 4. Test Boundaries (TDD Red)

- **单元测试**(vitest · test/main/):
  - `test('activateAccount 在运行中切换到指定账号,pool.currentIndex 更新,下次 getNextAccount 返回该账号')`
  - `test('removePoolMembers 清空后剩余 = 0 应拒绝,不清 pool')`
  - `test('addPoolMembers 添加 id 已存在则 update,不重复')`
  - `test('replacePoolMembers 空数组拒绝')`
  - `test('SWRR credit 在 removeAccount 后 forget(id) 被调用')`
- **手动 e2e**:反代运行中 · 单账号模式点账号卡"切换到此" · 观察下一次代理请求走该账号(日志验证)· 多账号模式勾选/取消勾选池成员 · 观察生效

### 🛡️ 5. Anti-Corruption Layer & Registration

- **无 3rd-party SDK**
- **Registration checklist**(§6.4 + error-journal E-055 三收口):
  - [ ] 主进程 `ipcMain.handle` 注册 2 处新 IPC(index.ts)
  - [ ] Preload 暴露 API(preload/index.ts):`setActiveAccount(id)` / `updatePoolMembers(payload)`
  - [ ] TypeScript 类型声明(preload/index.d.ts 或 src/renderer/src/env.d.ts)
  - [ ] 前端 store/action:`useAccountsStore.switchProxyActiveAccount(id)` / `syncPoolMembersToProxy(payload)`
  - [ ] ProxyPanel.tsx UI:
    - 移除运行中 `disabled` 阀门(账号选择器、池成员编辑器)
    - 单账号模式在 AccountCard 加"切换到此"按钮(仅反代运行时显示)
    - 多账号模式池成员编辑器变热(勾选立即触发 updatePoolMembers)
  - [ ] i18n(zh/en):"切换到此" · "已切换" · "无法清空账号池"
  - [ ] 日志:两个 IPC 在 proxyLogger.info 各记一条 · 便于用户排查

### ⚠️ 边界与显式不做

- **不改**:端口/host/TLS 变更时的重启逻辑(底层 socket 无法热切)
- **不改**:accountPool 内部 strategy(round-robin/sticky/weighted)· 保留切换配置(不属热切换范畴)
- **不改**:多账号模式的 group filter(v1.6.9 已热编辑)

---

## Update Log

- 2026-07-23 落盘骨架 · pending 读 ProxyPanel 现有 sync IPC 逻辑后补最终 UI 定位
- 2026-07-23 实施完成(SUB executor):accountPool.setActiveAccount + 2 IPC + preload + store action + ProxyPanel 单账号 hot switch wire · 11/11 单测 pass
- 2026-07-23 补齐 §5F 第 3 点(commit a69ce05):移除 ProxyPanel 3 处 `disabled={isRunning}` 阀门(scope toggle × 2 + ungrouped chip + user group chip),放开多账号轮询范围运行时编辑。既有 toggleGid / scope onClick 已经调 `syncAccounts({mode, groupIds})` 全量 replace,后端 pool.clear + addAccount 循环支持热更新。按钮加 title 提示"热切换:池成员立即重同步"。**决策卡遗留未做项全部关闭。** typecheck:web ✓
- 2026-07-23T16:47 executor 完成实施(E-055 三收口全套)
  - **改** `src/main/proxy/accountPool.ts`:新增 `setActiveAccount(accountId): boolean` · `this.currentIndex = idx + this.swrr.reset()` · 不存在返回 false
  - **改** `src/main/index.ts` 紧挨 `account-set-proxy-binding` 后新增 2 handle:
    - `proxy-set-active-account({accountId})` · 校验 `proxyServer 运行中 + pool.getAccount + !isSuspended` · 错误码 PROXY_NOT_RUNNING / ACCOUNT_NOT_IN_POOL / ACCOUNT_NOT_AVAILABLE · 成功返回 `{success, account:{id,email,isAvailable}}`
    - `proxy-update-pool-members({add?,remove?,replace?})` · replace 优先 · 空数组拒绝(WOULD_EMPTY_POOL)· add 校验 id+accessToken 非空(INVALID_ACCOUNT_SHAPE)· remove 后 pool 空且运行中拒绝 · 返回 `{success,addedCount,removedCount,poolSize}`
    - 日志走 `console.log('[AccountPool] ...')`(注:决策卡原写 `proxyLogger.info` 但 index.ts 顶部未导入,`console.log` 经 interceptConsole 转发到 proxyLogStore 语义等价 · 不新增 import)
  - **改** `src/preload/index.ts` + `index.d.ts` 新增 2 API:`setActiveProxyAccount(id)` / `updateProxyPoolMembers(payload)`
  - **改** `src/renderer/src/store/accounts.ts` AccountsActions 接口 + impl 新增 2 action:`switchProxyActiveAccount(id)` / `syncPoolMembersToProxy(payload)`
  - **改** `src/renderer/src/components/proxy/ProxyPanel.tsx`:
    - 移除单账号选择按钮 `disabled={isRunning}` 阀门
    - AccountSelectDialog `onSelect` 回调:`isRunning && accountId` → 调 `switchProxyActiveAccount(accountId)` 热切换
  - **测** `test/main/hotSwapAccounts.test.ts`(11 用例):setActiveAccount 存在/不存在/空池/幂等/优先返回 · clear-add/覆盖-add/remove-不存在-静默/联动 · SWRR forget/reset · **11/11 pass**
  - 验证:`npm run typecheck:node ✓` · `npm run typecheck:web ✓` · vitest 21/21 pass
  - **未做**:多账号模式池成员编辑器 `syncPoolMembersToProxy` 的 UI 热编辑(§5F 第 3 点)—— 该处依赖识别 multiAccount group filter 变更 → 差量同步逻辑,UI 面积较大且涉及 selectedGroupIds/enableMultiAccount/accountSelectionMode 三态耦合。**当前状态**:store action + IPC 已就绪(下游可零成本 wire),仅 UI 触发点未加。建议下一轮做:多账号 group chip toggle → 计算 add/remove diff → 调 `syncPoolMembersToProxy`;或用 replace 全量同步。

