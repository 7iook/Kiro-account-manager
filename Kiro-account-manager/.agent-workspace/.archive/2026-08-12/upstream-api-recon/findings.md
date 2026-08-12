# 上游 API 四函数抽取侦察报告

- 模式：Mode R · 现实侦察（只读，不改任何源文件，不提交）
- 仓库：`F:\Kiro-account-manager\Kiro-account-manager`，分支 main @ `3354d50`
- 日期：2026-08-12
- 目标：让 headless server 模式能自动刷新 token（成功状态：Linux 服务器上跑、本机关机后反代持续服务 + 手机面板持续管账号），而不 fork 第二套刷新实现、不把 Electron 状态泄漏进共享模块。

> 状态：进行中（增量落盘）。锚点全部本轮亲验，行号以本文为准 —— 任务书给的行号已漂移。

## 0. 锚点校正（任务书 → 实测）

| 符号 | 任务书行号 | 实测行号 | 备注 |
|---|---|---|---|
| `currentUsageApiType` | ~285 | **292** | `let`，模块级可变 |
| `setUsageApiType` | — | **294** | **已 export** |
| `getNetworkAgent` | — | **318** | 模块私有 |
| `fetchWithAppProxy` | ~335 | **342** | 模块私有 |
| `refreshTokenByMethod` | ~1170 | **1170** ✅ | 未漂移 |
| `refreshTokenByMethodInner` | ~1187 | **1187** ✅ | 未漂移 |
| `getCurrentMachineId`（index.ts 本地） | ~1221 | **1230** | 与 `machineId.ts` 同名导出不是一回事 |
| `ssoDeviceAuth` | ~1248 | **1248** ✅ | 未漂移 |
| `getUsageAndLimits` | ~1748 | **1748** ✅ | 未漂移 |
| `getUserInfo` | ~1902 | **1902** ✅ | 未漂移 |

`src/main/index.ts` 实测 6954 行（不是 7200）。

## 1. 待填

（后续章节增量写入）

## 2. 四函数的真实依赖闭包（本轮亲验）

### 2.1 依赖图（自底向上）

```
safeCreateProxyAgent / getSystemProxy   ← 已在 ./proxy/systemProxy（外部模块，非 index.ts 私有）
        ↑
getNetworkAgent (index.ts:318)          ← 读模块级 useKProxyForApi(:305) + getKProxyService()
        ↑
fetchWithAppProxy (index.ts:342)        ← 纯 HTTP，唯一状态来源是 getNetworkAgent
        ↑
        ├── refreshOidcToken (:1001)        → 委托 ./oidcRefresh 的 refreshOidcTokenAcrossRegions（已外部模块，接受 fetcher 注入！）
        ├── refreshSocialToken (:1032)      → + getCurrentMachineId(:1230) + getKiroUserAgent(:1219)
        ├── refreshExternalIdpToken (:1099) → + validateMicrosoftTokenEndpoint(:1080)
        │        ↑
        │   refreshTokenByMethodInner (:1187)  ← 三分支路由，纯判定
        │        ↑
        │   refreshTokenByMethod (:1170)       ← single-flight，读写模块级 Map inFlightRefreshByToken(:1168)
        │
        ├── ssoDeviceAuth (:1248)           → 7 次 fetchWithAppProxy，无其它模块状态
        │
        ├── kiroApiRequest (:1421)          → + getCurrentMachineId + getKProxyAgent(:362) + getKiroAmzUserAgent(:1224)
        │                                     + generateInvocationId(:1209) + cbor-x encode/decode
        │        ↑
        │   getUserInfo (:1902)             ← 一行委托 kiroApiRequest('GetUserInfo')
        │
        └── getUsageLimitsRest (:1610)      → + getCurrentMachineId
                 ↑
             getUsageAndLimits (:1748)      ← 读模块级 currentUsageApiType(:292) 选 rest/cbor 分支
```

### 2.2 逐函数签名

**`refreshTokenByMethod(token, clientId, clientSecret, region='us-east-1', authMethod?, proxyUrl?, externalIdp?: {tokenEndpoint?, scopes?}) → Promise<OidcRefreshResult>`**
`OidcRefreshResult`(:1085 附近声明) = `{ success, accessToken?, refreshToken?, expiresIn?, error?, resolvedRegion? }`。
关键状态：`inFlightRefreshByToken: Map<string, Promise<OidcRefreshResult>>`（:1168）—— 按 refresh token 去重的 single-flight。头部注释明确：这就是防「并发刷同一个 rotating refresh token → 后到的用已作废 token → 401 → 账户被踢下线」的那道闸。**这是整个抽取里最不能出错的一块状态。**

