import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as machineIdModule from './machineId'
import { join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeFile, readFile } from 'fs/promises'
import { homedir as nodeHomedir } from 'node:os'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import icon from '../../resources/icon.png?asset'
import { ProxyServer, configureProxyClients, type ProxyAccount, type ProxyConfig, type ProxyClientTarget, type ProxyClientModel, type HeldRequestsInfo } from './proxy'
import { 
  initKProxyService, 
  getKProxyService, 
  generateDeviceId, 
  isValidDeviceId,
  type KProxyConfig,
  type DeviceIdMapping
} from './kproxy'
// 说明:resolveApiKeyProfileArnIfEligible / validateApiKeyCredential / sha256Fingerprint /
// resolveProfileArnForVerify 的消费点已随 verify-api-key / compute-token-fingerprint /
// verify-account-credentials 剥离到 accountService/verify.ts(W2),本文件不再直接引用。
import { fetchKiroModels, fetchSubscriptionToken, fetchAvailableSubscriptions, setUserPreference, setUseKProxyForApiInProxy, setLogStreamEvents, setPayloadSizeLimitKB, setTokenBufferReserve, setEnableTokenBufferReserve, setEnableProxyContextSafetyNet, callKiroApi, fetchEnterpriseProfileArn, fetchEnterpriseProfiles, setProfileArnPersistCallback, setTokenRefreshCallbackForModelFetch, setAccountModelSyncCallback, setRateLimitRetryConfig, setAgentMode, KNOWN_SSO_OIDC_REGIONS, type KiroProfile } from './proxy/kiroApi'
// 账号业务函数(IPC 与将来的 web 面板 HTTP 共用同一实现;业务层不依赖 preload / IpcMainInvokeEvent)
// 两个 deps 接口的分工见 accountService/types.ts:AccountStoreDeps 注释 ——
// 前者模块级即可装配,后者要等 app.whenReady 后 proxyServer / mainWindow / api 就位。
import type { AccountRuntimeDeps } from './accountService/types'
import { refreshAccountToken } from './accountService/refresh'
import {
  checkAccountStatus,
  backgroundBatchCheck,
  type BatchCheckAccount
} from './accountService/check'
// 后台批量刷新 Token —— 服务器形态下唯一的续期路径（主进程调度器每 60s 调它）。
// 原先内联在本文件(:3959)且只把结果 emit 给渲染进程,无渲染进程时静默丢失,见该文件头注释。
import {
  backgroundBatchRefresh,
  type BackgroundRefreshAccount
} from './accountService/backgroundRefresh'
// 用量/订阅解析 SSOT 的最后一个 index.ts 消费点随 backgroundBatchRefresh 一并搬走
// （parseCreditUsage / parseSubscription 现由 accountService 内部各业务函数直接引用）。
import type { VerifyApiKeyResult } from '../shared/types/credential'
import { isAccountSuspensionError } from '../shared/accountSuspension'
import { buildCompleteLoginResult } from './proxy/profile-selection'
import { checkPoolAdmission, logPoolAdmissionSkips, type PoolAdmissionSkip } from './proxy/activation'
import {
  writeKiroAuthTokenFile,
  readKiroAuthTokenFile,
  parseAccessTokenClaims,
  watchKiroAuthTokenFile,
  resolveProfileArnForWrite,
  KIRO_AUTH_TOKEN_PATH
} from './kiroAuthSync'
// 上游 Kiro / AWS API 的**共享**实现（零 electron，服务端形态用同一份 —— af94451）。
// 这些函数曾是本文件的模块私有函数，于是 `node out/server/index.js` 拿不到它们，
// 服务器上 accessToken 过期后无法自动刷新。抽取后本文件只负责装配（见下方 `upstreamApi`）。
import { createUpstreamApi, KIRO_AUTH_ENDPOINT } from './upstreamApi'
import { openaiToKiro } from './proxy/translator'
import { safeCreateProxyAgent } from './proxy/systemProxy'
import { proxyLogStore, interceptConsole, setLogTruncationEnabled } from './proxy/logger'
import { perfDiag } from './proxy/perfDiag'
import { installIpcSizeGuard } from './utils/emitToRenderer'
import { installStdioGuard } from './utils/stdioGuard'
import { registerIPCHandlers as registerRegistrationHandlers } from './registration/ipc-handlers'
import { registerProxyPoolIpcHandlers } from './ipc/proxyPool'
// 局域网 web 面板装配(W6)。装配逻辑收在 ipc/webPanelWiring.ts:
//   本文件只留三个调用点 —— IPC 注册 / ready-to-show 自启动 / will-quit 清理。
//   webPanel/ 目录本身不得 import electron(架构闸门 webpanel_auth_constraints.test.ts),
//   故 electron 依赖留在 wiring 一侧。
import { WebPanelWiring, buildPanelRouteDeps } from './ipc/webPanelWiring'
import { buildPanelProxyDeps } from './ipc/panelProxyDeps'
import { applyProxyConfigUpdate } from './proxy/applyProxyConfigUpdate'
import {
  applyAccountDataMutation,
  setStoreRef as setAccountStoreRef,
  setLastSavedDataSetter as setAccountLastSavedSetter,
  setBroadcaster as setAccountBroadcaster,
  type AccountsBlob,
  type BroadcastPayload as AccountsBroadcastPayload
} from './accountService/state'
// 切号 / 退出登录 / 导入导出 / 订阅 的业务实现已抽到 accountService/,
// 让 IPC 通道与将来的 web 面板 HTTP 层共用同一份实现(决策卡 §3),而不是各写一份。
// 本文件的 handler 只负责:注入宿主机能力(Electron dialog / 本机磁盘 / SQLite)+ 注入模块级状态的读写。
import {
  switchAccountToIde,
  logoutAccount,
  type SwitchAccountCredentials
} from './accountService/switch'
import {
  switchAccountToCli,
  type SwitchAccountCliCredentials
} from './accountService/switchCli'
import {
  getAccountModels,
  getAccountSubscriptions,
  getAccountSubscriptionUrl,
  setAccountOverage
} from './accountService/subscription'
import { exportToFile, importFromFile } from './accountService/transfer'
// 账号读写 / 凭证验证（W2 剥离 · 同一 barrel 出口）
import {
  loadAccounts as svcLoadAccounts,
  saveAccounts as svcSaveAccounts,
  getLocalActiveAccount as svcGetLocalActiveAccount,
  loadKiroCredentials as svcLoadKiroCredentials,
  computeTokenFingerprint as svcComputeTokenFingerprint,
  verifyApiKey as svcVerifyApiKey,
  importFromSsoToken as svcImportFromSsoToken,
  verifyAccountCredentials as svcVerifyAccountCredentials,
  importApiKeys as svcImportApiKeys,
  type AccountStoreDeps,
  type AccountStoreRef,
  type CredentialFsDeps,
  type VerifyApiDeps,
  type VerifyCredentialsInput,
  type ApiKeyImportDeps,
  type ApiKeyImportInput
} from './accountService'
// 持久化端口（K-3）：数据文件名 / 混淆密钥 / 四态前置校验的单一真源。
// 桌面仍用 electron-store 构造实例（它额外提供 renderer 侧 IPC 桥，且正在正常工作），
// 但**判据**与服务端共用同一份 —— 否则两端会各自漂移出不同的失败行为。
import {
  ACCOUNT_STORE_ENCRYPTION_KEY,
  ACCOUNT_STORE_NAME,
  adaptRawStoreToPort,
  preflightAccountStore
} from './persistence/accountStorePort'
import {
  createTray,
  destroyTray,
  updateTrayMenu,
  updateCurrentAccount,
  updateAccountList,
  setTrayTooltip,
  updateTrayLanguage,
  type TraySettings,
  defaultTraySettings
} from './tray'

// ============ 后台节流:用 Chromium 命令行开关，不用 webPreferences.backgroundThrottling ============
//
// 2026-07-25 修复「挂后台/最小化一段时间后前端点不开」(第 4 次同症状，但与前 3 次根因不同)
//
// 前 3 次(c3d7905 / 29d6773 / estimateTokens memoize)都是主进程 event loop 被 CPU 饿死。
// 本次实测否证了那条路径:main CPU 仅 9.2% + 反代 HTTP 1-2ms 秒回 → event loop 完全健康，
// 但 UI 仍点不开。改判为 Electron 自身 bug:
//
//   webPreferences.backgroundThrottling:false + frame:false(Windows 上本应用就是 frameless)
//   → Electron 的 allow_disabling_blink_scheduler_throttling_per_renderview.patch 在
//     WebViewImpl::SetVisibilityState 里短路 return，跳过 observers_ 通知
//   → 窗口被最小化/遮挡后内部 visibility 状态永久 desync
//   → 依赖 is_page_visible_ 门控的渲染/输入路径再也恢复不了(hover 有效但点击全死)
//
//   上游证据:electron#29646「backgroundThrottling:false causes window to become
//   unresponsive after restoring」(frameless 窗口复现步骤与用户描述完全一致)；
//   electron#50250 给出 patch 层根因，修复 PR#50264 至 2026-07 仍未合入。本项目 Electron 38.1.2 带此 patch。
//
// 修法:改用 Chromium 原生命令行开关。它们走「进程优先级 + timer 节流」层，
// 完全不经过上面那个有 bug 的 blink visibility patch，因此没有 desync 风险。
// 三个开关合起来覆盖原 backgroundThrottling:false 的全部目的(保证隐藏时定时器照常跑):
//   - disable-background-timer-throttling      : setInterval/setTimeout 不被降频(原始需求)
//   - disable-renderer-backgrounding           : 不降低不可见页面渲染进程的优先级
//   - disable-backgrounding-occluded-windows   : 被遮挡(非最小化)窗口同样不进入后台态
// 注意:必须在 app ready 之前 appendSwitch，ready 之后设置无效。
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// ============ stdio 错误收口:管道断开不得崩主进程 ============
//
// 2026-08-05 修复用户两个弹窗「Uncaught Exception: Error: EPIPE broken pipe, write」
// (RCA: .agent-workspace/.archive/2026-08-05/main-process-epipe-crash/)
//
// 必须在这里、app ready 之前装配 —— 打包版无 TTY 启动时,启动早期的日志
// 就已经能触发 EPIPE。晚一步装配等于漏掉那个窗口。
//
// onFatal 承接 Electron 原本的行为:我们一注册 uncaughtException 监听,
// Electron lib/browser/init.ts 里的 `listenerCount > 1 → return` 就让它自带的
// showErrorBox 永久沉默了。所以非管道类真错误必须由这里补回可见性 + 落盘,
// 否则会把「可见崩溃」变成「静默猝死」(详见 stdioGuard.ts 顶部长注释)。
//
// 落盘走 proxyLogStore 而非 proxyLogger:后者的文件流默认 enabled:false 且
// 全仓从未调用 configure(),写不进磁盘;proxyLogStore 有 flushSaveNow() 强制落盘。
// ready 之前 store 尚未 initialize,此时 add() 只进内存 —— 故这里显式 flush,
// 且无论如何都先弹窗(弹窗不依赖任何初始化)。
installStdioGuard({
  onFatal: (err, origin) => {
    const e = err instanceof Error ? err : new Error(String(err))
    const stack = e.stack || `${e.name}: ${e.message}`
    try {
      proxyLogStore.add({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        category: 'Main',
        message: `[FATAL][${origin}] ${e.message}`,
        data: { stack }
      })
      // 立刻落盘:进程可能马上就没了,等 3s 的定时保存等不到
      void proxyLogStore.flushSaveNow()
    } catch { /* 留痕失败不得二次崩溃 */ }
    // 补回 Electron 被我们抑制掉的那个弹窗(仅真错误,stdio EPIPE 不会走到这里)
    try {
      dialog.showErrorBox('A JavaScript error occurred in the main process', `${origin}:\n${stack}`)
    } catch { /* ignore */ }
  }
})

// ============ 自动更新配置 ============
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

function setupAutoUpdater(): void {
  // 检查更新出错
  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error)
    mainWindow?.webContents.send('update-error', error.message)
  })

  // 检查更新中
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...')
    mainWindow?.webContents.send('update-checking')
  })

  // 有可用更新
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version)
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  // 没有可用更新
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available, current:', info.version)
    mainWindow?.webContents.send('update-not-available', { version: info.version })
  })

  // 下载进度
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`)
    mainWindow?.webContents.send('update-download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  // 下载完成
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version)
    mainWindow?.webContents.send('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })
}

// API 类型配置
type UsageApiType = 'rest' | 'cbor'
let currentUsageApiType: UsageApiType = 'rest' // 默认使用 REST API (GetUsageLimits)

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

// 是否使用 K-Proxy 代理发送 API 请求
let useKProxyForApi: boolean = false

export function setUseKProxyForApi(enabled: boolean): void {
  useKProxyForApi = enabled
  // 同步设置到 kiroApi.ts
  setUseKProxyForApiInProxy(enabled)
  console.log(`[API] Use K-Proxy for API requests: ${enabled}`)
}

export function getUseKProxyForApi(): boolean {
  return useKProxyForApi
}

// ============ 上游 API（共享模块 · 与服务端形态同一份实现）============
//
// 实现在 `./upstreamApi`（零 electron —— 服务端 `node out/server/index.js` 用的是同一份，
// 见 af94451）。本文件只剩**装配**：把三个桌面侧可变状态以 getter 注入。
//
// 为什么必须只 create 一次：`refreshTokenByMethod` 的 single-flight 表在工厂闭包内。
// 同一进程两个实例 = 两张表 = 同一个 rotating refreshToken 可能被并发刷两次 →
// 后到的用已作废 token → 401 → **账号被上游踢下线**。门禁
// `test/main/architecture/upstream_api_single_instance.test.ts` 守这一条。
const upstreamApi = createUpstreamApi({
  // 桌面端可由 IPC 切（`set-use-kproxy-for-api`），故读模块级 `useKProxyForApi`；
  // 服务端固定 false（服务器上没有本地 IDE 出网流量要拦截，K-Proxy 不运行）。
  useKProxy: () => useKProxyForApi,
  getKProxyService: () => getKProxyService(),
  // 真源是 store 的 `usageApiType` 键；此处读本文件的内存缓存，IPC 语义零变化。
  getUsageApiType: () => currentUsageApiType,
  // 账号绑定域的设备 ID（kproxy 的 64 位 hex）。**不是** machineId.ts 的系统机器码
  // （UUID 形态）—— 混用有先例：fce8c89 误注入 UUID 后匹配不上
  // `kproxy/mitmProxy.ts:17 KIRO_UA_REGEX`，ksk_ 账号的设备 ID 改写静默失效。
  // 下面这行就是原 index.ts:1230 本地 `getCurrentMachineId` 的函数体。
  getDeviceIdForUa: () => getKProxyService()?.getDeviceId()
})

// 解构出现有调用点用到的符号 —— 全部调用点写法一字不变（recon §6.1：它们全是符号引用或
// 直接调用，没有一处依赖「这些函数与本文件其余代码共享闭包」这一事实；本轮已逐点核实
// 实参逐字相同、arity 未变）。
// `fetchWithAppProxy` 另有 11 个本文件内的登录/导入流程调用点（GitHub API / 连通性诊断 /
// 两条 SSO 设备流 / external IdP discovery / social oauth-token），不属本次抽取范围，
// 故这里保留同名绑定而非改写那些调用点。
const {
  refreshTokenByMethod,
  getUsageAndLimits,
  getUserInfo,
  ssoDeviceAuth,
  fetchWithAppProxy
} = upstreamApi
// ============ 代理设置 ============

/**
 * 规范化代理 URL，确保 protocol://host:port 格式。
 * 容错处理用户常见的格式错误：
 *   http:127.0.0.1:7890     → http://127.0.0.1:7890   (缺 //)
 *   http:/127.0.0.1:7890    → http://127.0.0.1:7890   (单 /)
 *   127.0.0.1:7890          → http://127.0.0.1:7890   (无 protocol)
 *   http://127.0.0.1:7890   → http://127.0.0.1:7890   (已规范)
 */
export function normalizeProxyUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  // 已是标准 protocol:// 前缀
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  // 有 protocol: 但缺/少 //
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  // 无 protocol，默认 http
  return `http://${trimmed}`
}

// 设置代理环境变量
function applyProxySettings(enabled: boolean, url: string): void {
  if (enabled && url) {
    const normalized = normalizeProxyUrl(url)
    process.env.HTTP_PROXY = normalized
    process.env.HTTPS_PROXY = normalized
    process.env.http_proxy = normalized
    process.env.https_proxy = normalized
    if (normalized !== url) {
      console.log(`[Proxy] Enabled: ${normalized} (规范化自: ${url})`)
    } else {
      console.log(`[Proxy] Enabled: ${normalized}`)
    }
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    console.log('[Proxy] Disabled')
  }
}

// ============ 防抖 store 写入（减少磁盘 I/O） ============
const pendingStoreWrites: Map<string, unknown> = new Map()
let storeFlushTimer: ReturnType<typeof setTimeout> | null = null
const STORE_FLUSH_INTERVAL = 5000 // 5 秒批量写入一次

function debouncedStoreSet(key: string, value: unknown): void {
  pendingStoreWrites.set(key, value)
  if (!storeFlushTimer) {
    storeFlushTimer = setTimeout(flushStoreWrites, STORE_FLUSH_INTERVAL)
  }
}

function flushStoreWrites(): void {
  storeFlushTimer = null
  if (!store || pendingStoreWrites.size === 0) return
  for (const [key, value] of pendingStoreWrites) {
    store.set(key, value)
  }
  pendingStoreWrites.clear()
}

/** 会话历史保留上限（滚动） */
const PROXY_SESSION_HISTORY_LIMIT = 200
/** orphan snapshot 在 store 的 key（强杀/崩溃下次启动时归档） */
const PROXY_ORPHAN_SESSION_KEY = 'proxyOrphanSessionSnapshot'

/**
 * 把当前代理会话（本次 启动→停止）快照归档为一条历史记录。
 * 在 proxy-stop 以及应用退出（服务仍在运行）时调用。跳过 0 请求的空会话，避免误点启停刷垃圾。
 */
