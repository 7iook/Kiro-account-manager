# 未提交 server autostart 池同步变更独立审查

审查基线：`HEAD=d8f957ec37a4766b22fab2426d6c87b9080d37b7`。本次仅审阅用户列出的工作树变更；未编辑、暂存、提交或 stash 代码。唯一写入是本报告及按要求生成后删除的临时 Vitest JSON。

## 结论摘要

核心池同步实现本身是对的：面板路径仍然只读一次 store、使用同一映射/绑定上下文/准入日志，并继续走 `replaceAll`，运行期额度、402 标记、风控挂起和断路器状态都有测试实证保留。服务端 store 的运行时数据形状也与面板一致，`accountProxyBindings` 与 `proxyPool` 确实被传入映射；`as never` 隐藏的是 `AccountStorePort.get(): unknown` 的静态类型缺口，不是已发现的运行时形状错配。

但本批次仍有三项重要代码/测试问题：启动红色告警陈述了与真实 HoldGate 行为相反的事实；“发现全部启动点”的门禁可被变量别名轻易绕过；“同步后启动只有一个实现”的自述不成立，当前仍有两个顺序实现。另有完整套件两次都未全绿，因此当前不能批准合入。

## Findings

### IMPORTANT 1 — 红色启动告警错误声称空池一定直接失败、HoldGate 不会触发

锚点：

- `src/main/server/entry.ts:165-175`：告警写着“每个外部请求都会失败（池空 ⇒ 挂起门闸也不会触发，直接报错）”。
- `test/main/server/serverAutostartPoolSync.test.ts:161-190`：测试只匹配该文案，没有发请求验证真实行为，因而把错误描述认证为绿色。
- `src/main/proxy/holdDecision.ts:93-130`：当 `holdWhenNoAccount` 开启、池内无 blocked 账号、没有 pre-body error 时，最终明确返回 `{ action: 'hold', reason: 'pool-empty' }`。
- `src/main/proxy/proxyServer.ts:1783-1787`：空池先触发 `onPoolEmpty`；补池仍为 0 后才进入无账号决策。
- `src/main/proxy/accountPool.ts:453-457`：空池时 `hasBlockedAccount()` 的确为 false，但这不会阻止 `holdDecision.ts:129-130` 的 `pool-empty` 分支。

独立行为验证：

```text
npx vitest run ... test/main/proxy/holdGateFallbackCrossRegion.test.ts --reporter=json ...
numTotalTests=39 numPassedTests=39 numFailedTests=0
其中通过：池空/根本没号可 attempt(无 pre-body error)→ 挂起等换号
```

因此已知风险的四个代码锚点都真实存在（`index.ts:1875`、`:4593`、`proxyServer.ts:1783-1787/1892-1912`、`accountPool.ts:453-457`），但“因为空池使 `hasBlockedAccount()` 为 false，所以门闸永不触发并直接失败”不成立：

- `holdWhenNoAccount=true`：请求会进入 `pool-empty` 挂起；
- `holdWhenNoAccount=false`：请求会失败，但原因是总开关在 `holdDecision.ts:93-99` 关闭，不是 `hasBlockedAccount()` 为 false；
- 无论哪种，池未补入可准入账号前都无法正常服务。

建议把告警改为真实且不依赖配置的表述，例如“当前没有可服务账号；请求将按 HoldGate 配置挂起或失败”，并增加一个真实请求级测试覆盖开关两态。

### IMPORTANT 2 — “发现式”门禁并不能发现每个新启动点

锚点：

- `test/main/architecture/proxy_orchestration_wiring.test.ts:229-248`：扫描器先要求同文件出现 `initProxyServer()`，随后只计数接收者名字逐字为 `server` 或 `proxy` 的 `.start()`。
- `test/main/architecture/proxy_orchestration_wiring.test.ts:263-279`：硬编码表只比较三个文件的计数。

独立执行扫描器同款正则的受控样本：

```text
node -e "... const src='const p = initProxyServer(); p.start()' ..."
{"hasInit":true,"discoveredStarts":0}
```

也就是说，新增以下任一种真实启动路径都可以让期望表完全不变并继续全绿：

```ts
const p = initProxyServer()
await p.start()
```

同类漏检还包括别名 helper、可选链、括号属性访问，以及 `initProxyServer` 与真正 `.start()` 被拆到不同文件。当前“匹配名必须有定义/导入”的自检只保护面板专用顺序断言（`:126-140`），没有保护 discovery 扫描器。

