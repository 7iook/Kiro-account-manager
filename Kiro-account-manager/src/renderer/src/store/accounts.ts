import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type {
  Account,
  AccountGroup,
  AccountTag,
  AccountFilter,
  AccountSort,
  AccountStatus,
  AccountStats,
  AccountExportData,
  AccountImportItem,
  BatchOperationResult,
  AccountSubscription,
  SubscriptionType,
  IdpType
} from '../types/account'
import type {
  ProxyEntry,
  ProxyPoolConfig,
  ProxyValidationResult,
  ProxyProtocol
} from '../types/proxy'
import { DEFAULT_PROXY_POOL_CONFIG } from '../types/proxy'
import { useWebhookStore, type WebhookEvent, type WebhookMessage } from './webhooks'
import { mergeSyncBlob, type SyncBlob } from './syncMerge'

// ============================================
// 账号管理 Store
// ============================================

// 生成随机 64 位十六进制设备 ID
function generateRandomMachineId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// 自动 Token 刷新定时器
let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null
// 刷新提前量必须 ≥ 2× 检查间隔，否则账号会在两次 tick 之间过期：
// 某次 tick 时剩余刚好略超阈值会被跳过，下一次 tick（间隔分钟后）时早已过期。
// 再叠加 IPC + OIDC 网络刷新本身的耗时，余量不足就会出现"过期才刷"。
const TOKEN_REFRESH_MIN_LEAD_MS = 10 * 60 * 1000
function tokenRefreshLeadMs(intervalMin: number): number {
  return Math.max(intervalMin * 2 * 60 * 1000, TOKEN_REFRESH_MIN_LEAD_MS)
}

// 持久化防抖：合并连续 mutation 为单次写盘，避免后台刷新风暴时 IPC + IO 风暴
const SAVE_DEBOUNCE_MS = 500
/** 防抖最大延迟：连续 mutation 时也最迟在此时间内落盘一次，防止风暴下数据长时间不入磁盘 */
const SAVE_MAX_WAIT_MS = 5000
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
let saveMaxWaitTimer: ReturnType<typeof setTimeout> | null = null
/** 本次 flush 的结果契约。调用方靠它知道「我的保存到底成不成」—— 而不是以前的 void（无从得知）。 */
export type FlushSaveResult =
  | { ok: true; revision: number }
  | { ok: false; code: 'SYNC_CONFLICT_UNRESOLVED'; attempts: number }
  | { ok: false; code: 'SAVE_FAILED'; error: string }

let saveInFlight: Promise<FlushSaveResult> | null = null
/** 等待本轮防抖窗口落盘的所有调用方 resolver；批量唤醒，避免风暴时 Promise 永久挂起 */
let savePendingResolvers: Array<() => void> = []

// ============ 跨端同步：base 快照 + 被吞广播账本（C1 / A-I2 返修） ============
//
// base = 「我当前内存状态所基于的那个磁盘快照」。
// 为什么必须有它:整表覆盖写模型下,只有 ours 与 theirs 两方时,「某账号在 ours 里没有」
// 是二义的 —— 可能是"我删的",也可能是"别人刚加的、我还没见过"。二义无法消除 ⇒ 必然误判一种,
// 这正是 C1「删除被 reload 复活」的根因。有 base 后语义唯一,合并成为确定性运算而非猜测。
//
// 四个写入点与 currentRevision 严格同步（任何一处漏更新都会让下次合并基于错误的 base）:
//   1. loadFromStorage 成功      2. reloadFromStorageQuiet 成功
//   3. flushSaveImmediately 写盘成功（base = 我刚写上去的内容,它已经是盘面）
//   4. 重放循环每轮合并后（base = 本轮拉到的盘面 theirs,**不是**合并产物 —— 见 C3）
//
// C3 的教训:base 有两个必须同时满足的要求,过去被混为一谈 ——
//   内容必须是「盘面」(theirs)  · 形状必须与 ours 同一生产者(buildPersistBlob)。
// 取「合并产物」满足了形状却违反了内容,于是用户的删除从第二轮起被判成"别人新加的"而复活。
// 三个读盘路径统一走 deriveBaseFromDisk,同时满足两条。
let syncBaseSnapshot: SyncBlob | null = null

/** 被 isSyncing 反检吞掉的最高外部 revision;null = 无待对账项（A-I2） */
let pendingExternalRevision: number | null = null

/**
 * 本窗口的写入来源标识（A-I2）。随每次 saveAccounts 上行,main 侧原样带回广播 payload,
 * 使 consumer 能**精确**判定「这条广播是我自己写的回声」。
 *
 * 为何不用 isSyncing 时间窗:时间窗无法区分「我的回声」与「刚好落在窗口内的外部写」,
 * 于是两者一起被吃且不留痕迹;本机写入随后把 revision 推得更高 ⇒ revision 反检此后永久失效
 * ⇒ 那条外部改动再也不会被拉回来。originId 把“猜”换成了“知道”。
 */
export const SYNC_ORIGIN_ID = `renderer-${Math.random().toString(36).slice(2)}-${Date.now()}`

/** STALE 后基于最新盘面重放的最大次数。超出即明确报错,绝不静默丢弃也绝不无限重试。 */
const MAX_STALE_REPLAY_ATTEMPTS = 3

/**
 * 「内存里有未落盘的本地编辑」判据（C1-again 返修 · 本轮核心）。
 *
 * 为什么不能用 isSyncing:
 *   isSyncing 只在 flushSaveImmediately 执行期间为 true = **IPC 在途**。
 *   而用户编辑后的真实时序是:
 *     set() 改内存 → saveToStorage 起防抖 timer(500ms,最长 5000ms) → flushNow → isSyncing=true
 *                    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *                    这整段 isSyncing 恒为 false,可内存里已经有未落盘的删除/编辑
 *   于是任何以 isSyncing 为守卫的 reload 通道在防抖窗内全部畅通 ⇒ 整表覆盖 ⇒ 用户编辑被磁盘复活。
 *   这正是 C1 第一轮只修了 STALE 分支却复发的原因:isSyncing ≠ dirty,两个概念不等价。
 *
 * 判据取自持久化机制本身（saveToStorage / flushSaveImmediately 是唯一落盘入口,天然 SSOT）:
 *   - saveDebounceTimer / saveMaxWaitTimer 非空 → 有编辑在等防抖
 *   - savePendingResolvers 非空               → 有调用方在等本轮落盘
 *   - saveInFlight 非空 / isSyncing            → IPC 在途
 *
 * timer 被 clear 到 flush 真正开始之间**没有窗口**:flushNow 里
 * 「clear timers → 取走 resolvers → 调 flushSaveImmediately」全程同步无 await,
 * 而 flushSaveImmediately 的同步段即刻 set isSyncing=true 并赋值 saveInFlight。
 * 故任一 await 点上观察,必然至少命中上面一项。
 */
function hasPendingLocalEditsInternal(isSyncing: boolean): boolean {
  return (
    saveDebounceTimer !== null ||
    saveMaxWaitTimer !== null ||
    savePendingResolvers.length > 0 ||
    saveInFlight !== null ||
    isSyncing
  )
}

/**
 * 持久化设置字段的默认值 —— store 初始 state 与 `keep()` fallback 的**单一来源**（I7）。
 *
 * 为什么必须同源:这两处过去各写一份字面量（如 `autoRefreshInterval: 5` 出现两次）。
 * 在「盘面有这个 key 但值为 null」的路径上,`keep` 走 fallback、初始化走初值 ——
 * 改一处漏一处就产生真实的行为分叉,而且没有任何测试会发现。
 */
const DEFAULT_SETTINGS: Pick<
  AccountsStore,
  | 'autoRefreshEnabled'
  | 'autoRefreshInterval'
  | 'autoRefreshConcurrency'
  | 'autoRefreshSyncInfo'
  | 'batchImportConcurrency'
  | 'loginPrivateMode'
  | 'statusCheckInterval'
  | 'privacyMode'
  | 'usagePrecision'
  | 'proxyEnabled'
  | 'proxyUrl'
  | 'autoSwitchEnabled'
  | 'autoSwitchThreshold'
  | 'autoSwitchInterval'
  | 'switchTarget'
  | 'theme'
  | 'darkMode'
  | 'language'
  | 'machineIdConfig'
  | 'accountMachineIds'
  | 'machineIdHistory'
> = {
  autoRefreshEnabled: true,
  autoRefreshInterval: 5,
  autoRefreshConcurrency: 100,
  autoRefreshSyncInfo: true,
  batchImportConcurrency: 100,
  loginPrivateMode: false,
  statusCheckInterval: 60,
  privacyMode: false,
  usagePrecision: false,
  proxyEnabled: false,
  proxyUrl: '',
  autoSwitchEnabled: false,
  autoSwitchThreshold: 0,
  autoSwitchInterval: 5,
  switchTarget: 'ide',
  theme: 'default',
  darkMode: false,
  language: 'auto',
  machineIdConfig: {
    autoSwitchOnAccountChange: false,
    bindMachineIdToAccount: false,
    useBindedMachineId: true
  },
  accountMachineIds: {},
  machineIdHistory: []
}

/**
 * 从 store 现值构造落盘 blob（accountData 的字段清单 SSOT）。
 *
 * 抽出的原因:C1 的重放需要「用同一套字段清单再构造一次 payload」。若让 flush 与重放各写一份
 * 字段列表,任何新增字段都会漏在其中一处 —— 那是 Shotgun Surgery。这里是唯一构造点。
 */
function buildPersistBlob(s: AccountsStore): SyncBlob {
  return {
    accounts: Object.fromEntries(s.accounts),
    groups: Object.fromEntries(s.groups),
    tags: Object.fromEntries(s.tags),
    activeAccountId: s.activeAccountId,
    autoRefreshEnabled: s.autoRefreshEnabled,
    autoRefreshInterval: s.autoRefreshInterval,
    autoRefreshConcurrency: s.autoRefreshConcurrency,
    // I-b:以下三个字段有 setter + UI + 读入,却从未进落盘 payload（基线存量 bug,c15cbe4 同样缺）。
    //     旧代码里只在启动时发作一次;本轮新增的 reload 通道会把它们**每次同步都重置回默认值**
    //     （applySyncBlobToState 读到 undefined → ?? 默认值）。补齐输出即同时消灭存量 bug。
    autoRefreshSyncInfo: s.autoRefreshSyncInfo,
    batchImportConcurrency: s.batchImportConcurrency,
    loginPrivateMode: s.loginPrivateMode,
    statusCheckInterval: s.statusCheckInterval,
    privacyMode: s.privacyMode,
    usagePrecision: s.usagePrecision,
    proxyEnabled: s.proxyEnabled,
    proxyUrl: s.proxyUrl,
    autoSwitchEnabled: s.autoSwitchEnabled,
    autoSwitchThreshold: s.autoSwitchThreshold,
    autoSwitchInterval: s.autoSwitchInterval,
    switchTarget: s.switchTarget,
    // main 侧决定信封必须参与三方合并；否则它落在 renderer 防抖窗时会被下一次整表写抹掉，
    // activeAccountId 虽然变了，IDE/CLI/反代桌面副作用却永远收不到命令。
    autoSwitchDecision: s.autoSwitchDecision,
    theme: s.theme,
    darkMode: s.darkMode,
    language: s.language,
    machineIdConfig: s.machineIdConfig,
    accountMachineIds: s.accountMachineIds,
    machineIdHistory: s.machineIdHistory,
    proxyPool: Object.fromEntries(s.proxyPool),
    proxyPoolConfig: s.proxyPoolConfig,
    proxyPoolCursor: s.proxyPoolCursor,
    accountProxyBindings: s.accountProxyBindings
  }
}

/**
 * 把一个 blob（磁盘读到的 / 合并产物）归一化成 store 的 state 形状。
 *
 * 为什么要把「归一化」与「写入 store」拆开（C3 返修）:
 *   base 的定义是「我当前内存状态**所基于的那个磁盘快照**」,而它必须与 ours 同一个生产者
 *   （buildPersistBlob）才能逐字比对（见 M2 / loadFromStorage 处注释）。重放循环需要
 *   「把 theirs 归一化成我的形状」却**不能**把 theirs 写进内存（内存要装的是合并产物）。
 *   拆出纯归一化后,deriveBaseFromDisk 与 applySyncBlobToState 共用同一套归一化逻辑,
 *   不存在"两份形状规则漂移"的可能。
 */
function normalizeSyncBlob(data: SyncBlob, current: AccountsStore): Partial<AccountsStore> {
  const accounts = new Map(Object.entries((data.accounts ?? {}) as Record<string, Account>))
  const activeAccountId = (data.activeAccountId as string | null) ?? null

  // 根据 activeAccountId 同步 isActive（保持与 loadFromStorage 一致性）
  for (const [id, account] of accounts) {
    const shouldBeActive = id === activeAccountId
    if (account.isActive !== shouldBeActive) {
      accounts.set(id, { ...account, isActive: shouldBeActive })
    }
  }

  /** 盘面有这个 key → 用盘面值（null/undefined 时落 fallback）;盘面没有 key → 保留内存现值 */
  const keep = <K extends keyof AccountsStore>(key: K, fallback: AccountsStore[K]): AccountsStore[K] => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return current[key]
    const v = (data as Record<string, unknown>)[key as string]
    return (v ?? fallback) as AccountsStore[K]
  }

  return {
    accounts,
    groups: new Map(Object.entries((data.groups ?? {}) as Record<string, AccountGroup>)),
    tags: new Map(Object.entries((data.tags ?? {}) as Record<string, AccountTag>)),
    activeAccountId,
    currentRevision: typeof data.revision === 'number' ? data.revision : 0,
    autoRefreshEnabled: keep('autoRefreshEnabled', DEFAULT_SETTINGS.autoRefreshEnabled),
    autoRefreshInterval: keep('autoRefreshInterval', DEFAULT_SETTINGS.autoRefreshInterval),
    autoRefreshConcurrency: keep('autoRefreshConcurrency', DEFAULT_SETTINGS.autoRefreshConcurrency),
    autoRefreshSyncInfo: keep('autoRefreshSyncInfo', DEFAULT_SETTINGS.autoRefreshSyncInfo),
    batchImportConcurrency: keep('batchImportConcurrency', DEFAULT_SETTINGS.batchImportConcurrency),
    loginPrivateMode: keep('loginPrivateMode', DEFAULT_SETTINGS.loginPrivateMode),
    statusCheckInterval: keep('statusCheckInterval', DEFAULT_SETTINGS.statusCheckInterval),
    privacyMode: keep('privacyMode', DEFAULT_SETTINGS.privacyMode),
    usagePrecision: keep('usagePrecision', DEFAULT_SETTINGS.usagePrecision),
    proxyEnabled: keep('proxyEnabled', DEFAULT_SETTINGS.proxyEnabled),
    proxyUrl: keep('proxyUrl', DEFAULT_SETTINGS.proxyUrl),
    autoSwitchEnabled: keep('autoSwitchEnabled', DEFAULT_SETTINGS.autoSwitchEnabled),
    autoSwitchThreshold: keep('autoSwitchThreshold', DEFAULT_SETTINGS.autoSwitchThreshold),
    autoSwitchInterval: keep('autoSwitchInterval', DEFAULT_SETTINGS.autoSwitchInterval),
    switchTarget: keep('switchTarget', DEFAULT_SETTINGS.switchTarget),
    autoSwitchDecision: Object.prototype.hasOwnProperty.call(data, 'autoSwitchDecision')
      ? parseMainAutoSwitchDecision(data.autoSwitchDecision)
      : current.autoSwitchDecision,
    theme: keep('theme', DEFAULT_SETTINGS.theme),
    darkMode: keep('darkMode', DEFAULT_SETTINGS.darkMode),
    language: keep('language', DEFAULT_SETTINGS.language),
    machineIdConfig: keep('machineIdConfig', DEFAULT_SETTINGS.machineIdConfig),
    accountMachineIds: keep('accountMachineIds', DEFAULT_SETTINGS.accountMachineIds),
    machineIdHistory: keep('machineIdHistory', DEFAULT_SETTINGS.machineIdHistory),
    proxyPool: data.proxyPool
      ? new Map(Object.entries(data.proxyPool as Record<string, ProxyEntry>))
      : new Map<string, ProxyEntry>(),
    proxyPoolConfig: {
      ...DEFAULT_PROXY_POOL_CONFIG,
      ...(data.proxyPoolConfig as Partial<ProxyPoolConfig> | undefined)
    },
    proxyPoolCursor: typeof data.proxyPoolCursor === 'number' ? data.proxyPoolCursor : 0,
    accountProxyBindings: (data.accountProxyBindings as Record<string, string> | undefined) || {}
  }
}

/**
 * 把一个 blob（磁盘读到的 / 合并产物）回灌进 store state。
 *
 * 只写数据,**不做副作用** —— 副作用由 reloadFromStorageQuiet 按 before/after 差异决定,
 * 因为重放循环里会多次回灌,若每次都唤醒 main / 重启 token timer 会造成抖动。
 *
 * I-b 结构性防线:标量设置字段一律经 `keep()` 读取 —— 盘面**根本没有这个 key** 时保留内存现值,
 * 而不是回落到默认值。理由:`?? 默认值` 把"盘面没说"与"盘面说了默认值"混为一谈,于是任何
 * 「有 setter 有 UI 但漏出落盘清单」的字段都会被每次跨端同步重置回默认（autoRefreshSyncInfo /
 * batchImportConcurrency / loginPrivateMode 三个字段就是这样被用户"关掉又自己打开"的）。
 * 补齐 buildPersistBlob 治了当下三例;这条防线让同类漏字段今后**结构上不再表现为静默重置**。
 */
function applySyncBlobToState(
  data: SyncBlob,
  set: (partial: Partial<AccountsStore>) => void,
  current: AccountsStore
): void {
  set(normalizeSyncBlob(data, current))
}

/** 从 blob 里取 accounts 集合（缺失 / 形状不对时退化成空对象,供 I6 不变量断言用） */
function asAccountMap(blob: SyncBlob | null): Record<string, unknown> {
  const v = blob?.accounts
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * 由「刚从磁盘读到的盘面」推导出新的 base 快照（C3 返修 · 本轮核心）。
 *
 * base 的语义是「我这份内存状态**所基于的那个磁盘快照**」—— 它必须装**别人的盘面内容**,
 * 因为它唯一的用途是回答:「某条记录在 ours 里不见了,是我删的、还是我根本没见过?」
 *
 * 于是它有两个必须同时满足的要求,过去被混为一谈:
 *   ① 内容 = theirs（新拉到的盘面）。装成合并产物就等于把"这条记录我曾见过"的证据抹掉,
 *      下一轮它会落到「base 没有 + theirs 有」= 别人新加的 ⇒ 用户的删除被复活。
 *   ② 形状 = 与 ours 同一个生产者（buildPersistBlob ∘ normalizeSyncBlob）。直接存磁盘原始
 *      blob 会因归一化差异（isActive 推导 / Map 转换 / 缺 key 补默认）把每条记录误判为
 *      "本地改过" ⇒ 合并退化成全量本地胜 ⇒ 等于回到整表覆盖（这是 M2 修过的坑）。
 *
 * @param disk    刚读到的盘面（theirs）
 * @param current 归一化时的参照内存态 —— 必须与 `ours = buildPersistBlob(current)` 同一份,
 *                这样"盘面缺某个 key"在 base 与 ours 里取到同一个值 ⇒ 判为"我没改过"（保守正确）
 */
function deriveBaseFromDisk(disk: SyncBlob, current: AccountsStore): SyncBlob {
  const normalized = { ...current, ...normalizeSyncBlob(disk, current) } as AccountsStore
  return { ...buildPersistBlob(normalized), revision: normalized.currentRevision }
}

// ============ getFilteredAccounts / getStats 引用缓存 ============
// 大账号量场景下这两个 selector 每次 re-render 都跑 O(n) 计算（filter + sort）
// 通过引用比较缓存输入快照，命中时直接返回上次结果，将 N×n 计算降至 1×n
let _filterCache: {
  accounts: unknown
  filter: unknown
  sort: unknown
  activeGroupTab: unknown
  output: Account[]
} | null = null

let _statsCache: {
  accounts: unknown
  output: AccountStats
} | null = null

/**
 * 异步同步本地 SSO 缓存中的激活账号到 store。
 * 含潜在的网络请求（verifyAccountCredentials），从 loadFromStorage 中拆出来
 * 异步执行，避免阻塞首屏加载（isLoading）。
 */
type SetFn = (
  partial:
    | Partial<AccountsState>
    | ((state: AccountsState) => Partial<AccountsState>)
) => void

type MainAutoSwitchDecision = {
  id: string
  fromAccountId: string
  toAccountId: string
  switchTarget: 'ide' | 'cli' | 'both'
  decidedAt: number
}

let lastHandledAutoSwitchDecisionId: string | null = null
let handlingAutoSwitchDecisionId: string | null = null

function parseMainAutoSwitchDecision(value: unknown): MainAutoSwitchDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.id !== 'string' ||
    typeof raw.fromAccountId !== 'string' ||
    typeof raw.toAccountId !== 'string' ||
    typeof raw.decidedAt !== 'number' ||
    (raw.switchTarget !== 'ide' && raw.switchTarget !== 'cli' && raw.switchTarget !== 'both')
  ) {
    return null
  }
  return raw as MainAutoSwitchDecision
}

