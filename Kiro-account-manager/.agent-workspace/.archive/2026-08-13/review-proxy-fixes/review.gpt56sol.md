# Proxy fixes 独立评审（HEAD `d8f957e`）

## 结论摘要

本批次不能批准。`d8f957e` 的方向（选中账号是偏好）合理，但生产接线没有实现纯函数测试所宣称的完整语义，并引入了 API Key 账号绑定逃逸；`gptHalt` 的提示注入还会生成不合法的 Anthropic SSE 内容块序列。Hold Gate 的两个读数仍不是单一来源，运行超过 50 次放行后会再次出现累计数与时间线数不一致。

## Findings

### Critical 1 — 单账号 fallback 可越过 API Key→账号绑定，且选中账号本身也未受绑定校验

`getAvailableAccount` 正确构造了 `allowedIds`，并把它纳入 `isAllowed`（`src/main/proxy/proxyServer.ts:1766-1828`）；但单账号分支先直接执行 `getAccount(selectedAccountIds[0])`，没有调用 `isAllowed`（`src/main/proxy/proxyServer.ts:1877-1884`）。选中项缺失时，fallback 的 `isUsable` 虽包含 `isAllowed`，实际候选却来自没有传入白名单排除集的 `getNextAvailableAccount(new Set())`（`src/main/proxy/proxyServer.ts:1900-1908`）。因此候选选择阶段可以选中绑定外账号，而 `resolveSelectedPreference` 不会再用 `isUsable` 校验 `pickAnyUsable()` 的返回值（`src/main/proxy/selectedAccountFallback.ts:84-85`）。

实际生产类探针：

```text
命令: npx tsx -e "<实例化 ProxyServer；keyA 只允许 A；选中 gone；按 B,A 入池；调用 getAvailableAccount(...,'keyA')>"
输出: {"scenario":"binding-fallback","allowed":["A"],"picked":"B"}
退出码: 0
```

这不是仅测试覆盖不足，而是已复现的绑定逃逸。修复时应让所有单账号候选（直接选中、额度自动切换、偏好 fallback）统一经过同一个 `isAllowed + isAccountAvailable` 过滤，并新增经真实 `getAvailableAccount` 的绑定回归测试。

### Critical 2 — GPT halt 提示会破坏 Anthropic SSE 内容块状态机

完成回调先关闭当前文本块并递增 `currentBlockIndex`，但没有把 `hasStartedTextBlock` 复位（`src/main/proxy/proxyServer.ts:4801-4806`）。随后命中 halt 时：

- 原本有文本块：`hasStartedTextBlock` 仍为 true，于是跳过 `content_block_start`，却在已经递增的新 index 上直接发 `content_block_delta`（`src/main/proxy/proxyServer.ts:4936-4949`）。
- 原本没有文本块：会新发 `content_block_start`，但在 `message_delta` / `message_stop` 前不发对应的 `content_block_stop`（`src/main/proxy/proxyServer.ts:4937-4977`）。

两条路径都产生不配对的内容块事件；因此所谓“无害介入”可能让严格客户端拒收或丢弃尾部。现有测试只测纯判定和提示文案（`test/main/proxy/gptHaltDetection.test.ts:26-89`），没有经过 `handleClaudeStream` 检查事件顺序。

验证命令：

```text
npx vitest run test/main/proxy/selectedAccountFallback.test.ts test/main/proxy/gptHaltDetection.test.ts test/main/proxy/modelMapping.test.ts test/main/proxy/holdReleaseObservability.test.ts test/main/proxy/holdGateTimeline.test.ts --reporter=json --outputFile=<tmp>
numPassedTests=57, numFailedTests=0
```

该绿灯没有覆盖 SSE 注入接线。应增加命中/未命中两种流式集成测试，断言每个 `content_block_start(index)` 恰有一个同 index 的 stop，且终端事件只出现一次。

### Important 1 — “选中账号存在但不可用时 fallback”只存在于纯函数测试，生产路径不会调用它

