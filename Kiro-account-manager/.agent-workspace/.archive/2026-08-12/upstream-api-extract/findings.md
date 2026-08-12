# 工作包 B · 上游 API 四函数抽取（只新增文件，不碰 index.ts）

- 依据：`.agent-workspace/.archive/2026-08-12/upstream-api-recon/findings.md`（321 行侦察报告，本轮全文读过）
- 仓库：`F:\Kiro-account-manager\Kiro-account-manager`，HEAD = `49978e1`（侦察时为 `3354d50`）
- 日期：2026-08-12

## 0. 锚点复核（侦察报告 → 本轮实测）

侦察报告 §0 校正过的 10 个锚点，本轮逐一复核，**全部仍然成立，零漂移**：

| 符号 | 报告行号 | 本轮实测 | 结论 |
|---|---|---|---|
| `KIRO_API_BASE` | 262 | 262 | ✅ |
| `KIRO_REST_API_ENDPOINTS` | 266 | 266 | ✅ |
| `getRestApiBase` | 276 | 276 | ✅ |
| `currentUsageApiType` | 292 | 292 | ✅ |
| `setUsageApiType` | 294 | 294 | ✅ |
| `useKProxyForApi` | 304/305 | 304 | ✅ |
| `getNetworkAgent` | 318 | 318 | ✅ |
| `fetchWithAppProxy` | 342 | 342 | ✅ |
| `getKProxyAgent` | 362 | 362 | ✅ |
| `refreshOidcToken` | 1001 | 1001 | ✅ |
| `refreshSocialToken` | 1032 | 1032 | ✅ |
| `validateMicrosoftTokenEndpoint` | 1082 | 1082 | ✅ |
| `refreshExternalIdpToken` | 1099 | 1099 | ✅ |
| `inFlightRefreshByToken` | 1168 | 1168 | ✅ |
| `refreshTokenByMethod` | 1170 | 1170 | ✅ |
| `refreshTokenByMethodInner` | 1187 | 1187 | ✅ |
| `getCurrentMachineId`（index.ts 本地） | 1230 | 1230 | ✅ |
| `ssoDeviceAuth` | 1248 | 1248 | ✅ |
| `kiroApiRequest` | 1421 | 1421 | ✅ |
| `getUsageLimitsRest` | 1610 | 1610 | ✅ |
| `getUsageAndLimits` | 1748 | 1748 | ✅ |
| `getUserInfo` | 1902 | 1902 | ✅ |

`src/main/index.ts` 仍为 **6954 行**。HEAD 虽已前进两个 commit（`d6e5586` 落地了工作包 A —— 四个自由方法已接上真实实现、`49978e1` 改反代挂起可观测性），但都未触及 §7 行段表覆盖的区段。

## 1. 本轮新发现的两处补充（侦察 §7 行段表未列，但必须一并搬）

`getUsageLimitsRest` 的两个模块私有依赖，在侦察报告的行段表里落在 `~1495-1608「UsageLimitsResponse 等类型」`那一格内，没有单独点名，但它们是**函数不是类型**，漏搬会直接编译失败：

- `normalizeResetDate`（:1563-1571）—— Unix 秒 / ISO 字符串归一，`getUsageAndLimits` 两条分支各用一次
- `fetchRestApi`（:1573-1608）—— **承载 TokenType 分发铁律**（`external_idp`→`EXTERNAL_IDP` / `api_key`→`API_KEY` / 其余→`SSO_OIDC`），2026-07 迁移后后端严格校验，缺 header 被当 legacy 拒 403。这一段的注释密度与侦察点名的五处同级，同样逐字搬。

## 2. 依赖来源核实（全部已在 index.ts 之外，新模块直接 import）

| 符号 | 来源模块 | 是否内核安全 |
|---|---|---|
| `getSystemProxy` / `safeCreateProxyAgent` | `./proxy/systemProxy` | ✅ 闸门闭包内 |
| `refreshOidcTokenAcrossRegions` | `./oidcRefresh` | ✅ |
| `KNOWN_SSO_OIDC_REGIONS` / `parseRegionFromProfileArn` / `isKiroApiDebug` | `./proxy/kiroApi` | ✅ 闸门闭包内（ADR-0002 那条链的中段） |
| `isPlaceholderProfileArn` / `getEnterpriseFallbackArn` / `KIRO_SOCIAL_PROFILE_ARN` | `./kiroAuthSync` | ✅ |
| `getKProxyService` / `KProxyService` | `./kproxy` | ✅ 闸门入口 #1 |
| `encode` / `decode` | `cbor-x` | ✅ |
| `fetch` / `Dispatcher` | `undici` | ✅ |

