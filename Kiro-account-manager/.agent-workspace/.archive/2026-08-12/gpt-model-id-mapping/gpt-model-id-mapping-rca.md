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
  **Evidence**: verify=`npx vitest run` 140 files / 1550 tests passed;`npm run typecheck` 双端零错 · commit=pending

## 🔴 1. 现象与上下文

用户报:所有 GPT 系列模型被统一映射为 GPT-5.6。

**成功状态**(用户视角):**不是**「映射表里每个 GPT 名都有一行」,**而是**「客户端传任何 GPT 系模型名,请求都能真正到达 Kiro 并返回内容,且用户知道自己实际用的是哪一档、按什么倍率计费」。
负条件:不得出现「客户端传了一个看起来合法的 GPT 名 → 上游 400 INVALID_MODEL_ID → 用户看到黑盒失败」。
来源:用户原话 + 下游消费点前置条件(`translator.ts:421/924` 把 `mapModelId` 结果直接注入 payload `modelId`,上游据此做白名单校验)。

**现象锁定**(单一可证伪命题):`mapModelId` 对 GPT 系输入产出的 modelId,存在「上游不接受」与「档位/计费语义错位」两类偏差 —— 具体哪些名、偏成什么,由实测确定而非推断。

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

次生偏离(同根因,元数据侧未跟上上游):
- `tokenCounter.ts` 兜底表:`gpt-5.6-*` 落函数末尾 200000(真实 272000);`claude-opus-5`/`sonnet-5`/`opus-4.8/4.7/4.6`/`sonnet-4.6` 被 `claude-opus-4`/`claude-sonnet-4` 通配吃掉落 200000(真实 1M,低估 5 倍)→ 长上下文被提前误判超限。
- `proxyServer.ts` `/v1/models` 静态兜底清单:完全缺 GPT-5.6 三档与 Claude 5 系,广告的仍是上游已拒的 gpt-4o/gpt-4-turbo。
- `modelFamily`:无 gpt-5 分支,`gpt-5.6-sol` 落字符串切割兜底。
- `DiagnosePage` 测活候选清单:停留在旧 Claude 模型。

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

**消费锚点**:最终 sink = 上游 `runtime.{region}.kiro.dev` payload 的 `userInputMessage.modelId`。本轮已对该 sink 真跑受控对照(非仅单测):`gpt-5.6-sol` 与 `claude-opus-5` 200 出流,证明归一目标真实可用。

| 节点 | 生产者 | 消费者 |
|---|---|---|
| model 名归一 | `kiroApi.ts:mapModelId` | `translator.ts:421` / `:924` |
| 窗口元数据 | `tokenCounter.ts:getModelContextLength` + `setModelContextWindow`(动态优先) | 上下文裁剪 / `contextUsagePercentage` 反推 |
| 模型广告 | `proxyServer.ts:handleModels` | 客户端 `/v1/models` |

## 🧩 8. 边界加固

- 把「哪一档是 GPT 默认」从散落字面量收敛为单常量 `GPT_DEFAULT_TIER`,未来切档改一处即可(原先 6 处字面量,属 SSOT 缺失)。
- 白名单外 GPT 名归一时打 warn,把「静默换档」变可观测(对齐参考项目的 `tracing::warn!` 姿势)。

## Update Log

- 2026-08-12:首次落地。实测拿到 17 模型清单 + 6 名受控对照;修 5 个文件;测试 6 → 21 例;全量 1550 绿 + typecheck 零错。倍率以端点实测值覆盖官方博客旧值。commit=pending
