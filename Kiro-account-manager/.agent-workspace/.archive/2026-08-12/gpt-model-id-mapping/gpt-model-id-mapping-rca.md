# GPT 模型 ID 映射错档 · RCA

> 归档:`.agent-workspace/.archive/2026-08-12/gpt-model-id-mapping/gpt-model-id-mapping-rca.md`
> 类型:🐛 Bug flow(既有功能行为错) · 决策项已由用户 2026-08-12 拍板

## 任务清单

- [x] 实测 Kiro `ListAvailableModels` 真实模型清单 + 各档窗口/倍率
  **Evidence**: verify=EU ksk + 7897 代理拉到 17 个模型(直连仅 6 个) · AC=拿到第一手 tokenLimits/rateMultiplier,非文档推断
- [x] 受控对照实测各 model 名的上游接受度
  **Evidence**: verify=`runtime.eu-central-1.kiro.dev` 逐名探测 · AC=sol/opus-5 → 200 出流;裸名/老名/未来名 → 400 INVALID_MODEL_ID
- [x] 修 `mapModelId` 未知 GPT 名原样透传缺陷
  **Evidence**: files=`src/main/proxy/kiroApi.ts` · verify=21 测试绿 · AC=`gpt-5.7-sol`/`gpt-6`/`gpt-4.1` 归一到 Sol 而非透传吃 400
- [x] 裸名 + GPT-4 老名归档到 Sol(用户决策)
  **Evidence**: files=`src/main/proxy/kiroApi.ts` · AC=6 个 GPT 别名全部落 `gpt-5.6-sol`,跨厂商静默换 Claude 已消除
- [x] 修 `tokenCounter` 兜底窗口
  **Evidence**: files=`src/main/proxy/tokenCounter.ts` · AC=gpt-5.6 三档 272000;opus-5/sonnet-5/opus-4.8/4.7/4.6/sonnet-4.6 = 1000000
- [x] 补 `/v1/models` 静态兜底清单 + `modelFamily` GPT-5 分支
  **Evidence**: files=`src/main/proxy/proxyServer.ts` · AC=GPT-5.6 三档 + Claude 5 系已广告且带实测窗口
- [x] 变体再扫:测活候选模型清单同根因漏点
  **Evidence**: files=`src/renderer/src/components/pages/DiagnosePage.tsx` · AC=清单补全,不再用裸名测活误判账号已死
- [x] 全量验证
  **Evidence**: verify=`npx vitest run` 139 passed / 1 skipped(15 例失败全在他人在飞的 `adminKeyStore.test.ts`,零引用已核实);`npm run typecheck` 双端零错 · commit=ed4202c
- [x] 异构工件评审 + 按意见修订
  **Evidence**: verify=`spec-cross-review` 模板 F(codex/gpt-5.6-sol) → NEEDS_CHANGES p0=2 p1=3 · `validation.ok=true` 5 锚点全 CHECKED · review 路径=`gpt-model-id-mapping-rca.review1.codex.md` · AC=5 条全部采纳并落地
- [x] A2 端到端补验(穿过映射点,非只验目标)
  **Evidence**: files=`test/main/proxy/modelMapping.upstream.test.ts` · verify=带 `KAM_E2E_KSK` 真跑 6/6 通过 15.2s · AC=`gpt-4o`→Sol→上游 200 出流;terra/luna 不被误归一
- [x] A5 静态兜底清单适用范围加固
  **Evidence**: files=`src/main/proxy/proxyServer.ts` · AC=拉取失败时打 warn + description 加 `[未校验兜底清单]` 前缀,不再把一次实测当全局能力事实


## 🔴 1. 现象与上下文

用户报:所有 GPT 系列模型被统一映射为 GPT-5.6。

**原失败样本锁定**(评审 A1 · 修复前后同一入口实测对照):