function decisionFromBlob(blob: unknown): MainAutoSwitchDecision | null {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null
  return parseMainAutoSwitchDecision(
    (blob as Record<string, unknown>).autoSwitchDecision
  )
}

/**
 * 复用既有 background-batch-refresh IPC 发空批次，只用于启动/唤醒 Electron main
 * 的共享调度器。renderer 不持有 timer，也不计算阈值或候选号。
 */
function syncMainAutoSwitchScheduler(): void {
  if (typeof window.api?.backgroundBatchRefresh !== 'function') return
  void window.api
    .backgroundBatchRefresh([], 1, false)
    .catch((error) => console.warn('[AutoSwitch] Failed to sync main scheduler:', error))
}

/**
 * 消费 main 已持久化的决定，执行只在桌面存在的副作用。
 *
 * 选号已经完成，renderer 不能改目标；它只沿用旧实现的 setActiveAccount（机器码 /
 * lastUsedAt）、IDE、CLI 和反代热切换顺序。决定 id 做进程内幂等，重复广播不重复切。
 */
async function applyMainAutoSwitchDecision(
  decision: MainAutoSwitchDecision,
  get: () => AccountsStore,
  set: SetFn
): Promise<void> {
  if (
    decision.id === lastHandledAutoSwitchDecisionId ||
    decision.id === handlingAutoSwitchDecisionId
  ) {
    return
  }

  const availableAccount = get().accounts.get(decision.toAccountId)
  if (!availableAccount) {
    console.warn(`[AutoSwitch] Decided account no longer exists: ${decision.toAccountId}`)
    lastHandledAutoSwitchDecisionId = decision.id
    return
  }

  handlingAutoSwitchDecisionId = decision.id
  try {
    // 保留旧 setActiveAccount 的机器码与保存副作用；main 已决定目标，renderer 不再选号。
    get().setActiveAccount(decision.toAccountId)

    const creds = availableAccount.credentials
    if (decision.switchTarget === 'ide' || decision.switchTarget === 'both') {
      const switchResult = await window.api.switchAccount({
        accessToken: creds.accessToken || '',
        refreshToken: creds.refreshToken || '',
        clientId: creds.clientId || '',
        clientSecret: creds.clientSecret || '',
        region: creds.region || 'us-east-1',
        startUrl: creds.startUrl,
        authMethod: creds.authMethod,
        provider: creds.provider,
        profileArn: availableAccount.profileArn,
        accountId: availableAccount.id
      })

      // 与旧 renderer 决策路径一致：main refresh 轮换出的凭据必须回写账号库。
      if (switchResult?.success && switchResult.refreshedCredentials) {
        const rc = switchResult.refreshedCredentials
        set((state) => {
          const accounts = new Map(state.accounts)
          const account = accounts.get(availableAccount.id)
          if (account) {
            accounts.set(availableAccount.id, {
              ...account,
              credentials: {
                ...account.credentials,
                accessToken: rc.accessToken,
                refreshToken: rc.refreshToken,
                expiresAt: Date.now() + rc.expiresIn * 1000
              }
            })
          }
          return { accounts }
        })
        get().saveToStorage()
      }
    }

    if (decision.switchTarget === 'cli' || decision.switchTarget === 'both') {
      const scopes = availableAccount.credentials.scopes
      window.api
        .switchAccountCli?.({
          accessToken: creds.accessToken || '',
          refreshToken: creds.refreshToken || '',
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          region: creds.region || 'us-east-1',
          profileArn: availableAccount.profileArn,
          provider: creds.provider,
          scopes: scopes ? scopes.split(/\s+/).filter(Boolean) : undefined,
          tokenEndpoint: availableAccount.credentials.tokenEndpoint,
          issuerUrl: availableAccount.credentials.issuerUrl,
          audience: availableAccount.credentials.audience
        })
        .catch((error) => console.warn('[AutoSwitch CLI] Failed:', error))
    }

    // 反代仍走既有三步热切换编排；API-key 绑定在 main 的请求选择路径继续作为硬边界。
    await get().syncActiveAccountToProxy(availableAccount.id)
  } finally {
    handlingAutoSwitchDecisionId = null
    lastHandledAutoSwitchDecisionId = decision.id
  }
}

async function syncLocalSsoAccountAsync(
  get: () => AccountsStore,
  set: SetFn
): Promise<void> {
  try {
    const localResult = await window.api.getLocalActiveAccount()
    if (!localResult.success || !localResult.data?.refreshToken) return

    const localRefreshToken = localResult.data.refreshToken
    const currentAccounts = get().accounts

    // 查找匹配的账号
    let foundAccountId: string | null = null
    for (const [id, account] of currentAccounts) {
      if (account.credentials.refreshToken === localRefreshToken) {
        foundAccountId = id
        break
      }
    }

    if (foundAccountId) {
      // 找到匹配的账号，更新 activeAccountId
      set({ activeAccountId: foundAccountId })
      // 同步 isActive 字段
      set((state) => {
        const accounts = new Map(state.accounts)
        for (const [id, account] of accounts) {
          const shouldBeActive = id === foundAccountId
          if (account.isActive !== shouldBeActive) {
            accounts.set(id, { ...account, isActive: shouldBeActive })
          }
        }
        return { accounts }
      })
      console.log('[Store] Synced active account from local SSO cache:', foundAccountId)
      get().saveToStorage()
      return
    }

    // 未找到匹配账号，尝试自动导入（网络请求）
    console.log('[Store] Local account not found in app, importing...')
    const importResult = await window.api.loadKiroCredentials()
    if (!importResult.success || !importResult.data) return

    const verifyResult = await window.api.verifyAccountCredentials({
      refreshToken: importResult.data.refreshToken,
      clientId: importResult.data.clientId || '',
      clientSecret: importResult.data.clientSecret || '',
      region: importResult.data.region,
      authMethod: importResult.data.authMethod,
      provider: importResult.data.provider,
      // external_idp 验证/刷新走微软端点，必须带这些字段，否则报"缺少 tokenEndpoint"
      accessToken: importResult.data.accessToken,
      tokenEndpoint: importResult.data.tokenEndpoint,
      issuerUrl: importResult.data.issuerUrl,
      scopes: importResult.data.scopes,
      profileArn: importResult.data.profileArn
    })
    if (!verifyResult.success || !verifyResult.data) return

    const now = Date.now()
    const newId = `${verifyResult.data.email}-${now}`
    const newAccount: Account = {
      id: newId,
      email: verifyResult.data.email,
      userId: verifyResult.data.userId,
      nickname: verifyResult.data.email ? verifyResult.data.email.split('@')[0] : undefined,
      idp: ((): IdpType => { const p = importResult.data.provider; if (p === 'AzureAD' || p === 'ExternalIdp') return 'ExternalIdp'; if (p === 'BuilderId' || p === 'Enterprise' || p === 'Github' || p === 'Google' || p === 'IAM_SSO' || p === 'AWSIdC' || p === 'Internal') return p as IdpType; return 'BuilderId' })(),
      profileArn: importResult.data.profileArn,
      credentials: {
        accessToken: verifyResult.data.accessToken,
        csrfToken: '',
        refreshToken: verifyResult.data.refreshToken,
        clientId: importResult.data.clientId || '',
        clientSecret: importResult.data.clientSecret || '',
        region: importResult.data.region || 'us-east-1',
        expiresAt: verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600 * 1000,
        authMethod: importResult.data.authMethod as 'IdC' | 'social' | 'external_idp' | undefined,
        provider: importResult.data.provider as 'BuilderId' | 'Enterprise' | 'Github' | 'Google' | 'IAM_SSO' | 'AzureAD' | 'ExternalIdp' | undefined,
        // external_idp 字段：之前静默丢失导致后续刷新必败（微软端点拿不到）
        tokenEndpoint: importResult.data.tokenEndpoint,
        issuerUrl: importResult.data.issuerUrl,
        scopes: importResult.data.scopes,
        profileArn: importResult.data.profileArn
      },
      subscription: {
        type: verifyResult.data.subscriptionType as SubscriptionType,
        title: verifyResult.data.subscriptionTitle,
        rawType: verifyResult.data.subscription?.rawType,
        daysRemaining: verifyResult.data.daysRemaining,
        expiresAt: verifyResult.data.expiresAt,
        managementTarget: verifyResult.data.subscription?.managementTarget,
        upgradeCapability: verifyResult.data.subscription?.upgradeCapability,
        overageCapability: verifyResult.data.subscription?.overageCapability
      },
      usage: {
        current: verifyResult.data.usage.current,
        limit: verifyResult.data.usage.limit,
        percentUsed: verifyResult.data.usage.limit > 0
          ? verifyResult.data.usage.current / verifyResult.data.usage.limit
          : 0,
        lastUpdated: now,
        baseLimit: verifyResult.data.usage.baseLimit,
        baseCurrent: verifyResult.data.usage.baseCurrent,
        freeTrialLimit: verifyResult.data.usage.freeTrialLimit,
        freeTrialCurrent: verifyResult.data.usage.freeTrialCurrent,
        freeTrialExpiry: verifyResult.data.usage.freeTrialExpiry,
        bonuses: verifyResult.data.usage.bonuses,
        nextResetDate: verifyResult.data.usage.nextResetDate,
        resourceDetail: verifyResult.data.usage.resourceDetail
      },
      status: 'active',
      createdAt: now,
      lastUsedAt: now,
      tags: [],
      isActive: true
    }

    set((state) => {
      const accounts = new Map(state.accounts)
      // 取消其它账号的激活状态
      for (const [id, account] of accounts) {
        if (account.isActive) {
          accounts.set(id, { ...account, isActive: false })
        }
      }
      accounts.set(newId, newAccount)
      return { accounts, activeAccountId: newId }
    })
    console.log('[Store] Auto-imported account from local SSO cache:', verifyResult.data.email)
    get().saveToStorage()
  } catch (e) {
    console.warn('[Store] Failed to sync local active account:', e)
  }
}

export function isBannedAccountError(error?: string): boolean {
  if (!error) return false
  const lowerError = error.toLowerCase()
  const hasSuspendedSignal =
    lowerError.includes('accountsuspendedexception') ||
    lowerError.includes('account suspended') ||
    lowerError.includes('temporarily_suspended') ||
    lowerError.includes('temporarily suspended') ||
    (lowerError.includes('user id is') && lowerError.includes('suspended')) ||
    lowerError.includes('账户已封禁') ||
    lowerError.includes('已封禁') ||
    /\b423\b/.test(lowerError)
  if (hasSuspendedSignal) return true
  if (
    lowerError.includes('fetch failed') ||
    lowerError.includes('network') ||
    lowerError.includes('token expired') ||
    lowerError.includes('token 过期') ||
    lowerError.includes('刷新失败') ||
    lowerError.includes('unauthorizedexception')
  ) {
    return false
  }
  return false
}

// 批量测活中止标志：stopLivenessCheck 置 true，worker 循环检测后停止取新账号
let livenessAbortFlag = false

// 定时自动保存定时器（防止数据丢失）
let autoSaveTimer: ReturnType<typeof setInterval> | null = null
const AUTO_SAVE_INTERVAL = 30 * 1000 // 每 30 秒自动保存一次
let lastSaveHash = '' // 用于检测数据是否变化

interface AccountsState {
  // 应用版本号
  appVersion: string

  // 数据
  accounts: Map<string, Account>
  groups: Map<string, AccountGroup>
  tags: Map<string, AccountTag>

  // 当前激活账号
  activeAccountId: string | null

  // 筛选和排序
  filter: AccountFilter
  /** 当前激活的分组 Tab：'all' | 'ungrouped' | <groupId>，互斥 */
  activeGroupTab: string
  sort: AccountSort

  // 选中的账号（用于批量操作）
  selectedIds: Set<string>

  // 加载状态
  isLoading: boolean
  isSyncing: boolean

  /**
   * 本地持有的 accountData revision 快照（T7 · 决策卡 §1 不变量 2）
   * - 每次 loadFromStorage / reloadFromStorageQuiet 从盘面读入
   * - flushSaveImmediately 携带此值传给 main 侧仲裁
   * - 收到广播 accounts-data-changed 时:payload.revision <= 此值 → 忽略（自写回声）· > 此值 → reload
   * - 初始 0 = 未加载 · load 后与磁盘一致
   */
  currentRevision: number

  /**
   * 跨端同步失败且无法自动合并时的用户可见错误（C1 返修）
   * null = 无冲突。非 null 时 UI 应提示用户「你的改动没能保存」——绝不静默丢弃。
   */
  syncError: { code: 'SYNC_CONFLICT_UNRESOLVED'; attempts: number; at: number } | null

  // 批量测活(走反代真实发请求探活/探封禁)进度；null=未运行
  livenessProgress: { done: number; total: number; ok: number; failed: number } | null

  // 自动刷新设置
  autoRefreshEnabled: boolean
  autoRefreshInterval: number // 分钟
  autoRefreshConcurrency: number // 自动刷新并发数
  autoRefreshSyncInfo: boolean // 刷新时是否同步检测账户信息（用量、订阅、封禁状态）
  statusCheckInterval: number // 分钟

  // 主动续期开关（持久化在 main 进程的 electron-store；这里只是镜像，不写 saveToStorage）
  proactiveRenewalEnabled: boolean
  proactiveRenewalLeadMinutes: number

  // 隐私模式
  privacyMode: boolean

  // 使用量显示精度
  usagePrecision: boolean // true: 显示精确小数, false: 显示整数

  // 代理设置
  proxyEnabled: boolean
  proxyUrl: string // 格式: http://host:port 或 socks5://host:port

  // 自动换号设置
  autoSwitchEnabled: boolean
  autoSwitchThreshold: number // 余额阈值，低于此值时自动切换
  autoSwitchInterval: number // 检查间隔（分钟）
  /** main 已持久化的最后一条自动换号命令；renderer 只幂等执行，不参与选号。 */
  autoSwitchDecision: MainAutoSwitchDecision | null

  // 批量导入设置
  batchImportConcurrency: number // 批量导入并发数

  // 登录浏览器隐私模式
  loginPrivateMode: boolean // 登录时使用浏览器隐私/无痕模式

  // 切号目标设置
  switchTarget: 'ide' | 'cli' | 'both' // ide=仅 Kiro IDE, cli=仅 Kiro CLI, both=两者都切

  // 主题设置
  theme: string // 主题名称: default, purple, emerald, orange, rose, cyan, amber
  darkMode: boolean // 深色模式

  // 语言设置
  language: 'auto' | 'en' | 'zh' // auto: 跟随系统

  // 机器码管理
  machineIdConfig: {
    autoSwitchOnAccountChange: boolean // 切号时自动更换机器码
    bindMachineIdToAccount: boolean // 账户机器码绑定
    useBindedMachineId: boolean // 使用绑定的机器码（否则随机生成）
  }
  currentMachineId: string // 当前机器码
  originalMachineId: string | null // 备份的原始机器码
  originalBackupTime: number | null // 原始机器码备份时间
  accountMachineIds: Record<string, string> // 账户绑定的机器码映射
  machineIdHistory: Array<{
    id: string
    machineId: string
    timestamp: number
    action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
    accountId?: string
    accountEmail?: string
  }>

  // ============ 代理池（用于注册时 IP 轮换）============
  /** 代理条目列表（Map 保证 O(1) 查找） */
  proxyPool: Map<string, ProxyEntry>
  /** 代理池配置（启用状态、调度策略等） */
  proxyPoolConfig: ProxyPoolConfig
  /** 轮询调度光标（仅用于 round_robin 策略） */
  proxyPoolCursor: number
  /** 账号-代理绑定映射（accountId → proxyId）；用于"反代时 N 个账号共用 1 个 IP" */
  accountProxyBindings: Record<string, string>
}

interface AccountsActions {
  // 账号 CRUD
  addAccount: (account: Omit<Account, 'id' | 'createdAt' | 'isActive'>) => string
  updateAccount: (id: string, updates: Partial<Account>) => void
  removeAccount: (id: string) => void
  removeAccounts: (ids: string[]) => BatchOperationResult

  // 激活账号
  setActiveAccount: (id: string | null) => void
  getActiveAccount: () => Account | null

  // 分组操作
  addGroup: (group: Omit<AccountGroup, 'id' | 'createdAt' | 'order'>) => string
  updateGroup: (id: string, updates: Partial<AccountGroup>) => void
  removeGroup: (id: string) => void
  moveAccountsToGroup: (accountIds: string[], groupId: string | undefined) => void

  // 标签操作
  addTag: (tag: Omit<AccountTag, 'id'>) => string
  updateTag: (id: string, updates: Partial<AccountTag>) => void
  removeTag: (id: string) => void
  addTagToAccounts: (accountIds: string[], tagId: string) => void
  removeTagFromAccounts: (accountIds: string[], tagId: string) => void

  // 筛选和排序
  setFilter: (filter: AccountFilter) => void
  clearFilter: () => void
  setActiveGroupTab: (tab: string) => void
  setSort: (sort: AccountSort) => void
  getFilteredAccounts: () => Account[]

  // 选择操作
  selectAccount: (id: string) => void
  deselectAccount: (id: string) => void
  selectAll: () => void
  deselectAll: () => void
  toggleSelection: (id: string) => void
  getSelectedAccounts: () => Account[]

  // 导入导出
  exportAccounts: (ids?: string[]) => AccountExportData
  importAccounts: (items: AccountImportItem[]) => BatchOperationResult
  importFromExportData: (data: AccountExportData) => BatchOperationResult

  // 状态管理
  updateAccountStatus: (id: string, status: AccountStatus, error?: string) => void
  refreshAccountToken: (id: string) => Promise<boolean>
  batchRefreshTokens: (ids: string[]) => Promise<BatchOperationResult>
  checkAccountStatus: (id: string) => Promise<void>
  batchCheckStatus: (ids: string[]) => Promise<BatchOperationResult>
  /**
   * 批量测活：走反代真实发一条轻量对话探活/探封禁（复用诊断页 diagnose:account-liveness 口径）。
   * 与 batchCheckStatus 区别：后者查管理面接口(GetUsageLimits)，封禁号常仍返回成功而漏判；
   * 本方法走真实对话路径，能抓到"额度还在但实际已封"的号。结果按封禁/掉线精确回写 lastError，
   * 主界面卡片据 isBannedAccountError 渲染"已封禁"。可通过 stopLivenessCheck 中止。
   */
  batchLivenessCheck: (ids: string[]) => Promise<BatchOperationResult>
  /** 中止进行中的批量测活 */
  stopLivenessCheck: () => void

  // 统计
  getStats: () => AccountStats

  // 持久化
  loadFromStorage: () => Promise<void>
  /**
   * 静默重载账号数据（T7 · 决策卡 §1 跨端同步机制）
   *
   * 与 loadFromStorage 的关键差异（recon-revision-sync.md §2 P6 副作用清单）:
   *   - 不设 isLoading = true（不影响 UI loading 态,广播触发的 reload 应静默）
   *   - 不调 syncLocalSsoAccountAsync（防幽灵账号回归:web 端删账号 → 桌面端 reload →
   *     若走 SSO 同步则从本机 SSO 缓存自动重新导入 = 删除失效）
   *   - 不调 startAutoSave / 不做 machineId 迁移（那是首屏一次性动作）
   *   - 但**会**按 before/after 差异唤醒 main 自动换号调度器、重启 token timer、
   *     应用主题 / 切代理（B-I1 返修）——
   *     否则"同步了值但不生效",UI 显示与实际行为不一致
   *
   * ⚠️ 调用前必须确认没有未落盘的本地编辑（`hasPendingLocalEdits()`）:本函数是**整表覆盖**,
   *    在防抖窗内调用会把用户尚未落盘的删除/编辑抹掉（C1-again）。守卫在 syncIfRevisionDrifted。
   */
  reloadFromStorageQuiet: (preloaded?: SyncBlob) => Promise<void>
  /** 防抖触发持久化（推荐：高频 mutation 自动合并写盘） */
  saveToStorage: () => Promise<void>
  /** 立即持久化（用于 beforeunload 或关键操作场景） */
  flushSaveImmediately: () => Promise<FlushSaveResult>

  // 设置
  setAutoRefresh: (enabled: boolean, interval?: number) => void
  setAutoRefreshConcurrency: (concurrency: number) => void
  setAutoRefreshSyncInfo: (enabled: boolean) => void
  /** 调 main 进程的 IPC，同步开启/关闭主动续期；成功后更新本地镜像 */
  setProactiveRenewalEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  /** 从 main 进程读取主动续期开关当前状态 */
  loadProactiveRenewalEnabled: () => Promise<void>
  setStatusCheckInterval: (interval: number) => void

  // 隐私模式
  setPrivacyMode: (enabled: boolean) => void
  maskEmail: (email: string) => string
  maskNickname: (nickname: string | undefined) => string

  // 使用量精度
  setUsagePrecision: (enabled: boolean) => void

  // 代理设置
  setProxy: (enabled: boolean, url?: string) => Promise<void>

  // 主题设置
  setTheme: (theme: string) => void
  setDarkMode: (enabled: boolean) => void
  applyTheme: () => void

  // 语言设置
  setLanguage: (language: 'auto' | 'en' | 'zh') => void

  // 自动换号
  setAutoSwitch: (enabled: boolean, threshold?: number, interval?: number) => void

