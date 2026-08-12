# K-5 服务端入口 · 侦察报告

> 派单：主 AI · 只调查、不改代码。
> 目标：为 K-5（服务器无头入口 = 组装图重写）产出可派单的执行计划。
> 仓库 `F:\Kiro-account-manager\Kiro-account-manager` · `main @ 8e1099e` · 派单期间只读。
> 决策卡：`.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md`
> 前置：`181b169`(K-1) · `8687d58`(K-2) · `afe80af`(K-3) · `8e1099e` 只加宽 K-4 门禁测试
> owner off-limits：`src/main/proxy/kiroApi.ts` · `test/main/proxy/rateLimitBackoffJitter.test.ts`
> · `src/main/proxy/proxyServer.ts` · `src/renderer/src/components/proxy/ProxyLogsDialog.tsx`

## 派单方给我的路标校核（先纠正）

| 派单里的锚点 | 实测 | 结论 |
|---|---|---|
| `initProxyServer()` 在 `src/main/index.ts:507` | **实为 `:516`**（`let proxyServer:... = null` 在 `:505`；`let webPanelWiring` 在 `:514`） | 派单注明"自己核" |
| `initStore()` 在 `:1990` | **实为 `:1985`** | 同上 |
| `state.ts` 的锁在 `:124-179` | **实为 `accountService/state.ts:139-190`**（`let pending: Promise<unknown> = Promise.resolve()` + `applyAccountDataMutation` 串行化的整块） | 语义未变（进程内串行锁、`expectedRevision` 显式传入才启用） |
| 「约 100 个 `ipcMain.handle` 注册」 | **实测 `ipcMain.handle` 133 处 + `ipcMain.on` 9 处 = 142 通道**（在 `app.whenReady()` 里，`:3184-7156`） | 附录 A 逐个枚举 |
| 「4520 行 `accountService/`」 | 未逐行核 | unverified: needs recheck if used as承重依据 |

## 派单前提校核（更重要）

派单说服务端入口的组装可以按「面板/反代/池调度」三块直接接内核。**这里有一处比锚点校准更承重的偏差**——组装图不是三块，而是**四块**，第四块是"账号数据的主进程持久化闭环"，它今天还不存在于内核里、桌面上是靠 renderer 兜的（详见 §1 假设⑦、§4 建议 P1、§5 SCOPE.5、§6 W-C）。这个偏差如果不在派单阶段亮出来，后面派几个 executor 都会做出"看起来能启动、但账号数据不落盘"的服务端。故本报告 §4 一整节说这件事。

---

## 1. Plan assumptions list（决策卡里那些"现实可能推翻"的假设）

从 `.archive/2026-08-10/server-migration-decision/decision-card.md` 抽出：

| # | 假设 | 出处（决策卡节） | 现实可能怎么推翻 |
|---|---|---|---|
| ① | 内核已零 `electron` 依赖，只等一个服务端壳把端口注入 | 三分范围表·K-1~K-4 已完成 | 端口注入是否覆盖了所有场景？—— 反代 SSE 端点、K-Proxy 装配、账号池懒加载都用了 `app.getPath('userData')`，需逐个核 |
| ② | 服务端复用 `conf` 实现 → 与桌面**字节级兼容** | ADR-0002 Decision 3 / DC:244 | `conf` 只是 `electron-store` 的传递依赖，服务端 bundle 需要把它显式引入 `dependencies` |
| ③ | 主要端点已就位（`AccountStorePort` / `BackupCipher` / `WebPanelServer` / `ProxyServer` / `initKProxyService`），K-5 是"组装图重写而非搬运" | K-11 ADR-0002 落盘节 | 已就位是真的；但既存 `initProxyServer` 有 7 个 `mainWindow?.webContents.send`+ `debouncedStoreSet` + `lastSavedData` 内存快照，全是**渲染进程假设** |
| ④ | 面板已经是"注入式"，服务端拿它即可用 | §1 决策卡「六个模块」段 | 面板本身是纯的（`webPanel/**` 无 electron），但装配层 `ipc/webPanelWiring.ts` 里 `AdminKeyStore` 走的是 **store 的 `webPanelAdminKey` 键** —— 决策卡 DC9 定的"首启打印一次到 stdout"与"文件权限 0600" 都还没有代码承载 |
| ⑤ | 单实例锁按数据目录，服务器上"无需任何锁" | §「数据目录并发」表 | 完全成立，但要拒绝"退化到 `requestSingleInstanceLock`"—— Electron API 纯 Node 下不存在 |
| ⑥ | 服务端 store 键与桌面同名同形 | §「数据真源」 I1a | 决策卡明确桌面端配置项**大部分原样不动**，但服务端得决定哪些键真的读 |
| ⑦ | K-5 只需要"组装图重写" | §1 依赖顺序图 | **最关键的隐性假设** —— 桌面端账号数据落盘的**完整闭环**不在主进程：主进程的 `background-batch-refresh` **只 send IPC，不落盘**（`index.ts:4023/4233/4251`），renderer 收到后走 `set(...)` 到内存，再由 25 处 `saveToStorage()` 调用点回主进程 `save-accounts` → `applyAccountDataMutation` 写盘。服务端没有 renderer，这条链断了 |
| ⑧ | `webPanelAssetRoot.ts` 的 `out/main → ../webPanel` 相对关系在服务端 bundle 中保持 | §5 注册清单 | 该文件通过 `__dirname` 定位，与 electron 无关；服务端 bundle 产物落到 `out/server/index.js` + `out/webPanel/*` 即自动成立 |
| ⑨ | `conf` 已经被证明"零 electron" | K-3 commit message + `accountStorePort.ts` 头注释 | 已实测 `node_modules/conf/dist/source/index.js` 无 electron import，成立 |
| ⑩ | 服务端只支持"原始数据文件直拷"作为迁移工件 | ADR-0002 Decision 3 / DC:538 | 成立，且 `preflightAccountStoreForServer` 已经把四态判定 + 写权限闸门写好，装配层直接调即可 |