| 客户端传入 | 入口 | 修复前 payload.modelId | 修复前上游 | 修复后 payload.modelId | 修复后上游 |
|---|---|---|---|---|---|
| `gpt-4o` | `/v1/chat/completions` | `claude-sonnet-4.5` | 200(但拿到的是 Claude,非 OpenAI 模型) | `gpt-5.6-sol` | 200 出流 |
| `gpt-5.6`(裸名) | 同上 | `gpt-5.6-sol`(静态 alias 已命中) | 200 | `gpt-5.6-sol` | 200 出流 |
| `gpt-5.7-sol` | 同上 | `gpt-5.7-sol`(正则原样透传) | **400 INVALID_MODEL_ID** | `gpt-5.6-sol` | 200 出流 |
| `gpt-6` / `gpt-4.1` | 同上 | 原样透传 | **400 INVALID_MODEL_ID** | `gpt-5.6-sol` | (同族,归一后可用) |
| `gpt-5.6-terra` | 同上 | `gpt-5.6-terra` | 200 | `gpt-5.6-terra`(**不被改成 Sol**) | 200 出流 |

即用户投诉的「统一映射为 GPT-5.6」实为**两个独立缺陷叠加**:① 白名单外 GPT 名被原样透传 → 400 黑盒;
② GPT-4 老名跨厂商指向 Claude(看起来"不是 GPT-5.6",实则连 OpenAI 都不是)。
时间/版本:v1.7.6 · 2026-08-12。

**四类输入的预期行为**(评审 A1 要求的契约分层,修复后):

| 输入类别 | 样例 | 预期 | 依据 |
|---|---|---|---|
| canonical ID(白名单内) | `gpt-5.6-sol/-terra/-luna` | 原样透传,**绝不改档** | 实测 200;`GPT_CANONICAL_IDS` |
| 已登记裸名 | `gpt-5.6` / `gpt-5` / `gpt-5-6` | 归一到 `GPT_DEFAULT_TIER`(Sol) | 用户 2026-08-12 决策 |
| 历史兼容别名 | `gpt-4` / `4o` / `4-turbo` / `3.5-turbo` | 归一到 Sol(同厂商就近替代) | 用户决策;原 Claude 指向系 2025-01 遗留 |
| 未知 GPT 名 | `gpt-5.7-sol` / `gpt-6` | 归一到 Sol + `console.warn` | 见 §8「未知名降级契约」 |
| 完全未知非 GPT 名 | `foo-bar-99` | 兜底 `claude-sonnet-4.5` + warn | 既有行为,未改 |

**成功状态**(用户视角):**不是**「映射表里每个 GPT 名都有一行」,**而是**「客户端传任何 GPT 系模型名,请求都能真正到达 Kiro 并返回内容,且**归一发生时在服务端日志留痕可追**」。
负条件:不得出现「客户端传了一个看起来合法的 GPT 名 → 上游 400 INVALID_MODEL_ID → 用户看到黑盒失败」。
⚠️ 边界诚实(评审 A1 指出):本轮**不包含**「把实际用档回传给终端用户」——`/v1/models` 的 description 已标注别名去向,
但单次响应体不回传"你实际用的是 Sol"。要做到那一步需改响应装配契约(响应 `model` 字段回填归一后值),
超出本次修复范围,**登记为债**,不宣称已闭环。

来源:用户原话 + 下游消费点前置条件(`translator.ts:421/924` 把 `mapModelId` 结果直接注入 payload `modelId`,上游据此做白名单校验)。


## 🔍 1.5 假设账本

| ID | 假设 | 状态 | 证伪/确认证据 |
|----|------|------|------|
| A | 上游对裸名 `gpt-5.6` 会做 catalog 二次解析,部分端点可用(原代码注释的假设) | 🔴 已证伪 | `runtime.eu-central-1.kiro.dev` 实测裸名 → 400 INVALID_MODEL_ID;同 key 同端点 `gpt-5.6-sol` → 200 出流(对照锚点) |
| B | 未知 GPT 名原样透传可实现前向兼容(原 `/^gpt-\d+.../` 正则的假设) | 🔴 已证伪 | `gpt-5.7-sol` 实测 400 INVALID_MODEL_ID(且经 3 次 429 重试后拿到,非限流误判);Kiro 不做 GPT 名模糊解析 |
| C | 映射表缺档/错档,且窗口元数据也未跟上上游 | 🟢 已确认 | 实测 17 模型清单:GPT-5.6 三档 272K(代码兜底落 200K);opus-5/sonnet-5/4.8/4.7/4.6/sonnet-4.6 均 1M(代码兜底落 200K,低估 5 倍) |
| D | 是账号/区域权限问题而非映射问题 | 🔴 已证伪 | 同一 key 同一端点下 `gpt-5.6-sol` 与 `claude-opus-5` 均 200 正常出流,通道健康;失败只与 model 名相关 |

