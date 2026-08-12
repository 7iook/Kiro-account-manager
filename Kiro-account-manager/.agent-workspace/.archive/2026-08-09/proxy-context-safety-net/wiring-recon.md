# 侦察报告：`enableProxyContextSafetyNet` 开关的接线面

> 模式 R · 只读侦察（未改任何代码）。仓库 `F:/Kiro-account-manager/Kiro-account-manager`，
> 分支 HEAD @ `4d60c44`。日期 2026-08-09。
> 本文件**边查边追加**，每答完一问立即落盘。

## Q1 · 模板设置 `enableTokenBufferReserve` 端到端链路

一条完整的布尔代理设置，从 UI 到 proxy 模块，共 6 段：

| # | 环节 | 位置 | 说明 |
|---|---|---|---|
| 1 | 渲染进程本地类型 | `src/renderer/src/components/proxy/ProxyPanel.tsx:85` | `enableTokenBufferReserve?: boolean` —— **ProxyPanel 自己又声明了一份 config 形状**（不是 import `ProxyConfig`），这是 Q8 的头号坑 |
| 2 | 渲染进程控件 | `ProxyPanel.tsx:1283-1287` | `<Switch id="enableTokenBufferReserve" checked={config.enableTokenBufferReserve \|\| false} onCheckedChange={checked => { setConfig(...); window.api.proxyUpdateConfig({ enableTokenBufferReserve: checked }) }}` —— 本地 state 与 IPC 双写，无 await、无回滚 |
| 2b | 联动 disable | `ProxyPanel.tsx:1305` | 数值输入框 `disabled={isRunning \|\| !config.enableTokenBufferReserve}` —— 主开关关掉时子项灰掉的既有范式 |
| 3 | preload 桥 | `src/preload/index.ts:846` → `ipcRenderer.invoke('proxy-update-config', config)` | 桥是**整体 config 透传**，不按字段枚举 → 新字段**无需改 preload 实现** |
| 3b | preload 类型 | `src/preload/index.d.ts:794` | `proxyUpdateConfig: (config: Record<string, unknown>) => ...` —— 参数是 `Record<string, unknown>`，**没有字段级 allowlist**，新字段同样无需改 |
| 4 | 主进程 handler | `src/main/index.ts:5893` `ipcMain.handle('proxy-update-config')` | 内部：`server.updateConfig(config)` → 逐字段 `if (config.X !== undefined) setX(...)`；`enableTokenBufferReserve` 在 `index.ts:5907-5909` |
| 5 | 持久化 | `src/main/index.ts:5934` `store.set('proxyConfig', newConfig)` | 注意存的是 `server.getConfig()` 的**回读结果**，不是入参 → 字段能否落盘取决于 `updateConfig` 的白名单（见 Q8） |
| 6 | proxy 模块 setter | `src/main/proxy/kiroApi.ts:112-118` | `let enableTokenBufferReserve = true` + `setEnableTokenBufferReserve` / `getEnableTokenBufferReserve`；消费点 `kiroApi.ts:1614` |

### 开机重放（这条问得对，本仓**确实有**重放，且是唯一真源）

`initProxyServer()` @ `src/main/index.ts:505` 是启动时的配置复原点：

- `index.ts:509` 读盘：`store?.get('proxyConfig')`
- `index.ts:532-545` `defaultConfig`（含 `enableTokenBufferReserve: true, tokenBufferReserve: 20000`）
- `index.ts:551` 合并：`savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig`
- `index.ts:582` **重新推给 proxy 模块**：`setEnableTokenBufferReserve(config.enableTokenBufferReserve === true)`
  （旁边 `index.ts:577-580` 是 `setPayloadSizeLimitKB`，`583-585` 是 `setTokenBufferReserve`，`587-591` 是 `setRateLimitRetryConfig`，`593-595` 是 `setAgentMode`）

**结论**：开机重放存在且集中在 `index.ts:577-595` 这一小段。新开关必须在此处补一行 `setEnableProxyContextSafetyNet(...)`，
否则症状是「UI 显示开着、重启后代理模块实际是模块级默认值」——即你担心的半接线，本仓的槽位很明确。

⚠️ 注意 `index.ts:582` 用的是 `=== true` 而非 `if (x !== undefined)`：
对 default-OFF 的新开关，等价写法是 `setEnableProxyContextSafetyNet(config.enableProxyContextSafetyNet === true)`，
这天然把 `undefined`（老用户升级）映射成 `false` —— 正好是你要的 default-OFF，且不会崩。

