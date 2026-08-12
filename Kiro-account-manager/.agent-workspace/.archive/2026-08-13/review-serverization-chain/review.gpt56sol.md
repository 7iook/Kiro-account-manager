# Serverization chain 独立审查

审查对象：`main` / `d8f957ec37a4766b22fab2426d6c87b9080d37b7`。源码判断均基于 Git 对象或隔离导出的 HEAD；未把工作区在途修改计入结论。

## Findings

### Critical 1 — 反代自启动失败仍被报告成“服务健康”

`src/main/server/entry.ts:120-143` 捕获 `proxy.start()` 的任何异常，仅写一条日志后让 `bootstrap()` 成功返回；随后 `main()` 在 `src/main/server/entry.ts:245-253` 打印“就绪”并保持进程正常运行。与此同时，该文件把面板端口明确指定为 systemd / Docker 的存活信号（`src/main/server/entry.ts:35-37`）。结果是端口冲突、空池或其他启动故障发生后，编排层持续看到健康进程和健康面板，但反代没有监听，直接违反“服务器不得看起来健康却不能服务”的负向条件。

命令证据：

```text
git grep "反代自动启动失败\|shouldAutoStartProxy" HEAD -- test
→ 只有 serverAssembly.test.ts:188-192 对 enabled && autoStart 的纯判据测试
→ 没有 bootstrap 在 proxy.start() 失败时必须失败/降为 unhealthy 的测试
```

建议：只要配置要求自动启动，启动失败就应让进程以非零码退出；若产品坚持保留面板用于修复，则必须提供独立、会反映 proxy readiness 的健康端点，不能继续把面板端口定义成整体健康信号。

### Critical 2 — 正常停机不等待 token 持久化，也不 flush 防抖统计

`src/main/server/persistence.ts:152-177` 把 `persistAccountPatch()` 作为 fire-and-forget Promise 启动，hook 返回 `void`，没有暴露 pending 集合或 `drain()`。`src/main/server/assembly.ts:396-410` 的 `shutdown()` 只停反代、归档会话、停面板；它没有等待这些凭据写入。`src/main/server/assembly.ts:603-604,680-690,737-758` 的 credits/token/request 统计还使用 2 秒防抖，但 helper 只返回 setter，没有 flush API，停机也没有 flush。最后 `src/main/server/entry.ts:252-253` 在 `shutdown()` 返回后立即 `process.exit(0)`。

因此，若 SIGTERM 紧跟在 refreshToken 轮换之后，新 refreshToken 可能只存在于内存，进程退出后盘上仍是已被上游撤销的旧 token；正常停机也会稳定丢掉最后一个防抖窗口内的统计。这正是本链声称已修复的“重启后 401”失效形态。

命令证据：

```text
git grep "pending\|onProxyAccountUpdate\|createServerPersistenceHooks\|shutdown" HEAD -- src/main/server/{persistence,assembly,entry}.ts
→ persistence.ts 只有 fire-and-forget onProxyAccountUpdate
→ assembly.ts 的 pendingValues 只在 timer 回调中 clear
→ shutdown 路径没有 persistence drain，也没有 debounced flush
```

现有 `serverSeamsWiring.test.ts` 会等待落盘后再断言，因此证明“给足时间会写盘”，没有覆盖“事件后立刻 shutdown”的竞态。

建议：让持久化 hooks 跟踪所有在途 Promise 并暴露 `drain()`；让防抖写入器暴露 `flush()`；`shutdown()` 在停止接收新请求后依次 await/flush，再允许 `main()` 退出，并增加 refresh 后立即 shutdown 的回归测试。

### Important 1 — 首启日志密钥的“立即在面板轮换”补救实际不可执行

首启会把完整密钥写入 stdout（`src/main/server/adminKeyStore.ts:809-829`），这符合原始“打印一次”裁决；代码随后明确要求用户登录面板后立即轮换，以消除 journal / docker logs 中仍有效的副本。但服务端 HTTP 路由没有任何轮换端点。全仓唯一生产调用位于 Electron IPC：`src/main/ipc/webPanelWiring.ts:294-301`。`PanelAuth.rotateAdminKey()` 本身存在于 `src/main/webPanel/auth.ts:125-138`，却没有被 headless server 消费。

命令证据：

```text
git grep "rotateAdminKey" HEAD -- src test/main/webPanel
→ 生产调用仅 src/main/ipc/webPanelWiring.ts:301
→ src/main/webPanel/server.ts / routes.ts 零调用
```

好的一面是：也不存在“无鉴权 HTTP 重置”漏洞；所有 `/api/*`（登录除外）先经过 `src/main/webPanel/server.ts:292-325` 的统一 session + CSRF 闸门。问题是当前唯一可行的无日志方案只能在首启前配置 `KIRO_ADMIN_KEY`，生成路径打印出的密钥无法通过手机面板轮换。

建议：增加已登录且通过 CSRF 闸门的轮换端点，调用 `PanelAuth.rotateAdminKey()`；不要增加任何未认证 reset/recovery 端点。

## Verified