新测试声称“选中号存在但被封/超额，池里有别的可用号 → 回退”（`test/main/proxy/selectedAccountFallback.test.ts:41-45`），但生产代码只有在 `account === null` 时才调用 `resolveSelectedPreference`（`src/main/proxy/proxyServer.ts:1881-1893`）。只要账号仍在池中：

- quota exhausted 且 `autoSwitchOnQuotaExhausted=false`：直接返回已耗尽账号；
- suspended 账号同样不会进入 helper；
- quota 自动切换开启时，切换候选也没有 API Key/分组/capability 过滤（`src/main/proxy/proxyServer.ts:1882-1889`）。

实际生产类探针：

```text
命令: npx tsx -e "<选中 Q；Q quota exhausted；另有健康 H；autoSwitchOnQuotaExhausted=false；调用 getAvailableAccount()>"
输出: {"scenario":"unusable-selected","selected":"Q","picked":"Q","isQuotaExhausted":true}
退出码: 0
```

因此 `selectedAccountFallback.test.ts` 没有覆盖生产接线，且与实际行为相反。应把 helper 调用提升到读取选中账号之后，无论 missing 还是 unusable 都走一次解析。

### Important 2 — Hold Gate 累计数与时间线仍是两份状态，且第 51 次起保证不一致

自动 timer 独立执行 `autoReleaseCount++`，再调用 `releaseAll('auto')`（`src/main/proxy/holdGate.ts:428-435`）；时间线则在另一个方法独立 `push`（`src/main/proxy/holdGate.ts:371-388`）。这不是单一事实源，而是靠调用顺序维持同步。

更直接的问题是时间线每轮最多保留 50 条，超过后主动丢弃旧记录（`src/main/proxy/holdGate.ts:375-378`），而累计计数不设上限。现有测试明确构造 60 次放行并断言时间线只剩 50 条（`test/main/proxy/holdGateTimeline.test.ts:296-306`），同时另一个测试只在一次放行时比较两者（`test/main/proxy/holdReleaseObservability.test.ts:104-124`）。所以原“累计 14 vs 时间线 0”缺陷被推迟成“累计 60 vs 时间线 50”，没有结构性消除。

建议时间线 episode 增加不可截断的 `totalReleaseCount`，界面累计数从该值/统一 release 事件归约得到；展示数组可以继续截断，但不能拿其长度冒充总数。

### Minor 1 — rollback 后 `holdDecision` 留下三个不参与决策的死入参

`poolSize`、`selectedAccountIds`、`selectedAccountInPool` 仍在公开输入类型中（`src/main/proxy/holdDecision.ts:45-63`），实现仅用三个 `void` 消除未使用告警（`src/main/proxy/holdDecision.ts:102-107`）。调用方仍计算选中账号可用性（`src/main/proxy/proxyServer.ts:4343-4363`），但结果不可能影响 action/reason。

这不会直接改变行为，但会让后续维护者误以为 selected-account 仍属于 hold 判据，并增加再次把两层逻辑混回去的风险。应删除这些入参及调用方计算；需要日志归因时在日志层单独取值。

## 被删除测试的覆盖核对

`holdDecisionSelectedMissing.test.ts` 与 `holdSelectedBlockedRegression.test.ts` 中以下契约仍有守护：

- 门闸关闭不挂起、账号封禁/额度耗尽挂起、明确授权失效挂起、429/5xx/400 不挂起、池空挂起：当前集成测试覆盖；第二批测试命令结果为 `numPassedTests=34, numFailedTests=0, numPendingTests=6`，其中 `holdGateFallbackCrossRegion`、`holdGateStreamWiring`、`holdGateSessionLifecycle` 均通过。
- “missing selected 必须 giveup”是被本次产品语义明确撤销的旧断言，不应保留原期望。
- 丢失且未被等价替代的是生产接线级覆盖：missing fallback 必须遵守 API Key binding，以及 existing-but-unusable 必须真正 fallback。新文件只对注入回调的纯函数做断言（`test/main/proxy/selectedAccountFallback.test.ts:17-24`），无法发现上述两个生产缺陷。