## 🔍 2. 根因分析

**第一处偏离点**:`src/main/proxy/kiroApi.ts:913`(修复前)
```ts
if (/^gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/.test(lower)) return modelId
```
该分支假定「Kiro 会接受任意 GPT 形状的名字」,以此做前向兼容。实测证伪:Kiro 只认 `ListAvailableModels` 白名单内的 canonical id,任何白名单外的 GPT 名一律 400。于是这条「兼容」分支实际是把用户直接送进 400 黑盒 —— 而 `mapModelId` 存在的全部意义就是避免 400。

**Bug 类别**(§5.2 七类):**接口契约理解歧义**(Interface Contract Ambiguity)—— 对上游 model 名解析能力的假设与实际契约不符。

**并列变体链**(评审 A3 修正:以下**不是**透传正则的次生后果,而是各自独立的缺陷,
共同上位原因是「模型目录事实缺少权威单一真源,散落至少 4 处手维」——这是架构级问题,
本轮只做数据对齐,未建 SSOT,见 §8 债务登记):

| # | 独立缺陷 | 首个偏离点 | 直接证据 | 用户影响 |
|---|---|---|---|---|
| V1(主链) | 白名单外 GPT 名原样透传 | `kiroApi.ts:913` 乐观正则 | `gpt-5.7-sol` → 400 | 请求黑盒失败 |
| V2 | GPT-4 老名跨厂商指向 Claude | `kiroApi.ts:877-880`(2025-01 遗留) | `git log -L` 考古 + 映射表原文 | 要 OpenAI 拿到 Claude |
| V3 | Claude 1M 档被 4.x 通配吃掉 | `tokenCounter.ts:116` 判定顺序 | 实测 opus-5 等 6 个模型 =1M,函数返 200000 | 长上下文提前误判超限(低估 5 倍) |
| V4 | GPT-5.6 窗口无分支 | `tokenCounter.ts` 缺 gpt-5 分支 | 实测 272000,函数落末尾 200000 兜底 | 白丢 26% 可用上下文 |
| V5 | `/v1/models` 静态兜底缺档 | `proxyServer.ts:2860` 清单 | 原清单无 GPT-5.6 三档 / Claude 5 系 | 拉取失败时 UI 缺档 |
| V6 | `modelFamily` 无 gpt-5 分支 | `proxyServer.ts:189` | `gpt-5.6-sol` 落字符串切割兜底 | 分组展示错 |
| V7 | 测活候选清单过期 | `DiagnosePage.tsx:12` | 原清单只有旧 Claude 模型 | 拿裸名测活会误判账号已死 |

V1/V2 共享指纹「对上游标识符做乐观假设」;V3-V7 共享指纹「模型目录多真源漂移」。
两组都在本轮修复,但**根因不同**,不应合并陈述(原稿把它们都写成"同根因次生偏离",判断有误,已改正)。


**考古结论**(`git log -L 875,882`):`gpt-4/4o/4-turbo/3.5-turbo → claude-sonnet-4.5` 这四行是 `89872d0`/`f83c236`(2025-01 项目初期)写的,当时 Kiro 上**只有 Claude、无任何 OpenAI 模型可选**,故指向 Claude 是当年唯一可能;2026-07 上游新增 OpenAI 模型后该映射即过时。它不是有意的跨厂商设计,不属于「推翻前人决策」。

## 🕵️ 3. 变体扫描

重复实现审查(强制首行):
- 内部:`fast_context_search` + `git grep "MODEL_ID_MAP|mapModelId"` → 映射逻辑唯一收口在 `kiroApi.ts:mapModelId`,仅 `translator.ts:421/924` 两个生产 caller,无并行实现,故就地修而非新建。
- 外部:参考项目 `F:\kiro-hub\kiro-proxy\jsjm1986-studio\src\anthropic\model_catalog.rs` 已有成熟范式(单张 `static CATALOG` + 分层匹配 + 拒绝而非静默降级),其注释明确记录了「`contains` 匹配导致 claude-3-opus 静默升到 2.2x 贵档」的同类漏洞。本轮采纳其「白名单 + 不静默透传」思想,但不照搬其「裸名一律拒绝」策略(用户决策为归一到 Sol,以免打断传裸名的现有客户端)。

