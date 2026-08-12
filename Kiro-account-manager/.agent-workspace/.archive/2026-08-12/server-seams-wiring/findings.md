# 服务端两处可达断点接线（W-A / W-D）

- 仓库：`F:\Kiro-account-manager\Kiro-account-manager`，git 根在上一层
- 日期：2026-08-12
- 范围：任务 1（接上 4 个已可达的缝位方法）+ 任务 2（`entry.ts` 传 `persistence`）
- 硬约束：不碰 `src/main/index.ts` / `src/main/proxy/**` / `src/renderer/**` /
  `server/adminKeyStore.ts` 及其测试 / `package.json` / lockfile；不 commit

## 0. 锚点亲验（任务书 → 实测）

| 断言 | 任务书 | 实测 | 结论 |
|---|---|---|---|
| `entry.ts` 装配调用缺 `persistence` | `:77` | **`:77`** `const server = assembleServer({ config, adminKeyStore })` | ✅ 未漂移 |
| `onAccountUpdate` 缺 hook 即丢弃 | `assembly.ts:570-574` | **`:568-578`**（`warnOnce(...)` 后 `return`） | ✅ 语义如述，行号差 2 |
| 桌面 `api:` 对象转发 4 个已有 import | `index.ts:3860-3863` | **`:3855-3863`**，`api:{}` 内 7 个成员纯符号转发 | ✅ |
| 4 个方法来自已有模块 | — | `kiroAuthSync.ts:84 resolveProfileArnForWrite` / `:157 writeKiroAuthTokenFile` / `:233 readKiroAuthTokenFile`；`proxy/kiroApi.ts fetchEnterpriseProfileArn` | ✅ 全部 `export` |
| `assembly.ts` 已 import `proxy/kiroApi` | 任务书说已 import | **是**（`:97` 取 4 个符号），但**未取** `fetchEnterpriseProfileArn` → 需加进同一 import | ⚠️ 微修正 |
| `assembly.ts` 已 import `kiroAuthSync` | — | **否**，全无 → 需新增 import | ⚠️ 微修正 |

## 1. 闭包/门禁核实（任务 1 的前置条件）

`test/main/architecture/kernel_without_electron.test.ts` 是权威判据，且**闭包是计算出来的**
（`KERNEL_ENTRY_POINTS` 含 `src/main/server/entry.ts` → 传递闭包自动纳管新 import）。

- `kiroAuthSync.ts` 外部依赖实测只有 `fs/promises` `fs` `path` `os` `crypto`（`:16-20`），
  零 electron、零第三方包 → 进闭包不会让门禁转红。
- `proxy/kiroApi.ts` **已在闭包内**（该测试有一条自检显式断言
  `graph.files` 包含 `src/main/proxy/kiroApi.ts`，理由是 ADR-0002 点名的穿透链）。
  故 `fetchEnterpriseProfileArn` 是零新增闭包成本。

结论：任务 1 不引入任何 electron 依赖；仍会真跑门禁验证，不靠推理。

## 2. `readKiroAuthTokenFile` 吞错形态对服务端的影响（任务书要求评估）

`kiroAuthSync.ts:233-241` 把 `readFile` / `JSON.parse` / 字段缺失三种情况全部归一成
`return null`。契约 `accountService/types.ts:138` 也写的是 `Promise<KiroTokenFileLike | null>`。
**本轮不修**（4 个生产消费者 + 契约级返回值，另有独立任务）。

对服务端行为的影响（实测消费点 `accountService/refresh.ts:125-145`
与 `backgroundRefresh.ts:200-215`）：`null` 走的是
`syncSkipReason = '磁盘上未找到 kiro-auth-token.json（IDE 未登录），跳过磁盘同步'`。

- 服务器上**本来就没有 Kiro IDE**，`~/.aws/sso/cache/kiro-auth-token.json` 正常缺席，
  故 `null` 是**期望值**，不是故障。
- 于是这个吞错在服务端形态下**不改变可观察行为**：损坏文件与不存在文件都跳过 IDE 同步，
  而 IDE 同步在服务器上本无消费者（`assembly.ts:buildRuntimeDeps` 已把
  `scheduleProactiveRenewal` 定为 no-op、`isProactiveRenewalEnabled` 恒 false，同款理由）。
- 唯一值得记一句的差别：日志里会说「IDE 未登录」，而真实原因可能是「文件权限错/内容坏」。
  在服务器上这句话本身就总是对的，故不构成误导。

判定：接线安全，无需为它加任何兜底（加了就是在服务端造第二个真源）。

## 3. 任务 2 的语义裁决（桌面 → 服务端不能照搬的部分）

桌面 `index.ts:661-698` 两个回调的下游动作：