function archiveProxySessionIfAny(): void {
  try {
    if (!proxyServer || !store) return
    const rec = proxyServer.snapshotSession()
    if (rec.totalRequests <= 0) return // 空会话不记录
    const history = (store.get('proxySessionHistory') as import('./proxy/types').ProxySessionRecord[] | undefined) || []
    history.push(rec)
    const trimmed = history.length > PROXY_SESSION_HISTORY_LIMIT
      ? history.slice(-PROXY_SESSION_HISTORY_LIMIT)
      : history
    store.set('proxySessionHistory', trimmed)
    // 正常归档后清 orphan，避免下次启动重复归档
    store.set(PROXY_ORPHAN_SESSION_KEY, undefined)
    console.log(`[ProxySession] Archived session: ${rec.totalRequests} req (✓${rec.successRequests} ✗${rec.failedRequests}), ${rec.credits.toFixed(2)} credits`)
  } catch (err) {
    console.warn('[ProxySession] archive failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * 启动时回收上一次 orphan session（上次强杀/崩溃/关机没来得及正常归档时留下的）。
 * endTime 是最后一次 60s tick 时间点，最多丢 <60s 的请求计数（已知杂噪，可接受）。
 * 必须在 store 就绪之后、任何新会话开始写 orphan 之前调用。
 */
async function restoreOrphanProxySessionIfAny(): Promise<void> {
  try {
    if (!store) { await initStore() }
    if (!store) return
    const orphan = store.get(PROXY_ORPHAN_SESSION_KEY) as import('./proxy/types').ProxySessionRecord | undefined
    if (!orphan || typeof orphan !== 'object') return
    if (!orphan.totalRequests || orphan.totalRequests <= 0) {
      store.set(PROXY_ORPHAN_SESSION_KEY, undefined)
      return
    }
    const history = (store.get('proxySessionHistory') as import('./proxy/types').ProxySessionRecord[] | undefined) || []
    history.push(orphan)
    const trimmed = history.length > PROXY_SESSION_HISTORY_LIMIT
      ? history.slice(-PROXY_SESSION_HISTORY_LIMIT)
      : history
    store.set('proxySessionHistory', trimmed)
    store.set(PROXY_ORPHAN_SESSION_KEY, undefined)
    console.log(`[ProxySession] Restored orphan session (${orphan.totalRequests} req, ${orphan.credits.toFixed(2)} credits) from previous unclean shutdown`)
  } catch (err) {
    console.warn('[ProxySession] restore orphan failed:', err instanceof Error ? err.message : err)
  }
}

let trayMenuTimer: ReturnType<typeof setTimeout> | null = null

function debouncedUpdateTrayMenu(): void {
  if (trayMenuTimer) return
  trayMenuTimer = setTimeout(() => {
    trayMenuTimer = null
    updateTrayMenu()
  }, 3000)
}

// ============ Kiro API 反代服务器 ============
let proxyServer: ProxyServer | null = null

/** 部署期 TLS 代理信任不是用户配置；任何桌面写回路径都必须先剥离。 */
function withoutTrustedTlsProxyIPs(config: ProxyConfig): ProxyConfig {
  const persisted = { ...config } as ProxyConfig & { trustedTlsProxyIPs?: unknown }
  delete persisted.trustedTlsProxyIPs
  return persisted
}

/**
 * 局域网 web 面板装配实例(W6)。
 *
 * 在 `registerIPCHandlers` 内赋值(需要 accountDeps / accountServiceDeps 已就绪),
 * 由 `ready-to-show` 的自启动分支与 `will-quit` 的清理分支读取。
 * 与 proxyServer 同为模块级单例 —— 面板独立端口,可开面板而不开反代。
 */
let webPanelWiring: WebPanelWiring | null = null

function initProxyServer(): ProxyServer {
  if (proxyServer) return proxyServer

  // 确保日志存储已初始化（app.whenReady 中已调用，此处兜底）
  proxyLogStore.initialize(app.getPath('userData'))

  // 从 store 加载保存的配置，如果没有则使用默认配置
  const savedRaw = store?.get('proxyConfig') as
    | (Partial<ProxyConfig> & { trustedTlsProxyIPs?: unknown })
    | undefined
  const savedConfig = savedRaw
    ? withoutTrustedTlsProxyIPs({ ...savedRaw } as ProxyConfig)
    : undefined
  // 从 store 加载保存的 Usage API 类型
  const savedUsageApiType = store?.get('usageApiType') as 'rest' | 'cbor' | undefined
  if (savedUsageApiType) {
    setUsageApiType(savedUsageApiType)
  }
  // 从 store 加载保存的 K-Proxy 代理设置
  const savedUseKProxyForApi = store?.get('useKProxyForApi') as boolean | undefined
  if (savedUseKProxyForApi !== undefined) {
    setUseKProxyForApi(savedUseKProxyForApi)
  }
  // 从 store 加载保存的累计 credits 和 tokens
  const savedTotalCredits = (store?.get('proxyTotalCredits') as number) || 0
  const savedInputTokens = (store?.get('proxyInputTokens') as number) || 0
  const savedOutputTokens = (store?.get('proxyOutputTokens') as number) || 0
  // 从 store 加载保存的请求统计
  const savedTotalRequests = (store?.get('proxyTotalRequests') as number) || 0
  const savedSuccessRequests = (store?.get('proxySuccessRequests') as number) || 0
  const savedFailedRequests = (store?.get('proxyFailedRequests') as number) || 0
  const defaultConfig: ProxyConfig = {
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
    clientDrivenToolExecution: true,
    // 2026-07-26 默认开启：关闭时超模型 context window 的请求会原样出站导致三端点全 400
    // （RCA: .archive/2026-07-26/proxy-400-model-and-content-length/）
    enableTokenBufferReserve: true,
    tokenBufferReserve: 20000
  }
  
  // 合并保存的配置和默认配置
  const config: ProxyConfig = savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig

  // ===== 一次性迁移:纠正历史持久化的 enableTokenBufferReserve=false =====
  // 仅改 defaultConfig 无效 —— savedConfig 会覆盖它(该字段在 proxyServer 的
  // updateConfig 白名单里,任何一次配置保存都会把当年的 false 落盘)。
  // v1.6.8~v1.7.6 期间该开关默认关闭,关闭时超模型 context window 的请求原样出站
  // → 三端点全 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD。这里一次性纠正为 true。
  // 带 FLAG 只执行一次:此后用户若主动关闭,不会被再次强开。
  if (store) {
    const MIGRATION_KEY = 'accountDataMigration'
    const FLAG = 'tokenBufferReserveDefaultOn'
    const migrationState = (store.get(MIGRATION_KEY, {}) as Record<string, number>) || {}
    if (!migrationState[FLAG]) {
      const wasOff = config.enableTokenBufferReserve !== true
      config.enableTokenBufferReserve = true
      // 无条件写回:`proxy-get-status` 在 proxyServer 未初始化时会**原样返回 store 里的
      // config**,若 store 里缺该字段,渲染进程 `config.enableTokenBufferReserve || false`
      // 会显示"关闭"而主进程实际已开启 → 显示与实际不一致。这里确保 store 里一定有该字段。
      store.set('proxyConfig', withoutTrustedTlsProxyIPs(config))
      if (wasOff) {
        console.log('[Migration] enableTokenBufferReserve 由历史 false 纠正为 true(防上下文超限 400)')
      }
      store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
    }
  }

  // 恢复 payload 大小限制
  if (config.payloadSizeLimitKB) {
    setPayloadSizeLimitKB(config.payloadSizeLimitKB)
  }
  // 恢复 Token buffer reserve（开关 + 数值）
  setEnableTokenBufferReserve(config.enableTokenBufferReserve === true)
  // 恢复出站上下文安全网总开关(Layer B RTK + Layer C 静默看门狗;默认关闭)
  setEnableProxyContextSafetyNet(config.enableProxyContextSafetyNet === true)
  if (config.tokenBufferReserve) {
    setTokenBufferReserve(config.tokenBufferReserve)
  }
  // v1.7.6 恢复 429 rate limit 重试策略(包括 strategy 默认)
  setRateLimitRetryConfig({
    maxAttempts: config.rateLimitRetryMaxAttempts,
    baseMs: config.rateLimitRetryBaseMs,
    strategy: config.rateLimitRetryStrategy
  })
  // 恢复性能诊断落盘开关 —— 必须在启动路径也接线,否则重启后用户开的开关静默失效
  perfDiag.configure(config.enablePerfDiagLog === true, app.getPath('userData'))
  // 恢复 Agent 模式（vibe / spec）
  if (config.agentMode) {
    setAgentMode(config.agentMode)
  }

  proxyServer = new ProxyServer(
    config,
    {
      onRequest: (info) => {
        mainWindow?.webContents.send('proxy-request', info)
      },
      onResponse: (info) => {
        mainWindow?.webContents.send('proxy-response', info)
      },
      onError: (error) => {
        console.error('[ProxyServer] Error:', error)
        mainWindow?.webContents.send('proxy-error', error.message)
      },
      onStatusChange: (running, port) => {
        mainWindow?.webContents.send('proxy-status-change', { running, port })
      },
      // Token 刷新回调 - 复用已有的刷新逻辑，含账号绑定代理
      onTokenRefresh: async (account) => {
        try {
          console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}${account.proxyUrl ? ' [via bound proxy]' : ''}`)
          const refreshResult = await refreshTokenByMethod(
            account.refreshToken || '',
            account.clientId || '',
            account.clientSecret || '',
            account.region || 'us-east-1',
            account.authMethod,
            account.proxyUrl,  // 账号绑定的代理（如有）
            { tokenEndpoint: account.tokenEndpoint, scopes: account.scopes }
          )

          if (refreshResult.success && refreshResult.accessToken) {
            return {
              success: true,
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresAt: Date.now() + (refreshResult.expiresIn || 3600) * 1000
            }
          }
          return { success: false, error: refreshResult.error || 'Token 刷新失败' }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
        }
      },
      // 账号更新回调 - 通知渲染进程更新账号数据
      onAccountUpdate: (account) => {
        mainWindow?.webContents.send('proxy-account-update', {
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt
        })
      },
      // 账号被 Kiro 后端长期封禁 - 通知渲染进程标记 lastError + 持久化到 store
      // 不同于 token 失效，需要人工解封；账号池已自动跳过该账号
      onAccountSuspended: (info) => {
        console.warn(`[ProxyServer] Account suspended: ${info.email || info.accountId} (${info.reason})`)
        // 推送 IPC 事件给前端 store
        mainWindow?.webContents.send('proxy-account-suspended', {
          id: info.accountId,
          email: info.email,
          reason: info.reason,
          message: info.message,
          suspendedAt: Date.now()
        })
        // 持久化封禁状态：依赖 renderer store 接收 IPC 后通过 saveToStorage 防抖落盘，
        // 主进程仅在 lastSavedData 内存快照上做轻量更新，避免每次封禁都触发整库加解密 IO。
        // 这能从根本上消除频繁封禁场景下的主进程阻塞（旧代码 store.get + store.set 各做一次 AES 全库加解密）
        if (lastSavedData && typeof lastSavedData === 'object') {
          try {
            const data = lastSavedData as { accounts?: Record<string, Record<string, unknown>> }
            if (data.accounts?.[info.accountId]) {
              data.accounts[info.accountId] = {
                ...data.accounts[info.accountId],
                status: 'error',
                lastError: `[${info.reason}] ${info.message}`,
                lastCheckedAt: Date.now()
              }
            }
          } catch (e) {
            console.error('[ProxyServer] Failed to update suspended state in memory:', e)
          }
        }
      },
      // Credits 更新回调 - 使用防抖持久化
      onCreditsUpdate: (totalCredits) => {
        debouncedStoreSet('proxyTotalCredits', totalCredits)
      },
      // Tokens 更新回调 - 使用防抖持久化
      onTokensUpdate: (inputTokens, outputTokens) => {
        debouncedStoreSet('proxyInputTokens', inputTokens)
        debouncedStoreSet('proxyOutputTokens', outputTokens)
      },
      // 请求统计更新回调 - 使用防抖持久化
      onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
        debouncedStoreSet('proxyTotalRequests', totalRequests)
        debouncedStoreSet('proxySuccessRequests', successRequests)
        debouncedStoreSet('proxyFailedRequests', failedRequests)
        // 更新托盘菜单（也防抖，避免频繁重建菜单）
        debouncedUpdateTrayMenu()
      },
      // 挂起门闸:被挂起请求数变化时推送前端，驱动挂起数徽标 + 放行按钮启用态
      onHeldRequestsChanged: (info) => {
        mainWindow?.webContents.send('proxy-held-requests-changed', info)
      },
      // 会话快照 tick：服务运行中每 60s 写 orphan snapshot 到 store
      // 强杀/崩溃/关机时 — 下次启动 restoreOrphanProxySessionIfAny 会归档它
      onSessionTick: (rec) => {
        if (!store) return
        try { store.set(PROXY_ORPHAN_SESSION_KEY, rec) } catch { /* ignore */ }
      },
      // 账号池为空时懒加载 - 从 store 读取账号数据同步到 pool
      onPoolEmpty: async () => {
        await initStore()
        if (!store) return
        const accountData = store.get('accountData') as {
          accounts?: Record<string, any>
          accountProxyBindings?: Record<string, string>
          proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
        } | undefined
        if (!accountData?.accounts) return

        // 构建 accountId → proxyUrl 映射（用于反代时 N:1 分桶）
        const bindings = accountData.accountProxyBindings || {}
        const proxyPool = accountData.proxyPool || {}
        const buildProxyUrl = (accountId: string): string | undefined => {
          const proxyId = bindings[accountId]
          if (!proxyId) return undefined
          const p = proxyPool[proxyId]
          if (!p || !p.enabled || p.status === 'dead') return undefined
          return p.url
        }

        // 准入判据与 autostart / 面板同一真源，见 `proxy/activation.ts checkPoolAdmission`
        const admissionSkips: PoolAdmissionSkip[] = []
        const proxyAccounts = Object.values(accountData.accounts)
          .filter((acc: any) => {
            const skip = checkPoolAdmission(acc)
            if (skip) admissionSkips.push(skip)
            return !skip
          })
          .map((acc: any) => ({
            id: acc.id,
            email: acc.email,
            accessToken: acc.credentials.accessToken,
            refreshToken: acc.credentials?.refreshToken,
            profileArn: acc.profileArn || acc.credentials?.profileArn,
            expiresAt: acc.credentials?.expiresAt,
            machineId: acc.machineId,
            clientId: acc.credentials?.clientId,
            clientSecret: acc.credentials?.clientSecret,
            region: acc.credentials?.region || 'us-east-1',
            authMethod: acc.credentials?.authMethod,
            provider: acc.credentials?.provider || acc.idp,
            // external_idp (Azure AD) 专用:反代自动刷新需微软 tokenEndpoint,不传会报"缺 tokenEndpoint"
            tokenEndpoint: acc.credentials?.tokenEndpoint,
            issuerUrl: acc.credentials?.issuerUrl,
            scopes: acc.credentials?.scopes,
            proxyUrl: buildProxyUrl(acc.id)
          }))
        logPoolAdmissionSkips(admissionSkips, 'lazy-refill')
        if (proxyAccounts.length > 0 && proxyServer) {
          const pool = proxyServer.getAccountPool()
          proxyAccounts.forEach(acc => pool.addAccount(acc))
          const boundCount = proxyAccounts.filter(a => a.proxyUrl).length
          console.log(`[ProxyServer] Lazy-synced ${proxyAccounts.length} accounts from store (${boundCount} with bound proxy)`)
        }
      }
    },
    // 自签证书落盘目录（K-2）：由装配层注入，共享内核不再自己 require('electron')。
    // 传目录本身而非 config 字段 —— config 会被 store 持久化并跨 IPC，
    // 机器绝对路径混进去会在换机/恢复备份后被当成证书目录用（见 ProxyServer 构造注释）。
    app.getPath('userData')
  )

  // P1-6 注入 webhook 触发器：让反代关键事件（封号 / 全员配额耗尽 / 限流）能推送通知
  proxyServer.setWebhookTrigger((event, payload) => {
    // 通过 IPC 转发到 renderer，由 useWebhookStore.triggerEvent 实际发送
    mainWindow?.webContents.send('proxy-webhook-trigger', { event, payload })
  })

  // Enterprise profileArn 自愈持久化：运行时首次解析出真实 profileArn 时，
  // 回写到账号池 + 内存快照 + 通知 renderer 落盘，避免每次请求重复获取。
  setProfileArnPersistCallback((accountId, profileArn) => {
    try {
      proxyServer?.getAccountPool().updateAccount(accountId, { profileArn })
      // 推送 IPC，让 renderer store 把 profileArn 写入账号数据
      mainWindow?.webContents.send('proxy-account-update', { id: accountId, profileArn })
      // 同步更新内存快照，确保下次整库落盘时带上 profileArn
      if (lastSavedData && typeof lastSavedData === 'object') {
        const data = lastSavedData as { accounts?: Record<string, Record<string, unknown>> }
        if (data.accounts?.[accountId]) {
          data.accounts[accountId] = { ...data.accounts[accountId], profileArn }
        }
      }
      console.log(`[ProxyServer] Persisted Enterprise profileArn for ${accountId}: ${profileArn}`)
    } catch (e) {
      console.warn('[ProxyServer] Failed to persist profileArn:', e)
    }
  })

  // v1.7.6 fetchKiroModels 403 自愈: token 刷新回调
  // fetchKiroModels 拿到 403 时先调这个回调尝试刷 token,而不是直接落 catalog(§附录 A Bug 4)
  setTokenRefreshCallbackForModelFetch(async (account) => {
    if (!account.refreshToken) return { ok: false }
    try {
      console.log(`[ModelFetchRefresh] Refreshing token for ${account.email || account.id}`)
      const result = await refreshTokenByMethod(
        account.refreshToken,
        account.clientId || '',
        account.clientSecret || '',
        account.region || 'us-east-1',
        account.authMethod,
        account.proxyUrl,
        { tokenEndpoint: account.tokenEndpoint, scopes: account.scopes }
      )
      if (result.success && result.accessToken) {
        // 同步回写账号池(与 onTokenRefresh 类似,但由 model fetch 触发)
        const expiresAt = Date.now() + (result.expiresIn || 3600) * 1000
        proxyServer?.getAccountPool().updateAccount(account.id, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt
        })
        mainWindow?.webContents.send('proxy-account-update', {
          id: account.id,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt
        })
        return { ok: true, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt }
      }
      return { ok: false }
    } catch (e) {
      console.warn('[ModelFetchRefresh] threw:', e instanceof Error ? e.message : e)
      return { ok: false }
    }
  })

  // v1.7.6 fetchKiroModels 结束后能力反哺回调 —— 把 modelId 列表灌进 accountPool.modelCapabilities
  setAccountModelSyncCallback((accountId, models, status) => {
    try {
      proxyServer?.getAccountPool().applyModelListResult(accountId, models, status)
    } catch (e) {
      console.warn('[AccountModelSync] applyModelListResult failed:', e instanceof Error ? e.message : e)
    }
  })

  // 恢复保存的累计 credits
  if (savedTotalCredits > 0) {
    proxyServer.setTotalCredits(savedTotalCredits)
  }

  // 恢复保存的累计 tokens
  if (savedInputTokens > 0 || savedOutputTokens > 0) {
    proxyServer.setTotalTokens(savedInputTokens, savedOutputTokens)
  }

  // 恢复保存的请求统计
  if (savedTotalRequests > 0 || savedSuccessRequests > 0 || savedFailedRequests > 0) {
    proxyServer.setRequestStats(savedTotalRequests, savedSuccessRequests, savedFailedRequests)
  }

  // 加载 Steering 文件（如果配置了工作区路径）
  proxyServer.loadSteering()

  return proxyServer
}

// ============ 隐私模式打开浏览器 ============
import { exec, execSync } from 'child_process'

// 获取 Windows 默认浏览器
function getWindowsDefaultBrowser(): string {
  try {
    // 从注册表读取默认浏览器
    const progId = execSync(
      'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    
    if (progId.includes('ChromeHTML') || progId.includes('Google')) return 'chrome'
    if (progId.includes('MSEdgeHTM') || progId.includes('Edge')) return 'msedge'
    if (progId.includes('FirefoxURL') || progId.includes('Firefox')) return 'firefox'
    if (progId.includes('BraveHTML') || progId.includes('Brave')) return 'brave'
    if (progId.includes('Opera')) return 'opera'
    
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// 使用隐私模式打开浏览器
function openBrowserInPrivateMode(url: string): void {
  const platform = process.platform
  console.log(`[Browser] Opening in private mode on ${platform}: ${url}`)

  try {
    if (platform === 'win32') {
      // Windows: 检测默认浏览器并使用对应的隐私模式参数
      const defaultBrowser = getWindowsDefaultBrowser()
      console.log(`[Browser] Detected default browser: ${defaultBrowser}`)
      
      let command = ''
      switch (defaultBrowser) {
        case 'chrome':
          command = `start chrome --incognito "${url}"`
          break
        case 'msedge':
          command = `start msedge -inprivate "${url}"`
          break
        case 'firefox':
          command = `start firefox -private-window "${url}"`
          break
        case 'brave':
          command = `start brave --incognito "${url}"`
          break
        case 'opera':
          command = `start opera --private "${url}"`
          break
        default:
          // 未知浏览器，尝试常见浏览器
          console.log('[Browser] Unknown default browser, trying common browsers...')
          exec(`start chrome --incognito "${url}"`, (err) => {
            if (err) {
              exec(`start msedge -inprivate "${url}"`, (err2) => {
                if (err2) {
                  exec(`start firefox -private-window "${url}"`, (err3) => {
                    if (err3) {
                      console.log('[Browser] Fallback to default browser (non-private)')
                      shell.openExternal(url)
                    }
                  })
                }
              })
            }
          })
          return
      }
      
      exec(command, (err) => {
        if (err) {
          console.log(`[Browser] Failed to open ${defaultBrowser}, fallback to default`)
          shell.openExternal(url)
        }
      })
    } else if (platform === 'darwin') {
      // macOS: 尝试 Chrome -> Firefox -> 默认浏览器
      exec(`open -na "Google Chrome" --args --incognito "${url}"`, (err) => {
        if (err) {
          exec(`open -a Firefox --args -private-window "${url}"`, (err2) => {
            if (err2) {
              console.log('[Browser] Fallback to default browser')
              shell.openExternal(url)
            }
          })
        }
      })
    } else {
      // Linux: 尝试 Chrome -> Chromium -> Firefox
      exec(`google-chrome --incognito "${url}"`, (err) => {
        if (err) {
          exec(`chromium --incognito "${url}"`, (err2) => {
            if (err2) {
              exec(`firefox -private-window "${url}"`, (err3) => {
                if (err3) {
                  console.log('[Browser] Fallback to default browser')
                  shell.openExternal(url)
                }
              })
            }
          })
        }
      })
    }
  } catch (error) {
    console.error('[Browser] Error opening in private mode:', error)
    shell.openExternal(url)
  }
}

// 微软登录端点白名单。**刷新逻辑已搬进 `./upstreamApi`**（那里有自己的一份私有副本），
// 这里留下的唯一消费者是下面 GetLoginMetadata 的 issuerUrl 校验（本文件 ~4000 行处）——
// 那是「外部 IdP 是否受支持」的判定，与 token 刷新是两条独立路径。
const MICROSOFT_TOKEN_ENDPOINT_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net'
])

// 定义自定义协议
const PROTOCOL_PREFIX = 'kiro'

// electron-store 实例（延迟初始化）
let store: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
} | null = null

// 最后保存的数据（用于崩溃恢复）
let lastSavedData: unknown = null

// ============ accountService 依赖装配 ============
//
// 剥离到 src/main/accountService/ 的业务函数不再闭包引用本文件的模块级变量，
// 而是通过下面两个 deps 对象显式接收。web 面板（HTTP 通道）复用同一对象。
//
// ⚠️ store 用 getter 而非直接传值：`store` 是惰性初始化的（initStore 跑完才有值），
// 而 handler 注册发生在 app.whenReady 内、首次 initStore 之前 —— 直接传值会永久捕获 null。
const accountDeps: AccountStoreDeps = {
  getStore: (): AccountStoreRef => {
    if (!store) {
      // 装配次序 bug（initStore 未先跑）→ 抛错让上层立刻看见，不静默 no-op
      throw new Error('[accountService] store not initialized. Call initStore() first.')
    }
    return store
  },
  ensureStore: () => initStore(),
  createBackup: (data: unknown) => createBackup(data),
  setLastSavedData: (data: unknown) => {
    lastSavedData = data
  }
}

// 本机凭证读取的磁盘副作用注入点（~/.aws/sso/cache）。
// 原 handler 内是 `await import('os'|'fs/promises')` 动态导入，这里收口成一处装配。
// homedir 保持同步签名（业务函数用它拼路径），故用 node:os 的静态命名空间导入方式：
// 本文件其余位置沿用动态 import('os') 的历史风格，此处不改动它们。
const credentialFsDeps: CredentialFsDeps = {
  homedir: () => nodeHomedir(),
  readTextFile: (p: string) => readFile(p, 'utf-8'),
  readDir: async (p: string) => {
    const fsp = await import('fs/promises')
    return fsp.readdir(p)
  }
}

// 验证/导入路径依赖的 Kiro API 函数。实现已抽进 `./upstreamApi`（零 electron 共享模块），
// 这里注入的是工厂实例上的方法引用。注入契约本身保持不变 —— verify.ts 一行未改。
const verifyApiDeps: VerifyApiDeps = {
  ssoDeviceAuth: (bearerToken, region) => ssoDeviceAuth(bearerToken, region),
  getUserInfo: (accessToken, idp, accountMachineId, email) =>
    getUserInfo(accessToken, idp, accountMachineId, email),
  getUsageAndLimits: (accessToken, idp, profileArn, accountMachineId, ssoRegion, email, authMethod) =>
    getUsageAndLimits(accessToken, idp, profileArn, accountMachineId, ssoRegion, email, authMethod),
  refreshTokenByMethod: (token, clientId, clientSecret, region, authMethod, proxyUrl, externalIdp) =>
    refreshTokenByMethod(token, clientId, clientSecret, region, authMethod, proxyUrl, externalIdp)
}

/**
 * ksk_ 导入用例的依赖装配（IPC 与 web 面板共用同一份）。
 *
 * 为什么是函数而不是模块级常量：`applyAccountDataMutation` 要求 store 已注入
 * （`setStoreRef` 在 initStore 末尾才跑）。装配成常量会在模块求值时就绑定，
 * 与 `accountDeps.getStore` 用惰性 getter 同一理由。
 *
 * `newMachineId` 注入 kproxy 的 `generateDeviceId`（`kproxy/index.ts:275`，32 字节 →
 * 64 位 hex）—— 与 `proxy/types.ts:436` 的账号绑定设备 ID 契约一致，也与 renderer
 * 侧三处写入（`store/accounts.ts:1053/1604/2424`）同形态。
 *
 * 不要改回 `machineId.ts:83` 的 `generateRandomMachineId`：那属于**系统机器码**
 * 命名空间（产出 UUID，写 Windows 注册表 MachineGuid），与账号绑定域不可互换。
 * `fce8c89` 曾误注入它，写出的 UUID 形态 machineId 拼进 UA 后匹配不上
 * `kproxy/mitmProxy.ts:17 KIRO_UA_REGEX`（只认 64 hex），K-Proxy 设备 ID 改写
 * 对 ksk_ 账号静默失效。闸门见 `test/main/accountService/accountMachineIdFormat.test.ts`。
 */
function buildApiKeyImportDeps(): ApiKeyImportDeps {
  return {
    verifyApiKey: (params) => svcVerifyApiKey(params),
    applyMutation: (mutate, opts) => applyAccountDataMutation(mutate, opts),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    newMachineId: () => generateDeviceId()
  }
}

async function initStore(): Promise<void> {
  if (store) return
  const Store = (await import('electron-store')).default
  const path = await import('path')

  // ============ K-3 数据故障前置校验（桌面走三态，不含写权限） ============
  //
  // 决策卡 `decision-card.md:103-106` 的四态位于该卡的**服务器迁移**章节
  // （周围不变量 I1a/I1b/I1c 通篇在讲把数据文件拷到服务器），本是服务端启动语义。
  // 逐条判断哪些也该管桌面 ——
  // 实测(2026-08-10 本机 node v22 · conf 15.0.2，用 conf + 显式 cwd 等价复刻本构造)桌面现状：
  //   ① 文件不存在        → 构造成功、空库启动、写入成功    ← 与决策卡一致，无需改
  //   ② 存在但解不开      → `new Store()` 抛 `SyntaxError: Unexpected token`
  //                          （conf 把解密失败退化成「把密文当明文 JSON.parse」）
  //                          结果**已经**是拒绝启动，但错误信息完全不指向真实原因：
  //                          运维/用户看到 JSON 语法错误，不会想到是加密密钥不符
  //   ③ 版本比预期新      → 构造成功、正常启动 ← 与决策卡 ③ 冲突（但见下：该字段今天不存在）
  //   ④ 数据目录/文件只读 → **桌面不查**。它是服务器才真实存在的处境（挂载权限 /
  //                          容器卷 / 服务用户不拥有拷进来的文件）；桌面上是「装了应用、
  //                          它写自己的 %APPDATA%」，那个处境几乎不存在。在这儿加闸门等于
  //                          用「多一条桌面拒绝启动的路」换「守一件桌面不会发生的事」。
  //                          闸门本体仍在端口里（`assertAccountStoreWritable`），
  //                          由服务端的 `preflightAccountStoreForServer` 调用。
  //
  // 故这里调的是**不含写权限**的 `preflightAccountStore`。**对桌面端的可见行为变化**：
  //   - ②：仍然拒绝启动（行为不变），但错误信息从 JSON 语法错误变成明确说明
  //   - ①③④：无变化（③ 的版本字段是 K-3 新引入的，现存数据一律无此字段 = 判为兼容）
  // 即本轮**没有给桌面新增任何一条拒绝启动的路**。
  const dataDir = app.getPath('userData')
  preflightAccountStore(dataDir)

  const storeInstance = new Store({
    name: ACCOUNT_STORE_NAME,
    // 混淆密钥收口到 persistence 端口的常量 —— 桌面与服务端**必须**用同一个值，
    // 否则一端写的文件另一端读不开。ADR-0002 已裁决它是混淆非安全，且**禁止改动**：
    // 改了等于让所有既有用户的 kiro-accounts.json 再也读不开。
    encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
  })
  
  // 桌面 store 引用经端口适配器包一层，而不是直接把 electron-store 实例赋过去。
  //
  // 唯一目的：把 `set(key, undefined)` 翻译成 `delete(key)`。实测(2026-08-10 · conf 15.0.2)
  // `conf` 对 `set(key, undefined)` 抛 `TypeError: Use \`delete()\` to clear values`，
  // **且旧值留在盘上**。本文件的 orphan session 清理有三处这种写法（:458 / :477 / :486），
  // 都裹在只 console.warn 的 catch 里 —— 于是快照永远清不掉，每次启动被重新归档一次，
  // 历史里出现字节完全相同的重复条目（本机实测已产生 7 条重复）。
  //
  // 修在装配层而不是那三个调用点：调用点的语义本来就是「清掉这个键」，
  // 让每处各自记得改写成 delete 是三次机会各错一次；收在这里则新增调用点自动受益，
  // 且与服务端实现（`accountStore.conf.ts`）共用同一份翻译逻辑。
  store = adaptRawStoreToPort({
    get: (key: string, defaultValue?: unknown) => storeInstance.get(key, defaultValue),
    set: (key: string, value: unknown) => storeInstance.set(key, value),
    delete: (key: string) => storeInstance.delete(key),
    path: storeInstance.path
  })
  
  // 尝试从备份恢复数据（如果主数据损坏）。备份优先读加密 .enc，兼容旧明文 .json
  try {
    const mainData = storeInstance.get('accountData')

    if (!mainData) {
      try {
        const { readSecureBackup } = await import('./secureBackup')
        // 加解密能力由装配层注入：桌面用 safeStorage（OS keyring）。
        // 内核 secureBackup 不认识 electron，服务端注入 AES-GCM 实现。
        const { createSafeStorageBackupCipher } = await import('./secureBackupCipher.safeStorage')
        const backupData = await readSecureBackup(
          path.dirname(storeInstance.path),
          createSafeStorageBackupCipher()
        ) as { accounts?: unknown } | null
        if (backupData && backupData.accounts) {
          console.log('[Store] Restoring data from backup...')
          // initStore bootstrap 阶段:store 引用尚未注入 accountService/state,
          // 无法走 applyAccountDataMutation。保持直写,但显式初始化 revision=0,
          // 让后续第一次 applyAccountDataMutation 从 1 起递增（保证乐观锁语义完整）。
          storeInstance.set('accountData', { ...(backupData as Record<string, unknown>), revision: 0 })
          console.log('[Store] Data restored from backup successfully')
        }
      } catch (e) {
        // readSecureBackup 把「没有备份」和「备份存在但读不出来」区分开了：
        // 前者返回 null（走不到这里），所以进到这个 catch 说明**有**一份备份却用不了 ——
        // 打不开（权限/路径被占）、解不开（keyring 变更/密文损坏）、或内容坏掉（JSON 截断）。
        // 不能再当「备份也不存在，忽略」静默吞掉 —— 那正是把一次可修复的故障变成静默数据丢失。
        // 这里只记不抛：主数据缺失叠加备份损坏时，仍要让应用能起来（用户可手动导入），
        // 崩在启动路径上会让用户连界面都进不去，反而更难自救。
        // （服务端形态相反 —— 按 ADR-0002 应拒绝启动。该判定属于装配层，不在内核里分支。）
        console.error(
          '[Store] 备份存在但无法恢复（不覆盖任何现有数据）。若刚更换过系统密钥环或迁移过机器，' +
            '旧备份可能已无法解密：',
          e
        )
      }
    }
  } catch (error) {
    console.error('[Store] Error checking backup:', error)
  }

  // 一次性迁移：清理 BuilderId 占位符 profileArn 等脏数据
  // 详见 migrateAccountDataIfNeeded 注释
  try {
    migrateAccountDataIfNeeded()
  } catch (error) {
    console.error('[Store] Account data migration failed:', error)
  }

  // 加载主动续期开关状态（默认关闭）
  try {
    proactiveRenewalEnabled = !!storeInstance.get('proactiveRenewalEnabled', false)
    console.log(`[ProactiveRenewal] Loaded from settings: ${proactiveRenewalEnabled ? 'enabled' : 'disabled'}`)
  } catch (e) {
    console.warn('[ProactiveRenewal] Failed to load setting:', e)
  }

  // 注入 store 引用给 accountService/state（applyAccountDataMutation 收口函数需要）
  // 决策卡 §1 不变量 2:所有 accountData 写入必须过 revision 仲裁
  setAccountStoreRef(store!)
  setAccountLastSavedSetter((data) => { lastSavedData = data })

  // T8 广播装配 · 决策卡 §1 不变量 3:收口成功后广播 accounts-data-changed
  // payload 严格白名单 { revision, changedIds } —— 绝不含凭证（§3 输出脱敏 · state.ts 内部就限定死了 payload 形状）
  // 照抄 kiro-ide-token-changed 先例（:1966 / :2110）:全窗口广播（W5 web 面板落地后同一 channel 也可服务它）
  setAccountBroadcaster((payload: AccountsBroadcastPayload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('accounts-data-changed', payload)
      } catch (e) {
        // 单窗口发送失败不影响其它窗口 · precise catch（§4.4）
        console.warn('[Broadcaster] send accounts-data-changed failed:', e)
      }
    }
  })
}

// ============ Kiro IDE Auth Token 反向同步 ============
//
// Kiro IDE 桌面端自己也有 refresh loop：每 N 秒检查 token 是否快到期，到期就用磁盘里的
// refreshToken 调 OIDC，得到新 access + 新 refresh 后写回 ~/.aws/sso/cache/kiro-auth-token.json。
//
// 反代如果不感知这种"IDE 自己改了 token 文件"，下次反代再调 refresh 时还在用废的旧 refresh
// → OIDC 拒绝 → 后续 IDE 自动刷新也连环挂掉。
//
// 这里启动一个 fs.watchFile 监听器：
//   - 检测到磁盘 token 变化 + 不是反代自己刚写的（lastWrittenTokenSignature 不一致）
//   - 把新 access/refresh/expiresAt 同步回反代 store
//   - 通过 webContents.send 通知 renderer 重新 loadAccounts，UI 立刻刷新
//
// 账号匹配优先级（任一命中即视为同一账号）：
//   1) accessToken JWT 解 sub，与反代 store 里某账号 cached accessToken claims 的 sub 一致
//   2) lastSwitchedAccountId（反代刚 switch-account 过的那一个）
//   3) refreshToken 旧值匹配（IDE 第一次自刷新前，磁盘 refresh 还等于 store 里的）
let stopKiroAuthTokenWatcher: (() => void) | null = null

function startKiroAuthTokenWatcher(): void {
  if (stopKiroAuthTokenWatcher) return
  stopKiroAuthTokenWatcher = watchKiroAuthTokenFile(async (token) => {
    const sig = `${token.accessToken}|${token.refreshToken}`
    if (sig === lastWrittenTokenSignature) {
      // 反代自己刚写的，跳过避免回环
      return
    }
    if (sig === lastSyncedFromIdeSignature) {
      // 之前一次 IDE 同步已处理过这份内容，跳过
      return
    }
    lastSyncedFromIdeSignature = sig
    try {
      await syncIdeTokenChangeToStore(token)
    } catch (e) {
      console.warn('[KiroAuthSync] syncIdeTokenChangeToStore failed:', e)
    }
  })
  console.log('[KiroAuthSync] Watching:', KIRO_AUTH_TOKEN_PATH)
}

async function syncIdeTokenChangeToStore(token: {
  accessToken: string
  refreshToken: string
  expiresAt: string
  provider?: string
  authMethod?: string
  region?: string
  profileArn?: string
}): Promise<void> {
  if (!store) {
    try {
      await initStore()
    } catch (e) {
      console.warn('[KiroAuthSync] initStore failed, cannot sync back:', e)
      return
    }
  }
  const accountData = store?.get('accountData') as
    | { accounts?: Record<string, { id?: string; email?: string; credentials?: { accessToken?: string; refreshToken?: string; expiresAt?: number } }> }
    | null
    | undefined
  if (!accountData?.accounts) {
    console.log('[KiroAuthSync] No accounts in store, skip')
    return
  }

  // 1) JWT sub 匹配（最准）
  const newClaims = parseAccessTokenClaims(token.accessToken)
  let matchedId: string | null = null
  let matchedReason = ''
  if (newClaims?.sub) {
    for (const [id, acc] of Object.entries(accountData.accounts)) {
      const oldClaims = acc.credentials?.accessToken
        ? parseAccessTokenClaims(acc.credentials.accessToken)
        : null
      if (oldClaims?.sub && oldClaims.sub === newClaims.sub) {
        matchedId = id
        matchedReason = `JWT sub match (${newClaims.sub.slice(0, 12)}…)`
        break
      }
    }
  }

  // 2) lastSwitchedAccountId 兜底
  if (!matchedId && lastSwitchedAccountId && accountData.accounts[lastSwitchedAccountId]) {
    matchedId = lastSwitchedAccountId
    matchedReason = 'lastSwitchedAccountId fallback'
  }

  // 3) 旧 refreshToken 匹配
  if (!matchedId) {
    for (const [id, acc] of Object.entries(accountData.accounts)) {
      if (acc.credentials?.accessToken === token.accessToken) {
        // store 和 disk access 完全一致，无需同步
        return
      }
      if (acc.credentials?.refreshToken && acc.credentials.refreshToken === token.refreshToken) {
        matchedId = id
        matchedReason = 'refreshToken exact match (no rotation yet)'
        break
      }
    }
  }

  if (!matchedId) {
    console.warn(
      '[KiroAuthSync] IDE token file changed but no matching account in store. ' +
        'This usually means the user signed in directly inside Kiro IDE without going through 反代切号. ' +
        'sub=',
      newClaims?.sub
    )
    return
  }

  const accountToUpdate = accountData.accounts[matchedId]
  if (!accountToUpdate) return
  accountToUpdate.credentials = {
    ...accountToUpdate.credentials,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.parse(token.expiresAt) || Date.now() + 3600 * 1000
  }

  // 走收口:main 侧自动同步是权威源,不传 expectedRevision（无仲裁直写 + 递增 revision）
  await applyAccountDataMutation(() => accountData as unknown as AccountsBlob)
  console.log(
    `[KiroAuthSync] Synced IDE-refreshed token back to account ${accountToUpdate.email || matchedId} (${matchedReason})`
  )

  try {
    mainWindow?.webContents.send('kiro-ide-token-changed', {
      accountId: matchedId,
      reason: matchedReason
    })
  } catch (e) {
    console.warn('[KiroAuthSync] failed to notify renderer:', e)
  }
}

// ============ 主动续期实现 ============
//
// 设计要点：
//  - 仅对"当前 IDE 激活账号"调度 timer（最多 1 个 in-flight timer）
//  - schedule 之前总是 clear，确保 timer 不会泄漏（switch 到另一账号、关闭功能、登出都会 clear）
//  - runProactiveRenewal 内部调 refreshTokenByMethod + writeKiroAuthTokenFile（复用现有逻辑）
//  - 续期成功后自动 schedule 下一次（基于新 token 的 expiresAt）
//  - 续期失败：不再调度，避免无限重试；让 IDE 自己的 refresh loop 兜底（双向同步仍生效）
//  - 通过 webContents.send('kiro-ide-token-changed') 通知 renderer 重新加载，UI 立刻刷新

function clearProactiveRenewal(reason?: string): void {
  if (proactiveRenewalTimer) {
    clearTimeout(proactiveRenewalTimer)
    proactiveRenewalTimer = null
    if (reason) console.log(`[ProactiveRenewal] Timer cleared: ${reason}`)
  }
}

/**
 * 在 token 剩余 (PROACTIVE_RENEWAL_LEAD_MS) 时触发续期。
 * 调用者负责传入准确的 expiresAt（来自 OIDC 真实 expiresIn），不读 store 避免不一致。
 */
function scheduleProactiveRenewal(accountId: string, expiresAtMs: number): void {
  clearProactiveRenewal()
  if (!proactiveRenewalEnabled) return
  const msUntilRenewal = expiresAtMs - Date.now() - PROACTIVE_RENEWAL_LEAD_MS
  // 若已经在窗口内（包括已过期），立刻续期
  const delay = Math.max(msUntilRenewal, 0)
  console.log(
    `[ProactiveRenewal] Scheduled in ${Math.round(delay / 1000)}s for account ${accountId} ` +
      `(token expiresAt ${new Date(expiresAtMs).toISOString()})`
  )
  proactiveRenewalTimer = setTimeout(() => {
    proactiveRenewalTimer = null
    void runProactiveRenewal(accountId)
  }, delay)
}

async function runProactiveRenewal(accountId: string): Promise<void> {
  if (!proactiveRenewalEnabled) {
    console.log('[ProactiveRenewal] Disabled, skip run')
    return
  }
  if (!store) {
    try {
      await initStore()
    } catch (e) {
      console.warn('[ProactiveRenewal] initStore failed:', e)
      return
    }
  }
  const accountData = store?.get('accountData') as
    | { accounts?: Record<string, { id?: string; email?: string; profileArn?: string; proxyUrl?: string; credentials?: { refreshToken?: string; clientId?: string; clientSecret?: string; region?: string; authMethod?: string; startUrl?: string; provider?: string; accessToken?: string; expiresAt?: number; tokenEndpoint?: string; scopes?: string } }> }
    | null
    | undefined
  const account = accountData?.accounts?.[accountId]
  if (!account) {
    console.log(`[ProactiveRenewal] Account ${accountId} no longer exists, stop`)
    return
  }
  const creds = account.credentials
  if (!creds?.refreshToken) {
    console.log(`[ProactiveRenewal] Account ${accountId} has no refreshToken, stop`)
    return
  }
  console.log(
    `[ProactiveRenewal] Renewing token for IDE active account ${account.email || accountId}...`
  )
  let refreshResult
  try {
    refreshResult = await refreshTokenByMethod(
      creds.refreshToken,
      creds.clientId || '',
      creds.clientSecret || '',
      creds.region || 'us-east-1',
      creds.authMethod,
      account.proxyUrl,
      { tokenEndpoint: creds.tokenEndpoint, scopes: creds.scopes }
    )
  } catch (e) {
    console.warn('[ProactiveRenewal] refreshTokenByMethod threw, stop scheduling:', e)
    return
  }
  if (!refreshResult.success || !refreshResult.accessToken) {
    console.warn(
      `[ProactiveRenewal] Renewal failed: ${refreshResult.error || 'unknown'}. ` +
        `Stop scheduling; IDE's own refresh loop will take over as fallback.`
    )
    return
  }
  const newAccess = refreshResult.accessToken
  const newRefresh = refreshResult.refreshToken || creds.refreshToken
  const expiresIn = refreshResult.expiresIn ?? 3600
  const newExpiresAt = Date.now() + expiresIn * 1000

  const resolvedProfileArn = resolveProfileArnForWrite({
    profileArn: account.profileArn,
    authMethod: creds.authMethod,
    provider: creds.provider,
    region: creds.region
  })

  // 1. 写磁盘（同步给 IDE）
  try {
    await writeKiroAuthTokenFile({
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresAtIso: new Date(newExpiresAt).toISOString(),
      authMethod: (creds.authMethod === 'social' ? 'social' : creds.authMethod === 'external_idp' ? 'external_idp' : 'IdC'),
      provider: creds.provider || 'BuilderId',
      region: creds.region,
      startUrl: creds.startUrl,
      clientId: creds.clientId || undefined,
      clientSecret: creds.clientSecret || undefined,
      profileArn: resolvedProfileArn
    })
    lastWrittenTokenSignature = `${newAccess}|${newRefresh}`
    lastSwitchedAccountId = accountId
  } catch (e) {
    console.warn('[ProactiveRenewal] Failed to write IDE token file (will still try store sync):', e)
  }

  // 2. 写 store（同步反代/UI）· 走收口:main 侧自动续期是权威源,不传 expectedRevision
  if (store) {
    account.credentials = {
      ...creds,
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresAt: newExpiresAt
    }
    await applyAccountDataMutation(() => accountData as unknown as AccountsBlob)
  }

  // 3. 通知 renderer reload
  try {
    mainWindow?.webContents.send('kiro-ide-token-changed', {
      accountId,
      reason: 'proactive-renewal'
    })
  } catch {
    /* renderer 可能已关闭 */
  }

  console.log(
    `[ProactiveRenewal] Renewed OK for ${account.email || accountId}. ` +
      `Next renewal in ${expiresIn - PROACTIVE_RENEWAL_LEAD_MS / 1000}s`
  )

  // 4. 调度下一次
  scheduleProactiveRenewal(accountId, newExpiresAt)
}

/**
 * 账号数据迁移（已停用）：曾用于清理 profileArn 占位符，
 * 但 Kiro IDE 内部逻辑依赖该字段存在，移除后导致严重问题，已回退。
 * 保留函数壳和标记写入，防止旧版本回滚时重复执行。
 */
function migrateAccountDataIfNeeded(): void {
  if (!store) return
  const MIGRATION_KEY = 'accountDataMigration'
  const FLAG = 'builderIdArn'
  const migrationState = (store.get(MIGRATION_KEY, {}) as Record<string, number>) || {}
  const accountData = store.get('accountData') as
    | { accounts?: Record<string, { id?: string; provider?: string; profileArn?: string; email?: string }> }
    | null
    | undefined

  if (!accountData?.accounts) {
    if (!migrationState[FLAG]) {
      store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
    }
    return
  }

  // profileArn 占位符不再清理 —— Kiro IDE 内部逻辑依赖该字段存在
  // 保留迁移标记写入以避免旧版本回滚时重复执行

  if (!migrationState[FLAG]) {
    store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
  }
}

// ============ 备份节流配置 ============
// 备份是为容灾兜底，不需要每次保存都全量重写文件，按时间节流即可大幅降低磁盘 IO。
const BACKUP_THROTTLE_MS = 5 * 60 * 1000 // 5 分钟最多写一次备份
let lastBackupTime = 0
let pendingBackupData: unknown = null
let pendingBackupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 创建数据备份（节流）
 * - 距上次备份不足 BACKUP_THROTTLE_MS 时，仅记录数据指针，不立即写盘
 * - 节流窗口结束后，自动 flush 最新一份数据
 * - 退出前可手动调用 flushBackupNow() 强制写盘
 */
async function createBackup(data: unknown): Promise<void> {
  pendingBackupData = data
  const now = Date.now()
  const elapsed = now - lastBackupTime

  if (elapsed >= BACKUP_THROTTLE_MS) {
    // 节流窗口已过，立即写盘
    await writeBackupNow()
    return
  }

  // 在节流窗口内：调度一次延迟 flush（如果尚未调度）
  if (!pendingBackupTimer) {
    const delay = BACKUP_THROTTLE_MS - elapsed
    pendingBackupTimer = setTimeout(() => {
      pendingBackupTimer = null
      void writeBackupNow()
    }, delay)
  }
}

/**
 * 真正执行备份写盘。仅当 pendingBackupData 非空时写入。
 */
async function writeBackupNow(): Promise<void> {
  if (!store || pendingBackupData == null) return
  const data = pendingBackupData
  pendingBackupData = null
  lastBackupTime = Date.now()
  try {
    const path = await import('path')
    const { writeSecureBackup, isSecureBackupAvailable } = await import('./secureBackup')
    // 加解密能力由装配层注入（同 initStore 处注释）
    const { createSafeStorageBackupCipher } = await import('./secureBackupCipher.safeStorage')
    const cipher = createSafeStorageBackupCipher()
    await writeSecureBackup(path.dirname(store.path), data, cipher)
    console.log(`[Backup] Data backup created (${isSecureBackupAvailable(cipher) ? 'encrypted' : 'plaintext-fallback'})`)
  } catch (error) {
    console.error('[Backup] Failed to create backup:', error)
  }
}

/**
 * 强制 flush 待写的备份（用于退出前兜底）
 */
async function flushBackupNow(): Promise<void> {
  if (pendingBackupTimer) {
    clearTimeout(pendingBackupTimer)
    pendingBackupTimer = null
  }
  if (pendingBackupData != null) {
    await writeBackupNow()
  }
}

let mainWindow: BrowserWindow | null = null

// ============ Kiro IDE Auth 同步状态 ============
// 账号管理器上一次写入 kiro-auth-token.json 时对应的 accountId，watcher 反向同步时优先用它
let lastSwitchedAccountId: string | null = null
// 账号管理器上一次写入时的 token 签名（access|refresh）。
// watcher 触发时若签名一致，说明是账号管理器自己写的，跳过反向同步，避免回环。
let lastWrittenTokenSignature: string | null = null
// 上一次反向同步成功时刷写过的 store 数据签名，用于 dedupe webContents.send
let lastSyncedFromIdeSignature: string | null = null

// ============ 主动续期（Proactive Token Renewal） ============
// 思路：在 Kiro IDE 内部 refresh loop 触发之前（token 剩 10 分钟时）抢先 refresh，
//   让 IDE 永远拿到剩余时间充足的 token，IDE 自己永远不需要调 OIDC → 彻底消除 race。
// 仅对"当前 IDE 激活账号"（lastSwitchedAccountId）维护一个 timer，开销小。
// 默认关闭，需用户在 Settings 中显式打开。
let proactiveRenewalEnabled = false
let proactiveRenewalTimer: NodeJS.Timeout | null = null
// 在 token 剩余多久时触发主动续期。15 分钟 > Kiro IDE 的 10 分钟阈值，确保抢先。
const PROACTIVE_RENEWAL_LEAD_MS = 15 * 60 * 1000

// ============ 账号池 token 主动刷新（主进程调度，不依赖窗口存活）============
//
// 背景：原先只有渲染进程的 setInterval 调度池内 token 刷新，窗口最小化到托盘后会被
// Chromium 后台节流，导致 token 过期数分钟才刷新。这里把"调度"搬到主进程：主进程定时器
// 不受窗口可见性影响，到点读 store 里的账号、刷新即将过期的 token。
//
// **落盘由主进程自己完成**（accountService/backgroundRefresh.ts → persistBatchRefreshResults）。
// 原先这里写的是"结果经 background-refresh-result 事件回流给渲染进程持久化" —— 那条路
// 在服务器形态下不存在：无 BrowserWindow ⇒ `mainWindow?.webContents.send` 静默 no-op ⇒
// 新签发的 refreshToken 永不上盘，而旧的已被 IdP 当场作废 ⇒ 重启后账号全死。
// 事件仍照发（渲染进程 UI 的即时更新来源），但它不再是持久化路径。
// 渲染进程定时器保留（已关后台节流）做信息同步/自动换号；两边的 token 刷新由
// poolRefreshInFlightIds 去重，避免对同一 refreshToken 并发刷新把其中一个用作废。
//
// 入参类型 BackgroundRefreshAccount 由 accountService/backgroundRefresh.ts 导出（SSOT）。
/** background-batch-refresh 的核心实现（由 IPC 与主进程调度器共用）。在 whenReady 中赋值。 */
let backgroundBatchRefreshImpl:
  | ((accounts: BackgroundRefreshAccount[], concurrency?: number, syncInfo?: boolean) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>)
  | null = null
/** 正在刷新中的账号 ID 去重集合，渲染进程与主进程调度器共享，防止同一 refreshToken 被并发刷新。 */
const poolRefreshInFlightIds = new Set<string>()
let mainPoolRefreshTimer: NodeJS.Timeout | null = null

/** 兼容调度器既有调用名；封禁语义来自跨进程共享分类器。 */
function isBannedAccountErrorMain(error?: string): boolean {
  return isAccountSuspensionError(error)
}

/**
 * 永久性凭据错误判定：这类错误表示 refresh token / client 已失效或被吊销，
 * 本质需要重新登录/更换凭据，反复每分钟重刷只会刷屏且无意义（本次日志故障主因）。
 * 注意：401 / fetch failed / 网络超时等是「可恢复」错误，不在此列，仍允许后续重试。
 */
function isPermanentCredentialError(error?: string): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return e.includes('invalid_grant')
    || e.includes('invalid_client')
    || e.includes('invalid client secret')
    || e.includes('invalid refresh token')
    || e.includes('invalid token provided')
    || e.includes('unauthorized_client')
    || e.includes('aadsts9002313') // Azure AD: 提供的 refresh token 无效
}

/**
 * 永久错误退避状态（主进程内存态，进程重启后重置——重启后允许再探测一次是合理的）。
 * key = accountId；until = 在此时间戳前跳过刷新；attempts = 已尝试次数（驱动指数退避）。
 */
const permanentErrorBackoff = new Map<string, { until: number; attempts: number }>()

/** 指数退避窗口：15min → 1h → 6h → 24h（封顶）。 */
function permanentBackoffMs(attempts: number): number {
  const steps = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]
  return steps[Math.min(Math.max(attempts, 1) - 1, steps.length - 1)]
}

/** 刷新提前量：≥ 2× 检查间隔且不少于 10 分钟，确保 token 不会在两次 tick 之间过期。 */
function mainTokenRefreshLeadMs(intervalMin: number): number {
  return Math.max(intervalMin * 2 * 60 * 1000, 10 * 60 * 1000)
}

/** 读取 store 里的账号，刷新即将过期的池内 token（仅刷 token，信息同步仍由渲染进程负责）。 */
async function runMainPoolTokenRefreshTick(): Promise<void> {
  if (!backgroundBatchRefreshImpl) return
  try {
    if (!store) { await initStore() }
    if (!store) return
    const data = store.get('accountData') as {
      accounts?: Record<string, {
        id?: string
        email?: string
        idp?: string
        profileArn?: string
        machineId?: string
        lastError?: string
        credentials?: {
          refreshToken?: string
          clientId?: string
          clientSecret?: string
          region?: string
          authMethod?: string
          accessToken?: string
          provider?: string
          profileArn?: string
          expiresAt?: number
          tokenEndpoint?: string
          issuerUrl?: string
          scopes?: string
        }
      }>
      autoRefreshEnabled?: boolean
      autoRefreshInterval?: number
      autoRefreshConcurrency?: number
    } | undefined
    if (!data?.accounts) return
    if (data.autoRefreshEnabled === false) return

    const intervalMin = Math.max(1, data.autoRefreshInterval ?? 5)
    const leadMs = mainTokenRefreshLeadMs(intervalMin)
    const concurrency = Math.max(1, Math.min(500, data.autoRefreshConcurrency ?? 100))
    const now = Date.now()

    const toRefresh: BackgroundRefreshAccount[] = []
    for (const [id, acc] of Object.entries(data.accounts)) {
      const creds = acc?.credentials
      if (!creds?.refreshToken) continue
      if (isBannedAccountErrorMain(acc.lastError)) continue
      // 永久凭据错误退避：invalid token/client/grant 等无退避每分钟重刷是日志刷屏主因。
      // 命中后按指数退避跳过；退避到点时放行一次做探测性重试，仍失败则加倍。
      if (isPermanentCredentialError(acc.lastError)) {
        const bo = permanentErrorBackoff.get(id)
        if (bo && now < bo.until) continue // 退避窗口内，跳过刷新
        const attempts = (bo?.attempts ?? 0) + 1
        permanentErrorBackoff.set(id, { attempts, until: now + permanentBackoffMs(attempts) })
      } else if (permanentErrorBackoff.has(id)) {
        // 已不再是永久错误（刷新成功或转为可恢复错误）→ 清除退避状态
        permanentErrorBackoff.delete(id)
      }
      const expiresAt = creds.expiresAt
      // 只刷"即将过期/已过期"的；没有 expiresAt 的跳过（无从判断）
      if (!expiresAt || expiresAt - now > leadMs) continue
      toRefresh.push({
        id,
        idp: acc.idp,
        profileArn: acc.profileArn,
        needsTokenRefresh: true,
        machineId: acc.machineId,
        credentials: {
          refreshToken: creds.refreshToken,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          region: creds.region,
          authMethod: creds.authMethod,
          accessToken: creds.accessToken,
          provider: creds.provider,
          profileArn: creds.profileArn,
          // external_idp 主进程自动刷新走微软端点，必须带这些字段，否则报"缺少 tokenEndpoint"
          tokenEndpoint: creds.tokenEndpoint,
          issuerUrl: creds.issuerUrl,
          scopes: creds.scopes
        }
      })
    }

    if (toRefresh.length === 0) return
    console.log(`[MainPoolRefresh] ${toRefresh.length} token(s) expiring within ${Math.round(leadMs / 60000)}min, refreshing...`)
    // syncInfo=false：仅刷 token；用量/订阅等信息同步由渲染进程定时器负责，避免主进程跑重活
    await backgroundBatchRefreshImpl(toRefresh, concurrency, false)
  } catch (err) {
    console.warn('[MainPoolRefresh] tick failed:', err instanceof Error ? err.message : err)
  }
}

/** 启动主进程池 token 刷新调度器（不依赖窗口可见/存活）。 */
function startMainPoolTokenRefresh(): void {
  stopMainPoolTokenRefresh()
  // 启动后稍等片刻先跑一次（让 store 与账号池就绪），之后每分钟检查一次；
  // 实际是否需要刷新由 runMainPoolTokenRefreshTick 内按 expiresAt + 提前量判定。
  setTimeout(() => { void runMainPoolTokenRefreshTick() }, 15_000)
  mainPoolRefreshTimer = setInterval(() => { void runMainPoolTokenRefreshTick() }, 60_000)
  console.log('[MainPoolRefresh] Scheduler started (main process, checks every 60s)')
}

function stopMainPoolTokenRefresh(): void {
  if (mainPoolRefreshTimer) {
    clearInterval(mainPoolRefreshTimer)
    mainPoolRefreshTimer = null
  }
}

// ============ 托盘相关变量 ============
let traySettings: TraySettings = { ...defaultTraySettings }
let isQuitting = false // 标记是否真正退出应用

// ============ 全局快捷键设置 ============
let showWindowShortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Ctrl+Shift+K'

// 加载快捷键设置
async function loadShortcutSettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('showWindowShortcut') as string | undefined
    if (saved) {
      showWindowShortcut = saved
    }
  } catch (error) {
    console.error('[Shortcut] Failed to load shortcut settings:', error)
  }
}

