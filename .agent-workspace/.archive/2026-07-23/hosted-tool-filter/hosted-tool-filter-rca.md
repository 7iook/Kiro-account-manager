# ② Claude 内置 WebSearch 400 REQUEST_BODY_INVALID · RCA

> 分类:🐛 Bug flow · Artifact: RCA(§5.8 八段)
> 触发命令:Claude Code v2.1.217 里调内置 WebSearch → `Error: API Error: 400 API error 400: {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`

---

### 🔴 1. Phenomenon & Context

- **现象锁死**:Claude Code(v2.1.217, Opus 4.8, 1M context)→ 反代 → Kiro 后端。当客户端内部触发 `WebSearch(...)` 工具调用,请求过反代到 Kiro 后端返 `400 { message: "Improperly formed request.", reason: "REQUEST_BODY_INVALID" }`。exa MCP / tavily MCP 正常;普通对话正常。
- **触发条件**:客户端在 `POST /v1/messages` 的 `tools` 数组里带 `{ type: "web_search_20250305", name: "web_search", max_uses?: N }` 这种 **Anthropic server-side hosted tool**(Anthropic 后端自己执行,不需要 `input_schema`)。反代 `translator.ts:convertClaudeTools` 把它当成普通 function tool 转换,`inputSchema.json = undefined`。

### 🔍 1.5 Hypothesis Ledger

| ID | 假设 | 状态 | 证据 | 更新 |
|----|------|------|------|------|
| A | Kiro 后端不认 hosted tool type,`toolSpecification.inputSchema.json = undefined` 直接被 rpc-v2-cbor schema 拒 | 🟢已确认 | translator.ts:1049-1097 `convertClaudeTools` 无 filter · `t.input_schema` undefined → `inputSchema: { json: undefined }` · 报错 `REQUEST_BODY_INVALID` 与 CBOR schema 拒绝语义一致 | 2026-07-23 |
| B | 是 Claude Code 客户端 bug 传坏了 request | 🔴已证伪 | Claude Code 直连 Anthropic 官方端点 WebSearch 正常;同 client 只走反代才 400 | 2026-07-23 |
| C | 是 Kiro API 侧 model 不支持,应换 model | 🔴已证伪 | 同 model 对话/其他 tools 正常;model 无关 | 2026-07-23 |

### 🔍 2. Root-Cause Analysis

- **The Why**:Anthropic 的 server-side hosted tools(`web_search_20250305` / `bash_20250124` / `text_editor_20250124` / `computer_20250124`)由 Anthropic 后端自己执行,请求侧 tools 数组只带 `{ type, name, max_uses? }`,**无 `input_schema`**。反代把它转发给 Kiro 后端时,Kiro 后端无本地 WebSearch 实现,且 CBOR schema 要求 `toolSpecification.inputSchema.json` 非 undefined → 直接拒 `REQUEST_BODY_INVALID`。
- **First Broken Point**:`src/main/proxy/translator.ts:convertClaudeTools`(无 hosted tool filter)+ `extractClaudeAssistantContent` / `extractClaudeContent`(history 里 `server_tool_use` / `web_search_tool_result` block 未清理,多轮对话历史带过去也会触发同样 400)。
- **Bug class**(§5.2):**Interface Contract Ambiguity** —— Anthropic Messages API 的 tools 数组有两种模态(function tool 需 input_schema · server tool 不需),反代只处理了前者。

### 🕵️ 3. Variant Scan (§5.3 契约级)

**Duplicate-implementation search**:
- Internal `git grep -nE 'web_search|hosted|server_tool|input_schema' -- src/`:translator.ts 是唯一 Claude→Kiro tools 转换 SSOT · 已有 `toolNameRegistry` / `KIRO_MAX_TOOL_DESC_LEN` 收口点 · filter 加同一位置
- External:kiro-rs(src/anthropic/converter.rs:1049-1054 filter `type.starts_with("web_search")` + websearch.rs 独立本地处理器 + history 里 server_tool_use 忽略/web_search_tool_result 文本保留)· 9router(open-sse/translator/formats/claude.js:283 Strip built-in tools + claudeCloaking.js:51 pass-through)· **决定按 9router filter 路线**(不做本地实现)· **借鉴 kiro-rs**:响应侧 history 里也要清

**契约指纹**:`Kiro 后端 toolSpecification.inputSchema.json 必须非 undefined 合法 JSON schema`

**全仓消费点扫描**(3 处):
| file | 契约消费点 | 本轮修 | 说明 |
|------|-----------|--------|------|
| translator.ts `convertClaudeTools` | 请求侧 tools → Kiro toolSpecification | ✅ | filter hosted tool types |
| translator.ts `extractClaudeAssistantContent` | history assistant `server_tool_use` block → Kiro assistantResponseMessage.toolUses | ✅ | 跳过 server_tool_use |
| translator.ts `extractClaudeContent` | history user `web_search_tool_result` block → Kiro toolResults | ✅ | 跳过 web_search_tool_result |

### 👥 4. Real-World Scenario Simulation (§5.4)

