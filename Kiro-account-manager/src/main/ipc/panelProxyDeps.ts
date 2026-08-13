/**
 * 面板反代端点的生产实现 —— 把 `proxy/activation.ts` 的编排接到真实 proxyServer
 *
 * ## 为什么单独一个文件
 *
 * `index.ts` 已 7000+ 行且有并行 executor 在改它。这里收下全部装配逻辑，
 * `index.ts` 只需在 `buildPanelRouteDeps({...})` 里多传一个展开
 * （`...buildPanelProxyDeps({...})`），冲突面最小。
 *
 * ## 这一层做什么、不做什么
 *
 * **做**：把 `index.ts` 持有的模块级可变状态（惰性 `proxyServer` / `store`）
 * 包装成 `ProxyActivationHost`，并把三个既有 IPC 背后的动作（start / stop /
 * 同步池）转成面板可调的形状。
 *
 * **不做**：任何顺序编排。选号的三步顺序在 `activation.ts`；「先同步池再启动」
 * 在本文件的 `proxyStart` 里且只此一处。路由层与面板 UI 都不重复这个顺序 ——
 * 顺序有第二个真源时，两处早晚分叉，表现是「面板绿灯但反代打旧号」。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import {
  activateProxyAccount,
  buildProxyAccountsFromStore,
  logPoolAdmissionSkips,
  type ProxyActivationHost,
  type ProxyBindingContext
} from '../proxy/activation'
import type { AccountPool } from '../proxy/accountPool'
import type { ApiKey, ProxyConfig } from '../proxy/types'
import type { HoldAutoReleaseState, HeldRequestsInfo } from '../proxy/proxyServer'
import type { HoldEpisode } from '../proxy/holdGate'
import {
  applyProxyConfigUpdate,
  ProxyConfigUpdateError
} from '../proxy/applyProxyConfigUpdate'
import { proxyLogger } from '../proxy/logger'
import { redactString } from '../utils/redact'
import {
  panelProxyApiKeyHint,
  projectPanelProxyApiKeyList,
  projectPanelProxyConfig,
  validatePanelProxyApiKeyCreate,
  validatePanelProxyApiKeyRevoke,
  validatePanelProxyApiKeyVerify,
  validatePanelProxyConfigPatch,
  validatePanelProxyPortChange,
  type PanelProxyApiKeyCreateResult,
  type PanelProxyApiKeyListResult,
  type PanelProxyApiKeyRevokeResult,
  type PanelProxyApiKeyVerifyResult,
  type PanelProxyConfigResult,
  type PanelProxyConfigView,
  type PanelProxyPortChangeResult
} from '../webPanel/proxyConfigPolicy'

/** 反代服务器的最小接口（避免把整个 ProxyServer 类型拖进来） */
export interface ProxyServerRef {
  isRunning: () => boolean
  getAccountPool: () => AccountPool
  getConfig: () => ProxyConfig
  updateConfig: (patch: Partial<ProxyConfig>) => void
  invalidateSessionAffinity: () => number
  start: () => Promise<void>
  stop: () => Promise<void>
  restartServer: () => Promise<void>
  needsRestart: () => boolean
  getStats: () => { totalRequests: number; successRequests: number; failedRequests: number }
  /**
   * 自动放行调度器的当前读数（决策卡 §3 三字段）。
   *
   * 类型直接复用 `proxyServer.ts:HoldAutoReleaseState`，**不在这里手抄一份字面量** ——
   * 手抄 +「保持同步」注释是已知的漂移源（Globalrules §4.3 SSOT）：那边加字段
   * 这边不会知道，编译期零保护。
   *
   * `nextAutoReleaseAt` 的 `null` 表示**没有下一次**（开关关 / 无挂起条目 / 未运行）。
   * 刻意不用 `0` 表达「无」—— `0` 是合法 epoch，前端拿到会渲染出 1970 年起算的
   * 巨大负倒计时，而那看起来像渲染 bug 而非「没有下一次」。
   */
  getHoldAutoReleaseState: () => HoldAutoReleaseState
  /**
   * Single construction point on the proxy side (count + auto-release state + timeline).
   * The desktop pull, the desktop push event and this panel all read the same shape,
   * so the field sets cannot drift apart.
   */
  getHeldRequestsInfo: () => HeldRequestsInfo
  /** 手动放行全部挂起请求。@returns 实际放行数（幂等，无挂起时 0） */
  releaseHeldRequests: () => number
}

