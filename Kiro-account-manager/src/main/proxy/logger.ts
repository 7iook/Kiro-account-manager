// 代理服务器日志模块
//
// ## 为什么这里没有 `import { app } from 'electron'`
//
// 本模块是**共享内核**的一部分（`accountService/verify.ts` → `proxy/kiroApi.ts` →
// 本文件），既要在 Electron 桌面端跑，也要在 Linux 服务器的裸 node 下跑。
// 而 `electron` 在本仓是 **devDependency**，且 `dependencies` 里**没有任何包 peer 上它**
// —— 两个条件都成立，服务器 `npm install --omit=dev` 之后该模块才真的不存在，
// 任何静态 import 都会让整条链死在模块解析期。
//
// 第二个条件不是废话：`@electron-toolkit/utils` / `@electron-toolkit/preload` 曾长期
// 待在 `dependencies` 里，它们的 `peerDependencies.electron` 会把 electron 拖回 prod 树
// （npm 认为这是设计行为，见 npm/cli#6282），于是「electron 是 devDependency」这句话
// 在当时是**假的**。已于 2026-08-12 把两包移入 devDependencies 修正。
// 闸门：`test/main/architecture/prod_tree_has_no_electron.test.ts`（防有人再加一个
// peer 上 electron 的 prod 依赖，把这条前提悄悄推翻）。
//
// 处理姿态与 `utils/webPanelAssetRoot.ts` 一致：**把平台差异推到装配层，
// 并从共享代码里删掉分支**。所以这里既不做 DI 容器，也不写
// `await import('electron')` —— 后者只是把依赖藏得更晚、还躲过静态检查，
// 等于没解耦。取而代之：唯一一个平台相关的事实（是否为生产构建）由装配层
// （`src/main/index.ts`）在启动早期显式注入，见 `setLogTruncationEnabled`。
//
// 同一动作里删掉了 `ProxyLogger.configure()` 的「默认日志目录」分支：它依赖
// `app.getPath('userData')`，且是**死代码** —— 全仓无 configure() 调用点，
// 且 `DEFAULT_CONFIG.enabled === false`。详见 `configure()` 上方注释。
import * as fs from 'fs'
import * as path from 'path'
import { normalizeAndRedactLogEntry } from '../utils/redact'

export interface LogEntry {
  timestamp: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  category: string
  message: string
  data?: unknown
}

export interface LoggerConfig {
  enabled: boolean
  logDir?: string
  maxFileSize?: number // 最大文件大小 (bytes)
  maxFiles?: number // 最大文件数量
  logToConsole?: boolean
}

const DEFAULT_CONFIG: LoggerConfig = {
  enabled: false,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  logToConsole: true
}

/**
 * INFO 级 data 是否强制截断为 200B preview（原 `app.isPackaged` 闸门）。
 *
 * ## 默认为 true（= 截断开启）的理由
 *
 * 这个默认值的唯一职责，是回答「没人注入时，谁来承担代价」。两侧代价不对称：
 *   - 默认 true 而实际在开发机 → 日志 data 被截断，调试信息变少，**可恢复**
 *     （装配层注入 false，或临时改一行）。
 *   - 默认 false 而实际在生产 → 每条 INFO 日志 stringify 整个对象，
 *     CPU 峰值把事件循环拖死（2026-07-23 frontend-freeze RCA 假设 B 的原始病灶），
 *     **在线上表现为卡死，且没人会注意到日志系统悄悄换了行为**。
 *
 * 服务器场景恰好落在「没人注入」这一格：裸 node 下没有 `app.isPackaged` 这个概念，
 * 且服务器天然是生产环境。若默认 false，服务器就会**静默退化成 dev 行为** ——
 * 一个只在压力上来之后才暴露的性能地雷。所以默认取安全侧。
 *
 * 桌面端由 `src/main/index.ts` 在 `interceptConsole()` 之前注入 `app.isPackaged`，
 * 从而恢复「dev 不截断」的原有开发体验。
 */
