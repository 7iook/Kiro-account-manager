/**
 * webPanel 生产装配 —— 把六个 webPanel 模块 + accountService 接成一个可运行的面板
 *
 * 为什么单独一个文件而不是塞进 `index.ts`：`index.ts` 已 6900+ 行，且本轮有并行
 * executor 在改它。装配逻辑（配置读写 / deps 组装 / IPC 注册 / 生命周期）收在这里，
 * `index.ts` 只留三个调用点（autoStart / IPC 注册 / will-quit 清理），冲突面最小。
 *
 * ⚠️ 本文件是 webPanel 目录里**唯一允许 import electron 的地方吗？——不是**：
 * `test/main/architecture/webpanel_auth_constraints.test.ts` 禁止 `src/main/webPanel/`
 * 下任何文件 import electron。所以本文件放在 `webPanel/` 之外（`src/main/ipc/`），
 * electron 依赖（app / ipcMain / store 类型）留在这一侧，
 * `webPanel/*` 保持纯净、可在 vitest node env 里直接跑。
 */
import { ipcMain } from 'electron'
import { networkInterfaces } from 'node:os'
import { WebPanelServer, type WebPanelConfig } from '../webPanel/server'
import { PanelAuth, type AdminKeyStore } from '../webPanel/auth'
import { PANEL_PATH_PREFIX } from '../webPanel/cookie'
import type { PanelRouteDeps, PanelAccountIdentity } from '../webPanel/routes'

/** electron-store 的最小接口（与 accountService/state.ts:StoreRef 同一风格） */
export interface WebPanelStoreRef {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

/** store 里的配置键 —— 与 `proxyConfig` / `kproxyConfig` 同级同风格 */
const CONFIG_KEY = 'webPanelConfig'
const ADMIN_KEY_STORE_KEY = 'webPanelAdminKey'

/**
 * 默认**关闭**（决策卡 §5 注册清单第一条）。
 * 端口 5590 与反代 5580 分离，面板可开而反代不开。
 */
export const DEFAULT_WEB_PANEL_CONFIG: WebPanelConfig = {
  enabled: false,
  port: 5590,
  host: '127.0.0.1',
  autoStart: false
}

/**
 * 装配所需的宿主侧能力。由 `index.ts` 提供 —— 它持有 store、accountService deps
 * 与那些闭包引用模块级可变状态的函数（`refreshTokenByMethod` 等）。
 */
export interface WebPanelWiringDeps {
  /** 惰性取 store（与 accountDeps.getStore 同一理由：initStore 跑完才有值） */
  getStore: () => WebPanelStoreRef | null
  ensureStore: () => Promise<void>
  /** 直接透传 `accountService` 的业务函数（已绑好各自的 deps） */
  routeDeps: PanelRouteDeps
}

/** 面板对外可见状态（供设置页显示真实结果，而不是「以为开了」） */
export interface WebPanelStatus {
  running: boolean
  enabled: boolean
  host: string
  port: number
  /** 实际监听端口（port:0 时才与配置不同） */
  listeningPort: number | null
  /** 局域网可访问的完整地址列表（供手机端输入 / 生成二维码） */
  addresses: string[]
  hasAdminKey: boolean
  /** 最近一次启动失败的原因（决策卡 §5 场景 S3：不能显示「已启用」却其实没监听） */
  lastError: string | null
}

/**
 * 面板装配的单一持有者。`index.ts` 只跟它打交道。
 */
export class WebPanelWiring {
  private readonly deps: WebPanelWiringDeps
  private readonly auth: PanelAuth
  private readonly server: WebPanelServer
  private lastError: string | null = null

  constructor(deps: WebPanelWiringDeps) {
    this.deps = deps
    // AdminKeyStore 用 electron-store 实现并注入 —— auth.ts 刻意不 import electron，
    // 持久化端口由装配方补上（依赖倒置，非 auth.ts 的疏漏）。
    this.auth = new PanelAuth(this.createAdminKeyStore())
    this.server = new WebPanelServer({
      auth: this.auth,
      routeDeps: deps.routeDeps,
      getConfig: () => this.readConfig(),
      onStatusChange: (running) => {
        if (running) this.lastError = null
      },
      onError: (error) => {
        this.lastError = error.message
      }
    })
  }

