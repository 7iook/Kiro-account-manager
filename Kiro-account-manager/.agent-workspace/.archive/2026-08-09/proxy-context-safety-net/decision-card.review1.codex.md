> **[主 AI 下一步]** 本报告使用固定模板 `artifact-decision-card`。逐条过筛后修订被审工件；不得把局部测试绿当作完成，必须按模板要求补齐真实目标、端到端链路和副作用证据。

---

# 第 1 轮评审结论

## 一、原始用户目标与可观察成功状态

文档呈现的原始目标是：使用 Claude Code、Codex、Cursor 等客户端通过反代执行真实 SUB 长任务时，避免因历史过大、单条工具结果过大或上游流停滞而长时间无响应或整次任务失败。

应当以以下生产结果判定成功：

1. 历史超限时，任务仍能继续，保留内容满足结构不变量。
2. 工具结果过大时，客户端最终获得足以继续工作的内容，而不是无标识的语义残缺文本。
3. 上游流停滞时，每种受支持客户端都能识别失败并进入明确的重试或人工处置流程。
4. 任一防护层自身失败时，不得留下部分改写的 payload，也不得制造新的挂起或协议错误。

当前决策卡已描述三类技术机制，但“可识别、可续行”的最终结果尚未与具体客户端消费者逐一闭环。

---

## 二、端到端 Goal → Outcome 链路表

| 链路 | Producer | Artifact | Consumer | 消费后结果 | 失败行为/缺口 |
|---|---|---|---|---|---|
| 历史超限 | `callKiroApiStream` 入口的 Layer A | 截断后的 payload、占位 user/assistant pair | Kiro 上游请求及后续模型响应 | 理论上继续生成并返回客户端 | 当前消息自身超限时不处理；A 先于 B 可能先丢历史；异常发生在部分原地修改后时无法证明 payload 原样恢复 |
| 工具结果过大 | `compressToolResults` | 被过滤器替换的 tool result 文本 | 上游模型，间接影响客户端最终回复 | 理论上减少 body 并保留结构锚点 | 500B 即可能压缩当前 tool result，与“200K+”目标及“不静默改写当前消息”冲突；摘要标识和语义保真契约缺失 |
| SSE 停滞 | 上游原始字节流、watchdog timer | AbortSignal、stall diagnosis、拟议 SSE error | 四条下游 SSE 组装路径及 Claude Code/Codex/Cursor | 理论上客户端收到明确错误并重试 | 文档同时规定“抛 stream error”和“发送 SSE error”，但未确定转换责任点；未说明 AbortController 是否实际绑定 fetch；各客户端是否识别该事件需实现方核实 |
| 功能启用 | Settings UI / `electron-store` | 三个 bool feature flag | `kiroApi.ts` 三层入口 | 用户启用后机制生效 | 未列出设置项从 UI、持久化、IPC/后端读取到请求路径的完整 producer/consumer 链 |
| 验证闭环 | 手工 SUB 会话或假流 | 三类日志、客户端结果 | 开发/验收人员 | 证明功能在生产接线可达 | “三条日志任一出现即算穿线”只能证明一个局部钩子执行，不能证明三项用户结果 |

---

## 三、P0/P1 评审问题

### A1（P0，架构级）SSE stall 的错误消费者与协议落点尚未确定

- **定位锚点**：`**上层集成**（parseEventStream 内 or callKiroApiStream 内）`
- **问题**：方案仍在两个接线位置之间摇摆；一处写“向下游发 SSE error”，另一处要求包装流向 reader 抛异常。抛出流错误并不会自然生成一个合法 SSE error。
- **问题根因**：没有明确唯一的错误转换责任层，也没有逐条说明四条转发路径如何消费 stall。
- **业务影响**：实际结果可能仍是连接直接断开、客户端继续等待或显示未知网络错误，不能保证“明确知道并可重试”。
- **架构影响**：错误契约跨越 stream wrapper、解析器和四个下游组装器，当前设计可能产生多个错误真源或遗漏路径。
- **修改建议**：开工前确定唯一错误映射层；补齐 AbortController 创建→`fetch(signal)`→watchdog abort→解析/组装→每类客户端的完整链路。逐个确认四条路径发送一次且仅一次合法终止事件。客户端是否支持拟议 error 形状需实现方核实。
- **优先级**：P0。

### A2（P0，架构级）Layer B 的改写范围违背核心负向条件