| 回调 | 桌面做法 | 服务端裁决 |
|---|---|---|
| `onAccountUpdate` (`:662`) | `mainWindow.webContents.send('proxy-account-update', {id, accessToken, refreshToken, expiresAt})`，落盘靠 renderer | 走 `persistAccountPatch` 真落盘 |
| `onAccountSuspended` (`:672`) | 推 IPC + **只改 `lastSavedData` 内存快照**（刻意省掉整库 AES 重写） | 走 `persistAccountPatch` 真落盘；**不碰 `lastSavedData`** |

**不能照搬的三处，逐条给理由：**

1. **IPC 推送**：服务端无 renderer。`assembly.ts` 已把 `setBroadcaster` 设成显式 no-op，
   面板走 HTTP 轮询 —— 不是「还没做」，是无消费者。
2. **`lastSavedData` 内存快照捷径**：桌面靠它 + renderer 防抖落盘两条腿走路。服务端
   只写这个快照**永远到不了盘**（它只在 `buildStoreDeps.createBackup` 被读），
   等于把「反代刷了 token 但重启丢」原样保留。故服务端必须走真落盘路径。
3. **桌面 renderer 的 `if (!info.profileArn) return`**（`App.tsx:412`）：桌面这个 handler
   **只处理 profileArn，token 三字段直接丢**。服务端刻意**不**照搬这条早退 ——
   照搬就等于把要修的 bug 复制过来。这是本轮唯一一处「刻意不与桌面逐字对齐」的地方。
   （顺带记录：桌面侧 token 落盘实际依赖 `store/accounts.ts` 的其它路径，
   `proxy-account-update` 这条链在桌面上也只搬 profileArn —— 桌面是否同样漏落盘
   不在本轮范围，登记为观察。）

**写入路径选择**：`persistAccountPatch`（`accountService/persistAccountPatch.ts`）而非
`applyAccountDataMutation` 直调 —— 后者要自己重写「数组/Record 两种形状 + 账号不存在
零副作用中止」的 traversal，那正是该文件头点名的第二份 SSOT。
`persistRefreshResult` 不直接复用：它的入参是 `expiresIn`（相对秒）且强制写
`status:'active'` / 清 `lastError` / `lastCheckedAt`，而反代 `onAccountUpdate` 给的是
**已算好的 `expiresAt` 绝对毫秒**，且该回调也在「切号」时触发（`proxyServer.ts:1790/1954/2005`），
那时把 `status` 按成 active、清掉真实 `lastError` 是无依据的副作用。
故用 `persistAccountPatch` + 本轮自己的纯函数补丁（只写 patch 真带的字段）。

**写入频率核实**（为什么不需要防抖/去重）：`onAccountUpdate` 四个触发点实测
`proxyServer.ts:1582`（刷新成功）+ `:1790` / `:1954` / `:2005`（切号）。后三个都在
`if (!this.config.enableMultiAccount)` 里 —— 仅单账号模式，且切号由配额耗尽/封禁触发、
单请求内有 `triedIds` 去重，**不是每请求一次**。默认多账号模式下只有 `:1582` 会触发。
故整库 AES 写的频率与「刷新次数」同阶，无需引防抖（引了反而会在停机时丢最后一次 token 落盘）。

**异步收口**：hook 签名是同步 `void`，`persistAccountPatch` 是 async →
必须 `.catch()` 兜住。承重理由：`entry.ts:main()` 给 `unhandledRejection` 装的是
**`process.exit(EXIT.UNAVAILABLE)`** —— 一次落盘失败若变成未处理 rejection 会直接杀进程。

## 4. 第三个同族缺口（本轮发现 · 已登记，未纳入本轮）

`setProfileArnPersistCallback`（`proxy/kiroApi.ts:48`）在桌面 `index.ts:800-812` 被装上，
用于 Enterprise profileArn 运行时自愈的回写。**服务端 `assembly.ts` 零调用点**
（实测 `git grep setProfileArnPersistCallback -- src/main` 只命中 index.ts 与 kiroApi.ts）。
病灶与本轮任务 2 同族：运行时解析出的值没有落盘路径。
但它是**新增一处装配调用**（不在任务书两项范围内，且需要判断池回写语义），
故本轮只登记不做，留给主 AI 裁决。

## Update Log

- 2026-08-12 侦察与锚点校正完成，未改任何源文件。三条修正：① `assembly.ts` 未 import
  `kiroAuthSync`、且 `proxy/kiroApi` 的 import 里没有 `fetchEnterpriseProfileArn`
  （任务书说「已 import」只对后者的模块、不对符号）；② `onAccountUpdate` 锚点在 `:568-578`
  不是 `:570-574`；③ 发现第三个同族缺口 `setProfileArnPersistCallback`（未纳入本轮）。

## 5. 实施与验证（全部本轮真跑）

