// Kiro Proxy 类型定义

// 挂起门闸超时收尾策略(SSOT 定义在 holdGate.ts,此处重新导出供 ProxyConfig 使用)
import type { HoldTimeoutAction } from './holdGate'
export type { HoldTimeoutAction }

// ============ OpenAI 兼容格式 ============
export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; function: { name: string } }
  response_format?: { type: string; json_schema?: unknown }
  conversation_id?: string
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max' | string
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'adaptive' } | { type: 'disabled' }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[]
  reasoning_content?: string
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  cache_control?: ClaudeCacheControl
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url' | 'file' | 'document'
  text?: string
  image_url?: { url: string; detail?: string }
  file?: { filename?: string; file_data?: string }
  source?: ClaudeDocumentSource
  name?: string
  cache_control?: ClaudeCacheControl
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
  cache_control?: ClaudeCacheControl
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChoice[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

export interface OpenAIChoice {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | null
}

export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Partial<OpenAIToolCall>[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }[]
}

export interface OpenAIResponsesRequest {
  model: string
  input: string | OpenAIResponseInputItem[]
  instructions?: string
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; name?: string; function?: { name: string } }
  previous_response_id?: string
  reasoning?: unknown
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
}

export interface OpenAIResponseInputItem {
  type?: 'message' | 'function_call' | 'function_call_output'
  role?: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIResponseContentPart[]
  call_id?: string
  name?: string
  arguments?: string
  output?: string
}

export interface OpenAIResponseContentPart {
  type: 'input_text' | 'output_text' | 'input_image' | 'input_file'
  text?: string
  image_url?: string
  file_data?: string
  filename?: string
}

export interface OpenAIResponsesResponse {
  id: string
  object: 'response'
  created_at: number
  model: string
  output: OpenAIResponseOutputItem[]
  previous_response_id?: string
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

export type OpenAIResponseOutputItem =
  | { type: 'message'; id: string; role: 'assistant'; content: { type: 'output_text'; text: string }[] }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }

// ============ Claude 兼容格式 ============
export interface ClaudeRequest {
  model: string
  messages: ClaudeMessage[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
  system?: string | ClaudeSystemBlock[]
  tools?: ClaudeTool[]
  tool_choice?: { type: string; name?: string }
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive'; display?: string } | { type: 'disabled' }
  conversation_id?: string
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
  anthropic_beta?: string[]
  output_config?: { effort?: string; task_budget?: { type: 'tokens'; total: number; remaining?: number } }
  context_management?: { type?: string; [key: string]: unknown }
}

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
  cache_control?: ClaudeCacheControl
}

export interface ClaudeSystemBlock {
  type: 'text'
  text: string
  cache_control?: ClaudeCacheControl
}

export interface ClaudeContentBlock {
  type: 'text' | 'image' | 'document' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking'
  text?: string
  thinking?: string
  signature?: string
  data?: string
  source?: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | ClaudeDocumentSource
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ClaudeContentBlock[]
  cache_control?: ClaudeCacheControl
}

export type ClaudeDocumentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'text'; media_type?: string; data: string }

export interface ClaudeTool {
  name: string
  description: string
  input_schema: unknown
  cache_control?: ClaudeCacheControl
}

export interface ClaudeCacheControl {
  type: string
}

export interface ClaudeResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ClaudeContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface ClaudeStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error'
  message?: Partial<ClaudeResponse>
  index?: number
  content_block?: ClaudeContentBlock
  delta?: { type: string; text?: string; thinking?: string; signature?: string; data?: string; reasoning_content?: string; stop_reason?: string; stop_sequence?: string }
  usage?: { input_tokens?: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  error?: { type: string; message: string }
}

// ============ Kiro API 格式 ============
export interface KiroPayload {
  conversationState: KiroConversationState
  profileArn?: string
  inferenceConfig?: KiroInferenceConfig
  additionalModelRequestFields?: Record<string, unknown>
}

export interface KiroConversationState {
  agentContinuationId?: string
  agentTaskType?: string
  chatTriggerType: 'MANUAL'
  conversationId: string
  currentMessage: KiroCurrentMessage
  history?: KiroHistoryMessage[]
}