  // 批量导入并发数
  setBatchImportConcurrency: (concurrency: number) => void

  // 登录浏览器隐私模式
  setLoginPrivateMode: (enabled: boolean) => void

  // 切号目标设置
  setSwitchTarget: (target: 'ide' | 'cli' | 'both') => void

  // 自动 Token 刷新
  startAutoTokenRefresh: () => void
  stopAutoTokenRefresh: () => void
  checkAndRefreshExpiringTokens: () => Promise<void>
  refreshExpiredTokensOnly: () => Promise<void>
  triggerBackgroundRefresh: () => Promise<void>
  handleBackgroundRefreshResult: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  handleBackgroundCheckResult: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  /** 批量处理后台刷新结果：一次 set 应用 N 条结果，消除 N 次 Map 全量复制 */
  applyBackgroundRefreshResults: (items: Array<{ id: string; success: boolean; data?: unknown; error?: string }>) => void
  /** 批量处理后台检查结果：一次 set 应用 N 条结果 */
  applyBackgroundCheckResults: (items: Array<{ id: string; success: boolean; data?: unknown; error?: string }>) => void

  // 定时自动保存（防止数据丢失）
  startAutoSave: () => void
  stopAutoSave: () => void

  // 机器码管理
  setMachineIdConfig: (config: Partial<{
    autoSwitchOnAccountChange: boolean
    bindMachineIdToAccount: boolean
    useBindedMachineId: boolean
  }>) => void
  refreshCurrentMachineId: () => Promise<void>
  changeMachineId: (newMachineId?: string) => Promise<boolean>
  restoreOriginalMachineId: () => Promise<boolean>
  bindMachineIdToAccount: (accountId: string, machineId?: string) => void
  getMachineIdForAccount: (accountId: string) => string | null
  backupOriginalMachineId: () => void
  clearMachineIdHistory: () => void

  // ============ 代理池操作 ============
  /** 添加单个代理（自动解析协议/主机/端口/认证） */
  addProxy: (url: string, options?: { label?: string; source?: string; tags?: string[] }) => string | null
  /** 批量导入（文本，每行一个，支持 http://host:port、socks5://user:pass@host:port、host:port 等） */
  importProxies: (text: string) => { added: number; skipped: number; failed: number }
  /** 删除代理 */
  removeProxy: (id: string) => void
  /** 批量删除 */
  removeProxies: (ids: string[]) => void
  /** 切换启用状态 */
  toggleProxyEnabled: (id: string, enabled?: boolean) => void
  /** 更新代理元数据 */
  updateProxy: (id: string, updates: Partial<ProxyEntry>) => void
  /** 测试单个代理（异步，主进程执行） */
  validateProxy: (id: string) => Promise<ProxyValidationResult>
  /** 批量测试（并发） */
  validateProxiesBatch: (ids: string[], concurrency?: number) => Promise<void>
  /** 清空所有代理 */
  clearProxyPool: () => void
  /** 更新代理池配置 */
  setProxyPoolConfig: (config: Partial<ProxyPoolConfig>) => void
  /** 按当前策略挑选下一个可用代理（注册流程内部调用） */
  pickNextProxy: () => ProxyEntry | null
  /** 标记代理使用结果（供注册流程上报，用于失败计数与自动停用） */
  reportProxyResult: (id: string, success: boolean, boundEmail?: string, errorMsg?: string) => void

  // ============ 账号-代理绑定（反代分桶）============
  /** 把账号绑定到指定代理 */
  bindAccountToProxy: (accountId: string, proxyId: string) => void
  /** 批量绑定（用于批量分配） */
  bindAccountsToProxy: (accountIds: string[], proxyId: string) => void
  /** 解除账号绑定 */
  unbindAccountFromProxy: (accountId: string) => void
  /** 清空全部账号绑定 */
  clearAccountProxyBindings: () => void
  /**
   * 自动分配：把账号按 N:1 比例平均分配到当前启用的代理上
   * @param accountsPerProxy 每个代理承载的账号数；为 0 表示尽量均分
   * @param onlyUnbound 是否仅分配尚未绑定的账号；false 则重新分配全部
   * @returns 分配统计
   */
  autoDistributeAccountsToProxies: (params: {
    accountsPerProxy?: number
    onlyUnbound?: boolean
    accountIds?: string[]  // 限定分配范围，不填则全部
  }) => { distributed: number; perProxy: Record<string, number>; skipped: number }
  /** 读取账号绑定的代理 URL（供主进程同步用） */
  getAccountProxyUrl: (accountId: string) => string | undefined

  // ============ 账号池热切换(反代运行中不 stop · 2026-07-23 hot-swap-accounts)============

  /** 热切换:反代运行中强制下一次请求使用指定账号 */
  switchProxyActiveAccount: (accountId: string) => Promise<{ success: boolean; error?: string }>

  /**
   * 将「当前该用哪个账号」传播到反代(唯一收口点)
   * 所有桌面反代切号入口(账号卡 / 列表行 / main 自动换号决定执行 / 反代面板指定)都走这里。
   * 详见 RCA:.archive/2026-07-28/proxy-hot-switch-single-account/
   */
  syncActiveAccountToProxy: (accountId: string) => Promise<{
    applied: boolean
    mode?: 'single' | 'multi'
    reason?: string
  }>

  /** 热编辑账号池成员(add / remove / replace) */
  syncPoolMembersToProxy: (payload: {
    add?: Array<Record<string, unknown>>
    remove?: string[]
    replace?: Array<Record<string, unknown>>
  }) => Promise<{ success: boolean; addedCount?: number; removedCount?: number; poolSize?: number; error?: string }>

  // ==================== 跨端同步（C1 / A-I2 / I3 返修） ====================

  /**
   * 记录一次收到的外部 revision（A-I2 返修）。
   *
   * 为什么需要:原实现里 isSyncing 反检命中后直接 return,**不留任何痕迹** ⇒
   * 本机写入随后把本地 revision 推到更高值,那条被吞的外部改动此后再也不会被 reload
   * （revision 反检永久失效）。用户若不再编辑,就永远看不到它。
   *
   * @param selfOrigin true = 这条广播是本窗口自己写入产生的回声,无需补拉
   */
  noteExternalRevision: (revision: number, opts?: { selfOrigin?: boolean }) => void

  /**
   * 对账:若存在被吞过的外部 revision 且本地盘面确实落后,补拉一次（A-I2 返修）。
   * 在 flushSaveImmediately 结束后 / 窗口聚焦时调用。
   */
  reconcilePendingExternalRevision: () => Promise<void>

  /**
   * 兜底同步（I3 返修 · 决策卡「跨端同步机制」表格要求）:
   * 比对磁盘 revision 与本地 revision,不一致才整表拉取。广播丢失时的安全网。
   *
   * @returns true = 本次确实与盘面对齐了（含"无漂移,无需动作"）;
   *          false = 没对上（被 dirty 守卫挡下 / 读盘失败 / 盘面为空）。
   *          调用方据此决定「待对账账本」能否清除（I5）—— 本函数的 catch 只 warn 不抛,
   *          所以失败**无法**通过 await 抛错感知,必须靠这个返回值。
   */
  syncIfRevisionDrifted: () => Promise<boolean>

  /**
   * 「内存里有未落盘的本地编辑」（C1-again 返修）。
   *
   * 所有 reload 通道的守卫判据。**不要用 isSyncing 代替** —— 后者只表示 IPC 在途,
   * 覆盖不到防抖窗（500ms,最长 5000ms）,而用户的删除恰恰在那段时间只存在于内存里。
   */
  hasPendingLocalEdits: () => boolean

  /**
   * 收到 kiro-ide-token-changed 后的同步（C1-again · 第 4 条 reload 通道）。
   * 与广播 / 聚焦 / 轮询共用同一套 dirty 守卫 + revision 比对,不再无条件 loadFromStorage。
   */
  syncAfterIdeTokenChanged: () => Promise<void>

  /** 清除跨端同步冲突提示（C2:UI 弹窗告知用户后调用,避免重复弹） */
  clearSyncError: () => void
}

type AccountsStore = AccountsState & AccountsActions

/** 反代账号同步载荷(与 preload proxySyncAccounts / updateProxyPoolMembers 的入参契约一致) */
export interface ProxyAccountPayload {
  id: string
  email?: string
  accessToken: string
  refreshToken?: string
  profileArn?: string
  expiresAt?: number
  machineId?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  provider?: string
  tokenEndpoint?: string
  issuerUrl?: string
  scopes?: string
  groupId?: string
  weight?: number
}

/**
 * Account → 反代 ProxyAccount 载荷的唯一字段映射真源(SSOT)
 * 消费者:ProxyPanel.syncAccounts(全量同步) + syncActiveAccountToProxy(单账号热切换)
 * 加字段时只改这里 —— 曾经这份映射内联在 ProxyPanel 里,新增消费者极易漏字段(E-055 母题)
 */
export function toProxyAccount(acc: Account): ProxyAccountPayload {
  return {
    id: acc.id,
    email: acc.email,
    accessToken: acc.credentials.accessToken,
    refreshToken: acc.credentials?.refreshToken,
    profileArn: acc.profileArn || acc.credentials?.profileArn,
    expiresAt: acc.credentials?.expiresAt,
    machineId: acc.machineId,
    // Token 刷新所需字段
    clientId: acc.credentials?.clientId,
    clientSecret: acc.credentials?.clientSecret,
    region: acc.credentials?.region || 'us-east-1',
    authMethod: acc.credentials?.authMethod,
    provider: acc.credentials?.provider || acc.idp,
    // external_idp (Azure AD) 反代刷新需微软端点
    tokenEndpoint: acc.credentials?.tokenEndpoint,
    issuerUrl: acc.credentials?.issuerUrl,
    scopes: acc.credentials?.scopes,
    // 透传分组 ID：后端 getAvailableAccount 可据此做二次过滤（双保险）
    groupId: acc.groupId,
    // v1.7.6 SWRR 权重(缺省 100)
    weight: typeof acc.weight === 'number' ? acc.weight : 100
  }
}

// 默认排序
const defaultSort: AccountSort = { field: 'lastUsedAt', order: 'desc' }

// 默认筛选
const defaultFilter: AccountFilter = {}

// 从 localStorage 恢复分组 Tab（遵循 Electron renderer 环境总是可用）
const loadActiveGroupTab = (): string => {
  try {
    return localStorage.getItem('accounts_activeGroupTab') || 'all'
  } catch {
    return 'all'
  }
}

