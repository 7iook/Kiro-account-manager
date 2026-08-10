// Kiro API 调用核心模块
import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'node:crypto'
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
// Layer B(出站 tool_result 语义压缩)与 Layer C(上游 SSE 静默看门狗)。
// 两者都是叶子模块,依赖方向单向 kiroApi → layer,不会成环。
import { compressToolResults, formatRtkLog } from './rtk'
import { wrapStreamWithStallDetection } from './streamWatchdog'
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

// v1.7.6 fetchKiroModels 自愈闭环:
// 1) token 刷新回调 —— 403 时先尝试 refresh(可用 refreshToken 的账号),避免 catalog fallback 误吞刷 token 就能解决的问题
type ModelFetchTokenRefreshCallback = (account: ProxyAccount) => Promise<{ ok: boolean; accessToken?: string; refreshToken?: string; expiresAt?: number }>
let modelFetchTokenRefreshCallback: ModelFetchTokenRefreshCallback | undefined
export function setTokenRefreshCallbackForModelFetch(cb: ModelFetchTokenRefreshCallback | undefined): void {
  modelFetchTokenRefreshCallback = cb
}

// 2) 模型同步结果回调 —— fetchKiroModels 结束后无论成功失败都通知,让 accountPool 更新 modelCapabilities 三态标记
type AccountModelSyncCallback = (accountId: string, models: string[], status: 'ok' | 'failed') => void
let accountModelSyncCallback: AccountModelSyncCallback | undefined
export function setAccountModelSyncCallback(cb: AccountModelSyncCallback | undefined): void {
  accountModelSyncCallback = cb
}

export function setLogStreamEvents(enabled: boolean): void {
  logStreamEvents = enabled
}

// v1.7.6 429 rate limit 重试策略 · 前端可配
// Kiro 后端是概率式限流(窗口随机),快速密集重试比慢退避更能穿透
// 默认:8 次 · 400ms 起 · fast 策略(固定 + ±25% jitter),总耗时 ~4-6s
export type RateLimitRetryStrategy = 'fast' | 'linear' | 'exponential'
export interface RateLimitRetryConfig {
  maxAttempts: number      // 每端点最大 429 重试次数
  baseMs: number           // 基础 backoff 毫秒
  strategy: RateLimitRetryStrategy
}
const rateLimitRetryConfig: RateLimitRetryConfig = {
  maxAttempts: 8,
  baseMs: 400,
  strategy: 'fast'
}
export function setRateLimitRetryConfig(cfg: Partial<RateLimitRetryConfig>): void {
  if (typeof cfg.maxAttempts === 'number' && cfg.maxAttempts > 0) {
    rateLimitRetryConfig.maxAttempts = Math.max(1, Math.min(50, Math.floor(cfg.maxAttempts)))
  }
  if (typeof cfg.baseMs === 'number' && cfg.baseMs > 0) {
    rateLimitRetryConfig.baseMs = Math.max(50, Math.min(10000, Math.floor(cfg.baseMs)))
  }
  if (cfg.strategy === 'fast' || cfg.strategy === 'linear' || cfg.strategy === 'exponential') {
    rateLimitRetryConfig.strategy = cfg.strategy
  }
  console.log(`[KiroAPI] rateLimitRetryConfig updated: ${JSON.stringify(rateLimitRetryConfig)}`)
}
export function getRateLimitRetryConfig(): Readonly<RateLimitRetryConfig> {
  return { ...rateLimitRetryConfig }
}

// ============ 上游尝试计数(纯观测 · 不改变任何重试行为)============
// RCA 2026-08-11 429-latency-throughput §3:此前无法回答「一次客户端请求内部
// 到底撞了几次 429 / 发了几次上游请求」——请求日志只有端到端 responseTime,
// 而长尾(实测 200-361s)恰恰来自重试链累积。日志里虽有逐条 [Perf] 行,但
// 事后靠 payload 相邻性拼链不可靠(实测会把连续重试误当同一请求)。
//
// 用「按请求实例传入的计数器」而非模块级全局:并发请求各自计数,互不污染。
export interface UpstreamAttemptCounter {
  /** 发往上游的尝试总次数(含端点回退 / 429 重试 / 溢出恢复重试) */
  attempts: number
  /** 其中收到 429 的次数 */
  rateLimited: number
  /** 被拒后重传的累计字节数 —— 量化「无效上传」成本(实测 1.23MB/请求) */
  wastedUploadBytes: number
}

export function createUpstreamAttemptCounter(): UpstreamAttemptCounter {
  return { attempts: 0, rateLimited: 0, wastedUploadBytes: 0 }
}

// Payload 大小限制（KB），用户可在高级设置中调整
// 默认 4608KB = 4.5MB：上游请求体硬限实测约 5MiB（参 F:\kiro-rs），留安全余量。
// 注意：这是 **byte 维度** 的兼底；token 超 context window 由 enableTokenBufferReserve 处理。
let payloadSizeLimitKB = 4608
export function setPayloadSizeLimitKB(limitKB: number): void {
  payloadSizeLimitKB = Math.max(256, Math.min(204800, limitKB))
}

// Token buffer reserve 开关（默认 true）
// 2026-07-26 从 false 改为 true（见 .archive/2026-07-26 proxy-400-dual-defect-rca.md）：
//   实测受控对照证实 Kiro 后端按**模型 token context window**判限，不是按 payload 字节数：
//     claude-opus-5  1,792,972 B (ctx 1,000,000) → 200 OK
//     gpt-5.6-sol      945,144 B (ctx   272,000) → 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD
//   关闭时 trimHistoryByTokens 整段跳过 → 超限请求原样出站 → 三端点全 400。
//   该裁剪仅在 currentTokens > effectiveLimit 时才动手，平时不改内容，
//   因此**不会破坏 prompt cache 的 prefix 稳定性**（参 727be0b）。
let enableTokenBufferReserve = true
export function setEnableTokenBufferReserve(enabled: boolean): void {
  enableTokenBufferReserve = !!enabled
}
export function getEnableTokenBufferReserve(): boolean {
  return enableTokenBufferReserve
}

// ===== 出站上下文安全网总开关(Layer B RTK 压缩 + Layer C 上游静默看门狗)=====
// 单一用户可见开关,默认 **关闭** —— 两层都会改变出站内容或掐断上游连接,先让用户
// 自己决定何时启用。开发者可用 KIRO_PROXY_LAYER_B / KIRO_PROXY_LAYER_C=false 单独关某一层
// (env 只能关不能开:总开关关着时 env 无意义,避免出现"两个真源打架")。
//
// 注意:Layer A(trimHistoryByTokens 的裁剪留痕 + 原子写回)**不受本开关管辖** ——
// 它是既有 enableTokenBufferReserve 路径的行为修正,今天已默认生效;
// 把它塞进一个默认关闭的新开关等于静默关掉一个本来在工作的东西。
let enableProxyContextSafetyNet = false
export function setEnableProxyContextSafetyNet(enabled: boolean): void {
  enableProxyContextSafetyNet = !!enabled
}
// test-only: reads module-scoped flag written by setter
export function getEnableProxyContextSafetyNet(): boolean {
  return enableProxyContextSafetyNet
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
const TOKEN_TYPE_API_KEY = 'API_KEY'

// ============ 诊断日志开关(端点路由 / region / 400 排查用)============
// 默认关闭以免生产噪音;开发排查跨 region / 端点路由问题时打开。
// 开启方式:① 环境变量 KIRO_API_DEBUG=1 启动;② 运行时调 setKiroApiDebug(true)(IPC/设置可接)。
let kiroApiDebugEnabled = process.env.KIRO_API_DEBUG === '1'
export function setKiroApiDebug(enabled: boolean): void {
  kiroApiDebugEnabled = enabled
}
export function isKiroApiDebug(): boolean {
  return kiroApiDebugEnabled
}

/**
 * 根据账户类型返回 TokenType header 值(2026-07 迁移后)
 * - external_idp / ExternalIdp(真 Azure AD): EXTERNAL_IDP
 * - 其它所有(IdC / BuilderId / Github / Google): SSO_OIDC
 * 抓包证据:官方 Kiro IDE 1.0.116 stream + management API 请求全带 TokenType: SSO_OIDC
 */
function getTokenTypeHeader(account: ProxyAccount): string {
  // 网页 API Key(ksk_)账户：所有 Kiro 调用（GetProfile / ListAvailableModels / generateAssistantResponse）
  // 必须带 TokenType: API_KEY（抓包证据：kiro-cli headless 模式 UA=AmazonQ-For-CLI, tokentype=API_KEY 贯穿全程）
  if (account.authMethod === 'api_key' || account.provider === 'ApiKey') {
    return TOKEN_TYPE_API_KEY
  }
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
  // eu 侧唯一可用的 V1 host。实测 2026-08-05(三把真实 ksk,含一把健康 EU key):
  //   q.eu-central-1              → 200 流式正常            ← 本端点
  //   codewhisperer.eu-central-1  → ECONNRESET(确实停服,故不登记)
  // 与 US 侧两个 V1 的差异:只有 q 有 eu 变体,codewhisperer 没有。
  {
    url: 'https://q.eu-central-1.amazonaws.com/generateAssistantResponse',
    origin: 'AI_EDITOR',
    amzTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    name: 'AmazonQ-EU',
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

// 网页 API Key(ksk_)专用 UA —— kiro-cli headless 抓包实测证据(2026-07)：
// runtime.*.kiro.dev(V2 host)对 TokenType=API_KEY 的授权校验会看 UA，
// 用 KiroIDE UA 会返 403 "User is not authorized to make this call"；
// 必须用 AmazonQ-For-CLI UA 才通过（authz 关键，非 misleading）。
const KIRO_CLI_USER_AGENT = 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/windows lang/rust/1.92.0 md/appVersion-2.12.1 app/AmazonQ-For-CLI'
const KIRO_CLI_AMZ_USER_AGENT = 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/windows lang/rust/1.92.0 m/F app/AmazonQ-For-CLI'

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
  // API Key(ksk_)账户：profileArn 必须是导入时 GetProfile 解析出的真实值（绑定到该 ksk），
  // 没有时绝不能回退到 social/builder 占位 ARN（会 403 Invalid token），返 undefined 让上游自愈重拉。
  if (account.authMethod === 'api_key' || account.provider === 'ApiKey') {
    return account.profileArn && !isPlaceholderProfileArn(account.profileArn) ? account.profileArn : undefined
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

// ============================================================================
// 网页 API Key(ksk_)凭据校验契约(RCA §2 责任分离)
// ----------------------------------------------------------------------------
// - 官方证据(github.com/aws/amazon-q-developer-cli#3805):
//     STANDALONE 订阅类型的 ksk_ 调 GetProfile 一律返 AccessDenied,
//     kiro-cli 输出 "This command is only available for IAM Identity Center or External IdP users"。
//     反向条款:IdC/External IdP 类的 ksk_ 才能 GetProfile 200 拿真 arn。
// - 因此 profileArn 对 ksk 是**可选元数据**,不是必需凭据。
//   凭据有效性判定走 GetUsageLimits(REST · 200 = VALID);GetProfile 只作元数据附赠。
// - 状态机决策表见 validateApiKeyCredential 内部注释。
// ============================================================================

// 状态机 / 探测结果类型的 SSOT 在 @shared/types/credential.ts,此处只 import 使用
import type { CredentialProbeResult, SubscriptionSummary } from '../../shared/types/credential'
import { sha256Fingerprint } from '../utils/tokenFingerprint'
export type { CredentialProbeResult, SubscriptionSummary } from '../../shared/types/credential'

/** 网页 API Key(ksk_)GetProfile 解析结果 */
export interface ApiKeyProfile {
  profileArn: string
  profileName?: string
  status?: string
  profileType?: string
}

/**
 * 用网页 API Key(ksk_)调 GetProfile 尝试解析其绑定的 profileArn。
 *
 * 【重要契约变更(RCA §2 责任拆分)】
 *   本函数现降级为**纯可选元数据解析器**:
 *   - 拿不到 profileArn → 返回 undefined(不 throw · 400 AccessDenied 是 STANDALONE 的既定 feature gate)
 *   - 拿到 → 返回 ApiKeyProfile
 *   凭据有效性判定不再依赖本函数;请调用 validateApiKeyCredential。
 *
 * 精确 wire 格式(2026-07 抓 kiro-cli headless 实测,200 验证通过):
 *   POST https://management.{region}.kiro.dev/   (aws-json RPC 根路径)
 *   Headers: Content-Type: application/x-amz-json-1.0
 *            X-Amz-Target: AmazonCodeWhispererService.GetProfile
 *            TokenType: API_KEY   (关键!区别于 SSO_OIDC,服务据此做 key→profile 查找)
 *            Authorization: Bearer ksk_...
 *            x-amzn-codewhisperer-optout: false
 *   Body: {}
 *   Resp: { "profile": { "arn": "arn:aws:codewhisperer:...:profile/xxx", "profileName", "status", "profileType" } }
 */
export async function resolveApiKeyProfileArn(
  apiKey: string,
  region = 'us-east-1'
): Promise<ApiKeyProfile | undefined> {
  const account: ProxyAccount = {
    id: 'apikey-probe',
    accessToken: apiKey,
    authMethod: 'api_key',
    provider: 'ApiKey',
    region
  }
  const url = `${getKiroManagementHost(region)}/`
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/x-amz-json-1.0',
    'X-Amz-Target': 'AmazonCodeWhispererService.GetProfile',
    'TokenType': TOKEN_TYPE_API_KEY,
    'x-amzn-codewhisperer-optout': 'false',
    'User-Agent': getKiroUserAgent(),
    'x-amz-user-agent': getKiroAmzUserAgent(),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body: '{}' }, account)
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      // 400 AccessDenied 是 STANDALONE 类 ksk 的既定 feature gate;其他 HTTP 错误也一律降级
      proxyLogger.debug('KiroAPI', `resolveApiKeyProfileArn: HTTP ${response.status} ${text.slice(0, 200)} (returning undefined · profileArn is optional metadata)`)
      return undefined
    }
    let data: { profile?: { arn?: string; profileName?: string; status?: string; profileType?: string } }
    try {
      data = JSON.parse(text)
    } catch {
      proxyLogger.debug('KiroAPI', `resolveApiKeyProfileArn: non-JSON response ${text.slice(0, 200)} (returning undefined)`)
      return undefined
    }
    const arn = data.profile?.arn
    if (!arn) {
      proxyLogger.debug('KiroAPI', `resolveApiKeyProfileArn: missing profile.arn (returning undefined)`)
      return undefined
    }
    return {
      profileArn: arn,
      profileName: data.profile?.profileName,
      status: data.profile?.status,
      profileType: data.profile?.profileType
    }
  } catch (e) {
    // 网络错误等:同样降级为 undefined,不 throw
    proxyLogger.debug('KiroAPI', `resolveApiKeyProfileArn network error: ${e instanceof Error ? e.message : String(e)} (returning undefined)`)
    return undefined
  }
}

/**
 * 已知的 STANDALONE 订阅类型集合(GetProfile 会 400 AccessDenied · Step 2 跳过)。
 * type 值来自 GetUsageLimits 响应的 subscriptionInfo.type,大小写敏感匹配 STANDALONE 关键字即可。
 * 官方证据:kiro.dev/docs 与 aws/amazon-q-developer-cli#3805。
 */
