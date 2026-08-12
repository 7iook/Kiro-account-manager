# Server autostart review 修复记录

## 变更

1. `entry.ts` 的全不准入告警改为配置无关的真实描述：当前没有可服务账号；请求会按 HoldGate 配置挂起或立即失败。零记录分支仍指导复制数据文件，全不准入分支仍指导排查准入原因。
2. `serverAutostartPoolSync.test.ts` 不再用错误文案代替行为验证。测试经真实 `bootstrap()` 取得反代实例并走 `/v1/messages` 处理路径：
   - `holdWhenNoAccount=true`：池空请求进入 HELD，响应不结束；
   - `holdWhenNoAccount=false`：池空请求立即结束并返回 503 `No available accounts`。
3. 启动点发现扫描器不再限定接收者名为 `server|proxy`。它跟踪由裸调用或成员调用 `initProxyServer()` 绑定的标识符，并识别普通、`await`、可选链和 bracket `start()` 调用。受控正反样本随门禁提交，保证扫描器自身可证伪。
4. 注释改为真实架构：共享的是池同步原语；“同步后启动”的顺序在面板与服务端刻意各写一次，因为两端空池策略不同；两条顺序断言和发现式门禁负责防漂移。没有抽取带策略回调的共享启动 orchestrator。
5. 在 `panelProxyDeps.ts` 导出最小 `StoredProxyAccountData`，供面板同步契约和 `entry.ts` store 读取边界共用，移除 `as never`。`server/assembly.ts` 的等价读取点未修改，因为不在本任务文件所有权内。

## TDD 红 → 绿证据

### 告警与 HoldGate 两态

- Red：`serverAutostartPoolSync.test.ts`，`5 passed / 1 failed`。真实请求已进入 HELD，但日志仍声称“每个外部请求都会失败/挂起门闸也不会触发”，失败原因与缺陷一致。
- Green：修正文案后同文件 `6 passed / 0 failed`。

### 启动点扫描器

- Red：加入受控自检、仍使用旧扫描器时，`16 passed / 1 failed`；样本 `const p = initProxyServer(); p.start()` 被错误计为 0。
- Green：改为绑定接收者扫描后，门禁文件 `17 passed / 0 failed`。正样本覆盖别名、`await p.start()`、`p?.start()`、`p['start']()`；负样本覆盖未调用初始化器、只取方法引用、无关接收者和 `restart()`。
- 选择小型正则扫描器而非 TypeScript AST：本门禁只需识别“同文件中由 `initProxyServer()` 取得的实例是否调用零参 `start()`”；受控自检直接锁住语法边界，成本和误报面都小于引入 AST 类型追踪。

## 门禁突变证明

每次都只临时改 `src/main/server/entry.ts`，运行架构门禁后立即反向补丁恢复：

| 突变 | 结果 |
|---|---|
| 删除 `syncProxyPoolFromStore(...)` | `16 passed / 1 failed`，报“服务端自启动没有同步池” |
| 把同步移到 `proxy.start()` 之后 | `16 passed / 1 failed`，报“同步池必须在 proxy.start() 之前” |
| 新增 `const unclassified = server.initProxyServer(); void unclassified.start()` | `16 passed / 1 failed`，发现表检测到 `server/entry.ts` 启动点计数变化 |

恢复前 SHA-256：`57E57DA95075AE404E9BB53C0C1DB4798F0111EB6AABCEE7A0FD6134A1FFADA9`  
三次恢复后 SHA-256：`57E57DA95075AE404E9BB53C0C1DB4798F0111EB6AABCEE7A0FD6134A1FFADA9`

## 最终验证

- 定向 Vitest（JSON reporter）：`23 passed / 0 failed`。
- `npm run typecheck:node`：EXIT=0。
- owned files `git diff --check`：EXIT=0。
- 所有本轮 Vitest 临时 JSON 均在读取计数后删除。

## 评审意见处置

- 采纳：错误告警、行为测试缺口、别名扫描漏洞、不准确的“唯一顺序实现”注释、`as never`。
- 拒绝过度重构：没有抽取统一启动 orchestrator。代码证据是面板空池返回 `EMPTY_POOL`，服务端空池仍启动以保留 `onPoolEmpty` 懒补；为这一处刻意差异增加策略回调只会增加抽象。
- 未修改：`src/main/upstreamApi/{refresh,sso,transport,usage}.ts`。`git diff -w --stat` 无输出且 EXIT=0，确认仅空白噪音，按要求留给提交者处理。
- 未修改：`src/main/server/assembly.ts` 的等价 store 读取点；它不在本代理所有权内。

⚡ 契约传播检查：语义检索列出了 `PanelProxyDepsImpl.loadAccountData`、`entry.ts`、`assembly.ts` 与相关测试消费点；本任务拥有范围内的类型和“共享原语/刻意重复顺序”注释已同步，越界的 `assembly.ts` 已明确留注。
