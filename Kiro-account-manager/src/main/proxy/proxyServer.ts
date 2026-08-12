// Kiro Proxy HTTP/HTTPS 服务器
import http from 'http'
import https from 'https'
import fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { safeStringEq, isBindingExternal, isIPAllowed } from '../utils/netGuard'
import type { Socket } from 'net'
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIResponsesRequest,
  ClaudeRequest,
  ClaudeContentBlock,
  ClaudeCacheControl,
  ProxyConfig,
  ProxyStats,
  ProxyAccount,
  TokenRefreshCallback,
  ProxySessionRecord
} from './types'
import { AccountPool, ErrorType, classifyError, extractHttpStatusCode } from './accountPool'
import { SmoothWeightedRoundRobin } from '../utils/smoothWeightedRoundRobin'
import { callKiroApiStream, callKiroApi, fetchKiroModels, setModelContextWindow, createUpstreamAttemptCounter, sampleTailShape, type KiroModel } from './kiroApi'
import { proxyLogger } from './logger'
import { perfDiag } from './perfDiag'
import { classifyNoAccountHold, type NoAccountHoldDecision } from './holdDecision'
import { detectGptHalt, isGptModel, GPT_HALT_NUDGE } from './gptHalt'
import { getKProxyService, generateDeviceId } from '../kproxy'
import {
  openaiToKiro,
  claudeToKiro,
  kiroToOpenaiResponse,
  type ThinkingConfig,
  kiroToClaudeResponse,
  createOpenaiStreamChunk,
  createClaudeStreamEvent,
  responsesToOpenAIChat,
  openAIChatToResponsesResponse,
  setInjectExecutionDirective
} from './translator'
import { ToolNameRegistry } from './toolNameRegistry'
import { promptCacheTracker } from './promptCacheTracker'
import { loadSteeringDocuments, formatSteeringForPrompt, type SteeringDocument } from './steeringLoader'
import { HoldGate, realClock, type HoldGateRuntimeConfig, type HeldRequestHooks, type HoldReason, type HoldEpisode, type HoldGateEvent } from './holdGate'
import { normalizeHoldConfig } from './holdConfig'
import { ensureProxySelfSignedCert, type ProxySelfSignedCert } from './selfSignedCert'


/**
 * 该错误是否属于「上游终止类失败」—— 上游内容过滤器截断 / 上游异常终止。
 *
 * 这类失败**既不是账号的错，也不是请求本身的错**，处置上三点不同于普通错误：
 *   ① 状态码 502 而非 500（500 会让人以为反代自己炸了）
 *   ② 不记进账号错误计数（换号一样被同一个过滤器拦）
 *   ③ 日志需带 model / responseTime，否则 UI 上只剩一行 `-`
 *
 * 判据收口成一个导出函数是为了可测 + 单一真源；文案真源是 `kiroApi.ts` 非流式
 * onComplete 拦截处抛出的那两条消息（`Upstream content filter truncated…` /
 * `Upstream terminated abnormally…`），改文案时必须同步这里。
 */
export function isUpstreamTerminalFailure(message: string): boolean {
  return /Upstream (content filter truncated|terminated abnormally)/i.test(message || '')
}

export interface ProxyServerEvents {
  onRequest?: (info: { path: string; method: string; accountId?: string }) => void
  /**
   * 可选诊断字段(RCA 2026-08-11 429-latency-throughput §3 观测缺口):
   * - `ttft`: 首 token 延迟 ms —— 与 responseTime(端到端)分离,用于区分
   *   「上游/排队慢」vs「流式输出慢」。此前全仓零 TTFT 打点,首响慢无法归因。
   * - `upstream429`: 本次客户端请求内部累计遭遇的上游 429 次数。
   * - `upstreamAttempts`: 本次请求实际发出的上游尝试总数(含端点回退与账号切换)。
   *   实测基线 7.3 次/请求;它与 responseTime 一起才能解释长尾。
   * - `accountId`: 归因到账号 —— 实测同区域账号 429 率落差 5.4%↔75%。
   * 全部 optional:未接线的 onResponse 调用点行为不变。
   */
  onResponse?: (info: { path: string; model?: string; status: number; tokens?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; credits?: number; responseTime?: number; error?: string; ttft?: number; upstream429?: number; upstreamAttempts?: number; accountId?: string }) => void
  onError?: (error: Error) => void
  onConfigChanged?: (config: ProxyConfig) => void  // API Key 用量更新时触发
  onStatusChange?: (running: boolean, port: number) => void
  onTokenRefresh?: TokenRefreshCallback
  onAccountUpdate?: (account: ProxyAccount) => void
  // 账号被 Kiro 后端长期封禁（如 TEMPORARILY_SUSPENDED / AccountSuspendedException）
  // 不同于临时 token 失效，需人工解封
  onAccountSuspended?: (info: { accountId: string; email?: string; reason: string; message: string }) => void
  onCreditsUpdate?: (totalCredits: number) => void
  onTokensUpdate?: (inputTokens: number, outputTokens: number) => void
  onRequestStatsUpdate?: (totalRequests: number, successRequests: number, failedRequests: number) => void
  // 会话内定期快照回调：服务运行中每 60s 用 snapshotSession() 触发一次，主进程写 store 作为 orphan 保底（强杀/崩溃下次启动能归档）
  onSessionTick?: (record: ProxySessionRecord) => void
  onPoolEmpty?: () => Promise<void> // 账号池为空时触发（冷启动懒加载）
  // 挂起门闸:当前被挂起(HELD)请求数变化时触发,驱动前端徽标/放行按钮态
  // 方案:.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §5
  onHeldRequestsChanged?: (info: HeldRequestsInfo) => void
}

/**
 * 挂起自动放行读数(决策卡 hold-gate-auto-release §3 字段契约 · 三字段钉死)。
 *
 * 语义纪律(消除三端各自猜测):
 * - `nextAutoReleaseAt` 的 `null` = 「没有下一次」(关闭 / 无挂起条目 / 反代未运行)。
 *   **禁用 `0` 表达「无」** —— `0` 是合法 epoch。
 * - 只推**绝对**时间戳:倒计时由前端 `nextAutoReleaseAt - Date.now()` 本地每秒渲染,
 *   主进程不推倒计时数值(推送是事件驱动、倒计时是连续量)→ 推送频率不变。
 * - `autoReleaseCount` 口径 = 一次 timer 触发 +1(哪怕该次放了 0 个条目),手动放行不计入。
 */
export interface HoldAutoReleaseState {
  /** 调度器当前是否生效 = 自动放行配置值 && 挂起门闸总开关。 */
  autoReleaseEnabled: boolean
  /** 下次自动放行的绝对 epoch ms;`null` = 没有下一次。 */
  nextAutoReleaseAt: number | null
  /** 本次反代启动以来的自动放行**周期次数**(非条目数)。 */
  autoReleaseCount: number
}

/** `onHeldRequestsChanged` 推送形状 + `proxy-get-held-requests` 返回形状(同一形状,单一构造点)。 */
export interface HeldRequestsInfo extends HoldAutoReleaseState {
  /** 当前挂起中的请求数。 */
  count: number
  /**
   * 当前进行中的那一轮挂起(含触发原因 / 起始时刻 / 已放行明细);`null` = 当前无挂起。
   * 决策卡 hold-gate-observability。
   */
  currentEpisode: HoldEpisode | null
  /** 最近已结束的挂起轮次,最新在前(≤ 20)。 */
  recentEpisodes: HoldEpisode[]
}

type ModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

type ClientModel = {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  description: string
  model_name?: string
  family: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  interleaved: boolean | { field: 'reasoning_content' }
  cost: { input: number; output: number; cache_read: number; cache_write: number }
  limit: { context: number; input?: number; output: number }
  modalities: { input: ModelModality[]; output: ModelModality[] }
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: Record<ModelModality, boolean>
    output: Record<ModelModality, boolean>
    interleaved: boolean | { field: 'reasoning_content' }
  }
  context_length: number
  max_tokens: number
  max_input_tokens?: number
  max_output_tokens: number
  inputTypes?: string[]
  rateMultiplier?: number
  rateUnit?: string
  supportsThinking?: boolean
  thinkingEfforts?: string[]
  thinkingSchemaPath?: 'output_config' | 'reasoning'
  supportsPromptCaching?: boolean
  modelProvider?: string
  permission: unknown[]
  root: string
  parent: null
}

function modelDisplayName(id: string, modelName?: string): string {
  if (modelName?.trim()) return modelName
  return id
    .split('-')
    .filter(Boolean)
    .map(part => part === 'gpt' ? 'GPT' : part === 'ai' ? 'AI' : part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function modelFamily(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'claude-opus'
  if (lower.includes('sonnet')) return 'claude-sonnet'
  if (lower.includes('haiku')) return 'claude-haiku'
  // GPT-5.6 三档同族(sol/terra/luna 是并列 tier,不是不同家族)
  if (lower.startsWith('gpt-5')) return 'gpt-5.6'
  if (lower.includes('gpt-4o')) return 'gpt-4o'
  if (lower.includes('gpt-4')) return 'gpt-4'
  if (lower.includes('gpt-3.5')) return 'gpt-3.5'
  if (lower.includes('glm')) return 'glm'
  if (lower === 'auto') return 'auto'
  return lower.split(/[.-]/).slice(0, 2).join('-') || lower
}

function modelOutputLimit(id: string, output?: number | null): number {
  if (typeof output === 'number' && output > 0) return output
  const lower = id.toLowerCase()
  if (lower.includes('haiku') || lower.includes('gpt-3.5')) return 8192
  return 32000
}

function modelInputModalities(inputTypes?: string[]): ModelModality[] {
  const values = new Set<ModelModality>(['text'])
  for (const item of inputTypes ?? []) {
    const lower = item.toLowerCase()
    if (lower.includes('image')) values.add('image')
    if (lower.includes('pdf') || lower.includes('document') || lower.includes('file')) values.add('pdf')
    if (lower.includes('audio')) values.add('audio')
    if (lower.includes('video')) values.add('video')
  }
  return Array.from(values)
}

function modelCapabilityMap(modalities: ModelModality[]): Record<ModelModality, boolean> {
  return {
    text: modalities.includes('text'),
    audio: modalities.includes('audio'),
    image: modalities.includes('image'),
    video: modalities.includes('video'),
    pdf: modalities.includes('pdf')
  }
}

function extractThinkingSchema(schema?: Record<string, unknown> | null): { efforts?: string[]; schemaPath?: 'output_config' | 'reasoning' } | undefined {
  if (!schema) return undefined
  const props = schema.properties as Record<string, unknown> | undefined
  if (!props) return undefined
  // output_config 路径（Claude 4.6+ 新模型）
  if (props.output_config) {
    const effortField = (props.output_config as Record<string, unknown>)?.properties as Record<string, unknown> | undefined
    const effortEnum = (effortField?.effort as Record<string, unknown> | undefined)?.enum as string[] | undefined
    if (effortEnum && effortEnum.length > 0) {
      return { efforts: effortEnum, schemaPath: 'output_config' }
    }
  }
  // reasoning 路径（备用）
  if (props.reasoning) {
    const reasoningProps = (props.reasoning as Record<string, unknown>)?.properties as Record<string, unknown> | undefined
    const effortEnum = (reasoningProps?.effort as Record<string, unknown> | undefined)?.enum as string[] | undefined
    if (effortEnum && effortEnum.length > 0) {
      return { efforts: effortEnum, schemaPath: 'reasoning' }
    }
  }
  return undefined
}

function buildClientModel(input: {
  id: string
  created: number
  ownedBy: string
  description?: string
  modelName?: string
  supportedInputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
  rateMultiplier?: number
  rateUnit?: string
  promptCaching?: { supportsPromptCaching: boolean; maximumCacheCheckpointsPerRequest?: number | null; minimumTokensPerCacheCheckpoint?: number | null } | null
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null
  modelProvider?: string | null
}): ClientModel {
  const name = modelDisplayName(input.id, input.modelName)
  const inputModalities = modelInputModalities(input.supportedInputTypes)
  const outputModalities: ModelModality[] = ['text']
  const output = modelOutputLimit(input.id, input.maxOutputTokens)
  const context = typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? input.maxInputTokens : 200000
  const hasThinking = !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.thinking || !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.output_config
  const reasoning = hasThinking
  const interleaved = hasThinking ? { field: 'reasoning_content' as const } : false

  return {
    id: input.id,
    object: 'model',
    created: input.created,
    owned_by: input.ownedBy,
    name,
    description: input.description || name,
    model_name: input.modelName || name,
    family: modelFamily(input.id),
    release_date: '',
    attachment: inputModalities.some(item => item !== 'text'),
    reasoning,
    temperature: true,
    tool_call: true,
    interleaved,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: {
      context,
      ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? { input: input.maxInputTokens } : {}),
      output
    },
    modalities: { input: inputModalities, output: outputModalities },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: inputModalities.some(item => item !== 'text'),
      toolcall: true,
      input: modelCapabilityMap(inputModalities),
      output: modelCapabilityMap(outputModalities),
      interleaved
    },
    context_length: context,
    max_tokens: output,
    ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? { max_input_tokens: input.maxInputTokens } : {}),
    max_output_tokens: output,
    inputTypes: input.supportedInputTypes,
    rateMultiplier: input.rateMultiplier,
    rateUnit: input.rateUnit,
    supportsThinking: !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.thinking || !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.output_config,
    thinkingEfforts: extractThinkingSchema(input.additionalModelRequestFieldsSchema)?.efforts,
    thinkingSchemaPath: extractThinkingSchema(input.additionalModelRequestFieldsSchema)?.schemaPath,
    supportsPromptCaching: input.promptCaching?.supportsPromptCaching || false,
    modelProvider: input.modelProvider || undefined,
    permission: [],
    root: input.id,
    parent: null
  }
}

// 请求体超限错误（统一识别用，触发 413 响应）
class BodyTooLargeError extends Error {
  constructor(public readonly received: number, public readonly limit: number) {
    super(`Request body too large: ${received} bytes exceeds limit of ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

// ============ 挂起决策调试开关(RCA 2026-08-03)============
// 开启后在 runWithHold 每个决策分叉点(挂起 / 立即报错 / 换号 / attempt 上报错误)
// 打印详细日志,便于「AI SUB 中途莫名中断」类问题追溯。
//
// 开启方式:
//   ① 环境变量 HOLD_DEBUG=1 启动
//   ② 运行时代码里调 setHoldDebug(true)(可接 IPC 从设置页开关)
//
// 默认关闭以避免生产日志噪音。
let holdDebugEnabled = process.env.HOLD_DEBUG === '1'
export function setHoldDebug(enabled: boolean): void {
  holdDebugEnabled = enabled
  console.log(`[HoldGate][DEBUG] holdDebugEnabled=${enabled}`)
}
export function isHoldDebug(): boolean {
  return holdDebugEnabled
}

export class ProxyServer {
  private server: http.Server | https.Server | null = null
  private fallbackServer: http.Server | null = null  // HTTPS 启用时同时监听 HTTP（可选）
  private accountPool: AccountPool
  private config: ProxyConfig
  private stats: ProxyStats
  private sessionStats: { totalRequests: number; successRequests: number; failedRequests: number; credits: number; inputTokens: number; outputTokens: number; startTime: number }
  private events: ProxyServerEvents
  // 挂起门闸(Hold Gate):无可用账号时冻结流式请求。基础设施层建好实例 + 出口,
  // task#3 负责在 handleClaudeStream 错误汇合点调 enterHold 接线。
  // 方案:.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md
  private holdGate: HoldGate
  /** HoldGate 运行配置(持久引用;updateConfig 原地更新,HoldGate 持有同一引用) */
  private holdRuntimeConfig: HoldGateRuntimeConfig
  private refreshingTokens: Map<string, Promise<boolean>> = new Map() // 在途刷新去重（并发方共享同一结果）
  /** v1.7.6 probe-once: 单账户 × 单模型的探测锁,key=`${accountId}:${modelId}`,防并发爆量 */
  private modelProbeInflight: Map<string, number> = new Map()
  private isHttps: boolean = false
  private isStopping: boolean = false
  private activeRequests: Set<AbortController> = new Set()
  private sockets: Set<Socket> = new Set()
  /** P1-7 按 API Key/IP 的滑动窗口限流（每分钟桶） */
  private rateLimitBuckets: Map<string, { count: number; windowStart: number }> = new Map()
  /** P1-8 会话粘性：session hint → accountId 的映射（10 分钟 TTL） */
  private sessionAffinity: Map<string, { accountId: string; lastAt: number }> = new Map()
  /** P2-17 审计日志（最近 200 条） */
  private auditLog: Array<{ ts: number; type: string; data: Record<string, unknown> }> = []
  /** Webhook 触发回调（由外部注入，避免 main → renderer 循环依赖） */
  private webhookTrigger?: (event: string, payload: Record<string, unknown>) => void
  /** 定期清理 timer */
  private cleanupTimer: NodeJS.Timeout | null = null
  /** 会话快照 tick timer（每 60s 把 in-progress session 写入 store，防强杀/崩溃丢失） */
  private sessionSnapshotTimer: NodeJS.Timeout | null = null
  /** modelMapping loadbalance 的 SWRR instance,每 rule 一个,持久到 this 保持累积状态 */
  private modelMappingSwrr: Map<string, SmoothWeightedRoundRobin<{ id: string; target: string; weight: number }>> = new Map()

  /**
   * 从请求中提取 session hint，用于稳定 conversationId
   * 优先级 1：显式稳定 ID（header）
   * 优先级 2：请求体中的会话相关字段（body）
   * 优先级 3：返回 undefined（由 kiroApi 用 history fingerprint 兜底）
   */
  static extractSessionHint(req: http.IncomingMessage, body: unknown): string | undefined {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const h = req.headers
    // 优先级 1：显式稳定 header
    const headerHint =
      (h['x-claude-code-session-id'] as string) ||
      (h['x-opencode-session'] as string) ||
      (h['x-session-affinity'] as string) ||
      (h['x-conversation-id'] as string)
    if (headerHint) return headerHint

    // 优先级 2：body 中可靠的会话字段
    const bodyHint =
      (b.prompt_cache_key as string) ||
      (b.promptCacheKey as string) ||
      (b.conversation_id as string) ||
      (b.conversationId as string) ||
      (b.thread_id as string) ||
      (b.threadId as string) ||
      (b.session_id as string) ||
      (b.sessionId as string)
    if (bodyHint) return bodyHint

    // 优先级 2.5：metadata 中的 session/conversation
    const metadata = b.metadata as Record<string, unknown> | undefined
    if (metadata) {
      const metaHint =
        (metadata.session_id as string) ||
        (metadata.conversation_id as string)
      if (metaHint) return metaHint
    }

    // 优先级 3：无显式 ID，返回 undefined（kiroApi 用 history fingerprint 兜底）
    return undefined
  }

  /**
   * 自签证书落盘根目录（`<userDataPath>/proxy-tls/`）。由**装配层注入**，构造后只读。
   *
   * ## 为什么是构造参数，而不是塞进 `config`
   *
   * `src/main/index.ts` 有 6 处 `store.set('proxyConfig', server.getConfig())`，
   * 启动时又把它读回来喂构造函数。若把机器绝对路径混进 `config`，它就会被持久化并
   * 跨 IPC 发给渲染层；换机 / 换安装位置 / 恢复备份之后，一个**陈旧的外部路径**会被
   * 当成证书目录用 —— 且不报错。路径是**装配期事实**，不是用户可配置项，
   * 与 `config` 的生命周期根本不同。
   *
   * ## 为什么不是 `logger.ts` 那种模块级 setter
   *
   * `setLogTruncationEnabled()` 注入的是一个进程级布尔（全进程共用一个日志器，语义正确）。
   * 证书目录是 **per-instance** 的：本仓测试里有 39 处 `new ProxyServer(...)`，
   * 模块级单值会让它们互相覆盖同一份证书；服务端将来多实例同理。故取 `kproxy/index.ts`
   * 的构造参数形态。
   *
   * ## 为什么可选，而不是像 KProxyService 那样缺失即抛
   *
   * `KProxyService` 的 `dataPath` 是**每次运行都要用**的（CA 必落盘），缺失即抛是对的。
   * 而自签证书只在 `tls.enabled` 且未显式提供 cert/key 时才需要 —— 反代默认 HTTP，
   * 39 处既有测试构造点里没有一处走证书路径。若改成必填，等于为一条可选功能
   * 让 39 个无关调用点全部改签名（且 `tsconfig.node.json` 不含 `test/**`，
   * 类型检查根本挡不住漏改，只会在运行时炸）。
   *
   * 代价是「装配层漏接线」这一形态：此时三条证书路径**显式失败**（抛 / 返回 null +
   * 告警），绝不静默退化到 `process.cwd()`。静默兜底会让用户信赖的证书每次换位置
   * 且无任何报错，现场只剩「证书莫名失效」—— 比启动失败贵得多。
   */
  private readonly userDataPath: string | null

  /**
   * @param userDataPath 用户数据目录**绝对路径**。桌面端传 `app.getPath('userData')`，
   *   服务端传其配置目录。只用于自签证书落盘（见 `userDataPath` 字段注释）。
   *   省略则自签证书功能不可用，其余功能不受影响。
   */
  constructor(config: Partial<ProxyConfig> = {}, events: ProxyServerEvents = {}, userDataPath?: string) {
    if (userDataPath !== undefined) {
      if (typeof userDataPath !== 'string' || userDataPath.trim() === '') {
        throw new Error(
          '[ProxyServer] userDataPath 传了却是空值：要么不传（自签证书功能关闭），' +
            '要么传用户数据目录绝对路径。空串会让证书落到进程 cwd。'
        )
      }
      if (!path.isAbsolute(userDataPath)) {
        throw new Error(
          `[ProxyServer] userDataPath 必须是绝对路径，收到相对路径：${userDataPath}。` +
            '相对路径会随进程 cwd 漂移，等价于把证书写到随机位置。'
        )
      }
    }
    this.userDataPath = userDataPath ?? null

    this.config = {
      enabled: false,
      port: 5580,
      host: '127.0.0.1',
      enableMultiAccount: true,
      selectedAccountIds: [],
      logRequests: true,
      maxConcurrent: 10,
      maxRetries: 3,
      retryDelayMs: 1000,
      tokenRefreshBeforeExpiry: 300, // 5分钟提前刷新
      autoStart: false, // 是否自动启动
      clientDrivenToolExecution: true,
      ...config
    }
    this.accountPool = new AccountPool()
    this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'round-robin')
    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      totalCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      startTime: Date.now(),
      accountStats: new Map(),
      endpointStats: new Map(),
      modelStats: new Map(),
      recentRequests: []
    }
    this.sessionStats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      credits: 0,
      inputTokens: 0,
      outputTokens: 0,
      startTime: 0
    }
    this.events = events