function isKnownStandaloneSubscriptionType(type: string | undefined): boolean {
  if (!type) return false
  // 匹配任意含 STANDALONE 字段的 subscription type(Q_DEVELOPER_STANDALONE_POWER / _PRO / _FREE 等)
  return /STANDALONE/i.test(type)
}

/**
 * 验证网页 API Key(ksk_)的凭据有效性(RCA §2 责任拆分)。
 *
 * 只跑一次 GetUsageLimits(management.{region}.kiro.dev/getUsageLimits),按下方
 * 互斥决策表(11 行)从上到下顺序判定,命中即出结果。
 * 【一次响应 → 一个 state】不做跨请求投票 / fallback 链。
 *
 * 决策表(SSOT):
 *   1. 网络错误 / 超时 / DNS 失败              → INDETERMINATE
 *   2. HTTP 5xx                                   → INDETERMINATE
 *   3. HTTP 429                                   → INDETERMINATE
 *   4. HTTP 423                                   → SUSPENDED
 *   5. HTTP 200 + body 含 SUSPENDED 结构字段    → SUSPENDED
 *   6. HTTP 4xx + body 含 SUSPENDED 结构字段    → SUSPENDED
 *   7. HTTP 401                                   → INVALID
 *   8. HTTP 403 + body __type 明确 InvalidToken/Unauthorized → INVALID
 *   8b. HTTP 403 + 裸 AccessDeniedException       → INDETERMINATE (feature gate 未知)
 *   9. HTTP 200 + body 含 subscriptionInfo.type   → VALID
 *   10. 其他 HTTP 200(结构不完整)                → INDETERMINATE
 *   11. 其他 HTTP 4xx(未知拒绝语义)              → INDETERMINATE
 *
 * SUSPENDED 优先级高于 VALID(行 5 先命中,不进入行 9)。
 * 5xx/429 一律归 INDETERMINATE(不解析 body,避免错误日志混入 SUSPENDED 字样)。
 */
export async function validateApiKeyCredential(
  apiKey: string,
  region = 'us-east-1'
): Promise<CredentialProbeResult> {
  // 跨 region 探测(RCA 2026-08-02 · ksk-region-adaptation):
  //   Kiro 数据面 REST 只在 us-east-1 / eu-central-1 提供服务,ksk 归属特定 region;
  //   打到错 region 一律 403 {"message":"Invalid token"},与"密钥吊销"无法从响应体区分。
  //   hint region → 若返 INVALID(401/403) 且还有另一区域候选,试下一个;
  //   VALID / SUSPENDED / INDETERMINATE 均直接短路(网络错误/5xx/429 与 region 无关)。
  //   参考 F:\kiro.rs-admin\src\kiro\token_manager.rs:461 rest_api_region_candidates。
  const primary = region
  const others = KNOWN_CW_DATA_REGIONS.filter(r => r !== primary)
  const candidates = [primary, ...others]

  let lastInvalid: CredentialProbeResult | null = null
  for (const candidateRegion of candidates) {
    const result = await probeApiKeyCredentialAtRegion(apiKey, candidateRegion)
    if (result.state === 'INVALID') {
      // 记住第一次 INVALID(hint region),继续试下一个 region
      lastInvalid = lastInvalid ?? result
      continue
    }
    // VALID → 附上实际成功 region(hint 猜错的场景,caller 用它做持久化)
    if (result.state === 'VALID') {
      return { ...result, region: candidateRegion }
    }
    // SUSPENDED / INDETERMINATE → 与 region 无关,直接短路
    return result
  }
  // 所有候选都 INVALID → 密钥真的无效
  return lastInvalid ?? {
    state: 'INVALID',
    reason: 'No CW data-plane region accepted this credential'
  }
}

/**
 * 单 region 探测 · validateApiKeyCredential 的内部实现。
 * 决策表见 validateApiKeyCredential 头部注释。返回不带 region 字段(由外层填充)。
 */