export const useAccountsStore = create<AccountsStore>()((set, get) => ({
  // 初始状态
  appVersion: '1.0.0',
  accounts: new Map(),
  groups: new Map(),
  tags: new Map(),
  activeAccountId: null,
  filter: defaultFilter,
  activeGroupTab: loadActiveGroupTab(),
  sort: defaultSort,
  selectedIds: new Set(),
  isLoading: false,
  isSyncing: false,
  currentRevision: 0,
  syncError: null,
  livenessProgress: null,
  autoSwitchDecision: null,
  // I7:持久化设置字段一律取 DEFAULT_SETTINGS,不再与 keep() 的 fallback 各写一份字面量
  ...DEFAULT_SETTINGS,
  proactiveRenewalEnabled: false,
  proactiveRenewalLeadMinutes: 15,

  currentMachineId: '',
  originalMachineId: null,
  originalBackupTime: null,

  // 代理池初始状态
  proxyPool: new Map<string, ProxyEntry>(),
  proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG },
  proxyPoolCursor: 0,
  accountProxyBindings: {},

  // ==================== 账号 CRUD ====================

  addAccount: (accountData) => {
    const id = uuidv4()
    const now = Date.now()

    // 如果没有提供 machineId，自动生成一个随机的 64 位十六进制设备 ID
    const machineId = accountData.machineId || generateRandomMachineId()

    const account: Account = {
      ...accountData,
      id,
      machineId,
      createdAt: now,
      lastUsedAt: now,
      isActive: false,
      tags: accountData.tags || []
    }

    set((state) => {
      const accounts = new Map(state.accounts)
      accounts.set(id, account)
      return { accounts }
    })

    get().saveToStorage()
    return id
  },

  updateAccount: (id, updates) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, { ...account, ...updates })
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  removeAccount: (id) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      accounts.delete(id)

      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)

      const activeAccountId = state.activeAccountId === id ? null : state.activeAccountId

      // 同时清理账号-代理绑定
      const bindings = { ...state.accountProxyBindings }
      delete bindings[id]

      return { accounts, selectedIds, activeAccountId, accountProxyBindings: bindings }
    })
    get().saveToStorage()
  },

  removeAccounts: (ids) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    set((state) => {
      const accounts = new Map(state.accounts)
      const selectedIds = new Set(state.selectedIds)
      let activeAccountId = state.activeAccountId
      const bindings = { ...state.accountProxyBindings }

      for (const id of ids) {
        if (accounts.has(id)) {
          accounts.delete(id)
          selectedIds.delete(id)
          delete bindings[id]
          if (activeAccountId === id) activeAccountId = null
          result.success++
        } else {
          result.failed++
          result.errors.push({ id, error: 'Account not found' })
        }
      }

      return { accounts, selectedIds, activeAccountId, accountProxyBindings: bindings }
    })

    get().saveToStorage()
    return result
  },

  // ==================== 激活账号 ====================

  setActiveAccount: async (id) => {
    const state = get()
    
    set((s) => {
      const accounts = new Map(s.accounts)

      // 取消之前的激活状态
      if (s.activeAccountId) {
        const prev = accounts.get(s.activeAccountId)
        if (prev) {
          accounts.set(s.activeAccountId, { ...prev, isActive: false })
        }
      }

      // 设置新的激活状态
      if (id) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, { ...account, isActive: true, lastUsedAt: Date.now() })
        }
      }

      return { accounts, activeAccountId: id }
    })
    
    // 切换账号时自动更换机器码（如果启用）
    if (id && state.machineIdConfig.autoSwitchOnAccountChange) {
      try {
        const account = state.accounts.get(id)
        
        if (state.machineIdConfig.bindMachineIdToAccount) {
          // 使用账户绑定的机器码
          let boundMachineId = state.accountMachineIds[id]
          
          if (!boundMachineId) {
            // 如果没有绑定机器码，为该账户生成一个
            boundMachineId = await window.api.machineIdGenerateRandom()
            get().bindMachineIdToAccount(id, boundMachineId)
          }
          
          if (state.machineIdConfig.useBindedMachineId) {
            // 使用绑定的机器码
            await get().changeMachineId(boundMachineId)
          } else {
            // 随机生成新机器码
            await get().changeMachineId()
          }
        } else {
          // 每次切换都随机生成新机器码
          await get().changeMachineId()
        }
        
        // 更新历史记录
        const newMachineId = get().currentMachineId
        set((s) => ({
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: newMachineId,
              timestamp: Date.now(),
              action: 'auto_switch' as const,
              accountId: id,
              accountEmail: account?.email
            }
          ]
        }))
        
        console.log(`[MachineId] Auto-switched machine ID for account: ${account?.email}`)
      } catch (error) {
        console.error('[MachineId] Failed to auto-switch machine ID:', error)
      }
    }
    
    get().saveToStorage()
  },

  getActiveAccount: () => {
    const { accounts, activeAccountId } = get()
    return activeAccountId ? accounts.get(activeAccountId) ?? null : null
  },

  // ==================== 分组操作 ====================

  addGroup: (groupData) => {
    const id = uuidv4()
    const { groups } = get()

    const group: AccountGroup = {
      ...groupData,
      id,
      order: groups.size,
      createdAt: Date.now()
    }

    set((state) => {
      const groups = new Map(state.groups)
      groups.set(id, group)
      return { groups }
    })

    get().saveToStorage()
    return id
  },

  updateGroup: (id, updates) => {
    set((state) => {
      const groups = new Map(state.groups)
      const group = groups.get(id)
      if (group) {
        groups.set(id, { ...group, ...updates })
      }
      return { groups }
    })
    get().saveToStorage()
  },

  removeGroup: (id) => {
    set((state) => {
      const groups = new Map(state.groups)
      groups.delete(id)

      // 移除账号的分组引用
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.groupId === id) {
          accounts.set(accountId, { ...account, groupId: undefined })
        }
      }

      return { groups, accounts }
    })
    get().saveToStorage()
  },

  moveAccountsToGroup: (accountIds, groupId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, { ...account, groupId })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== 标签操作 ====================

  addTag: (tagData) => {
    const id = uuidv4()

    const tag: AccountTag = { ...tagData, id }

    set((state) => {
      const tags = new Map(state.tags)
      tags.set(id, tag)
      return { tags }
    })

    get().saveToStorage()
    return id
  },

  updateTag: (id, updates) => {
    set((state) => {
      const tags = new Map(state.tags)
      const tag = tags.get(id)
      if (tag) {
        tags.set(id, { ...tag, ...updates })
      }
      return { tags }
    })
    get().saveToStorage()
  },

  removeTag: (id) => {
    set((state) => {
      const tags = new Map(state.tags)
      tags.delete(id)

      // 移除账号的标签引用
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.tags.includes(id)) {
          accounts.set(accountId, {
            ...account,
            tags: account.tags.filter((t) => t !== id)
          })
        }
      }

      return { tags, accounts }
    })
    get().saveToStorage()
  },

  addTagToAccounts: (accountIds, tagId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account && !account.tags.includes(tagId)) {
          accounts.set(id, { ...account, tags: [...account.tags, tagId] })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  removeTagFromAccounts: (accountIds, tagId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, {
            ...account,
            tags: account.tags.filter((t) => t !== tagId)
          })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== 筛选和排序 ====================

  setFilter: (filter) => {
    set({ filter })
  },

  clearFilter: () => {
    set({ filter: defaultFilter })
  },

  setActiveGroupTab: (tab) => {
    try { localStorage.setItem('accounts_activeGroupTab', tab) } catch { /* no-op */ }
    set({ activeGroupTab: tab })
  },

  setSort: (sort) => {
    set({ sort })
  },

  getFilteredAccounts: () => {
    const { accounts, filter, sort, activeGroupTab } = get()

    // 引用缓存命中：返回上次结果（数组同引用，便于消费方 useMemo 复用）
    if (
      _filterCache &&
      _filterCache.accounts === accounts &&
      _filterCache.filter === filter &&
      _filterCache.sort === sort &&
      _filterCache.activeGroupTab === activeGroupTab
    ) {
      return _filterCache.output
    }

    let result = Array.from(accounts.values())

    // 优先按分组 Tab 互斥过滤（与 filter.groupIds 独立）
    if (activeGroupTab === 'ungrouped') {
      result = result.filter((a) => !a.groupId)
    } else if (activeGroupTab !== 'all') {
      result = result.filter((a) => a.groupId === activeGroupTab)
    }

    // 应用筛选
    if (filter.search) {
      const search = filter.search.toLowerCase()
      result = result.filter(
        (a) =>
          a.email.toLowerCase().includes(search) ||
          a.nickname?.toLowerCase().includes(search)
      )
    }

    if (filter.subscriptionTypes?.length) {
      result = result.filter((a) => filter.subscriptionTypes!.includes(a.subscription.type))
    }

    if (filter.statuses?.length) {
      result = result.filter((a) => filter.statuses!.includes(a.status))
    }

    if (filter.idps?.length) {
      result = result.filter((a) => filter.idps!.includes(a.idp))
    }

    if (filter.groupIds?.length) {
      result = result.filter((a) => a.groupId && filter.groupIds!.includes(a.groupId))
    }

    if (filter.tagIds?.length) {
      result = result.filter((a) => filter.tagIds!.some((t) => a.tags.includes(t)))
    }

    if (filter.emailDomains?.length) {
      result = result.filter((a) => {
        const atIndex = a.email.lastIndexOf('@')
        if (atIndex < 0) return false
        const domain = a.email.slice(atIndex + 1).toLowerCase()
        return filter.emailDomains!.includes(domain)
      })
    }

    if (filter.usageMin !== undefined) {
      result = result.filter((a) => a.usage.percentUsed >= filter.usageMin!)
    }

    if (filter.usageMax !== undefined) {
      result = result.filter((a) => a.usage.percentUsed <= filter.usageMax!)
    }

    if (filter.daysRemainingMin !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining >= filter.daysRemainingMin!
      )
    }

    if (filter.daysRemainingMax !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining <= filter.daysRemainingMax!
      )
    }

    // 封禁筛选
    if (filter.bannedOnly) {
      result = result.filter((a) => isBannedAccountError(a.lastError))
    }

    // 应用排序
    result.sort((a, b) => {
      let cmp = 0

      switch (sort.field) {
        case 'email':
          cmp = a.email.localeCompare(b.email)
          break
        case 'nickname':
          cmp = (a.nickname ?? '').localeCompare(b.nickname ?? '')
          break
        case 'subscription':
          cmp = a.subscription.type.localeCompare(b.subscription.type)
          break
        case 'usage':
          cmp = a.usage.percentUsed - b.usage.percentUsed
          break
        case 'daysRemaining':
          cmp = (a.subscription.daysRemaining ?? 999) - (b.subscription.daysRemaining ?? 999)
          break
        case 'lastUsedAt':
          cmp = a.lastUsedAt - b.lastUsedAt
          break
        case 'createdAt':
          cmp = a.createdAt - b.createdAt
          break
        case 'status':
          cmp = a.status.localeCompare(b.status)
          break
      }

      return sort.order === 'desc' ? -cmp : cmp
    })

    // 写入缓存：下次相同输入直接命中
    _filterCache = { accounts, filter, sort, activeGroupTab, output: result }
    return result
  },

  // ==================== 选择操作 ====================

  selectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.add(id)
      return { selectedIds }
    })
  },

  deselectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)
      return { selectedIds }
    })
  },

  selectAll: () => {
    const filtered = get().getFilteredAccounts()
    set({ selectedIds: new Set(filtered.map((a) => a.id)) })
  },

  deselectAll: () => {
    set({ selectedIds: new Set() })
  },

  toggleSelection: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      if (selectedIds.has(id)) {
        selectedIds.delete(id)
      } else {
        selectedIds.add(id)
      }
      return { selectedIds }
    })
  },

  getSelectedAccounts: () => {
    const { accounts, selectedIds } = get()
    return Array.from(selectedIds)
      .map((id) => accounts.get(id))
      .filter((a): a is Account => a !== undefined)
  },

  // ==================== 导入导出 ====================

  exportAccounts: (ids) => {
    const { accounts, groups, tags } = get()

    let exportAccounts: Account[]
    if (ids?.length) {
      exportAccounts = ids
        .map((id) => accounts.get(id))
        .filter((a): a is Account => a !== undefined)
    } else {
      exportAccounts = Array.from(accounts.values())
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const data: AccountExportData = {
      version: get().appVersion,
      exportedAt: Date.now(),
      accounts: exportAccounts.map(({ isActive, ...rest }) => rest),
      groups: Array.from(groups.values()),
      tags: Array.from(tags.values())
    }

    return data
  },

  importAccounts: (items) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    // 验证 idp 是否有效
    // 扩展白名单：加 Enterprise/AzureAD/ExternalIdp/IAM_SSO（external_idp 账户入库必需）
    const validIdps = ['Google', 'Github', 'BuilderId', 'Enterprise', 'AzureAD', 'ExternalIdp', 'IAM_SSO'] as const
    const normalizeIdp = (idp?: string): IdpType => {
      if (!idp) return 'Google'
      const normalized = validIdps.find(v => v.toLowerCase() === idp.toLowerCase())
      return normalized || 'Google'
    }

    // 批量构造账号对象 + 一次 set，避免 N 次 new Map(O(n²)) 与 N 次 re-render
    const newAccounts: Account[] = []
    for (const item of items) {
      try {
        const now = Date.now()
        const id = uuidv4()
        const machineId = generateRandomMachineId()

        // expiresAt 秒/毫秒兼容：kiro-go/CLIProxyAPI 导出是秒级 Unix，项目内部统一毫秒
        // 阈值 1e12≈ 2001-09-09 的毫秒，秒级时间戳(~1.78e9) 远小于它，毫秒级(~1.78e12) 则大于
        const rawExpires = (item as { expiresAt?: number }).expiresAt
        const expiresAt = typeof rawExpires === 'number' && rawExpires > 0
          ? (rawExpires < 1e12 ? rawExpires * 1000 : rawExpires)
          : now + 3600 * 1000

        // AccountImportItem 现已包含 external_idp 必需字段（见 types/account.ts），直接取
        const itemExt = item as {
          authMethod?: string
          provider?: string
          tokenEndpoint?: string
          issuerUrl?: string
          scopes?: string
          profileArn?: string
        }

        const account: Account = {
          id,
          createdAt: now,
          isActive: false,
          machineId,
          email: item.email,
          password: item.password,
          nickname: item.nickname,
          idp: normalizeIdp(item.idp as string),
          profileArn: itemExt.profileArn,
          credentials: {
            accessToken: item.accessToken || '',
            csrfToken: item.csrfToken || '',
            refreshToken: item.refreshToken,
            clientId: item.clientId,
            clientSecret: item.clientSecret,
            region: item.region || 'us-east-1',
            expiresAt,
            // external_idp / 其他 账户的完整 credentials 字段（之前丢了导致入库即废）
            authMethod: itemExt.authMethod as 'IdC' | 'social' | 'external_idp' | undefined,
            provider: itemExt.provider as 'BuilderId' | 'Enterprise' | 'Github' | 'Google' | 'IAM_SSO' | 'AzureAD' | 'ExternalIdp' | undefined,
            tokenEndpoint: itemExt.tokenEndpoint,
            issuerUrl: itemExt.issuerUrl,
            scopes: itemExt.scopes,
            profileArn: itemExt.profileArn
          },
          subscription: {
            type: 'Free'
          },
          usage: {
            current: 0,
            limit: 25,
            percentUsed: 0,
            lastUpdated: now
          },
          groupId: item.groupId,
          tags: item.tags ?? [],
          status: 'unknown',
          lastUsedAt: now
        }
        newAccounts.push(account)
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: item.email,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    if (newAccounts.length > 0) {
      set((state) => {
        // 仅一次完整 Map 复制
        const accounts = new Map(state.accounts)
        for (const account of newAccounts) {
          accounts.set(account.id, account)
        }
        return { accounts }
      })
      // 防抖触发一次持久化
      get().saveToStorage()
    }

    return result
  },

  importFromExportData: (data) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }
    const { accounts: existingAccounts } = get()
    
    // 检查账户是否已存在（同userId 视为主键;副键扩为 email + provider + profileArn 三元组）
    // 2026-07-13 多 profile 支持:同 email + 同 provider + 不同 profileArn 视为不同账户
    //   - 传入 profileArn 时:三元组完全相同才算重复(允许多 profile 并存)
    //   - 未传 profileArn 时:维持旧副键 (email, provider),向后兼容 OIDC / BuilderId / Social 等无 profile 概念的登录
    // TODO(下轮): 与 AddAccountDialog:65-74 的同名闭包函数收敛为单一 helper(§SSOT 债务台账已登记)
    const isAccountExists = (email: string, userId?: string, provider?: string, profileArn?: string): boolean => {
      return Array.from(existingAccounts.values()).some(acc => {
        // userId 相同则重复
        if (userId && acc.userId === userId) return true
        // email 相同且 provider 相同 → 进入三元组判定
        if (acc.email === email && acc.credentials.provider === provider) {
          // 传入 profileArn:必须完全相同才算重复
          if (profileArn !== undefined && profileArn !== '') {
            return acc.credentials.profileArn === profileArn
          }
          // 未传 profileArn:维持旧副键行为(向后兼容)
          return true
        }
        return false
      })
    }
    
    // 去重：文件内部去重
    const seenEmails = new Set<string>()
    const seenUserIds = new Set<string>()
    const uniqueAccounts = data.accounts.filter(acc => {
      if (seenEmails.has(acc.email) || (acc.userId && seenUserIds.has(acc.userId))) {
        return false
      }
      seenEmails.add(acc.email)
      if (acc.userId) seenUserIds.add(acc.userId)
      return true
    })

    // 收集所有变更，一次性 set，避免 N 次 new Map（O(n²)）
    let skipped = 0
    const accountsToAdd: Account[] = []

    for (const accountData of uniqueAccounts) {
      // 检查本地是否已存在（传入 provider + profileArn,§三元组副键）
      if (isAccountExists(accountData.email, accountData.userId, accountData.credentials?.provider, accountData.credentials?.profileArn)) {
        skipped++
        continue
      }
      try {
        accountsToAdd.push({ ...accountData, isActive: false })
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: accountData.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    // 一次 set 应用所有分组、标签、账号 — 单次 re-render
    if (data.groups.length > 0 || data.tags.length > 0 || accountsToAdd.length > 0) {
      set((state) => {
        const groups = data.groups.length > 0 ? new Map(state.groups) : state.groups
        if (data.groups.length > 0) {
          for (const group of data.groups) groups.set(group.id, group)
        }
        const tags = data.tags.length > 0 ? new Map(state.tags) : state.tags
        if (data.tags.length > 0) {
          for (const tag of data.tags) tags.set(tag.id, tag)
        }
        const accounts = accountsToAdd.length > 0 ? new Map(state.accounts) : state.accounts
        if (accountsToAdd.length > 0) {
          for (const acc of accountsToAdd) accounts.set(acc.id, acc)
        }
        return { groups, tags, accounts }
      })
    }

    // 记录跳过数量
    if (skipped > 0) {
      result.errors.push({
        id: 'skipped',
        error: `跳过 ${skipped} 个已存在的账号`
      })
    }

    get().saveToStorage()
    return result
  },

  // ==================== 状态管理 ====================

  updateAccountStatus: (id, status, error) => {
    const wasBanned = isBannedAccountError(get().accounts.get(id)?.lastError)
    const isBanned = isBannedAccountError(error)
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, {
          ...account,
          status,
          lastError: error,
          lastCheckedAt: Date.now()
        })
      }
      return { accounts }
    })
    get().saveToStorage()
    // 触发 webhook：账号刚被封禁时通知（已封禁的不重复）
    if (isBanned && !wasBanned) {
      const acc = get().accounts.get(id)
      triggerWebhook('account-banned', {
        title: '账号被封禁',
        message: `账号 ${acc?.email || id} 状态变为封禁`,
        level: 'error',
        fields: { 邮箱: acc?.email || '-', 错误: error || '-' }
      })
    }
  },

  refreshAccountToken: async (id) => {
    const { accounts, updateAccountStatus } = get()
    const account = accounts.get(id)

    if (!account) return false

    // 网页 API Key(ksk_)账户无 token 刷新概念(静态长凭证)：委托到 checkAccountStatus 刷新额度。
    if (account.credentials.authMethod === 'api_key' || account.credentials.provider === 'ApiKey') {
      await get().checkAccountStatus(id)
      return true
    }

    updateAccountStatus(id, 'refreshing')

    try {
      // 通过主进程调用 Kiro API 刷新 Token（避免 CORS）
      const result = await window.api.refreshAccountToken(account)

      if (result.success && result.data) {
        // 当 refresh 后 main 进程检测到该账号是 IDE 当前激活账号，会自动同步到磁盘 token 文件；
        // 否则只更新反代 store，IDE 仍用旧 token —— 提醒用户避免误以为"刷新对 IDE 也生效了"
        if (result.data.syncedToIde) {
          console.log(`[refreshAccountToken] Token refreshed AND synced to Kiro IDE (account=${account.email})`)
        } else {
          console.warn(
            `[refreshAccountToken] Token refreshed but NOT synced to Kiro IDE (account=${account.email}). ` +
              `Reason: ${result.data.syncSkipReason || 'unknown'}. ` +
              `Kiro IDE will still use its previously cached token until its own refresh loop kicks in.`
          )
        }

        set((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(id)
          if (acc) {
            // Enterprise 账号刷新时主进程会返回真实 profileArn，持久化避免后续重复获取
            const resolvedProfileArn = result.data!.profileArn || acc.credentials.profileArn || acc.profileArn
            accounts.set(id, {
              ...acc,
              profileArn: resolvedProfileArn,
              credentials: {
                ...acc.credentials,
                accessToken: result.data!.accessToken,
                // 如果返回了新的 refreshToken，更新它
                refreshToken: result.data!.refreshToken || acc.credentials.refreshToken,
                expiresAt: Date.now() + result.data!.expiresIn * 1000,
                profileArn: resolvedProfileArn
              },
              status: 'active',
              lastError: undefined,
              lastCheckedAt: Date.now()
            })
          }
          return { accounts }
        })
        // ⚠️ 这里**刻意不调 saveToStorage()** —— 落盘已由 main 侧完成。
        //
        // `accountService/refresh.ts:refreshAccountToken` 现在会经
        // `persistRefreshResult` → `applyAccountDataMutation` 把新凭据落盘（IPC 与 web 面板
        // 共用同一条路径）。上面那次 `set()` 保留，它是桌面端「刷完立刻显示新过期时间」
        // 响应性的来源 —— UI 不必等盘。但**再落一次盘就是双写**：
        //
        //   store 的落盘是**整表覆盖 + 防抖**（saveToStorage → 500ms 窗口 →
        //   flushSaveImmediately 带 expectedRevision 提交）。main 侧刚写完时 disk revision
        //   已经 +1，而本窗口的 currentRevision 还是旧值 ⇒ 这次提交必然 STALE ⇒ 走三方合并
        //   重放，白花一次 IPC + 整表序列化 + 合并，产出的内容与盘上已有的完全一致。
        //
        // 那为什么删掉它是安全的（凭据尤其不能出错）:
        //   - `currentRevision` / `syncBaseSnapshot` 的收敛不依赖这次写：main 侧写入成功后
        //     广播 `accounts-data-changed`，App.tsx:150 的 consumer 判定为外部写 →
        //     `reloadFromStorageQuiet` 对齐盘面并更新 base 与 revision。广播万一丢失，
        //     I3 的 focus / visibilitychange / 短轮询（≤6s）兜底。
        //   - 期间若有**别的**未落盘编辑，它们的 flush 撞上更高的 disk revision 时走既有的
        //     三方合并；而 credentials 有 `syncMerge.ts:184` 的**字段级例外**（I-a）：
        //     「我没改过凭据而别人改了」⇒ 采纳 theirs ⇒ 新 refreshToken 不会被本地陈旧
        //     快照按回旧值。那个例外存在的理由正是"凭据的权威源在 main 侧"。
        //
        // 不动本函数开头的 `updateAccountStatus(id,'refreshing')` 那次落盘：那是多调用方
        // 共享的通用 setter，改它会溢出本轮范围；它写 status 而非 credentials。已登记为技术债。
        return true
      } else {
        updateAccountStatus(id, 'error', result.error?.message)
        // 触发 webhook：Token 刷新失败
        triggerWebhook('token-expired', {
          title: 'Token 刷新失败',
          message: `账号 ${account.email} Token 刷新失败`,
          level: 'warn',
          fields: { 邮箱: account.email, 错误: result.error?.message || '-' }
        })
        return false
      }
    } catch (error) {
      updateAccountStatus(id, 'error', error instanceof Error ? error.message : 'Unknown error')
      return false
    }
  },

  batchRefreshTokens: async (ids) => {
    const { accounts, autoRefreshConcurrency } = get()

    // 网页 API Key(ksk_)账号：静态长凭证无 refreshToken，不能走 token 刷新，
    // 但可委托 checkAccountStatus 拉最新额度/订阅（与单账号 refreshAccountToken 行为一致）。
    // 若不单独处理，下面 `!refreshToken → continue` 会把它们静默跳过，
    // 导致「分组里全是/多为 API Key 账号时，点批量刷新毫无反应」。
    const apiKeyIds: string[] = []

    // 收集需要刷新的账号
    const accountsToRefresh: Array<{
      id: string
      email: string
      profileArn?: string
      credentials: {
        refreshToken: string
        clientId?: string
        clientSecret?: string
        region?: string
        authMethod?: string
        accessToken?: string
        provider?: string
        profileArn?: string
        tokenEndpoint?: string
        issuerUrl?: string
        scopes?: string
      }
    }> = []

    for (const id of ids) {
      const account = accounts.get(id)
      if (!account) continue

      // API Key(ksk_)账号：无 token 刷新概念，改走 checkAccountStatus 刷新额度
      if (account.credentials.authMethod === 'api_key' || account.credentials.provider === 'ApiKey') {
        apiKeyIds.push(id)
        continue
      }

      if (!account.credentials.refreshToken) continue
      
      accountsToRefresh.push({
        id,
        email: account.email,
        profileArn: account.profileArn,
        credentials: {
          refreshToken: account.credentials.refreshToken,
          clientId: account.credentials.clientId,
          clientSecret: account.credentials.clientSecret,
          region: account.credentials.region,
          authMethod: account.credentials.authMethod,
          accessToken: account.credentials.accessToken,
          provider: account.credentials.provider || account.idp,
          profileArn: account.credentials.profileArn,
          // external_idp 刷新走微软端点，必须带这些字段，否则报"缺少 tokenEndpoint"
          tokenEndpoint: account.credentials.tokenEndpoint,
          issuerUrl: account.credentials.issuerUrl,
          scopes: account.credentials.scopes
        }
      })
    }

    // API Key 账号并发刷新额度（走 checkAccountStatus）；与 token 刷新并行
    const apiKeyConcurrency = Math.max(1, Math.min(autoRefreshConcurrency || 3, 5))
    const runApiKeyRefresh = async (): Promise<{ ok: number; fail: number }> => {
      let ok = 0
      let fail = 0
      const queue = [...apiKeyIds]
      const worker = async (): Promise<void> => {
        for (;;) {
          const id = queue.shift()
          if (!id) break
          try {
            await get().checkAccountStatus(id)
            ok++
          } catch {
            fail++
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(apiKeyConcurrency, apiKeyIds.length) }, () => worker())
      )
      return { ok, fail }
    }

    // 两类账号都没有 → 直接返回
    if (accountsToRefresh.length === 0 && apiKeyIds.length === 0) {
      return { success: 0, failed: 0, errors: [] }
    }

    console.log(
      `[BatchRefresh] Triggering refresh: ${accountsToRefresh.length} token accounts + ${apiKeyIds.length} API Key accounts...`
    )

    // 后台 token 刷新 与 API Key 额度刷新 并行执行
    const [tokenResult, apiKeyResult] = await Promise.all([
      accountsToRefresh.length > 0
        ? window.api.backgroundBatchRefresh(accountsToRefresh, autoRefreshConcurrency)
        : Promise.resolve({ successCount: 0, failedCount: 0 }),
      apiKeyIds.length > 0 ? runApiKeyRefresh() : Promise.resolve({ ok: 0, fail: 0 })
    ])

    return {
      success: tokenResult.successCount + apiKeyResult.ok,
      failed: tokenResult.failedCount + apiKeyResult.fail,
      errors: []
    }
  },

  checkAccountStatus: async (id) => {
    const { updateAccountStatus } = get()
    let account = get().accounts.get(id)

    // store 可能还没追上主进程的盘面:ksk_ 导入下沉共享层后(fce8c89),renderer 不再本地
    // addAccount,新账号靠 main 侧写盘 + `accounts-data-changed` 广播 → App.tsx:150 →
    // reloadFromStorageQuiet 带进来。而 AddAccountDialog 在 importApiKeys resolve 的
    // **同一个 tick** 就调本函数,那条跨进程异步链(广播→读盘→解密→set)往往还没跑完,
    // accounts.get(id) 于是为 undefined。旧实现在此直接 return —— IPC 从未发出、main 侧
    // 的 applyAccountDataMutation 落盘也从未发生 ⇒ 额度永远停在 importApiKey.ts 的占位值
    // { current: 0, limit: 0 },即用户看到的 0/0(手动点「检查账户信息」却能刷出来)。
    //
    // 自愈收口在本函数:先对齐一次盘面再重试。所有调用方受益 —— 不必让每个调用方各自
    // await 广播(那样判据散落多处,且新增调用方仍会再踩一次同一个竞态)。
    if (!account) {
      await get().reloadFromStorageQuiet()
      account = get().accounts.get(id)
    }

    if (!account) {
      // 不再静默:本次 0/0 排查因零日志只能靠通读源码定位,留痕是下次可诊断的前提。
      console.warn(`[Account] checkAccountStatus: account not found after reload, id=${id}`)
      return
    }

    // 网页 API Key(ksk_)账户：静态凭证无 token 刷新,但 getUsageLimits(TokenType: API_KEY)可拉真实额度/订阅/邮箱。
    // 走正常路径 —— 主进程 check-account-status 对 api_key 已有专属分支(仅额度,不刷 token,不误标封禁)。

    // 设置刷新状态，提供视觉反馈
    updateAccountStatus(id, 'refreshing')

    try {
      // 通过主进程调用 Kiro API 获取状态（避免 CORS）
      const result = await window.api.checkAccountStatus(account)

      if (result.success && result.data) {
        set((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(id)
          if (acc) {
            // 如果 token 被刷新，更新凭证
            const updatedCredentials = result.data!.newCredentials 
              ? {
                  ...acc.credentials,
                  accessToken: result.data!.newCredentials.accessToken,
                  refreshToken: result.data!.newCredentials.refreshToken ?? acc.credentials.refreshToken,
                  expiresAt: result.data!.newCredentials.expiresAt ?? acc.credentials.expiresAt
                }
              : acc.credentials

            // 合并 usage 数据，确保包含所有必要字段
            const apiUsage = result.data!.usage
            const mergedUsage = apiUsage ? {
              current: apiUsage.current ?? acc.usage.current,
              limit: apiUsage.limit ?? acc.usage.limit,
              percentUsed: apiUsage.limit > 0 ? apiUsage.current / apiUsage.limit : 0,
              lastUpdated: apiUsage.lastUpdated ?? Date.now(),
              baseLimit: apiUsage.baseLimit,
              baseCurrent: apiUsage.baseCurrent,
              freeTrialLimit: apiUsage.freeTrialLimit,
              freeTrialCurrent: apiUsage.freeTrialCurrent,
              freeTrialExpiry: apiUsage.freeTrialExpiry,
              bonuses: apiUsage.bonuses,
              nextResetDate: apiUsage.nextResetDate,
              resourceDetail: apiUsage.resourceDetail
            } : acc.usage

            // 合并订阅信息
            const apiSub = result.data!.subscription
            const mergedSubscription = apiSub ? {
              ...acc.subscription,
              ...apiSub
            } : acc.subscription

            // 转换 IDP 类型（保持原值优先，只有明确匹配时才更新）
            const apiIdp = result.data!.idp
            let idpType = acc.idp
            if (apiIdp) {
              if (apiIdp === 'BuilderId') idpType = 'BuilderId'
              else if (apiIdp === 'Google') idpType = 'Google'
              else if (apiIdp === 'Github') idpType = 'Github'
              else if (apiIdp === 'AWSIdC') idpType = 'AWSIdC'
              else if (apiIdp === 'Enterprise' || apiIdp === 'Internal') idpType = 'Enterprise'
              // 未知类型保持原值，不强制改为 Internal
            }

            accounts.set(id, {
              ...acc,
              // 更新邮箱（如果 API 返回了）
              email: result.data!.email ?? acc.email,
              userId: result.data!.userId ?? acc.userId,
              idp: idpType,
              status: result.data!.status as AccountStatus,
              usage: mergedUsage,
              subscription: mergedSubscription as AccountSubscription,
              credentials: updatedCredentials,
              lastCheckedAt: Date.now(),
              lastError: undefined
            })
          }
          return { accounts }
        })
        // ⚠️ 这里**刻意不调 saveToStorage()** —— 落盘已由 main 侧完成。
        //
        // W8:`accountService/check.ts:checkAccountStatus` 现在会经
        // `applyAccountDataMutation` 把这次刷新的结果落盘（IPC 与 web 面板共用同一条路径）。
        // 上面那次 `set()` 保留,它是桌面端「额度数字逐条即时更新」响应性的来源 ——
        // UI 不必等盘。但**再落一次盘就是双写**,而且是危险的双写:
        //
        //   store 的落盘是**整表覆盖 + 防抖**（saveToStorage → 500ms 窗口 → flushSaveImmediately
        //   带 expectedRevision 提交）。main 侧刚写完时 disk revision 已经 +1,而本窗口的
        //   currentRevision 还是旧值 ⇒ 这次提交必然 STALE ⇒ 走三方合并重放,白花一次
        //   IPC + 整表序列化 + 合并,产出的内容与盘上已有的完全一致。
        //
        // 那为什么删掉它是安全的（不破坏 store 自己的一致性假设）:
        //   - `currentRevision` / `syncBaseSnapshot` 的收敛不依赖这次写:main 侧写入成功后会
        //     广播 `accounts-data-changed`,App.tsx:150 的 consumer 判定为外部写（本次广播
        //     不带 originId）→ `reloadFromStorageQuiet` 对齐盘面并更新 base 与 revision。
        //     广播万一丢失,I3 的 focus / visibilitychange / 短轮询（≤6s）兜底。
        //   - 期间若有**别的**未落盘编辑,它们有自己的 saveToStorage 在飞,不受影响;
        //     那次 flush 撞上更高的 disk revision 时走既有的三方合并 —— 而 usage 字段在
        //     base 与 ours 里相等（本地没改过它,是 main 侧改的）⇒ 合并采纳 theirs
        //     ⇒ 新额度不会被本地陈旧快照按回旧值。这正是 base 存在的意义。
        //
        // 不动 `updateAccountStatus(id,'refreshing')` 那次落盘（它在本函数开头）:
        // 那是多调用方共享的通用 setter,改它会溢出本轮范围;它写的是 status 而非 usage,
        // 且同样受上面那条合并语义保护。已登记为技术债。

        // 如果刷新了 token，打印日志
        if (result.data.newCredentials) {
          console.log(`[Account] Token refreshed for ${account?.email}`)
        }
      } else {
        // 检查是否是封禁错误
        const isBanned = (result.error as { isBanned?: boolean })?.isBanned
        if (isBanned) {
          // 封禁账户：设置错误状态并标记为封禁
          updateAccountStatus(id, 'error', `账户已封禁: ${result.error?.message}`)
        } else {
          updateAccountStatus(id, 'error', result.error?.message)
        }
      }
    } catch (error) {
      updateAccountStatus(id, 'error', error instanceof Error ? error.message : 'Unknown error')
    }
  },

  batchCheckStatus: async (ids) => {
    const { accounts, autoRefreshConcurrency } = get()
    
    // 收集需要检查的账号（使用批量检查 API，不刷新 Token）
    const accountsToCheck: Array<{
      id: string
      email: string
      profileArn?: string
      credentials: {
        accessToken: string
        refreshToken?: string
        clientId?: string
        clientSecret?: string
        region?: string
        authMethod?: string
        provider?: string
        tokenEndpoint?: string
        issuerUrl?: string
        scopes?: string
      }
      idp?: string
    }> = []

    for (const id of ids) {
      const account = accounts.get(id)
      if (!account?.credentials.accessToken) continue

      accountsToCheck.push({
        id,
        email: account.email,
        // profileArn 顶层字段必须一并透传给主进程，否则 background-batch-check
        // 走 REST GetUsageLimits 会以 undefined profileArn 被 Kiro 后端 400
        // "Improperly formed request"，导致 usage 永远保持初始 0。
        // RCA: .agent-workspace/.archive/2026-07-14/usage-refresh-zero/
        profileArn: account.profileArn || account.credentials.profileArn,
        credentials: {
          accessToken: account.credentials.accessToken,
          refreshToken: account.credentials.refreshToken,
          clientId: account.credentials.clientId,
          clientSecret: account.credentials.clientSecret,
          region: account.credentials.region,
          authMethod: account.credentials.authMethod,
          provider: account.credentials.provider,
          // external_idp 401 重试刷新走微软端点，必须带这些字段
          tokenEndpoint: account.credentials.tokenEndpoint,
          issuerUrl: account.credentials.issuerUrl,
          scopes: account.credentials.scopes
        },
        idp: account.idp
      })
    }

    if (accountsToCheck.length === 0) {
      return { success: 0, failed: 0, errors: [] }
    }

    console.log(`[BatchCheck] Triggering background check for ${accountsToCheck.length} accounts...`)
    
    // 使用后台检查 API（只检查状态，不刷新 Token）
    const result = await window.api.backgroundBatchCheck(accountsToCheck, autoRefreshConcurrency)
    
    return { 
      success: result.successCount, 
      failed: result.failedCount, 
      errors: [] 
    }
  },

  stopLivenessCheck: () => {
    livenessAbortFlag = true
    set({ livenessProgress: null })
  },

  batchLivenessCheck: async (ids) => {
    const { accounts, autoRefreshConcurrency, getAccountProxyUrl, updateAccountStatus } = get()

    // 收集可测活的账号（必须有 accessToken）
    const targets = ids
      .map((id) => accounts.get(id))
      .filter((a): a is Account => !!a?.credentials.accessToken)

    if (targets.length === 0) {
      return { success: 0, failed: 0, errors: [] }
    }

    // 测活模型：沿用诊断页持久化的选择，回退 claude-sonnet-4.5
    let model = 'claude-sonnet-4.5'
    try {
      const saved = localStorage.getItem('kiro-liveness-model')
      if (saved && saved.trim()) model = saved.trim()
    } catch { /* ignore */ }

    livenessAbortFlag = false
    // 并发上限：测活走真实请求消耗额度，控制在较低并发（复用配置，封顶 5）
    const concurrency = Math.max(1, Math.min(autoRefreshConcurrency || 3, 5))

    const errors: { id: string; error: string }[] = []
    let ok = 0
    let failed = 0
    let done = 0
    set({ livenessProgress: { done: 0, total: targets.length, ok: 0, failed: 0 } })

    const queue = [...targets]
    const worker = async (): Promise<void> => {
      for (;;) {
        if (livenessAbortFlag) break
        const acc = queue.shift()
        if (!acc) break

        try {
          const cred = acc.credentials
          const res = await window.api.diagnoseAccountLiveness({
            account: {
              id: acc.id,
              email: acc.email,
              accessToken: cred.accessToken,
              refreshToken: cred.refreshToken,
              clientId: cred.clientId,
              clientSecret: cred.clientSecret,
              region: cred.region,
              authMethod: cred.authMethod,
              provider: cred.provider,
              profileArn: acc.profileArn,
              machineId: acc.machineId,
              expiresAt: cred.expiresAt,
              proxyUrl: getAccountProxyUrl(acc.id)
            },
            model
          })

          if (livenessAbortFlag) break

          if (res.success) {
            // 真实可用：置 active + 清除历史 lastError（顺带解除误标的封禁/错误）
            updateAccountStatus(acc.id, 'active', undefined)
            ok++
          } else {
            const errMsg = res.error || '测活失败'
            // 精确区分封禁 vs 掉线：isBannedAccountError 命中才算封禁，
            // 原始错误文案(含 423/AccountSuspended/TEMPORARILY_SUSPENDED)原样写入 lastError，
            // 让主界面卡片的 isUnauthorized 匹配并渲染"已封禁"。
            updateAccountStatus(acc.id, 'error', errMsg)
            errors.push({ id: acc.id, error: errMsg })
            failed++
          }
        } catch (err) {
          if (livenessAbortFlag) break
          const errMsg = err instanceof Error ? err.message : String(err)
          updateAccountStatus(acc.id, 'error', errMsg)
          errors.push({ id: acc.id, error: errMsg })
          failed++
        } finally {
          done++
          set({ livenessProgress: { done, total: targets.length, ok, failed } })
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
    await Promise.all(workers)

    set({ livenessProgress: null })
    return { success: ok, failed, errors }
  },

  // ==================== 统计 ====================

  getStats: () => {
    const { accounts } = get()

    // 引用缓存命中：避免每次重渲染重新 O(n) 遍历
    if (_statsCache && _statsCache.accounts === accounts) {
      return _statsCache.output
    }

    const accountList = Array.from(accounts.values())

    const stats: AccountStats = {
      total: accountList.length,
      byStatus: {
        active: 0,
        expired: 0,
        error: 0,
        refreshing: 0,
        unknown: 0
      },
      bySubscription: {
        Free: 0,
        Pro: 0,
        Pro_Plus: 0,
        Enterprise: 0,
        Teams: 0
      },
      byIdp: {
        Google: 0,
        Github: 0,
        BuilderId: 0,
        Enterprise: 0,
        AWSIdC: 0,
        Internal: 0,
        IAM_SSO: 0,
        AzureAD: 0,
        ExternalIdp: 0,
        ApiKey: 0
      },
      activeCount: 0,
      expiringSoonCount: 0,
      bannedCount: 0
    }

    for (const account of accountList) {
      stats.byStatus[account.status]++
      stats.bySubscription[account.subscription.type]++
      stats.byIdp[account.idp]++

      if (account.isActive) stats.activeCount++
      if (account.subscription.daysRemaining !== undefined &&
          account.subscription.daysRemaining <= 7) {
        stats.expiringSoonCount++
      }
      // 统计封禁账号
      if (isBannedAccountError(account.lastError)) {
        stats.bannedCount++
      }
    }

    _statsCache = { accounts, output: stats }
    return stats
  },

  // ==================== 持久化 ====================

  loadFromStorage: async () => {
    set({ isLoading: true })

    try {
      // 获取应用版本号
      const appVersion = await window.api.getAppVersion()
      set({ appVersion })

      const data = await window.api.loadAccounts()

      if (data) {
        const accounts = new Map(Object.entries(data.accounts ?? {}) as [string, Account][])
        const activeAccountId = data.activeAccountId ?? null

        // 为没有 machineId 的现有账户生成一个
        //
        // ⚠️ 必须写**副本**而非就地改 account（C3 别名变体）:
        //   `new Map(Object.entries(data.accounts))` 是浅拷贝 —— Map 里的 value 与
        //   `data.accounts[id]` 是同一个对象引用。就地写 `account.machineId = …` 会连带污染
        //   `data`,而 data 正是下面 deriveBaseFromDisk(data, …) 的「盘面」入参。
        //   一旦 base 里也带上刚生成的 machineId,它就与 ours 相同 ⇒ 合并读作「我没改过」
        //   ⇒ 采纳盘面（无 machineId）⇒ 生成的值被静默丢弃(flush 仍返回 ok:true)。
        //   base 的**内容**必须是盘面原样,这是 C3 的同一条铁律。
        let needsSave = false
        for (const [id, account] of accounts) {
          if (!account.machineId) {
            const machineId = generateRandomMachineId()
            accounts.set(id, { ...account, machineId })
            needsSave = true
            console.log(`[Store] Generated machineId for account ${account.email}: ${machineId.substring(0, 16)}...`)
          }
        }

        // 根据 activeAccountId 重新同步所有账号的 isActive 状态，确保只有一个账号为激活状态
        for (const [id, account] of accounts) {
          const shouldBeActive = id === activeAccountId
          if (account.isActive !== shouldBeActive) {
            accounts.set(id, { ...account, isActive: shouldBeActive })
          }
        }

        set({
          accounts,
          groups: new Map(Object.entries(data.groups ?? {}) as [string, AccountGroup][]),
          tags: new Map(Object.entries(data.tags ?? {}) as [string, AccountTag][]),
          activeAccountId,
          // T7:记住磁盘 revision,后续 save 携带此值参与仲裁;旧盘无此字段视为 0 兼容
          currentRevision: typeof (data as unknown as { revision?: unknown }).revision === 'number'
            ? (data as unknown as { revision: number }).revision
            : 0,
          autoRefreshEnabled: data.autoRefreshEnabled ?? true,
          autoRefreshInterval: data.autoRefreshInterval ?? 5,
          autoRefreshConcurrency: data.autoRefreshConcurrency ?? 100,
          autoRefreshSyncInfo: data.autoRefreshSyncInfo ?? true,
          statusCheckInterval: data.statusCheckInterval ?? 60,
          privacyMode: data.privacyMode ?? false,
          usagePrecision: data.usagePrecision ?? false,
          proxyEnabled: data.proxyEnabled ?? false,
          proxyUrl: data.proxyUrl ?? '',
          autoSwitchEnabled: data.autoSwitchEnabled ?? false,
          autoSwitchThreshold: data.autoSwitchThreshold ?? 0,
          autoSwitchInterval: data.autoSwitchInterval ?? 5,
          switchTarget: data.switchTarget ?? 'ide',
          autoSwitchDecision: decisionFromBlob(data),
          theme: data.theme ?? 'default',
          darkMode: data.darkMode ?? false,
          language: data.language ?? 'auto',
          machineIdConfig: data.machineIdConfig ?? {
            autoSwitchOnAccountChange: false,
            bindMachineIdToAccount: false,
            useBindedMachineId: true
          },
          accountMachineIds: data.accountMachineIds ?? {},
          machineIdHistory: data.machineIdHistory ?? [],
          proxyPool: data.proxyPool
            ? new Map(Object.entries(data.proxyPool as Record<string, ProxyEntry>))
            : new Map<string, ProxyEntry>(),
          proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG, ...(data.proxyPoolConfig as Partial<ProxyPoolConfig> | undefined) },
          proxyPoolCursor: typeof data.proxyPoolCursor === 'number' ? data.proxyPoolCursor : 0,
          accountProxyBindings: (data.accountProxyBindings as Record<string, string> | undefined) || {}
        })

        // 应用主题
        get().applyTheme()

        // 如果代理已启用，通过 store 的 setProxy（会自动 normalize URL 并回写 UI）
        if (data.proxyEnabled && data.proxyUrl) {
          void get().setProxy(true, data.proxyUrl)
        }

        // 首次加载只记住盘上的旧决定，不重放历史命令。共享 main 调度器要等下面
        // syncBaseSnapshot 就绪后再启动，避免第一次决定广播撞进尚未建好的三方合并基线。
        lastHandledAutoSwitchDecisionId = decisionFromBlob(data)?.id ?? null

        // 启动定时自动保存（防止数据丢失）
        get().startAutoSave()

        // 如果生成了新的 machineId，保存到存储
        if (needsSave) {
          console.log('[Store] Saving accounts with newly generated machineIds')
          get().saveToStorage()
        }

        // SSO 同步（含潜在网络请求）异步执行，不阻塞首屏加载
        // 完成后通过 set 应用结果，UI 会自然更新
        queueMicrotask(() => { void syncLocalSsoAccountAsync(get, set) })

        // C1:记下「我这份内存状态所基于的盘面快照」作为后续三方合并的 base。
        // 没有 base 就无法区分「我删的」与「别人刚加的」,STALE 后必然误判丢用户操作。
        //
        // C3 变体:base 的**内容**必须来自盘面（`data`）,不能取回灌后的内存 ——
        // 此处内存已可能含刚生成的 machineId（上面的 needsSave 分支）,而盘面还没有。
        // 若 base 取内存,那个新 machineId 在 base 与 ours 里都存在 ⇒ 合并判为"我没改过"
        // ⇒ 采纳 theirs（无 machineId）⇒ 刚生成的 machineId 被静默丢弃。
        // 形状仍由 buildPersistBlob 统一产出（与 ours 同一生产者,否则每条记录误判为本地改过）。
        syncBaseSnapshot = deriveBaseFromDisk(data as unknown as SyncBlob, get())

        // 用既有 IPC 发一次空批次，让 Electron main 启动共享调度器。renderer 不持有
        // 自动换号 timer，也不计算阈值/候选号。
        syncMainAutoSwitchScheduler()
      }
    } catch (error) {
      console.error('Failed to load accounts:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  /**
   * 静默重载（T7 · 决策卡 §1 跨端同步机制）
   *
   * 用于:
   *   - 收到 accounts-data-changed 广播且 payload.revision > currentRevision 时
   *   - flushSaveImmediately 收到 STALE_REVISION 后同步到最新状态
   *
   * 与 loadFromStorage 的差异（recon §2 P6）:
   *   - 不设 isLoading = true
   *   - 不调 syncLocalSsoAccountAsync（防幽灵账号回归 · 手机端删账号后不会自动重新导入）
   *   - 不调 startAutoSave / 不做 machineId 迁移（那是首屏一次性动作）
   *   - 但**会**按 before/after 差异重启定时器 / 应用主题 / 切代理（B-I1 返修）——
   *     否则“同步了值但不生效”，UI 显示与实际行为不一致
   *
   * @param preloaded 已经读到的盘面（避免兼容校对后再读一次）
   */
  reloadFromStorageQuiet: async (preloaded?: SyncBlob) => {
    try {
      const data = (preloaded ?? (await window.api.loadAccounts())) as SyncBlob | null
      if (!data) return

      // ---- B-I1:先记下「需要副作用才能生效」的字段旧值 ----
      // 原实现只 set 值、不重启定时器 / 不应用主题 / 不切代理 ⇒ 用户在 UI 上看到新值,
      // 实际行为仍按旧值跑（显示 10 分钟、实际 5 分钟）。「同步值但不生效」是最差的选择:
      // 它让用户以为已生效。桌面端用户自己改设置时走的是 setter（都带副作用）,
      // 跨端同步理应等价 —— 这就是「照搬桌面端行为」的含义。
      const before = get()
      const prev = {
        autoSwitchEnabled: before.autoSwitchEnabled,
        autoSwitchInterval: before.autoSwitchInterval,
        theme: before.theme,
        darkMode: before.darkMode,
        proxyEnabled: before.proxyEnabled,
        proxyUrl: before.proxyUrl,
        autoRefreshEnabled: before.autoRefreshEnabled,
        autoRefreshInterval: before.autoRefreshInterval
      }

      applySyncBlobToState(data, set, get())

      // 盘面已成为我当前状态的基准 → 更新 base。
      // 内容取盘面（`data`）· 形状由 buildPersistBlob 统一产出（与 ours 同一生产者,
      // 否则归一化差异会把每条记录误判为本地改过）。这里回灌的就是 data 本身,
      // 故「内存态」与「盘面」等价;仍走 deriveBaseFromDisk 以保持三个写入点同一语义（C3）。
      syncBaseSnapshot = deriveBaseFromDisk(data, get())

      const after = get()

      // ---- B-I1:仅在值真变了时施加副作用（值未变不动,避免每次广播都重建定时器 / 闪主题） ----

      // 主题:applyTheme 是命令式 DOM 操作,App.tsx 无响应式订阅 ⇒ 不显式调用则跨端改主题不变色
      if (after.theme !== prev.theme || after.darkMode !== prev.darkMode) {
        get().applyTheme()
      }

      // 自动换号 timer/决定都在 main；配置变化只发一次唤醒信号，不在 renderer 重建 timer。
      if (
        after.autoSwitchEnabled !== prev.autoSwitchEnabled ||
        after.autoSwitchInterval !== prev.autoSwitchInterval
      ) {
        syncMainAutoSwitchScheduler()
      }

      // 自动 token 刷新定时器:同构问题（startAutoTokenRefresh 也是一次性读 interval）
      if (
        after.autoRefreshEnabled !== prev.autoRefreshEnabled ||
        after.autoRefreshInterval !== prev.autoRefreshInterval
      ) {
        if (after.autoRefreshEnabled) {
          get().startAutoTokenRefresh()
        } else {
          get().stopAutoTokenRefresh()
        }
      }

      // 代理:只 set 值不调 setProxy ⇒ main 侧代理实际未切换
      if (after.proxyEnabled !== prev.proxyEnabled || after.proxyUrl !== prev.proxyUrl) {
        try {
          await window.api.setProxy?.(after.proxyEnabled, after.proxyUrl)
        } catch (e) {
          // 代理切换失败不应回滚数据同步;留 warn 可观测（§4.4 精准 catch）
          console.warn('[Store] setProxy after cross-end sync failed:', e)
        }
      }

      const decision = decisionFromBlob(data)
      if (decision) {
        await applyMainAutoSwitchDecision(decision, get, set)
      }
    } catch (error) {
      // 静默失败:调用方（广播 consumer / STALE 处理）会在下次机会重试
      // NEVER 吞:留 warn 让 devtools 可观测（§4.4）
      console.warn('[Store] reloadFromStorageQuiet failed:', error)
    }
  },

  /**
   * 防抖触发持久化：连续 mutation 在 SAVE_DEBOUNCE_MS 内只写盘一次。
   * 调用方仍可 await 该 Promise；返回的 Promise 会在防抖窗口结束并完成实际落盘后 resolve。
   * 用于消除高频更新场景（如 1000 账号后台刷新风暴）下的 IPC/IO 抖动。
   */
  /**
   * 防抖触发持久化：连续 mutation 在 SAVE_DEBOUNCE_MS 内只写盘一次；
   * 同时强制 SAVE_MAX_WAIT_MS 最大延迟，避免后台刷新风暴时一直被新调用 reset 导致永不落盘。
   * 同窗口内的所有调用方共享一组 resolvers，实际落盘后批量唤醒。
   */
  saveToStorage: async () => {
    return new Promise<void>((resolve) => {
      savePendingResolvers.push(resolve)
      const flushNow = async (): Promise<void> => {
        if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null }
        if (saveMaxWaitTimer) { clearTimeout(saveMaxWaitTimer); saveMaxWaitTimer = null }
        const resolvers = savePendingResolvers
        savePendingResolvers = []
        await get().flushSaveImmediately()
        for (const r of resolvers) r()
      }
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer)
      saveDebounceTimer = setTimeout(flushNow, SAVE_DEBOUNCE_MS)
      if (!saveMaxWaitTimer) {
        saveMaxWaitTimer = setTimeout(flushNow, SAVE_MAX_WAIT_MS)
      }
    })
  },

  /**
   * 立即落盘（跳过防抖）。用于 beforeunload、关键操作前后强制持久化场景。
   * 并发调用会自动等待同一次 in-flight 保存，避免重入。
   * 同时会唤醒所有走 saveToStorage 在等本次窗口落盘的调用方。
   */
  flushSaveImmediately: async () => {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null }
    if (saveMaxWaitTimer) { clearTimeout(saveMaxWaitTimer); saveMaxWaitTimer = null }
    const pending = savePendingResolvers
    savePendingResolvers = []
    if (saveInFlight) {
      const inflight = saveInFlight
      void inflight.then(() => { for (const r of pending) r() })
      return inflight
    }

    set({ isSyncing: true })

    saveInFlight = (async () => {
      try {
        let attempt = 0
        /**
         * I6:本次落盘期间「用户删掉过的账号 id」累积集合。
         * 逐轮累积而不是只看当轮:删除意图属于**本次落盘**,一旦成立就必须一路保持到写盘成功。
         */
        const myDeletedIds = new Set<string>()
        // STALE 重放循环（C1 返修）:
        //   原实现收到 STALE 后只 reload,而 reload 整表覆盖内存 ⇒ 用户本次操作被磁盘数据冲掉,
        //   磁盘上从未写入 ⇒ 真实丢更新且无提示。
        //   正确语义不是"把陈旧整表再写一遍"（那会覆盖别人的改动）,而是
        //   **基于新拉到的磁盘状态,重新施加本次改动** —— 即 base/ours/theirs 三方合并后重放。
        while (attempt < MAX_STALE_REPLAY_ATTEMPTS) {
          attempt++
          const blob = buildPersistBlob(get())
          const expectedRevision = get().currentRevision

          // blob 是 buildPersistBlob 的产物（accountData 字段清单 SSOT）。
          // saveAccounts 的形参声明为 AccountData（preload 的 ambient 类型,web tsconfig 里不可见）,
          // 故此处按调用契约收窄:整表字段 + 两个仲裁参数。
          const result = await window.api.saveAccounts({
            ...blob,
            expectedRevision,
            originId: SYNC_ORIGIN_ID
          } as Parameters<typeof window.api.saveAccounts>[0])

          if (result.ok) {
            // 写盘成功 → 本次落盘内容成为新的 base（下次合并的比较基准）
            syncBaseSnapshot = { ...blob, revision: result.revision }
            set({ currentRevision: result.revision, syncError: null })
            // 自动换号决定可能在本次保存的 STALE 三方合并里才进入内存；若只等下一条
            // 广播，本窗口自己的成功写回声会被 originId 过滤，桌面副作用将永久丢失。
            const decision = get().autoSwitchDecision
            if (decision) {
              queueMicrotask(() => {
                void applyMainAutoSwitchDecision(decision, get, set).catch((error) =>
                  console.warn('[AutoSwitch] Failed to apply merged decision:', error)
                )
              })
            }
            return { ok: true as const, revision: result.revision }
          }

          // STALE:别人在我提交期间写过盘。拉最新盘面,把本次改动重新施加其上。
          console.warn(
            `[Store] saveAccounts STALE (local=${expectedRevision}, server=${result.currentRevision}); ` +
              `merging + replaying (attempt ${attempt}/${MAX_STALE_REPLAY_ATTEMPTS})`
          )

          const theirs = (await window.api.loadAccounts()) as SyncBlob | null
          if (!theirs) {
            // 盘面读不到 → 无法安全合并。明确失败,不假装成功（§4.4 不吞）
            const error = 'cannot read latest state for merge'
            set({ syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: attempt, at: Date.now() } })
            return { ok: false as const, code: 'SAVE_FAILED' as const, error }
          }

          const ours = buildPersistBlob(get())
          const oursAccountIds = new Set(Object.keys(asAccountMap(ours)))
          const { merged, stats } = mergeSyncBlob(syncBaseSnapshot ?? {}, ours, theirs)
          console.log(
            `[Store] merge: localKept=${stats.localRecordsKept} remoteAdopted=${stats.remoteRecordsAdopted} ` +
              `myDeletions=${stats.localDeletionsHonored} theirDeletions=${stats.remoteDeletionsAdopted} ` +
              `remoteCreds=${stats.remoteCredentialsAdopted} settingsKept=[${stats.localScalarsKept.join(',')}]`
          )

          // I6:用户删除意图的**跨轮次守恒**闸门（§4.9 Layer-1）。
          //
          // 为什么需要它:C1 与 C3 是同一个母题 —— 丢用户数据时缺少"这不对"的信号。
          // syncError 弹窗只覆盖「重试耗尽」,覆盖不到「合并成功但用户意图蒸发」——
          // 后者 flush 返回 ok:true、syncError 为 null,日志里 merge: 那行看起来一切正常
          // （C3 就是这样躲过三轮评审的）。这道闸门让同类 base 语义错误无法再静默发生。
          //
          // 判据选「意图集合守恒」而不是「统计数字逐轮比较」:后者会误报 ——
          // 别人也删了同一个账号时,我的 localDeletionsHonored 会合法归零,
          // 而 remoteDeletionsAdopted 那个分支要求 inOurs 故仍为 0 ⇒ 看起来像"意图蒸发"。
          // 而「我删过的 id 不得重新出现在合并产物里」对这种情况天然免疫（依然不存在 = 正确）,
          // 且它正是用户可感知的那句话:我删掉的账号不许自己回来。
          for (const id of Object.keys(asAccountMap(syncBaseSnapshot))) {
            if (!oursAccountIds.has(id)) myDeletedIds.add(id)
          }
          const resurrected = [...myDeletedIds].filter((id) =>
            Object.prototype.hasOwnProperty.call(asAccountMap(merged), id)
          )
          if (resurrected.length > 0) {
            console.error(
              `[Store] merge invariant violated: 我删除的账号在合并产物里复活了 ` +
                `[${resurrected.join(',')}] —— base 语义可能有误,拒绝落盘以免静默丢弃用户操作`
            )
            set({
              syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: attempt, at: Date.now() }
            })
            return {
              ok: false as const,
              code: 'SAVE_FAILED' as const,
              error: `merge invariant violated: deleted accounts resurrected [${resurrected.join(',')}]`
            }
          }

          // C3:新 base 必须是**本轮拉到的盘面**（theirs）,不是合并产物。
          //
          // 为什么:base 只有一个用途 —— 回答「某记录在 ours 里没有,是我删的还是我没见过」。
          // 合并产物里用户删掉的账号已经不存在了,把它当 base 就等于抹掉"我曾见过这条记录"
          // 的证据 ⇒ 下一轮它落到「base 无 + theirs 有」= 别人新加的 ⇒ 删除复活,
          // 而 flush 仍返回 ok:true、syncError 为 null（比 C1 更隐蔽:连日志都显示正常）。
          //
          // 注意顺序:先用**回灌前**的内存态推 base,再回灌。因为归一化时"盘面缺某个 key"
          // 要保留的是与 ours 同一份内存现值（deriveBaseFromDisk 的 @param current 契约）。
          const nextBase = deriveBaseFromDisk(theirs, get())
          applySyncBlobToState(merged, set, get())
          syncBaseSnapshot = nextBase
        }

        // 重试耗尽:持续撞车（罕见,通常意味着有写路径在高频刷盘）。
        // 必须让用户知道 —— 静默是 C1 的原罪之一。
        console.error(
          `[Store] saveAccounts still conflicting after ${MAX_STALE_REPLAY_ATTEMPTS} replays; surfacing to user`
        )
        set({
          syncError: {
            code: 'SYNC_CONFLICT_UNRESOLVED',
            attempts: MAX_STALE_REPLAY_ATTEMPTS,
            at: Date.now()
          }
        })
        return {
          ok: false as const,
          code: 'SYNC_CONFLICT_UNRESOLVED' as const,
          attempts: MAX_STALE_REPLAY_ATTEMPTS
        }
      } catch (error) {
        console.error('Failed to save accounts:', error)
        return {
          ok: false as const,
          code: 'SAVE_FAILED' as const,
          error: error instanceof Error ? error.message : String(error)
        }
      } finally {
        set({ isSyncing: false })
        saveInFlight = null
        for (const r of pending) r()
        // A-I2:写入窗口内被反检吞掉的外部广播,在这里补拉,避免永久错过。
        void get().reconcilePendingExternalRevision()
      }
    })()

    return saveInFlight
  },

  // ==================== 跨端同步（C1 / A-I2 / I3 返修） ====================

  hasPendingLocalEdits: () => hasPendingLocalEditsInternal(get().isSyncing),

  noteExternalRevision: (revision, opts) => {
    if (opts?.selfOrigin) return
    if (revision <= get().currentRevision) return
    if (pendingExternalRevision !== null && pendingExternalRevision >= revision) return
    pendingExternalRevision = revision
  },

  reconcilePendingExternalRevision: async () => {
    const target = pendingExternalRevision
    if (target === null) return
    // C1-again:判据是 dirty（内存有未落盘编辑）,不是 isSyncing（仅 IPC 在途）。
    // 防抖窗内 isSyncing 恒为 false,若只看它,这里会整表覆盖掉用户尚未落盘的删除。
    if (get().hasPendingLocalEdits()) return // 留到那次 flush 的 finally 再对账

    // I5:先拉取成功再清账本。这个账本存在的唯一理由是「绝不丢失外部信号」,
    // 而 syncIfRevisionDrifted 内部的 catch 只 warn（不能让兜底通道的失败冒泡打断主流程）,
    // 所以**不能靠 await 抛错**来判断成败 —— 它返回布尔告知本次是否真的对上了盘面。
    // 若先清账再拉取,IPC 抛错时账本已空而数据未到,那次外部改动就只能等兜底轮询（≤6s）,
    // 「确定性补拉」被降级成「依赖兜底」。
    const settled = await get().syncIfRevisionDrifted()
    if (!settled) return // 账本原样留着,下次广播 / 轮询继续对账
    // 仅当账本仍是我进来时看到的那个值才清除:期间可能有更高的外部 revision 记进来,
    // 直接置 null 会把那条新信号一起丢掉。
    if (pendingExternalRevision === target) pendingExternalRevision = null
  },

  syncIfRevisionDrifted: async () => {
    // C1-again 核心:守卫用 dirty 而非 isSyncing。
    //   isSyncing 只覆盖 flushSaveImmediately 执行期间（IPC 在途）;而用户编辑后先在防抖窗里等
    //   500ms（最长 5000ms）,那段时间 isSyncing === false 却已有未落盘编辑 ⇒ 本函数畅通
    //   ⇒ reloadFromStorageQuiet 整表覆盖 ⇒ 删除被磁盘数据复活,且不 STALE、不进合并、不报错。
    //   reviewer 探针实测同一场景复活 3 个已删账号、syncError 为 null,与首轮 C1 现象逐字相同。
    // 挡下不等于丢弃:记账后由 flush 的 finally 对账补拉（见 flushSaveImmediately 的 finally）。
    if (get().hasPendingLocalEdits()) {
      const local = get().currentRevision
      pendingExternalRevision = Math.max(pendingExternalRevision ?? 0, local + 1)
      return false
    }
    try {
      const data = (await window.api.loadAccounts()) as SyncBlob | null
      if (!data) return false
      const diskRevision = typeof data.revision === 'number' ? data.revision : 0
      if (diskRevision === get().currentRevision) return true // 无漂移,不做无谓整表 set
      console.log(
        `[Store] revision drift detected (disk=${diskRevision}, local=${get().currentRevision}); syncing`
      )
      await get().reloadFromStorageQuiet(data)
      return true
    } catch (error) {
      // 兜底通道失败不能影响主流程;留 warn 可观测（§4.4 不吞）
      console.warn('[Store] syncIfRevisionDrifted failed:', error)
      return false // I5:告知调用方本次没对上,账本不要清
    }
  },

  /**
   * IDE token 反向同步（kiro-ide-token-changed）后的重取（C1-again 第 4 条通道）。
   *
   * 原来 App.tsx 收到该事件直接调 loadFromStorage() —— 那是**无守卫的整表覆盖**,
   * 且比另外三条更狠:它还会跑 syncLocalSsoAccountAsync（重新导入本机 SSO 账号 = 幽灵账号回归）。
   * ProactiveRenewal 刷 token 后正是同时发这个事件与 accounts-data-changed 广播,
   * 于是防抖窗内用户的删除会被这条通道复活。改为与其余三条同一套 dirty 守卫 + revision 比对。
   */
  syncAfterIdeTokenChanged: async () => {
    await get().syncIfRevisionDrifted()
  },

  clearSyncError: () => {
    if (get().syncError !== null) set({ syncError: null })
  },

  // ==================== 设置 ====================

  setAutoRefresh: (enabled, interval) => {
    set({
      autoRefreshEnabled: enabled,
      autoRefreshInterval: interval ?? get().autoRefreshInterval
    })
    get().saveToStorage()
    
    // 重新启动定时器
    if (enabled) {
      get().startAutoTokenRefresh()
    } else {
      get().stopAutoTokenRefresh()
    }
  },

  setAutoRefreshConcurrency: (concurrency) => {
    set({ autoRefreshConcurrency: Math.max(1, Math.min(500, concurrency)) })
    get().saveToStorage()
  },

  setAutoRefreshSyncInfo: (enabled) => {
    set({ autoRefreshSyncInfo: enabled })
    get().saveToStorage()
  },

  setProactiveRenewalEnabled: async (enabled) => {
    if (typeof window.api?.setProactiveRenewalEnabled !== 'function') {
      return { success: false, error: 'API not available' }
    }
    const result = await window.api.setProactiveRenewalEnabled(enabled)
    if (result.success) {
      set({ proactiveRenewalEnabled: !!result.enabled })
    }
    return { success: result.success, error: result.error }
  },

  loadProactiveRenewalEnabled: async () => {
    if (typeof window.api?.getProactiveRenewalEnabled !== 'function') return
    try {
      const result = await window.api.getProactiveRenewalEnabled()
      if (result.success) {
        set({
          proactiveRenewalEnabled: !!result.enabled,
          proactiveRenewalLeadMinutes: result.leadTimeMinutes ?? 15
        })
      }
    } catch (e) {
      console.warn('[Store] loadProactiveRenewalEnabled failed:', e)
    }
  },

  setStatusCheckInterval: (interval) => {
    set({ statusCheckInterval: interval })
    get().saveToStorage()
  },

  // ==================== 隐私模式 ====================

  setPrivacyMode: (enabled) => {
    set({ privacyMode: enabled })
    get().saveToStorage()
  },

  maskEmail: (email) => {
    if (!get().privacyMode || !email) return email
    // 生成固定长度的随机字符串作为伪装邮箱
    const hash = email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const maskedName = `user${(hash % 100000).toString().padStart(5, '0')}`
    return `${maskedName}@***.com`
  },

  maskNickname: (nickname) => {
    if (!get().privacyMode || !nickname) return nickname || ''
    // 基于原始昵称生成固定的伪装昵称
    const hash = nickname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    return `用户${(hash % 100000).toString().padStart(5, '0')}`
  },

  // ==================== 使用量精度 ====================

  setUsagePrecision: (enabled) => {
    set({ usagePrecision: enabled })
    get().saveToStorage()
  },

  // ==================== 代理设置 ====================

  setProxy: async (enabled, url) => {
    const targetUrl = url ?? get().proxyUrl
    set({ 
      proxyEnabled: enabled,
      proxyUrl: targetUrl
    })
    get().saveToStorage()
    // 通知主进程更新代理设置，并用规范化后的 URL 回写 store
    try {
      const result = await window.api.setProxy?.(enabled, targetUrl)
      if (result?.normalizedUrl && result.normalizedUrl !== targetUrl) {
        set({ proxyUrl: result.normalizedUrl })
        get().saveToStorage()
      }
    } catch (err) {
      console.error('[Store] setProxy IPC failed:', err)
    }
  },

  // ==================== 主题设置 ====================

  setTheme: (theme) => {
    set({ theme })
    get().saveToStorage()
    get().applyTheme()
  },

  setDarkMode: (enabled) => {
    set({ darkMode: enabled })
    get().saveToStorage()
    get().applyTheme()
  },

  // ==================== 语言设置 ====================

  setLanguage: (language) => {
    set({ language })
    get().saveToStorage()
    // 更新托盘菜单语言
    const actualLang = language === 'auto' 
      ? (navigator.language.startsWith('zh') ? 'zh' : 'en')
      : language
    window.api.updateTrayLanguage(actualLang)
  },

  applyTheme: () => {
    const { theme, darkMode } = get()
    const root = document.documentElement
    
    // 移除所有主题类（包含所有 32 个主题）
    root.classList.remove(
      'dark', 
      // 蓝色系
      'theme-indigo', 'theme-cyan', 'theme-sky', 'theme-teal',
      // 紫红系
      'theme-purple', 'theme-violet', 'theme-fuchsia', 'theme-pink', 'theme-rose',
      // 暖色系
      'theme-red', 'theme-orange', 'theme-amber', 'theme-yellow',
      // 绿色系
      'theme-emerald', 'theme-green', 'theme-lime',
      // 中性色
      'theme-slate', 'theme-zinc', 'theme-stone', 'theme-neutral',
      // 奢华配色
      'theme-gold', 'theme-navy', 'theme-wine', 'theme-champagne',
      // 莫兰迪
      'theme-dustyblue', 'theme-terracotta', 'theme-sage', 'theme-mauve',
      // 自然深色
      'theme-coral', 'theme-forest', 'theme-ocean'
    )
    
    // 应用深色模式
    if (darkMode) {
      root.classList.add('dark')
    }
    
    // 应用主题颜色
    if (theme !== 'default') {
      root.classList.add(`theme-${theme}`)
    }
  },

  // ==================== 自动换号 ====================

  setAutoSwitch: (enabled, threshold, interval) => {
    set({
      autoSwitchEnabled: enabled,
      autoSwitchThreshold: threshold ?? get().autoSwitchThreshold,
      autoSwitchInterval: interval ?? get().autoSwitchInterval
    })
    // 先等配置经 revision 收口落盘，再唤醒 main；否则它可能仍读到旧阈值。
    void get().saveToStorage().then(syncMainAutoSwitchScheduler)
  },

  setBatchImportConcurrency: (concurrency) => {
    set({ batchImportConcurrency: Math.max(1, Math.min(500, concurrency)) })
    get().saveToStorage()
  },

  setLoginPrivateMode: (enabled) => {
    set({ loginPrivateMode: enabled })
    get().saveToStorage()
  },

  setSwitchTarget: (target) => {
    set({ switchTarget: target })
    get().saveToStorage()
  },

  // ==================== 自动 Token 刷新 ====================

  checkAndRefreshExpiringTokens: async () => {
    const { accounts, refreshAccountToken, checkAccountStatus, autoSwitchEnabled, autoRefreshConcurrency, autoRefreshSyncInfo, autoRefreshInterval } = get()
    const now = Date.now()
    const refreshLeadMs = tokenRefreshLeadMs(autoRefreshInterval)

    console.log(`[AutoRefresh] Checking ${accounts.size} accounts... (syncInfo: ${autoRefreshSyncInfo}, autoSwitch: ${autoSwitchEnabled})`)

    // 筛选需要处理的账号
    const accountsToProcess: Array<{ id: string; email: string; needsTokenRefresh: boolean }> = []
    
    for (const [id, account] of accounts) {
      // 跳过已封禁或错误状态的账号
      if (isBannedAccountError(account.lastError)) {
        console.log(`[AutoRefresh] Skipping ${account.email} (banned/error)`)
        continue
      }

      const expiresAt = account.credentials.expiresAt
      const timeUntilExpiry = expiresAt ? expiresAt - now : Infinity
      const needsTokenRefresh = expiresAt && timeUntilExpiry <= refreshLeadMs

      accountsToProcess.push({ id, email: account.email, needsTokenRefresh: !!needsTokenRefresh })
    }

    console.log(`[AutoRefresh] Processing ${accountsToProcess.length} accounts...`)

    // 并发控制：使用配置的并发数，避免卡顿
    const BATCH_SIZE = autoRefreshConcurrency
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < accountsToProcess.length; i += BATCH_SIZE) {
      const batch = accountsToProcess.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(async ({ id, email, needsTokenRefresh }) => {
          try {
            if (needsTokenRefresh) {
              console.log(`[AutoRefresh] Refreshing token for ${email}...`)
              await refreshAccountToken(id)
              console.log(`[AutoRefresh] Token for ${email} refreshed`)
              // Token 刷新后同步刷新账户信息
              await checkAccountStatus(id)
              console.log(`[AutoRefresh] Account info for ${email} updated`)
            } else if (autoRefreshSyncInfo || autoSwitchEnabled) {
              // 开启同步检测账户信息或自动换号时，刷新账户信息
              await checkAccountStatus(id)
              console.log(`[AutoRefresh] Account info for ${email} updated`)
            }
            return { email, success: true }
          } catch (e) {
            console.error(`[AutoRefresh] Failed for ${email}:`, e)
            return { email, success: false, error: e }
          }
        })
      )
      
      successCount += results.filter(r => r.status === 'fulfilled' && r.value.success).length
      failCount += results.length - results.filter(r => r.status === 'fulfilled' && r.value.success).length
      
      // 批次间延迟
      if (i + BATCH_SIZE < accountsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    console.log(`[AutoRefresh] Completed: ${successCount} success, ${failCount} failed`)
  },

  // 仅刷新失效的 Token（不刷新账户信息）
  refreshExpiredTokensOnly: async () => {
    const { accounts, refreshAccountToken, autoRefreshConcurrency, autoRefreshInterval } = get()
    const now = Date.now()
    const refreshLeadMs = tokenRefreshLeadMs(autoRefreshInterval)

    // 筛选需要刷新 Token 的账号
    const expiredAccounts: Array<{ id: string; email: string }> = []
    
    for (const [id, account] of accounts) {
      // 跳过已封禁或错误状态的账号
      if (isBannedAccountError(account.lastError)) {
        continue
      }

      const expiresAt = account.credentials.expiresAt
      const timeUntilExpiry = expiresAt ? expiresAt - now : Infinity
      
      // Token 已过期或即将过期
      if (expiresAt && timeUntilExpiry <= refreshLeadMs) {
        expiredAccounts.push({ id, email: account.email })
      }
    }

    if (expiredAccounts.length === 0) {
      console.log('[AutoRefresh] No expired tokens found')
      return
    }

    console.log(`[AutoRefresh] Refreshing ${expiredAccounts.length} expired tokens...`)

    // 并发控制：使用配置的并发数，避免卡顿
    const BATCH_SIZE = autoRefreshConcurrency
    for (let i = 0; i < expiredAccounts.length; i += BATCH_SIZE) {
      const batch = expiredAccounts.slice(i, i + BATCH_SIZE)
      await Promise.allSettled(
        batch.map(async ({ id, email }) => {
          try {
            await refreshAccountToken(id)
            console.log(`[AutoRefresh] Token for ${email} refreshed`)
          } catch (e) {
            console.error(`[AutoRefresh] Failed to refresh token for ${email}:`, e)
          }
        })
      )
      // 批次间延迟
      if (i + BATCH_SIZE < expiredAccounts.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  },

  startAutoTokenRefresh: () => {
    const { autoRefreshEnabled, autoRefreshInterval } = get()
    
    // 如果已有定时器，先停止
    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
    }
    
    // 如果未启用，不启动定时器
    if (!autoRefreshEnabled) {
      console.log('[AutoRefresh] Auto-refresh is disabled')
      return
    }

    // 启动时触发后台刷新（在主进程执行，不阻塞 UI）
    get().triggerBackgroundRefresh()

    // 使用用户设置的间隔（分钟转毫秒）
    const intervalMs = autoRefreshInterval * 60 * 1000
    tokenRefreshTimer = setInterval(() => {
      get().triggerBackgroundRefresh()
    }, intervalMs)

    console.log(`[AutoRefresh] Token auto-refresh started with interval: ${autoRefreshInterval} minutes`)
  },

  stopAutoTokenRefresh: () => {
    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
      console.log('[AutoRefresh] Token auto-refresh stopped')
    }
  },

  // 触发后台刷新（在主进程执行，不阻塞 UI）
  triggerBackgroundRefresh: async () => {
    const { accounts, autoRefreshConcurrency, autoRefreshSyncInfo, autoSwitchEnabled, autoRefreshInterval } = get()
    const now = Date.now()
    const refreshLeadMs = tokenRefreshLeadMs(autoRefreshInterval)

    // 筛选需要处理的账号
    const accountsToRefresh: Array<{
      id: string
      email: string
      idp?: string
      profileArn?: string
      needsTokenRefresh: boolean
      machineId?: string  // 账户绑定的设备 ID
      credentials: {
        refreshToken: string
        clientId?: string
        clientSecret?: string
        region?: string
        authMethod?: string
        accessToken?: string
        provider?: string
        profileArn?: string
        tokenEndpoint?: string
        issuerUrl?: string
        scopes?: string
      }
    }> = []
    
    for (const [id, account] of accounts) {
      // 跳过已封禁或错误状态的账号
      if (isBannedAccountError(account.lastError)) {
        continue
      }

      const expiresAt = account.credentials.expiresAt
      const timeUntilExpiry = expiresAt ? expiresAt - now : Infinity
      const needsTokenRefresh = expiresAt && timeUntilExpiry <= refreshLeadMs
      
      // Token 即将过期需要刷新，或开启了同步检测/自动换号需要检查账户信息
      if (needsTokenRefresh || autoRefreshSyncInfo || autoSwitchEnabled) {
        accountsToRefresh.push({
          id,
          email: account.email,
          idp: account.idp,
          profileArn: account.profileArn,
          needsTokenRefresh: !!needsTokenRefresh,
          machineId: account.machineId,  // 传递账户绑定的设备 ID
          credentials: {
            refreshToken: account.credentials.refreshToken || '',
            clientId: account.credentials.clientId,
            clientSecret: account.credentials.clientSecret,
            region: account.credentials.region,
            authMethod: account.credentials.authMethod,
            accessToken: account.credentials.accessToken,
            provider: account.credentials.provider,
            profileArn: account.credentials.profileArn,
            // external_idp 刷新走微软端点，必须带这些字段，否则报"缺少 tokenEndpoint"
            tokenEndpoint: account.credentials.tokenEndpoint,
            issuerUrl: account.credentials.issuerUrl,
            scopes: account.credentials.scopes
          }
        })
      }
    }

    if (accountsToRefresh.length === 0) {
      console.log('[BackgroundRefresh] No accounts need processing')
      return
    }

    console.log(`[BackgroundRefresh] Triggering refresh for ${accountsToRefresh.length} accounts (syncInfo: ${autoRefreshSyncInfo})...`)
    
    // 调用主进程后台刷新，不等待结果（通过 IPC 事件接收）
    window.api.backgroundBatchRefresh(accountsToRefresh, autoRefreshConcurrency, autoRefreshSyncInfo)
  },

  // 处理后台刷新结果（兼容入口；高频场景请走 applyBackgroundRefreshResults 批量）
  handleBackgroundRefreshResult: (data) => {
    get().applyBackgroundRefreshResults([data])
  },

  // 批量处理后台刷新结果：合并 N 条结果到一次 set，避免 N 次 Map 全量复制
  applyBackgroundRefreshResults: (items) => {
    if (!items || items.length === 0) return

    set((state) => {
      // 仅一次完整 Map 复制
      const accounts = new Map(state.accounts)
      const now = Date.now()

      for (const data of items) {
        const { id, success, data: resultData, error } = data
        const account = accounts.get(id)
        if (!account) continue

        if (!success) {
          accounts.set(id, {
            ...account,
            status: 'error',
            lastError: error,
            lastCheckedAt: now
          })
          continue
        }

        const refreshData = resultData as {
        accessToken?: string
        refreshToken?: string
        expiresIn?: number
        profileArn?: string
        usage?: {
          current?: number
          limit?: number
          baseCurrent?: number
          baseLimit?: number
          freeTrialCurrent?: number
          freeTrialLimit?: number
          freeTrialExpiry?: string
          bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
          nextResetDate?: string
          resourceDetail?: {
            displayName?: string
            displayNamePlural?: string
            resourceType?: string
            currency?: string
            unit?: string
            overageRate?: number
            overageCap?: number
            overageEnabled?: boolean
          }
        }
        subscription?: { type?: string; title?: string; daysRemaining?: number; expiresAt?: number; overageCapability?: string; upgradeCapability?: string; subscriptionManagementTarget?: string }
        userInfo?: { email?: string; userId?: string }
        status?: string
        errorMessage?: string
      } | undefined

      // 检测封禁状态
      const newStatus = refreshData?.status === 'error' ? 'error' as AccountStatus : 'active' as AccountStatus
      const newError = refreshData?.errorMessage

      // 后台刷新时主进程可能返回自动获取的 profileArn，持久化到顶层和 credentials
      const bgProfileArn = refreshData?.profileArn || account.credentials.profileArn || account.profileArn
      accounts.set(id, {
        ...account,
        ...(bgProfileArn ? { profileArn: bgProfileArn } : {}),
        credentials: {
          ...account.credentials,
          accessToken: refreshData?.accessToken || account.credentials.accessToken,
          refreshToken: refreshData?.refreshToken || account.credentials.refreshToken,
          expiresAt: refreshData?.expiresIn ? now + refreshData.expiresIn * 1000 : account.credentials.expiresAt,
          ...(bgProfileArn ? { profileArn: bgProfileArn } : {})
        },
        usage: refreshData?.usage ? (() => {
          const newCurrent = refreshData.usage.current ?? account.usage.current
          const newLimit = refreshData.usage.limit ?? account.usage.limit
          return {
            ...account.usage,
            current: newCurrent,
            limit: newLimit,
            percentUsed: newLimit > 0 ? newCurrent / newLimit : 0,
            baseCurrent: refreshData.usage.baseCurrent ?? account.usage.baseCurrent,
            baseLimit: refreshData.usage.baseLimit ?? account.usage.baseLimit,
            freeTrialCurrent: refreshData.usage.freeTrialCurrent ?? account.usage.freeTrialCurrent,
            freeTrialLimit: refreshData.usage.freeTrialLimit ?? account.usage.freeTrialLimit,
            freeTrialExpiry: refreshData.usage.freeTrialExpiry ?? account.usage.freeTrialExpiry,
            bonuses: refreshData.usage.bonuses ?? account.usage.bonuses,
            nextResetDate: refreshData.usage.nextResetDate ?? account.usage.nextResetDate,
            resourceDetail: refreshData.usage.resourceDetail ?? account.usage.resourceDetail,
            lastUpdated: now
          }
        })() : account.usage,
        subscription: refreshData?.subscription ? {
          ...account.subscription,
          type: (refreshData.subscription.type as SubscriptionType) || account.subscription.type,
          title: refreshData.subscription.title || account.subscription.title,
          daysRemaining: refreshData.subscription.daysRemaining ?? account.subscription.daysRemaining,
          expiresAt: refreshData.subscription.expiresAt ?? account.subscription.expiresAt,
          overageCapability: refreshData.subscription.overageCapability ?? account.subscription.overageCapability,
          upgradeCapability: refreshData.subscription.upgradeCapability ?? account.subscription.upgradeCapability,
          managementTarget: refreshData.subscription.subscriptionManagementTarget ?? account.subscription.managementTarget
        } : account.subscription,
        email: refreshData?.userInfo?.email || account.email,
        userId: refreshData?.userInfo?.userId || account.userId,
        status: newStatus,
        lastError: newError,
        lastCheckedAt: now
      })
      } // end for-loop

      return { accounts }
    })
  },

  // 处理后台检查结果（兼容入口；高频场景请走 applyBackgroundCheckResults 批量）
  handleBackgroundCheckResult: (data) => {
    get().applyBackgroundCheckResults([data])
  },

  // 批量处理后台检查结果：合并 N 条结果到一次 set
  applyBackgroundCheckResults: (items) => {
    if (!items || items.length === 0) return

    set((state) => {
      const accounts = new Map(state.accounts)
      const now = Date.now()

      for (const data of items) {
        const { id, success, data: resultData, error } = data
        const account = accounts.get(id)
        if (!account) continue

        if (!success) {
          accounts.set(id, {
            ...account,
            status: 'error',
            lastError: error,
            lastCheckedAt: now
          })
          continue
        }

        const checkData = resultData as {
        usage?: {
          current?: number
          limit?: number
          baseCurrent?: number
          baseLimit?: number
          freeTrialCurrent?: number
          freeTrialLimit?: number
          freeTrialExpiry?: string
          bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
          nextResetDate?: string
          resourceDetail?: {
            displayName?: string
            displayNamePlural?: string
            resourceType?: string
            currency?: string
            unit?: string
            overageRate?: number
            overageCap?: number
            overageEnabled?: boolean
          }
        }
        subscription?: { type?: string; title?: string; daysRemaining?: number; expiresAt?: number; overageCapability?: string; upgradeCapability?: string; subscriptionManagementTarget?: string }
        userInfo?: { email?: string; userId?: string }
        status?: string
        errorMessage?: string
        needsRefresh?: boolean
      } | undefined

      // 检测状态
      let newStatus: AccountStatus = 'active'
      if (checkData?.status === 'error') {
        newStatus = 'error'
      } else if (checkData?.status === 'expired' || checkData?.needsRefresh) {
        newStatus = 'expired'
      }
      const newError = checkData?.errorMessage

      accounts.set(id, {
        ...account,
        usage: checkData?.usage ? (() => {
          const newCurrent = checkData.usage.current ?? account.usage.current
          const newLimit = checkData.usage.limit ?? account.usage.limit
          return {
            ...account.usage,
            current: newCurrent,
            limit: newLimit,
            percentUsed: newLimit > 0 ? newCurrent / newLimit : 0,
            baseCurrent: checkData.usage.baseCurrent ?? account.usage.baseCurrent,
            baseLimit: checkData.usage.baseLimit ?? account.usage.baseLimit,
            freeTrialCurrent: checkData.usage.freeTrialCurrent ?? account.usage.freeTrialCurrent,
            freeTrialLimit: checkData.usage.freeTrialLimit ?? account.usage.freeTrialLimit,
            freeTrialExpiry: checkData.usage.freeTrialExpiry ?? account.usage.freeTrialExpiry,
            bonuses: checkData.usage.bonuses ?? account.usage.bonuses,
            nextResetDate: checkData.usage.nextResetDate ?? account.usage.nextResetDate,
            resourceDetail: checkData.usage.resourceDetail ?? account.usage.resourceDetail,
            lastUpdated: now
          }
        })() : account.usage,
        subscription: checkData?.subscription ? {
          ...account.subscription,
          type: (checkData.subscription.type as 'Free' | 'Pro' | 'Enterprise' | 'Teams') ?? account.subscription.type,
          title: checkData.subscription.title ?? account.subscription.title,
          daysRemaining: checkData.subscription.daysRemaining ?? account.subscription.daysRemaining,
          expiresAt: checkData.subscription.expiresAt ?? account.subscription.expiresAt,
          overageCapability: checkData.subscription.overageCapability ?? account.subscription.overageCapability,
          upgradeCapability: checkData.subscription.upgradeCapability ?? account.subscription.upgradeCapability,
          managementTarget: checkData.subscription.subscriptionManagementTarget ?? account.subscription.managementTarget
        } : account.subscription,
        email: checkData?.userInfo?.email || account.email,
        userId: checkData?.userInfo?.userId || account.userId,
        status: newStatus,
        lastError: newError,
        lastCheckedAt: now
      })
      } // end for-loop

      return { accounts }
    })
  },

  // ==================== 定时自动保存 ====================

  startAutoSave: () => {
    // 如果已有定时器，先停止
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer)
    }

    // 计算当前数据的哈希值
    const computeHash = () => {
      const { accounts, groups, tags, activeAccountId } = get()
      return JSON.stringify({
        accounts: Object.fromEntries(accounts),
        groups: Object.fromEntries(groups),
        tags: Object.fromEntries(tags),
        activeAccountId
      })
    }

    // 初始化哈希值
    lastSaveHash = computeHash()

    // 设置定时保存
    autoSaveTimer = setInterval(async () => {
      const currentHash = computeHash()
      
      // 只有数据变化时才保存
      if (currentHash !== lastSaveHash) {
        console.log('[AutoSave] Data changed, saving...')
        await get().saveToStorage()
        lastSaveHash = currentHash
        console.log('[AutoSave] Data saved successfully')
      }
    }, AUTO_SAVE_INTERVAL)

    console.log(`[AutoSave] Auto-save started with interval: ${AUTO_SAVE_INTERVAL / 1000}s`)
  },

  stopAutoSave: () => {
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer)
      autoSaveTimer = null
      console.log('[AutoSave] Auto-save stopped')
    }
  },

  // ==================== 机器码管理 ====================

  setMachineIdConfig: (config) => {
    set((state) => ({
      machineIdConfig: { ...state.machineIdConfig, ...config }
    }))
    get().saveToStorage()
  },

  refreshCurrentMachineId: async () => {
    try {
      const result = await window.api.machineIdGetCurrent()
      if (result.success && result.machineId) {
        set({ currentMachineId: result.machineId })
        
        // 首次获取时自动备份原始机器码
        const { originalMachineId } = get()
        if (!originalMachineId) {
          get().backupOriginalMachineId()
        }
      }
    } catch (error) {
      console.error('[MachineId] Failed to refresh current machine ID:', error)
    }
  },

  changeMachineId: async (newMachineId) => {
    const state = get()
    
    // 首次更改时备份原始机器码
    if (!state.originalMachineId) {
      state.backupOriginalMachineId()
    }

    // 生成新机器码（如果未提供）
    const machineIdToSet = newMachineId || await window.api.machineIdGenerateRandom()
    
    try {
      const result = await window.api.machineIdSet(machineIdToSet)
      
      if (result.success) {
        // 更新状态
        set((s) => ({
          currentMachineId: machineIdToSet,
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: machineIdToSet,
              timestamp: Date.now(),
              action: 'manual'
            }
          ]
        }))
        get().saveToStorage()
        return true
      } else if (result.requiresAdmin) {
        // 需要管理员权限，主进程会处理弹窗
        return false
      } else {
        console.error('[MachineId] Failed to change:', result.error)
        return false
      }
    } catch (error) {
      console.error('[MachineId] Error changing machine ID:', error)
      return false
    }
  },

  restoreOriginalMachineId: async () => {
    const { originalMachineId } = get()
    
    if (!originalMachineId) {
      console.warn('[MachineId] No original machine ID to restore')
      return false
    }

    try {
      const result = await window.api.machineIdSet(originalMachineId)
      
      if (result.success) {
        set((s) => ({
          currentMachineId: originalMachineId,
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: originalMachineId,
              timestamp: Date.now(),
              action: 'restore'
            }
          ]
        }))
        get().saveToStorage()
        return true
      }
      return false
    } catch (error) {
      console.error('[MachineId] Error restoring original machine ID:', error)
      return false
    }
  },

  bindMachineIdToAccount: (accountId, machineId) => {
    const account = get().accounts.get(accountId)
    if (!account) return

    // 生成或使用提供的机器码
    const boundMachineId = machineId || crypto.randomUUID()

    set((state) => ({
      accountMachineIds: {
        ...state.accountMachineIds,
        [accountId]: boundMachineId
      },
      machineIdHistory: [
        ...state.machineIdHistory,
        {
          id: crypto.randomUUID(),
          machineId: boundMachineId,
          timestamp: Date.now(),
          action: 'bind',
          accountId,
          accountEmail: account.email
        }
      ]
    }))
    get().saveToStorage()
  },

  getMachineIdForAccount: (accountId) => {
    return get().accountMachineIds[accountId] || null
  },

  backupOriginalMachineId: () => {
    const { currentMachineId, originalMachineId } = get()
    
    // 只有在没有备份且有当前机器码时才备份
    if (!originalMachineId && currentMachineId) {
      set({
        originalMachineId: currentMachineId,
        originalBackupTime: Date.now()
      })
      
      // 添加历史记录
      set((s) => ({
        machineIdHistory: [
          ...s.machineIdHistory,
          {
            id: crypto.randomUUID(),
            machineId: currentMachineId,
            timestamp: Date.now(),
            action: 'initial'
          }
        ]
      }))
      
      get().saveToStorage()
      console.log('[MachineId] Original machine ID backed up:', currentMachineId)
    }
  },

  clearMachineIdHistory: () => {
    set({ machineIdHistory: [] })
    get().saveToStorage()
  },

  // ==================== 代理池 ====================

  addProxy: (url, options) => {
    const parsed = parseProxyUrl(url)
    if (!parsed) return null

    // 去重：同 host:port:protocol:username 视为重复
    // 含 username 以支持 bestproxy 等「单入口、靠用户名区分地区/会话」的轮换代理添加多条
    const existingPool = get().proxyPool
    for (const entry of existingPool.values()) {
      if (entry.host === parsed.host && entry.port === parsed.port && entry.protocol === parsed.protocol
        && (entry.username || '') === (parsed.username || '')) {
        return null
      }
    }

    const id = uuidv4()
    const entry: ProxyEntry = {
      id,
      url: parsed.normalized,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      label: options?.label,
      source: options?.source ?? 'manual',
      tags: options?.tags,
      status: 'untested',
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }

    set((state) => {
      const next = new Map(state.proxyPool)
      next.set(id, entry)
      return { proxyPool: next }
    })
    get().saveToStorage()
    return id
  },

  importProxies: (text) => {
    const result = { added: 0, skipped: 0, failed: 0 }
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (lines.length === 0) return result

    // 批量构造新条目，最后只 set 一次，避免 O(n²) re-render
    const existingPool = get().proxyPool
    const existingKeys = new Set<string>()
    for (const entry of existingPool.values()) {
      existingKeys.add(`${entry.protocol}://${entry.username || ''}@${entry.host}:${entry.port}`)
    }
    const newEntries: ProxyEntry[] = []

    for (const line of lines) {
      const parsed = parseProxyUrl(line)
      if (!parsed) { result.failed++; continue }
      const key = `${parsed.protocol}://${parsed.username || ''}@${parsed.host}:${parsed.port}`
      if (existingKeys.has(key)) { result.skipped++; continue }
      existingKeys.add(key)
      newEntries.push({
        id: uuidv4(),
        url: parsed.normalized,
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        source: 'import',
        status: 'untested',
        usedCount: 0,
        failCount: 0,
        enabled: true,
        createdAt: Date.now()
      })
      result.added++
    }

    if (newEntries.length > 0) {
      set((state) => {
        const next = new Map(state.proxyPool)
        for (const e of newEntries) next.set(e.id, e)
        return { proxyPool: next }
      })
      get().saveToStorage()
    }
    return result
  },

  removeProxy: (id) => {
    // 收集受影响的账号（绑定到该代理的账号）
    const affectedAccountIds = Object.entries(get().accountProxyBindings)
      .filter(([, pid]) => pid === id)
      .map(([aid]) => aid)
    set((state) => {
      const next = new Map(state.proxyPool)
      next.delete(id)
      // 同步清理绑定
      const bindings = { ...state.accountProxyBindings }
      for (const aid of affectedAccountIds) delete bindings[aid]
      return { proxyPool: next, accountProxyBindings: bindings }
    })
    get().saveToStorage()
    // 通知主进程：这些账号现在无代理绑定，回退全局
    for (const aid of affectedAccountIds) syncAccountProxyToMain(aid)
  },

  removeProxies: (ids) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const affectedAccountIds = Object.entries(get().accountProxyBindings)
      .filter(([, pid]) => idSet.has(pid))
      .map(([aid]) => aid)
    set((state) => {
      const next = new Map(state.proxyPool)
      for (const id of ids) next.delete(id)
      const bindings = { ...state.accountProxyBindings }
      for (const aid of affectedAccountIds) delete bindings[aid]
      return { proxyPool: next, accountProxyBindings: bindings }
    })
    get().saveToStorage()
    for (const aid of affectedAccountIds) syncAccountProxyToMain(aid)
  },

  toggleProxyEnabled: (id, enabled) => {
    set((state) => {
      const next = new Map(state.proxyPool)
      const entry = next.get(id)
      if (entry) {
        next.set(id, { ...entry, enabled: enabled ?? !entry.enabled })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    // 通知所有绑定该代理的账号更新主进程内存（启用变化会影响是否可用）
    syncAllAccountsBoundToProxy(id)
  },

  updateProxy: (id, updates) => {
    set((state) => {
      const next = new Map(state.proxyPool)
      const entry = next.get(id)
      if (entry) {
        next.set(id, { ...entry, ...updates })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    // url / 启用状态 / 状态变化都需要同步绑定账号
    if ('url' in updates || 'enabled' in updates || 'status' in updates) {
      syncAllAccountsBoundToProxy(id)
    }
  },

  validateProxy: async (id) => {
    const entry = get().proxyPool.get(id)
    if (!entry) {
      return { success: false, error: 'Proxy not found' }
    }
    const { proxyPoolConfig } = get()

    // 先置为 testing 状态
    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, status: 'testing' })
      return { proxyPool: next }
    })

    let result: ProxyValidationResult
    try {
      result = await window.api.proxyPoolValidate({
        url: entry.url,
        testUrl: proxyPoolConfig.testUrl,
        timeoutMs: proxyPoolConfig.testTimeoutMs,
        upstreamProxy: proxyPoolConfig.upstreamProxy
      })
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(id)
      if (existing) {
        const latencyMs = result.latencyMs
        const status: ProxyEntry['status'] = result.success
          ? (latencyMs !== undefined && latencyMs > 3000 ? 'slow' : 'alive')
          : 'dead'
        next.set(id, {
          ...existing,
          status,
          latencyMs: result.latencyMs,
          lastTestedAt: Date.now(),
          lastError: result.success ? undefined : result.error,
          // 验活失败也累计到 failCount，但不计入 reportProxyResult 的注册失败
          failCount: result.success ? existing.failCount : existing.failCount + 1,
          // 自动停用：累计失败超过阈值；但池中可用代理 <= 1 时保护性保留（轮换代理避免变直连）
          enabled: result.success
            ? existing.enabled
            : (state.proxyPoolConfig.autoDisableDead
              && existing.failCount + 1 >= state.proxyPoolConfig.failureThreshold
              && Array.from(state.proxyPool.values()).filter((p) => p.enabled && p.status !== 'dead').length > 1
              ? false
              : existing.enabled)
        })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    // 同步绑定账号：状态变化（alive/slow/dead）影响代理是否可用
    syncAllAccountsBoundToProxy(id)
    return result
  },

  validateProxiesBatch: async (ids, concurrency = 5) => {
    if (ids.length === 0) return
    const validateProxy = get().validateProxy
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        const idx = cursor++
        try { await validateProxy(ids[idx]) } catch { /* per-item error logged */ }
      }
    }
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, () => worker())
    await Promise.all(workers)
  },

  clearProxyPool: () => {
    const affectedAccountIds = Object.keys(get().accountProxyBindings)
    set({ proxyPool: new Map(), proxyPoolCursor: 0, accountProxyBindings: {} })
    get().saveToStorage()
    // 通知所有曾被绑定的账号回退全局
    for (const aid of affectedAccountIds) syncAccountProxyToMain(aid)
  },

  setProxyPoolConfig: (config) => {
    set((state) => ({
      proxyPoolConfig: { ...state.proxyPoolConfig, ...config }
    }))
    get().saveToStorage()
  },

  pickNextProxy: () => {
    const { proxyPool, proxyPoolConfig, proxyPoolCursor } = get()
    if (!proxyPoolConfig.enabled) return null

    // 仅在启用且非 dead 的代理中挑选
    const candidates = Array.from(proxyPool.values())
      .filter(p => p.enabled && p.status !== 'dead')
    if (candidates.length === 0) return null

    let picked: ProxyEntry
    switch (proxyPoolConfig.strategy) {
      case 'random':
        picked = candidates[Math.floor(Math.random() * candidates.length)]
        break
      case 'least_used':
        picked = candidates.reduce((min, cur) => (cur.usedCount < min.usedCount ? cur : min))
        break
      case 'fastest':
        // 已测过的优先按延迟升序；未测过的排最后
        picked = candidates.slice().sort((a, b) => {
          const la = a.latencyMs ?? Number.POSITIVE_INFINITY
          const lb = b.latencyMs ?? Number.POSITIVE_INFINITY
          return la - lb
        })[0]
        break
      case 'round_robin':
      default: {
        const idx = proxyPoolCursor % candidates.length
        picked = candidates[idx]
        set({ proxyPoolCursor: proxyPoolCursor + 1 })
        break
      }
    }

    // 更新使用计数（即时反映到 UI，使用 saveToStorage 防抖）
    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(picked.id)
      if (existing) {
        next.set(picked.id, { ...existing, usedCount: existing.usedCount + 1, lastUsedAt: Date.now() })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    return picked
  },

  reportProxyResult: (id, success, boundEmail, errorMsg) => {
    let autoDisabled = false
    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(id)
      if (!existing) return state
      // 仅「代理连接层错误」才累加 failCount；AWS 业务/风控失败（如 Portal/EOF/邮箱已注册）不计，
      // 避免把好代理（尤其只配了一条的轮换代理）误判停用导致变直连暴露真实 IP。
      const isProxyFail = !success && isProxyConnectionError(errorMsg)
      const failCount = isProxyFail ? existing.failCount + 1 : existing.failCount
      // 轮换代理保护：池中可用代理 <= 1 时不自动停用
      const enabledCount = Array.from(state.proxyPool.values()).filter((p) => p.enabled && p.status !== 'dead').length
      const autoDisable = isProxyFail
        && state.proxyPoolConfig.autoDisableDead
        && failCount >= state.proxyPoolConfig.failureThreshold
        && enabledCount > 1
      autoDisabled = autoDisable
      next.set(id, {
        ...existing,
        failCount,
        lastBoundEmail: boundEmail || existing.lastBoundEmail,
        lastError: success ? existing.lastError : (errorMsg || existing.lastError),
        enabled: autoDisable ? false : existing.enabled,
        status: autoDisable ? 'dead' : existing.status
      })
      return { proxyPool: next }
    })
    get().saveToStorage()
    // 仅在代理被自动停用时通知主进程（普通 used/failCount 计数变化无需同步）
    if (autoDisabled) {
      syncAllAccountsBoundToProxy(id)
    }
  },

  // ==================== 账号-代理绑定 ====================

  bindAccountToProxy: (accountId, proxyId) => {
    set((state) => ({
      accountProxyBindings: { ...state.accountProxyBindings, [accountId]: proxyId }
    }))
    get().saveToStorage()
    // 同步到主进程的账号池
    syncAccountProxyToMain(accountId)
  },

  bindAccountsToProxy: (accountIds, proxyId) => {
    if (accountIds.length === 0) return
    set((state) => {
      const next = { ...state.accountProxyBindings }
      for (const id of accountIds) next[id] = proxyId
      return { accountProxyBindings: next }
    })
    get().saveToStorage()
    for (const id of accountIds) syncAccountProxyToMain(id)
  },

  unbindAccountFromProxy: (accountId) => {
    set((state) => {
      const next = { ...state.accountProxyBindings }
      delete next[accountId]
      return { accountProxyBindings: next }
    })
    get().saveToStorage()
    syncAccountProxyToMain(accountId)
  },

  clearAccountProxyBindings: () => {
    const old = Object.keys(get().accountProxyBindings)
    set({ accountProxyBindings: {} })
    get().saveToStorage()
    for (const id of old) syncAccountProxyToMain(id)
  },

  autoDistributeAccountsToProxies: ({ accountsPerProxy = 0, onlyUnbound = false, accountIds }) => {
    const state = get()
    const aliveProxies = Array.from(state.proxyPool.values())
      .filter((p) => p.enabled && p.status !== 'dead')
    if (aliveProxies.length === 0) {
      return { distributed: 0, perProxy: {}, skipped: 0 }
    }

    // 候选账号
    const candidates = accountIds
      ? accountIds.map((id) => state.accounts.get(id)).filter((a): a is Account => !!a)
      : Array.from(state.accounts.values())
    const targets = onlyUnbound
      ? candidates.filter((a) => !state.accountProxyBindings[a.id])
      : candidates

    if (targets.length === 0) {
      return { distributed: 0, perProxy: {}, skipped: candidates.length }
    }

    const perProxy: Record<string, number> = {}
    aliveProxies.forEach((p) => { perProxy[p.id] = 0 })
    const newBindings = { ...state.accountProxyBindings }

    // 取消已绑定到失效/不存在代理的账号（仅 onlyUnbound=false 时统一重新分配）
    if (!onlyUnbound) {
      for (const id of Object.keys(newBindings)) {
        const proxyExists = aliveProxies.some((p) => p.id === newBindings[id])
        if (!proxyExists) delete newBindings[id]
      }
    }

    let distributed = 0
    let cursor = 0
    for (const account of targets) {
      // accountsPerProxy=0：均分；非 0：每代理填满 N 个再换下一个
      let chosenProxyId: string
      if (accountsPerProxy > 0) {
        // 找第一个还未填满的代理
        let found: string | undefined
        for (let i = 0; i < aliveProxies.length; i++) {
          const pid = aliveProxies[i].id
          if (perProxy[pid] < accountsPerProxy) {
            found = pid
            break
          }
        }
        if (!found) {
          // 全部代理都满了：跳过剩余账号
          break
        }
        chosenProxyId = found
      } else {
        chosenProxyId = aliveProxies[cursor % aliveProxies.length].id
        cursor++
      }
      newBindings[account.id] = chosenProxyId
      perProxy[chosenProxyId]++
      distributed++
    }

    set({ accountProxyBindings: newBindings })
    get().saveToStorage()
    // 同步到主进程
    for (const id of targets.slice(0, distributed)) {
      syncAccountProxyToMain(id.id)
    }
    return { distributed, perProxy, skipped: targets.length - distributed }
  },

  getAccountProxyUrl: (accountId) => {
    const state = get()
    const proxyId = state.accountProxyBindings[accountId]
    if (!proxyId) return undefined
    const proxy = state.proxyPool.get(proxyId)
    if (!proxy || !proxy.enabled || proxy.status === 'dead') return undefined
    return proxy.url
  },

  // ============ 账号池热切换 · 2026-07-23 hot-swap-accounts ============
  switchProxyActiveAccount: async (accountId) => {
    try {
      const result = await window.api.setActiveProxyAccount(accountId)
      if (!result.success) {
        console.warn('[Store] switchProxyActiveAccount failed:', result.error)
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Store] switchProxyActiveAccount error:', msg)
      return { success: false, error: msg }
    }
  },

  syncPoolMembersToProxy: async (payload) => {
    try {
      const result = await window.api.updateProxyPoolMembers(payload as never)
      if (!result.success) {
        console.warn('[Store] syncPoolMembersToProxy failed:', result.error)
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Store] syncPoolMembersToProxy error:', msg)
      return { success: false, error: msg }
    }
  },

  // 唯一收口:把「active 账号变更」传播到主进程反代 · RCA §6
  // .archive/2026-07-28/proxy-hot-switch-single-account/
  syncActiveAccountToProxy: async (accountId) => {
    try {
      const status = await window.api.proxyGetStatus()
      if (!status?.running) {
        return { applied: false, reason: 'not_running' }
      }

      // 凭据只从 store 现读:切换成功分支刚把 OIDC 刷新后的 access/refresh 回写这里,
      // 而调用方组件手里的 account prop 是渲染时快照(可能带已被 rotate 作废的 refresh v1)
      const acc = get().accounts.get(accountId)
      if (!acc?.credentials?.accessToken) {
        return { applied: false, reason: 'no_credentials' }
      }

      // 1) 先入池/刷凭据 —— 单账号模式是严格模式,指定的账号不在池会直接 503
      await window.api.updateProxyPoolMembers({ add: [toProxyAccount(acc)] } as never)

      // 2) 单账号模式的真开关是 config.selectedAccountIds[0](currentIndex 在这条路不被消费)
      const cfg = (status.config || {}) as { enableMultiAccount?: boolean }
      const isSingle = cfg.enableMultiAccount === false
      if (isSingle) {
        await window.api.proxyUpdateConfig({ selectedAccountIds: [accountId] })
      }

      // 3) 指针 + 会话粘性失效(多账号轮询下“从此账号开始轮”)
      await window.api.setActiveProxyAccount(accountId)

      return { applied: true, mode: isSingle ? 'single' : 'multi' }
    } catch (err) {
      // 不得抛出:反代同步失败不应阻断已经成功的 IDE/CLI 切换
      console.warn('[Store] syncActiveAccountToProxy error:', err instanceof Error ? err.message : String(err))
      return { applied: false, reason: 'error' }
    }
  }
}))