export interface KiroCurrentMessage {
  userInputMessage: KiroUserInputMessage
}

export interface KiroUserInputMessage {
  content: string
  modelId?: string  // 可选，占位消息不需要
  origin: string
  images?: KiroImage[]
  documents?: KiroDocument[]
  cachePoint?: KiroCachePoint
  clientCacheConfig?: unknown
  userInputMessageContext?: KiroUserInputMessageContext
}

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface KiroDocument {
  format: string
  name: string
  source: { bytes: string }
}

export interface KiroUserInputMessageContext {
  toolResults?: KiroToolResult[]
  tools?: KiroToolWrapper[]
  editorState?: unknown
  shellState?: unknown
  gitState?: unknown
  envState?: unknown
  additionalContext?: unknown
}

export interface KiroToolResult {
  content: { text: string }[]
  status: 'success' | 'error'
  toolUseId: string
}

export type KiroToolWrapper = {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: unknown }
  }
} | {
  cachePoint: KiroCachePoint
}

export interface KiroHistoryMessage {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

export interface KiroAssistantResponseMessage {
  content: string
  cachePoint?: KiroCachePoint
  reasoningContent?: KiroReasoningContent
  toolUses?: KiroToolUse[]
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroInferenceConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
}

export interface KiroCachePoint {
  type: 'default'
}

export interface KiroReasoningContent {
  reasoningText?: {
    text: string
    signature?: string
  }
  redactedContent?: string
}

export interface KiroRequestContext {
  editorState?: unknown
  shellState?: unknown
  gitState?: unknown
  envState?: unknown
  additionalContext?: unknown
}

export interface KiroUsage {
  inputTokens: number
  outputTokens: number
  credits: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /**
   * 上游真实终止语义(2026-08-01 修 CONTENT_FILTERED 被伪装成 end_turn 致客户端静默断流)。
   *
   * 背景:Kiro 后端在 messageMetadataEvent/messageStopEvent 里给出真实 stopReason,
   * 实测分布含 END_TURN / TOOL_USE / **CONTENT_FILTERED**。此前反代完全不消费该字段,
   * 四条转发路径一律按 `hasToolCalls ? 'tool_use' : 'end_turn'` 本地推断 → 被内容过滤
   * 掐断的半截响应也被翻译成 end_turn("模型自然说完")→ 客户端不报错不重试,静默停止。
   *
   * disposition 用于让各转发路径判断"这轮能不能算正常收尾":
   * - complete    : 正常收尾(END_TURN / 无 stopReason)
   * - tool_use    : 工具调用收尾
   * - length      : 命中输出长度上限(MAX_TOKENS,无工具调用)
   * - filtered    : 内容被上游过滤器截断(CONTENT_FILTERED)→ 必须让客户端明确失败
   * - incomplete  : 其他非正常截断(CANCELLED / 上下文超限 / 未知 stopReason)
   */
  terminal?: {
    /** 上游原始 stopReason 字符串,原样保留供日志/诊断(如 'CONTENT_FILTERED') */
    upstreamStopReason?: string
    disposition: 'complete' | 'tool_use' | 'length' | 'filtered' | 'incomplete'
    /** 该 disposition 是否应让客户端明确失败(filtered/incomplete = true) */
    shouldFail: boolean
    /**
     * 本轮**一个字节的语义正文都没吐、也没有任何工具调用**。
     *
     * 这是「失败能否被透明重试」的唯一判据:零输出意味着客户端还没收到任何内容
     * (流式路径的 `message_start` 也是惰性发送、要等首个语义正文才发 —— 见
     * `proxyServer` ADR-0001 边界 1),所以重发不会造成内容重复或协议错乱;
     * 反之只要吐过一个字,重试就会让客户端看到重复输出。
     *
     * 由 `parseEventStream` 按实际累计的 outChars / 工具数填写,不由
     * `classifyKiroStopReason` 推断 —— 后者只做「stopReason → 处置」的映射,
     * 不该知道流里到底吐了多少东西(SSOT 分层)。
     */
    emptyOutput?: boolean
  }
  /** Context usage breakdown（来自后端 ContextUsageEvent） */
  contextUsage?: {
    percentage: number
    breakdown?: {
      conversation?: number
      mcpTools?: number
      steeringFiles?: number
    }
  }
}

// ============ 账号和代理配置 ============
export interface ProxyAccount {
  id: string
  email?: string
  accessToken: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp' | 'api_key'
  provider?: string
  profileArn?: string
  // external_idp (Azure AD 等外部 IdP) 专用：刷新走微软 tokenEndpoint
  tokenEndpoint?: string
  issuerUrl?: string
  scopes?: string
  expiresAt?: number
  machineId?: string  // 账户绑定的设备 ID（64位十六进制）
  /** 账号绑定的出口代理 URL（http/https）；为空则使用全局代理逻辑 */
  proxyUrl?: string
  /** 账号所属分组 ID；与 multiAccountSelectionMode='groups' + multiAccountGroupIds 配合做轮询分组过滤 */
  groupId?: string
  // 运行时状态
  lastUsed?: number
  requestCount?: number
  errorCount?: number
  isAvailable?: boolean
  cooldownUntil?: number
  // 配额追踪
  quotaUsed?: number
  quotaLimit?: number
  quotaExhaustedAt?: number // 配额耗尽时间戳
  quotaResetAt?: number // 下次配额重置时间
  /**
   * `quotaUsed/quotaLimit` 这份数据的**观测时刻**(上游响应到手的时间),不是写入时间。
   *
   * 用途是时序仲裁:`checkAccountStatus` 是并发的(singleFlight 只按 id 去重、跨轮次不保序),
   * 没有它时一个慢响应回来就能把新数字按回旧值。`updateQuota` 据此丢弃迟到的旧响应。
   * 兼作日志自证依据 —— 判「这个号额度耗尽」时能说出结论基于何时的数据。
   */
  quotaUpdatedAt?: number
  // 长期封禁追踪（区分于临时 errorCount 冷却）
  // Kiro 后端 TEMPORARILY_SUSPENDED / AccountSuspendedException 等风控触发时设置
  // 需要联系 AWS Support 人工解封，账号池会持续跳过直到 clearSuspended
  suspendedAt?: number       // 封禁时间戳
  suspendReason?: string     // 封禁原因 (如 'TEMPORARILY_SUSPENDED')
  suspendMessage?: string    // 封禁完整错误消息 (含联系链接)
  // ============ v1.7.6 新增: 权重 + 三态能力 ============
  /** 权重(整数,≥ 0,默认 100)。SWRR 加权轮询使用。0 = 临时下线(不参与选负但保留在池) */
  weight?: number
  /** per-model 能力标记。key = kiro modelId, value = 'confirmed'|'unsupported'。key 不存在 = unknown */
  modelCapabilities?: Record<string, 'confirmed' | 'unsupported'>
  /** ListAvailableModels 最后一次同步时间戳 (ms) */
  lastListModelsAt?: number
  /** 上次同步结果: 'ok' | 'failed' (用于陈旧警告) */
  lastListModelsStatus?: 'ok' | 'failed'
  /** 用户手工强制排除的 model(即便 API 报告支持),用于过滤 API 假信号 */
  excludedModels?: string[]
}

// API Key 格式类型
export type ApiKeyFormat = 'sk' | 'simple' | 'token'

// API Key 用量记录
export interface ApiKeyUsageRecord {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  credits: number
  path: string
}

// API Key 类型
export interface ApiKey {
  id: string
  name: string
  key: string
  format: ApiKeyFormat  // 密钥格式
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  // 额度限制
  creditsLimit?: number  // Credits 上限（undefined 表示无限制）
  // 用量统计
  usage: {
    totalRequests: number
    totalCredits: number
    totalInputTokens: number
    totalOutputTokens: number
    // 按日期统计（YYYY-MM-DD -> usage）
    daily: Record<string, {
      requests: number
      credits: number
      inputTokens: number
      outputTokens: number
    }>
    // 按模型统计
    byModel?: Record<string, {
      requests: number
      credits: number
      inputTokens: number
      outputTokens: number
    }>
  }
  // 用量历史记录（最近 100 条）
  usageHistory?: ApiKeyUsageRecord[]
}

// 模型映射规则
export interface ModelMappingRule {
  id: string
  name: string  // 规则名称
  enabled: boolean
  // 映射类型：replace(替换), alias(别名), loadbalance(负载均衡)
  type: 'replace' | 'alias' | 'loadbalance'
  // 源模型（用户请求的模型名，支持通配符 *）
  sourceModel: string
  // 目标模型列表（负载均衡时随机选择）
  targetModels: string[]
  // 负载均衡权重（可选，默认平均）
  weights?: number[]
  // 优先级（数字越小优先级越高）
  priority: number
  // 适用的 API Key ID 列表（空表示全局）
  apiKeyIds?: string[]
}

export interface ProxyConfig {
  enabled: boolean
  port: number
  host: string
  apiKey?: string  // 保留兼容性
  apiKeys?: ApiKey[]  // 多 API Key 支持
  enableMultiAccount: boolean
  selectedAccountIds: string[]
  logRequests: boolean
  logStreamEvents?: boolean
  maxConcurrent: number
  // 重试配置
  maxRetries?: number
  retryDelayMs?: number
  // 首选端点配置
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
  // Token 刷新提前量（秒）
  tokenRefreshBeforeExpiry?: number
  // TLS/HTTPS 配置
  tls?: TlsConfig
  // 自动启动
  autoStart?: boolean
  clientDrivenToolExecution?: boolean
  // 禁用工具调用（移除 tools 参数）
  disableTools?: boolean
  // v1.7.7 新增:是否往 system prompt 尾部注入中文 <execution_discipline> 纪律指令
  // - 默认 false(off)。此指令是 v1.4.3 引入的"防止 AI 目标漂移"辅助 · 但会:
  //   (a) 强命令口吻抑制模型深度思考/探索/澄清提问
  //   (b) 中英混合语言污染(客户端英文任务里可能冒中文短语)
  //   (c) 与 Claude Code / OpenCode 自带的执行纪律指令冲突
  // - 只有明确需要模型"闷头执行不废话"的场景才手动打开
  injectExecutionDirective?: boolean
  // Payload 大小限制（KB），超过时截断工具结果（byte 维度）
  payloadSizeLimitKB?: number
  // Token buffer reserve 开关（默认 false = 完全跳过 trimHistoryByTokens）
  // 关闭时后端不再裁剪任何旧消息，超出 context window 由 Kiro 后端原样返回错误
  enableTokenBufferReserve?: boolean
  // Token buffer reserve（仅在 enableTokenBufferReserve=true 时生效）
  // effective limit = model.maxInputTokens - buffer
  // 默认 20K：覆盖 system + tools + current message + output + 估算偏差
  tokenBufferReserve?: number
  // 单账号模式下额度耗尽自动切换到下一个账号
  autoSwitchOnQuotaExhausted?: boolean
  // 多账号选择策略 (仅 enableMultiAccount=true 时生效)
  // - round-robin: 每次请求成功后切到下一个账号 (默认, 负载均衡)
  // - sticky: 一个账号成功就粘住, 直到失败才切换 (保留 prompt cache, 牺牲均衡)
  // - weighted: SWRR 加权轮询 (按账号 weight 字段按比例分流,箭紧行业同款算法)
  accountSelectionStrategy?: 'round-robin' | 'sticky' | 'weighted'
  // 多账号轮询范围 (仅 enableMultiAccount=true 时生效)
  // - 'all': 使用所有 active 账号（默认）
  // - 'groups': 仅使用 multiAccountGroupIds 选中分组的账号；可包含特殊值 '__ungrouped__' 表示未分组账号
  multiAccountSelectionMode?: 'all' | 'groups'
  multiAccountGroupIds?: string[]
  // 模型映射规则
  modelMappings?: ModelMappingRule[]

