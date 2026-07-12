// Kiro API 调用核心模块
import { v4 as uuidv4 } from 'uuid'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Dispatcher } from 'undici'
import type {
  KiroPayload,
  KiroUserInputMessage,
  KiroHistoryMessage,
  KiroToolWrapper,
  KiroToolResult,
  KiroImage,
  KiroDocument,
  KiroToolUse,
  KiroCachePoint,
  KiroRequestContext,
  KiroUsage,
  ProxyAccount
} from './types'
import { proxyLogger } from './logger'
import { getKProxyService } from '../kproxy'
import { getSystemProxy, safeCreateProxyAgent } from './systemProxy'
import {
  countTokens,
  getModelContextLength,
  setModelContextWindow,
  getModelContextWindow
} from './tokenCounter'
// 重新导出以保持向后兼容（proxyServer.ts 等模块仍 from './kiroApi' 导入）
export { setModelContextWindow, getModelContextWindow }

// 是否使用 K-Proxy 代理发送 API 请求（从主进程导入）
let useKProxyForApi = false
let logStreamEvents = false

export function setUseKProxyForApiInProxy(enabled: boolean): void {
  useKProxyForApi = enabled
}

// profileArn 自愈持久化回调：当 Enterprise 账号在运行时首次解析出真实 profileArn 时，
// 通过该回调通知主进程回写到 renderer store + 磁盘，避免每次请求都重新获取。
type ProfileArnPersistCallback = (accountId: string, profileArn: string) => void
let profileArnPersistCallback: ProfileArnPersistCallback | undefined
export function setProfileArnPersistCallback(cb: ProfileArnPersistCallback | undefined): void {
  profileArnPersistCallback = cb
}

export function setLogStreamEvents(enabled: boolean): void {
  logStreamEvents = enabled
}

// Payload 大小限制（KB），用户可在高级设置中调整
let payloadSizeLimitKB = 153600 // 默认 150MB（支持大图片）
export function setPayloadSizeLimitKB(limitKB: number): void {
  payloadSizeLimitKB = Math.max(256, Math.min(204800, limitKB))
}

// Token buffer reserve 开关（默认 false = 完全跳过 trimHistoryByTokens）
// 关闭时后端不再裁剪任何旧消息，超出 context window 由 Kiro 后端原样返回错误
let enableTokenBufferReserve = false
export function setEnableTokenBufferReserve(enabled: boolean): void {
  enableTokenBufferReserve = !!enabled
}
export function getEnableTokenBufferReserve(): boolean {
  return enableTokenBufferReserve
}

// Token buffer reserve（仅在 enableTokenBufferReserve=true 时生效）
// 为 model context window 预留的余量，覆盖 system + tools + current + output + 估算偏差 + schema 开销
// 默认 20K：开关启用后的合理初始值（200K → effective 180K, 1M → effective 980K）
let tokenBufferReserve = 20000
export function setTokenBufferReserve(tokens: number): void {
  tokenBufferReserve = Math.max(5000, Math.min(150000, tokens))
}
export function getTokenBufferReserve(): number {
  return tokenBufferReserve
}

// 根据 modelId 和 buffer 计算 effective token limit
// 仅在 enableTokenBufferReserve=true 时被调用
// 查不到 model 时 fallback 到 200K context (Claude 默认)
function getEffectiveTokenLimit(modelId?: string): number {
  // 复用 getModelContextLength（支持 cache 命中 → 模糊匹配 → 关键词兜底）
  const ctx = modelId ? getModelContextLength(modelId) : 200000
  return Math.max(8000, ctx - tokenBufferReserve)
}

// Token 估算 (UTF-8 字节数 / 3.5，对中英混合场景做安全偏保守估算)
// 比真实 cl100k_base tokenizer 略偏高 (10-20%), 用于触发裁剪阈值是安全的
function estimateTokensFromString(str: string): number {
  return Math.ceil(Buffer.byteLength(str, 'utf-8') / 3.5)
}

function estimatePayloadTokens(payload: KiroPayload): number {
  return estimateTokensFromString(JSON.stringify(payload))
}

/**
 * 获取网络代理 agent
 * 优先级（从高到低）：
 *   1. 账号自身绑定的 proxyUrl（实现"N 个号一个 IP"分桶反代）
 *   2. K-Proxy（如果启用）
 *   3. 环境变量代理
 *   4. 系统代理
 *
 * 传入 account 让账号级代理覆盖全局；不传则走全局逻辑。
 */
function getNetworkAgent(account?: ProxyAccount): Dispatcher | undefined {
  // 1. 账号专属代理：实现"N 个账号共用 1 个 IP"的分桶反代
  if (account?.proxyUrl) {
    const agent = safeCreateProxyAgent(account.proxyUrl)
    if (agent) {
      proxyLogger.debug('KiroAPI', `Using account-bound proxy for ${account.email || account.id}`)
      return agent
    }
  }
  // 2. K-Proxy
  if (useKProxyForApi) {
    const kproxyService = getKProxyService()
    if (kproxyService?.isRunning()) {
      const config = kproxyService.getConfig()
      const proxyUrl = `http://${config.host}:${config.port}`
      const agent = safeCreateProxyAgent(proxyUrl)
      if (agent) return agent
    }
  }
  // 3. 环境变量
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const envAgent = safeCreateProxyAgent(envProxy)
  if (envAgent) return envAgent
  // 4. 系统代理
  return safeCreateProxyAgent(getSystemProxy())
}

/**
 * 使用代理的 fetch 函数
 * 传入 account 时会优先使用账号绑定的代理（账号-代理 N:1 分桶）
 */
