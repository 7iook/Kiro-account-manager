# Vitest 全套随机红 RCA（GPT-5.6 Sol）

日期：2026-08-13；诊断范围：只读，未改动、暂存、提交或 stash 仓库内容。报告文件是用户明确要求的唯一落盘产物。

## 结论

这不是一个根因，而是同一组“真实资源测试”暴露出的三个已证实缺陷：

1. **`proxyServerDataPathInjection.test.ts` 是默认 5000ms 单测超时。** 原始失败耗时 5006.3341ms；我在两份并行、`--maxWorkers=32` 的完整套件中 2/2 复现，同一测试分别耗时 5014.3885ms、5056.7785ms，第二份还让下一条证书测试耗时 5414.7927ms。错误恰好落在 5 秒边界，不是断言失败。
2. **`importAccounts.server.test.ts` 是 Windows 网络资源耗尽，不是路由回归。** 原始 run 2 的真实错误是 `listen ENOBUFS: no buffer space available 127.0.0.1`，耗时仅 4.6605ms，发生在 `beforeEach -> startServer() -> server.listen(port: 0)`；失败测试标题只是当时准备执行的最后一个测试。`port: 0` 避免 `EADDRINUSE`，但不避免内核端口/AFD 缓冲资源耗尽。
3. **另有一个已实锤的跨进程共享临时文件竞争。** `staticAssets.server.test.ts` 虽为资源根使用 `mkdtempSync`，却把探针写到其父目录固定路径 `%TEMP%\kam-secret-probe.txt`。我并行跑三份资源子集时 1/3 因另一进程 `afterAll` 删除该文件而报 `ENOENT`。

因此，“不同真实端口/TLS 测试轮流红”是资源调度与测试隔离问题，不是固定端口冲突，也没有证据指向跨文件模块状态污染。

## 原始数字

用户两次基线（同一棵 1680 测试树）：

- run 1：1680 total / 1673 passed / 1 failed / 6 pending；失败耗时 **5006.3341ms**，`STACK_TRACE_ERROR`。
- run 2：1680 total / 1673 passed / 1 failed / 6 pending；失败耗时 **4.6605ms**，真实消息为 **`listen ENOBUFS`**。

我测得的压力基线：

- 两份完整套件同时运行，均显式 `--maxWorkers=32`：**2/2 发生 5 秒超时**。当时工作树被其他代理并发改动，已变为 1686 tests；另有 6 个正常断言失败属于用户要求忽略的并发工作，不纳入本 RCA。
  - stress A：1686 total / 1673 passed / 7 failed / 6 pending；目标超时 5014.3885ms。
  - stress B：1686 total / 1672 passed / 8 failed / 6 pending；目标超时 5056.7785ms，下一证书测试 5414.7927ms。
- 10 个真实资源文件，三份同时运行、`--maxWorkers=16`、默认 5 秒：2 份全绿；1 份因固定探针文件竞争 `ENOENT`，即 **共享临时文件竞争 1/3**。该轮首个 proxy import 即使通过也耗时 2438.8–3845.5ms，离 5 秒不远。
- 同一 10 文件集合，两份同时运行、`--maxWorkers=16 --testTimeout=15000`：**2/2 全绿，均为 138/138**。这证明 15 秒可消除本次 CPU 饥饿症状，但单独升超时不是 ENOBUFS 的修复。
- 排除共享探针文件后，7 个真实 HTTP/启动文件四份同时运行：**4/4 全绿，均为 87/87**；本轮未再次复现 ENOBUFS。
- 当前 Windows IPv4 TCP 动态端口范围：49152 起，共 16384 个。压力测试结束后快照：2425 个 TCP 连接，其中 TIME_WAIT 1736、Bound 285、Listen 71。它只能说明测试确实制造大量 TCP 生命周期，不能还原 run 2 瞬时内核水位。

`unverified: ENOBUFS 的精确瞬时阈值/究竟先耗尽动态端口还是 AFD 非分页池未被捕获；原始 JSON 已明确给出 OS 级 ENOBUFS，但其他代理并发跑测是不可控负载，后续 4 路子集压力未复现。`

## 实际 Vitest 配置

仓库只有 `vitest.config.ts` 的顶层 `test` 配置：排除 e2e/node_modules/dist/out，`passWithNoTests:false`，配置 reporter 为 `default`；两个 projects 分别是 main/node 与 renderer/jsdom。没有设置任何资源、超时或并发选项。