  // ============ 安全 / 限流 / 可观测（v1.8 新增） ============
  /** 入站请求体最大字节数（默认 10MB）。超过返回 413 */
  maxRequestBodyBytes?: number
  /** 允许访问的客户端 IP 列表（CIDR 或单 IP）；空数组或未设 = 不限制 */
  allowedIPs?: string[]
  /** 拒绝访问的客户端 IP 列表（CIDR 或单 IP）；优先级高于 allowedIPs */
  deniedIPs?: string[]
  /** 当绑定 host 是 0.0.0.0/外网接口时，是否允许无 API Key 启动（默认 false 拒绝） */
  allowExternalWithoutApiKey?: boolean
  /** 按 API Key（或匿名时按 IP）的请求频率限制：每分钟最大请求数。0=不限制 */
  rateLimitPerKeyPerMinute?: number
  /** 客户端会话粘性：true 时同一 session hint 总路由到同一账号子集 */
  sessionAffinityEnabled?: boolean
  /** keep-alive 连接空闲超时（毫秒），默认 65s */
  keepAliveTimeoutMs?: number
  /** request headers 接收超时（毫秒），默认 60s */
  headersTimeoutMs?: number
  /** recentRequests 保留条数（默认 100，最多 10000） */
  recentRequestsLimit?: number
  /** 是否暴露 /metrics（Prometheus 文本格式） */
  enableMetrics?: boolean
  /**
   * P2-21 API Key 与账号的精细绑定：apiKey id → 允许使用的账号 ID 数组（白名单）
   * 未配置或空数组 = 该 API Key 可使用所有账号；
   * 兼容旧名 apiKeyGroupBindings（按 group 绑定，需配合 group 同步）
   */
  apiKeyAccountBindings?: Record<string, string[]>
  /** @deprecated 改用 apiKeyAccountBindings；保留以兼容老配置 */
  apiKeyGroupBindings?: Record<string, string[]>
  /** HTTP + HTTPS 双端口：启用 TLS 时，仍同时监听 HTTP 端口在 fallbackPort */
  fallbackPort?: number
  /** 启用审计日志（管理 API 操作、config 变更） */
  enableAuditLog?: boolean