let logTruncationEnabled = true

/**
 * 由装配层注入「当前是否为生产构建」。
 *
 * 桌面端传 `app.isPackaged`；服务器端不调用即可（默认已是安全侧）。
 * 必须在任何日志产生之前、且在 `interceptConsole()` 之前调用 —— 晚一步
 * 就会有早期日志按错误的档位处理。
 */
export function setLogTruncationEnabled(enabled: boolean): void {
  logTruncationEnabled = enabled
}

class ProxyLogger {
  private config: LoggerConfig
  private logStream: fs.WriteStream | null = null
  private currentLogFile: string = ''
  private currentFileSize: number = 0

  constructor() {
    this.config = { ...DEFAULT_CONFIG }
  }

  /**
   * 开启/配置文件日志。
   *
   * ## `logDir` 现在是「开启文件日志」的必要输入，不再有默认值
   *
   * 原实现在 `enabled && !logDir` 时回落到
   * `path.join(app.getPath('userData'), 'logs', 'proxy')`。该分支被删除，
   * 而不是换个方式保留，理由是它**从来无法执行**：
   *   - 全仓没有任何 `configure()` 调用点（`index.ts:165` 的注释亦如此记载）；
   *   - 且 `DEFAULT_CONFIG.enabled === false`，即使被调用也要显式传 enabled。
   * 也就是说文件日志在生产从未启用过。把一条走不到的路径改写成「服务器上也能
   * 算出目录」，只是凭空造第二个可疑事实源；真要启用文件日志时，调用方本就
   * 该明确说出写到哪 —— 桌面端有 userData，服务器端没有，这正是装配层的决定。
   *
   * 所以：想开文件日志 → 必须同时给 `logDir`。缺失时不静默降级、也不猜路径，
   * 而是保持 enabled=false 并告警 —— 静默猜一个目录会让日志落到没人找的地方。
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }

    if (this.config.enabled && !this.config.logDir) {
      console.warn(
        '[ProxyLogger] configure({ enabled: true }) 缺少 logDir —— ' +
        '文件日志保持关闭（不猜测目录）。调用方须显式提供写入目录。'
      )
      this.config.enabled = false
    }

    if (this.config.enabled) {
      this.initLogFile()
    } else {
      this.close()
    }
  }

  private initLogFile(): void {
    if (!this.config.logDir) return

    try {
      // 确保目录存在
      fs.mkdirSync(this.config.logDir, { recursive: true })

      // 创建新的日志文件
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      this.currentLogFile = path.join(this.config.logDir, `proxy-${timestamp}.log`)
      this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' })
      // 文件流是独立的错误边界:磁盘满 / 权限撤销 / 句柄失效都会**异步** emit('error')。
      // 无监听器时 EventEmitter 直接 throw → 冒到全局 fatal → onFatal 又回来写日志,
      // 可能形成二次异常。故这里就地承接:关掉流并降级为「只进内存 store」,不外泄。
      this.logStream.on('error', (err) => {
        this.logStream = null
        this.config.enabled = false
        // 用 originalError 语义:这条必须能看见,但不能再触发文件写入
        console.error('[ProxyLogger] Log file stream error, file logging disabled:', err)
      })
      this.currentFileSize = 0

      this.info('Logger', 'Log file initialized', { file: this.currentLogFile })
    } catch (error) {
      console.error('[ProxyLogger] Failed to init log file:', error)
    }
  }

  private rotateIfNeeded(): void {
    if (!this.config.maxFileSize || this.currentFileSize < this.config.maxFileSize) {
      return
    }

    this.close()
    this.cleanOldLogs()
    this.initLogFile()
  }

  private cleanOldLogs(): void {
    if (!this.config.logDir || !this.config.maxFiles) return

    try {
      const files = fs.readdirSync(this.config.logDir)
        .filter(f => f.startsWith('proxy-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.config.logDir!, f),
          time: fs.statSync(path.join(this.config.logDir!, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time)

      // 删除超出数量限制的旧文件
      while (files.length >= this.config.maxFiles) {
        const oldest = files.pop()
        if (oldest) {
          fs.unlinkSync(oldest.path)
        }
      }
    } catch (error) {
      console.error('[ProxyLogger] Failed to clean old logs:', error)
    }
  }

  private isWriting = false
  private write(rawEntry: LogEntry): void {
    // 统一脱敏 + Error 正规化：message + data 里的代理账密 / token / password 等，避免明文落盘或上屏
    const norm = normalizeAndRedactLogEntry(rawEntry.message, rawEntry.data)
    const entry: LogEntry = {
      ...rawEntry,
      message: norm.message,
      data: norm.data
    }
    const line = JSON.stringify(entry) + '\n'

    if (this.config.logToConsole) {
      const prefix = `[${entry.level}][${entry.category}]`
      // 设置 flag 防止 console 拦截器重复写入 proxyLogStore
      this.isWriting = true
      if (entry.level === 'ERROR') {
        console.error(prefix, entry.message, entry.data || '')
      } else if (entry.level === 'WARN') {
        console.warn(prefix, entry.message, entry.data || '')
      } else {
        console.log(prefix, entry.message, entry.data || '')
      }
      this.isWriting = false
    }

    if (this.config.enabled && this.logStream) {
      this.logStream.write(line)
      this.currentFileSize += Buffer.byteLength(line)
      this.rotateIfNeeded()
    }

    // 同时添加到内存存储（用于 UI 显示）
    proxyLogStore.add(entry)
  }

  get _isWriting(): boolean { return this.isWriting }

  debug(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      category,
      message,
      data
    })
  }

  info(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category,
      message,
      data
    })
  }

  warn(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      category,
      message,
      data
    })
  }

  error(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      category,
      message,
      data
    })
  }

  // 记录请求
  request(info: {
    path: string
    method: string
    model?: string
    accountId?: string
  }): void {
    this.info('Request', `${info.method} ${info.path}`, info)
  }

  // 记录响应
  response(info: {
    path: string
    status: number
    tokens?: number
    responseTime?: number
    error?: string
  }): void {
    if (info.error) {
      this.error('Response', `${info.path} -> ${info.status}`, info)
    } else {
      this.info('Response', `${info.path} -> ${info.status}`, info)
    }
  }

  // 记录 Token 刷新
  tokenRefresh(accountId: string, success: boolean, error?: string): void {
    if (success) {
      this.info('TokenRefresh', `Account ${accountId} refreshed successfully`)
    } else {
      this.error('TokenRefresh', `Account ${accountId} refresh failed`, { error })
    }
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
  }

  getLogDir(): string | undefined {
    return this.config.logDir
  }
}

// 内存日志存储（用于 UI 显示）
//
// 性能修复要点：
// 1. maxLogs 从 100万 降至 5万 — 避免序列化数百 MB 大对象阻塞主进程
// 2. save() 改为异步 fs.promises.writeFile — 不再 freeze 主进程事件循环
// 3. 单次写盘原子化（in-flight guard）防止并发 writeFile 导致竞态
// 4. 写盘节流间隔从 5s 提至 30s — 大幅降低高频日志场景下的 IO 频率
// 5. 应用退出时通过 flushSaveNow() 强制写盘，防止数据丢失
class ProxyLogStore {
  private logs: LogEntry[] = []
  // 1 万条 × 平均 500 字节 ≈ 5 MB；JSON.stringify 时长 <100ms，长时运行不会因 log stringify 把 IPC 拖到 renderer 失响。
  private maxLogs: number = 10000
  // 单条 log entry 的 data 字段序列化上限：防止一条巨对象(如 1.4MB payload)长期驻留 + 写盘阻塞。
  // 超限 → 截为 preview，保留原 byte size 便于事后定位。
  private readonly maxDataBytes: number = 4096
  // save() safety net：万一 UI/参数改上限导致 snapshot 体积失控，写盘前再限 20MB。
  private readonly maxSnapshotBytes: number = 20 * 1024 * 1024
  private listeners: ((entry: LogEntry) => void)[] = []
  private storePath: string = ''

  private initialized = false
  initialize(userDataPath: string): void {
    if (this.initialized) return
    this.initialized = true
    this.storePath = path.join(userDataPath, 'proxy-logs.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8')
        const parsed = JSON.parse(data)
        // 验证并过滤有效的日志条目
        const filtered = Array.isArray(parsed) ? parsed.filter((log: LogEntry) => {
          if (!log.timestamp || isNaN(new Date(log.timestamp).getTime())) return false
          if (!log.level || !log.category) return false
          return true
        }) : []
        // 加载时也施加上限，避免旧版本遗留的超大日志文件导致首次启动卡顿
        this.logs = filtered.length > this.maxLogs ? filtered.slice(-this.maxLogs) : filtered
        console.log(`[ProxyLogStore] Loaded ${this.logs.length} valid logs`)
      }
    } catch (error) {
      console.error('[ProxyLogStore] Failed to load logs:', error)
      this.logs = []
    }
  }

  /** 异步保存日志（不阻塞主进程事件循环）。并发调用通过 in-flight 标志合并。 */
  private writeInFlight = false
  private writePending = false