  /** `AdminKeyStore` over electron-store（决策卡 §5：adminKey 配置项） */
  private createAdminKeyStore(): AdminKeyStore {
    return {
      get: () => {
        const raw = this.deps.getStore()?.get(ADMIN_KEY_STORE_KEY, null)
        return typeof raw === 'string' && raw.length > 0 ? raw : null
      },
      set: (key: string) => {
        const store = this.deps.getStore()
        if (!store) {
          // 装配次序 bug（initStore 未先跑）→ 抛错让上层立刻看见，不静默丢 key。
          // 静默丢 key 的后果是「设置页显示了一个密钥，但盘上没有」→ 登录永远失败。
          throw new Error('[webPanel] store not initialized; cannot persist adminKey')
        }
        store.set(ADMIN_KEY_STORE_KEY, key)
      }
    }
  }

  /** 读配置（默认值 + 盘上覆盖，照 `initProxyServer` 的 defaultConfig 合并先例） */
  readConfig(): WebPanelConfig {
    const saved = this.deps.getStore()?.get(CONFIG_KEY) as Partial<WebPanelConfig> | undefined
    return saved ? { ...DEFAULT_WEB_PANEL_CONFIG, ...saved } : { ...DEFAULT_WEB_PANEL_CONFIG }
  }

  private writeConfig(patch: Partial<WebPanelConfig>): WebPanelConfig {
    const next = { ...this.readConfig(), ...patch }
    const store = this.deps.getStore()
    if (!store) throw new Error('[webPanel] store not initialized; cannot persist config')
    store.set(CONFIG_KEY, next)
    return next
  }

  getStatus(): WebPanelStatus {
    const config = this.readConfig()
    const addr = this.server.getListeningAddress()
    const port = addr?.port ?? config.port
    return {
      running: this.server.isRunning(),
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      listeningPort: addr?.port ?? null,
      addresses: buildPanelAddresses(config.host, port),
      hasAdminKey: this.auth.hasAdminKey(),
      lastError: this.lastError
    }
  }

  /**
   * 启动面板。
   *
   * 绑定外网时会先确保 adminKey 存在 —— 否则服务器会按安全红线拒绝启动。
   * 这不是绕过红线：红线要求的是「不得无鉴权暴露」，自动生成一个强密钥满足它，
   * 而**不设默认密码**（密钥是 256 bit 随机，由设置页显示给用户）。
   */
  async start(): Promise<WebPanelStatus> {
    await this.deps.ensureStore()
    try {
      this.auth.ensureAdminKey()
      await this.server.start()
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      // 不吞：状态里带真实失败原因，同时抛给调用方（IPC 会把它转成 { success:false }）
      throw error
    }
    return this.getStatus()
  }

  async stop(): Promise<WebPanelStatus> {
    await this.server.stop()
    return this.getStatus()
  }

  /**
   * 应用退出清理：关服务器 + 停会话清扫 + 停限流清扫。
   *
   * `server.stop()` 内部已 `sessionStore.stopSweeping()` 与清限流 timer；
   * 这里再显式停一次，覆盖「服务器从未启动但 sweeper 已起」的路径。
   */
  async dispose(): Promise<void> {
    await this.server.stop().catch((e) => {
      console.error('[webPanel] stop during dispose failed:', e)
    })
    this.auth.sessionStore.stopSweeping()
  }

  /** 自启动（在 `ready-to-show` 里调，照 proxyConfig.autoStart 先例） */
  async autoStartIfConfigured(): Promise<void> {
    await this.deps.ensureStore()
    const config = this.readConfig()
    if (!config.enabled || !config.autoStart) return
    try {
      console.log('[webPanel] Auto-starting web panel...')
      await this.start()
      const addr = this.server.getListeningAddress()
      console.log(`[webPanel] Auto-started on port ${addr?.port ?? config.port}`)
    } catch (error) {
      // 自启动失败不能阻断应用启动；原因已记入 lastError，设置页会显示
      console.error('[webPanel] Auto-start failed:', error)
    }
  }

