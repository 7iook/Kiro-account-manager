# 本项目反代独有能力盘点 · 迁移可移植性评估

> 侦察模式 R · 只读盘点 · 2026-08-10
> 目的：为「自建服务端部署」vs「以其他 Kiro-proxy 项目(Rust/Go/Node)为宿主移植本项目独有能力」的决策提供事实底座。
> 判据：**common** = 任何合格反代实现都会有（低移植价值）；**distinctive** = 针对 Kiro 上游特定行为的硬仗修复，背后有事故/RCA（高价值，重新发现要数周）。
> 分支状态：`feat/hold-gate-auto-release`（a61ef6b + 90ac4d8）**未并入 main**，且切自 3658b6e **之前**，故两条线互不相交；diffstat 里 rtk/streamWatchdog 的「删除」是缺少 3658b6e 造成的假象，不是移除。

## 1. 能力清单表（distinctive 优先）

### D1 · 挂起门闸 HoldGate + 自动定时放行 ★★★
- **做什么**：账号全挂（真额度耗尽/封禁）时**冻结**流式请求而不是返回失败；SSE ping 保活；有号可用/手动放行/超时/abort 四入口竞争同一 CAS 认领位；绝对 deadline 从 receivedAt 起算跨多次挂起不重置；超时三态收尾 `keep_blocking / error / graceful_stop`。**自动放行**周期到点**无条件**调 releaseAll（刻意不查池可用性）。
- **为什么**：客户端 idle watchdog 会掐断静默请求。实测（2026-08-06 探针，claude-cli/2.1.220）**掐断周期恒定 310s**，ping 心跳不算语义正文挡不住它；用户实测「账号仍受限时手动点一次放行 → 那 10min 计时被重置」，自动放行就是把这个手动动作自动化。默认 8min（客户端 `API_TIMEOUT_MS` 默认 600s，留 120s 余量）。
- **锚点**：`src/main/proxy/holdGate.ts`（main 230 行 / 分支 +141 行）、`holdConfig.ts:57`（clamp + 实测注释）、`proxyServer.ts` 错误汇合点接线、决策卡 `.archive/2026-07-28/hold-gate-blocking/`、`.archive/2026-08-09/hold-gate-auto-release/`
- **规模**：子系统。门闸本体 ~370 行 + 配置归一化 + 两端界面读数（IPC + HTTP 推送）+ 6 个测试文件
- **判定**：**distinctive**。两个不可自行推导的知识点：① 310s 恒定掐断周期是探针实测数字；② 「放行动作本身能重置客户端计时」是行为观测，不是设计推论。另有一条负面知识：自动放行**不能**加池可用性判断，否则在目标场景（池无号）下永不触发 = 功能等于没做。

### D2 · 429 vs 402 语义分离 + 成功清误标 + 状态码提取 SSOT ★★★
- **做什么**：`recordError` 的 `isQuotaError` **只认 402**（此前 402||429）；`recordSuccess` 清 `quotaExhaustedAt`（成功=上游放行该账号的最硬证据）但不动 `quotaUsed/quotaLimit/suspendedAt/quotaResetAt`；新增 `extractHttpStatusCode()` 只认 `API/Auth error NNN` / `status=NNN` / `statusCode: NNN` / `HTTP NNN` 且限 100-599。
- **为什么**：429 被当额度耗尽 → 锁号 1 小时 → `hasBlockedAccount` 恒真 → 此后任何 pre-body 错误（哪怕 400 malformed）都被挂起。**实证推翻了「撑过 10 次重试的 429 = 真配额问题」这个前一轮的立论**：proxy-logs UTC 10:30-11:07 单账号 471 请求 / 147 次 429（全部撑过重试），其中 **146 次（99.3%）在 60 秒内同一账号就有 200 成功**。同根因变体：4 处各自写 `match(/(\d{3})/)` 裸抓第一个三位数 → `kiro.dev:443` 抓成 443、`Payload size: 402913 bytes` 抓成 **402 → 直接误触发额度耗尽**。
- **锚点**：`accountPool.ts` recordError/recordSuccess/extractHttpStatusCode、RCA `.archive/2026-08-04/hold-gate-429-quota-false-positive/`、commit `cdf71f9`
- **规模**：三个函数 + 4 处调用点收口
- **判定**：**distinctive**，且**是本仓最便宜、最容易被别人做错的一条**。任何实现只要把 429 当额度信号就会重演；那 99.3% 的统计是花了一整天日志分析才拿到的。

