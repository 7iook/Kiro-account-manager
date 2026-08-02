# RCA · ksk_ 网页密钥跨区域适配缺失(欧洲账号 403)

## 🔴 1. 现象 & Context

- 用户导入 `ksk_y9odCr6NibzKEEsOj6k2sZ5bk5aXEaSq`,应用账户卡显示 `HTTP 403 {"message":"The bearer token included in the r..."}`,状态"错误"。
- 用户业务陈述:该 key 在别处能正常对话,是"一人账号,没有地区",怀疑代码把请求发到了错误地区,或对无地区场景未做适配。
- 参考项目(Rust `kiro.rs-admin` / Node `9router` / `Kiro-Go-main`)已实现 ksk 相关能力。
- **成功状态(§0.15B · 用户视角)**:NOT «代码把 ksk 请求打到正确 host»,BUT «用户导入一个欧洲 ksk 密钥后,账户卡显示 KIRO POWER · 使用量正常读取,不显示 403»。负向条件:不再出现"bearer token invalid"错误。来源=用户原话 + 截图观察。
- **现象锁**:同一 ksk,`GET management.us-east-1.kiro.dev/getUsageLimits` → 403 `{"message":"Invalid token"}`;`GET management.eu-central-1.kiro.dev/getUsageLimits` → 200 KIRO POWER,`currentUsage=948`。(证据锚点:2026-08-02 01:19 node fetch 实测,PID 62936)

## 🔍 1.5 假设账本

| ID | 假设 | 状态 | 证据 | 更新 |
|----|------|------|------|------|
| A | 应用把 ksk 请求打到 us-east-1,但该 key 属于 eu-central-1,单区域探测无跨区回退 | 🟢 已证实 | ①`validateApiKeyCredential` kiroApi.ts:523-533 硬编码 `region='us-east-1'` 且无回退;②`callKiroApiStream` kiroApi.ts:1812 `isEnterprise` 守卫把 api_key 排除在 profileArn 自愈之外;③受控对照:同 key US=403 / EU=200 | 08-02 |
| B | key 本身已吊销或签名格式变化 | 🔴 已证伪 | EU 端点 200 返回 KIRO POWER 完整订阅信息,key 有效 | 08-02 |
| C | AddAccountDialog UI 不让用户选 region | 🔴 已证伪 | AddAccountDialog.tsx:140 `apiKeyRegion` 有 dropdown,但默认 `'us-east-1'`,用户未主动改就是默认 US → 依旧 A | 08-02 |

**结论**:根因 = A。B/C 均已证伪且证据直接锚在目标样本。

## 🔍 2. Root-Cause Analysis

### The Why

Kiro 数据面 REST API(`getUsageLimits` / `ListAvailableModels` / `ListAvailableProfiles` / `GetProfile`)**只在两个 region 提供服务**:`us-east-1`(N. Virginia)和 `eu-central-1`(Frankfurt)。Kiro 网页版发放的 ksk_ 静态密钥归属于账号所在数据面 region;打到错误 region 上,后端一律返 `403 {"message":"Invalid token"}`(与"密钥吊销"无法从响应体区分)。

参考项目 `kiro.rs-admin/src/kiro/token_manager.rs:461` 已明文这个契约并实现 `rest_api_region_candidates(sso_region)`:根据身份 region 决定主端点,403 时自动回退另一个。本应用只对 Enterprise / IdC / external_idp 类型账户实现了跨区自愈(`fetchEnterpriseProfileArn` kiroApi.ts:3472,遍历 `KNOWN_CW_DATA_REGIONS`),但对 api_key(ksk_)完全缺失同款能力:

- `validateApiKeyCredential`(kiroApi.ts:523):默认 `region='us-east-1'`,单次 `GET management.{region}.kiro.dev/getUsageLimits`,403 直接归 INVALID(无 region 回退)。
- `callKiroApiStream` isEnterprise 守卫(kiroApi.ts:1809-1812):`const isEnterprise = account.provider === 'Enterprise' || account.authMethod === 'external_idp'`,api_key 不匹配 → 永不进入 `fetchEnterpriseProfileArn` 自愈分支,即使该函数内部逻辑是通用的、对 ksk 完全可用。