**`ssoDeviceAuth(bearerToken, region='us-east-1') → Promise<SsoAuthResult>`**
`SsoAuthResult` = `{ success, accessToken?, refreshToken?, clientId?, clientSecret?, region?, expiresIn?, error? }`。7 步设备授权全走 `fetchWithAppProxy`，**不读任何模块级可变状态**（最干净的一个）。

**`getUsageAndLimits(accessToken, idp='BuilderId', profileArn?, accountMachineId?, ssoRegion?, email?, authMethod?) → Promise<UnifiedUsageResponse>`**
读 `currentUsageApiType` 决定 rest / cbor 分支。内含两条业务归一化（social 兜底 ARN `KIRO_SOCIAL_PROFILE_ARN`；ksk_ 账户绝不能注入兜底 ARN，附 RCA 引用）——抽取时必须整块搬走，不能只搬壳。

**`getUserInfo(accessToken, idp='BuilderId', accountMachineId?, email?) → Promise<UserInfoResponse>`**
单行委托 `kiroApiRequest<UserInfoResponse>('GetUserInfo', { origin: 'KIRO_IDE' }, ...)`。真正的重量在 `kiroApiRequest`。

### 2.3 Electron 依赖结论（第 3 问）

**四函数及其全部传递闭包（`fetchWithAppProxy` / `getNetworkAgent` / `kiroApiRequest` / `getUsageLimitsRest` / 三个 refresh 分支 / `getCurrentMachineId` / UA 生成 / `generateInvocationId`）没有一处 touch Electron。** 用到的是 `undici`、`cbor-x`、`node:url`、`process.env`，以及已在 index.ts 之外的 `./proxy/systemProxy`、`./oidcRefresh`。

也就是说：**抽取在本质上是机械的**——它们不是「Electron 纠缠」，而是「被困在一个 import 了 electron 的文件里」。唯一真正的耦合是 3 个模块级可变状态（`useKProxyForApi`、`currentUsageApiType`、`inFlightRefreshByToken`）+ 1 个服务单例访问器（`getKProxyService()`），全部与 Electron 无关。

## 3. 关键发现：缝位是 7 个方法，但只有 4 个需要抽取

`assembly.ts:113-134` 的 `unwiredAccountApi()` 让**全部 7 个**方法抛错，`AccountServiceApi`（`accountService/types.ts:106-146`）也是 7 个成员。但实测 `index.ts:3855-3863` 的桌面装配：

| 缝位方法 | 来源 | 需要抽取？ |
|---|---|---|
| `getUsageAndLimits` | index.ts:1748 模块私有 | **是** |
| `getUserInfo` | index.ts:1902 模块私有 | **是** |
| `refreshTokenByMethod` | index.ts:1170 模块私有 | **是** |
| `ssoDeviceAuth`（仅 verify.ts 的 `VerifyApiDeps` 用，不在 `AccountServiceApi` 里） | index.ts:1248 模块私有 | **是** |
| `fetchEnterpriseProfileArn` | **`./proxy/kiroApi` 的 import**（index.ts:23） | **否** —— 直接 import |
| `readKiroAuthTokenFile` | **`./kiroAuthSync` 的 import**（index.ts:45-47） | **否** |
| `writeKiroAuthTokenFile` | **`./kiroAuthSync` 的 import** | **否** |
| `resolveProfileArnForWrite` | **`./kiroAuthSync` 的 import**（index.ts:50） | **否** |

桌面侧 `api:` 对象是**纯符号转发**（无 wrapper、无闭包），后 4 个只是把已有 import 原样传进去。

**含义（对派发很重要）**：装配层今天让 7 个全抛，其中 4 个本可以立刻接上 —— `assembly.ts` 直接 import `kiroAuthSync` / `proxy/kiroApi` 即可，**不依赖任何抽取工作**。这是一个可以立即并行、零风险、不碰 index.ts 的工作包。但要先确认 `kiroAuthSync.ts` 已在内核闭包内（`accountService/verify.ts` 入口可达它 —— 待验，见 §5）。

## 4. 先例判读（第 5 问）

### 4.1 三次抽取的既定姿态（读 commit message）