零 electron —— 与侦察 §2.3 结论一致。

## 3. 交付形态（判断依据）

侦察建议 `index.ts` + `usage.ts` 两文件。实际拆五个，理由是**依赖方向**而非行数：

| 文件 | 行 | 内容 |
|---|---|---|
| `types.ts` | 166 | 纯类型 / 契约（零依赖，谁都能引） |
| `transport.ts` | 257 | 四级代理策略 + `fetchWithAppProxy` + CBOR RPC + UA / 常量 + `UpstreamApiDeps` |
| `refresh.ts` | 241 | 三条刷新分支 + single-flight 协调器 |
| `sso.ts` | 191 | `ssoDeviceAuth` 7 步（不读任何可变状态，天然独立） |
| `usage.ts` | 333 | `fetchRestApi` / `getUsageLimitsRest` / `getUsageAndLimits` / `getUserInfo` |
| `index.ts` | 131 | `createUpstreamApi` 工厂 + 对外契约 |

`getUsageLimitsRest` 与 `getUsageAndLimits` **同文件**（任务书要求，也是唯一合理选择 —— 兜底 ARN 的相反处置横跨两者，分开会让 RCA 知识被文件边界切断）。`sso.ts` 单独成文件是因为它与其余三个零共享状态；把它塞进 `index.ts` 只会让工厂文件变成第二个 God-file。

## 4. 验收 · 逐字节等价（这是主证据，不是测试）

工具：`extract-bodies.cjs`（按函数名提取函数体 → dedent → 逐字节比对）+ `classify-diff.cjs`（逐行分类）+ `ws-audit.cjs`（空白差异审计）。20 个函数、约 950 行。

**结果：15 处改动行，`UNEXPECTED=0`。**

| 类别 | 处数 | 内容 |
|---|---|---|
| EXPORT | 7 | `function X` → `export function X`（`getRestApiBase` / `getFallbackRestApiBase` / `generateInvocationId` / `getKiroUserAgent` / `getKiroAmzUserAgent` / `validateMicrosoftTokenEndpoint` / `normalizeResetDate`） |
| SEAM | 8 | 状态注入缝位，逐条列在 §5 |

**其余每一行、包括每一处行尾空白，与 `index.ts` 逐字节相同。** 首轮比对发现 9 行「纯空白差异」（`write_file` 顺手剥掉了空行的行尾空格），已用 `restore-ws.cjs` 原样写回 —— 「顺手规整空白」正是本次禁止的那类改动，哪怕无害也会在证据里混入噪声。复跑 `ws-audit.cjs` 输出为空。

`ssoDeviceAuth`（172 行，最大一块）、`refreshTokenByMethod` / `refreshTokenByMethodInner`（含 external_idp 先于 social 的判定顺序）、`refreshOidcToken`、`refreshExternalIdpToken`、`fetchWithAppProxy`、`getUsageAndLimits` 的两段归一化 —— **逐字节零差异**。任务书点名必须逐字搬的五处，四处零差异，第五处（`getUsageAndLimits`）唯一差异是 `currentUsageApiType` → `getUsageApiType()` 这一行。

产物留在 `bodies/old/*.ts` 与 `bodies/new/*.ts`，可用 `git diff --no-index` 复核。

## 5. 行为**必须**不同的 8 处，及为何差异被限制在缝位

每一处都是「原先直读 index.ts 模块级变量 → 改为读注入 getter」，值语义完全一致；差异只在**读取路径**，不在读到的内容。

| # | 函数 | 旧 | 新 | 为何限制在缝位 |
|---|---|---|---|---|
| 1 | `getNetworkAgent` | `if (useKProxyForApi)` | `if (deps.useKProxy())` | 桌面装配传 `() => useKProxyForApi`（同一个变量），IPC 语义零变化；服务端传 `() => false` |
| 2 | `getNetworkAgent` | `getKProxyService()`（模块 import） | `deps.getKProxyService()` | 同一个函数，只是经由 deps 传入；两端都可返回 null，`?.isRunning()` 守卫原样保留 |
| 3 | `kiroApiRequest` | `getCurrentMachineId()` | `deps.getDeviceIdForUa()` | 同一实现（`kproxy.getDeviceId()`），仅改名消歧义 |
| 4 | `kiroApiRequest` | `getKProxyAgent()` | `getNetworkAgent()` | `getKProxyAgent` 在 index.ts 里就是 `return getNetworkAgent()` 的一行别名（:362-364），**语义完全等价**；新模块不再保留纯别名，改为直呼被代理的函数 |
| 5 | `fetchRestApi` | `getKProxyAgent()` | `getNetworkAgent()` | 同 #4 |
| 6 | `getUsageLimitsRest` | `getCurrentMachineId()` | `transport.getDeviceIdForUa()` | 同 #3 |
| 7 | `refreshSocialToken` | `getCurrentMachineId()` | `transport.getDeviceIdForUa()` | 同 #3 |
| 8 | `getUsageAndLimits` | `currentUsageApiType === 'rest'` | `getUsageApiType() === 'rest'` | 桌面传 `() => currentUsageApiType` 读同一份内存；真源仍是 store 的 `usageApiType` 键 |