指纹:**「本地对上游白名单做乐观假设 → 放行未经证实的标识符」**。

| 变体点 | 风险 | 本轮修复 | 备注 |
|---|---|---|---|
| `kiroApi.ts:913` GPT 透传正则 | 高:用户吃 400 黑盒 | ✅ | 改白名单 Set + 归一 |
| `tokenCounter.ts:125-129` GPT 窗口 | 中:272K 当 200K,提前截断 | ✅ | |
| `tokenCounter.ts:116` Claude 1M 档被 4.x 通配吃掉 | 高:1M 当 200K,低估 5 倍 | ✅ | 1M 档正则前置 |
| `proxyServer.ts:2860` 静态清单缺档 | 中:动态拉取失败时 UI 缺档 | ✅ | 补 GPT 三档 + Claude 5 系 + 实测窗口 |
| `proxyServer.ts:189` modelFamily | 低:分组展示错 | ✅ | 加 gpt-5 分支 |
| `DiagnosePage.tsx:12` 测活候选 | 中:用裸名测活会误判账号已死 | ✅ | 清单补全 |
| `clientConfig.ts:424` 窗口 | 无 | 不需改 | 取 `m.maxInputTokens` 真实值,随动态清单自动正确 |
| `index.ts:3743` 测活默认 model | 无 | 不需改 | `claude-sonnet-4.5` 是有效 id,且被 UI 显式选择覆盖 |

## 👥 4. 真实场景模拟

1. **Claude Code 默认配置传裸名**:`ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.6` → 修复前首端点 400(旧注释称靠第三个端点 fallback,实测 V2 直接拒);修复后归一 Sol 首端点即命中。
2. **客户端按广告窗口裁剪上下文**:`/v1/models` 报 200K 而真实 272K → 客户端白丢 26% 可用上下文;Claude 1M 档更严重(丢 80%)。已按实测值广告。
3. **上游限流与「名字无效」同形**:探测时首轮 6 个名全 429,若不做对照会误判「所有名都不可用」。本轮以 `gpt-5.6-sol`/`claude-opus-5` 作对照锚点 + 指数退避重试区分二者(E-148 同族:错误文本的形状不等于根因)。
4. **地区决定返回子集**:直连拉到 6 个模型(Claude 全系缺失),走 7897 代理拉到 17 个 —— 若拿直连结果当权威会误判「该账号无 Claude 权限」并写错映射表。
5. 未处理(明确列出):Kiro 未来新增 GPT tier(如真出 `gpt-5.7-sol`)时,白名单需手工加一行,否则会被归一到 Sol 而非用上新档。这是「宁可可用也不 400」的有意取舍,不是遗漏。

## 📚 5. 业界参考

- `tavily_search` "Kiro models GPT-5.6 Sol Terra Luna context window" → top1 `https://kiro.dev/docs/models`:GPT-5.6 Sol/Terra/Luna 三档,均 272K,US+EU 区域。
- `https://kiro.dev/changelog/models/gpt-5-6`:272K 全档,倍率 Sol 2.4x / Terra 1.2x / Luna 0.6x,us-east-1 + eu-central-1 cross-region inference。
- ⚠️ **文档与端点冲突,以端点为准**:实测 `rateMultiplier` = Sol 2.4 / Terra **1.0** / Luna **0.1**。官方另有一篇 "GPT‑5.6 update: lower credit multipliers for Terra and Luna" 说明其后降过价,故博客旧值已过时。这正是「文档不能替代实测」的现场样本。
- 参考项目 `jsjm1986-studio/src/anthropic/model_catalog.rs`:同类问题的成熟解法(单一 CATALOG SSOT + 精确别名反查 + 未知显式拒绝 + 非精确命中打 warn)。

## 🛠️ 6. 手术式修复

策略:在唯一收口点 `mapModelId` 把「乐观透传」改为「白名单 + 显式归一 + warn 可观测」;元数据侧按实测值对齐。

