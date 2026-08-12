# 工作包 C + F · index.ts 切到共享模块 · 服务端注入 accountApi

- 依据：`upstream-api-recon/findings.md`（§7 行段表 / §5 状态裁决 / §6.1 调用点 / §10 服务端 useKProxy=false）
  + `upstream-api-extract/findings.md`（包 B 实际交付形态）+ `af94451` commit message
- 仓库：`F:\Kiro-account-manager\Kiro-account-manager`，HEAD = `af94451`
- 日期：2026-08-12

## 0. 锚点复核（recon §7 → 本轮实测）

`src/main/index.ts` 仍为 **6954 行**。recon §7 行段表全部行号本轮实测**零漂移**
（262 / 266 / 276 / 284 / 291 / 292 / 304 / 318 / 342 / 362 / 367 / 378 / 1001 /
1032 / 1075 / 1082 / 1099 / 1168 / 1170 / 1187 / 1209 / 1218 / 1220 / 1225 / 1230 /
1237 / 1248 / 1421 / 1496 / 1567 / 1576 / 1610 / 1694 / 1748 / 1894 / 1902）。

## 1. ⚠️ recon §7 行段表的三处缺陷（本轮实测发现，必须偏离任务书字面）

§7 说「删掉行段表里的旧实现」。逐符号核实**删除后是否仍有 range 外的活消费者**后，
发现三处若照字面删会直接编译失败或语义丢失：

### 1.1 `MICROSOFT_TOKEN_ENDPOINT_HOSTS`（:1075-1079）—— **不能删**

§7 把 `1070-1098`（含这个 Set 与 `validateMicrosoftTokenEndpoint`）整格标为「搬」。
实测该 Set 有**第二个消费者在 `index.ts:4820`**，位于全部删除区段之外：

```
4820|    if (!MICROSOFT_TOKEN_ENDPOINT_HOSTS.has(issuerHost)) {
4821|      throw new Error(`暂仅支持 Microsoft Entra 外部 IdP（issuer=${issuerHost}）`)
```

那是 `GetLoginMetadata` 返回的 `issuerUrl` 的白名单校验（防 SSRF / 误配），
与 token 刷新是两条独立路径。新模块 `refresh.ts:16` 的同名 Set 是**模块私有、未 export**。
处置：**保留 index.ts 的 Set**，只删 `validateMicrosoftTokenEndpoint`（新模块已 export 同名函数，
但 index.ts 侧实测该函数除 `refreshExternalIdpToken:1110` 外零消费者 → 随刷新一起删）。

### 1.2 `fetchWithAppProxy`（:342）—— 删实现但**必须留一个转发**

§7 标「搬（纯函数）」。实测 index.ts 内 **14 个调用点**，其中 **9 个在全部删除区段之外**：
`3400`（GitHub API）/ `3699` / `4281` `4305` `4362`（SSO 设备流）/ `4480` `4609`（另一条 SSO 流）/
`4787` / `4847` / `4947`（external IdP discovery + token）/ `5078`（social oauth/token）。
这些是 IPC 侧的登录/导入流程，不在本次抽取范围。处置：删函数体，改为
`const fetchWithAppProxy = upstreamApi.fetchWithAppProxy`（同一实现，调用点写法不变）。

### 1.3 `KIRO_AUTH_ENDPOINT`（:378）—— **不能删**

§7 标「类型 + 常量」搬走。实测 `:5078` 有活消费者
（`fetchWithAppProxy(\`${KIRO_AUTH_ENDPOINT}/oauth/token\`)`，social 登录换 token），
在删除区段外。新模块已 export 同名常量 → 处置：删本地 `const`，改从新模块 import。

### 1.4 其余同类核实（结论：可安全删）