**#4 / #5 值得单独说明**：这是唯一一处「改了符号名而非仅改读取路径」的地方。`getKProxyAgent`（index.ts:362）的**全部函数体**就是 `return getNetworkAgent()` —— 一个 2026 年之前留下的兼容别名（原注释：「兼容函数，指向 getNetworkAgent」）。新模块不再复制这个空壳，两个调用点直呼 `getNetworkAgent()`。行为等价可由 index.ts 源码直接读出，不需要额外论证。若希望连别名一起保留以求 diff 为零，可以加回，但那会把一个已无价值的间接层带进新模块。

**没有任何一处状态语义被改变**：`inFlightRefreshByToken` 仍是工厂闭包内的私有 Map（不注入 —— §5.1 裁决），`currentUsageApiType` 没有在新模块里造第二个 `let`（§5.2 裁决），四级代理优先级整块下沉、只有一个布尔量注入（§5.3 裁决），设备 ID 改名 `getDeviceIdForUa` 以物理消除与 `machineId.ts` 同名导出的歧义（§5.4 裁决）。

## 6. 其余验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck:node` | **exit 0** |
| 服务端构建 | `npm run build:server` | **exit 0** |
| 工厂契约测试 | `npx vitest run test/main/upstreamApi` | **34 passed / 0 failed** |
| 单例门禁 | `test/main/architecture/upstream_api_single_instance.test.ts` | **6 passed / 0 failed** |
| 内核零 electron 闸门 | `kernel_without_electron.test.ts` | **16 passed / 0 failed**（未因新文件转红） |
| 全套件（新增前） | `npx vitest run` | 1649 passed / 0 failed / 6 skipped |
| 全套件（新增后） | `npx vitest run` | 1657 passed / **2 failed** / 6 skipped —— 见下 |

退出码一律用 `*> file` + `$LASTEXITCODE` 取，不走管道。

### 那 2 红不是本工作包引起的

`test/main/proxy/holdDecisionSelectedMissing.test.ts` 的两条挂起决策用例。归属实测：

- 唯一被修改的**已跟踪**文件是 `src/main/proxy/holdDecision.ts`（`git status` 显示 ` M`），mtime **21:23:03**；
- 本工作包最后一次写文件是 **19:50:49**，且只新增 `src/main/upstreamApi/*` 与 `test/main/{upstreamApi,architecture}/*`；
- `src/main/proxy/**` 是任务书明令不得触碰的范围（工作包 F 领地），本轮零改动。

即另一个 agent 在 21:23 改了 `holdDecision.ts`。19:48 那次全量跑（改完新模块之后）是 **1649 / 0 failed**，可作为本工作包未引入回归的时间锚点。

### 门禁闭包文件数：无硬编码期望值

侦察 §12 冲突警告 4 提醒要核实。实测 `kernel_without_electron.test.ts` **没有任何硬编码文件数断言**，唯一的规模判据是下界：

```ts
expect(graph.files.length).toBeGreaterThan(KERNEL_ENTRY_POINTS.length * 3)
```

新文件只会让闭包变大，故该断言不会因本轮转红。**但要注意一个覆盖面事实**：今天还没有任何内核入口 import `upstreamApi`（接线是工作包 C / F），所以新模块此刻**不在那道图级闸门的覆盖面内** —— 与该文件头部批评的「够不到所以照绿」同形。本轮因此补了运行时用例
`test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts`：用抛异常的 `vi.mock('electron')` 让 electron 解析本身失败（与既有 `kernelWithoutElectron.runtime.test.ts` 同款手法），断言新模块及其传递闭包（`kiroAuthSync` / `proxy.kiroApi` / `oidcRefresh` / `proxy.systemProxy`）全部可加载，且**真发出一次请求**并拿到归一后结果 —— 加载成功 ≠ 调用成功，函数体里若有 electron 依赖要到执行时才炸。接线落地后闭包会自动纳管它。