### 附带发现：本仓已有一次「默认值翻转」的先例，直接就是你一周后要走的路

`index.ts:553-574` 是一段**一次性迁移**，把历史落盘的 `enableTokenBufferReserve=false` 纠正为 `true`：
- 用 `store` 里 `accountDataMigration` 对象 + `FLAG='tokenBufferReserveDefaultOn'` 保证只跑一次（`index.ts:558-560, 573`）
- 注释明确点出为什么只改 `defaultConfig` 无效：**`savedConfig` 会覆盖它**，因为该字段在 `updateConfig` 白名单里，任何一次配置保存都会把当年的值落盘
- 还无条件 `store.set('proxyConfig', config)`（`index.ts:568`），理由写在注释里：`proxy-get-status` 在 server 未初始化时**原样返回 store 里的 config**，store 缺字段则渲染进程 `config.X || false` 显示"关"而主进程实际"开" → 显示与实际不一致

这段就是「一周后把默认从 OFF 翻成 ON」的现成模板 —— 抄 flag 名换一个即可。

---

## Q2 · 新布尔必改文件清单（依赖序）

**必改（5 处，缺一即半接线）**

| 序 | 文件:行 | 改什么 | 缺了会怎样 |
|---|---|---|---|
| 1 | `src/main/proxy/types.ts:~575` 附近（`ProxyConfig` interface，573-579 是 tokenBuffer 那组） | 加 `enableProxyContextSafetyNet?: boolean` + 注释 | TS 编译报错（`npm run typecheck:node`） |
| 2 | `src/main/proxy/<新模块或 kiroApi.ts>` | 模块级状态 + `set/get` | —— |
| 3 | `src/main/index.ts:577-595`（`initProxyServer` 复原段） | `setEnableProxyContextSafetyNet(config.enableProxyContextSafetyNet === true)` | **开机不重放** → 重启后 UI 显示与实际不符 |
| 3b | `src/main/index.ts:532-545`（`defaultConfig`） | 加 `enableProxyContextSafetyNet: false` | 见 Q5，不加也不崩，但 store 里长期缺字段 |
| 4 | `src/main/index.ts:5905-5915`（`proxy-update-config` handler 内） | `if (config.X !== undefined) setX(config.X)` | **改了开关当场不生效**，要重启才生效 |
| 5 | `src/renderer/src/components/proxy/ProxyPanel.tsx:85` 附近 + 控件处 | 本地 config 类型加字段 + `<Switch>` | 用户看不到开关 |

**不用改（已验证是透传，不是字段枚举）**

- `src/preload/index.ts:846` —— `proxyUpdateConfig` 直接 `ipcRenderer.invoke('proxy-update-config', config)`，整体透传
- `src/preload/index.d.ts:794` —— 签名是 `(config: Record<string, unknown>)`，无字段级 allowlist
- `src/main/proxy/proxyServer.ts:758` —— `this.config = { ...this.config, ...config }` **是无过滤展开**，新字段自动进 config、自动被 `getConfig()` 回读、自动落盘。**没有"拒绝未知字段"的校验**（Q8 问的那种 validation 不存在）
- IPC channel registry —— **不存在集中注册表**：`ipcMain.handle('proxy-update-config')` 复用既有频道，不新增频道

**可选**

| 文件:行 | 改什么 | 判断 |
|---|---|---|
| `src/main/proxy/proxyServer.ts:2310-2330`（`filterAdminConfigUpdate` allowlist） | 把新字段加进 `allowed` 数组 | **这是唯一的显式字段白名单**。不加 → 局域网/HTTP admin API 改不了该字段（本地 IPC 仍可改）。见 Q3 建议：**建议不加**，与 `port`/`apiKey` 同列排除，因为它是安全网总闸，手机误触代价大 |
| `src/renderer/src/i18n/locales/{zh,en}.ts` | 见 Q4 —— ProxyPanel 实际不走 key，走内联三元 | 按现状**不需要** |

---

## Q4 · i18n

