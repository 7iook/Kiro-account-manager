# 候选宿主评估:9router (Node) vs Kiro-Go-main (Go)

> 侦察报告 · 只读 · 2026-08-10 · 目标:为服务端部署选宿主
> 所有结论都带 `file:line` 锚点。未能证实的项一律显式写「未找到」,不猜。

## 0. 一句话结论

**Kiro-Go-main 是唯一可信的宿主候选;9router 不是宿主,是「取经对象」。**

两者根本不同物种:Kiro-Go 是 Kiro 专精代理(账号池 / 失败分类 / 限流忍耐 / 配额都是一等公民),
9router 是 200+ provider 的通用网关,Kiro 只是 `open-sse/executors/kiro.js` 一个执行器。
把 Kiro 专有的挂起门闸塞进 9router,要改的是全 provider 共用的失败回退主循环 —— 爆炸半径覆盖 200 个 provider。

采用 Kiro-Go 的代价是**语言全损**:Go,我们的 TypeScript 逻辑是重写而非搬迁。

## 1. 项目画像

### 1.1 Kiro-Go-main (`F:\Kiro-Go-main\Kiro-Go-main`)

| 项 | 事实 |
|---|---|
| 是什么 | Go 单体 Kiro 代理 + 原生 web 管理台,上游 `github.com/Quorinex/Kiro-Go` |
| 版本 / 活跃度 | `version.json` v1.1.2;**无 `.git`**(GitHub zip 解包,不是克隆 → 无法看提交历史/做 git 考古) |
| 最近活动痕迹 | `logs/kirogo_20260720_051317.log` —— 2026-07-20 有真实运行日志 |
| 1176 MB 的真相 | **不是垃圾堆**。体积来自 `md/临时json账号.7z` + `md/测试json功能号` + `logs/` + 已编译 `kiro-go.exe`。真实源码只有 `main.go` + `auth/ config/ pool/ proxy/ logger/ web/` 七处,`proxy/` 约 60 个 .go(其中 ~40 个 `_test.go`) |
| 服务端原生度 | **强**。`Dockerfile` 多架构交叉编译 `CGO_ENABLED=0` → alpine 静态单二进制;`docker-compose.yml`;`start.sh`/`start.ps1` |
| 测试密度 | 高且针对性极强:`account_retry_budget_test.go` / `ratelimit_endurance_test.go` / `stream_continuation_e2e_test.go` / `translator_truncate_test.go` / `no_response_test.go` / `context_window_test.go` / `kiro_ratelimit_test.go` |

**代码气质**:注释带真实事故取证数据,不是模板注释。`ratelimit_endurance.go:12-20`:
「922 次 429 分布在 120 个不同分钟,峰值单分钟 43 次,连续 429 中位数 ~388s 最长 ~26 分钟,
上游 474/474 次都不发 Retry-After」。这是从生产日志统计出来的。同类的还有
`account_failover.go:70-78`(402 漏分类导致「单分钟 20 次自旋」)、`stream_watchdog.go:16-19`
(`bytesRead=0, eventsParsed=0` + ~3m57s 静默)。这是同一批人在真实多账号池上被打过的痕迹。

### 1.2 9router (`F:\9router`)