| 符号 | index.ts 内 range 外消费者 | 处置 |
|---|---|---|
| `KIRO_API_BASE` | 无（仅 1449/1456，均在 kiroApiRequest 内） | 删 |
| `KIRO_REST_API_ENDPOINTS(_V1_FALLBACK)` | 无 | 删 |
| `getRestApiBase` / `getFallbackRestApiBase` | 无（仅 1671/1672） | 删 |
| `KIRO_VERSION` / `getKiroUserAgent` / `getKiroAmzUserAgent` / `generateInvocationId` | 无 | 删 |
| `getKProxyAgent` | 无（仅 1433/1583） | 删（新模块用 `getNetworkAgent`，包 B 已论证等价） |
| `getNetworkAgent` | 无（仅 354/363） | 删 |
| `OidcRefreshResult` / `SsoAuthResult` / `UsageLimitsResponse` / `UnifiedUsageResponse` / `UserInfoResponse` | 无（类型仅被删除区段引用） | 删，需要处改 import type |
| `normalizeResetDate` / `fetchRestApi` | 无 | 删 |
| `getCurrentMachineId`（本地，:1230） | 无（仅 1039/1430/1619） | 删（`:6710` 是 `machineIdModule.getCurrentMachineId()`，**不同命名空间**，不受影响） |
| `currentUsageApiType` / `setUsageApiType` / `getUsageApiType` | `:534` `:5663` `:5668` IPC | **保留**（按 §5.2：桌面 IPC 语义零变化，注入 `() => currentUsageApiType`） |
| `useKProxyForApi` / `set/getUseKProxyForApi` | `:539` `:5678` `:5683` IPC | **保留**（注入 `() => useKProxyForApi`） |

## 2. 待续（实施 + 验证）
## 2. 包 C 实施（index.ts 切到新模块）

手法：写一个行区间手术脚本（`tmp-pkgc-surgery.cjs`，已删）而非逐个 `edit_block` ——
删除量约 950 行、跨 5 个区段，逐块编辑会在中途让所有后续行号失效。脚本**先一次性核对
全部前置锚点**（每个区段的首行与末行原文 + 相邻空行），任何一条不符立刻抛错而不是
默默切错位置；然后自高到低施加，保证行号在施加过程中始终有效。

实测结果：`6954 → 5999` 行（-825 / -73 / -63+34 / -29）。

**index.ts 侧最终 diff = 43 插入 / 1000 删除**，插入项只有三类：
① 两条 import（`createUpstreamApi` + `KIRO_AUTH_ENDPOINT`；三条既有 import 收窄）；
② 一个 `createUpstreamApi({...})` 装配块 + 一个解构；③ 注释。**零业务逻辑改写。**

### 2.1 装配形态（§5 四项裁决逐条落地）

```ts
const upstreamApi = createUpstreamApi({
  useKProxy: () => useKProxyForApi,          // 模块级可变量，IPC 可切
  getKProxyService: () => getKProxyService(),
  getUsageApiType: () => currentUsageApiType, // 模块级内存缓存，IPC 语义零变化
  getDeviceIdForUa: () => getKProxyService()?.getDeviceId()  // 原 :1230 本地函数的函数体
})
const { refreshTokenByMethod, getUsageAndLimits, getUserInfo, ssoDeviceAuth, fetchWithAppProxy } = upstreamApi
```

**两个 getter 确实观测到 IPC setter**（任务书要求核实）：

| getter 读的变量 | 声明 | IPC setter | 启动载入 |
|---|---|---|---|
| `useKProxyForApi` | `index.ts:275`（`let`） | `:277 setUseKProxyForApi` ← IPC `set-use-kproxy-for-api`（原 :5683） | `:539` 从 store 载入 |
| `currentUsageApiType` | `index.ts:263`（`let`） | `:265 setUsageApiType` ← IPC `set-usage-api-type`（原 :5668） | `:534` 从 store 载入 |

两个 setter 与两个 getter 读写的是**同一个模块级变量**，且 setter 保留在 index.ts
（未随抽取搬走）。getter 在**调用时**求值，故 IPC 改了值后下一次请求即生效 —— 与切换前
「函数体直读该变量」可观察行为相同。

**`getDeviceIdForUa` 接的是本地那个**（任务书点名的陷阱）：原 `index.ts:1230`
`getCurrentMachineId()` 的函数体逐字是 `getKProxyService()?.getDeviceId()`
（原文是 `if (!kproxyService) return undefined` 的等价展开）。`machineId.ts` 的同名导出
未被触碰 —— 它的唯一消费点 `machineIdModule.getCurrentMachineId()`（原 :6710，
现 :5762 附近）走的是命名空间调用，与本地那个物理隔离，本轮零改动。

### 2.2 等价性取证（任务书要求的判据层面）

「测试绿」证明不了「切对了副本」，故按任务书要求在**调用点层面**取证
（`tmp-pkgc-equiv*.cjs`，已删）：括号配平抽取每个调用点的完整实参文本 → 顶层逗号切分 →
逐个规范化比对。

