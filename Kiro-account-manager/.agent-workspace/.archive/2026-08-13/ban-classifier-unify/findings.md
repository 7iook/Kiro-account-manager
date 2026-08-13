# Ban classifier unify — executor findings

## 交付契约（原文，不改写）

成功状态: NOT「把 9 个分类器合并成 1 个」, BUT「一个被上游封禁的账号，重启服务后不会重新进池去打上游；而一个只是撞了 423 的账号，不会被误判成封禁踢出池」
          不该发生：为此引入临时/永久状态机、TTL 或自动探测（见下方「范围红线」）；不该发生：改变挂起门闸现有的判据与恢复路径
          来源: 用户原话「我们只是把已有的逻辑迁移到服务器，并不需要你改变业务」+ 侦察实测的分类器差异表

## 结论

- 核心链路已修：运行期收到 `reason:"ACCOUNT_SUSPENDED"` 后，账号先进入既有 `suspendedAt` 闩锁；其既有落盘信封 `[ACCOUNT_SUSPENDED] ...` 在重启水合时也会被同一分类器识别，因此不会重新入池。
- 裸 `423` 只有同时带 `locked|suspended` 才是封禁；`Payload size: 423 bytes`、`completed in 423 ms` 均准入，`HTTP 423 Locked` 仍被拦截。
- 未新增临时/永久状态机、TTL、恢复探测或 backoff；`accountPool.ts`、`holdDecision.ts` 均未改。
- 通用原文判定已收口到 `src/shared/accountSuspension.ts`。明确禁止修改的 `src/webPanel/ui/format.ts` 仍有一份存量副本，已被架构门禁精确列为临时例外，见“范围红线挡住的事项”。

## 交付链逐格复核

| 节点 | 复核结果 |
|---|---|
| 上游错误文本 → 权威分类 | 已核实：四条生产请求路径现均调用 `classifyAccountSuspension`（`src/main/proxy/proxyServer.ts:2018,3609,3881,4960`）；切号价值判定也复用同一结果（`:4267`）。 |
| 权威分类 → 运行期闩锁 | 已核实：调用 `accountPool.markSuspended`；它设置 `suspendedAt/suspendReason/suspendMessage/isAvailable:false`（`src/main/proxy/accountPool.ts:388-404`）。 |
| 闩锁 → 可用性/挂起判据 | 已核实：`isSuspended` 只认 `suspendedAt > 0`（`:382-385`），`hasBlockedAccount` 仍只认 suspension 或 quota（`:441-457`）。 |
| 挂起判据 → holdDecision | 已核实且未改：`poolHasBlockedAccount` 仍返回 `{action:'hold',reason:'account-blocked'}`（`src/main/proxy/holdDecision.ts:75-111`）。 |
| 落盘错误 → 重启准入 | 已核实：`checkPoolAdmission` 经共享分类器过滤，`buildProxyAccountsFromStore` 的三个生产水合入口继续共用这条准入（`src/main/proxy/activation.ts:104-124,277-307`）。 |
| 展示/选号 | 桌面卡片、列表、选号对话框、store 筛选/统计/通知均消费共享布尔结果；文案和样式仍由各 UI 自己渲染。 |
| 最终 sink | 新增真实链路测试：让 `ProxyServer` 的上游 mock 返回 `ACCOUNT_SUSPENDED` → 断言运行期账号已锁及落盘信封 → 调 `buildProxyAccountsFromStore` 模拟重启 → 断言空数组（`test/main/proxy/holdGateFalsePositive.test.ts:288-329`）。 |

## 普查真实数目与差异

### 改前：9 个通用分类器

1. C1 `proxyServer.ts` 的运行期 detector（权威入口）。
2. C2 `proxy/activation.ts` 的重启准入。
3. C3 `accountService/autoSwitch.ts` 的候选号排除。
4. C4 `main/index.ts` 的主进程刷新调度排除。
5. C5 `renderer/store/accounts.ts` 的筛选、统计、通知、自动刷新排除。
6. C6 `AccountCard.tsx` 的卡片判定。
7. C7 `accounts/_helpers.ts` 的列表判定。
8. C8 `proxy/AccountSelectDialog.tsx` 的选号判定。
9. C9 `webPanel/ui/format.ts` 的手机卡片判定。

### 改前：7 个局部判定点

1. S1 `accountService/backgroundRefresh.ts`：异常文本中的 `AccountSuspendedException|423`。
2. S2 `accountService/check.ts`：异常文本中的 `AccountSuspended|423`，另有结构化 user status 判定。
3. S3 `proxy/kiroApi.ts`：真实 HTTP 423 / `__type` / subscription status 协议字段。
4. S4 `registration/registrar.ts`：注册 usage HTTP 403 + body `suspended`。
5. S5 `AddAccountDialog.tsx`：真实推理探测错误文本。
6. S6 `SubscriptionPage.tsx`：升级候选排除。
7. S7 `RegisterPage.tsx`：注册错误诊断文案。

### 实测分歧