---

## 2. Reality verification（plan vs reality · 每条假设的证据锚点）

### ① 内核已零 electron —— [match]，闭包比"我列的四个入口"大

`test/main/architecture/kernel_without_electron.test.ts:100-108` 已列出 9 个入口，闭包扩到"几十个文件"（K-3 commit 里主 AI 自报 45 个）。8e1099e 又加宽为"抓子路径 + 抓间接依赖包"（`git show --stat 8e1099e`：300 行变更全在该测试文件）。**结论**：内核零 electron 的闸门已经是模块图级+多形态（ESM/CJS/dynamic），假设成立。

派单里"K-1..K-3 已完成、K-5 是下一步"的判断正确。

### ② `conf` 字节级兼容 —— [deviation: packaging 缺陷]

- 事实（本轮 `npm ls conf --depth=3`）：`conf@15.0.2` 仅通过 `electron-store@11.0.2` 传递依赖，**不在 `package.json` 的 `dependencies`**（本轮 grep `"conf"` 命中 False）。
- 影响：服务端 bundle 若跑 `npm i --omit=dev` 移除 `electron` 时把 `electron-store` 也带走（虽然它是 dep 不是 devDep，但服务端不需要它自身，只需要它的 `conf`）。
- **动作**：K-5 必须把 `conf` 显式提到 `dependencies`。这不是 K-6 的事，是 K-5 的事——`accountStore.conf.ts` 在服务端入口路径上，K-5 加载它就会解析 `import Conf from 'conf'`，成败取决于 `dependencies`。

### ③ 已就位的端点 —— [match] 但**零生产 caller**

本轮实测（`Get-ChildItem ... Select-String`）：
- `createConfAccountStore`：只在 `test/main/persistence/accountStorePort.test.ts` 里被调（**零生产 caller** —— 派单描述正确）
- `createAesGcmBackupCipher`：只在 `test/main/secureBackup/aesGcmCipher.test.ts` + `test/main/kernelWithoutElectron.runtime.test.ts` 里被调（**零生产 caller**）
- `preflightAccountStoreForServer`：只在 `test/main/architecture/persistence_port_wiring.test.ts` 里被调（**零生产 caller**）
- `WebPanelWiring` / `ProxyServer` / `initKProxyService`：桌面 `index.ts` 已在用（有生产 caller，但装配点是 electron 依赖的）

K-3 落地的三个"服务端形态"端点全部是"备好没接线"——它们等的正是 K-5。

### ④ 面板准备度 —— [match] + [deviation: 首启密钥引导缺]

`src/main/webPanel/*.ts` 无一 import electron（`webpanel_auth_constraints.test.ts` 的门禁保护）；`ipc/webPanelWiring.ts` 是有 electron 的边界层，服务端要旁路它。

**但 DC9（决策卡 R2 唯一 P0）里定的 5 项密钥引导规则一条代码承载都没有**：
- ✗ 首启无密钥 → 生成并**打印到 stdout 一次**：`PanelAuth.ensureAdminKey()` 只 return，不打印
- ✗ 密钥文件权限 `0600`：`AdminKeyStore` 走 `store.set('webPanelAdminKey', key)`，即写进 `kiro-accounts.json`；无独立密钥文件、无 chmod
- ✗ 环境变量预置 `KIRO_ADMIN_KEY`：完全不存在
- ✗ 环境变量与文件冲突时拒绝启动：完全不存在
- ✓ "不提供 HTTP 端点重置密钥"：**已符合**（面板路由表里确实没有该端点，本轮 `git grep` 未在 `routes.ts` / `server.ts` 找到 rotate 相关 HTTP 路由，只有 IPC handler）

**动作**：K-5 必须给面板装配一个新的 `AdminKeyStore` 实现——服务端形态用独立文件 + 环境变量优先级 + 首启打印。桌面端不动。

### ⑤ 单实例锁 —— [match]

- 桌面：`index.ts:7159 gotTheLock = app.requestSingleInstanceLock()`（唯一命中）
- 服务端：`requestSingleInstanceLock` 是 electron API，不能用；决策卡说"服务器上只有一个进程 → 无需任何锁"。
- **动作**：K-5 服务端入口**不装单实例锁**。派单里问"是否需要"，答案是"决策卡已答过：不需要"，唯一要防的是"某执行者按桌面样子照搬 electron API"—— 这是判定题不是设计题。

### ⑥ store 键复用 —— [deviation: 需要分类]

服务端形态下这些键分四类（本轮读 `initProxyServer` / `WebPanelWiring.readConfig` 等得到）：