- `src/main/proxy/kiroApi.ts`:新增 `GPT_DEFAULT_TIER`(单常量切档)+ `GPT_CANONICAL_IDS`(白名单 Set);6 个 GPT 别名指向常量;删除乐观透传正则,改为白名单命中原样返回、其余归一并 warn。
- `src/main/proxy/tokenCounter.ts`:1M 档正则前置于 200K 通配;GPT-5 档前置于 gpt-4 老名分支。
- `src/main/proxy/proxyServer.ts`:静态清单补 GPT 三档 + Claude 5 系(带实测窗口/倍率);preset 别名窗口按归一后真实目标 272K 广告并注明 `→ GPT-5.6 Sol`;`modelFamily` 加 gpt-5 分支。
- `src/renderer/src/components/pages/DiagnosePage.tsx`:测活候选清单对齐实测。

**刻意未改**:`clientConfig.ts`(窗口取真实值,自动正确)、`index.ts:3743`(默认 model 有效)、`presetModels` 未删除(经归一后仍是可用别名,删除会破坏现有客户端配置)。

## ⚠️ 7. 影响面与回归风险

影响面:反代 OpenAI/Anthropic 两条入口的 model 解析(`translator.ts:421/924`)、`/v1/models` 广告、上下文窗口推断、UI 测活清单。

**行为变更(需知情)**:
- `gpt-4/4o/4-turbo/3.5-turbo` 由 Claude Sonnet 4.5(1.3x)改为 GPT-5.6 Sol(2.4x)。把这些别名当「便宜 Claude」用的配置会换成 OpenAI 模型且倍率近乎翻倍 —— 用户已知情决策。
- 裸名 `gpt-5.6`/`gpt-5` 维持 Sol(2.4x)不变。

回归测试:`test/main/proxy/modelMapping.test.ts` 由 6 → 21 例,含 3 个失败前置(白名单外归一 / 1M 档 / 272K 档)。全量 140 files / 1550 tests passed;typecheck 双端零错。

**消费锚点**:最终 sink = 上游 `runtime.{region}.kiro.dev` payload 的 `userInputMessage.modelId`。

**端到端验证(评审 A2 落实 · 已真跑)**:新增 `test/main/proxy/modelMapping.upstream.test.ts` ——
用**真实 `openaiToKiro` 转换链**产出 payload(不手搓),断言 `payload.conversationState.currentMessage
.userInputMessage.modelId` 后**把该 payload 真发上游**,覆盖「客户端 model 名 → translator →
mapModelId → payload → 上游 → 出流」整条链。默认 `describe.skipIf` 跳过(需 ksk + 网络 + 额度),
带 `KAM_E2E_KSK` 时才跑,故不影响 CI(无 env 时 6 skipped)。

2026-08-12 实跑结果(EU ksk + 7897 代理,6/6 通过 · 15.2s):

| 客户端传入 | payload.modelId 断言 | 上游 |
|---|---|---|
| `gpt-4o`(原始投诉样本) | `gpt-5.6-sol` | 200 出流 |
| `gpt-5.6`(裸名) | `gpt-5.6-sol` | 200 出流 |
| `gpt-5.7-sol`(未来名 · 修复前 400) | `gpt-5.6-sol` | 200 出流 |
| `gpt-5.6-terra`(对照) | `gpt-5.6-terra` **未被改成 Sol** | 200 出流 |
| `gpt-5.6-luna`(对照) | `gpt-5.6-luna` **未被改成 Sol** | 200 出流 |
| `claude-opus-5`(对照) | `claude-opus-5` 不受 GPT 归一影响 | 200 出流 |

⚠️ 仍未覆盖(诚实边界):① Anthropic 入口(`/v1/messages` → `claudeToKiro`)未单独跑,
但它与 OpenAI 入口共用同一个 `mapModelId`(`translator.ts:924` vs `:421`),映射行为同源;
② 未经完整反代 HTTP 入口(需造加密账号库),本测试从 translator 起算,不覆盖 HTTP 路由与鉴权层。

| 节点 | 生产者 | 消费者 |
|---|---|---|
| model 名归一 | `kiroApi.ts:mapModelId` | `translator.ts:421` / `:924` |
| 窗口元数据 | `tokenCounter.ts:getModelContextLength` + `setModelContextWindow`(动态优先) | 上下文裁剪 / `contextUsagePercentage` 反推 |
| 模型广告 | `proxyServer.ts:handleModels` | 客户端 `/v1/models` |