Vitest 4.1.10 因而解析为：

- `testTimeout: 5000ms`；`hookTimeout: 10000ms`；`teardownTimeout: 10000ms`。
- `pool: 'forks'`；`isolate: true`。
- `fileParallelism: true`（未关闭时不会把 maxWorkers 强制为 1）。
- `sequence.concurrent` 未启用；文件内普通 `it` 本来就是顺序执行。
- `retry` 未配置，即不重试。
- `poolOptions` 未配置；而且 Vitest 4 已删除 `poolOptions`，使用它会收到迁移警告，不能作为本仓修法。
- `maxWorkers` 未配置；本机 `availableParallelism()` 为 32，因此没有仓库级资源上限。`unverified: forks pool 在本次普通命令最终选择的精确默认 worker 数未打印；压力复现使用的是显式 32。`

CLI 的 `--reporter=json` 覆盖了配置中的 `default` reporter，所以用户运行时没有人类可读输出。

## 候选机制判定

- **固定端口竞争：否。** 所有确认会真实监听的测试都用 `127.0.0.1` + `port: 0`。检索到的 3456/5580/5590/6000/8899 等非零端口均是 stub、配置解析断言或地址拼装数据，没有进入真实 `listen`。原始错误也是 ENOBUFS，不是 EADDRINUSE。
- **每测试超时：是，解释 proxy 失败。** 5006ms、5014ms、5057ms、5415ms 与默认 5000ms 精确对齐；完整高并发 2/2 复现。
- **共享临时目录/制品：大部分否，但静态探针是确定缺陷。** TLS 用例每个 `beforeEach` 都 `mkdtempSync('kam-k2-proxytls-')`，多实例另有随机目录，不共享证书。server 目录也都使用 `mkdtempSync`。例外是 `%TEMP%\kam-secret-probe.txt` 固定兄弟文件，已 1/3 复现竞争。
- **跨文件模块级状态：排除为这两次根因。** `isolate:true` 且 forks pool；每文件有独立模块图。文件内部虽有 `servers[]`、全局 stub 状态，但均在 before/after hook 重置。
- **泄漏 server/timer：未发现正常路径泄漏。** WebPanelServer.stop 会清 timer、停止 session sweep、destroy sockets，再 close；ProxyServer 测试使用 stop，TLS 用例还在 finally 内 stop。server bootstrap 用例 shutdown。超时/进程被杀时可能跳过清理，但没有证据表明它先于本次错误发生。
- **真实原因的第二支：Windows 内核网络资源压力。** `port:0` 仍要分配监听 socket；每次 fetch 还会产生客户端 socket/TIME_WAIT。大量测试文件并行、且其他代理同时跑全套时，`listen` 可直接返回 ENOBUFS。

## 真实资源测试影响面

确认真实启动 HTTP/HTTPS 或完整 server bootstrap 的文件：

1. `test/main/proxy/proxyServerDataPathInjection.test.ts`（真实自签证书落盘 + HTTPS，port 0）
2. `test/main/proxy/holdGateSessionLifecycle.test.ts`（真实 ProxyServer，多次 start/stop，port 0）
3. `test/main/webPanel/importAccounts.server.test.ts`（每个测试 beforeEach 启一台 WebPanelServer）
4. `test/main/webPanel/proxyRoutes.test.ts`（大量测试各启一台 WebPanelServer）
5. `test/main/webPanel/server.test.ts`（大量真实 HTTP、生命周期和 LAN 绑定测试）
6. `test/main/webPanel/staticAssets.server.test.ts`（大量真实 HTTP + 固定兄弟探针文件）
7. `test/main/accountService/checkPersistence.test.ts`（真实 WebPanelServer）
8. `test/main/accountService/refreshPersistence.test.ts`（真实 WebPanelServer）
9. `test/main/server/serverAutostartPoolSync.test.ts`（bootstrap 真面板，部分场景还真反代）
10. `test/main/architecture/server_bundle_esm_interop.test.ts`（真实构建产物 bootstrap + shutdown）

搜索共找到 61 处 `await <对象>.start()` 形态；bootstrap 内的隐式启动不全包含在该数字里。`test/main/server/serverAssembly.test.ts` 等虽写临时盘或含端口配置，但不真实监听，不应被一刀切进慢资源池。

