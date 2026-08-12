# Headless server shutdown drain 修复报告

## 结论

独立评审指出的竞态属实。`createServerPersistenceHooks()` 原先把
`persistAccountPatch()` 作为不可观察的 fire-and-forget Promise 启动；
`assembleServer().shutdown()` 又在停止服务后直接返回。只要账号补丁仍在
`applyAccountDataMutation()` 的串行队列中，调用方随后 `process.exit(0)` 就可能让盘上
保留已经被上游吊销的旧 refreshToken。统计写入的 2 秒防抖窗口也没有 flush。

本次只修改：

- `src/main/server/persistence.ts`
- `src/main/server/assembly.ts`
- `test/main/server/serverSeamsWiring.test.ts`
- 本报告

没有修改 `src/main/server/entry.ts`、`src/main/proxy/**`、
`src/main/ipc/panelProxyDeps.ts`，也没有提交、stash 或回退其他工作树修改。

## TDD 红灯证据

先在 `serverSeamsWiring.test.ts` 加入“token 刷新事件后立即 shutdown”回归测试。
测试先占住 `applyAccountDataMutation()` 的既有串行锁，使 token 补丁确定地停在队列中；
再触发真实装配给 `ProxyServer` 的 `onAccountUpdate`，立即调用 `shutdown()`；
用 `setImmediate` 释放写锁。该构造不依赖真实 I/O 或机器速度：

- 旧实现会在 `setImmediate` 前返回，捕获到盘上的 `refresh-v1`。
- 正确实现会等待 drain，写锁释放并落盘 `refresh-v2` 后才返回。

修复前命令：

```text
npx vitest run "test/main/server/serverSeamsWiring.test.ts" --reporter=json --outputFile=".agent-workspace-red-shutdown-drain.json"
EXIT=1
numPassedTests=16
numFailedTests=1
失败：expected 'refresh-v1' to be 'refresh-v2'
```

随后用假时钟（不推进 2 秒 timer）加入统计 flush 测试。修复前：

```text
EXIT=1
numPassedTests=16
numFailedTests=2
失败 1：refresh-v1 != refresh-v2
失败 2：proxyTotalCredits 为 undefined，期望 321
```

临时 JSON 已在读取计数后删除。

## 实现设计

### 1. 持久化 hook 取得在途 Promise 的生命周期所有权

`createServerPersistenceHooks()` 现在把每个账号更新/封禁写入放进
`Map<Promise<void>, description>`，settle 后由 `finally` 删除。热路径签名仍是同步
`void`，反代请求处理不会等待磁盘写入；等待只发生在停机边界。

`ServerPersistenceHooks` 新增必需的 `drain(): Promise<void>`。设为必需而不是可选，是为了
让以后新增服务端持久化实现时不能再次忘记生命周期收尾；`persistence` 整体仍可选，
保留未注入时的显式告警测试路径。

`drain()` 不是只对一次快照做 `Promise.allSettled()`，而是循环到 pending 集合为空；
这样即便等待期间集合发生变化，也不会把后加入的已接收写入漏掉。装配层仍先停止入口，
因此正常关停时集合有固定点。

### 2. 有界等待与运维可见性

默认 drain 上限为 10 秒，可通过工厂选项覆盖以便确定性测试。当前
`persistAccountPatch()` 没有内部重试；可能长时间不 settle 的实际来源是前序串行写、
文件系统卡住或未来加入的重试。到达上限后：

- `drain()` 返回，关停不会永久挂死；
- 不取消仍在途的 Promise（现有写入 API没有安全取消语义）；
- `console.error` 列出每条尚未确认落盘的写入描述/账号 id；
- 日志明确写出：若包含 refreshToken，盘上可能仍是已被吊销的旧 token。

单独的零上限测试固定了“必须返回 + 必须说清哪条写入未确认 + refreshToken 风险”。
已经 reject 的写入会先走原有精确错误日志，然后从 pending 集合移除；不会伪装成成功，
也不会让 drain 永久等待。

### 3. 去抖写入可 flush