async function fetchWithProxy(url: string, options: RequestInit, account?: ProxyAccount): Promise<Response> {
  const agent = getNetworkAgent(account)
  if (agent) {
    proxyLogger.debug('KiroAPI', `Using proxy agent: ${agent.constructor.name}`)
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// ============ Kiro API 端点 SSOT(2026-07 迁移)============
//
// AWS 把 Kiro 从 CodeWhisperer/Amazon Q 拆离到独立域名 + 新命名空间。
// - Stream (GenerateAssistantResponse):runtime.{region}.kiro.dev(V2) / 旧 host(V1 fallback,仅 us 短期兼容)
// - Management (ListProfiles/Models/Subscriptions/Preferences):management.us-east-1.kiro.dev(V2 全局)
// - X-Amz-Target 前缀:AmazonCodeWhispererStreamingService.* → KiroRuntimeService.*
// - TokenType header:所有 IdC/BuilderId/social 统一 SSO_OIDC(仅真 Azure external_idp 保留 EXTERNAL_IDP)
// 详见 .agent-workspace/.archive/2026-07-12/kiro-endpoint-migration/*-rca.md

/** V2 Kiro Runtime host(stream API,按 region 分发)*/
function getKiroRuntimeHost(region?: string): string {
  const r = region?.startsWith('eu-') ? 'eu-central-1' : 'us-east-1'
  return `https://runtime.${r}.kiro.dev`
}
void getKiroRuntimeHost // 内部保留,当前未直接引用(KIRO_ENDPOINTS 数组已 hardcode 两个 region V2 URL)

/** V2 Kiro Management host(元数据 API,per-region 分发)
 * 2026-07-12 实测证据:eu 账户 → management.eu-central-1.kiro.dev 返 200 拿 13 个模型;
 *                          us 账户 → management.us-east-1.kiro.dev 返 200 拿 15 个模型。
 * eu 账户发到 us-east-1 host 会 403 Invalid token(cross-region auth 拒)。
 */
function getKiroManagementHost(region?: string): string {
  const r = region?.startsWith('eu-') ? 'eu-central-1' : 'us-east-1'
  return `https://management.${r}.kiro.dev`
}

const TOKEN_TYPE_SSO_OIDC = 'SSO_OIDC'
const TOKEN_TYPE_EXTERNAL_IDP = 'EXTERNAL_IDP'

/**
 * 根据账户类型返回 TokenType header 值(2026-07 迁移后)
 * - external_idp / ExternalIdp(真 Azure AD): EXTERNAL_IDP
 * - 其它所有(IdC / BuilderId / Github / Google): SSO_OIDC
 * 抓包证据:官方 Kiro IDE 1.0.116 stream + management API 请求全带 TokenType: SSO_OIDC
 */
function getTokenTypeHeader(account: ProxyAccount): string {
  if (account.authMethod === 'external_idp' || account.provider === 'ExternalIdp') {
    return TOKEN_TYPE_EXTERNAL_IDP
  }
  return TOKEN_TYPE_SSO_OIDC
}

// Kiro API 端点配置(V2 优先 + V1 fallback)
const KIRO_ENDPOINTS = [
  // ============ V2 端点(2026-07 迁移后主端点)============
  // 抓包证据:官方 Kiro IDE 1.0.116 stream 请求
  //   POST https://runtime.{region}.kiro.dev/(根路径)
  //   Content-Type: application/x-amz-json-1.0
  //   X-Amz-Target: KiroRuntimeService.GenerateAssistantResponse
  //   TokenType: SSO_OIDC
  {
    url: 'https://runtime.us-east-1.kiro.dev/',
    origin: 'AI_EDITOR',
    amzTarget: 'KiroRuntimeService.GenerateAssistantResponse',
    name: 'KiroRuntime-US',
    protocol: 'generateAssistantResponse' as const
  },
  {
    url: 'https://runtime.eu-central-1.kiro.dev/',
    origin: 'AI_EDITOR',
    amzTarget: 'KiroRuntimeService.GenerateAssistantResponse',
    name: 'KiroRuntime-EU',
    protocol: 'generateAssistantResponse' as const
  },
  // ============ V1 端点(旧,保留作 fallback,eu 侧已停服 · us 侧 grace period)============
  {
    url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR',
    amzTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    name: 'CodeWhisperer',
    protocol: 'generateAssistantResponse' as const
  },
  {
    url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR',
    amzTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    name: 'AmazonQ',
    protocol: 'generateAssistantResponse' as const
  },
  {
    url: 'https://q.us-east-1.amazonaws.com/SendMessageStreaming',
    origin: 'CLI',
    amzTarget: 'AmazonQDeveloperStreamingService.SendMessage',
    name: 'AmazonQCLI'
  }
]

// Kiro 版本号(2026-07 迁移:对齐官方 IDE 1.0.116 抓包证据)
// V2 host 严格校验 UA,旧值(0.12.155 / codewhispererstreaming#1.0.34 / m/E)会报
// misleading “bearer token invalid”。V1 endpoint 不严格校验 UA,新值也接受。
const KIRO_VERSION = '1.0.116'
const AWS_SDK_VERSION = '1.0.0'
const AWS_STREAMING_API_VERSION = '1.0.0'

const OS_PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'macos' : 'linux'
const OS_RELEASE = (() => { try { return require('os').release() } catch { return '10.0.0' } })()
const NODE_VERSION = process.versions.node || '22.22.0'

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  // 2026-07 迁移:UA API 段 codewhispererstreaming → kiroruntime, m/E → m/N(拓包证据)
  return `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${OS_PLATFORM}#${OS_RELEASE} lang/js md/nodejs#${NODE_VERSION} api/kiroruntime#${AWS_STREAMING_API_VERSION} m/N ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  // 2026-07 迁移:suffix 用短横分隔(与主 UA 一致),不再用空格
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/${AWS_SDK_VERSION} ${suffix}`
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const KIRO_CLI_OS = OS_PLATFORM === 'win32' ? 'windows' : OS_PLATFORM === 'macos' ? 'macos' : 'linux'
void KIRO_CLI_OS // reserved for future kiro-cli UA

// Agent 模式（可通过 setAgentMode 配置切换）
let configuredAgentMode: 'vibe' | 'spec' = 'vibe'
export function setAgentMode(mode: 'vibe' | 'spec'): void {
  configuredAgentMode = mode
}
export function getAgentMode(): 'vibe' | 'spec' {
  return configuredAgentMode
}

// profileArn 决策中心已迁移到 ../kiroAuthSync，反代和账号管理器主进程共用同一份定义，
// 防止多处常量漂移。注意 KIRO_BUILDER_ID_PLACEHOLDER_ARN 仍以本模块为出口 re-export，
// 这样 main/index.ts 等老 import 路径不需要改。
import {
  KIRO_BUILDER_ID_PLACEHOLDER_ARN as _KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_SOCIAL_PROFILE_ARN,
  isPlaceholderProfileArn as _isPlaceholderProfileArn,
  getEnterpriseFallbackArn
} from '../kiroAuthSync'

export const KIRO_BUILDER_ID_PLACEHOLDER_ARN = _KIRO_BUILDER_ID_PLACEHOLDER_ARN
export const isPlaceholderProfileArn = _isPlaceholderProfileArn

/**
 * 反代调 Kiro API 时使用的 profileArn 决策。
 * 优先级：真实 ARN（自动获取） > 备用固定 ARN（按账号类型）
 * - 已有真实 ARN（非占位符） → 直接用
 * - Enterprise/IdC → 区域化备用 ARN（自动获取失败时兜底）
 * - Social（Github/Google） → 固定 social ARN
 * - BuilderId → 占位符 ARN
 */
function resolveProfileArn(account: ProxyAccount): string | undefined {
  if (account.profileArn && !isPlaceholderProfileArn(account.profileArn)) {
    return account.profileArn
  }
  if (account.provider === 'Enterprise' || account.authMethod === 'external_idp') {
    return getEnterpriseFallbackArn(account.region)
  }
  if (account.authMethod === 'social' || account.provider === 'Github' || account.provider === 'Google') {
    return KIRO_SOCIAL_PROFILE_ARN
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

// 兼容 SDK 部分调用仍想知道社交 ARN 的场景（极少；保留 export 不破坏外部 import）
export { KIRO_SOCIAL_PROFILE_ARN }

// Agentic 模式系统提示 - 防止大文件写入超时
const AGENTIC_SYSTEM_PROMPT = `# CRITICAL: CHUNKED WRITE PROTOCOL (MANDATORY)

You MUST follow these rules for ALL file operations. Violation causes server timeouts and task failure.

## ABSOLUTE LIMITS
- **MAXIMUM 350 LINES** per single write/edit operation - NO EXCEPTIONS
- **RECOMMENDED 300 LINES** or less for optimal performance
- **NEVER** write entire files in one operation if >300 lines

## MANDATORY CHUNKED WRITE STRATEGY

### For NEW FILES (>300 lines total):
1. FIRST: Write initial chunk (first 250-300 lines) using write_to_file/fsWrite
2. THEN: Append remaining content in 250-300 line chunks using file append operations
3. REPEAT: Continue appending until complete

### For EDITING EXISTING FILES:
1. Use surgical edits (apply_diff/targeted edits) - change ONLY what's needed
2. NEVER rewrite entire files - use incremental modifications
3. Split large refactors into multiple small, focused edits

REMEMBER: When in doubt, write LESS per operation. Multiple small operations > one large operation.`

// Thinking 模式标签
const THINKING_MODE_PROMPT = `<thinking_mode>enabled</thinking_mode>
<max_thinking_length>200000</max_thinking_length>`

const CODEWHISPERER_DEFAULT_MODEL_ID = 'CLAUDE_SONNET_4_20250514_V1_0'
const CODEWHISPERER_MODEL_CACHE_TTL = 5 * 60 * 1000

const codeWhispererModelCache = new Map<string, { models: KiroModel[]; timestamp: number }>()

// 模型 ID 映射
const MODEL_ID_MAP: Record<string, string> = {
  // Claude 4.5 系列
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4.5': 'claude-sonnet-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4.5': 'claude-haiku-4.5',
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4.5': 'claude-opus-4.5',
  // Claude 4 系列
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-sonnet-4-20250514': 'claude-sonnet-4',
  // Claude 3.5 系列 (映射到 Sonnet 4.5)
  'claude-3-5-sonnet': 'claude-sonnet-4.5',
  'claude-3-opus': 'claude-sonnet-4.5',
  'claude-3-sonnet': 'claude-sonnet-4',
  'claude-3-haiku': 'claude-haiku-4.5',
  // GPT 兼容映射 (映射到 Sonnet 4.5)
  'gpt-4': 'claude-sonnet-4.5',
  'gpt-4o': 'claude-sonnet-4.5',
  'gpt-4-turbo': 'claude-sonnet-4.5',
  'gpt-3.5-turbo': 'claude-sonnet-4.5',
  'default': 'claude-sonnet-4.5'
}

/**
 * 归一化 Claude 版本号：把版本号里的短横线转成点号。
 *
 * 背景：部分客户端（如 Claude Code）不允许模型名里出现 "."，会把 "claude-opus-4.6"
 * 写成 "claude-opus-4-6"，若原样透传给 Kiro 会被解析成 "claude-opus-4"（丢掉 minor），
 * 导致 1M 上下文等特性设置失败。这里把 claude-{family}-{major}-{minor} 的最后一段
 * 版本短横转成点号，兼容未来任意新版本（4.6 / 4.7 / 5.0 ...）。
 *
 * 仅当 minor 是 1~2 位数字且其后不是更多数字时才转换，避免误伤日期快照后缀
 * （如 claude-sonnet-4-20250514 不会被改）。
 */
function normalizeClaudeVersion(modelId: string): string {
  return modelId.replace(
    /^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/i,
    '$1-$2.$3'
  )
}

export function mapModelId(model: string): string {
  let modelId = model.trim()
  if (!modelId) return MODEL_ID_MAP.default
  if (isCodeWhispererModelId(modelId)) return modelId
  // 0) 归一化版本号短横 → 点号（claude-opus-4-6 → claude-opus-4.6），兼容不支持 "." 的客户端
  modelId = normalizeClaudeVersion(modelId)
  const lower = modelId.toLowerCase()
  // 1) 显式 alias 映射优先
  if (MODEL_ID_MAP[lower]) return MODEL_ID_MAP[lower]
  // 2) 看似 Kiro 支持的 Claude 模型格式 (claude-{sonnet|haiku|opus}-{ver})，原样透传
  //    用于向前兼容尚未加入 MODEL_ID_MAP 的新发布模型
  if (/^claude-(sonnet|haiku|opus)-/.test(lower)) return modelId
  // 3) 完全未知的 model（用户拼错/不存在），兜底到 default 避免直接 400
  console.warn(`[Kiro API] Unknown model "${modelId}" → fallback to "${MODEL_ID_MAP.default}"`)
  return MODEL_ID_MAP.default
}

function clonePayload(payload: KiroPayload): KiroPayload {
  return JSON.parse(JSON.stringify(payload)) as KiroPayload
}

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function modelTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function matchesRequestedModel(model: KiroModel, requestedModelId: string): boolean {
  // 1. modelId 级精确匹配（去除符号后比较）
  const requestedKey = normalizeModelKey(requestedModelId)
  const modelIdKey = normalizeModelKey(model.modelId)
  if (modelIdKey === requestedKey || modelIdKey.includes(requestedKey)) return true
  // 2. modelName 精确匹配
  if (model.modelName && normalizeModelKey(model.modelName).includes(requestedKey)) return true
  // 3. token 匹配（所有请求 token 必须在 modelId+modelName 中命中，不搜索 description 避免误匹配）
  const tokens = modelTokens(requestedModelId).filter(token => token !== 'latest' && token !== 'model')
  if (tokens.length === 0) return false
  const candidateTokens = new Set(modelTokens(`${model.modelId} ${model.modelName || ''}`))
  // 必须全部 token 命中
  if (!tokens.every(token => candidateTokens.has(token))) return false
  // 防止模型家族冲突：如果请求包含 opus/sonnet/haiku，候选必须也包含对应的
  const families = ['opus', 'sonnet', 'haiku']
  for (const family of families) {
    if (tokens.includes(family) && !candidateTokens.has(family)) return false
    if (!tokens.includes(family) && candidateTokens.has(family)) return false
  }
  return true
}

function isCodeWhispererModelId(modelId: string): boolean {
  return /^[A-Z0-9_]+$/.test(modelId) && modelId.includes('_')
}

function getModelCacheKey(account: ProxyAccount): string {
  return `${account.id}:${account.region || 'us-east-1'}:${resolveProfileArn(account) ?? 'no-arn'}`
}

async function getCachedCodeWhispererModels(account: ProxyAccount, signal?: AbortSignal): Promise<KiroModel[]> {
  const key = getModelCacheKey(account)
  const cached = codeWhispererModelCache.get(key)
  if (cached && Date.now() - cached.timestamp < CODEWHISPERER_MODEL_CACHE_TTL) return cached.models
  const models = await fetchKiroModels(account, signal)
  codeWhispererModelCache.set(key, { models, timestamp: Date.now() })
  return models
}

async function resolveCodeWhispererModelId(account: ProxyAccount, requestedModelId?: string, signal?: AbortSignal): Promise<string> {
  const modelId = requestedModelId?.trim()
  if (!modelId) return CODEWHISPERER_DEFAULT_MODEL_ID
  if (isCodeWhispererModelId(modelId)) return modelId
  const models = await getCachedCodeWhispererModels(account, signal)
  return models.find(model => matchesRequestedModel(model, modelId))?.modelId || CODEWHISPERER_DEFAULT_MODEL_ID
}

function getPayloadModelId(payload: KiroPayload): string | undefined {
  const currentModelId = payload.conversationState.currentMessage.userInputMessage.modelId
  if (currentModelId) return currentModelId
  return payload.conversationState.history?.find(message => message.userInputMessage?.modelId)?.userInputMessage?.modelId
}

function applyPayloadModelId(payload: KiroPayload, modelId: string): void {
  payload.conversationState.currentMessage.userInputMessage.modelId = modelId
  for (const message of payload.conversationState.history ?? []) {
    if (message.userInputMessage) message.userInputMessage.modelId = modelId
  }
}

function applyPayloadOrigin(payload: KiroPayload, origin: string): void {
  payload.conversationState.currentMessage.userInputMessage.origin = origin
  for (const message of payload.conversationState.history ?? []) {
    if (message.userInputMessage) message.userInputMessage.origin = origin
  }
}

// 检测是否为 Agentic 模式请求
export function isAgenticRequest(model: string, tools?: unknown[]): boolean {
  const lower = model.toLowerCase()
  // 模型名称包含 -agentic 或有工具调用
  return lower.includes('-agentic') || lower.includes('agentic') || Boolean(tools && tools.length > 0)
}

// 检测是否启用 Thinking 模式
export function isThinkingEnabled(headers?: Record<string, string>): boolean {
  if (!headers) return false
  // 检查 Anthropic-Beta 头是否包含 thinking
  const betaHeader = headers['anthropic-beta'] || headers['Anthropic-Beta'] || ''
  return betaHeader.toLowerCase().includes('thinking')
}

// 注入系统提示
export function injectSystemPrompts(
  content: string,
  isAgentic: boolean,
  thinkingEnabled: boolean
): string {
  let result = content
  
  // 注入时间戳
  const timestamp = new Date().toISOString()
  const timestampPrompt = `Current time: ${timestamp}`
  
  // 注入 Thinking 模式（必须在最前面）
  if (thinkingEnabled) {
    result = THINKING_MODE_PROMPT + '\n\n' + result
  }
  
  // 注入 Agentic 模式提示
  if (isAgentic) {
    result = result + '\n\n' + AGENTIC_SYSTEM_PROMPT
  }
  
  // 注入时间戳
  result = timestampPrompt + '\n\n' + result
  
  return result
}

// ============= 消息清理逻辑（参考 Kiro 官方实现）=============

// 占位消息
const HELLO_MESSAGE: KiroHistoryMessage = {
  userInputMessage: { content: 'Hello', origin: 'AI_EDITOR' }
}

const CONTINUE_MESSAGE: KiroHistoryMessage = {
  userInputMessage: { content: 'Continue', origin: 'AI_EDITOR' }
}

const UNDERSTOOD_MESSAGE: KiroHistoryMessage = {
  assistantResponseMessage: { content: 'understood' }
}

// 创建失败的工具结果消息
function createFailedToolUseMessage(toolUseIds: string[]): KiroHistoryMessage {
  return {
    userInputMessage: {
      content: '',
      origin: 'AI_EDITOR',
      userInputMessageContext: {
        toolResults: toolUseIds.map(createFailedToolResult)
      }
    }
  }
}

// 类型检查函数
function isUserInputMessage(message: KiroHistoryMessage): boolean {
  return message != null && 'userInputMessage' in message && message.userInputMessage != null
}

function isAssistantResponseMessage(message: KiroHistoryMessage): boolean {
  return message != null && 'assistantResponseMessage' in message && message.assistantResponseMessage != null
}

function hasToolResults(message: KiroHistoryMessage): boolean {
  return !!(message.userInputMessage?.userInputMessageContext?.toolResults?.length)
}

function hasToolUses(message: KiroHistoryMessage): boolean {
  return !!(message.assistantResponseMessage?.toolUses?.length)
}

function hasMatchingToolResults(
  toolUses: KiroToolUse[] | undefined,
  toolResults: KiroToolResult[] | undefined
): boolean {
  if (!toolUses || !toolUses.length) return true
  if (!toolResults || !toolResults.length) return false
  
  const allToolUsesHaveResults = toolUses.every(
    toolUse => toolResults.some(result => result.toolUseId === toolUse.toolUseId)
  )
  const allToolResultsHaveUses = toolResults.every(
    result => toolUses.some(toolUse => result.toolUseId === toolUse.toolUseId)
  )
  return allToolUsesHaveResults && allToolResultsHaveUses
}

function createFailedToolResult(toolUseId: string): KiroToolResult {
  return {
    toolUseId,
    content: [{ text: 'Tool execution failed' }],
    status: 'error'
  }
}

function stripInvalidToolResults(message: KiroHistoryMessage): KiroHistoryMessage | null {
  if (message.userInputMessage?.content?.trim()) {
    return {
      userInputMessage: {
        ...message.userInputMessage,
        userInputMessageContext: undefined
      }
    }
  }
  return null
}

// 确保以 user 消息开始
function ensureStartsWithUserMessage(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length === 0 || isUserInputMessage(messages[0])) {
    return messages
  }
  return [HELLO_MESSAGE, ...messages]
}

// 确保以 user 消息结束
function ensureEndsWithUserMessage(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length === 0) return [HELLO_MESSAGE]
  if (isUserInputMessage(messages[messages.length - 1])) return messages
  return [...messages, CONTINUE_MESSAGE]
}

// 确保消息交替
function ensureAlternatingMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length <= 1) return messages
  
  const result: KiroHistoryMessage[] = [messages[0]]
  for (let i = 1; i < messages.length; i++) {
    const prevMessage = result[result.length - 1]
    const currentMessage = messages[i]
    
    if (isUserInputMessage(prevMessage) && isUserInputMessage(currentMessage)) {
      result.push(UNDERSTOOD_MESSAGE)
    } else if (isAssistantResponseMessage(prevMessage) && isAssistantResponseMessage(currentMessage)) {
      result.push(CONTINUE_MESSAGE)
    }
    result.push(currentMessage)
  }
  return result
}

function relocateToolResultMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const assistantToolUseIndexes: number[] = []
  const toolResultIndexById = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      assistantToolUseIndexes.push(i)
    } else if (isUserInputMessage(message) && hasToolResults(message)) {
      for (const toolResult of message.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        if (toolResult.toolUseId && !toolResultIndexById.has(toolResult.toolUseId)) {
          toolResultIndexById.set(toolResult.toolUseId, i)
        }
      }
    }
  }

  if (assistantToolUseIndexes.length === 0) return messages

  const result: KiroHistoryMessage[] = []
  const usedIndexes = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (usedIndexes.has(i)) continue
    const message = messages[i]
    result.push(message)
    usedIndexes.add(i)

    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      for (const toolUse of message.assistantResponseMessage?.toolUses ?? []) {
        const toolResultIndex = toolResultIndexById.get(toolUse.toolUseId)
        if (toolResultIndex !== undefined && toolResultIndex !== i + 1 && !usedIndexes.has(toolResultIndex)) {
          const toolResultMessage = messages[toolResultIndex]
          if (toolResultMessage) {
            result.push(toolResultMessage)
            usedIndexes.add(toolResultIndex)
          }
        }
      }
    }
  }
  return result
}

function removeInvalidToolResultMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const result: KiroHistoryMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const previousMessage = i > 0 ? messages[i - 1] : null
    if (!isUserInputMessage(message) || !hasToolResults(message)) {
      result.push(message)
      continue
    }
    if (!previousMessage || !isAssistantResponseMessage(previousMessage) || !hasToolUses(previousMessage)) {
      const stripped = stripInvalidToolResults(message)
      if (stripped) result.push(stripped)
      continue
    }

    const validToolUseIds = new Set((previousMessage.assistantResponseMessage?.toolUses ?? []).map(toolUse => toolUse.toolUseId).filter(Boolean))
    const seenToolUseIds = new Set<string>()
    const toolResults = message.userInputMessage?.userInputMessageContext?.toolResults ?? []
    const filteredToolResults = toolResults.filter(toolResult => {
      if (!toolResult.toolUseId || !validToolUseIds.has(toolResult.toolUseId) || seenToolUseIds.has(toolResult.toolUseId)) return false
      seenToolUseIds.add(toolResult.toolUseId)
      return true
    })

    if (filteredToolResults.length === toolResults.length) {
      result.push(message)
    } else if (filteredToolResults.length > 0) {
      result.push({
        userInputMessage: {
          ...message.userInputMessage!,
          userInputMessageContext: {
            ...message.userInputMessage!.userInputMessageContext,
            toolResults: filteredToolResults
          }
        }
      })
    } else {
      const stripped = stripInvalidToolResults(message)
      if (stripped) result.push(stripped)
    }
  }
  return result
}

// 确保工具调用有对应结果
function ensureValidToolUsesAndResults(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const result: KiroHistoryMessage[] = []
  
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    result.push(message)
    
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      const nextMessage = i + 1 < messages.length ? messages[i + 1] : null
      const toolUses = message.assistantResponseMessage?.toolUses ?? []
      const toolUseIds = toolUses.map((tu, idx) => tu.toolUseId ?? `toolUse_${idx + 1}`)
      
      if (!nextMessage || !isUserInputMessage(nextMessage) || !hasToolResults(nextMessage)) {
        // 没有对应的工具结果，添加失败消息
        result.push(createFailedToolUseMessage(toolUseIds))
      } else if (!hasMatchingToolResults(
        message.assistantResponseMessage?.toolUses,
        nextMessage.userInputMessage?.userInputMessageContext?.toolResults
      ) && !messages.some((candidate, index) => (
        index !== i
        && isAssistantResponseMessage(candidate)
        && hasToolUses(candidate)
        && hasMatchingToolResults(candidate.assistantResponseMessage?.toolUses, nextMessage.userInputMessage?.userInputMessageContext?.toolResults)
      ))) {
        // 工具结果不匹配，添加失败消息
        const existingToolResults = nextMessage.userInputMessage?.userInputMessageContext?.toolResults ?? []
        const validToolUseIds = new Set(toolUseIds)
        const usedToolUseIds = new Set<string>()
        const completedToolResults = existingToolResults.filter(toolResult => {
          if (!toolResult.toolUseId || !validToolUseIds.has(toolResult.toolUseId) || usedToolUseIds.has(toolResult.toolUseId)) return false
          usedToolUseIds.add(toolResult.toolUseId)
          return true
        })
        for (const toolUseId of toolUseIds) {
          if (!usedToolUseIds.has(toolUseId)) completedToolResults.push(createFailedToolResult(toolUseId))
        }
        result.push({
          userInputMessage: {
            ...nextMessage.userInputMessage!,
            userInputMessageContext: {
              ...nextMessage.userInputMessage!.userInputMessageContext,
              toolResults: completedToolResults
            }
          }
        })
        i++
      }
    }
  }
  return result
}

