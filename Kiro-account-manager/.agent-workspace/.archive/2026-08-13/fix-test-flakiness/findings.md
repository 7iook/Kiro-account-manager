# 测试抖动修复与验证

日期：2026-08-13  
范围：只改 `vitest.config.ts`、获授权的测试文件与验证纪律文档；未改 `src/**`，未提交、未 stash、未回退其他代理改动。

## 结论

修前完整套件约每轮失败一条，且失败文件轮换：

- 基线 run 1：1680 total / 1673 passed / **1 failed** / 6 pending（5006ms 超时）。
- 基线 run 2：1680 total / 1673 passed / **1 failed** / 6 pending（`listen ENOBUFS`）。
- RCA 压力基线：两份 32-worker 完整套件 **2/2 超时**；固定探针并发复现 **1/3 ENOENT**。

修后：

- `main-real-io` 独立连续运行：**20/20 绿**，每轮 138 total / 138 passed / 0 failed / 0 pending；日志中 ENOBUFS / ENOENT / timeout / STACK_TRACE_ERROR 均为 0。
- 四个独立 Vitest 进程同时运行 `main-real-io`：**4/4 绿**，每份 138/138/0；上述四类错误均为 0。
- 完整套件连续三轮：**3/3 绿**。
  - run 1：1694 total / 1688 passed / 0 failed / 6 pending。
  - run 2：1696 total / 1690 passed / 0 failed / 6 pending。
  - run 3：1696 total / 1690 passed / 0 failed / 6 pending。
  - 测试总数在 run 1→2 之间增加 2，是共享工作树中其他代理在飞改动造成；三份 JSON 均逐一读取，`numFailedTests=0`。
- `npm run typecheck:node`：EXIT=0。

20 轮资源测试期间还叠加了四进程资源压力和三轮完整套件，机器负载高于单独执行；这与用户说明的多代理并发环境一致，是有价值的压力条件。

## 实施内容

### 1. 后置串行真实资源项目

`vitest.config.ts` 定义精确的十文件 `REAL_IO_TESTS`：

- 普通 `main` 项目明确排除它们。
- 新建 `main-real-io`：`pool:'forks'`、`isolate:true`、`fileParallelism:false`、`maxWorkers:1`、`testTimeout/hookTimeout:15000`。
- `main` / `renderer` 使用 `groupOrder:0`，资源项目使用 `groupOrder:1`。
- 显式 `retry:0`，并注释说明重试会掩盖资源耗尽且制造更多 socket/RSA 工作。
- 未使用 Vitest 4 已移除的 `poolOptions`。

`vitest list` 显示资源项目恰好十文件，普通 `main` 不再包含它们。完整套件 run 3 的时间戳证明：普通项目最后一个文件结束于 `1786573444136.66`，资源项目最早文件开始于 `1786573444505`，即资源组确实后置，而非仅配置了单 worker。

清单逐文件核验了真实 `WebPanelServer.start()`、`ProxyServer.start()` 或 `bootstrap()` 路径；`serverAssembly.test.ts` 没有监听调用，继续留在并行项目。

### 2. 固定探针改为每进程唯一根

`staticAssets.server.test.ts` 现在创建：

- `CASE_ROOT = mkdtempSync(...kam-panel-case-...)`
- `ASSET_ROOT = CASE_ROOT/assets-root`
- `PROBE_PATH = CASE_ROOT/kam-secret-probe.txt`

探针仍在资源根之外，但不再是 `%TEMP%` 下跨进程共享的固定文件。`afterAll` 只清理本轮 `CASE_ROOT`。

结构门禁不是匹配某个旧文件名，而是通用地断言：

- asset root 是本轮随机根的严格子路径；
- probe 是本轮随机根的严格子路径；
- probe 不是 asset root 的子路径。

### 3. 减少免费可消除的监听 churn

- `importAccounts.server.test.ts`：13 条业务断言从每测启动一台改为文件级一台；`beforeEach` 重置 disk / verify result / checked ids / 登录 cookie。`loadAccountsBlob` 改为请求时读取当前 disk，避免共享 server 捕获第一份旧盘。
- `staticAssets.server.test.ts`：30 条业务断言共享文件级一台 server；每测只重置 `assetsAvailable`。

因此这两个文件由原来的约 43 次监听生命周期降到 2 次。

### 4. 双报告验证纪律

已追加到：

- `.agent-workspace/HANDOVER-2026-08-10.md` 的“验证口径纪律”；
- `.agent-workspace/TASKS-2026-08-13.md` §4。

标准命令：

```powershell
npx vitest run <paths> --reporter=default --reporter=json --outputFile.json=<run.json> *> <run.log>
```

JSON 负责机器计数；default reporter 经重定向保留可读失败原因。`*>` 不是管道，`$LASTEXITCODE` 仍来自 Vitest。

强制 `--testTimeout=1` 探针实测：命令预期 EXIT=1；default 日志含 `Test timed out in 1ms` 和测试源码路径，而 JSON 仍含 `STACK_TRACE_ERROR`，证实双报告命令确实产出诊断价值。

## 验证命令

单轮与 20 轮的核心命令：

```powershell
node node_modules/vitest/vitest.mjs run --project=main-real-io `
  --reporter=default --reporter=json `
  --outputFile.json="$env:TEMP\kam-flake-resource-20\run-N.json" `
  *> "$env:TEMP\kam-flake-resource-20\run-N.log"
```

四进程并发：用四个 PowerShell job 同时执行上面的命令，每个进程使用独立 `run-N.json` / `run-N.log`。

完整套件三轮：

```powershell
node node_modules/vitest/vitest.mjs run `
  --reporter=default --reporter=json `
  --outputFile.json="$env:TEMP\kam-flake-full-3\run-N.json" `
  *> "$env:TEMP\kam-flake-full-3\run-N.log"
```

类型检查：

```powershell
npm run typecheck:node
```

首个后台批量脚本曾用 `npx`，后台 PowerShell 对可执行入口解析失败，20 次都在进入 Vitest 前报 `npm error could not determine executable to run`，且没有生成 JSON；这些不计入测试运行或失败率。随后改用仓内固定入口 `node node_modules/vitest/vitest.mjs` 完整重跑 20 轮，得到上面的 20/20。

## 未采纳 / 保留现状

- 不加全局 timeout：普通单元测试继续使用 5 秒，只有真实资源项目用 15 秒。
- 不加 retry：它会把 timeout/ENOBUFS 伪装成绿，并增加资源工作量。
- 不合并 `server.test.ts` / `proxyRoutes.test.ts` 的实例：前者覆盖不同绑定配置和真实 start/stop 生命周期，后者每测有独立 proxy stub、pool 与编排状态；共享会破坏隔离。
- 未把 `checkPersistence.test.ts` / `refreshPersistence.test.ts` 改为共享 server：前者不同 HTTP 场景注入不同 usage 响应，后者大量场景持有不同 refresh 依赖、回调与 IDE 副作用记录。要共享需再引入一层可变依赖间接层，不属于“免费减少 churn”，收益也远小于已消除的 43 次监听。

## 备注

完整套件日志中存在通过用例故意打印/命名的 `ENOENT`（例如 adminKeyStore 的“目录不存在时创建”故障态），不能把纯文本命中当成测试失败；最终判定始终来自每份 JSON 的 `numFailedTests`。资源项目 20+4 份日志中没有任何 ENOBUFS / ENOENT / timeout / STACK_TRACE_ERROR。