## 为什么 JSON 是 STACK_TRACE_ERROR

这是 Vitest 4.1.10 JSON reporter 的序列化缺陷/表现，不是被测代码抛出的错误。`@vitest/runner/dist/chunk-artifact.js` 在收集每条测试时主动创建 `new Error('STACK_TRACE_ERROR')`（约 1784 行），把它作为预捕获调用点栈传给 `withTimeout`；真正超时时 `makeTimeoutError` 应把消息改成 `Test timed out in ...`，同时保留该栈以定位测试声明。

默认 reporter 能正确渲染这个合成 TimeoutError，但 JSON reporter 的 `failureMessages` 保留了预捕获 Error 的原始 message/stack，所以只剩 `STACK_TRACE_ERROR`。我用 `--testTimeout=1` 强制探针验证：

- default reporter 明确打印 `Error: Test timed out in 1ms`，并定位到测试源码行；
- 同一次运行的 JSON `failureMessages[0]` 仍是 `Error: STACK_TRACE_ERROR`。

立刻可用的诊断命令是双 reporter，而不是只用 JSON：

```powershell
npx vitest run <paths> --reporter=default --reporter=json --outputFile.json=<result.json>
```

这仍应从 JSON 读取计数/退出码；default 控制台仅用于保存首发错误。不要经 `Select-String` 管道判断 `$LASTEXITCODE`。若 CI 只接受结构化文件，应写一个极小 custom reporter，同时保存 task error 的 `name/message/stack`；也可升级到修复该 JSON 行为的 Vitest 版本，但本次未验证更高版本是否已修。

## 排序后的修复计划

### P0：把真实资源测试放入独立、后置、单 worker 的 project（首选）

修改 `vitest.config.ts`：定义上面 10 个文件的 `REAL_IO_TESTS`；现有 `main` project 排除它们，新建 `main-real-io` project 精确 include 它们，并设置：

```ts
test: {
  name: 'main-real-io', environment: 'node', include: REAL_IO_TESTS,
  pool: 'forks', isolate: true, fileParallelism: false, maxWorkers: 1,
  sequence: { concurrent: false, groupOrder: 1 },
  testTimeout: 15_000, hookTimeout: 15_000,
}
```
同时给现有 main/renderer project 设置 `sequence.groupOrder: 0`，确保真实资源组在普通并行组结束后再运行；否则 `main-real-io` 自己单 worker，仍可能与 31 个普通 worker 抢 CPU/网络。`fileParallelism:false` 已会把 worker 强制为 1，`maxWorkers:1` 是显式契约。

这一步针对两个根因：证书生成不再与全套 CPU 风暴竞争；真实 server 文件之间不再同时 bind/fetch。不要写 `poolOptions`：Vitest 4 已移除。不要仅加 `describe.sequential`：文件内当前本来就顺序，它无法串行不同文件。`sequence.concurrent:false` 只防同文件测试并发，也不能单独解决跨文件竞争。

### P0（同一修复集）：消灭固定探针路径

修改 `test/main/webPanel/staticAssets.server.test.ts`：先创建唯一 `CASE_ROOT = mkdtempSync(join(tmpdir(), 'kam-panel-case-'))`，再让 `ASSET_ROOT = join(CASE_ROOT, 'assets-root')`，探针为 `join(CASE_ROOT, 'kam-secret-probe.txt')`；afterAll 只递归删除 `CASE_ROOT`。所有断言引用该唯一 `probePath`。这样仍然测试“资源根之外”，又不会跨 Vitest 进程互删。

给 TLS/临时盘测试补一条结构断言：路径必须位于本测试刚创建的随机根下，且不能等于固定 `%TEMP%` 子路径。现有 `proxyServerDataPathInjection` 已做到 per-test mkdtemp，无需改其目录策略。

### P1：减少真实 server churn，而不是永远靠串行

- `importAccounts.server.test.ts`：可在文件级只启动一台 server，beforeEach 仅替换 `disk/verifyResult/checkedIds` 并重新登录；afterAll 停机。当前每条测试 beforeEach 都重启一台，13 条业务断言没有必要各占一次监听生命周期。
- `staticAssets.server.test.ts`：大多数测试可共享文件级 server；`assetsAvailable` 已是可变依赖。保留专门的 start/stop 生命周期测试独占实例。
- `checkPersistence.test.ts` / `refreshPersistence.test.ts`：评估按 describe 共享 server，beforeEach 重置内存 store/deps。
- `server.test.ts`、`proxyRoutes.test.ts` 中配置和生命周期不同的用例应继续独占；不要为了少 bind 牺牲隔离。