/** 反代池同步实际消费的 `accountData` 最小持久化形状。 */
export interface StoredProxyAccountData {
  accounts?: Record<string, unknown>
  accountProxyBindings?: Record<string, string>
  proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
}

export interface PanelProxyDepsImpl {
  /**
   * 取已初始化的反代实例；未初始化返回 null。
   *
   * 刻意**不**在这里惰性 `initProxyServer()`：隐式初始化会让「反代未运行」这个
   * 状态难以如实回报，而面板的运行态判据必须真实。启动端点自己负责初始化。
   */
  getProxyServer: () => ProxyServerRef | null
  /** 惰性初始化并返回实例（仅启动路径用） */
  initProxyServer: () => ProxyServerRef
  /** 未初始化时从持久态读取；已初始化时调用方应返回实例的最新运行态。 */
  getLatestProxyConfig: () => ProxyConfig
  /** 从盘上读 `accountData`（账号表 + 出口代理绑定） */
  loadAccountData: () => StoredProxyAccountData | undefined
  /** 把当前配置写回 store（对齐 `proxy-update-config` 的持久化行为） */
  persistProxyConfig: (config: ProxyConfig) => void | Promise<void>
  /** 托盘菜单状态刷新（桌面端启停后会做，面板启停也要做，否则托盘显示与实际不符） */
  updateTrayMenu?: () => void
  /** 停止前归档会话统计（对齐 `proxy-stop` 的既有行为） */
  archiveSessionIfAny?: () => void
}

export interface PanelConfigAuditActor {
  clientIP: string
  userAgent: string
}

export type PanelConfigOperationOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false
      kind: 'invalid' | 'conflict' | 'apply' | 'persist' | 'internal'
      message: string
    }

export interface PanelProxyRouteDeps {
  proxyGetStatus: () => Promise<unknown>
  proxySyncPool: () => Promise<unknown>
  proxyActivateAccount: (accountId: string) => Promise<unknown>
  proxyStart: () => Promise<unknown>
  proxyStop: () => Promise<unknown>
  proxyReleaseHeld: () => Promise<unknown>
  proxyGetConfig: () => Promise<PanelProxyConfigView>
  proxyUpdateConfig: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyConfigResult>>
  proxyChangePort: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyPortChangeResult>>
  proxyListApiKeys: () => Promise<PanelProxyApiKeyListResult>
  proxyCreateApiKey: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyApiKeyCreateResult>>
  proxyVerifyApiKey: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyApiKeyVerifyResult>>
  proxyRevokeApiKey: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyApiKeyRevokeResult>>
}

/** 面板可见的反代状态。**不含任何凭据** —— 只有 id / email 级别的标识 */
export interface PanelProxyStatus {
  success: true
  running: boolean
  port?: number
  host?: string
  enableMultiAccount: boolean
  /** 单账号模式下用户指定的账号；多账号模式为 undefined */
  selectedAccountId?: string
  selectedAccountEmail?: string
  poolSize: number
  availableCount: number
  /**
   * 已服务的请求总数。
   *
   * 面板的「停止」不做优雅停止 —— 桌面端 `ProxyPanel.tsx:352` 也是直接停，
   * 引入面板独有的优雅停止会让两端行为分叉。取而代之：把请求统计如实回传，
   * 让用户自己判断现在停是否合适。这是有意的取舍，不是遗漏。
   */
  totalRequests: number
  successRequests: number
  failedRequests: number
  /**
   * 自动定时放行当前是否启用（= 配置开关 && 挂起门闸本身开着）。
   *
   * 三个自动放行字段**一律必填**，反代未初始化时也不例外：下面 `status()` 的
   * 未初始化分支显式给出关闭态（`false` / `null` / `0`），那是**真实读数而非编造**
   * —— 「没有门闸实例」精确等价于「没开着、没有下一次、本次启动还没放过」。
   *
   * 为什么不留 `?`：可选会让「将来某次改动漏发这个字段」在编译期完全无声，而消费端
   * 的 `?? 0` / 默认关闭处理会把这个契约漂移渲染成一个**合法业务态**（「自动放行未
   * 开启」「已放行 0 次」）。用户看到的是一个平静的错误读数，界面上没有任何异常。
   * 必填把这类漂移变成编译失败 —— 本该拦住它的那道编译期护栏，正是被 `?` 关掉的。
   */
  autoReleaseEnabled: boolean
  /**
   * 下次自动放行的**绝对** epoch ms；`null` = 没有下一次。
   *
   * ⚠️ `null` 是**取值**，不是「字段缺失」，所以类型是 `number | null` 且**必填** ——
   * 「没有下一次」必须由发送方明确表态，不能靠字段不存在来暗示。两者混同后消费端
   * 无法区分「服务端说没有下一次」与「服务端没说」。判空一律用 `== null`，
   * 不能用 falsy 判断：`0` 是合法 epoch。
   *
   * 前端用 `nextAutoReleaseAt - Date.now()` 本地每秒渲染倒计时 —— 主进程只推绝对
   * 时间戳，不推倒计时数值（推送是事件驱动，倒计时是连续量；推数值会让推送频率
   * 被倒计时的刷新率绑架）。
   */
  nextAutoReleaseAt: number | null
  /** 本次反代启动以来自动放行的**周期次数**（不是条目数）。手动放行不计入 */
  autoReleaseCount: number
  /**
   * Current in-progress hold round: trigger reason, when it started, and every
   * release with its outcome. null = nothing is held right now.
   * The phone panel is read-only here (routes.ts deliberately takes no config params).
   */
  currentEpisode: HoldEpisode | null
  /** Most recent finished hold rounds, newest first (at most 20). */
  recentEpisodes: HoldEpisode[]
}