- **`181b169`（K-1，断 electron）** 定的姿态，明确写了：「把平台差异推到装配层，共享代码里删掉分支；**不做 DI 容器，不用动态 import 规避静态依赖**」。三种手法：值导入删掉（logger 的 `app.isPackaged` → 装配层 `setLogTruncationEnabled()`）、路径注入（kproxy 的 userDataPath）、抽端口两端各给实现（secureBackup 的 `BackupCipher`）。
- **`afe80af`（K-3，持久化端口）** 立的规矩：端口只放**实测有消费者**的成员（66 处 `store.get/set` + 2 处 `path` → 端口就 3 个成员；`onDidChange`/`has`/`delete` 等全仓零消费，不进端口）。并且「两个命名函数而非 `{checkWritable?: boolean}`」—— 默认值是日后「统一一下」的冲动会翻转的东西，且翻转在调用点不留痕迹。
- **`3adda90`（K-5，服务端入口）** 明确记录了当前这个缺口，并给出处置：「抽那一层是独立工作包；落地后 `assembleServer({accountApi})` 直接接，本批文件零改动。」**本任务就是那个 commit 已经指定的工作包。**

### 4.2 `verify.ts` 的先例是否仍然成立 —— **不成立了**

`accountService/verify.ts:1-19` 头部原文写的理由是两条：

> 「把它们搬出来是另一个 executor 量级的改动，**且会与并行 executor（check-account-status / refresh-account-token 也调这些函数）撞车**。」

`index.ts:1955-1957` 的 `verifyApiDeps` 注释同款：

> 「故以函数引用注入，而不是搬移实现（**搬移会与并行修改这些函数的工作撞车**）」

两处理由的承重部分都是**调度冲突**（当时有并行 executor 在改这些函数），不是架构判断。附带的技术描述「闭包引用 index.ts 的模块级可变状态」本轮已亲验为**只有 3 个可变状态 + 1 个服务单例访问器，且全部与 Electron 无关**（§2.3）。

**判读结论**：`verify.ts` 的注入契约本身应当保留（它是稳定的、已验证的、有消费者的缝位形状 —— 拆掉它才是浪费）；但它「不搬移实现」的**理由已经过期**。当时不搬是因为会撞车，今天不搬则意味着服务端拿不到刷新能力（Critical）。而且抽取完成后 `verify.ts` 一行都不用改 —— 注入契约照旧，只是喂给它的实现从 index.ts 私有函数换成共享模块导出。

**这也回答了「情况是否变了」**：变了两处 —— ① 当时的并行撞车已结束（三次抽取都已落地）；② 当时没有服务端形态，所以「不搬」的代价是零，今天「不搬」的代价是成功状态不成立。

## 5. 可变状态归属（第 2 问）—— 逐项裁决 + 理由

抽取要搬走的三个模块级可变状态 + 一个服务访问器。**四项答案各不相同**，理由比选择重要。

### 5.1 `inFlightRefreshByToken`（:1168，single-flight Map）→ **成为新共享模块的模块级状态**

**唯一正确答案，不能注入、不能参数化。** 理由：它的语义是「同一个进程内，同一个 refreshToken 至多一个在飞的刷新」。这个不变量的作用域**就是模块实例**。如果做成注入的 Map，就多了一个「谁传进来」的问题，而任何一个调用方漏传或传了新的 Map，去重就静默失效 —— 失效表现正是 `:1161-1166` 注释描述的「账号被上游踢下线」，且只在生产并发下出现。做成模块级私有 `const` 则物理上不可能被传错。

注意这与 `AccountRuntimeDeps.refreshInFlightIds`（`types.ts:172`，按**账号 id** 去重的 Set）是**两层不同的去重**，各自有独立理由，不要合并：前者按 token 去重在 API 层，后者按账号 id 去重在调度层。桌面装配传的是 `poolRefreshInFlightIds`（index.ts:3876）。

### 5.2 `currentUsageApiType`（:292，rest/cbor 开关）→ **注入 getter，但 getter 的真源留在各自装配层**

实测消费面极窄：**全仓只有 2 个写入点，都在 index.ts**（`:534` 启动时从 `store.get('usageApiType')` 载入、`:5668` IPC `set-usage-api-type`），读取点在 `getUsageAndLimits:1774` 与 IPC getter `:5662`。preload 只暴露 `getUsageApiType`。

裁决：新模块暴露 `getUsageApiType: () => 'rest' | 'cbor'` 作为**注入的 getter**，不在新模块里放 `let currentUsageApiType`。理由：这是**用户设置**，真源是 store（`usageApiType` 键），两端的 store 都已经通过 K-3 的 `AccountStorePort` 统一了。让新模块持有一份 `let` 会造出第二个真源 —— 桌面 IPC 改了它、store 里也改了，但如果新模块那份没同步，就出现「设置页显示 cbor、实际发 rest」，且没有任何报错。

**这正是任务书警告的那个陷阱的正解**：注入 getter 本身不危险，危险的是「getter 读的是 desktop 模块状态」。此处 getter 读的是 **store**（两端共有的端口），不是 Electron 侧状态。桌面装配传 `() => currentUsageApiType`（保留现有 IPC 语义不变），服务端装配传 `() => (store.get('usageApiType') ?? 'rest')`。两边读同一个真源，只是桌面多了一层内存缓存（现状，不改）。