| 项 | 事实 |
|---|---|
| 是什么 | `9router-app` v0.5.40 —— Next.js 16 dashboard + Express 5 代理,**通用多 provider 网关** |
| 规模 | 真实源码 824 文件 / 4.6 MB(`src` + `open-sse` + `cli`),618 MB 是 `node_modules` + `.next` |
| 最近提交 | `79918c7` 2026-07-20 `# v0.5.40`(有 `.git`,可考古) |
| Provider 覆盖 | `open-sse/providers/registry/` **200+** registry 文件;`open-sse/executors/` ~30 执行器,Kiro 只是 `executors/kiro.js` 一个 |
| 能力广度 | 远超代理:chat / embeddings / TTS / STT / 图像生成 / 视频 / web search,各自独立 provider 目录 |
| 服务端原生度 | **强**。`Dockerfile`(node:22-alpine 多阶段,`PORT=20128`)+ `docker-compose.yml` + `captain-definition`(CapRover schemaVersion 2)+ `start.sh` |
| 存储 | SQLite,三适配器 `betterSqliteAdapter` / `nodeSqliteAdapter` / `bunSqliteAdapter`,`sql.js` 兜底(package.json `comment_better_sqlite3` 明说为了无构建工具的机器) |
| 认证 | **最成熟的一环**:`bcryptjs` + `jose`(JWT)+ OIDC 登录(`src/app/api/auth/oidc/{start,callback,test}/route.js`)+ 密码重置 |

**决策卡引用的先例已核实为真**:`open-sse/config/runtimeConfig.js:53`
`STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000)` —— 6 分钟默认、可环境变量覆盖,
`:56` 首 token 200s、`:59` 连接 60s。常量分离说法也成立(`open-sse/config/` 下 15 个纯常量文件)。
`utils/streamHandler.js:93` 注释明确「Stall detection lives in pipeWithDisconnect (tied to upstream byte
activity)」,`:178`「Stall watchdog tracks raw upstream byte activity, not transform output」—— 看**上游原始字节**
而非 transform 输出,这个区分是对的,值得抄。

## 2. 能力对照表

图例:✅ 有且成熟 · ⚠️ 部分/形态不同 · ❌ 未找到

