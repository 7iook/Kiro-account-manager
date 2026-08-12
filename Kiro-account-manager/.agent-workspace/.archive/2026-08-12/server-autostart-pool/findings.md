# 服务端自启动漏同步池 —— 执行findings

## 1. 缺陷锚点（已逐条亲验，非转述）

| 锚点 | 实际内容 | 结论 |
|---|---|---|
| `src/main/server/entry.ts:120-126` | `shouldAutoStartProxy` → `initProxyServer()` → `await proxy.start()`，**中间无任何同步池** | ✅ 缺陷确认 |
| `src/main/ipc/panelProxyDeps.ts:296-320` `proxyStart` | 「顺序承重：先同步池，再启动」+ `poolSize===0` 返回 `EMPTY_POOL` 拒启 | ✅ 唯一「同步后启动」实现 |
| `panelProxyDeps.ts:17-18` 文件头 | 「顺序有第二个真源时，两处早晚分叉，表现是『面板绿灯但反代打旧号』」 | ✅ 禁止复制实现 |
| `panelProxyDeps.ts:181-188` `syncPool` | 模块私有 helper，走 `pool.replaceAll()`（非 clear+add，保运行期状态） | 需要抽成可共用 |
| `server/assembly.ts:911-937` | 服务端**已经** `import { buildPanelProxyDeps } from '../ipc/panelProxyDeps'` | ✅ 该模块零 electron，服务端可直接复用 |
| `server/entry.ts:127-130` | 反代启动失败**刻意不致命**：面板要活着当管理入口 | 决定空池处置必须与此一致 |

## 2. 电子依赖核实

`panelProxyDeps.ts` 的 import 全部是 `../proxy/activation` / `../proxy/accountPool` /
`../proxy/types` / `../proxy/proxyServer` / `../proxy/holdGate` 的**类型与函数**，
无 `electron`。`assembly.ts` 文件头已明确实测过这一点并原样复用它。
→ 服务端从 `panelProxyDeps.ts` 取共享件是既有姿势，不是新开的耦合。

## 3. 待定的设计判断（下节论证）

- 共享件放哪：`activation.ts` 不可改（约束），`panelProxyDeps.ts` 是顺序既有真源 → 抽在后者。
- 空池处置两端不同（面板拒启 vs 服务端无人在场）→ 需要区分「盘上无账号」与「有账号但全不准入」。

## 4. 严重性亲验（**修正下派任务的描述**）

下派说「每个外部请求都失败，且只有 `onPoolEmpty` 恰好触发才恢复」。亲验后
真实形态更细，且这个差别直接决定空池处置该怎么选：

`proxyServer.ts:1783-1786`（`getAvailableAccount` 的**第一步**）：
```ts
if (this.accountPool.size === 0 && this.events.onPoolEmpty) {
  await this.abortable(this.events.onPoolEmpty(), signal)
}
```
`assembly.ts:706-740` 已经接了 `onPoolEmpty`，走的正是 `buildProxyAccountsFromStore`
同一准入真源。且 `conf` 的 `get store` 每次都 `fs.readFileSync`（`conf/dist/source/index.js:200-202`），
所以懒加载读的是**盘上现值**，不是启动时的快照。

⇒ 真实后果分两种，不是一种：

| 场景 | 空池启动后的实际行为 | 严重度 |
|---|---|---|
| 多账号模式（`enableMultiAccount: true`，服务端默认） | 第一个请求进来 → `size===0` → 懒加载补池 → **能选到号**。首请求可能慢一点，之后正常 | 🟡 自愈，但可观测性全丢：启动日志说「反代已启动」却没有池大小，运维无法在**请求到来之前**知道池是空的 |
| 单账号模式（`enableMultiAccount: false` + `selectedAccountIds`） | 懒加载补池发生在 `size===0` 判定之后，`selectedAccountIds[0]` 的查找在 `:1878`。补池成功则能找到；但补池若因**账号全不准入**返回 0（`assembly.ts:718` `accounts.length===0` 直接 return），则 `:1895` 严格模式**拒绝 fallback** → `account=null` | 🔴 每个请求失败 |
| 盘上有号但全不准入（无凭据 / 被上游拒绝） | 懒加载同样返回 0 → 池恒空 → 请求全失败 | 🔴 且 `hasBlockedAccount()` 遍历的是**池内**成员，空池 → 恒 false → 不挂起、直接报错 |

**结论**：缺陷成立，但不是「必然全盘失败」，而是
**① 启动可观测性丢失（必然发生）+ ② 账号全不准入时静默全失败（条件发生）**。
`accountPool.ts:453 hasBlockedAccount` 遍历池内成员，空池恒 false ⇒
`activation.ts:154` 注释说的「诊断信号恰好在最需要它的场景下消失」在这条路上重演。