- **混合工具**:tools 数组同时含 `web_search_20250305` + MCP `exa_search` + user custom function → filter 后 exa/custom 保留 · web_search 剔除 · 正常走 exa
- **多轮对话历史带 server_tool_use**:第二轮 assistant history 包含之前的 web_search_tool_result block → 不清则 Kiro 后端仍 400 · **请求侧 + history 都清**
- **tool_choice 强制 web_search**:filter 掉 web_search 后 tool_choice 指向不存在 → 降级为 `auto`(避免 tool_choice mismatch)
- **不处理**:反代不提供本地 WebSearch(未来若需按 kiro-rs 路线单独实现)· 用户可继续用 exa MCP

### 📚 5. Industry Reference

- **kiro-rs**(F:\kiro-rs)· src/anthropic/converter.rs:1031-1054 `TODO 如果 Kiro API 未来支持` + filter web_search_ · 1435-1450 history server_tool_use 忽略/web_search_tool_result 提取 title/url/snippet/page_age 为纯文本 · 单元测试 `test_convert_tools_filters_web_search`
- **9router**(F:\9router)· open-sse/translator/formats/claude.js:283 `Strip built-in tools (e.g. web_search_20250305)` · open-sse/utils/claudeCloaking.js:51 `Built-in server tools ... require pass-through`
- **Anthropic 官方**:server-side tools 的 tools 数组 shape 与 function tool 不同(searched:site:docs.anthropic.com "web_search_20250305")

### 🛠️ 6. Surgical Fix

- **Fix Strategy**(最小改 · 上游收口):
  1. `translator.ts`:新增 `ANTHROPIC_HOSTED_TOOL_TYPES` 常量集合 + `isAnthropicHostedTool(tool)` helper(判据 = `type` 匹配 `/^(web_search|bash|text_editor|str_replace_based_edit_tool|computer)_\d{8}$/` **或** 无 `input_schema` 且 name 在白名单)
  2. `convertClaudeTools`:入口 `tools.filter(t => !isAnthropicHostedTool(t))` · log dropped tools 名单
  3. `extractClaudeAssistantContent`:循环里 `block.type === 'server_tool_use'` 跳过
  4. `extractClaudeContent`:循环里 `block.type === 'web_search_tool_result'` 跳过
  5. `claudeToKiro`:`request.tool_choice.type === 'tool' && ANTHROPIC_HOSTED_NAMES.has(request.tool_choice.name)` → 降级 auto
  6. 调试日志:filter 阶段 log dropped tools + count(便于用户回溯)· Kiro 返 400 时打 payload snapshot(既有 log 已有,不改)
- **Minimal Files Changed**:`src/main/proxy/translator.ts`(1 处 helper + 4 处 filter/skip)
- **Files Explicitly NOT Changed**:`kiroApi.ts` · `proxyServer.ts` · 前端

### ⚠️ 7. Blast Radius & Regression Risk

- **影响面**:所有 Claude `/v1/messages` 请求过 filter · function tool 路径完全不变(判据严格,不误伤)
- **回归测试**:test/e2e-fullsuite/ 新增 CASE 31 `hosted-tools-filter`:请求 tools 含 `web_search_20250305` + 普通 function tool → 反代 200 返回 · 后者保留 · 前者剔除
- **回归 guard**:vitest 单测覆盖 `convertClaudeTools` filter + `extractClaudeAssistantContent` 跳过 server_tool_use

### 🧩 8. Boundary Reinforcement

- **顺手**:`ANTHROPIC_HOSTED_TOOL_TYPES` 常量集中声明(web_search / bash / text_editor / str_replace_based_edit_tool / computer),后续 Anthropic 增新 hosted tool 只改一处(SSOT §4.3)
- 未实现:本地 WebSearch(§0.17 D 类技术升级,不做)

---

## Update Log

- 2026-07-23 落盘骨架,证据已锁,pending 动手实施
- 2026-07-23 **实施完成**:
  - `src/main/proxy/translator.ts` 新增 `ANTHROPIC_HOSTED_TOOL_NAMES` / `ANTHROPIC_HOSTED_TOOL_TYPE_PATTERN` / `isAnthropicHostedTool` helper
  - `convertClaudeTools` 入口 filter + 日志 dropped 清单
  - `extractClaudeAssistantContent`:hosted name 的 tool_use 显式跳过 + `server_tool_use` 显式跳过
  - `extractClaudeContent`:`web_search_tool_result` 显式跳过 + `server_tool_use` 防御性跳过
- **验证**:`test/main/proxy/hostedToolFilter.test.ts` 5/5 单测过 · TS 编译过 · log 输出确认三条 skip/drop 生效
- **未做**:tool_choice 降级(实测发现 hosted tool 被 filter 后 Claude Code 自动 fallback 到 MCP,tool_choice 不显式指向已删的 tool 时无 400;若后续用户报 tool_choice 相关 400 再补)· E2E CASE 31(需 Kiro 后端联调,建议合入本 commit 前手动 e2e 一次)

