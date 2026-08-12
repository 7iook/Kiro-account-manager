# Rust Kiro-proxy 宿主候选评估（只读侦察）

日期：2026-08-10 · 模式：plan-reality-recon Mode R · **只读，未构建、未运行 cargo、未修改任何目标目录**

目标：判断三个 Rust 项目能否作为「服务器部署」的宿主，把本项目（Electron/TS，Kiro-account-manager）的代理优化移植进去。

---

## 0. 三者关系（先定这个 —— 结论：两条血脉，不是三个项目）

| 项目 | remote | 根提交 | 提交数 | 版本 | 最后提交 | src/*.rs |
|---|---|---|---|---|---|---|
| `E:\kiro.rs` | ZyphrZero/kiro.rs | `02026cc9`(2025-12-27) | 466 | 0.6.9 | **2026-07-09** | 71 个 / 1.49 MB |
| `F:\kiro.rs-admin` | liuran001/kiro.rs-admin | `02026cc9`(**同一个**) | 520 | **0.6.11** | **2026-07-15** | 80 个 / 1.84 MB |
| `F:\kiro-rs` | M-JYuan/kiro.rs（upstream=hank9999） | `4ecd10c`(2026-05-14) | **1（squash 快照）** | 1.1.31 | 2026-05-14 | 69 个 / 1.11 MB |

**关键事实（证据：`git log --reverse` 首提交哈希一致）**：`E:\kiro.rs` 与 `F:\kiro.rs-admin` **共享同一个根提交 `02026cc9b2a4e03d9c682da50556328c3277dd33`** —— 它们是同一条血脉的两个位置，`kiro.rs-admin` 领先 54 个提交（520 vs 466）、版本更高（0.6.11 vs 0.6.9）、代码更多（+9 个文件 / +0.35 MB），并且多出 `src/openai/`（`E:` 没有 OpenAI 兼容端点）。

血脉链（`F:\kiro.rs-admin\README.md` 开头 + 二改说明自述）：
`hank9999/kiro.rs`（原始）→ `ZyphrZero/kiro.rs` 二开（= `E:\kiro.rs`）→ 长秋佬 `kiro-rs-admin` 三开 → **`liuran001/kiro.rs-admin` 四开（= `F:\kiro.rs-admin`，同步了 ZyphrZero 0.6.9 并继续加 Admin 能力）**。

`F:\kiro-rs` 是**另一条血脉**（hank9999 → M-JYuan）的**单提交 squash 快照**，版本号体系完全不同（1.1.31），最后活动 2026-05-14，比另外两个**旧了两个月**，且没有 git 历史（1 个提交 = 无法做考古、无法 cherry-pick 上游）。

**45.2 MB ≠ 代码量。** `E:\kiro.rs` 体积大是因为工作目录里塞了 `kiro-rs-0.6.1-Windows-x64\`（解压的发布包）、`logs\`、`.agent-workspace\`、`Cargo.lock`、若干 `.tmp-*.ps1` / `req-*.json` 临时件。真实源码它是三者中的**中间量**，不是最大。

> **早期结论（按约束「若是 trivial fork 就早说」）**：`E:\kiro.rs` 对 `F:\kiro.rs-admin` 而言是**严格子集的上游**（少 OpenAI 端点、少 model_mapping、少 54 提交、旧 6 天+2 个小版本）。**没有理由选 `E:`**：选它 = 主动放弃已经合并好的 54 个提交。因此预算集中在 `F:\kiro.rs-admin`（实质候选）与 `F:\kiro-rs`（对照）。

---

## 1. 逐项目结论

### 1.1 `F:\kiro.rs-admin` —— 实质候选，唯一值得认真考虑的宿主

活着且是三者中最新（2026-07-15，0.6.11，520 提交）。它是一个 axum 0.8 + tokio 的 Anthropic Messages API 兼容代理，把 `/v1/messages` 等转成 Kiro / Amazon Q 后端请求，另有 `src/openai/`（`chat/completions`）、内嵌 Admin UI（`rust-embed`）、SQLite 请求链路追踪（`rusqlite` bundled）、代理池、客户端 Key 分组、在线更新（tar/zip 自解压换二进制）。凭据池模型在 `src/kiro/token_manager.rs`（5758 行，单文件即整个池 + token 刷新 + 余额查询 + 冷却），选择器 `select_next_credential_excluding()`（`src/kiro/token_manager.rs:1425`）支持三种负载均衡模式 `priority` / `balanced`（success_count 最少）/ `least_conn`（**in_flight 在途请求最少** —— 这条注释明确写了「天然避免惊群与『反复选中→反复 429』死循环」，是真实上游踩坑知识），过滤链已含 `disabled` / `throttled_until`（账号级 429 风控）/ `rate_limited_until`（普通 429 策略冷却）/ 模型与分组隔离 / **RPM 滑动窗口**（`is_rpm_exceeded`）。402 与 429 **确实分开处理**（`src/kiro/provider.rs:827` 与 `:1139`：`402 && endpoint.is_monthly_request_limit(&body)` 才禁用凭据；`QUOTA_EXHAUSTED_REASONS` 在 `src/kiro/endpoint/mod.rs:140` 且有 3 个针对性测试，包括「子串不得误匹配」）。CHANGELOG 0.6.11 有整节讲 429 全链路传播、`Retry-After` 只转发合法秒数/HTTP-date、刷新端点 429 不计入失败次数不误禁用凭据 —— 这类知识买不到。**但它没有请求挂起**：池空时 `acquire_context_excluding()` 走 attempt 预算循环，耗尽即 `anyhow::bail!("所有凭据均无法获取有效 Token（可用: {}/{}）")`（`src/kiro/token_manager.rs:1553`），也就是**报错向上冒**，不是冻结请求等额度回来。

### 1.2 `E:\kiro.rs` —— 同血脉的上游，严格劣于 1.1，不作候选

同根提交、同架构、同文件布局，落后 54 提交 / 2 个小版本，**缺 `src/openai/`（无 OpenAI 兼容端点）**、缺 `src/admin/model_mapping.rs`。唯一它有而 admin 分支「看起来没有」的是 SSE 空闲中断常量 `IDLE_TIMEOUT_SECS = 30`（`src/anthropic/handlers.rs:830`，注释「上游连续无数据超过该时长主动中断本次流」）+ 最后一个提交正是 `fix(stream): tool_use 进行中放宽空闲中断阈值`；`git grep idle_timeout|stall|空闲中断` 在 admin 分支未命中同名常量，所以**若选 admin 分支，需要单独确认这条 stall detection 是否被改名/重构，别把它丢了**（这是本次侦察发现的唯一「上游比下游多」的点，未深挖，标记 `unverified`）。除此之外选它没有收益。

### 1.3 `F:\kiro-rs` —— 另一条血脉的 squash 快照，作对照有价值，作宿主不行

最旧（2026-05-14，比 admin 分支旧两个月）且**只有 1 个提交** —— 没有历史 = 不能考古、不能跟上游、每次同步都是整树 diff。它的凭据选择器反而更贴近「真实用量驱动」：`select_best_candidate_id()`（`src/kiro/token_manager.rs:1109`）两级排序 = **recent_usage 最少 → remaining 余额最多 → round-robin 兜底**，直接读 `balance_cache`，且把未初始化凭据当 `u32::MAX` 避免被优先选中、把 NaN 余额归一化为 0.0（细节到位）。它是三者中**唯一有独立 `src/kiro/affinity.rs`**（会话粘性单独成模块）、有独立 `src/kiro/rate_limiter.rs` / `src/kiro/cooldown.rs` / `src/kiro/background_refresh.rs`（带 `tokio::sync::Notify` 优雅停机）—— **模块边界比 admin 分支干净得多**。但功能面窄：没有 OpenAI 端点、没有 SQLite 追踪、没有代理池、没有 model_mapping、没有 SSE stall detection（`git grep idle_timeout|stall` 零命中）。**它对「池空」的处理是明确的快速失败**：`src/anthropic/handlers.rs:499` 日志「所有凭据临时冷却，返回 429 + Retry-After」→ 直接 `StatusCode::TOO_MANY_REQUESTS` + `Retry-After` 头；池空则 `503 No credentials available`（`:480`）。也就是说它把「无可用账号」当成**要告诉客户端的错误**，与「挂起」是相反的设计取向。另外它工作目录里躺着 `credentials.json` / `credentials.json.bak` / `kiro_balance_cache.json`（真实凭据文件，未读取内容）。

---

## 2. 特性对照表

| 特性 | `F:\kiro.rs-admin` (0.6.11) | `E:\kiro.rs` (0.6.9) | `F:\kiro-rs` (1.1.31) |
|---|---|---|---|
| 多账号池 + 轮转/加权 | ✅ 3 模式 priority/balanced/**least_conn(in_flight)** `token_manager.rs:1470-1487` | ✅ 同源但少 least_conn 相关演进 | ✅ usage+balance 两级排序 + RR `token_manager.rs:1109` |
| Token 刷新（Kiro/AWS IdC + social + 外部 IdP） | ✅ 三类齐全，**含企业 SSO / Entra ID / Azure AD 全流程**（README 二改说明） | ✅ 三类（无 admin 分支的 Entra 网页取链） | ✅ social/IdC（`credentials.example.{idc,social,multiple}.json`），无企业 SSO 网页流程 |
| **请求挂起（无账号时冻结而非失败）** | ❌ **无**。attempt 预算耗尽 → `bail!("所有凭据均无法获取有效 Token")` `token_manager.rs:1553`；仅有「全冷却时 sleep 最短等待再重试」的循环内退避 | ❌ 同源无 | ❌ **明确反向设计**：`handlers.rs:499` 全冷却 → 429+Retry-After；`:480` 池空 → 503 |
| 429 重试 + 可配策略 | ✅ 全链路类型化 429 传播、只转发合法 `Retry-After`、刷新端点 429 不计失败（CHANGELOG 0.6.11）；`rate_limited_until` + `throttled_until` 双冷却位 | ✅ 弱一版（429 全链路那节是 0.6.11 才补的） | ✅ 独立 `rate_limiter.rs` + `cooldown.rs`，`ALL_CREDENTIALS_COOLDOWN_BAIL_THRESHOLD` 阈值化 |
| **402 额度耗尽 vs 429 限流区分** | ✅ `provider.rs:827/1139` `402 && is_monthly_request_limit(body)` 才 `DisabledReason::QuotaExceeded`；`QUOTA_EXHAUSTED_REASONS` + 3 个测试（含防子串误匹配）`endpoint/mod.rs:140-157` | ✅ 同源 `provider.rs:348/598` | ✅ `provider.rs:428/740` + 文档注释写明语义 |
| 每账号额度/用量追踪，且真实用量喂给选择 | ⚠️ 有 `get_usage_limits`（`token_manager.rs:492`）+ `usage_stats.rs` 聚合器，但**选择器只用 success_count / in_flight / priority，不读余额** | ⚠️ 同源 | ✅ **余额直接进选择**：`balance_cache` 的 `recent_usage` + `remaining` 是一/二优先级 `token_manager.rs:1116-1141` |
| 会话粘性（每会话固定账号） | ⚠️ `sticky` 只用于**代理池**（`proxyBalancingMode`，`config.rs:285`），不是会话→账号亲和 | ⚠️ 同源，且 `git grep affinity\|sticky` 在 src 零命中 | ✅ **独立 `src/kiro/affinity.rs`**，被 `provider.rs` / `token_manager.rs` 引用 |
| Anthropic + OpenAI 双兼容端点 | ✅ `src/openai/handlers.rs` + `chat/completions` | ❌ **无 OpenAI**（`git grep chat/completions` 零命中） | ❌ 无 |
| Prompt cache 处理 | ✅ `anthropic/cache_metering.rs` + converter/middleware | ✅ 同源 | ✅ `anthropic/cache_tracker.rs` |
| SSE 流 + 断流检测 | ⚠️ `git grep idle_timeout\|stall\|空闲中断` **零命中**（需确认是否改名，`unverified`） | ✅ `IDLE_TIMEOUT_SECS=30` `handlers.rs:830` + 最后提交在调这个阈值 | ❌ 零命中 |
| 模型能力路由 | ✅ `admin/model_mapping.rs` + `credential_matches_request(creds, model, group)` 进过滤链 | ⚠️ 无 model_mapping，有 converter 侧 | ⚠️ 仅 `web_portal.rs` 命中，无独立映射层 |
| Web Admin UI + 鉴权 | ✅ 内嵌 `admin_ui` + **单一 admin key 常量时间比较**（`admin/middleware.rs:75` `auth::constant_time_eq`）+ 客户端 Key/分组体系 | ✅ 同源（无 model_mapping 页） | ✅ 有 `admin_ui`，能力面窄 |
| 部署 | ✅ 三段 Dockerfile（bun 构建前端 → rust:1.92-alpine musl → alpine:3.21）+ compose（`8990:8990`、`./data:/app/config`、`restart: unless-stopped`）+ `Dockerfile.release`。**无 systemd unit** | ✅ 同源 + `Dockerfile.release` | ✅ Dockerfile + compose，另有 Python 侧（`main.py`/`pyproject.toml`/`Makefile`/`uv.lock`）—— 双语言运行时 |
| 测试 | ⚠️ 无 `tests/` 目录；`#[cfg(test)]` 内联（如 `endpoint/mod.rs:258-270`、`token_manager.rs:4427`）；无 CI 可断言的覆盖率 | ⚠️ 同源，更少 | ⚠️ 内联测试（`handlers.rs:2058-2064`），无 `tests/` |
| 上游怪癖知识（注释/CHANGELOG） | ✅✅ **最厚**：企业 ARN 双语义隔离、`getUsageLimits` 不能带 profileArn、429 不误禁凭据、least_conn 防惊群、批量导入 50MB body limit | ✅ 中等 | ✅ 中等（serde `preserve_order` 保证 kiro-cli 字节对齐、uuid v5 派生 agentContinuationId 保多轮稳定 —— 这两条很精） |

---

## 3. 架构缝隙（我们的特性能否挂上去）

三者的池都在 `src/kiro/token_manager.rs`，入口都是 `acquire_context*()`，**这就是唯一需要挂的缝**。

**`F:\kiro.rs-admin` 的缝在哪：**
- `acquire_context_excluding(model, group, excluded_ids)`（`token_manager.rs:1535`）内部已经是一个 `loop { 选 → 不可用则继续 }` + attempt 预算的结构，且循环里**已经有 sleep-retry 语义**（0.6.9 起就在处理「全冷却时等最短可用时间」）。把「挂起」插进去 = 把 `attempt_count >= max_attempts → bail!`（`:1550-1556`）这条出口，换成 `tokio::sync::Notify` / `watch` 上的等待 + 客户端断连感知（axum 的 `Drop`/cancel 已天然可用，因为整条链是 async）。**语义上不打架**：它已经承认「暂时无可用」是一种可等待状态（`throttled_until` / `rate_limited_until` 都是时间戳，天生可算唤醒时刻），只是当前选择了报错而不是等。
- 摩擦点是**这个文件 5758 行**，池状态、token 刷新、余额查询、冷却、分组隔离全在一个 `entries: Mutex<Vec<Entry>>` 上，且 `parking_lot`（**非异步锁、不可重入**，`:2102` 有注释专门警告持锁调用问题）。在 `parking_lot::Mutex` 临界区里不能 `.await`，所以挂起逻辑必须严格写在锁外，用「读一次最早可用时刻 → 释放锁 → await 到那个时刻或被 notify」的形状。这是可行的（现有代码已经用 `min_wait` 这么做过），但**改动落在一个巨型文件的热点函数上，每次同步上游都会冲突**。
- 「真实用量喂选择」要挂 `select_next_credential_excluding()` 的 `min_by_key`（`:1470-1487`）—— 那里已经是「取出 available → 按 key 排序」的形状，加一个读 `usage_limits` 缓存的 key 是**加法**，不是手术。这条很干净。
- 「会话粘性」要新建：admin 分支的 `sticky` 是代理池的，不是会话→账号的。需要 conversation_id → credential_id 的映射层（可直接照抄 `F:\kiro-rs\src\kiro\affinity.rs` 的形状）。

**`F:\kiro-rs` 的缝在哪：** 模块边界更好（`affinity.rs` / `cooldown.rs` / `rate_limiter.rs` / `background_refresh.rs` 各自独立，`background_refresh.rs:80` 已经在用 `tokio::sync::Notify`，挂起要的原语现成），选择器 `select_best_candidate_id()` 已经读余额。**但它的失败路径是显式设计过的对外契约**（`handlers.rs:480-513` 把 503/429+Retry-After 当成要告诉客户端的语义），改成挂起要动 handler 层的错误映射，且**没有 git 历史可考古**、比 admin 分支旧两个月、功能面窄（补 OpenAI 端点/追踪/代理池/model_mapping 是纯新建工作量）。

**`E:\kiro.rs`**：缝与 admin 分支完全相同（同源），但起点更落后，不构成独立选项。

---

## 4. 宿主推荐 + 我们最大的独有资产

**推荐 `F:\kiro.rs-admin`。** 理由锚在具体文件：它是唯一同时具备 (a) 最新且在动（2026-07-15 / 0.6.11 / 520 提交，有完整 git 历史可考古与跟上游）、(b) 功能面最全（`src/openai/` 双兼容端点、`admin/model_mapping.rs`、`rusqlite` 请求追踪、代理池、客户端 Key 分组、企业 SSO 全流程）、(c) 上游怪癖知识最厚（CHANGELOG 0.6.11 整节 429 全链路 + 企业 ARN 双语义 + `endpoint/mod.rs:140` 的 402 判定含防误匹配测试）、(d) 部署即用（三段 musl Dockerfile + compose 8990 + `Dockerfile.release`）。`E:\kiro.rs` 是它的落后上游，选它等于丢 54 个提交；`F:\kiro-rs` 架构更干净但旧两个月、无 git 历史、功能面窄。

**我们项目有而它最缺的一件事：请求挂起（无可用账号时冻结请求，等额度/冷却恢复后继续，而不是把失败抛给客户端）。** 三个候选**全都没有**，而且 `F:\kiro-rs` 是明确的反向设计（`src/anthropic/handlers.rs:480-513`：池空 503、全冷却 429+Retry-After）。`F:\kiro.rs-admin` 最接近但仍是报错出口（`src/kiro/token_manager.rs:1550-1556` attempt 预算耗尽即 `bail!`）。这解释了它们为什么把「自愈」做成别的形状：admin 分支在池全灭时干的是**重置失败计数并重新启用全部凭据**（`token_manager.rs:1594-1604`，注释「等价于重启」）—— 这是在没有挂起能力时，为了不返回错误而被迫采取的粗暴补偿，恰好反证挂起是缺的那一环。

次要缺口（按移植成本从低到高）：① 真实额度喂选择（admin 有 `get_usage_limits` 但选择器不读；`F:\kiro-rs:1116` 可作参考实现）；② 会话→账号粘性（admin 的 `sticky` 是代理池的，需新建；可照抄 `F:\kiro-rs\src\kiro\affinity.rs`）；③ SSE 断流检测在 admin 分支 `git grep` 零命中而在 `E:\kiro.rs:830` 存在（`IDLE_TIMEOUT_SECS=30`）—— **迁移前必须确认这条有没有在 admin 分支被改名或丢掉**（本次未深挖，`unverified`）。

**风险提示（不是否决项）**：`token_manager.rs` 5758 行单文件承载池+刷新+额度+冷却，且用 `parking_lot` 同步锁（`:2102` 注释明确警告持锁调用与非重入），挂起改造必须严格锁外 await；三个项目**都没有 `tests/` 目录**，只有内联 `#[cfg(test)]`，所以移植后的回归网要我们自己补。

---

## Update Log

- 2026-08-10 骨架落盘，开始填充。
- 2026-08-10 完成：血脉关系（同根提交证据）+ 挂起门闸三方结论（均无，kiro-rs 为反向设计）+ 402/429 区分 + 特性对照表 + 架构缝隙 + 宿主推荐（`F:\kiro.rs-admin`）。全程只读，未构建未运行 cargo。遗留 `unverified`：admin 分支 SSE 空闲中断常量是否被改名。