async function probeApiKeyCredentialAtRegion(
  apiKey: string,
  region: string
): Promise<CredentialProbeResult> {
  const account: ProxyAccount = {
    id: 'apikey-probe',
    accessToken: apiKey,
    authMethod: 'api_key',
    provider: 'ApiKey',
    region
  }
  // GetUsageLimits REST:探测阶段没有 profileArn,不传该参数(后端对 API_KEY 允许)
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  const url = `${getKiroManagementHost(region)}/getUsageLimits?${params.toString()}`
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'TokenType': TOKEN_TYPE_API_KEY,
    'User-Agent': getKiroUserAgent(),
    'x-amz-user-agent': getKiroAmzUserAgent()
  }

  // === Row 1: 网络错误 / 超时 / DNS 失败 → INDETERMINATE ===
  let response: Response
  try {
    response = await fetchWithProxy(url, { method: 'GET', headers }, account)
  } catch (e) {
    return {
      state: 'INDETERMINATE',
      reason: `Network error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  const httpStatus = response.status
  const text = await response.text().catch(() => '')

  // === Row 2 & 3: 5xx / 429 → INDETERMINATE(不解析 body) ===
  if (httpStatus >= 500 && httpStatus <= 599) {
    return { state: 'INDETERMINATE', httpStatus, reason: `HTTP ${httpStatus} server error` }
  }
  if (httpStatus === 429) {
    return { state: 'INDETERMINATE', httpStatus, reason: 'HTTP 429 rate limited' }
  }

  // === Row 4: 423 Locked → SUSPENDED ===
  if (httpStatus === 423) {
    return { state: 'SUSPENDED', httpStatus, reason: 'HTTP 423 Locked · account suspended by Kiro' }
  }

  // 解析 body(供 Row 5-11 使用 · 失败时 body = 空对象)
  let body: {
    __type?: string
    message?: string
    subscriptionInfo?: {
      type?: string
      subscriptionTitle?: string
      status?: string
      subscriptionManagementTarget?: string
    }
    usageBreakdownList?: Array<{
      resourceType?: string
      currentUsage?: number
      usageLimit?: number
    }>
  } = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }

  const bodyType = typeof body.__type === 'string' ? body.__type : ''
  const bodyMessage = typeof body.message === 'string' ? body.message : ''
  const subscriptionStatusIsSuspended =
    typeof body.subscriptionInfo?.status === 'string' &&
    /SUSPENDED/i.test(body.subscriptionInfo.status)
  const hasSuspendedStructuralField =
    /TEMPORARILY_SUSPENDED|AccountSuspended/i.test(bodyType) ||
    subscriptionStatusIsSuspended

  // === Row 5: HTTP 200 + body 含 SUSPENDED 结构字段 → SUSPENDED ===
  if (httpStatus === 200 && hasSuspendedStructuralField) {
    return {
      state: 'SUSPENDED',
      httpStatus,
      reason: 'Subscription/account suspended (200 response body)'
    }
  }

  // === Row 6: HTTP 4xx + body 含 SUSPENDED 结构字段 → SUSPENDED ===
  if (httpStatus >= 400 && httpStatus < 500 && hasSuspendedStructuralField) {
    return {
      state: 'SUSPENDED',
      httpStatus,
      reason: `Account suspended (HTTP ${httpStatus})`
    }
  }

  // === Row 7: HTTP 401 → INVALID ===
  if (httpStatus === 401) {
    return {
      state: 'INVALID',
      httpStatus,
      reason: 'HTTP 401 · authentication failed · invalid or revoked API key'
    }
  }

  // === Row 8 / 8b: HTTP 403 ===
  if (httpStatus === 403) {
    const isExplicitInvalidToken =
      /InvalidTokenException|UnauthorizedException/i.test(bodyType) ||
      /Invalid token/i.test(bodyMessage)
    if (isExplicitInvalidToken) {
      return {
        state: 'INVALID',
        httpStatus,
        reason: 'HTTP 403 · invalid token'
      }
    }
    // Row 8b: 裸 AccessDeniedException / 未知 403 → INDETERMINATE(可能是 feature gate)
    return {
      state: 'INDETERMINATE',
      httpStatus,
      reason: 'HTTP 403 · unclear whether feature-gated or invalid, retry recommended'
    }
  }

  // === Row 9: HTTP 200 + body 含 subscriptionInfo.type → VALID ===
  if (httpStatus === 200 && body.subscriptionInfo?.type) {
    const subscription: SubscriptionSummary = {
      type: body.subscriptionInfo.type,
      title: body.subscriptionInfo.subscriptionTitle,
      status: body.subscriptionInfo.status,
      managementTarget: body.subscriptionInfo.subscriptionManagementTarget
    }
    // usageBreakdownList 中提取 AGENTIC_REQUEST 的 usage/limit(如有)
    const agentic = body.usageBreakdownList?.find(
      it => typeof it?.resourceType === 'string' && it.resourceType === 'AGENTIC_REQUEST'
    )
    if (agentic) {
      subscription.currentUsage = agentic.currentUsage
      subscription.usageLimit = agentic.usageLimit
    }
    return {
      state: 'VALID',
      httpStatus,
      subscription,
      // VALID 态立即在 main 内算 fingerprint(IPC 层直接透传给 renderer,renderer 不重算)
      tokenFingerprint: sha256Fingerprint(apiKey)
    }
  }

  // === Row 10: 其他 HTTP 200 (结构不完整) → INDETERMINATE ===
  if (httpStatus === 200) {
    return {
      state: 'INDETERMINATE',
      httpStatus,
      reason: 'HTTP 200 but response lacks subscriptionInfo.type (cannot confirm active subscription)'
    }
  }

  // === Row 11: 其他 HTTP 4xx(未知拒绝语义) → INDETERMINATE ===
  return {
    state: 'INDETERMINATE',
    httpStatus,
    reason: `HTTP ${httpStatus} · unknown rejection semantics`
  }
}

/**
 * Step 2 元数据附赠:仅对可能有 profile 的订阅类型调 GetProfile(RCA §6 A6-R4)。
 * - STANDALONE 类 → 直接跳过(GetProfile 一定 400 AccessDenied · 减少无意义请求)
 * - 未知 / IdC-managed 类 → 调 GetProfile · 拿不到 undefined(不改变 state)
 */
export async function resolveApiKeyProfileArnIfEligible(
  apiKey: string,
  region: string,
  subscriptionType: string | undefined
): Promise<ApiKeyProfile | undefined> {
  if (isKnownStandaloneSubscriptionType(subscriptionType)) {
    proxyLogger.debug(
      'KiroAPI',
      `Skipping GetProfile for known STANDALONE subscription type: ${subscriptionType}`
    )
    return undefined
  }
  return resolveApiKeyProfileArn(apiKey, region)
}


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
  // GPT-5.6 系列(2026-07-24 修复 INVALID_MODEL_ID)
  // Kiro catalog 的 canonical id 带 tier 后缀(gpt-5.6-sol / -terra / -luna),
  // 裸 `gpt-5.6` 只有 CodeWhisperer 端点会做 catalog 二次解析,V2 KiroRuntime / AmazonQ
  // 直接 400 INVALID_MODEL_ID → 表现为"有时成功(fallback 到第三个端点)、有时挂"。
  // 客户端(如 Claude Code 的 ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.6 · SUB 用 model:sonnet)
  // 常传裸别名,这里静态映射到旗舰 Sol,首个端点即命中。
  // 官方证据:kiro.dev/docs/models GPT-5.6 Sol/Terra/Luna 三档 · 272K ctx · 2.4x/1.2x/0.6x credit
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-5-6': 'gpt-5.6-sol',
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5': 'gpt-5.6-sol',
  // Claude 5 系列(2026-07-24 Opus 5 发布)
  'claude-opus-5': 'claude-opus-5',
  'claude-sonnet-5': 'claude-sonnet-5',
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
  // 2) Kiro 支持的动态模型家族原样透传，用于向前兼容尚未加入静态 alias 的新版本
  if (/^claude-(sonnet|haiku|opus)-/.test(lower)) return modelId
  if (/^gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/.test(lower)) return modelId
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

// 网页 API Key(ksk_)账户：kiro-cli headless 抓包证据——generate 请求 origin 必须是 KIRO_CLI
// （用 AI_EDITOR 会被 V2 host 拒 403 not authorized）；其它账户用端点自带 origin。
function resolveEffectiveOrigin(account: ProxyAccount, endpointOrigin: string): string {
  if (account.authMethod === 'api_key' || account.provider === 'ApiKey') return 'KIRO_CLI'
  return endpointOrigin
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

// 注入系统提示（thinking / agentic）
// 注：不再在前面拼 timestamp（每次变化会杀死 prompt cache 命中）。参考 Anthropic 官方文档：
// prefix 任何 byte 变化都将 invalidate cache。客户端会自己注入时间上下文，反代不重复。
export function injectSystemPrompts(
  content: string,
  isAgentic: boolean,
  thinkingEnabled: boolean
): string {
  let result = content

  // 注入 Thinking 模式（必须在最前面）
  if (thinkingEnabled) {
    result = THINKING_MODE_PROMPT + '\n\n' + result
  }

  // 注入 Agentic 模式提示
  if (isAgentic) {
    result = result + '\n\n' + AGENTIC_SYSTEM_PROMPT
  }

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

// 裁剪留痕占位说明(见 trimHistoryByTokens)。
// 静默丢弃旧历史会让模型无法区分「这事没发生过」与「这段被省略了」,于是重复索要
// 它本来已有的信息,或从断口硬推。切口处插一条说明把「被省略」这一事实显式告知。
export const TRUNCATION_PLACEHOLDER =
  '[Earlier conversation history was truncated to fit the model input limit. Older messages and tool activity have been omitted.]'

const TRUNCATION_PLACEHOLDER_MESSAGE: KiroHistoryMessage = {
  userInputMessage: { content: TRUNCATION_PLACEHOLDER, origin: 'AI_EDITOR' }
}

function isTruncationPlaceholder(message: KiroHistoryMessage | undefined): boolean {
  return message?.userInputMessage?.content === TRUNCATION_PLACEHOLDER
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
//
// 保护 system prompt Human/AI 注入对(translator.ts 在 history 头部注入):
//   history[0] = { userInputMessage: { content: <systemPrompt> } }
//   history[1] = { assistantResponseMessage: { content: 'I will follow these instructions.' } }
// 若检测到此 marker,startIdx=2,裁剪只发生在其后,保证 system 指令不丢。
//
// 2026-08-09 Layer A 两处增量:
//  1) 留痕:真丢弃 ≥1 条时在切口插 TRUNCATION_PLACEHOLDER(user) + UNDERSTOOD_MESSAGE(assistant)。
//     静默丢弃会让模型无法区分「这事没发生过」与「这段被省略了」→ 重复索要已有信息 / 从断口硬推。
//     ack 不是装饰:上游要求严格 user/assistant 交替,占位(user)直接接一个同样以 user 起头的
//     尾段会形成 user+user → 400 REQUEST_BODY_INVALID。
//     交替不靠手工维持 —— 完整 sanitize 链(含 ensureAlternatingMessages)在 :1545 于**裁剪之前**
//     跑完,裁剪后只剩 ensureStartsWithUserMessage,插入动作会扰动交替不变量,故这里显式复用
//     ensureAlternatingMessages 收口(同一个 SSOT,不另造一份交替逻辑)。
//  2) 原子性:候选 history 在本地累积,末尾一次性换入 payload。此前逐轮赋值,循环中途抛异常
//     (JSON.stringify 遇到脏对象)会留下半裁 payload,而该 payload 随后仍被发出/重试。
//     末次 token 估算也必须在写回**之前**算完 —— 写回是本函数最后一个动作。
//  3) 预算判定跑在**最终形态**上:循环里估算的候选已含占位对 + 规范化补齐(finalizeCandidate),
//     一直裁到最终形态装得下。此前先把纯历史收敛到 <= maxTokens 才插占位,占位对的固定开销
//     从未计入 → 恰好收敛到预算线的请求被推回超限,而函数报告成功(安全网自己交出超限 payload)。
//     裁到保护下限仍装不下时诚实上报 finalTokens > maxTokens,不丢占位对去凑数。
export function trimHistoryByTokens(payload: KiroPayload, maxTokens: number): { trimmed: number; finalTokens: number; iterations: number } {
  const originalHistory = payload.conversationState.history
  if (!originalHistory || originalHistory.length === 0) {
    return { trimmed: 0, finalTokens: estimatePayloadTokens(payload), iterations: 0 }
  }
  let history = originalHistory

  // 不写回 payload 的试算视图:浅展开,history 换成候选数组,其余字段按引用共享
  const estimateWith = (candidate: KiroHistoryMessage[]): number =>
    estimatePayloadTokens({
      ...payload,
      conversationState: { ...payload.conversationState, history: candidate }
    })

  // 检测 system prompt Human/AI 注入对(translator.ts openaiToKiro/claudeToKiro 都注入的固定 marker)
  // 保护:裁剪时永远跳过前 2 条,不裁 system 指令 pair
  const SYSTEM_MARKER = 'I will follow these instructions.'
  const hasSystemPair =
    history.length >= 2 &&
    isUserInputMessage(history[0]) &&
    isAssistantResponseMessage(history[1]) &&
    history[1].assistantResponseMessage?.content === SYSTEM_MARKER
  const startIdx = hasSystemPair ? 2 : 0

  // 把「已裁剪的纯历史」变成**真正会被发出的最终形态**:去重旧占位 → 插占位对 → 收口交替/起头。
  // 纯函数(不改入参、不写回),因此可以在循环里反复试算。
  // 预算判定必须跑在它的输出上:占位对与 ensureAlternatingMessages 补齐的 filler 都是真实
  // token 开销,只测中间形态会让恰好收敛到预算线的请求被占位对推回超限而仍报成功。
  const finalizeCandidate = (candidate: KiroHistoryMessage[]): KiroHistoryMessage[] => {
    // 去掉尾段里可能残留的旧占位对(上一轮裁剪留下的),保证全程只有一对
    const deduped: KiroHistoryMessage[] = []
    for (let i = 0; i < candidate.length; i++) {
      if (isTruncationPlaceholder(candidate[i])) {
        // 占位(user) 与其后紧跟的 ack(assistant) 一起丢
        if (isAssistantResponseMessage(candidate[i + 1])) i++
        continue
      }
      deduped.push(candidate[i])
    }

    // 切口处插入留痕:占位(user) + ack(assistant),位置在 system pair 之后、保留尾段之前
    let rebuilt = [
      ...deduped.slice(0, startIdx),
      TRUNCATION_PLACEHOLDER_MESSAGE,
      UNDERSTOOD_MESSAGE,
      ...deduped.slice(startIdx)
    ]
    // 插入扰动了交替不变量 → 复用既有 helper 显式收口(裁剪后 sanitize 链不会再跑)
    rebuilt = ensureAlternatingMessages(rebuilt)
    rebuilt = ensureStartsWithUserMessage(rebuilt)
    return rebuilt
  }

  let totalTrimmed = 0
  let iterations = 0
  // 入口判定用**原样 payload**(还没裁 → 按契约不该有占位对):
  // 决定「要不要动手」的门槛必须是当前真实出站形态,否则未超限请求会被误判。
  let currentTokens = estimatePayloadTokens(payload)
  // 最终形态候选:仅在真裁过后才存在,末尾一次性换入 payload
  let finalized: KiroHistoryMessage[] | null = null
  const MAX_ITERATIONS = 100 // 防止极端情况死循环

  while (currentTokens > maxTokens && (history.length - startIdx) >= 4 && iterations < MAX_ITERATIONS) {
    iterations++
    // 从 startIdx(跳过 system pair)开始至少裁掉 1 组 (user+assistant),并连带 toolUse/toolResult 配对
    let cutAt = 0
    while (cutAt < (history.length - startIdx - 2)) {
      const msg = history[startIdx + cutAt]
      // assistant(toolUse) → 下一条 user(toolResult) 必须一起裁，避免配对断裂
      if (isAssistantResponseMessage(msg) && hasToolUses(msg)) {
        cutAt += 2
      } else {
        cutAt += 1
      }
      if (cutAt >= 2) break
    }

    if (cutAt === 0) break // 无法继续裁剪

    // 保留 [0..startIdx](system pair),裁掉 [startIdx..startIdx+cutAt](最旧的对话)
    history = [...history.slice(0, startIdx), ...history.slice(startIdx + cutAt)]
    totalTrimmed += cutAt

    // 裁剪后 history 可能以 assistant 起头(仅 startIdx=0 场景) → 补 HELLO 重新规范
    history = ensureStartsWithUserMessage(history)
    // 每轮 cutAt >= 1 ⇒ history 严格变短 ⇒ 循环必然收敛到「装得下」或「触保护下限」,不会空转
    finalized = finalizeCandidate(history)
    currentTokens = estimateWith(finalized)
  }

  if (totalTrimmed === 0 || finalized === null) {
    // 一条都没裁 → 不插占位、不写回。裁剪只在超限时发生,平时不改内容,
    // prompt cache 的 prefix 逐字节匹配不受影响(参 727be0b)。
    return { trimmed: 0, finalTokens: currentTokens, iterations }
  }

  // 触到保护下限(system pair + 末轮对话)仍装不下时,这里的 currentTokens 会 > maxTokens。
  // 选择**诚实上报**而不是丢占位对去凑数:占位只值几十 token,丢掉却退回静默丢弃语义,
  // 而调用方(响应式恢复)靠 trimmed/finalTokens 判断「还能不能再裁」,谎报达标会让它误判。
  // 全程只有这一次写回,且是本函数**最后一个动作**:
  // 任何一步(含末次 token 估算)抛异常都必须让 payload 保持原样,半裁 payload 随后仍会被发出/重试。
  payload.conversationState.history = finalized

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


  // ====== 第零阶段：RTK 形态感知压缩(Layer B)======
  // 顺序刻意钉死在 token 裁剪**之前**:先语义压缩,可能压完就不必丢历史;真要丢也丢的是
  // 更小的东西。放在裁剪之后等于去压那些已经被丢掉的内容,白做。
  // 只压 history 里的大 tool_result,绝不碰 currentMessage(用户当前消息逐字节原样出站)。
  if (enableProxyContextSafetyNet) {
    const rtkResult = compressToolResults(payload)
    if (rtkResult.applied) {
      const line = formatRtkLog(rtkResult.stats)
      if (line) {
        console.log(`[KiroPayload] ${line}`)
        proxyLogger.info('KiroPayload', line, {
          bytesBefore: rtkResult.stats.bytesBefore,
          bytesAfter: rtkResult.stats.bytesAfter,
          hits: rtkResult.stats.hits.length
        })
      }
    } else if (rtkResult.reason === 'error') {
      // 压缩失败**不是**需要上抛的故障:模块保证 payload 一个字节都没被改,原样出站即可。
      // 这里只留痕,不改控制流 —— 少一道压缩 < 弄坏一个本来能跑通的请求。
      const msg = `RTK compression skipped (payload untouched): ${rtkResult.error ?? 'unknown'}`
      console.warn(`[KiroPayload] ${msg}`)
      proxyLogger.warn('KiroPayload', msg)
    }
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
  // 避免 HTTP body 过大被 Kiro 网关拒绝（byte 维度，与上面的 token 维度互补）
  //
  // 2026-07-26 修正(RCA: .archive/2026-07-26/proxy-400-model-and-content-length/):
  //   v1.7.5 曾把默认 1.5MB 提到 150MB(changelog 写"支持大图片",但 trim 只截
  //   tool_result.content[].text、根本不碰 images,那次改动基于误解)。
  //   随后一版把硬顶压回 1536KB —— 方向同样错:受控对照证明 byte 不是 Kiro 的判限维度
  //     claude-opus-5 1,792,972 B (ctx 1,000,000) → 200 OK
  //     gpt-5.6-sol     945,144 B (ctx   272,000) → 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD
  //   1.79MB 能过而 0.92MB 被拒 ⇒ 拒绝来自 token 超 context window(已由第一阶段处理)。
  //   压到 1536KB 反而会去裁那个本来能成功的 1.79MB 请求,白白改写历史内容 →
  //   破坏 prompt cache 的 prefix 逐字节匹配(参 727be0b),credit 涨回 5 倍。
  //   现按参考项目实测值设定:F:\kiro-rs src/model/config.rs 注释「上游请求体硬性限制
  //   实测约 5MiB 会触发 400」,其默认取 4.5MiB 留安全余量 —— 这里对齐 4608KB。
  const HARD_TRIM_CEILING_KB = 4608
  const effectiveTrimKB = Math.min(payloadSizeLimitKB || HARD_TRIM_CEILING_KB, HARD_TRIM_CEILING_KB)
  const PAYLOAD_SIZE_LIMIT = effectiveTrimKB * 1024
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

  // 网页 API Key(ksk_)账户：V2 host 对 API_KEY 授权校验 UA，必须用 AmazonQ-For-CLI UA（否则 403）；
  // 且 stream target 用 V1 命名 AmazonCodeWhispererStreamingService.*（KiroRuntimeService.* 会 403 not authorized）。
  if (account.authMethod === 'api_key' || account.provider === 'ApiKey') {
    headers['user-agent'] = KIRO_CLI_USER_AGENT
    headers['x-amz-user-agent'] = KIRO_CLI_AMZ_USER_AGENT
    if (headers['X-Amz-Target']?.startsWith('KiroRuntimeService.')) {
      headers['X-Amz-Target'] = headers['X-Amz-Target'].replace('KiroRuntimeService.', 'AmazonCodeWhispererStreamingService.')
    }
  }

  return headers
}

// 获取排序后的端点列表(根据 account.region 与首选端点配置)
// 2026-07 迁移后的策略:
//   - V2 端点(runtime.*.kiro.dev) 总是优先,按 account.region 选单一 EU/US endpoint
//   - V1 端点作 fallback,按 region 取对应变体(us：codewhisperer + q；eu：仅 q,
//     codewhisperer.eu 实测 ECONNRESET 已停服)；preferredEndpoint 只影响 V1 内部顺序
//   - amazonq-cli 保留单端点不回退行为
export function getSortedEndpoints(
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli',
  region?: string,
  isApiKeyAuth?: boolean
): typeof KIRO_ENDPOINTS {
  // AmazonQ CLI 模式：只用这一个端点，失败不回退
  //
  // 例外 —— ksk_(TokenType=API_KEY)账号:该端点明确拒绝 API key 认证。
  // 实测 2026-08-05:q.eu-central-1/SendMessageStreaming + Bearer ksk_… →
  //   403 {"message":"API key authentication is not supported for this operation"}
  // “单端点不回退”的语义对它就是 100% 必败且无退路,故忽略这个偏好。
  if (preferredEndpoint === 'amazonq-cli' && !isApiKeyAuth) {
    return KIRO_ENDPOINTS.filter(ep => ep.name === 'AmazonQCLI')
  }

  // V2 端点按 region 分发(eu account → EU host, us/其它 account → US host)
  const wantEuRegion = region?.startsWith('eu-')
  const v2Endpoints = KIRO_ENDPOINTS.filter(ep => {
    if (!ep.name.startsWith('KiroRuntime')) return false
    return wantEuRegion ? ep.name === 'KiroRuntime-EU' : ep.name === 'KiroRuntime-US'
  })

  // V1 端点按 region 取对应变体 —— **绝不跨区**:
  //   US 账户 → codewhisperer.us + q.us(两个都实测 200)
  //   EU 账户 → 仅 q.eu-central-1(实测 200);codewhisperer.eu 已停服(ECONNRESET),不登记
  //
  // 为什么 EU 从前是空数组:RCA 2026-08-03 hold-gate-fallback-cross-region 现场是
  //   「EU 账户 KiroRuntime-EU 429 撞爆 10 次 → fallback CodeWhisperer(us-east-1) → 403
  //    → 单账号池 shouldHold=false → 立即报错 → 用户看到 AI SUB 莫名中断」。
  // 那次结论「EU 账户 fallback 到 V1 **us** 必 403 Invalid token」**完全正确**,三把 ksk
  // 实测复现(q.us / cw.us 对 EU token 一律 "bearer token invalid")。但它被记成了
  // 「eu 侧 V1 已停服」并落成空数组 —— 那句话只对 codewhisperer.eu 成立,q.eu 一直是活的
  // (REST 侧 index.ts:KIRO_REST_API_ENDPOINTS_V1_FALLBACK 早就在用它取 usage)。
  //
  // 代价:EU 账户唯一端点抽风时无路可走。实测 2026-08-05 当日 KiroRuntime-EU 非 200 率
  // **41%**(n=29),而 KiroRuntime-US 仅 1%(n=325)—— 41 倍差距,且 EU 失败后直接抛给客户端。
  const v1Endpoints = wantEuRegion
    ? KIRO_ENDPOINTS.filter(ep => ep.name === 'AmazonQ-EU')
    : KIRO_ENDPOINTS.filter(ep =>
        ep.name !== 'AmazonQCLI' && !ep.name.startsWith('KiroRuntime') && ep.name !== 'AmazonQ-EU'
      )

  // V1 内部按 preferredEndpoint 排序(codewhisperer/amazonq 二选一优先)
  if (preferredEndpoint && v1Endpoints.length > 0) {
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

/**
 * 每次 fetch 尝试专属的「联动 AbortController」。
 *
 * 为什么必须新建而不是复用 callKiroApiStream 的 `signal`:那个 signal 是**调用方注入的
 * 客户端取消通道**,对它 abort 等于伪造「客户端主动取消」—— parseEventStream 正是从同一个
 * signal 推导 abort 语义(getAbortError(signal)),污染它会让统计与错误分类全错。
 *
 * 语义:外部 signal 单向转发进来(外部取消 → 联动取消);看门狗只能 abort 联动的那个,
 * 外部 signal 的 aborted 保持 false。
 *
 * dispose() 必须在每次尝试结束后调用:转发监听器挂在外部 signal 上,而外部 signal 的寿命
 * 是整个请求 —— 端点回退 / 429 / 溢出恢复 / 内容过滤 / thinking 重试每轮都新建一个,
 * 不摘监听器就会随重试轮数线性堆积在同一个 signal 上。
 */
function createLinkedAbort(signal?: AbortSignal): {
  signal: AbortSignal
  abort: (reason?: unknown) => void
  dispose: () => void
} {
  const controller = new AbortController()
  if (!signal) {
    return { signal: controller.signal, abort: (r) => controller.abort(r), dispose: () => undefined }
  }
  // 外部已经取消 → 立刻同步过来,别发一个注定被丢弃的请求
  if (signal.aborted) {
    controller.abort(signal.reason)
    return { signal: controller.signal, abort: (r) => controller.abort(r), dispose: () => undefined }
  }
  const forward = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => signal.removeEventListener('abort', forward)
  }
}

// 调用 Kiro API（流式）
/**
 * 判断一个出站失败是否属于「值得整体重试」的瞬时故障。
 *
 * 用途:三个端点全挂之后决定要不要退避后重走整条端点链(见 callKiroApiStream catch 末尾)。
 * 现场依据(RCA 2026-08-04):全库 53 次端点故障有 50 次集中在 KiroRuntime-US 的同一个
 * 抽风窗口;且 undici 把真因埋在 `error.cause.code` 里(message 恒为 "fetch failed")。
 *
 * 判据边界 —— 宽了烧额度,窄了救不回:
 *   - 传输层错误(连接根本没成 / 半路被 RESET)→ 可重试
 *   - HTTP 5xx(上游服务端自己的问题)→ 可重试
 *   - 429 穿透(端点内重试已耗尽;Kiro 是概率式限流窗口)→ 可重试
 *   - HTTP 4xx(请求本身有问题:400 畸形 / 401 过期 / 404 无此模型)→ 不可重试,
 *     重试 100 次还是同一个 4xx,纯烧额度。CONTENT_LENGTH_EXCEEDS_THRESHOLD 与
 *     THINKING_SIGNATURE_INVALID 也落在这里 —— 它们各有专属恢复分支,不该走这条路。
 *   - 未知错误 → 保守判不可重试
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false
  const e = err as { message?: string; code?: string; cause?: { code?: string; message?: string } }
  const msg = String(e.message ?? '')

  // Layer C 上游静默 → **绝不**走整链重试。看门狗已经掐了上游、也已经把 error 交给下游,
  // 属于「有专属处置分支」那一类(同 CONTENT_LENGTH_EXCEEDS_THRESHOLD /
  // THINKING_SIGNATURE_INVALID)。而且静默发生时客户端可能已经收到部分输出,重发会产生
  // 重复内容;用户还刚白等完一整个静默超时,再重走整条链等于再等好几分钟。
  //
  // 这个早退不是装饰:下面的传输层 regex 命中 `fetch failed` / `terminated` /
  // UND_ERR_* —— 被掐断的 fetch 恰好会以这些形态出现(本轮实测:
  // {message:'fetch failed', cause:{code:'UND_ERR_ABORTED'}} → true)。
  // StallError 今天的 message 是 'upstream_stream_stall: ... upstream aborted',实测不命中;
  // 但只要哪天 message 改词或被 undici 的 cause 包一层,就会静默掉进重试链。按稳定的 code
  // 判定而不是靠 message 侥幸不匹配。
  if ((e.code ?? '') === 'upstream_stream_stall') return false

  // 带 HTTP 状态码 = 连接是通的,只有 5xx 值得再试
  const httpStatus = msg.match(/\b(?:API|Auth) error (\d{3})\b/)
  if (httpStatus) {
    const status = Number(httpStatus[1])
    return status >= 500 && status <= 599
  }
  // 端点内 429 重试耗尽后抛的 "Rate limited on <ep> after N retries"
  if (/rate limited/i.test(msg)) return true

  const codes = [e.code, e.cause?.code].filter(Boolean).map(String).join(' ')
  const haystack = `${msg} ${String(e.cause?.message ?? '')} ${codes}`
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|ENETRESET|EHOSTUNREACH|socket hang up|secure TLS connection|fetch failed|other side closed|\bterminated\b|UND_ERR_(?:SOCKET|CONNECT|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)/i.test(haystack)
}

export async function callKiroApiStream(
  account: ProxyAccount,
  payload: KiroPayload,
  // onChunk 可返回 Promise：下游 SSE 写缓冲打满时返回 drain promise，流解析 await 实现背压
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, reasoningSignature?: string, redactedContent?: string) => void | Promise<void>,
  onComplete: (usage: KiroUsage) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal,
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli',
  /** 纯观测计数器(可选)。传入则累计上游尝试 / 429 / 无效上传字节;不传时零行为变化。 */
  attemptCounter?: UpstreamAttemptCounter
): Promise<void> {
  const isEnterprise = account.provider === 'Enterprise' || account.authMethod === 'external_idp'

  // Enterprise 缺 profileArn 时先调 API 获取(必须在选 endpoint 之前,否则跨 region
  // 账户按 account.region 打错端点)；BuilderId/Social 不需要
  if (!account.profileArn && isEnterprise) {
    const fetchedArn = await fetchEnterpriseProfileArn(account)
    if (fetchedArn) {
      account.profileArn = fetchedArn
      if (account.id) profileArnPersistCallback?.(account.id, fetchedArn)
    }
  }

  // 跨 region 账户支持:SSO OIDC 注册的 region(account.region)不一定等于 profileArn
  // 对应的数据面 region。用 parseRegionFromProfileArn 从 arn 里解出真实 dataPlane
  // region 选 KiroRuntime EU/US endpoint,避免"SSO 在 US、profile 挂 EU"的账户被
  // 路由到错端点后 400 "Improperly formed request"。
  // Fix:6ab368b 只修了 verify/GetUsageLimits,stream 阶段仍用 account.region — 本轮补齐。
  const parsedArnRegion = parseRegionFromProfileArn(account.profileArn)
  const dataPlaneRegion = parsedArnRegion || account.region
  const endpoints = getSortedEndpoints(preferredEndpoint, dataPlaneRegion, account.authMethod === 'api_key')

  // [DIAG] 端点路由诊断(排查"切到 US2 后间歇性 400":暴露是哪个账户/arn/region 被路由到哪个端点)
  if (kiroApiDebugEnabled) {
    console.log(`[KiroAPI][DIAG] Route plan | account=${account.email || account.id || 'unknown'} provider=${account.provider ?? '?'} authMethod=${account.authMethod ?? '?'}`)
    console.log(`[KiroAPI][DIAG]   account.region=${account.region ?? 'undef'} | parsedArnRegion=${parsedArnRegion ?? 'null'} | dataPlaneRegion(used)=${dataPlaneRegion ?? 'undef'}`)
    console.log(`[KiroAPI][DIAG]   profileArn=${account.profileArn ?? 'undef'}`)
    console.log(`[KiroAPI][DIAG]   preferredEndpoint=${preferredEndpoint ?? 'none'} | endpoint plan=[${endpoints.map(e => e.name).join(' > ')}]`)
  }

  let lastError: Error | null = null

  // ===== 上下文溢出响应式恢复(参考 Kiro IDE 官方 ContextOverflowHandler)=====
  // Kiro IDE 的做法是**响应式**而非预测式:照常发请求,catch ContextWindowExceededError
  // 后再本地恢复(其指标名 contextUsagePercentAtOverflow 记录的是"溢出时"的百分比,
  // 不是用百分比预测溢出)。它有三级降级:截断式 summarization → map-reduce 总结 →
  // brute-force 本地截断(preserveRecentRounds:0,零 API 依赖故不可能失败)。
  //
  // 反代这里实现等价的第 1 + 第 3 级:收到 CONTENT_LENGTH_EXCEEDS_THRESHOLD 后按递进
  // 比例裁掉最旧 history,重试**同一端点**(换端点无用,三端点共用同一后端限制)。
  //
  // 为何用「相对比例」而不是「绝对 token 上限」:本地 token 估算不可靠 —— 同一
  // byte/3.5 口径在两个真实样本上偏差 0.7% vs 82%(RCA 2026-07-26)。而按当前估算值
  // 的比例裁剪只需要「裁掉约 30%/55%/80% 的内容」,与绝对精度无关,估算再偏也成立。
  //
  // 直接收益:Claude Code 的 /compact 请求本身超限时(上游已知死锁 anthropics/claude-code
  // #26518 #8136 #65905),反代裁剪后重试可让 compact 成功,打破死锁。
  const CONTEXT_OVERFLOW_RECOVERY_RATIOS = [0.7, 0.45, 0.2]
  let overflowRecoveryAttempt = 0

  // ===== 三端点全挂后的整体退避重试(具体判据在 catch 末尾)=====
  // 与上面的上下文溢出恢复正交:那个是「同一端点、裁小 payload 再试」,
  // 这个是「payload 不变、等上游缓一缓、重走整条端点链」。
  const ALL_ENDPOINT_RETRY_BACKOFF_MS = [800, 2000]
  let allEndpointRetryAttempt = 0

  // ===== CONTENT_FILTERED 且零输出 → 透明重试(具体判据在 parseEventStream 调用处)=====
  // 上游内容过滤器有时在**一个字都没吐**的情况下就掎断。实测(RCA 2026-08-05):
  // UTC 19:13-19:17 四分钟内 CONTENT_FILTERED 爆发 16 次,**16/16 全部 outChars=0**,
  // 而同期 421 次 TOOL_USE 正常 —— 形态是上游过滤器的瞬时/概率性行为,不是「这个
  // prompt 内容违规」(真违规重试也会失败,代价只多一次调用)。
  const CONTENT_FILTER_RETRY_BACKOFF_MS = [400, 1200]
  let contentFilterRetryAttempt = 0

  type AttemptAbort = {
    signal: AbortSignal | undefined
    abort: (reason?: unknown) => void
    dispose: () => void
  }
  const createAttemptAbort = (): AttemptAbort => enableProxyContextSafetyNet
    ? createLinkedAbort(signal)
    : { signal, abort: () => undefined, dispose: () => undefined }

  for (let endpointIdx = 0; endpointIdx < endpoints.length; endpointIdx++) {
    const endpoint = endpoints[endpointIdx]
    // [DIAG] 记录本端点实际出站的 modelId,供 catch 分支写入 UI 日志。
    // 背景:INVALID_MODEL_ID 类 400 在 UI 侧完全是黑盒 —— 只有 console 里
    // 打了 "Model ID",打包版没有终端 → 无法区分「客户端传了未映射的裸别名」
    // vs「映射对了但账户/region 无该模型权限」。诊断可见性是一等公民。
    let outboundModelId: string | undefined
    let clientRequestedModelId: string | undefined
    // 安全网 ON 时使用尝试专属联动通道;OFF 时原样透传 caller signal。
    // 429 / thinking 重试会在轮内重建它,故用 let;finally 里统一 dispose 摘监听器。
    let linked = createAttemptAbort()
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
      clientRequestedModelId = requestedModelId
      if (endpoint.name === 'CodeWhisperer') {
        applyPayloadModelId(requestPayload, await resolveCodeWhispererModelId(account, requestedModelId, signal))
      }
      outboundModelId = getPayloadModelId(requestPayload)

      applyPayloadOrigin(requestPayload, resolveEffectiveOrigin(account, endpoint.origin))

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
      if (kiroApiDebugEnabled) {
        console.log(`[KiroAPI][DIAG]   - endpoint.url=${endpoint.url}`)
        console.log(`[KiroAPI][DIAG]   - resolvedProfileArn=${resolvedArn ?? 'undef'}`)
        console.log(`[KiroAPI][DIAG]   - TokenType=${headers['TokenType'] ?? 'n/a'} | effectiveOrigin=${resolveEffectiveOrigin(account, endpoint.origin)}`)
      }
      console.log(`[KiroAPI]   - Agent mode: ${headers['x-amzn-kiro-agent-mode']}`)
      console.log(`[KiroAPI]   - Payload size: ${payloadStr.length} bytes`)
      if (requestPayload.additionalModelRequestFields && Object.keys(requestPayload.additionalModelRequestFields).length > 0) {
        console.log(`[KiroAPI]   - additionalModelRequestFields: ${JSON.stringify(requestPayload.additionalModelRequestFields)}`)
      }
      
      const agent = getNetworkAgent(account)
      if (agent) proxyLogger.debug('KiroAPI', `Stream request via proxy to ${endpoint.name}`)
      // [Perf] 分段打点 — 每请求 1 行,量 TTFB(fetch 发出 → response 返回)
      // TTFB = TCP/TLS 连接 + 网络 RTT + Kiro 后端模型 first-byte(启动/thinking)
      // 之前只有端到端 responseTime,无法分辨「网络+服务端慢」vs「反代自身慢」
      const tFetchStart = Date.now()
      if (attemptCounter) attemptCounter.attempts++
      let response = agent
        ? await undiciFetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal: linked.signal, dispatcher: agent } as UndiciRequestInit) as unknown as Response
        : await fetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal: linked.signal })
      const ttfb = Date.now() - tFetchStart
      const usingProxy = agent ? 'proxy' : 'direct'
      console.log(`[Perf] ep=${endpoint.name} region=${dataPlaneRegion || '?'} TTFB=${ttfb}ms status=${response.status} pay=${payloadStr.length}B via=${usingProxy} acc=${account.email || account.id?.slice(0, 8) || '?'}`)

      if (response.status === 429) {
        // 纯观测:首次 429(重试循环内的后续 429 在循环末尾累计)。
        if (attemptCounter) {
          attemptCounter.rateLimited++
          attemptCounter.wastedUploadBytes += payloadStr.length
        }
        // 429 = Kiro 后端概率式限流(不是真 QPS 上限,窗口随机开关)。
        // 策略:短 backoff + 高重试次数 + jitter,让请求密集打向服务端有更大概率命中开窗。
        // 之前策略 3 次 · 2s→5s→10s(exponential)对概率窗口过慢,大部分错过窗口 → 端点全打完 → 500。
        // 新策略默认 8 次 · 400ms 起线性 + ±25% jitter,总耗时 ~4-6s 内密集试探。
        // Retry-After header 优先(HTTP 标准),某些平台会给出真实等待时间。
        // 参考:GitHub kirodotdev/Kiro#8998 credits 充足也 429。
        // 前端 ProxyConfig 可调 rateLimitRetryMaxAttempts / rateLimitRetryBaseMs / rateLimitRetryStrategy。
        const maxRetries = rateLimitRetryConfig.maxAttempts
        const baseMs = rateLimitRetryConfig.baseMs
        const strategy = rateLimitRetryConfig.strategy
        let retried = 0
        while (response.status === 429 && retried < maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after')
          const asSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN
          let waitMs: number
          if (!isNaN(asSec) && asSec > 0) {
            waitMs = Math.min(asSec * 1000, 15000)
          } else if (strategy === 'exponential') {
            waitMs = Math.min(baseMs * Math.pow(2, retried), 15000)
          } else if (strategy === 'linear') {
            waitMs = Math.min(baseMs + retried * baseMs, 5000)
          } else {
            // 'fast'(默认): 固定 baseMs + ±25% jitter,让并发请求错开重试
            const jitter = (Math.random() - 0.5) * 0.5 * baseMs // ±25%
            waitMs = Math.max(50, Math.round(baseMs + jitter))
          }
          console.log(`[KiroAPI] ${endpoint.name} 429 rate-limited, backoff ${waitMs}ms retry ${retried + 1}/${maxRetries} (strategy=${strategy})`)
          await new Promise(r => setTimeout(r, waitMs))
          throwIfAborted(signal)
          // 每次重发都换一个全新 linked controller:上一个可能已被看门狗掐过(aborted 不可复位),
          // 复用会让新请求出生即死。旧的先 dispose 摘掉转发监听器,避免按重试次数堆积。
          linked.dispose()
          linked = createAttemptAbort()
          if (attemptCounter) attemptCounter.attempts++
          response = agent
            ? await undiciFetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal: linked.signal, dispatcher: agent } as UndiciRequestInit) as unknown as Response
            : await fetch(endpoint.url, { method: 'POST', headers, body: payloadStr, signal: linked.signal })
          retried++
          // 纯观测:重发后仍 429 → 又一次无效上传。
          if (response.status === 429 && attemptCounter) {
            attemptCounter.rateLimited++
            attemptCounter.wastedUploadBytes += payloadStr.length
          }
        }
        if (response.status === 429) {
          console.log(`[KiroAPI] ${endpoint.name} still rate-limited after ${maxRetries} retries, trying next endpoint...`)
          lastError = new Error(`Rate limited on ${endpoint.name} after ${maxRetries} retries`)
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
        // [DIAG] 记录失败端点完整上下文,便于定位跨端点/region/账户切换后的 400
        if (kiroApiDebugEnabled) {
          console.error(`[KiroAPI][DIAG] Non-OK ${response.status} from ${endpoint.name} (${endpoint.url}) | account=${account.email || account.id || '?'}`)
          console.error(`[KiroAPI][DIAG]   dataPlaneRegion=${dataPlaneRegion} account.region=${account.region} resolvedArn=${resolvedArn ?? 'undef'} TokenType=${headers['TokenType'] ?? 'n/a'}`)
          console.error(`[KiroAPI][DIAG]   body: ${body}`)
        }
        throw new Error(`API error ${response.status}: ${body}`)
      }

      // 解析 Event Stream
      // 传入 modelId + payloadStr 用于精确 token 计算（contextUsage 反推 + tiktoken）
      const inputChars = payloadStr.length
      // CONTENT_FILTERED 且零输出 → 不上报给客户端,原地重试。
      // 零输出使重试**完全安全**:客户端还没收到任何内容,且流式路径的 message_start
      // 是惰性发送(要等首个语义正文,见 proxyServer ADR-0001 边界 1),重发不会造成
      // 内容重复或 SSE 协议错乱。吐过正文则**绝不重试** —— 那会让客户端看到重复内容。
      let retryFilteredEmpty = false
      const completeGuard = (u: KiroUsage): void => {
        if (
          u.terminal?.disposition === 'filtered' &&
          u.terminal.emptyOutput === true &&
          contentFilterRetryAttempt < CONTENT_FILTER_RETRY_BACKOFF_MS.length
        ) {
          retryFilteredEmpty = true
          return
        }
        onComplete(u)
      }
      await parseEventStream(response.body!, onChunk, completeGuard, onError, () => linked.abort(new Error('upstream stream stall — aborted by watchdog')), inputChars, signal, requestedModelId, payloadStr)
      if (retryFilteredEmpty) {
        const waitMs = CONTENT_FILTER_RETRY_BACKOFF_MS[contentFilterRetryAttempt]
        contentFilterRetryAttempt++
        const cfMsg = `CONTENT_FILTERED with zero output — retrying ${endpoint.name} ${contentFilterRetryAttempt}/${CONTENT_FILTER_RETRY_BACKOFF_MS.length} after ${waitMs}ms (safe: nothing sent to client yet)`
        console.warn(`[KiroAPI] ${cfMsg}`)
        proxyLogger.warn('KiroAPI', cfMsg, {
          endpoint: endpoint.name,
          attempt: contentFilterRetryAttempt,
          maxAttempts: CONTENT_FILTER_RETRY_BACKOFF_MS.length,
          backoffMs: waitMs,
          account: account.email || account.id?.slice(0, 8) || '?'
        })
        await new Promise(r => setTimeout(r, waitMs))
        if (signal?.aborted) { onError(getAbortError(signal)); return }
        endpointIdx--  // 重试同一端点(与上下文溢出恢复同手法),不消耗端点 fallback 机会
        continue
      }
      return
    } catch (error) {
      if (signal?.aborted) {
        onError(getAbortError(signal))
        return
      }
      lastError = error as Error
      const errMsgFull = (error as Error).message || String(error)
      const errStack = (error as Error).stack || ''
      // v1.7.6 调试:显式打出 error.message 让 UI 日志也能看到具体 body(不止 "failed:" 空串)
      proxyLogger.error('KiroAPI', `Endpoint ${endpoint.name} failed [model=${outboundModelId ?? 'unset'}]: ${errMsgFull.slice(0, 500)}`, {
        endpoint: endpoint.name,
        endpointUrl: endpoint.url,
        // [DIAG] outboundModelId = 真正发给该端点的 modelId(CodeWhisperer 会二次解析成
        // 大写枚举);clientModelId = mapModelId 之后进 payload 的值。两者 + 错误 body
        // 三元组足以区分「别名未映射」vs「映射对但无权限」vs「端点不支持该模型」。
        outboundModelId: outboundModelId ?? 'unset',
        clientModelId: clientRequestedModelId ?? 'unset',
        account: account.email || account.id?.slice(0, 8) || '?',
        region: account.region,
        arnRegion: parseRegionFromProfileArn(account.profileArn),
        stack: errStack.split('\n').slice(0, 3).join(' | ')
      })
      console.error(`[KiroAPI] Endpoint ${endpoint.name} failed:`, error)
      
      // 如果是认证错误，不继续尝试其他端点
      if ((error as Error).message.includes('Auth error')) {
        onError(error as Error)
        return
      }

      // 上下文超出模型 context window → 响应式恢复(见函数顶部 ContextOverflowHandler 注释)。
      // 换端点无用(三端点共用同一后端限制,实测 04:16:12/:15/:18 三连全 400),
      // 正确处理是本地裁掉最旧 history 后**重试同一端点**。
      // 注意:INVALID_MODEL_ID 不走此路 —— 只有 CodeWhisperer 会做 catalog 二次解析,
      // 裸别名在 V2 端点被拒但能被 CodeWhisperer 救回,必须保留换端点 fallback。
      if ((error as Error).message.includes('CONTENT_LENGTH_EXCEEDS_THRESHOLD')) {
        if (overflowRecoveryAttempt < CONTEXT_OVERFLOW_RECOVERY_RATIOS.length) {
          const ratio = CONTEXT_OVERFLOW_RECOVERY_RATIOS[overflowRecoveryAttempt]
          overflowRecoveryAttempt++
          const beforeTokens = estimatePayloadTokens(payload)
          const beforeMessages = payload.conversationState.history?.length ?? 0
          // 裁剪作用于**外层 payload**,使后续重试/换端点都用裁后版本。
          // trimHistoryByTokens 内含三重保护:跳过 system prompt pair、toolUse/toolResult
          // 成对裁剪(防 orphan → 上游 400)、ensureStartsWithUserMessage。
          const trimResult = trimHistoryByTokens(payload, Math.floor(beforeTokens * ratio))
          if (trimResult.trimmed > 0 && trimResult.finalTokens < beforeTokens) {
            const msg = `Context overflow recovery ${overflowRecoveryAttempt}/${CONTEXT_OVERFLOW_RECOVERY_RATIOS.length}: dropped ${trimResult.trimmed} oldest history messages (${beforeMessages}→${payload.conversationState.history?.length ?? 0}, ≈${beforeTokens.toLocaleString()}→${trimResult.finalTokens.toLocaleString()} est. tokens, target ratio ${ratio}), retrying ${endpoint.name}`
            console.warn(`[KiroAPI] ${msg}`)
            proxyLogger.warn('KiroAPI', msg, {
              endpoint: endpoint.name,
              outboundModelId: outboundModelId ?? 'unset',
              attempt: overflowRecoveryAttempt,
              droppedMessages: trimResult.trimmed,
              historyBefore: beforeMessages,
              historyAfter: payload.conversationState.history?.length ?? 0
            })
            endpointIdx--  // 重试同一端点(裁剪后的 payload),不消耗端点 fallback 机会
            continue
          }
          // 没有真实缩小 payload 时重发同一已知超限请求没有恢复价值。
          const noProgress = trimResult.trimmed > 0
            ? `dropped ${trimResult.trimmed} history messages but tokens did not decrease (${beforeTokens.toLocaleString()}→${trimResult.finalTokens.toLocaleString()})`
            : `could not trim further (history=${beforeMessages})`
          console.warn(`[KiroAPI] Context overflow recovery ${overflowRecoveryAttempt} ${noProgress}, giving up`)
        }
        const giveUp = `Context window exceeded [model=${outboundModelId ?? 'unset'}] — recovery exhausted after ${overflowRecoveryAttempt} attempt(s); skipping remaining endpoints (same backend limit)`
        console.warn(`[KiroAPI] ${giveUp}`)
        proxyLogger.error('KiroAPI', giveUp, {
          endpoint: endpoint.name,
          outboundModelId: outboundModelId ?? 'unset',
          recoveryAttempts: overflowRecoveryAttempt,
          remainingEndpointsSkipped: endpoints.length - endpointIdx - 1
        })
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
          applyPayloadOrigin(retryPayload, resolveEffectiveOrigin(account, endpoint.origin))
          const retryStr = JSON.stringify(retryPayload)
          const retryHeaders = getAuthHeaders(account, endpoint)
          const retryAgent = getNetworkAgent(account)
          // 本次重试也要有自己的联动通道:主 fetch 那个可能已被掐过(aborted 不可复位)。
          // 这条路径尤其不能漏静默保护 —— 用户已经白等过一次失败了。
          linked.dispose()
          linked = createAttemptAbort()
          const retryResponse = retryAgent
            ? await undiciFetch(endpoint.url, { method: 'POST', headers: retryHeaders, body: retryStr, signal: linked.signal, dispatcher: retryAgent } as UndiciRequestInit) as unknown as Response
            : await fetch(endpoint.url, { method: 'POST', headers: retryHeaders, body: retryStr, signal: linked.signal })
          if (retryResponse.ok) {
            await parseEventStream(retryResponse.body!, onChunk, onComplete, onError, () => linked.abort(new Error('upstream stream stall — aborted by watchdog')), retryStr.length, signal, getPayloadModelId(retryPayload), retryStr)
            return
          }
          const retryBody = await retryResponse.text()
          console.error(`[KiroAPI] THINKING_SIGNATURE_INVALID retry also failed: ${retryResponse.status} ${retryBody.slice(0, 200)}`)
        } catch (retryErr) {
          if (signal?.aborted) { onError(getAbortError(signal)); return }
          console.error(`[KiroAPI] THINKING_SIGNATURE_INVALID retry error:`, retryErr)
        }
      }

      // ===== 三端点全挂 → 退避后重走整条端点链(RCA 2026-08-04)=====
      // 现场(16:40:17):CodeWhisperer / KiroRuntime-US / AmazonQ 在同几秒内全部 ECONNRESET
      // → 端点 fallback 走完 → lastError 交上层 → decideHoldAction 判 giveup → 客户端直接断,
      // 全程零重试。而全库 53 次端点故障有 50 次挤在 KiroRuntime-US 的同一个抽风窗口 ——
      // 这类故障是瞬时的,等一下就好。
      //
      // 设计意图(用户明确):网络类 / 429 错误「只需要重试,绝不挂起」—— 重试 ≠ 挂起。
      // 挂起门闸只管「账号级真不可用」(封禁 / 额度上限 / 未授权),不管链路抽风。
      //
      // 为何放在 catch 末尾而不包一层 while:复用上下文溢出恢复已验证的 endpointIdx
      // 回拨手法,不动循环结构 —— 两个恢复机制共用同一套语义,不引入第二种控制流。
      const isLastEndpoint = endpointIdx >= endpoints.length - 1
      if (isLastEndpoint
        && allEndpointRetryAttempt < ALL_ENDPOINT_RETRY_BACKOFF_MS.length
        && isTransientNetworkError(error)) {
        const waitMs = ALL_ENDPOINT_RETRY_BACKOFF_MS[allEndpointRetryAttempt]
        allEndpointRetryAttempt++
        const retryMsg = `All ${endpoints.length} endpoint(s) failed with transient error — backing off ${waitMs}ms then retrying whole chain ${allEndpointRetryAttempt}/${ALL_ENDPOINT_RETRY_BACKOFF_MS.length} (last: ${errMsgFull.slice(0, 120)})`
        console.warn(`[KiroAPI] ${retryMsg}`)
        proxyLogger.warn('KiroAPI', retryMsg, {
          endpointsTried: endpoints.length,
          attempt: allEndpointRetryAttempt,
          maxAttempts: ALL_ENDPOINT_RETRY_BACKOFF_MS.length,
          backoffMs: waitMs,
          lastError: errMsgFull.slice(0, 200),
          account: account.email || account.id?.slice(0, 8) || '?'
        })
        await new Promise(r => setTimeout(r, waitMs))
        // 退避期间客户端可能已经放弃 —— 白等完再烧一轮额度没意义
        if (signal?.aborted) { onError(getAbortError(signal)); return }
        endpointIdx = -1  // 下轮 ++ 回到 0,重走整条端点链
        continue
      }
    } finally {
      // 摘掉挂在外部 signal 上的转发监听器。外部 signal 活整个请求的寿命,而端点回退 /
      // 429 / 溢出恢复 / 内容过滤 / thinking 重试每轮都新建一个 linked —— 不摘就按重试
      // 轮数线性堆积。放 finally 覆盖全部出口(return / continue / throw)。
      linked.dispose()
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
//
// ⚡ 2026-07-25 主进程 event loop 饿死修复（第 3 次同母题，前两次:c3d7905 / 29d6773）
//
// 症状:长会话 + 多客户端并发跑一段时间后，UI 点击完全无响应（renderer 的
//   ipcRenderer.invoke 排不上队），但反代 5580 仍正常处理请求。
// 实测证据:main 进程 80% CPU 持续 / renderer 仅 2.3%（说明 renderer 空转等主进程，
//   不是 Chromium 后台节流问题）。
// 根因:promptCacheTracker.flattenCacheBlocks() 对每个 cache block 调 estimateTokens()，
//   而 Claude Code 长会话可达 658 个 block / 累计 658K tokens ≈ 2.6MB 文本。
//   tiktoken 是纯 JS 同步实现（~1-3 MB/s）→ 单请求 1-2.6 秒纯 CPU 阻塞 event loop。
//   history 只增不减，所以「跑越久越卡」；多会话并发时主进程永久饱和。
// 修法:memoize。history 是 append-only，同一 block 在后续每轮重复出现，tiktoken
//   结果完全相同。用 native crypto SHA-1 作 key（C++ 实现，2.6MB 约 5ms，比 tiktoken
//   快 200-500 倍），第二轮起命中率 ~99%。
// 边界:短文本（<512B）直接算，hash 开销大于收益；cache 上限 20000 条防内存泄漏。
const tokenCountCache = new Map<string, number>()
const TOKEN_COUNT_CACHE_MAX = 20000
const TOKEN_COUNT_CACHE_MIN_LEN = 512

export function estimateTokens(text: string): number {
  if (!text) return 0
  // 短文本:hash + Map 开销 > tiktoken 直算，不走缓存
  if (text.length < TOKEN_COUNT_CACHE_MIN_LEN) return countTokens(text)

  const key = createHash('sha1').update(text, 'utf-8').digest('base64')
  const hit = tokenCountCache.get(key)
  if (hit !== undefined) return hit

  const tokens = countTokens(text)
  // 简单容量控制:超限整体清空（LRU 的复杂度对本场景不划算，
  // 清空后下一轮会重新填充，最坏情况退化成一次全量重算）
  if (tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX) {
    tokenCountCache.clear()
    console.log(`[TokenCounter] estimateTokens cache cleared at ${TOKEN_COUNT_CACHE_MAX} entries`)
  }
  tokenCountCache.set(key, tokens)
  return tokens
}

/** 测试/诊断用:返回 memoize 缓存当前条目数 */
export function getEstimateTokensCacheSize(): number {
  return tokenCountCache.size
}

/**
 * 把上游 Kiro stopReason 归一化并分类成终止语义(2026-08-01)。
 *
 * 为什么必须有这一层:上游 stopReason 是**唯一**能区分「模型说完了」和「模型被掐断了」的信号。
 * 实测日志分布 END_TURN:155 / TOOL_USE:367 / CONTENT_FILTERED:4 —— 那 4 次内容过滤截断,
 * 此前被一律翻译成 Anthropic `end_turn`(语义 = 自然收尾)→ 客户端判定本轮正常完成 → 静默停止,
 * 表现为用户看到的"跑到一半自己断了"。
 *
 * 判据参考 F:\9router\open-sse\executors\kiro.js 的 stopDisposition(生产验证过的六态分类),
 * 此处收敛到本项目实际需要的五态,不引入用不上的分支。
 */
export function classifyKiroStopReason(
  rawStopReason: string | undefined,
  hasToolCalls: boolean
): NonNullable<KiroUsage['terminal']> {
  // 归一化:上游给大写下划线(CONTENT_FILTERED),也兼容驼峰/连字符写法
  const norm = String(rawStopReason || '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

  const mk = (
    disposition: NonNullable<KiroUsage['terminal']>['disposition'],
    shouldFail: boolean
  ): NonNullable<KiroUsage['terminal']> => ({
    upstreamStopReason: rawStopReason || undefined,
    disposition,
    shouldFail
  })

  // 内容过滤截断 —— 本次 RCA 确认的致断根因,必须让客户端明确失败(用户选择:发 SSE error)
  if (norm === 'content_filtered' || norm === 'content_filter' || norm === 'refusal') {
    return mk('filtered', true)
  }
  // 明确的非正常截断
  if (['cancelled', 'canceled', 'pause_turn', 'model_context_window_exceeded',
       'malformed_model_output', 'invalid_model_output'].includes(norm)) {
    return mk('incomplete', true)
  }
  // 输出长度上限:无工具调用时是可接受的正常截断(客户端自己会续写);
  // 但若已开了工具调用又被截断,工具入参极可能不完整 → 按 incomplete 处理
  if (['max_tokens', 'max_output_tokens', 'length'].includes(norm)) {
    return hasToolCalls ? mk('incomplete', true) : mk('length', false)
  }
  if (norm === 'tool_use' || (!norm && hasToolCalls)) return mk('tool_use', false)
  if (!norm || norm === 'end_turn' || norm === 'stop' || norm === 'stop_sequence') {
    return mk(hasToolCalls ? 'tool_use' : 'complete', false)
  }
  // 未知 stopReason:不假设它安全 —— 宁可让客户端看到错误,也不要静默截断
  return mk('incomplete', true)
}

/**
 * 断点尾部形态取样(2026-08-07 · 诊断 GPT 中途硬断)。
 *
 * 只返回**形状**,绝不返回原文 —— 请求正文属用户隐私,日志会进 UI 面板并可能被截图外传。
 * 判断依据:上游「发完才关流」的尾部通常以句末标点收束;「传输中被掐断」的尾部
 * 常停在半个词/半个标识符/中文句中,或以逗号、连接词类字符结尾。
 *
 * @returns endsSentence 是否以句末标点收束 · tailClass 末字符类别 · tailLen 取样长度
 */
export function sampleTailShape(text: string): {
  endsSentence: boolean
  tailClass: string
  tailLen: number
} {
  const trimmed = (text || '').replace(/\s+$/u, '')
  if (!trimmed) return { endsSentence: false, tailClass: 'empty', tailLen: 0 }
  const last = trimmed[trimmed.length - 1]!
  // 句末标点(中英双语):这些结尾强烈暗示上游把话说完了
  const endsSentence = /[。！？.!?；;」』】)\]}]/u.test(last)
  const tailClass =
    endsSentence ? 'sentence_end'
    : /[,、，:：]/u.test(last) ? 'comma'        // 停在逗号 = 话没说完
    : /[\p{Script=Han}]/u.test(last) ? 'han'    // 停在汉字中间
    : /[A-Za-z]/u.test(last) ? 'latin'          // 停在半个英文词
    : /[0-9]/u.test(last) ? 'digit'
    : /[`'"*_~#>|/\\-]/u.test(last) ? 'markup'  // 停在 markdown/代码标记里
    : 'other'
  return { endsSentence, tailClass, tailLen: trimmed.length }
}

// 解析 AWS Event Stream 二进制格式
//
// Layer C 接线点在**函数内部**,不在调用处。理由:静默保护属于「每一次解析上游流都必须有」
// 的不变量,放在调用处就变成每个新调用点的自觉义务(今天两处:主路径 + THINKING_SIGNATURE
// 重试;将来第三处极容易漏)。onStallAbort 刻意做成**必填参数**而不是可选 —— 少传直接编译
// 不过,漏接线成为类型错误而不是运行时静默缺失。
async function parseEventStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, reasoningSignature?: string, redactedContent?: string) => void | Promise<void>,
  onComplete: (usage: KiroUsage) => void,
  onError: (error: Error) => void,
  // 判定上游静默后掐断本次 fetch 的动作(必须是 linked controller 的 abort,不是调用方 signal)
  onStallAbort: () => void,
  inputChars: number = 0,  // 输入字符长度（兜底估算用）
  signal?: AbortSignal,
  modelId?: string,        // 模型 ID，用于 contextUsagePercentage 反推 inputTokens
  payloadStr?: string      // 请求 payload JSON 字符串，用于 tiktoken 精确计算
): Promise<void> {
  // Layer C:先给上游原始字节流套静默看门狗,再取 reader。
  // 总开关关闭 / KIRO_PROXY_LAYER_C=false / 看门狗自身构建失败 → 原样返回上游流(纯透传)。
  // 计时按**原始上游 chunk**,不按 SSE 输出 —— 推理模型会长时间零 SSE 输出但分片一直在到,
  // 按输出计时会误掐正常的慢思考请求(见 streamWatchdog.ts 顶部)。
  const guardedBody = enableProxyContextSafetyNet
    ? wrapStreamWithStallDetection(body, onStallAbort)
    : body
  const reader = guardedBody.getReader()
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
  // ===== [STREAM-END] 取证埋点(2026-08-01 · RCA gpt-stream-premature-end)=====
  // 目的:定位「GPT 系模型经反代跑到一半自断」的真实终止原因。纯观测,零行为改变。
  // 覆盖 RCA §1.5 五条假设的判据:A 截断帧 / B 上游 stopReason 被丢弃 / C tool_call wrapper /
  // D 客户端 abort / E 帧界错位。定主因后本段可保留(诊断可见性是一等公民)或收进正式门闸。
  const diagEventCounts: Record<string, number> = {}
  let diagUpstreamStopReason: string | undefined   // 上游真实 stopReason(当前转发逻辑从不消费它)
  let diagStopReasonSource: string | undefined     // 来源:messageStopEvent / metadataEvent
  let diagJsonSyntaxErrors = 0                     // 被静默吞掉的 JSON 语法错误数(截断信号)
  const diagToolNames: string[] = []               // 见过的 toolUseEvent 名(判 tool_call wrapper)
  let diagToolInputParseFailures = 0               // tool input JSON 解析失败次数
  let diagFramesParsed = 0
  let diagLastTotalLength = 0
  // ===== 断点形态取证补强(2026-08-07 · 用户报「GPT 中途硬断,最后一句说个『继续』就没了」)=====
  // 现有埋点能答「断在哪」(exit 四态 + residualBytes),不能答「断之前上游是发完了还是被掐断」——
  // 而这两者处置相反(前者=模型行为,反代无解;后者=传输层,可重试)。补两组读数:
  //   A 尾部形态:断点前最后一段正文的**形状**(长度/是否完整句尾/末尾字符类别),不落原文
  //   B 时间轴:首字节→末 chunk→流终止 的间隔。末 chunk 到终止有明显静默 = 上游挂起后超时;
  //            紧邻 = 上游主动关流(模型自己收尾)
  let diagFirstByteAt = 0        // 首个 chunk 到达时刻(ms,performance 单调时钟)
  let diagLastChunkAt = 0        // 最后一个 chunk 到达时刻
  let diagChunkCount = 0         // 上游 chunk 数(区分「一次性返回」与「真流式」)
  
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
    // ⚠️ 顺序关键(2026-08-01 修):本块必须在"提取内层工具"之前。
    // 缺陷:若先提取内层,嵌套在幻觉外壳里的内层工具会先被捞进 leakedTools,
    //       等外壳被整块丢弃时工具已经提取出去了 → 流结束时作为真实 tool_use 注入客户端
    //       = 模型幻觉 / 散文里的示例标记被提升成真实工具调用。
    // 实证:一次会话中模型在报告正文里写示例标记,反代真的向客户端发出了 toolUseId=toolleakfix_* 的
    //       调用(客户端回 No such tool available)。若幻觉里的工具名恰好存在,就会执行一次
    //       无人意图的调用 → 对话状态错乱(这是"跑到一半断了"的另一条路径)。
    // 现在的顺序保证:外壳内的一切(含内层工具标记)整块丢弃,永不进 leakedTools。
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

  // [STREAM-END] 取证输出:流终止时打一行结构化证据(dev 终端 + UI 日志双通道)。
  // 异常态走 warn,使打包版用户也能在 UI 日志面板看到(打包版没有终端)。
  const emitStreamEndDiag = (exitReason: string, errInfo?: string): void => {
    const residual = buffer.length
    let residualHead = ''
    let claimedTotalLength = 0
    if (residual > 0) {
      residualHead = Array.from(buffer.slice(0, Math.min(16, residual)))
        .map(b => b.toString(16).padStart(2, '0')).join(' ')
      if (residual >= 4) {
        claimedTotalLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false)
      }
    }
    const hasSemanticOutput = totalOutputChars > 0 || processedIds.size > 0 || leakedTools.length > 0
    // 断点形态(2026-08-07):尾部只落形状不落原文;时间轴用于区分「上游主动关流」与「挂起后超时」
    const tail = sampleTailShape(collectedOutputText)
    const nowAt = performance.now()
    const silenceMs = diagLastChunkAt > 0 ? Math.round(nowAt - diagLastChunkAt) : -1
    const streamSpanMs = diagFirstByteAt > 0 ? Math.round(diagLastChunkAt - diagFirstByteAt) : -1
    const line = `[STREAM-END] exit=${exitReason} residualBytes=${residual}`
      + ` claimedTotalLength=${claimedTotalLength} framesParsed=${diagFramesParsed}`
      + ` lastFrameLength=${diagLastTotalLength}`
      + ` upstreamStopReason=${diagUpstreamStopReason ?? 'ABSENT'}(${diagStopReasonSource ?? 'none'})`
      + ` semanticOutput=${hasSemanticOutput} outChars=${totalOutputChars} toolsDone=${processedIds.size}`
      + ` toolNames=[${diagToolNames.join(',')}] toolInputParseFail=${diagToolInputParseFailures}`
      + ` jsonSyntaxErrSwallowed=${diagJsonSyntaxErrors} leakCarryLeft=${leakCarry.length}`
      + ` tailClass=${tail.tailClass} tailEndsSentence=${tail.endsSentence} tailLen=${tail.tailLen}`
      + ` chunks=${diagChunkCount} streamSpanMs=${streamSpanMs} silenceBeforeEndMs=${silenceMs}`
      + ` events=${JSON.stringify(diagEventCounts)}`
      + (residual > 0 ? ` residualHead=${residualHead}` : '')
      + (errInfo ? ` err=${errInfo}` : '')
    console.log(line)
    const suspicious = residual > 0 || !hasSemanticOutput || diagJsonSyntaxErrors > 0
      || diagToolInputParseFailures > 0 || exitReason !== 'clean_eof'
    if (suspicious) proxyLogger.warn('Kiro', line)
    else proxyLogger.info('Kiro', line)
  }

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

      // [STREAM-END] 取证:chunk 时间轴(纯读数,不影响控制流)
      diagChunkCount++
      diagLastChunkAt = performance.now()
      if (diagFirstByteAt === 0) diagFirstByteAt = diagLastChunkAt

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
            
            // [STREAM-END] 取证:无条件统计事件类型(streamEventCounts 只在 logStreamEvents 开时统计,
            // 断链现场往往没开)+ 观测上游真实 stopReason —— 当前转发逻辑完全不消费它(RCA §1.5 假设 B)。
            diagEventCounts[eventType || 'unknown'] = (diagEventCounts[eventType || 'unknown'] || 0) + 1
            if (eventType === 'messageStopEvent' || event.messageStopEvent) {
              const stopPayload = (event.messageStopEvent || event) as { stopReason?: unknown; stop_reason?: unknown }
              const rawReason = stopPayload.stopReason ?? stopPayload.stop_reason
              if (rawReason !== undefined && rawReason !== null) {
                diagUpstreamStopReason = String(rawReason)
                diagStopReasonSource = 'messageStopEvent'
              } else if (!diagUpstreamStopReason) {
                diagUpstreamStopReason = 'PRESENT_BUT_EMPTY'
                diagStopReasonSource = 'messageStopEvent'
              }
            }
            if (!diagUpstreamStopReason) {
              const metaForStop = (event.messageMetadataEvent || event.metadataEvent || event) as { stopReason?: unknown; stop_reason?: unknown }
              const metaStopReason = metaForStop.stopReason ?? metaForStop.stop_reason
              if (metaStopReason !== undefined && metaStopReason !== null) {
                diagUpstreamStopReason = String(metaStopReason)
                diagStopReasonSource = 'metadataEvent'
              }
            }
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
              // [STREAM-END] 取证:记录工具名,判 GPT 系是否走 tool_call wrapper(RCA §1.5 假设 C)
              if (toolName && !diagToolNames.includes(String(toolName))) diagToolNames.push(String(toolName))
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
                  diagToolInputParseFailures++  // [STREAM-END] 取证:工具入参被上游截断的次数
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
                // token 级 log 只在 logStreamEvents 开启时才落 store,否则每个 token
                // 都推 2 条 entry 会让 proxyLogStore 数组每 add 一次都 O(N) slice
                // (N=50000),几万 token 之后主进程 event loop 完全卡死,UI 打不开。
                if (logStreamEvents) {
                  proxyLogger.info('Kiro', `Received reasoning content (isThinking=true): ${reasoning.text.slice(0, 50)}...`)
                }
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
              if (logStreamEvents) {
                proxyLogger.debug('Kiro', 'reasoningContentEvent', JSON.stringify(reasoning).slice(0, 200))
              }
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
              diagJsonSyntaxErrors++  // [STREAM-END] 取证:被静默吞掉的截断信号计数
              console.debug('[EventStream] JSON parse error:', parseError)
            } else {
              throw parseError
            }
          }
        }
        
        // [STREAM-END] 取证:帧计数 + 最后一帧声明长度(判帧界错位 / prelude 无 CRC 校验)
        diagFramesParsed++
        diagLastTotalLength = totalLength
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

      // 上游结构化 toolUseEvent 计数 —— 写进下面的 RESCUE 埋点,用于持续判定
      // 「救回的是真泄漏(上游同时发了结构化工具)还是模型正文里的 XML 示例」。
      //
      // 2026-08-04 已证伪的假设(勿重复):曾怀疑 GPT 系是「上游走纯文本协议 + 正文 XML
      // 被误救 → 客户端 No such tool → END_TURN」,据此加过「GPT 系 + 上游零结构化工具
      // → 抑制注入」的判据。实测 458 条 STREAM-END 推翻:GPT 侧 tool-leak rescue 与
      // SUPPRESSED 均为 0 条、leakCarryLeft 全 0;42 条 rescued 全部来自 Claude。
      // GPT 提前收尾的真因是上游模型行为(「outChars<110 + 零工具 + END_TURN」出现率
      // GPT 10.1% vs Claude 2.1%),与 tool-leak 无关。抑制判据已回滚 —— 它不但是死代码,
      // 万一 GPT 某天真泄漏还会把真工具丢掉,反而制造断线。
      // RCA: .agent-workspace/.archive/2026-08-04/gpt-suppression-rollback-and-endpoint-retry/
      const upstreamStructuredToolCount = processedIds.size

      for (const lt of leakedTools) {
        let sig: string
        try { sig = toolSig(lt.name, lt.input) } catch { sig = lt.name + '|?' }
        if (seenToolSigs.has(sig)) {
          deduped++
          if (toolLeakDebug) console.log(`[tool-leak-fix] [DEDUP-SKIP] name=${lt.name} sig=${sig.slice(0, 100)}`)
          continue
        }
        seenToolSigs.add(sig)

        // 无条件 RESCUE 详情埋点(不需要开 KIRO_TOOL_LEAK_DEBUG)——
        // 用于持续判定「救回的到底是真工具还是模型正文里的 XML 示例」。
        const inputKeys = (() => { try { return Object.keys(lt.input || {}).join(',') } catch { return '?' } })()
        const inputPreview = (() => { try { return JSON.stringify(lt.input).slice(0, 160) } catch { return '[unserializable]' } })()

        leakIdCounter++
        const rescuedId = `toolleakfix_${Date.now().toString(36)}_${leakIdCounter.toString(36)}`
        proxyLogger.info('Kiro',
          `[tool-leak-fix][RESCUE] model=${modelId ?? '?'} · id=${rescuedId} · name=${lt.name} ` +
          `· inputKeys=[${inputKeys}] · upstreamStructuredTools=${upstreamStructuredToolCount} · input=${inputPreview}`)
        if (toolLeakDebug) console.log(`[tool-leak-fix] [RESCUE] id=${rescuedId} name=${lt.name} input=${JSON.stringify(lt.input).slice(0, 200)}`)
        await onChunk('', { toolUseId: rescuedId, name: lt.name, input: lt.input })
        rescued++
      }
      if (rescued > 0 || toolLeakDebug) {
        proxyLogger.info('Kiro', `Tool-leak-fix: leaked=${leakedTools.length} rescued=${rescued} deduped=${deduped} seen_sigs=${seenToolSigs.size} model=${modelId ?? '?'} upstreamStructuredTools=${upstreamStructuredToolCount}`)
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
    } else if (collectedOutputText && usage.outputTokens > 0) {
      // 修次生缺陷(2026-08-01):上游在被过滤/截断时给的 outputTokens 是**残值**。
      // 实测:outChars=11397 却只记 38 tokens、outChars=3154 记个位数 —— 偏低两三个数量级,
      // 使用量统计/计费全面失真。上游值只在明显不合理时纠正(取两者较大),
      // 不无条件覆盖 —— 正常情况下上游真实值仍比本地 tiktoken 估算更权威。
      const localEstimate = countTokens(collectedOutputText)
      if (localEstimate > usage.outputTokens * 2 && localEstimate - usage.outputTokens > 50) {
        proxyLogger.warn('Kiro', `Upstream outputTokens looks truncated: upstream=${usage.outputTokens} localTiktoken=${localEstimate} (chars=${totalOutputChars}, stopReason=${diagUpstreamStopReason ?? 'ABSENT'}) — using local estimate`)
        usage.outputTokens = localEstimate
      }
    }

    // 将上游真实终止语义带给转发层(2026-08-01 修 CONTENT_FILTERED 静默断流)。
    // parseEventStream 只做分类不做处置 —— 具体怎么对客户端表现由各转发路径自己决定
    // (四条路径的协议不同:Claude SSE error / OpenAI finish_reason / Gemini finishReason / 非流式 JSON)。
    const hasAnyToolCall = processedIds.size > 0 || leakedTools.length > 0
    usage.terminal = classifyKiroStopReason(diagUpstreamStopReason, hasAnyToolCall)
    // 本轮是否一个字的语义正文都没吐、也没有工具调用 —— 失败能否被透明重试的唯一判据。
    // 放在这里而不是 classifyKiroStopReason 里:后者只做「stopReason → 处置」的映射,
    // 不应知道流里到底吐了多少东西(SSOT 分层)。
    usage.terminal.emptyOutput = totalOutputChars === 0 && !hasAnyToolCall
    if (usage.terminal.shouldFail) {
      proxyLogger.warn('Kiro', `Upstream terminated abnormally: stopReason=${usage.terminal.upstreamStopReason ?? 'ABSENT'} disposition=${usage.terminal.disposition} outChars=${totalOutputChars} tools=${processedIds.size}`)
    }
    
    // 流式事件聚合摘要
    if (logStreamEvents && Object.keys(streamEventCounts).length > 0) {
      const total = Object.values(streamEventCounts).reduce((a, b) => a + b, 0)
      proxyLogger.debug('Kiro', `Stream events summary (${total} total)`, streamEventCounts)
    }
    
    throwIfAborted(signal)
    // [STREAM-END] 取证:residual>0 = 上游流在半截帧处断掉,但当前代码仍走 onComplete → 客户端收 end_turn
    emitStreamEndDiag(buffer.length > 0 ? 'eof_with_truncated_frame' : 'clean_eof')
    // 2026-08-07 观测(尚未改处置):半截帧 EOF 是「上游流被硬掐断」的确证信号,
    // 而 classifyKiroStopReason 只看 stopReason、看不到 residual —— 于是这里仍会
    // 以 complete/tool_use 收场,客户端判本轮正常完成 → 静默停止(与 1d74a05 修掉的
    // CONTENT_FILTERED 同一个病灶,但这条分支当时 458 条实测 residual 全为 0 未暴露)。
    // 先只打独立告警确认这条分支是否真被命中;命中后再决定是否纳入 terminal 分类,
    // 避免重蹈 e106792「基于未验证假设改行为、最后整块回滚」。
    if (buffer.length > 0) {
      proxyLogger.warn('Kiro', `[STREAM-TRUNCATED-FRAME] 上游在半截帧处断流但被当成正常完成:`
        + ` residualBytes=${buffer.length} outChars=${totalOutputChars}`
        + ` disposition=${usage.terminal?.disposition ?? 'none'}`
        + ` stopReason=${diagUpstreamStopReason ?? 'ABSENT'}`)
    }
    proxyLogger.info('Kiro', 'Stream complete, final usage', usage)
    onComplete(usage)
  } catch (error) {
    // [STREAM-ERROR] 调试:看 stream 提前中断的根因(filterToolLeak 抛错 / event 解析异常 / abort)
    if (toolLeakDebug) console.log(`[tool-leak-fix] [STREAM-ERROR]`, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    emitStreamEndDiag(
      signal?.aborted ? 'client_abort' : 'reader_or_parse_error',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
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
        // 非流式路径统一拦截上游异常终止(2026-08-01 修 CONTENT_FILTERED 静默断流)。
        // 为什么在这里单点拦截而不是改各 caller:非流式有 9 个 callsite 散在多条路径的重试分支里
        // (git grep 'callKiroApi(' -- proxyServer.ts),逐个改必漏;且它们全部已被 try/catch 或
        // callWithRetry 包裹,reject 会被现成的错误处理接住 → 客户端拿到明确 HTTP 错误而非
        // 一个 finishReason:'STOP' 的半截 JSON。SSOT:分类逻辑只有 classifyKiroStopReason 一处。
        if (u.terminal?.shouldFail) {
          const reason = u.terminal.upstreamStopReason || u.terminal.disposition
          reject(new Error(
            u.terminal.disposition === 'filtered'
              ? `Upstream content filter truncated the response (stopReason: ${reason}). 输出不完整,请重试或调整措辞。`
              : `Upstream terminated abnormally (stopReason: ${reason}). 响应不完整,请重试。`
          ))
          return
        }
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

// ============ 跨账户共享模型 catalog(仅 UI 展示兜底,禁止用于能力路由) ============
//
// **用途(唯一合法):** 账户凭据/权限故障时保障 GET /v1/models 不空白,UI 至少能显示"曾经拉到过的完整模型清单".
// **与 region 无关**、**与账户能力路由无关**.
//
// 🚫 **禁止**用于账户能力路由决策: 跨账户 catalog 会把 A 账户支持的模型错误当成 B 账户的能力信号,
// 导致 gpt-5.6 请求路由到 eu profile 的账户 → stream 端 unsupported → 用户明确禁止的错误码兜底路径.
// 能力路由请使用 ProxyAccount.modelCapabilities 三态标记(confirmed/unsupported/unknown).
// 详见 .agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/decision-card.md 附录 A Bug 3.
//
// 架构闸门(test/main/architecture/no_shared_catalog_in_routing.test.ts)硬拒 accountPool.ts / proxyServer.ts
// 的路由代码引用本 catalog(handleModels 白名单例外,那里合法拼接 UI 模型清单).
//
// TTL 30 min:模型 catalog 变化频率低于单账户缓存的 5 min,给用户提供更稳定 UI.
// 详见 .agent-workspace/.archive/2026-07-12/kiro-endpoint-migration/*-rca.md(2026-07 迁移原始 RCA)

interface SharedModelCatalogForUI {
  models: KiroModel[]
  timestamp: number
  sourceEmail?: string  // 来源账户,用于日志和潜在的 UI 提示
}
const SHARED_MODEL_CATALOG_TTL_MS = 30 * 60 * 1000
let sharedModelCatalogForUI: SharedModelCatalogForUI | null = null

function getSharedModelCatalogForUI(): SharedModelCatalogForUI | null {
  if (!sharedModelCatalogForUI) return null
  if (Date.now() - sharedModelCatalogForUI.timestamp > SHARED_MODEL_CATALOG_TTL_MS) return null
  return sharedModelCatalogForUI
}

function setSharedModelCatalogForUI(models: KiroModel[], account: ProxyAccount): void {
  if (!models || models.length === 0) return
  sharedModelCatalogForUI = {
    models: models.map(m => ({ ...m })),
    timestamp: Date.now(),
    sourceEmail: account.email
  }
  console.log(`[KiroAPI] Shared model catalog (UI-only) updated: ${models.length} models from ${account.email || account.id.slice(0, 8)}`)
}

/** 外部可读(供 UI 层使用),返回当前共享 catalog 的 clone 或 null.
 * ⚠ **禁止用于账户能力路由决策**,只允许 UI 展示层(如 GET /v1/models handleModels)合并使用. */
export function getSharedModelCatalogSnapshot(): KiroModel[] | null {
  const shared = getSharedModelCatalogForUI()
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
 * 从 profileArn 解析真实数据面 region。
 * arn 格式:arn:aws:codewhisperer:{region}:{accountId}:profile/{profileId}
 * 跨 region 用户:身份 SSO region(refresh 用)可能 ≠ profile region(数据面 API 用)
 */
export function parseRegionFromProfileArn(arn: string | undefined | null): string | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  // arn:aws:codewhisperer:{region}:...
  if (parts.length >= 4 && parts[0] === 'arn' && parts[2] === 'codewhisperer') {
    return parts[3] || undefined
  }
  return undefined
}

/**
 * 已知 CodeWhisperer 数据面 profile 可能存在的 region 集合。
 *
 * ⚠️ **仅用于数据面 API**(CodeWhisperer profile / ListAvailableProfiles /
 * ListAvailableModels / streaming endpoints)—— CW 数据面官方 rollout 只在
 * us-east-1 (N. Virginia) 和 eu-central-1 (Frankfurt) 两个 region。
 *
 * ❌ **禁止**用于 SSO OIDC token refresh / RegisterClient —— AWS IAM Identity
 * Center 在每个 AWS region 有独立 OIDC 实例(如 us-east-2),不受此二选一
 * 限制。SSO OIDC 场景请用 {@link KNOWN_SSO_OIDC_REGIONS}。
 *
 * 混用历史证据:.agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/
 * (sso=us-east-2 账户 token 过期后 refresh 跨 region fallback 探不到 us-east-2 → 永久失活)
 */
export const KNOWN_CW_DATA_REGIONS: readonly string[] = ['us-east-1', 'eu-central-1']

/**
 * AWS IAM Identity Center / SSO OIDC 已知 region 全集(全 AWS 商用 region)。
 *
 * ✅ **用于**:`oidc.{region}.amazonaws.com/token` 刷 token / `client/register`
 *              等 SSO OIDC 端点,以及本项目 IAM SSO Authorization Code flow
 *              主 region 拒绝时的跨 region fallback 探测。
 *
 * 与 `src/renderer/src/lib/awsRegions.ts`(前端 UI SSOT)保持 21-region 同步。
 * 新增 AWS region 时两处一起改。
 */
export const KNOWN_SSO_OIDC_REGIONS: readonly string[] = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'eu-north-1', 'eu-south-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1',
  'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'
]

/**
 * @deprecated 语义歧义,请显式选用:
 *   - 数据面 API(CW profile / models / stream) → {@link KNOWN_CW_DATA_REGIONS}
 *   - SSO OIDC(token refresh / client register) → {@link KNOWN_SSO_OIDC_REGIONS}
 * 保留 alias 仅为兼容早期外部 import;新代码禁止使用。
 */
export const KNOWN_CW_REGIONS: readonly string[] = KNOWN_CW_DATA_REGIONS

/** 单次 region 尝试:200 返数组(可能空);非 200 返 null 表示这个 region 拒了 */
async function tryListProfilesAt(
  account: ProxyAccount,
  region: string,
  headers: Record<string, string>
): Promise<Array<{ arn?: string; profileName?: string }> | null> {
  const baseUrl = getCodeWhispererEndpoint(region)
  const url = `${baseUrl}/ListAvailableProfiles`
  const response = await fetchWithProxy(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  }, account)
  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    console.warn(`[KiroAPI] ListAvailableProfiles @${region} → ${response.status} ${errBody.slice(0, 150)}`)
    return null
  }
  const data = await response.json() as { profiles?: Array<{ arn?: string; profileName?: string }> }
  return data.profiles || []
}