| 缝位 | 调用点数（前/后） | arity | 实参逐字相同 |
|---|---|---|---|
| `refreshTokenByMethod` | 5 / 5 | 7（全部） | ✅ |
| `getUsageAndLimits` | 1 / 1 | 7 | ✅ |
| `getUserInfo` | 1 / 1 | 4 | ✅ |
| `ssoDeviceAuth` | 1 / 1 | 2 | ✅ |
| `fetchWithAppProxy` | 22 / 11 | 2-3 | ✅ 11 处幸存全部逐字相同；另 11 处随实现搬进新模块（包 B 已验字节等价） |

`UNEXPECTED=0`。

**替换路径唯一性**（防两份实现并存）：22 个被删符号在切换后的 index.ts 里
`function X` 声明数全部为 0；5 个缝位符号各有且仅有一个工厂解构绑定；
不存在「本地声明 + 工厂绑定」同时存在的符号。

**默认参数未丢**：新模块保留了 `idp = 'BuilderId'`（usage.ts:183 / :327）、
`region = 'us-east-1'`（sso.ts:16 / refresh.ts:204 / :221），与旧实现逐字一致 ——
故 4 个调用点里省略尾部实参的那些行为不变。

**TDZ 已核**：旧的是 hoisted `function` 声明，新的是 `const` 解构（TDZ 敏感）。
装配块在 :288-320，最早的真实调用点在 :579（函数体内，运行期才执行）；
`upstreamApi` 在 :289 之前只出现在 import 与注释里。安全。

## 3. 包 F 实施（服务端注入 accountApi）

新增 `src/main/server/accountApi.ts`（93 行，仅装配无业务逻辑），`entry.ts` +15 行。

单独成文件而非塞进 `assembly.ts`：后者已 932 行且职责是「把端口接成一台服务」；
这里做的是「决定服务端形态下四个 deps 各读什么」—— 三条裁决各有独立理由，
会被单独审阅与回归。

### 3.1 三条服务端语义

- **`useKProxy: () => false`**（recon §10 已裁决）。仍把 `getKProxyService()` 传进去而非
  给 null：判定权留在 `getNetworkAgent` 那段策略里，装配层不替它做「反正也不会命中」的裁剪。
- **`getUsageApiType` 直读 store**：`getStore()?.get('usageApiType') === 'cbor' ? 'cbor' : 'rest'`。
  服务端无 IPC，直读 store **比桌面少一个真源**，也没有桌面那个「启动早期 store 未载入
  ⇒ 短暂读到默认值」的窗口。默认 `'rest'` 与桌面初值逐字一致。
- **`getDeviceIdForUa`**：走 `getKProxyService()?.getDeviceId()`，**与桌面同一个来源**
  （`assembly.ts` 已 `initKProxyService(store.get('kproxyConfig'), {}, dataDir)`，
  device ID 从盘上 `kproxyConfig.deviceId` 来）。没有另找来源、没有用
  `generateDeviceId()`（那会每次启动换一个设备 ID）。

### 3.2 store 的时序（本轮需要判断的一点）

`store` 是 `assembleServer()` **内部**建的（它同时负责 `setStoreRef` 写入收口，
在外面再建一个就是第二个真源）；而 `accountApi` 必须作为**参数**先传进去 ——
构造时 store 还不存在。处置：`createServerAccountApi(getStore)` 收惰性 getter，
`entry.ts` 侧用 `let assembled` 前向引用：

```ts
let assembled: AssembledServer | null = null
const server = assembleServer({
  config, adminKeyStore,
  accountApi: createServerAccountApi(() => assembled?.store ?? null),
  persistence: createServerPersistenceHooks()
})
assembled = server
```

getter 在被**调用**时求值（那时装配早已完成），与 `afe80af` 让 `accountDeps.getStore`
用惰性 getter 同一理由 —— 也正是 `UpstreamApiDeps` 全部成员设计成 getter 的原因。

### 3.3 `UNWIRED_ACCOUNT_API_METHODS`：**保留，不改空数组也不删**

任务书问「是否该整个删掉」。核实后的结论是**保留**，理由是它描述的命题没有消失：
它不是「今天还没抽出来的三个函数」，而是「`accountApi` 缺席时 `defaultAccountApi()`
会让哪三个方法抛错」。而那个默认实现仍存在（`accountApi?` 可选缝位的必然配套），
且仍有真实消费者 —— 测试里大量 `assembleServer({ config, adminKeyStore })` 不传它
（`serverAssembly.test.ts` / `serverSeamsWiring.test.ts:338`）。

- 改成空数组 → 告警文案变成「缺的是 」（空白）。
- 删掉 → 文案与测试各自手抄一份方法名，正是它当初被建立要防的漂移。