| store 键 | 服务端处置 | 依据 |
|---|---|---|
| `accountData` | **读写**（核心账号数据） | 迁移工件本尊 |
| `proxyConfig` | **读写**（`initProxyServer` 一次性迁移 `enableTokenBufferReserve` + 面板反代编排 `persistProxyConfig` 要写它） | 面板 `POST /api/proxy/active-account` 会走 `persistProxyConfig` |
| `webPanelConfig` | **读写**（面板自身启停配置） | `WebPanelWiring.writeConfig` |
| `webPanelAdminKey` | **弃用** —— 迁到独立 `adminKey` 文件 | DC9（见 ④） |
| `proactiveRenewalEnabled` | **读**（`runProactiveRenewal` 是主进程逻辑，服务端一样跑） | `index.ts:2091` |
| `proxyTotalCredits` / `proxyInputTokens` / `proxyOutputTokens` / `proxyTotalRequests` / `proxySuccessRequests` / `proxyFailedRequests` | **读写**（反代统计防抖持久化：`debouncedStoreSet`） | `initProxyServer` 里的 `onCreditsUpdate` / `onTokensUpdate` / `onRequestStatsUpdate` |
| `usageApiType` / `useKProxyForApi` | **读**（反代运行时开关） | `initProxyServer:526-534` |
| `kproxyConfig` | 读，仅当**服务端也起 K-Proxy**（见 §5 DEC.1） | — |
| `accountDataMigration` | **读写**（一次性迁移标志） | `initProxyServer` 里的 tokenBufferReserve 迁移 |
| `PROXY_ORPHAN_SESSION_KEY` / `proxySessionHistory` | **读写**（反代会话归档，服务端一样有） | `restoreOrphanProxySessionIfAny` + `archiveProxySessionIfAny` |
| `traySettings` / `showWindowShortcut` | **不读**（桌面专属） | tray/快捷键只在桌面壳 |

### ⑦ K-5 只需要"组装图重写" —— [**deviation: 严重**]

这是本次侦察最承重的发现，见 §4 P1、§5 SCOPE.5、§6 W-C 详述。

**证据链**（本轮真跑）：

1. `src/main/index.ts:4023 / 4233 / 4251` —— `backgroundBatchRefresh`（主进程 token 池刷新）在每条账号刷新成功/失败后**只发 `background-refresh-result` IPC**，没有 `applyAccountDataMutation`、没有 `store.set`、没有直接写盘。
2. `src/main/index.ts:2701` —— 主进程调度器 `runMainPoolTokenRefreshTick` 调 `backgroundBatchRefreshImpl(...)`，之后**没有落盘动作**。
3. `src/renderer/src/App.tsx:356-370` —— renderer 订阅 `onBackgroundRefreshResult`，缓冲后调 `applyBackgroundRefreshResults(batch)`。
4. `src/renderer/src/store/accounts.ts:3461-3570`（`applyBackgroundRefreshResults` 主体）—— 只 `set((state) => ...)` 到 zustand 内存；**没有触发落盘**（该函数尾部无 `saveToStorage()` 调用，与其他 25 处入口不同）。

那到底是**谁**落盘了新 token？

- 追踪：`checkAndRefreshExpiringTokens`（`accounts.ts:3223`）—— 这是 **renderer 侧**的定时器，它调 `refreshAccountToken(id)` 与 `checkAccountStatus(id)`，这些函数才会调 `saveToStorage()`。
- 也就是说，桌面上 token 落盘的**权威路径**是"renderer 定时器 → refreshAccountToken/checkAccountStatus → saveToStorage → save-accounts IPC → main.applyAccountDataMutation → 盘"。
- 主进程的 `background-batch-refresh` 是**冗余**通道（`index.ts:2536` 头注释：「窗口最小化到托盘后 Chromium 后台节流，导致 token 过期数分钟才刷新」—— 主进程调度器只是补充，不是权威）。
- 结论：`backgroundBatchRefresh` 的产物**并未持久化**。桌面上其实有个坑——主进程调度器跑完后靠 renderer 定时器补上，因为 renderer 定时器也在跑。但服务端**没有 renderer 定时器**。

**K-5 必须做的事，不是"把 renderer 定时器搬到主进程"**（那是渲染层的定时器，服务端不 host renderer），**而是给 `backgroundBatchRefresh` 加一条主进程落盘路径**。桌面上加不加？桌面上加会与 renderer 的 `saveToStorage` 撞车（两处都在写、只有 revision 仲裁能兜住冲突）——决策卡 §1 不变量 I5 说"两端共用同一内核，不得分叉"，故落盘路径必须服务端桌面共用。

一个"看起来能启动的服务端 + 一个悄悄不落盘的 token 池"是 K-5 最容易犯的隐性错误。

### ⑧ webPanelAssetRoot 相对路径 —— [match]

`src/main/utils/webPanelAssetRoot.ts:88 __dirname + '..' + WEB_PANEL_OUT_DIR_NAME`：产物落 `out/server/index.js` + `out/webPanel/*` 即可满足。K-6 需要保证这一点，K-5 不用碰。

### ⑨ conf 零 electron —— [match]

已核实 K-3 commit message 里的实测：`node_modules/electron-store/index.js` 是 83 行的 `extends Conf` 薄壳，`conf@15.0.2` 自身无 electron 依赖。

### ⑩ 迁移工件仅"原始文件直拷" —— [match]

