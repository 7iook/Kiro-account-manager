# GPT halt / Claude SSE 状态机修复记录

## 结论

`handleClaudeStream` 的内容块状态由 `currentBlockIndex`、`hasStartedTextBlock`、
`hasStartedThinkingBlock` 三个可独立漂移的变量表达。完成回调停止文本块并递增索引时没有清除
`hasStartedTextBlock`，导致 GPT halt 提示在新索引上直接发 delta。若完成时活跃的是 thinking
块，halt 分支会新开文本块，但终端事件前不停止它。

修复后用一个判别联合 `activeContentBlock: 'text' | 'thinking' | null` 表达唯一活跃块，并让
`closeActiveContentBlock()` 原子完成 thinking signature 刷出、`content_block_stop`、索引推进
和活跃状态清空。GPT halt 提示始终作为完整的新文本块发出并在终端事件前关闭。

## TDD 红灯证据

命令：

`npx vitest run test/main/proxy/gptHaltClaudeStream.test.ts --reporter=default --reporter=json --outputFile.json=.agent-workspace/gpt-halt-sse-red.json`

- EXIT=1
- JSON：`numFailedTests=2`，`numPassedTests=0`
- 已有文本块路径：`delta references unopened content block 1`
- 完成时无文本块路径：`all content blocks must be stopped: expected [2] to deeply equal []`

发现兄弟缺陷后，在改生产代码前增加第三个用例并再次确认红灯：

- EXIT=1
- JSON：`numFailedTests=3`，`numPassedTests=0`
- signature-only thinking 路径：`content block 0 opened twice`

所有临时 JSON 均在读取计数后删除。

## 绿灯证据

流级测试：

- EXIT=0
- JSON：`numPassedTests=3`，`numFailedTests=0`

联合回归：

`npx vitest run test/main/proxy/gptHaltDetection.test.ts test/main/proxy/gptHaltClaudeStream.test.ts --reporter=default --reporter=json --outputFile.json=.agent-workspace/gpt-halt-sse-regression.json`

- EXIT=0
- JSON：`numPassedTests=12`，`numFailedTests=0`

类型检查：

`npm run typecheck:node`

- EXIT=0

## 两条 halt 路径的实际事件序列

以下省略 payload，只保留 `event(index, blockType/deltaType)`。

### 路径 A：完成回调前文本块仍打开

修复前：

1. `message_start`
2. `content_block_start(0, text)`
3. `content_block_delta(0, text_delta)`
4. `content_block_stop(0)`
5. `content_block_delta(1, text_delta:nudge)` ← 索引 1 从未打开
6. `message_delta`
7. `message_stop`

修复后：

1. `message_start`
2. `content_block_start(0, text)`
3. `content_block_delta(0, text_delta)`
4. `content_block_stop(0)`
5. `content_block_start(1, text)`
6. `content_block_delta(1, text_delta:nudge)`
7. `content_block_stop(1)`
8. `message_delta`
9. `message_stop`

### 路径 B：完成回调时文本块未打开（最后活跃块为 thinking）

修复前：

1. `message_start`
2. `content_block_start(0, text)`
3. `content_block_delta(0, text_delta)`
4. `content_block_stop(0)`
5. `content_block_start(1, thinking)`
6. `content_block_delta(1, thinking_delta)`
7. `content_block_stop(1)`
8. `content_block_start(2, text)`
9. `content_block_delta(2, text_delta:nudge)`
10. `message_delta`
11. `message_stop` ← 索引 2 未停止

修复后在第 10 步前增加 `content_block_stop(2)`，随后各恰好一个
`message_delta`、`message_stop`。

## 不变量测试

测试直调真实 `handleClaudeStream`，只 mock 最低外部边界 `callKiroApiStream`。解析实际
`res.write()` 的 SSE 字节并逐事件验证：

- 每个 index 最多打开一次，且必须恰好停止一次；
- 任意 delta 的 index 在当时必须处于打开状态；
- stop 不能引用未打开的 index；
- 流结束时没有活跃内容块；
- `message_delta`、`message_stop` 各恰好一次。

该不变量不依赖 halt 判定是否准确；即便短回复被误判，输出仍是合法 SSE。

## 兄弟实例

`isThinking && reasoningSignature` 且没有 thinking 文本的分支原来只检查
`hasStartedThinkingBlock`，不会先关闭已打开的文本块。因此它会在同一
`currentBlockIndex` 上再次发 thinking `content_block_start`，并让两个 boolean 同时为真；
完成回调随后又会在递增后的错误索引停止“文本块”。

统一活跃块状态和原子 close helper 同时修复该分支。第三个流级测试覆盖：
text → signature-only thinking → completion → GPT halt。

其余开闭点已逐一核对：

- text ↔ thinking 切换；
- redacted thinking；
- tool use；
- 正常完成；
- abnormal terminal 早返回；
- GPT halt nudge。

工具块和 redacted thinking 块仍按原设计同步 start/delta/stop；异常终止仍发 SSE error 并
早返回，没有伪装为 `end_turn`，也没有重复 terminal。

## 设计取舍与拒绝项

- 没有只补一行 `hasStartedTextBlock = false`：这只能修当前漏赋值，仍保留三个变量靠纪律
  同步，signature-only thinking 已证明第二个漂移实例真实存在。
- 没有引入完整 State class / reducer / 独立 emitter 模块：本函数只有一个并发内的活跃块，
  一个判别联合加一个原子 close helper 已让非法“双活跃”状态不可表达；更大抽象没有对应收益。
- 没有改 halt 判据、提示文案或 stop reason：缺陷是发射协议，不是产品判定。尤其没有把异常
  终止伪装成正常 `end_turn`，避免重引入 `e106792` 的负知识。
- 没有把测试降级成纯函数测试：回归测试经过真实 `handleClaudeStream` 与真实 SSE 序列，
  可捕获索引、顺序和终端事件错误。

## 工作树纪律

仅新增 `test/main/proxy/gptHaltClaudeStream.test.ts`，并只修改
`proxyServer.ts` 的 Claude streaming 区域。未修改 `gptHalt.ts`。`proxyServer.ts`
账号选择区的既有其他代理改动保持原样，未 stash、未 revert、未 commit。

⚡ 契约/序号占用复核：语义检索枚举了 `handleClaudeStream` 全部
`currentBlockIndex` 与 content-block 开闭点；`git ls-files` 复核所有权内已跟踪文件，
新增测试保持未跟踪待用户审阅。安全网本轮真实产出证据为修复前 3/3 fail、修复后 3/3 pass。