### 5.3 `useKProxyForApi` + `getKProxyService()`（:305 / :320）→ **注入 `getAgent: () => Dispatcher | undefined`，整块下沉**

不要把 `useKProxyForApi` 和 `getKProxyService` 分别注入。新模块只需要一个能力：「给我这次请求该用的 agent」。理由：`getNetworkAgent()` 的四级优先级（K-Proxy → env → 系统代理 → 直连）是一段**策略**，不是状态；把它拆成两个注入项会让策略散在两端装配层，日后改优先级要改两处 —— 这就是 `afe80af` 记的「端口只放实测有消费者的成员」和 `181b169` 记的「共享代码里删掉分支，平台差异推到装配层」的同款判断。

`kproxy/index.ts` **已是内核入口**（gate 的 `KERNEL_ENTRY_POINTS` 第 1 项）且实测无 electron 引用，`proxy/systemProxy.ts` 也无 —— 所以 `getNetworkAgent` 整个函数**可以直接搬进新模块**，两端共用同一份策略，只有 `useKProxyForApi` 这一个布尔量作为注入的 getter（桌面 IPC 可切，服务端固定 false —— 见 §7 停止条件里的说明）。

**推荐形态**：新模块导出 `createUpstreamApi(deps)` 工厂，`deps = { getAgent | (useKProxy getter + kproxyService getter), getUsageApiType, getMachineId }`；single-flight Map 在工厂闭包内（每个进程只建一个实例，装配层保证）。工厂而非模块级函数的理由：让「一个进程一个实例」在类型上可见，且测试可以造独立实例而不互相污染 single-flight 表。

### 5.4 `getCurrentMachineId`（:1230）→ **注入 getter**（`() => string | undefined`）

它只是 `getKProxyService()?.getDeviceId()`。若已按 5.3 注入 kproxyService，可以不单独注入。**必须在报告里点明的坑（任务书已提示，本轮确认）**：`index.ts:1230` 的本地 `getCurrentMachineId` 与 `machineId.ts` 的同名导出**不是一回事** —— 后者是**系统机器码**命名空间（UUID / Windows 注册表 MachineGuid），index.ts 在 `:6710` 通过 `machineIdModule.getCurrentMachineId()` 调它。两者混用的后果有先例：`index.ts:1978-1982` 注释记录 `fce8c89` 曾误注入 `generateRandomMachineId`，产出 UUID 形态拼进 UA 后匹配不上 `kproxy/mitmProxy.ts:17 KIRO_UA_REGEX`（只认 64 hex），设备 ID 改写对 ksk_ 账号**静默失效**。抽取时新模块需要的是**账号绑定域**那个（kproxy 的 `getDeviceId`）。建议新模块里改名为 `getDeviceIdForUa` 之类，物理上消除同名歧义。

## 6. 桌面侧风险（第 4 问）

### 6.1 全部桌面调用点（实测，逐一亲验）

`refreshTokenByMethod` —— 7 个调用点，全部是**符号引用传递或直接调用**，无一个依赖闭包状态之外的东西：

| 行 | 场景 | 形态 |
|---|---|---|
| `:638` | `ProxyServer.onTokenRefresh` 回调 | 直接调用 —— **这就是服务端最需要的那条路** |
| `:824` | `setTokenRefreshCallbackForModelFetch`（fetchKiroModels 403 自愈） | 直接调用 |
| `:2339` | `runProactiveRenewal`（主动续期） | 直接调用 |
| `:3760` | 账号连通性/预检路径（needsRefresh 时先刷） | 直接调用 |
| `:3859` | `accountServiceDeps.api` 装配 | 符号引用 |
| `:4072` | `switch-account` IPC → `switchAccountToIde` deps | 符号引用 |
| `:4098` | `buildSwitchCliDeps()` → `switchAccountToCli` deps | 符号引用 |
| `:4201` | web 面板路由 deps（`switchAccountToIde` 复用） | 符号引用 |
| `:1963` | `verifyApiDeps`（verify.ts 注入契约） | 箭头函数包一层 |

`getUsageAndLimits` / `getUserInfo`：`:3857/:3858`（accountServiceDeps）+ `:1959-1962`（verifyApiDeps）。`ssoDeviceAuth`：仅 `:1958`（verifyApiDeps）—— 消费面最小。

**结论：没有任何调用点依赖「这些函数与 index.ts 其它代码共享闭包」这一事实。** 它们只依赖 §5 那四项。抽取后 index.ts 侧改为 `import { ... } from './upstreamApi'`（或从工厂实例解构），全部 9 处调用点**写法不变**。