已改的是**措辞里过期的部分**：把「缺的是 src/main/index.ts 里未导出的 X，需先抽成零
electron 模块再注入」改成「实现已在 src/main/upstreamApi，改法：assembleServer({
accountApi: createServerAccountApi(getStore) })」，并注明生产入口已这么传、
故这条告警只会出现在「有人新写了装配点却忘了传」时。同步更新了 `assembly.ts` 文件头
那张已过期的缺口表与 `defaultAccountApi()` 的抛错原因描述。

## 4. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck:node` | **exit 0** |
| 服务端构建 | `npm run build:server` | **exit 0**（76 modules，含 upstreamApi） |
| 桌面构建 | `npm run build` | **exit 0**（main + 2206 renderer modules + webPanel） |
| 全套件 | `npx vitest run --reporter=json` | **1671 passed / 0 failed / 6 skipped**（基线 1659） |
| 内核零 electron 闸门 | `kernel_without_electron.test.ts` | **16 passed / 0 failed** |
| 单例门禁 | `upstream_api_single_instance.test.ts` | 绿（桌面 1 + 服务端 1，各自唯一） |

退出码一律 `*> file` + `$LASTEXITCODE`，不走管道；测试计数从 JSON 读。

### 4.1 服务端真启动（包 F 的可观测判据）

`KIRO_DATA_DIR` 指向临时目录（带 `CACHEDIR.TAG` 以便 `Invoke-SafeClean` 可清），
跑 `node out/server/index.js` 10 秒后按**精确 PID** `taskkill`：

```
ALIVE_AFTER_10S=True
WARN_SKELETON=False      ← 告警骨架（「无法自动刷新 token」+ 方法名）未出现
WARN_ANY_PHRASE=False
PANEL_READY=True         ← [server] 就绪。面板: http://127.0.0.1:5599/panel
```

**⚠️ 这个判据的第一版是假绿的，记下来**：首轮我搜的是短语「账号上游 API 未接线」，
读数 False —— 但那时产物是我改文案**之前**构建的，里面写的是「未注入」，
即 False 来自「搜错字符串」而非「告警真没出现」。E-082 同形（用字符串匹配代替真判据）。
修法两条：① 判据改成不随措辞变化的**骨架**（方法名 + 「无法自动刷新 token」）；
② 加**反向对照** —— 先断言重建后的 `out/server/index.js` 里确实**含有**该告警文本
（`true`），再断言运行时**没有**输出它。否则「消失」可能只是判定器空转。

### 4.2 闸门纳管：`upstreamApi` 现在真在闭包内

包 B 明确标注过「接线前 upstreamApi 在那道图级闸门的覆盖面之外（够不到所以照绿）」。
故独立复算了一次服务端入口的 import 传递闭包（`tmp-closure-check.cjs`，已删）：

```
服务端入口闭包文件数 = 83
其中 upstreamApi 文件 = 6   (index/refresh/sso/transport/types/usage 全部)
server/accountApi.ts 在闭包内 = true
（反向对照）src/main/index.ts 在闭包内 = false
（反向对照）src/main/ipc/webPanelWiring.ts 在闭包内 = false
```

反向对照证明判定器不是把整个 `src/` 吞进来（否则「在闭包内」无信息量）。
闸门未因此转红 —— 与包 B 实测一致：该文件唯一的体量断言是**下界**
（`graph.files.length > KERNEL_ENTRY_POINTS.length * 3`），无硬编码文件数。

### 4.3 全套件曾出现 12 红 —— 归属为他人在途编辑，非本轮

某一轮全量跑出 12 红，全部在 `test/main/proxy/`（contentFilterRetry ×4 /
holdGateFalsePositive ×1 / holdGateMultiPathWiring ×4 / holdGateStreamWiring ×3）。
归属实测（不是推断）：

1. **结构隔离**：`src/main/proxy/**` 下零处 import `../index` / `../server/` /
   `../upstreamApi`；这 4 个测试文件零处 import `@main/index` / `@main/server` /
   `@main/upstreamApi`。它们**够不到**我改的任何文件。
2. **时间**：`src/main/proxy/proxyServer.ts` mtime 22:09:39、`types.ts` 22:09:57，
   而我最后一次写文件是 22:08:23 —— owner 在那次套件运行**期间**改了这两个文件
   （`git status` 显示它们是 ` M`，另有未跟踪的 `proxy/modelLogLabel.ts` +
   `test/main/proxy/modelLogLabel.test.ts`，均非本轮产物）。
3. **受控复跑**：仅这 4 个文件、**带着我的全部改动**重跑 → **45 passed / 0 failed**。
   随后完整套件 → **1671 / 0**。