- C1 能在运行期产出 `ACCOUNT_SUSPENDED`，C2 改前不识别其落盘信封，形成“重启复活”。
- `PERMANENTLY_SUSPENDED`、`ACCOUNT_LOCKED`、`用户状态异常` 原先只在 C2 出现，桌面/选号/调度显示与处理不一致。
- C2-C9 把任意带边界的数字 `423` 当封禁；C1 要求同一文本同时带 `locked|suspended`。
- C5/C8 的网络/token 负面分支之后仍统一 `return false`，是无行为效果的重复死分支。

### 改后

- C1-C8 及 S1/S2/S5/S6 均调用 `src/shared/accountSuspension.ts`，不再保留关键词副本。
- S3、S4 保留：它们读取真实 HTTP 状态/结构字段，是协议边界，不是通用 `lastError` 副本。
- S7 保留：只把注册失败翻译成诊断文案，不写账号状态、不影响池准入/选号；旧 `classifyError` 还会把该类别回落为 `unknown`。
- C9 因明确禁止触碰 WebPanel 目录暂留；它仍会把裸 `423` 显示成封禁，但不会影响本轮最终 sink（账号是否进入主进程池）。

## 红 → 绿证据

### RED

命令：

```text
npx vitest run test/main/proxy/holdGateFalsePositive.test.ts test/main/proxy/poolAdmission.test.ts test/main/proxy/accountSuspensionArchitecture.test.ts --reporter=default --reporter=json --outputFile.json=.tmp-ban-red.json *> .tmp-ban-red.log
```

结果：

```text
EXIT=1
Tests  5 failed | 29 passed (34)
ACCOUNT_SUSPENDED 运行期锁定 → 模拟重启水合后不得重新入池
  expected [ { id: 'SOLO', ... } ] to deeply equal []
裸 423（载荷大小/耗时）没有 locked/suspended 语义 → 不得误判封禁
  expected [] to deeply equal [ 'healthy' ]
```

失败点正是业务缺陷，不是 import/语法错误；同一 e2e 的运行期闩锁与落盘信封断言在 RED 已先通过，只有重启准入失败。

### GREEN

同一命令改用 `.tmp-ban-green-focused.*` 后：

```text
EXIT=0
numTotalTests=34
numPassedTests=34
numFailedTests=0
```

自审又发现共享实现把旧副本的宽匹配 `includes('已封禁')` 错窄化成了只认 `账户已封禁`。先加入 `lastError='已封禁'` 保持性用例，得到 `1 failed | 15 passed`，再修正权威分类器；最终 focused 为：

```text
EXIT=0
numTotalTests=35
numPassedTests=35
numFailedTests=0
```

扩展回归（含 4 条指定 hold suites、activation、accountService、renderer liveness）：

```text
EXIT=0
numTotalTests=298
numPassedTests=298
numFailedTests=0
```

## 架构门禁与真实变异证明

- 门禁：`test/main/proxy/accountSuspensionArchitecture.test.ts` 用 TypeScript AST 扫描生产 `src/**/*.ts(x)` 的 `.includes(...)` 与封禁正则；权威分类器必须存在且实际命中，未知文件出现新判定即失败。
- 非空自检：内存 mutant `message.includes('ACCOUNT_SUSPENDED')` 被扫描器命中。
- 真实文件变异：临时向 `src/main/proxy/activation.ts` 插入 `void ''.includes('ACCOUNT_SUSPENDED')` 后运行门禁：

```text
EXIT=1
Tests  1 failed | 1 passed (2)
src/main/proxy/activation.ts:50 ''.includes('ACCOUNT_SUSPENDED')
```

- 随即删除该变异并复跑：

```text
EXIT=0
numTotalTests=2
numPassedTests=2
numFailedTests=0
```

## 挂起门闸未变证明

指定四套均包含在 298 项回归中且全绿：

- `holdGateFalsePositive.test.ts`
- `holdGateStreamWiring.test.ts`
- `holdGateFallbackCrossRegion.test.ts`
- `holdGateMultiPathWiring.test.ts`

`accountPool.hasBlockedAccount` 与 `holdDecision.classifyNoAccountHold` 源码零改动；429 快速重试/不挂起契约也继续通过。

## 判为纯展示而保留的内容

- `AccountCard` / `AccountListRow` / `AccountSelectDialog` 的“已封禁”文字、徽章、颜色和详情弹窗：输入已是共享分类结果，组件只渲染。
- `AddAccountDialog` 对已类型化 `verify.state === 'SUSPENDED'` 的分支：消费 `CredentialProbeResult`，不是重解英文/中文错误。
- `accountService/verify.ts` 与 WebPanel import UI 对 typed `SUSPENDED`/`ApiKeyImportCode` 的文案映射：消费已判定状态。
- `RegisterPage.diagnoseRegError` 的 `suspended` 诊断：只解释一次注册任务的失败文案，不改变账号池、账号持久状态或选号。
- `kiroApi.ts` 的真实 HTTP 423/结构字段与 `registrar.ts` 的 HTTP 403+body 判定不是展示，但属于各自协议边界，合理保留。

