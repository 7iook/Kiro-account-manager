# RCA · EU 账号只有单一端点导致断流无退路(补 q.eu-central-1 fallback)

- 日期:2026-08-05
- 类型:🐛 Bug flow(错误认知落成实现)
- 触发:用户报「今天大量 500/502,前几天没这么严重,AI SUB 频繁中断」

## 🔴 1. 现象与上下文

当日请求日志与详细日志实测(窗口 10:14–11:08 UTC,n=362 Perf 行):

| 端点 | 请求数 | 非 200 | 非 200 率 |
|---|---|---|---|
| KiroRuntime-US | 325 | 2 | **1%** |
| **KiroRuntime-EU** | 29 | 12 | **41%** |
| CodeWhisperer | 8 | 0 | 0% |

而端点链实测不对称:

```
us-east-1     => KiroRuntime-US > CodeWhisperer > AmazonQ   (3 个,有退路)
eu-central-1  => KiroRuntime-EU                             (1 个,无退路)
```

EU 账号打唯一端点,该端点当日 41% 失败,失败后直接抛给客户端 → Claude Code 收到
`API Error: 500 terminated` → AI SUB agent 崩掉。

**成功态(用户视角)**:
> NOT「端点链里多了一个 URL」,BUT「EU 账号在 runtime.eu-central-1 抽风时,请求能自动
> 走第二个端点完成,用户不再看到 SUB agent 莫名中断」。
> 负条件:绝不能把 EU token 发到任何 us host(那是必 403,会白耗时间并污染错误计数)。

来源:用户原话(「总是遇到中断,这个确实需要解决」)+ ADR/RCA 2026-08-03 的既有约束。

## 🔍 1.5 假设账本

| ID | 假设 | 状态 | 证据 |
|----|------|------|------|
| A | 是我们近期改动引入的回归 | 🔴 falsified | 窗口内 `429 耗尽=0 / CONTENT_FILTERED=0 / 连接超时=0` —— 近期新增的那几套重试根本没触发 |
| B | payload 过大导致上游断流 | 🔴 falsified | 600-1000KB 非 200 率 2%,反低于 0-100KB 的 25%;无单调关系。TTFB p50 4.1s / p99 13.8s 正常 |
| C | check/stream 路径 region 兜底成 us-east-1 | 🔴 falsified | `[DIAG] account.region=eu-central-1 \| dataPlaneRegion(used)=eu-central-1`,且 GetUsageLimits region=eu-central-1 → 200 |
| D | 零输出断流可透明重试 | 🔴 falsified | 21 条 `reader_or_parse_error` 的 outChars **全部 > 0**(23…7323),已发 message_start + delta;ADR-0001 Invariant 1 禁止重放 |
| E | 不记账号错误削弱了换号自愈 | 🔴 falsified | 换号由 `pre_body_failed` vs 已吐正文决定,与 recordError 无关;首字节前失败仍照常 recordError + 切号 |
| F | AWS 新增了 region 端点 | 🔴 falsified | 24 region × 3 host DNS 枚举(带通配对照,假 region NXDOMAIN)→ 仅 us-east-1 / eu-central-1 |
| G | **EU 侧存在可用的 V1 fallback,只是我们没登记** | 🟢 **confirmed** | 三把真实 ksk 实测:`q.eu-central-1` → **200 流式正常**;`codewhisperer.eu-central-1` → ECONNRESET |

## 🔬 1.6 实测矩阵(三把真实 ksk · 用户授权)

| 端点 | ksk#1(EU·已封号) | ksk#2(US) | ksk#3(EU·健康) |
|---|---|---|---|
| `runtime.us-east-1.kiro.dev` | 403 invalid | **200** | 403 invalid |
| `runtime.eu-central-1.kiro.dev` | **200** | 403 invalid | **200** |
| `codewhisperer.us-east-1` | 403 invalid | **200** | — |
| `codewhisperer.eu-central-1` | ECONNRESET | ECONNRESET | **ECONNRESET** |
| `q.us-east-1` | 403 invalid | **200** | 403 invalid |
| `q.eu-central-1` | 403 **suspended** | 403 invalid | **200 ✅** |
| `q.eu-central-1/SendMessageStreaming` | — | — | 403 **API key auth not supported** |