- 机制：`src/renderer/src/i18n/index.ts`（zustand store + `getNestedValue`），语言文件 `src/renderer/src/i18n/locales/en.ts` 与 `zh.ts`，key 是点分嵌套路径。
- **缺 key 不会失败**：`index.ts:29-38` `getNestedValue` 找不到时 `return path`（原样回显 key 字符串）。没有 lint / test 闸门校验 key 完整性 —— 已核实 `git ls-files` 无 i18n 校验脚本。故「zh 和 en 都必须有」在构建层面**不成立**，只是显示会退化成 key 字面量。
- **但 ProxyPanel 根本不走 key**：`ProxyPanel.tsx:164` `const isEn = t('common.unknown') === 'Unknown'`，然后全文用 `{isEn ? 'English text' : '中文'}` 内联三元（见 `1275`、`1281` 的 Label/title）。
- **结论**：新开关的文案照抄 ProxyPanel 内联三元范式即可，**不碰 locales 文件**。想走 key 反而是偏离该文件既有约定。文案两语同时写在一行里，天然不会漏一种语言。

---

## Q6 · 该走 `holdConfig` 的富配置对象，还是再加一个模块级 `let`？

两种范式在本仓都在用，但服务不同形状：

- **模块级 `let` + set/get**（`kiroApi.ts:112`、`payloadSizeLimitKB` @ `kiroApi.ts:98`）：单个标量、无跨字段约束、无 clamp。
- **`holdConfig.ts` 富对象 SSOT**（`src/main/proxy/holdConfig.ts:47` `normalizeHoldConfig`）：**7 个字段**、有 clamp 区间（`PING_MIN/MAX`、`BUDGET_MIN/MAX`、`GRACE_MIN/MAX`）、有**跨字段约束**（`maxWaitMs ≤ totalBudgetMs`、`graceMs < totalBudgetMs`，`holdConfig.ts:52-60`）。文件头注释点明它存在的理由：「校验只在此处做，不散落进 UI/IPC/proxy 三处」。运行时用持久引用 + `Object.assign` 原地更新（`proxyServer.ts:314, 427, 766-768`），使 HoldGate 无需重启即热生效。

**建议：走模块级 `let`，不要新建 holdConfig 式模块。** 理由：

1. `holdConfig` 的全部价值是 **clamp + 跨字段校验**。一个 `boolean` 既没有区间也没有跨字段约束 —— 套上去只会得到一个 `normalizeX()` 里写 `!!value` 的空壳，是把范式当装饰。
2. 三个 per-layer 逃生开关是 **env var**（`KIRO_PROXY_LAYER_A/B/C`），不进 `ProxyConfig`，所以不存在「4 个相关字段成组」的富对象诉求。
3. 若后续该安全网长出数值参数（阈值 / 窗口大小 / 重试次数）并出现跨字段约束，**那时**再抽 `contextSafetyNetConfig.ts` 并把 boolean 一起收进去 —— 与 hold gate 的实际演化路径一致（它是先有 7 个字段才抽的 SSOT，不是先抽壳）。

---

## Q3 · Web 面板 / admin HTTP API —— 第二、第三个面

### 面板（`src/webPanel/`）：**不暴露代理配置，无需改**

这是一个刻意的设计决定，有代码内注释作证，不是遗漏：

- `src/main/webPanel/routes.ts:93-96`（服务端路由契约声明）：
  > 「为什么没有 `proxyUpdateConfig` 这样的通用配置端点：`proxy-update-config` 有大量副作用分支（日志开关 / payload 上限 / agent 模式 / steering 重载），从手机误触的代价远大于收益。面板只暴露日常操作，端口 / API Key / 模型映射留在桌面端。」
- 客户端侧同一结论：`src/webPanel/api/panel.ts:252-254`。
- 面板反代能力仅 5 个端点（`routes.ts:99-115`）：`proxyGetStatus` / `proxySyncPool` / `proxyActivateAccount` / `proxyStart` / `proxyStop` —— 全部无配置参数（`panel.ts:245-275`）。
- `src/webPanel/ui/ProxyPanel.tsx` 只有选号 + 启停（文件头注释 1-20 行说明了「运行态绝不乐观更新」）。

组件/类型共享程度：面板**不复用**桌面 `ProxyPanel`，是独立组件；仅通过 vite alias `@renderer` 复用 `components/ui/` 纯展示件（`vite.webPanel.config.ts:56-62` 注释：「零 `window.api` 依赖」）。传输路径完全不同：桌面走 `ipcRenderer.invoke`，面板走 `HTTP /panel/api/*`（`webPanel/api/client.ts` + cookie `Path=/panel`）。