## 范围红线挡住的事项

1. `src/webPanel/ui/format.ts` 的 C9 仍是 raw-text 副本，且仍误判裸 `423`。本轮明确禁止触碰 `src/webPanel/**`；待并行任务释放后，应改为导入共享分类器，并删除门禁中的这一条临时例外。
2. 手机解封入口（台账 #27）明确不在本轮，未实现。
3. 侦察建议的 temporary/permanent/unknown 状态机、TTL、自动恢复探测及任何 backoff 均被用户否决，本轮没有留下 TODO，也不建议作为“顺手后续”恢复。

## Review Findings

### 审查发现（per exploration & autonomy charter）

#### 目标对齐审查

- 用户目标：重启不复活真封号，裸 423 不误踢池，同时保持既有挂起/恢复业务。
- 对齐程度：完全对齐核心 sink；WebPanel C9 因用户明确并发红线暂留并如实披露。
- Tier 1 自纠：侦察报告实际位于嵌套代码目录的 `.agent-workspace`，不是 git 根外层路径；报告基线为 `edcb42c`，本轮实码为 `c781f02`，重新普查后数目仍是 9+7。

#### 超范围修改记录

为避免“proxy 修了、调度/store 仍按裸 423 误判”的半收口，除预列目录外还修改：

| 文件 | 必要性 |
|---|---|
| `src/shared/accountSuspension.ts` | 主进程与 renderer 都能安全 import 的纯函数 SSOT。 |
| `src/main/accountService/autoSwitch.ts` | 否则候选号仍把裸 423 当封禁。 |
| `src/main/accountService/backgroundRefresh.ts` | 否则后台刷新仍按任意 423 写封禁错误态。 |
| `src/main/accountService/check.ts` | 否则检查链仍有六个裸 423/AccountSuspended 分支。 |
| `src/main/index.ts` | 否则主进程刷新调度仍使用独立副本。 |
| `src/renderer/src/store/accounts.ts` | 否则筛选、统计、通知、自动刷新仍使用独立副本。 |

本 executor 明确没有修改 `src/main/webPanel/**`、`src/webPanel/**`、`src/main/server/**`、配置或 lockfile；当前工作区这些目录里的 diff 属于并行 executor。

#### 主动发现的问题

- 初次替换后全仓传播复核仍找到 `proxyServer.isSwitchWorthyError` 一处旧私有调用，以及 `check.ts` 两处遗漏；已在声明完成前补齐。最终 `detectSuspendedError` 零命中。
- 自审发现首次共享实现会漏掉旧副本明确识别的裸中文文案 `已封禁`；保持性红测确认后已修正为原语义，并纳入最终 35/35。
- 并行 WebPanel 改动曾导致全量 typecheck/full suite 失败；类型检查随后已恢复为绿，全套仍有该区域的 5 个失败；见“最终验证状态”，未越界代修。

#### 遗漏预警

- C9 是唯一已知未收口 raw classifier；门禁用精确例外把它暴露出来，不能把该例外长期当完成态。

### Discovery Evidence（per exploration & autonomy charter）

- 语义检索查询：定位运行期 classifier → `markSuspended` → `hasBlockedAccount` → holdDecision → restart admission 全链路。
- `codebase-context-engine` 命中 `proxyServer.ts`、`activation.ts`、`accountPool.ts`、`holdDecision.ts` 及对应测试。
- `fast-context` 独立复核生产 raw-text 决策点；随后用源码 `rg` 与 Everything 文件系统内容搜索补齐遗漏。
- 初始实码普查确认 9 个通用副本 + 7 个局部点；面板当天新增文件未增加第 10 个通用分类器。
- 没有创建 commit（用户明确要求审查后再提交）。

## 最终验证状态

- 两条核心缺陷首次 RED→GREEN：通过，34/34；加入中文旧语义保持性红测并修正后，最终 focused 35/35。
- 指定挂起门闸 + 相关跨域回归：通过，298/298，`numFailedTests=0`。
- `npm run typecheck:web`：EXIT=0。
- `npm run typecheck`：并行改动稳定后复跑，EXIT=0（node + web 均通过）。
- 全量 Vitest 最终复跑为 1807 total / 1796 passed / 5 failed / 6 pending；5 个失败和 3 个 unhandled 均来自并行 WebPanel 配置/构建中间态（`ProxyConfigSection` 空配置导致 3 个旧百分比测试无法渲染、旧装配源码形状断言、产物过期），本任务 focused suites 全绿。明确禁止修改这些目录，不能把此状态写成全绿。

## Update Log

- 2026-08-13 executor：完成封禁分类 SSOT、`ACCOUNT_SUSPENDED` 重启准入修复、裸 423 收紧、桌面/调度消费点迁移、AST 门禁与真实变异验证；未 commit。证据见本报告“红 → 绿”“架构门禁”“最终验证状态”。