// 保存快捷键设置
async function saveShortcutSettings(): Promise<void> {
  try {
    await initStore()
    store?.set('showWindowShortcut', showWindowShortcut)
  } catch (error) {
    console.error('[Shortcut] Failed to save shortcut settings:', error)
  }
}

// 注册显示主窗口的快捷键
function registerShowWindowShortcut(): void {
  // 先注销所有已注册的快捷键
  globalShortcut.unregisterAll()
  
  if (!showWindowShortcut) return
  
  try {
    const success = globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢复 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    })
    if (success) {
      console.log(`[Shortcut] Registered: ${showWindowShortcut}`)
    } else {
      console.warn(`[Shortcut] Failed to register: ${showWindowShortcut}`)
    }
  } catch (error) {
    console.error('[Shortcut] Error registering shortcut:', error)
  }
}
let currentProxyAccount: { id: string; email: string; idp: string; status: string; subscription?: string; usage?: { usedCredits: number; totalCredits: number; totalRequests: number; successRequests: number; failedRequests: number } } | null = null
let allAccounts: { id: string; email: string; idp: string; status: string }[] = []

// 加载托盘设置
async function loadTraySettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('traySettings') as TraySettings | undefined
    if (saved) {
      traySettings = { ...defaultTraySettings, ...saved }
    }
  } catch (error) {
    console.error('[Tray] Failed to load tray settings:', error)
  }
}