/**
 * Enterprise 账号获取 profileArn(通过 CodeWhisperer Runtime 的 /ListAvailableProfiles)
 * 官方 IDE 在认证后通过此 API 获取可用 profiles,用户选择后存储 ARN。
 * 反代自动取第一个 profile。
 *
 * 跨 region 用户支持(2026-07-14):身份 SSO region ≠ profile region 的场景
 *   - 用户 SSO 在 eu-central-1(refresh 用),但组织 profile 挂在 us-east-1
 *   - 首选 account.region 打,profiles=[] 时自动跨 region 探测已知的 CW region
 *   - 找到有 profile 的 region → 返 arn(caller 可用 parseRegionFromProfileArn 解析真 region 用于后续 API)
 */
export async function fetchEnterpriseProfileArn(account: ProxyAccount): Promise<string | undefined> {
  const machineId = getAccountMachineId(account.id, account.machineId)

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-amz-json-1.0',
    'Authorization': `Bearer ${account.accessToken}`,
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'user-agent': getKiroUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }
  // external_idp (Azure AD) 需 TokenType header 走外部 IdP 校验路径,否则 CW REST 拒 403 "Invalid token"
  // 2026-07 迁移:所有账户类型统一 SSO_OIDC(仅 external_idp 用 EXTERNAL_IDP)
  headers['TokenType'] = getTokenTypeHeader(account)

  // 获取该账号类型对应的备用 ARN(403 时兜底,避免每次请求都重复尝试)
  const fallbackArn = resolveProfileArn(account)

  // 探测顺序:account.region 优先,其他已知 CW 数据面 region 兜底(去重)
  const primaryRegion = account.region || 'us-east-1'
  const probeRegions = [primaryRegion, ...KNOWN_CW_DATA_REGIONS.filter(r => r !== primaryRegion)]
  console.log(`[KiroAPI] fetchEnterpriseProfileArn probe order: [${probeRegions.join(', ')}]`)

  let lastAccessDenied = false
  try {
    for (const region of probeRegions) {
      const profiles = await tryListProfilesAt(account, region, headers)
      if (profiles === null) {
        // 该 region 拒了(403/500 等)→ 继续下一个 region
        lastAccessDenied = true
        continue
      }
      if (profiles.length === 0) {
        // 该 region 200 但空 → 该 region 无 profile,试下一个
        console.log(`[KiroAPI] @${region}: profiles=[] · try next region`)
        continue
      }
      const arn = profiles[0].arn
      if (arn) {
        console.log(`[KiroAPI] Enterprise profileArn resolved @${region}: ${arn}`)
        return arn
      }
    }
    // 所有 region 都试完 · 空
    if (lastAccessDenied && fallbackArn) {
      console.log(`[KiroAPI] All regions denied; using fallback profileArn for ${account.provider || 'unknown'}: ${fallbackArn}`)
      return fallbackArn
    }
    console.warn('[KiroAPI] ListAvailableProfiles: no profiles across all known regions')
    return undefined
  } catch (error) {
    console.error('[KiroAPI] fetchEnterpriseProfileArn error:', error)
    return undefined
  }
}