  // ============ Agent 模式 + Steering（v1.7.5 新增） ============
  /** Agent 模式：vibe（对话优先）或 spec（计划优先）。默认 vibe */
  agentMode?: 'vibe' | 'spec'
  /** 工作区路径：用于读取 .kiro/steering/*.md 规则文件注入到 system prompt */
  workspacePath?: string

  // ============ v1.7.6 新增: 能力路由 ============
  /** 能力路由总开关(默认 false,升级零行为变化) */
  enableModelCapabilityRouting?: boolean
  /** 能力未知时策略:
   * - strict: 直接 400 "no account confirmed to support X"
   * - probe-once: 从 unknown 中挑一个试探,成功升 confirmed / 失败降 unsupported
   * 默认 'strict' */
  capabilityUnknownPolicy?: 'strict' | 'probe-once'
  /** 能力同步周期(ms,默认 3600000 = 1h)。fetchKiroModels 后台同步间隔 */
  modelCapabilitySyncIntervalMs?: number

  // ============ v1.7.6 新增: 429 rate limit 重试策略(Kiro 后端概率式限流) ============
  /** 每端点 429 最大重试次数,默认 8(区间 1-50) */
  rateLimitRetryMaxAttempts?: number
  /** 基础 backoff 毫秒,默认 400ms(区间 50-10000) */
  rateLimitRetryBaseMs?: number
  /**
   * 重试 backoff 策略:
   * - fast(默认): 固定 baseMs + ±25% jitter,密集打向概率限流窗口
   * - linear: baseMs, baseMs*2, baseMs*3 ...(封顶 5s)
   * - exponential: baseMs, baseMs*2, baseMs*4 ...(封顶 15s,旧默认行为)
   */
  rateLimitRetryStrategy?: 'fast' | 'linear' | 'exponential'