### First Broken Point

- `src/main/proxy/kiroApi.ts:523-533` `validateApiKeyCredential` 函数签名 `region = 'us-east-1'` + 后续 `getKiroManagementHost(region)` 只用这一个值。

### Bug 类别(§5.2)

- [x] **Interface Contract Ambiguity** — 契约层面:"ksk 属于哪个 region"是上游隐式契约,代码把它降级成"用户输入的 region 一定对",没有做契约层的适配探测。

## 🕵️ 3. 变体扫描(§5.3)

**指纹**:"api_key 类型账户的数据面 region 假设单一 / 无跨区回退"。

| 位置 | 风险 | 本轮修? | 备注 |
|------|------|---------|------|
| `validateApiKeyCredential` kiroApi.ts:523 | 🔴 高 · 导入路径直接 403 | ✅ 是 | 加跨区探测(hint region → 另一 region) |
| `resolveApiKeyProfileArn` kiroApi.ts:433 | 🟡 中 · Step2 附赠 profileArn 时可能 403 | ⚠️ 半修 | VALID 后调用,可用 validateApiKeyCredential 返回的实际 region → 不需再跨区 |
| `callKiroApiStream` isEnterprise 守卫 kiroApi.ts:1809-1812 | 🟢 低 · 一旦导入 region 正确,`account.region` 已含 eu-central-1,`getKiroRuntimeHost(account.region)` 自然打对端点 | ❌ 否 · 见备注 | api_key 走 Bearer + `TokenType:API_KEY`,不强依赖 profileArn;为其扩守卫会引入无必要 GetProfile 调用(STANDALONE 订阅本来就 400) |

**内部复用检索(§2 双方向)**:
- 内部:`git grep KNOWN_CW_DATA_REGIONS` → kiroApi.ts:3411 已定义并被 `fetchEnterpriseProfileArn` 消费;可直接复用,不新造并行清单。
- 外部:参考项目 `F:\kiro.rs-admin\src\kiro\token_manager.rs:461-475` `rest_api_region_candidates` 已给出成熟范例;`F:\9router\src\lib\oauth\services\kiro.js:269-293` `listAvailableProfiles` 是"取回 profiles 再按 region 匹配"的相似但更弱形态(它假设 hint region 正确)。→ 采用 Rust 侧"403 → 试另一个"的强形态。

## 👥 4. Real-World Scenario Simulation(§5.4)

- **EU 账号导入(主场景)**:用户在下拉默认 `us-east-1` 状态下粘贴 EU ksk → 之前 403,修复后自动切 EU 探测 200 → 持久化 `region=eu-central-1`。
- **US 账号导入(回归)**:hint region 正确 → 首次探测就 200,不进入回退,无额外延迟。
- **无效密钥(回归)**:两个 region 都 403 且 body 明确 `InvalidTokenException` → 保持 INVALID。
- **被吊销的 EU 密钥**:US 端 403(Invalid token / 无 __type)→ 尝试 EU;EU 端 401 明确 InvalidToken → 归 INVALID 正确。
- **网络瞬时故障**:hint region 网络错误 → INDETERMINATE,不试另一个(网络错误与 region 无关,避免误将网络故障当成"真的无 profile")。
- **两个 region 都返 5xx / 429**:短路,首次 5xx/429 就 INDETERMINATE,不额外打第二区。
- 明确不处理:AWS 未来新增第 3 个 CW 数据面 region → 由 `KNOWN_CW_DATA_REGIONS` 常量集中控制,新增 region 时改一处即可(§4.3 SSOT)。

## 📚 5. Industry Reference

- **kiro.rs-admin `rest_api_region_candidates`** — `F:\kiro.rs-admin\src\kiro\token_manager.rs:461-475`(searched: `git grep -n rest_api_region_candidates` in kiro.rs-admin;top1 = token_manager.rs:461)。直接同构参考,采用其"primary + fallback 双选"模型,已在本项目 IdC/Enterprise 路径实证有效(`fetchEnterpriseProfileArn probe order` 每次请求都跑,日志见 dev PID 13040 输出)。
- **9router `listAvailableProfiles`** — `F:\9router\src\lib\oauth\services\kiro.js:269-293`(searched: `grep validateApiKey|ListAvailableProfiles` in 9router;top1 = kiro.js:269)。较弱形态,依赖 hint region 正确;若 EU 账号用 US region 打仍会 403 挂。**证据即"参考项目并非全都做对了,不能只对着一个抄"**。