// 保存托盘设置
async function saveTraySettings(): Promise<void> {
  try {
    await initStore()
    store?.set('traySettings', traySettings)
  } catch (error) {
    console.error('[Tray] Failed to save tray settings:', error)
  }
}

// 初始化托盘
function initTray(): void {
  if (!traySettings.enabled) return

  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢复 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onRefreshAccount: async () => {
      mainWindow?.webContents.send('tray-refresh-account')
    },
    onSwitchAccount: async () => {
      mainWindow?.webContents.send('tray-switch-account')
    },
    onToggleProxy: async () => {
      const server = initProxyServer()
      if (server.isRunning()) {
        server.stop()
      } else {
        await server.start()
      }
      updateTrayMenu()
    },
    getProxyStatus: () => {
      const server = initProxyServer()
      return {
        running: server.isRunning(),
        port: server.getConfig().port
      }
    },
    getCurrentAccount: () => currentProxyAccount,
    getAccountList: () => allAccounts,
    getProxyStats: () => {
      const server = initProxyServer()
      const stats = server.getStats()
      return {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests
      }
    },
    getSessionStats: () => {
      const server = initProxyServer()
      return server.getSessionStats()
    }
  })

  // 设置初始提示
  setTrayTooltip(`Kiro 账号管理器 v${app.getVersion()}`)
}

function createWindow(): void {
  // Create the browser window.
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    title: `Kiro 账号管理器 v${app.getVersion()}`,
    width: 1200,   // 刚好容纳 3 列卡片 (340*3 + 16*2 + 边距)
    height: 1200,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // 自定义 titlebar：mac 保留红绿黄灯 + 隐藏标题栏；win/linux 完全无 frame
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // 不透明窗口（关闭透明 + Mica/Vibrancy 避免桌面元素干扰）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
      // ⚠ 不要在这里加 backgroundThrottling: false
      // 它 + frame:false 会触发 electron#29646 / #50250:最小化/遮挡后 visibility 状态
      // desync，窗口永久收不到点击(hover 仍有效)。同等目的已由文件头部的三个
      // app.commandLine.appendSwitch(disable-background-timer-throttling /
      // disable-renderer-backgrounding / disable-backgrounding-occluded-windows)实现，
      // 那条路径不经过有 bug 的 blink patch。详见文件头部注释块。
    }
  })

  // ============ 自定义 titlebar IPC ============
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximize-changed', false))

  mainWindow.on('ready-to-show', () => {
    // 设置带版本号的标题（HTML 加载后会覆盖初始标题）
    mainWindow?.setTitle(`Kiro 账号管理器 v${app.getVersion()}`)
    mainWindow?.show()
    
    // 检查代理服务自启动配置
    setTimeout(async () => {
      try {
        await initStore()
        if (!store) return
        
        const savedProxyConfig = store.get('proxyConfig') as ProxyConfig | undefined
        if (!savedProxyConfig?.autoStart) return
        
        console.log('[ProxyServer] Auto-starting proxy server...')
        const server = initProxyServer()
        server.updateConfig(savedProxyConfig)
        
        // 自启动时同步账号到代理池（含重试机制应对冷启动数据延迟）
        const syncAccountsToPool = (): number => {
          const accountData = store!.get('accountData') as {
            accounts?: Record<string, any>
            accountProxyBindings?: Record<string, string>
            proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
          } | undefined
          if (!accountData?.accounts) return 0

          const bindings = accountData.accountProxyBindings || {}
          const proxyPool = accountData.proxyPool || {}
          const buildProxyUrl = (accountId: string): string | undefined => {
            const proxyId = bindings[accountId]
            if (!proxyId) return undefined
            const p = proxyPool[proxyId]
            if (!p || !p.enabled || p.status === 'dead') return undefined
            return p.url
          }

          // 准入判据与面板侧同一真源(`proxy/activation.ts checkPoolAdmission`):
          // 有凭据 + 未被上游明确拒绝。**不判 `status === 'active'`** —— status 是显示字段,
          // 断网时的后台测活会把好号写成 'error'(`persistCheckResult.ts:325`),
          // 而没有任何路径会自动写回 'active',于是一次网络抖动就把全部账号永久踢出池。
          const admissionSkips: PoolAdmissionSkip[] = []
          const proxyAccounts = Object.values(accountData.accounts)
            .filter((acc: any) => {
              const skip = checkPoolAdmission(acc)
              if (skip) admissionSkips.push(skip)
              return !skip
            })
            .map((acc: any) => {
              const provider = acc.credentials?.provider || acc.idp
              const authMethod = acc.credentials?.authMethod
              const profileArn = acc.profileArn || acc.credentials?.profileArn
              // BuilderId/Social 不需要预填 profileArn（resolveProfileArn 会兜底，流式端点自动不传占位符）
              // Enterprise 留给自愈获取真实 ARN
              return {
                id: acc.id,
                email: acc.email,
                accessToken: acc.credentials.accessToken,
                refreshToken: acc.credentials?.refreshToken,
                profileArn,
                expiresAt: acc.credentials?.expiresAt,
                machineId: acc.machineId,
                clientId: acc.credentials?.clientId,
                clientSecret: acc.credentials?.clientSecret,
                region: acc.credentials?.region || 'us-east-1',
                authMethod,
                provider,
                // external_idp (Azure AD) 专用:反代自动刷新需微软 tokenEndpoint
                tokenEndpoint: acc.credentials?.tokenEndpoint,
                issuerUrl: acc.credentials?.issuerUrl,
                scopes: acc.credentials?.scopes,
                proxyUrl: buildProxyUrl(acc.id),
                // v1.7.6 SWRR 权重(缺省 100)
                weight: typeof acc.weight === 'number' ? acc.weight : 100,
                groupId: acc.groupId
              }
            })
          logPoolAdmissionSkips(admissionSkips, 'autostart')
          if (proxyAccounts.length > 0) {
            // replaceAll 而非 clear()+addAccount():后者会在清空那一步丢掉
            // 运行期状态(额度 / 402 耗尽标记 / 风控挂起 / 断路器)。
            // 自启动首次同步时池本来是空的,迁移无副作用;但这里同时被
            // retrySync 复用(下方 2s..10s 重试),那时池里可能已有喂进去的额度。
            server.getAccountPool().replaceAll(proxyAccounts)
          }
          return proxyAccounts.length
        }

        let syncedCount = syncAccountsToPool()
        if (syncedCount > 0) {
          console.log('[ProxyServer] Auto-synced', syncedCount, 'accounts')
        } else {
          // 冷启动时 store 可能还没有数据（渲染进程尚未初始化完成），延迟重试
          console.log('[ProxyServer] No accounts found on initial sync, will retry...')
          const retrySync = (attempt: number) => {
            setTimeout(() => {
              const count = syncAccountsToPool()
              if (count > 0) {
                console.log(`[ProxyServer] Retry #${attempt}: synced ${count} accounts`)
              } else if (attempt < 5) {
                retrySync(attempt + 1)
              } else {
                console.log('[ProxyServer] All retry attempts exhausted, no accounts available. Accounts will sync when UI loads.')
              }
            }, attempt * 2000) // 2s, 4s, 6s, 8s, 10s
          }
          retrySync(1)
        }
        
        await server.start()
        console.log('[ProxyServer] Auto-started successfully on port', savedProxyConfig.port || 5580)
      } catch (error) {
        console.error('[ProxyServer] Auto-start failed:', error)
      }

      // 局域网 web 面板自启动(W6)。照反代 autoStart 先例:配置里 enabled + autoStart
      // 双开才拉起;失败不阻断应用启动(原因记入 lastError,设置页显示真实结果)。
      await webPanelWiring?.autoStartIfConfigured()

      // K-Proxy MITM 自启动
      try {
        const savedKProxyConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
        if (savedKProxyConfig?.autoStart) {
          console.log('[KProxy] Auto-starting K-Proxy MITM...')
          // 用户数据目录由装配层注入（内核零 electron 依赖，见 kproxy/index.ts 头部）
          const service = initKProxyService(savedKProxyConfig, {
            onRequest: (info) => {
              mainWindow?.webContents.send('kproxy-request', info)
            },
            onResponse: (info) => {
              mainWindow?.webContents.send('kproxy-response', info)
            },
            onError: (error) => {
              console.error('[KProxy] Error:', error)
              mainWindow?.webContents.send('kproxy-error', error.message)
            },
            onStatusChange: (running, port) => {
              mainWindow?.webContents.send('kproxy-status-change', { running, port })
            },
            onMitmIntercept: (host, modified) => {
              mainWindow?.webContents.send('kproxy-mitm', { host, modified })
            }
          }, app.getPath('userData'))
          await service.initialize()
          await service.start()
          console.log('[KProxy] Auto-started successfully')
        }
      } catch (error) {
        console.error('[KProxy] Auto-start failed:', error)
      }
    }, 1000)
  })

  mainWindow.on('close', (event) => {
    // 托盘最小化逻辑 - 必须同步检查并调用 preventDefault
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === 'minimize') {
        // 直接最小化到托盘
        event.preventDefault()
        mainWindow?.hide()
        // macOS: 隐藏窗口时隐藏 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
        return
      } else if (traySettings.closeAction === 'ask' && mainWindow) {
        // 询问用户 - 先阻止关闭，再异步处理
        event.preventDefault()
        // 通知渲染进程显示自定义对话框
        mainWindow.webContents.send('show-close-confirm-dialog')
        return
      }
      // closeAction === 'quit' 时继续关闭流程
    }

    // 窗口关闭前保存数据（同步保存，不等待备份）· 走收口
    if (lastSavedData && store) {
      try {
        console.log('[Window] Saving data before close...')
        // 关窗 flush 语义:把内存里的 lastSavedData 落盘。走收口保持 revision 单调递增,
        // main 侧是权威源,不传 expectedRevision。收口会在 mutator 返回值上 +1 revision。
        void applyAccountDataMutation(() => lastSavedData as AccountsBlob)
        // 备份异步进行，不阻塞关闭
        createBackup(lastSavedData).then(() => {
          console.log('[Window] Backup created')
        }).catch(err => {
          console.error('[Window] Backup failed:', err)
        })
        console.log('[Window] Data saved successfully')
      } catch (error) {
        console.error('[Window] Failed to save data:', error)
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // ★ SSOT IPC 出口守卫 · 一处收口 · 防止大 payload 跨进程克隆卡死 renderer
  // 详见 src/main/utils/emitToRenderer.ts 与 2026-07-23 frontend-freeze RCA
  installIpcSizeGuard(mainWindow.webContents)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 注册自定义协议
function registerProtocol(): void {
  // 先注销旧的注册（防止上次异常退出未注销）
  unregisterProtocol()
  
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      // dev 模式：process.argv[1] 是相对路径，协议处理器由系统从 system32 启动，
      // 必须传绝对路径，否则 electron 找不到 app 入口报 "Unable to find Electron app"
      app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [
        resolve(process.argv[1])
      ])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`)
}

// 注销自定义协议 (应用退出时调用)
function unregisterProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [
        resolve(process.argv[1])
      ])
    }
  } else {
    app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`)
}