  /**
   * IPC 注册 —— 桌面端设置页用这些通道开关面板、读状态、看局域网地址、重新生成密钥。
   *
   * 通道命名 `web-panel:*`，与 `proxy-*` / `kproxy-*` 同级可辨。
   */
  registerIpcHandlers(): void {
    ipcMain.handle('web-panel:get-status', async () => {
      await this.deps.ensureStore()
      return { success: true, status: this.getStatus() }
    })

    ipcMain.handle('web-panel:get-config', async () => {
      await this.deps.ensureStore()
      return { success: true, config: this.readConfig() }
    })

    ipcMain.handle('web-panel:set-config', async (_event, patch: Partial<WebPanelConfig>) => {
      try {
        await this.deps.ensureStore()
        const config = this.writeConfig(patch ?? {})
        return { success: true, config, status: this.getStatus() }
      } catch (error) {
        return { success: false, error: toMessage(error) }
      }
    })

    ipcMain.handle('web-panel:start', async () => {
      try {
        const status = await this.start()
        return { success: true, status }
      } catch (error) {
        // 真实失败原因回传 UI（决策卡 §5 场景 S3）
        return { success: false, error: toMessage(error), status: this.getStatus() }
      }
    })

    ipcMain.handle('web-panel:stop', async () => {
      try {
        const status = await this.stop()
        return { success: true, status }
      } catch (error) {
        return { success: false, error: toMessage(error), status: this.getStatus() }
      }
    })

    /**
     * 读 adminKey 供设置页显示。首次调用会生成（不设默认密码）。
     *
     * ⚠️ 这条通道是 IPC（同机 renderer ↔ main），不是 HTTP —— adminKey 明文回传
     * 给桌面端设置页是**必需**的（用户要能看到并抄到手机上）。它不经网络。
     */
    ipcMain.handle('web-panel:get-admin-key', async () => {
      try {
        await this.deps.ensureStore()
        return { success: true, adminKey: this.auth.ensureAdminKey() }
      } catch (error) {
        return { success: false, error: toMessage(error) }
      }
    })

    /**
     * 重新生成 adminKey。
     *
     * **必须走 `rotateAdminKey()`** —— 它在写盘的同时失效所有既存会话。
     * 直接往 store 写新 key 会让旧 key 签发的会话继续可用，轮换就只是装样子
     * （对已泄漏的会话毫无补救作用）。
     */
    ipcMain.handle('web-panel:rotate-admin-key', async () => {
      try {
        await this.deps.ensureStore()
        return { success: true, adminKey: this.auth.rotateAdminKey() }
      } catch (error) {
        return { success: false, error: toMessage(error) }
      }
    })
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 枚举面板的可访问地址。
 *
 * 绑定 `0.0.0.0` / `::` 时列出所有非回环 IPv4 网卡地址 —— 用户需要知道
 * 「在手机浏览器里该输哪个」，而 `0.0.0.0` 本身不是可输入的地址。
 */
export function buildPanelAddresses(host: string, port: number): string[] {
  const suffix = `:${port}${PANEL_PATH_PREFIX}`
  const isWildcard = host === '0.0.0.0' || host === '::' || host === ''
  if (!isWildcard) return [`http://${host}${suffix}`]

  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        out.push(`http://${entry.address}${suffix}`)
      }
    }
  }
  // 回环兜底：没有可用网卡时至少给一个能自测的地址
  out.push(`http://127.0.0.1${suffix}`)
  return out
}

/**
 * 组装 `PanelRouteDeps`。
 *
 * 这层把「桌面端 handler 的 token-first 签名」翻译成「面板的 accountId 寻址」：
 * 四个 `account-get-*` / `account-set-overage` 的实现本来就接受一个 identity 对象，
 * 路由层已经从 store 内部取好 token 塞进 identity，所以这里只是原样转交。
 * token 从未作为 HTTP 参数出现（决策卡 §3 第二处豁免）。
 */
export function buildPanelRouteDeps(impl: {
  loadAccountsBlob: () => Promise<unknown>
  checkAccountStatus: (account: unknown) => Promise<unknown>
  refreshAccountToken: (account: unknown) => Promise<unknown>
  switchAccountToIde: (credentials: unknown) => Promise<unknown>
  switchAccountToCli: (credentials: unknown) => Promise<unknown>
  logoutFromIde: () => Promise<unknown>
  getAccountModels: (identity: PanelAccountIdentity) => Promise<unknown>
  getAccountSubscriptions: (identity: PanelAccountIdentity) => Promise<unknown>
  getAccountSubscriptionUrl: (
    identity: PanelAccountIdentity,
    subscriptionType?: string
  ) => Promise<unknown>
  setAccountOverage: (identity: PanelAccountIdentity, enabled: boolean) => Promise<unknown>
}): PanelRouteDeps {
  const asService = <A extends unknown[]>(
    fn: (...args: A) => Promise<unknown>
  ): ((...args: A) => Promise<Record<string, unknown>>) => {
    return async (...args: A) => (await fn(...args)) as Record<string, unknown>
  }
  return {
    loadAccountsBlob: impl.loadAccountsBlob,
    checkAccountStatus: asService(impl.checkAccountStatus),
    refreshAccountToken: asService(impl.refreshAccountToken),
    switchAccountToIde: asService(impl.switchAccountToIde),
    switchAccountToCli: asService(impl.switchAccountToCli),
    logoutFromIde: asService(impl.logoutFromIde),
    getAccountModels: asService(impl.getAccountModels),
    getAccountSubscriptions: asService(impl.getAccountSubscriptions),
    getAccountSubscriptionUrl: asService(impl.getAccountSubscriptionUrl),
    setAccountOverage: asService(impl.setAccountOverage)
  }
}