这修正了下派的严重性描述，但**没有削弱**修复的必要性 —— 反而说明修复的重点是
**启动时点的如实播报**，而不只是「别用空池启动」。

## 5. 空池处置的裁决（含论证）

服务端**不采用**面板的 `EMPTY_POOL` 拒启，理由三条，全部有代码锚点：

1. `entry.ts:127-130` 已裁决「反代启动失败不致命 —— 面板要活着当管理入口」。
   拒启反代与这条一致（面板照活），但**拒启会关掉懒加载这条自愈路**：
   反代没起来 → 没有 `onPoolEmpty` → 运维必须手动上面板点启动。而首启场景
   （下派说明的：owner 稍后手动拷 `kiro-accounts.json`）恰好是「先起服务、后放数据」，
   拒启会把一个能自愈的场景变成必须人工干预的场景。
2. 面板的 `EMPTY_POOL` 拒启是对**屏幕前的人**的即时反馈（他刚按了按钮，能立刻改）。
   服务端自启动发生在开机时，**无人在场** —— 拒绝启动的信息只会进 journal，
   而运维下次看日志可能是几小时后。此时「拒启」的收益（避免假绿灯）
   可以用「如实播报 + 继续」同样达到，且不牺牲自愈。
3. 盘上零账号是**合法首启态**（下派已确认）。把合法态当启动失败处理是误报。

**采用**：先同步池 → **按池大小分三种如实播报** → 无论哪种都继续启动。
即「不拒启，但绝不打印一条会让人以为一切正常的日志」。三态区分（下派要求）：

| 池大小 | 盘上账号 | 日志 | 语义 |
|---|---|---|---|
| >0 | — | `反代已启动: host:port（池 N 个账号）` | 正常。**带上池大小**才是真读数 |
| 0 | 盘上 `accounts` 为空/缺失 | `⚠️ 空池启动：数据文件里还没有任何账号（首次部署常态）。拷入 kiro-accounts.json 后，反代会在下一个请求到来时自动补池，无需重启。` | 合法首启 |
| 0 | 盘上**有**账号但全被准入判据挡下 | `🔴 空池启动：盘上有 N 个账号，但全部未通过池准入 —— 每个请求都会失败。原因见上一行 [PoolAdmission]。` | 真故障。`logPoolAdmissionSkips` 已逐个点名原因 |

第三种是下派要求的「有号但全不准入」，它与第二种的处置差异是**运维动作不同**：
前者「去拷数据」，后者「去看为什么这些号不准入」。

## 6. 交付记录

### 改动文件（2 改 1 新增）

| 文件 | 改动 |
|---|---|
| `src/main/ipc/panelProxyDeps.ts` | 把原模块私有 `syncPool` 提成导出的 `syncProxyPoolFromStore(loadAccountData, server, source)` + `ProxyPoolSyncResult{recordCount, poolSize}`；面板侧 `syncPool` 改为薄封装（面板行为零变化） |
| `src/main/server/entry.ts` | ⑥ 反代分支：`initProxyServer()` → **`syncProxyPoolFromStore(..., 'server-autostart')`** → `start()` → 按池大小三态如实播报；文件头启动顺序 ⑥ 补上顺序承重说明与「服务端为何不拒启」 |
| `test/main/server/serverAutostartPoolSync.test.ts`（新） | 5 个用例，全部驱动**真** `bootstrap(env)` |

**未改**：`src/main/proxy/**`（约束）· `src/renderer/**`（约束）· `src/main/index.ts`（不需要 —— 见下变体扫描）· `server/assembly.ts`（缺陷不在装配语义里）。

### 红证据（移除修复后必须红，且因缺功能而红）

修复前实跑 `EXIT=1`，4/5 红，红的原因是**功能缺失**而非语法/装配错：

```
[failed] 盘上有准入账号 → bootstrap 返回时池里已经有号
   AssertionError: expected +0 to be 2          ← 池是空的
[failed] 启动日志必须带上池大小
   AssertionError: expected '[server] 反代已启动: 127.0.0.1:0' to match /池|pool/i
[failed] 反向对照 ①（盘上零账号）    expected '[WARN][HoldGate]' to match /空池/
[failed] 反向对照 ②（有号但全不准入） expected '[WARN][HoldGate]' to match /未通过池准入/
[passed] 未配置自启动 → 不初始化反代    ← 这条本就该绿（证明测试有辨别力，不是全红）
```

第 1 条 `expected +0 to be 2` 是缺陷的直接指纹：反代 `isRunning()` 为真、池 0 个号。

### 变体扫描（§5.3 —— 只修一条路是本项目已知的失败形态）

全仓三条池水合路径逐一核实：