### D3 · 三层出站上下文安全网 ★★★
- **做什么**：Layer A `trimHistoryByTokens`（无条件生效）按 **token** 而非字节裁历史，保护 system pair / toolUse-toolResult 成对 / 严格交替 / 起头必 user，裁剪留痕占位对 + 单次赋值原子写回，裁到下限仍超则**诚实上报 finalTokens > maxTokens**；Layer B `rtk/` tool_result 形态感知压缩（git-diff / grep / read-numbered / smart-truncate），跑在 token 裁剪**之前**；Layer C `streamWatchdog` 按**原始上游 chunk** 判静默（不看 SSE 输出，防误掐推理模型），仅在 read 在飞期间武装计时器。
- **为什么**：受控对照证实上游按**模型 context window**判限而非 payload 字节：`claude-opus-5` 1,792,972 B (ctx 1M) → **200**；`gpt-5.6-sol` 945,144 B (ctx 272K) → **400 CONTENT_LENGTH_EXCEEDS_THRESHOLD`。**900KB 字节阈值方向在本仓被证伪**（低于既有 5MB 硬顶，且破 prompt cache prefix 逐字节匹配 → credit 涨 5x，已否决）。SUB 返 1800 行 diff 类 tool_result 无形态感知裁剪 → 任务中途 400 常态。上游 SSE 静默观察到 **1h50m 死等**，匹配 Anthropic SDK #867。
- **锚点**：`kiroApi.ts:1474-1580`(A)、`src/main/proxy/rtk/*`(B, ~436 行)、`streamWatchdog.ts:322`(C)、决策卡 `.archive/2026-08-09/proxy-context-safety-net/`、commit `3658b6e`
- **规模**：子系统 ~1200 行 + 大量测试；B+C 由 `enableProxyContextSafetyNet` 总开关控（默认关），A 无条件
- **判定**：**distinctive**。「按 token 不按字节」+ 那两个对照数字 + 「字节阈值方向是错的」这三条都是实测结论，反向直觉（多数实现会去卡字节数）。

### D4 · EU / 跨区域端点 fallback 矩阵 ★★★
- **做什么**：EU 账号补 `q.eu-central-1`(AmazonQ-EU) 端点；`v1Endpoints` 按 region 取变体（US 显式排除 EU host，否则既有宽 filter 会把 EU host 吸进 US 链造成跨区 403）；`getSortedEndpoints` 加 `isApiKeyAuth`（ksk_ 账号的 amazonq-cli 偏好不再锁死单端点，该端点明确拒绝 API key 认证）；保留「EU 绝不 fallback 到任何 us host」并由测试硬断言。
- **为什么**：EU 账号原先只有单一端点，失败即无处可去，而当日 **KiroRuntime-EU 非 200 率 41%(n=29) vs US 1%(n=325)**。用三把真实 ksk 实测出的端点矩阵：`runtime.eu-central-1` 200 / `q.eu-central-1` 200（本轮登记）/ `codewhisperer.eu-central-1` ECONNRESET（确实停服）/ `q.us-east-1`+`cw.us-east-1` 403 bearer token invalid（跨区，六次复现）/ `SendMessageStreaming` 403 API key 不支持。另做 **24 region × 3 host DNS 枚举**（带通配对照）确认官方仅部署 us-east-1 / eu-central-1。**并且修正了上一轮 RCA 自己的过度概括**——「eu 侧 V1 已停服」只对 codewhisperer.eu 成立。
- **锚点**：`kiroApi.ts` getSortedEndpoints / v1Endpoints、commit `a67b295`、`18dcbda`、`26e84fd`、RCA 2026-08-03
- **规模**：端点表 + 一个排序函数的分支
- **判定**：**distinctive，且是纯嵌入式知识**——那张矩阵表换语言一个字都不用改，但没有真账号根本测不出来。

### D5 · CONTENT_FILTERED 零输出透明重试 ★★★
- **做什么**：上游返回 CONTENT_FILTERED 且 `outChars=0 / toolsDone=0 / semanticOutput=false` 时**原地透明重试**（400ms/1200ms，上界 2 次），收口在 `callKiroApiStream` 内部包装 `onComplete` → 流式/非流式 4 条协议路径全部受益。**吐过正文则绝不重试**。上游终止类失败（undici `UND_ERR_SOCKET` other side closed）改判 **502** 且**不给账号记错误计数**。
- **为什么**：14 个 5xx 的真实构成里 CONTENT_FILTERED 占 11 条，**16 次全部零输出**；UTC 19:13-19:17 四分钟爆发 16 次而同期 421 次 TOOL_USE 正常 → 形态是上游过滤器的**瞬时/概率性行为**，不是 prompt 内容违规。零输出使重试**完全安全**：客户端还没收到任何内容，且流式 `message_start` 是**惰性发送**（等首个语义正文，proxyServer ADR-0001 边界 1）。终止类不记账号错误的理由：换号一样被同一过滤器拦，记了只会让完全正常的号被打入退避冷却。
- **锚点**：`kiroApi.ts` onComplete 包装 + `isUpstreamTerminalFailure()`、`types.ts` terminal.emptyOutput、commit `9794e47`
- **规模**：一个包装函数 + 一个导出谓词
- **判定**：**distinctive**。「零输出 ⇒ 重试安全」这个安全边界依赖惰性 message_start 这个自家设计，移植时必须一起搬。

### D6 · Prompt cache 保真（移除自杀式 timestamp 注入）★★★
- **做什么**：删掉 3 处把 `[Context: Current time is <ISO>]` / `Current time: <ISO>` 拼在 system prompt 最前面的注入（`translator.ts` openaiToKiro + claudeToKiro，`kiroApi.ts` injectSystemPrompts）。
- **为什么**：Anthropic prompt caching 是 **prefix 逐字节匹配**——position N 差一个字节就让 N 之后所有 breakpoint 失效。每请求变化的时间戳 → **cache 100% miss**。预期：input 100K → 15K uncached + 85K cache_read，credits 2.5-3.0 → 0.5-0.7（90% 折扣），TTFB 5-8s → 2-3s。反代应作透明层，客户端自己会注入日期。
- **锚点**：`translator.ts`、`kiroApi.ts` injectSystemPrompts、commit `727be0b`
- **规模**：删三行（收益/代码量比全仓最高）
- **判定**：**distinctive 的「负向知识」**——它的价值在于**知道不要做什么**。任何新实现都很容易「贴心地」注入时间戳，然后 credit 涨 5 倍且永远查不出原因。D3 的 Layer A 也刻意只在超限时才动手，正是为了不破这个 prefix。

### D7 · 额度真实喂池 + 观测时钟（HLC）★★☆
- **做什么**：`feedQuotaToPool()` 单一写者（桌面单查/面板 HTTP/批量三条路径汇流），架构门禁断言生产调用方恰好一处；`updateQuota` 不再无条件覆写 `quotaResetAt`；新增 `replaceAll()` 让全量同步保留运行期状态（额度五项 + 封禁三项 + 派生 isAvailable + 熔断计数）；新增 `utils/observationClock.ts`，版本 = `max(now, last+1)`（HLC 本地事件规则），在请求**发出**点铸造而非落盘时取 `Date.now()`。
- **为什么**：`updateQuota` 自 v1.6.0 诞生起**从无生产调用方**（`git log --all -S` 取证，非曾有后删）→ 额度判据在生产中**永远为 false**，反代只能靠 402 得知账号用光，每次换号先赔一个失败请求，界面上的「余额阈值」对换号毫无作用。落盘时取时戳导致**慢响应用更大时戳覆盖快响应** → 可能把仍可用账号标成耗尽（触发整池挂起）。
- **锚点**：`accountService/persistCheckResult.ts:73`、`accountPool.ts:613/:633`、`utils/observationClock.ts`、`check.ts:191/:452`、commit `90ac4d8`（未并 main）
- **规模**：一个写者收口 + 53 行时钟 + replaceAll 合并逻辑
- **判定**：**distinctive**，但偏「自家架构债」而非上游知识。HLC 那段是通用算法（可查文献）；真正独有的是「按账号而非按批次铸造版本」这个判据（批次级会让相邻两轮同账号分数相等而退化回完成顺序）。

### D8 · 会话粘性 + 额度耗尽失效判据 ★★☆
- **做什么**：`sessionAffinity` Map（TTL 600s）+ `pickAccountWithAffinity` 校验 `isSuspended` / `isAvailable` / **`isQuotaExhausted`**（第三条是 90ac4d8 补的）。
- **为什么**：缺 `isQuotaExhausted` → 某号 402 后，带固定 session id 的客户端在粘性 TTL 内**每个请求仍先命中该死号**，发一次注定 402 的上游调用再走重试切号。修法是补齐单点判据，而非在三处换号点各插一次粘性失效。
- **锚点**：`proxyServer.ts:326/:1550/:4704/:4717/:4735`
- **判定**：粘性本身 **common**；「三条失效判据必须齐」**distinctive**（是踩出来的）。

### D9 · 429 快速重置（`rateLimitRetryStrategy`）★★☆
- **做什么**：默认 **8 次 · 400ms 起 · `fast` 策略（固定 baseMs + ±25% jitter）**，总耗时 ~4-6s；`Retry-After` header 优先（上限 15s）；另备 `linear` / `exponential`。每次重发都换全新 linked AbortController（上一个可能已被看门狗掐过，aborted 不可复位，复用会让新请求出生即死），旧的先 dispose 摘监听器避免按重试次数堆积。
- **为什么**：**Kiro 后端是概率式限流（窗口随机），快速密集重试比慢退避更能穿透**。原策略 3 次 · 2s→5s→10s(exponential) 对概率窗口过慢 → 大部分错过窗口 → 端点全打完 → 500。参考 `kirodotdev/Kiro#8998`（credits 充足也 429）。
- **锚点**：`src/main/proxy/kiroApi.ts:70-97`（配置 + setter clamp）、`kiroApi.ts:2245-2290`（重试循环）、`types.ts:663`
- **规模**：一个 while 循环 + 一个配置对象
- **判定**：**这就是用户说的「快速重置」**（已核实：仓内无 `fastReset*` 符号，`'fast'` 唯一命中就是这条）。重试本身 common；**「对概率式限流要密集短退避而非指数退避」这个方向判断是 distinctive**——它与所有教科书建议相反，且指数退避的实现看起来更「专业」。

### D10 · 上游异常终止不再伪装成 end_turn / 幻觉工具标记不提升为真实调用 ★★☆
- **锚点**：commit `1d74a05`、`e106792`（回滚已证伪的 GPT tool-leak 抑制 + 三端点全挂后退避重试）、`4d60c44`（断点形态取证埋点：分辨 GPT 中途硬断是「上游发完」还是「被掐断」）
- **判定**：**distinctive**。`e106792` 尤其值得注意——它是一条**被证伪后回滚**的记录，即「别去抑制 GPT tool-leak，那个方向是错的」，属于负向知识。

### 常见能力（common · 低移植价值）
| 能力 | 锚点 | 说明 |
|---|---|---|
| SWRR 加权轮询 | `src/main/utils/smoothWeightedRoundRobin.ts` | nginx 同款算法，公开可查 |
| 模型能力路由（三态状态机） | `358477c`、`accountPool.ts` | 思路通用；**但「哪个端点支持哪个模型」的表是 distinctive** |
| Token 刷新 / SSO OIDC | `kiroApi.ts` | 通用；**但 `KNOWN_SSO_OIDC_REGIONS`(21 region) vs `KNOWN_CW_DATA_REGIONS`(2) 的概念拆分是 distinctive**——混用会让 sso=us-east-2 账户永远刷不到 token |
| 协议翻译 Claude/OpenAI/Gemini ↔ Kiro | `translator.ts:1367` | 任何反代必做；工作量大但无隐藏知识 |
| tiktoken 计数 | `tokenCounter.ts:127` | 通用 |
| 自签证书 / 系统代理 / 限流 / 鉴权 | `selfSignedCert.ts`、`systemProxy.ts` | 通用 |
| Prompt cache 模拟器（cache_control 断点追踪 + usage 统计） | `promptCacheTracker.ts:346` | 中间态：模拟 Anthropic 语义是可查的，但**让 Claude Code 的 cache_control 字段产生实际 usage 效果**是本仓特有拼接 |
| 跨端写入仲裁（revision 乐观锁 + 三方合并） | `aa03a94`、`c15cbe4` | **与反代无关**，是桌面+面板双端共写账号文件的并发问题。若服务端只有一个写者则**整块不需要移植** |
| Payload 字节硬顶 4.5MB | `kiroApi.ts:100` | 实测 ~5MiB 硬限（参 kiro-rs），一个常量 |

## 2. Top 5 移植价值排序

| # | 能力 | 移植难度 | 性质 |
|---|---|---|---|
| 1 | **D2 429/402 语义分离** | **极低**（几十行） | 纯**嵌入式知识**。算法零难度，价值 100% 在「429 不是额度信号 + 99.3% 统计 + 别裸抓三位数」这三句话。换语言照抄即可 |
| 2 | **D4 EU/跨区端点矩阵** | **极低**（一张表） | 纯**嵌入式知识**。没有真账号 + 24×3 DNS 枚举根本测不出来，但拿到表后任何语言都是常量 |
| 3 | **D6 prompt cache 保真** | **零**（不要写那三行） | 纯**负向嵌入式知识**。最高 ROI，也最容易在新实现里重新踩 |
| 4 | **D1 挂起门闸 + 自动放行** | **中高**（370+ 行 + 并发语义） | **算法逻辑为主**：CAS 一次性认领、绝对 deadline 不重置、两个刻意不合并的 timer。Rust/Go 反而更好写（原生 select/channel）。**嵌入部分**只有三个数字：310s 掐断周期、8min 间隔、ping < 45s |
| 5 | **D3 三层安全网** | **高**（~1200 行） | **混合**。Layer A 的结构不变量（system pair 保护 / toolUse-toolResult 成对 / 严格交替）是可移植算法但要小心；Layer B 形态感知过滤器需按语言重写正则；Layer C 是标准看门狗。**嵌入部分**是「按 token 不按字节」+ 两个对照数字 + 「900KB 字节阈值是错的」 |

**次优先**：D9（一个 while 循环，但那句「概率式限流要密集短退避」必须随行）、D5（一个包装函数 + 惰性 message_start 边界要一起搬）、D8（补一个判据）。

**结论倾向**：Top 3 全是**纯知识、零代码难度**——这意味着「以别的项目为宿主」在这三项上几乎无成本。真正的移植工作量集中在 D1/D3 两个子系统，以及 `translator.ts`(1367 行) 这类 common 但体量大的部分。若宿主项目已有成熟 translator，移植路线的性价比明显高于自建服务端。

## 3. Electron 纠缠度

- **`src/main/proxy/` 几乎已可移植**：全目录仅 `logger.ts:4` 一处 `import { app } from 'electron'`（取用户数据目录）。替换成配置注入即可，其余 21 个文件零 electron 依赖。
- **`src/main/accountService/` 与 `src/main/webPanel/`**：`git grep "from 'electron'"` 在这两个目录**零命中**，已刻意 electron-free。
- **HoldGate 依赖全注入**（clock / timer / ping 回调 / 池可用性查询），不耦合 http 与真实定时器 → 换宿主几乎零改动。
- **纠缠重的是 `src/main/index.ts`(7149 行)**：装配、IPC、SSO 登录流、窗口管理混在一起；三处 full resync 调用点（`:2902/:3546/:6200`）也在这里。移植时这一层需要重写而非搬运。
- **不需要移植**：跨端写入仲裁（D9 表内）——服务端单写者场景下该问题不存在。

## 4. 证据锚点与检索留痕
- `git log --oneline -60`（main）、`git log --oneline feat/hold-gate-auto-release -8`、`git diff --stat main..feat/hold-gate-auto-release`
- `git log -1 --format=%B` on `a61ef6b` `90ac4d8` `cdf71f9` `3658b6e` `a67b295` `9794e47` `727be0b` `358477c`
- `git show feat/hold-gate-auto-release:.../holdGate.ts`（头 130 行）、`.../holdConfig.ts`（Select-String 上下文）
- `git grep -n "rateLimitRetryStrategy|'fast'"` → 确认「快速重置」= `kiroApi.ts:73` 策略枚举，仓内无 `fastReset*` 符号
- `git grep -n "from 'electron'" -- src/main/proxy src/main/accountService src/main/webPanel` → 唯一命中 `logger.ts:4`
- `git grep -n "pickAccountWithAffinity|sessionAffinity"` → `proxyServer.ts` 5 处
- LOC 统计：`Get-Content | Measure-Object -Line` on proxy/*.ts + rtk/*.ts

**未核项（诚实标注）**：
- 未逐行读 `proxyServer.ts`(4970) 与 `index.ts`(7149)，按约束只做 grep + 切片；两文件内可能仍有未盘点的 Kiro 特异处理。
- 其他五个 Kiro-proxy 项目的现有能力**未考察**（本次范围只是「我们有什么」），故「宿主已有 translator」只是假设而非结论。
- `promptCacheTracker.ts` 只读了注释与结构，未验证其 usage 统计与上游真实计费的一致性。