这是长期根治 ENOBUFS 的方向：减少 socket 生命周期总数。资源 project 串行是立即可靠的调度护栏。

### P2：超时策略（局部合理，全局不合理）

**不建议只把全局 `testTimeout` 调大。** 它对 ENOBUFS 完全无效，也会让真实死锁更晚失败。这里局部 15 秒是合理的，因为该 project 明确执行真 RSA 证书生成、真构建产物和真网络；实测合法路径已达 5.4 秒，5 秒预算与工作量不匹配。应在资源 project 或仅证书 describe 上设 15 秒，并保留普通单测 5 秒。

### P3：明确保持 `retry: 0`

不建议 `retry: 1`。本次两个原始失败都很可能重试即过；重试会把 OS 资源耗尽和错误预算不足伪装成绿，并重新制造更多 socket/TLS 工作，甚至加重 ENOBUFS。只有在修复后，为外部不可控服务的测试且同时记录 first-attempt failure 指标时才考虑 retry；本组全部是本机可控资源，不符合条件。

### P4：诊断输出

CI/本地全套改用双 reporter：default 输出保存为日志，JSON 仍作机器判定。短期无需 custom reporter；若团队要求单文件结构化归档，再实现 reporter。不要把 reporter 改动误称为 flake 修复，它只解决“第一次红就看不出原因”。

## 修后验证门

1. 先跑资源 project 20 次（每次独立 JSON），要求 20/20 `numFailedTests=0`，且无 ENOBUFS/ENOENT/STACK_TRACE_ERROR。
2. 四个 Vitest 进程并行跑资源 project 10 轮，验证临时目录跨进程唯一；仍要求 40/40 绿。
3. 完整 `npx vitest run` 连跑 10 次，逐份 JSON 校验 total/passed/failed/pending，不接受“重跑到绿”。
4. 用 `--testTimeout=1 --reporter=default --reporter=json --outputFile.json=<tmp>` 保留一个诊断探针，确认控制台首发能明确显示 `Test timed out` 和源码行。
5. 每轮后检查 TCP/活动句柄回落；若单进程执行后 Listen/Bound 持续增长，再单独追查泄漏。当前正常 teardown 代码没有泄漏证据。

本次复现命令（均从仓库代码目录运行）：

```powershell
npx vitest run --maxWorkers=32 --reporter=json --outputFile="$env:TEMP\kam-rca-stress-a.json"
npx vitest run --maxWorkers=32 --reporter=json --outputFile="$env:TEMP\kam-rca-stress-b.json"
$resource = @(
  'test/main/proxy/proxyServerDataPathInjection.test.ts',
  'test/main/proxy/holdGateSessionLifecycle.test.ts',
  'test/main/webPanel/importAccounts.server.test.ts',
  'test/main/webPanel/proxyRoutes.test.ts',
  'test/main/webPanel/server.test.ts',
  'test/main/webPanel/staticAssets.server.test.ts',
  'test/main/accountService/checkPersistence.test.ts',
  'test/main/accountService/refreshPersistence.test.ts',
  'test/main/server/serverAutostartPoolSync.test.ts',
  'test/main/architecture/server_bundle_esm_interop.test.ts'
)
npx vitest run $resource --maxWorkers=16 --reporter=json --outputFile="$env:TEMP\kam-rca-target-default-a.json"
npx vitest run $resource --maxWorkers=16 --testTimeout=15000 --reporter=json --outputFile="$env:TEMP\kam-rca-target-15s-a.json"
$http = $resource | Where-Object { $_ -notmatch 'proxyServerDataPathInjection|holdGateSessionLifecycle|staticAssets' }
npx vitest run $http --maxWorkers=16 --reporter=json --outputFile="$env:TEMP\kam-rca-port-a.json"
```

## 最终判定

首要执行项不是 retry，也不是全局延长超时；是 **真实资源文件独立后置单 worker + 固定探针路径改为随机根 + 后续减少 server churn**。局部 15 秒超时是对真实 RSA/网络工作量的合理预算，不是独立修复。双 reporter 负责让下一次失败可诊断。