  async save(): Promise<void> {
    if (this.writeInFlight) {
      // 已有写盘进行中：标记 pending，让其完成后立即重写最新数据
      this.writePending = true
      return
    }
    this.writeInFlight = true
    try {
      // 拷贝引用快照（不复制数组）以保证 JSON.stringify 期间数据稳定
      let snapshot = this.logs
      let json = JSON.stringify(snapshot)
      // Safety net：万一 UI/参数改上限导致体积失控（>20MB），二次裁剪到后 5000 条重新 stringify
      if (json.length > this.maxSnapshotBytes) {
        const keep = Math.min(snapshot.length, 5000)
        snapshot = snapshot.slice(-keep)
        this.logs = snapshot
        json = JSON.stringify(snapshot)
      }
      await fs.promises.writeFile(this.storePath, json, 'utf-8')
    } catch (error) {
      console.error('[ProxyLogStore] Failed to save logs:', error)
    } finally {
      this.writeInFlight = false
      if (this.writePending) {
        this.writePending = false
        // 用 microtask 而不是立即递归，避免栈深问题
        queueMicrotask(() => { void this.save() })
      }
    }
  }

  private saveTimer: NodeJS.Timeout | null = null

  add(entry: LogEntry): void {
    // 单条 data 字段体积上限：避免一条巨 data（如 1.4MB payload / 长 stack）长期驻留内存与阻塞写盘。
    if (entry.data !== undefined) {
      try {
        const serialized = JSON.stringify(entry.data)
        if (serialized && serialized.length > this.maxDataBytes) {
          entry = {
            ...entry,
            data: {
              __truncated: true,
              originalBytes: serialized.length,
              preview: serialized.slice(0, 200)
            }
          }
        }
      } catch {
        // 循环引用等不可序列化对象：就地标为不可序列化，避免后续 save() 反复抛错
        entry = { ...entry, data: { __unserializable: true } }
      }
    }

    this.logs.push(entry)

    // 超过最大数量时批量原地删除,不用 slice 拷贝整个数组。
    // 老代码 `this.logs = this.logs.slice(-this.maxLogs)` 每次 add 都 O(N) 拷贝
    // 50000 元素,配合 Claude Code reasoning stream 每 token 打 2-4 条 log →
    // 主进程 event loop CPU 100% 卡死,UI 打不开(2026-07-16 用户实测复现)。
    // 现在超阈值 5% 才 splice 一次,后续 (maxLogs * 0.05) 次 add 都不用触发删除,
    // 均摊 O(1)。
    if (this.logs.length > this.maxLogs + Math.floor(this.maxLogs * 0.05)) {
      this.logs.splice(0, this.logs.length - this.maxLogs)
    }

    // 通知监听器（异常隔离）
    for (const listener of this.listeners) {
      try { listener(entry) } catch { /* ignore */ }
    }

    // 节流调度异步保存
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return  // 已调度，等待 flush
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 30_000) // 30 秒批量写盘一次（异步、不阻塞）
  }

  /** 强制立即写盘（用于退出场景），保证最新数据落盘 */
  async flushSaveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  getAll(): LogEntry[] {
    return [...this.logs]
  }

  getLast(count: number): LogEntry[] {
    return this.logs.slice(-count)
  }

  clear(): void {
    this.logs = []
    void this.save()
  }

  count(): number {
    return this.logs.length
  }

  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) {
        this.listeners.splice(index, 1)
      }
    }
  }
}