// 移除空的 user 消息
function removeEmptyUserMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length <= 1) return messages
  
  const firstUserMessageIndex = messages.findIndex(isUserInputMessage)
  return messages.filter((message, index) => {
    if (isAssistantResponseMessage(message)) return true
    if (isUserInputMessage(message) && index === firstUserMessageIndex) return true
    if (isUserInputMessage(message)) {
      const hasContent = message.userInputMessage?.content?.trim() !== ''
      return hasContent || hasToolResults(message)
    }
    return true
  })
}

function validateConversation(messages: KiroHistoryMessage[]): string[] {
  const errors: string[] = []
  if (messages.length === 0 || !isUserInputMessage(messages[0])) {
    errors.push('STARTS_WITH_USER_MESSAGE:index=0')
  }
  if (messages.length === 0 || !isUserInputMessage(messages[messages.length - 1])) {
    errors.push(`ENDS_WITH_USER_MESSAGE:index=${Math.max(messages.length - 1, 0)}`)
  }
  for (let i = 1; i < messages.length; i++) {
    const previousMessage = messages[i - 1]
    const currentMessage = messages[i]
    if (isUserInputMessage(previousMessage) && isUserInputMessage(currentMessage)) {
      errors.push(`ALTERNATING_MESSAGES:index=${i}`)
      break
    }
    if (isAssistantResponseMessage(previousMessage) && isAssistantResponseMessage(currentMessage)) {
      errors.push(`ALTERNATING_MESSAGES:index=${i}`)
      break
    }
  }
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i]
    const nextMessage = messages[i + 1]
    if (isAssistantResponseMessage(message) && hasToolUses(message) && (!isUserInputMessage(nextMessage) || !hasMatchingToolResults(message.assistantResponseMessage?.toolUses, nextMessage?.userInputMessage?.userInputMessageContext?.toolResults))) {
      errors.push(`TOOL_USES_AND_RESULTS:index=${i + 1}`)
      break
    }
    if (isAssistantResponseMessage(message) && !hasToolUses(message) && isUserInputMessage(nextMessage) && hasToolResults(nextMessage)) {
      errors.push(`TOOL_RESULTS_AND_NO_USES:index=${i}`)
      break
    }
  }
  for (let i = 1; i < messages.length; i++) {
    const previousMessage = messages[i - 1]
    const currentMessage = messages[i]
    if (!isAssistantResponseMessage(previousMessage) || !hasToolUses(previousMessage) || !isUserInputMessage(currentMessage) || !hasToolResults(currentMessage)) continue
    const toolUseIds = new Set((previousMessage.assistantResponseMessage?.toolUses ?? []).map(toolUse => toolUse.toolUseId).filter(Boolean))
    const seenToolUseIds = new Set<string>()
    const hasInvalidToolResult = (currentMessage.userInputMessage?.userInputMessageContext?.toolResults ?? []).some(toolResult => {
      if (!toolResult.toolUseId || !toolUseIds.has(toolResult.toolUseId) || seenToolUseIds.has(toolResult.toolUseId)) return true
      seenToolUseIds.add(toolResult.toolUseId)
      return false
    })
    if (hasInvalidToolResult) {
      errors.push(`TOOL_RESULTS_ORPHAN_IDS:index=${i}`)
      break
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isUserInputMessage(message) && !message.userInputMessage?.content?.trim() && !hasToolResults(message)) {
      errors.push(`NON_EMPTY_USER_MESSAGE:index=${i}`)
      break
    }
  }
  return errors
}

function getToolNames(tools: KiroToolWrapper[]): Set<string> {
  return new Set(tools.flatMap(tool => 'toolSpecification' in tool ? [tool.toolSpecification.name] : []))
}

function stringifyToolInput(input: unknown): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function flattenContent(content: string, extra: string): string {
  const trimmedContent = content.trim()
  if (!trimmedContent) return extra
  if (!extra) return trimmedContent
  return `${trimmedContent}\n\n${extra}`
}

function formatToolUses(toolUses: KiroToolUse[]): string {
  return toolUses.map(toolUse => [
    `<tool_use id="${toolUse.toolUseId}" name="${toolUse.name}">`,
    stringifyToolInput(toolUse.input),
    '</tool_use>'
  ].filter(Boolean).join('\n')).join('\n\n')
}

function formatToolResults(toolResults: KiroToolResult[]): string {
  return toolResults.map(toolResult => [
    `<tool_result id="${toolResult.toolUseId}" status="${toolResult.status}">`,
    toolResult.content.map(content => content.text).join('\n'),
    '</tool_result>'
  ].filter(Boolean).join('\n')).join('\n\n')
}

function normalizeToolHistory(messages: KiroHistoryMessage[], tools: KiroToolWrapper[]): KiroHistoryMessage[] {
  const toolNames = getToolNames(tools)
  const hasUnknownToolUse = messages.some(message => (
    message.assistantResponseMessage?.toolUses?.some(toolUse => !toolNames.has(toolUse.name)) ?? false
  ))
  if (!hasUnknownToolUse) return messages

  return messages.map(message => {
    if (message.assistantResponseMessage?.toolUses?.length) {
      return {
        assistantResponseMessage: {
          ...message.assistantResponseMessage,
          content: flattenContent(message.assistantResponseMessage.content, formatToolUses(message.assistantResponseMessage.toolUses)),
          toolUses: undefined
        }
      }
    }
    if (message.userInputMessage?.userInputMessageContext?.toolResults?.length) {
      return {
        userInputMessage: {
          ...message.userInputMessage,
          content: flattenContent(message.userInputMessage.content, formatToolResults(message.userInputMessage.userInputMessageContext.toolResults)),
          userInputMessageContext: {
            ...message.userInputMessage.userInputMessageContext,
            toolResults: undefined
          }
        }
      }
    }
    return message
  })
}

// 清理会话消息（参考 Kiro 官方实现）
function sanitizeConversation(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  let sanitized = [...messages]
  sanitized = ensureStartsWithUserMessage(sanitized)
  sanitized = removeEmptyUserMessages(sanitized)
  sanitized = relocateToolResultMessages(sanitized)
  sanitized = removeInvalidToolResultMessages(sanitized)
  sanitized = ensureValidToolUsesAndResults(sanitized)
  sanitized = ensureAlternatingMessages(sanitized)
  sanitized = ensureEndsWithUserMessage(sanitized)
  const validationErrors = validateConversation(sanitized)
  if (validationErrors.length > 0) {
    throw new Error(`Invalid Kiro conversation after sanitization: ${validationErrors.join(', ')}`)
  }
  return sanitized
}

// 按 token 估算成对裁剪 history 最旧消息 (避免后端 CONTENT_LENGTH_EXCEEDS_THRESHOLD)
// 切点保证不破坏 toolUse↔toolResult 配对：assistant(toolUse) 必须连同后续 user(toolResult) 一起裁
// 裁剪后用 ensureStartsWithUserMessage 兜底重新规范化
function trimHistoryByTokens(payload: KiroPayload, maxTokens: number): { trimmed: number; finalTokens: number; iterations: number } {
  let history = payload.conversationState.history
  if (!history || history.length === 0) {
    return { trimmed: 0, finalTokens: estimatePayloadTokens(payload), iterations: 0 }
  }

  let totalTrimmed = 0
  let iterations = 0
  let currentTokens = estimatePayloadTokens(payload)
  const MAX_ITERATIONS = 100 // 防止极端情况死循环

  while (currentTokens > maxTokens && history.length >= 4 && iterations < MAX_ITERATIONS) {
    iterations++
    // 计算安全切点：从 index 0 开始至少裁掉 1 组 (user+assistant)，并连带 toolUse/toolResult 配对
    let cutAt = 0
    while (cutAt < history.length - 2) {
      const msg = history[cutAt]
      // assistant(toolUse) → 下一条 user(toolResult) 必须一起裁，避免配对断裂
      if (isAssistantResponseMessage(msg) && hasToolUses(msg)) {
        cutAt += 2
      } else {
        cutAt += 1
      }
      if (cutAt >= 2) break
    }

    if (cutAt === 0) break // 无法继续裁剪

    history = history.slice(cutAt)
    totalTrimmed += cutAt

    // 裁剪后 history 可能以 assistant 起头 → 补 HELLO 重新规范
    history = ensureStartsWithUserMessage(history)
    payload.conversationState.history = history
    currentTokens = estimatePayloadTokens(payload)
  }

  return { trimmed: totalTrimmed, finalTokens: currentTokens, iterations }
}

// ============= 构建 Kiro API 请求负载（参考 Kiro 官方实现）=============

export function buildKiroPayload(
  content: string,
  modelId: string,
  origin: string,
  history: KiroHistoryMessage[] = [],
  tools: KiroToolWrapper[] = [],
  toolResults: KiroToolResult[] = [],
  images: KiroImage[] = [],
  profileArn?: string,
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number },
  messageOptions?: { cachePoint?: KiroCachePoint | undefined; clientCacheConfig?: unknown; documents?: KiroDocument[]; conversationId?: string; context?: KiroRequestContext },
  additionalModelRequestFields?: Record<string, unknown>
): KiroPayload {
  // 构建当前消息
  const finalContent = content.trim() || (toolResults.length > 0 ? '' : 'Continue')
  
  const currentUserInputMessage: KiroUserInputMessage = {
    content: finalContent,
    modelId,
    origin
  }

  if (images.length > 0) {
    currentUserInputMessage.images = images
  }

  if (messageOptions?.documents?.length) {
    currentUserInputMessage.documents = messageOptions.documents
  }

  if (messageOptions?.cachePoint) {
    currentUserInputMessage.cachePoint = messageOptions.cachePoint
  }

  if (messageOptions?.clientCacheConfig !== undefined) {
    currentUserInputMessage.clientCacheConfig = messageOptions.clientCacheConfig
  }

  // 构建 userInputMessageContext（包含 tools 和 toolResults）
  // 注意：tools 只放在最后一条消息（currentMessage）的 userInputMessageContext 中
  if (tools.length > 0 || toolResults.length > 0) {
    currentUserInputMessage.userInputMessageContext = {}
    if (tools.length > 0) {
      currentUserInputMessage.userInputMessageContext.tools = tools
    }
    if (toolResults.length > 0) {
      currentUserInputMessage.userInputMessageContext.toolResults = toolResults
    }
  }

  if (messageOptions?.context) {
    currentUserInputMessage.userInputMessageContext = {
      ...currentUserInputMessage.userInputMessageContext,
      ...(messageOptions.context.editorState !== undefined ? { editorState: messageOptions.context.editorState } : {}),
      ...(messageOptions.context.shellState !== undefined ? { shellState: messageOptions.context.shellState } : {}),
      ...(messageOptions.context.gitState !== undefined ? { gitState: messageOptions.context.gitState } : {}),
      ...(messageOptions.context.envState !== undefined ? { envState: messageOptions.context.envState } : {}),
      ...(messageOptions.context.additionalContext !== undefined ? { additionalContext: messageOptions.context.additionalContext } : {})
    }
  }

  // 构建 currentMessage
  const currentMessage: KiroHistoryMessage = {
    userInputMessage: currentUserInputMessage
  }

  // 清理并准备所有消息（history + currentMessage）
  const allMessages = [...history, currentMessage]
  const sanitizedMessages = sanitizeConversation(normalizeToolHistory(allMessages, tools))
  
  // 分离 history 和 currentMessage
  // currentMessage 是最后一条消息，history 是其余的
  const sanitizedHistory = sanitizedMessages.slice(0, -1)
  let finalCurrentMessage = sanitizedMessages.at(-1)!

  // 确保 currentMessage 是 user 消息（sanitizeConversation 保证以 user 消息结束）
  // 并确保包含 tools
  if (!finalCurrentMessage.userInputMessage) {
    // 如果清理后最后一条不是 user 消息，创建一个新的
    finalCurrentMessage = {
      userInputMessage: {
        content: finalContent || 'Continue',
        modelId,
        origin
      }
    }
  }
  
  finalCurrentMessage.userInputMessage!.userInputMessageContext = {
    ...finalCurrentMessage.userInputMessage!.userInputMessageContext,
    ...(tools.length > 0 ? { tools } : {})
  }

  // conversationId 稳定化：同一会话的多轮请求复用同一个 conversationId
  // 优先级：客户端显式 conversation_id → sessionHint（header 提取）→ history fingerprint → 新 UUID
  const conversationId = resolveConversationId(history, messageOptions?.conversationId)
  const payload: KiroPayload = {
    conversationState: {
      agentContinuationId: uuidv4(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: {
        userInputMessage: finalCurrentMessage.userInputMessage!
      },
      history: sanitizedHistory.length > 0 ? sanitizedHistory : undefined
    }
  }

  if (profileArn !== undefined) {
    payload.profileArn = profileArn
  }

  if (inferenceConfig && (inferenceConfig.maxTokens || inferenceConfig.temperature !== undefined || inferenceConfig.topP !== undefined)) {
    payload.inferenceConfig = {}
    if (inferenceConfig.maxTokens) {
      payload.inferenceConfig.maxTokens = inferenceConfig.maxTokens
    }
    if (inferenceConfig.temperature !== undefined) {
      payload.inferenceConfig.temperature = inferenceConfig.temperature
    }
    if (inferenceConfig.topP !== undefined) {
      payload.inferenceConfig.topP = inferenceConfig.topP
    }
  }

  // additionalModelRequestFields（thinking 等模型级参数）
  if (additionalModelRequestFields && Object.keys(additionalModelRequestFields).length > 0) {
    payload.additionalModelRequestFields = additionalModelRequestFields
  }

  // ====== 第一阶段：按 token 估算成对裁剪旧 history ======
  // 避免 Kiro 后端 CONTENT_LENGTH_EXCEEDS_THRESHOLD（token 维度的拒绝）
  // 注意：byte size 充足但 token 超限是常见情况（长对话+大量小消息）
  // effectiveLimit 按模型 context window 自动算：ctx - tokenBufferReserve（开关启用时，默认 20K）
  // 例：sonnet-4.5 (200K) → 180K, sonnet-4.5 with 1M beta → 980K
  // 开关关闭时完全跳过，超出 context window 由 Kiro 后端原样返回错误
  if (enableTokenBufferReserve) {
    const effectiveTokenLimit = getEffectiveTokenLimit(modelId)
    const tokenTrimResult = trimHistoryByTokens(payload, effectiveTokenLimit)
    if (tokenTrimResult.trimmed > 0) {
      const modelCtx = getModelContextLength(modelId)
      console.log(`[KiroPayload] Trimmed ${tokenTrimResult.trimmed} oldest history messages by token estimate (≈${tokenTrimResult.finalTokens.toLocaleString()} / ${effectiveTokenLimit.toLocaleString()} tokens [model ctx ${modelCtx.toLocaleString()} - buffer ${tokenBufferReserve.toLocaleString()}], ${tokenTrimResult.iterations} iter)`)
    }
  }

  // ====== 第二阶段：按 byte 截断 tool result 内容 ======
  // 避免 HTTP body 过大被 Kiro 网关拒绝
  // 用户可在高级设置中调整限制值（默认 1536KB = 1.5MB）
  const PAYLOAD_SIZE_LIMIT = (payloadSizeLimitKB || 1536) * 1024
  const TOOL_RESULT_TRUNCATE_LENGTH = 4000
  let initialPayloadSize = JSON.stringify(payload).length
  if (initialPayloadSize > PAYLOAD_SIZE_LIMIT && payload.conversationState.history) {
    const historyMessages = payload.conversationState.history
    let truncatedCount = 0
    for (const message of historyMessages) {
      if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break
      const userToolResults = message.userInputMessage?.userInputMessageContext?.toolResults
      if (!userToolResults) continue
      for (const toolResult of userToolResults) {
        if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break
        if (!toolResult.content) continue
        for (const contentItem of toolResult.content) {
          if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break
          if (contentItem.text && contentItem.text.length > TOOL_RESULT_TRUNCATE_LENGTH) {
            const originalLen = contentItem.text.length
            contentItem.text = `${contentItem.text.slice(0, TOOL_RESULT_TRUNCATE_LENGTH)}\n\n[Truncated by proxy: original ${originalLen} chars]`
            truncatedCount++
            initialPayloadSize = JSON.stringify(payload).length
          }
        }
      }
    }
    if (truncatedCount > 0) {
      console.log(`[KiroPayload] Truncated ${truncatedCount} large tool results to fit payload size limit (final size: ${initialPayloadSize} bytes)`)
    }
  }

  // 调试日志
  console.log(`[KiroPayload] Built payload (native history mode):`, {
    contentLength: finalContent.length,
    originalHistoryLength: history.length,
    sanitizedHistoryLength: sanitizedHistory.length,
    toolsCount: tools.length,
    toolResultsCount: toolResults.length,
    hasProfileArn: payload.profileArn !== undefined,
    hasThinking: !!additionalModelRequestFields?.thinking,
    payloadSize: initialPayloadSize
  })

  return payload
}

// conversationId 稳定化：同一会话的多轮请求复用同一个 conversationId
// 策略：sessionHint（由 proxyServer 从 header/body 提取）→ 稳定映射到固定 conversationId
// 无 sessionHint 时用 history fingerprint 兜底
const conversationCache = new Map<string, { id: string; timestamp: number }>()
const CONVERSATION_CACHE_TTL = 2 * 60 * 60 * 1000 // 2 小时
const CONVERSATION_CACHE_MAX = 1000

function resolveConversationId(history: KiroHistoryMessage[], sessionHint?: string): string {
  // sessionHint 已包含 API Key hash 前缀（由 proxyServer 注入），天然隔离不同用户
  const key = sessionHint || fingerprintFromHistory(history)
  if (!key) return uuidv4()

  const now = Date.now()
  const cached = conversationCache.get(key)
  if (cached) {
    cached.timestamp = now
    return cached.id
  }

  // 清理过期缓存
  if (conversationCache.size > CONVERSATION_CACHE_MAX) {
    const cutoff = now - CONVERSATION_CACHE_TTL
    for (const [k, v] of conversationCache) {
      if (v.timestamp < cutoff) conversationCache.delete(k)
    }
  }

  const id = uuidv4()
  conversationCache.set(key, { id, timestamp: now })
  return id
}

function fingerprintFromHistory(history: KiroHistoryMessage[]): string | undefined {
  if (history.length === 0) return undefined
  const fp = history.slice(0, 2).map(msg =>
    `${msg.userInputMessage?.content || ''}|${msg.assistantResponseMessage?.content || ''}`
  ).join('::')
  const crypto = require('crypto')
  return crypto.createHash('sha256').update(fp).digest('hex').slice(0, 32)
}

// 清除所有内存缓存
export function clearAllCaches(): { conversation: number; model: number } {
  const conversationCount = conversationCache.size
  const modelCount = codeWhispererModelCache.size
  conversationCache.clear()
  codeWhispererModelCache.clear()
  return { conversation: conversationCount, model: modelCount }
}

// machineId 稳定生成缓存（用于无绑定 machineId 且 K-Proxy 不可用时的兆底）
const fallbackMachineIds = new Map<string, string>()

function generateStableMachineId(accountId: string): string {
  const cached = fallbackMachineIds.get(accountId)
  if (cached) return cached
  const crypto = require('crypto')
  const hash = crypto.createHash('sha256').update(`kiro-device-${accountId}`).digest('hex')
  fallbackMachineIds.set(accountId, hash)
  return hash
}

// 获取账号绑定的 Machine ID（保证永远不为空）
function getAccountMachineId(accountId: string, accountMachineId?: string): string {
  if (accountMachineId) return accountMachineId
  const kproxyService = getKProxyService()
  if (kproxyService) {
    const deviceId = kproxyService.getDeviceIdForAccount(accountId)
    if (deviceId) return deviceId
  }
  return generateStableMachineId(accountId)
}

// 获取认证方式对应的请求头(2026-07 迁移后)
// - V2 端点(runtime.*.kiro.dev):Content-Type = application/x-amz-json-1.0(AWS RPC 序列化)
// - V1 端点(codewhisperer / q.*.amazonaws.com):保留 application/json(旧 SDK 序列化)
// - TokenType:统一 SSO_OIDC(仅真 Azure AD external_idp 用 EXTERNAL_IDP)
function getAuthHeaders(account: ProxyAccount, endpoint: typeof KIRO_ENDPOINTS[0]): Record<string, string> {
  const machineId = getAccountMachineId(account.id, account.machineId)
  // 按配置的 agent 模式（vibe 或 spec）设置 header
  const agentMode = configuredAgentMode

  // V2 端点用 x-amz-json-1.0;V1 端点保留旧 Content-Type
  const isV2Endpoint = endpoint.url.includes('.kiro.dev')
  const contentType = isV2Endpoint ? 'application/x-amz-json-1.0' : 'application/json'

  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-amzn-kiro-agent-mode': agentMode,
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'user-agent': getKiroUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=3',
    'Authorization': `Bearer ${account.accessToken}`,
    // 抓包证据:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
    'TokenType': getTokenTypeHeader(account),
    // 2026-07: X-Amz-Target 是 AWS SDK RPC 协议的必需 header,声明调用哪个 service.operation
    // - V2 端点(runtime.*.kiro.dev)强制要求,缺失会返 400 UnknownOperationException
    // - V1 端点(REST 路径风格)不严格要求,但加了也接受
    // 值从 KIRO_ENDPOINTS 数组每项的 amzTarget 字段来
    'X-Amz-Target': endpoint.amzTarget
  }

  return headers
}