## 7. 工作包 E（单例门禁）：已在本轮交付

`test/main/architecture/upstream_api_single_instance.test.ts`，源码级判据：

- 单文件内 `createUpstreamApi(` 出现次数 ≤ 1；
- 装配点只允许在 `src/main/index.ts`（桌面进程）或 `src/main/server/*`（服务端进程）—— 两个**不同进程**各一张表是正确的，同一进程两处才是缺陷；出现在业务模块里直接红；
- single-flight Map 的**声明位置**必须在 `createRefresh` 工厂体内（若有人把它提到模块顶层，两个实例会共享一张表 —— 反向缺陷），且不得变成注入参数；
- 四条自检防判定器空转（能数到真实调用形态 / 注释与类型引用不计入 / 工厂符号存在 / Map 存在）。

判定器作用域已在文件头明写：它数的是**静态调用点**，不能证明运行时唯一实例（同一行放进一个被调两次的函数里仍会建两个）。选这个判据是因为它能可靠抓到真实回归形态「某处顺手又 create 了一个」，理由与 `afe80af` 给 `persistence_port_wiring.test.ts` 的相同 —— 端口级行为测试在有人绕过时照样绿。

## 8. 测试首轮 25 红的原因（值得记下，会绊到后续工作包）

首轮工厂契约测试 28 条里 25 红，根因**不是**实现缺陷：本机有系统代理（7897），于是 `getNetworkAgent()` 返回真 agent、请求走 `undiciFetch` 而非 `globalThis.fetch`，断言全部落空。也就是说那版测试的读数取决于**跑测试这台机器有没有代理** —— 在 CI 上可能相反。

修法是把 `proxy/systemProxy` mock 成确定行为（只有显式给 URL 才产出哨兵 agent，系统代理恒空）并清掉 env 代理变量，让四级优先级的每一级都可被单独断言。运行时用例里则**刻意保留真实的** `systemProxy`（那条用例要验的正是它在 electron 缺席时能否加载），改为 mock undici 的 fetch，并从两条通道里取实际被调用的那一条 —— 于是判据与机器环境无关。

## 9. 未验证 / 不在本轮范围

- `unverified: 桌面应用未实际运行`。本轮全部结论为源码级 + 单测级。桌面行为不变的最终证据要等工作包 C 切换 index.ts 后真跑一次桌面。
- `unverified: Linux 服务器上未运行`。运行时用例证明的是「electron 不可解析时能加载并发请求」，与真机跑 `node out/server/index.js` 不是同一件事。
- **`index.ts` 零改动**（任务书约束）。旧实现仍在原处，两份并存、编译均通过；切换是工作包 C。
- 侦察 §11 的第二个断点（`entry.ts:77` 未传 `persistence`）—— HEAD `d6e5586` 的 commit message 显示「反代刷出的新 token 不再被丢弃 · 四个缝位接上真实实现」，看起来工作包 A / D 已落地，但**本轮未核实**其完整性（不在范围内）。成功状态仍需 C + F 才成立。
- `package.json` / lockfile / `src/renderer/**` / `src/main/server/**` / `src/main/proxy/**` 零改动。

## Update Log

- 2026-08-12 · executor · 工作包 B 落地。新增 `src/main/upstreamApi/{index,types,transport,refresh,sso,usage}.ts`（1319 行）+ `test/main/upstreamApi/{createUpstreamApi,upstreamApiWithoutElectron.runtime}.test.ts` + `test/main/architecture/upstream_api_single_instance.test.ts`（工作包 E）。`index.ts` 零改动。证据：函数体逐字节比对 20 函数 / 15 处改动行 / `UNEXPECTED=0`（`bodies/` + 三个 .cjs 工具）；`typecheck:node` exit 0；`build:server` exit 0；新增测试 40 passed / 0 failed。侦察报告 22 个锚点全部复核零漂移。踩到的坑：① 首轮 25 红源于本机系统代理让请求改走 undici（测试环境依赖，已消除）；② `write_file` 会剥掉行尾空白，导致 9 行伪差异，已原样复原以保住「逐字节」判据。补充侦察 §7 未单独点名的两个必搬函数：`normalizeResetDate`、`fetchRestApi`（后者承载 TokenType 分发铁律）。全套件末次 2 红归属实测为另一 agent 21:23 修改 `src/main/proxy/holdDecision.ts`，非本轮。