原始 7c63d4c 的“残留 id 永久挂起”缺陷没有按旧语义回来：池内有健康号时现在会 fallback；但在绑定过滤修好后，若绑定子集内没有可用号，应进入 hold/报错，而不能逃到绑定外账号。5b0d3b8 要防的“被封账号误判配置错误”也没有回来，当前 hold 判据优先按 `hasBlockedAccount` / auth / transient / empty 分类（`src/main/proxy/holdDecision.ts:109-130`）。

## 已验证

- 模型映射路径：`claudeToKiro` 在入口调用 `mapModelId`（`src/main/proxy/translator.ts:920-925`），构造 payload 时写入 `currentMessage.userInputMessage.modelId`（`src/main/proxy/kiroApi.ts:1644-1652`）；token 裁剪使用同一个已映射 `modelId` 调 `getEffectiveTokenLimit` / `getModelContextLength`（`src/main/proxy/kiroApi.ts:1789-1800`）。GPT 5.6 fallback 为 272K、Claude 4.6+/5 为 1M（`src/main/proxy/tokenCounter.ts:116-135`）。
- 日志计费档位：`resolveLoggedModel` 直接复用 `mapModelId`（`src/main/proxy/modelLogLabel.ts:36-44`），`onResponse` 在构造器统一包装（`src/main/proxy/proxyServer.ts:528-543`），`modelLogLabel`/`modelLogWiring` 测试通过。handler 在记录前也已应用映射（例如 `src/main/proxy/proxyServer.ts:3156-3158`），因此显示档位与实际 payload 一致。
- GPT halt 的异常终止分支先返回，不会再注入提示或双发 terminal（`src/main/proxy/proxyServer.ts:4867-4890`）；正常命中路径也只发一组 `message_delta` + `message_stop`（`src/main/proxy/proxyServer.ts:4966-4978`）。问题是其前面的内容块序列非法，而不是 terminal 双发。
- Hold 事件的日志与 perfDiag 都由同一个 `HoldGateEvent` 出口消费（`src/main/proxy/proxyServer.ts:596-617`）；但累计计数和时间线存储本身并非单源，见 Important 2。
- 429/402 语义在本批审查范围内未发现被重新混用；核心 hold 回归测试通过。

## Could not verify

- 真实 Kiro 上游映射测试因未提供 `KAM_E2E_KSK` 全部 skip：第二批 JSON 为 `numPassedTests=34, numFailedTests=0, numPendingTests=6`，6 个 pending 均来自 `modelMapping.upstream.test.ts`（该文件在 `test/main/proxy/modelMapping.upstream.test.ts:69-108` 使用 `describe.skipIf(!KSK)`）。因此确认了真实 payload 构造路径，未在本次评审中重新联网证明上游 200。
- 没有现成的 GPT halt SSE 接线测试；纯判定测试通过不能证明流合法，且静态状态机检查已发现 Critical 2。

## 与未提交在途工作的交互

未提交的 `src/main/server/entry.ts` / `src/main/ipc/panelProxyDeps.ts` 改动在 server autostart 前调用共享的 `syncProxyPoolFromStore`，会改变请求到来时池是否为空、进而改变 selected fallback 与 hold 分类的触发频率；它没有修改本批文件，也没有直接文本冲突。需要合并验证的交点是：同步后 `poolSize>0` 但 selected id 漂移时，必须在 API Key 绑定子集内 fallback；同步后所有账号被准入过滤掉时，空池仍按当前 hold 语义处理。除此之外未发现与这两处在途改动的直接冲突。

## VERDICT
status: NEEDS_CHANGES
critical_count: 2
important_count: 2
minor_count: 1
ready_to_merge: NO
one_line: 选中账号 fallback 可越过 API Key 绑定，GPT halt 注入会生成非法 SSE，且 Hold Gate 双计数在 50 次后必然再次漂移。