- **定位锚点**：`### Layer B：Tool result 智能压缩（compressToolResults）`
- **问题**：方案遍历 history 和 currentMessage，并以 500B 为最小阈值；原始目标却是单条 200K+，同时明确不得静默改写用户当前正在等待的信息。
- **问题根因**：把“支持压缩”的技术能力扩大成“对几乎所有稍长 tool result 自动改写”，没有区分历史上下文治理和当前结果交付。
- **业务影响**：正常的当前工具输出可能在用户不知情时丢失内容，影响补丁、日志、搜索结果和行号等后续操作。
- **架构影响**：反代从传输防护层变成未经明确契约授权的内容语义改写层。
- **修改建议**：明确历史结果与当前结果的不同政策；阈值应由已陈述的真实超限场景推导。若当前结果允许压缩，必须定义严格触发条件、摘要标识、不可压缩类型和用户可观察行为。重新论证 A→B 顺序，因为先截历史再压缩大结果会造成不必要的上下文丢失；同时定义 current message 单独超过上游限制时的稳定失败结果。
- **优先级**：P0。

### A3（P0，架构级）“异常后 payload 保持原状”的 fail-open 不变量不可由当前契约保证

- **定位锚点**：`**I4**：任何一层内部抛异常`
- **问题**：A、B 都以可变 payload 为参数，并描述在遍历或裁剪中直接修改；顶层 catch 只能捕获异常，不能自动撤销异常前已完成的部分修改。
- **问题根因**：fail-open 被当作异常捕获策略，而不是原子变换/提交策略。
- **业务影响**：异常情况下可能发送结构被部分改写、tool pair 残缺或只压缩了一部分的请求，比明确失败更难诊断。
- **架构影响**：I4 是三层方案共同的安全前提；该前提不成立会使“默认关、可回退”的风险判断失真。
- **修改建议**：规定先在副本或不可变中间结果上完成全部验证，再一次性提交；或给出可证明的回滚策略。Layer C 也应明确 timer callback、abort、reader cancel、正常完成之间的资源清理及一次性终止规则。
- **优先级**：P0。

### F1（P1，功能闭环）成功状态来源与三项结果没有逐项映射

- **定位锚点**：`**Source**：`
- **问题**：来源混合了用户对话、外部 issue 和项目埋点，但没有说明哪个来源支持哪项用户目标；外部 issue 只能佐证技术现象，不能替代本项目用户目标。
- **问题根因**：把问题参考资料和成功状态来源合并记录。
- **业务影响**：可能实现了参考项目的机制，却未解决本项目用户真实操作中的最终失败。
- **架构影响**：验收条件容易退化为日志和钩子存在，而不是客户端可续行。
- **修改建议**：逐项映射“具体角色—操作—业务结果—负向条件—合法来源”，并说明 A/B 的“可识别信号”究竟由客户端看到什么。
- **优先级**：P1。

### F2（P1，功能闭环）现有 Link table 不是完整的 Goal→Outcome 消费链

- **定位锚点**：`**Link table**（consumption anchors）：`
- **问题**：表中只有 Node、Producer、Consumer，没有产出物、消费后状态和失败行为；多个 consumer 仍写成“或”及“4 条路径”的集合。
- **问题根因**：接线点清单被当成端到端链路。
- **业务影响**：容易出现函数已导出、文件已建立，但生产请求未调用或只有部分协议路径生效。
- **架构影响**：无法审查死产出、错误消费者和旁路入口。
- **修改建议**：按三层分别补全 producer、artifact、consumer、result、failure；消除所有候选式接线点，并覆盖重试路径和四条 SSE 路径。
- **优先级**：P1。

### F3（P1，产品边界）三个用户可见开关缺少业务现实论证

- **定位锚点**：`| Feature flag | ⚠️ **本轮新增（默认关）**`
- **问题**：三项防护属于有真实事故依据的 **B 类稳定性保护**，但把它们暴露为三个设置面板开关是另一项新增产品能力，文档没有说明哪类用户应理解或操作这些底层机制。
- **问题根因**：把发布保护手段直接提升为用户配置需求。
- **业务影响**：默认关闭意味着普通用户仍会遭遇原问题；三个技术开关还可能增加错误配置和支持成本。
- **架构影响**：UI、settings schema 和后端传递增加了新的控制面与状态组合。
- **修改建议**：补充具体操作角色、缺失影响和业务分类；若只是灰度/回滚需要，优先比较内部统一配置、单一安全网开关或自动启用策略，删除无真实用户需求的 UI 能力。
- **优先级**：P1。

### F4（P1，架构决策）替代方案比较没有覆盖固定模板要求的三个层级

- **定位锚点**：`| Alternatives rejected |`
- **问题**：当前比较重点是“一份还是三份决策卡”“抄哪套实现”“是否建框架”，没有系统比较沿用现状、局部修复和调整边界三种方向的收益、成本、风险及可逆性。
- **问题根因**：替代项围绕实现组织方式，而非真实业务结果。
- **业务影响**：无法判断三层是否必须一次同时上线，也无法识别最小可用修复。
- **架构影响**：600–800 行及新增 UI 控制面的合理性缺乏决策依据。
- **修改建议**：以用户的三类事故为轴比较现状、单层/局部调整、边界重构，并给出停止条件和分阶段交付条件。
- **优先级**：P1。