  // ============ 挂起门闸(Hold Gate · 无可用账号时冻结请求)============
  // 方案:.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §3
  // 校验(clamp)收口在 proxyServer.normalizeHoldConfig,非有限值/越界一律回落默认并 warn
  /** 挂起门闸总开关(默认 false,关闭时零行为变化) */
  holdWhenNoAccount?: boolean
  /** 挂起期间 SSE ping 心跳间隔 ms(默认 10000;clamp [1000,40000],<45s watchdog) */
  holdPingIntervalMs?: number
  /** 兜底轮询周期 ms(默认 600000=10min;clamp [10000,21600000] 且 ≤ holdTotalBudgetMs)。
   *  注意:这不是单请求挂起上限 —— 上限由 holdTotalBudgetMs 定;本值是「多久没被事件唤醒就主动复查一次池」。 */
  holdMaxWaitMs?: number
  /** 从 RECEIVED 起的绝对 deadline ms(默认 1680000=28min;clamp [10000,21600000]=最长 6h)。
   *  实测 2026-08-06:真实可挂时长由客户端 API_TIMEOUT_MS + idle watchdog(~5min 无正文即重连)共同决定,非本值;
   *  生产实证曾挂 4172s(69.5min)后成功放行续接。详见 holdConfig.ts BUDGET_MAX 注释。 */
  holdTotalBudgetMs?: number
  /** deadline 剩余不足此值即触发超时收尾 ms(默认 15000;clamp [1000,60000] 且 < holdTotalBudgetMs) */
  holdGraceMs?: number
  /** 触及绝对 deadline 时的收尾策略(默认 keep_blocking 持续卡住) */
  holdTimeoutAction?: HoldTimeoutAction
  /** 池出现可用号时自动放行(默认 true) */
  holdAutoResumeOnAvailable?: boolean
  /** 自动定时放行开关(默认 true)。开启后即使池仍无可用号,也会按间隔周期性放行挂起请求 ——
   *  放行本身就是目的:它产生客户端可见的流活动,重置客户端 idle watchdog 的 ~10min 计时
   *  (用户 2026-08-09 实测确立:受限状态下手动点放行即重置该窗口)。ping 心跳做不到这件事。
   *  注意仅在 holdWhenNoAccount 开启时有对象可放;且 holdTimeoutAction 非 keep_blocking 时,
   *  预算到点条目已被认领移出集合 → 自动放行到点认领不到,循环终止。 */
  holdAutoReleaseEnabled?: boolean
  /** 自动定时放行间隔 ms(默认 480000=8min;clamp [60000, holdTotalBudgetMs])。
   *  下限 60s:每轮放行都真发一次上游请求,过短会加深 429 误标风险。
   *  8min 而非客户端 10min 极限:留 120s 余量吸收上游首字节延迟。详见 holdConfig.ts 常量段。 */
  holdAutoReleaseIntervalMs?: number
}

export interface TlsConfig {
  enabled: boolean
  certPath?: string // 证书文件路径
  keyPath?: string // 私钥文件路径
  // 或直接提供 PEM 内容
  cert?: string
  key?: string
}

// Token 刷新回调类型
export type TokenRefreshCallback = (account: ProxyAccount) => Promise<{
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  error?: string
}>

export interface ProxyStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalTokens: number
  totalCredits: number // 累计总 credits（所有请求）
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  startTime: number
  accountStats: Map<string, AccountStats>
  // 按端点统计
  endpointStats: Map<string, EndpointStats>
  // 按模型统计
  modelStats: Map<string, ModelStats>
  // 最近请求日志
  recentRequests: RequestLog[]
}

export interface AccountStats {
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
  errors: number
  lastUsed: number
  avgResponseTime: number
  totalResponseTime: number
}

export interface EndpointStats {
  name: string
  requests: number
  successes: number
  failures: number
  quotaErrors: number
}

export interface ModelStats {
  model: string
  requests: number
  tokens: number
}

export interface RequestLog {
  timestamp: number
  path: string
  model: string
  accountId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  credits?: number // Kiro API 返回的 credit 使用量
  responseTime: number
  success: boolean
  error?: string
}

// ============ Event Stream 解析 ============
export interface KiroEventStreamMessage {
  type: string
  payload: unknown
}

export interface KiroAssistantResponseEvent {
  content?: string
  toolUse?: KiroToolUse
}

export interface KiroUsageEvent {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}


// ============ 会话级用量历史（每次 启动→停止 归档一条） ============
export interface ProxySessionRecord {
  id: string
  startTime: number        // 会话开始（服务启动）时间戳
  endTime: number          // 会话结束（服务停止）时间戳
  durationMs: number       // 会话时长（毫秒）
  totalRequests: number
  successRequests: number
  failedRequests: number
  credits: number          // 本次会话消耗的 credits
  inputTokens: number
  outputTokens: number
}
