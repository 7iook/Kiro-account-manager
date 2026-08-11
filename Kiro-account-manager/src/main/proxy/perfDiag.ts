/**
 * 性能诊断落盘(perf diag log)—— 按天 append-only JSONL。
 *
 * ## 为什么需要它,而不是复用现有两个日志通道
 *
 * 既有通道都无法回答「429 机制是什么」「首响慢在哪一段」:
 * - `ProxyLogStore`(`proxy-logs.json`):内存 10000 条**滚动窗口**,实测 40 分钟
 *   即写满并开始丢弃最旧记录。跨小时/跨天对比(白天限流 vs 凌晨空闲)必然丢数据。
 * - 请求日志(`proxy-request-logs.json`):只保留最近 N 条,且是给界面看的聚合视图。
 *
 * 本模块是**第三条通道**,职责单一:把原始事件按天 append 到 JSONL,不滚动、不聚合、
 * 不参与 UI 渲染,专供事后用脚本统计(p50/p95、按账号分组、按小时分桶)。
 *
 * ## 设计约束
 *
 * 1. **默认关闭**,零开销 —— 关闭时不建流、不写盘、不拼 JSON 字符串。
 *    观测代码本身不能成为性能问题(观测的侵入代价常被低估)。
 * 2. **写失败绝不影响请求** —— 磁盘满/权限撤销只关掉本通道并记一次告警,
 *    不抛异常、不重试、不阻塞出站请求。
 * 3. **按天分文件** —— 便于「取昨天全天」这类操作,也天然限制单文件体积。
 * 4. **每行一个完整 JSON 对象** —— 追加写天然原子(单次 write 小于 PIPE_BUF),
 *    进程崩溃最坏丢最后一行,不会损坏已写内容。
 */
import * as fs from 'fs'
import * as path from 'path'

/** 一次上游尝试(attempt 级):每次真正发出 HTTP 请求都记一条。 */
export interface PerfAttemptRecord {
  kind: 'attempt'
  /** ISO 时间戳 */
  ts: string
  /** 端点名(KiroRuntime-US / AmazonQ-EU ...) */
  endpoint: string
  /** 数据面 region */
  region?: string
  /** HTTP 状态码 */
  status: number
  /** fetch 发出 → response 返回的耗时 ms(含上传 + 服务端首字节) */
  ttfbMs: number
  /** 出站 payload 字节数 */
  payloadBytes: number
  /** 该端点内的第几次 429 重试(0 = 首次尝试) */
  retryIndex: number
  /** 本次尝试前等待了多久 ms(429 backoff);首次为 0 */
  waitedMs: number
  /** 账号标识(邮箱或 id 前缀) */
  account?: string
  via: 'proxy' | 'direct'
}

/** 一个客户端请求(request 级):端到端结果与内部累计代价。 */
export interface PerfRequestRecord {
  kind: 'request'
  ts: string
  path: string
  model?: string
  status: number
  /** 首 token 延迟 ms(仅流式;非流式为 null) */
  ttftMs: number | null
  /** 端到端耗时 ms */
  totalMs: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  /** 上游尝试总次数 */
  attempts: number
  /** 其中 429 次数 */
  rateLimited: number
  /** 被拒后重传的累计字节数 */
  wastedUploadBytes: number
  account?: string
  error?: string
}

export type PerfRecord = PerfAttemptRecord | PerfRequestRecord

class PerfDiagLogger {
  private enabled = false
  private dir: string | null = null
  private stream: fs.WriteStream | null = null
  private streamDay: string | null = null
  private warned = false

  /**
   * 开启/关闭。`userDataPath` 由装配层(index.ts)提供 —— 本模块不猜路径,
   * 也不 import electron(保持 kernel 可在无 Electron 环境下运行)。
   */
  configure(enabled: boolean, userDataPath?: string): void {
    if (enabled && !userDataPath) {
      console.warn('[PerfDiag] 开启需要 userDataPath,保持关闭(不猜测目录)')
      this.enabled = false
      this.close()
      return
    }
    const changed = this.enabled !== enabled
    this.enabled = enabled
    if (enabled) {
      this.dir = path.join(userDataPath!, 'perf-logs')
      if (changed) console.log(`[PerfDiag] 性能诊断落盘已开启 → ${this.dir}`)
    } else {
      if (changed) console.log('[PerfDiag] 性能诊断落盘已关闭')
      this.close()
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 当前落盘文件路径(未开启时 null) —— 供界面显示"日志在哪"。 */
  currentFile(): string | null {
    if (!this.enabled || !this.dir) return null
    return path.join(this.dir, `perf-${this.today()}.jsonl`)
  }

  private today(): string {
    // 本地日期(不是 UTC):用户按"今天下午"回溯,应与其墙上时钟一致。
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  }

  /** 跨天时切换到新文件。 */
  private ensureStream(): fs.WriteStream | null {
    if (!this.enabled || !this.dir) return null
    const day = this.today()
    if (this.stream && this.streamDay === day) return this.stream
    this.close()
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const file = path.join(this.dir, `perf-${day}.jsonl`)
      this.stream = fs.createWriteStream(file, { flags: 'a' })
      this.streamDay = day
      // 磁盘满 / 权限撤销是异步 error:无监听器会直接 throw 冒到全局。
      // 就地承接 → 关闭本通道,绝不影响出站请求。
      this.stream.on('error', (err) => {
        this.stream = null
        this.enabled = false
        if (!this.warned) {
          this.warned = true
          console.error(`[PerfDiag] 写盘失败,已关闭诊断落盘: ${err.message}`)
        }
      })
      return this.stream
    } catch (err) {
      this.enabled = false
      if (!this.warned) {
        this.warned = true
        console.error(`[PerfDiag] 无法创建日志文件,已关闭诊断落盘: ${(err as Error).message}`)
      }
      return null
    }
  }

  /** 写一条记录。关闭时立即返回(零开销:调用方也应先判 isEnabled 再拼对象)。 */
  write(record: PerfRecord): void {
    if (!this.enabled) return
    const s = this.ensureStream()
    if (!s) return
    try {
      s.write(JSON.stringify(record) + '\n')
    } catch {
      // 同步 write 的异常(极少见)同样不外泄
    }
  }

  close(): void {
    if (this.stream) {
      try { this.stream.end() } catch { /* 忽略 */ }
      this.stream = null
    }
    this.streamDay = null
  }
}

export const perfDiag = new PerfDiagLogger()