`preflightAccountStoreForServer`（`accountStorePort.ts:377`）已实现四态判定 + 写权限 + 版本闸门，装配层调它即可。

---

## 3. Duplicate & reusable scan（内部 + 外部）

### 3a 内部（已存在、K-5 直接调，不重造）

| 能力 | 已存在位置 | K-5 消费方式 |
|---|---|---|
| 账号数据端口 | `src/main/persistence/accountStorePort.ts` | 装配层调 `createConfAccountStore({ dataDir })` |
| 账号数据服务端实现 | `src/main/persistence/accountStore.conf.ts` | 同上 |
| 备份加密（AES-GCM） | `src/main/secureBackupCipher.aesGcm.ts` | 装配层调 `createAesGcmBackupCipher(process.env)` 注入给 secureBackup |
| 备份读写 | `src/main/secureBackup.ts` | 装配层注入 cipher |
| 反代服务器 | `src/main/proxy/proxyServer.ts` | `new ProxyServer(config, events, userDataPath)` |
| 反代自签证书（可选） | `src/main/proxy/selfSignedCert.ts` | 由 ProxyServer 内部按 tls.enabled 拉起 |
| K-Proxy 服务 | `src/main/kproxy/index.ts:initKProxyService(config, events, userDataPath)` | 装配层注入 dataPath |
| 面板 HTTP 服务器 | `src/main/webPanel/server.ts` | `new WebPanelServer({ auth, routeDeps, getConfig, onStatusChange, onError })` |
| 面板路由 | `src/main/webPanel/routes.ts:routePanelApi` | server 内部调，K-5 不重写 |
| 面板鉴权 | `src/main/webPanel/auth.ts:PanelAuth` | 装配层注入 `AdminKeyStore` |
| 反代池编排 | `src/main/proxy/activation.ts` | 通过 `buildPanelProxyDeps` 组合，K-5 不重写 |
| 面板反代 deps 拼装 | `src/main/ipc/panelProxyDeps.ts:buildPanelProxyDeps` | 服务端也用它，只是 `getProxyServer` 等回调改成本地闭包 |
| accountService 全套 | `src/main/accountService/**` | 装配层构造 `AccountRuntimeDeps` 时注入函数（同桌面） |
| 主进程池 token 刷新调度器 | `src/main/index.ts:2708 startMainPoolTokenRefresh` | **必须搬出 index.ts**（见 §7 冲突热点） |
| Kiro IDE token 反向同步 | `src/main/index.ts:2139 startKiroAuthTokenWatcher` | 服务端**不 host IDE**，不启动此监听器 |
| Kiro API 层 | `src/main/proxy/kiroApi.ts` | ⚠️ owner 正在改，K-5 只透传 setter；派单里已列为 off-limits |
| 单实例锁 | Electron `app.requestSingleInstanceLock` | 服务端**不用**（决策卡） |
| 面板地址枚举 | `src/main/ipc/webPanelWiring.ts:buildPanelAddresses` | 该函数不 import electron，可提取到共享层 |

### 3b 外部（proven-path / 已经解决的问题）

| 需求 | 已有成熟做法 | 结论 |
|---|---|---|
| 独立密钥文件权限 0600（Windows / Unix 差异） | Node `fs.chmod(path, 0o600)`；Windows 上 chmod 只影响只读位，真实 ACL 需 `icacls` | 服务端优先目标 Linux，`0o600` 即够；Windows 服务端属边缘场景，K-5 不做特殊处理，写入前告警"Windows 下文件系统权限保护弱" |
| 首启密钥生成到 stdout / 环境变量优先级 | 见 gitea / drone / grafana 等自托管服务的通用做法 | 决策卡 DC9 已定优先级，直接实现 |
| Node HTTP 服务器优雅停机 + socket destroy | 面板 `WebPanelServer.stop()` + 反代 `ProxyServer.stop()` 已经手写了这套 | 复用；服务端入口的 SIGTERM handler 只需要按顺序调它们 |
| `SIGTERM` / `SIGINT` handling | Node `process.on('SIGTERM', ...)`，官方标准 | K-5 装配层写；不引入第三方 |
| 探针（liveness/readiness/business） | 决策卡 DC14 已裁决：本轮**只做 liveness**（存活 + 进程托管才有消费者） | readiness/告警不做 |

**没找到需要引入的新第三方库**。所有能力都已在项目内或 Node 标准库覆盖。

---

## 4. Architecture / premise challenge + business-reality check + better approach

### 【架构级建议 P1】桌面 token 落盘链断裂——服务端不能"照搬"，必须补主进程落盘路径

**当前架构**：主进程 `backgroundBatchRefresh` 不落盘，靠 renderer 收 IPC 后再落盘。桌面上这条链能工作，是因为 renderer 一直在（即便最小化）。

**服务端要做的事**：`backgroundBatchRefresh` 每条结果成功后 `applyAccountDataMutation` 直接写盘（不再依赖 renderer 中转）。同时保留 `webContents.send`——桌面上 renderer 仍订阅它，但此时 renderer 端的 `applyBackgroundRefreshResults` 变成"更新 UI 内存快照"（不再驱动 saveToStorage）。