// 获取排序后的端点列表(根据 account.region 与首选端点配置)
// 2026-07 迁移后的策略:
//   - V2 端点(runtime.*.kiro.dev) 总是优先,按 account.region 选单一 EU/US endpoint
//   - V1 端点作 fallback(仅 us,eu 侧 V1 已停服),preferredEndpoint 只影响 V1 内部顺序
//   - amazonq-cli 保留单端点不回退行为
function getSortedEndpoints(
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli',
  region?: string
): typeof KIRO_ENDPOINTS {
  // AmazonQ CLI 模式：只用这一个端点，失败不回退
  if (preferredEndpoint === 'amazonq-cli') {
    return KIRO_ENDPOINTS.filter(ep => ep.name === 'AmazonQCLI')
  }

  // V2 端点按 region 分发(eu account → EU host, us/其它 account → US host)
  // V1 端点历史上全是 us,不按 region 过滤;eu account 若 V2 失败仍可尝试 V1 us 作最后 fallback
  const wantEuRegion = region?.startsWith('eu-')
  const v2Endpoints = KIRO_ENDPOINTS.filter(ep => {
    if (!ep.name.startsWith('KiroRuntime')) return false
    return wantEuRegion ? ep.name === 'KiroRuntime-EU' : ep.name === 'KiroRuntime-US'
  })

  const v1Endpoints = KIRO_ENDPOINTS.filter(ep =>
    ep.name !== 'AmazonQCLI' && !ep.name.startsWith('KiroRuntime')
  )

  // V1 内部按 preferredEndpoint 排序(codewhisperer/amazonq 二选一优先)
  if (preferredEndpoint) {
    const preferredName = preferredEndpoint === 'codewhisperer' ? 'CodeWhisperer' : 'AmazonQ'
    v1Endpoints.sort((a, b) => {
      if (a.name === preferredName) return -1
      if (b.name === preferredName) return 1
      return 0
    })
  }

  // V2 优先(2026-07 迁移后主端点),V1 作 fallback
  return [...v2Endpoints, ...v1Endpoints]
}

function getAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  if (signal?.reason) return new Error(String(signal.reason))
  return new Error('Request aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw getAbortError(signal)
}

// 调用 Kiro API（流式）
export async function callKiroApiStream(
  account: ProxyAccount,
  payload: KiroPayload,
  // onChunk 可返回 Promise：下游 SSE 写缓冲打满时返回 drain promise，流解析 await 实现背压
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, reasoningSignature?: string, redactedContent?: string) => void | Promise<void>,
  onComplete: (usage: KiroUsage) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal,
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
): Promise<void> {
  const isEnterprise = account.provider === 'Enterprise' || account.authMethod === 'external_idp'
  // 所有账号类型均走正常端点优先级（含 fallback），不再强制 Enterprise 走 CodeWhisperer
  const endpoints = getSortedEndpoints(preferredEndpoint, account.region)

  // Enterprise 缺 profileArn 时调 API 获取；BuilderId/Social 不需要（resolveProfileArn 会兜底，流式端点自动不传占位符）
  if (!account.profileArn && isEnterprise) {
    const fetchedArn = await fetchEnterpriseProfileArn(account)
    if (fetchedArn) {
      account.profileArn = fetchedArn
      if (account.id) profileArnPersistCallback?.(account.id, fetchedArn)
    }
  }

  let lastError: Error | null = null

  for (const endpoint of endpoints) {
    try {
      throwIfAborted(signal)
      const requestPayload = clonePayload(payload)
      // profileArn 决策：后端所有端点均强制要求 profileArn（400 "profileArn is required"）
      // resolveProfileArn 按账号类型返回：BuilderId→占位符 / Social→固定 / Enterprise→真实ARN
      const resolvedArn = resolveProfileArn(account)
      if (resolvedArn) {
        requestPayload.profileArn = resolvedArn
      }
      const requestedModelId = getPayloadModelId(requestPayload)
      if (endpoint.name === 'CodeWhisperer') {
        applyPayloadModelId(requestPayload, await resolveCodeWhispererModelId(account, requestedModelId, signal))
      }

      applyPayloadOrigin(requestPayload, endpoint.origin)

      // AmazonQCLI 端点不支持 agentContinuationId/agentTaskType
      if (endpoint.name === 'AmazonQCLI') {
        delete (requestPayload.conversationState as unknown as Record<string, unknown>).agentContinuationId
        delete (requestPayload.conversationState as unknown as Record<string, unknown>).agentTaskType
      }

      const payloadStr = JSON.stringify(requestPayload)
      const headers = getAuthHeaders(account, endpoint)
      const currentUserInput = requestPayload.conversationState.currentMessage.userInputMessage
      const historyMessages = requestPayload.conversationState.history ?? []
      const historyToolUseCount = historyMessages.reduce((count, message) => count + (message.assistantResponseMessage?.toolUses?.length ?? 0), 0)
      const historyToolResultCount = historyMessages.reduce((count, message) => count + (message.userInputMessage?.userInputMessageContext?.toolResults?.length ?? 0), 0)
      console.log(`[KiroAPI] Request to ${endpoint.name}:`)
      console.log(`[KiroAPI]   - Content length: ${currentUserInput?.content?.length || 0}`)
      console.log(`[KiroAPI]   - Tools count: ${currentUserInput?.userInputMessageContext?.tools?.length || 0}`)
      console.log(`[KiroAPI]   - Current tool results: ${currentUserInput?.userInputMessageContext?.toolResults?.length || 0}`)
      console.log(`[KiroAPI]   - History messages: ${historyMessages.length}`)
      console.log(`[KiroAPI]   - History tool uses/results: ${historyToolUseCount}/${historyToolResultCount}`)
      console.log(`[KiroAPI]   - Model ID: ${currentUserInput?.modelId || 'default'}`)
      console.log(`[KiroAPI]   - Has profileArn: ${requestPayload.profileArn !== undefined}`)
      console.log(`[KiroAPI]   - Agent mode: ${headers['x-amzn-kiro-agent-mode']}`)
      console.log(`[KiroAPI]   - Payload size: ${payloadStr.length} bytes`)
      
      const agent = getNetworkAgent(account)
      if (agent) proxyLogger.debug('KiroAPI', `Stream request via proxy to ${endpoint.name}`)
      let response = agent
        ? await undiciFetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal, dispatcher: agent } as UndiciRequestInit) as unknown as Response
        : await fetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal })

      if (response.status === 429) {
        // 429 = rate limit(短期请求过多),不是永久配额耗尽。
        // 策略:同端点指数退避 + 重试(默认 3 次)。Retry-After header 优先(HTTP 标准)。
        // 都失败才 continue 到下一端点。参考:GitHub kirodotdev/Kiro#8998 credits 充足也 429,
        // 时间序列证明 rate limit 窗口通常 10-15 秒后恢复,退避重试能救回大多数 burst 失败。
        const RATE_LIMIT_MAX_RETRIES = 3
        let retried = 0
        while (response.status === 429 && retried < RATE_LIMIT_MAX_RETRIES) {
          const retryAfterHeader = response.headers.get('retry-after')
          const asSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN
          const waitMs = !isNaN(asSec) && asSec > 0 ? Math.min(asSec * 1000, 15000)
            : (retried === 0 ? 2000 : retried === 1 ? 5000 : 10000)
          console.log(`[KiroAPI] ${endpoint.name} 429 rate-limited, backoff ${waitMs}ms retry ${retried + 1}/${RATE_LIMIT_MAX_RETRIES}`)
          await new Promise(r => setTimeout(r, waitMs))
          throwIfAborted(signal)
          response = agent
            ? await undiciFetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal, dispatcher: agent } as UndiciRequestInit) as unknown as Response
            : await fetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal })
          retried++
        }
        if (response.status === 429) {
          console.log(`[KiroAPI] ${endpoint.name} still rate-limited after ${RATE_LIMIT_MAX_RETRIES} retries, trying next endpoint...`)
          lastError = new Error(`Rate limited on ${endpoint.name} after ${RATE_LIMIT_MAX_RETRIES} retries`)
          continue
        }
        console.log(`[KiroAPI] ${endpoint.name} recovered from 429 after ${retried} retries`)
        // 重试成功,response 已更新,fall through 到下面 401/403 检查 → not-ok 检查 → stream 解析
      }

      if (response.status === 401 || response.status === 403) {
        throwIfAborted(signal)
        const body = await response.text()
        throwIfAborted(signal)
        throw new Error(`Auth error ${response.status}: ${body}`)
      }

      if (!response.ok) {
        throwIfAborted(signal)
        const body = await response.text()
        throwIfAborted(signal)
        throw new Error(`API error ${response.status}: ${body}`)
      }

      // 解析 Event Stream
      // 传入 modelId + payloadStr 用于精确 token 计算（contextUsage 反推 + tiktoken）
      const inputChars = payloadStr.length
      await parseEventStream(response.body!, onChunk, onComplete, onError, inputChars, signal, requestedModelId, payloadStr)
      return
    } catch (error) {
      if (signal?.aborted) {
        onError(getAbortError(signal))
        return
      }
      lastError = error as Error
      console.error(`[KiroAPI] Endpoint ${endpoint.name} failed:`, error)
      
      // 如果是认证错误，不继续尝试其他端点
      if ((error as Error).message.includes('Auth error')) {
        onError(error as Error)
        return
      }

      // THINKING_SIGNATURE_INVALID: 剥离 history 中 reasoningContent 后重试一次（官方 IDE 同策略）
      const errMsg = (error as Error).message || ''
      if (errMsg.includes('THINKING_SIGNATURE_INVALID')) {
        console.log(`[KiroAPI] THINKING_SIGNATURE_INVALID on ${endpoint.name}, retrying with reasoningContent stripped`)
        try {
          throwIfAborted(signal)
          const retryPayload = clonePayload(payload)
          // 剥离 history 中所有 assistantResponseMessage.reasoningContent
          if (retryPayload.conversationState.history) {
            for (const msg of retryPayload.conversationState.history) {
              if (msg.assistantResponseMessage?.reasoningContent !== undefined) {
                delete (msg.assistantResponseMessage as unknown as Record<string, unknown>).reasoningContent
              }
            }
          }
          // 复用同一端点的配置（与主流程 profileArn 逻辑一致）
          const resolvedArn2 = resolveProfileArn(account)
          if (resolvedArn2 && (!isPlaceholderProfileArn(resolvedArn2) || isEnterprise)) {
            retryPayload.profileArn = resolvedArn2
          } else {
            delete retryPayload.profileArn
          }
          if (endpoint.name === 'CodeWhisperer') {
            applyPayloadModelId(retryPayload, await resolveCodeWhispererModelId(account, getPayloadModelId(retryPayload), signal))
          }
          applyPayloadOrigin(retryPayload, endpoint.origin)
          const retryStr = JSON.stringify(retryPayload)
          const retryHeaders = getAuthHeaders(account, endpoint)
          const retryAgent = getNetworkAgent(account)
          const retryResponse = retryAgent
            ? await undiciFetch(endpoint.url, { method: 'POST', headers: retryHeaders, body: retryStr, signal, dispatcher: retryAgent } as UndiciRequestInit) as unknown as Response
            : await fetch(endpoint.url, { method: 'POST', headers: retryHeaders, body: retryStr, signal })
          if (retryResponse.ok) {
            await parseEventStream(retryResponse.body!, onChunk, onComplete, onError, retryStr.length, signal, getPayloadModelId(retryPayload), retryStr)
            return
          }
          const retryBody = await retryResponse.text()
          console.error(`[KiroAPI] THINKING_SIGNATURE_INVALID retry also failed: ${retryResponse.status} ${retryBody.slice(0, 200)}`)
        } catch (retryErr) {
          if (signal?.aborted) { onError(getAbortError(signal)); return }
          console.error(`[KiroAPI] THINKING_SIGNATURE_INVALID retry error:`, retryErr)
        }
      }
    }
  }

  if (lastError) {
    onError(lastError)
  }
}

