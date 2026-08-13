# Server assembly production wiring

日期：2026-08-13  
基线：`4517d12` + 本轮三组 sibling 未提交改动  
范围：仅修改 `src/main/server/assembly.ts`，新增 `test/main/server/assemblyProductionWiring.test.ts`；未 commit、未 stash、未 revert。

## 结论

两个生产接线缺口均已闭合：

1. `KIRO_TRUSTED_TLS_PROXY_IPS` 经 `readServerConfig()` 后，现在通过真实 `assembleServer()` 同时进入：
   - `WebPanelServer` 的实时 `getConfig()`；
   - `ProxyServer` 实例配置。
2. `proxyLogStore` 现在由服务端装配使用 `config.dataDir` 初始化，实际文件为 `<dataDir>/proxy-logs.json`；`shutdown()` 最后会强制刷盘。
3. 受信代理列表保持“部署期只读覆盖”：盘上/UI 同名值不能开启信任，运行时值也不会因面板选号或自动换号写回共享 `proxyConfig`。
4. C4 日志查看的“服务端有日志可读”前置条件已经恢复；本任务未越权实现面板查看 UI/路由。

## Gap 1：受信 TLS 代理配置生产接线

### 实现

- 面板：`readPanelConfig()` 在合并盘上配置及 host/port 覆盖后，最终用 `serverConfig.trustedTlsProxyIPs` 覆盖，见 `assembly.ts:543-561`。
- 反代：`initProxyServer()` 改为使用 `readProxyRuntimeConfig(store, config)`，见 `assembly.ts:395-408`。
- 运行时配置先通过 `readProxyConfig()` 剥离任何盘上同名字段，再最后注入环境列表，见 `assembly.ts:579-605`。因此盘上/UI 值无法扩大 forwarded-header 信任边界。
- `ProxyServer.getConfig()` 会返回运行时扩展；面板选号与自动换号都可能把该对象写回 store。两个服务端写回边界均通过 `withoutTrustedTlsProxyIPs()` 清理：
  - 自动换号：`assembly.ts:646-649`；
  - 面板选号：`assembly.ts:1116-1120`。

### 红 → 绿

测试：`test/main/server/assemblyProductionWiring.test.ts` 第一条。

测试不是 parser 孤立断言：

1. 用 `readServerConfig()` 产生环境配置；
2. 走真实 `assembleServer()`；
3. 从真实 `WebPanelServer` 的配置闭包与真实 `ProxyServer.getConfig()` 读取 consumer 实际值；
4. 再走真实面板 `proxyActivateAccount` 装配写回边界，验证运行时字段不会落盘。

红：

```text
numFailedTests=1, numPassedTests=0
Received: ["198.51.100.10"]       # 盘上 webPanelConfig
Expected: ["127.0.0.1", "10.20.0.0/16"]  # 环境配置
```

这证明旧装配实际把盘上值交给面板，环境解析结果没有到达 consumer。

绿：

```text
numFailedTests=0, numPassedTests=1
```

最终整文件：

```text
numFailedTests=0, numPassedTests=2
```

## Gap 2：服务端初始化并刷盘 proxyLogStore

### 直接确认

- `ProxyLogStore.storePath` 初始为空，只有 `initialize(userDataPath)` 才设为 `<userDataPath>/proxy-logs.json`（`proxy/logger.ts:335-343`）。
- 每条 `ProxyLogger` 日志都会进入 `proxyLogStore.add()`（`:194-227`），30 秒节流后写盘（`:401-450`）。
- 修复前 `assembleServer()` 未调用 `initialize()`，`shutdown()` 也未调用 `flushSaveNow()`。

### 实现与路径

- 在真实账号 store 构造/前置校验成功后、任何 `ProxyServer` 构造之前调用：

```text
proxyLogStore.initialize(config.dataDir)
```

位置：`assembly.ts:334-344`。

这复用 K-2 已建立的 `initialize(userDataPath)` 路径注入端口，不读取 Electron，也不猜默认目录。放在 store 守卫之后可避免拒启路径留下日志文件；放在反代构造之前保证第一条代理日志已有落点。

### shutdown 位置

保留既有承重顺序：

```text
panel.stop
→ proxy.stop
→ autoSwitchScheduler.stop（等待在途决定）
→ persistence.drain
→ debouncedStoreSet.flush
→ archiveProxySession
→ sessionStore.stopSweeping
→ proxyLogStore.flushSaveNow
```

日志 flush 放在最后（`assembly.ts:471-499`），原因：

- 面板、反代、自动换号、持久化和会话清扫均已静止，不会在 flush 后重新排出一批日志；
- 能收进停机阶段的最后日志；
- `entry.ts` 的数据目录锁要等整个 `shutdown()` settle 后才释放，因此最终日志写入仍在单实例保护内；
- flush 异常被记录但不阻断 shutdown settle。

### 红 → 绿

测试：`test/main/server/assemblyProductionWiring.test.ts` 第二条，spy 的是生产单例本身。

红：