三条结论:
1. **跨区必 403**(三把 key 六次复现)→ RCA 2026-08-03 的结论**完全成立**,保留
2. **`codewhisperer.eu` 确实停服**,但 **`q.eu-central-1` 一直可用** —— 二者不可混为「eu 侧 V1 停服」
3. `SendMessageStreaming` 明确拒绝 API key 认证 → ksk 账号 + `amazonq-cli` 偏好 = 100% 必败

判据分层是这次能定性的关键:403 有三种完全不同的含义 —— `bearer token invalid`(跨区不认)
/ `User ID suspended`(端点认了 token,账号有问题)/ `API key authentication is not supported`
(端点不支持这种凭据)。只看状态码会把「端点不可用」和「账号被封」混成一件事。

## 🔍 2. 根因分析

**首个断裂点**:`src/main/proxy/kiroApi.ts` — `getSortedEndpoints` 的
`const v1Endpoints = wantEuRegion ? [] : ...`

**为什么会写成空数组**:RCA 2026-08-03 的现场是「EU 账户 KiroRuntime-EU 429 撞爆 10 次 →
fallback CodeWhisperer(us-east-1) → 403 → 立即报错」。当时的处置(EU 不 fallback 到 V1 us)
**正确**;但结论被概括成注释「**eu 侧 V1 已停服**」,并据此落成空数组。

那句概括只对 `codewhisperer.eu` 成立。同一仓的 REST 侧其实一直在用 `q.eu-central-1`:

```ts
// src/main/index.ts
const KIRO_REST_API_ENDPOINTS_V1_FALLBACK: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'   // ← 一直在用
}
```

而它上面那行注释同样写着「eu 侧已停服」—— **注释与它自己下面的代码矛盾**。REST 侧代码碰巧
没跟着错(map 里两个 region 都配了),反代对话链则真的照注释实现成了空数组。

**Bug 类别**(§5.2 七类):**Interface Contract Ambiguity** —— 一个过度概括的结论被当作
契约写进注释,下游按注释而非按事实实现。

**放大因素**:该端点当日 41% 失败率(上游侧质量,非本仓可控),使「无退路」从潜在缺陷
变成用户每天可感知的中断。

## 🕵️ 3. 变体扫描

重复实现检索(§2.6 pre-write existence gate):
- 内部 `git grep "q\.eu-central-1"` → `index.ts:255` / `registrar.ts:1498` 已在用(**未在反代端点表登记**)⇒ 补登记而非新造机制
- 内部 `git grep "getSortedEndpoints|KIRO_ENDPOINTS" -- test` → 3 个文件提到端点名但都 `vi.mock` 掉 kiroApi,**端点选择本身零测试** ⇒ 本轮补 10 例
- 外部:`kiro-manager-lite` 的 `qEndpoint(region)` 按 region 动态构造(同一思路的既有实践);`d-kuro/kirocc`、`nopperabbo/kiroxy`、`jwadow/kiro-gateway` 活跃跟进协议变更

指纹:**「按 region 分发的端点表里只登记了其中一个 region 的变体」**。

| 变体 | 位置 | 风险 | 本轮 |
|---|---|---|---|
| EU 缺 V1 fallback | `getSortedEndpoints` v1Endpoints | 高(41% 失败无退路) | ✅ 补 `AmazonQ-EU` |
| 新端点被 US 链 filter 顺带吸入 | 同处 `ep.name !== 'AmazonQCLI' && !startsWith('KiroRuntime')` | 高(EU host 混进 US 链 → 跨区 403) | ✅ 显式排除 + 专测守护 |
| ksk + amazonq-cli 必败 | `preferredEndpoint === 'amazonq-cli'` 单端点分支 | 中(用户误配即 100% 失败) | ✅ API_KEY 时忽略该偏好 |
| 按端点名的特殊分支 | L1998 CodeWhisperer 模型 ID 解析 / L2007 AmazonQCLI 删字段 | 低 | 已核:新端点与 `AmazonQ` 同构,走默认路径 |
| 「eu 侧已停服」错误注释 | `index.ts:246` REST 侧同句 | 低(代码是对的,注释误导后人) | ⏳ 未改 —— 属另一模块,登记待办 |

## 👥 4. 真实场景模拟