// 从 headers 中提取 event type
function extractEventType(headers: Uint8Array): string {
  let offset = 0
  while (offset < headers.length) {
    if (offset >= headers.length) break
    const nameLen = headers[offset]
    offset++
    if (offset + nameLen > headers.length) break
    const name = new TextDecoder().decode(headers.slice(offset, offset + nameLen))
    offset += nameLen
    if (offset >= headers.length) break
    const valueType = headers[offset]
    offset++
    
    if (valueType === 7) { // String type
      if (offset + 2 > headers.length) break
      const valueLen = (headers[offset] << 8) | headers[offset + 1]
      offset += 2
      if (offset + valueLen > headers.length) break
      const value = new TextDecoder().decode(headers.slice(offset, offset + valueLen))
      offset += valueLen
      if (name === ':event-type') {
        return value
      }
      continue
    }
    
    // Skip other value types
    const skipSizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
    if (valueType === 6) {
      if (offset + 2 > headers.length) break
      const len = (headers[offset] << 8) | headers[offset + 1]
      offset += 2 + len
    } else if (skipSizes[valueType] !== undefined) {
      offset += skipSizes[valueType]
    } else {
      break
    }
  }
  return ''
}

// Tool Use 状态跟踪
interface ToolUseState {
  toolUseId: string
  name: string
  inputBuffer: string
}

// Token 估算（被 promptCacheTracker 等模块使用，用于 cache 块大小判定）
// 优先使用 tiktoken cl100k_base 精确计算（±5%），失败时自动降级到字符系数（±15%）
export function estimateTokens(text: string): number {
  return countTokens(text)
}