该表并非“硬编码 112 个文件”：它递归扫描约 112 个 `.ts`，但期望表只有 3 个文件，失败消息本身是可操作的。维护成本尚可，问题是检测语法覆盖不足。建议至少加入受控自检样本，证明别名 receiver 也会被发现；更稳妥的是用 TypeScript AST 识别零参 `.start()` 调用并按初始化/类型上下文分类。

### IMPORTANT 3 — “同步后启动只有一个实现、两端共享”不受代码支持

锚点：

- `src/main/ipc/panelProxyDeps.ts:215-229`：新导出函数只执行“读取 → 映射 → `replaceAll`”，完全不调用 `start()`。
- `src/main/ipc/panelProxyDeps.ts:345-355`：面板自己实现 `syncPool()` → 空池判断 → `server.start()`。
- `src/main/server/entry.ts:133-146`：服务端再次实现 `syncProxyPoolFromStore()` → `proxy.start()`。
- `test/main/architecture/proxy_orchestration_wiring.test.ts:113-208`：门禁分别验证这两个顺序副本，反过来证明顺序并未收口为单一实现。

已验证共享的是“池同步原语”，不是“同步后启动的顺序”。实现者报告中“先同步池再启动这条顺序的唯一实现落点”以及代码注释 `panelProxyDeps.ts:195-201` 均不准确。若“顺序只能有一个实现”真是必须不变量，应抽取拥有 `start()` 的共享编排函数，并把两端不同的空池策略作为显式策略/回调；否则应修正文档与 claim，承认这里依靠两条门禁维持两个调用点的相同顺序。

### IMPORTANT 4 — 当前工作树无法复现“完整套件 1679/0”

锚点：`package.json:23` 定义完整测试为 `vitest run`；本批新增/修改测试位于 `test/main/server/serverAutostartPoolSync.test.ts:103-204` 与 `test/main/architecture/proxy_orchestration_wiring.test.ts:113-297`。

按要求用 JSON reporter 独立运行两次完整套件：

```text
# 第一次
numTotalTests=1680 numPassedTests=1667 numFailedTests=7 numPendingTests=6 success=false
EXIT=1

# 第二次
numTotalTests=1680 numPassedTests=1673 numFailedTests=1 numPendingTests=6 success=false
EXIT=1
失败：test/main/proxy/proxyServerDataPathInjection.test.ts
      electron 缺席时 proxyServer 模块仍可加载
```

第一次失败的 4 个文件单独复跑为 `32/32 passed`，说明这里至少存在并发/隔离波动；但第二次全套仍失败，所以不能把当前状态报告为全绿。当前总数也是 1680，而不是自述的 1679。临时 JSON 均已删除。

这几项失败看起来不由本批语义改动直接造成，但“可合入”仍缺一份可复现的完整绿色证据；至少应先定位并稳定该套件，或给出仓库认可的串行/隔离验证命令及绿色 JSON。

### MINOR 1 — `as never` 绕过了真正需要的 store 边界类型

锚点：

- `src/main/server/entry.ts:140-143`：`() => server.store.get('accountData') as never`。
- `src/main/persistence/accountStorePort.ts:103-114`：`get()` 有意返回 `unknown`。
- `src/main/server/assembly.ts:701-716`：同一服务端 store 在懒补路径被断言为与面板完全相同的 `accounts/accountProxyBindings/proxyPool` 形状。
- `src/main/ipc/panelProxyDeps.ts:64-79,148-152`：面板契约及绑定上下文的真实目标类型。

我验证了当前运行时形状没有错配：服务端和桌面复用同一份 `conf` 数据，传给同步函数的是完整 `accountData`，绑定与代理池没有丢失；`bindingContext` 也没有传 `groupIds`，所以启动三态不会因“用户选择了别的分组”而误报红色。`recordCount>0 && poolSize===0` 当前表示准入失败或畸形记录，均不是良性分组过滤。

问题仅在静态契约：`as never` 会让未来 store 形状漂移无法在此处报错。建议导出一个最小 `StoredProxyAccountData` 类型并在两个服务端读取点复用，或加边界解析函数；不要用 `never`。

### MINOR 2 — `upstreamApi/*.ts` 是无关的纯空白改动，不应随本提交交付

锚点：

- `src/main/upstreamApi/refresh.ts:103-119`
- `src/main/upstreamApi/sso.ts:141-145`
- `src/main/upstreamApi/transport.ts:191-207`
- `src/main/upstreamApi/usage.ts:263-313`

独立命令：

```text
git diff -w --stat -- src/main/upstreamApi/{refresh,sso,transport,usage}.ts
# 无输出，EXIT=0
```

