/**
 * webPanel HTTP 服务器 —— 纯 Node `http`，手写路由
 *
 * 形态照 `proxy/proxyServer.ts`（同进程里的姊妹服务器）：
 *   - `http.createServer(handler)` + `server.listen(port, host)`（`proxyServer.ts:504` / `:569`）
 *   - `connection` 事件收集 socket，`stop()` 里强制 `socket.destroy()`
 *     （`proxyServer.ts:520` / `:721`）—— 不做这一步，`close()` 会等 keep-alive
 *     连接自然超时（~60s），表现为「关面板按钮点了没反应」。
 *   - 定时器 `setInterval(...).unref?.()`（`proxyServer.ts:552`）
 *
 * **独立端口**，与反代分离：面板可以开着而反代不开（决策卡 §3 端点映射原则）。
 *
 * ## 安全红线：外网绑定 + 无 adminKey → 拒绝启动
 *
 * 决策卡 §1 负条件 3。这条是**新写**而非从 `proxyServer.ts:472` 抽取 ——
 * 原版把「凭据存在性」定义成「遍历 `apiKeys[]` + legacy `apiKey`」，那是代理专属的；
 * 面板只有单个 adminKey。复用的是 `isBindingExternal` 这个判定原语
 * （SSOT 落在判定层，而不是「凭据是什么」这一层）。
 */
import http from 'node:http'
import type { Socket } from 'node:net'
import {
  isBindingExternal,
  isIPAllowed,
  resolveClientIP,
  type IPAccessPolicy
} from '../utils/netGuard'
import { PANEL_PATH_PREFIX } from './cookie'
import { sendJson, sendError } from './respond'
import { serveStaticAsset } from './staticAssets'
import { resolveWebPanelAssets, type WebPanelAssets } from '../utils/webPanelAssetRoot'
import { routePanelApi, type PanelRouteDeps, type PanelRequestContext } from './routes'
import type { PanelAuth, GuardDenyReason } from './auth'

/** 请求体大小上限 —— 面板的写操作 payload 都很小，防止内存被大 body 打爆 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * API 命名空间前缀（去掉 `/panel` 之后的部分）。
 *
 * 静态托管与 API 的分界线收在这一个常量上：`/panel/api/*` 走 JSON 闸门，
 * 其余走静态资源。**不写字面量散落各处** —— 分界线一旦分叉，
 * 未知 API 路径会被 SPA 回退成 HTML，前端拿到 `<!doctype` 再报 JSON 解析错，
 * 排查方向被彻底带偏。
 */
const API_PREFIX = '/api'

/** 会话清扫间隔（照 `proxyServer.ts:552` 的 5 分钟 + unref 先例） */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export interface WebPanelConfig {
  enabled: boolean
  /** 面板端口。**与反代端口分离**，面板可单独开启 */
  port: number
  host: string
  /** 启动时自动拉起（照 proxyConfig.autoStart 先例） */
  autoStart?: boolean
  allowedIPs?: string[]
  deniedIPs?: string[]
  /**
   * 显式声明的 TLS 终止代理 socket 地址。只有 peer 命中时才读取 X-Forwarded-For，
   * 且该请求签发/清除的 session cookie 会带 Secure。
   */
  trustedTlsProxyIPs?: string[]
  /**
   * 外网绑定且无 adminKey 时的逃生门。默认 `undefined` = 关闭。
   * 与代理侧 `allowExternalWithoutApiKey` 同一语义（NOT RECOMMENDED）。
   */
  allowExternalWithoutAdminKey?: boolean
}

export interface WebPanelServerOptions {
  auth: PanelAuth
  routeDeps: PanelRouteDeps
  /** 实时读配置（用户可在运行期改端口/主机，读时取最新值） */
  getConfig: () => WebPanelConfig
  /**
   * 业务就绪判据。服务端注入「反代正在实际监听」；桌面端未注入时保持未就绪。
   *
   * readiness 与面板进程的 liveness 刻意分离：面板活着只说明还能运维，
   * 不代表数据面能接请求。
   */
  isReady?: () => boolean
  /** 状态变化回调（供设置页显示真实启动结果 —— 决策卡 §5 场景 S3） */
  onStatusChange?: (running: boolean, port: number) => void
  onError?: (error: Error) => void
}

export class WebPanelServer {
  private server: http.Server | null = null
  private readonly sockets = new Set<Socket>()
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly auth: PanelAuth
  private readonly routeDeps: PanelRouteDeps
  private readonly getConfig: () => WebPanelConfig
  private readinessProbe: () => boolean
  private readonly onStatusChange?: (running: boolean, port: number) => void
  private readonly onError?: (error: Error) => void

  constructor(options: WebPanelServerOptions) {
    this.auth = options.auth
    this.routeDeps = options.routeDeps
    this.getConfig = options.getConfig
    this.readinessProbe = options.isReady ?? (() => false)
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
  }