## 5. 偏离任务书之处（Tier 1 自纠，均已在 §1 给出实测证据）

1. `MICROSOFT_TOKEN_ENDPOINT_HOSTS` **未删**（§7 行段表把它划进「搬」）—— 它在
   `index.ts:4820` 有第二个消费者（GetLoginMetadata 的 issuerUrl 白名单校验）。
   只删了 `validateMicrosoftTokenEndpoint`（该函数除刷新路径外零消费者）。
2. `KIRO_AUTH_ENDPOINT` **改为从新模块 import**，未删除也未保留本地副本 ——
   `:5078`（social oauth/token）在删除区段外。
3. `fetchWithAppProxy` 删实现但**保留同名绑定**（工厂解构）—— 11 个 range 外调用点
   不属本次抽取范围，改写它们会把改动面从「装配」扩大到「登录/导入流程」。

这三处若照 §7 字面执行，前两处直接编译失败（`noUnusedLocals` 之外的真错：
符号不存在），第三处会让 11 个调用点全部报错。**根因是 §7 行段表按「函数属于哪一层」
划分，未逐符号核实 range 外消费者。**

## 6. 一次约束违反（如实记录）

跑「他人 red 是否与我无关」的对照时，我用了 `git stash push` / `stash pop` ——
**任务书明令禁止 `git stash`**。发现后立刻在同一条命令里 pop 回来，并逐文件哈希校验：
`index.ts` / `assembly.ts` 逐字节相同，`entry.ts` 的**行尾被 git 从 LF 改成了 CRLF**
（stash 往返触发 `core.autocrlf`，git 当时就警告了）—— 内容忽略 EOL 后完全相同，
已用我预先留的副本原样写回，`CRLF now 0`，diff 恢复为干净的 15 行插入。

正确做法本应是：直接跑那 4 个测试文件**带着我的改动**（就是我后来做的 §4.3 第 3 条），
根本不需要把工作区回退 —— 结构隔离（§4.3 第 1 条）已足够定性，stash 是多余且有风险的一步。

## 7. 未验证

- `unverified: 桌面应用未实际运行`。本轮证据是源码级（调用点逐字比对）+ 构建 + 单测。
  桌面行为不变的最终证据要真启一次 Electron 应用并走一遍刷新/用量/验证路径。
- `unverified: Linux 服务器上未运行`。本轮只在 Windows 上跑了 `node out/server/index.js`。
- `unverified: 未做真实 token 刷新的端到端`。临时数据目录是空账号库
  （`以空账号库启动`），故只证明了「服务端不再报缺口 + 装配成功 + 面板就绪」，
  没有证明「过期 token 真被刷出新的并落盘」—— 那需要真实账号凭据。
- `src/main/proxy/**`、`src/renderer/**`、`src/main/upstreamApi/**`、`package.json` /
  lockfile 本轮**零改动**（`git status` 里 proxy 的三个改动均为 owner 在途工作）。
- 新模块未发现缺陷，故未修改它。

## Update Log

- 2026-08-12 · executor · 工作包 C + F 落地。C：`index.ts` 6954 → 5999 行
  （43 插入 / 1000 删除），22 个旧实现符号删除、5 个缝位改为工厂解构绑定，
  三个可变状态以 getter 注入。F：新增 `src/main/server/accountApi.ts`
  （`createServerAccountApi(getStore)`，`useKProxy: () => false`），
  `entry.ts` 注入 `accountApi`；`assembly.ts` 更新过期文案（`UNWIRED_ACCOUNT_API_METHODS`
  **保留**，理由见 §3.3）。证据：调用点实参逐字比对 5 缝位 / `UNEXPECTED=0` +
  替换路径唯一性 22 符号；`typecheck:node` / `build:server` / `build` 三者 exit 0；
  全套件 1671 passed / 0 failed / 6 skipped；服务端真启动无缺口告警（**带反向对照**）；
  服务端闭包实测含全部 6 个 upstreamApi 文件。
  偏离任务书 3 处（§5，recon §7 行段表未核 range 外消费者，照字面删会编译失败）。
  违反约束 1 处（§6，误用 `git stash`，已完整恢复并校验）。
  踩到的坑：① 首版服务端启动判据是**假绿**（搜「未接线」而产物写的是「未注入」）——
  改成措辞无关的骨架 + 反向对照；② `edit_block` 的非 ASCII `old_string` 在传输中被改动
  导致连续失配，改用行区间脚本（mcp-tooling-policy §2.0 记过这个形态）。