### 6.2 共享可变状态的耦合（任务书特别问的那条）

**两个函数读同一个可变量的情形，实测只有一处**：`getUsageAndLimits`（`:1774`）与 IPC getter（`:5662`）读同一个 `currentUsageApiType`。按 §5.2 的裁决（注入 getter，真源留 store）这个耦合**被刻意保留**：桌面侧 getter 仍返回 `currentUsageApiType` 那一份，IPC 语义零变化。

`inFlightRefreshByToken` 只有 `refreshTokenByMethod` 一个读写方，抽取后仍然如此 —— 但**这是必须刻意保证的**：如果 index.ts 侧和服务端各自 `createUpstreamApi()` 建两个实例，同一进程内就有两张 single-flight 表。桌面进程只应有一个实例（在模块级建、或在装配处建一次并复用）。**这是本工作包最重要的单条验收项，建议写成门禁**（源码级断言：`createUpstreamApi` 在 `src/main/` 下调用点数量 ≤ 每个进程一次），理由与 `afe80af` 给 `persistence_port_wiring.test.ts` 的理由同款：端口级行为测试在「有人绕过」时照样绿。

### 6.3 启动顺序假设

一处实测风险：`getNetworkAgent` → `getKProxyService()` 在 kproxy 服务未启动时返回 undefined（`:320-327` 有 `?.isRunning()` 守卫，安全）。但 `setUsageApiType` 在 `:534` 才从 store 载入 —— 在那之前调 `getUsageAndLimits` 会拿到默认 `'rest'`。这个时序**现状即如此**，抽取不改变它；但若按 5.2 让服务端 getter 直读 store，服务端反而没有这个窗口（更好，不是回归）。工厂实例化时机需在 store 就绪后（与 `afe80af` 记的 `accountDeps.getStore` 用惰性 getter 同一理由），故 deps 里给的是 **getter 而不是值**。

## 7. 真实修改范围（抽取跨度实测）

新建 `src/main/upstreamApi/`（建议拆两文件，理由见工作包）。需要搬走的 index.ts 片段：

| 行段 | 内容 | 性质 |
|---|---|---|
| `262` | `KIRO_API_BASE` | 常量 |
| `266-274` | `KIRO_REST_API_ENDPOINTS` / `..._V1_FALLBACK` | 常量 |
| `276-288` | `getRestApiBase` / `getFallbackRestApiBase` | 纯函数 |
| `290-301` | `UsageApiType` / `currentUsageApiType` / `setUsageApiType` / `getUsageApiType` | **状态 —— 按 §5.2 处理，不整块搬** |
| `303-334` | `useKProxyForApi` 及其 get/set / `getNetworkAgent` | **状态 + 策略 —— 按 §5.3 处理** |
| `336-365` | `fetchWithAppProxy` / `getKProxyAgent` | 搬（纯函数） |
| `367-378` | `OidcRefreshResult` / `KIRO_AUTH_ENDPOINT` | 类型 + 常量 |
| `1001-1030` | `refreshOidcToken` | 搬 |
| `1032-1068` | `refreshSocialToken` | 搬 |
| `1070-1098` | `MICROSOFT_TOKEN_ENDPOINT_HOSTS` / `validateMicrosoftTokenEndpoint` | 搬 |
| `1099-1157` | `refreshExternalIdpToken` | 搬 |
| `1161-1185` | `inFlightRefreshByToken` + `refreshTokenByMethod` | 搬（Map 按 §5.1 留模块级/工厂闭包） |
| `1187-1206` | `refreshTokenByMethodInner` | 搬 |
| `1208-1226` | `generateInvocationId` / `KIRO_VERSION` / `getKiroUserAgent` / `getKiroAmzUserAgent` | 搬 |
| `1230-1234` | `getCurrentMachineId`（**本地那个**） | 按 §5.4 注入 + 改名 |
| `1236-1246` | `SsoAuthResult` | 类型 |
| `1248-~1419` | `ssoDeviceAuth` | 搬 |
| `1421-1493` | `kiroApiRequest` | 搬 |
| `~1495-1608` | `UsageLimitsResponse` 等类型 | 类型 |
| `1610-1692` | `getUsageLimitsRest` | 搬 —— **业务知识最密的一块** |
| `1694-1746` | `UnifiedUsageResponse` | 类型 |
| `1748-~1891` | `getUsageAndLimits` | 搬 |
| `1894-1905` | `UserInfoResponse` + `getUserInfo` | 搬 |

约 **900-950 行**净迁移，index.ts 从 6954 → 约 6000 行。