**为什么这是架构级、不是补丁**：如果只在服务端加个"如果没有 mainWindow 就自己落盘"分支，K-5 就在装配层里做了业务判断，违反决策卡 §1 不变量 I5"两端共用同一内核不得分叉"。正确做法是让主进程本身就是权威——桌面上也是（renderer 只是消费者，不是权威）。

**代价对比**：

| 做法 | 服务端可用性 | 桌面回归风险 | 与决策卡对齐 |
|---|---|---|---|
| A. 只在服务端入口装配层加"无 mainWindow 时落盘"分支 | ✅ | ✅ 桌面不动 | ⛔ I5 违反：内核分叉出两条落盘路径 |
| B. `backgroundBatchRefresh` 主进程直接落盘，renderer 只更新 UI | ✅ | ⚠️ renderer 侧 `applyBackgroundRefreshResults` 得改：现在它假设"我收到了就代表要更新，稍后其他调用点会 save" —— 改为"我收到时数据已在盘上，只 UI 更新" | ✅ 内核唯一权威 |
| C. 保留桌面现状，服务端派一个"虚拟 renderer"（headless 空 BrowserWindow） | ✅ | ✅ | ⛔ 决策卡明确拒绝"无头 Electron"路径 |

**推荐 B**。renderer 侧只需要在 `applyBackgroundRefreshResults` 尾部加一行显式 flush 或让它成为纯 UI 更新（因为主进程已落盘）。**这个改动必须在 K-5 派单里明确**，否则 executor 会选 A 走轻的路。

### 业务现实检查（§0.17）

K-5 是"落地服务端启动能力"，本身是决策卡已确认的 A 类核心需求，不需要走 §0.17 四问。

但派单里"面板 mainWindow 那些 send 事件哪些真的需要"这个问法**藏了一个 §0.17 陷阱**：如果按"面板不需要就丢"处理，会漏掉"主进程自己需要"的那类事件（见上）。分类必须是：

- **面板需要**：0 个。面板全部信息通过 HTTP pull 拿（`routes.ts` + panel frontend `src/webPanel/ui/**` 只 setInterval 轮询）。
- **主进程自己需要**：3 个（`proxy-account-update` / `proxy-account-suspended` / `background-refresh-result`），因为它们的下游动作是"落盘"，桌面靠 renderer 转手落盘。服务端必须由主进程自己落盘。
- **完全可以在服务端丢**：其他所有（进度、UI 提示、托盘、诊断、账号刷新弹窗、模型能力更新推送等）。

### 更好的方法建议：K-5 拆分为"薄壳 + 装配 module"

不推荐单文件写 `src/main/server.ts` 组装所有东西（会成为第二个 6900 行的 index.ts）。推荐结构：

```
src/main/
  server/
    entry.ts              # 顶层入口：读 env、拉起装配、SIGTERM handler
    assembly.ts           # accountService/proxy/webPanel deps 组装
    adminKeyStore.ts      # 服务端 AdminKeyStore（独立文件 + 0600 + env 优先）
    persistence.ts        # 主进程直接落盘的 backgroundBatchRefresh persistence 补丁
  ipc/
    panelProxyDeps.ts     # 保留，服务端也用
    webPanelWiring.ts     # 保留（内含 IPC，服务端旁路 IPC 只用其内部 class）
```

**为什么不把桌面 index.ts 也重构**：那属于 §0.18 的"错路质疑"——桌面运行良好，此刻分它到多个文件是"看似整洁而实无收益"的重构，不在本轮范围。

---

## 5. True modification scope（比派单说的略窄，也略宽）

### 5.1 略宽处（派单未点、必须做）

- **SCOPE.5**：`backgroundBatchRefresh` 在主进程侧直接落盘（见 §4 P1）——K-5 的一部分。
- **SCOPE.6**：`conf` 提升到 `package.json` 的 `dependencies`——K-5 的一部分。
- **SCOPE.7**：`adminKey` 存储从 `store.get('webPanelAdminKey')` 迁移到独立 `adminKey` 文件——K-5 的一部分（服务端形态才用；桌面保留 store 键作 fallback，或双读迁移）。

### 5.2 略窄处（派单点了、但 K-5 不做）

- **NOT.1**：`initTray` / 托盘菜单 / `updateCurrentAccount` / `traySettings` —— 桌面专属，服务端零装配。
- **NOT.2**：`createWindow` / `BrowserWindow` / `webPreferences` / `globalShortcut` / `registerShowWindowShortcut` —— 桌面专属。
- **NOT.3**：`registerProtocol` / `handleProtocolUrl` / `open-url` / 深链 —— 桌面专属。
- **NOT.4**：`autoUpdater` / `setupAutoUpdater` —— 桌面专属（服务器更新走运维流程）。
- **NOT.5**：`startKiroAuthTokenWatcher`（IDE token 反向同步）—— 服务端不 host IDE。
- **NOT.6**：`ipcMain.handle` 全部 142 通道 —— 服务端无 renderer，一条不装。
- **NOT.7**：`openBrowserInPrivateMode` / `getWindowsDefaultBrowser` —— 桌面专属。
- **NOT.8**：Kiro settings / MCP / steering 文件管理 —— 决策卡 §7 归为"语义失效"。
- **NOT.9**：机器码 IPC (`machine-id:*`)、`kproxy-*` —— 桌面专属（K-Proxy service 见 DEC.1）。
- **NOT.10**：`registration/*`（注册流程）—— 决策卡明确移出本轮 → 桌面端离线工具。
- **NOT.11**：`electron-updater` 依赖 —— 服务端不需要。
- **NOT.12**：`applyProxySettings`(`session.defaultSession.setProxy`) —— 依赖 electron `session`。