| 路径 | 位置 | 状态 |
|---|---|---|
| 桌面自启动 | `index.ts:2034 syncedCount = syncAccountsToPool()` 在 start 之前，且 `:2023 logPoolAdmissionSkips(..., 'autostart')` | ✅ 本就正确，无需改 |
| 面板 `/start` | `panelProxyDeps.ts:proxyStart` | ✅ 本就正确（改为共用导出函数，行为不变） |
| **服务端自启动** | `server/entry.ts` | 🔴 **唯一缺失者 → 本轮修复** |
| `ProxyServer.restartServer()` | `proxyServer.ts:1069-1078` | ✅ 非变体：重启的是已在内存里的池，不经过水合 |

### 空池裁决（最终选择：不拒启 + 三态如实播报）

**没有**照搬面板的 `EMPTY_POOL` 拒启。三条理由：

1. 拒启会连带关掉 `onPoolEmpty` 懒加载补池那条自愈路（`assembly.ts` 已接，且
   `conf` 每次 `get` 都 `fs.readFileSync` ⇒ 稍后拷进来的数据文件能被读到）。
   机主的迁移动作正是「先起服务、后拷 `kiro-accounts.json`」，拒启把一个能自愈的
   场景变成必须人工上面板点启动。
2. 面板拒启是给**屏幕前的人**的即时反馈；服务端自启动在开机时、无人在场，
   「拒启」的收益（避免假绿灯）用「如实播报」同样达到，且不牺牲自愈。
3. 与 `entry.ts:127-130` 既有裁决一致：反代问题不该带走面板这个唯一管理入口。

**与既有不对称的一致性**：既有裁决是「反代起不来 → 不致命，面板活着」；
本轮是「反代起来了但池空 → 不拒启，但绝不打印一条会让人以为一切正常的日志」。
同一取向：把决定权留给能看到日志的运维，而不是替他停服务。

三态（下派要求的「区分盘上无账号 / 有账号但全不准入」已落地）：

| 池 | 盘上 | 播报 |
|---|---|---|
| >0 | — | `[server] 反代已启动: h:p（池 N 个账号）` |
| 0 | 0 条记录 | `⚠️ 空池启动：数据文件里还没有任何账号（首次部署的常态）… 不需要重启` |
| 0 | N 条但全不准入 | `🔴 空池启动：盘上有 N 个账号，但全部未通过池准入 —— 每个请求都会失败…` + 上一行 `[PoolAdmission] server-autostart:` 逐个点名 |

### 验证读数（全部实跑，非推断）

| 项 | 命令 | 结果 |
|---|---|---|
| 红 | `npx vitest run test/main/server/serverAutostartPoolSync.test.ts` | `EXIT=1` · 5 总 / 1 过 / **4 红** |
| 绿 | 同上 | `EXIT=0` · 5 总 / **5 过** / 0 红 |
| 类型 | `npm run typecheck:node` | `EXIT=0` |
| 服务端构建 | `npm run build:server` | `EXIT=0` |
| 全套件 | `npx vitest run --reporter=json` | `EXIT=0` · **1676 passed / 0 failed / 6 skipped** · 513 suites（基线 1671 + 本轮 5） |

### 真实服务端端到端（`out/server/index.js` · 临时 `KIRO_DATA_DIR` · 按 PID 精确 kill）

三态全部实测通过，日志原文见 `e2e.log`：

```
mode=admissible  : [AccountPool] Pool rebuilt: 2 accounts …
                   [server] 反代已启动: 127.0.0.1:0（池 2 个账号）
mode=empty       : [server] ⚠️ 空池启动：数据文件里还没有任何账号（首次部署的常态）。
mode=inadmissible: [PoolAdmission] server-autostart: 2 个账号未入反代池 ——
                     b1@example.test: 无凭据 · b2@example.test: 已被上游拒绝(AccountSuspendedException…)
                   [server] 🔴 空池启动：盘上有 2 个账号，但全部未通过池准入 ——
```

关键顺序证据：`Pool rebuilt` 出现在 `ProxyServer Started` **之前** —— 即池在对外接流之前已就位。

数据文件用项目自己的 `conf` + `ACCOUNT_STORE_ENCRYPTION_KEY` 现造，
**全程未读、未拷 `%APPDATA%\kiro-account-manager\kiro-accounts.json`**（机主活凭据）。

临时树经守卫入口清理：`Invoke-SafeClean.ps1 -Path <temp> -Force` →
`moved -> C:\.ai-trash\20260812-232355-…` + `[ok] parent intact`。
临时播种脚本 `tmp-e2e-seed.mjs` 已删；仓库工作区只剩上表 3 个文件。
未 commit / 未 stash / 未 `git add`。