**必须整块搬、绝不能重写或"顺手整理"的段落**（每一处都是 RCA 换来的）：
- `getUsageLimitsRest:1622-1641`：V1 legacy 占位 ARN → V2 fallback；EU 强制 ARN 但 **`api_key` 必须排除**（RCA 2026-08-02 `ksk-eu-fallback-arn`，受控对照：无 ARN → 200 / 带 fallback ARN → 403）。
- `getUsageLimitsRest:1655-1660`：数据面 host 必须按 profileArn 真实 region 选，而非 `account.region`（间歇性 403 → 400）。
- `getUsageAndLimits:1755-1772`：social 兜底 ARN 与 ksk_ 的**相反**处置（RCA 2026-07-14 `usage-refresh-zero`）。
- `refreshTokenByMethodInner:1194-1196`：`external_idp` 判定**必须先于** `social` —— 两者都无 clientSecret，顺序反了 external_idp 会走错端点。
- `refreshTokenByMethod` 的 single-flight（§5.1）。

## 8. 链路完整性扫描（§0.16）

成功状态：**不是**「新模块编译通过 / 单测绿」，**而是**「服务器上 `KIRO_DATA_DIR=... node out/server/index.js` 起来后，account 的 accessToken 过期时反代自动刷出新 token 并落盘，手机面板上看到 expiresAt 前移；本机关机不影响」。负条件：**不得出现同一 refreshToken 被并发刷两次**（会被上游踢下线）。
来源：owner 原话（成功判据）+ 消费方前置条件 —— `assembly.ts:288` `buildProxyEvents(store, accountApi, ...)` 与 `:297` `buildRuntimeDeps(accountApi, ...)` 实测已把 `accountApi` 接进反代事件与 runtime deps，即**下游已就绪，只缺实现**。

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| 上游 API 实现 | `upstreamApi/*.ts`（**to-build**） | `assembly.ts:234` `options.accountApi` | ⛔ 断：缺 to-build |
| 桌面侧继续使用 | `upstreamApi/*.ts`（to-build） | `index.ts:3855-3863` `api:{...}` / `:1958-1964` verifyApiDeps / `:4072/:4098/:4201` | ⛔ 断：待改 import |
| `refreshTokenByMethod` → 反代 | `assembly.ts:288 buildProxyEvents` | `proxy/proxyServer.ts` onTokenRefresh | ✅ 已通（桌面 `index.ts:638` 同形） |
| 刷出的新 token → 落盘 | `assembly.ts` `ServerPersistenceHooks.onProxyAccountUpdate` | `applyAccountDataMutation` / store | ⚠️ **须核**：`assembly.ts:139-152` 注释说这三个 hook 由「另一个并行工作包」实现；未注入时**告警一次后丢弃**。若该包未落地，则 token 刷成功但重启后用回旧的 —— 成功状态仍不成立 |
| 4 个自由方法（kiroAuthSync / kiroApi 来源） | 已存在的模块 | `assembly.ts` accountApi | ⛔ 断：`unwiredAccountApi` 让它们也抛，**可立即修，无依赖** |
| 门禁纳管 | `server/entry.ts` 入口传递闭包 | `kernel_without_electron.test.ts:133` | ✅ 自动纳管（闭包计算，无需改清单）—— 但闭包文件数会从 44/45 上升，若测试里有硬编码期望数需同步 |

**关键警示（给主派发者）**：即使本工作包 100% 完成，若 `ServerPersistenceHooks` 那个包未落地，成功状态**依然不成立**（刷新成功但不落盘）。必须确认那个包的状态，否则会出现「四个函数抽完了、评审仍是 Critical」。

## 9. 业务现实核对（§0.17）

抽取不是新建能力，是把既有能力搬到可复用位置 —— 四问对「抽取」本身不适用（已确认为 A 类既定需求：owner 的成功判据直接依赖它，评审判 Critical）。

需要核对的是**顺带新增的东西**，逐项：
- 新增 `createUpstreamApi` 工厂 → **A**（业务必需，服务端无它则无法刷新）。
- 新增「工厂单例」门禁测试 → **B**（稳定性防护：防两张 single-flight 表 → 账号被踢，§6.2）。真实场景具体、影响可陈述，做。
- 是否顺手把 `useKProxyForApi` / `currentUsageApiType` 统一成一个 settings 端口 → **D 技术整洁**，**不做**。理由：今天各 2 个写入点、全在 index.ts，无业务方要求统一；统一会把 IPC 语义变更引进一个本应零行为变化的抽取里。
- 是否顺手修 `kiroAuthSync.ts:233 readKiroAuthTokenFile` 的吞错形态（`181b169`/`afe80af` 两次都登记未修）→ **不在本轮**：它是接口契约变更（`types.ts:139` 把返回 null 写进契约，4 个生产消费者），与本轮零行为变化目标冲突。保持登记状态。