### F5（P1，功能闭环）缺少典型、复杂、极端生产场景的完整推演

- **定位锚点**：`## 🧪 4. Test Boundaries（TDD Red 优先）`
- **问题**：测试列表覆盖函数行为，但没有从真实客户端操作走到最终结果的生产场景推演。
- **问题根因**：将组件测试边界等同于业务可用性验证。
- **业务影响**：无法确认多轮工具调用、截断后继续调用、压缩内容被后续工具引用、stall 后重试等流程真的可继续。
- **架构影响**：跨层组合风险和恢复路径没有被验证。
- **修改建议**：至少推演正常长会话、历史超限且含 tool pair、当前超大结果、部分输出后 stall、stall 后重试等场景，并为每个场景写最终客户端结果和失败处置。
- **优先级**：P1。

### F6（P1，契约缺陷）`TruncationResult.reason` 与 fail-open 返回值直接矛盾

- **定位锚点**：`reason?: 'oversize' | 'none'`
- **问题**：接口只允许 `oversize | none`，Fail-open 却要求返回 `reason:'error'`。
- **问题根因**：错误契约和类型签名未同步。
- **业务影响**：实现阶段会出现类型失败、强制断言或丢失错误原因。
- **架构影响**：稳定可观测错误和测试契约不一致。
- **修改建议**：统一返回类型、无触发与失败语义，并明确日志与调用方如何区分正常 no-op 和防护层故障。
- **优先级**：P1。

### F7（P1，验证闭环）当前 e2e 验收条件会产生假通过

- **定位锚点**：`**Verified once by**：`
- **问题**：“三条日志任一即算穿线”只能证明某一层被调用；手工假流也不能证明下游客户端能解析最终错误。INT1 同时写“三层组合”又允许 A 不触发、C 不触发。
- **问题根因**：把内部日志出现当作最终用户结果。
- **业务影响**：可能在 A、B 或 C 仍断链时宣称整体完成。
- **架构影响**：注册、协议消费和恢复路径没有生产级验证门。
- **修改建议**：三类目标分别设置独立验收；每项必须证明入口可达、机制触发、最终客户端结果正确及负向条件未发生。组合测试与单层触发测试应分开。
- **优先级**：P1。

---

## 四、断链、孤儿产出与错误消费者清单

1. `wrapStreamWithStallDetection` 的异常究竟由谁转换成 SSE error 未确定。
2. AbortController 是否传入上游 fetch 的 `signal` 未写明，需实现方核实。
3. 四条 SSE 组装路径只被集合式引用，没有逐条接线与终止行为。
4. 拟议 SSE error 是否被 Claude Code、Codex、Cursor 识别，需实现方核实。
5. 三个 settings 字段缺少 UI → store → 后端读取 → 请求执行的完整链路。
6. A/B 的日志是内部产出，不等于客户端获得可续行结果。
7. A/B 原地修改失败后缺少回滚消费者，可能留下半成品 payload。
8. `reason:'error'` 没有合法类型消费者。

---

## 五、生产业务场景推演

| 场景 | 当前方案推演 | 结论 |
|---|---|---|
| 典型：长会话历史超过 900KB | A 裁剪历史并插占位，再发送上游 | 基本方向成立，但需证明占位与保留 tail 满足真实上游结构，且异常原子回退 |
| 复杂：历史 850KB，当前 tool result 200KB | A 因总 payload 超限可能先丢历史，B 随后才压缩当前结果 | 顺序可能造成不必要的历史损失，需要调整策略 |
| 极端：当前 tool result 超过 10MB | A 不改 current message，B 因 RAW_CAP 跳过 | 请求仍可能必然超过上游限制，当前没有稳定失败或续行结果 |
| 流式：已有三个 chunk 后上游停发 | watchdog abort 并让 reader 抛错 | 若没有唯一错误映射层，客户端可能只见断流而非结构化错误 |
| 恢复：客户端收到 stall error 后重试 | 文档只写“please retry” | 是否自动重试、是否重复提交、是否复用已变异 payload 均未定义 |
| 配置：普通用户未开启三个开关 | 所有机制默认关闭 | 用户仍遭遇原问题；与整体成功状态不一致 |

---

## 六、架构判决

**调整边界。**

三类能力作为反代稳定性保护的业务分类成立，属于 **B 类稳定性保护**，并非技术洁癖；但当前方案把传输防护、内容语义改写、客户端错误协议和用户设置控制面混在同一“内部钩子”边界中。尤其 Layer B 的当前消息改写和 Layer C 的错误协议已经改变外部可观察行为，不能继续宣称“不改客户端可见协议”。

无需推倒三层目标，但必须先明确：