## 🛠️ 6. Surgical Fix

**Fix Strategy**:在 `validateApiKeyCredential` 里加"hint region → 另一 region"两步探测,复用现有 `KNOWN_CW_DATA_REGIONS`;成功时返回实际生效 region;IPC handler 用它作为持久化 region。

**Minimal Files Changed**:

1. `src/shared/types/credential.ts` — `CredentialProbeResult` 加可选 `region?: string`(SSOT 类型契约扩展,3 行)。
2. `src/main/proxy/kiroApi.ts` — `validateApiKeyCredential` 重构:抽出内部 `probeApiKeyCredentialAtRegion`,主函数循环 `[hint, ...KNOWN_CW_DATA_REGIONS.filter(≠hint)]`,单区域 INVALID/403 时试下一个,其他终态直接返回(约 40 行改动 / 净增 20 行)。
3. `src/main/index.ts` — verify-api-key IPC 用 `probe.region` 优先于入参 region 作为 dataPlaneRegion 兜底(2 行)。

**Files Explicitly NOT Changed**(下游诱人补丁点保留):
- `callKiroApiStream` `isEnterprise` 守卫 — 一旦 `account.region` 正确入库,现有 `getKiroRuntimeHost(account.region)` 天然选对端点;强扩守卫反而给 STANDALONE 订阅引入无用 GetProfile 调用。
- `resolveApiKeyProfileArn` — VALID 后调用,拿到实际 region 后 caller 传入即可。

## ⚠️ 7. Blast Radius & Regression Risk

- **影响面**:
  - `verify-api-key` IPC 返回 `region` 字段可能不再等于入参 `region`(EU 账户会翻转);AddAccountDialog 已经用 `verify.region || apiKeyRegion` 消费(:1417),兼容。
  - 老 ksk 账户(store 里 region=us-east-1 但实际是 EU):账户卡的"刷新/检测"按钮会重新走 verify-api-key → 自动纠正 region 并持久化,自愈。
- **回归测试**:
  - 单元测试锁 `validateApiKeyCredential`:mock fetch,US 200 → 走 US 一次;US 403+EU 200 → 走两次成功;US 5xx → INDETERMINATE 短路不试 EU;US+EU 都 401 → INVALID。
  - 端到端:用户手上 ksk 重跑一次导入,确认账户卡状态从"错误"变"正常"。
- **消费锚点(§0.15B)**:最终 sink = 账户卡 UI 状态从红色"错误"变绿色"正常" + `management.eu-central-1.kiro.dev` 返 200。真实 e2e 姿态 = 用户重启 dev 后重新验证账户(或直接删除重导入),观察 UI + 后端日志。

### 消费链路

| 节点 | 生产者 | 消费者 |
|------|--------|--------|
| ksk key + region hint | AddAccountDialog(existing) | verify-api-key IPC(existing) |
| verify-api-key IPC | main/index.ts:4959(to change) | AddAccountDialog verify.region 分支(existing) |
| CredentialProbeResult.region | validateApiKeyCredential(to change) | verify-api-key IPC region 计算(to change) |
| account.region | Store persistence(existing) | callKiroApiStream getKiroRuntimeHost(existing) |

## 🧩 8. Boundary Reinforcement

- **顺手接顶**:`CredentialProbeResult.region` 语义 = "实际成功命中的 region";state=VALID 时必填,其他 state 一律 undefined(与 tokenFingerprint 同规矩)。这条不变式在类型注释里明写,防止未来 caller 误消费。
- **不做**:引入 IdC/Social 的 region 探测扩展 —— 这些账户走 SSO OIDC refresh,`account.region` 是身份 region(不一定等于数据面),已由 `parseRegionFromProfileArn` 处理,与 ksk 场景机制不同。

## Update Log

- 2026-08-02 01:20 · 落 RCA · 受控对照证据锚点:PID 62936 输出(us-east-1=403,eu-central-1=200)。commit: pending。