`makeDebouncedStoreSet()` 从单个 setter 改为 `{ set, flush }`。`flush()` 会先取消 timer，
同步写出 Map 中每个键并清空。timer 到期也复用同一个 `flush()`，没有第二份写盘逻辑。
每键写失败仍沿用原有告警，不因一个键失败阻断其余键。

### 4. 关停顺序

`shutdown()` 现在按以下顺序执行：

1. 停面板控制面，阻止关停期间通过面板重新启动/改变反代；
2. 停反代数据面，拒绝新连接并等待/终止在途请求；
3. `await persistence.drain()`；
4. flush credits、input/output tokens、request success/failure 统计；
5. 用停止后的最终会话统计归档；
6. 停会话清扫器。

先 drain 再停入口是错误的：新回调仍可加入 pending，集合没有固定点。只停反代、不停面板
也不完整，因为面板仍可在 drain 期间操作反代。`ProxyServer.stop()` 不清空
`sessionStats`，因此移到 stop 后归档仍能取得最终快照，且服务端测试覆盖了会话归档行为。

## 绿灯证据

定向测试修复后：

```text
npx vitest run "test/main/server/serverSeamsWiring.test.ts" --reporter=json --outputFile=".agent-workspace-green-shutdown-drain.json"
EXIT=0
numPassedTests=18
numFailedTests=0
```

加入有界等待日志测试后的最终服务端范围：

```text
npx vitest run "test/main/server" --reporter=json --outputFile=".agent-workspace-server-shutdown-final.json"
EXIT=0
numPassedTests=112
numFailedTests=0
```

节点类型检查：

```text
npm run typecheck:node
EXIT=0
```

另执行了三个归属文件的 `git diff --check`，EXIT=0；仅有仓库既有的
LF→CRLF 提示，没有空白错误。所有临时测试 JSON 均已删除。

## 桌面路径影响

没有直接行为影响。修改只位于 `server/persistence.ts` 与 `server/assembly.ts`：

- 桌面 `src/main/index.ts` 不使用 `ServerPersistenceHooks` 或这个服务端 debounce helper；
- 共享的 `persistAccountPatch()`、`applyAccountDataMutation()` 及其串行锁没有改动；
- 桌面仍使用自己的 renderer/主进程持久化与 `debouncedStoreSet` 路径。

共同数据文件的字段形状和 revision 语义也未改变。

## 明确拒绝的方案

1. **把 hook 改成同步 await 写盘**：`ProxyServerEvents` 的 hook 契约是 `void`，强行同步会把
   AES/文件 I/O 放进在线请求热路径；修复点应是 shutdown 生命周期边界。
2. **给 token 写也加防抖**：refreshToken 轮换后旧值立即失效，额外窗口会扩大同一故障；
   token 补丁继续逐次进入既有串行收口。
3. **只等待 `state.ts` 的全局 pending**：该队列是模块私有的共享写锁，不是服务端 hook
   的生命周期 API；暴露它会把桌面与服务端关停耦合，并让 shutdown 等待不属于自己的写入。
   在服务端边界跟踪自己启动的 Promise 更小且不会和锁互相等待。
4. **只做一次 Promise 快照**：等待期间若新增 hook，单次快照会漏写；实现循环到集合为空，
   且先关闭生产者。
5. **修改 `entry.ts` 再多等一下**：固定 sleep 既不能证明写完，也会拖慢每次关停。
   `entry.ts` 已经 await `shutdown()`，让 `shutdown()` 自足即可，故没有触碰该文件。
6. **引入队列库/AbortController/重试系统**：现有 `persistAccountPatch()` 已由
   `applyAccountDataMutation()` 串行化，问题只是 Promise 不可观察；新增依赖和取消协议不会
   提高本次正确性，反而扩大共享桌面路径的风险。

## 工作树说明

最终归属代码/测试修改只有上述三个文件。`test/main/server/serverAutostartPoolSync.test.ts`
在检查时已是其他任务的未跟踪文件；本次只把它作为 `test/main/server` 测试范围的一部分运行，
没有编辑或删除。