确认零语义变化。它们只扩大审阅面并制造 blame/换行噪音，应从本提交排除。

## 其余核验

### 面板行为保持

已对比 `HEAD` 原实现与当前实现。`syncPool` 的可观察序列仍是：

1. 调一次 `loadAccountData()`；
2. 用完整 `bindingContext(data)` 调同一个 `buildProxyAccountsFromStore`；
3. 用同一个 `panel-sync` 来源记录准入跳过；
4. 调 `AccountPool.replaceAll()` 并把池大小返回给原调用方。

新增的 `Object.keys(records).length` 只是纯诊断读取。`replaceAll` 的状态迁移在 `src/main/proxy/accountPool.ts:821-894`，定向 JSON 结果为：

```text
poolResyncPreservesRuntime.test.ts：8/8 passed
覆盖真实额度、402 标记/恢复时刻、风控挂起、断路器计数与 lastUsed
```

因此我验证了正常 plain-object store 数据下的面板路径行为保持；“任意 Proxy 对象 trap 下逐字节等价”不属于该 store 契约，我未作此扩张声明。

### 三态判别

`syncProxyPoolFromStore` 的 `bindingContext` 只传绑定与代理池，没有传 `groupIds`（`panelProxyDeps.ts:148-152,220-227`）；`buildProxyAccountsFromStore` 仅在 `ctx.groupIds` 存在时做分组过滤（`activation.ts:300-328`）。所以用户担心的“良性分组过滤导致红色空池告警”在这条服务端自启动路径不可达。

定向真实 `bootstrap()` 测试为 5/5 通过，覆盖有号、零记录、全不准入、不自启及池大小日志。

### 空池不拒启

我验证了 `server/assembly.ts:701-721` 的 `onPoolEmpty` 每次重新调用 store，并使用同一 `buildProxyAccountsFromStore` 准入真源；`proxyServer.ts:1783-1787` 在请求选择前触发它。因此“零记录首启后再拷数据可在下个请求补池”的结构成立，服务端不照搬面板 `EMPTY_POOL` 有合理依据。

架构门禁的 `.not.toMatch(/EMPTY_POOL/)` 本身不空洞：分支锚点、结束锚点、sync/start 两个索引都各有非负自检。它的主要问题是测试源文本而非真实运行语义，以及 Findings 2 的 discovery 漏检。

### 实现者报告 claims

1. **顺序承重**：已验证；同步后启动可避免启动完成时池仍为空，但旧缺陷并非所有配置下一律“每请求直接失败”，见 Finding 1。
2. **顺序只有一个实现**：未验证，且代码反证；只有同步原语被共享，见 Finding 3。
3. **服务端空池不拒启以保留懒补迁移流**：已验证；但后续请求究竟挂起还是失败取决于 HoldGate 开关。
4. **两个突变各只红 1 条、其余 15 条绿**：我验证了当前断言逻辑确实能抓“直接删除”与“直接后移”；但在只读约束下没有修改生产文件重跑突变，无法独立验证精确的 `15/1` 历史读数。该数字仅见实现者报告，不能标为我的亲验。
5. **1679 passed / 0 failed；typecheck:node=0**：类型检查我复现为 EXIT=0；完整套件我两次都未复现，当前是 1680 tests 且两次 EXIT=1，见 Finding 4。

## 独立验证汇总

```text
git rev-parse HEAD
d8f957ec37a4766b22fab2426d6c87b9080d37b7

npm run typecheck:node
EXIT=0

npx vitest run \
  test/main/architecture/proxy_orchestration_wiring.test.ts \
  test/main/server/serverAutostartPoolSync.test.ts \
  test/main/proxy/poolResyncPreservesRuntime.test.ts \
  test/main/proxy/holdGateFallbackCrossRegion.test.ts \
  --reporter=json --outputFile=<tmp>
numTotalTests=39 numPassedTests=39 numFailedTests=0 success=true

npx vitest run --reporter=json --outputFile=<tmp>
run 1: 1680 total / 1667 passed / 7 failed / 6 pending, EXIT=1
run 2: 1680 total / 1673 passed / 1 failed / 6 pending, EXIT=1
```

## VERDICT
status: NEEDS_CHANGES
critical_count: 0
important_count: 4
minor_count: 2
ready_to_merge: NO
one_line: 核心同步修复正确，但告警与真实 HoldGate 行为矛盾、启动点发现门禁可绕过、顺序并未真正单点收口，且完整套件当前无法复现全绿。