  isRunning(): boolean {
    return this.server !== null
  }

  /** 服务端装配完成后注入动态 readiness 判据（每次探测都读真实运行态，不缓存）。 */
  setReadinessProbe(probe: () => boolean): void {
    this.readinessProbe = probe
  }

  /** 当前业务面是否可服务；与面板 HTTP 监听态无关。 */
  isReady(): boolean {
    return this.readinessProbe()
  }

  /**
   * 实际监听地址。`port: 0` 时内核分配端口，配置里的 0 不是真实端口，
   * 所以设置页要显示的地址必须问这里而不是问配置。
   */
  getListeningAddress(): { host: string; port: number } | null {
    if (!this.server) return null
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') return null
    return { host: this.getConfig().host, port: addr.port }
  }

  /**
   * 启动面板服务器。
   *
   * @throws 外网绑定且无 adminKey（安全红线）/ 端口被占用 / 其他监听错误。
   *   **抛出而非静默降级** —— 决策卡 §5 场景 S3 要求设置页显示真实失败原因，
   *   而不是显示「已启用」却其实没在监听。
   */
  async start(): Promise<void> {
    if (this.server) return
    const config = this.getConfig()

    // ===== 安全红线（决策卡 §1 负条件 3）=====
    // 绑定到会暴露到本机以外的地址 + 未配置 adminKey → 拒绝启动，无例外。
    // 复用 isBindingExternal 判定原语；「凭据存在性」是面板自己的定义（单个 adminKey）。
    if (isBindingExternal(config.host) && !this.auth.hasAdminKey()) {
      if (!config.allowExternalWithoutAdminKey) {
        const err = new Error(
          `[Security] Refused to start: host=${config.host} exposes the panel to the network ` +
            `but no adminKey is configured. Generate an adminKey in settings, ` +
            `or bind to 127.0.0.1.`
        )
        console.error('[WebPanel]', err.message)
        this.onError?.(err)
        throw err
      }
      console.warn(
        `[WebPanel] [Security] WARNING: binding to ${config.host} without adminKey ` +
          `(allowExternalWithoutAdminKey=true). This exposes your accounts to the network!`
      )
    }

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // handleRequest 自己兜住所有异常；这里不加 .catch 会让未预期的抛错吞掉响应
        void this.handleRequest(req, res)
      })

      const onListenError = (error: NodeJS.ErrnoException): void => {
        // 监听失败时不能留下半初始化的 server 引用，否则 isRunning() 会骗人
        this.server = null
        const err =
          error.code === 'EADDRINUSE' ? new Error(`Port ${config.port} is already in use`) : error
        console.error('[WebPanel] Server error:', err.message)
        this.onError?.(err)
        reject(err)
      }
      server.once('error', onListenError)

      server.on('connection', (socket: Socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })

      server.listen(config.port, config.host, () => {
        server.removeListener('error', onListenError)
        // 监听成功后的运行期错误不该 reject 一个已 resolve 的 promise
        server.on('error', (error: Error) => {
          console.error('[WebPanel] Runtime server error:', error.message)
          this.onError?.(error)
        })
        this.server = server
        const actualPort = this.getListeningAddress()?.port ?? config.port
        console.log(`[WebPanel] Started on http://${config.host}:${actualPort}${PANEL_PATH_PREFIX}`)
        this.auth.sessionStore.startSweeping()
        this.startThrottleSweep()
        this.onStatusChange?.(true, actualPort)
        resolve()
      })
    })
  }

  /**
   * 停止面板服务器。
   *
   * 必须主动 destroy socket：`close()` 只停止接受新连接，已建立的 keep-alive
   * 连接会拖到超时（~60s）。照 `proxyServer.ts:721` 的做法。面板的请求都是短的
   * JSON 调用，没有流式响应要等，所以不需要代理那样的 graceful 窗口。
   */
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return

    this.stopTimers()
    this.auth.sessionStore.stopSweeping()

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.server = null
        this.sockets.clear()
        console.log('[WebPanel] Stopped')
        this.onStatusChange?.(false, this.getConfig().port)
        resolve()
      }

      server.close(() => finish())
      // 立刻断开保持中的连接，否则 close 的回调要等 keep-alive 超时
      this.sockets.forEach((socket) => {
        try {
          socket.destroy()
        } catch {
          /* socket 可能已被对端关闭 */
        }
      })
      // 兜底：极端情况下 close 回调未触发也要让 stop() 返回
      setTimeout(finish, 1000).unref?.()
    })
  }

  /** 登录限流表的周期清扫（防 Map 随 IP 数无界增长） */
  private startThrottleSweep(): void {
    this.stopTimers()
    this.sweepTimer = setInterval(() => {
      this.auth.loginThrottle.sweep()
    }, SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  private stopTimers(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * 请求主入口：IP 门禁 → 前缀分派 → 登录/登出 → 闸门 → 路由。
   *
   * 顺序不可调换：IP 门禁在最前（被拒的 IP 不该有机会触发登录比较，也不该进限流表）。
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const config = this.getConfig()
      const resolvedClient = resolveClientIP(
        req.socket.remoteAddress,
        req.headers['x-forwarded-for'],
        config.trustedTlsProxyIPs
      )
      if (!resolvedClient.ok) {
        console.error(
          `[WebPanel] [Security] Rejected request from trusted TLS proxy ${resolvedClient.peerIP}: ` +
            resolvedClient.reason
        )
        sendError(res, 400, 'INVALID_CREDENTIAL', 'Invalid proxy forwarding metadata')
        return
      }
      const clientIP = resolvedClient.clientIP
      const requestSecurity = {
        viaTrustedTlsProxy: resolvedClient.viaTrustedTlsProxy
      }

      // ===== IP 门禁（复用代理侧同一实现）=====
      const policy: IPAccessPolicy = {
        allowedIPs: config.allowedIPs,
        deniedIPs: config.deniedIPs
      }
      const ipCheck = isIPAllowed(clientIP, policy)
      if (!ipCheck.allowed) {
        sendError(res, 403, 'UNAUTHORIZED')
        return
      }

      const url = req.url ?? '/'
      const pathOnly = url.split('?')[0]

      // 只服务 /panel 命名空间；其余一律 404（与反代 /v1/* 隔离）
      if (pathOnly !== PANEL_PATH_PREFIX && !pathOnly.startsWith(`${PANEL_PATH_PREFIX}/`)) {
        sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'Not found')
        return
      }

      // 去前缀后的路径。⚠️ 必须用 PANEL_PATH_PREFIX 常量，不得写字面量 ——
      // cookie 的 Path 用的是同一常量，两者一旦分叉，浏览器就静默不发 cookie
      // （表现为「登录成功但后续全 401」，最容易误诊成鉴权 bug）。
      const path = pathOnly.slice(PANEL_PATH_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      // ===== 匿名 readiness（前置反代必须能直接轮询）=====
      //
      // 只返回一个布尔结论，不返回端口、账号数、错误原因等业务信息。详细状态仍走
      // 已鉴权的 `/api/proxy/status`。因此匿名探测不会给攻击者增加有用情报，
      // 却避免给 Caddy/nginx 配置面板会话与 CSRF 这种不稳定、无意义的凭据流程。
      if (path === '/readyz' && method === 'GET') {
        const ready = this.isReady()
        res.setHeader('Cache-Control', 'no-store')
        sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' })
        return
      }

      // ===== 静态资源（在鉴权闸门**之前**）=====
      // 顺序理由：登录页本身就是这个 shell。若放在闸门之后，就成了
      // 「必须先登录才能拿到登录页」—— 死锁。鉴权决策的完整论证见
      // `staticAssets.ts` 的 `serveStaticAsset` 注释。
      //
      // 分界线：只有 `/api/*` 之外的路径才交给静态层。这保证未知 API 路径
      // 仍然落到下方的 JSON 404，**不会**被 SPA 回退伪装成 200 HTML。
      if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) {
        await serveStaticAsset(
          {
            method,
            // 去掉前导斜杠：静态层契约要求相对路径（以 `/` 开头一律判逃逸）
            relUrlPath: path.replace(/^\/+/, ''),
            ifNoneMatch: headerValue(req.headers['if-none-match'])
          },
          res,
          this.getAssets()
        )
        return
      }

      // ===== 登录（闸门之前，因为此时还没有会话）=====
      if (path === '/api/login' && method === 'POST') {
        const body = await this.readJsonBody(req, res)
        if (body === undefined) return
        const provided = typeof body?.adminKey === 'string' ? body.adminKey : undefined
        const result = this.auth.login(provided, clientIP, requestSecurity)
        if (result.ok && result.setCookie) {
          res.setHeader('Set-Cookie', result.setCookie)
          sendJson(res, 200, { ok: true })
          return
        }
        if (result.reason === 'RATE_LIMITED') {
          const retryAfterSec = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000))
          res.setHeader('Retry-After', String(retryAfterSec))
          sendError(res, 429, 'RATE_LIMITED')
          return
        }
        // INVALID_KEY 与 NO_ADMIN_KEY 对外**同一个响应** —— 不告诉攻击者
        // 「面板还没设密钥」这种可利用信息（reason 只进服务端日志）。
        sendError(res, 401, 'UNAUTHORIZED')
        return
      }

      // ===== 闸门（会话 + CSRF 头合并成单一布尔）=====
      const guard = this.auth.guard(req)
      if (!guard.ok) {
        // reason 区分「会话过期」与「缺 CSRF 头」是给审计日志用的，
        // **绝不回传浏览器** —— 对客户端两者都只是 UNAUTHORIZED（决策卡 §3）。
        this.logDeny(clientIP, method, path, guard.reason)
        sendError(res, 401, 'UNAUTHORIZED')
        return
      }

      // ===== 登出（需要有效会话才有意义）=====
      if (path === '/api/logout' && method === 'POST') {
        const { setCookie } = this.auth.logout(req, requestSecurity)
        res.setHeader('Set-Cookie', setCookie)
        sendJson(res, 200, { ok: true })
        return
      }

      // ===== 面板自身状态（供 web UI 显示） =====
      if (path === '/api/session' && method === 'GET') {
        sendJson(res, 200, { ok: true, authenticated: true })
        return
      }

      // ===== 管理员密钥轮换（已通过会话 + CSRF 闸门）=====
      if (path === '/api/admin-key/rotate' && method === 'POST') {
        // rotateAdminKey 的顺序是「先持久化，成功后再失效全部会话」：
        // 写盘失败会抛到统一 500 出口，旧密钥与旧会话继续有效，不会把运维锁在门外。
        const next = this.auth.rotateAdminKey()
        // 当前会话也已失效；同时清浏览器 cookie，避免客户端继续携带一个确定无效的 sid。
        const { setCookie } = this.auth.logout(req, requestSecurity)
        res.setHeader('Set-Cookie', setCookie)
        res.setHeader('Cache-Control', 'no-store')
        // 不叫 `adminKey`：sendJson 的安全兜底会按敏感键名遮盖它。`key` 是这个
        // 明确的一次性交付端点的受控豁免；响应体不写 console，调用方展示一次后丢弃。
        sendJson(res, 200, { key: next })
        return
      }

      // ===== 业务路由 =====
      let body: Record<string, unknown> | undefined
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const parsed = await this.readJsonBody(req, res)
        if (parsed === undefined) return
        body = parsed
      }
      const ctx: PanelRequestContext = { method, path, body }
      const handled = await routePanelApi(ctx, res, this.routeDeps)
      if (!handled) {
        sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'Not found')
      }
    } catch (error) {
      // 全局兜底：向用户隐藏内部细节，但完整记录给开发者（§4.4 分层错误处理）。
      // 这不是吞异常返回成功 —— 状态码是 500，调用方看得到失败。
      console.error('[WebPanel] Unhandled request error:', error)
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL_ERROR')
      } else {
        res.destroy()
      }
    }
  }

  /**
   * 读并解析 JSON body。
   *
   * @returns 解析结果（空 body → `{}`）；**已写出错误响应时返回 undefined**，
   *   调用方必须据此立即 return，不要再写第二个响应。
   */
  private async readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer
        size += buf.length
        if (size > MAX_BODY_BYTES) {
          sendError(res, 413, 'INVALID_CREDENTIAL', 'Request body too large')
          req.destroy()
          return undefined
        }
        chunks.push(buf)
      }
    } catch (error) {
      // 读 body 期间连接中断：明确回一个错误，不静默当成空 body
      console.warn('[WebPanel] Failed to read request body:', error)
      if (!res.headersSent) sendError(res, 400, 'INVALID_CREDENTIAL', 'Malformed request body')
      return undefined
    }
    if (size === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(res, 400, 'INVALID_CREDENTIAL', 'Request body must be a JSON object')
        return undefined
      }
      return parsed as Record<string, unknown>
    } catch {
      sendError(res, 400, 'INVALID_CREDENTIAL', 'Request body must be valid JSON')
      return undefined
    }
  }

  /**
   * 静态资源位置。**每次请求都问 `resolveWebPanelAssets()`**，不缓存整个结果 ——
   * 这样开发时跑一次 `npm run build:webpanel` 后无需重启应用，面板立刻可用。
   *
   * 若改成启动时解析一次并缓存：产物在服务器启动后才构建出来的场景下，
   * 面板会一直返回「资源未构建」直到重启 —— 一个纯属自找的运维坑。
   * 代价是每请求一次 `existsSync`，对局域网面板的量级可忽略。
   */
  private getAssets(): WebPanelAssets {
    return resolveWebPanelAssets()
  }

  /** 审计日志：记录「谁、何时、对什么路径」被拒，**不记录凭证值**（决策卡 §3） */
  private logDeny(
    clientIP: string,
    method: string,
    path: string,
    reason: GuardDenyReason | undefined
  ): void {
    console.warn(`[WebPanel] Denied ${method} ${path} from ${clientIP} (${reason ?? 'UNKNOWN'})`)
  }
}

/** 取单值头（Node 对重复头会给数组；`if-none-match` 理论上可重复出现） */
function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}