### 5.3 决定题（派单里问了、需要决策卡外补答的）

- **DEC.1 · K-Proxy MITM 服务端是否启用？**
  - 现状：K-Proxy 是本地代理拦截，用来在 Kiro IDE 出网时改写 device ID。服务端没有本地 IDE 消费方。
  - 但 K-Proxy 的 device ID 映射表（`kproxy-add-device-mapping` / `kproxy-get-device-mappings`）**被反代路径读**。
  - **建议**：服务端 K-5 加载 `initKProxyService`（因为反代要读它的映射），但**不启动 MITM 服务器**（不调 `service.start()`）。桌面不动。
  - 决策卡未明说；K-5 派单点里问这个属于合理范围。

- **DEC.2 · 反代 autoStart？**
  - 服务端启动时若 `proxyConfig.autoStart && proxyConfig.enabled` 就拉起反代——同桌面语义。
  - 不需要新逻辑，只需要装配层显式拉一次 `initProxyServer()` + 判 autoStart。

- **DEC.3 · 面板 autoStart？**
  - 服务端**总是**启面板（否则用户没法管账号），忽略 `webPanelConfig.autoStart` 开关。**这是服务端与桌面的语义差**。
  - 或者：默认改写 `webPanelConfig.enabled = true, autoStart = true`（若未配置）。
  - 决策卡未明说，建议 K-5 派单里让主 AI 或 owner 拍板。

---

## 6. Executable split（工作包 · 供多 AI 并行派发）

### 分工原则

- 所有触及 `src/main/index.ts` 的工作 = **必须串行**（多 AI 同改会撞不掉）
- 所有新增 `src/main/server/**` 的工作 = **可并行**（新文件互不冲突）
- 触及 `renderer/**` 的 = 独立于服务端子树，可并行

### 工作包表

| # | 包名 | 范围 (files) | 目标 | 依赖 | 可否并行 | 建议 AI 数 | 判定题 |
|---|---|---|---|---|---|---|---|
| W-A | 服务端入口骨架 | 新增 `src/main/server/entry.ts` `src/main/server/assembly.ts` | 一个可跑的 `node out/server/index.js`：读 `KIRO_DATA_DIR` / `KIRO_ADMIN_KEY` 等 env → 装配 accountService + WebPanelServer + ProxyServer → 拉起面板 → 若 `proxyConfig.autoStart` 拉起反代 → 装 SIGTERM/SIGINT handler | 无 | ✅ 可与 W-B/C/D 并行 | 1（守 assembly.ts 顺序） | 面板 autoStart 强制开？（DEC.3） |
| W-B | 服务端 AdminKeyStore | 新增 `src/main/server/adminKeyStore.ts` + `test/main/server/adminKeyStore.test.ts` | 独立密钥文件（`adminKey` in dataDir）+ 0600 + env `KIRO_ADMIN_KEY` 优先级 + 首启打印到 stdout 一次 + 冲突时拒启 | 无 | ✅ 可与 W-A/C/D 并行 | 1 | Windows 服务端是否要真 ACL？（建议告警不阻塞） |
| W-C | 主进程 tokens 落盘 | 修改 `src/main/index.ts:3959-4270`（`backgroundBatchRefresh` 内部）+ 修改 `src/renderer/src/store/accounts.ts:3461`（`applyBackgroundRefreshResults`）+ 新增 `test/main/backgroundRefreshPersistence.test.ts` | 主进程 refresh 成功后 `applyAccountDataMutation` 直接落盘；renderer 只更新内存快照 | 无 | ⚠️ **与 owner 的 kiroApi.ts 修改互斥**（同一 hot path）—— 需 owner 明示可动 | 1 | 桌面上要不要保留 renderer 的 saveToStorage 兜底？（推荐是） |
| W-D | 面板兼容性打通 | 新增 `src/main/server/webPanelAdapter.ts`（把 `ipc/webPanelWiring.ts:WebPanelWiring` 里 electron 依赖旁路成服务端形态，或直接组合 `new WebPanelServer + new PanelAuth`） | 服务端起面板不装 IPC handler，但配置读写 / 密钥读写等仍走独立路径 | 依赖 W-B（AdminKeyStore） | ✅ 与 W-A 并行 | 1 | 是否直接 new WebPanelServer 而弃 WebPanelWiring class？（推荐是——它 import electron） |
| W-E | conf 依赖显式化 | `package.json` | `dependencies` 加 `"conf": "^15.0.2"`；跑 `npm ls conf` 确认 | 无 | ✅ 独立 | 1（可与 W-A 合并派） | 无 |
| W-F | 服务端构建目标 | 新增 `electron.vite.config.ts` 里的 `lib` mode 或独立 `vite.server.config.ts` | 产 `out/server/index.js`，`electron` / `electron-updater` externalize | 依赖 W-A（入口存在） | ⚠️ 顺序：W-A 落盘后才能配置产物路径 | 1 | 是否要 dockerfile？（属 K-10 而非 K-5） |
| W-G | 服务端启动锁（判定题） | 无 | 决策卡已定"服务器上无需锁"—— 派单里问，答"不做"即可 | 无 | — | 0 | 派单里的判定题，无代码 |
| W-H | 桌面回归测试 | 已有 1413 测试（K-3 commit 数字） | 全绿是决策卡 I3 度量 | 全部工作包做完后串行跑 | ⚠️ 收尾 | 1 | 无 |