| 能力 | Kiro-Go-main | 9router |
|---|---|---|
| **多账号池 + 权重轮换** | ✅ `pool/account.go:44-64` `Reload()` 权重展开(weight≥2 → 重复 N 条目);`GetNext` / `GetNextExcluding` / `GetNextForModel` | ⚠️ 有 cooldown 过滤 `services/accountFallback.js:166 filterAvailableAccounts`,但**未找到权重选择**;账号存 SQLite `provider_nodes`(`src/lib/localDb.js:9 getProviderNodes`) |
| **请求挂起(无可用账号时冻结而非失败)** | ✅ **这是它的旗舰特性**。`proxy/ratelimit_endurance.go` 整个文件专为此写;判定入口 `ratelimit_endurance.go:100 decideRateLimitEndurance`,调用点 `proxy/kiro.go:569-581`。预算 6 分钟(`:69 rateLimitEnduranceBudget = 6 * time.Minute`),单次睡眠上限 20s(`:74`),基数 1s(`:78`),**full jitter**(`:130-146`,注释明确解释为何不用「窗口+小抖动」:共享凭据下窄抖动会重新同步成惊群) | ❌ **没有挂起**。`accountFallback.js` 是「打 cooldown → 换下一个账号」,`checkFallbackError` 返回 `{shouldFallback, cooldownMs}`;全池不可用时未找到等待路径,只有 backoff 指数退避 cooldown 时长(`:9 getQuotaCooldown`,base 2s → max 5min,maxLevel 15) |
| ↳ 挂起的三个安全前提 | ✅ `ratelimit_endurance.go:33-42` 显式论证:① 429 构造性瞬时 ② 尚未向客户端发任何字节 ③ **两个流式 handler 都在调 CallKiroAPI 之前就启动了 SSE 心跳**,所以等待期间客户端不会超时 | — |
| ↳ 有兄弟账号可用时优先轮换 | ✅ `ratelimit_endurance.go:103-106`:`siblingReady` 为真直接返回不等待(「rotating serves the user now AND takes load off the throttled bucket」),实参 `kiro.go:575 hasReadySiblingAccount` | — |
| ↳ 可关闭 | ✅ `ratelimit_endurance.go:170 rateLimitEnduranceEnabled()` → `config.GetRateLimitEnduranceEnabled()`,运维可选回退到 fail-fast | — |
| **429 vs 402 区分** | ✅ **明确分离,且是被事故驱动的**。`account_failover.go:48-58 isRateLimitErrorMessage`(429/too many requests → 短冷却快轮换,注释:「never the hour-long quota bench that a genuine quota-exhaustion warrants」);`:60 isOverageErrorMessage`(402+overage);`:80-89 isLimitReachedErrorMessage`(402 + MONTHLY_REQUEST_COUNT / free_trial / reached the limit)。冷却时长分层:429 → 15s(`pool/account.go:315-323 RecordRateLimit`,且**不计入 3 击退场计数**),配额 → 1 小时(`:301`),超额 → 1 小时(`:408 MarkOverLimit`),禁用 → 24 小时(`:399`) | ⚠️ **有 402 独立规则但被文本规则抢先**。`config/errorConfig.js:73` `{status: 402, cooldownMs: COOLDOWN.long}` = 2 分钟;但 `:67` 的文本规则 `{text: "quota exceeded", backoff: true}` 在状态规则**之前**求值(`:52` 注释「text rules first (by order), then status rules」)。一个「402 quota exceeded」会命中 backoff 指数退避分支,而非 402 的固定冷却 —— **这就是把配额耗尽当节流处理**。且 402 冷却只有 2 分钟,配额是按月重置的 |
| **真实配额追踪 + 喂给选路** | ✅ 双向。拉取:`kiro_overage.go` `FetchOverageStatus`;池侧判据 `pool/account.go:557 isOverUsageLimit` / `:564 isQuotaBlocked(acc, allowOverUsage)`,在 `GetNext` 的候选过滤里就用上了(`:106`/`:228` 同时看 cooldown 和 quota),即**请求失败之前**就排除 | ⚠️ 拉得到但**未证实喂给选路**。`services/usage/kiro.js:12 parseKiroQuotaData` 解析 `usageBreakdownList` → `{used,total,remaining}` 含 `freeTrialInfo`;但 `filterAvailableAccounts` 只过滤 `rateLimitedUntil`,未见配额参与选择 |
| **会话粘性(每会话固定账号)** | ⚠️ 形态不同:粘的是**上游 conversationId**,不是账号。`translator.go:1893 buildConversationIDWithSession(modelID, systemPrompt, anchor, sessionID)`,客户端 session 优先(`:337` 取 `extractClaudeSessionID(req.Metadata)`)。含一条安全修复:`:1863-1879` conversationId 曾是纯内容 hash,导致跨用户碰撞共享上下文,现加 `conversationIDSalt` 实例盐。失效规则:流在出字节前被切 → `:770 rotateConversationIDForRetry` 换新 id 重试(`:671` 注释:同 id 重连=让上游重放同一个卡死会话) | ❌ 未找到账号级粘性;有 `utils/sessionManager.js` 和 `utils/kiroSessionReplay.js`,未深读 |
| **Anthropic + OpenAI 双端点** | ✅ `proxy/handler.go:396-432`:`/v1/messages`、`/v1/messages/count_tokens`、`/v1/chat/completions`、`/v1/responses`、`/v1/images/{generations,edits}`、`/v1/models`。另有 `/api/event_logging/batch`(:434,吞 Kiro 客户端遥测)和 `/v1/stats`(:452) | ✅ 更全:`src/app/api/v1/**` + `src/app/api/v1beta/**`(Gemini 原生),translator 覆盖 claude/openai/gemini/responses 互转(`open-sse/translator/request/`、`response/` 各 10+ 文件) |
| **Prompt cache 处理** | ✅ `proxy/cache_tracker.go`:`defaultPromptCacheTTL = 5min`(:14),`defaultMinCacheableTokens = 1024`(:19,注释解释为何要排除小断点:否则短请求会报出不真实的 100% 命中率),断点 sha256 匹配 | ⚠️ 有 `utils/claudeHeaderCache.js` / `claudeSignature.js`,但**未证实**是 prompt cache 断点追踪 |
| **SSE 流 + 停顿检测** | ✅ 两段式,分工清楚。① **首字节门** `stream_watchdog.go:34 firstByteTimeout = 90s`,`guardFirstByte` 包 body,超时靠 `rc.Close()` 唤醒阻塞的 Read(:64-67 注释:没别的办法打断 blocked read),报 `errNoFirstByte` 且消息含 "timeout" 以便复用既有瞬时切流重试路径;**见到第一个字节即自我解除**(`:71-73 disarm.Once`),故合法的中途长思考完全不受干扰。② 中途仅告警不杀:`kiro.go:942 streamGapWarnThreshold = 15s`。③ 断流续传 `stream_continuation.go` + 三个 e2e 测试 | ✅ 三段阈值且**全可环境变量覆盖**:`runtimeConfig.js:53` 停顿 360s / `:56` 首 token 200s / `:59` 连接 60s。看**上游原始字节**而非 transform 输出(`streamHandler.js:178`)。网络重置/socket hang up 视作优雅关闭(`:139-157`) |
| **模型能力路由** | ✅ 按账号可用模型选账号:`pool/account.go:153 SetModelList`(来自 `ListAvailableModels`)/ `:181 accountHasModel` / `:192 GetNextForModel`;Codex 账号存在才广告 Codex 模型(`handler.go:520`、`codex_handler.go:32`) | ✅ 最强项:`providers/capabilities.js` + `providers/models/namePatterns.js` + `thinkingLevels.js` + `pricing.js`,200+ provider 的能力矩阵 |
| **Web 管理台 + 认证模型** | ⚠️ 有台,认证弱。`web/` 原生 JS(`app.js` + `index.html` + locales),API `/api-keys` CRUD + `/reset-usage`(`handler.go:2678-2690`)。认证是 **API key 单层**(`proxy/auth.go:28 extractProvidedKey` / `:55 authenticate`),**未找到用户名密码/会话/OIDC**;`:42` 注释显示无 key 配置时放行 | ✅ **显著更强**。Next.js dashboard,bcrypt 密码 + jose JWT + OIDC(`src/app/api/auth/oidc/*`)+ 密码重置 + `/api/auth/status` |
| **上下文溢出处理** | ✅ `translator.go:1666 truncatePayloadToLimit(payload, hasPriming)`,从最旧回合开始丢,插入单条占位符 `:61 truncationPlaceholder`;保底保留系统 priming + 活跃工具回合(`:64`);孤儿 tool_result 展平(`:291`)。测试 `translator_truncate_test.go` / `translator_compaction_test.go` / `context_window_test.go`;`token_estimator.go` 提供估算 | ⚠️ 有 `services/compact.js` 和整套 **RTK**(`open-sse/rtk/`,12 文件 + 12 个 filter:`smartTruncate` / `gitDiff` / `grep` / `readNumbered` / `headroom`)—— 这是**工具输出压缩**,和历史截断是不同层的事,形态比 Kiro-Go 更精巧(按工具类型定制压缩) |
| **每 API key 配额 / 账号绑定** | ⚠️ 有配额,**未找到绑定**。`config/apikeys.go:107-108` `TokenLimit` / `CreditLimit`,`:224 ApiKeyOverLimit` 返回 `(overToken, overCredit)`,认证时即拦(`proxy/auth.go:73-75`,超限返回 429 `token limit exceeded`)。但**未找到 API key → 账号白名单绑定** | ❌ 有 `/api/keys` CRUD,但**未找到**每 key 配额或账号绑定 |