// ============ 多 profile 登录路径(2026-07-13 新增,与老 fetchEnterpriseProfileArn 并存)============
// 决策卡 v2:external_idp + IdC 多 profile 场景共用此函数
// 老 fetchEnterpriseProfileArn 一行不动(3 处调用点契约保护:fetchKiroModels 自愈 / fetchAvailableSubscriptions / index.ts 里 3 处)
// 参见 .agent-workspace/.archive/2026-07-13/multi-profile-import/multi-profile-import-decision-card.md

/** 归一化后的 Kiro Profile 结构(防腐层:后端字段变化不泄漏到 renderer) */
export interface KiroProfile {
  /** 完整 ARN(去重键的一部分) */
  profileArn: string
  /** 展示名(UI 主标题,可选,fallback ARN 尾段) */
  profileName?: string
  /** AWS 账号名(UI 副标题,可选) */
  accountName?: string
  /** profile 所在 region(us-east-1 / eu-central-1) */
  region?: string
}

/** ListAvailableProfiles 返空数组时抛的错误常量,供上游 catch 通过 error.message 精准匹配 */
export const NO_PROFILES_AVAILABLE = 'NO_PROFILES_AVAILABLE'

/** fetchEnterpriseProfiles 可注入依赖(测试用,生产不传;通过依赖注入避免测试真实网络) */
export interface FetchEnterpriseProfilesDeps {
  fetcher?: (url: string, options: RequestInit, account?: ProxyAccount) => Promise<Response>
}