// 解析 AWS Event Stream 二进制格式
async function parseEventStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, reasoningSignature?: string, redactedContent?: string) => void | Promise<void>,
  onComplete: (usage: KiroUsage) => void,
  onError: (error: Error) => void,
  inputChars: number = 0,  // 输入字符长度（兜底估算用）
  signal?: AbortSignal,
  modelId?: string,        // 模型 ID，用于 contextUsagePercentage 反推 inputTokens
  payloadStr?: string      // 请求 payload JSON 字符串，用于 tiktoken 精确计算
): Promise<void> {
  const reader = body.getReader()
  const abort = () => {
    reader.cancel(getAbortError(signal)).catch(() => undefined)
  }
  let buffer = new Uint8Array(0)
  let usage: KiroUsage = { 
    inputTokens: 0, 
    outputTokens: 0, 
    credits: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  }
  
  // 累积输出文本长度，用于估算 tokens
  let totalOutputChars = 0
  // 累积输出文本内容，用于 tiktoken 精确计算 output tokens
  let collectedOutputText = ''
  // 是否已拿到 Kiro 真实 tokenUsage（最高优先级，锁定后不再被 contextUsage/tiktoken 覆盖）
  let hasRealTokenUsage = false
  // 流式事件聚合计数（logStreamEvents 开启时，结束后输出摘要而非逐条输出）
  const streamEventCounts: Record<string, number> = {}
  
  // 初始化 input tokens 估算（优先级链路：tokenUsage > contextUsage 反推 > tiktoken > 字符系数）
  // 这里只是兜底初值，后续真实事件会覆盖
  if (payloadStr) {
    // 用 tiktoken cl100k_base 精确计算（±5%）
    usage.inputTokens = countTokens(payloadStr)
  } else if (inputChars > 0) {
    // 字符系数兜底（针对 payload JSON 经验值 0.42）
    usage.inputTokens = Math.max(1, Math.round(inputChars * 0.42))
  }
  
  // Tool use 状态跟踪 - 用于累积输入片段
  let currentToolUse: ToolUseState | null = null
  const processedIds = new Set<string>()

  // ===== 工具调用 XML 泄漏修复（跨帧解析 + 流结束去重）=====
  // 背景：Kiro 后端偶尔把模型的工具调用 XML（<function_calls>/<invoke>/<parameter>，
  //       <function_calls> 有时被损坏成纯文本 "count"）当普通文本，混在
  //       assistantResponseEvent / codeEvent 里【流式分帧】发出。原先的逐帧
  //       `content.replace(/<tool_use.../)` 只覆盖 <tool_use> 且无法匹配跨帧分片的标签，
  //       导致：原始 XML 泄漏成可见文本，且客户端解析不到工具调用 → 工具不执行、任务中断。
  // 方案：用有状态的跨帧过滤器分离「正常文本」与「泄漏的工具调用」；正常文本照常输出，
  //       泄漏工具解析为结构化 tool_use 暂存；流结束时与已见的结构化 toolUseEvent 去重
  //       （同名同参丢弃，避免重复执行）后注入救回。
  // 开关：环境变量 KIRO_TOOL_LEAK_FIX=off 可回退到原逐帧 <tool_use> 过滤。
  const toolLeakFixEnabled = (process.env.KIRO_TOOL_LEAK_FIX || 'on').toLowerCase().trim() !== 'off'
  // 调试开关:默认关闭,`set KIRO_TOOL_LEAK_DEBUG=1 && npm run dev` 开启详细跟踪(carry/emit/rescue/leak-to-client 日志)
  const toolLeakDebug = process.env.KIRO_TOOL_LEAK_DEBUG === '1'
  // 调试信号 pattern:只在 raw content / emit 后内容命中时 log(避免正常文本刷屏)
  const SUSPICIOUS_LEAK_PATTERN = /<tool_use|<invoke|<function_results|\b(?:court|count|call)\b/
  let leakCarry = ''
  const leakedTools: Array<{ name: string; input: Record<string, unknown> }> = []
  const seenToolSigs = new Set<string>()
  let leakIdCounter = 0
  const toolSig = (name: string, input: Record<string, unknown>): string => {
    const sortedKeys = Object.keys(input).sort()
    const norm: Record<string, unknown> = {}
    for (const k of sortedKeys) norm[k] = input[k]
    return name + '|' + JSON.stringify(norm)
  }
  const parseInvokeBody = (name: string, body: string): { name: string; input: Record<string, unknown> } => {
    const input: Record<string, unknown> = {}
    const re = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const key = m[1]
      const raw = m[2]
      const t = raw.trim()
      // 类型还原：布尔/数字/null 转换，其余保留原字符串（保留内部空白，如 command/old_string）
      if (t === 'true') input[key] = true
      else if (t === 'false') input[key] = false
      else if (t === 'null') input[key] = null
      else if (/^-?\d+$/.test(t)) input[key] = parseInt(t, 10)
      else if (/^-?\d*\.\d+$/.test(t)) input[key] = parseFloat(t)
      else input[key] = raw
    }
    return { name, input }
  }
  // 解析 <tool_use id="..." name="..."> {body} </tool_use> 泄漏格式(Anthropic 标准格式)
  // 2026-07-12 升级:支持 3 种错配 close tag(model 常混：</tool_use> / </invoke> / </function_calls>)
  //           body 可以是 JSON 对象或 <parameter>...</parameter> XML 格式（model 混合 mimic）
  const parseToolUseBlock = (rawBlock: string): { name: string; input: Record<string, unknown> } | null => {
    const nameMatch = rawBlock.match(/<tool_use\b[^>]*\bname="([^"]+)"/)
    if (!nameMatch) return null
    const name = nameMatch[1]
    // 支持任一 close tag:</tool_use> / </invoke> / </function_calls>
    const bodyMatch = rawBlock.match(/<tool_use\b[^>]*>([\s\S]*?)<\/(?:tool_use|invoke|function_calls)>/)
    if (!bodyMatch) return null
    const body = bodyMatch[1].trim()
    let input: Record<string, unknown> = {}
    if (body) {
      // 混合格式检测：如果 body 含 <parameter> 就用 XML parser,否则当 JSON 解
      if (body.includes('<parameter')) {
        const parsed = parseInvokeBody(name, body)
        input = parsed.input
      } else {
        try { input = JSON.parse(body) as Record<string, unknown> }
        catch { input = { _raw: body } }  // JSON 坏了兜底原文,让下游 tool 至少收到点东西
      }
    }
    return { name, input }
  }
  // Opus 4.8 已知会在工具调用边界前插入一个多余的英文词（社区实测 court/count/call 三种都高频出现，
  // 随会话/版本随机，不是固定替换），此前只处理了 count，court/call 会原样泄漏成可见文本
  const STRAY_TOKEN_RE = /\b(?:court|count|call)\s*$/
  const stripToolPrefix = (pre: string): string => {
    const fc = pre.match(/<function_calls>\s*$/)
    if (fc) return pre.slice(0, pre.length - fc[0].length)
    const st = pre.match(STRAY_TOKEN_RE)
    if (st) return pre.slice(0, pre.length - st[0].length)
    return pre
  }
  const hasOpenInvoke = (s: string): boolean => {
    const i = s.lastIndexOf('<invoke name=')
    if (i === -1) return false
    return !s.slice(i).includes('</invoke>')
  }
  // 2026-07-12 新增:检测未闭合的 <tool_use 开标签(Kiro backend 分帧极细,一帧 17 字节就能到达,必须 hold-back)
  // 2026-07-12 升级:支持 3 种错配 close tag(model mimic history 时常混：</tool_use> / </invoke> / </function_calls>)
  const hasOpenToolUse = (s: string): boolean => {
    const i = s.lastIndexOf('<tool_use')
    if (i === -1) return false
    const after = s.slice(i)
    return !after.includes('</tool_use>') && !after.includes('</invoke>') && !after.includes('</function_calls>')
  }
  const hasOpenFunctionResults = (s: string): boolean => {
    const i = s.lastIndexOf('<function_results')
    if (i === -1) return false
    return !s.slice(i).includes('</function_results>')
  }
  const pendingToolTail = (s: string): number => {
    const markers = ['<function_calls>', '<invoke name=', '</invoke>', '</function_calls>', '<parameter name=', '</parameter>', '<tool_use', '</tool_use>', '<function_results', '</function_results>', 'court', 'count', 'call']
    let hold = 0
    for (const tag of markers) {
      for (let k = Math.min(s.length, tag.length - 1); k >= 1; k--) {
        if (s.slice(s.length - k) === tag.slice(0, k)) {
          if (k > hold) hold = k
          break
        }
      }
    }
    const cm = s.match(STRAY_TOKEN_RE)
    if (cm && cm[0].length > hold) hold = cm[0].length
    const cm2 = s.match(/\b(?:court|count|call)\s*<[\s\S]*$/)
    if (cm2 && cm2[0].length > hold) hold = cm2[0].length
    return hold
  }
  // 处理 leakCarry：正常文本经 onChunk 输出，泄漏工具暂存 leakedTools。isFlush 时吐出残留。
  // async：emit await onChunk 以保留 SSE 背压（慢客户端时暂停拉流，避免内存堆积）
  const filterToolLeak = async (isFlush: boolean): Promise<void> => {
    if (toolLeakDebug) {
      const tail = leakCarry.slice(Math.max(0, leakCarry.length - 80))
      console.log(`[tool-leak-fix] filterToolLeak(isFlush=${isFlush}) carry.length=${leakCarry.length} tail=${JSON.stringify(tail)}`)
    }
    const emit = async (s: string): Promise<void> => {
      if (!s) return
      // [LEAK-TO-CLIENT] 如果 emit 到客户端的内容含可疑 XML/stray token pattern = 漏网泄漏到 client 了
      if (toolLeakDebug && SUSPICIOUS_LEAK_PATTERN.test(s)) {
        console.log(`[tool-leak-fix] [LEAK-TO-CLIENT] len=${s.length}:`, JSON.stringify(s.slice(0, 250)))
      }
      await onChunk(s)
      totalOutputChars += s.length
      collectedOutputText += s
    }
    // 提取所有已闭合的 <tool_use>(Anthropic 标准格式,Opus 4.8 常见泄漏)
    // 2026-07-12 升级:close tag 支持 3 种(</tool_use> / </invoke> / </function_calls>) model 混配时也能命中
    for (;;) {
      const fi = leakCarry.indexOf('<tool_use')
      if (fi === -1) break
      // 找最早出现的 close tag(任一种)
      const closeCandidates: Array<{ tag: string; len: number }> = [
        { tag: '</tool_use>', len: '</tool_use>'.length },
        { tag: '</invoke>', len: '</invoke>'.length },
        { tag: '</function_calls>', len: '</function_calls>'.length }
      ]
      let ci = -1
      let closeLen = 0
      for (const cand of closeCandidates) {
        const idx = leakCarry.indexOf(cand.tag, fi)
        if (idx !== -1 && (ci === -1 || idx < ci)) {
          ci = idx
          closeLen = cand.len
        }
      }
      if (ci === -1) break // 未闭合,等更多帧
      const endIdx = ci + closeLen
      const rawBlock = leakCarry.slice(fi, endIdx)
      const tool = parseToolUseBlock(rawBlock)
      if (tool) {
        await emit(leakCarry.slice(0, fi))
        leakedTools.push(tool)
        if (toolLeakDebug) console.log(`[tool-leak-fix] parsed <tool_use name="${tool.name}">, input.keys=[${Object.keys(tool.input).join(',')}], close=${leakCarry.slice(ci, endIdx)}`)
        leakCarry = leakCarry.slice(endIdx)
      } else {
        // 2026-07-12 遗漏修正:Opus 4.8 常见 <tool_use id="..."> 缺 name= 属性 → parseToolUseBlock 返 null
        // 旧代码在这里 await emit(rawBlock) 原样输出 → 客户端收到 raw XML → 误识为已执行 tool → stop_reason=end_turn → 对话直接中断。
        // 新代码:静默剥离不 emit(无 name 无法 rescue,丢弃比中断对话好)；同时 debug log 捕获现场
        await emit(leakCarry.slice(0, fi))
        if (toolLeakDebug) console.log(`[tool-leak-fix] 剥离无 name 的 <tool_use> block 不 emit, len=${endIdx - fi}, raw preview:`, rawBlock.slice(0, 200).replace(/\s+/g, ' '))
        leakCarry = leakCarry.slice(endIdx)
      }
    }
    // 2026-07-12 新增:提取所有已闭合的 <function_results>（Opus 4.8 幻觉的“假 tool result”）
    // 背景:模型自己在文本里 emit `<function_results id="...">Error calling tool ...</function_results>` 假装 tool 已执行 →
    //       客户端（Claude Code）收到会认为 tool 已完成一轮（尽管是幻觉）→ stop_reason=end_turn → 对话直接中断，后续 tool 全失败。
    // 修法:直接剥离整块不 emit 到客户端（不 rescue，因为是幻觉不能重新执行）。
    for (;;) {
      const fi = leakCarry.indexOf('<function_results')
      if (fi === -1) break
      const ci = leakCarry.indexOf('</function_results>', fi)
      if (ci === -1) break // 未闭合,等更多帧
      const endIdx = ci + '</function_results>'.length
      await emit(leakCarry.slice(0, fi))
      if (toolLeakDebug) console.log(`[tool-leak-fix] 剥离幻觉 <function_results> block 不 emit, len=${endIdx - fi}, preview:`, leakCarry.slice(fi, Math.min(fi + 200, endIdx)).replace(/\s+/g, ' '))
      leakCarry = leakCarry.slice(endIdx)
    }
    // 2026-07-12 关键修复:跨帧分片时未闭合的 <tool_use / <function_results 必须 hold-back
    // Kiro backend 分帧极细,一帧 17 字节就可能仅到达 "\n\n<tool_use id=\"t";close tag 可能在 20+ 帧后才拼到。
    // 旧代码仅 <invoke> 有 hasOpenInvoke hold-back,<tool_use / <function_results 无,
    // 导致 leakCarry 里未闭合的 <tool_use 会被 pendingToolTail 误判为 "非 prefix"(尾部 "t" 不匹配 marker prefix)→
    // 整段 emit 到客户端 → XML 泄漏 + 对话中断。
    // 修法:发现未闭合 open tag 时,剥掉它之前的正常文本,leakCarry 保留 open tag 及之后字符,等下一帧拼接 close tag。
    if (hasOpenToolUse(leakCarry)) {
      if (isFlush) {
        await emit(leakCarry)
        leakCarry = ''
        return
      }
      const ti = leakCarry.indexOf('<tool_use')
      const safe = leakCarry.slice(0, ti)
      await emit(safe)
      if (toolLeakDebug) console.log(`[tool-leak-fix] [HOLD-BACK-tool_use] open 无 close,hold-back 从 pos=${ti} 到末尾,carry.length=${leakCarry.length}`)
      leakCarry = leakCarry.slice(ti)
      return
    }
    if (hasOpenFunctionResults(leakCarry)) {
      if (isFlush) {
        await emit(leakCarry)
        leakCarry = ''
        return
      }
      const fi = leakCarry.indexOf('<function_results')
      const safe = leakCarry.slice(0, fi)
      await emit(safe)
      if (toolLeakDebug) console.log(`[tool-leak-fix] [HOLD-BACK-function_results] open 无 close,hold-back 从 pos=${fi} 到末尾,carry.length=${leakCarry.length}`)
      leakCarry = leakCarry.slice(fi)
      return
    }
    // 提取所有已闭合的 invoke
    for (;;) {
      const fi = leakCarry.indexOf('<invoke name=')
      if (fi === -1) break
      const ci = leakCarry.indexOf('</invoke>', fi)
      if (ci === -1) break // 未闭合，等更多帧
      await emit(stripToolPrefix(leakCarry.slice(0, fi)))
      const localRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g
      localRe.lastIndex = fi
      let m: RegExpExecArray | null
      let consumedEnd = ci + '</invoke>'.length
      while ((m = localRe.exec(leakCarry)) !== null) {
        if (m.index > consumedEnd + 30) break
        const tool = parseInvokeBody(m[1], m[2])
        leakedTools.push(tool)
        consumedEnd = m.index + m[0].length
      }
      const fcClose = leakCarry.slice(consumedEnd).match(/^\s*<\/function_calls>/)
      if (fcClose) consumedEnd += fcClose[0].length
      leakCarry = leakCarry.slice(consumedEnd)
    }
    if (hasOpenInvoke(leakCarry)) {
      if (isFlush) {
        // 流结束仍未闭合 = 损坏的工具调用，原样当文本输出（不丢字符）
        await emit(leakCarry)
        leakCarry = ''
        return
      }
      const oi = leakCarry.indexOf('<invoke name=')
      const safe = stripToolPrefix(leakCarry.slice(0, oi))
      await emit(safe)
      leakCarry = leakCarry.slice(safe.length)
      return
    }
    if (isFlush) {
      await emit(leakCarry)
      leakCarry = ''
      return
    }
    const hold = pendingToolTail(leakCarry)
    await emit(leakCarry.slice(0, leakCarry.length - hold))
    leakCarry = leakCarry.slice(leakCarry.length - hold)
  }
  // ===== 工具调用 XML 泄漏修复 end =====

  try {
    throwIfAborted(signal)
    signal?.addEventListener('abort', abort, { once: true })
    while (true) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      throwIfAborted(signal)
      
      if (done) {
        break
      }

      // 合并缓冲区
      const newBuffer = new Uint8Array(buffer.length + value.length)
      newBuffer.set(buffer)
      newBuffer.set(value, buffer.length)
      buffer = newBuffer

      // 尝试解析消息
      while (buffer.length >= 16) {
        // AWS Event Stream 格式：
        // - 4 bytes: total length
        // - 4 bytes: headers length
        // - 4 bytes: prelude CRC
        // - headers
        // - payload
        // - 4 bytes: message CRC

        const totalLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false)
        
        if (buffer.length < totalLength) {
          break // 等待更多数据
        }

        const headersLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(4, false)
        
        // 从 headers 中提取 event type
        const headersStart = 12
        const headersEnd = 12 + headersLength
        const eventType = extractEventType(buffer.slice(headersStart, headersEnd))
        
        // 提取 payload
        const payloadStart = 12 + headersLength
        const payloadEnd = totalLength - 4 // 减去 message CRC
        
        if (payloadStart < payloadEnd) {
          const payloadBytes = buffer.slice(payloadStart, payloadEnd)
          
          try {
            const payloadText = new TextDecoder().decode(payloadBytes)
            const event = JSON.parse(payloadText)
            
            // 根据 event type 处理不同类型的事件
            if (eventType === 'assistantResponseEvent' || event.assistantResponseEvent) {
              const assistantResp = event.assistantResponseEvent || event
              const content = assistantResp.content as string | undefined
              if (content) {
                // [RAW] Kiro backend raw 帧含可疑 XML/stray token,后续追踪过滤是否命中
                if (toolLeakDebug && SUSPICIOUS_LEAK_PATTERN.test(content)) {
                  console.log(`[tool-leak-fix] [RAW-assistantResponseEvent] len=${content.length}:`, JSON.stringify(content.slice(0, 250)))
                }
                if (toolLeakFixEnabled) {
                  // 跨帧过滤:分离正常文本与泄漏的工具调用 XML
                  leakCarry += content
                  await filterToolLeak(false)
                } else {
                  // 回退：原逐帧 <tool_use> 过滤
                  const stripped = content.replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/g, '').trim()
                  if (stripped) {
                    await onChunk(stripped)
                    totalOutputChars += stripped.length
                    collectedOutputText += stripped
                  }
                }
              }
            }

            // AmazonQ CLI 协议特有：CodeEvent (代码片段流式输出)
            // 来自 amzn_qdeveloper_streaming_client 的 ChatResponseStream::CodeEvent { content: String }
            // CodeWhisperer/AmazonQ 端点用 AssistantResponseEvent 包代码，CLI 端点单独用 CodeEvent
            if (eventType === 'codeEvent' || event.codeEvent) {
              const codeResp = event.codeEvent || event
              const content = codeResp.content as string | undefined
              if (content) {
                if (toolLeakDebug && SUSPICIOUS_LEAK_PATTERN.test(content)) {
                  console.log(`[tool-leak-fix] [RAW-codeEvent] len=${content.length}:`, JSON.stringify(content.slice(0, 250)))
                }
                if (toolLeakFixEnabled) {
                  leakCarry += content
                  await filterToolLeak(false)
                } else {
                  const stripped = content.replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/g, '').trim()
                  if (stripped) {
                    await onChunk(stripped)
                    totalOutputChars += stripped.length
                    collectedOutputText += stripped
                  }
                }
              }
            }
            
            if (eventType === 'toolUseEvent' || event.toolUseEvent) {
              const toolUseData = event.toolUseEvent || event
              const toolUseId = toolUseData.toolUseId
              const toolName = toolUseData.name
              const isStop = toolUseData.stop === true
              
              // 获取输入 - 可能是字符串片段或完整对象
              let inputFragment = ''
              let inputObj: Record<string, unknown> | null = null
              if (typeof toolUseData.input === 'string') {
                inputFragment = toolUseData.input
              } else if (typeof toolUseData.input === 'object' && toolUseData.input !== null) {
                inputObj = toolUseData.input
              }
              
              // 新的 tool use 开始
              if (toolUseId && toolName) {
                if (currentToolUse && currentToolUse.toolUseId !== toolUseId) {
                  // 前一个 tool use 被中断，完成它
                  if (!processedIds.has(currentToolUse.toolUseId)) {
                    let finalInput: Record<string, unknown> = {}
                    try {
                      if (currentToolUse.inputBuffer) {
                        finalInput = JSON.parse(currentToolUse.inputBuffer)
                      }
                    } catch { /* 忽略解析错误 */ }
                    await onChunk('', {
                      toolUseId: currentToolUse.toolUseId,
                      name: currentToolUse.name,
                      input: finalInput
                    })
                    if (toolLeakFixEnabled) {
                      try { seenToolSigs.add(toolSig(currentToolUse.name, finalInput)) } catch { /* ignore */ }
                    }
                    totalOutputChars += currentToolUse.name.length + currentToolUse.inputBuffer.length
                    processedIds.add(currentToolUse.toolUseId)
                  }
                  currentToolUse = null
                }
                
                if (!currentToolUse) {
                  if (processedIds.has(toolUseId)) {
                    // 跳过重复的 tool use
                  } else {
                    currentToolUse = {
                      toolUseId,
                      name: toolName,
                      inputBuffer: ''
                    }
                  }
                }
              }
              
              // 累积输入片段
              if (currentToolUse && inputFragment) {
                currentToolUse.inputBuffer += inputFragment
              }
              
              // 如果直接提供了完整输入对象
              if (currentToolUse && inputObj) {
                currentToolUse.inputBuffer = JSON.stringify(inputObj)
              }
              
              // Tool use 完成
              if (isStop && currentToolUse) {
                let finalInput: Record<string, unknown> = {}
                let parseError = false
                try {
                  if (currentToolUse.inputBuffer) {
                    if (logStreamEvents) proxyLogger.debug('Kiro', 'Tool input buffer: ' + currentToolUse.inputBuffer.substring(0, 200))
                    finalInput = JSON.parse(currentToolUse.inputBuffer)
                    if (logStreamEvents) proxyLogger.debug('Kiro', 'Parsed tool input: ' + JSON.stringify(finalInput).substring(0, 200))
                  }
                } catch (e) {
                  parseError = true
                  console.error('[Kiro] Failed to parse tool input:', e, 'Buffer:', currentToolUse.inputBuffer?.substring(0, 100))
                  // 当 JSON 解析失败时，创建一个包含错误信息的 input
                  // 这样客户端可以看到工具调用失败的原因
                  finalInput = {
                    _error: 'Tool input truncated by Kiro API (output token limit exceeded)',
                    _partialInput: currentToolUse.inputBuffer?.substring(0, 500) || ''
                  }
                }
                
                // 只有在成功解析或有错误信息时才发送
                await onChunk('', {
                  toolUseId: currentToolUse.toolUseId,
                  name: currentToolUse.name,
                  input: finalInput
                })
                if (toolLeakFixEnabled && !parseError) {
                  try { seenToolSigs.add(toolSig(currentToolUse.name, finalInput)) } catch { /* ignore */ }
                }
                totalOutputChars += currentToolUse.name.length + currentToolUse.inputBuffer.length

                // 如果解析失败，额外发送一条文本消息告知用户
                if (parseError) {
                  await onChunk(`\n\n⚠️ Tool "${currentToolUse.name}" input was truncated by Kiro API. The output may be incomplete due to token limits.`)
                }
                
                processedIds.add(currentToolUse.toolUseId)
                currentToolUse = null
              }
            }
            
            // 处理 messageMetadataEvent - 包含 token 使用量
            if (eventType === 'messageMetadataEvent' || eventType === 'metadataEvent' || event.messageMetadataEvent || event.metadataEvent) {
              const metadata = event.messageMetadataEvent || event.metadataEvent || event
              proxyLogger.info('Kiro', 'messageMetadataEvent', metadata)
              
              // 检查 tokenUsage 对象
              if (metadata.tokenUsage) {
                const tokenUsage = metadata.tokenUsage
                proxyLogger.info('Kiro', 'tokenUsage', tokenUsage)
                // 计算 inputTokens = uncachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens
                const uncached = tokenUsage.uncachedInputTokens || 0
                const cacheRead = tokenUsage.cacheReadInputTokens || 0
                const cacheWrite = tokenUsage.cacheWriteInputTokens || 0
                const calculatedInput = uncached + cacheRead + cacheWrite
                
                if (calculatedInput > 0) {
                  usage.inputTokens = calculatedInput
                  hasRealTokenUsage = true  // 真实值，锁定不再被 contextUsage/tiktoken 覆盖
                }
                if (tokenUsage.outputTokens) usage.outputTokens = tokenUsage.outputTokens
                if (tokenUsage.totalTokens) {
                  // 如果有 totalTokens，用它来推算
                  if (usage.inputTokens === 0 && usage.outputTokens > 0) {
                    usage.inputTokens = tokenUsage.totalTokens - usage.outputTokens
                    hasRealTokenUsage = true
                  }
                }
                
                // 保存 cache tokens
                usage.cacheReadTokens = cacheRead
                usage.cacheWriteTokens = cacheWrite
                
                // 记录上下文使用百分比
                if (tokenUsage.contextUsagePercentage !== undefined) {
                  proxyLogger.info('Kiro', 'Context usage: ' + tokenUsage.contextUsagePercentage.toFixed(2) + '%')
                }
                
                // 详细的 token 分解日志
                proxyLogger.info('Kiro', 'Token breakdown', {
                  uncached,
                  cacheRead,
                  cacheWrite,
                  inputTotal: calculatedInput,
                  output: tokenUsage.outputTokens || 0,
                  total: tokenUsage.totalTokens || 0,
                  contextUsage: tokenUsage.contextUsagePercentage ? `${tokenUsage.contextUsagePercentage.toFixed(2)}%` : 'N/A'
                })
              }
              
              // 直接在 metadata 中的 tokens
              if (metadata.inputTokens) {
                usage.inputTokens = metadata.inputTokens
                hasRealTokenUsage = true
              }
              if (metadata.outputTokens) usage.outputTokens = metadata.outputTokens
            }
            
            if (logStreamEvents) {
              // 聚合流式事件（不逐条输出，在 onComplete 时输出摘要）
              streamEventCounts[eventType || 'unknown'] = (streamEventCounts[eventType || 'unknown'] || 0) + 1
            }
            
            // 处理 usageEvent
            if (eventType === 'usageEvent' || eventType === 'usage' || event.usageEvent || event.usage) {
              const usageData = event.usageEvent || event.usage || event
              if (usageData.inputTokens) {
                usage.inputTokens = usageData.inputTokens
                hasRealTokenUsage = true
              }
              if (usageData.outputTokens) usage.outputTokens = usageData.outputTokens
            }
            
            // 处理 meteringEvent - Kiro API 返回 credit 使用量
            if (eventType === 'meteringEvent' || event.meteringEvent) {
              const metering = event.meteringEvent || event
              if (metering.usage && typeof metering.usage === 'number') {
                // 累加 credit 使用量
                usage.credits += metering.usage
                proxyLogger.info('Kiro', `meteringEvent - credit: ${metering.usage}, total: ${usage.credits}`)
              }
            }
            
            // 处理 supplementaryWebLinksEvent - 网页链接引用
            if (eventType === 'supplementaryWebLinksEvent' || event.supplementaryWebLinksEvent) {
              const webLinksEvent = event.supplementaryWebLinksEvent || event
              if (webLinksEvent.supplementaryWebLinks && Array.isArray(webLinksEvent.supplementaryWebLinks)) {
                // 格式化网页链接引用
                const links = webLinksEvent.supplementaryWebLinks
                  .filter((link: { url?: string; title?: string; snippet?: string }) => link.url)
                  .map((link: { url?: string; title?: string; snippet?: string }) => {
                    const title = link.title || link.url
                    return `- [${title}](${link.url})`
                  })
                if (links.length > 0) {
                  await onChunk(`\n\n🔗 **Web References:**\n${links.join('\n')}`)
                }
              }
              proxyLogger.debug('Kiro', 'supplementaryWebLinksEvent', JSON.stringify(webLinksEvent).slice(0, 300))
            }
            
            // 处理 contextUsageEvent - 上下文使用百分比 + breakdown（Conversation/MCP tools/Steering files）
            if (eventType === 'contextUsageEvent' || event.contextUsageEvent) {
              const contextEvent = event.contextUsageEvent || event
              if (contextEvent.contextUsagePercentage !== undefined) {
                const percentage = contextEvent.contextUsagePercentage
                // 捕获 breakdown 并存入 usage.contextUsage
                usage.contextUsage = {
                  percentage,
                  breakdown: contextEvent.breakdown ? {
                    conversation: contextEvent.breakdown.conversation,
                    mcpTools: contextEvent.breakdown.mcpTools,
                    steeringFiles: contextEvent.breakdown.steeringFiles
                  } : undefined
                }
                // 若已拿到真实 tokenUsage，仅记录百分比，不覆盖 inputTokens
                if (hasRealTokenUsage) {
                  proxyLogger.info('Kiro', `contextUsageEvent - Context usage: ${percentage.toFixed(2)}% (real tokenUsage already received)`)
                } else {
                  // 反推真实 inputTokens：modelContext × percentage / 100
                  const contextLen = getModelContextLength(modelId)
                  const reverseInput = Math.round(contextLen * percentage / 100)
                  if (reverseInput > 0) {
                    usage.inputTokens = reverseInput
                    proxyLogger.info('Kiro', `contextUsageEvent ${percentage.toFixed(2)}% → inputTokens=${reverseInput} (modelContext=${contextLen}, model=${modelId || 'unknown'})`)
                  } else {
                    proxyLogger.info('Kiro', `contextUsageEvent - Context usage: ${percentage.toFixed(2)}%`)
                  }
                }
                if (usage.contextUsage.breakdown) {
                  proxyLogger.info('Kiro', `contextUsage breakdown: conversation=${usage.contextUsage.breakdown.conversation || 0}% mcpTools=${usage.contextUsage.breakdown.mcpTools || 0}% steering=${usage.contextUsage.breakdown.steeringFiles || 0}%`)
                }
                // 如果上下文使用率超过 80%，发送警告
                if (percentage > 80) {
                  console.warn('[Kiro] Warning: Context usage is high:', percentage.toFixed(2) + '%')
                }
              }
            }
            
            // 处理 reasoningContentEvent - Thinking 模式的推理内容
            // Kiro ReasoningContentEvent 字段：[text, redactedContent, signature]
            if (eventType === 'reasoningContentEvent' || event.reasoningContentEvent) {
              const reasoning = event.reasoningContentEvent || event
              if (reasoning.text) {
                proxyLogger.info('Kiro', `Received reasoning content (isThinking=true): ${reasoning.text.slice(0, 50)}...`)
                await onChunk(reasoning.text, undefined, true, reasoning.signature, undefined)
                totalOutputChars += reasoning.text.length
                usage.reasoningTokens = (usage.reasoningTokens || 0) + Math.max(1, Math.round(reasoning.text.length * 0.4))
              } else if (reasoning.signature && !reasoning.redactedContent) {
                await onChunk('', undefined, true, reasoning.signature, undefined)
              }
              // 处理 redactedContent（重编辑的加密 thinking 内容）
              if (reasoning.redactedContent) {
                proxyLogger.info('Kiro', `Received redacted thinking content (len=${reasoning.redactedContent.length})`)
                await onChunk('', undefined, true, undefined, reasoning.redactedContent)
              }
              proxyLogger.debug('Kiro', 'reasoningContentEvent', JSON.stringify(reasoning).slice(0, 200))
            }
            
            // 处理 codeReferenceEvent - 代码引用/许可证信息
            if (eventType === 'codeReferenceEvent' || event.codeReferenceEvent) {
              const codeRef = event.codeReferenceEvent || event
              if (codeRef.references && Array.isArray(codeRef.references)) {
                // 格式化代码引用信息
                const refTexts = codeRef.references
                  .filter((ref: { licenseName?: string; repository?: string; url?: string }) => ref.licenseName || ref.repository)
                  .map((ref: { licenseName?: string; repository?: string; url?: string }) => {
                    const parts: string[] = []
                    if (ref.licenseName) parts.push(`License: ${ref.licenseName}`)
                    if (ref.repository) parts.push(`Repo: ${ref.repository}`)
                    if (ref.url) parts.push(`URL: ${ref.url}`)
                    return parts.join(', ')
                  })
                if (refTexts.length > 0) {
                  await onChunk(`\n\n📚 **Code References:**\n${refTexts.join('\n')}`)
                }
              }
              proxyLogger.debug('Kiro', 'codeReferenceEvent', JSON.stringify(codeRef).slice(0, 300))
            }
            
            // 处理 followupPromptEvent - 后续提示建议
            if (eventType === 'followupPromptEvent' || event.followupPromptEvent) {
              const followup = event.followupPromptEvent || event
              if (followup.followupPrompt) {
                const prompt = followup.followupPrompt
                if (prompt.content || prompt.userIntent) {
                  // 将后续提示作为建议输出
                  const suggestion = prompt.content || prompt.userIntent
                  await onChunk(`\n\n💡 **Suggested follow-up:** ${suggestion}`)
                }
              }
              proxyLogger.debug('Kiro', 'followupPromptEvent', JSON.stringify(followup).slice(0, 200))
            }
            
            // 处理 intentsEvent - 意图事件（artifact、deeplinks 等）
            if (eventType === 'intentsEvent' || event.intentsEvent) {
              const intents = event.intentsEvent || event
              // 意图事件主要用于 UI 渲染，记录日志即可
              proxyLogger.debug('Kiro', 'intentsEvent', JSON.stringify(intents).slice(0, 300))
            }
            
            // 处理 interactionComponentsEvent - 交互组件事件
            if (eventType === 'interactionComponentsEvent' || event.interactionComponentsEvent) {
              const components = event.interactionComponentsEvent || event
              // 交互组件主要用于 UI 渲染，记录日志即可
              proxyLogger.debug('Kiro', 'interactionComponentsEvent', JSON.stringify(components).slice(0, 300))
            }
            
            // 处理 invalidStateEvent - 无效状态事件（错误处理）
            if (eventType === 'invalidStateEvent' || event.invalidStateEvent) {
              const invalid = event.invalidStateEvent || event
              const reason = invalid.reason || 'UNKNOWN'
              const message = invalid.message || 'Invalid state detected'
              console.error('[Kiro] invalidStateEvent:', reason, message)
              // 将无效状态作为错误消息输出
              await onChunk(`\n\n⚠️ **Warning:** ${message} (reason: ${reason})`)
            }
            
            // 处理 citationEvent - 引用事件
            if (eventType === 'citationEvent' || event.citationEvent) {
              const citation = event.citationEvent || event
              if (citation.citations && Array.isArray(citation.citations)) {
                // 格式化引用信息
                const citationTexts = citation.citations
                  .filter((c: { title?: string; url?: string; content?: string }) => c.title || c.url)
                  .map((c: { title?: string; url?: string; content?: string }, i: number) => {
                    const parts = [`[${i + 1}]`]
                    if (c.title) parts.push(c.title)
                    if (c.url) parts.push(`(${c.url})`)
                    return parts.join(' ')
                  })
                if (citationTexts.length > 0) {
                  await onChunk(`\n\n📖 **Citations:**\n${citationTexts.join('\n')}`)
                }
              }
              proxyLogger.debug('Kiro', 'citationEvent', JSON.stringify(citation).slice(0, 300))
            }
            
            // 检查错误
            if (event._type || event.error) {
              const errMsg = event.message || event.error?.message || 'Unknown stream error'
              throw new Error(errMsg)
            }
          } catch (parseError) {
            if (parseError instanceof SyntaxError) {
              // JSON 解析错误，忽略
              console.debug('[EventStream] JSON parse error:', parseError)
            } else {
              throw parseError
            }
          }
        }
        
        // 移动到下一条消息
        buffer = buffer.slice(totalLength)
      }
    }

    // 工具调用 XML 泄漏修复：flush 过滤器残留文本
    if (toolLeakFixEnabled) {
      try { await filterToolLeak(true) } catch { /* ignore */ }
    }

    // 完成任何未完成的 tool use
    if (currentToolUse && !processedIds.has(currentToolUse.toolUseId)) {
      let finalInput: Record<string, unknown> = {}
      try {
        if (currentToolUse.inputBuffer) {
          finalInput = JSON.parse(currentToolUse.inputBuffer)
        }
      } catch { /* 忽略解析错误 */ }
      await onChunk('', {
        toolUseId: currentToolUse.toolUseId,
        name: currentToolUse.name,
        input: finalInput
      })
      if (toolLeakFixEnabled) {
        try { seenToolSigs.add(toolSig(currentToolUse.name, finalInput)) } catch { /* ignore */ }
      }
      totalOutputChars += currentToolUse.name.length + currentToolUse.inputBuffer.length
    }

    // 工具调用 XML 泄漏修复：流结束统一去重后注入救回的工具
    // 与已见的结构化 toolUseEvent 同名同参的丢弃（避免重复执行），其余注入为结构化 tool_use
    if (toolLeakFixEnabled && leakedTools.length > 0) {
      let rescued = 0
      let deduped = 0
      for (const lt of leakedTools) {
        let sig: string
        try { sig = toolSig(lt.name, lt.input) } catch { sig = lt.name + '|?' }
        if (seenToolSigs.has(sig)) {
          deduped++
          if (toolLeakDebug) console.log(`[tool-leak-fix] [DEDUP-SKIP] name=${lt.name} sig=${sig.slice(0, 100)}`)
          continue
        }
        seenToolSigs.add(sig)
        leakIdCounter++
        const rescuedId = `toolleakfix_${Date.now().toString(36)}_${leakIdCounter.toString(36)}`
        if (toolLeakDebug) console.log(`[tool-leak-fix] [RESCUE] id=${rescuedId} name=${lt.name} input=${JSON.stringify(lt.input).slice(0, 200)}`)
        await onChunk('', { toolUseId: rescuedId, name: lt.name, input: lt.input })
        rescued++
      }
      if (rescued > 0 || toolLeakDebug) {
        proxyLogger.info('Kiro', `Tool-leak-fix: leaked=${leakedTools.length} rescued=${rescued} deduped=${deduped} seen_sigs=${seenToolSigs.size}`)
      }
    }

    // 如果 API 没有返回 token 信息，优先用 tiktoken 精确计算，兜底字符系数
    if (usage.outputTokens === 0 && totalOutputChars > 0) {
      if (collectedOutputText) {
        // tiktoken cl100k_base 精确计算（±5%）
        usage.outputTokens = Math.max(1, countTokens(collectedOutputText))
        proxyLogger.info('Kiro', `Estimated output tokens (tiktoken): ${totalOutputChars} chars -> ${usage.outputTokens} tokens`)
      } else {
        // 字符系数兜底（自然语言中英混合约 0.4 token/字符）
        usage.outputTokens = Math.max(1, Math.round(totalOutputChars * 0.4))
        proxyLogger.info('Kiro', `Estimated output tokens (fallback): ${totalOutputChars} chars -> ${usage.outputTokens} tokens`)
      }
    }
    
    // 流式事件聚合摘要
    if (logStreamEvents && Object.keys(streamEventCounts).length > 0) {
      const total = Object.values(streamEventCounts).reduce((a, b) => a + b, 0)
      proxyLogger.debug('Kiro', `Stream events summary (${total} total)`, streamEventCounts)
    }
    
    throwIfAborted(signal)
    proxyLogger.info('Kiro', 'Stream complete, final usage', usage)
    onComplete(usage)
  } catch (error) {
    // [STREAM-ERROR] 调试:看 stream 提前中断的根因(filterToolLeak 抛错 / event 解析异常 / abort)
    if (toolLeakDebug) console.log(`[tool-leak-fix] [STREAM-ERROR]`, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    onError(signal?.aborted ? getAbortError(signal) : error as Error)
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

// 非流式调用（等待完整响应）
export async function callKiroApi(
  account: ProxyAccount,
  payload: KiroPayload,
  signal?: AbortSignal
): Promise<{
  content: string
  toolUses: KiroToolUse[]
  usage: KiroUsage
  reasoningContent?: { text?: string; signature?: string; redactedContent?: string }
}> {
  return new Promise((resolve, reject) => {
    let content = ''
    let reasoningText = ''
    let reasoningSignature: string | undefined
    let redactedContent = ''
    const toolUses: KiroToolUse[] = []
    let usage: KiroUsage = { inputTokens: 0, outputTokens: 0, credits: 0 }

    callKiroApiStream(
      account,
      payload,
      (text, toolUse, isThinking, signature, redacted) => {
        if (isThinking) {
          if (text) reasoningText += text
          if (signature) reasoningSignature = signature
          if (redacted) redactedContent += redacted
        } else {
          content += text
        }
        if (toolUse) {
          toolUses.push(toolUse)
        }
      },
      (u) => {
        usage = u
        if (reasoningText || redactedContent) {
          const rc: { text?: string; signature?: string; redactedContent?: string } = {}
          if (reasoningText) rc.text = reasoningText
          if (reasoningSignature) rc.signature = reasoningSignature
          if (redactedContent) rc.redactedContent = redactedContent
          resolve({ content, toolUses, usage, reasoningContent: rc })
          return
        }
        resolve({ content, toolUses, usage })
      },
      reject,
      signal
    ).catch(reject)
  })
}

// Kiro 官方模型信息
export interface KiroModel {
  modelId: string
  modelName: string
  description: string
  modelProvider?: string | null
  rateMultiplier?: number
  rateUnit?: string
  status?: string | null
  supportedInputTypes?: string[]
  tokenLimits?: {
    maxInputTokens?: number | null
    maxOutputTokens?: number | null
  }
  promptCaching?: {
    supportsPromptCaching: boolean
    maximumCacheCheckpointsPerRequest?: number | null
    minimumTokensPerCacheCheckpoint?: number | null
  } | null
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null
  availableOrigins?: string[] | null
}

// ============ 跨账户共享模型 catalog(2026-07 迁移) ============
//
// 背景:AWS 端 IdC provisioning 限制导致某些账户(如 eu-central-1 IdC)accessToken
// 无法通过 management.us-east-1.kiro.dev 的 controlplane 校验(403 Invalid token),
// 即使换任何 profileArn 也一样;而同一账户的 stream API(runtime.*.kiro.dev)则完全通过。
//
// 策略:任何账户 fetchKiroModels 成功 → 写入此模块级缓存;
//        后续失败账户 → 读缓存,让用户至少能看到“KAC 里已知的完整模型清单”。
// NEVER 硬编码模型清单(过时/不真实/无 rate multiplier/context window 等元数据)。
//
// 实测(2026-07-12):us 账户 GET /ListAvailableModels 返 15 个真实模型
// (含 claude-sonnet-5/opus-4.8/rate multiplier/context window 完整元数据);
// eu 账户 403,回落此共享 catalog 显示同样 15 个,反代 stream 依然可用。
//
// TTL 30 min:模型 catalog 变化频率低于单账户缓存的 5 min,给用户提供更稳定 UI。
// 详见 .agent-workspace/.archive/2026-07-12/kiro-endpoint-migration/*-rca.md

interface SharedModelCatalog {
  models: KiroModel[]
  timestamp: number
  sourceEmail?: string  // 来源账户,用于日志和潜在的 UI 提示
}
const SHARED_MODEL_CATALOG_TTL_MS = 30 * 60 * 1000
let sharedModelCatalog: SharedModelCatalog | null = null

function getSharedModelCatalog(): SharedModelCatalog | null {
  if (!sharedModelCatalog) return null
  if (Date.now() - sharedModelCatalog.timestamp > SHARED_MODEL_CATALOG_TTL_MS) return null
  return sharedModelCatalog
}

function setSharedModelCatalog(models: KiroModel[], account: ProxyAccount): void {
  if (!models || models.length === 0) return
  sharedModelCatalog = {
    models: models.map(m => ({ ...m })),
    timestamp: Date.now(),
    sourceEmail: account.email
  }
  console.log(`[KiroAPI] Shared model catalog updated: ${models.length} models from ${account.email || account.id.slice(0, 8)}`)
}

/** 外部可读(供其它模块如 UI 层使用),返回当前共享 catalog 的 clone 或 null */
export function getSharedModelCatalogSnapshot(): KiroModel[] | null {
  const shared = getSharedModelCatalog()
  return shared ? shared.models.map(m => ({ ...m })) : null
}

// 2026-07 迁移:q.{region}.amazonaws.com → management.{region}.kiro.dev(per-region)
// 此函数用于元数据 API(ListAvailableModels/Subscriptions/CreateSubscriptionToken/setUserPreference),
// stream 端点由 KIRO_ENDPOINTS 数组独立管理。
// 实测:eu 账户发到 us-east-1 host 会 403 Invalid token,必须按账户 region 分发。
function getQServiceEndpoint(region?: string): string {
  return getKiroManagementHost(region)
}

// 2026-07 迁移:codewhisperer.{region}.amazonaws.com → management.{region}.kiro.dev(per-region)
// 此函数用于 fetchEnterpriseProfileArn 调 ListAvailableProfiles。
function getCodeWhispererEndpoint(region?: string): string {
  return getKiroManagementHost(region)
}

/**
 * Enterprise 账号获取 profileArn（通过 CodeWhisperer Runtime 的 /ListAvailableProfiles）
 * 官方 IDE 在认证后通过此 API 获取可用 profiles，用户选择后存储 ARN。
 * 反代自动取第一个 profile。
 */
export async function fetchEnterpriseProfileArn(account: ProxyAccount): Promise<string | undefined> {
  const baseUrl = getCodeWhispererEndpoint(account.region)
  const url = `${baseUrl}/ListAvailableProfiles`
  const machineId = getAccountMachineId(account.id, account.machineId)

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-amz-json-1.0',
    'Authorization': `Bearer ${account.accessToken}`,
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'user-agent': getKiroUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  // external_idp (Azure AD) 需 TokenType header 走外部 IdP 校验路径，否则 CW REST 拒 403 "Invalid token"
  // 2026-07 迁移:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
  headers['TokenType'] = getTokenTypeHeader(account)

  // 获取该账号类型对应的备用 ARN（403 时兜底，避免每次请求都重复尝试）
  const fallbackArn = resolveProfileArn(account)

  try {
    const response = await fetchWithProxy(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    }, account)

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      console.error(`[KiroAPI] ListAvailableProfiles failed: ${response.status}`, errBody.slice(0, 200))
      // 403 = 无权限（BuilderId/Social 账号不支持此 API）→ 返回备用 ARN 作为缓存，不再重复尝试
      if (response.status === 403 && fallbackArn) {
        console.log(`[KiroAPI] Using fallback profileArn for ${account.provider || 'unknown'}: ${fallbackArn}`)
        return fallbackArn
      }
      return undefined
    }

    const data = await response.json() as { profiles?: Array<{ arn?: string; profileName?: string }> }
    const profiles = data.profiles || []
    if (profiles.length === 0) {
      console.warn('[KiroAPI] ListAvailableProfiles: no profiles returned')
      return undefined
    }

    const arn = profiles[0].arn
    if (arn) {
      console.log(`[KiroAPI] Enterprise profileArn resolved: ${arn}`)
    }
    return arn || undefined
  } catch (error) {
    console.error('[KiroAPI] fetchEnterpriseProfileArn error:', error)
    return undefined
  }
}