// 处理协议 URL (用于 OAuth 回调)
function handleProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // 处理 auth 回调
    if (pathname === 'auth/callback' || urlObj.host === 'auth') {
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')

      if (code && state && mainWindow) {
        mainWindow.webContents.send('auth-callback', { code, state })
        mainWindow.focus()
      }
    }
  } catch (error) {
    console.error('Failed to parse protocol URL:', error)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // 初始化日志系统（尽早拦截，确保所有 console 输出都进入日志存储）
  //
  // 平台差异注入点：logger 是共享内核，不再自己 import electron（见其文件头）。
  // 它对「是否生产构建」的默认判断取安全侧(截断开启)，桌面端在这里把真实的
  // app.isPackaged 交给它，从而恢复「dev 不截断、便于调试」的开发体验。
  // 必须在 interceptConsole() 之前 —— 晚一步就有早期日志按错误档位处理。
  setLogTruncationEnabled(app.isPackaged)
  proxyLogStore.initialize(app.getPath('userData'))
  interceptConsole()

  // 回收上次 orphan session（强杀/崩溃/关机未及时正常归档时留下的）
  // 必须在 initProxyServer/proxyServer.start 之前，避免新会话的 60s tick 盖掉上一次的 orphan
  await restoreOrphanProxySessionIfAny()

  // 启动 Kiro IDE token 文件监听（反向同步：IDE 自己 refresh 后把新 token 同步回反代 store）
  // 见 syncIdeTokenChangeToStore 注释
  startKiroAuthTokenWatcher()

  // 注册自定义协议
  registerProtocol()

  // 加载托盘设置并初始化托盘
  await loadTraySettings()
  initTray()

  // 初始化自动更新（仅生产环境）
  if (!is.dev) {
    setupAutoUpdater()
    // 启动后延迟检查更新
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(console.error)
    }, 3000)
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.kiro.account-manager')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC: 打开外部链接
  ipcMain.on('open-external', (_event, url: string, usePrivateMode?: boolean) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      if (usePrivateMode) {
        openBrowserInPrivateMode(url)
      } else {
        shell.openExternal(url)
      }
    }
  })

  // ============ 注册功能 IPC ============
  registerRegistrationHandlers(() => mainWindow)

  // ============ 托盘相关 IPC ============

  // IPC: 获取托盘设置
  ipcMain.handle('get-tray-settings', () => {
    return traySettings
  })

  // ============ 自定义 titlebar IPC ============
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window-get-platform', () => process.platform)

  // IPC: 获取显示主窗口快捷键
  ipcMain.handle('get-show-window-shortcut', () => {
    return showWindowShortcut
  })

  // IPC: 设置显示主窗口快捷键
  ipcMain.handle('set-show-window-shortcut', async (_event, shortcut: string) => {
    try {
      showWindowShortcut = shortcut
      await saveShortcutSettings()
      registerShowWindowShortcut()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // IPC: 保存托盘设置
  ipcMain.handle('save-tray-settings', async (_event, settings: Partial<TraySettings>) => {
    try {
      traySettings = { ...traySettings, ...settings }
      await saveTraySettings()
      
      // 根据设置启用/禁用托盘
      if (settings.enabled !== undefined) {
        if (settings.enabled) {
          initTray()
        } else {
          destroyTray()
        }
      }
      
      return { success: true }
    } catch (error) {
      console.error('[Tray] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 更新托盘账户信息（从渲染进程调用）
  ipcMain.on('update-tray-account', (_event, account: typeof currentProxyAccount) => {
    currentProxyAccount = account
    updateCurrentAccount(account)
    
    // 更新托盘提示
    if (account) {
      setTrayTooltip(`Kiro 账号管理器\n当前账户: ${account.email}`)
    } else {
      setTrayTooltip(`Kiro 账号管理器 v${app.getVersion()}`)
    }
  })

  // IPC: 更新托盘账户列表（从渲染进程调用）
  ipcMain.on('update-tray-account-list', (_event, accounts: typeof allAccounts) => {
    allAccounts = accounts
    updateAccountList(accounts)
  })

  // IPC: 刷新托盘菜单
  ipcMain.on('refresh-tray-menu', () => {
    updateTrayMenu()
  })

  // IPC: 更新托盘语言
  ipcMain.on('update-tray-language', (_event, language: 'en' | 'zh') => {
    updateTrayLanguage(language)
  })

  // IPC: 关闭确认对话框响应
  ipcMain.on('close-confirm-response', (_event, action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => {
    if (action === 'minimize') {
      mainWindow?.hide()
      // macOS: 隐藏窗口时隐藏 Dock 图标
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide()
      }
    } else if (action === 'quit') {
      // 如果用户选择记住选择
      if (rememberChoice) {
        traySettings.closeAction = 'quit'
        saveTraySettings()
      }
      isQuitting = true
      app.quit()
    }
    // cancel 时不做任何操作
    
    // 如果用户选择记住"最小化"选择
    if (action === 'minimize' && rememberChoice) {
      traySettings.closeAction = 'minimize'
      saveTraySettings()
    }
  })

  // IPC: 获取应用版本
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // IPC: 检查更新
  ipcMain.handle('check-for-updates', async () => {
    if (is.dev) {
      return { hasUpdate: false, message: '开发环境不支持更新检查' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return {
        hasUpdate: !!result?.updateInfo,
        version: result?.updateInfo?.version,
        releaseDate: result?.updateInfo?.releaseDate
      }
    } catch (error) {
      console.error('[AutoUpdater] Check failed:', error)
      return { hasUpdate: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 下载更新
  ipcMain.handle('download-update', async () => {
    if (is.dev) {
      return { success: false, message: '开发环境不支持更新' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('[AutoUpdater] Download failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 安装更新并重启
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // IPC: 手动检查更新（使用 GitHub API，用于 AboutPage）
  const GITHUB_REPO = 'chaogei/Kiro-account-manager'
  const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  
  ipcMain.handle('check-for-updates-manual', async () => {
    try {
      console.log('[Update] Manual check via GitHub API...')
      const currentVersion = app.getVersion()
      
      const response = await fetchWithAppProxy(GITHUB_API_URL, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Kiro-Account-Manager'
        }
      })
      
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('GitHub API 请求次数超限，请稍后再试')
        } else if (response.status === 404) {
          throw new Error('未找到发布版本')
        }
        throw new Error(`GitHub API 错误: ${response.status}`)
      }
      
      const release = await response.json() as {
        tag_name: string
        name: string
        body: string
        html_url: string
        published_at: string
        assets: Array<{
          name: string
          browser_download_url: string
          size: number
        }>
      }
      
      const latestVersion = release.tag_name.replace(/^v/, '')
      
      // 比较版本号
      const compareVersions = (v1: string, v2: string): number => {
        const parts1 = v1.split('.').map(Number)
        const parts2 = v2.split('.').map(Number)
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
          const p1 = parts1[i] || 0
          const p2 = parts2[i] || 0
          if (p1 > p2) return 1
          if (p1 < p2) return -1
        }
        return 0
      }
      
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      
      console.log(`[Update] Current: ${currentVersion}, Latest: ${latestVersion}, HasUpdate: ${hasUpdate}`)
      
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseNotes: release.body || '',
        releaseName: release.name || `v${latestVersion}`,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        assets: release.assets.map(a => ({
          name: a.name,
          downloadUrl: a.browser_download_url,
          size: a.size
        }))
      }
    } catch (error) {
      console.error('[Update] Manual check failed:', error)
      return {
        hasUpdate: false,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  })

  // ============ 一键诊断 ============
  /**
   * 测试一组目标 URL 的连通性（用于诊断面板）
   * 支持指定代理 URL；返回每个目标的延迟与错误
   */
  ipcMain.handle('diagnose:run', async (_event, params: {
    proxyUrl?: string
    targets: Array<{ id: string; label: string; url: string; timeoutMs?: number; expectStatus?: number[] }>
  }) => {
    const { proxyUrl, targets } = params || {}
    const agent = proxyUrl ? safeCreateProxyAgent(proxyUrl) : undefined

    const results = await Promise.all((targets || []).map(async (t) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? 8000)
      const start = Date.now()
      try {
        const init: UndiciRequestInit = {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'KiroAccountManager-Diagnose/1.0' }
        }
        if (agent) init.dispatcher = agent
        const resp = await undiciFetch(t.url, init)
        const latencyMs = Date.now() - start
        const expected = t.expectStatus
        const ok = expected ? expected.includes(resp.status) : (resp.status >= 200 && resp.status < 400)
        return {
          id: t.id,
          label: t.label,
          url: t.url,
          success: ok,
          httpStatus: resp.status,
          latencyMs,
          error: ok ? undefined : `HTTP ${resp.status}`
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return {
          id: t.id,
          label: t.label,
          url: t.url,
          success: false,
          latencyMs: Date.now() - start,
          error: controller.signal.aborted ? '超时' : errMsg
        }
      } finally {
        clearTimeout(timer)
      }
    }))

    return { results }
  })

  // ============ 代理池验活 ============
  /**
   * 通过指定代理 URL 请求测试地址，返回延迟与出口 IP
   * 仅支持 http/https 协议代理（受 undici ProxyAgent 限制；socks 协议会被 safeCreateProxyAgent 静默跳过）
   */
  // 代理池相关 IPC handler 已拆分到独立模块，便于后续维护
  registerProxyPoolIpcHandlers()

  // ============ 账号-代理绑定（反代时 N 账号一个 IP）============
  /**
   * 设置账号在反代场景下使用的出口代理 URL
   * 同时更新：反代账号池里现存的 ProxyAccount.proxyUrl + store 持久化的 accountProxyBindings
   */
  ipcMain.handle('account-set-proxy-binding', async (_event, accountId: string, proxyUrl: string | undefined) => {
    try {
      if (!accountId) return { success: false }
      // 更新反代账号池内存中的 proxyUrl
      if (proxyServer) {
        const pool = proxyServer.getAccountPool()
        const acc = pool.getAccount(accountId)
        if (acc) {
          acc.proxyUrl = proxyUrl || undefined
          console.log(`[ProxyServer] Account ${acc.email || accountId.slice(0, 8)} proxy ${proxyUrl ? `bound to ${proxyUrl.replace(/:([^:@/]+)@/, ':***@')}` : 'unbound'}`)
        }
      }
      return { success: true }
    } catch (err) {
      console.error('[account-set-proxy-binding] error:', err)
      return { success: false }
    }
  })

  // ============ 账号池热切换(反代运行中不 stop)============
  // 详见 2026-07-23 hot-swap-accounts 决策卡 §3
  /**
   * 强制下一次请求使用指定账号
   * 校验:proxyServer 运行中 + 账号在池 + 非 suspended
   * 错误码:PROXY_NOT_RUNNING / ACCOUNT_NOT_IN_POOL / ACCOUNT_NOT_AVAILABLE
   * Idempotent:是(切到同一账号 no-op)
   */
  ipcMain.handle('proxy-set-active-account', (_event, params: { accountId?: string }) => {
    try {
      const accountId = params?.accountId
      if (!accountId) {
        return { success: false, error: 'ACCOUNT_NOT_IN_POOL' }
      }
      if (!proxyServer) {
        return { success: false, error: 'PROXY_NOT_RUNNING' }
      }
      const pool = proxyServer.getAccountPool()
      const acc = pool.getAccount(accountId)
      if (!acc) {
        return { success: false, error: 'ACCOUNT_NOT_IN_POOL' }
      }
      if (pool.isSuspended(acc)) {
        return { success: false, error: 'ACCOUNT_NOT_AVAILABLE' }
      }
      const ok = pool.setActiveAccount(accountId)
      if (!ok) {
        return { success: false, error: 'ACCOUNT_NOT_IN_POOL' }
      }
      console.log(`[AccountPool] Hot-switch active account to ${acc.email || accountId.slice(0, 8)}`)
      // 显式换账号 ⇒ 旧会话粘性作废。不清的话,开了 sessionAffinity 的用户即使接线
      // 正确,带固定 session id 的客户端仍会粘在旧账号上直到重启 · 详见 RCA §1.5 假设 D
      const droppedAffinity = proxyServer.invalidateSessionAffinity()
      if (droppedAffinity > 0) {
        console.log(`[AccountPool] Invalidated ${droppedAffinity} session affinity entr${droppedAffinity === 1 ? 'y' : 'ies'} after hot-switch`)
      }
      return {
        success: true,
        account: {
          id: acc.id,
          email: acc.email,
          isAvailable: acc.isAvailable !== false
        }
      }
    } catch (err) {
      console.error('[proxy-set-active-account] error:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })

  /**
   * 热编辑账号池成员(add / remove / replace 互斥,replace 优先)
   * 校验:操作后 pool 非空(replace 空数组 / remove 后为空 → 拒绝)
   * 错误码:WOULD_EMPTY_POOL / INVALID_ACCOUNT_SHAPE
   * Idempotent:add 是(已存在 update 不重复)· remove 是(不存在跳过)
   */
  ipcMain.handle('proxy-update-pool-members', (_event, params: {
    add?: ProxyAccount[]
    remove?: string[]
    replace?: ProxyAccount[]
  }) => {
    try {
      if (!proxyServer) {
        return { success: false, error: 'PROXY_NOT_RUNNING' }
      }
      const pool = proxyServer.getAccountPool()
      const { add, remove, replace } = params || {}

      // replace 优先
      if (Array.isArray(replace)) {
        if (replace.length === 0) {
          return { success: false, error: 'WOULD_EMPTY_POOL' }
        }
        for (const acc of replace) {
          if (!acc?.id || !acc?.accessToken) {
            return { success: false, error: 'INVALID_ACCOUNT_SHAPE' }
          }
        }
        // replaceAll:按 id 迁移运行期状态(额度 / 402 耗尽标记 / 风控挂起 / 断路器)。
        // 热替换是「换名单」不是「忘掉一切」—— 名单里仍在的号不该因为一次替换
        // 就把已知的耗尽/封禁状态清干净(那会让坏号立刻重新进入轮询)。
        pool.replaceAll(replace)
        console.log(`[AccountPool] Hot-replace pool: ${replace.length} accounts`)
        return { success: true, addedCount: replace.length, removedCount: 0, poolSize: pool.size }
      }

      // add / remove
      let addedCount = 0
      let removedCount = 0

      if (Array.isArray(add)) {
        for (const acc of add) {
          if (!acc?.id || !acc?.accessToken) {
            return { success: false, error: 'INVALID_ACCOUNT_SHAPE' }
          }
        }
        for (const acc of add) {
          // 幂等 upsert:已在池只刷凭据(保留 suspendedAt / 断路器 / 统计),不在池才新增。
          // 无条件 addAccount 会静默解除运行期风控封禁 · 详见 RCA §4.2b
          pool.upsertAccount(acc)
          addedCount++
        }
      }

      if (Array.isArray(remove)) {
        for (const id of remove) {
          if (pool.getAccount(id)) {
            pool.removeAccount(id)
            removedCount++
          }
        }
      }

      // 操作后 pool 非空校验(仅在 remove 且未 add 的情况下才可能触发)
      if (pool.size === 0) {
        return { success: false, error: 'WOULD_EMPTY_POOL' }
      }

      console.log(`[AccountPool] Hot-update pool: +${addedCount}/-${removedCount}, size=${pool.size}`)
      return { success: true, addedCount, removedCount, poolSize: pool.size }
    } catch (err) {
      console.error('[proxy-update-pool-members] error:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })

  // ============ 通用 HTTP 诊断探测 ============
  /**
   * 使用应用代理设置发起一次 GET/HEAD 请求，返回延迟、状态码、错误信息。
   * 用于"一键诊断"面板中检测 Kiro API / 邮箱服务 / 公网连通性。
   */
  ipcMain.handle('diagnose:http-probe', async (_event, params: {
    url: string
    method?: 'GET' | 'HEAD'
    timeoutMs?: number
  }) => {
    const { url, method = 'GET', timeoutMs = 5000 } = params || {}
    if (!url) return { success: false, error: 'Missing url' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const start = Date.now()
    try {
      const resp = await fetchWithAppProxy(url, {
        method,
        signal: controller.signal,
        headers: { 'User-Agent': 'KiroAccountManager-Diagnose/1.0' }
      })
      const latencyMs = Date.now() - start
      return { success: resp.ok, latencyMs, status: resp.status }
    } catch (err) {
      const isAbort = controller.signal.aborted
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: isAbort ? `Timeout (${timeoutMs}ms)` : (err instanceof Error ? err.message : String(err))
      }
    } finally {
      clearTimeout(timer)
    }
  })

  // IPC: 账号测活 —— 指定账号走反代逻辑（callKiroApi，与反代服务器同一底层调用）
  // 给指定模型发一条测试消息，验证账号是否能正常返回，用于一键诊断"账号测活"功能
  ipcMain.handle('diagnose:account-liveness', async (_event, params: {
    account: {
      id?: string
      email?: string
      accessToken?: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp' | 'api_key'
      provider?: string
      profileArn?: string
      machineId?: string
      expiresAt?: number
      proxyUrl?: string
      tokenEndpoint?: string
      scopes?: string
    }
    model?: string
    message?: string
    timeoutMs?: number
  }) => {
    const acc = params?.account
    const model = (params?.model || 'claude-sonnet-4.5').trim()
    const message = (params?.message || 'Hi, reply with "pong" only.').trim()
    const timeoutMs = params?.timeoutMs ?? 45000
    const start = Date.now()

    if (!acc || !acc.accessToken) {
      return { success: false, error: '账号缺少 accessToken', latencyMs: 0 }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // 1) Token 即将过期/已过期 → 先刷新（走账号绑定代理）
      let accessToken = acc.accessToken
      const needsRefresh = acc.expiresAt ? (acc.expiresAt - Date.now() < 60_000) : false
      if (needsRefresh && acc.refreshToken) {
        try {
          const r = await refreshTokenByMethod(
            acc.refreshToken,
            acc.clientId || '',
            acc.clientSecret || '',
            acc.region || 'us-east-1',
            acc.authMethod,
            acc.proxyUrl,
            { tokenEndpoint: acc.tokenEndpoint, scopes: acc.scopes }
          )
          if (r.success && r.accessToken) accessToken = r.accessToken
        } catch { /* 刷新失败则用原 token 尝试，让真实错误暴露出来 */ }
      }

      // 2) 构建 ProxyAccount（callKiroApi 需要的账号结构）
      const proxyAccount: ProxyAccount = {
        id: acc.id || 'diagnose',
        email: acc.email,
        accessToken,
        refreshToken: acc.refreshToken,
        clientId: acc.clientId,
        clientSecret: acc.clientSecret,
        region: acc.region || 'us-east-1',
        authMethod: acc.authMethod,
        provider: acc.provider,
        profileArn: acc.profileArn,
        machineId: acc.machineId,
        proxyUrl: acc.proxyUrl,
        expiresAt: acc.expiresAt
      }

      // 3) 构建最小 OpenAI chat 请求 → 转 Kiro payload
      const payload = openaiToKiro({
        model,
        messages: [{ role: 'user', content: message }],
        stream: false,
        max_tokens: 64
      }, proxyAccount.profileArn)

      // 4) 调用（与反代服务器内部完全相同的底层调用）
      const result = await callKiroApi(proxyAccount, payload, controller.signal)
      const latencyMs = Date.now() - start
      const content = (result.content || '').trim()
      return {
        success: true,
        latencyMs,
        model,
        content: content.slice(0, 500),
        usage: {
          inputTokens: result.usage?.inputTokens || 0,
          outputTokens: result.usage?.outputTokens || 0,
          credits: result.usage?.credits || 0
        }
      }
    } catch (err) {
      const isAbort = controller.signal.aborted
      const rawMsg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        latencyMs: Date.now() - start,
        model,
        error: isAbort ? `超时 (${timeoutMs}ms)` : rawMsg
      }
    } finally {
      clearTimeout(timer)
    }
  })

  // IPC: 加载账号数据
  // 实现在 accountService/accounts.ts（IPC 与 web 面板共用）
  ipcMain.handle('load-accounts', async () => svcLoadAccounts(accountDeps))

  // IPC: 保存账号数据
  // 返回契约（T7 升级）:
  //   成功 → { ok: true, revision: number }
  //   过期 → { ok: false, code: 'STALE_REVISION', currentRevision: number }
  // 客户端未传 expectedRevision 时降级为无仲裁直写（向后兼容,同 W1 骨架语义）,仍返回 { ok: true, revision }。
  // 实现在 accountService/accounts.ts（IPC 与 web 面板共用）
  ipcMain.handle('save-accounts', async (_event, data: { expectedRevision?: number; originId?: string; [k: string]: unknown }) =>
    svcSaveAccounts(accountDeps, data)
  )

  // ============ accountService 依赖装配 ============
  // 账号业务逻辑已抽到 src/main/accountService/(IPC 与将来的 web 面板 HTTP 共用同一实现)。
  // 此处把原先被 handler 闭包捕获的模块级状态显式注入:
  //   - mainWindow?.webContents.send → emit(保留"窗口已关闭时静默 no-op"容错)
  //   - lastSwitchedAccountId / lastWrittenTokenSignature 走 getter/setter,
  //     因为 IDE token watcher 与 ProactiveRenewal 定时器**也读**这两个变量,传值会产生两个副本
  //   - proxyServer / proactiveRenewalEnabled 实时读(用户可在运行期切换)
  const accountServiceDeps: AccountRuntimeDeps = {
    get proxyServer() {
      return proxyServer
    },
    emit: (channel, payload) => {
      // 原语义:主窗口关闭时 send 是 no-op,不抛错
      mainWindow?.webContents.send(channel, payload)
    },
    api: {
      getUsageAndLimits,
      getUserInfo,
      refreshTokenByMethod,
      fetchEnterpriseProfileArn,
      readKiroAuthTokenFile,
      writeKiroAuthTokenFile,
      resolveProfileArnForWrite
    },
    getLastSwitchedAccountId: () => lastSwitchedAccountId,
    setLastSwitchedAccountId: (id) => {
      lastSwitchedAccountId = id
    },
    getLastWrittenTokenSignature: () => lastWrittenTokenSignature,
    setLastWrittenTokenSignature: (sig) => {
      lastWrittenTokenSignature = sig
    },
    isProactiveRenewalEnabled: () => proactiveRenewalEnabled,
    scheduleProactiveRenewal: (accountId, expiresAtMs) =>
      scheduleProactiveRenewal(accountId, expiresAtMs),
    refreshInFlightIds: poolRefreshInFlightIds
  }

  // IPC: 刷新账号 Token（支持 IdC 和社交登录）
  ipcMain.handle('refresh-account-token', async (_event, account) =>
    refreshAccountToken(accountServiceDeps, account)
  )

  // ============ 主动续期开关 IPC ============
  // 启用后，账号管理器会在 IDE 当前激活账号的 token 剩 PROACTIVE_RENEWAL_LEAD_MS（默认 15 分钟）时
  // 抢先 refresh + 写磁盘，IDE 永远拿到剩余 ≥ 45 分钟的 token，IDE 内部 refresh loop 不会触发，
  // 彻底消除 IDE 与账号管理器同时 refresh 撞车的可能。
  ipcMain.handle('set-proactive-renewal-enabled', async (_event, enabled: boolean) => {
    try {
      await initStore()
      proactiveRenewalEnabled = !!enabled
      store?.set('proactiveRenewalEnabled', proactiveRenewalEnabled)
      console.log(`[ProactiveRenewal] ${proactiveRenewalEnabled ? 'Enabled' : 'Disabled'} by user`)

      if (proactiveRenewalEnabled) {
        // 启用时：若当前已有 IDE 激活账号，立刻 schedule
        if (lastSwitchedAccountId) {
          const accountData = store?.get('accountData') as
            | { accounts?: Record<string, { credentials?: { expiresAt?: number } }> }
            | null
            | undefined
          const acc = accountData?.accounts?.[lastSwitchedAccountId]
          const exp = acc?.credentials?.expiresAt
          if (typeof exp === 'number' && exp > Date.now()) {
            scheduleProactiveRenewal(lastSwitchedAccountId, exp)
          } else {
            console.log('[ProactiveRenewal] No valid expiresAt for current IDE active account, will schedule after next switch/refresh')
          }
        } else {
          console.log('[ProactiveRenewal] No IDE active account recorded yet, will schedule after next switch')
        }
      } else {
        clearProactiveRenewal('disabled by user')
      }
      return { success: true, enabled: proactiveRenewalEnabled }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  ipcMain.handle('get-proactive-renewal-enabled', async () => {
    try {
      await initStore()
      return {
        success: true,
        enabled: !!store?.get('proactiveRenewalEnabled', false),
        leadTimeMinutes: PROACTIVE_RENEWAL_LEAD_MS / 60000
      }
    } catch (error) {
      return {
        success: false,
        enabled: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // IPC: 从 SSO Token 导入账号 (x-amz-sso_authn)
  // 实现在 accountService/verify.ts（IPC 与 web 面板共用）
  ipcMain.handle('import-from-sso-token', async (_event, bearerToken: string, region: string = 'us-east-1') =>
    svcImportFromSsoToken(verifyApiDeps, bearerToken, region)
  )

  // IPC: 检查账号状态（用量/订阅/封禁）—— 用户日常的"刷新额度"
  ipcMain.handle('check-account-status', async (_event, account) =>
    checkAccountStatus(accountServiceDeps, account)
  )

  // IPC: 后台批量刷新账号（在主进程执行，不阻塞 UI）
  //
  // 实现在 accountService/backgroundRefresh.ts —— 与 backgroundBatchCheck 同构:
  // 传输通道无关、可单测、服务端壳（无 BrowserWindow）可直接调。
  // 原先本文件内联一份约 320 行的副本,且刷新结果**只** emit 给渲染进程由
  // renderer store 落盘;服务器形态下 mainWindow 为 undefined ⇒ send 静默 no-op ⇒
  // 新签发的 refreshToken 永不上盘。落盘现已在业务层收口(persistBatchRefreshResults)。
  const backgroundBatchRefreshLocal = (
    accounts: BackgroundRefreshAccount[],
    concurrency: number = 10,
    syncInfo: boolean = true
  ): Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }> =>
    backgroundBatchRefresh(accountServiceDeps, accounts, concurrency, syncInfo)
  // 暴露给主进程调度器复用（startMainPoolTokenRefresh）
  backgroundBatchRefreshImpl = backgroundBatchRefreshLocal
  ipcMain.handle('background-batch-refresh', (_event, accounts: BackgroundRefreshAccount[], concurrency: number = 10, syncInfo: boolean = true) => backgroundBatchRefreshLocal(accounts, concurrency, syncInfo))
  // 启动主进程池 token 刷新调度器（不依赖窗口可见/存活，挂托盘也照常刷新）
  startMainPoolTokenRefresh()

  // IPC: 后台批量检查账号状态（不刷新 Token，只检查状态）
  ipcMain.handle('background-batch-check', async (_event, accounts: BatchCheckAccount[], concurrency: number = 10) =>
    backgroundBatchCheck(accountServiceDeps, accounts, concurrency)
  )

  // IPC: 导出到文件
  //   业务实现在 accountService/transfer.ts(IPC 与将来的 HTTP 层共用)。
  //   此处只注入宿主机能力:Electron dialog 选路径 + 本机写盘。
  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    return exportToFile(
      {
        pickSavePath: async (defaultPath) => {
          const result = await dialog.showSaveDialog(mainWindow!, {
            title: '导出账号数据',
            defaultPath,
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
          })
          return !result.canceled && result.filePath ? result.filePath : null
        },
        writeTextFile: (filePath, content) => writeFile(filePath, content, 'utf-8')
      },
      data,
      filename
    )
  })

  // IPC: 从文件导入
  //   业务实现在 accountService/transfer.ts;此处只注入 Electron dialog + 本机读盘。
  ipcMain.handle('import-from-file', async () => {
    return importFromFile({
      pickOpenPath: async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
          title: '导入账号数据',
          filters: [
            { name: '所有支持的格式', extensions: ['json', 'csv', 'txt'] },
            { name: 'JSON Files', extensions: ['json'] },
            { name: 'CSV Files', extensions: ['csv'] },
            { name: 'TXT Files', extensions: ['txt'] }
          ],
          properties: ['openFile']
        })
        return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null
      },
      readTextFile: (filePath) => readFile(filePath, 'utf-8')
    })
  })

  // IPC: 验证网页 API Key(ksk_)凭据有效性 + 附赠尝试解析 profileArn
  //   实现在 accountService/verify.ts（IPC 与 web 面板共用）
  //   契约(SSOT):@shared/types/credential.ts VerifyApiKeyResult —— renderer 唯一分类字段是 state · success 只作辅助
  ipcMain.handle('verify-api-key', async (_event, params: { apiKey: string; region?: string }): Promise<VerifyApiKeyResult> =>
    svcVerifyApiKey(params)
  )

  // IPC: 计算 accessToken 的 sha256 hex 指纹(前 16 位) · 用于老账号 tokenFingerprint 补齐迁移
  //   实现在 accountService/verify.ts（IPC 与 web 面板共用）
  ipcMain.handle('compute-token-fingerprint', async (_event, accessToken: string): Promise<string> =>
    svcComputeTokenFingerprint(accessToken)
  )

  // IPC: 导入网页 API Key(ksk_) —— 桌面端与 web 面板**共用同一份用例**
  //   实现在 accountService/importApiKey.ts。四态判定 / 双重判重 / 稳定 userId 派生
  //   全在那里,renderer 不再自己拼账号对象(否则判重逻辑会有两份真源,必然漂移)。
  //
  //   ⚠️ 写入经 applyAccountDataMutation 收口 ⇒ 落盘后会广播 accounts-data-changed,
  //   renderer 的订阅（App.tsx:150）据此静默 reload,新账号自动出现在桌面列表里。
  ipcMain.handle('import-api-keys', async (_event, input: ApiKeyImportInput) =>
    svcImportApiKeys(buildApiKeyImportDeps(), input ?? { rawInput: '' })
  )

  // IPC: 验证凭证并获取账号信息（用于添加账号）
  //   实现在 accountService/verify.ts（IPC 与 web 面板共用）
  ipcMain.handle('verify-account-credentials', async (_event, credentials: VerifyCredentialsInput) =>
    svcVerifyAccountCredentials(verifyApiDeps, credentials)
  )

  // IPC: 获取本地 SSO 缓存中当前使用的账号信息
  //   实现在 accountService/credentials.ts（IPC 与 web 面板共用）
  ipcMain.handle('get-local-active-account', async () => svcGetLocalActiveAccount(credentialFsDeps))

  // IPC: 从 Kiro 本地配置导入凭证
  //   实现在 accountService/credentials.ts（IPC 与 web 面板共用）
  ipcMain.handle('load-kiro-credentials', async () => svcLoadKiroCredentials(credentialFsDeps))

  // IPC: 切换账号 - 写入凭证到本地 SSO 缓存
  //
  // 业务实现在 accountService/switch.ts:switchAccountToIde(IPC 与将来的 HTTP 层共用)。
  // 关键设计(全部在被抽出的函数里,改那边时不要"顺手简化"):
  //   1. (bug A 修复) 把 OIDC 返回的新 refreshToken 也写入磁盘
  //      （旧实现只更新 accessToken，refreshToken 仍是已被服务端 rotate 作废的 v1，
  //       导致 Kiro IDE ~55min 后用 v1 刷新 → 401 → logoutAndForget）
  //   2. (bug C 修复) expiresAt 用 OIDC 返回的真实 expiresIn，不再硬编码 3600
  //   3. (bug D 修复) refresh 失败时直接报错并拒绝写入文件，避免埋雷
  //   4. (bug F 支持) 通过 refreshedCredentials 把新 refresh 回传 renderer，让反代 store 同步
  //   5. 记录 lastSwitchedAccountId，供 fs.watch 反向同步时用作账号匹配兜底
  //
  // lastSwitchedAccountId / lastWrittenTokenSignature 通过 setter 注入而非让 switch.ts 自己持有:
  //   读方是本文件的 watcher(:1875 防回环 / :1937 账号匹配兜底),两边必须是同一份。
  ipcMain.handle('switch-account', async (_event, credentials: SwitchAccountCredentials) => {
    return switchAccountToIde(
      {
        refreshTokenByMethod,
        writeKiroAuthTokenFile,
        resolveProfileArnForWrite,
        setLastSwitchedAccountId: (id) => {
          lastSwitchedAccountId = id
        },
        setLastWrittenTokenSignature: (sig) => {
          lastWrittenTokenSignature = sig
        },
        isProactiveRenewalEnabled: () => proactiveRenewalEnabled,
        scheduleProactiveRenewal
      },
      credentials
    )
  })

  // IPC: 切换账号到 Kiro CLI - 写入凭证到 SQLite 数据库
  // kiro-cli 使用 ~/.local/share/kiro-cli/data.sqlite3 中的 auth_kv 表
  //
  // 业务实现在 accountService/switchCli.ts:switchAccountToCli。
  // 此处只注入宿主机能力:解析本机 kiro-cli 数据目录 + 执行 SQLite 语句(含 sqlite3 命令行
  // → Node 内置 SQLite 的降级链)。
  //
  // ⚠️ deps 抽成 buildSwitchCliDeps() 而非内联:web 面板(W6)的同名端点必须复用**同一份**
  //    宿主机能力注入。内联会产生第二份副本,将来改降级链只改一处 = 两个通道行为分叉。
  const buildSwitchCliDeps = (): Parameters<typeof switchAccountToCli>[0] => ({
        refreshTokenByMethod,
        resolveProfileArnForWrite,
        resolveCliDbPath: async () => {
          const os = await import('os')
          const path = await import('path')
          const { mkdir } = await import('fs/promises')
          // kiro-cli SQLite 数据库路径
          // Windows: %LOCALAPPDATA%\kiro-cli\data.sqlite3
          // macOS/Linux: ~/.local/share/kiro-cli/data.sqlite3
          const dataDir =
            process.platform === 'win32'
              ? path.join(os.homedir(), 'AppData', 'Local', 'kiro-cli')
              : path.join(os.homedir(), '.local', 'share', 'kiro-cli')
          await mkdir(dataDir, { recursive: true })
          return path.join(dataDir, 'data.sqlite3')
        },
        execSqlite: async (dbPath, sqlStatements) => {
          // 使用 sqlite3 命令行操作（跨平台兼容，无需原生模块编译）
          const { execFileSync } = await import('child_process')
          const sqlite3Bin = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3'
          try {
            execFileSync(sqlite3Bin, [dbPath], {
              input: sqlStatements.join('\n'),
              timeout: 10000,
              encoding: 'utf-8'
            })
          } catch (sqlite3Error) {
            // sqlite3 命令不存在，尝试用 Node.js 22+ 的内置 SQLite
            console.log('[Switch CLI] sqlite3 command not available, trying Node.js built-in SQLite...')
            try {
              const { DatabaseSync } = await import('node:sqlite') as { DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void } }
              const db = new DatabaseSync(dbPath)
              try {
                for (const sql of sqlStatements) {
                  db.exec(sql)
                }
              } finally {
                db.close()
              }
            } catch {
              throw new Error(`SQLite 操作失败: sqlite3 命令不可用 (${(sqlite3Error as Error).message})，且 Node.js 内置 SQLite 不支持。请确保系统安装了 sqlite3 命令行工具。`)
            }
          }
        }
  })

  ipcMain.handle('switch-account-cli', async (_event, credentials: SwitchAccountCliCredentials) => {
    return switchAccountToCli(buildSwitchCliDeps(), credentials)
  })


  // IPC: 退出登录 - 清除本地 SSO 缓存
  //   业务实现在 accountService/switch.ts:logoutAccount;此处注入本机 SSO 缓存目录的读写。
  //
  // ⚠️ 与 buildSwitchCliDeps 同一理由抽成函数:web 面板的 /api/local/logout 复用同一份注入。
  const buildLogoutDeps = (): Parameters<typeof logoutAccount>[0] => ({
      clearProactiveRenewal,
      setLastSwitchedAccountId: (id) => {
        lastSwitchedAccountId = id
      },
      setLastWrittenTokenSignature: (sig) => {
        lastWrittenTokenSignature = sig
      },
      listSsoCacheFiles: async () => {
        const os = await import('os')
        const path = await import('path')
        const { readdir } = await import('fs/promises')
        const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
        console.log('[Logout] Clearing SSO cache:', ssoCache)
        // 目录不存在按空目录处理(与原实现 .catch(() => []) 一致)
        const files = await readdir(ssoCache).catch(() => [])
        return files.map((f) => path.join(ssoCache, f))
      },
      deleteSsoCacheFile: async (filePath) => {
        const { unlink } = await import('fs/promises')
        await unlink(filePath)
      }
  })

  ipcMain.handle('logout-account', async () => {
    return logoutAccount(buildLogoutDeps())
  })

  // ============ 局域网 web 面板装配(W6) ============
  //
  // 决策卡 §1 不变量 1「web 面板不得包含任何业务逻辑」的落点:面板的每个端点
  // 复用**上面这些 handler 背后的同一份 accountService 实现**,只是换了传输通道。
  // 下面的 routeDeps 里没有一行业务逻辑,全是把已装配好的调用原样转交。
  //
  // 决策卡 §3 第二处豁免:桌面端 `account-get-*` / `account-set-overage` 把 accessToken
  // 当第一个入参(:6108 起)。面板端点**按 accountId 寻址**,token 由 routes.ts 从 store
  // 内部取出后组装进 identity —— 绝不让浏览器把 token 经局域网发过来。
  const panelRouteImpl = {
    loadAccountsBlob: () => svcLoadAccounts(accountDeps),
    importApiKeys: (input: ApiKeyImportInput) => svcImportApiKeys(buildApiKeyImportDeps(), input),
    checkAccountStatus: (account: unknown) =>
      checkAccountStatus(accountServiceDeps, account as never),
    refreshAccountToken: (account: unknown) =>
      refreshAccountToken(accountServiceDeps, account as never),
    switchAccountToIde: (credentials: unknown) =>
      switchAccountToIde(
        {
          refreshTokenByMethod,
          writeKiroAuthTokenFile,
          resolveProfileArnForWrite,
          setLastSwitchedAccountId: (id) => {
            lastSwitchedAccountId = id
          },
          setLastWrittenTokenSignature: (sig) => {
            lastWrittenTokenSignature = sig
          },
          isProactiveRenewalEnabled: () => proactiveRenewalEnabled,
          scheduleProactiveRenewal
        },
        credentials as SwitchAccountCredentials
      ),
    switchAccountToCli: (credentials: unknown) =>
      switchAccountToCli(buildSwitchCliDeps(), credentials as SwitchAccountCliCredentials),
    logoutFromIde: () => logoutAccount(buildLogoutDeps()),
    getAccountModels: (identity: import('./webPanel/routes').PanelAccountIdentity) =>
      getAccountModels({ fetchKiroModels }, identity),
    getAccountSubscriptions: (identity: import('./webPanel/routes').PanelAccountIdentity) =>
      getAccountSubscriptions({ fetchAvailableSubscriptions }, identity),
    getAccountSubscriptionUrl: (
      identity: import('./webPanel/routes').PanelAccountIdentity,
      subscriptionType?: string
    ) => getAccountSubscriptionUrl({ fetchSubscriptionToken }, identity, subscriptionType),
    setAccountOverage: (
      identity: import('./webPanel/routes').PanelAccountIdentity,
      enabled: boolean
    ) => setAccountOverage({ setUserPreference }, identity, enabled ? 'ENABLED' : 'DISABLED'),
    // 反代编排(W8):用户日常的第三、四步 —— 在手机上选号 + 启停反代。
    // 顺序与判据都在 proxy/activation.ts 与 ipc/panelProxyDeps.ts,面板不重算。
    ...buildPanelProxyDeps({
      getProxyServer: () => proxyServer,
      initProxyServer: () => initProxyServer(),
      loadAccountData: () => store?.get('accountData') as never,
      getLatestProxyConfig: () => {
        const saved = store?.get('proxyConfig') as
          | (Partial<ProxyConfig> & { trustedTlsProxyIPs?: unknown })
          | undefined
        return withoutTrustedTlsProxyIPs({
          enabled: false,
          port: 5580,
          host: '127.0.0.1',
          enableMultiAccount: true,
          selectedAccountIds: [],
          logRequests: true,
          maxConcurrent: 10,
          maxRetries: 3,
          retryDelayMs: 1000,
          tokenRefreshBeforeExpiry: 300,
          clientDrivenToolExecution: true,
          enableTokenBufferReserve: true,
          tokenBufferReserve: 20000,
          ...saved
        })
      },
      persistProxyConfig: (config) => {
        if (!store) {
          throw new Error('[webPanel] store not initialized; cannot persist proxy config')
        }
        store.set('proxyConfig', withoutTrustedTlsProxyIPs(config))
      },
      updateTrayMenu: () => updateTrayMenu(),
      archiveSessionIfAny: () => archiveProxySessionIfAny()
    })
  }

  webPanelWiring = new WebPanelWiring({
    getStore: () => store ?? null,
    ensureStore: () => initStore(),
    routeDeps: {
      ...buildPanelRouteDeps(panelRouteImpl),
      // buildPanelRouteDeps 的旧适配层只消费六个运行端点；配置端点保留强类型后直连。
      proxyGetConfig: panelRouteImpl.proxyGetConfig,
      proxyUpdateConfig: panelRouteImpl.proxyUpdateConfig,
      proxyChangePort: panelRouteImpl.proxyChangePort,
      proxyListApiKeys: panelRouteImpl.proxyListApiKeys,
      proxyCreateApiKey: panelRouteImpl.proxyCreateApiKey,
      proxyVerifyApiKey: panelRouteImpl.proxyVerifyApiKey,
      proxyRevokeApiKey: panelRouteImpl.proxyRevokeApiKey
    }
  })
  webPanelWiring.registerIpcHandlers()

  // ============ 手动登录相关 IPC ============

  // 存储当前登录状态
  let currentLoginState: {
    type: 'builderid' | 'social' | 'iamsso'
    // BuilderId / IAM SSO 相关
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    startUrl?: string // IAM SSO 专用
    redirectUri?: string // IAM SSO Authorization Code flow
    region?: string // IAM SSO region
    // Social Auth 相关
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: 启动 Builder ID 手动登录
  ipcMain.handle('start-builder-id-login', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Starting Builder ID login...')
    
    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: 注册 OIDC 客户端
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        return { success: false, error: `注册客户端失败: ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 发起设备授权
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `设备授权失败: ${errText}` }
      }

      const authData = await authRes.json()
      const { deviceCode, userCode, verificationUri, verificationUriComplete, interval = 5, expiresIn = 600 } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // 保存登录状态
      currentLoginState = {
        type: 'builderid',
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1000
      }

      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 Builder ID 授权状态
  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: '没有进行中的登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const { clientId, clientSecret, deviceCode } = currentLoginState

    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json()
        console.log('[Login] Authorization successful!')
        
        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
        
        currentLoginState = null
        return result
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json()
        const error = errData.error

        if (error === 'authorization_pending') {
          return { success: true, completed: false, status: 'pending' }
        } else if (error === 'slow_down') {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5
          }
          return { success: true, completed: false, status: 'slow_down' }
        } else if (error === 'expired_token') {
          currentLoginState = null
          return { success: false, error: '设备码已过期' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: '用户拒绝授权' }
        } else {
          currentLoginState = null
          return { success: false, error: `授权错误: ${error}` }
        }
      } else {
        return { success: false, error: `未知响应: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : '轮询失败' }
    }
  })

  // IPC: 取消 Builder ID 登录
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IAM SSO 本地服务器和状态
  let iamSsoServer: ReturnType<typeof import('http').createServer> | null = null
  let iamSsoResult: {
    completed: boolean
    success: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  } | null = null

  // IPC: 启动 IAM Identity Center SSO 登录 (使用 Authorization Code Grant with PKCE)
  ipcMain.handle('start-iam-sso-login', async (_event, startUrl: string, region: string = 'us-east-1') => {
    console.log('[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...')
    console.log('[Login] Start URL:', startUrl)
    
    // 验证 startUrl 格式
    if (!startUrl || !startUrl.startsWith('https://')) {
      return { success: false, error: 'SSO Start URL 必须以 https:// 开头' }
    }
    
    const crypto = await import('crypto')
    const http = await import('http')
    
    // RegisterClient 跨 region 自动重试:AWS SSO OIDC 拒 "Invalid start url" 通常
    // 意味着 start URL 对应的 IdC 实例不在传入 region,自动切 KNOWN_SSO_OIDC_REGIONS 里
    // 其他 region 再试;成功时 oidcBase / region 都同步更新,后续 authorize URL +
    // token exchange 也用该 region。
    // RCA: .agent-workspace/.archive/2026-07-16/oidc-refresh-cross-region/
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    const isStartUrlMismatchError = (status: number, errText: string): boolean => {
      if (status !== 400 && status !== 401) return false
      const lower = errText.toLowerCase()
      return (
        lower.includes('invalid_request') ||
        lower.includes('invalid start url') ||
        lower.includes('invalid_client') ||
        lower.includes('invalid_grant')
      )
    }

    const tryRegisterAtRegion = async (r: string): Promise<{ ok: true; oidcBase: string; region: string; regRes: Response } | { ok: false; status: number; errText: string; region: string }> => {
      const oidcBase = `https://oidc.${r}.amazonaws.com`
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['authorization_code', 'refresh_token'],
          redirectUris: ['http://127.0.0.1/oauth/callback'],
          issuerUrl: startUrl
        })
      })
      if (regRes.ok) return { ok: true, oidcBase, region: r, regRes }
      const errText = await regRes.text().catch(() => '')
      return { ok: false, status: regRes.status, errText, region: r }
    }

    try {
      // Step 1: 注册 OIDC 客户端 (使用 authorization_code grant type)
      console.log('[Login] Step 1: Registering OIDC client, primary region:', region)
      // SSO OIDC RegisterClient 也需跨 region 探测:startUrl 对应的 IdC 实例可能在任何 AWS region
      // (包括 us-east-2),早期用 KNOWN_CW_DATA_REGIONS 只能探 us-east-1 / eu-central-1 两个,会遗漏
      const probeRegions: string[] = [region, ...KNOWN_SSO_OIDC_REGIONS.filter((r) => r !== region)]
      let successCtx: { oidcBase: string; region: string; regRes: Response } | null = null
      let lastFailure: { status: number; errText: string; region: string } | null = null
      for (let i = 0; i < probeRegions.length; i++) {
        const r = probeRegions[i]
        const attempt = await tryRegisterAtRegion(r)
        if (attempt.ok) {
          if (i > 0) {
            console.warn(`[Login] IAM SSO RegisterClient succeeded @${r} after primary(${region}) rejected;region 已切换到 ${r}`)
          }
          successCtx = attempt
          break
        }
        lastFailure = attempt
        console.error(`[Login] IAM SSO RegisterClient @${r} failed: ${attempt.status} ${attempt.errText.slice(0, 200)}`)
        if (attempt.errText.includes('UnauthorizedException') || attempt.errText.includes('access denied')) {
          // 授权类错误跟 region 无关,立即停 fallback
          break
        }
        if (!isStartUrlMismatchError(attempt.status, attempt.errText)) {
          break
        }
      }

      if (!successCtx) {
        const errText = lastFailure?.errText || 'unknown'
        if (errText.includes('UnauthorizedException') || errText.includes('access denied')) {
          return {
            success: false,
            error: '授权失败:您的组织可能未配置 Amazon Q Developer 访问权限。请联系组织管理员在 IAM Identity Center 中启用相关权限。'
          }
        }
        return { success: false, error: `注册客户端失败: ${errText}` }
      }

      const oidcBase = successCtx.oidcBase
      region = successCtx.region  // 后续 poll / token 交换都用这个 region
      const regRes = successCtx.regRes

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 生成 PKCE 和 state
      const codeVerifier = crypto.randomBytes(32).toString('base64url')
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const state = crypto.randomUUID()

      // Step 3: 启动本地 HTTP 服务器接收回调
      console.log('[Login] Step 2: Starting local OAuth callback server...')
      
      // 关闭之前的服务器
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }

      // 找一个可用端口
      const port = await new Promise<number>((resolve, reject) => {
        const server = http.createServer()
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            const p = addr.port
            server.close(() => resolve(p))
          } else {
            reject(new Error('无法获取端口'))
          }
        })
      })

      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
      console.log('[Login] Redirect URI:', redirectUri)

      // 重置结果
      iamSsoResult = null

      // 创建回调服务器
      iamSsoServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://127.0.0.1:${port}`)
        
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code')
          const returnedState = url.searchParams.get('state')
          const error = url.searchParams.get('error')
          
          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权失败</h1><p>您可以关闭此窗口。</p></body></html>')
            iamSsoResult = { completed: true, success: false, error: `授权失败: ${error}` }
            return
          }
          
          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权失败</h1><p>状态不匹配，请重试。</p></body></html>')
            iamSsoResult = { completed: true, success: false, error: '状态不匹配' }
            return
          }
          
          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权成功！</h1><p>正在获取令牌，请稍候...</p></body></html>')
            
            // 自动完成 token 交换
            try {
              const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  clientId,
                  clientSecret,
                  grantType: 'authorization_code',
                  redirectUri,
                  code,
                  codeVerifier
                })
              })

              if (!tokenRes.ok) {
                const errText = await tokenRes.text()
                console.error('[Login] Token exchange failed:', tokenRes.status, errText)
                iamSsoResult = { completed: true, success: false, error: `获取 Token 失败: ${errText}` }
              } else {
                const tokenData = await tokenRes.json()
                console.log('[Login] IAM SSO Authorization successful!')
                iamSsoResult = {
                  completed: true,
                  success: true,
                  accessToken: tokenData.accessToken,
                  refreshToken: tokenData.refreshToken,
                  clientId,
                  clientSecret,
                  region,
                  expiresIn: tokenData.expiresIn
                }
              }
            } catch (tokenError) {
              console.error('[Login] Token exchange error:', tokenError)
              iamSsoResult = { 
                completed: true, 
                success: false, 
                error: tokenError instanceof Error ? tokenError.message : '获取 Token 失败' 
              }
            }
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权失败</h1><p>未收到授权码。</p></body></html>')
            iamSsoResult = { completed: true, success: false, error: '未收到授权码' }
          }
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      iamSsoServer.listen(port, '127.0.0.1', () => {
        console.log('[Login] OAuth callback server listening on port', port)
      })

      // Step 4: 构建授权 URL 并打开浏览器
      const authorizeParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: scopes.join(','),
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      })
      const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`
      console.log('[Login] Opening browser for authorization...')

      // 保存登录状态
      currentLoginState = {
        type: 'iamsso',
        clientId,
        clientSecret,
        codeVerifier,
        redirectUri,
        region,
        startUrl,
        expiresAt: Date.now() + 600000
      }

      // 返回授权 URL，前端会打开浏览器
      return {
        success: true,
        authorizeUrl,
        expiresIn: 600
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 IAM SSO 授权状态 (检查本地服务器是否收到回调)
  ipcMain.handle('poll-iam-sso-auth', async () => {
    if (!currentLoginState || currentLoginState.type !== 'iamsso') {
      return { success: false, error: '没有进行中的 IAM SSO 登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }
      iamSsoResult = null
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    // 检查是否已收到回调并完成 token 交换
    if (iamSsoResult) {
      const result = { ...iamSsoResult }
      if (result.completed) {
        // 清理状态
        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }
        iamSsoResult = null
        currentLoginState = null
      }
      return result
    }

    // 还在等待回调
    return { success: true, completed: false, status: 'pending' }
  })

  // IPC: 取消 IAM SSO 登录
  ipcMain.handle('cancel-iam-sso-login', async () => {
    console.log('[Login] Cancelling IAM SSO login...')
    if (iamSsoServer) {
      iamSsoServer.close()
      iamSsoServer = null
    }
    iamSsoResult = null
    currentLoginState = null
    return { success: true }
  })

  // ============ external_idp (Microsoft Entra) 浏览器登录 ============
  // 协议来自真机抓包（.agent-workspace/.archive/2026-07-07/external-idp-login/）：
  // email 域名 → GetLoginMetadata(拿 clientId/issuerUrl/scopes) → OIDC discovery →
  // 浏览器 authorize(直连微软, redirect_uri=kiro://kiro.oauth/callback deep-link) →
  // 用户粘回 kiro://...?code=... → PKCE 换 token → ListAvailableProfiles 拿 profileArn。
  // deep-link 被真 Kiro IDE 抢注，故用"半自动粘贴回调链接"绕开，不抢协议。
  let externalIdpLoginState: {
    codeVerifier: string
    state: string
    clientId: string
    tokenEndpoint: string
    issuerUrl: string
    scopes: string[]
    email: string
    expiresAt: number
  } | null = null

  const EXTERNAL_IDP_REDIRECT_URI = 'kiro://kiro.oauth/callback'

  // 按 email 域名向 Kiro 后端查该组织的 Azure App 配置（smithy rpc-v2-cbor）
  async function getLoginMetadata(
    domainName: string
  ): Promise<{ clientId: string; issuerUrl: string; scopes: string[] }> {
    const { decode } = await import('cbor-x')
    // 请求体手写 canonical CBOR（结构固定 {domainName: str}）：与抓包字节 (a1...) 逐字节一致。
    // cbor-x encode 默认写成 b90001(uint16 长度头)，虽合法但非 canonical，避免后端严格解析拒收。
    const cborText = (s: string): Uint8Array => {
      const bytes = Buffer.from(s, 'utf8')
      const len = bytes.length
      let header: number[]
      if (len < 24) header = [0x60 | len]
      else if (len < 256) header = [0x78, len]
      else header = [0x79, (len >> 8) & 0xff, len & 0xff]
      return new Uint8Array([...header, ...bytes])
    }
    const reqBody = new Uint8Array([
      0xa1, // map, 1 对
      ...cborText('domainName'),
      ...cborText(domainName)
    ])
    const res = await fetchWithAppProxy(
      'https://app.kiro.dev/service/KiroWebPortalService/operation/GetLoginMetadata',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/cbor',
          Accept: 'application/cbor',
          'smithy-protocol': 'rpc-v2-cbor'
        },
        body: reqBody
      }
    )
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`GetLoginMetadata 失败: HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const data = decode(buf) as {
      clientId?: string
      found?: boolean
      issuerUrl?: string
      scopes?: string[]
    }
    if (!data || data.found === false || !data.clientId || !data.issuerUrl) {
      throw new Error(`该邮箱域名 (${domainName}) 未配置 Kiro 外部 IdP 登录，或不是组织账号`)
    }
    // 安全校验：issuerUrl 必须是微软登录端点
    let issuerHost = ''
    try {
      issuerHost = new URL(data.issuerUrl).hostname.toLowerCase()
    } catch {
      throw new Error('GetLoginMetadata 返回的 issuerUrl 非法')
    }
    if (!MICROSOFT_TOKEN_ENDPOINT_HOSTS.has(issuerHost)) {
      throw new Error(`暂仅支持 Microsoft Entra 外部 IdP（issuer=${issuerHost}）`)
    }
    return {
      clientId: data.clientId,
      issuerUrl: data.issuerUrl,
      scopes: Array.isArray(data.scopes) ? data.scopes : []
    }
  }

  // IPC: 启动 external_idp 登录 —— 返回浏览器授权 URL
  ipcMain.handle('start-external-idp-login', async (_event, email: string) => {
    console.log('[ExternalIdpLogin] Starting login for:', email)
    const trimmed = (email || '').trim()
    const domainName = trimmed.split('@')[1]
    if (!trimmed || !domainName) {
      return { success: false, error: '请输入完整的组织邮箱（如 user@company.com）' }
    }

    try {
      const crypto = await import('crypto')

      // Step 1: email 域名 → clientId / issuerUrl / scopes
      const meta = await getLoginMetadata(domainName)

      // Step 2: OIDC discovery 拿 authorization_endpoint / token_endpoint
      const discoveryUrl = `${meta.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`
      const discRes = await fetchWithAppProxy(discoveryUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
      if (!discRes.ok) {
        return { success: false, error: `OIDC discovery 失败: HTTP ${discRes.status}` }
      }
      const disc = (await discRes.json()) as {
        authorization_endpoint?: string
        token_endpoint?: string
      }
      if (!disc.authorization_endpoint || !disc.token_endpoint) {
        return { success: false, error: 'OIDC discovery 缺少 authorization/token endpoint' }
      }

      // Step 3: PKCE + state（照抄 IAM SSO 做法）
      const codeVerifier = crypto.randomBytes(32).toString('base64url')
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const state = crypto.randomUUID()

      // Step 4: 拼 authorize URL
      const authorizeUrl = new URL(disc.authorization_endpoint)
      authorizeUrl.searchParams.set('redirect_uri', EXTERNAL_IDP_REDIRECT_URI)
      authorizeUrl.searchParams.set('scope', meta.scopes.join(' '))
      authorizeUrl.searchParams.set('code_challenge', codeChallenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      authorizeUrl.searchParams.set('response_mode', 'query')
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('login_hint', trimmed)
      authorizeUrl.searchParams.set('client_id', meta.clientId)
      authorizeUrl.searchParams.set('response_type', 'code')

      externalIdpLoginState = {
        codeVerifier,
        state,
        clientId: meta.clientId,
        tokenEndpoint: disc.token_endpoint,
        issuerUrl: meta.issuerUrl,
        scopes: meta.scopes,
        email: trimmed,
        expiresAt: Date.now() + 600000
      }

      return { success: true, authorizeUrl: authorizeUrl.toString() }
    } catch (error) {
      console.error('[ExternalIdpLogin] start error:', error)
      return { success: false, error: error instanceof Error ? error.message : '启动登录失败' }
    }
  })

  // IPC: 完成 external_idp 登录 —— 用户粘贴 kiro://...?code=... 回调链接
  ipcMain.handle('complete-external-idp-login', async (_event, callbackUrl: string) => {
    if (!externalIdpLoginState) {
      return { success: false, error: '没有进行中的登录，请重新开始' }
    }
    if (Date.now() > externalIdpLoginState.expiresAt) {
      externalIdpLoginState = null
      return { success: false, error: '登录已超时，请重新开始' }
    }

    const saved = externalIdpLoginState

    // 解析 code + state。kiro:// 是非标准 scheme，new URL 可解析但 host/path 归属不定，
    // 统一取 search 部分兜底。
    let code: string | null = null
    let returnedState: string | null = null
    try {
      const raw = (callbackUrl || '').trim()
      const qIndex = raw.indexOf('?')
      const search = qIndex >= 0 ? raw.slice(qIndex + 1) : raw
      const params = new URLSearchParams(search)
      code = params.get('code')
      returnedState = params.get('state')
      const errParam = params.get('error')
      if (errParam) {
        return {
          success: false,
          error: `授权失败: ${errParam} ${params.get('error_description') || ''}`.trim()
        }
      }
    } catch {
      return { success: false, error: '回调链接解析失败，请粘贴完整的 kiro:// 链接' }
    }

    if (!code) {
      return { success: false, error: '回调链接里没有 code，请确认粘贴的是登录成功后的完整链接' }
    }
    if (returnedState && returnedState !== saved.state) {
      return { success: false, error: 'state 不匹配，可能是旧链接或跨会话，请重新登录' }
    }

    try {
      // 用 code + code_verifier 换 token（PKCE，无 client_secret）
      const body = new URLSearchParams({
        redirect_uri: EXTERNAL_IDP_REDIRECT_URI,
        code,
        code_verifier: saved.codeVerifier,
        grant_type: 'authorization_code',
        client_id: saved.clientId
      })
      const tokenRes = await fetchWithAppProxy(saved.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: body.toString()
      })
      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        externalIdpLoginState = null
        // invalid_grant 常见于 code 过期/已用
        const hint = errText.includes('invalid_grant')
          ? '（code 可能已过期或已被使用，请重新登录）'
          : ''
        return { success: false, error: `换取 Token 失败: HTTP ${tokenRes.status} ${hint}` }
      }
      const tok = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }
      if (!tok.access_token) {
        externalIdpLoginState = null
        return { success: false, error: '换取 Token 响应缺少 access_token' }
      }

      // 用微软 access_token 调 ListAvailableProfiles 拿所有可用 profiles(v2:多 profile 支持)
      // 空数组 / 4xx / 5xx 都 catch:登录 token 换取已成功,只是 profiles 拿不到,不阻塞整体登录流程
      // (与老 fetchEnterpriseProfileArn 兜底 undefined 行为一致 · renderer 侧看到 profiles=[] 会给用户提示)
      let profiles: KiroProfile[] = []
      try {
        profiles = await fetchEnterpriseProfiles({
          id: '',
          accessToken: tok.access_token,
          region: 'us-east-1',
          provider: 'ExternalIdp',
          authMethod: 'external_idp'
        })
      } catch (e) {
        console.warn('[ExternalIdpLogin] fetchEnterpriseProfiles failed:', e)
      }

      const result = buildCompleteLoginResult(
        {
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresIn: tok.expires_in
        },
        profiles,
        saved
      )
      externalIdpLoginState = null
      return result
    } catch (error) {
      console.error('[ExternalIdpLogin] complete error:', error)
      return { success: false, error: error instanceof Error ? error.message : '完成登录失败' }
    }
  })

  // IPC: 取消 external_idp 登录
  ipcMain.handle('cancel-external-idp-login', async () => {
    console.log('[ExternalIdpLogin] Cancelling login...')
    externalIdpLoginState = null
    return { success: true }
  })

  // IPC: 启动 Social Auth 登录 (Google/GitHub)
  ipcMain.handle('start-social-login', async (_event, provider: 'Google' | 'Github', usePrivateMode?: boolean) => {
    console.log(`[Login] Starting ${provider} Social Auth login... (privateMode: ${usePrivateMode})`)
    
    const crypto = await import('crypto')

    // 生成 PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const oauthState = crypto.randomBytes(32).toString('base64url')

    // 构建登录 URL
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
    loginUrl.searchParams.set('idp', provider)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('code_challenge', codeChallenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')
    loginUrl.searchParams.set('state', oauthState)

    // 保存登录状态
    currentLoginState = {
      type: 'social',
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    }

    const urlStr = loginUrl.toString()
    console.log(`[Login] Opening browser for ${provider} login...`)

    // 根据是否使用隐私模式选择打开方式
    if (usePrivateMode) {
      openBrowserInPrivateMode(urlStr)
    } else {
      shell.openExternal(urlStr)
    }

    return {
      success: true,
      loginUrl: urlStr,
      state: oauthState
    }
  })

  // IPC: 交换 Social Auth token
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: '没有进行中的社交登录' }
    }

    // 验证 state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: '状态参数不匹配，可能存在安全风险' }
    }

    const { codeVerifier, provider } = currentLoginState
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'

    try {
      const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        currentLoginState = null
        return { success: false, error: `Token 交换失败: ${errText}` }
      }

      const tokenData = await tokenRes.json()
      console.log('[Login] Token exchange successful!')

      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        authMethod: 'social' as const,
        provider
      }

      currentLoginState = null
      return result
    } catch (error) {
      console.error('[Login] Token exchange error:', error)
      currentLoginState = null
      return { success: false, error: error instanceof Error ? error.message : 'Token 交换失败' }
    }
  })

  // IPC: 取消 Social Auth 登录
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: 设置代理
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    const normalizedUrl = enabled && url ? normalizeProxyUrl(url) : url
    console.log(`[IPC] set-proxy called: enabled=${enabled}, url=${normalizedUrl}${normalizedUrl !== url ? ` (原始: ${url})` : ''}`)
    try {
      applyProxySettings(enabled, url)
      
      // 同时设置 Electron 的 session 代理
      if (mainWindow) {
        const session = mainWindow.webContents.session
        if (enabled && normalizedUrl) {
          await session.setProxy({ proxyRules: normalizedUrl })
        } else {
          await session.setProxy({ proxyRules: '' })
        }
      }
      
      return { success: true, normalizedUrl }
    } catch (error) {
      console.error('[Proxy] Failed to set proxy:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============ Kiro 设置管理 IPC ============

  // IPC: 获取 Kiro 设置
  ipcMain.handle('get-kiro-settings', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      
      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      const kiroSteeringPath = path.join(homeDir, '.kiro', 'steering')
      const kiroMcpUserPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      let settings = {}
      let mcpConfig = { mcpServers: {} }
      let steeringFiles: string[] = []
      
      // 读取 Kiro settings.json (VS Code 风格 JSON，可能有尾随逗号)
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // 移除尾随逗号和注释以兼容标准 JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // 移除单行注释
          .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
          .replace(/,(\s*[}\]])/g, '$1') // 移除尾随逗号
        const parsed = JSON.parse(cleanedContent)
        settings = {
          modelSelection: parsed['kiroAgent.modelSelection'],
          agentAutonomy: parsed['kiroAgent.agentAutonomy'],
          enableDebugLogs: parsed['kiroAgent.enableDebugLogs'],
          enableTabAutocomplete: parsed['kiroAgent.enableTabAutocomplete'],
          enableCodebaseIndexing: parsed['kiroAgent.enableCodebaseIndexing'],
          usageSummary: parsed['kiroAgent.usageSummary'],
          codeReferences: parsed['kiroAgent.codeReferences.referenceTracker'],
          configureMCP: parsed['kiroAgent.configureMCP'],
          trustedCommands: parsed['kiroAgent.trustedCommands'] || [],
          trustedTools: parsed['kiroAgent.trustedTools'] || {},
          commandDenylist: parsed['kiroAgent.commandDenylist'] || [],
          ignoreFiles: parsed['kiroAgent.ignoreFiles'] || [],
          mcpApprovedEnvVars: parsed['kiroAgent.mcpApprovedEnvVars'] || [],
          notificationsActionRequired: parsed['kiroAgent.notifications.agent.actionRequired'],
          notificationsFailure: parsed['kiroAgent.notifications.agent.failure'],
          notificationsSuccess: parsed['kiroAgent.notifications.agent.success'],
          notificationsBilling: parsed['kiroAgent.notifications.billing']
        }
      }
      
      // 读取 MCP 配置
      if (fs.existsSync(kiroMcpUserPath)) {
        const mcpContent = fs.readFileSync(kiroMcpUserPath, 'utf-8')
        mcpConfig = JSON.parse(mcpContent)
      }
      
      // 读取 Steering 文件列表
      if (fs.existsSync(kiroSteeringPath)) {
        const files = fs.readdirSync(kiroSteeringPath)
        steeringFiles = files.filter(f => f.endsWith('.md'))
        console.log('[KiroSettings] Steering path:', kiroSteeringPath)
        console.log('[KiroSettings] Found steering files:', steeringFiles)
      } else {
        console.log('[KiroSettings] Steering path does not exist:', kiroSteeringPath)
      }
      
      return { settings, mcpConfig, steeringFiles }
    } catch (error) {
      console.error('[KiroSettings] Failed to get settings:', error)
      return { error: error instanceof Error ? error.message : 'Failed to get settings' }
    }
  })

  // IPC: 获取 Kiro 可用模型列表（使用当前账号调用官方 API）
  ipcMain.handle('get-kiro-available-models', async () => {
    try {
      if (!store) return { models: [] }
      const accountData = store.get('accountData') as { accounts?: Record<string, any> } | undefined
      if (!accountData?.accounts) return { models: [] }

      // 优先使用当前激活账号（isActive），其次使用第一个 active 且有 accessToken 的账号
      const allAccounts = Object.values(accountData.accounts) as any[]
      const account = allAccounts.find((acc: any) => acc.isActive && acc.credentials?.accessToken)
        || allAccounts.find((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
      if (!account) return { models: [] }

      const proxyAccount = {
        id: account.id,
        email: account.email,
        accessToken: account.credentials.accessToken,
        refreshToken: account.credentials?.refreshToken,
        profileArn: account.profileArn,
        expiresAt: account.credentials?.expiresAt,
        clientId: account.credentials?.clientId,
        clientSecret: account.credentials?.clientSecret,
        region: account.credentials?.region || 'us-east-1',
        authMethod: account.credentials?.authMethod
      }

      const models = await fetchKiroModels(proxyAccount)
      return {
        models: models.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description
        }))
      }
    } catch (error) {
      console.error('[KiroSettings] Failed to fetch models:', error)
      return { models: [], error: error instanceof Error ? error.message : 'Failed to fetch models' }
    }
  })

  // IPC: 保存 Kiro 设置
  ipcMain.handle('save-kiro-settings', async (_event, settings: Record<string, unknown>) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      
      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      let existingSettings = {}
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // 移除尾随逗号和注释以兼容标准 JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // 移除单行注释
          .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
          .replace(/,(\s*[}\]])/g, '$1') // 移除尾随逗号
        existingSettings = JSON.parse(cleanedContent)
      }
      
      // 映射设置到 Kiro 的格式
      const kiroSettings = {
        ...existingSettings,
        'kiroAgent.modelSelection': settings.modelSelection,
        'kiroAgent.agentAutonomy': settings.agentAutonomy,
        'kiroAgent.enableDebugLogs': settings.enableDebugLogs,
        'kiroAgent.enableTabAutocomplete': settings.enableTabAutocomplete,
        'kiroAgent.enableCodebaseIndexing': settings.enableCodebaseIndexing,
        'kiroAgent.usageSummary': settings.usageSummary,
        'kiroAgent.codeReferences.referenceTracker': settings.codeReferences,
        'kiroAgent.configureMCP': settings.configureMCP,
        'kiroAgent.trustedCommands': settings.trustedCommands,
        'kiroAgent.trustedTools': settings.trustedTools,
        'kiroAgent.commandDenylist': settings.commandDenylist,
        'kiroAgent.ignoreFiles': settings.ignoreFiles,
        'kiroAgent.mcpApprovedEnvVars': settings.mcpApprovedEnvVars,
        'kiroAgent.notifications.agent.actionRequired': settings.notificationsActionRequired,
        'kiroAgent.notifications.agent.failure': settings.notificationsFailure,
        'kiroAgent.notifications.agent.success': settings.notificationsSuccess,
        'kiroAgent.notifications.billing': settings.notificationsBilling
      }
      
      // 确保目录存在
      const dir = path.dirname(kiroSettingsPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(kiroSettingsPath, JSON.stringify(kiroSettings, null, 4))
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save settings' }
    }
  })

  // IPC: 打开 Kiro MCP 配置文件
  ipcMain.handle('open-kiro-mcp-config', async (_event, type: 'user' | 'workspace') => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      
      let configPath: string
      if (type === 'user') {
        configPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      } else {
        // 工作区配置，打开当前工作区的 .kiro/settings/mcp.json
        configPath = path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      }
      
      // 如果文件不存在，创建空配置
      const fs = await import('fs')
      if (!fs.existsSync(configPath)) {
        const dir = path.dirname(configPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
      }
      
      shell.openPath(configPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open MCP config:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open MCP config' }
    }
  })

  // IPC: 打开 Kiro Steering 目录
  ipcMain.handle('open-kiro-steering-folder', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      
      // 如果目录不存在，创建它
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      shell.openPath(steeringPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering folder:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering folder' }
    }
  })

  // IPC: 打开 Kiro settings.json 文件
  ipcMain.handle('open-kiro-settings-file', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const settingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      // 如果文件不存在，创建默认配置
      if (!fs.existsSync(settingsPath)) {
        const dir = path.dirname(settingsPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        const defaultSettings = {
          'workbench.colorTheme': 'Kiro Light',
          'kiroAgent.modelSelection': 'claude-haiku-4.5'
        }
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4))
      }
      
      shell.openPath(settingsPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open settings file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open settings file' }
    }
  })

  // IPC: 打开指定的 Steering 文件
  ipcMain.handle('open-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      shell.openPath(filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering file' }
    }
  })

  // IPC: 创建默认的 rules.md 文件
  ipcMain.handle('create-kiro-default-rules', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const rulesPath = path.join(steeringPath, 'rules.md')
      
      // 确保目录存在
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      // 默认规则内容
      const defaultContent = `# Role: 高级软件开发助手
一、系统为Windows10
二、调式文件、测试脚本、test相关文件都放在test文件夹里面，md文件放在docs文件夹里面
# 核心原则


## 1. 沟通与协作
- **诚实优先**：在任何情况下都严禁猜测或伪装。当需求不明确、存在技术风险或遇到知识盲区时，必须停止工作，并立即向用户澄清。
- **技术攻坚**：面对技术难题时，首要目标是寻找并提出高质量的解决方案。只有在所有可行方案均被评估后，才能与用户探讨降级或替换方案。
- **批判性思维**：在执行任务时，如果发现当前需求存在技术限制、潜在风险或有更优的实现路径，必须主动向用户提出你的见解和改进建议。
- **语言要求**：思考和回答时总是使用中文进行回复。


## 2. 架构设计
- **模块化设计**：所有设计都必须遵循功能解耦、职责单一的原则。严格遵守SOLID和DRY原则。
- **前瞻性思维**：在设计时必须考虑未来的可扩展性和可维护性，确保解决方案能够融入项目的整体架构。
- **技术债务优先**：在进行重构或优化时，优先处理对系统稳定性和可维护性影响最大的技术债务和基础架构问题。


## 3. 代码与交付物质量标准
### 编写规范
- **架构视角**：始终从整体项目架构出发编写代码，确保代码片段能够无缝集成，而不是孤立的功能。
- **零技术债务**：严禁创建任何形式的技术债务，包括但不限于：临时文件、硬编码值、职责不清的模块或函数。
- **问题暴露**：禁止添加任何用于掩盖或绕过错误的fallback机制。代码应设计为快速失败（Fail-Fast），确保问题在第一时间被发现。


### 质量要求
- **可读性**：使用清晰、有意义的变量名和函数名。代码逻辑必须清晰易懂，并辅以必要的注释。
- **规范遵循**：严格遵循目标编程语言的社区最佳实践和官方编码规范。
- **健壮性**：必须包含充分的错误处理逻辑和边界条件检查。
- **性能意识**：在保证代码质量和可读性的前提下，对性能敏感部分进行合理优化，避免不必要的计算复杂度和资源消耗。


### 交付物规范
- **无文档**：除非用户明确要求，否则不要创建任何Markdown文档或其他形式的说明文档。
- **无测试**：除非用户明确要求，否则不要编写单元测试或集成测试代码。
- **无编译/运行**：禁止编译或执行任何代码。你的任务是生成高质量的代码和设计方案。


# 注意事项
- 除非特别说明否则不要创建新的文档、不要测试、不要编译、不要运行、不需要总结，除非用户主动要求


- 需求不明确时使向用户询问澄清，提供预定义选项
- 在有多个方案的时候，需要向用户询问，而不是自作主张
- 在有方案/策略需要更新时，需要向用户询问，而不是自作主张


- ACE为augmentContextEngine工具的缩写
- 如果要求查看文档请使用 Context7 MCP
- 如果需要进行WEB前端页面测试请使用 Playwright MCP
- 如果用户回复'继续' 则请按照最佳实践继续完成任务
`
      
      fs.writeFileSync(rulesPath, defaultContent, 'utf-8')
      console.log('[KiroSettings] Created default rules.md at:', rulesPath)
      
      // 打开文件
      shell.openPath(rulesPath)
      
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to create default rules:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create default rules' }
    }
  })

  // IPC: 读取 Steering 文件内容
  ipcMain.handle('read-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }
      
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      console.error('[KiroSettings] Failed to read steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' }
    }
  })

  // IPC: 保存 Steering 文件内容
  ipcMain.handle('save-kiro-steering-file', async (_event, filename: string, content: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const filePath = path.join(steeringPath, filename)
      
      // 确保目录存在
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      fs.writeFileSync(filePath, content, 'utf-8')
      console.log('[KiroSettings] Saved steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save file' }
    }
  })

  // ============ Kiro API 反代服务器 IPC ============

  // IPC: 启动反代服务器
  ipcMain.handle('proxy-start', async (_event, config?: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      if (config) {
        server.updateConfig(config)
      }
      await server.start()
      // 更新托盘菜单状态
      updateTrayMenu()
      return { success: true, port: server.getConfig().port }
    } catch (error) {
      console.error('[ProxyServer] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start proxy server' }
    }
  })

  // IPC: 停止反代服务器
  ipcMain.handle('proxy-stop', async () => {
    try {
      if (proxyServer) {
        archiveProxySessionIfAny() // 停止前先快照归档本次会话
        await proxyServer.stop()
      }
      // 更新托盘菜单状态
      updateTrayMenu()
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop proxy server' }
    }
  })

  // IPC: 获取反代服务器状态
  ipcMain.handle('proxy-get-status', () => {
    if (!proxyServer) {
      // 未初始化时从 store 读取保存的配置
      const savedConfig = store?.get('proxyConfig') as ProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, sessionStats: null }
    }
    return {
      running: proxyServer.isRunning(),
      config: proxyServer.getConfig(),
      stats: proxyServer.getStats(),
      sessionStats: proxyServer.getSessionStats()
    }
  })

  // IPC: 重置累计 credits
  ipcMain.handle('proxy-reset-credits', () => {
    if (proxyServer) {
      proxyServer.resetTotalCredits()
    }
    if (store) {
      store.set('proxyTotalCredits', 0)
    }
    return { success: true }
  })

  // IPC: 重置累计 tokens
  ipcMain.handle('proxy-reset-tokens', () => {
    if (proxyServer) {
      proxyServer.resetTotalTokens()
    }
    if (store) {
      store.set('proxyInputTokens', 0)
      store.set('proxyOutputTokens', 0)
    }
    return { success: true }
  })

  // IPC: 重置请求统计
  ipcMain.handle('proxy-reset-request-stats', () => {
    if (proxyServer) {
      proxyServer.resetRequestStats()
    }
    if (store) {
      store.set('proxyTotalRequests', 0)
      store.set('proxySuccessRequests', 0)
      store.set('proxyFailedRequests', 0)
    }
    return { success: true }
  })

  // IPC: 获取会话历史（每次 启动→停止 自动归档的记录，最新在前）
  ipcMain.handle('proxy-get-session-history', () => {
    const history = (store?.get('proxySessionHistory') as import('./proxy/types').ProxySessionRecord[] | undefined) || []
    return [...history].reverse()
  })

  // IPC: 清空会话历史
  ipcMain.handle('proxy-clear-session-history', () => {
    if (store) store.set('proxySessionHistory', [])
    return { success: true }
  })

  // IPC: 获取反代日志
  ipcMain.handle('proxy-get-logs', (_event, count?: number) => {
    if (count) {
      return proxyLogStore.getLast(count)
    }
    return proxyLogStore.getAll()
  })

  // IPC: 清除反代日志
  ipcMain.handle('proxy-clear-logs', () => {
    proxyLogStore.clear()
    return { success: true }
  })

  // IPC: 获取反代日志数量
  ipcMain.handle('proxy-get-logs-count', () => {
    return proxyLogStore.count()
  })

  // IPC: 获取 Usage API 类型
  ipcMain.handle('get-usage-api-type', () => {
    return currentUsageApiType
  })

  // IPC: 设置 Usage API 类型
  ipcMain.handle('set-usage-api-type', (_event, type: 'rest' | 'cbor') => {
    setUsageApiType(type)
    // 保存到 store
    if (store) {
      store.set('usageApiType', type)
    }
    return { success: true, type }
  })

  // IPC: 获取是否使用 K-Proxy 代理
  ipcMain.handle('get-use-kproxy-for-api', () => {
    return getUseKProxyForApi()
  })

  // IPC: 设置是否使用 K-Proxy 代理
  ipcMain.handle('set-use-kproxy-for-api', (_event, enabled: boolean) => {
    setUseKProxyForApi(enabled)
    // 保存到 store
    if (store) {
      store.set('useKProxyForApi', enabled)
    }
    return { success: true, enabled }
  })

  // IPC: 更新反代服务器配置
  ipcMain.handle('proxy-update-config', async (_event, config: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      const requiresRestart = (['port', 'host', 'tls', 'fallbackPort'] as Array<keyof ProxyConfig>)
        .some((key) => key in config)
      const { config: newConfig } = await applyProxyConfigUpdate(
        {
          getLatestConfig: () => server.getConfig(),
          getProxyServer: () => server,
          persistProxyConfig: (next) => {
            if (!store) {
              throw new Error('[ProxyServer] store not initialized; cannot persist config')
            }
            store.set('proxyConfig', withoutTrustedTlsProxyIPs(next))
          }
        },
        config,
        requiresRestart ? 'restart' : 'hot'
      )
      // 同步流式日志开关
      if (config.logStreamEvents !== undefined) {
        setLogStreamEvents(config.logStreamEvents)
      }
      // 同步性能诊断落盘开关(按天 JSONL,不受内存日志滚动窗口影响)
      if (config.enablePerfDiagLog !== undefined) {
        perfDiag.configure(config.enablePerfDiagLog === true, app.getPath('userData'))
      }
      // 同步 payload 大小限制
      if (config.payloadSizeLimitKB !== undefined) {
        setPayloadSizeLimitKB(config.payloadSizeLimitKB)
      }
      // 同步 Token buffer reserve（开关 + 数值）
      if (config.enableTokenBufferReserve !== undefined) {
        setEnableTokenBufferReserve(config.enableTokenBufferReserve)
      }
      if (config.tokenBufferReserve !== undefined) {
        setTokenBufferReserve(config.tokenBufferReserve)
      }
      // 同步出站上下文安全网总开关(Layer B RTK + Layer C 静默看门狗)
      if (config.enableProxyContextSafetyNet !== undefined) {
        setEnableProxyContextSafetyNet(config.enableProxyContextSafetyNet)
      }
      // v1.7.6 同步 429 rate limit 重试策略(任何一个字段变化就更新)
      if (config.rateLimitRetryMaxAttempts !== undefined || config.rateLimitRetryBaseMs !== undefined || config.rateLimitRetryStrategy !== undefined) {
        setRateLimitRetryConfig({
          maxAttempts: config.rateLimitRetryMaxAttempts,
          baseMs: config.rateLimitRetryBaseMs,
          strategy: config.rateLimitRetryStrategy
        })
      }
      // 同步 Agent 模式
      if (config.agentMode) {
        setAgentMode(config.agentMode)
      }
      // 工作区路径变化时重新加载 steering
      if (config.workspacePath !== undefined) {
        server.loadSteering()
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[ProxyServer] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // ============ 反代安全 / 可观测 IPC（v1.8 新增） ============

  // 获取自签证书信息（PEM、指纹、有效期、SAN）
  ipcMain.handle('proxy-self-signed-cert-info', () => {
    try {
      if (!proxyServer) return { success: false, error: 'Proxy server not initialized' }
      const info = proxyServer.getSelfSignedCertInfo()
      if (!info) return { success: false, error: 'Failed to get self-signed cert info' }
      return { success: true, ...info }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // 重新生成自签证书（用户主动触发）
  ipcMain.handle('proxy-self-signed-cert-regenerate', () => {
    try {
      if (!proxyServer) return { success: false, error: 'Proxy server not initialized' }
      const info = proxyServer.regenerateSelfSignedCert()
      if (!info) return { success: false, error: 'Failed to regenerate self-signed cert' }
      return { success: true, ...info }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // 检查反代配置是否需要重启
  ipcMain.handle('proxy-needs-restart', () => {
    try {
      if (!proxyServer) return { needsRestart: false }
      return { needsRestart: proxyServer.needsRestart() }
    } catch {
      return { needsRestart: false }
    }
  })

  // 重启反代（用户在 UI 点"立即重启"时调用）
  ipcMain.handle('proxy-restart', async () => {
    try {
      if (!proxyServer) return { success: false, error: 'Proxy server not initialized' }
      await proxyServer.restartServer()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // 获取反代审计日志
  ipcMain.handle('proxy-audit-log', () => {
    try {
      if (!proxyServer) return { entries: [] }
      return { entries: proxyServer.getAuditLog().slice(-200) }
    } catch {
      return { entries: [] }
    }
  })

  // ============ API Key 管理 IPC ============

  // IPC: 获取所有 API Keys
  ipcMain.handle('proxy-get-api-keys', () => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      return { success: true, apiKeys: config.apiKeys || [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get API keys', apiKeys: [] }
    }
  })

  // IPC: 添加 API Key
  ipcMain.handle('proxy-add-api-key', async (_event, apiKey: { name: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }) => {
    try {
      const crypto = await import('crypto')
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      // 根据格式生成随机 Key
      const format = apiKey.format || 'sk'
      let newKey = apiKey.key
      if (!newKey) {
        const randomHex = crypto.randomBytes(24).toString('hex')
        switch (format) {
          case 'sk':
            newKey = `sk-${randomHex}`
            break
          case 'simple':
            newKey = `PROXY_KEY_${randomHex.toUpperCase().substring(0, 32)}`
            break
          case 'token':
            newKey = `KEY:${randomHex.substring(0, 16)}:TOKEN:${randomHex.substring(16, 32)}`
            break
          default:
            newKey = `sk-${randomHex}`
        }
      }
      
      const newApiKey: import('./proxy/types').ApiKey = {
        id: crypto.randomUUID(),
        name: apiKey.name || `API Key ${apiKeys.length + 1}`,
        key: newKey,
        format: format,
        enabled: true,
        createdAt: Date.now(),
        creditsLimit: apiKey.creditsLimit,
        usage: {
          totalRequests: 0,
          totalCredits: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          daily: {}
        }
      }
      
      apiKeys.push(newApiKey)
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', withoutTrustedTlsProxyIPs(server.getConfig()))
      }
      
      return { success: true, apiKey: newApiKey }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add API key' }
    }
  })

  // IPC: 更新 API Key
  ipcMain.handle('proxy-update-api-key', (_event, id: string, updates: Partial<import('./proxy/types').ApiKey>) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      // 更新字段（不允许更新 id、createdAt、usage）
      const { id: _, createdAt: __, usage: ___, ...allowedUpdates } = updates
      apiKeys[index] = { ...apiKeys[index], ...allowedUpdates }
      
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', withoutTrustedTlsProxyIPs(server.getConfig()))
      }
      
      return { success: true, apiKey: apiKeys[index] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update API key' }
    }
  })

  // IPC: 删除 API Key
  ipcMain.handle('proxy-delete-api-key', (_event, id: string) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      apiKeys.splice(index, 1)
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', withoutTrustedTlsProxyIPs(server.getConfig()))
      }
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete API key' }
    }
  })

  // IPC: 重置 API Key 用量统计
  ipcMain.handle('proxy-reset-api-key-usage', (_event, id: string) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const apiKey = apiKeys.find(k => k.id === id)
      if (!apiKey) {
        return { success: false, error: 'API key not found' }
      }
      
      apiKey.usage = {
        totalRequests: 0,
        totalCredits: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        daily: {}
      }
      
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', withoutTrustedTlsProxyIPs(server.getConfig()))
      }
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reset usage' }
    }
  })

  // IPC: 添加账号到反代池
  ipcMain.handle('proxy-add-account', (_event, account: ProxyAccount) => {
    try {
      const server = initProxyServer()
      server.getAccountPool().addAccount(account)
      return { success: true, accountCount: server.getAccountPool().size }
    } catch (error) {
      console.error('[ProxyServer] Add account failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add account' }
    }
  })

  // IPC: 从反代池移除账号
  ipcMain.handle('proxy-remove-account', (_event, accountId: string) => {
    try {
      const server = initProxyServer()
      server.getAccountPool().removeAccount(accountId)
      return { success: true, accountCount: server.getAccountPool().size }
    } catch (error) {
      console.error('[ProxyServer] Remove account failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to remove account' }
    }
  })

  // IPC: 同步账号到反代池（批量更新）
  ipcMain.handle('proxy-sync-accounts', (_event, accounts: ProxyAccount[]) => {
    try {
      const server = initProxyServer()
      const pool = server.getAccountPool()
      // replaceAll 而非 clear()+addAccount():renderer 传来的账号形状不带 quota /
      // suspendedAt / errorCount,清空后重加会把运行期状态整体抹掉 ——
      // 表现为「界面点一下同步,已耗尽的号又开始被选中」。
      pool.replaceAll(accounts)
      return { success: true, accountCount: pool.size }
    } catch (error) {
      console.error('[ProxyServer] Sync accounts failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to sync accounts' }
    }
  })

  // IPC: 获取反代池账号列表
  ipcMain.handle('proxy-get-accounts', () => {
    if (!proxyServer) {
      return { accounts: [], availableCount: 0 }
    }
    const pool = proxyServer.getAccountPool()
    return {
      accounts: pool.getAllAccounts(),
      availableCount: pool.availableCount
    }
  })

  // IPC: 刷新模型缓存
  ipcMain.handle('proxy-refresh-models', () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized' }
    }
    proxyServer.clearModelCache()
    return { success: true }
  })

  // IPC: 获取可用模型列表
  ipcMain.handle('proxy-get-models', async () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized', models: [] }
    }
    try {
      const result = await proxyServer.getAvailableModels()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get models', models: [] }
    }
  })

  ipcMain.handle('proxy-configure-clients', async (_event, input: { clients: ProxyClientTarget[]; modelId: string; modelName?: string; models?: ProxyClientModel[] }) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKey = (config.apiKey || config.apiKeys?.find(key => key.enabled)?.key || '').trim()
      if (!apiKey) {
        return {
          success: false,
          proxyOrigin: '',
          openaiBaseUrl: '',
          results: [],
          error: '请先在反代配置中设置或启用 API Key'
        }
      }
      return await configureProxyClients({
        clients: input.clients,
        host: config.host,
        port: config.port,
        tlsEnabled: config.tls?.enabled,
        apiKey,
        modelId: input.modelId,
        modelName: input.modelName,
        models: input.models
      })
    } catch (error) {
      return {
        success: false,
        proxyOrigin: '',
        openaiBaseUrl: '',
        results: [],
        error: error instanceof Error ? error.message : 'Failed to configure clients'
      }
    }
  })

  // IPC: 获取账户可用模型列表
  //   业务实现在 accountService/subscription.ts(IPC 与将来的 HTTP 层共用)。
  ipcMain.handle('account-get-models', async (_event, accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    return getAccountModels(
      { fetchKiroModels },
      { accessToken, region, profileArn, machineId, provider, authMethod, accountId }
    )
  })

  // IPC: 获取可用订阅列表
  ipcMain.handle('account-get-subscriptions', async (_event, accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    return getAccountSubscriptions(
      { fetchAvailableSubscriptions },
      { accessToken, region, profileArn, machineId, provider, authMethod, accountId }
    )
  })

  // IPC: 获取订阅管理/支付链接
  //   只返回 URL,打开动作由 open-subscription-window 负责(桌面端本机无痕窗口 = 宿主机能力)。
  ipcMain.handle('account-get-subscription-url', async (_event, accessToken: string, subscriptionType?: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    return getAccountSubscriptionUrl(
      { fetchSubscriptionToken },
      { accessToken, region, profileArn, machineId, provider, authMethod, accountId },
      subscriptionType
    )
  })

  // IPC: 设置用户偏好（超额开启/关闭）
  ipcMain.handle('account-set-overage', async (_event, accessToken: string, overageStatus: 'ENABLED' | 'DISABLED', region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    return setAccountOverage(
      { setUserPreference },
      { accessToken, region, profileArn, machineId, provider, authMethod, accountId },
      overageStatus
    )
  })

  // IPC: 在系统默认浏览器无痕模式中打开订阅链接
  ipcMain.handle('open-subscription-window', async (_event, url: string) => {
    try {
      openBrowserInPrivateMode(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' }
    }
  })

  // 代理日志持久化（请求日志，与详细日志分开存储）
  const getProxyLogsPath = (): string => join(app.getPath('userData'), 'proxy-request-logs.json')
  // 保留条数上限。100 → 2000(RCA 2026-08-11 429-latency-throughput §3):
  // 100 条在高峰期只覆盖几分钟,无法看「白天 vs 凌晨」的 429/延迟曲线,而这正是
  // 定位限流与首响慢所必需的时间跨度。单条约 200-400B,2000 条 ≈ 0.8MB,可接受。
  const MAX_LOGS = 2000

  // IPC: 保存代理日志
  ipcMain.handle('proxy-save-logs', async (_event, logs: Array<{ time: string; path: string; status: number; tokens?: number }>) => {
    try {
      const logsPath = getProxyLogsPath()
      // 只保留最近 100 条
      const trimmedLogs = logs.slice(0, MAX_LOGS)
      await writeFile(logsPath, JSON.stringify(trimmedLogs, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('[ProxyLogs] Save failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save logs' }
    }
  })

  // IPC: 加载代理日志
  ipcMain.handle('proxy-load-logs', async () => {
    try {
      const logsPath = getProxyLogsPath()
      const content = await readFile(logsPath, 'utf-8')
      const logs = JSON.parse(content)
      return { success: true, logs }
    } catch (error) {
      // 文件不存在是正常的
      return { success: true, logs: [] }
    }
  })

  // IPC: 重置反代池状态
  ipcMain.handle('proxy-reset-pool', () => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().reset()
      }
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Reset pool failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reset pool' }
    }
  })

  // IPC: v1.7.6 能力路由 · 手动触发全池能力同步(冷启动 / 加账号后 / 手动刷新)
  // 前端在打开 enableModelCapabilityRouting 或点"立即同步"按钮时调用
  // 幂等:多次同时调用会共用同一 in-flight Promise
  ipcMain.handle('proxy-sync-capabilities', async () => {
    try {
      if (!proxyServer) {
        return { success: false, error: 'Proxy server not running' }
      }
      const result = await proxyServer.syncCapabilities()
      return { success: true, ...result }
    } catch (error) {
      console.error('[ProxyServer] Manual capability sync failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'sync failed' }
    }
  })

  // IPC: 查询能力同步是否在进行中(供 UI 显示 loading 状态)
  ipcMain.handle('proxy-capability-sync-status', () => {
    if (!proxyServer) return { inflight: false }
    return { inflight: proxyServer.isCapabilityBootstrapInflight() }
  })

  // IPC: 手动解除账号封禁标记（用户确认账号已恢复后调用）
  // 1) 清除反代池中的 suspended 状态
  // 2) 同步清除 store.accountData[id].lastError，状态回到 active
  ipcMain.handle('proxy-clear-account-suspended', async (_event, accountId: string) => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().clearSuspended(accountId)
      }
      // 持久化清除 lastError · 走收口
      if (store) {
        const accountData = store.get('accountData') as { accounts?: Record<string, Record<string, unknown>> } | undefined
        if (accountData?.accounts?.[accountId]) {
          const acc = accountData.accounts[accountId]
          accountData.accounts[accountId] = {
            ...acc,
            status: 'active',
            lastError: undefined,
            lastCheckedAt: Date.now()
          }
          // main 侧清封禁标记是权威操作,不传 expectedRevision
          await applyAccountDataMutation(() => accountData as unknown as AccountsBlob)
          // lastSavedData 由收口内部同步,此处保留显式赋值兼容老语义
          lastSavedData = accountData
        }
      }
      console.log(`[ProxyServer] Cleared suspended flag for account ${accountId}`)
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Clear suspended failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to clear suspended' }
    }
  })

  // IPC: 手动放行所有挂起请求(挂起门闸"放行"按钮)
  ipcMain.handle('proxy-release-held-requests', () => {
    try {
      if (!proxyServer) return { released: 0 }
      return { released: proxyServer.releaseHeldRequests() }
    } catch (error) {
      console.error('[ProxyServer] Release held requests failed:', error)
      return { released: 0 }
    }
  })

  // IPC: 查询当前挂起中的请求数(前端徽标 + 放行按钮启用条件)
  ipcMain.handle('proxy-get-held-requests', () => {
    // 反代未运行 / 异常时的空读数。**单一字面量**:此前两条兜底路径各手抄一份字段列表,
    // 每次给 HeldRequestsInfo 加字段都得同步改两处,漏一处就是「前端字段时有时无」(E-060 形态)。
    const emptyInfo = (): HeldRequestsInfo => ({
      count: 0,
      autoReleaseEnabled: false,
      nextAutoReleaseAt: null,
      autoReleaseCount: 0,
      currentEpisode: null,
      recentEpisodes: []
    })
    try {
      if (!proxyServer) return emptyInfo()
      return proxyServer.getHeldRequestsInfo()
    } catch (error) {
      console.error('[ProxyServer] Get held requests failed:', error)
      return emptyInfo()
    }
  })

  // ============ K-Proxy MITM 代理 IPC ============

  // IPC: 初始化 K-Proxy 服务
  ipcMain.handle('kproxy-init', async () => {
    try {
      const savedConfig = store?.get('kproxyConfig') as Partial<KProxyConfig> | undefined
      // 用户数据目录由装配层注入（内核零 electron 依赖，见 kproxy/index.ts 头部）
      const service = initKProxyService(savedConfig || {}, {
        onRequest: (info) => {
          mainWindow?.webContents.send('kproxy-request', info)
        },
        onResponse: (info) => {
          mainWindow?.webContents.send('kproxy-response', info)
        },
        onError: (error) => {
          console.error('[KProxy] Error:', error)
          mainWindow?.webContents.send('kproxy-error', error.message)
        },
        onStatusChange: (running, port) => {
          mainWindow?.webContents.send('kproxy-status-change', { running, port })
        },
        onMitmIntercept: (host, modified) => {
          mainWindow?.webContents.send('kproxy-mitm', { host, modified })
        }
      }, app.getPath('userData'))
      const caInfo = await service.initialize()
      return { 
        success: true, 
        caInfo: {
          certPath: caInfo.certPath,
          fingerprint: caInfo.fingerprint,
          validFrom: caInfo.validFrom.toISOString(),
          validTo: caInfo.validTo.toISOString()
        }
      }
    } catch (error) {
      console.error('[KProxy] Init failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to init K-Proxy' }
    }
  })

  // IPC: 启动 K-Proxy
  ipcMain.handle('kproxy-start', async (_event, config?: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      if (config) {
        service.updateConfig(config)
      }
      await service.start()
      // 保存配置
      if (store) {
        store.set('kproxyConfig', service.getConfig())
      }
      return { success: true, port: service.getConfig().port }
    } catch (error) {
      console.error('[KProxy] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start K-Proxy' }
    }
  })

  // IPC: 停止 K-Proxy
  ipcMain.handle('kproxy-stop', async () => {
    try {
      const service = getKProxyService()
      if (service) {
        await service.stop()
      }
      return { success: true }
    } catch (error) {
      console.error('[KProxy] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop K-Proxy' }
    }
  })

  // IPC: 获取 K-Proxy 状态
  ipcMain.handle('kproxy-get-status', () => {
    const service = getKProxyService()
    if (!service) {
      const savedConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, caInfo: null }
    }
    return {
      running: service.isRunning(),
      config: service.getConfig(),
      stats: service.getStats(),
      caInfo: service.getCACertInfo()
    }
  })

  // IPC: 更新 K-Proxy 配置
  ipcMain.handle('kproxy-update-config', async (_event, config: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.updateConfig(config)
      const newConfig = service.getConfig()
      if (store) {
        store.set('kproxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[KProxy] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // IPC: 设置当前设备 ID
  ipcMain.handle('kproxy-set-device-id', (_event, deviceId: string) => {
    try {
      if (!isValidDeviceId(deviceId)) {
        return { success: false, error: 'Invalid device ID format (must be 64 hex characters)' }
      }
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.setDeviceId(deviceId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set device ID' }
    }
  })

  // IPC: 生成新的设备 ID
  ipcMain.handle('kproxy-generate-device-id', () => {
    return { success: true, deviceId: generateDeviceId() }
  })

  // IPC: 添加设备 ID 映射
  ipcMain.handle('kproxy-add-device-mapping', (_event, mapping: DeviceIdMapping) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.addDeviceIdMapping(mapping)
      // 保存映射
      const mappings = service.getAllDeviceIdMappings()
      if (store) {
        store.set('kproxyDeviceMappings', mappings)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add mapping' }
    }
  })

  // IPC: 获取所有设备 ID 映射
  ipcMain.handle('kproxy-get-device-mappings', () => {
    const service = getKProxyService()
    if (!service) {
      const savedMappings = store?.get('kproxyDeviceMappings') as DeviceIdMapping[] | undefined
      return { success: true, mappings: savedMappings || [] }
    }
    return { success: true, mappings: service.getAllDeviceIdMappings() }
  })

  // IPC: 切换到账号设备 ID
  ipcMain.handle('kproxy-switch-to-account', (_event, accountId: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const switched = service.switchToAccount(accountId)
      return { success: switched, error: switched ? undefined : 'No device ID mapping for account' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to switch account' }
    }
  })

  // IPC: 获取 CA 证书 PEM（用于导出/安装）
  ipcMain.handle('kproxy-get-ca-cert', () => {
    const service = getKProxyService()
    if (!service) {
      return { success: false, error: 'K-Proxy not initialized' }
    }
    const certPem = service.getCACertPem()
    const caInfo = service.getCACertInfo()
    if (!certPem || !caInfo) {
      return { success: false, error: 'CA certificate not available' }
    }
    return { 
      success: true, 
      certPem,
      certPath: caInfo.certPath,
      fingerprint: caInfo.fingerprint
    }
  })

  // IPC: 导出 CA 证书到指定路径
  ipcMain.handle('kproxy-export-ca-cert', async (_event, exportPath?: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const certPem = service.getCACertPem()
      if (!certPem) {
        return { success: false, error: 'CA certificate not available' }
      }
      
      let targetPath = exportPath
      if (!targetPath) {
        const result = await dialog.showSaveDialog({
          title: 'Export CA Certificate',
          defaultPath: 'kproxy-ca.crt',
          filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }]
        })
        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }
        targetPath = result.filePath
      }
      
      await writeFile(targetPath, certPem, 'utf-8')
      return { success: true, path: targetPath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to export certificate' }
    }
  })

  // IPC: 重置 K-Proxy 统计
  ipcMain.handle('kproxy-reset-stats', () => {
    const service = getKProxyService()
    if (service) {
      service.resetStats()
    }
    return { success: true }
  })

  // IPC: 检查 CA 证书是否已安装到系统信任存储
  ipcMain.handle('kproxy-check-ca-cert-installed', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, installed: false, error: 'K-Proxy not initialized' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 检查证书
        try {
          const output = execSync('certutil -store -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, installed: output.includes('K-Proxy CA') }
        } catch {
          return { success: true, installed: false }
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令检查
        try {
          execSync('security find-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db', { encoding: 'utf-8' })
          return { success: true, installed: true }
        } catch {
          return { success: true, installed: false }
        }
      } else {
        // Linux: 检查文件是否存在
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        return { success: true, installed: fs.existsSync(targetPath) }
      }
    } catch (error) {
      console.error('[KProxy] Check CA cert installed failed:', error)
      return { success: false, installed: false, error: error instanceof Error ? error.message : 'Check failed' }
    }
  })

  // IPC: 安装 CA 证书到系统信任存储
  ipcMain.handle('kproxy-install-ca-cert', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const caInfo = service.getCACertInfo()
      if (!caInfo) {
        return { success: false, error: 'CA certificate not available' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 安装到根证书存储
        try {
          execSync(`certutil -addstore -user Root "${caInfo.certPath}"`, { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate installed to Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('already in store') || errMsg.includes('已在存储中')) {
            return { success: true, message: 'CA certificate already installed' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令安装到钥匙串
        execSync(`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caInfo.certPath}"`)
        return { success: true, message: 'CA certificate installed to macOS Keychain' }
      } else {
        // Linux: 复制到系统 CA 目录
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        fs.copyFileSync(caInfo.certPath, targetPath)
        execSync('sudo update-ca-certificates')
        return { success: true, message: 'CA certificate installed to Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Install CA cert failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to install certificate' }
    }
  })

  // IPC: 卸载 CA 证书从系统信任存储
  ipcMain.handle('kproxy-uninstall-ca-cert', async () => {
    try {
      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 删除证书
        try {
          execSync('certutil -delstore -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate removed from Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('not found') || errMsg.includes('找不到')) {
            return { success: true, message: 'CA certificate not found in store' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令删除
        execSync('security delete-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db')
        return { success: true, message: 'CA certificate removed from macOS Keychain' }
      } else {
        // Linux: 删除证书并更新
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath)
          execSync('sudo update-ca-certificates --fresh')
        }
        return { success: true, message: 'CA certificate removed from Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Uninstall CA cert failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to uninstall certificate' }
    }
  })

  // ============ MCP 服务器管理 IPC ============

  // IPC: 保存 MCP 服务器配置
  ipcMain.handle('save-mcp-server', async (_event, name: string, config: { command: string; args?: string[]; env?: Record<string, string> }, oldName?: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      // 读取现有配置
      let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
      if (fs.existsSync(mcpPath)) {
        const content = fs.readFileSync(mcpPath, 'utf-8')
        mcpConfig = JSON.parse(content)
      }
      
      // 如果是重命名，先删除旧的
      if (oldName && oldName !== name) {
        delete mcpConfig.mcpServers[oldName]
      }
      
      // 添加/更新服务器
      mcpConfig.mcpServers[name] = config
      
      // 确保目录存在
      const dir = path.dirname(mcpPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Saved MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save MCP server:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save MCP server' }
    }
  })

  // IPC: 删除 MCP 服务器
  ipcMain.handle('delete-mcp-server', async (_event, name: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: '配置文件不存在' }
      }
      
      const content = fs.readFileSync(mcpPath, 'utf-8')
      const mcpConfig = JSON.parse(content)
      
      if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[name]) {
        return { success: false, error: '服务器不存在' }
      }
      
      delete mcpConfig.mcpServers[name]
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Deleted MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete MCP server:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' }
    }
  })

  // IPC: 删除 Steering 文件
  ipcMain.handle('delete-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }
      
      fs.unlinkSync(filePath)
      console.log('[KiroSettings] Deleted steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete file' }
    }
  })

  // ============ 机器码管理 IPC ============
  
  // IPC: 获取操作系统类型
  ipcMain.handle('machine-id:get-os-type', () => {
    return machineIdModule.getOSType()
  })

  // IPC: 获取当前机器码
  ipcMain.handle('machine-id:get-current', async () => {
    console.log('[MachineId] Getting current machine ID...')
    return await machineIdModule.getCurrentMachineId()
  })

  // IPC: 设置新机器码
  ipcMain.handle('machine-id:set', async (_event, newMachineId: string) => {
    console.log('[MachineId] Setting new machine ID:', newMachineId.substring(0, 8) + '...')
    const result = await machineIdModule.setMachineId(newMachineId)
    
    if (!result.success && result.requiresAdmin) {
      // 弹窗询问用户是否以管理员权限重启
      const shouldRestart = await machineIdModule.showAdminRequiredDialog()
      if (shouldRestart) {
        await machineIdModule.requestAdminRestart()
      }
    }
    
    return result
  })

  // IPC: 生成随机机器码
  ipcMain.handle('machine-id:generate-random', () => {
    return machineIdModule.generateRandomMachineId()
  })

  // IPC: 检查管理员权限
  ipcMain.handle('machine-id:check-admin', async () => {
    return await machineIdModule.checkAdminPrivilege()
  })

  // IPC: 请求管理员权限重启
  ipcMain.handle('machine-id:request-admin-restart', async () => {
    const shouldRestart = await machineIdModule.showAdminRequiredDialog()
    if (shouldRestart) {
      return await machineIdModule.requestAdminRestart()
    }
    return false
  })

  // IPC: 备份机器码到文件
  ipcMain.handle('machine-id:backup-to-file', async (_event, machineId: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '备份机器码',
      defaultPath: 'machine-id-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    
    if (result.canceled || !result.filePath) {
      return false
    }
    
    return await machineIdModule.backupMachineIdToFile(machineId, result.filePath)
  })

  // IPC: 从文件恢复机器码
  ipcMain.handle('machine-id:restore-from-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '恢复机器码',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: '用户取消' }
    }
    
    return await machineIdModule.restoreMachineIdFromFile(result.filePaths[0])
  })

  // 更新协议处理函数以支持 Social Auth 回调
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - 重新定义协议处理
  handleProtocolUrl = (url: string): void => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

    try {
      const urlObj = new URL(url)

      // 处理 external_idp (Microsoft Entra) 回调 (kiro://kiro.oauth/callback?code=...)
      // 必须在下面 social 分支之前：'kiro.oauth' 含 'auth' 会被 social 分支误吃。
      if (url.includes('kiro.oauth/callback') || urlObj.host === 'kiro.oauth') {
        console.log('[ExternalIdpLogin] Deep-link callback received')
        if (mainWindow) {
          mainWindow.webContents.send('external-idp-callback', { url })
          mainWindow.focus()
        }
        return
      }

      // 处理 Social Auth 回调 (kiro://kiro.kiroAgent/authenticate-success)
      if (url.includes('authenticate-success') || url.includes('auth')) {
        const code = urlObj.searchParams.get('code')
        const state = urlObj.searchParams.get('state')
        const error = urlObj.searchParams.get('error')

        if (error) {
          console.log('[Login] Auth callback error:', error)
          if (mainWindow) {
            mainWindow.webContents.send('social-auth-callback', { error })
            mainWindow.focus()
          }
          return
        }

        if (code && state && mainWindow) {
          console.log('[Login] Auth callback received, code:', code.substring(0, 20) + '...')
          mainWindow.webContents.send('social-auth-callback', { code, state })
          mainWindow.focus()
        }
        return
      }

      // 调用原始处理函数处理其他协议
      originalHandleProtocolUrl(url)
    } catch (error) {
      console.error('Failed to parse protocol URL:', error)
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // macOS: 点击 Dock 图标时显示主窗口
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 加载并注册全局快捷键
  await loadShortcutSettings()
  registerShowWindowShortcut()
})