### 改动文件（4 个，无一在禁改清单内）

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/main/server/persistence.ts` | 新增 | 两个补丁纯函数 + `createServerPersistenceHooks()` |
| `src/main/server/assembly.ts` | 改 | 四方法接线（`wiredFreeMethods`）· `unwiredAccountApi` → 导出 `defaultAccountApi` · 导出 `UNWIRED_ACCOUNT_API_METHODS` · 告警改为只点名三个 · **补 `profileArn` 转发**（见下 §6）· 三处过期文档同步 |
| `src/main/server/entry.ts` | 改 | `:77` 传 `persistence: createServerPersistenceHooks()` + import |
| `test/main/server/serverSeamsWiring.test.ts` | 新增 | 16 个测试 |

`git status` 实测只有这 4 项 —— `index.ts` / `proxy/**` / `renderer/**` / `adminKeyStore.ts` /
`package.json` / lockfile 零改动。

### 验证证据

- **Red（承重那一条）**：把 `entry.ts` 的 `persistence` 参数临时撤掉再跑 →
  `RED-CHECK passed=15 failed=1`，失败的正是
  「bootstrap() 起的服务端，反代刷出的新 token 落到盘上」，
  失败原因 `等待超时（2000ms）：经 bootstrap 起的服务端把新 refreshToken 落到盘上`
  —— 即**因为功能缺失而红**，不是语法/import 错。恢复后 16/16 绿。
- **本文件**：`passed=16 failed=0 total=16`
- **门禁 + server 全域**：`test/main/architecture/` + `test/main/server/` +
  `kernelWithoutElectron.runtime.test.ts` → `passed=252 failed=0`。
  **模块图闸门绿** = `kiroAuthSync.ts` 进闭包没有拖进任何 electron 依赖（预判被证实）。
- **`typecheck:node`**：`TYPECHECK_EXIT=0`
- **`build:server`**：`BUILD_EXIT=0`（`out/server/index.js` 673.85 kB，68 modules）
- **全套件**：`passed=1601 failed=0 skipped=6 total=1607`（基线 1580/0/6，+16 本轮 +5 他人）
- **真跑服务端**（`KIRO_DATA_DIR` 指临时目录，`node out/server/index.js`）：启动告警实测输出
  `缺的是 src/main/index.ts 里未导出的 getUsageAndLimits / getUserInfo / refreshTokenByMethod`
  并明写四个方法「已从 proxy/kiroApi 与 kiroAuthSync 直接接上，不在缺口内」
  —— **任务书要求的可观察判据达成**（七个 → 三个）。进程已 `taskkill /PID` 精确清理。

## 6. 实施中发现并修掉的第二个 bug（任务书未提及）

`assembly.ts` 的 `onAccountUpdate` 转发给 hook 时**只传四个字段，漏了 `profileArn`**，
而 `ServerPersistenceHooks.onProxyAccountUpdate` 的契约里声明了它。

这是我写的测试「profileArn 自愈同时写顶层与 credentials」第一次跑就红抓到的
（`等待超时：盘上顶层 profileArn 落地`）。后果：Enterprise profileArn 运行时自愈的值
在契约上存在、在实现里恒为 `undefined` —— 一个静默死字段。而桌面侧那条链
（`renderer/src/App.tsx:412`）**只**处理 profileArn，即这个字段是那条链存在的全部理由。
已修（转发 `account.profileArn`），修完转绿。

## 7. 诚实标注（未验证 / 未做）

- **未在 Linux 上跑**，未接真实上游。「反代真的刷出新 token」这一步由**注入回调**触发，
  不是让反代真去打上游 —— 真打上游需要有效账号 + 网络，属 e2e。
  `unverified: 需真实账号与 Linux 环境`。
- **`refreshTokenByMethod` 仍未接线**，故 owner 的成功状态（关机后反代持续服务）
  **本轮仍不成立** —— 缺的是 ~900 行抽取那个包。本轮做的是「刷出来之后不再丢」，
  是那条链的下半段。上半段落地后无需再改这两个文件。
- **`setProfileArnPersistCallback` 服务端零调用点**（§4）—— 第三个同族缺口，未做，留裁决。
- **`readKiroAuthTokenFile` 吞错未修**（按任务书要求），影响评估见 §2：服务端形态下
  不改变可观察行为。

## Update Log

- 2026-08-12 侦察与锚点校正完成，未改任何源文件。三条修正：① `assembly.ts` 未 import
  `kiroAuthSync`、且 `proxy/kiroApi` 的 import 里没有 `fetchEnterpriseProfileArn`
  （任务书说「已 import」只对后者的模块、不对符号）；② `onAccountUpdate` 锚点在 `:568-578`
  不是 `:570-574`；③ 发现第三个同族缺口 `setProfileArnPersistCallback`（未纳入本轮）。
- 2026-08-12 实施完成。两项任务落地 + 一个自查出的漏字段 bug（`profileArn` 未转发）已修。
  证据：red 15/1 → green 16/16 · 门禁域 252/0 · typecheck 0 · build:server 0 ·
  全套件 1601/0/6 · 真跑服务端确认启动告警从七个方法收窄到三个。未提交（按约束）。