    // 挂起门闸实例化(基础设施):注入真实时钟 + 池可用性查询 + 归一化后的 hold 配置。
    // holdRuntimeConfig 是持久引用对象,updateConfig 时 Object.assign 原地更新其字段;
    // HoldGate 持有同一引用,故新配置对之后 enterHold 的新请求即时生效(已 held 请求 timer 不追溯)。
    this.holdRuntimeConfig = normalizeHoldConfig(this.config)
    this.holdGate = new HoldGate({
      clock: realClock,
      isPoolAvailable: () => this.accountPool.availableCount > 0,
      config: this.holdRuntimeConfig,
      // 门闸事件 → 日志 + 诊断落盘。装配权在这一层:holdGate 是叶子模块,不认识 logger。
      // RCA 2026-08-12:此前放行只更新内存计数,proxy-logs.json 里放行事件零条 ——
      // 用户看到界面「累计放行 14 次」而时间线全是「0 次」,无从判断放行是否真的发生。
      onEvent: (ev) => this.onHoldGateEvent(ev)
    })
    // 事件即时唤醒:池从全挂→出现可用号时,若开关开 + 允许自动放行,则尝试放行挂起请求。
    // 时间衰减恢复(配额到点)的兜底轮询由 task#3 接线时叠加(方案 §5 A4)。
    this.accountPool.setAvailabilityListener(() => {
      if (this.config.holdWhenNoAccount && (this.config.holdAutoResumeOnAvailable ?? true)) {
        this.holdGate.tryResume()
      }
    })
  }

  /**
   * 门闸事件 → 日志 + 诊断落盘(RCA 2026-08-12)。
   *
   * 为什么放行必须留痕:用户在界面看到「累计放行 14 次」,同屏时间线却每轮都写「0 次 /
   * 尚未放行过」,而 proxy-logs.json 里放行事件**零条** —— 三个数字互相矛盾且都不可核对。
   * 挂起侧的日志在 RCA 2026-08-04 已补过,自动放行这条后加的路径又重犯同一个错。
   *
   * `released=0` 也照记:「周期触发了但无事可放」与「放行了但客户端没收到字节」是
   * 两个不同的世界,合并显示会让「放行到底有没有用」这个问题永远答不了。
   */
  private onHoldGateEvent(ev: HoldGateEvent): void {
    try {
      if (ev.kind === 'hold-entered') {
        // 挂起进入已有 proxyLogger.warn('HoldGate', …) 在决策处记录(含 blockedAccounts),
        // 这里只补诊断落盘,避免同一事实在 UI 日志里出现两条。
        if (perfDiag.isEnabled()) {
          perfDiag.write({
            kind: 'hold',
            ts: new Date(ev.at).toISOString(),
            event: 'entered',
            holdId: ev.id,
            reason: ev.reason,
            detail: ev.detail,
            heldCount: ev.heldCount
          })
        }
        return
      }
      if (ev.kind === 'release') {
        const what = ev.released > 0
          ? `放行 ${ev.released} 个挂起请求`
          : '放行周期触发但无请求可放(已被超时/断开带走)'
        const msg = `${what} · 触发=${ev.trigger} · 累计自动放行=${ev.autoReleaseCount} · 放行后仍挂起=${ev.heldCountAfter}`
        proxyLogger.info('HoldGate', msg, {
          trigger: ev.trigger,
          released: ev.released,
          autoReleaseCount: ev.autoReleaseCount,
          heldCountAfter: ev.heldCountAfter
        })
        if (perfDiag.isEnabled()) {
          perfDiag.write({
            kind: 'hold',
            ts: new Date(ev.at).toISOString(),
            event: 'release',
            trigger: ev.trigger,
            released: ev.released,
            autoReleaseCount: ev.autoReleaseCount,
            heldCount: ev.heldCountAfter
          })
        }
        return
      }
      // episode-ended:一轮挂起收尾。durationMs 是用户最关心的「这次挂了多久」。
      const mins = (ev.durationMs / 60000).toFixed(1)
      proxyLogger.info('HoldGate', `一轮挂起结束 · 持续 ${mins} 分钟 · 原因=${ev.reason} · 本轮放行 ${ev.releaseCount} 次`, {
        reason: ev.reason,
        durationMs: ev.durationMs,
        releaseCount: ev.releaseCount,
        startedAt: new Date(ev.startedAt).toISOString()
      })
      if (perfDiag.isEnabled()) {
        perfDiag.write({
          kind: 'hold',
          ts: new Date(ev.at).toISOString(),
          event: 'episode-ended',
          reason: ev.reason,
          durationMs: ev.durationMs,
          releaseCount: ev.releaseCount
        })
      }
    } catch {
      /* 观测失败绝不影响放行本身 */
    }
  }

  /** 手动放行所有挂起请求(前端"放行"按钮 → IPC)。@returns 实际放行数(幂等,无挂起时 0)。 */
  releaseHeldRequests(): number {
    const released = this.holdGate.releaseAll()
    this.events.onHeldRequestsChanged?.(this.buildHeldRequestsInfo())
    return released
  }

  /** 当前挂起中的请求数(前端徽标 + 放行按钮启用条件)。 */
  getHeldRequestsCount(): number {
    return this.holdGate.getHeldCount()
  }

  /** HoldGate 实例(task#3 接线 handleClaudeStream 时调 enterHold/abort 用)。 */
  getHoldGate(): HoldGate {
    return this.holdGate
  }

  /**
   * 挂起自动放行状态(前端倒计时 + 累计次数 · 决策卡 §3 读数链路节点 2)。
   *
   * `autoReleaseEnabled` 取**生效值** = 自动放行配置值 && `holdWhenNoAccount`:
   * 门闸总开关关闭时压根没有挂起条目可放,界面必须显示「未生效」而非「已开启」
   * (决策卡 Must NOT #5:界面显示已开启而实际不执行)。
   *
   * 开关值读 `holdRuntimeConfig` 而非另走 HoldGate getter:该对象与 HoldGate 持有的是
   * **同一引用**(构造时注入 + updateConfig 原地 `Object.assign`),故两侧视角不会漂移,
   * 且少一个跨模块符号依赖。
   */
  getHoldAutoReleaseState(): HoldAutoReleaseState {
    return {
      autoReleaseEnabled: this.holdRuntimeConfig.autoReleaseEnabled && !!this.config.holdWhenNoAccount,
      // null = 没有下一次;不做 `?? 0` 之类的兜底 —— 0 是合法 epoch,会被前端当成 1970 年。
      nextAutoReleaseAt: this.holdGate.getNextAutoReleaseAt(),
      autoReleaseCount: this.holdGate.getAutoReleaseCount()
    }
  }

  /**
   * 挂起读数的**单一构造点**:IPC 拉取与 `onHeldRequestsChanged` 两个发射点共用它。
   *
   * 为什么不在各处手抄字段:决策卡 §3 第 6 跳的失败行为是「两个发射点形状不一致 →
   * 前端字段时有时无」。收口成一个方法后,该失败形态在结构上不可能出现。
   */
  private buildHeldRequestsInfo(): HeldRequestsInfo {
    const timeline = this.holdGate.getTimeline()
    return {
      count: this.holdGate.getHeldCount(),
      ...this.getHoldAutoReleaseState(),
      currentEpisode: timeline.current,
      recentEpisodes: timeline.recent
    }
  }

  /**
   * 挂起读数的**公开出口**(IPC 拉取用)。与推送事件共用同一 {@link buildHeldRequestsInfo},
   * 故拉取与推送的形状在结构上不可能分叉。
   */
  getHeldRequestsInfo(): HeldRequestsInfo {
    return this.buildHeldRequestsInfo()
  }

  /** 触发挂起数变化事件(task#3 在 enterHold/abort 后调,驱动前端徽标)。 */
  emitHeldRequestsChanged(): void {
    this.events.onHeldRequestsChanged?.(this.buildHeldRequestsInfo())
  }

  /**
   * 检测当前绑定地址是否会暴露到本机以外
   * 0.0.0.0 / :: / 网卡地址 → true；127.0.0.1 / ::1 / localhost → false
   *
   * 判定逻辑已抽至 `utils/netGuard.ts`（Web 面板共用同一护栏）。
   * 此处保留薄 wrapper 让类内调用点零改动。
   */
  private isBindingExternal(host?: string): boolean {
    return isBindingExternal(host)
  }

  // 启动服务器
  async start(): Promise<void> {
    if (this.server) {
      console.log('[ProxyServer] Server already running')
      return
    }

    // v1.7.7 同步 prompt 注入开关到 translator module-level flag
    setInjectExecutionDirective(this.config.injectExecutionDirective ?? false)

    // P0-2 安全护栏：外网绑定 + 无 API Key → 拒绝启动（用户可以显式 allowExternalWithoutApiKey 解除）
    if (this.isBindingExternal(this.config.host)) {
      const hasAnyKey = (this.config.apiKeys?.some(k => k.enabled && k.key) ?? false) || !!this.config.apiKey
      if (!hasAnyKey && !this.config.allowExternalWithoutApiKey) {
        const err = new Error(
          `[Security] Refused to start: host=${this.config.host} exposes to network but no API Key configured. ` +
          `Set at least one API Key, or change host to 127.0.0.1, or set allowExternalWithoutApiKey=true (NOT RECOMMENDED).`
        )
        console.error('[ProxyServer]', err.message)
        this.events.onError?.(err)
        throw err
      }
      if (!hasAnyKey) {
        console.warn(`[ProxyServer] [Security] WARNING: binding to ${this.config.host} without API Key (allowExternalWithoutApiKey=true). This exposes your accounts to the network!`)
      }
    }

    return new Promise((resolve, reject) => {
      this.isStopping = false
      const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => 
        this.handleRequest(req, res)

      // 检查是否启用 TLS
      if (this.config.tls?.enabled) {
        try {
          const tlsOptions = this.getTlsOptions()
          this.server = https.createServer(tlsOptions, requestHandler)
          this.isHttps = true
        } catch (error) {
          reject(new Error(`TLS configuration error: ${(error as Error).message}`))
          return
        }
      } else {
        this.server = http.createServer(requestHandler)
        this.isHttps = false
      }

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[ProxyServer] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[ProxyServer] Server error:', error)
          reject(error)
        }
        this.events.onError?.(error)
      })

      this.server.on('connection', (socket: Socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
        // P1-10 backpressure 监控：socket 写入缓冲区超过 1MB 时记录警告
        socket.on('drain', () => {
          if (socket.writableLength > 0) {
            proxyLogger.debug('ProxyServer', `Socket drain: bufferedLen=${socket.writableLength}`)
          }
        })
      })

      // 服务器关闭时尝试自动重启
      this.server.on('close', () => {
        if (!this.isStopping && this.config.autoStart && this.config.enabled) {
          console.log('[ProxyServer] Server closed unexpectedly, attempting restart in 3s...')
          setTimeout(() => {
            if (!this.isStopping && this.config.autoStart && !this.isRunning()) {
              console.log('[ProxyServer] Auto-restarting...')
              this.start().catch(err => {
                console.error('[ProxyServer] Auto-restart failed:', err)
              })
            }
          }, 3000)
        }
      })

      // P1-11 keep-alive / headers 空闲超时（避免长连接占用资源）
      const keepAliveMs = this.config.keepAliveTimeoutMs ?? 65_000
      const headersMs = this.config.headersTimeoutMs ?? 60_000
      this.server.keepAliveTimeout = keepAliveMs
      this.server.headersTimeout = Math.max(headersMs, keepAliveMs + 1000) // headers 必须 > keepAlive，否则 Node 会 warn
      this.server.requestTimeout = 0  // 流式响应可能很长，禁用 request 总超时

      // 启动定期清理（每 5 分钟）
      if (this.cleanupTimer) clearInterval(this.cleanupTimer)
      this.cleanupTimer = setInterval(() => this.cleanupExpiredCaches(), 5 * 60_000)
      // 让 timer 在 Node 退出时不阻塞
      this.cleanupTimer.unref?.()

      // 会话快照 tick（每 60s 写 orphan snapshot 到 store，强杀/崩溃时下次启动能自动归档）
      if (this.sessionSnapshotTimer) clearInterval(this.sessionSnapshotTimer)
      this.sessionSnapshotTimer = setInterval(() => {
        try {
          const rec = this.snapshotSession()
          if (rec.totalRequests > 0) this.events.onSessionTick?.(rec)
        } catch { /* ignore */ }
      }, 60_000)
      this.sessionSnapshotTimer.unref?.()

      const protocol = this.isHttps ? 'https' : 'http'
      this.server.listen(this.config.port, this.config.host, () => {
        proxyLogger.info('ProxyServer', `Started on ${protocol}://${this.config.host}:${this.config.port} (keepAlive=${keepAliveMs}ms)`)
        this.stats.startTime = Date.now()
        // 重置会话统计（每次 start 开启一个新会话）
        this.sessionStats = {
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          credits: 0,
          inputTokens: 0,
          outputTokens: 0,
          startTime: Date.now()
        }
        // 挂起门闸的会话态同口径归零(自动放行累计次数 + 残留条目 + 调度器)。
        // 门闸实例在构造函数里建一次、**不随 stop/start 重建**,故不显式复位就会把上一会话的
        // 累计次数带进新会话(界面显示 2 而不是 0)。决策卡 §3 字段契约:「反代停止归零」。
        this.holdGate.resetSessionState()
        // 归零后立刻推一次:桌面端只在挂载时拉取一次、之后靠推送更新,若不推,界面会一直
        // 显示上一会话的累计值,直到下次挂起活动才被动刷新 —— 内存里归零 ≠ 用户看到 0。
        this.emitHeldRequestsChanged()
        this.events.onStatusChange?.(true, this.config.port)
        // v1.7.6 能力路由 cold-start bootstrap: 反代启动 + 能力路由开关打开 → fire-and-forget 全池同步
        // 不 await, 让 start() resolve 后 UI 立即可用; 同步完成前请求走 filterByModel 会看到 unknown,
        // strict 政策 400 提示同步中, probe-once 政策会试探. 决策卡 §5 承诺兑现
        if (this.config.enableModelCapabilityRouting && this.accountPool.size > 0) {
          this.syncCapabilities().catch((e) => {
            proxyLogger.warn('ProxyServer', `Bootstrap capability sync failed: ${e instanceof Error ? e.message : e}`)
          })
        }
        resolve()
      })

      // D4 启用 TLS 时同时监听 HTTP fallback 端口（如果配置了 fallbackPort）
      if (this.isHttps && this.config.fallbackPort && this.config.fallbackPort !== this.config.port) {
        const fallback = http.createServer(requestHandler)
        fallback.keepAliveTimeout = keepAliveMs
        fallback.headersTimeout = Math.max(headersMs, keepAliveMs + 1000)
        fallback.requestTimeout = 0
        fallback.on('connection', (socket) => {
          this.sockets.add(socket)
          socket.on('close', () => this.sockets.delete(socket))
        })
        fallback.on('error', (err) => proxyLogger.warn('ProxyServer', `Fallback HTTP error: ${err.message}`))
        fallback.listen(this.config.fallbackPort, this.config.host, () => {
          proxyLogger.info('ProxyServer', `Fallback HTTP listening on http://${this.config.host}:${this.config.fallbackPort}`)
        })
        this.fallbackServer = fallback
      }
    })
  }

  // 获取 TLS 配置选项
  // P1-13 当 tls.enabled 但未提供 cert/key 时，自动生成自签证书
  private getTlsOptions(): https.ServerOptions {
    const tls = this.config.tls!
    
    let cert: string
    let key: string

    // 优先使用直接提供的 PEM 内容
    if (tls.cert && tls.key) {
      cert = tls.cert
      key = tls.key
    } else if (tls.certPath && tls.keyPath) {
      // 从文件读取
      cert = fs.readFileSync(tls.certPath, 'utf8')
      key = fs.readFileSync(tls.keyPath, 'utf8')
    } else {
      // 自动生成自签证书（位于 userData/proxy-tls/）
      try {
        if (!this.userDataPath) {
          // 显式失败而非退化到 cwd：见构造函数 userDataPath 字段注释
          throw new Error(
            'userDataPath 未注入（装配层需在构造 ProxyServer 时传入用户数据目录绝对路径）'
          )
        }
        const hostnames = [this.config.host || '127.0.0.1']
        const result = ensureProxySelfSignedCert(this.userDataPath, hostnames)
        proxyLogger.info('ProxyServer', `Using self-signed TLS cert (SAN=${result.altNames.join(',')}, fingerprint=${result.fingerprint.slice(0, 19)}...)`)
        cert = result.cert
        key = result.key
      } catch (err) {
        throw new Error(`TLS enabled but no certificate/key provided and auto-generation failed: ${(err as Error).message}`)
      }
    }

    return { cert, key }
  }

  /**
   * 获取（或生成）反代自签证书信息（供 UI 显示/导出 PEM）
   *
   * 未注入 `userDataPath` 时返回 null（并告警），不静默写到 cwd。
   */
  getSelfSignedCertInfo(): ProxySelfSignedCert | null {
    try {
      if (!this.userDataPath) {
        proxyLogger.warn(
          'ProxyServer',
          'getSelfSignedCertInfo skipped: userDataPath 未注入（装配层未传用户数据目录）'
        )
        return null
      }
      return ensureProxySelfSignedCert(this.userDataPath, [this.config.host || '127.0.0.1'])
    } catch (err) {
      proxyLogger.warn('ProxyServer', `getSelfSignedCertInfo failed: ${(err as Error).message}`)
      return null
    }
  }

  /** 强制重新生成自签证书（用户在 UI 上点"重新生成"） */
  regenerateSelfSignedCert(): ProxySelfSignedCert | null {
    try {
      if (!this.userDataPath) {
        proxyLogger.warn(
          'ProxyServer',
          'regenerateSelfSignedCert skipped: userDataPath 未注入（装配层未传用户数据目录）'
        )
        return null
      }
      this.appendAuditLog('regenerate_self_signed_cert', { host: this.config.host })
      return ensureProxySelfSignedCert(this.userDataPath, [this.config.host || '127.0.0.1'], true)
    } catch (err) {
      proxyLogger.warn('ProxyServer', `regenerateSelfSignedCert failed: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * 优雅停止服务器
   * - 立刻拒绝新连接（server.close）
   * - 给正在进行中的请求 5 秒完成；超时后强制 destroy socket
   * - 同时停 fallback HTTP 服务器
   */
  async stop(gracefulMs: number = 5000): Promise<void> {
    if (!this.server) {
      return
    }

    this.isStopping = true

    const main = this.server
    const fallback = this.fallbackServer

    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        proxyLogger.info('ProxyServer', 'Stopped')
        this.server = null
        this.fallbackServer = null
        this.isStopping = false
        this.activeRequests.clear()
        this.sockets.clear()
        if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null }
        if (this.sessionSnapshotTimer) { clearInterval(this.sessionSnapshotTimer); this.sessionSnapshotTimer = null }
        // 挂起门闸同 activeRequests / sockets 一起收尾:清残留条目 + 停调度器与兜底轮询 + 计数归零。
        // 上面 activeRequests.forEach(abort) 已给客户端发过停服信号,门闸这一步只做作废(不发 hooks)。
        // 不做会留下一个对着「已停的服务」定时放行的 interval,且下次 start 继承旧累计次数。
        this.holdGate.resetSessionState()
        this.events.onStatusChange?.(false, this.config.port)
        this.emitHeldRequestsChanged()
        resolve()
      }

      // 先停止接受新连接
      main.close(() => {
        fallback?.close(() => finish()) || finish()
      })
      fallback?.close()

      // P1-14 优雅停止：给正在进行中的请求时间完成，超时再强制
      this.activeRequests.forEach(controller => {
        // 给客户端一个明确的 stop 信号，但不立即中断已发送的响应流
        try { controller.abort(new Error('Proxy server stopped')) } catch { /* ignore */ }
      })

      // 超时强制 destroy
      setTimeout(() => {
        this.sockets.forEach(socket => { try { socket.destroy() } catch { /* ignore */ } })
        finish()
      }, Math.max(0, gracefulMs))
    })
  }

  // 更新配置
  // P2-18 检测到 port/host/tls 变更时，标记 needsRestart=true，UI 可读取并提示
  private _needsRestart = false
  updateConfig(config: Partial<ProxyConfig>): void {
    // 标记需要重启的字段
    const restartTriggerFields: Array<keyof ProxyConfig> = ['port', 'host', 'tls', 'fallbackPort']
    const willRestart = restartTriggerFields.some(k => k in config && JSON.stringify(this.config[k]) !== JSON.stringify(config[k]))
    if (willRestart && this.isRunning()) {
      this._needsRestart = true
      proxyLogger.warn('ProxyServer', `Config change requires restart: ${restartTriggerFields.filter(k => k in config).join(', ')}`)
    }
    this.appendAuditLog('config_changed', { fields: Object.keys(config), needsRestart: willRestart })
    // v1.7.6 检测能力路由开关 off→on,fire-and-forget 触发一次全池同步
    // 用户从 UI 打开开关不需要重启反代即可让能力信息就位;strict 从 400 变可路由需要这一步
    const enableWasOff = !this.config.enableModelCapabilityRouting
    const enableNowOn = config.enableModelCapabilityRouting === true
    this.config = { ...this.config, ...config }
    // 同步挂起门闸运行配置(clamp/校验收口在 holdConfig SSOT);原地更新持久引用,
    // HoldGate 持有同一对象 → 对之后 enterHold 的新请求即时生效。仅当传入任一 hold* 字段时才重算。
    const HOLD_KEYS: Array<keyof ProxyConfig> = [
      'holdWhenNoAccount', 'holdPingIntervalMs', 'holdMaxWaitMs', 'holdTotalBudgetMs',
      'holdGraceMs', 'holdTimeoutAction', 'holdAutoResumeOnAvailable',
      // 自动放行两键必须在册:漏了则界面显示新值、运行中的门闸仍用旧值,且**静默无报错**
      // (决策卡 §3 运行时链路第 1 跳的失败行为)。
      'holdAutoReleaseEnabled', 'holdAutoReleaseIntervalMs'
    ]
    if (HOLD_KEYS.some(k => k in config)) {
      Object.assign(this.holdRuntimeConfig, normalizeHoldConfig(this.config))
      // D1 裁决:改间隔必须**重建 timer**。
      // 上面的原地 Object.assign 只让「字段值」热生效;已在跑的 setInterval 周期是
      // 创建那一刻定死的,不重建会表现为「改了没反应」,用户只能靠重启反代碰运气。
      this.holdGate.applyAutoReleaseConfig({
        enabled: this.holdRuntimeConfig.autoReleaseEnabled && !!this.config.holdWhenNoAccount,
        intervalMs: this.holdRuntimeConfig.autoReleaseIntervalMs
      })
    }
    if (config.injectExecutionDirective !== undefined) {
      setInjectExecutionDirective(!!config.injectExecutionDirective)
    }
    // 同步账号选择策略到 accountPool
    if (config.accountSelectionStrategy !== undefined) {
      this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'round-robin')
    }
    if (enableWasOff && enableNowOn && this.isRunning() && this.accountPool.size > 0) {
      proxyLogger.info('ProxyServer', 'Capability routing turned ON → kick off bootstrap sync')
      this.syncCapabilities().catch((e) => {
        proxyLogger.warn('ProxyServer', `Bootstrap capability sync failed: ${e instanceof Error ? e.message : e}`)
      })
    }
  }

  /** UI 可用此判断是否需提示用户重启 */
  needsRestart(): boolean {
    return this._needsRestart
  }

  /** 重启后调用清除 needsRestart 标记 */
  async restartServer(): Promise<void> {
    if (!this.isRunning()) {
      await this.start()
      this._needsRestart = false
      return
    }
    await this.stop()
    await this.start()
    this._needsRestart = false
  }

  // 获取配置
  getConfig(): ProxyConfig {
    return { ...this.config }
  }

  private validateCacheControl(cacheControl?: ClaudeCacheControl): void {
    if (!cacheControl) return
    if (cacheControl.type !== 'ephemeral') {
      throw new Error(`Unsupported cache_control type: ${cacheControl.type}`)
    }
  }


  private validateClaudeContentBlocks(blocks: ClaudeContentBlock[]): void {
    blocks.forEach(block => {
      this.validateCacheControl(block.cache_control)
      if (Array.isArray(block.content)) {
        this.validateClaudeContentBlocks(block.content)
      }
    })
  }

  private validateOpenAICacheControls(request: OpenAIChatRequest): void {
    request.messages.forEach(message => {
      this.validateCacheControl(message.cache_control)
      if (Array.isArray(message.content)) {
        message.content.forEach(part => this.validateCacheControl(part.cache_control))
      }
    })
    request.tools?.forEach(tool => this.validateCacheControl(tool.cache_control))
  }

  private validateClaudeCacheControls(request: ClaudeRequest): void {
    if (Array.isArray(request.system)) {
      request.system.forEach(block => this.validateCacheControl(block.cache_control))
    }
    request.messages.forEach(message => {
      this.validateCacheControl(message.cache_control)
      if (Array.isArray(message.content)) {
        this.validateClaudeContentBlocks(message.content)
      }
    })
    request.tools?.forEach(tool => this.validateCacheControl(tool.cache_control))
  }

  private async downloadImageDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const abort = () => controller.abort(this.getAbortError(signal))
    try {
      if (signal?.aborted) throw this.getAbortError(signal)
      signal?.addEventListener('abort', abort, { once: true })
      const agent = (() => {
        const { getSystemProxy, safeCreateProxyAgent } = require('./systemProxy')
        const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
        const envAgent = safeCreateProxyAgent(envProxy)
        if (envAgent) return envAgent
        return safeCreateProxyAgent(getSystemProxy())
      })()
      const { fetch: undiciFetch } = require('undici')
      const response = agent
        ? await undiciFetch(url, { signal: controller.signal, dispatcher: agent }) as unknown as globalThis.Response
        : await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`Failed to download image: HTTP ${response.status}`)
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
      if (!contentType || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
        throw new Error(`Unsupported image content-type: ${contentType || 'unknown'}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
        throw new Error('Image exceeds 10MB limit')
      }
      return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async resolveOpenAIHttpImages(request: OpenAIChatRequest, signal?: AbortSignal): Promise<OpenAIChatRequest> {
    await Promise.all(request.messages.map(async message => {
      if (!Array.isArray(message.content)) return
      await Promise.all(message.content.map(async part => {
        if (part.type !== 'image_url' || !part.image_url?.url.startsWith('http')) return
        part.image_url.url = await this.downloadImageDataUrl(part.image_url.url, signal)
      }))
    }))
    return request
  }

  private async resolveClaudeHttpImages(request: ClaudeRequest, signal?: AbortSignal): Promise<ClaudeRequest> {
    await Promise.all(request.messages.map(async message => {
      if (!Array.isArray(message.content)) return
      await Promise.all(message.content.map(async block => {
        if (block.type !== 'image' || block.source?.type !== 'url') return
        const dataUrl = await this.downloadImageDataUrl(block.source.url, signal)
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
        if (!match) {
          throw new Error('Downloaded image produced invalid data URL')
        }
        block.source = { type: 'base64', media_type: match[1], data: match[2] }
      }))
    }))
    return request
  }

  private prepareOpenAIRequest(request: OpenAIChatRequest): OpenAIChatRequest {
    this.validateOpenAICacheControls(request)

    if (this.config.disableTools || request.tool_choice === 'none') {
      return { ...request, tools: undefined, tool_choice: undefined }
    }

    if (request.tool_choice && typeof request.tool_choice === 'object' && request.tool_choice.type === 'function' && !request.tool_choice.function?.name) {
      throw new Error('tool_choice function requires a tool name')
    }

    if (request.tool_choice && typeof request.tool_choice === 'object' && request.tool_choice.function?.name) {
      const selectedToolName = request.tool_choice.function.name
      if (!request.tools?.some(tool => tool.function.name === selectedToolName)) {
        throw new Error(`tool_choice references unknown tool: ${selectedToolName}`)
      }
      return {
        ...request,
        tools: request.tools?.filter(tool => tool.function.name === selectedToolName)
      }
    }

    return request
  }

  private prepareClaudeRequest(request: ClaudeRequest): ClaudeRequest {
    this.validateClaudeCacheControls(request)

    if (this.config.disableTools || request.tool_choice?.type === 'none') {
      return { ...request, tools: undefined, tool_choice: undefined }
    }

    if (request.tool_choice?.type === 'tool' && !request.tool_choice.name) {
      throw new Error('tool_choice tool requires a tool name')
    }

    if (request.tool_choice?.name) {
      const selectedToolName = request.tool_choice.name
      if (!request.tools?.some(tool => tool.name === selectedToolName)) {
        throw new Error(`tool_choice references unknown tool: ${selectedToolName}`)
      }
      return {
        ...request,
        tools: request.tools?.filter(tool => tool.name === selectedToolName)
      }
    }

    return request
  }

  // 获取统计信息
  getStats(): ProxyStats {
    // 返回可序列化的统计信息（Map 对象在 IPC 中无法正确序列化）
    return {
      totalRequests: this.stats.totalRequests,
      successRequests: this.stats.successRequests,
      failedRequests: this.stats.failedRequests,
      totalTokens: this.stats.totalTokens,
      totalCredits: this.stats.totalCredits,
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      cacheReadTokens: this.stats.cacheReadTokens,
      cacheWriteTokens: this.stats.cacheWriteTokens,
      reasoningTokens: this.stats.reasoningTokens,
      startTime: this.stats.startTime,
      accountStats: this.stats.accountStats,
      endpointStats: this.stats.endpointStats,
      modelStats: this.stats.modelStats,
      recentRequests: this.stats.recentRequests
    }
  }

  // 获取账号池
  getAccountPool(): AccountPool {
    return this.accountPool
  }

  // v1.7.6 能力路由 cold-start bootstrap
  // 并发对池内所有账号跑 fetchKiroModels,把 modelCapabilities 一次性填满
  // 触发时机:①反代 start() 后 (若 enableModelCapabilityRouting) ②updateConfig 检测到开关 off→on
  //           ③IPC proxy-sync-capabilities 前端手动/自动调用
  // 决策卡 §5 承诺"首次触发全池后台同步";此方法是它的实现
  //
  // 返回 { total, ok, failed } · fire-and-forget 时不 await 结果
  // 每账号超时 20s (fetchKiroModels 内部已有 signal 支持,但没暴露 timeout);
  // 并发上限 5 (避免同时炸 20+ 请求触发风控)
  private capabilityBootstrapInflight: Promise<{ total: number; ok: number; failed: number }> | null = null

  async syncCapabilities(): Promise<{ total: number; ok: number; failed: number }> {
    // 全局幂等锁:多个入口同时触发时复用同一 Promise
    if (this.capabilityBootstrapInflight) {
      return this.capabilityBootstrapInflight
    }
    const run = async (): Promise<{ total: number; ok: number; failed: number }> => {
      const accounts = this.accountPool.getAllAccounts()
      if (accounts.length === 0) return { total: 0, ok: 0, failed: 0 }
      proxyLogger.info('ProxyServer', `Capability bootstrap: syncing ${accounts.length} accounts...`)

      let ok = 0
      let failed = 0
      const CONCURRENCY = 5
      // 简单的分批并发,避免同时挤爆
      for (let i = 0; i < accounts.length; i += CONCURRENCY) {
        const batch = accounts.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map(async (acc) => {
            try {
              // fetchKiroModels 内部会调 accountModelSyncCallback → applyModelListResult
              // 也会走 403 自愈闭环 (refresh → arn heal → catalog UI fallback)
              await fetchKiroModels(acc)
              return true
            } catch (e) {
              proxyLogger.warn('ProxyServer', `Capability sync failed for ${acc.email || acc.id.slice(0, 8)}: ${e instanceof Error ? e.message : e}`)
              return false
            }
          })
        )
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) ok++
          else failed++
        }
      }
      proxyLogger.info('ProxyServer', `Capability bootstrap done: ${ok}/${accounts.length} synced, ${failed} failed`)
      return { total: accounts.length, ok, failed }
    }
    this.capabilityBootstrapInflight = run().finally(() => {
      this.capabilityBootstrapInflight = null
    })
    return this.capabilityBootstrapInflight
  }

  /** 是否有能力同步任务在跑(供 UI 显示进度用) */
  isCapabilityBootstrapInflight(): boolean {
    return this.capabilityBootstrapInflight !== null
  }


  // 设置初始累计 credits（用于从持久化存储恢复）
  setTotalCredits(credits: number): void {
    this.stats.totalCredits = credits
  }

  // 重置累计 credits
  resetTotalCredits(): void {
    this.stats.totalCredits = 0
    this.events.onCreditsUpdate?.(0)
  }

  // 设置初始累计 tokens（用于从持久化存储恢复）
  setTotalTokens(inputTokens: number, outputTokens: number): void {
    this.stats.inputTokens = inputTokens
    this.stats.outputTokens = outputTokens
    this.stats.totalTokens = inputTokens + outputTokens
  }

  // 重置累计 tokens
  resetTotalTokens(): void {
    this.stats.inputTokens = 0
    this.stats.outputTokens = 0
    this.stats.totalTokens = 0
  }

  // 设置请求统计（用于从持久化存储恢复）
  setRequestStats(totalRequests: number, successRequests: number, failedRequests: number): void {
    this.stats.totalRequests = totalRequests
    this.stats.successRequests = successRequests
    this.stats.failedRequests = failedRequests
  }

  // 重置请求统计
  resetRequestStats(): void {
    this.stats.totalRequests = 0
    this.stats.successRequests = 0
    this.stats.failedRequests = 0
    this.notifyRequestStatsUpdate()
  }

  // 通知请求统计更新
  private notifyRequestStatsUpdate(): void {
    this.events.onRequestStatsUpdate?.(
      this.stats.totalRequests,
      this.stats.successRequests,
      this.stats.failedRequests
    )
  }

  // 记录请求成功
  private recordRequestSuccess(): void {
    this.stats.successRequests++
    this.sessionStats.successRequests++
    this.notifyRequestStatsUpdate()
  }

  // 记录请求失败
  private recordRequestFailed(): void {
    this.stats.failedRequests++
    this.sessionStats.failedRequests++
    this.notifyRequestStatsUpdate()
  }

  // 记录新请求
  private recordNewRequest(): void {
    this.stats.totalRequests++
    this.sessionStats.totalRequests++
    this.notifyRequestStatsUpdate()
  }

  // 获取会话统计（当前服务运行期间的统计）
  getSessionStats(): { totalRequests: number; successRequests: number; failedRequests: number; credits: number; inputTokens: number; outputTokens: number; startTime: number } {
    return { ...this.sessionStats }
  }

  /** 生成当前会话的完整快照（用于停止时归档为一条历史记录）。 */
  snapshotSession(): ProxySessionRecord {
    const s = this.sessionStats
    const now = Date.now()
    const start = s.startTime || now
    return {
      id: `sess-${start}`,
      startTime: start,
      endTime: now,
      durationMs: Math.max(0, now - start),
      totalRequests: s.totalRequests,
      successRequests: s.successRequests,
      failedRequests: s.failedRequests,
      credits: s.credits,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens
    }
  }

  // 是否运行中
  isRunning(): boolean {
    return this.server !== null
  }

  private getAbortError(signal?: AbortSignal): Error {
    if (signal?.reason instanceof Error) return signal.reason
    if (signal?.reason) return new Error(String(signal.reason))
    return new Error('Request aborted')
  }

  private isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true
      || (error instanceof Error && (error.message.includes('Client disconnected') || error.message.includes('Proxy server stopped')))
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.getAbortError(signal)
  }

  private throwIfResponseClosed(res: http.ServerResponse, signal?: AbortSignal): void {
    this.throwIfAborted(signal)
    if (res.writableEnded || res.destroyed) throw new Error('Client disconnected')
  }

  private isResponseClosed(res: http.ServerResponse): boolean {
    return res.writableEnded || res.destroyed
  }

  /**
   * SSE 背压：res.write 缓冲打满（writableNeedDrain）时返回等待 drain 的 promise，
   * 上游流解析 await 它暂停拉取，避免慢客户端导致内存无限堆积。
   * 同时监听 close/error，客户端断开时立刻放行（防止 promise 永久挂起）。
   * 缓冲未满时返回 undefined（零开销快路径）。
   */
  private waitForDrain(res: http.ServerResponse): Promise<void> | undefined {
    if (!res.writableNeedDrain || res.destroyed || res.writableEnded) return undefined
    return new Promise<void>((resolve) => {
      const done = (): void => {
        res.off('drain', done)
        res.off('close', done)
        res.off('error', done)
        resolve()
      }
      res.once('drain', done)
      res.once('close', done)
      res.once('error', done)
    })
  }

  // 检测错误消息中是否包含账号被长期封禁的特征
  // 返回 { reason, message } 表示需要标记 suspended；返回 null 表示非封禁错误
  // 覆盖：
  //   - Kiro 后端 HTTP 403 + body: { reason: "TEMPORARILY_SUSPENDED", message: "..." }
  //   - CodeWhisperer AccountSuspendedException
  //   - 423 Locked
  private detectSuspendedError(errMsg: string): { reason: string; message: string } | null {
    if (!errMsg) return null

    // 1) 显式 reason: "TEMPORARILY_SUSPENDED" (Kiro 风控)
    const reasonMatch = errMsg.match(/"reason"\s*:\s*"(TEMPORARILY_SUSPENDED|ACCOUNT_SUSPENDED|PERMANENTLY_SUSPENDED)"/i)
    if (reasonMatch) {
      // 尝试提取 message 字段
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: reasonMatch[1].toUpperCase(), message: msgMatch?.[1] || errMsg }
    }

    // 2) 文本特征 "temporarily suspended" / "user id is ... suspended"
    if (/User\s+ID\s+is\s+(temporarily\s+)?suspended/i.test(errMsg) || /temporarily\s+suspended/i.test(errMsg)) {
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: 'TEMPORARILY_SUSPENDED', message: msgMatch?.[1] || errMsg }
    }

    // 3) AccountSuspendedException (CodeWhisperer)
    if (errMsg.includes('AccountSuspendedException') || errMsg.includes('Account suspended')) {
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: 'AccountSuspendedException', message: msgMatch?.[1] || errMsg }
    }

    // 4) HTTP 423 Locked
    if (/\b423\b/.test(errMsg) && /locked|suspended/i.test(errMsg)) {
      return { reason: 'ACCOUNT_LOCKED', message: errMsg }
    }

    return null
  }

  private waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, ms)
      const abort = () => {
        clearTimeout(timeout)
        reject(this.getAbortError(signal))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private async abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.throwIfAborted(signal)
    if (!signal) return promise
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const abort = () => reject(this.getAbortError(signal))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
          () => signal.removeEventListener('abort', abort),
          () => signal.removeEventListener('abort', abort)
        )
      })
    ])
  }

  // 清除模型缓存，强制下次请求重新获取
  clearModelCache(): void {
    this.modelCache = null
    console.log('[ProxyServer] Model cache cleared')
  }

  // 从模型缓存查找指定模型的 thinking 配置
  private getThinkingConfig(modelId: string): ThinkingConfig | undefined {
    if (!this.modelCache) return undefined
    const lower = modelId.toLowerCase()
    const model = this.modelCache.models.find(m => m.modelId.toLowerCase() === lower)
    if (!model) return undefined
    const schema = extractThinkingSchema(model.additionalModelRequestFieldsSchema)
    if (!schema?.schemaPath || !schema.efforts?.length) return undefined
    return { schemaPath: schema.schemaPath, efforts: schema.efforts }
  }

  // 获取可用模型列表
  private static mapKiroModelToApi(m: KiroModel) {
    return {
      id: m.modelId,
      name: m.modelName,
      description: m.description,
      inputTypes: m.supportedInputTypes,
      maxInputTokens: m.tokenLimits?.maxInputTokens,
      maxOutputTokens: m.tokenLimits?.maxOutputTokens,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      supportsThinking: !!(m.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.thinking || !!(m.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.output_config,
      thinkingEfforts: extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.efforts,
      thinkingSchemaPath: extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.schemaPath,
      supportsPromptCaching: m.promptCaching?.supportsPromptCaching || false,
      modelProvider: m.modelProvider || undefined
    }
  }

  async getAvailableModels(signal?: AbortSignal): Promise<{ models: ReturnType<typeof ProxyServer.mapKiroModelToApi>[]; fromCache: boolean }> {
    const now = Date.now()
    
    let kiroModels: KiroModel[]
    let fromCache = false

    if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
      fromCache = true
    } else {
      this.throwIfAborted(signal)
      const account = await this.getAvailableAccount(signal)
      this.throwIfAborted(signal)
      if (!account) {
        return { models: [], fromCache: false }
      }

      try {
        kiroModels = await fetchKiroModels(account, signal)
        if (kiroModels.length > 0) {
          this.modelCache = { models: kiroModels, timestamp: now }
          // 同步到 kiroApi 的 ctx cache, 供 token 裁剪逻辑使用
          for (const m of kiroModels) {
            if (m.tokenLimits?.maxInputTokens) {
              setModelContextWindow(m.modelId, m.tokenLimits.maxInputTokens)
            }
          }
        }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        console.error('[ProxyServer] Failed to fetch models:', error)
        return { models: [], fromCache: false }
      }
    }

    // 合并隐藏模型（与 /v1/models 端点一致）
    const modelIds = new Set(kiroModels.map(m => m.modelId))
    const hiddenModels: KiroModel[] = [
      { modelId: 'claude-3.7-sonnet', modelName: 'Claude 3.7 Sonnet', description: 'Claude 3.7 Sonnet (hidden)', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel,
      { modelId: 'simple-task', modelName: 'Simple Task', description: 'Kiro fast model (routes to Haiku)', supportedInputTypes: ['TEXT'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 4096 } } as KiroModel,
      { modelId: 'CLAUDE_SONNET_4_20250514_V1_0', modelName: 'Claude Sonnet 4 (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel,
      { modelId: 'CLAUDE_HAIKU_4_5_20251001_V1_0', modelName: 'Claude Haiku 4.5 (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel,
      { modelId: 'CLAUDE_3_7_SONNET_20250219_V1_0', modelName: 'Claude 3.7 Sonnet (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel
    ]
    const merged = [...kiroModels, ...hiddenModels.filter(m => !modelIds.has(m.modelId))]

    return { models: merged.map(ProxyServer.mapKiroModelToApi), fromCache }
  }

  // 检查 Token 是否需要刷新
  private isTokenExpiringSoon(account: ProxyAccount): boolean {
    if (!account.expiresAt) return false
    const refreshBeforeMs = (this.config.tokenRefreshBeforeExpiry || 300) * 1000
    return Date.now() + refreshBeforeMs >= account.expiresAt
  }

  // 刷新 Token
  private async refreshToken(account: ProxyAccount, signal?: AbortSignal): Promise<boolean> {
    this.throwIfAborted(signal)
    if (!this.events.onTokenRefresh) {
      console.warn('[ProxyServer] No token refresh callback configured')
      return false
    }

    // 并发去重：等待在途刷新并复用其真实结果。
    // 旧实现固定等 1 秒后按过期时间"猜"结果，慢刷新（网络抖动/慢代理）会被误判失败导致多余切号。
    const existing = this.refreshingTokens.get(account.id)
    if (existing) {
      console.log(`[ProxyServer] Token refresh already in progress for ${account.email || account.id}, awaiting result`)
      try {
        return await this.abortable(existing, signal)
      } catch {
        // 只有"本请求自己"被中止才向上抛；在途刷新因发起方中止/失败时，对本请求按刷新失败处理
        if (signal?.aborted) throw this.getAbortError(signal)
        return false
      }
    }

    const task = this.doRefreshToken(account, signal)
    this.refreshingTokens.set(account.id, task)
    try {
      return await task
    } finally {
      this.refreshingTokens.delete(account.id)
    }
  }

  /** 实际执行 Token 刷新（由 refreshToken 包裹在途去重后调用） */
  private async doRefreshToken(account: ProxyAccount, signal?: AbortSignal): Promise<boolean> {
    console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}`)

    try {
      // 随机延迟 0-3 秒，避免多账号同时刷新被识别为批量操作
      const jitter = Math.floor(Math.random() * 3000)
      if (jitter > 0) await this.waitForRetry(jitter, signal)
      
      const result = await this.abortable(this.events.onTokenRefresh!(account), signal)
      if (result.success && result.accessToken) {
        // 更新账号池中的 Token
        this.accountPool.updateAccount(account.id, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt
        })
        // 通知外部更新
        this.events.onAccountUpdate?.({
          ...account,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt
        })
        console.log(`[ProxyServer] Token refreshed for ${account.email || account.id}`)
        return true
      } else {
        console.error(`[ProxyServer] Token refresh failed for ${account.email || account.id}: ${result.error}`)
        this.accountPool.markNeedsRefresh(account.id)
        return false
      }
    } catch (error) {
      if (this.isAbortError(error, signal)) throw error
      console.error(`[ProxyServer] Token refresh error for ${account.email || account.id}:`, error)
      this.accountPool.markNeedsRefresh(account.id)
      return false
    }
  }

  /**
   * 计算 API Key 允许使用的账号 ID 集合（P2-21）
   * 返回 undefined = 不限制（允许所有账号）
   */
  private getAllowedAccountIds(apiKeyId?: string): Set<string> | undefined {
    if (!apiKeyId) return undefined
    const bindings = this.config.apiKeyAccountBindings?.[apiKeyId]
    if (!bindings || bindings.length === 0) return undefined
    return new Set(bindings)
  }

  // ============ v1.7.6 能力路由: probe-once 锁 + unsupported 错误检测 ============
  private static readonly MODEL_PROBE_LOCK_TTL_MS = 30_000

  /**
   * probe-once: 从 unknown 账号中挑一个权重最高、且不在锁定期的账号去试探.
   * 返回 null = 全部在锁定中,本次请求应拒绝.
   * 挑中账号会加 30s 锁,防止 N 个并发同时挑同一账号打爆额度.
   */
  private probeOnceForModel(unknowns: readonly ProxyAccount[], modelId: string): ProxyAccount | null {
    const now = Date.now()
    // 清理过期锁(懒清理,不用定时器)
    for (const [k, expireAt] of this.modelProbeInflight) {
      if (expireAt < now) this.modelProbeInflight.delete(k)
    }
    let picked: ProxyAccount | null = null
    let maxW = -1
    for (const acc of unknowns) {
      const key = `${acc.id}:${modelId}`
      if (this.modelProbeInflight.has(key)) continue // 在锁中,跳过
      const w = acc.weight ?? 100
      if (w > maxW) {
        maxW = w
        picked = acc
      }
    }
    if (picked) {
      this.modelProbeInflight.set(`${picked.id}:${modelId}`, now + ProxyServer.MODEL_PROBE_LOCK_TTL_MS)
    }
    return picked
  }

  /**
   * 从错误消息中识别"当前模型该账号不支持"的信号.
   * 命中 → 会调用 accountPool.markModelUnsupported 降级,并切下一账号.
   * NEVER 误伤:严格匹配 Kiro 后端具体错误串,不用宽松包含.
   */
  private detectUnsupportedModelError(errMsg: string): boolean {
    if (!errMsg) return false
    const lower = errMsg.toLowerCase()
    return (
      lower.includes('unsupported model') ||
      lower.includes('does not have access to model') ||
      lower.includes('model not available') ||
      lower.includes('modelunavailableexception') ||
      lower.includes('model does not exist') ||
      lower.includes('invalid model')
    )
  }

  // 获取可用账号（包含 Token 刷新检查）
  // P1-8 sessionHint：相同会话尽量复用同一账号（命中 prompt cache + 防风控）
  // P2-21 apiKeyId：用于过滤 API Key 允许使用的账号子集
  // v1.7.6 modelId：启用 enableModelCapabilityRouting 时,按 per-account modelCapabilities 前置过滤
  //         详见 .agent-workspace/.archive/2026-07-22/account-weighted-capability-routing/decision-card.md §3.3
  private async getAvailableAccount(signal?: AbortSignal, sessionHint?: string, apiKeyId?: string, modelId?: string): Promise<ProxyAccount | null> {
    const allowedIds = this.getAllowedAccountIds(apiKeyId)
    const groupMode = this.config.multiAccountSelectionMode === 'groups'
    const allowedGroupIds = groupMode ? new Set(this.config.multiAccountGroupIds || []) : null

    // baseline: 白名单 + 分组过滤(不含 capability)
    const isAllowedBaseline = (acc: ProxyAccount | null): boolean => {
      if (!acc) return true
      if (allowedIds && !allowedIds.has(acc.id)) return false
      if (groupMode && allowedGroupIds) {
        const gid = acc.groupId || '__ungrouped__'
        if (!allowedGroupIds.has(gid)) return false
      }
      return true
    }

    this.throwIfAborted(signal)
    // 如果 pool 为空，触发懒加载回调尝试同步账号（冷启动场景）
    if (this.accountPool.size === 0 && this.events.onPoolEmpty) {
      console.log('[ProxyServer] Account pool empty, triggering lazy sync...')
      await this.abortable(this.events.onPoolEmpty(), signal)
    }
    this.throwIfAborted(signal)

    // ============ v1.7.6 能力路由前置过滤(§3.3) ============
    // 只在多账号模式 + 开关开 + 有 modelId 时生效;向后兼容:任一条件不满足 → capabilityAllowedIds=null(不过滤)
    let capabilityAllowedIds: Set<string> | null = null
    if (this.config.enableMultiAccount && this.config.enableModelCapabilityRouting && modelId) {
      // 计算 baseline 允许的账号 id(白名单 + 分组交集)供 filterByModel 使用
      const baseAllowed = new Set<string>()
      for (const a of this.accountPool.getAllAccounts()) {
        if (isAllowedBaseline(a)) baseAllowed.add(a.id)
      }
      const filterResult = this.accountPool.filterByModel(modelId, baseAllowed)
      let candidates = filterResult.candidates
      if (candidates.length === 0) {
        if (filterResult.unknownAccounts.length === 0) {
          console.warn(`[ProxyServer] no_account_supports_model: modelId=${modelId}, unsupported=${filterResult.unsupportedCount}`)
          return null
        }
        const policy = this.config.capabilityUnknownPolicy || 'strict'
        if (policy === 'strict') {
          console.warn(`[ProxyServer] no_account_confirmed_to_support_model (strict): modelId=${modelId}, unknown=${filterResult.unknownAccounts.length}`)
          return null
        }
        // probe-once: 从 unknown 中挑一个权重最高且不在探测锁的账号
        const probed = this.probeOnceForModel(filterResult.unknownAccounts, modelId)
        if (!probed) {
          console.warn(`[ProxyServer] probe-once: all unknown accounts already in-flight for ${modelId}, refusing`)
          return null
        }
        console.log(`[ProxyServer] probe-once: trying account ${probed.email || probed.id.slice(0, 8)} for ${modelId}`)
        candidates = [probed]
      }
      capabilityAllowedIds = new Set(candidates.map(c => c.id))
    }

    // 综合过滤:白名单 + 分组 + capability
    const isAllowed = (acc: ProxyAccount | null): boolean => {
      if (!isAllowedBaseline(acc)) return false
      if (capabilityAllowedIds && acc && !capabilityAllowedIds.has(acc.id)) return false
      return true
    }

    // P1-8 会话粘性：优先复用已绑定的账号（同时受 API Key 绑定过滤 + capability 过滤）
    if (this.config.sessionAffinityEnabled && sessionHint) {
      const sticky = this.pickAccountWithAffinity(sessionHint)
      if (sticky && isAllowed(sticky)) {
        proxyLogger.debug('ProxyServer', `Session affinity hit: ${sessionHint.slice(0, 16)} → ${sticky.email || sticky.id.slice(0, 8)}`)
        // 仍需检查 token 是否需要刷新
        if (this.isTokenExpiringSoon(sticky)) {
          const refreshed = await this.refreshToken(sticky, signal)
          if (refreshed) {
            return this.accountPool.getAccount(sticky.id) || sticky
          }
        } else {
          return sticky
        }
      }
    }

    let account: ProxyAccount | null

    if (this.config.enableMultiAccount) {
      const strategy = this.config.accountSelectionStrategy || 'round-robin'

      if (strategy === 'weighted') {
        // v1.7.6 SWRR: 从 pool 里筛出符合 isAllowed 的候选,按 weight 挑
        const candidates = this.accountPool.getAllAccounts().filter(a => isAllowed(a))
        account = this.accountPool.pickWeighted(candidates)
        if (!account) {
          const status = this.accountPool.getQuotaStatus()
          if (status.exhausted > 0 && status.available === 0) {
            console.log(`[ProxyServer] All accounts quota exhausted (${status.exhausted}/${status.total}), no available accounts`)
          }
        }
      } else {
        // round-robin / sticky: 复用现有 currentIndex 指针,通过 exclude 剔除不允许账号
        const allAccounts = this.accountPool.getAllAccounts()
        const exclude = new Set<string>()
        for (const a of allAccounts) {
          if (!isAllowed(a)) exclude.add(a.id)
        }
        account = this.accountPool.getNextAccount(exclude)
        if (!account) {
          const status = this.accountPool.getQuotaStatus()
          if (status.exhausted > 0 && status.available === 0) {
            console.log(`[ProxyServer] All accounts quota exhausted (${status.exhausted}/${status.total}), no available accounts`)
          }
        }
      }
    } else {
      // 禁用多账号轮询时，优先使用指定的账号
      if (this.config.selectedAccountIds && this.config.selectedAccountIds.length > 0) {
        // 使用指定的第一个账号
        account = this.accountPool.getAccount(this.config.selectedAccountIds[0])
        // 检查指定账号是否配额耗尽，若是则尝试自动切换
        if (account && this.accountPool.isQuotaExhausted(account) && this.config.autoSwitchOnQuotaExhausted) {
          const nextAccount = this.accountPool.getNextAvailableAccount(account.id)
          if (nextAccount) {
            console.log(`[ProxyServer] Selected account ${account.email || account.id} quota exhausted, auto-switching to ${nextAccount.email || nextAccount.id}`)
            this.config.selectedAccountIds = [nextAccount.id]
            this.events.onAccountUpdate?.(nextAccount)
            account = nextAccount
          }
        }
        if (!account) {
          // 严格模式：单账号模式下指定的账号不在池里，直接报错而不您默 fallback 到其他账号。
          // 旧行为“fallback 到 first available”会导致：用户配“只用 A”却您默用 B
          // （可能是死账号或已被封账号），背景报 SUSPENDED/402，啊啦把“指定账号不在池里”这个真问题掩盖了。
          console.warn(`[ProxyServer] Selected account ${this.config.selectedAccountIds[0]} not found in pool (pool size=${this.accountPool.size}). Refuse to fallback to a random account. Please check that the account is not error/suspended, or re-sync the account pool.`)
          account = null
        }
      } else {
        // 没有指定账号，使用第一个可用账号
        const allAccounts = this.accountPool.getAllAccounts()
        account = allAccounts.length > 0 ? allAccounts[0] : null
      }
    }
    
    if (!account) return null

    // 自动切换 K-Proxy 设备 ID（如果 K-Proxy 服务可用）
    this.syncKProxyDeviceId(account)

    // 检查是否需要刷新 Token
    if (this.isTokenExpiringSoon(account)) {
      const refreshed = await this.refreshToken(account, signal)
      if (!refreshed) {
        // 刷新失败，如果启用多账号才尝试获取下一个账号
        if (this.config.enableMultiAccount) {
          return this.accountPool.getNextAccount()
        }
        return null
      }
      // 返回更新后的账号
      const refreshedAccount = this.accountPool.getAccount(account.id)
      if (refreshedAccount && sessionHint) this.rememberAffinity(sessionHint, refreshedAccount.id)
      return refreshedAccount
    }

    if (sessionHint) this.rememberAffinity(sessionHint, account.id)
    return account
  }

  // 同步 K-Proxy 设备 ID（根据账号自动切换）
  private syncKProxyDeviceId(account: ProxyAccount): void {
    const kproxyService = getKProxyService()
    if (!kproxyService || !kproxyService.isRunning()) {
      return // K-Proxy 未初始化或未运行
    }

    // 尝试切换到账号绑定的设备 ID
    const switched = kproxyService.switchToAccount(account.id)
    
    if (!switched) {
      // 账号没有绑定设备 ID，自动生成并绑定
      const newDeviceId = generateDeviceId()
      kproxyService.addDeviceIdMapping({
        accountId: account.id,
        deviceId: newDeviceId,
        description: account.email || `Account ${account.id.substring(0, 8)}`,
        createdAt: Date.now()
      })
      kproxyService.setDeviceId(newDeviceId)
      proxyLogger.info('ProxyServer', `Auto-generated device ID for account ${account.email || account.id.substring(0, 8)}`)
    } else {
      proxyLogger.debug('ProxyServer', `Switched to device ID for account ${account.email || account.id.substring(0, 8)}`)
    }
  }

  // 带重试的 API 调用
  // v1.7.6 modelId: 传入时启用 runtime 能力反哺 —— 成功 → markModelConfirmed,
  //                 unsupported 错误 → markModelUnsupported 并切下一账号(§3.3)
  private async callWithRetry<T>(
    account: ProxyAccount,
    apiCall: (acc: ProxyAccount, endpointIndex: number) => Promise<T>,
    _path: string,
    signal?: AbortSignal,
    modelId?: string
  ): Promise<{ result: T; account: ProxyAccount }> {
    const maxRetries = this.config.maxRetries || 3
    const retryDelay = this.config.retryDelayMs || 1000
    let lastError: Error | null = null
    let currentAccount = account
    let endpointIndex = 0
    // 本次请求累计已尝试的账号 ID，避免重试时循环命中已经失败过的账号
    const triedIds = new Set<string>([account.id])
    /** 切到下一个可用账号；多账号模式带 triedIds 排除，单账号场景退化为旧逻辑 */
    const switchToNextAccount = (): ProxyAccount | null => {
      if (this.config.enableMultiAccount) {
        return this.accountPool.getNextAccount(triedIds)
      }
      if (this.config.autoSwitchOnQuotaExhausted) {
        return this.accountPool.getNextAvailableAccount(triedIds)
      }
      return null
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.throwIfAborted(signal)
      try {
        const result = await apiCall(currentAccount, endpointIndex)
        // v1.7.6 能力反哺: stream 成功即证明当前账号支持该模型
        if (modelId) {
          this.accountPool.markModelConfirmed(currentAccount.id, modelId)
        }
        return { result, account: currentAccount }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        lastError = error as Error
        const errMsg = lastError.message || ''

        console.log(`[ProxyServer] API call failed (attempt ${attempt + 1}/${maxRetries}): ${errMsg}`)

        // v1.7.6 能力反哺: unsupported model 错误 → 降级并切下一账号(优先于其它错误分支,防误判为 quota/auth)
        if (modelId && this.detectUnsupportedModelError(errMsg)) {
          this.accountPool.markModelUnsupported(currentAccount.id, modelId)
          console.warn(`[ProxyServer] Account ${currentAccount.email || currentAccount.id.slice(0, 8)} does NOT support ${modelId}, switching`)
          const nextAccount = switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            continue
          }
          break // 无可切换,抛给客户端
        }

        // 优先检测账号被长期封禁（不是 token 问题，刷新也没用）
        // 特征：HTTP 403 + reason: "TEMPORARILY_SUSPENDED" 或 AccountSuspendedException / 423
        const suspendInfo = this.detectSuspendedError(errMsg)
        if (suspendInfo) {
          const newlyMarked = this.accountPool.markSuspended(currentAccount.id, suspendInfo.reason, suspendInfo.message)
          if (newlyMarked) {
            this.events.onAccountSuspended?.({
              accountId: currentAccount.id,
              email: currentAccount.email,
              reason: suspendInfo.reason,
              message: suspendInfo.message
            })
            // P1-6 关键事件 → 触发 webhook
            this.appendAuditLog('account_suspended', {
              accountId: currentAccount.id,
              email: currentAccount.email,
              reason: suspendInfo.reason
            })
            this.triggerWebhook('proxy-account-suspended', {
              title: '反代账号被风控',
              message: `账号 ${currentAccount.email || currentAccount.id.slice(0, 8)} 被 Kiro 后端标记为 ${suspendInfo.reason}，需要人工解封`,
              level: 'error',
              fields: {
                邮箱: currentAccount.email || '-',
                账号ID: currentAccount.id.slice(0, 8),
                封禁原因: suspendInfo.reason,
                详情: this.sanitizeErrorMessage(suspendInfo.message || '').slice(0, 200)
              }
            })
          }
          console.warn(`[ProxyServer] Account ${currentAccount.email || currentAccount.id} suspended (${suspendInfo.reason}), switching to next available account`)
          // 切到下个可用账号（跳过被 suspended 的 + 本请求已试过的）
          const nextAccount = switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            if (!this.config.enableMultiAccount) {
              this.config.selectedAccountIds = [nextAccount.id]
              this.events.onAccountUpdate?.(nextAccount)
            }
            continue
          }
          // 无可切换的账号 → 直接抛出错误给客户端
          break
        }

        // 401/403: 尝试刷新 Token
        if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Auth')) {
          console.log('[ProxyServer] Auth error, attempting token refresh')
          const refreshed = await this.refreshToken(currentAccount, signal)
          if (refreshed) {
            currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
            continue
          }
          // 刷新失败 → 切到没试过的下个账号
          const nextAccount = switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            continue
          }
        }

        // 402(额度耗尽) / 429(限流): 切换端点或账号
        if (errMsg.includes('402') || errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('ThrottlingException') || errMsg.includes('reached the limit') || errMsg.includes('ServiceQuotaExceededException') || errMsg.includes('limit exceeded') || errMsg.includes('rate limit')) {
          // ⚠️ 必须按真实语义分流上报(RCA 2026-08-04 hold-gate-429-quota-false-positive):
          // 此前无论 402 还是 429 都硬编码传 429,而 accountPool 又把 429 当额度耗尽标记
          // 1 小时 → HoldGate 误伤。现在 accountPool 只认 402,故这里必须把真实的额度类
          // 错误如实传 402,否则真额度耗尽会永远标不上(回归风险)。
          //   402 语义(需等配额恢复):402 / quota / reached the limit /
          //                            ServiceQuotaExceededException / limit exceeded
          //   429 语义(重试即可):    429 / ThrottlingException / rate limit
          const isRealQuotaExhausted = errMsg.includes('402')
            || errMsg.includes('quota')
            || errMsg.includes('reached the limit')
            || errMsg.includes('ServiceQuotaExceededException')
            || errMsg.includes('limit exceeded')
          console.log(`[ProxyServer] ${isRealQuotaExhausted ? 'Quota exhausted' : 'Throttle'} error, switching endpoint or account`)
          this.accountPool.recordError(currentAccount.id, ErrorType.RECOVERABLE, isRealQuotaExhausted ? 402 : 429)
          endpointIndex = (endpointIndex + 1) % 2 // 切换端点
          if (endpointIndex === 0) {
            // 已尝试所有端点，切换到没试过的下个账号
            const nextAccount = switchToNextAccount()
            if (nextAccount && !triedIds.has(nextAccount.id)) {
              console.log(`[ProxyServer] Auto-switching to ${nextAccount.email || nextAccount.id.slice(0, 8)} due to quota exhausted`)
              currentAccount = nextAccount
              triedIds.add(nextAccount.id)
              if (!this.config.enableMultiAccount) {
                this.config.selectedAccountIds = [nextAccount.id]
                this.events.onAccountUpdate?.(nextAccount)
              }
            }
          }
          continue
        }

        // 5xx: 同账号短退避重试一次；再次 5xx 直接 fallback 到没试过的账号（瞬时故障跨账号绕过）
        if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503') || errMsg.includes('504')) {
          console.log('[ProxyServer] Server error, retrying')
          // 第二次及以后的 5xx → 切换账号（旧逻辑会同账号撞死）
          if (attempt > 0) {
            const nextAccount = switchToNextAccount()
            if (nextAccount && !triedIds.has(nextAccount.id)) {
              console.log(`[ProxyServer] Persistent 5xx on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`)
              currentAccount = nextAccount
              triedIds.add(nextAccount.id)
              continue
            }
          }
          await this.waitForRetry(retryDelay * (attempt + 1), signal)
          continue
        }

        // 其他错误，不重试
        break
      }
    }

    throw lastError || new Error('Unknown error')
  }

  /**
   * 常数时间字符串比较（防时序攻击）
   *
   * 实现已抽至 `utils/netGuard.ts`（Web 面板比对 adminKey 时共用同一实现）。
   * 此处保留薄 wrapper 让 validateApiKey 的两个调用点零改动。
   */
  private safeStringEq(a: string, b: string): boolean {
    return safeStringEq(a, b)
  }

  // 验证 API Key 并返回匹配的 Key（用于统计）
  // P0-3 使用 timingSafeEqual 防止时序攻击逐字猜 Key
  private validateApiKey(req: http.IncomingMessage): { valid: boolean; apiKey?: import('./types').ApiKey; reason?: string } {
    // 如果没有配置任何 API Key，则跳过验证
    const hasApiKeys = this.config.apiKeys && this.config.apiKeys.length > 0
    const hasLegacyKey = !!this.config.apiKey
    if (!hasApiKeys && !hasLegacyKey) return { valid: true }

    // 从 Authorization 头或 X-Api-Key 头获取 API Key
    const authHeader = req.headers['authorization'] || ''
    const apiKeyHeader = (req.headers['x-api-key'] as string) || ''

    let providedKey = ''
    // Bearer token 格式
    if (authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7)
    }
    // 直接 API Key 格式
    if (!providedKey && apiKeyHeader) {
      providedKey = apiKeyHeader
    }

    if (!providedKey) return { valid: false }

    // 检查多 API Key（常数时间比较）
    if (hasApiKeys) {
      let matched: import('./types').ApiKey | undefined
      for (const k of this.config.apiKeys!) {
        if (!k.enabled || !k.key) continue
        if (this.safeStringEq(k.key, providedKey)) {
          matched = k
          // 不 break：继续遍历保持时间一致（小数量数组 OK）
        }
      }
      if (matched) {
        if (matched.creditsLimit && matched.usage.totalCredits >= matched.creditsLimit) {
          return { valid: false, reason: 'Credits limit exceeded' }
        }
        return { valid: true, apiKey: matched }
      }
    }

    // 兼容旧的单 API Key（常数时间比较）
    if (hasLegacyKey && this.safeStringEq(this.config.apiKey!, providedKey)) {
      return { valid: true }
    }

    return { valid: false }
  }

  /**
   * P0-4 IP 访问控制
   * - deniedIPs 优先：命中即拒绝
   * - allowedIPs 配置后：必须在列表内（白名单模式）
   * - 都未配置：允许
   * 支持单 IP 和 CIDR（IPv4 / IPv6 简化处理）
   *
   * 判定逻辑（含 CIDR 匹配）已抽至 `utils/netGuard.ts` 的 `isIPAllowed(ip, policy)`。
   * 此处保留薄 wrapper：策略来源仍是本实例的 config，
   * 让 handleRequest 的唯一调用点零改动，同时让面板可以传自己的准入名单。
   */
  private isClientIPAllowed(clientIP: string): { allowed: boolean; reason?: string } {
    return isIPAllowed(clientIP, this.config)
  }

  // CIDR 匹配（ipInCidr / ipv4ToInt / ipv6ToBytes）已随 isIPAllowed 一并抽至
  // `utils/netGuard.ts`；类内已无调用点，故不保留 wrapper。

  /** 取客户端真实 IP（不信任 X-Forwarded-For，仅取 socket address） */
  private getClientIP(req: http.IncomingMessage): string {
    return req.socket.remoteAddress || ''
  }

  // 记录 API Key 用量
  recordApiKeyUsage(apiKeyId: string, credits: number, inputTokens: number, outputTokens: number, model?: string, path?: string): void {
    if (!this.config.apiKeys) return
    const apiKey = this.config.apiKeys.find(k => k.id === apiKeyId)
    if (!apiKey) return

    const today = new Date().toISOString().split('T')[0]
    const now = Date.now()
    
    // 更新总计
    apiKey.usage.totalRequests++
    apiKey.usage.totalCredits += credits
    apiKey.usage.totalInputTokens += inputTokens
    apiKey.usage.totalOutputTokens += outputTokens
    apiKey.lastUsedAt = now

    // 更新日统计
    if (!apiKey.usage.daily[today]) {
      apiKey.usage.daily[today] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
    }
    apiKey.usage.daily[today].requests++
    apiKey.usage.daily[today].credits += credits
    apiKey.usage.daily[today].inputTokens += inputTokens
    apiKey.usage.daily[today].outputTokens += outputTokens

    // 更新模型统计
    if (model) {
      if (!apiKey.usage.byModel) {
        apiKey.usage.byModel = {}
      }
      if (!apiKey.usage.byModel[model]) {
        apiKey.usage.byModel[model] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
      }
      apiKey.usage.byModel[model].requests++
      apiKey.usage.byModel[model].credits += credits
      apiKey.usage.byModel[model].inputTokens += inputTokens
      apiKey.usage.byModel[model].outputTokens += outputTokens
    }

    // 添加用量历史记录（保留最近 100 条）
    if (!apiKey.usageHistory) {
      apiKey.usageHistory = []
    }
    apiKey.usageHistory.unshift({
      timestamp: now,
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      credits,
      path: path || 'unknown'
    })
    if (apiKey.usageHistory.length > 100) {
      apiKey.usageHistory = apiKey.usageHistory.slice(0, 100)
    }

    // 触发配置保存事件
    this.events.onConfigChanged?.(this.config)
  }

  // 应用模型映射
  private applyModelMapping(requestedModel: string, apiKeyId?: string): string {
    const mappings = this.config.modelMappings
    if (!mappings || mappings.length === 0) return requestedModel

    // 按优先级排序（数字越小优先级越高）
    const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority)

    for (const rule of sortedMappings) {
      // 检查规则是否启用
      if (!rule.enabled) continue

      // 检查是否适用于当前 API Key
      if (rule.apiKeyIds && rule.apiKeyIds.length > 0 && apiKeyId) {
        if (!rule.apiKeyIds.includes(apiKeyId)) continue
      }

      // 检查源模型是否匹配（支持通配符 *）
      const sourcePattern = rule.sourceModel.replace(/\*/g, '.*')
      const regex = new RegExp(`^${sourcePattern}$`, 'i')
      if (!regex.test(requestedModel)) continue

      // 匹配成功，根据类型选择目标模型
      const validTargets = rule.targetModels.filter(t => t.trim())
      if (validTargets.length === 0) continue

      let targetModel: string

      if (rule.type === 'loadbalance' && validTargets.length > 1) {
        // 负载均衡: SWRR (Smooth Weighted Round-Robin, nginx 同款算法)
        // 相比 Math.random 加权随机:短窗口方差极小,长期比例严格贴合权重
        const weights = rule.weights || validTargets.map(() => 1)
        let swrr = this.modelMappingSwrr.get(rule.id)
        if (!swrr) {
          swrr = new SmoothWeightedRoundRobin({
            getId: (x) => x.id,
            getWeight: (x) => x.weight
          })
          this.modelMappingSwrr.set(rule.id, swrr)
        }
        const cands = validTargets.map((t, i) => ({
          id: `${rule.id}::${i}::${t}`,
          target: t,
          weight: Math.max(0, weights[i] ?? 1)
        }))
        const picked = swrr.pick(cands)
        targetModel = picked ? picked.target : validTargets[0]
      } else {
        // replace 或 alias：直接使用第一个目标
        targetModel = validTargets[0]
      }

      proxyLogger.info('ProxyServer', `Model mapping applied: ${requestedModel} -> ${targetModel} (rule: ${rule.name}, type: ${rule.type})`)
      return targetModel
    }

    return requestedModel
  }

  // 处理请求
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url || '/'
    const method = req.method || 'GET'
    const clientIP = this.getClientIP(req)
    const controller = new AbortController()
    const abortRequest = () => {
      if (!this.isStopping && res.writableEnded) return
      if (!controller.signal.aborted) {
        controller.abort(new Error(this.isStopping ? 'Proxy server stopped' : 'Client disconnected'))
      }
    }
    this.activeRequests.add(controller)
    req.on('aborted', abortRequest)
    res.on('close', abortRequest)

    // CORS 预检
    if (method === 'OPTIONS') {
      this.setCorsHeaders(res)
      res.writeHead(204)
      res.end()
      req.off('aborted', abortRequest)
      res.off('close', abortRequest)
      this.activeRequests.delete(controller)
      return
    }

    try {
      this.setCorsHeaders(res)

      // P0-4 IP 访问控制（健康检查也走，防止扫描器）
      const ipCheck = this.isClientIPAllowed(clientIP)
      if (!ipCheck.allowed) {
        proxyLogger.warn('ProxyServer', `Blocked request from ${clientIP}: ${ipCheck.reason}`)
        this.appendAuditLog('ip_blocked', { ip: clientIP, path, reason: ipCheck.reason })
        this.sendError(res, 403, 'Forbidden')
        return
      }

      // API Key 验证（健康检查端点除外）
      if (path !== '/health' && path !== '/') {
        const authResult = this.validateApiKey(req)
        if (!authResult.valid) {
          const errorMsg = authResult.reason || 'Invalid or missing API key'
          const statusCode = authResult.reason === 'Credits limit exceeded' ? 429 : 401
          // 401 不返回 reason 详情（防止指纹爬取）
          this.sendError(res, statusCode, statusCode === 401 ? 'Unauthorized' : errorMsg,
            this.isAnthropicPath(path) ? 'anthropic' : 'openai')
          return
        }
        // 将匹配的 API Key 存储到请求对象中，用于后续统计
        ;(req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey = authResult.apiKey

        // P1-7 按 API Key（或匿名时按 IP）请求限流
        const rateLimitId = authResult.apiKey?.id || `ip:${clientIP || 'unknown'}`
        const rl = this.checkRateLimit(rateLimitId)
        if (!rl.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)))
          res.setHeader('X-RateLimit-Limit', String(this.config.rateLimitPerKeyPerMinute || 0))
          res.setHeader('X-RateLimit-Remaining', '0')
          this.sendError(res, 429, 'Rate limit exceeded',
            this.isAnthropicPath(path) ? 'anthropic' : 'openai')
          return
        }
      }

      // 记录请求
      if (this.config.logRequests) {
        proxyLogger.info('ProxyServer', `${method} ${path}`)
      }

      // 路由（移除查询参数）
      const pathWithoutQuery = path.split('?')[0]
      
      if (pathWithoutQuery === '/v1/models' || pathWithoutQuery === '/models') {
        await this.handleModels(res, controller.signal)
      } else if (pathWithoutQuery === '/v1/chat/completions' || pathWithoutQuery === '/chat/completions') {
        await this.handleOpenAIChat(req, res, controller.signal)
      } else if (pathWithoutQuery === '/v1/responses' || pathWithoutQuery === '/responses') {
        await this.handleOpenAIResponses(req, res, controller.signal)
      } else if (pathWithoutQuery === '/v1/messages' || pathWithoutQuery === '/messages' || pathWithoutQuery === '/anthropic/v1/messages') {
        await this.handleClaudeMessages(req, res, controller.signal)
      } else if (pathWithoutQuery === '/v1/messages/count_tokens' || pathWithoutQuery === '/messages/count_tokens') {
        // Claude Code token 计数端点 - 返回模拟响应
        await this.handleCountTokens(req, res, controller.signal)
      } else if (pathWithoutQuery === '/api/event_logging/batch') {
        // Claude Code 遥测端点 - 直接返回 200 OK
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (pathWithoutQuery.startsWith('/v1beta/models/')) {
        // Gemini v1beta 兼容路由
        await this.handleGeminiRequest(req, res, pathWithoutQuery, controller.signal)
      } else if (pathWithoutQuery === '/v1beta/models') {
        // Gemini 模型列表
        await this.handleGeminiModels(res, controller.signal)
      } else if (pathWithoutQuery === '/health' || pathWithoutQuery === '/') {
        this.handleHealth(res)
      } else if (pathWithoutQuery === '/metrics' && this.config.enableMetrics) {
        // P2-16 Prometheus metrics
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(this.renderPrometheusMetrics())
      } else if (pathWithoutQuery.startsWith('/admin/')) {
        // 管理 API 端点
        await this.handleAdminApi(req, res, pathWithoutQuery, controller.signal)
      } else {
        // 记录未知路径以便调试
        console.log(`[ProxyServer] Unknown path: ${path} (method: ${method})`)
        this.sendError(res, 404, `Not Found: ${pathWithoutQuery}`)
      }
    } catch (error) {
      if (this.isAbortError(error, controller.signal)) {
        proxyLogger.info('ProxyServer', `Request aborted: ${method} ${path}`)
        return
      }
      // P0-1 body 超限 → 413
      if (error instanceof BodyTooLargeError) {
        proxyLogger.warn('ProxyServer', `Body too large from ${clientIP}: ${error.received}/${error.limit} bytes (${path})`)
        this.sendError(res, 413, `Request body too large (max ${error.limit} bytes)`,
          this.isAnthropicPath(path) ? 'anthropic' : 'openai')
        return
      }
      // P0-5 错误响应 sanitize：500 类不吐内部 message
      console.error('[ProxyServer] Request error:', error)
      this.sendError(res, 500, 'Internal server error', this.isAnthropicPath(path) ? 'anthropic' : 'openai')
      this.events.onError?.(error as Error)
    } finally {
      req.off('aborted', abortRequest)
      res.off('close', abortRequest)
      this.activeRequests.delete(controller)
    }
  }

  // 管理 API 端点
  private async handleAdminApi(req: http.IncomingMessage, res: http.ServerResponse, path: string, signal?: AbortSignal): Promise<void> {
    const method = req.method || 'GET'

    // 管理 API 需要 API Key 验证
    const authResult = this.validateApiKey(req)
    if (!authResult.valid) {
      this.sendError(res, 401, 'Admin API requires authentication')
      return
    }

    if (path === '/admin/stats' && method === 'GET') {
      // 获取详细统计
      this.handleAdminStats(res)
    } else if (path === '/admin/accounts' && method === 'GET') {
      // 获取账号列表
      this.handleAdminAccounts(res)
    } else if (path === '/admin/config' && method === 'GET') {
      // 获取配置
      this.handleAdminConfig(res)
    } else if (path === '/admin/config' && method === 'POST') {
      // 更新配置（P1-9 schema 白名单校验，防止任意字段注入）
      const body = await this.readBody(req, signal)
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(body) } catch {
        this.sendError(res, 400, 'Invalid JSON body')
        return
      }
      const safeUpdate = this.filterAdminConfigUpdate(parsed)
      this.updateConfig(safeUpdate)
      this.appendAuditLog('config_updated', { fields: Object.keys(safeUpdate) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, applied: Object.keys(safeUpdate), config: this.handleAdminConfigPayload() }))
    } else if (path === '/admin/audit' && method === 'GET') {
      // P2-17 审计日志
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ entries: this.auditLog.slice(-100) }))
    } else if (path === '/admin/logs' && method === 'GET') {
      // 获取最近日志
      this.handleAdminLogs(res)
    } else if (path === '/admin/cache/clear' && method === 'POST') {
      // 清除内存缓存（conversationId 映射、模型缓存、prompt cache）
      const { clearAllCaches } = require('./kiroApi')
      const cleared = clearAllCaches()
      const promptCacheCleared = promptCacheTracker.clear()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, cleared: { ...cleared, promptCache: promptCacheCleared } }))
    } else {
      this.sendError(res, 404, 'Admin endpoint not found')
    }
  }

  // 管理 API - 详细统计
  private handleAdminStats(res: http.ServerResponse): void {
    const stats = this.getStats()
    const accountStats: Record<string, unknown> = {}
    stats.accountStats.forEach((v, k) => { accountStats[k] = v })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      totalTokens: stats.totalTokens,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      uptime: Date.now() - stats.startTime,
      startTime: stats.startTime,
      accountStats,
      recentRequests: stats.recentRequests.slice(-50)
    }))
  }

  // 管理 API - 账号列表
  private handleAdminAccounts(res: http.ServerResponse): void {
    const accounts = this.accountPool.getAllAccounts().map(acc => ({
      id: acc.id,
      email: acc.email,
      isAvailable: acc.isAvailable !== false,
      lastUsed: acc.lastUsed,
      requestCount: acc.requestCount || 0,
      errorCount: acc.errorCount || 0,
      expiresAt: acc.expiresAt,
      authMethod: acc.authMethod
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      total: accounts.length,
      available: accounts.filter(a => a.isAvailable).length,
      accounts
    }))
  }

  /**
   * P1-12 构造脱敏后的配置（apiKeys[].key 全部脱敏，tls 私钥不返回）
   * 暴露给 /admin/config GET
   */
  private handleAdminConfigPayload(): Record<string, unknown> {
    const config = this.getConfig()
    const maskKey = (k: string | undefined): string | undefined => {
      if (!k) return undefined
      if (k.length <= 8) return '***'
      return `${k.slice(0, 4)}***${k.slice(-4)}`
    }
    return {
      ...config,
      apiKey: maskKey(config.apiKey),
      apiKeys: config.apiKeys?.map(k => ({ ...k, key: maskKey(k.key) || '***' })),
      tls: config.tls ? { enabled: config.tls.enabled, hasCert: !!(config.tls.cert || config.tls.certPath), hasKey: !!(config.tls.key || config.tls.keyPath) } : undefined
    }
  }

  // 管理 API - 配置
  private handleAdminConfig(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(this.handleAdminConfigPayload()))
  }

  /**
   * P1-9 admin/config POST 字段白名单过滤
   * 仅允许"可远程改"的字段；apiKeys/apiKey 等敏感字段必须通过本地 IPC 改
   */
  private filterAdminConfigUpdate(input: Record<string, unknown>): Partial<ProxyConfig> {
    const allowed: Array<keyof ProxyConfig> = [
      'enabled', 'enableMultiAccount', 'logRequests', 'logStreamEvents',
      'maxConcurrent', 'maxRetries', 'retryDelayMs', 'preferredEndpoint',
      'tokenRefreshBeforeExpiry', 'autoStart', 'clientDrivenToolExecution',
      'disableTools', 'payloadSizeLimitKB', 'enableTokenBufferReserve',
      'tokenBufferReserve', 'enableProxyContextSafetyNet',
      'autoSwitchOnQuotaExhausted', 'accountSelectionStrategy',
      'multiAccountSelectionMode', 'multiAccountGroupIds', 'modelMappings',
      'maxRequestBodyBytes', 'allowedIPs', 'deniedIPs',
      'rateLimitPerKeyPerMinute', 'sessionAffinityEnabled',
      'keepAliveTimeoutMs', 'headersTimeoutMs', 'recentRequestsLimit',
      'enableMetrics', 'apiKeyGroupBindings', 'enableAuditLog',
      'injectExecutionDirective',
      // 挂起门闸(Hold Gate)运行行为字段 —— 与其它运行字段一致允许远程改
      // (安全/监听字段仍排除;这些只改请求编排行为,clamp 校验在 updateConfig 收口)
      'holdWhenNoAccount', 'holdPingIntervalMs', 'holdMaxWaitMs', 'holdTotalBudgetMs',
      'holdGraceMs', 'holdTimeoutAction', 'holdAutoResumeOnAvailable'
      // 故意排除：port / host / apiKey / apiKeys / tls / fallbackPort / allowExternalWithoutApiKey
      // 这些字段会改变监听行为或安全策略，必须本地 IPC 改
    ]
    const out: Partial<ProxyConfig> = {}
    for (const key of allowed) {
      if (key in input) {
        (out as Record<string, unknown>)[key] = input[key as string]
      }
    }
    return out
  }

  // 管理 API - 日志
  private handleAdminLogs(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      recentRequests: this.stats.recentRequests.slice(-100)
    }))
  }

  // 设置 CORS 头
  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch')
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens')
  }

  private isAnthropicPath(path: string): boolean {
    const pathWithoutQuery = path.split('?')[0]
    return pathWithoutQuery === '/v1/messages'
      || pathWithoutQuery === '/messages'
      || pathWithoutQuery === '/anthropic/v1/messages'
      || pathWithoutQuery === '/v1/messages/count_tokens'
      || pathWithoutQuery === '/messages/count_tokens'
  }

  private getAnthropicErrorType(status: number): string {
    if (status === 400) return 'invalid_request_error'
    if (status === 401) return 'authentication_error'
    if (status === 403) return 'permission_error'
    if (status === 404) return 'not_found_error'
    if (status === 429) return 'rate_limit_error'
    return 'api_error'
  }

  private buildClaudeUsage(
    usage: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number },
    simulatedCache?: { cacheCreationInputTokens: number; cacheReadInputTokens: number }
  ): { input_tokens?: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } {
    // 优先使用 Kiro 后端返回的真实 cache tokens，否则用模拟器的值
    const cacheWrite = usage.cacheWriteTokens || simulatedCache?.cacheCreationInputTokens || 0
    const cacheRead = usage.cacheReadTokens || simulatedCache?.cacheReadInputTokens || 0
    // Kiro 的 inputTokens 是全量（含缓存），Anthropic API 规范中 input_tokens 不含缓存部分
    // 需要扣除 cache tokens 避免客户端双重计费
    const adjustedInput = Math.max(0, usage.inputTokens - cacheWrite - cacheRead)
    return {
      input_tokens: adjustedInput,
      output_tokens: usage.outputTokens,
      ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {})
    }
  }

  private estimateTokenCount(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === 'string') return Math.ceil(value.length / 4)
    if (typeof value === 'number' || typeof value === 'boolean') return 1
    if (Array.isArray(value)) {
      return value.reduce<number>((total, item) => total + this.estimateTokenCount(item), 0)
    }
    if (typeof value !== 'object') return 0
    const record = value as Record<string, unknown>
    if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text') return this.estimateTokenCount(record.text) + 4
    if (record.type === 'thinking') return this.estimateTokenCount(record.thinking) + this.estimateTokenCount(record.signature) + 4
    if (record.type === 'redacted_thinking') return 8
    if (record.type === 'image' || record.type === 'input_image') return 170
    if (record.type === 'document' || record.type === 'input_file') return this.estimateTokenCount(record.title) + this.estimateTokenCount(record.name) + this.estimateTokenCount(record.filename) + this.estimateTokenCount(record.source) + this.estimateTokenCount(record.file_data) + 120
    if (record.type === 'tool_use') return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.input) + 12
    if (record.type === 'tool_result') return this.estimateTokenCount(record.content) + 8
    if (typeof record.role === 'string' && 'content' in record) return this.estimateTokenCount(record.content) + 4
    if (typeof record.name === 'string' && 'input_schema' in record) return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.description) + this.estimateTokenCount(record.input_schema) + 32
    return Object.entries(record).reduce<number>((total, [key, item]) => key === 'cache_control' ? total : total + this.estimateTokenCount(item), 0)
  }

  // 健康检查
  private handleHealth(res: http.ServerResponse): void {
    const stats = this.getStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      accounts: this.accountPool.size,
      availableAccounts: this.accountPool.availableCount,
      stats: {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests,
        totalTokens: stats.totalTokens,
        uptime: Date.now() - stats.startTime
      }
    }))
  }

  // Claude Code token 计数（模拟响应）
  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    try {
      this.throwIfAborted(signal)
      const body = await this.readBody(req, signal)
      this.throwIfAborted(signal)
      const request = JSON.parse(body) as Partial<ClaudeRequest>
      if (!Array.isArray(request.messages)) {
        throw new Error('count_tokens requires messages')
      }
      const estimatedTokens = Math.max(1, this.estimateTokenCount(request.system) + this.estimateTokenCount(request.messages) + this.estimateTokenCount(request.tools))
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: estimatedTokens }))
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.sendError(res, 400, error instanceof Error ? error.message : 'Invalid request body', 'anthropic')
    }
  }

  // Gemini v1beta 模型列表
  private async handleGeminiModels(res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const result = await this.getAvailableModels(signal)
    const geminiModels = result.models.map(m => ({
      name: `models/${m.id}`,
      version: '001',
      displayName: m.name || m.id,
      description: m.description || '',
      inputTokenLimit: m.maxInputTokens || 200000,
      outputTokenLimit: m.maxOutputTokens || 64000,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
    }))
    this.throwIfResponseClosed(res, signal)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ models: geminiModels }))
  }

  // Gemini v1beta generateContent / streamGenerateContent
  private async handleGeminiRequest(req: http.IncomingMessage, res: http.ServerResponse, path: string, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const geminiReq = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey

    // 解析路径: /v1beta/models/{model}:{method}
    const match = path.match(/\/v1beta\/models\/([^:]+):(\w+)/)
    if (!match) {
      this.sendError(res, 400, 'Invalid Gemini endpoint path')
      return
    }
    const [, modelId, method] = match
    const isStream = method === 'streamGenerateContent'

    // 将 Gemini 请求转为 OpenAI 格式
    const messages: OpenAIMessage[] = []
    if (geminiReq.systemInstruction?.parts) {
      const sysText = geminiReq.systemInstruction.parts.map((p: { text?: string }) => p.text || '').join('\n')
      if (sysText) messages.push({ role: 'system', content: sysText })
    }
    for (const content of geminiReq.contents || []) {
      const role = content.role === 'model' ? 'assistant' : 'user'
      const text = (content.parts || []).map((p: { text?: string }) => p.text || '').join('')
      if (text) messages.push({ role: role as 'user' | 'assistant', content: text })
    }
    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Hello' })
    }

    const openaiRequest: OpenAIChatRequest = {
      model: this.applyModelMapping(modelId, matchedApiKey?.id),
      messages,
      stream: isStream,
      temperature: geminiReq.generationConfig?.temperature,
      top_p: geminiReq.generationConfig?.topP,
      max_tokens: geminiReq.generationConfig?.maxOutputTokens
    }

    // 复用 OpenAI 流程
    const startTime = Date.now()
    this.recordNewRequest()
    this.throwIfAborted(signal)
    // v1.7.6 传入 modelId 让能力路由生效(gemini 端点也参与,§4.8 sweep)
    const holdEnabledGemini = this.config.holdWhenNoAccount === true
    const account = await this.getAvailableAccount(signal, undefined, matchedApiKey?.id, openaiRequest.model)
    this.throwIfAborted(signal)
    if (!account) {
      // Hold Gate 汇合点 A(task#5):开关开 → 挂起等待换号,而非现状直接 503。
      if (holdEnabledGemini) {
        await this.startGeminiWithHold(res, openaiRequest, modelId, startTime, matchedApiKey, isStream, signal)
        return
      }
      this.sendError(res, 503, 'No available accounts')
      return
    }

    // Hold Gate 汇合点 B(task#5):选到号但首字节前失败 & 切号后无号 → 挂起。开关关 → 走下方原有路径,行为逐字不变。
    if (holdEnabledGemini) {
      await this.startGeminiWithHold(res, openaiRequest, modelId, startTime, matchedApiKey, isStream, signal, account)
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()
      const kiroPayload = openaiToKiro(openaiRequest, account.profileArn, toolNameRegistry, this.getThinkingConfig(openaiRequest.model))

      if (isStream) {
        // SSE 流式
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
        return new Promise<void>((resolve) => {
          callKiroApiStream(
            account as ProxyAccount,
            kiroPayload,
            (text) => {
              if (signal?.aborted || this.isResponseClosed(res)) return
              if (text) {
                const chunk = { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: null }] }
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
              return this.waitForDrain(res)
            },
            (usage) => {
              if (signal?.aborted || this.isResponseClosed(res)) {
                resolve()
                return
              }
              // 上游异常终止 → 不发 finishReason:'STOP'(伪装正常收尾),改发 error 让客户端明确失败。
              // 见 /v1/messages 处同款注释(2026-08-01 RCA CONTENT_FILTERED 静默断流)。
              if (usage.terminal?.shouldFail) {
                const reason = usage.terminal.upstreamStopReason || usage.terminal.disposition
                proxyLogger.warn('ProxyServer', `Gemini stream: upstream abnormal terminal → error`, {
                  model: modelId, disposition: usage.terminal.disposition, upstreamStopReason: usage.terminal.upstreamStopReason
                })
                res.write(`data: ${JSON.stringify({ error: { message: usage.terminal.disposition === 'filtered' ? `上游内容过滤器截断了本次响应 (stopReason: ${reason})。这一轮输出不完整,请重试或调整措辞。` : `上游异常终止,响应不完整 (stopReason: ${reason})。请重试。`, code: `upstream_${usage.terminal.disposition}` } })}\n\n`)
                res.end()
                this.recordRequestFailed()
                this.events.onResponse?.({ path: '/v1beta/models', model: modelId, status: 502, error: `upstream_${usage.terminal.disposition}: ${reason}` })
                resolve()
                return
              }
              // 上游命中输出上限 → Gemini 语义用 MAX_TOKENS,不伪装 STOP
              const gFinish = usage.terminal?.disposition === 'length' ? 'MAX_TOKENS' : 'STOP'
              const finalChunk = { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: gFinish }], usageMetadata: { promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens, totalTokenCount: usage.inputTokens + usage.outputTokens } }
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              res.end()
              this.recordRequestSuccess()
              this.stats.totalTokens += usage.inputTokens + usage.outputTokens
              this.stats.inputTokens += usage.inputTokens
              this.stats.outputTokens += usage.outputTokens
              this.stats.totalCredits += usage.credits || 0
              this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
              resolve()
            },
            (error) => {
              if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
                resolve()
                return
              }
              res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
              res.end()
              this.recordRequestFailed()
              resolve()
            },
            signal,
            this.config.preferredEndpoint
          ).catch(error => {
            if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
              res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
              res.end()
              this.recordRequestFailed()
            }
            resolve()
          })
        })
      } else {
        // 非流式
        const result = await callKiroApi(account as ProxyAccount, kiroPayload, signal)
        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: result.content }], role: 'model' }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: result.usage.inputTokens, candidatesTokenCount: result.usage.outputTokens, totalTokenCount: result.usage.inputTokens + result.usage.outputTokens }
        }))
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1beta', modelId, startTime, signal)
    }
  }

  // 模型列表缓存
  private modelCache: { models: KiroModel[]; timestamp: number } | null = null
  private readonly MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存

  // Steering 文件缓存（从 config.workspacePath 加载）
  private steeringDocs: SteeringDocument[] = []
  private steeringPrompt: string = ''

  /** 加载/刷新 steering 文件缓存。config.workspacePath 变化时调用。 */
  loadSteering(): void {
    if (!this.config.workspacePath) {
      this.steeringDocs = []
      this.steeringPrompt = ''
      return
    }
    this.steeringDocs = loadSteeringDocuments(this.config.workspacePath)
    this.steeringPrompt = formatSteeringForPrompt(this.steeringDocs)
    if (this.steeringPrompt) {
      console.log(`[ProxyServer] Loaded ${this.steeringDocs.filter(d => d.inclusion === 'always').length} steering files from ${this.config.workspacePath}`)
    }
  }

  /** 获取格式化后的 steering prompt（注入到 system message 前面） */
  getSteeringPrompt(): string {
    return this.steeringPrompt
  }

  /** 注入 steering 到 OpenAI 格式请求的 messages（prepend 到 system 消息前面或新增 system 消息） */
  private injectSteeringOpenAI(messages: OpenAIMessage[]): OpenAIMessage[] {
    if (!this.steeringPrompt) return messages
    // 找到第一个 system 消息并 prepend
    const sysIdx = messages.findIndex(m => m.role === 'system')
    if (sysIdx >= 0) {
      const sys = messages[sysIdx]
      const existingContent = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content)
      return [
        ...messages.slice(0, sysIdx),
        { ...sys, content: `${this.steeringPrompt}\n\n${existingContent}` },
        ...messages.slice(sysIdx + 1)
      ]
    }
    // 没有 system 消息，在最前面加一个
    return [{ role: 'system', content: this.steeringPrompt }, ...messages]
  }

  /** 注入 steering 到 Claude 格式请求的 system 字段 */
  private injectSteeringClaude(system?: string | ClaudeContentBlock[]): string | ClaudeContentBlock[] | undefined {
    if (!this.steeringPrompt) return system
    if (!system) return this.steeringPrompt
    if (typeof system === 'string') return `${this.steeringPrompt}\n\n${system}`
    // system 是 content block 数组，prepend 一个 text block
    return [{ type: 'text', text: this.steeringPrompt } as ClaudeContentBlock, ...system]
  }

  // 模型列表
  private async handleModels(res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    
    // Kiro 官方模型（与 UI 保持一致）
    // ⚠️ 这份静态清单只是 fetchKiroModels 失败时的兜底(动态模型优先合并,见下方 step 1)。
    // 窗口/倍率取自 ListAvailableModels 实测值(2026-08-12 · EU ksk + 代理拉到 17 个模型),
    // 不写 maxInputTokens 会被 buildClientModel 落到 200000 默认值 → 1M/272K 档被低估。
    const kiroOfficialModels = [
      buildClientModel({ id: 'auto', created: now, ownedBy: 'kiro-api', description: 'Auto select best model', modelName: 'Auto', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 64000, rateMultiplier: 1, rateUnit: 'Credit' }),
      // GPT-5.6 三档(2026-07 上游新增 OpenAI 模型;实测 272K 入 / 128K 出 · 倍率 2.4 / 1.0 / 0.1)
      buildClientModel({ id: 'gpt-5.6-sol', created: now, ownedBy: 'kiro-api', description: 'OpenAI GPT 5.6 Sol with 272k context window', modelName: 'GPT 5.6 Sol', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000, rateMultiplier: 2.4, rateUnit: 'Credit' }),
      buildClientModel({ id: 'gpt-5.6-terra', created: now, ownedBy: 'kiro-api', description: 'OpenAI GPT 5.6 Terra with 272k context window', modelName: 'GPT 5.6 Terra', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000, rateMultiplier: 1, rateUnit: 'Credit' }),
      buildClientModel({ id: 'gpt-5.6-luna', created: now, ownedBy: 'kiro-api', description: 'OpenAI GPT 5.6 Luna with 272k context window', modelName: 'GPT 5.6 Luna', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000, rateMultiplier: 0.1, rateUnit: 'Credit' }),
      // Claude 1M 档
      buildClientModel({ id: 'claude-opus-5', created: now, ownedBy: 'kiro-api', description: 'Claude Opus 5 with 1M context window', modelName: 'Claude Opus 5', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 128000, rateMultiplier: 2.2, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-sonnet-5', created: now, ownedBy: 'kiro-api', description: 'Claude Sonnet 5 with 1M context window', modelName: 'Claude Sonnet 5', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 64000, rateMultiplier: 1.3, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-opus-4.8', created: now, ownedBy: 'kiro-api', description: 'Claude Opus 4.8 with 1M context window', modelName: 'Claude Opus 4.8', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 128000, rateMultiplier: 2.2, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-opus-4.7', created: now, ownedBy: 'kiro-api', description: 'Claude Opus 4.7 with 1M context window', modelName: 'Claude Opus 4.7', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 128000, rateMultiplier: 2.2, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-opus-4.6', created: now, ownedBy: 'kiro-api', description: 'Claude Opus 4.6 with 1M context window', modelName: 'Claude Opus 4.6', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 64000, rateMultiplier: 2.2, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-sonnet-4.6', created: now, ownedBy: 'kiro-api', description: 'Claude Sonnet 4.6 with 1M context window', modelName: 'Claude Sonnet 4.6', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 1000000, maxOutputTokens: 64000, rateMultiplier: 1.3, rateUnit: 'Credit' }),
      // Claude 200K 档
      buildClientModel({ id: 'claude-opus-4.5', created: now, ownedBy: 'kiro-api', description: 'The most powerful model', modelName: 'Claude Opus 4.5', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000, rateMultiplier: 2.2, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-sonnet-4.5', created: now, ownedBy: 'kiro-api', description: 'The latest Claude Sonnet model', modelName: 'Claude Sonnet 4.5', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000, rateMultiplier: 1.3, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-sonnet-4', created: now, ownedBy: 'kiro-api', description: 'Hybrid reasoning and coding', modelName: 'Claude Sonnet 4', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000, rateMultiplier: 1.3, rateUnit: 'Credit' }),
      buildClientModel({ id: 'claude-haiku-4.5', created: now, ownedBy: 'kiro-api', description: 'The latest Claude Haiku model', modelName: 'Claude Haiku 4.5', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000, rateMultiplier: 0.4, rateUnit: 'Credit' }),
      // 国产模型(实测在 EU/US 均返回)
      buildClientModel({ id: 'minimax-m2.5', created: now, ownedBy: 'kiro-api', description: 'The MiniMax M2.5 model', modelName: 'MiniMax M2.5', supportedInputTypes: ['TEXT'], maxInputTokens: 196000, maxOutputTokens: 64000, rateMultiplier: 0.25, rateUnit: 'Credit' }),
      buildClientModel({ id: 'qwen3-coder-next', created: now, ownedBy: 'kiro-api', description: 'Experimental preview of Qwen3 Coder Next', modelName: 'Qwen3 Coder Next', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 256000, maxOutputTokens: 64000, rateMultiplier: 0.05, rateUnit: 'Credit' })
    ]

    // 隐藏模型（未在官方 ListAvailableModels 中返回，但后端可能支持）
    const hiddenModels = [
      buildClientModel({ id: 'claude-3.7-sonnet', created: now, ownedBy: 'kiro-api', description: 'Claude 3.7 Sonnet (hidden)', modelName: 'Claude 3.7 Sonnet', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
      buildClientModel({ id: 'simple-task', created: now, ownedBy: 'kiro-api', description: 'Kiro fast model for intent classification and lightweight tasks (routes to Haiku)', modelName: 'Simple Task', supportedInputTypes: ['TEXT'], maxInputTokens: 200000, maxOutputTokens: 4096 }),
      buildClientModel({ id: 'CLAUDE_SONNET_4_20250514_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude Sonnet 4 (CodeWhisperer internal ID)', modelName: 'Claude Sonnet 4 (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
      buildClientModel({ id: 'CLAUDE_HAIKU_4_5_20251001_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude Haiku 4.5 (CodeWhisperer internal ID)', modelName: 'Claude Haiku 4.5 (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
      buildClientModel({ id: 'CLAUDE_3_7_SONNET_20250219_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude 3.7 Sonnet (CodeWhisperer internal ID)', modelName: 'Claude 3.7 Sonnet (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 })
    ]

    // 预设模型（GPT 兼容别名）
    // 这些名字在 Kiro 上游并不存在(2026-08-12 实测 gpt-4o → 400 INVALID_MODEL_ID),
    // 但反代的 mapModelId 会把它们归一到 GPT-5.6 Sol,故对客户端仍是可用别名。
    // 窗口按归一后的真实目标(272K)广告,而非 OpenAI 原版 gpt-4o 的 128K —— 否则客户端
    // 会按错误上限裁剪上下文。裸名 gpt-5.6 / gpt-5 同理一并广告。
    const presetModels = [
      buildClientModel({ id: 'gpt-5.6', created: now, ownedBy: 'kiro-proxy', description: 'Alias → GPT-5.6 Sol', modelName: 'GPT-5.6 (alias → Sol)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000 }),
      buildClientModel({ id: 'gpt-5', created: now, ownedBy: 'kiro-proxy', description: 'Alias → GPT-5.6 Sol', modelName: 'GPT-5 (alias → Sol)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000 }),
      buildClientModel({ id: 'gpt-4o', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro (→ GPT-5.6 Sol)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000 }),
      buildClientModel({ id: 'gpt-4', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro (→ GPT-5.6 Sol)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000 }),
      buildClientModel({ id: 'gpt-4-turbo', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro (→ GPT-5.6 Sol)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000 }),
      buildClientModel({ id: 'gpt-3.5-turbo', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro (→ GPT-5.6 Sol)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 272000, maxOutputTokens: 128000 })
    ]

    // 尝试从 Kiro API 获取动态模型
    let kiroModels: KiroModel[] = []
    
    // 检查缓存
    if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
    } else {
      // 获取一个可用账号来请求模型列表
      const account = this.accountPool.getNextAccount()
      if (account) {
        try {
          kiroModels = await fetchKiroModels(account, signal)
          if (kiroModels.length > 0) {
            this.modelCache = { models: kiroModels, timestamp: now }
            // 同步到 kiroApi 的 ctx cache, 供 token 裁剪逻辑使用
            for (const m of kiroModels) {
              if (m.tokenLimits?.maxInputTokens) {
                setModelContextWindow(m.modelId, m.tokenLimits.maxInputTokens)
              }
            }
            proxyLogger.info('ProxyServer', `Fetched ${kiroModels.length} models from Kiro API`)
          }
        } catch (error) {
          if (this.isAbortError(error, signal)) throw error
          console.error('[ProxyServer] Failed to fetch Kiro models:', error)
        }
      }
    }

    // 转换 Kiro 模型为 OpenAI 格式（保持原始 modelId）
    const dynamicModels = kiroModels.map(m => buildClientModel({
      id: m.modelId,
      created: now,
      ownedBy: 'kiro-api',
      description: m.description,
      modelName: m.modelName,
      supportedInputTypes: m.supportedInputTypes,
      maxInputTokens: m.tokenLimits?.maxInputTokens,
      maxOutputTokens: m.tokenLimits?.maxOutputTokens,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      promptCaching: m.promptCaching,
      additionalModelRequestFieldsSchema: m.additionalModelRequestFieldsSchema,
      modelProvider: m.modelProvider
    }))

    // 合并模型列表，去重
    const modelIds = new Set<string>()
    const allModels: ClientModel[] = []
    
    // 1. 优先添加动态模型（从 API 获取的，包含真实 token limit / input types）
    for (const m of dynamicModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }
    
    // 2. 添加隐藏模型（未在官方 ListAvailableModels 中返回，但后端可能支持）
    for (const m of hiddenModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }
    
    // 3. 动态模型缺失时才添加静态兜底
    //
    // ⚠️ 静态清单是「模型固有元数据」(id / 窗口 / 倍率),不是「本账号本区域的可用性」——
    // 两者必须分层看待。实测(2026-08-12)同一把 ksk:直连 ListAvailableModels 只返 6 个模型
    // (Claude 全系被过滤),走代理返 17 个;不同订阅档/区域的可用子集也不同。
    // 因此拉取失败时广告全量清单,可能列出该账号实际调不动的模型 → 用户遇到「列表里有但请求 400」。
    // 取舍:宁可多列(用户可换号/查网络)也不给空列表(客户端直接不可用)——但必须让用户知道
    // 这是未经账号校验的兜底清单,故 description 前缀标注 + 打 warn 日志。
    if (dynamicModels.length === 0) {
      proxyLogger.warn(
        'ProxyServer',
        `ListAvailableModels 拉取失败或无可用账号 → 回落静态模型清单(未按账号/区域校验可用性)。` +
        `其中部分模型在当前账号或网络环境下可能返回 400 INVALID_MODEL_ID。`
      )
      for (const m of [...kiroOfficialModels, ...presetModels]) {
        if (!modelIds.has(m.id)) {
          modelIds.add(m.id)
          allModels.push({
            ...m,
            description: `[未校验兜底清单] ${m.description}`
          })
        }
      }
    }

    this.throwIfResponseClosed(res, signal)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: allModels }))
  }

  // 处理 OpenAI Chat Completions 请求
  private async handleOpenAIChat(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const request: OpenAIChatRequest = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey

    // 提取 session hint（用于稳定 conversationId），拼入 API Key hash 隔离不同用户
    const rawHintChat = ProxyServer.extractSessionHint(req, request)
    if (!request.conversation_id && rawHintChat) {
      const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
      request.conversation_id = `${keyPrefix}:${rawHintChat}`
    }
    const affinityHintChat = request.conversation_id

    // 应用模型映射
    request.model = this.applyModelMapping(request.model, matchedApiKey?.id)

    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST' })

    let processedRequest: OpenAIChatRequest
    try {
      processedRequest = await this.resolveOpenAIHttpImages(this.prepareOpenAIRequest(request), signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message)
      this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 400, error: message })
      this.recordRequest({ path: '/v1/chat/completions', model: request.model, responseTime: Date.now() - startTime, success: false, error: message })
      return
    }

    // 获取账号（包含 Token 刷新检查 + 会话粘性 + API Key 账号白名单）
    this.throwIfAborted(signal)
    const wantStreamChat = request.stream === true
    const holdEnabledChat = this.config.holdWhenNoAccount === true
    const account = await this.getAvailableAccount(signal, affinityHintChat, matchedApiKey?.id, request.model)
    this.throwIfAborted(signal)
    if (!account) {
      // Hold Gate 汇合点 A(task#5):开关开 → 挂起等待换号,而非现状直接 503。
      if (holdEnabledChat) {
        await this.startOpenAIChatWithHold(res, processedRequest, request.model, startTime, matchedApiKey, wantStreamChat, signal)
        return
      }
      this.recordRequestFailed()
      const quotaStatus = this.accountPool.getQuotaStatus()
      const errorMsg = quotaStatus.exhausted > 0 && quotaStatus.available === 0
        ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
        : 'No available accounts'
      this.sendError(res, 503, errorMsg)
      this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 503, error: errorMsg })
      this.recordRequest({ path: '/v1/chat/completions', model: request.model, success: false, error: errorMsg })
      return
    }

    this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST', accountId: account.id })

    // Hold Gate 汇合点 B(task#5):选到号但首字节前失败 & 切号后无号 → 挂起。开关关 → 走下方原有路径,行为逐字不变。
    if (holdEnabledChat) {
      await this.startOpenAIChatWithHold(res, processedRequest, request.model, startTime, matchedApiKey, wantStreamChat, signal, account)
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()

      // 注入 steering 到 system message
      if (this.steeringPrompt) {
        processedRequest.messages = this.injectSteeringOpenAI(processedRequest.messages)
      }

      // 转换为 Kiro 格式
      const thinkingConfig = this.getThinkingConfig(processedRequest.model)
      const kiroPayload = openaiToKiro(processedRequest, account.profileArn, toolNameRegistry, thinkingConfig)

      // 记录请求详情到日志
      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0
        
        proxyLogger.info('ProxyServer', `OpenAI API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id
        })
      }

      if (request.stream) {
        // 流式响应（流式不使用重试机制，错误由流处理）
        await this.handleOpenAIStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, matchedApiKey, toolNameRegistry, signal)
      } else {
        // 非流式响应（带重试机制）
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry, thinkingConfig)
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/chat/completions',
          signal,
          request.model
        )
        const response = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, request.model, toolNameRegistry, result.reasoningContent)

        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/chat/completions', model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
        // 记录 API Key 用量
        if (matchedApiKey) {
          this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, request.model, '/v1/chat/completions')
        }
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1/chat/completions', request.model, startTime, signal)
    }
  }

  private async handleOpenAIResponses(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey
    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/responses', method: 'POST' })

    let responseRequest: OpenAIResponsesRequest
    let chatRequest: OpenAIChatRequest
    let processedRequest: OpenAIChatRequest
    let affinityHintResp: string | undefined
    try {
      responseRequest = JSON.parse(body)
      chatRequest = responsesToOpenAIChat(responseRequest)
      // session hint：用于会话粘性
      const rawHintResp = ProxyServer.extractSessionHint(req, responseRequest)
      if (rawHintResp) {
        const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
        affinityHintResp = `${keyPrefix}:${rawHintResp}`
      }
      chatRequest.model = this.applyModelMapping(chatRequest.model, matchedApiKey?.id)
      processedRequest = await this.resolveOpenAIHttpImages(this.prepareOpenAIRequest(chatRequest), signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message)
      this.events.onResponse?.({ path: '/v1/responses', status: 400, error: message })
      this.recordRequest({ path: '/v1/responses', responseTime: Date.now() - startTime, success: false, error: message })
      return
    }

    this.throwIfAborted(signal)
    const holdEnabledResp = this.config.holdWhenNoAccount === true
    const account = await this.getAvailableAccount(signal, affinityHintResp, matchedApiKey?.id, chatRequest.model)
    this.throwIfAborted(signal)
    if (!account) {
      // Hold Gate 汇合点 A(task#5):开关开 → 挂起等待换号,而非现状直接 503。
      if (holdEnabledResp) {
        await this.startOpenAIResponsesWithHold(res, processedRequest, responseRequest, chatRequest.model, startTime, matchedApiKey, processedRequest.stream === true, signal, undefined, affinityHintResp)
        return
      }
      this.recordRequestFailed()
      const quotaStatus = this.accountPool.getQuotaStatus()
      const errorMsg = quotaStatus.exhausted > 0 && quotaStatus.available === 0
        ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
        : 'No available accounts'
      this.sendError(res, 503, errorMsg)
      this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 503, error: errorMsg })
      this.recordRequest({ path: '/v1/responses', model: chatRequest.model, success: false, error: 'No available accounts' })
      return
    }

    this.events.onRequest?.({ path: '/v1/responses', method: 'POST', accountId: account.id })

    // Hold Gate 汇合点 B(task#5):选到号但首字节前失败 & 切号后无号 → 挂起。开关关 → 走下方原有路径,行为逐字不变。
    if (holdEnabledResp) {
      await this.startOpenAIResponsesWithHold(res, processedRequest, responseRequest, chatRequest.model, startTime, matchedApiKey, processedRequest.stream === true, signal, account, affinityHintResp)
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()
      if (processedRequest.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        const responseId = `resp_${uuidv4()}`
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: chatRequest.model, output: [] } })}\n\n`)
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry, this.getThinkingConfig(processedRequest.model))
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/responses',
          signal,
          chatRequest.model
        )
        const chatResponse = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, chatRequest.model, toolNameRegistry, result.reasoningContent)
        this.throwIfResponseClosed(res, signal)
        const response = openAIChatToResponsesResponse(chatResponse, responseRequest.previous_response_id)
        const streamedResponse = { ...response, id: responseId }
        streamedResponse.output.forEach((item, outputIndex) => {
          this.throwIfResponseClosed(res, signal)
          res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIndex, item })}\n\n`)
          if (item.type === 'message') {
            item.content.forEach((part, contentIndex) => {
              this.throwIfResponseClosed(res, signal)
              res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { type: part.type, text: '' } })}\n\n`)
              if (part.text) {
                res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text })}\n\n`)
              }
              res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text })}\n\n`)
              res.write(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part })}\n\n`)
            })
          } else {
            if (item.arguments) {
              res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments })}\n\n`)
            }
            res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments })}\n\n`)
          }
          this.throwIfResponseClosed(res, signal)
          res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item })}\n\n`)
        })
        this.throwIfResponseClosed(res, signal)
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: streamedResponse })}\n\n`)
        res.end()
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/responses', model: chatRequest.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
        if (matchedApiKey) {
          this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, chatRequest.model, '/v1/responses')
        }
        return
      }

      const { result, account: usedAccount } = await this.callWithRetry(
        account,
        async (acc) => {
          const retryPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry, this.getThinkingConfig(processedRequest.model))
          return callKiroApi(acc, retryPayload, signal)
        },
        '/v1/responses',
        signal,
        chatRequest.model
      )
      const chatResponse = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, chatRequest.model, toolNameRegistry, result.reasoningContent)
      this.throwIfResponseClosed(res, signal)
      const response = openAIChatToResponsesResponse(chatResponse, responseRequest.previous_response_id)

      this.recordRequestSuccess()
      this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
      this.stats.inputTokens += result.usage.inputTokens
      this.stats.outputTokens += result.usage.outputTokens
      this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
      const respTime = Date.now() - startTime
      this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
      this.recordRequest({ path: '/v1/responses', model: chatRequest.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
      if (matchedApiKey) {
        this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, chatRequest.model, '/v1/responses')
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1/responses', chatRequest.model, startTime, signal)
    }
  }

  // 处理 OpenAI 流式响应
  private async handleOpenAIStream(
    res: http.ServerResponse,
    account: { id: string; accessToken: string; profileArn?: string },
    kiroPayload: ReturnType<typeof openaiToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    streamId?: string,
    headersSent: boolean = false,
    matchedApiKey?: import('./types').ApiKey,
    toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
    signal?: AbortSignal,
    // Hold Gate 接线(task#5,ADR-0001 边界 2):首字节前上游失败时回调。
    // 返回 true = 已被挂起门闸接管(不发 error chunk,交给 resume 重试);false = 未接管,按现状发 error。
    // 仅在"尚未写出任何语义正文(initial/content/tool chunk)"时才可能被调用。
    onPreBodyError?: (error: Error) => boolean
  ): Promise<void> {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
    }

    const id = streamId || `chatcmpl-${uuidv4()}`
    let toolCallIndex = 0
    const pendingToolCalls: Map<string, { index: number; name: string; arguments: string }> = new Map()
    let collectedContent = ''
    // ADR-0001 边界 1(SSE bootstrap 时序):initial chunk(role:assistant)从"进入即发"延迟到"首个语义正文前"。
    // 挂起态(resume 前)从不写出正文,故首字节前失败可无缝切号重放。currentRound>0(续接)视为已发。
    let bodyStartSent = currentRound !== 0
    const emitBodyStartOnce = () => {
      if (bodyStartSent) return
      bodyStartSent = true
      const initialChunk = createOpenaiStreamChunk(id, model, { role: 'assistant' })
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`)
    }

    return new Promise((resolve) => {
      callKiroApiStream(
        account as any,
        kiroPayload,
        (text, toolUse, isThinking) => {
          if (signal?.aborted || this.isResponseClosed(res)) return
          // ADR-0001 边界 1:首个语义正文前惰性补发 initial chunk(恰好一次);此后 onPreBodyError 不再接管。
          emitBodyStartOnce()
          if (text && text.trim()) {
            if (isThinking) {
              // 原生 thinking 内容 → 输出为 reasoning_content
              const chunk = createOpenaiStreamChunk(id, model, { reasoning_content: text })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            } else {
              // 普通文本内容
              collectedContent += text
              const chunk = createOpenaiStreamChunk(id, model, { content: text })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          }
          if (toolUse) {
            const idx = toolCallIndex++
            const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
            pendingToolCalls.set(toolUse.toolUseId, {
              index: idx,
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input)
            })
            const toolChunk = createOpenaiStreamChunk(id, model, {
              tool_calls: [{
                index: idx,
                id: toolUse.toolUseId,
                type: 'function',
                function: {
                  name: restoredToolUse.name,
                  arguments: JSON.stringify(toolUse.input)
                }
              }]
            })
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`)
          }
          return this.waitForDrain(res)
        },
        async (usage) => {
          if (signal?.aborted || this.isResponseClosed(res)) {
            resolve()
            return
          }
          // 空响应(上游未吐 chunk 即完成)也需补发 initial chunk,保证 SSE 完整。
          emitBodyStartOnce()

          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.cacheReadTokens += usage.cacheReadTokens || 0
          this.stats.cacheWriteTokens += usage.cacheWriteTokens || 0
          this.stats.reasoningTokens += usage.reasoningTokens || 0
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
          const oaiRespTime = Date.now() - startTime
          this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, reasoningTokens: usage.reasoningTokens, credits: usage.credits, responseTime: oaiRespTime })
          this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: oaiRespTime, success: true })
          // 记录 API Key 用量
          if (matchedApiKey) {
            this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/chat/completions')
          }

          // 上游异常终止 → 发 SSE error 让客户端明确失败(同 Claude 路径,见 /v1/messages 处注释)。
          // OpenAI 协议:错误以 data 里带 error 字段表达,随后照常 [DONE] 收尾。
          if (usage.terminal?.shouldFail) {
            const reason = usage.terminal.upstreamStopReason || usage.terminal.disposition
            const humanMsg = usage.terminal.disposition === 'filtered'
              ? `上游内容过滤器截断了本次响应 (stopReason: ${reason})。这一轮输出不完整,请重试或调整措辞。`
              : `上游异常终止,响应不完整 (stopReason: ${reason})。请重试。`
            proxyLogger.warn('ProxyServer', `OpenAI stream: upstream abnormal terminal → SSE error`, {
              path: '/v1/chat/completions', model, disposition: usage.terminal.disposition,
              upstreamStopReason: usage.terminal.upstreamStopReason
            })
            res.write(`data: ${JSON.stringify({ error: { message: humanMsg, type: 'upstream_error', code: `upstream_${usage.terminal.disposition}` } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
            this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 502, error: `upstream_${usage.terminal.disposition}: ${reason}` })
            resolve()
            return
          }
          // 发送结束 chunk（包含完整 usage 信息）
          const hasToolCalls = pendingToolCalls.size > 0
          // 上游 length(命中输出上限)如实映射为 OpenAI 'length',不伪装成 'stop'
          const finishReason = usage.terminal?.disposition === 'length'
            ? 'length'
            : hasToolCalls ? 'tool_calls' : 'stop'
          const usageInfo: {
            prompt_tokens: number
            completion_tokens: number
            total_tokens: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          } = {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens
          }
          // 添加 cache tokens 详情
          if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
            usageInfo.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
          }
          // 添加 reasoning tokens 详情
          if (usage.reasoningTokens && usage.reasoningTokens > 0) {
            usageInfo.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
          }
          const finalChunk = createOpenaiStreamChunk(id, model, {}, finishReason, usageInfo)
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          resolve()
        },
        (error) => {
          if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
            resolve()
            return
          }
          const errMsgFull = error.message || String(error)
          // v1.7.6 调试:显式把 error 内容写到 UI 可见日志
          proxyLogger.error('ProxyServer', `Stream error (OpenAI chat): ${errMsgFull.slice(0, 500)}`, {
            path: '/v1/chat/completions',
            model,
            account: (account as { email?: string }).email || account.id?.slice(0, 8) || '?',
            errorType: error.name || 'Error'
          })
          console.error('[ProxyServer] Stream error:', error)

          // Hold Gate 接线(task#5):先记账失败账号(recordError + suspended 检测),使 resume 拿号跳过它。
          this.recordRequestFailed()
          const errStatusCode = extractHttpStatusCode(error.message)
          this.accountPool.recordError(account.id, errStatusCode !== undefined ? classifyError(errStatusCode) : ErrorType.RECOVERABLE, errStatusCode)
          const suspendInfoOai = this.detectSuspendedError(error.message)
          if (suspendInfoOai) {
            const newlyMarked = this.accountPool.markSuspended(account.id, suspendInfoOai.reason, suspendInfoOai.message)
            if (newlyMarked) this.events.onAccountSuspended?.({ accountId: account.id, email: (account as { email?: string }).email, reason: suspendInfoOai.reason, message: suspendInfoOai.message })
          }

          // ADR-0001 边界 2:仅在"尚未写出任何语义正文(bodyStartSent=false)"时,才允许挂起门闸接管。
          // RCA 2026-08-02:额外要求错误「换号可能有用」(isSwitchWorthyError)——
          //   400 Improperly formed request 这类请求级错误换号无用,以前会被误挂到客户端超时。
          if (!bodyStartSent && this.isSwitchWorthyError(error.message) && onPreBodyError?.(error)) {
            this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 503, error: `held: ${error.message}` })
            resolve()
            return
          }

          res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
          res.end()
          this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 500, error: error.message })
          this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: error.message })
          resolve()
        },
        signal,
        this.config.preferredEndpoint
      ).catch(error => {
        if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
          res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
          res.end()
          this.recordRequestFailed()
        }
        resolve()
      })
    })
  }

  /**
   * Hold Gate OpenAI /v1/chat/completions 挂起编排(task#5)。流式复用 runWithHold + 改造后的 handleOpenAIStream;
   * 非流式复用 runJsonRequestWithHold + callWithRetry。开关关时不走此路径,行为逐字不变。
   */
  private async startOpenAIChatWithHold(
    res: http.ServerResponse,
    processedRequest: OpenAIChatRequest,
    model: string,
    startTime: number,
    matchedApiKey: import('./types').ApiKey | undefined,
    stream: boolean,
    signal?: AbortSignal,
    seedAccount?: ProxyAccount
  ): Promise<void> {
    if (this.steeringPrompt) processedRequest.messages = this.injectSteeringOpenAI(processedRequest.messages)
    const thinkingConfig = this.getThinkingConfig(processedRequest.model)
    const affinityHint = processedRequest.conversation_id
    const pickAccount = (_tried: Set<string>) => this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id, model)

    if (stream) {
      // 先建 SSE 连接;initial chunk 由 handleOpenAIStream 惰性延迟到首字节。
      if (!this.isResponseClosed(res)) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
      const attempt = (acc: ProxyAccount, recordError: (err: Error) => void): Promise<'done' | 'pre_body_failed'> => new Promise((resolveAttempt) => {
        const toolNameRegistry = new ToolNameRegistry()
        const kiroPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry, thinkingConfig)
        this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST', accountId: acc.id })
        let settled = false
        const onPreBodyError = (e: Error): boolean => { if (!settled) { settled = true; recordError(e); resolveAttempt('pre_body_failed') } ; return true }
        this.handleOpenAIStream(res, acc, kiroPayload, model, startTime, 0, undefined, true, matchedApiKey, toolNameRegistry, signal, onPreBodyError)
          .then(() => { if (!settled) { settled = true; resolveAttempt('done') } })
          .catch(() => { if (!settled) { settled = true; resolveAttempt('done') } })
      })
      await this.runWithHold({
        res, startTime, signal, seedAccount, pickAccount, attempt,
        sendPing: () => { if (!this.isResponseClosed(res)) res.write(': ping\n\n') },
        onTimeoutError: () => { if (!this.isResponseClosed(res)) { res.write(`data: ${JSON.stringify({ error: { message: 'Hold timeout: no account became available in time (HOLD_TIMEOUT)' } })}\n\n`); res.end() } },
        onTimeoutGracefulStop: () => { if (!this.isResponseClosed(res)) { const c = createOpenaiStreamChunk(`chatcmpl-${uuidv4()}`, model, { role: 'assistant', content: '[请求等待可用账号超时,请重新发送]' }, 'stop'); res.write(`data: ${JSON.stringify(c)}\n\n`); res.write('data: [DONE]\n\n'); res.end() } }
      })
      return
    }

    // 非流式
    await this.runJsonRequestWithHold<{ result: Awaited<ReturnType<typeof callKiroApi>>; toolNameRegistry: ToolNameRegistry }>({
      res, startTime, signal, seedAccount, path: '/v1/chat/completions', model, pickAccount,
      doCall: async (acc) => {
        const toolNameRegistry = new ToolNameRegistry()
        this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST', accountId: acc.id })
        const { result, account: usedAccount } = await this.callWithRetry(
          acc, async (a) => callKiroApi(a, openaiToKiro(processedRequest, a.profileArn, toolNameRegistry, thinkingConfig), signal),
          '/v1/chat/completions', signal, model
        )
        return { result: { result, toolNameRegistry } as any, account: usedAccount }
      },
      writeSuccess: (wrapped: any, usedAccount) => {
        const { result, toolNameRegistry } = wrapped
        const response = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, model, toolNameRegistry, result.reasoningContent)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/chat/completions', model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
        if (matchedApiKey) this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, model, '/v1/chat/completions')
      },
      onTimeoutError: () => { if (!this.isResponseClosed(res)) this.sendError(res, 503, 'Hold timeout: no account became available in time (HOLD_TIMEOUT)') },
      onTimeoutGracefulStop: () => { if (!this.isResponseClosed(res)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: `chatcmpl-${uuidv4()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: '[请求等待可用账号超时,请重新发送]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })) } }
    })
  }

  /**
   * Hold Gate OpenAI /v1/responses 挂起编排(task#5)。responses 是"伪流式"(先 callWithRetry 拿完整结果再拆成 SSE 事件),
   * 故流式/非流式都用 runJsonRequestWithHold:doCall=callWithRetry;writeSuccess 里按 stream 写 SSE 事件序列或 JSON。
   * 流式的 response.created 首字节延迟到拿到 result 后才写(writeSuccess 内),使首字节前失败可挂起。
   */
  private async startOpenAIResponsesWithHold(
    res: http.ServerResponse,
    processedRequest: OpenAIChatRequest,
    responseRequest: OpenAIResponsesRequest,
    model: string,
    startTime: number,
    matchedApiKey: import('./types').ApiKey | undefined,
    stream: boolean,
    signal?: AbortSignal,
    seedAccount?: ProxyAccount,
    affinityHint?: string
  ): Promise<void> {
    if (stream && !this.isResponseClosed(res)) {
      // 先建 SSE 连接(空头,尚不写 response.created,延迟到拿到结果)。
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    }
    await this.runJsonRequestWithHold<{ result: Awaited<ReturnType<typeof callKiroApi>>; toolNameRegistry: ToolNameRegistry }>({
      res, startTime, signal, seedAccount, path: '/v1/responses', model,
      pickAccount: (_tried) => this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id, model),
      doCall: async (acc) => {
        const toolNameRegistry = new ToolNameRegistry()
        this.events.onRequest?.({ path: '/v1/responses', method: 'POST', accountId: acc.id })
        const { result, account: usedAccount } = await this.callWithRetry(
          acc, async (a) => callKiroApi(a, openaiToKiro(processedRequest, a.profileArn, toolNameRegistry, this.getThinkingConfig(processedRequest.model)), signal),
          '/v1/responses', signal, model
        )
        return { result: { result, toolNameRegistry } as any, account: usedAccount }
      },
      writeSuccess: (wrapped: any, usedAccount) => {
        const { result, toolNameRegistry } = wrapped
        const chatResponse = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, model, toolNameRegistry, result.reasoningContent)
        const response = openAIChatToResponsesResponse(chatResponse, responseRequest.previous_response_id)
        const commonRecord = () => {
          this.recordRequestSuccess()
          this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
          this.stats.inputTokens += result.usage.inputTokens
          this.stats.outputTokens += result.usage.outputTokens
          this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)
          const respTime = Date.now() - startTime
          this.events.onResponse?.({ path: '/v1/responses', model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
          this.recordRequest({ path: '/v1/responses', model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
          if (matchedApiKey) this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, model, '/v1/responses')
        }
        if (stream) {
          const responseId = `resp_${uuidv4()}`
          res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] } })}\n\n`)
          const streamedResponse = { ...response, id: responseId }
          streamedResponse.output.forEach((item, outputIndex) => {
            res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIndex, item })}\n\n`)
            if (item.type === 'message') {
              item.content.forEach((part, contentIndex) => {
                res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { type: part.type, text: '' } })}\n\n`)
                if (part.text) res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text })}\n\n`)
                res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text })}\n\n`)
                res.write(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part })}\n\n`)
              })
            } else {
              if (item.arguments) res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments })}\n\n`)
              res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments })}\n\n`)
            }
            res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item })}\n\n`)
          })
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: streamedResponse })}\n\n`)
          res.end()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        }
        commonRecord()
      },
      onTimeoutError: () => {
        if (this.isResponseClosed(res)) return
        if (stream) { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: 'Hold timeout: no account became available in time (HOLD_TIMEOUT)' })}\n\n`); res.end() }
        else this.sendError(res, 503, 'Hold timeout: no account became available in time (HOLD_TIMEOUT)')
      },
      onTimeoutGracefulStop: () => {
        if (this.isResponseClosed(res)) return
        if (stream) { const rid = `resp_${uuidv4()}`; res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] } })}\n\n`); res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: rid, object: 'response', model, output: [{ type: 'message', id: `msg_${uuidv4()}`, role: 'assistant', content: [{ type: 'output_text', text: '[请求等待可用账号超时,请重新发送]' }] }] } })}\n\n`); res.end() }
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: `resp_${uuidv4()}`, object: 'response', model, output: [{ type: 'message', id: `msg_${uuidv4()}`, role: 'assistant', content: [{ type: 'output_text', text: '[请求等待可用账号超时,请重新发送]' }] }] })) }
      }
    })
  }

  /**
   * Hold Gate Gemini(/v1beta generateContent|streamGenerateContent)挂起编排(task#5)。
   * 流式复用 runWithHold(内联 attempt 调 callKiroApiStream + candidates chunk 首字节延迟);
   * 非流式复用 runJsonRequestWithHold(doCall=callKiroApi 单次)。开关关时不走此路径,行为逐字不变。
   */
  private async startGeminiWithHold(
    res: http.ServerResponse,
    openaiRequest: OpenAIChatRequest,
    modelId: string,
    startTime: number,
    matchedApiKey: import('./types').ApiKey | undefined,
    isStream: boolean,
    signal?: AbortSignal,
    seedAccount?: ProxyAccount
  ): Promise<void> {
    const model = openaiRequest.model
    const pickAccount = (_tried: Set<string>) => this.getAvailableAccount(signal, undefined, matchedApiKey?.id, model)

    if (isStream) {
      if (!this.isResponseClosed(res)) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
      const attempt = (acc: ProxyAccount, recordError: (err: Error) => void): Promise<'done' | 'pre_body_failed'> => new Promise((resolveAttempt) => {
        const toolNameRegistry = new ToolNameRegistry()
        const kiroPayload = openaiToKiro(openaiRequest, acc.profileArn, toolNameRegistry, this.getThinkingConfig(model))
        this.events.onRequest?.({ path: '/v1beta', method: 'POST', accountId: acc.id })
        let settled = false
        let bodyStarted = false
        callKiroApiStream(
          acc as ProxyAccount, kiroPayload,
          (text) => {
            if (signal?.aborted || this.isResponseClosed(res)) return
            bodyStarted = true // 首个 candidates chunk 即语义正文,此后不可挂起重放
            if (text) { const chunk = { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: null }] }; res.write(`data: ${JSON.stringify(chunk)}\n\n`) }
            return this.waitForDrain(res)
          },
          (usage) => {
            if (signal?.aborted || this.isResponseClosed(res)) { if (!settled) { settled = true; resolveAttempt('done') } ; return }
            // 上游异常终止 → 不伪装 STOP(同上,HoldGate 变体路径)
            if (usage.terminal?.shouldFail) {
              const reason = usage.terminal.upstreamStopReason || usage.terminal.disposition
              proxyLogger.warn('ProxyServer', `Gemini stream (hold path): upstream abnormal terminal → error`, {
                model, disposition: usage.terminal.disposition, upstreamStopReason: usage.terminal.upstreamStopReason
              })
              res.write(`data: ${JSON.stringify({ error: { message: usage.terminal.disposition === 'filtered' ? `上游内容过滤器截断了本次响应 (stopReason: ${reason})。这一轮输出不完整,请重试或调整措辞。` : `上游异常终止,响应不完整 (stopReason: ${reason})。请重试。`, code: `upstream_${usage.terminal.disposition}` } })}\n\n`)
              res.end()
              this.recordRequestFailed()
              if (!settled) { settled = true; resolveAttempt('done') }
              return
            }
            const gFinish2 = usage.terminal?.disposition === 'length' ? 'MAX_TOKENS' : 'STOP'
            const finalChunk = { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: gFinish2 }], usageMetadata: { promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens, totalTokenCount: usage.inputTokens + usage.outputTokens } }
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
            res.end()
            this.recordRequestSuccess()
            this.stats.totalTokens += usage.inputTokens + usage.outputTokens
            this.stats.inputTokens += usage.inputTokens
            this.stats.outputTokens += usage.outputTokens
            this.stats.totalCredits += usage.credits || 0
            this.accountPool.recordSuccess(acc.id, usage.inputTokens + usage.outputTokens)
            if (!settled) { settled = true; resolveAttempt('done') }
          },
          (error) => {
            if (this.isAbortError(error, signal) || this.isResponseClosed(res)) { if (!settled) { settled = true; resolveAttempt('done') } ; return }
            // 记账失败账号(recordError + suspended 检测),使 resume 跳过它。
            this.recordRequestFailed()
            const sc = extractHttpStatusCode(error.message)
            this.accountPool.recordError(acc.id, sc !== undefined ? classifyError(sc) : ErrorType.RECOVERABLE, sc)
            const susp = this.detectSuspendedError(error.message)
            if (susp) { const nm = this.accountPool.markSuspended(acc.id, susp.reason, susp.message); if (nm) this.events.onAccountSuspended?.({ accountId: acc.id, email: (acc as { email?: string }).email, reason: susp.reason, message: susp.message }) }
            // 首字节前失败 → 交给 runWithHold 切号/挂起;已吐正文 → 现状 error。
            if (!bodyStarted) { if (!settled) { settled = true; recordError(error); resolveAttempt('pre_body_failed') } ; return }
            res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
            res.end()
            if (!settled) { settled = true; resolveAttempt('done') }
          },
          signal, this.config.preferredEndpoint
        ).catch(() => { if (!settled) { settled = true; resolveAttempt('done') } })
      })
      await this.runWithHold({
        res, startTime, signal, seedAccount, pickAccount, attempt,
        sendPing: () => { if (!this.isResponseClosed(res)) res.write(': ping\n\n') },
        onTimeoutError: () => { if (!this.isResponseClosed(res)) { res.write(`data: ${JSON.stringify({ error: { message: 'Hold timeout (HOLD_TIMEOUT)' } })}\n\n`); res.end() } },
        onTimeoutGracefulStop: () => { if (!this.isResponseClosed(res)) { res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '[请求等待可用账号超时,请重新发送]' }], role: 'model' }, finishReason: 'STOP' }] })}\n\n`); res.end() } }
      })
      return
    }

    // 非流式
    await this.runJsonRequestWithHold<Awaited<ReturnType<typeof callKiroApi>>>({
      res, startTime, signal, seedAccount, path: '/v1beta', model: modelId, pickAccount,
      doCall: async (acc) => {
        const toolNameRegistry = new ToolNameRegistry()
        this.events.onRequest?.({ path: '/v1beta', method: 'POST', accountId: acc.id })
        const result = await callKiroApi(acc, openaiToKiro(openaiRequest, acc.profileArn, toolNameRegistry, this.getThinkingConfig(model)), signal)
        return { result, account: acc }
      },
      writeSuccess: (result, usedAccount) => {
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: result.content }], role: 'model' }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: result.usage.inputTokens, candidatesTokenCount: result.usage.outputTokens, totalTokenCount: result.usage.inputTokens + result.usage.outputTokens }
        }))
      },
      onTimeoutError: () => { if (!this.isResponseClosed(res)) this.sendError(res, 503, 'Hold timeout (HOLD_TIMEOUT)') },
      onTimeoutGracefulStop: () => { if (!this.isResponseClosed(res)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[请求等待可用账号超时,请重新发送]' }], role: 'model' }, finishReason: 'STOP' }] })) } }
    })
  }

  // 处理 Claude Messages 请求
  private async handleClaudeMessages(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const request: ClaudeRequest = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey

    // 提取 session hint（用于稳定 conversationId），拼入 API Key hash 隔离不同用户
    const rawHint = ProxyServer.extractSessionHint(req, request)
    if (!request.conversation_id && rawHint) {
      const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
      request.conversation_id = `${keyPrefix}:${rawHint}`
    }
    // P1-8 会话粘性使用 conversation_id 作为粘性 key（已包含 API Key 前缀）
    const affinityHint = request.conversation_id

    // 应用模型映射
    request.model = this.applyModelMapping(request.model, matchedApiKey?.id)

    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/messages', method: 'POST' })

    let processedRequest: ClaudeRequest
    try {
      processedRequest = await this.resolveClaudeHttpImages(this.prepareClaudeRequest(request), signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message, 'anthropic')
      this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 400, error: message })
      this.recordRequest({ path: '/v1/messages', model: request.model, responseTime: Date.now() - startTime, success: false, error: message })
      return
    }

    // 获取账号（包含 Token 刷新检查 + 会话粘性 + API Key 账号白名单）
    this.throwIfAborted(signal)
    const wantStream = request.stream === true
    const holdEnabled = this.config.holdWhenNoAccount === true
    const account = await this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id, request.model)
    this.throwIfAborted(signal)
    if (!account) {
      // Hold Gate 汇合点 A(方案 §1 状态机 RECEIVED→无号):开关开 → 挂起等待换号,而非现状直接 503。
      // 流式走 SSE 挂起编排;非流式(task#5)走 JSON 挂起编排(无心跳,HTTP keep-alive 硬等)。
      if (holdEnabled) {
        if (wantStream) await this.startClaudeStreamWithHold(res, processedRequest, request.model, startTime, matchedApiKey, signal)
        else await this.startClaudeNonStreamWithHold(res, processedRequest, request.model, startTime, matchedApiKey, signal)
        return
      }
      this.recordRequestFailed()
      const quotaStatus = this.accountPool.getQuotaStatus()
      const errorMsg = quotaStatus.exhausted > 0 && quotaStatus.available === 0
        ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
        : 'No available accounts'
      this.sendError(res, 503, errorMsg, 'anthropic')
      this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 503, error: errorMsg })
      this.recordRequest({ path: '/v1/messages', model: request.model, success: false, error: errorMsg })
      return
    }

    this.events.onRequest?.({ path: '/v1/messages', method: 'POST', accountId: account.id })

    // Hold Gate 汇合点 B(方案 §1:选到号但首字节前上游失败 & 切号后无号):
    // 开关开时,把首次拿到的号交给带挂起感知的转发器 —— 首字节前失败(且未吐正文)时进入 HELD,
    // 而非直接报错。流式走 SSE 编排,非流式(task#5)走 JSON 编排。开关关 → 走下方原有路径,行为逐字不变。
    if (holdEnabled) {
      if (wantStream) await this.startClaudeStreamWithHold(res, processedRequest, request.model, startTime, matchedApiKey, signal, account)
      else await this.startClaudeNonStreamWithHold(res, processedRequest, request.model, startTime, matchedApiKey, signal, account)
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()

      // 注入 steering 到 Claude system
      if (this.steeringPrompt) {
        processedRequest.system = this.injectSteeringClaude(processedRequest.system) as string | undefined
      }

      const claudeThinkingConfig = this.getThinkingConfig(processedRequest.model)
      const kiroPayload = claudeToKiro(processedRequest, account.profileArn, toolNameRegistry, claudeThinkingConfig)

      // 构建 prompt cache profile（用于模拟缓存 usage）
      const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length * 0.3))
      const cacheProfile = promptCacheTracker.buildClaudeProfile(
        processedRequest.system,
        processedRequest.messages,
        processedRequest.tools,
        estimatedInputTokens,
        processedRequest.model
      )
      const cacheUsage = promptCacheTracker.compute(account.id, cacheProfile)

      if (cacheProfile) {
        proxyLogger.info('ProxyServer', `Prompt cache: ${cacheProfile.breakpoints.length} breakpoints, creation=${cacheUsage.cacheCreationInputTokens}, read=${cacheUsage.cacheReadInputTokens}`)
      }

      // 记录请求详情到日志
      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0
        
        proxyLogger.info('ProxyServer', `Claude API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id.substring(0, 8) + '...'
        })
      }

      if (request.stream) {
        // 流式响应（流式不使用重试机制，错误由流处理）
        await this.handleClaudeStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, 0, matchedApiKey, toolNameRegistry, signal,
          cacheProfile ? { ...cacheUsage, cacheProfile, accountId: account.id } : undefined)
      } else {
        // 非流式响应（带重试机制）
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = claudeToKiro(processedRequest, acc.profileArn, toolNameRegistry, claudeThinkingConfig)
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/messages',
          signal,
          request.model
        )
        const response = kiroToClaudeResponse(result.content, result.toolUses, result.usage, request.model, toolNameRegistry, result.reasoningContent)

        // 用缓存模拟的 usage 覆盖（如果有 cache profile）
        if (cacheProfile && cacheUsage) {
          if (cacheUsage.cacheCreationInputTokens > 0) response.usage.cache_creation_input_tokens = cacheUsage.cacheCreationInputTokens
          if (cacheUsage.cacheReadInputTokens > 0) response.usage.cache_read_input_tokens = cacheUsage.cacheReadInputTokens
          promptCacheTracker.update(usedAccount.id, cacheProfile)
        }

        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/messages', model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1/messages', request.model, startTime, signal)
    }
  }

  /**
   * 通用挂起编排(task#5 · 5 端点复用 · 消除 shotgun surgery)。
   * 主循环:seed/拿号 → attempt 一次转发 → 首字节前失败则切下一个未试号 → 无号则 enterHold 等换号 → resume 重跑。
   * 各端点通过回调注入差异(attempt 的转发/首字节前失败检测、sendPing 心跳、超时收尾格式),编排主体共用。
   * 绝对 deadline 从 startTime 起算,全程不重置(Invariant 3);超时收尾由 HoldGate 按 timeoutAction 驱动对应回调。
   * @returns attempt 返回 'done'(终态:成功 / 已吐正文失败 / abort)即结束;'pre_body_failed'(首字节前失败)可切号或挂起。
   */
  private async runWithHold(opts: {
    res: http.ServerResponse
    startTime: number
    signal: AbortSignal | undefined
    seedAccount: ProxyAccount | undefined
    /** 拿一个可用号(内部去重由 runWithHold 负责,回调只需返回池给的号或 null)。 */
    pickAccount: (triedIds: Set<string>) => Promise<ProxyAccount | null>
    /**
     * 用一个账号做一次完整转发。返回 'done' 或 'pre_body_failed'(可切号/挂起)。
     *
     * recordError:attempt 在决定返 'pre_body_failed' 前**必须调** —— 把 pre-body 错误
     * 上报给主循环,主循环用它做「挂起 vs 立即报错」精细化决策(RCA 2026-08-03)。
     * 遗漏调用不会崩,但会退化到"未知错误" fallback = 挂起(保守偏严侧)。
     */
    attempt: (acc: ProxyAccount, recordError: (err: Error) => void) => Promise<'done' | 'pre_body_failed'>
    /** 挂起态心跳(流式写 SSE ping / 注释行;非流式无通道则 no-op)。 */
    sendPing: () => void
    /** 超时收尾 - error(触及绝对 deadline 且 timeoutAction=error):按端点格式发失败信号。 */
    onTimeoutError: () => void
    /** 超时收尾 - graceful_stop:按端点格式发"干净结束"信号。 */
    onTimeoutGracefulStop: () => void
    /**
     * 不挂起放弃收尾(RCA 2026-08-02):所有号都试过、拿不到新号,但决策为 giveup
     * (永久请求级错 / 无 pre-body 错误)→ 不挂起,按端点格式原样报错。
     * 缺省时回落 onTimeoutError(两者语义都是"发失败信号",格式一致)。
     */
    onNoHoldGiveUp?: () => void
  }): Promise<void> {
    const { res, startTime, signal, seedAccount, pickAccount, attempt, sendPing, onTimeoutError, onTimeoutGracefulStop } = opts
    const onNoHoldGiveUp = opts.onNoHoldGiveUp ?? onTimeoutError
    // 本次请求已试过的账号(避免 resume/切号反复命中同一挂账号)。
    const triedIds = new Set<string>()
    // 最近一次 pre-body 错误(attempt 通过 recordError 上报),用于挂起决策(§decideHoldAction)。
    // 用 { current } ref 结构避开 TS「闭包外看不到写入 → 类型收窄成 never」的问题。
    const preBodyErrorRef: { current: Error | null } = { current: null }
    const recordError = (err: Error): void => {
      preBodyErrorRef.current = err
      if (holdDebugEnabled) console.log(`[HoldGate][DEBUG] attempt reported pre-body error: ${err.message?.slice(0, 200)}`)
    }

    const pickFresh = async (): Promise<ProxyAccount | null> => {
      const acc = await pickAccount(triedIds)
      if (acc && !triedIds.has(acc.id)) return acc
      return null
    }

    // 挂起等待:进入 HELD,直到 resume(手动/自动)/ 超时 / abort 认领。返回 true=被 resume(应重试),false=终态。
    // reason/detail 仅用于可观测性时间线(决策卡 hold-gate-observability),不参与任何控制流判断。
    const waitInHold = (reason: HoldReason, detail: string[]): Promise<boolean> => {
      return new Promise<boolean>((resolveHold) => {
        let holdId = 0
        const settleHold = (retry: boolean): void => { this.emitHeldRequestsChanged(); resolveHold(retry) }
        const hooks: HeldRequestHooks = {
          sendPing,
          resume: () => { proxyLogger.info('HoldGate', '挂起请求被放行 · 用新号重试'); settleHold(true) },
          sendError: () => { onTimeoutError(); this.recordRequestFailed(); settleHold(false) },
          sendGracefulStop: () => { onTimeoutGracefulStop(); this.recordRequestFailed(); settleHold(false) }
        }
        holdId = this.holdGate.enterHold({ receivedAt: startTime, hooks, reason, detail })
        this.emitHeldRequestsChanged()
        // 客户端中途断开 → abort 该挂起条目(停心跳、清 timer、认领作废),视为终态。
        const onAbort = (): void => { this.holdGate.abort(holdId); this.emitHeldRequestsChanged(); settleHold(false) }
        if (signal) {
          if (signal.aborted) { onAbort(); return }
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    }

    let acc: ProxyAccount | null = seedAccount ?? await pickFresh()
    for (;;) {
      if (this.isResponseClosed(res)) return
      if (!acc) {
        // 挂起决策(RCA 2026-08-03 hold-gate-fallback-cross-region · SSOT: decideHoldAction):
        //   - 有号被封禁/额度耗尽 → 挂起
        //   - 有 pre-body 错误但非永久请求级错(429/5xx/跨区/未知)→ 挂起等恢复
        //   - 有永久请求级错(400 malformed / 明确密钥吊销)→ 立即报错
        //   - 从未 attempt 过就无号可用 → 立即报错
        const held = this.classifyHold(preBodyErrorRef.current)
        const decision = held.action
        const poolBlocked = this.shouldHoldForNoAccount()
        const errKind = preBodyErrorRef.current
          ? (this.isAccountLevelAuthFailure(preBodyErrorRef.current) ? 'account-level-auth-failure' : 'non-account-level')
          : 'none'
        if (holdDebugEnabled) {
          console.log(`[HoldGate][DEBUG] hold decision=${decision} · reason=${held.reason} · triedIds=${triedIds.size} · poolBlocked=${poolBlocked} · lastErrorKind=${errKind} · lastErrorMsg=${preBodyErrorRef.current?.message?.slice(0, 150) ?? 'null'}`)
        }
        // 挂起是用户可感知的强干预(请求被冻结等换号)→ 无条件留痕到 proxyLogger(UI 可见)。
        // RCA 2026-08-04:此前 holdGate.ts 零日志 + 决策日志只在 HOLD_DEBUG=1 下走 console,
        // 用户报「账号明明正常却被闸门拦住」时后端查不到任何现场,只能翻源码反推。
        if (decision === 'hold') {
          const blockedList = this.accountPool.describeBlockedAccounts()
          // 文案由 held.reason 驱动(单一判定 → 单一说法),不再另算一遍。
          const why = held.reason === 'account-blocked' ? '池内有号被封禁/额度耗尽'
            : held.reason === 'account-auth-failure' ? '最近错误是账号级授权失效'
            : '池内无号可试(池空 / 池未同步)'
          proxyLogger.warn('HoldGate', `请求被挂起 · ${why}`, {
            holdReason: held.reason,
            triedAccounts: triedIds.size,
            poolBlocked,
            blockedAccounts: blockedList.length ? blockedList : ['(none)'],
            lastErrorKind: errKind,
            lastError: preBodyErrorRef.current?.message?.slice(0, 200) ?? null
          })
        }
        if (decision === 'giveup') {
          // RCA 2026-08-11:`selected-account-missing` 是**配置错误**,此前被当成账号问题挂起
          // → 用户看到「账号封禁或额度上限」却查不出问题,且永远等不到(不存在的 id 不会进池)。
          // 现在如实报出真因与下一步动作。
          const giveupWhy = held.clientMessage ?? (preBodyErrorRef.current
            ? 'non-account-level error (429/5xx/malformed/net)'
            : 'no attempt made')
          console.warn(`[ProxyServer] No account available · decision=giveup · reason=${held.reason} · detail=${giveupWhy.slice(0, 220)}`)
          if (held.reason === 'selected-account-missing' || held.reason === 'hold-disabled') {
            proxyLogger.warn('HoldGate', `请求未挂起 · ${held.reason === 'selected-account-missing' ? '界面选中账号不在反代池(配置问题)' : '挂起门闸已关闭'}`, {
              holdReason: held.reason,
              poolSize: this.accountPool.size,
              selectedAccountIds: this.config.selectedAccountIds ?? [],
              detail: giveupWhy
            })
          }
          onNoHoldGiveUp()
          this.recordRequestFailed()
          return
        }
        // 时间线观测(决策卡 hold-gate-observability):直接用 held.reason,不再第二次分类。
        const holdReason: HoldReason = held.reason === 'account-blocked'
          ? 'account-blocked'
          : held.reason === 'account-auth-failure'
            ? 'account-auth-failure'
            : 'pool-empty'
        const holdDetail = decision === 'hold' ? this.accountPool.describeBlockedAccounts() : []
        const shouldRetry = await waitInHold(holdReason, holdDetail)
        if (!shouldRetry) return // 超时/abort 终态
        acc = await pickFresh()
        if (!acc) { triedIds.clear(); acc = await pickFresh() } // resume 后仍未拿到(去抖竞争),清 tried 再试一次
        if (!acc) {
          // 本轮放行后仍无号 → 即将重新挂起。这是「乙世界」:客户端本轮拿不到任何语义正文字节,
          // 其 idle watchdog 计时**未被重置**。记下它,界面上才能区分「放行有效」与「放行空转」。
          this.holdGate.settleLastRelease('re-held')
        }
        continue
      }
      triedIds.add(acc.id)
      if (holdDebugEnabled) console.log(`[HoldGate][DEBUG] attempt start · account=${acc.email || acc.id} · triedCount=${triedIds.size}`)
      const outcome = await attempt(acc, recordError)
      if (outcome === 'done') {
        // 拿到号并跑完一次完整转发 → 客户端真的收到了语义正文(甲世界)。
        // 若本次是被放行唤醒后才跑成的,这一笔就是「放行真的续上了命」的直接证据。
        // 无 pending 放行记录时该调用是 no-op(从未挂起过的正常请求)。
        this.holdGate.settleLastRelease('resumed-and-served')
        return // 终态(成功 / 已吐正文失败 / abort)
      }
      // 首字节前失败:先即时切下一个未试过的号,拿不到再挂起。
      if (holdDebugEnabled) console.log(`[HoldGate][DEBUG] attempt returned pre_body_failed · trying next account`)
      acc = await pickFresh()
    }
  }

  /**
   * 判断一个上游错误是否「值得换号重试」(账号级错误 —— 换个号可能就好)。
   * 命中 = 401/403/Auth / 402/429/quota/throttle/limit / 5xx / suspended → 返回 true(可切下一个号);
   * 未命中(如 400 malformed、校验失败)= 请求本身有问题,换号无用,应原样报错 → false。
   * 判据与 callWithRetry 的切号分支保持一致(SSOT:同一套「何时切号」的语义)。
   *
   * ⚠️ 本判据**只管换号**,不再单独决定是否挂起 —— 挂起走 {@link shouldHoldForNoAccount}
   * (RCA 2026-08-02 hold-gate-false-positive:两个语义混用导致瞬时 429/5xx 也被挂起 10-20 分钟)。
   */
  private isSwitchWorthyError(errMsg: string): boolean {
    if (!errMsg) return false
    if (this.detectSuspendedError(errMsg)) return true
    // 大小写不敏感匹配(RCA 2026-08-03):kiroApi 429 撞爆抛的错是 "Rate limited on ..."(R 大写),
    // 之前用 String.includes 区分大小写 → 不命中 → 走原样报错 → 用户看到 AI SUB 莫名中断。
    const lower = errMsg.toLowerCase()
    return (
      lower.includes('401') || lower.includes('403') || lower.includes('auth error') ||
      lower.includes('402') || lower.includes('429') || lower.includes('quota') ||
      lower.includes('throttlingexception') || lower.includes('reached the limit') ||
      lower.includes('servicequotaexceededexception') || lower.includes('limit exceeded') ||
      lower.includes('rate limit') || lower.includes('rate limited') ||   // 429 撞爆兜底
      lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504')
    )
  }

  /**
   * 「所有号都试过了、拿不到新号」时,是否应该**挂起等换号**(而不是原样报错)。
   *
   * 判据是**池的权威状态**,不是错误字符串:池里确有账号被封禁 / 额度耗尽
   * (accountPool.hasBlockedAccount)→ 挂起等人工换号或配额恢复才有意义。
   *
   * 反之,若池里所有号只是**瞬时错误退避冷却中**(429 限流 / 上游 5xx 触发 errorCount),
   * 挂起 10-20 分钟毫无意义 → 返回 false,原样报错让客户端自己重试。
   *
   * 这条门槛是 RCA 2026-08-02 hold-gate-false-positive 的核心修复:
   * 此前挂起判据混用了「换号判据」,任何 pre-body 错误(甚至 400 Improperly formed request)
   * 在单账号模式下都会把请求挂死到客户端 API_TIMEOUT_MS(默认 600s)超时。
   */
  private shouldHoldForNoAccount(): boolean {
    return this.accountPool.hasBlockedAccount()
  }

  /**
   * 上游 pre-body 错误是否属于**账号级授权失效**(该号真的不能用了,换号才是解 · 挂起等换号)。
   *
   * 命中 = 明确的账号级授权失败,不是瞬时错误也不是请求本身错:
   *   - InvalidTokenException(明确密钥无效)
   *   - UnauthorizedException(明确未授权)
   *   - 401 + revoked/expired/invalid credentials 明确标识
   *
   * **不命中(默认)= 非账号级不可用** → 立即报错让客户端处理:
   *   - 429(限流)· 5xx(上游抖动)· 网络错误 · 400 malformed · 未知错误
   *
   * RCA 2026-08-03 hold-gate-fallback-cross-region · 用户澄清:
   *   「429 只需要重试就行了,不需要挂起。只有账号封禁/额度上限/账号未授权
   *    这种账号级不可用才挂起。」
   *   —— 挂起门闸的原始设计意图,不该被"临时错误"污染。
   */
  private isAccountLevelAuthFailure(err: Error | null): boolean {
    if (!err) return false
    const msg = err.message || ''
    // 明确的账号级授权失败异常类型
    if (/InvalidTokenException|UnauthorizedException/i.test(msg)) return true
    // 401 + 明确密钥失效标识(不匹配裸 401 · 可能是别的短暂问题)
    if (/\b401\b/.test(msg) && /revoked|expired|invalid credentials|Bad credentials/i.test(msg)) return true
    return false
  }

  /**
   * 挂起决策 SSOT(RCA 2026-08-03 · 用户澄清后的最终契约):
   *
   *   ┌────────────────────────────────────────────┬──────────┐
   *   │ 池状态 / 最近错误                          │ 决策     │
   *   ├────────────────────────────────────────────┼──────────┤
   *   │ 有号被封禁/额度耗尽(hasBlockedAccount)   │ 挂起     │
   *   │ 最近错误是账号级授权失败(InvalidToken 等) │ 挂起     │
   *   │ 无 pre-body 错误(pool 空/seed 找不到)    │ 挂起     │
   *   │ 429 / 5xx / 400 malformed / 网络错 / 其他  │ 立即报错 │
   *   └────────────────────────────────────────────┴──────────┘
   *
   * 用户核心场景 = 挂起门闸只在**账号级真不可用**时触发:
   *   - 账号封禁(TEMPORARILY_SUSPENDED)
   *   - 额度上限(quotaExhausted)
   *   - 账号未授权(密钥真无效 / 已吊销)
   *   - **根本没号可用**(pool 空 / UI 指定的账号不在池里 / 池未同步)—— 这些都是账号问题
   * 其他一切 —— 包括 429 撞爆 —— 都按"临时错误"报给客户端(有 attempt 错误但非账号级)。
   *
   * 2026-08-03 补:无 pre-body 错误 = 根本没进入 attempt 循环 = 池里没号能试。
   * 门闸开关的用户直觉就是"没号就挂等换号",不该因为"没 attempt 过" fallback 到 giveup。
   *
   * 2026-08-11 起判据收口到 `proxy/holdDecision.ts`(SSOT · 可单测)。本方法只做
   * 「取运行时状态 → 委托纯函数」,不再自己写判据 —— 此前决策与 holdReason 分两处各算一遍,
   * 导致「决策挂起、原因说成账号封禁、真因其实是 UI 指定号不在池」的三方不一致。
   *
   * 三处修正见 holdDecision.ts 头部:① 指定号在账号总表里都不存在 = 配置错误(挂起是永久死等)
   * → 立即报错;② 新增 selected-account-missing 原因,界面说真话;③ holdWhenNoAccount 关闭时不挂。
   *
   * 2026-08-12 回归修复:① 的判据必须是「总表不存在」而非「不在可用池」——
   * 被封/超额的号也不在可用池,那是账号问题,挂起等恢复才对(详见 holdDecision.ts
   * selectedAccountExists 字段注释)。
   */
  private classifyHold(lastPreBodyError: Error | null): NoAccountHoldDecision {
    const selectedIds = this.config.selectedAccountIds ?? []
    const selectedId = selectedIds[0]
    return classifyNoAccountHold({
      holdEnabled: this.config.holdWhenNoAccount === true,
      poolSize: this.accountPool.size,
      selectedAccountIds: selectedIds,
      // 单账号模式才存在「指定号」概念;多账号轮询下 selectedAccountIds 不作为唯一来源,
      // 故仅在非多账号模式下才把「不存在」判为配置错误,避免误伤轮询模式。
      //
      // ⚠️ getAccount() 查的是**账号总表**(this.accounts),被封/超额的号仍在其中(只是被标记),
      // 所以它恰好就是「id 是否真的存在」的判据 —— 而不是「当前是否可用」。
      // RCA 2026-08-12:上一版把这个值当成 selectedAccountInPool 用,导致被封账号被误判为
      // 配置错误 → 立即 giveup,挂起功能从 2 小时退化成 20 分钟内彻底失败。
      selectedAccountExists: this.config.enableMultiAccount
        ? true
        : (selectedId ? !!this.accountPool.getAccount(selectedId) : true),
      // 可用池视角(仅供日志归因,不参与判定)。accountPool 没有 per-id 可用性查询接口,
      // 这里用「在总表里 且 池中至少有一个可用号」近似 —— 不为一个纯日志字段新增公开方法
      // (那会扩大池的对外契约)。判定权在 selectedAccountExists,不受本近似影响。
      selectedAccountInPool: selectedId
        ? this.accountPool.getAllAccounts().some(a => a.id === selectedId)
          && this.accountPool.availableCount > 0
        : true,
      poolHasBlockedAccount: this.shouldHoldForNoAccount(),
      lastPreBodyError
    })
  }

  /**
   * 非流式(JSON)请求的通用挂起编排(task#5 · 3 个 JSON 端点复用:Claude 非流式 / OpenAI chat 非流式 / responses 非流式)。
   * 复用 runWithHold 核心,attempt 内跑 callWithRetry(保留其端点切换/token 刷新/suspended 检测能力):
   *   - callWithRetry 成功 → writeSuccess 写响应 → 'done';
   *   - 抛账号级可恢复错误(isSwitchWorthyError)→ 'pre_body_failed'(runWithHold 切号,无号且确有封禁/额度耗尽才挂起);
   *   - 抛请求本身错误(400 等)→ handleApiError 原样报错 → 'done'(换号无用,不挂起)。
   * 非流式无 SSE 心跳通道:挂起期间靠 HTTP keep-alive 硬等,受 holdTotalBudgetMs 约束(方案"实现约束");
   * 若客户端 HTTP 层超时早于此,连接断开触发 abort → 退化为原有报错(不比现状差)。
   * @param doCall 用给定账号做一次带重试的上游调用(内部 callWithRetry);seedAccount 作为首个尝试号。
   */
  private async runJsonRequestWithHold<T>(opts: {
    res: http.ServerResponse
    startTime: number
    signal: AbortSignal | undefined
    seedAccount: ProxyAccount | undefined
    path: string
    model: string
    pickAccount: (triedIds: Set<string>) => Promise<ProxyAccount | null>
    doCall: (acc: ProxyAccount) => Promise<{ result: T; account: ProxyAccount }>
    writeSuccess: (result: T, usedAccount: ProxyAccount) => void
    /** 超时收尾 - error:按端点格式发失败响应(headers 尚未发,可直接 writeHead+end)。 */
    onTimeoutError: () => void
    /** 超时收尾 - graceful_stop:按端点格式发"干净结束"响应。 */
    onTimeoutGracefulStop: () => void
  }): Promise<void> {
    const attempt = async (acc: ProxyAccount, recordError: (err: Error) => void): Promise<'done' | 'pre_body_failed'> => {
      try {
        const { result, account: usedAccount } = await opts.doCall(acc)
        if (this.isResponseClosed(opts.res)) return 'done'
        opts.writeSuccess(result, usedAccount)
        return 'done'
      } catch (error) {
        if (this.isAbortError(error, opts.signal) || this.isResponseClosed(opts.res)) return 'done'
        const errMsg = (error as Error).message || String(error)
        // 账号级可恢复错误(callWithRetry 已把失败号记账/切号耗尽)→ 交给 runWithHold 切号或挂起。
        if (this.isSwitchWorthyError(errMsg)) { recordError(error as Error); return 'pre_body_failed' }
        // 请求本身错误(换号无用)→ 原样报错,不挂起。
        this.handleApiError(opts.res, acc, error as Error, opts.path, opts.model, opts.startTime, opts.signal)
        return 'done'
      }
    }
    await this.runWithHold({
      res: opts.res,
      startTime: opts.startTime,
      signal: opts.signal,
      seedAccount: opts.seedAccount,
      pickAccount: opts.pickAccount,
      attempt,
      sendPing: () => { /* 非流式无 SSE 心跳通道:靠 HTTP keep-alive 硬等(方案实现约束) */ },
      onTimeoutError: opts.onTimeoutError,
      onTimeoutGracefulStop: opts.onTimeoutGracefulStop
    })
  }

  /**
   * Hold Gate 流式转发编排(task#3 收口 · ADR-0001;task#5 重构为复用 runWithHold)。
   * 封装"拿号 → 构造 payload → handleClaudeStream"一次尝试,并在两个失败汇合点接挂起门闸:
   *   ① 无可用号(首次或切号后)→ enterHold 等待换号(手动放行 / 池自动检测),resume 重跑;
   *   ② 首字节前上游失败(未吐正文)→ 先即时切下一个号重试,无号可切 → enterHold。
   * 一旦吐了语义正文(message_start 之后),失败只能走 SSE error 收尾(协议硬限制,由 handleClaudeStream 处理)。
   * 绝对 deadline 从 receivedAt(=startTime)起算,全程不重置(Invariant 3);超时收尾由 HoldGate 按 timeoutAction 处理。
   * @param seedAccount 汇合点 B 首次已拿到的号(汇合点 A 无号时为 undefined)。
   */
  private async startClaudeStreamWithHold(
    res: http.ServerResponse,
    processedRequest: ClaudeRequest,
    model: string,
    startTime: number,
    matchedApiKey: import('./types').ApiKey | undefined,
    signal?: AbortSignal,
    seedAccount?: ProxyAccount
  ): Promise<void> {
    // 先建立 SSE 连接(发响应头),使挂起态能写 ping 心跳;此时尚未发 message_start(延迟到首字节)。
    if (!this.isResponseClosed(res)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    }

    // 注入 steering(与非挂起路径一致);每次重试用当前 account 的 profileArn 重新构造 payload。
    if (this.steeringPrompt) {
      processedRequest.system = this.injectSteeringClaude(processedRequest.system) as string | undefined
    }
    const claudeThinkingConfig = this.getThinkingConfig(processedRequest.model)
    const affinityHint = processedRequest.conversation_id

    // 用一个账号做一次完整流式转发。返回 'done'(终态:成功/已吐正文的失败/abort)
    // 或 'pre_body_failed'(首字节前失败,可切号或挂起)。
    const attempt = (acc: ProxyAccount, recordError: (err: Error) => void): Promise<'done' | 'pre_body_failed'> => {
      return new Promise<'done' | 'pre_body_failed'>((resolveAttempt) => {
        const toolNameRegistry = new ToolNameRegistry()
        const kiroPayload = claudeToKiro(processedRequest, acc.profileArn, toolNameRegistry, claudeThinkingConfig)
        const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length * 0.3))
        const cacheProfile = promptCacheTracker.buildClaudeProfile(
          processedRequest.system, processedRequest.messages, processedRequest.tools, estimatedInputTokens, processedRequest.model
        )
        const cacheUsage = promptCacheTracker.compute(acc.id, cacheProfile)
        this.events.onRequest?.({ path: '/v1/messages', method: 'POST', accountId: acc.id })
        let settled = false
        const onPreBodyError = (error: Error): boolean => {
          // 首字节前失败:标记为可切号/挂起,接管(不发 SSE error)。
          if (!settled) { settled = true; recordError(error); resolveAttempt('pre_body_failed') }
          return true
        }
        // headersSent=true:响应头已发;currentRound=0:message_start 由 handleClaudeStream 惰性延迟到首字节。
        this.handleClaudeStream(
          res, acc, kiroPayload, model, startTime, 0, undefined, true, 0, matchedApiKey, toolNameRegistry, signal,
          cacheProfile ? { ...cacheUsage, cacheProfile, accountId: acc.id } : undefined,
          onPreBodyError
        ).then(() => {
          // handleClaudeStream 走完(成功收尾 / 已吐正文的 error / abort)。若不是被 onPreBodyError 接管的,即终态。
          if (!settled) { settled = true; resolveAttempt('done') }
        }).catch(() => {
          if (!settled) { settled = true; resolveAttempt('done') }
        })
      })
    }

    await this.runWithHold({
      res, startTime, signal, seedAccount,
      pickAccount: (_tried) => this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id, model),
      attempt,
      // SSE ping 心跳:挂起态保活客户端 watchdog(ADR-0001 边界 1)。
      sendPing: () => { if (!this.isResponseClosed(res)) res.write('event: ping\ndata: {"type":"ping"}\n\n') },
      // 超时收尾 - error:发 SSE error 事件(overloaded_error/HOLD_TIMEOUT),客户端识别为可重试失败。
      onTimeoutError: () => {
        if (this.isResponseClosed(res)) return
        const errorEvent = createClaudeStreamEvent('error', { error: { type: 'overloaded_error', message: 'Hold timeout: no account became available in time (HOLD_TIMEOUT)' } })
        res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
        res.end()
      },
      // 超时收尾 - graceful_stop:发提示文本 + 完整 message_stop 干净收尾。
      onTimeoutGracefulStop: () => {
        if (this.isResponseClosed(res)) return
        const msgStart = createClaudeStreamEvent('message_start', { message: { id: `msg_${uuidv4()}`, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`)
        const blockStart = createClaudeStreamEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
        const delta = createClaudeStreamEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '[请求等待可用账号超时,请重新发送]' } })
        res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
        res.write(`event: content_block_stop\ndata: ${JSON.stringify(createClaudeStreamEvent('content_block_stop', { index: 0 }))}\n\n`)
        res.write(`event: message_delta\ndata: ${JSON.stringify(createClaudeStreamEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null } as any, usage: { output_tokens: 0 } }))}\n\n`)
        res.write(`event: message_stop\ndata: ${JSON.stringify(createClaudeStreamEvent('message_stop'))}\n\n`)
        res.end()
      }
    })
  }

  /**
   * Hold Gate 非流式(JSON)转发编排(task#5 · Claude /v1/messages 非流式)。
   * 复用 runJsonRequestWithHold:每个 attempt 用当前账号构造 payload → callWithRetry → 成功写 JSON 响应。
   * 无 SSE 心跳,挂起靠 HTTP keep-alive 硬等(受 holdTotalBudgetMs 约束)。
   */
  private async startClaudeNonStreamWithHold(
    res: http.ServerResponse,
    processedRequest: ClaudeRequest,
    model: string,
    startTime: number,
    matchedApiKey: import('./types').ApiKey | undefined,
    signal?: AbortSignal,
    seedAccount?: ProxyAccount
  ): Promise<void> {
    if (this.steeringPrompt) {
      processedRequest.system = this.injectSteeringClaude(processedRequest.system) as string | undefined
    }
    const claudeThinkingConfig = this.getThinkingConfig(processedRequest.model)
    const affinityHint = processedRequest.conversation_id

    await this.runJsonRequestWithHold<{
      result: Awaited<ReturnType<typeof callKiroApi>>
      cacheProfile: ReturnType<typeof promptCacheTracker.buildClaudeProfile>
      cacheUsage: ReturnType<typeof promptCacheTracker.compute>
    }>({
      res, startTime, signal, seedAccount, path: '/v1/messages', model,
      pickAccount: (_tried) => this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id, model),
      doCall: async (acc) => {
        const toolNameRegistry = new ToolNameRegistry()
        const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(claudeToKiro(processedRequest, acc.profileArn, toolNameRegistry, claudeThinkingConfig)).length * 0.3))
        const cacheProfile = promptCacheTracker.buildClaudeProfile(processedRequest.system, processedRequest.messages, processedRequest.tools, estimatedInputTokens, processedRequest.model)
        const cacheUsage = promptCacheTracker.compute(acc.id, cacheProfile)
        this.events.onRequest?.({ path: '/v1/messages', method: 'POST', accountId: acc.id })
        const { result, account: usedAccount } = await this.callWithRetry(
          acc,
          async (a) => callKiroApi(a, claudeToKiro(processedRequest, a.profileArn, toolNameRegistry, claudeThinkingConfig), signal),
          '/v1/messages', signal, model
        )
        return { result: { result, cacheProfile, cacheUsage, toolNameRegistry } as any, account: usedAccount }
      },
      writeSuccess: (wrapped: any, usedAccount) => {
        const { result, cacheProfile, cacheUsage, toolNameRegistry } = wrapped
        const response = kiroToClaudeResponse(result.content, result.toolUses, result.usage, model, toolNameRegistry, result.reasoningContent)
        if (cacheProfile && cacheUsage) {
          if (cacheUsage.cacheCreationInputTokens > 0) response.usage.cache_creation_input_tokens = cacheUsage.cacheCreationInputTokens
          if (cacheUsage.cacheReadInputTokens > 0) response.usage.cache_read_input_tokens = cacheUsage.cacheReadInputTokens
          promptCacheTracker.update(usedAccount.id, cacheProfile)
        }
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/messages', model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/messages', model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
        if (matchedApiKey) this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, model, '/v1/messages')
      },
      onTimeoutError: () => { if (!this.isResponseClosed(res)) this.sendError(res, 503, 'Hold timeout: no account became available in time (HOLD_TIMEOUT)', 'anthropic') },
      onTimeoutGracefulStop: () => { if (!this.isResponseClosed(res)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: `msg_${uuidv4()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: '[请求等待可用账号超时,请重新发送]' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } })) } }
    })
  }

  // 处理 Claude 流式响应
  private async handleClaudeStream(
    res: http.ServerResponse,
    account: { id: string; accessToken: string; profileArn?: string },
    kiroPayload: ReturnType<typeof claudeToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    msgId?: string,
    headersSent: boolean = false,
    contentBlockIndex: number = 0,
    matchedApiKey?: import('./types').ApiKey,
    toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
    signal?: AbortSignal,
    simulatedCacheUsage?: { cacheCreationInputTokens: number; cacheReadInputTokens: number; cacheProfile?: unknown; accountId?: string },
    // Hold Gate 接线(task#3,ADR-0001 边界 2):首字节前上游失败时回调。
    // 返回 true = 已被挂起门闸接管(不发 SSE error,交给 resume 重试);false = 未接管,按现状发 error。
    // 仅在"尚未发出 message_start(未写入任何语义正文)"时才可能被调用 —— 一旦吐了正文,重放会重复输出。
    onPreBodyError?: (error: Error) => boolean
  ): Promise<void> {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
    }

    const id = msgId || `msg_${uuidv4()}`
    let currentBlockIndex = contentBlockIndex
    let hasStartedTextBlock = false
    let hasStartedThinkingBlock = false
    let pendingThinkingSignature: string | undefined
    let collectedContent = ''
    const pendingToolCalls: Map<string, { name: string; input: Record<string, unknown> }> = new Map()

    // ADR-0001 边界 1(SSE bootstrap 时序):message_start 从"进入函数即发"延迟到"首个语义正文写出前"。
    // 挂起态(resume 前)从不进入本函数,故永不发 message_start;拿到号真正转发时,首个 delta/tool 前
    // 惰性发一次。这样"未吐正文前失败"可无缝切号重放,不背"已提交正文"包袱(Invariant 1)。
    // currentRound>0(多轮工具续接)时 message_start 已在首轮发过,这里视为已发。
    let messageStartSent = currentRound !== 0
    // TTFT(首 token 延迟)观测:首个语义正文写给客户端的时刻 - 请求进入时刻。
    // RCA 2026-08-11 §3:此前全仓零 TTFT 打点,只有端到端 responseTime,
    // 导致「首响慢」无法归因到「上游/排队慢」还是「流式输出慢」。
    // 多轮工具续接(currentRound>0)时首轮已发过 message_start,不重复计。
    let ttftMs: number | undefined
    const emitMessageStartOnce = () => {
      if (messageStartSent) return
      messageStartSent = true
      if (ttftMs === undefined) ttftMs = Date.now() - startTime
      const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length / 3))
      const messageStart = createClaudeStreamEvent('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 }
        }
      })
      res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`)
    }

    const flushThinkingSignature = () => {
      if (!pendingThinkingSignature) return
      const signatureDelta = createClaudeStreamEvent('content_block_delta', {
        index: currentBlockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSignature }
      })
      res.write(`event: content_block_delta\ndata: ${JSON.stringify(signatureDelta)}\n\n`)
      pendingThinkingSignature = undefined
    }

    return new Promise((resolve) => {
      // 纯观测计数器:统计本次请求内部的上游尝试 / 429 / 无效上传字节。
      const attemptCounter = createUpstreamAttemptCounter()
      callKiroApiStream(
        account as any,
        kiroPayload,
        (text, toolUse, isThinking, reasoningSignature, redactedContent) => {
          if (signal?.aborted || this.isResponseClosed(res)) return
          // ADR-0001 边界 1:首个语义正文写出前,惰性补发 message_start(恰好一次)。
          // 此后 onPreBodyError 不再接管(messageStartSent=true → 已吐正文,重放会重复)。
          emitMessageStartOnce()
          // 优先处理 redacted_thinking（加密的 thinking 块，需单独 content_block）
          if (redactedContent) {
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            if (hasStartedThinkingBlock) {
              flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }
            const blockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: { type: 'redacted_thinking', data: redactedContent }
            })
            res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
            return this.waitForDrain(res)
          }
          if (text && text.trim()) {
            if (isThinking) {
              // 原生 thinking 内容 → 输出为 Anthropic thinking block
              if (hasStartedTextBlock) {
                const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
                res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
                currentBlockIndex++
                hasStartedTextBlock = false
              }
              if (!hasStartedThinkingBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'thinking', thinking: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedThinkingBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'thinking_delta', thinking: text }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              if (reasoningSignature) {
                pendingThinkingSignature = reasoningSignature
              }
            } else {
              // 普通文本内容
              if (hasStartedThinkingBlock) {
                flushThinkingSignature()
                const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
                res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
                currentBlockIndex++
                hasStartedThinkingBlock = false
              }
              collectedContent += text
              if (!hasStartedTextBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
            }
          } else if (isThinking && reasoningSignature) {
            if (!hasStartedThinkingBlock) {
              const blockStart = createClaudeStreamEvent('content_block_start', {
                index: currentBlockIndex,
                content_block: { type: 'thinking', thinking: '' }
              })
              res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
              hasStartedThinkingBlock = true
            }
            pendingThinkingSignature = reasoningSignature
          }
          if (toolUse) {
            const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
            if (hasStartedThinkingBlock) {
              flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }
            // 结束之前的文本块
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            // 记录工具调用
            pendingToolCalls.set(toolUse.toolUseId, { name: toolUse.name, input: toolUse.input })
            // 开始工具块
            const toolBlockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: { type: 'tool_use', id: toolUse.toolUseId, name: restoredToolUse.name, input: {} }
            })
            res.write(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`)
            // 发送工具输入
            const toolDelta = createClaudeStreamEvent('content_block_delta', {
              index: currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } as any
            })
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`)
            // 结束工具块
            const toolBlockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`)
            currentBlockIndex++
          }
          return this.waitForDrain(res)
        },
        async (usage) => {
          if (signal?.aborted || this.isResponseClosed(res)) {
            resolve()
            return
          }
          // 空响应(上游未吐任何 chunk 即完成)也需补发 message_start,保证 SSE 协议完整。
          emitMessageStartOnce()
          if (hasStartedThinkingBlock) {
            flushThinkingSignature()
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
            hasStartedThinkingBlock = false
          }

          // 结束最后的文本块
          if (hasStartedTextBlock) {
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
          }

          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
          this.stats.cacheReadTokens += usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens || 0
          this.stats.cacheWriteTokens += usage.cacheWriteTokens || simulatedCacheUsage?.cacheCreationInputTokens || 0
          this.stats.reasoningTokens += usage.reasoningTokens || 0
          const respTime = Date.now() - startTime
          this.events.onResponse?.({ path: '/v1/messages', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens, reasoningTokens: usage.reasoningTokens, credits: usage.credits, responseTime: respTime, ttft: ttftMs, upstream429: attemptCounter.rateLimited, upstreamAttempts: attemptCounter.attempts, accountId: account.id })
          // [Perf429] 单请求诊断行:把「一次客户端请求内部发生了什么」落成一条可 grep 的记录。
          // 逐条 [Perf] 行只有单次尝试视角,拼不回请求级链路(实测事后拼链会误判)。
          if (attemptCounter.rateLimited > 0 || attemptCounter.attempts > 1) {
            const msg = `attempts=${attemptCounter.attempts} 429=${attemptCounter.rateLimited} wastedUpload=${(attemptCounter.wastedUploadBytes / 1e6).toFixed(2)}MB ttft=${ttftMs ?? -1}ms total=${respTime}ms in=${usage.inputTokens} acc=${account.id?.slice(0, 8) || '?'} model=${model}`
            console.log(`[Perf429] ${msg}`)
            proxyLogger.info('Perf429', msg, {
              attempts: attemptCounter.attempts,
              rateLimited: attemptCounter.rateLimited,
              wastedUploadBytes: attemptCounter.wastedUploadBytes,
              ttftMs: ttftMs ?? null,
              totalMs: respTime,
              inputTokens: usage.inputTokens,
              accountId: account.id,
              model
            })
          }
          // request 级诊断落盘:**每个请求都记**(不只是撞过 429 的),
          // 因为「正常请求的 TTFT 基线」正是判断慢不慢的对照组。
          if (perfDiag.isEnabled()) {
            perfDiag.write({
              kind: 'request',
              ts: new Date().toISOString(),
              path: '/v1/messages',
              model,
              status: 200,
              ttftMs: ttftMs ?? null,
              totalMs: respTime,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens,
              attempts: attemptCounter.attempts,
              rateLimited: attemptCounter.rateLimited,
              wastedUploadBytes: attemptCounter.wastedUploadBytes,
              account: account.id?.slice(0, 8)
            })
          }
          this.recordRequest({ path: '/v1/messages', model, accountId: account.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: respTime, success: true })
          // 记录 API Key 用量
          if (matchedApiKey) {
            this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/messages')
          }

          // 成功后更新 prompt cache tracker
          if (simulatedCacheUsage?.cacheProfile && simulatedCacheUsage?.accountId) {
            promptCacheTracker.update(simulatedCacheUsage.accountId, simulatedCacheUsage.cacheProfile as any)
          }
          // 上游异常终止(CONTENT_FILTERED 等)→ 发 SSE error 让客户端明确失败,不伪装成 end_turn。
          // 2026-08-01 RCA:此前一律按 hasToolCalls 本地推断 stop_reason,被内容过滤掐断的半截响应
          // 也被翻译成 end_turn("模型自然说完")→ 客户端不报错不重试,静默停止 = 用户看到的"跑一半自己断"。
          // 注意:此时正文已经吐了一部分(content_block 已 stop),这里补一个 error 事件让客户端知道
          // 这轮不完整 —— 比静默假装完成诚实。
          if (usage.terminal?.shouldFail) {
            const reason = usage.terminal.upstreamStopReason || usage.terminal.disposition
            const humanMsg = usage.terminal.disposition === 'filtered'
              ? `上游内容过滤器截断了本次响应 (stopReason: ${reason})。这一轮输出不完整,请重试或调整措辞。`
              : `上游异常终止,响应不完整 (stopReason: ${reason})。请重试。`
            proxyLogger.warn('ProxyServer', `Claude stream: upstream abnormal terminal → SSE error`, {
              path: '/v1/messages', model, disposition: usage.terminal.disposition,
              upstreamStopReason: usage.terminal.upstreamStopReason,
              account: (account as { email?: string }).email || account.id?.slice(0, 8) || '?'
            })
            const errEvent = createClaudeStreamEvent('error', {
              error: { type: 'api_error', message: humanMsg }
            })
            res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`)
            res.end()
            this.events.onResponse?.({ path: '/v1/messages', model, status: 502, error: `upstream_${usage.terminal.disposition}: ${reason}` })
            resolve()
            return
          }
          // 发送 message_delta（包含完整 usage 信息）
          const hasToolCalls = pendingToolCalls.size > 0

          // ===== GPT 半途收工:观测 + 无害介入(RCA 2026-08-12)=====
          // 生产日志模型对照:gpt-5.6-sol 的 35 次流 100% 以 END_TURN 结束、TOOL_USE 为 0,
          // 而 opus-4.7 是 163:17。且 GPT 那批全是 clean_eof + residual=0 ⇒ 上游流正常结束,
          // 不是限流/掐断 —— GPT 把「我还要继续」表达成了普通 END_TURN,客户端据此收工。
          // 判据与措辞见 gptHalt.ts;只在 GPT + END_TURN + 无工具 + 尾部话没说完时命中。
          const haltTail = sampleTailShape(collectedContent)
          const haltVerdict = detectGptHalt({
            model,
            upstreamStopReason: usage.terminal?.upstreamStopReason,
            toolCallCount: pendingToolCalls.size,
            outputChars: collectedContent.length,
            tailEndsSentence: haltTail.endsSentence,
            tailClass: haltTail.tailClass
          })
          if (haltVerdict.suspected) {
            const haltMsg = `[GPT-HALT] 疑似半途收工 · model=${model}`
              + ` stopReason=${usage.terminal?.upstreamStopReason ?? 'ABSENT'}`
              + ` outChars=${collectedContent.length} tailClass=${haltTail.tailClass}`
              + ` tools=${pendingToolCalls.size} → 已注入继续/汇报提示`
            proxyLogger.warn('ProxyServer', haltMsg, {
              path: '/v1/messages', model,
              upstreamStopReason: usage.terminal?.upstreamStopReason ?? null,
              outputChars: collectedContent.length,
              tailClass: haltTail.tailClass,
              account: (account as { email?: string }).email || account.id?.slice(0, 8) || '?'
            })
            if (perfDiag.isEnabled()) {
              perfDiag.write({
                kind: 'gpt-halt',
                ts: new Date().toISOString(),
                model,
                upstreamStopReason: usage.terminal?.upstreamStopReason ?? null,
                outputChars: collectedContent.length,
                tailClass: haltTail.tailClass,
                toolCallCount: pendingToolCalls.size,
                injected: true
              })
            }
            // 介入:把提示作为正文追加到当前文本块。
            // 为什么不改 stop_reason:本项目 clientDrivenToolExecution=true,工具由客户端执行,
            // 服务端没有多轮循环 —— 改成 tool_use 会让客户端去找不存在的工具调用(协议撕裂)。
            // 追加正文则是协议内的合法输出,模型下一轮能看到它并自行决定继续还是汇报。
            if (!this.isResponseClosed(res)) {
              if (!hasStartedTextBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const nudge = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text: GPT_HALT_NUDGE }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(nudge)}\n\n`)
            }
          } else if (isGptModel(model) && perfDiag.isEnabled()) {
            // A(观测):GPT 未命中也落盘,用于事后核对判据是否过紧 —— 只有分母才能算命中率。
            perfDiag.write({
              kind: 'gpt-halt',
              ts: new Date().toISOString(),
              model,
              upstreamStopReason: usage.terminal?.upstreamStopReason ?? null,
              outputChars: collectedContent.length,
              tailClass: haltTail.tailClass,
              toolCallCount: pendingToolCalls.size,
              injected: false,
              passedBy: haltVerdict.passedBy
            })
          }

          // 上游真实 stopReason 优先(length = 命中输出上限,需如实告知客户端);无则回退本地推断
          const stopReason = usage.terminal?.disposition === 'length'
            ? 'max_tokens'
            : hasToolCalls ? 'tool_use' : 'end_turn'
          const messageDelta = createClaudeStreamEvent('message_delta', {
            delta: { stop_reason: stopReason, stop_sequence: null } as any,
            usage: this.buildClaudeUsage(usage, simulatedCacheUsage)
          })
          res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
          // 发送 message_stop
          const messageStop = createClaudeStreamEvent('message_stop')
          res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`)
          res.end()
          resolve()
        },
        (error) => {
          if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
            resolve()
            return
          }
          console.error('[ProxyServer] Stream error:', error)

          // Hold Gate 接线(task#3):先按现状把失败账号的状态记账(suspended/quota/冷却),
          // 使随后的 resume 拿号能跳过这个刚挂的账号。
          this.recordRequestFailed()
          const errStatusCode2 = extractHttpStatusCode(error.message)
          this.accountPool.recordError(account.id, errStatusCode2 !== undefined ? classifyError(errStatusCode2) : ErrorType.RECOVERABLE, errStatusCode2)
          // 单账号被 403 suspended 时 recordError 不足以标记长期封禁,补一道 detect+markSuspended,
          // 否则 resume 会再次选中同一挂账号死循环。
          const suspendInfo2 = this.detectSuspendedError(error.message)
          if (suspendInfo2) {
            const newlyMarked = this.accountPool.markSuspended(account.id, suspendInfo2.reason, suspendInfo2.message)
            if (newlyMarked) {
              this.events.onAccountSuspended?.({ accountId: account.id, email: (account as { email?: string }).email, reason: suspendInfo2.reason, message: suspendInfo2.message })
            }
          }

          // ADR-0001 边界 2:仅在"尚未发出 message_start(未吐任何语义正文)"时,才允许挂起门闸接管。
          // 接管成功 → 静默 resolve,不发 SSE error(交给 resume 用新号重放,客户端无感)。
          // RCA 2026-08-02:额外要求错误「换号可能有用」(isSwitchWorthyError)——
          //   400 Improperly formed request 这类请求级错误换号无用,以前会被误挂到客户端超时。
          if (!messageStartSent && this.isSwitchWorthyError(error.message) && onPreBodyError?.(error)) {
            this.events.onResponse?.({ path: '/v1/messages', model, status: 503, error: `held: ${error.message}` })
            resolve()
            return
          }

          const errMsgFull2b = error.message || String(error)
          // v1.7.6 调试:显式把 error 内容写到 UI 可见日志(接管失败或已吐正文,才走现状 error 路径)
          proxyLogger.error('ProxyServer', `Stream error (Claude msg): ${errMsgFull2b.slice(0, 500)}`, {
            path: '/v1/messages',
            model,
            account: (account as { email?: string }).email || account.id?.slice(0, 8) || '?',
            errorType: error.name || 'Error'
          })
          const errorEvent = createClaudeStreamEvent('error', {
            error: { type: 'api_error', message: error.message }
          })
          res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
          res.end()

          this.events.onResponse?.({ path: '/v1/messages', model, status: 500, error: error.message })
          this.recordRequest({ path: '/v1/messages', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: error.message })
          // 失败路径同样落盘 —— 失败样本恰恰最有价值(429 撞爆 / 流中断 / 502
          // 都走这里),只记成功会让事后统计系统性偏乐观。
          if (perfDiag.isEnabled()) {
            perfDiag.write({
              kind: 'request',
              ts: new Date().toISOString(),
              path: '/v1/messages',
              model,
              status: 500,
              ttftMs: ttftMs ?? null,
              totalMs: Date.now() - startTime,
              attempts: attemptCounter.attempts,
              rateLimited: attemptCounter.rateLimited,
              wastedUploadBytes: attemptCounter.wastedUploadBytes,
              account: account.id?.slice(0, 8),
              error: error.message?.slice(0, 300)
            })
          }
          resolve()
        },
        signal,
        this.config.preferredEndpoint,
        attemptCounter
      ).catch(error => {
        if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
          const errorEvent = createClaudeStreamEvent('error', {
            error: { type: 'api_error', message: error.message }
          })
          res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
          res.end()
          this.recordRequestFailed()
        }
        resolve()
      })
    })
  }

  // 处理 API 错误
  private handleApiError(res: http.ServerResponse, account: { id: string }, error: Error, path: string, model?: string, startTime?: number, signal?: AbortSignal): void {
    if (this.isAbortError(error, signal) || this.isResponseClosed(res)) return
    this.recordRequestFailed()
    const parsedCode = extractHttpStatusCode(error.message) ?? 500
    const errorType = classifyError(parsedCode)
    const isAuthError = error.message.includes('401') || error.message.includes('403') || error.message.includes('Auth')

    // 上游终止类失败（内容过滤 / 异常截断）—— 既不是账号的错，也不是请求本身的错，
    // 是上游侧的行为。三处后果都要按这个语义处理（RCA 2026-08-05）：
    //   ① 状态码给 502（Bad Gateway）而非 500 —— kiroApi 的抛错文案里没有 HTTP 状态码，
    //      extractHttpStatusCode 提取不到就落到默认 500，而 500 会让人以为反代自己炸了。
    //      实测用户看到请求日志里一片 500 时第一反应就是「反代有 bug」，排查方向被带偏。
    //   ② 不记进账号错误计数 —— 换个号一样会被同一个过滤器拦，给账号记错误只会让一个
    //      完全正常的号因为上游过滤器发神经而被打入退避冷却。
    //   ③ 日志带上 model / responseTime（见下）。
    const isUpstreamTerminal = isUpstreamTerminalFailure(error.message)

    if (!isUpstreamTerminal) {
      this.accountPool.recordError(account.id, errorType, parsedCode)
    }

    let statusCode = isUpstreamTerminal ? 502 : parsedCode
    if (isAuthError) statusCode = 401

    // 失败也要能在 UI 里看出「哪个模型、耗了多久」。此前这两处 onResponse 只传
    // { path, status, error }，而请求日志读的正是它 —— 于是所有走本函数的失败在
    // UI 上模型列与耗时列都是 `-`，用户无法判断是哪个模型出的问题（RCA 2026-08-05）。
    const responseTime = startTime ? Date.now() - startTime : 0

    if (res.headersSent) {
      if (!this.isResponseClosed(res)) {
        if (path === '/v1/responses' || path === '/responses') {
          res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', error: { type: 'api_error', message: error.message } })}\n\n`)
        }
        res.end()
      }
      this.events.onResponse?.({ path, model, status: statusCode, responseTime, error: error.message })
      this.recordRequest({ path, model, accountId: account.id, responseTime, success: false, error: error.message })
      return
    }

    this.sendError(res, statusCode, error.message, this.isAnthropicPath(path) ? 'anthropic' : 'openai')
    this.events.onResponse?.({ path, model, status: statusCode, responseTime, error: error.message })
    this.recordRequest({ path, model, accountId: account.id, responseTime, success: false, error: error.message })
  }

  // 读取请求体
  /**
   * 读取请求体，限制最大字节数以防 DoS
   * - Content-Length 头超限：立即 reject
   * - 流式累加超限：销毁连接并 reject
   * 触发 BodyTooLarge 错误时上层会发 413 Payload Too Large
   */
  private readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
    const maxBytes = Math.max(1024, this.config.maxRequestBodyBytes ?? 10 * 1024 * 1024)

    // 优先用 Content-Length 提前拒绝（避免分配缓冲）
    const declaredLen = parseInt(req.headers['content-length'] || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      return Promise.reject(new BodyTooLargeError(declaredLen, maxBytes))
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const cleanup = () => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        req.off('aborted', onAborted)
        signal?.removeEventListener('abort', onAbort)
      }
      const onData = (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          cleanup()
          try { req.destroy() } catch { /* ignore */ }
          reject(new BodyTooLargeError(total, maxBytes))
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => {
        cleanup()
        resolve(Buffer.concat(chunks, total).toString('utf8'))
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onAborted = () => {
        cleanup()
        reject(new Error('Client disconnected'))
      }
      const onAbort = () => {
        cleanup()
        reject(this.getAbortError(signal))
      }
      if (signal?.aborted) {
        reject(this.getAbortError(signal))
        return
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('aborted', onAborted)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // 发送错误响应
  // P0-5 自动 sanitize：500 类不吐 message 详情；4xx 客户端错误正常返回
  private sendError(res: http.ServerResponse, status: number, message: string, format: 'openai' | 'anthropic' = 'openai'): void {
    if (res.writableEnded || res.destroyed) return
    // 500-599 强制使用通用消息（防止泄露内部信息）
    const safeMessage = status >= 500 && status < 600
      ? this.sanitizeErrorMessage(message) || 'Internal server error'
      : message
    // P1-6 503 → 触发 webhook（已有 5 分钟去重）
    if (status === 503) {
      this.notifyAllAccountsExhausted('unknown')
    }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    if (format === 'anthropic') {
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: this.getAnthropicErrorType(status),
          message: safeMessage
        }
      }))
      return
    }
    res.end(JSON.stringify({ error: { message: safeMessage, type: 'error', code: status } }))
  }

  /**
   * P0-5 / P2-19 错误消息脱敏（移除可能含的 Bearer/Token/路径等敏感信息）
   * 用于错误响应和日志输出
   */
  private sanitizeErrorMessage(msg: string): string {
    if (!msg) return ''
    return msg
      // Bearer xxxx → Bearer ***
      .replace(/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, 'Bearer ***')
      // access_token / refresh_token / api_key / x-api-key 字段值
      .replace(/(access[_-]?token|refresh[_-]?token|api[_-]?key|x-api-key)["'\s:=]+[^"',\s}]+/gi, '$1=***')
      // 长 base64/JWT（>= 40 chars）替换为占位
      .replace(/eyJ[A-Za-z0-9\-_]{20,}/g, 'eyJ***')
      // Windows 用户路径
      .replace(/C:\\Users\\[^\\/\s]+/gi, 'C:\\Users\\***')
      // Linux/Mac home 路径
      .replace(/\/home\/[^\s/]+/g, '/home/***')
      .replace(/\/Users\/[^\s/]+/g, '/Users/***')
  }

  /**
   * P1-7 滑动窗口限流：每分钟 N 次（按 API Key id 或 IP）
   * 0 = 不限制
   */
  private checkRateLimit(id: string): { allowed: boolean; retryAfterMs: number } {
    const limit = this.config.rateLimitPerKeyPerMinute || 0
    if (limit <= 0) return { allowed: true, retryAfterMs: 0 }

    const now = Date.now()
    const bucket = this.rateLimitBuckets.get(id)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.rateLimitBuckets.set(id, { count: 1, windowStart: now })
      return { allowed: true, retryAfterMs: 0 }
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterMs: 60_000 - (now - bucket.windowStart) }
    }
    bucket.count++
    return { allowed: true, retryAfterMs: 0 }
  }

  /** 定期清理过期的限流桶 / 会话粘性条目（避免内存泄漏） */
  private cleanupExpiredCaches(): void {
    const now = Date.now()
    // 限流桶过期 2 分钟
    for (const [key, bucket] of this.rateLimitBuckets) {
      if (now - bucket.windowStart > 120_000) this.rateLimitBuckets.delete(key)
    }
    // 粘性会话过期 10 分钟
    for (const [key, entry] of this.sessionAffinity) {
      if (now - entry.lastAt > 600_000) this.sessionAffinity.delete(key)
    }
    // 审计日志最多 200 条
    if (this.auditLog.length > 200) {
      this.auditLog = this.auditLog.slice(-200)
    }
  }

  /**
   * P1-8 会话粘性账号选择：相同 session hint 优先复用同一账号
   * 实现方式：用 sessionHint hash 索引到固定账号；账号失效时自动失效粘性
   */
  private pickAccountWithAffinity(sessionHint: string | undefined): ProxyAccount | null {
    if (!this.config.sessionAffinityEnabled || !sessionHint) return null
    const entry = this.sessionAffinity.get(sessionHint)
    if (entry) {
      const account = this.accountPool.getAccount(entry.accountId)
      // 校验账号仍可用:未被封禁、未额度耗尽、未被显式标记不可用。
      //
      // isQuotaExhausted 必须在列 —— 它与 isSuspended 并列构成池对「长期不可用」的
      // 判定(见 accountPool.hasBlockedAccount / isAccountAvailable,二者同为 SSOT)。
      // 漏掉它的后果:账号 402 额度耗尽换号后,带固定 session id 的客户端仍被粘到旧号,
      // 每个请求先发一发注定 402 的上游调用再进重试循环,持续到 600s TTL 过期;
      // 而反应式换号路径(:1670 等)不经 activation.ts、不调 invalidateSessionAffinity,
      // 没有任何下游机制能抵消。suspend 分支之所以自愈,正因为它的判据在这里。
      if (
        account &&
        !this.accountPool.isSuspended(account) &&
        !this.accountPool.isQuotaExhausted(account) &&
        account.isAvailable !== false
      ) {
        entry.lastAt = Date.now()
        return account
      }
      // 已失效 → 清掉粘性
      this.sessionAffinity.delete(sessionHint)
    }
    return null
  }

  /** 记录粘性映射 */
  private rememberAffinity(sessionHint: string | undefined, accountId: string): void {
    if (!this.config.sessionAffinityEnabled || !sessionHint) return
    this.sessionAffinity.set(sessionHint, { accountId, lastAt: Date.now() })
  }

  /**
   * 失效会话粘性(显式换账号时调用)
   * 不传 accountId → 清全部;传了 → 只清指向该账号的条目。
   * 语义:用户显式换账号后,旧会话不得继续粘在旧账号上(否则仍需重启服务才生效)。
   * 详见 RCA §1.5 假设 D:.archive/2026-07-28/proxy-hot-switch-single-account/
   * @returns 被清理的条目数
   */
  invalidateSessionAffinity(accountId?: string): number {
    if (!accountId) {
      const n = this.sessionAffinity.size
      this.sessionAffinity.clear()
      return n
    }
    let n = 0
    for (const [key, entry] of this.sessionAffinity) {
      if (entry.accountId === accountId) {
        this.sessionAffinity.delete(key)
        n++
      }
    }
    return n
  }

  /** P2-17 审计日志 */
  private appendAuditLog(type: string, data: Record<string, unknown>): void {
    if (!this.config.enableAuditLog) return
    this.auditLog.push({ ts: Date.now(), type, data })
    if (this.auditLog.length > 200) this.auditLog.shift()
  }

  /** 获取审计日志（供管理 API） */
  getAuditLog(): ReadonlyArray<{ ts: number; type: string; data: Record<string, unknown> }> {
    return this.auditLog
  }

  /** 注入 webhook 触发器（由 main/index.ts 注入，调用 renderer 的 webhook store） */
  setWebhookTrigger(fn: (event: string, payload: Record<string, unknown>) => void): void {
    this.webhookTrigger = fn
  }

  /** 关键事件去重时间戳（5 分钟内同事件不重复推） */
  private lastWebhookByEvent: Map<string, number> = new Map()

  /** P1-6 触发 webhook（封装错误处理 + 5 分钟去重） */
  private triggerWebhook(event: string, payload: Record<string, unknown>): void {
    const now = Date.now()
    const last = this.lastWebhookByEvent.get(event) || 0
    if (now - last < 5 * 60_000) return  // 同事件 5 分钟内不重复推
    this.lastWebhookByEvent.set(event, now)
    try { this.webhookTrigger?.(event, payload) } catch (err) {
      proxyLogger.warn('ProxyServer', `Webhook trigger failed: ${(err as Error).message}`)
    }
  }

  /** 全员配额耗尽 webhook（503 时调用） */
  private notifyAllAccountsExhausted(path: string, model?: string): void {
    const quota = this.accountPool.getQuotaStatus()
    this.appendAuditLog('all_accounts_exhausted', { path, model, ...quota })
    this.triggerWebhook('proxy-all-exhausted', {
      title: '反代账号全部不可用',
      message: `所有账号配额耗尽或冷却中（exhausted=${quota.exhausted}/${quota.total}，cooldown=${quota.cooldown}）`,
      level: 'error',
      fields: { 端点: path, 模型: model || '-', 总账号: quota.total, 配额耗尽: quota.exhausted, 冷却中: quota.cooldown, 可用: quota.available }
    })
  }

  /** P2-16 Prometheus metrics 文本 */
  private renderPrometheusMetrics(): string {
    const s = this.stats
    const ap = this.accountPool
    const lines: string[] = []
    lines.push('# HELP kiro_proxy_requests_total Total requests handled')
    lines.push('# TYPE kiro_proxy_requests_total counter')
    lines.push(`kiro_proxy_requests_total ${s.totalRequests}`)
    lines.push('# HELP kiro_proxy_requests_success_total Total successful requests')
    lines.push('# TYPE kiro_proxy_requests_success_total counter')
    lines.push(`kiro_proxy_requests_success_total ${s.successRequests}`)
    lines.push('# HELP kiro_proxy_requests_failed_total Total failed requests')
    lines.push('# TYPE kiro_proxy_requests_failed_total counter')
    lines.push(`kiro_proxy_requests_failed_total ${s.failedRequests}`)
    lines.push('# HELP kiro_proxy_tokens_total Total tokens consumed')
    lines.push('# TYPE kiro_proxy_tokens_total counter')
    lines.push(`kiro_proxy_tokens_total{type="input"} ${s.inputTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="output"} ${s.outputTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="cache_read"} ${s.cacheReadTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="cache_write"} ${s.cacheWriteTokens}`)
    lines.push('# HELP kiro_proxy_credits_total Total credits consumed')
    lines.push('# TYPE kiro_proxy_credits_total counter')
    lines.push(`kiro_proxy_credits_total ${s.totalCredits}`)
    lines.push('# HELP kiro_proxy_accounts Accounts by status')
    lines.push('# TYPE kiro_proxy_accounts gauge')
    const quota = ap.getQuotaStatus()
    lines.push(`kiro_proxy_accounts{status="total"} ${quota.total}`)
    lines.push(`kiro_proxy_accounts{status="available"} ${quota.available}`)
    lines.push(`kiro_proxy_accounts{status="exhausted"} ${quota.exhausted}`)
    lines.push(`kiro_proxy_accounts{status="cooldown"} ${quota.cooldown}`)
    lines.push('# HELP kiro_proxy_uptime_seconds Server uptime in seconds')
    lines.push('# TYPE kiro_proxy_uptime_seconds gauge')
    lines.push(`kiro_proxy_uptime_seconds ${Math.floor((Date.now() - s.startTime) / 1000)}`)
    return lines.join('\n') + '\n'
  }

  // 记录请求到 recentRequests
  private recordRequest(log: {
    path: string
    model?: string
    accountId?: string
    inputTokens?: number
    outputTokens?: number
    credits?: number
    responseTime?: number
    success: boolean
    error?: string
  }): void {
    this.stats.recentRequests.push({
      timestamp: Date.now(),
      path: log.path,
      model: log.model || 'unknown',
      accountId: log.accountId || 'unknown',
      inputTokens: log.inputTokens || 0,
      outputTokens: log.outputTokens || 0,
      credits: log.credits,
      responseTime: log.responseTime || 0,
      success: log.success,
      // P2-19 错误消息脱敏
      error: log.error ? this.sanitizeErrorMessage(log.error).slice(0, 500) : undefined
    })
    // 会话级用量累计（credits / tokens）：recordRequest 是所有成功/失败请求的统一收口点
    this.sessionStats.credits += log.credits || 0
    this.sessionStats.inputTokens += log.inputTokens || 0
    this.sessionStats.outputTokens += log.outputTokens || 0
    // P2-15 可配置上限（默认 100，最多 10000）
    const limit = Math.min(10000, Math.max(20, this.config.recentRequestsLimit || 100))
    if (this.stats.recentRequests.length > limit) {
      this.stats.recentRequests = this.stats.recentRequests.slice(-limit)
    }
  }
}