## 10. 停止条件（第 7 问）—— 是否存在必须分叉或泄漏的部分

**没有。四个函数全部可抽，不需要分叉实现，也不需要把 Electron 状态泄漏进共享模块。** 依据：§2.3 实测全部传递闭包零 Electron 引用；三个可变状态与 Electron 无关；四个上游模块（`kiroAuthSync` / `proxy/kiroApi` / `oidcRefresh` / `proxy/systemProxy`）实测均无 electron 引用，`kproxy/index.ts` 已是内核入口。

一处**必须明写的服务端语义差**（不是阻塞，是需 owner 裁决的一行）：`useKProxyForApi` 在服务端应固定为 **false**。理由与 `3adda90` 裁「K-Proxy 载映射不启 MITM」同款 —— 服务器上没有本地 IDE 出网流量需要拦截，K-Proxy 不运行，`getNetworkAgent` 的第一级分支恒不命中。让服务端装配传 `() => false` 比传一个永远读到「未运行」的 getter 更诚实。**若 owner 认为服务端也要走 K-Proxy，则这一条要改，且需要先启 kproxy 服务** —— 这是唯一需要裁决的点。

一处**诚实标注**：本报告全部结论为源码级实测，**未在 Electron 下或 Linux 上运行任何东西**（只读侦察）。「抽取后桌面行为完全不变」= `unverified: 需实际运行桌面应用 + 全套件`。§7 的行段跨度按当前 6954 行文件实测，若 owner 期间编辑 index.ts 需重新校准。

## 11. 第二个断点（本轮新发现 · 重要）

`server/entry.ts:77` 实测：

```ts
const server = assembleServer({ config, adminKeyStore })
```

**既没传 `accountApi`，也没传 `persistence`。** 而 `assembly.ts:568-578` 的 `onAccountUpdate` 在 `persistence?.onProxyAccountUpdate` 缺席时是 `warnOnce` 后 **return（丢弃）**。

含义：即使四个函数抽完并注入 `accountApi`，链路仍在下一跳断开 —— **反代刷出新 token → 内存里更新了 → 没有任何东西落盘 → 进程重启后用回旧 token**。而旧 refreshToken 若已被上游 rotate 作废，重启后刷新会直接 401。

`assembly.ts:139-152` 的注释说这三个 hook「由另一个并行工作包实现」，但 `entry.ts` 侧**零传入**，说明那个包**尚未落地**。

**故本任务的真实范围比任务书描述的大一跳**：抽取四函数是必要条件，不是充分条件。服务端 `persistence` hooks 也必须接上（服务端侧比桌面简单 —— 不需要 IPC，直接 `applyAccountDataMutation` 落 store，`afe80af` 已把 `applyAccountDataMutation` 纳入内核闭包）。这一项已列为工作包 D。

## 12. 可派发工作分解（第 6 问）

`src/main/index.ts` 是单写者瓶颈 —— **凡碰它的必须串行**。据此分层：

### 并行波次 1（互不冲突，可同时开工 · 均不碰 index.ts）

| 包 | 范围（文件） | 目标 | 性质 |
|---|---|---|---|
| **A · 接上 4 个自由方法** | `src/main/server/assembly.ts`（仅 `unwiredAccountApi` 与装配处） | `fetchEnterpriseProfileArn` / `readKiroAuthTokenFile` / `writeKiroAuthTokenFile` / `resolveProfileArnForWrite` 从 `../kiroAuthSync` 与 `../proxy/kiroApi` 直接 import 注入；只让剩下 3 个抛。验收：`unwiredAccountApi` 只剩 3 个 `missing()` | **机械** · 零依赖 · 建议先做（立刻缩小缺口且不阻塞任何人） |
| **D · 服务端持久化 hooks** | `src/main/server/assembly.ts` 或新 `server/persistence.ts` + `server/entry.ts` | `entry.ts` 向 `assembleServer` 传 `persistence`，实现 `onProxyAccountUpdate` / `onProxyAccountSuspended` → 走 `applyAccountDataMutation` 落 store | **需判断**（落盘语义、与桌面 SSOT 对齐）· 与 A 有同文件冲突风险，见下 |
| **E · 单例门禁测试** | `test/main/architecture/`（新文件） | 源码级断言：`createUpstreamApi` 每进程仅一个实例（防两张 single-flight 表，§6.2） | **需判断**（判据设计）· 可先写成 red，等 B 落地转绿 |

⚠️ **A 与 D 都改 `assembly.ts`** —— 若并行，切成不同函数区（A 只碰 `unwiredAccountApi` ~113-134；D 只碰 `buildProxyEvents` ~520-600 与 `entry.ts`）。更安全的做法是 A 先做（很小，半小时级），D 紧随。