## 🧩 8. 边界加固

- 把「哪一档是 GPT 默认」从散落字面量收敛为单常量 `GPT_DEFAULT_TIER`,未来切档改一处即可(原先 6 处字面量,属 SSOT 缺失)。
- 白名单外 GPT 名归一时打 warn,把「静默换档」变可观测(对齐参考项目的 `tracing::warn!` 姿势)。

### 未知 canonical ID 降级契约(评审 A4)

**业务场景**:Kiro 未来真上新档(如 `gpt-5.7-sol`),或客户端配置里写了拼错/臆造的 GPT 名。
**缺失影响**:若不归一 → 用户吃 400 黑盒(修复前的实际状况,V1);若归一 → 用户拿到可用响应但档位与所请求不同。
**分类**(§0.17):**B 稳定性保护** —— 目标是「不让请求黑盒失败」,不是新业务能力。

**契约(本轮采用)**:未知 GPT 名 → 归一到 `GPT_DEFAULT_TIER` + `console.warn` 留痕。
**已知代价(诚实登记,不粉饰)**:这是**受控降级但用户不可见**——服务端 warn 只有运维看得到,
终端用户在响应里看不到"你实际用的是 Sol"。评审判定此点与「用户知道自己用哪档」的成功状态冲突,
判定成立,故已在 §1 把成功状态收窄为「归一在服务端留痕可追」,并登记债务如下。

**替代方案与未选原因**:显式拒绝未知名(参考项目 jsjm1986-studio 的做法)语义最干净,
但会让传裸名/老名的现有客户端(Claude Code 默认配置)直接失败 —— 用户 2026-08-12 决策优先可用性。
未来若要改为"回传实际用档",应在响应装配层把归一后 modelId 回填进响应 `model` 字段(见债务 D2)。

### 静态兜底清单的适用范围(评审 A5)

**分层澄清**:静态清单承载的是**模型固有元数据**(id / 窗口 / 倍率),**不是**「本账号本区域的可用性」。
两者是不同维度,原稿把一次实测的 17 项当成全局能力事实,是把租户可用性混进了固有元数据 —— 判定成立。

**实测依据**:同一把 ksk,直连 `ListAvailableModels` 只返 6 个(Claude 全系被过滤),走 7897 代理返 17 个;
不同订阅档/区域的可用子集也不同。

**失效行为(本轮已加固)**:静态清单**仅在 `dynamicModels.length === 0` 时生效**(`proxyServer.ts:2979`),
即真实拉取成功时永远以真实清单为准。拉取失败时:① 打 `proxyLogger.warn` 说明未按账号/区域校验可用性;
② 每条 description 加 `[未校验兜底清单]` 前缀,让用户在客户端模型列表里直接看见这是兜底数据。
**取舍**:宁可多列(用户可换号/查网络)也不给空列表(客户端直接不可用)。

**新鲜度依据**:倍率/窗口来自 2026-08-12 端点实测。⚠️ 倍率是**易变字段**(官方已降过一次价:
博客写 Terra 1.2x/Luna 0.6x,实测已是 1.0x/0.1x),硬编码值必然再次陈旧 → 见债务 D3。

### 债务登记(本轮未做,明确不宣称闭环)

- **D1 · 模型目录缺 SSOT**(评审判定 ARCHITECTURE_DEFECT):模型事实仍散落 4 处(`MODEL_ID_MAP` /
  `tokenCounter` 兜底表 / `proxyServer` 静态清单 / `DiagnosePage` 测活清单),本轮只做数据对齐,
  未建单一真源。参考项目 `model_catalog.rs` 的 `static CATALOG` 是可借鉴范式。**下次改模型相关代码时必然再次漂移。**
- **D2 · 归一结果对用户不可见** → ✅(2026-08-12 已解决 · commit 25c6938):用户看到日志显示
  `gpt-5.6` 后明确要求做掉。新增 `modelLogLabel.ts:resolveLoggedModel`,在 `this.events.onResponse`
  包装层与 `recordRequest` 两个收口点把客户端原始名解析为实际档;UI 显示实际档 + `← 原始名` 附注。
  仍未做:单次响应体的 `model` 字段仍回传客户端原始名(改它要动响应装配契约,且部分客户端会校验
  请求/响应 model 一致性,有兼容风险)——日志侧已可见,故降级为低优先。