// 获取 Kiro 官方模型列表（支持分页，与官方插件一致传递 profileArn）
export async function fetchKiroModels(account: ProxyAccount, signal?: AbortSignal): Promise<KiroModel[]> {
  const baseUrl = getQServiceEndpoint(account.region)
  const machineId = getAccountMachineId(account.id, account.machineId)
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': getKiroUserAgent(machineId),
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'x-amzn-codewhisperer-optout': 'true',
    // 补齐官方 Kiro IDE / AWS SDK 标准请求头 —— eu-central-1 等区域端点前置校验更严
    // 缺失这些 header 时会以通用 403 "Invalid token" 拒绝,不是 token 真的无效
    // 参考同文件 fetchEnterpriseProfileArn / 订阅函数 / 主流式接口(均已带这三个 header)
    'x-amzn-kiro-agent-mode': getAgentMode(),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  // external_idp (Azure AD) 需 TokenType header，否则 ListAvailableModels 403 "Invalid token"
  // 2026-07 迁移:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
  headers['TokenType'] = getTokenTypeHeader(account)

  const allModels: KiroModel[] = []
  let nextToken: string | undefined

  // Enterprise 缺 profileArn 时调 API 获取；BuilderId/Social 不需要（resolveProfileArn 会兜底）
  const isEnterprise = account.provider === 'Enterprise' || account.authMethod === 'external_idp'
  if (!account.profileArn && isEnterprise) {
    const fetchedArn = await fetchEnterpriseProfileArn(account)
    if (fetchedArn) {
      account.profileArn = fetchedArn
      if (account.id) profileArnPersistCallback?.(account.id, fetchedArn)
    }
  }

  try {
    do {
      const params = new URLSearchParams({ origin: 'AI_EDITOR', maxResults: '50' })
      const arnForModels = resolveProfileArn(account)
      // profileArn 决策由 resolveProfileArn 统一处理：
      //   - BuilderId → 占位符 ARN（ListAvailableModels 需要，有效）
      //   - Github/Google → social ARN（有效）
      //   - Enterprise → 真实 ARN（上方已自愈获取）
      if (arnForModels) params.set('profileArn', arnForModels)
      if (nextToken) params.set('nextToken', nextToken)

      const url = `${baseUrl}/ListAvailableModels?${params.toString()}`
      // 诊断日志:临时打印请求上下文(修 eu-central-1 刷模型问题用,验证通过后可移除)
      console.log(`[KiroAPI] ListAvailableModels →`, {
        url,
        region: account.region,
        profileArn: arnForModels,
        provider: account.provider,
        authMethod: account.authMethod,
        agentMode: headers['x-amzn-kiro-agent-mode'],
        accessTokenPreview: account.accessToken ? `${account.accessToken.slice(0, 20)}...${account.accessToken.slice(-10)}` : '(empty)'
      })
      throwIfAborted(signal)
      const response = await fetchWithProxy(url, { method: 'GET', headers, signal }, account)
      throwIfAborted(signal)
      
      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        // 诊断日志:失败时打印完整上下文 + response headers,便于定位是端点/token/参数哪一层的问题
        console.error(`[KiroAPI] ListAvailableModels failed: ${response.status}`, {
          url,
          region: account.region,
          profileArn: arnForModels,
          provider: account.provider,
          authMethod: account.authMethod,
          errBody: errBody.slice(0, 500),
          responseHeaders: Object.fromEntries(response.headers.entries())
        })
        // 2026-07 迁移:单账户失败(如 eu IdC provisioning 限制)→ 读跨账户共享 catalog
        // (由其它成功账户填充,例如同一 KAC 里的 us 账户)
        if (allModels.length === 0) {
          const shared = getSharedModelCatalog()
          if (shared) {
            console.warn(`[KiroAPI] Fetch failed, using shared catalog (${shared.models.length} models from ${shared.sourceEmail})`)
            return shared.models.map(m => ({ ...m }))
          }
          console.warn('[KiroAPI] Fetch failed and no shared catalog available; returning empty list (UI 将提示先用其它账户刷一次)')
        }
        break
      }

      const data = await response.json()
      allModels.push(...(data.models || []))
      nextToken = data.nextToken
    } while (nextToken)

    // 2026-07 迁移:成功 fetch → 写入跨账户共享 catalog(供其它 fetch 失败的账户读取)
    if (allModels.length > 0) {
      setSharedModelCatalog(allModels, account)
    }
    return allModels
  } catch (error) {
    if (signal?.aborted) throw getAbortError(signal)
    console.error('[KiroAPI] ListAvailableModels error:', error)
    // 2026-07 迁移:网络错误/host 不可达时 → 读跨账户共享 catalog
    if (allModels.length === 0) {
      const shared = getSharedModelCatalog()
      if (shared) {
        console.warn(`[KiroAPI] Network error, using shared catalog (${shared.models.length} models from ${shared.sourceEmail})`)
        return shared.models.map(m => ({ ...m }))
      }
    }
    return allModels
  }
}