### 串行主链（必须依次，全部或部分碰 index.ts）

| 包 | 范围 | 目标 | 性质 |
|---|---|---|---|
| **B · 抽取新模块**（核心） | **新建** `src/main/upstreamApi/index.ts`（+ 建议 `upstreamApi/usage.ts` 拆分）· **不改 index.ts** | 按 §7 行段表整块搬入，`createUpstreamApi(deps)` 工厂形态（§5 四项裁决）。此包**只新增文件**，index.ts 暂时留着旧副本（两份并存，编译均通过） | **机械为主 + 少量判断**：搬移本身机械，但 §5 的四项状态归属与工厂签名需按本报告裁决执行；§7 的五处 RCA 段落**逐字搬，不许重写** |
| **C · 切换 index.ts 到新模块**（单写者） | `src/main/index.ts`（唯一） | 删掉 §7 行段表里的旧实现，改为 import / 工厂实例；9 处调用点写法不变（§6.1）。桌面装配传 `getUsageApiType: () => currentUsageApiType`、`useKProxy: () => useKProxyForApi` 保持 IPC 语义 | **需判断** · **必须独占 index.ts** · owner 说过自己在编辑此文件 → 建议 owner 亲自做或明确交接窗口 |
| **F · 服务端注入 accountApi** | `src/main/server/assembly.ts` + `entry.ts` | `entry.ts` 构造 `createUpstreamApi({ useKProxy: () => false, getUsageApiType: () => store.get('usageApiType') ?? 'rest', ... })` 传入 `assembleServer({ accountApi })` | **机械**（依赖 B 完成） |

**依赖关系**：A、E 可立即并行 → B 可与 A/D/E 并行（只新增文件）→ C 需 B 完成且独占 index.ts → F 需 B 完成（可与 C 并行，不同文件）→ D 与 F 都碰 `assembly.ts`/`entry.ts`，需串行或切区。

**推荐顺序**：`A`（立即，最小）→ `B` + `E` 并行 → `C`（owner 独占）→ `F` → `D`。

### 冲突警告

1. **`index.ts` 单写者**：只有包 C 碰它。B 刻意设计成「只新增、不删旧」正是为了把 index.ts 的改动压缩进 C 一个包、一个窗口。
2. **`assembly.ts` 三方争用**：A（~113-134）、D（~520-600 + entry.ts）、F（~187-235 + entry.ts）。建议 A → F → D 串行，或严格切区并约定谁改 `entry.ts:77` 那一行（F 和 D 都要动它 —— **建议合并 F+D 为一个包**，它们改的是同一处装配调用）。
3. **`test/main/server/adminKeyStore*`**：另两个 agent 正在编辑，约 12 个测试红 —— **与本任务无关，不要碰、不要修、不要在验收时把它算作回归**。
4. **门禁闭包文件数**：B/F 落地后 `kernel_without_electron` 闭包文件数上升（44/45 → 更多）。闭包是计算出来的、自动纳管，但若测试内有硬编码期望数字需同步（本轮未逐行核实该断言形态，实施时先跑一次看是否有数字断言）。

## 13. 给主派发者的建议

- **先跑包 A**：它把「7 个方法全抛」缩成「3 个方法抛」，零风险、不碰 index.ts、不依赖任何人，且立刻让评审结论从「完全未接线」变成「仅刷新链未接线」。
- **B 的验收判据不能是「单测绿」**（E-052 形态）：必须是「新模块 export 的四个函数与 index.ts 旧实现**逐字节等价**」—— 建议实施者用 `git diff --no-index` 对搬移前后的函数体做一次逐字比对，作为 Evidence。
- **C 之后必须真跑一次桌面**：本报告全部结论是源码级，桌面行为不变属 `unverified`。
- **成功状态的最终验收**（§8）必须包含 D/F：只做 B+C 会得到「能刷但不落盘」，评审仍不会降级。

---

## Update Log

- 2026-08-12 侦察完成。锚点 10 项全部亲验（4 项漂移已校正，§0）。核心结论三条：① 四函数及全部传递闭包**零 Electron 依赖**，抽取本质机械；② 缝位实际是 7 个方法，其中 4 个来自已有外部模块、**可立即接线**（包 A）；③ **新发现第二个断点** —— `entry.ts:77` 未传 `persistence`，反代刷出的新 token 无处落盘，故仅抽取四函数**不足以**达成成功状态（§11）。`verify.ts` 先例的「不搬移」理由经判读为**调度冲突而非架构判断，已过期**（§4.2）。无需分叉实现、无需泄漏 Electron 状态（§10）。