## 3. 架构接缝

### 3.1 Kiro-Go-main:接缝干净,能力已在位

- **账号池**:`pool.AccountPool` 单例(`pool/account.go:32 GetPool`),内部 `accounts []config.Account` + `cooldowns map[string]time.Time` + `modelLists`。
  选择、冷却、配额判据全在这一个类型上,**没有第二个 SSOT**。
- **配置**:`config/config.go` + `data/config.json`;账号、API key、开关(含 `GetRateLimitEnduranceEnabled`)统一走 config 包。
- **挂起门闸的接缝**:`decideRateLimitEndurance` 是**纯函数**(入参:retryAfter / haveRetryAfter / attempt / elapsed / siblingReady,出参:Wait / Delay / Reason)。
  预算变量刻意做成 `var` 而非 `const`(`:67` 注释:否则测试要真等几分钟,那测试就等于不存在了)。
  **这是我们能直接对接的接缝** —— 我们自己的门闸策略如果更聪明,是替换这一个函数体,不是动主循环。
- **真正的 blocker**:**语言**。以及 **web 管理台认证只有 API key 单层**,要上公网必须先补一层(见 §4)。

### 3.2 9router:接缝不匹配,改造是侵入式手术

- **账号池**:概念上叫 `provider_nodes`,存 SQLite(`src/lib/localDb.js`),运行期状态是行上的
  `rateLimitedUntil` + `backoffLevel`(`accountFallback.js:206-210 buildFallbackUpdate`)。