- 内容治理边界：历史上下文与当前结果分别处理；
- 错误映射边界：唯一负责生成下游协议错误的层；
- 原子变换边界：防护失败不得提交部分结果；
- 配置边界：稳定性保护是否真的应由终端用户逐层控制。

---

## 七、开工前必核与注册清单

- [ ] 确定 Layer C 唯一接线点和唯一 SSE 错误映射层。
- [ ] 核实 AbortController 的 signal 实际绑定到 fetch。
- [ ] 核实四条转发路径均能消费并只发送一次 stall error。
- [ ] 核实 Claude Code、Codex、Cursor 对拟议 error 事件的行为。
- [ ] 修正 Layer B 对 currentMessage 的范围、阈值及摘要标识。
- [ ] 决定 B→A 或其他两阶段容量策略，处理 current message 单独超限。
- [ ] 将 A/B 变换改为原子提交或提供可证明的回滚。
- [ ] 修正 `TruncationResult.reason` 类型。
- [ ] 补全三个 feature flag 的 UI、持久化、后端读取、请求消费链。
- [ ] 对三个用户开关完成业务现实分类，删除无真实操作需求的 UI。
- [ ] 分别建立 A、B、C 的客户端级验收，不再使用“任一日志即通过”。

---

## 八、落地决定

**调整方案后开发。**

三类事故均有真实业务影响，方向值得保留；但当前存在客户端错误协议未闭环、内容改写越界以及 fail-open 不成立三个 P0，暂不应进入实现阶段。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: decision-card.md
    anchor: "**上层集成**（`parseEventStream` 内 or `callKiroApiStream` 内）："
    action: replace_section
    intent: 确定唯一错误映射层并补全AbortSignal到四条下游路径及客户端消费结果
    rationale_short: 抛流异常与发送合法SSE事件不是同一行为
  - issue_id: A2
    severity: P0
    target_file: decision-card.md
    anchor: "### Layer B：Tool result 智能压缩（`compressToolResults`）"
    action: replace_section
    intent: 区分历史与当前结果的改写政策并重新确定阈值、执行顺序和当前消息超限行为
    rationale_short: 当前设计会静默压缩正常当前结果并可能先丢失不必要的历史
  - issue_id: A3
    severity: P0
    target_file: decision-card.md
    anchor: "**I4**：任何一层内部抛异常"
    action: replace_section
    intent: 将fail-open改为可证明的原子变换提交并补齐流资源清理规则
    rationale_short: catch不能撤销异常前已发生的原地修改
  - issue_id: F1
    severity: P1
    target_file: decision-card.md
    anchor: "**Source**："
    action: replace_section
    intent: 将每项成功结果映射到具体角色、操作、负向条件和合法来源
    rationale_short: 技术参考不能替代用户目标来源
  - issue_id: F2
    severity: P1
    target_file: decision-card.md
    anchor: "**Link table**（consumption anchors）："
    action: replace_section
    intent: 补全每跳产出物、消费结果和失败行为并消除候选式接线点
    rationale_short: 当前表只能证明符号关系不能证明生产闭环
  - issue_id: F3
    severity: P1
    target_file: decision-card.md
    anchor: "| Feature flag | ⚠️ **本轮新增（默认关）**"
    action: replace_section
    intent: 论证三个用户开关的真实角色与缺失影响并比较更小的灰度控制面
    rationale_short: 稳定性机制成立不代表终端用户需要三个技术开关
  - issue_id: F4
    severity: P1
    target_file: decision-card.md
    anchor: "| Alternatives rejected |"
    action: replace_section
    intent: 比较沿用现状、局部调整和边界重构的收益成本风险可逆性与停止条件
    rationale_short: 当前替代项集中于代码组织而非业务结果
  - issue_id: F5
    severity: P1
    target_file: decision-card.md
    anchor: "## 🧪 4. Test Boundaries（TDD Red 优先）"
    action: insert_before
    intent: 增加典型复杂极端生产场景的端到端推演及最终客户端结果
    rationale_short: 函数测试不能证明真实用户流程可续行
  - issue_id: F6
    severity: P1
    target_file: decision-card.md
    anchor: "reason?: 'oversize' | 'none'"
    action: pattern_rewrite
    intent: 统一截断结果的类型定义、失败语义、日志和调用方分支
    rationale_short: 契约不允许文档要求返回的error值
  - issue_id: F7
    severity: P1
    target_file: decision-card.md
    anchor: "**Verified once by**："
    action: replace_section
    intent: 为三类目标分别建立入口触发客户端结果和负向条件的独立验收门
    rationale_short: 任一内部日志出现不能证明整体链路完成
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 7
one_line: 三层稳定性目标成立，但错误协议、内容改写边界和原子 fail-open 尚未闭环，需调整方案后再开发。