1. **EU 主端点抽风**(本 bug 本体):runtime.eu 429/断流 → 自动走 q.eu → 请求完成
2. **两个 EU 端点同时挂**:链走完 → 既有 `ALL_ENDPOINT_RETRY_BACKOFF_MS` 退避重走整条链 → 仍失败才交挂起决策(行为不变)
3. **EU token 误发 us host**:测试硬断言 EU 链任何 URL 不含 `us-east-1`(跨区必 403,白耗 10s + 污染错误计数)
4. **ksk 账号配了 amazonq-cli**:忽略偏好回落正常链(否则 403 API key not supported 且无退路)
5. **非 EU 非 US 的 region**(ap-*/ca-*/sa-*):归并 US 链(官方仅部署两个 region,已 DNS 枚举确认)

未处理(明确登记):`q.eu-central-1` 的实际健康度尚无长期样本 —— 它只在主端点失败时才被使用,
需观察若干天再判断是否要调整顺序或加健康度权重。

## 📚 5. 行业参照

- **AWS 官方公告原文**(github.com/jwadow/kiro-gateway#146,2026-04-29):`runtime/management/telemetry.{region}.kiro.dev` 三组新端点,`q.{region}.amazonaws.com` 于 2026-05-15 停用,**"Currently supported regions are us-east-1 and eu-central-1"** → 与本轮 DNS 枚举结论一致。注:`q.*` 实测至今仍可用(us/eu 皆 200),即代码注释所称的 grace period
- `hongyilyu/pi-kiro#9`:profile 解析已迁至 `management.*.kiro.dev`(本仓 REST 侧已用,**反代侧待核**)
- `nopperabbo/kiroxy` `headers.go`:端点 + header 形态会影响上游对请求的判定(native fingerprint vs generic SDK traffic),并按 machineID 派生 per-account UA 以避免批量使用检测 —— 与本轮 41% 失败率是否相关无证据,登记备查

## 🛠️ 6. 外科手术式修复

| 文件 | 改动 |
|---|---|
| `kiroApi.ts` | 新增端点定义 `AmazonQ-EU`(`q.eu-central-1/generateAssistantResponse`,与 `AmazonQ` 同 amzTarget/protocol/origin) |
| `kiroApi.ts` | `v1Endpoints`:EU → 仅 `AmazonQ-EU`;US → 排除 `AmazonQ-EU`(防被既有 filter 吸入) |
| `kiroApi.ts` | `getSortedEndpoints` 加第三参 `isApiKeyAuth`;`amazonq-cli` 单端点分支对 API_KEY 账号不生效 |
| `kiroApi.ts` | `export getSortedEndpoints`(可测性);修正「eu 侧 V1 已停服」注释为准确表述 |

**刻意不改**:
- **不给 EU 加任何 us host** —— 跨区必 403,三把 key 六次实测,RCA 2026-08-03 结论保留
- **不登记 `codewhisperer.eu`** —— 实测 ECONNRESET
- 不动 V2 优先顺序、不动 `ALL_ENDPOINT_RETRY` 退避、不动挂起决策
- 不动 `index.ts` 那句同源错误注释(跨模块,登记待办)

## ⚠️ 7. 影响面与回归风险

**影响面**:仅 EU 账号的端点链从 1 个变 2 个(纯增量,只在主端点失败时走到);US 链断言不变;
`amazonq-cli` 对非 API_KEY 账号行为不变。

**回归测试**:`test/main/proxy/endpointChainRegion.test.ts` 新增 **10 例** —— US 链回归 /
EU 有 fallback / EU 链禁含 us host / EU 用 q.eu / 其它 region 归并 / amazonq-cli 单端点 /
preferredEndpoint 只影响 V1 内部顺序 / ksk×amazonq-cli 三例。

**Mutation**:改前红 2(EU 无 fallback、缺 q.eu)+ 后续红 2(ksk 防御),其余 5–8 例保持绿 —— 证明非恒红。

**消费锚点**:最终 sink = EU 账号请求在主端点失败后的实际完成率。**真实端点连通性已由带真
token 的实测覆盖**(`q.eu-central-1` + 该 amzTarget + `TokenType: API_KEY` → 200 流式);
端点链构造由单元测试覆盖。运行时效果需观察若干天。

**验证**:`npm run typecheck` EXIT=0;`npx vitest run` → **98 files / 1039 tests 全绿**。

## 🧩 8. 边界加固

1. 端点选择此前**零测试**(3 个相关测试都 mock 掉了 kiroApi),本轮首次为其建立契约测试。
2. 「新增端点会被既有宽 filter 顺带吸入」这个陷阱被显式测试钉住(EU host 混进 US 链 = 跨区 403)。
3. 凭据类型与端点能力的冲突(API_KEY × SendMessageStreaming)第一次有了防御与判据来源。