**成本结论**：新开关**不需要**出现在面板。如果硬要加，成本是「新增 HTTP 端点 + 路由 + 服务端 deps 注入 + 客户端 api 函数 + UI 控件」≈ 5 个文件，且**违反上面这条已成文的边界决定** —— 建议不加，若要加须先推翻 `routes.ts:93` 的决定。

### admin HTTP API（第三个面）：真实存在，且**这里有一个既有的半接线 bug**

- 路由：`proxyServer.ts:2204`（GET）/ `2207`（POST）；e2e 用例 `test/e2e-fullsuite/cases/30-admin-config-apikeys.mjs:16` 只打 GET。
- POST 路径：`proxyServer.ts:2213` `filterAdminConfigUpdate(parsed)` → `2216` `this.updateConfig(safeUpdate)`。

⚠️ **`enableTokenBufferReserve` 在 admin allowlist 里（`proxyServer.ts:2317`），但 `updateConfig`（`proxyServer.ts:746-781`）只对三类字段做副作用同步**：hold* 组（`766-768`）、`injectExecutionDirective`（`769-771`）、`accountSelectionStrategy`（`773-775`）。**它不调 `setEnableTokenBufferReserve`，也不写 store。**

即：经 admin API 改 `enableTokenBufferReserve` → `this.config` 变了、GET 回读也变了、**但 `kiroApi.ts:112` 的模块级变量没变、盘上没变** → 「接口 200、配置显示已改、实际裁剪行为不变、重启后还原」。副作用同步逻辑只存在于 `index.ts:5900-5925` 的 IPC handler 里，admin HTTP 路径绕过了它。

**这是既有缺陷，不是本次任务引入的**（登记，不建议本轮顺手扩大改动范围）。对本次任务的直接含义：**新开关不要加进 `filterAdminConfigUpdate` 的 allowlist** —— 加进去只会复制这个失效形态。与 `port` / `apiKey` / `tls` 同列排除即可（`proxyServer.ts:2329-2330` 已有「故意排除」注释块，新开关注释一句写在那里）。

---

## Q5 · default-OFF 机制与老用户升级

**默认值只活在代码里，没有 store schema。** `src/main/index.ts:1961` 的 `new Store({ name: 'kiro-accounts', encryptionKey: ... })` —— **未传 `schema`，未传 `defaults`**。electron-store 因此不做任何字段校验，也不注入默认值。所以：

- **不存在「validation 拒绝未知字段」**（Q8 问的那种）。任意字段都能落盘。
- 默认值有**两个**来源，且必须一致：
  1. `index.ts:532-545` `defaultConfig`（进程内合并用）
  2. `kiroApi.ts:112` 模块级初值（proxy 模块自己的初始状态）

**老用户升级路径（逐步推演，无崩溃风险）**

1. store 里 `proxyConfig` 存在但**缺**新字段。
2. `index.ts:551` `{ ...defaultConfig, ...savedConfig }` —— `savedConfig` 里该 key 不存在，故**不会覆盖** `defaultConfig` 的值 → 拿到 schema 默认 `false`。
   （⚠️ 反面：若 `savedConfig` 里显式存了 `undefined`，展开会覆盖成 `undefined`。对 boolean + `=== true` 判据无害。）
3. `index.ts:582` 范式 `setX(config.X === true)` → `undefined === true` → `false`。**default-OFF 天然正确，不崩。**
4. 渲染进程 `ProxyPanel.tsx:1284` 范式 `checked={config.X || false}` → `undefined || false` → 显示关。**一致。**

**结论：写 `defaultConfig: false` + `=== true` 判据 + `|| false` 显示，三处一致，老用户升级即得 OFF，无迁移代码需求。** 一周后翻 ON 时再抄 `index.ts:553-574` 的一次性迁移块（换 FLAG 名）。

---

## Q7 · 测试现状

**没有 renderer → store → main → proxy 的端到端往返测试。** 已核实 `git ls-files test/` 无此类用例。存在的是三类局部：