**8 个工作包中 6 个可并行，2 个必须串行（W-C 依赖 owner 的 hot path 窗口；W-F 依赖 W-A）。**

预估：单 AI 顺跑 3-5 个"半天"级会话；4 AI 并行则 W-A/W-B/W-D/W-E 可同一波做完，W-C 独立一波，W-F 收尾，W-H 冒烟。

### 派单提示词模板（供主 AI 用）

每个 W-x 派单必带：
1. 决策卡指针（DC 号）
2. 本文件 §5 SCOPE 里对应条目
3. 明示"不许改 `src/main/proxy/kiroApi.ts` / `test/main/proxy/rateLimitBackoffJitter.test.ts` / `src/main/proxy/proxyServer.ts` / `src/renderer/src/components/proxy/ProxyLogsDialog.tsx`"
4. 明示"不许自己 commit"
5. 允许它读 `.archive/2026-08-10/server-migration-decision/decision-card.md` 与本报告

---

## 7. Risk-intersection zones & dispatch recommendation

### 冲突热点

1. **`src/main/index.ts`** —— 只有 W-C 会碰它。**串行**给 W-C。
2. **`src/renderer/src/store/accounts.ts`** —— W-C 会碰。owner 的 kiroApi.ts 修改若涉及"刷新链路重构"可能间接触发它，需 owner 表态。
3. **`src/main/proxy/proxyServer.ts` + `src/main/proxy/kiroApi.ts`** —— owner 正在改，K-5 无一工作包应触碰。它们对 K-5 是**只读接口**（`ProxyServer` 构造签名不能改）。
4. **`ipc/webPanelWiring.ts`** —— W-D 会碰。这个文件 import electron（是刻意的），W-D 要么就地拆、要么就不用它、直接从 `webPanel/server.ts` + `webPanel/auth.ts` 拼装。**推荐后者**：改动面更小。
5. **`package.json`** —— W-E / W-F 都碰。W-F 只加脚本、W-E 只加依赖，不冲突。

### 建议派发顺序

**第一波并行（4 AI）**：
- AI-1: W-A + W-E（骨架 + 依赖显式化，同一个 assembly 视角）
- AI-2: W-B（AdminKeyStore，纯新增文件）
- AI-3: W-D（webPanel adapter，纯新增文件；等 W-B 完成 AdminKeyStore 接口即可开工）
- AI-4: W-C（主进程 tokens 落盘—— 等 owner 窗口）

**第二波（W-A 完成后）**：
- AI-1: W-F（vite/electron-vite 配置服务端产物）

**第三波（全部完成后收尾）**：
- 主 AI 自跑：W-H（全套件跑绿 + 一次真实 Linux 环境 smoke test）

### 决策卡"停止条件"实测状态

| 触发 | 判据 | 当前状态 |
|---|---|---|
| 数据不兼容 | 服务端读不出既有账号 | ✅ 未触发。`preflightAccountStoreForServer` 单测已过，`conf` + 同 encryptionKey → 结构性字节兼容 |
| 依赖无法隔离 | electron 依赖无法用注入解开 | ✅ 未触发。K-4 门禁扩到闭包内 45+ 文件全过 |
| 桌面端回归 | 1413 测试出现无法修复的失败 | ✅ 未触发。K-3 commit 报告"1413/1413 绿" |
| 装配层重写超预期 | `index.ts` 桌面接口无法干净切分 | ⚠️ **警戒**：`backgroundBatchRefresh` 的 renderer 依赖是发现的一处不干净切分，但可通过 W-C 解决（不是无解） |
| 时间冲突无解 | 自动放行与 Layer C 时间冲突 | 未触发（属 K-7 范畴，不阻塞 K-5） |

---

## 8. Domain-Model reconciliation

本任务触及跨切子系统（**持久化中间层** + **面板鉴权** + **反代池调度**）。

**尝试读**：`docs/domain/*` —— 未存在（本轮 `list_directory F:\Kiro-account-manager\Kiro-account-manager\docs` 显示：`architecture/ADR-0002-shared-kernel-extraction.md` + 其他文件，无 `domain/` 子目录）。

**结论**：无既有 domain-model 文档可对齐。ADR-0002 承担了大部分同职责（它就是决策卡 K-11 落盘产物），本轮不必新建 domain-model 文档。**旗给主 dispatcher**：如果 K-5 落地后想加"服务端 vs 桌面"的责任边界文档，建议放在 `docs/domain/server-desktop-boundary.md`，但**不是 K-5 派单的一部分**（属 K-11 的延伸）。

**判定**：[not applicable to K-5 payload]
**理由**：ADR-0002 + 决策卡本轮版本已经承担了边界文档职责；K-5 的所有跨模块改动都能在 ADR-0002 的三条决定 + 决策卡的 15 项处置里找到锚点，无新建 domain-model 的必要。

---

## 附录 A · 142 个 IPC 通道分类（K-5 全部不装）