- **失败回退是全 provider 共用的**:`accountFallback.js` 被 `open-sse/index.js:42` 导入,
  规则集中在 `config/errorConfig.js` 的 `ERROR_RULES` 数组 —— **200+ provider 共享同一张表**。
- **具体 blocker**:把「无可用账号时挂起」加进去,要改的是这张共享表和它的调用点。
  Kiro 的 429 该等 6 分钟,但同一条代码路径上 OpenAI、Gemini、Cursor 的 429 语义完全不同(有的是硬墙)。
  要么给 Kiro 开特例分支(破坏 200 provider 一致性的抽象),要么把等待策略做成 per-provider 可配置(等于重设计失败回退层)。
  两条都不是「附加」,是改地基。
- 而 9router 的 Kiro 执行器本身很薄:`executors/kiro.js` 一个文件,配额在 `services/usage/kiro.js`,
  常量在 `config/kiroConstants.js`。**Kiro 在这个项目里是公民之一,不是主角** —— 这决定了它当不了 Kiro 专用宿主。

## 4. 多租户 / Key 管理

| | Kiro-Go-main | 9router |
|---|---|---|
| 每 key 配额 | ✅ Token + Credit 双限,认证层即拦 | ❌ 未找到 |
| key → 账号绑定白名单 | ❌ 未找到 | ❌ 未找到 |
| 用量归属 | ✅ `apiKeyIDFromContext`(`auth.go:105`)贯穿请求,`/reset-usage` 可重置 | ⚠️ 有 `usageDb.js` / `requestDetailsDb.js`,归属维度未证实 |
| 管理台认证 | ⚠️ 仅 API key | ✅ bcrypt + JWT + OIDC |

**两个项目都没有我们的「API key → 账号白名单绑定」。这是我们独有的能力,任选哪个宿主都得自己实现。**

## 5. 判决

### 5.1 Kiro-Go-main:**可信宿主,但要付语言税**

它不是「勉强能改成」我们要的东西 —— 它**已经是**。用户最看重的挂起门闸,在这里不是能否加的问题,
而是它已经有一份被 922 次真实 429 打磨出来的实现,还带 full jitter 惊群防护、兄弟账号优先、
预算封顶、可开关、有测试。402/429 分离同样已经做到位,且分层冷却(15s / 1h / 24h)比单一 cooldown 精细。

**采用它会失去什么**:
1. **全部 TypeScript 代码**。这是重写不是搬迁 —— Electron 那套账号管理、我们的门闸策略、UI 全部无法复用。
2. **Web 管理台认证**。它只有 API key 单层,`auth.go:42` 显示无 key 时放行。**上公网前必须补密码/会话层**,
   否则等于把账号池管理面板裸奔在互联网上。这是采用前必须闭合的安全缺口,不是可选优化。