- **D3 · 倍率硬编码会陈旧**:静态清单里的 rateMultiplier 是快照。应考虑只在动态拉取失败时展示"倍率未知"而非旧值。

## Update Log

- 2026-08-12:首次落地。实测拿到 17 模型清单 + 6 名受控对照;修 5 个文件;测试 6 → 21 例;全量 1550 绿 + typecheck 零错。倍率以端点实测值覆盖官方博客旧值。commit=ed4202c
- 2026-08-12:异构工件评审(`spec-cross-review` 模板 F · codex/gpt-5.6-sol · NEEDS_CHANGES p0=2 p1=3 ·
  `validation.ok=true` 5 锚点全 CHECKED 无幻觉)后修订。采纳全部 5 条:
  - **A2(P0,真实缺口)**:原先只验了归一「目标」(直发上游),未验归一「路径」。新增
    `test/main/proxy/modelMapping.upstream.test.ts` 走真实 `openaiToKiro` 链再发上游,**已真跑 6/6 通过**,
    含 terra/luna 不被误归一的对照。属 E-052「单测绿≠真接线」同形,评审判断正确。
  - **A5(P1,我引入的新风险)**:把一次账号/区域实测的 17 项写成全局静态兜底,与本 RCA 自己记录的
    「直连仅 6 个」自相矛盾。已加 warn + `[未校验兜底清单]` description 前缀 + 适用范围说明(`proxyServer.ts`)。
  - **A1/A3/A4(文档层)**:补原失败样本前后对照表 + 四类输入契约分层;把「同根因次生偏离」拆成
    V1-V7 并列变体链(原判断有误:窗口/广告/分组/测活并非透传正则的后果,共同上位原因是缺 SSOT);
    补未知名降级契约的场景/分类/代价。
  - 登记 D1(缺 SSOT · 架构债)/ D2(用户不可见)/ D3(倍率会陈旧),不宣称已闭环。
  - 未采纳:无。评审 5 条全部成立。
  - 注:本轮全量测试有 15 例失败,全部在 `test/main/server/adminKeyStore.test.ts` —— 该文件对应
    他人正在飞的 `adminKeyStore.ts` 重写(678 增/469 删),与本交付零引用(已 grep 核实),非本轮引入。

- 2026-08-12:用户看到日志「模型」列显示 `gpt-5.6`(Kiro 上不存在的 id),要求显示实际档 →
  **D2 债兑现** · commit 25c6938。新增 `src/main/proxy/modelLogLabel.ts`(`resolveLoggedModel`):
  由 `mapModelId` 派生实际档,不复制映射规则;只在归一真的改了名字时才带 `requestedModel`,
  大小写差异不算改变(避免噪音);空 model 保持 `unknown` 且不编造归一结果。
  **接线选两个收口点而非逐改 20 个调用点**:构造时包装 `this.events.onResponse`(一处覆盖
  chat/responses/messages 三条入口的全部成功与失败分支)+ `recordRequest`(UI 日志数据源)。
  这样未来新增入口自动获得该能力,规避 E-060 改 A 漏传播。契约逐层传播已改完:
  `RequestLog` · `ProxyServerEvents.onResponse` · preload 内外两层 + `.d.ts` ·
  renderer `RecentLogEntry` + 事件落库 · `ProxyLogsDialog` `LogEntry` + 渲染;
  webPanel 已核实不渲染请求日志。UI:显示实际档,归一过的以 `← 原始名` 附注 + tooltip 两行。
  验证:`modelLogLabel.test.ts` 8 例(纯函数)+ `modelLogWiring.test.ts` 4 例(**直接打生产
  通道验真接线**,防 E-052「造好了没接」);全量**连续两次** 151 files 全绿;typecheck 双端零错。
  注:期间全量曾出现 1-2 个 failed 文件抖动,定位为他人在飞的 `adminKeyStore.test.ts`
  (涉临时目录/权限,时序敏感);连续两次复跑均 0 failed,且该文件与本交付零引用。