/**
 * 把单个账号的代理绑定信息同步到主进程账号池
 * （主进程账号池里的 ProxyAccount.proxyUrl 由此 IPC 设置）
 */
function syncAccountProxyToMain(accountId: string): void {
  try {
    const url = useAccountsStore.getState().getAccountProxyUrl(accountId)
    void window.api.accountSetProxyBinding?.(accountId, url)
  } catch (err) {
    console.warn('[Store] Failed to sync account proxy binding to main:', err)
  }
}

/**
 * 当某个代理发生变化（URL/启用状态/有效性）时，
 * 同步所有绑定到该代理的账号到主进程，确保主进程内存里的 ProxyAccount.proxyUrl 与代理池实际情况一致
 */
function syncAllAccountsBoundToProxy(proxyId: string): void {
  try {
    const state = useAccountsStore.getState()
    const affectedAccountIds = Object.entries(state.accountProxyBindings)
      .filter(([, pid]) => pid === proxyId)
      .map(([aid]) => aid)
    for (const aid of affectedAccountIds) {
      syncAccountProxyToMain(aid)
    }
  } catch (err) {
    console.warn('[Store] Failed to sync accounts bound to proxy:', err)
  }
}

/** 触发 Webhook 事件（封装错误处理，不阻塞主业务流程） */
function triggerWebhook(event: WebhookEvent, payload: WebhookMessage): void {
  try {
    void useWebhookStore.getState().triggerEvent(event, payload)
  } catch (err) {
    console.warn(`[Webhook] trigger ${event} failed:`, err)
  }
}