function bindingContext(data: ReturnType<PanelProxyDepsImpl['loadAccountData']>): ProxyBindingContext {
  return {
    bindings: data?.accountProxyBindings ?? {},
    proxyPool: data?.proxyPool ?? {}
  }
}

/**
 * 把宿主能力包装成 `ProxyActivationHost`。
 *
 * `loadAccountRecords` 每次都从盘上现读 —— 编排的「凭据不接受调用方快照」
 * 这条纪律就落在这里：HTTP 请求体里只有 accountId，凭据一律现取。
 */
function makeActivationHost(impl: PanelProxyDepsImpl, server: ProxyServerRef): ProxyActivationHost {
  return {
    isRunning: () => server.isRunning(),
    getAccountPool: () => server.getAccountPool(),
    getConfig: () => server.getConfig(),
    updateConfig: (patch) => {
      server.updateConfig(patch)
      // 与 `proxy-update-config` 一致地持久化：不写盘的话，下次自启动会丢掉
      // 用户在手机上的选号，表现为「昨天选好的号今天自己变了」。
      impl.persistProxyConfig(server.getConfig())
    },
    invalidateSessionAffinity: () => server.invalidateSessionAffinity(),
    loadAccountRecords: () => impl.loadAccountData()?.accounts ?? {}
  }
}

/**
 * 同步整池的结果 —— 两个数字，因为「池是空的」有**两种**成因且处置不同。
 *
 * 调用方要能区分：
 *   - `recordCount === 0` → 盘上压根没有账号（服务端首次部署的常态：先起服务、后拷数据文件）
 *   - `recordCount > 0 && poolSize === 0` → 有账号但**全部**没通过池准入（真故障；
 *     逐个原因已由 {@link logPoolAdmissionSkips} 点名）
 *
 * 只回 `poolSize` 会让这两种坍缩成一种，而它们要求的运维动作相反
 * （「去拷数据」vs「去查这些号为什么不准入」）。
 */
export interface ProxyPoolSyncResult {
  /** 盘上 `accountData.accounts` 的记录条数（准入过滤**之前**） */
  recordCount: number
  /** `replaceAll` 之后池内实际成员数 */
  poolSize: number
}

/**
 * 同步整池：按盘上账号重建。桌面面板与服务端自启动共用这一同步原语。
 *
 * 「同步后再启动」的调用顺序刻意分别写在 `proxyStart` 与 `server/entry.ts`：
 * 两端的空池策略不同，面板拒启而无人值守的服务端保留懒补自愈。架构测试分别
 * 锁住两处顺序，并用发现式门禁阻止新的启动路径未经归类就加入。
 *
 * 走 `replaceAll` 而非 `clear()` + `addAccount()`：后者清空后再逐个加，
 * 运行期状态（真实额度 / 402 耗尽标记 / 风控挂起 / 断路器计数）会在
 * 清空那一步全部消失 —— 用户点一次「同步池」就把已耗尽的号放回轮询。
 *
 * **两端共用的只是「同步 + 诊断读数」，不包括空池怎么处置** —— 那件事两端刻意不同：
 * 面板前有人看着屏幕，拒启并回 `EMPTY_POOL` 让他当场改；服务端自启动发生在开机时、
 * 无人在场，拒启只会把一个能自愈的场景（`onPoolEmpty` 懒加载补池）变成必须人工干预。
 * 故处置留给各自的调用方，本函数只如实回报。
 *
 * @param loadAccountData 从盘上现读 `accountData`（每次现读 —— 不接受调用方快照）
 * @param source 水合入口标识（`panel-sync` / `server-autostart`），进准入日志便于定位是哪条路
 */