// Windows/Linux: 处理第二个实例和协议 URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: 协议 URL 会作为命令行参数传入
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // 聚焦主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 处理协议 URL
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 应用退出前注销 URI 协议处理器并保存数据
app.on('will-quit', async (event) => {
  // 防止重复处理
  if (isQuitting) return
  
  // 停止主进程池 token 刷新调度器
  stopMainPoolTokenRefresh()

  // 局域网 web 面板清理(W6):关 HTTP server + 停会话清扫 + 停限流清扫 timer。
  // 放在 preventDefault 分支**之外** —— 下面的 `lastSavedData && store` 分支不成立时
  // 也必须收干净,否则「从未保存过数据」的那次退出会漏掉面板的 timer 与监听端口。
  // 不 await:will-quit 是同步事件,await 会让后面的 preventDefault 错过时机。
  void webPanelWiring?.dispose()

  // 服务仍在运行时，退出前先归档本次会话（正常退出可救；进程崩溃无法救）
  if (proxyServer?.isRunning()) {
    archiveProxySessionIfAny()
  }

  // 防止应用立即退出，先保存数据
  if (lastSavedData && store) {
    event.preventDefault()
    isQuitting = true
    
    // 设置超时，确保 3 秒后强制退出（防止关机阻塞）
    const forceQuitTimer = setTimeout(() => {
      console.log('[Exit] Force quit due to timeout')
      unregisterProtocol()
      app.exit(0)
    }, 3000)
    
    try {
      console.log('[Exit] Saving data before quit...')
      // 刷新待写入的防抖数据
      flushStoreWrites()
      // 退出前 flush 语义:走收口保持 revision 单调递增。main 侧退出流程是权威源,不传 expectedRevision。
      await applyAccountDataMutation(() => lastSavedData as AccountsBlob)
      // 退出场景跳过节流，确保备份立即落盘
      await createBackup(lastSavedData)
      await flushBackupNow()
      // 强制落盘代理日志（异步节流中的尾巴数据）
      try {
        const { proxyLogStore } = await import('./proxy/logger')
        await proxyLogStore.flushSaveNow()
      } catch (err) {
        console.error('[Exit] Failed to flush proxy logs:', err)
      }
      // 释放共享的 TLS ModuleClient（worker pool + DLL）
      try {
        const { shutdownTlsClientPool } = await import('./registration/tlsClientPool')
        await shutdownTlsClientPool()
      } catch (err) {
        console.error('[Exit] Failed to shutdown TLS client pool:', err)
      }
      console.log('[Exit] Data saved successfully')
    } catch (error) {
      console.error('[Exit] Failed to save data:', error)
    }
    
    clearTimeout(forceQuitTimer)
    unregisterProtocol()
    app.exit(0)
  } else {
    unregisterProtocol()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