```text
numFailedTests=1, numPassedTests=0
expected "initialize" to be called once, but got 0 times
```

绿：

```text
numFailedTests=0, numPassedTests=1
initialize(dataDir) 调用 1 次
shutdown() 内 flushSaveNow() 调用 1 次
```

## 日志存储增长边界

`proxyLogStore` 不会随服务器运行月数无界追加：

- 内存窗口 `maxLogs = 10_000`；达到 10,500 后批量裁回 10,000（`proxy/logger.ts:325-333,424-434`）。
- 单条 `data` 序列化上限 4 KiB，超限只保留 preview（`:329-333,403-421`）。
- `proxy-logs.json` 是覆盖写，不是 append-only；快照超过名义 20 MiB 时裁到最近 5,000 条（`:370-388`）。
- 另一个可选的普通文件 logger 默认关闭；若启用，其既有轮转为 10 MiB × 5 文件（`:39-52,159-191`）。

判断：对“长期运行导致随时间无限增长”的风险，现有 10k 滚动窗口 + 单文件覆盖是合适的，因此没有擅自发明天数型 retention。

剩余边界需如实说明：20 MiB 是 safety net，不是严格的硬字节上限——裁到 5,000 条后不会二次检查，且 `message` 本身没有与 `data` 相同的单条字节上限。正常代理请求日志的 message 很短、data 已限 4 KiB，所以本缺口无需扩 scope；若未来要给恶意超长错误消息建立严格磁盘配额，应在 logger owner 下单独处理。

## Electron 路径影响

- Electron 不调用 `assembleServer()`；桌面仍在 `src/main/index.ts:2230` 使用 `app.getPath('userData')` 初始化同一日志 store，并在 `:5970-5974` 刷盘。
- 本次没有修改 logger、Electron 入口或桌面 `WebPanelWiring`。
- 服务端运行时受信代理字段不会写入共享 `proxyConfig`，反而避免数据文件拷回桌面后携带服务端部署信任。
- 因此 Electron 运行行为不变；仅共享数据文件更严格地排除了服务端运行时字段。

## 串行 Vitest 分组

新增测试不调用 `panel.start()` / `proxy.start()`，不绑定端口、不启动子进程；只构造真实装配对象、读取实际 consumer 配置并调用内存中的面板依赖。因此**不需要**加入 `main-real-io`。

相关回归命令包含既有真实端口/子进程测试，它们已由当前 `vitest.config.ts` 分到 `main-real-io`；本任务未修改该配置。

## 拒绝的方案与证据

- **只给 parser 加测试**：拒绝。原缺陷正是 parser 已绿但生产无效；新测试从 `assembleServer()` 走到两个真实 consumer。
- **允许盘上/UI 配置 trusted proxy**：拒绝。信任边界是部署事实；测试故意在盘上放入 `198.51.100.*`，最终 consumer 只能看到环境列表。
- **把运行时字段直接当普通 ProxyConfig 持久化**：拒绝。`ProxyServer` 构造器会展开配置，`getConfig()` 又展开返回；`proxyServer.ts:443-449` 已明确记录装配期事实进 config 会被多个写回点持久化。故在服务端读/写边界清理。
- **从共享 logger 读取 Electron `app.getPath()`**：拒绝。`proxy/logger.ts:18-26` 已把平台路径抽到 `initialize(userDataPath)`；服务端直接传 `config.dataDir`。
- **在 store 前置校验前初始化日志**：拒绝。一次拒绝启动不应在目标目录留下新文件。
- **在停止 producer 之前 flush**：拒绝。后续 stop/drain/archive 仍可能产生日志并重新启动 30 秒保存 timer；最终 flush 必须在所有 producer 静止后。
- **为服务器另造一套日志 retention**：拒绝。现有按条数滚动和覆盖写已经解决时间维度无界增长；严格字节上限的软边界已披露，但不在装配缺口里越权修改。

## 最终验证

从 `F:\Kiro-account-manager\Kiro-account-manager` 执行：

```text
npx vitest run test/main/server test/main/webPanel/trustedTlsProxyConfig.test.ts test/main/webPanel/server.test.ts test/main/proxy/trustedTlsProxy.integration.test.ts ...
Test Files 10 passed (10)
Tests      157 passed (157)
JSON: numFailedTests=0, numPassedTests=157
```

```text
npm run typecheck
EXIT=0
```

```text
npx prettier --check src/main/server/assembly.ts test/main/server/assemblyProductionWiring.test.ts
EXIT=0
```

```text
git diff --check -- src/main/server/assembly.ts test/main/server/assemblyProductionWiring.test.ts
EXIT=0
```

⚡ 传播/占用闸门：`git ls-files` 对新增测试路径零命中；语义检索列出配置、两个 consumer、logger、entry、Electron 入口和新增测试共 7 个相关文件；服务端两个 `getConfig() → proxyConfig` 写回点都已纳入 `withoutTrustedTlsProxyIPs()` 收口，最终 JSON 产出 157/157 通过。