export const proxyLogStore = new ProxyLogStore()

// 单例导出
export const proxyLogger = new ProxyLogger()

// 拦截主进程 console 输出，自动转发到 proxyLogStore
// 这样所有 console.log/warn/error 都能在日志页面显示
let consoleIntercepted = false
export function interceptConsole(): void {
  if (consoleIntercepted) return
  consoleIntercepted = true

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  const parseConsoleCategory = (args: unknown[]): { category: string; message: string } => {
    const first = String(args[0] || '')
    // 匹配 [Category] 或 [INFO][Category] 格式
    const bracketMatch = first.match(/^\[(?:DEBUG|INFO|WARN|ERROR)\]?\[?([^\]]*)\]?\s*(.*)/)
    if (bracketMatch) {
      return { category: bracketMatch[1] || 'App', message: bracketMatch[2] || '' }
    }
    const simpleMatch = first.match(/^\[([^\]]+)\]\s*(.*)/)
    if (simpleMatch) {
      return { category: simpleMatch[1], message: simpleMatch[2] || '' }
    }
    return { category: 'App', message: first }
  }

  const buildEntry = (args: unknown[], level: 'INFO' | 'WARN' | 'ERROR'): LogEntry => {
    const { category, message } = parseConsoleCategory(args)
    const rest = args.slice(1)
    // data: 后续参数（对象/数组保留结构，字符串拼接）
    let data: unknown = undefined
    if (rest.length === 1) {
      data = rest[0]
    } else if (rest.length > 1) {
      // 如果全是字符串，拼成一个；否则保持数组
      const allStrings = rest.every(r => typeof r === 'string')
      data = allStrings ? (rest as string[]).join(' ') : rest
    }
    // console 拦截路径同样经过统一脱敏 + Error 正规化，消除脱敏旁路与 Error 序列化成 {} 的问题
    const norm = normalizeAndRedactLogEntry(message, data)
    // 生产 gate:INFO 级别 data 强制走 200B preview,消除 stringify 全对象的 CPU 峰值
    // 详见 2026-07-23 frontend-freeze RCA 假设 B
    let finalData = norm.data
    if (logTruncationEnabled && level === 'INFO' && finalData != null) {
      try {
        const s = typeof finalData === 'string' ? finalData : JSON.stringify(finalData)
        if (s.length > 200) {
          finalData = s.slice(0, 200) + '…[+' + (s.length - 200) + 'B]'
        }
      } catch {
        finalData = '[unserializable]'
      }
    }
    return { timestamp: new Date().toISOString(), level, category, message: norm.message, data: finalData }
  }

  console.log = (...args: unknown[]) => {
    originalLog.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'INFO'))
  }

  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'WARN'))
  }

  console.error = (...args: unknown[]) => {
    originalError.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'ERROR'))
  }
}