| 类型 | 位置 | 覆盖什么 |
|---|---|---|
| 默认值锁定 | `test/main/proxy/contextTrimGuard.test.ts:34-36` | `expect(getEnableTokenBufferReserve()).toBe(true)` —— 直接断 proxy 模块 getter，**不经 store/IPC** |
| 配置归一化单测 | `test/main/proxy/holdConfig.test.ts` | clamp / 跨字段约束（纯函数） |
| **架构装配闸门**（最相关） | `test/main/architecture/proxy_orchestration_wiring.test.ts` | 静态读源码文本断言「生产路径确有调用者」。文件头明确写：本仓反复出现「模块写好、单测全绿、生产路径没有任何调用者」（E-052），故用静态断言而非「我记得接了」。`stripComments()`（`:26-28`）先剥注释，防「注释里提到了」被当成真实调用 |

**新开关的测试应当长这样（两条）**

1. **默认值锁定**（抄 `contextTrimGuard.test.ts:34`）：`expect(getEnableProxyContextSafetyNet()).toBe(false)`。一周后翻默认时这条测试**必须同步改** —— 它就是「默认值的唯一真源断言」。
2. **装配闭环闸门**（抄 `proxy_orchestration_wiring.test.ts` 范式，这是本仓治 E-052 的既有武器，正对你担心的半接线）：静态断言 `stripComments(read('src/main/index.ts'))` 同时匹配
   - `initProxyServer` 复原段里有 `setEnableProxyContextSafetyNet(`
   - `proxy-update-config` handler 里有 `config.enableProxyContextSafetyNet !== undefined`
   缺任一条 → 测试红，附上失败说明「设置能存但开机不重放 / 改了当场不生效」。
   这比端到端测试便宜得多，且正好卡住本仓已实证过的失效形态。

---

## Q8 · 会咬人的坑（按严重度）

### 坑 1 ⛔ Layer A 已上线且**部分无条件** —— 别整段塞进新开关（你的担心已确认，且比预期更细）

`trimHistoryByTokens` 有**两个调用点，闸门状态不同**：

| 调用点 | 位置 | 是否受 `enableTokenBufferReserve` 管 |
|---|---|---|
| ① 预防式（出站前按 effective limit 主动裁） | `kiroApi.ts:1614-1621`，包在 `if (enableTokenBufferReserve) {` 里 | **受管** |
| ② 响应式（上游已回 `CONTENT_LENGTH_EXCEEDS_THRESHOLD` 后按比例裁再重试同端点） | `kiroApi.ts:2196` | **不受管，无条件** |

②在 `kiroApi.ts:2187` 的 `if ((error).message.includes('CONTENT_LENGTH_EXCEEDS_THRESHOLD'))` 分支内，**没有任何开关包裹**，并被 `test/main/proxy/contextOverflowRecovery.test.ts:88/103/115` 三条测试锁住（有限次退出 / 真的裁掉最旧 history / 不留 orphan toolResult）。

**风险的确切形状**：如果「Layer A 截断占位符」被加在 `trimHistoryByTokens` **函数体内部**（`kiroApi.ts:1424-1472`），那它同时服务①②两个调用点。此时若有人图省事把闸门加在函数入口（`if (!enableProxyContextSafetyNet) return {trimmed:0,...}`），后果是**连②这条无条件的溢出恢复路径一起关掉** → 400 之后不再裁剪重试 → 直接回归到 2026-07-26 那个 RCA 修掉的缺陷。而 `contextOverflowRecovery.test.ts` 会变红，算是有网 —— 但那时已经浪费一轮。

**给执行者的硬约束**：新开关只准包在**Layer B / C 各自的调用点**上，绝不加在 `trimHistoryByTokens` 函数入口，也不加在 `kiroApi.ts:2187` 的溢出恢复分支上。若 Layer A 的占位符逻辑确实在函数体内，它应保持无条件。

### 坑 2 ⛔ 配置形状声明在两处，必须手动同步

- 真源：`src/main/proxy/types.ts` 的 `ProxyConfig`（`:539-...`）
- 副本：`src/renderer/src/components/proxy/ProxyPanel.tsx:85` 附近**自己又写了一份 config interface**，不是 `import type { ProxyConfig }`

两处不同步的表现：主进程认得该字段、UI 里 `config.newField` TS 报错或静默 `undefined`。**没有闸门测试卡住这个漂移** —— 已核实 `test/main/architecture/` 无此项断言。

### 坑 3 ⚠️ 唯一的显式字段白名单在 admin API，且它是个**半接线陷阱**

`proxyServer.ts:2311-2330` `filterAdminConfigUpdate` 的 `allowed` 数组 —— 见 Q3：加进去的字段能改 `this.config` 却**不触发 setter、不落盘**（因为 `updateConfig` 只同步 hold* / `injectExecutionDirective` / `accountSelectionStrategy` 三类）。**建议不加**，并在 `:2329` 的「故意排除」注释块补一行说明。