// ==================== 代理 URL 解析辅助 ====================

interface ParsedProxy {
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  normalized: string
}

/**
 * 解析多种代理 URL 格式：
 *   - http://host:port
 *   - http://user:pass@host:port
 *   - socks5://host:port
 *   - host:port              （默认 http）
 *   - host:port:user:pass    （Stormproxies 等代理商常用格式）
 *   - user:pass@host:port    （省略 scheme）
 */
// 判断错误是否为「代理连接层」问题（而非 AWS 业务/风控失败）。
// 仅这类错误才累加代理 failCount / 触发自动停用，避免风控失败把好代理（尤其单条轮换代理）误杀成直连。
function isProxyConnectionError(msg: string | undefined): boolean {
  const m = (msg || '').toLowerCase()
  if (!m) return false
  return m.includes('proxy')
    || m.includes('econnrefused')
    || m.includes('econnreset')
    || m.includes('etimedout')
    || m.includes('ehostunreach')
    || m.includes('enetunreach')
    || m.includes('tunnel')
    || m.includes('dial tcp')
    || m.includes('connection refused')
    || m.includes('connection reset')
    || m.includes('407')
    || m.includes('socks')
}

function parseProxyUrl(raw: string): ParsedProxy | null {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  // 形式 1: scheme://...
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      const protocol = normalizeProtocol(u.protocol.replace(':', ''))
      if (!protocol) return null
      const port = Number(u.port) || defaultPort(protocol)
      if (!u.hostname || !Number.isFinite(port)) return null
      return {
        protocol,
        host: u.hostname,
        port,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
        normalized: buildProxyUrl(protocol, u.hostname, port, u.username, u.password)
      }
    } catch {
      return null
    }
  }

  // 形式 2: host:port:user:pass（4 段冒号分隔）
  const segs = trimmed.split(':')
  if (segs.length === 4 && /^\d+$/.test(segs[1])) {
    const [host, portStr, user, pass] = segs
    const port = Number(portStr)
    if (!host || !Number.isFinite(port)) return null
    return {
      protocol: 'http',
      host, port,
      username: user || undefined,
      password: pass || undefined,
      normalized: buildProxyUrl('http', host, port, user, pass)
    }
  }

  // 形式 3: user:pass@host:port（缺 scheme）
  if (trimmed.includes('@')) {
    const [authPart, hostPart] = trimmed.split('@')
    const [user, pass] = authPart.split(':')
    const [host, portStr] = (hostPart || '').split(':')
    const port = Number(portStr)
    if (!host || !Number.isFinite(port)) return null
    return {
      protocol: 'http',
      host, port,
      username: user || undefined,
      password: pass || undefined,
      normalized: buildProxyUrl('http', host, port, user, pass)
    }
  }

  // 形式 4: host:port（裸格式，默认 http）
  if (segs.length === 2 && /^\d+$/.test(segs[1])) {
    const port = Number(segs[1])
    if (!segs[0] || !Number.isFinite(port)) return null
    return {
      protocol: 'http',
      host: segs[0],
      port,
      normalized: buildProxyUrl('http', segs[0], port)
    }
  }

  return null
}

function normalizeProtocol(raw: string): ProxyProtocol | null {
  const p = raw.toLowerCase()
  if (p === 'http' || p === 'https' || p === 'socks5' || p === 'socks4') return p
  if (p === 'socks') return 'socks5'
  return null
}

function defaultPort(protocol: ProxyProtocol): number {
  switch (protocol) {
    case 'http': return 8080
    case 'https': return 443
    case 'socks5':
    case 'socks4': return 1080
  }
}

function buildProxyUrl(
  protocol: ProxyProtocol,
  host: string,
  port: number,
  username?: string,
  password?: string
): string {
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : ''
  return `${protocol}://${auth}${host}:${port}`
}