3. **git 历史**。无 `.git`,考古只能靠代码注释(所幸注释质量异常高)。
4. **每 key 账号绑定**需自己补。

### 5.2 9router:**不是宿主,是取经对象**

它的服务端成熟度和认证体系确实比 Kiro-Go 强,provider 广度是碾压级的。但作为 **Kiro 专用**代理宿主,
它缺的恰好是用户最在意的那一项:**没有挂起,只有冷却+换号**;而且 402 会被 `quota exceeded` 文本规则
抢先路由到 backoff 分支 —— 正是用户担心的「把配额耗尽当节流」的活样本。

它值得抄的三样东西(建议无论选谁都抄):
1. **三段式可配阈值** `runtimeConfig.js:53/56/59` —— 停顿/首token/连接分离,全部 env 可覆盖。
2. **看上游原始字节而非 transform 输出** 判停顿(`streamHandler.js:178`)。
3. **RTK 工具输出压缩**(`open-sse/rtk/` + 12 个按工具类型定制的 filter)—— 比单纯截历史更聪明,
   我们的上下文溢出处理可以借这个思路。

### 5.3 跨两者:最大能力缺口

**相对成熟 Kiro 代理,两者共同缺的是「API key → 账号白名单绑定」的多租户隔离。**
Kiro-Go 有 per-key 配额但无绑定;9router 两者皆无。这是我们项目里已有、而候选都要重建的能力。

其次,**9router 缺挂起、Kiro-Go 缺管理台认证** —— 各自缺的正是对方的强项,但两者不能合并采用。

### 5.4 宿主推荐

**推荐 Kiro-Go-main,前提是接受 Go 重写并在上线前补齐管理台认证。**

理由锚在读过的代码上:宿主选择的实质是「哪些难做对的东西已经做对了」。
挂起门闸(`ratelimit_endurance.go` 全文)、402/429 分层(`account_failover.go:48-89`)、
配额前置过滤(`pool/account.go:557-570` 在 `GetNext` 候选过滤里)、首字节门自解除
(`stream_watchdog.go:71-73`)、conversationId 加盐防跨用户碰撞(`translator.go:1863-1879`)——
这五项都是「踩过才知道」的东西,重写一遍的代价远高于翻译一遍。9router 的强项(认证、provider 广度)
反而是标准化的、好补的。

**但这是一个需要用户裁决的取舍,不是我能替他决定的**:
- 选 Kiro-Go = 拿到成熟的 Kiro 专有能力,代价是 TypeScript 资产清零 + 补认证。
- 留在自己项目里加服务端部署 = 保住全部 TS 资产和已有的 key→账号绑定,代价是挂起/分层冷却/断流续传
  这些 Kiro-Go 已验证过的东西要自己继续磨(不过用户项目已有相当部分,见其决策卡)。

判据建议:**如果用户项目的门闸和 402/429 处理已经达到 `ratelimit_endurance.go` 这个成色,那就没有换宿主的理由**
—— 换来的只有部署便利,却付出语言重写。反之若这些还在磨,Kiro-Go 提供的是几个月的事故经验。

## 6. 侦察边界(未验证项,勿当结论)

- Kiro-Go 无 `.git`,**未做 git 考古**;所有「为何这样设计」的判断来自代码注释。
- 未读 `proxy/handler.go` 全文(3300+ 行),路由与 SSE 心跳启动顺序基于 `ratelimit_endurance.go:40-42` 的注释断言,**未亲自在 handler 里核实心跳确实先于 CallKiroAPI 启动**。这是挂起安全性的关键前提,采用前应亲验。
- 9router 的 `utils/sessionManager.js` / `kiroSessionReplay.js` / `claudeHeaderCache.js` 未深读,故会话粘性与 prompt cache 判「未找到」而非「无」。
- 两个项目都**未实际运行**,全部结论来自静态阅读。