### 坑 4 ⚠️ `updateConfig` 是无过滤展开 —— 好事也是坏事

`proxyServer.ts:758` `this.config = { ...this.config, ...config }`。好处：新字段零改动即可流经 config 并落盘。坏处：**它不会提醒你忘了写 setter 同步** —— 字段静默进 config、GET 回读正常、盘上也有，唯独 proxy 模块的行为没变。这正是坑 3 那个 bug 的机制，也是新开关最容易复制的失效形态。**判据：改完后必须问「`kiroApi` 里那个模块级变量真的变了吗」，而不是「config 里有了吗」。**

### 坑 5 ⚠️ UI 是手写 JSX，不从类型生成

`ProxyPanel.tsx` 的控件是逐个手写（`:1275-1310` 那一段是 Token Buffer 组），不存在「从静态数组渲染设置项」的机制 —— 所以不存在「忘了往数组里加一项」的坑，但也意味着**没有任何东西提醒你 UI 少了一个开关**。

### 坑 6 ℹ️ `isRunning` 的 disabled 语义要选对

既有两种范式并存：
- `enableTokenBufferReserve`：`disabled={isRunning}`（`:1289`）—— 运行中禁止改
- hold gate 参数：**不受 `isRunning` 限制**，注释写「运行时热生效」（`ProxyPanel.tsx:1310` 上方）

新开关属哪种取决于 Layer B/C 能否热切换。若模块级变量一改即生效（如 `enableTokenBufferReserve` 的消费点 `kiroApi.ts:1614` 是每次请求读），技术上是热的，但既有那个开关仍选了 `disabled={isRunning}`。**建议跟 `enableTokenBufferReserve` 一致用 `disabled={isRunning}`** —— 它是同一类「改变出站 payload 构造」的开关，行为分叉会让用户困惑。

### 坑 7 ℹ️ 未跟踪新文件的检索盲区（已核查，当前无影响）

`git status --short -- src/main/proxy/` 本轮返回**空**，`list_directory` 也确认 `src/main/proxy/` 下**尚无** `rtk/` 目录或 `streamWatchdog.ts`。即并发 SUB 此刻还没落盘。故本报告的所有 `git grep` 结论**未受未跟踪文件影响**；但后续若要判断「某符号全仓不存在」，必须补一次 `everything-search` / `list_directory`（`git grep` 对未跟踪文件盲）。

---

## 主分派者需要的结论汇总

**真实改动范围：4 个文件、5 个必改点。**

1. `src/main/proxy/types.ts` —— `ProxyConfig` 加字段（放在 `:573-579` tokenBuffer 组旁边，语义相邻）
2. `src/main/proxy/kiroApi.ts`（或 Layer B/C 所在新模块）—— 模块级 `let` + `set`/`get`（抄 `:112-118`）
3. `src/main/index.ts` —— 三处：`defaultConfig`（`:544` 后）、`initProxyServer` 复原（`:582` 后）、`proxy-update-config` handler（`:5909` 后）
4. `src/renderer/src/components/proxy/ProxyPanel.tsx` —— 本地 interface（`:85`）+ `<Switch>`（抄 `:1281-1291`）

**不改**：preload（透传）、webPanel 全部（刻意无配置面）、`filterAdminConfigUpdate`（会复制半接线 bug）、i18n locales（ProxyPanel 走内联三元）。

**并行拆分建议**：这 4 个文件构成**一条串行链**（types → proxy 模块 → index 接线 → UI），且 `kiroApi.ts` 正被并发 SUB 编辑 → **不建议拆包并行**。单个执行者顺序做完，成本远低于协调冲突。若一定要拆，只能把「Layer B/C 实现」与「开关接线」分开，且接线包必须等实现包定下 setter 名字。

**风险交叉区**：`src/main/proxy/kiroApi.ts` —— 并发 SUB 正在改此文件；接线也要动它（模块级 `let` 段 `:98-140`）。建议接线在 SUB 完成后串行进行，或把新开关的 set/get 放进 Layer B/C 的**新模块**里以物理避开冲突（推荐后者）。

**建议给执行者的两条测试**：见 Q7 —— 默认值锁定 + 装配闸门（`proxy_orchestration_wiring.test.ts` 范式）。