export function syncProxyPoolFromStore(
  loadAccountData: PanelProxyDepsImpl['loadAccountData'],
  server: Pick<ProxyServerRef, 'getAccountPool'>,
  source: string
): ProxyPoolSyncResult {
  const data = loadAccountData()
  const records = data?.accounts
  const accounts = buildProxyAccountsFromStore(records, bindingContext(data), (skipped) =>
    logPoolAdmissionSkips(skipped, source)
  )
  return {
    recordCount: records ? Object.keys(records).length : 0,
    poolSize: server.getAccountPool().replaceAll(accounts)
  }
}

/**
 * 面板路径的同步整池（对齐 `proxy-sync-accounts` 的语义）。
 *
 * 薄封装 {@link syncProxyPoolFromStore} —— 面板只关心池大小；
 * 「盘上有几条记录」这个诊断读数是服务端启动播报要用的。
 */
function syncPool(impl: PanelProxyDepsImpl, server: ProxyServerRef): number {
  return syncProxyPoolFromStore(impl.loadAccountData, server, 'panel-sync').poolSize
}

function configuredApiKeyCount(config: ProxyConfig): number {
  return (
    (config.apiKey ? 1 : 0) +
    (config.apiKeys ?? []).filter((entry) => entry.enabled && entry.key).length
  )
}

function safeAuditText(value: string, config: ProxyConfig, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength)
  const secrets = [config.apiKey, ...(config.apiKeys ?? []).map((entry) => entry.key)].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0
  )
  if (secrets.some((secret) => normalized.includes(secret))) return '[redacted]'
  return redactString(normalized).replace(/key:[a-f0-9]{12}/gi, '[redacted-hint]')
}

interface ConfigAuditInput {
  actor: PanelConfigAuditActor
  config: ProxyConfig
  outcome: 'success' | 'rejected' | 'failed'
  fields: string[]
  change:
    | { key: 'logRequests' | 'port'; before: boolean | number; after: boolean | number }
    | { operation: 'create' | 'verify' | 'revoke'; configuredBefore: boolean; configuredAfter: boolean }
    | null
  requiresRestart: boolean
  apply: 'not_attempted' | 'succeeded' | 'failed'
  persist: 'not_attempted' | 'succeeded' | 'failed'
  rollback?: 'not_needed' | 'succeeded' | 'failed'
}

/**
 * C1 配置审计固定写持久 proxyLogStore，刻意不读取 `enableAuditLog`。
 * secret 动作的 change 形状只有 operation/configuredBefore/configuredAfter。
 */
function writeConfigAudit(input: ConfigAuditInput): void {
  const data = {
    timestamp: new Date().toISOString(),
    actor: 'admin',
    clientIP: safeAuditText(input.actor.clientIP, input.config, 64),
    userAgent: safeAuditText(input.actor.userAgent, input.config, 256),
    outcome: input.outcome,
    fields: input.fields,
    change: input.change,
    requiresRestart: input.requiresRestart,
    apply: input.apply,
    persist: input.persist,
    rollback: input.rollback ?? 'not_needed'
  }
  const message = 'Panel proxy configuration operation'
  if (input.outcome === 'success') proxyLogger.info('PanelConfigAudit', message, data)
  else proxyLogger.warn('PanelConfigAudit', message, data)
}

function updateFailure(
  error: unknown
): { kind: 'apply' | 'persist' | 'internal'; message: string; rollback: 'succeeded' | 'failed' } {
  if (error instanceof ProxyConfigUpdateError) {
    const rollback = error.rollbackSucceeded ? 'succeeded' : 'failed'
    if (error.phase === 'persist') {
      return {
        kind: 'persist',
        message: error.rollbackSucceeded
          ? '配置持久化失败，运行态和盘上值已恢复。'
          : '配置持久化失败，自动回滚未完成；请检查反代与磁盘状态。',
        rollback
      }
    }
    return {
      kind: 'apply',
      message: error.rollbackSucceeded
        ? '配置运行态应用失败，已恢复原配置。'
        : '配置运行态应用失败，自动回滚未完成；请检查反代状态。',
      rollback
    }
  }
  return {
    kind: 'internal',
    message: '配置操作失败，请查看服务端审计日志。',
    rollback: 'failed'
  }
}