按前缀分组统计（本轮 `git grep -oE "ipcMain\.(handle|on)\('..." -- src/main/index.ts` 排序去重得）：

| 类别 | 数量 | 服务端处置 |
|---|---|---|
| 反代 (`proxy-*`) | 39 | 不装。面板已替代（HTTP `/panel/api/proxy/*`） |
| 账号 (`account-*` / `check-*` / `refresh-*` / `switch-*` / `verify-*` / `logout-*` / `save-*` / `load-*` / `import-*` / `background-batch-*`) | 25 | 不装。面板已替代（HTTP `/panel/api/accounts/*`） |
| K-Proxy (`kproxy-*`) | 16 | 不装（DEC.1：服务端加载 service 但不启 MITM） |
| 登录流程 (`start-*-login` / `poll-*` / `cancel-*-login` / `exchange-*` / `complete-*`) | 12 | 不装（服务器不参与登录 UI） |
| 机器码 (`machine-id:*`) | 8 | 不装（决策卡 §7 归为"语义失效"） |
| Kiro settings / MCP / steering | 10 | 不装 |
| 面板 (`web-panel:*`) | 7 | 不装（面板通过 HTTP 自我服务） |
| 诊断 (`diagnose:*`) | 3 | 不装 |
| 窗口 (`window-*` + `close-confirm-*`) | 5 | 不装 |
| 托盘 (`tray-*` / `update-tray-*` / `save-tray-*` / `get-tray-*` / `refresh-tray-*`) | 6 | 不装 |
| 更新 (`check-for-updates*` / `download-update` / `install-update`) | 4 | 不装 |
| 外部链接 / 快捷键 | 6 | 不装 |
| 版本 / 平台 (`get-app-version` / `window-get-platform`) | 2 | 不装 |
| 其他 (`get-usage-api-type` / `set-*-api-type` / `compute-token-fingerprint` / `set-proxy` / `open-subscription-window` 等) | 7 | 不装 |

**总计 ~142，服务端零装**。

---

## 附录 B · `mainWindow.webContents.send` 事件全表 & 服务端处置

| 事件 | 出处 | 服务端处置 | 理由 |
|---|---|---|---|
| `proxy-request` | `initProxyServer.onRequest` | drop | 只做 UI 展示（渲染进程做实时统计），面板轮询 `/api/proxy/status` 已够 |
| `proxy-response` | `initProxyServer.onResponse` | drop | 同上 |
| `proxy-error` | `initProxyServer.onError` | drop（console.error 已足） | 面板 `/api/proxy/status.lastError` 已包含 |
| `proxy-status-change` | `initProxyServer.onStatusChange` | drop | 面板轮询已够 |
| `proxy-account-update` | `initProxyServer.onAccountUpdate` + `setProfileArnPersistCallback` + `setTokenRefreshCallbackForModelFetch` | **主进程直接落盘**（见 §4 P1） | 内含 accessToken/refreshToken/expiresAt/profileArn；桌面靠 renderer 落盘、服务端无 renderer |
| `proxy-account-suspended` | `initProxyServer.onAccountSuspended` | **主进程直接落盘** | 内含 status/lastError 更新；同上理由 |
| `proxy-held-requests-changed` | `initProxyServer.onHeldRequestsChanged` | drop | 面板轮询 `/api/proxy/status.autoReleaseEnabled` 与 `.currentEpisode` 已包含 |
| `proxy-webhook-trigger` | `setWebhookTrigger` | drop（服务端不发 webhook） | webhook 由 renderer 的 `useWebhookStore.triggerEvent` 发，服务端无该 store |
| `background-refresh-result` | `backgroundBatchRefresh:4023/4233/4251` | **主进程直接落盘**（保留 `send` 桌面用） | 见 §4 P1 —— 最承重的服务端专属改动 |
| `background-refresh-progress` | `backgroundBatchRefresh:4263` | drop | 进度显示是 UI 事项 |
| `background-check-result` | `backgroundBatchCheck` 类似 | **主进程直接落盘**（若涉及 status 更新） | 同 refresh |
| `kproxy-request` / `kproxy-response` / `kproxy-error` / `kproxy-status-change` / `kproxy-mitm` | K-Proxy autostart 分支 | drop（DEC.1：服务端不启 K-Proxy MITM） | 无消费者 |
| `accounts-data-changed` | `setAccountBroadcaster` → 全窗口广播 | drop（`BrowserWindow.getAllWindows()` 服务端返 `[]`；broadcaster 内部 loop 空跑，天然 no-op） | 面板轮询 `loadAccountsBlob` 已够 |
| `kiro-ide-token-changed` | `syncIdeTokenChangeToStore` | drop（服务端不 host IDE） | `startKiroAuthTokenWatcher` 在服务端不启 |
| `open-external` handler(`ipcMain.on`) 等 | 各 IPC | 不装 | 无 IPC 通道 |

---

## Update Log

- 2026-08-11 · 骨架落盘。八段全部有内容（§8 判为 not applicable 且给了理由）。
- 2026-08-11 · 两次工具超时（`create_directory` 一次、初版 `write_file` 一次）；改用直接 `write_file` + 追加分段落盘。stall 期间 `main` 前进到 `8e1099e`（仅 K-4 门禁测试加宽 300 行，未触及内核实现或装配层），本报告结论未失效。

*Report ends. 8 sections complete.*