/**
 * 拉取 external_idp / IdC 账户下所有可用 Kiro Profile(专给多 profile 登录路径)。
 * - 与老 fetchEnterpriseProfileArn 并存,老函数一行不动
 * - 空数组 → 抛 NO_PROFILES_AVAILABLE(不返空数组给上游,避免空态歧义)
 * - 4xx/5xx → 抛错并透传 status + backend errorMessage,不吞(不做 fetchEnterpriseProfileArn 里的 403 fallback)
 * - 单 profile → 返 1 元素数组(不"退化"成单值,类型稳定)
 */
export async function fetchEnterpriseProfiles(
  account: ProxyAccount,
  deps: FetchEnterpriseProfilesDeps = {}
): Promise<Array<KiroProfile>> {
  const fetcher = deps.fetcher ?? fetchWithProxy
  const machineId = getAccountMachineId(account.id, account.machineId)

  const buildHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/x-amz-json-1.0',
    'Authorization': `Bearer ${account.accessToken}`,
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'user-agent': getKiroUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1',
    'TokenType': getTokenTypeHeader(account)
  })

  // 跨 region 探测:同一 SSO 账户组织可能同时挂 us-east-1 + eu-central-1 两个 Kiro Profile,
  // 老代码只用 account.region 单 region 探,第二个 region 的 profile 永远拿不到。
  // 修法(6ab368b 提交的未修变体登记债务清理):跨 KNOWN_CW_DATA_REGIONS 并行探,合并去重。
  // 主 region(account.region 或默认 us-east-1)优先,其他 region 补充。
  // 注:数据面 CW profile region 严格二选一,不与 SSO OIDC region 集合混用(见常量定义 JSDoc)。
  const primaryRegion = account.region || 'us-east-1'
  const probeRegions: string[] = [primaryRegion, ...KNOWN_CW_DATA_REGIONS.filter((r) => r !== primaryRegion)]

  interface RegionResult {
    region: string
    isPrimary: boolean
    ok: boolean
    status?: number
    errorBody?: string
    rawProfiles: Array<{ arn?: string; profileName?: string; accountName?: string; region?: string }>
  }

  const results = await Promise.all(
    probeRegions.map(async (region, idx): Promise<RegionResult> => {
      const baseUrl = getCodeWhispererEndpoint(region)
      const url = `${baseUrl}/ListAvailableProfiles`
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({})
        }, account)

        if (!response.ok) {
          const errBody = await response.text().catch(() => '')
          const trimmed = errBody.slice(0, 300)
          console.warn(
            `[KiroAPI] fetchEnterpriseProfiles @${region} failed: ${response.status} ${trimmed}`
          )
          return { region, isPrimary: idx === 0, ok: false, status: response.status, errorBody: trimmed, rawProfiles: [] }
        }

        const data = await response.json() as {
          profiles?: Array<{ arn?: string; profileName?: string; accountName?: string; region?: string }>
        }
        return {
          region,
          isPrimary: idx === 0,
          ok: true,
          rawProfiles: Array.isArray(data.profiles) ? data.profiles : []
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[KiroAPI] fetchEnterpriseProfiles @${region} threw: ${msg}`)
        return { region, isPrimary: idx === 0, ok: false, errorBody: msg, rawProfiles: [] }
      }
    })
  )

  // 主 region 失败(4xx/5xx)→ 抛错,与老单 region 行为一致
  // "主 region 拒 = 请求本身有问题(token/权限)"不应用备用 region 掩盖
  // 主 region 200 但空 → 允许跨 region 补充(用户跨 region 场景的核心 case)
  const primary = results[0]
  if (!primary.ok) {
    console.error(
      `[KiroAPI] fetchEnterpriseProfiles failed: ${primary.status || 'network'} ${primary.errorBody || ''}`
    )
    throw new Error(
      `ListAvailableProfiles HTTP ${primary.status || 'ERR'}: ${primary.errorBody || 'unknown'}`
    )
  }

  // 合并所有 ok region 的 rawProfiles,按 arn 去重(保序:主 region 优先)
  const seen = new Set<string>()
  const merged: Array<{ arn: string; profileName?: string; accountName?: string; region?: string }> = []
  for (const r of results) {
    if (!r.ok) continue
    for (const p of r.rawProfiles) {
      if (typeof p?.arn === 'string' && p.arn.length > 0 && !seen.has(p.arn)) {
        seen.add(p.arn)
        merged.push({ arn: p.arn, profileName: p.profileName, accountName: p.accountName, region: p.region || r.region })
      }
    }
  }

  if (merged.length === 0) {
    console.warn('[KiroAPI] fetchEnterpriseProfiles: no profiles across all known regions')
    throw new Error(NO_PROFILES_AVAILABLE)
  }

  const profiles: KiroProfile[] = merged.map((p) => ({
    profileArn: p.arn,
    profileName: p.profileName,
    accountName: p.accountName,
    region: p.region
  }))

  console.log(`[KiroAPI] fetchEnterpriseProfiles resolved ${profiles.length} profile(s) across [${probeRegions.join(', ')}]`)
  return profiles
}

// 获取 Kiro 官方模型列表（支持分页，与官方插件一致传递 profileArn）
export async function fetchKiroModels(account: ProxyAccount, signal?: AbortSignal): Promise<KiroModel[]> {
  // 跨 region 账户:profileArn 里的 region 才是数据面正确 region(242a117 同源修法)
  const baseUrl = getQServiceEndpoint(parseRegionFromProfileArn(account.profileArn) || account.region)
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

  // ============ v1.7.6 fetchKiroModels 自愈闭环(§附录 A Bug 4) ============
  // 403 → 先尝试 token refresh → 再尝试 Enterprise profileArn 自愈 → 最后才落 catalog(仅 UI 兜底)
  // 顺序不允许调换:catalog 是最弱兜底,先自愈能救回来的账号
  let attemptedRefresh = false
  let attemptedArnHeal = false

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

      // 每次请求都用最新 accessToken (自愈刷新可能改了)
      headers['Authorization'] = `Bearer ${account.accessToken}`

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

        // ============ v1.7.6 403 自愈闭环(顺序 = token refresh → arn heal → catalog) ============
        if (response.status === 403 && allModels.length === 0) {
          // 1) Token 刷新: 有 refreshToken 且未试过 → 刷新 + 重试(不 break, 继续 do-while)
          if (!attemptedRefresh && account.refreshToken && modelFetchTokenRefreshCallback) {
            attemptedRefresh = true
            console.warn('[KiroAPI] 403 detected, attempting token refresh before catalog fallback')
            try {
              const refreshResult = await modelFetchTokenRefreshCallback(account)
              if (refreshResult.ok && refreshResult.accessToken) {
                account.accessToken = refreshResult.accessToken
                if (refreshResult.refreshToken) account.refreshToken = refreshResult.refreshToken
                if (refreshResult.expiresAt) account.expiresAt = refreshResult.expiresAt
                console.log('[KiroAPI] Token refreshed, retrying ListAvailableModels')
                continue // 重试当前迭代
              }
              console.warn('[KiroAPI] Token refresh failed, moving to ARN heal')
            } catch (e) {
              console.warn('[KiroAPI] Token refresh threw:', e instanceof Error ? e.message : e)
            }
          }
          // 2) profileArn 自愈: Enterprise 账号 arn 可能失效 → 重新 fetch
          if (!attemptedArnHeal && isEnterprise) {
            attemptedArnHeal = true
            console.warn('[KiroAPI] Attempting Enterprise profileArn heal')
            try {
              const fetchedArn = await fetchEnterpriseProfileArn(account)
              if (fetchedArn && fetchedArn !== account.profileArn) {
                account.profileArn = fetchedArn
                if (account.id) profileArnPersistCallback?.(account.id, fetchedArn)
                console.log(`[KiroAPI] profileArn healed to ${fetchedArn}, retrying`)
                continue // 重试当前迭代
              }
              console.warn('[KiroAPI] profileArn heal returned same/empty ARN')
            } catch (e) {
              console.warn('[KiroAPI] fetchEnterpriseProfileArn threw:', e instanceof Error ? e.message : e)
            }
          }
        }

        // 3) 自愈都失败(或非 403) → catalog 兜底(仅 UI),同时通知能力路由该账号同步失败
        if (allModels.length === 0) {
          accountModelSyncCallback?.(account.id, [], 'failed')
          const shared = getSharedModelCatalogForUI()
          if (shared) {
            console.warn(`[KiroAPI] Fetch failed after self-heal attempts, using shared catalog for UI (${shared.models.length} models from ${shared.sourceEmail}). NOTE: 此数据仅用于 UI 展示,能力路由不采信.`)
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

    // 2026-07 迁移:成功 fetch → 写入跨账户共享 catalog(仅 UI 兜底,能力路由不采信)
    if (allModels.length > 0) {
      setSharedModelCatalogForUI(allModels, account)
      // v1.7.6 能力反哺:成功返回 → 通知 accountPool 更新 modelCapabilities
      accountModelSyncCallback?.(account.id, allModels.map(m => m.modelId), 'ok')
    }
    return allModels
  } catch (error) {
    if (signal?.aborted) throw getAbortError(signal)
    console.error('[KiroAPI] ListAvailableModels error:', error)
    // 2026-07 迁移:网络错误/host 不可达时 → 读跨账户共享 catalog
    if (allModels.length === 0) {
      accountModelSyncCallback?.(account.id, [], 'failed')
      const shared = getSharedModelCatalogForUI()
      if (shared) {
        console.warn(`[KiroAPI] Network error, using shared catalog for UI (${shared.models.length} models from ${shared.sourceEmail}). NOTE: 此数据仅用于 UI 展示,能力路由不采信.`)
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
  const baseUrl = getQServiceEndpoint(parseRegionFromProfileArn(account.profileArn) || account.region)
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
  const baseUrl = getQServiceEndpoint(parseRegionFromProfileArn(account.profileArn) || account.region)
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
  const baseUrl = getQServiceEndpoint(parseRegionFromProfileArn(account.profileArn) || account.region)
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