/**
 * 组装面板的六个反代端点实现。
 *
 * 返回值直接展开进 `buildPanelRouteDeps({...})`。
 */
export function buildPanelProxyDeps(impl: PanelProxyDepsImpl): PanelProxyRouteDeps {
  const latestConfig = (): ProxyConfig => ({
    ...(impl.getProxyServer()?.getConfig() ?? impl.getLatestProxyConfig())
  })
  const configView = (): PanelProxyConfigView => {
    const server = impl.getProxyServer()
    return projectPanelProxyConfig(server?.getConfig() ?? impl.getLatestProxyConfig(), server?.needsRestart() ?? false)
  }
  const applyUpdate = (patch: Partial<ProxyConfig>, mode: 'hot' | 'restart' = 'hot') =>
    applyProxyConfigUpdate(
      {
        getLatestConfig: latestConfig,
        getProxyServer: () => impl.getProxyServer(),
        persistProxyConfig: impl.persistProxyConfig
      },
      patch,
      mode
    )

  // 配置写必须串行：每个动作都在轮到自己时重新读最新 config，避免两个手机会话
  // 同时 patch 时都从旧快照合并，后完成者把前一个无关字段覆盖掉。
  let mutationTail: Promise<void> = Promise.resolve()
  const serializeMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const task = mutationTail.then(run, run)
    mutationTail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  /**
   * 面板状态读数。
   *
   * 返回类型是**单一** `PanelProxyStatus`，未初始化分支也走同一形状 —— 此前这里写成
   * `PanelProxyStatus | { ...零值字面量 }` 的联合，但那第二个成员的字段集与
   * `PanelProxyStatus` 完全一致（只是值全为零/关闭），结构上本就可赋给它，
   * 联合唯一的作用是让漏字段时错误信息指向"不匹配任何成员"而非"缺少某字段"。
   *
   * 刻意**不**按 `running` 做可辨识联合：`running: false` 并不蕴含"没有自动放行读数"。
   * 反代已初始化但已停止时（`getProxyServer()` 非 null 且 `isRunning()` 为 false）
   * 走的是下面的主分支，三字段是调度器的**真实读数**。即 `running: false` 对应两种
   * 情形，两者都带全字段，故它不是合法的判别式；按它分叉会让类型对"已停止"这一情形
   * 断言出错误的事实。
   */
  const status = (): PanelProxyStatus => {
    const server = impl.getProxyServer()
    if (!server) {
      // 未初始化 ≠ 出错。如实回报「没在跑」，让面板显示真实状态。
      return {
        success: true,
        running: false,
        poolSize: 0,
        availableCount: 0,
        enableMultiAccount: false,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        // 没有门闸实例 → 关闭态 + 无下一次。`null` 而不是 0（0 是合法 epoch）
        autoReleaseEnabled: false,
        nextAutoReleaseAt: null,
        autoReleaseCount: 0,
        // No hold gate instance yet, so there is no timeline to read.
        currentEpisode: null,
        recentEpisodes: []
      }
    }
    const config = server.getConfig()
    const pool = server.getAccountPool()
    const stats = server.getStats()
    // 三字段一律取调度器真实读数，面板不自己按配置推算 ——
    // 「配置开着」与「调度器真的在跑」是两件事，按配置推算就会显示
    // 「自动放行已开启」而实际不执行（决策卡 §1 Must NOT #5）。
    // 字段名与 `HoldAutoReleaseState` 逐字一致，故整体展开而不逐字段搬运。
    const { count: _heldCount, ...auto } = server.getHeldRequestsInfo()
    const selectedId = config.enableMultiAccount === false ? config.selectedAccountIds?.[0] : undefined
    const out: PanelProxyStatus = {
      success: true,
      // 真实判据：读 server 句柄。不是"我发过启动请求所以应该在跑"
      running: server.isRunning(),
      port: config.port,
      host: config.host,
      enableMultiAccount: config.enableMultiAccount === true,
      poolSize: pool.size,
      availableCount: pool.availableCount,
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      ...auto
    }
    if (selectedId) {
      out.selectedAccountId = selectedId
      const acc = pool.getAccount(selectedId)
      if (acc?.email) out.selectedAccountEmail = acc.email
    }
    return out
  }

  const rejected = <T>(
    actor: PanelConfigAuditActor,
    config: ProxyConfig,
    message: string,
    fields: string[],
    change: ConfigAuditInput['change'] = null
  ): PanelConfigOperationOutcome<T> => {
    writeConfigAudit({
      actor,
      config,
      outcome: 'rejected',
      fields,
      change,
      requiresRestart: false,
      apply: 'not_attempted',
      persist: 'not_attempted'
    })
    return { ok: false, kind: 'invalid', message }
  }

  const failed = <T>(
    actor: PanelConfigAuditActor,
    config: ProxyConfig,
    error: unknown,
    fields: string[],
    change: ConfigAuditInput['change'],
    requiresRestart: boolean
  ): PanelConfigOperationOutcome<T> => {
    const detail = updateFailure(error)
    writeConfigAudit({
      actor,
      config,
      outcome: 'failed',
      fields,
      change,
      requiresRestart,
      apply: detail.kind === 'persist' ? 'succeeded' : 'failed',
      persist: detail.kind === 'persist' ? 'failed' : 'not_attempted',
      rollback: detail.rollback
    })
    return { ok: false, kind: detail.kind, message: detail.message }
  }

  return {
    proxyGetConfig: async () => configView(),

    proxyUpdateConfig: (input, actor) =>
      serializeMutation(async () => {
        const previous = latestConfig()
        const validation = validatePanelProxyConfigPatch(input)
        if (!validation.ok) {
          return rejected(actor, previous, validation.message, validation.fields)
        }
        const nextValue = validation.value.changes.logRequests as boolean
        const change = {
          key: 'logRequests' as const,
          before: previous.logRequests === true,
          after: nextValue
        }
        if (change.before === change.after) {
          writeConfigAudit({
            actor,
            config: previous,
            outcome: 'success',
            fields: [],
            change,
            requiresRestart: false,
            apply: 'not_attempted',
            persist: 'not_attempted'
          })
          return {
            ok: true,
            value: {
              appliedFields: [],
              requiresRestart: false,
              config: configView()
            }
          }
        }
        try {
          const applied = await applyUpdate({ logRequests: nextValue })
          writeConfigAudit({
            actor,
            config: applied.config,
            outcome: 'success',
            fields: ['logRequests'],
            change,
            requiresRestart: false,
            apply: 'succeeded',
            persist: 'succeeded'
          })
          return {
            ok: true,
            value: {
              appliedFields: ['logRequests'],
              requiresRestart: false,
              config: projectPanelProxyConfig(
                applied.config,
                impl.getProxyServer()?.needsRestart() ?? false
              )
            }
          }
        } catch (error) {
          return failed(actor, previous, error, ['logRequests'], change, false)
        }
      }),

    proxyChangePort: (input, actor) =>
      serializeMutation(async () => {
        const previous = latestConfig()
        const validation = validatePanelProxyPortChange(input, previous.port)
        if (!validation.ok) {
          return rejected(actor, previous, validation.message, validation.fields)
        }
        const change = {
          key: 'port' as const,
          before: previous.port,
          after: validation.value.port
        }
        try {
          const applied = await applyUpdate({ port: validation.value.port }, 'restart')
          impl.updateTrayMenu?.()
          writeConfigAudit({
            actor,
            config: applied.config,
            outcome: 'success',
            fields: ['port'],
            change,
            requiresRestart: false,
            apply: 'succeeded',
            persist: 'succeeded'
          })
          return {
            ok: true,
            value: {
              previousPort: previous.port,
              port: applied.config.port,
              restarted: applied.restarted,
              requiresRestart: false as const,
              config: projectPanelProxyConfig(applied.config, false)
            }
          }
        } catch (error) {
          return failed(actor, previous, error, ['port'], change, true)
        }
      }),

    proxyListApiKeys: async () => projectPanelProxyApiKeyList(latestConfig()),

    proxyCreateApiKey: (input, actor) =>
      serializeMutation(async () => {
        const previous = latestConfig()
        const validation = validatePanelProxyApiKeyCreate(input)
        const configuredBefore = configuredApiKeyCount(previous) > 0
        const auditChange = {
          operation: 'create' as const,
          configuredBefore,
          configuredAfter: true
        }
        if (!validation.ok) {
          return rejected(actor, previous, validation.message, validation.fields, auditChange)
        }
        const createdAt = Date.now()
        const id = randomUUID()
        const key = `sk-${randomBytes(24).toString('hex')}`
        const entry: ApiKey = {
          id,
          name: `Panel key ${new Date(createdAt).toISOString()}`,
          key,
          format: 'sk',
          enabled: true,
          createdAt,
          usage: {
            totalRequests: 0,
            totalCredits: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            daily: {}
          }
        }
        try {
          const applied = await applyUpdate({
            apiKeys: [...(previous.apiKeys ?? []), entry]
          })
          writeConfigAudit({
            actor,
            config: applied.config,
            outcome: 'success',
            fields: ['apiKeys'],
            change: auditChange,
            requiresRestart: false,
            apply: 'succeeded',
            persist: 'succeeded'
          })
          return {
            ok: true,
            value: {
              id,
              key,
              hint: panelProxyApiKeyHint(id),
              createdAt,
              config: projectPanelProxyConfig(applied.config, false)
            }
          }
        } catch (error) {
          return failed(actor, previous, error, ['apiKeys'], auditChange, false)
        }
      }),

    proxyVerifyApiKey: (input, actor) =>
      serializeMutation(async () => {
        const previous = latestConfig()
        const configured = configuredApiKeyCount(previous) > 0
        const auditChange = {
          operation: 'verify' as const,
          configuredBefore: configured,
          configuredAfter: configured
        }
        const validation = validatePanelProxyApiKeyVerify(input)
        if (!validation.ok) {
          return rejected(actor, previous, validation.message, validation.fields, auditChange)
        }
        const entry = previous.apiKeys?.find(
          (candidate) => candidate.id === validation.value.id && candidate.enabled && candidate.key
        )
        if (!entry) {
          return rejected(
            actor,
            previous,
            '未找到可验证的新 API Key。',
            ['apiKeys'],
            auditChange
          )
        }
        if (typeof entry.lastUsedAt !== 'number' || entry.lastUsedAt < entry.createdAt) {
          writeConfigAudit({
            actor,
            config: previous,
            outcome: 'rejected',
            fields: ['apiKeys'],
            change: auditChange,
            requiresRestart: false,
            apply: 'not_attempted',
            persist: 'not_attempted'
          })
          return {
            ok: false,
            kind: 'conflict',
            message: '新 API Key 尚未成功服务过数据面请求，不能标记为已验证。'
          }
        }
        try {
          const applied = await applyUpdate({
            apiKeys: (previous.apiKeys ?? []).map((candidate) => ({ ...candidate }))
          })
          writeConfigAudit({
            actor,
            config: applied.config,
            outcome: 'success',
            fields: ['apiKeys'],
            change: auditChange,
            requiresRestart: false,
            apply: 'succeeded',
            persist: 'succeeded'
          })
          return {
            ok: true,
            value: {
              id: entry.id,
              verified: true as const,
              verifiedAt: entry.lastUsedAt,
              config: projectPanelProxyConfig(applied.config, false)
            }
          }
        } catch (error) {
          return failed(actor, previous, error, ['apiKeys'], auditChange, false)
        }
      }),

    proxyRevokeApiKey: (input, actor) =>
      serializeMutation(async () => {
        const previous = latestConfig()
        const configuredBefore = configuredApiKeyCount(previous) > 0
        const validation = validatePanelProxyApiKeyRevoke(input)
        const invalidAudit = {
          operation: 'revoke' as const,
          configuredBefore,
          configuredAfter: configuredBefore
        }
        if (!validation.ok) {
          return rejected(actor, previous, validation.message, validation.fields, invalidAudit)
        }
        const replacement = previous.apiKeys?.find(
          (candidate) =>
            candidate.id === validation.value.replacementId &&
            candidate.enabled &&
            candidate.key &&
            typeof candidate.lastUsedAt === 'number' &&
            candidate.lastUsedAt >= candidate.createdAt
        )
        if (!replacement) {
          writeConfigAudit({
            actor,
            config: previous,
            outcome: 'rejected',
            fields: ['apiKeys'],
            change: invalidAudit,
            requiresRestart: false,
            apply: 'not_attempted',
            persist: 'not_attempted'
          })
          return {
            ok: false,
            kind: 'conflict',
            message: '替代 API Key 尚未通过真实请求验证，不能吊销旧 key。'
          }
        }

        let patch: Partial<ProxyConfig>
        if (validation.value.id === 'legacy') {
          if (!previous.apiKey) {
            return rejected(actor, previous, '旧版 API Key 已不存在。', ['apiKeys'], invalidAudit)
          }
          patch = { apiKey: undefined }
        } else {
          const targetIndex = (previous.apiKeys ?? []).findIndex(
            (candidate) => candidate.id === validation.value.id && candidate.enabled
          )
          if (targetIndex < 0) {
            return rejected(actor, previous, '待吊销 API Key 不存在或已停用。', ['apiKeys'], invalidAudit)
          }
          patch = {
            apiKeys: (previous.apiKeys ?? []).map((candidate, index) =>
              index === targetIndex ? { ...candidate, enabled: false } : { ...candidate }
            )
          }
        }

        try {
          const applied = await applyUpdate(patch)
          const auditChange = {
            operation: 'revoke' as const,
            configuredBefore,
            configuredAfter: configuredApiKeyCount(applied.config) > 0
          }
          writeConfigAudit({
            actor,
            config: applied.config,
            outcome: 'success',
            fields: ['apiKeys'],
            change: auditChange,
            requiresRestart: false,
            apply: 'succeeded',
            persist: 'succeeded'
          })
          return {
            ok: true,
            value: {
              revokedId: validation.value.id,
              replacementId: replacement.id,
              config: projectPanelProxyConfig(applied.config, false)
            }
          }
        } catch (error) {
          return failed(actor, previous, error, ['apiKeys'], invalidAudit, false)
        }
      }),

    proxyGetStatus: async () => status(),

    proxySyncPool: async () => {
      const server = impl.getProxyServer()
      if (!server) return { success: false, error: 'PROXY_NOT_RUNNING' }
      const poolSize = syncPool(impl, server)
      return { success: true, poolSize }
    },

    proxyActivateAccount: async (accountId: string) => {
      const server = impl.getProxyServer()
      // 反代没跑就没有"当前账号"。不隐式启动 —— 那会绕过启动路径的空池检查。
      if (!server) return { success: false, error: 'PROXY_NOT_RUNNING' }
      const result = activateProxyAccount(
        accountId,
        makeActivationHost(impl, server),
        bindingContext(impl.loadAccountData())
      )
      if (!result.applied) return { success: false, error: result.reason }
      impl.updateTrayMenu?.()
      return { success: true, mode: result.mode, accountId: result.accountId, email: result.email }
    },

    proxyStart: async () => {
      try {
        const server = impl.initProxyServer()
        // 顺序承重：**先同步池，再启动**。颠倒或漏掉同步会用空池启动 ——
        // 反代起来了、状态显示正常、但没有账号可服务，且所有指示灯都是绿的。
        const poolSize = syncPool(impl, server)
        if (poolSize === 0) {
          // 空池启动是负条件。宁可拒绝启动，也不让用户面对"看起来正常但全失败"。
          return { success: false, error: 'EMPTY_POOL' }
        }
        await server.start()
        impl.updateTrayMenu?.()
        return {
          success: true,
          // 真实读数，不是乐观更新
          running: server.isRunning(),
          port: server.getConfig().port,
          poolSize
        }
      } catch (error) {
        // 启动失败原因如实回传（端口占用是最常见的一种），不吞
        console.error('[panelProxy] start failed:', error)
        return { success: false, error: error instanceof Error ? error.message : 'PROXY_START_FAILED' }
      }
    },

    proxyStop: async () => {
      try {
        const server = impl.getProxyServer()
        // 已经没在跑 → 幂等成功。手机端连点停止不该报错。
        if (!server) return { success: true, running: false }
        impl.archiveSessionIfAny?.()
        await server.stop()
        impl.updateTrayMenu?.()
        return { success: true, running: server.isRunning() }
      } catch (error) {
        console.error('[panelProxy] stop failed:', error)
        return { success: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }
      }
    },

    /**
     * 立刻放行全部挂起请求（手机端「立即放行」按钮）。
     *
     * 复用既有 `ProxyServer.releaseHeldRequests()` —— 与桌面端按钮、自动放行调度器
     * 走的是**同一个** `HoldGate.releaseAll()` 入口。刻意不在这一层遍历挂起集合：
     * 那会成为第三个放行入口，而放行的一次性 CAS 认领只有单一入口才守得住
     * （决策卡 §1 不变量 I2）。
     *
     * 决策卡明确：手机端只有「立刻放一次」这一个动作，**不接受任何配置参数**
     * （改间隔 / 改开关留在桌面端，手机误触代价大于收益）。
     */
    proxyReleaseHeld: async () => {
      try {
        const server = impl.getProxyServer()
        // 反代没跑就没有挂起集合。不隐式初始化 —— 那会绕过启动路径的空池检查。
        if (!server) return { success: false, error: 'PROXY_NOT_RUNNING' }
        // 无挂起条目时返回 0 而不是报错：放行本身是幂等语义，
        // 「点了没东西可放」不是失败（决策卡 §3 手机端契约）。
        return { success: true, released: server.releaseHeldRequests() }
      } catch (error) {
        // 放行失败原因如实回传，不吞
        console.error('[panelProxy] release held failed:', error)
        return { success: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }
      }
    }
  }
}