1. **生产依赖树无 Electron，服务端 bundle 无 Electron。** 在独立临时目录真跑 `npm ci --omit=dev`：安装 107 packages、postinstall 正常 exit 0、`ELECTRON_EXISTS=False`，`npm ls electron --all --omit=dev --json` 无依赖项。HEAD 快照构建后，`server_build_target.test.ts` 为 `22 passed / 0 failed / 0 pending`；构建产物 Electron 扫描没有 vacuous skip。源码图门禁从真实 `server/entry.ts` 出发，覆盖 ESM、CJS、动态 import，并有受控样本自检（`test/main/architecture/kernel_without_electron.test.ts:133-155,414-553`）。生产树门禁也有闭包注入自检（`test/main/architecture/prod_tree_has_no_electron.test.ts:141-245`）。

2. **当前桌面与服务端各构造一个 upstream API。** 桌面唯一调用在 `src/main/index.ts:296-308`；服务端唯一调用在 `src/main/server/accountApi.ts:69-77`，而 `entry.ts:95-102` 只调用一次该装配函数。门禁会抓直接写出的第二个调用：同文件通过 count、不同 server 文件通过 `server.length`、其他目录通过 allowlist（`test/main/architecture/upstream_api_single_instance.test.ts:49-89`）。它诚实地不保证“同一行运行两次”，见该测试 `:16-21`。

3. **高风险抽取未发现行为漂移。** 抽取前 `getNetworkAgent` 读 `useKProxyForApi`，抽取后读注入 getter（`src/main/upstreamApi/transport.ts:136-152`）；`kiroApiRequest` 的设备 ID 来源改为等价 getter（`:181-253`）；`getUsageAndLimits` 只把 `currentUsageApiType` 换成每次调用的 getter（`src/main/upstreamApi/usage.ts:181-323`）；single-flight Map 从旧模块级状态移入每个 factory 的闭包（`src/main/upstreamApi/refresh.ts:198-232`）。桌面只有一个 factory，故其共享范围不变。工厂行为测试覆盖 getter 热读、代理优先级、UA device ID、single-flight、刷新分支和 usage fallback。

4. **服务端三项语义裁决正确接线。** `useKProxy: () => false`、store 现读 `usageApiType`、kproxy 64-hex device ID 均在 `src/main/server/accountApi.ts:69-77`。K-Proxy 在装配时加载但不启动（`src/main/server/assembly.ts:343-350`），与 headless 主机语义一致。

5. **adminKey 的其余安全属性成立。** 登录经 `safeStringEq`（`src/main/webPanel/auth.ts:145-163`；实现为 `crypto.timingSafeEqual`，`src/main/utils/netGuard.ts:31-52`）。POSIX 文件权限必须不宽于 0600，否则拒启（`src/main/server/adminKeyStore.ts:506-548,594-649`）。空 env、弱值、文件不可读、env/file 冲突均拒启；未配置时生成 256-bit key 并安全落盘。没有无认证 HTTP reset 端点。日志密钥与不可执行轮换补救见 Important 1。

6. **数据失败四态成立。** `src/main/server/config.ts:200-257` 仅允许 absent 映射为空库并打印 notice；unreadable、undecryptable、future version 分别拒启。写权限在 `src/main/persistence/accountStorePort.ts:309-336` 启动前检查；解码器失败必抛且不返回空对象（`:153-203`）。相关测试覆盖错误密钥、垃圾/截断、EISDIR、新版本、不可写和 absent。

7. **token refresh 的正常运行链路已接通。** `entry.ts:95-102` 注入 persistence；`assembly.ts:619-662` 把 proxy refresh 结果转成 `onProxyAccountUpdate`；`persistence.ts:152-177` 调 `persistAccountPatch`；`proxyServer.ts:1662-1686` 在刷新成功后触发该事件。`serverSeamsWiring.test.ts` 的真实 bootstrap 用例确认盘上 access/refresh/expiresAt 更新。停机竞态见 Critical 2。

## Verification

在隔离导出的 `d8f957e` HEAD 快照执行：

```text
npx vitest run <12 个相关测试文件> --reporter=json --outputFile=...
numTotalTests=223
numPassedTests=217
numFailedTests=0
numPendingTests=6
```

6 个 pending 全部是 `server_build_target` 的“产物不存在则 skip”项。随后执行：

```text
npm run typecheck:node
TYPECHECK_EXIT=0

npm run build:server
78 modules transformed
out/server/index.js 717.34 kB
webPanel 36 modules transformed
BUILD_EXIT=0

npx vitest run test/main/architecture/server_build_target.test.ts --reporter=json ...
numPassedTests=22
numFailedTests=0
numPendingTests=0
```

另在干净临时目录执行真实生产安装：

```text
npm ci --omit=dev
added 107 packages in 5s
postinstall: 正常跳过 electron-builder
ELECTRON_EXISTS=False
```

## Could not verify

- 当前主机是 Windows；未在真实 Linux 内核上复跑 chmod / readonly mount 行为。POSIX 分支由注入 platform 的测试覆盖，但这不等价于真实 Linux 文件系统。
- 未向真实 Kiro / AWS 上游发送刷新请求；网络行为由 mock/本地响应测试覆盖。
- “抽取逐字一致”只对四个指定高风险函数及其状态边界做了历史对照，没有对 1000+ 行删除做逐字符证明。

## VERDICT
status: NEEDS_CHANGES
critical_count: 2
important_count: 1
minor_count: 0
ready_to_merge: NO
one_line: 生产树、抽取、四态与正常刷新链路基本成立，但反代启动失败仍报健康，且停机可丢旋转 token；首启日志密钥的面板轮换补救也未接线。