// 订阅计划信息
export interface SubscriptionPlan {
  name: string  // KIRO_FREE, KIRO_PRO, KIRO_PRO_PLUS, KIRO_POWER
  qSubscriptionType: string
  description: {
    title: string
    billingInterval: string
    featureHeader: string
    features: string[]
  }
  pricing: {
    amount: number
    currency: string
  }
}

// 订阅列表响应
export interface SubscriptionListResponse {
  disclaimer?: string[]
  subscriptionPlans?: SubscriptionPlan[]
}

// 订阅请求专用 User-Agent（匹配 Kiro IDE 实际报文格式）
const KIRO_SUBSCRIPTION_VERSION = '0.12.155'

function getSubscriptionUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}-${machineId}` : `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}`
  return `aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.19043 lang/js md/nodejs#22.22.0 api/codewhispererruntime#1.0.0 m/N,E ${suffix}`
}

function getSubscriptionAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}-${machineId}` : `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}`
  return `aws-sdk-js/1.0.0 ${suffix}`
}

// 获取可用订阅列表
export async function fetchAvailableSubscriptions(account: ProxyAccount): Promise<SubscriptionListResponse> {
  const baseUrl = getQServiceEndpoint(account.region)
  const url = `${baseUrl}/listAvailableSubscriptions`
  const machineId = getAccountMachineId(account.id, account.machineId)
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'user-agent': getSubscriptionUserAgent(machineId),
    'x-amz-user-agent': getSubscriptionAmzUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  // external_idp (Azure AD) 需 TokenType header 走外部 IdP 校验路径
  // 2026-07 迁移:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
  headers['TokenType'] = getTokenTypeHeader(account)

  const profileArn = resolveProfileArn(account)
  const body = JSON.stringify(profileArn ? { profileArn } : {})

  console.log(`[KiroAPI] ListAvailableSubscriptions [${account.email || account.id.slice(0, 8)}]`, {
    url,
    hasProfileArn: profileArn !== undefined
  })

  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body }, account)
    const responseText = await response.text()
    console.log(`[KiroAPI] ListAvailableSubscriptions → ${response.status}`, JSON.parse(responseText))
    
    if (!response.ok) {
      return {}
    }

    return JSON.parse(responseText)
  } catch (error) {
    console.error('[KiroAPI] ListAvailableSubscriptions error:', error)
    return {}
  }
}

// 订阅 Token 响应
export interface SubscriptionTokenResponse {
  encodedVerificationUrl?: string
  status?: string
  token?: string | null
  message?: string
}

// 获取订阅管理/支付链接
export async function fetchSubscriptionToken(
  account: ProxyAccount,
  subscriptionType?: string
): Promise<SubscriptionTokenResponse> {
  const baseUrl = getQServiceEndpoint(account.region)
  const url = `${baseUrl}/CreateSubscriptionToken`
  const machineId = getAccountMachineId(account.id, account.machineId)
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'user-agent': getSubscriptionUserAgent(machineId),
    'x-amz-user-agent': getSubscriptionAmzUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  // external_idp (Azure AD) 需 TokenType header
  // 2026-07 迁移:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
  headers['TokenType'] = getTokenTypeHeader(account)

  const profileArn = resolveProfileArn(account)

  // clientToken 是必需参数；profileArn 仅在解析出有效值时附带
  const payload: Record<string, string> = {
    clientToken: uuidv4(),
    provider: 'STRIPE'
  }
  if (profileArn) {
    payload.profileArn = profileArn
  }
  if (subscriptionType) {
    payload.subscriptionType = subscriptionType
  }

  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body: JSON.stringify(payload) }, account)
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error('[KiroAPI] CreateSubscriptionToken failed:', response.status, errorData)
      return { message: errorData.message || `Request failed with status ${response.status}` }
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error('[KiroAPI] CreateSubscriptionToken error:', error)
    return { message: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 设置用户偏好（超额开启/关闭）
export async function setUserPreference(
  account: ProxyAccount,
  overageStatus: 'ENABLED' | 'DISABLED'
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = getQServiceEndpoint(account.region)
  const url = `${baseUrl}/setUserPreference`
  const machineId = getAccountMachineId(account.id, account.machineId)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'user-agent': getSubscriptionUserAgent(machineId),
    'x-amz-user-agent': getSubscriptionAmzUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  // external_idp (Azure AD) 需 TokenType header
  // 2026-07 迁移:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
  headers['TokenType'] = getTokenTypeHeader(account)

  const profileArn = resolveProfileArn(account)
  const bodyPayload: Record<string, unknown> = {
    overageConfiguration: { overageStatus }
  }
  if (profileArn) {
    bodyPayload.profileArn = profileArn
  }
  const body = JSON.stringify(bodyPayload)

  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body }, account)
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 200)}` }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
