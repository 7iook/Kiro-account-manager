// SSOT IPC 出口守卫 · Runtime patch webContents.send 一处收口
//
// 背景（2026-07-23 前端卡死 RCA · 变体扫补漏）:
//   主进程 34 处 `webContents.send()` 直接把大 payload（含完整 request body /
//   history / tools）跨进程克隆到 renderer,前端 setState 累加 → 结构化克隆 +
//   re-render + DOM diff 四重叠加卡死。历史两次修 proxyLogStore 通道未覆盖这
//   条独立通道。
//
// 方案(§4.3 SSOT · 一处收口比 34 处硬改更符合 § 反 Shotgun Surgery):
//   在 createWindow 中对 `mainWindow.webContents.send` 做一次 runtime patch,
//   按通道分类做 size guard,超限简化为元数据摘要 + 定长短字段保留。
//
// 通道分类:
//   LARGE_PAYLOAD_CHANNELS(≤2KB)  = proxy-request / proxy-response / kproxy-* /
//                                  background-refresh-result / background-check-result
//   MEDIUM_CHANNELS(≤8KB)        = proxy-account-update / proxy-account-suspended /
//                                  background-refresh-progress / background-check-progress /
//                                  proxy-webhook-trigger
//   其他通道                       = 直通(短控制信号,定长)
//
// 超限算法:
//   1. 若 payload 是对象,把定长短字段(method / path / status / tokens 等)保留
//   2. 其余字段替换为 { __truncated: true, originalBytes, preview, _keys }
//
// Dev(!app.isPackaged)下 console.warn 告警;prod 静默。
//
// 注意:此模块**不改 34 处 send 调用点**——所有走 `mainWindow.webContents.send`
// 的调用都会被 patch 后的 send 拦截,前端收到的仍是相同 channel + 相同 event
// 语义,只是超限 payload 被替换为摘要。

import type { WebContents } from 'electron'
import { app } from 'electron'

/** 大 payload 通道:上限 2KB(含完整请求体的实时观测事件) */
const LARGE_PAYLOAD_CHANNELS = new Set<string>([
  'proxy-request',
  'proxy-response',
  'kproxy-request',
  'kproxy-response',
  'kproxy-mitm',
  'background-refresh-result',
  'background-check-result'
])

/** 中等控制信号通道:上限 8KB(含 token 等中等长度字段) */
const MEDIUM_CHANNELS = new Set<string>([
  'proxy-account-update',
  'proxy-account-suspended',
  'background-refresh-progress',
  'background-check-progress',
  'proxy-webhook-trigger'
])

const LARGE_LIMIT_BYTES = 2 * 1024   // 2KB
const MEDIUM_LIMIT_BYTES = 8 * 1024  // 8KB

/**
 * 元数据白名单:超限时保留这些字段的原值(定长 / 短字符串 / 数字),
 * 其余字段折叠成 preview 摘要。覆盖 proxy / kproxy / background-* 常见字段。
 */
const SAFE_META_KEYS = new Set<string>([
  // request / response 基础
  'method', 'path', 'status', 'statusCode', 'model', 'accountId', 'id', 'host',
  // token 计数
  'tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  'credits', 'responseTime',
  // 错误
  'error',
  // kproxy
  'timestamp', 'duration', 'isMitm', 'deviceIdReplaced', 'modified',
  // account
  'email', 'reason', 'expiresAt', 'suspendedAt',
  // progress
  'completed', 'total', 'success', 'failed',
  // webhook
  'event', 'success'
])

/** 计算 payload 字节数(用 JSON.stringify 近似,足够做阈值判断) */
function payloadBytes(payload: unknown): number {
  if (payload == null) return 0
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8')
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return 0
  }
}

// ============ IPC 频次追踪(RCA 2026-08-03 UI 卡死诊断)============
// 开关:环境变量 IPC_TRACE=1 启动,或代码里改 ipcTraceEnabled=true。
// 输出两类日志(直接 process.stderr.write,不进 console → log store 循环):
//   1. [IPC-TRACE] 60s 窗口 top10 通道调用次数 + 累计字节
//   2. [IPC-TRACE][BURST] 单通道单秒 >= BURST_THRESHOLD 次 → 即时警告(每秒每通道最多告一次)
// 用途:UI 卡死时后端日志里必有输出,秒查哪个通道被洪泛。
const ipcTraceEnabled = process.env.IPC_TRACE === '1'
const BURST_THRESHOLD_PER_SEC = 100

interface ChannelStat {
  count: number
  bytes: number
  maxBytes: number
}
const channelCounter = new Map<string, ChannelStat>()

interface BurstWindow {
  start: number
  count: number
  warned: boolean
}
const burstWindow = new Map<string, BurstWindow>()

let ipcTraceTimer: NodeJS.Timeout | null = null

function recordIpcTrace(channel: string, bytes: number): void {
  if (!ipcTraceEnabled) return
  // 60s 汇总
  const st = channelCounter.get(channel) || { count: 0, bytes: 0, maxBytes: 0 }
  st.count++
  st.bytes += bytes
  if (bytes > st.maxBytes) st.maxBytes = bytes
  channelCounter.set(channel, st)

  // 1s 爆发检测
  const now = Date.now()
  let w = burstWindow.get(channel)
  if (!w || now - w.start >= 1000) {
    w = { start: now, count: 0, warned: false }
    burstWindow.set(channel, w)
  }
  w.count++
  if (w.count >= BURST_THRESHOLD_PER_SEC && !w.warned) {
    w.warned = true
    try {
      process.stderr.write(`[IPC-TRACE][BURST] channel=${channel} · ${w.count} calls in 1s (>= ${BURST_THRESHOLD_PER_SEC}) · payload bytes so far ~${(st.bytes / 1024).toFixed(1)}KB\n`)
    } catch { /* ignore */ }
  }
}

function startIpcTraceTimer(): void {
  if (ipcTraceTimer || !ipcTraceEnabled) return
  ipcTraceTimer = setInterval(() => {
    if (channelCounter.size === 0) return
    const entries = [...channelCounter.entries()].sort((a, b) => b[1].count - a[1].count)
    const total = entries.reduce((s, [, v]) => s + v.count, 0)
    const summary = entries.slice(0, 10).map(([c, v]) =>
      `${c}=${v.count}(${(v.bytes / 1024).toFixed(1)}KB · max ${(v.maxBytes / 1024).toFixed(1)}KB)`
    ).join(' · ')
    try {
      process.stderr.write(`[IPC-TRACE] 60s window: total=${total} · top10: ${summary}\n`)
    } catch { /* ignore */ }
    channelCounter.clear()
    // 保留 burstWindow(每秒自然滚,不用清)
  }, 60_000)
  // 允许 Node 进程退出(不 keep process alive)
  ipcTraceTimer.unref?.()
  try {
    process.stderr.write(`[IPC-TRACE] enabled · 60s top10 summary + per-channel burst warning (>= ${BURST_THRESHOLD_PER_SEC}/s)\n`)
  } catch { /* ignore */ }
}

/**
 * 超限 payload 简化:
 *   - 若是对象,保留 SAFE_META_KEYS 里的定长短字段,其余字段折叠;
 *   - 若是数组 / 字符串 / 其他类型,整体折叠为摘要块。
 */
function truncatePayload(payload: unknown, originalBytes: number): unknown {
  // 非对象直接摘要
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    let preview = ''
    try {
      preview = JSON.stringify(payload).slice(0, 200)
    } catch {
      preview = String(payload).slice(0, 200)
    }
    return {
      __truncated: true,
      originalBytes,
      preview,
      _keys: [] as string[]
    }
  }

  const obj = payload as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  const droppedKeys: string[] = []

  for (const [k, v] of Object.entries(obj)) {
    if (SAFE_META_KEYS.has(k) && (v == null || typeof v === 'number' || typeof v === 'boolean' ||
      (typeof v === 'string' && v.length <= 256))) {
      kept[k] = v
    } else {
      droppedKeys.push(k)
    }
  }

  let preview = ''
  try {
    preview = JSON.stringify(obj).slice(0, 200)
  } catch {
    preview = '[unserializable]'
  }

  return {
    ...kept,
    __truncated: true,
    originalBytes,
    preview,
    _keys: droppedKeys
  }
}

/**
 * 在 webContents 上安装 IPC size guard。
 * 幂等:重复安装会跳过(检测 __installedIpcSizeGuard 标记)。
 */
export function installIpcSizeGuard(webContents: WebContents): void {
  // 幂等
  const wc = webContents as WebContents & { __installedIpcSizeGuard?: boolean }
  if (wc.__installedIpcSizeGuard) return
  wc.__installedIpcSizeGuard = true

  // 首次安装时启动 IPC 频次追踪 timer(若 IPC_TRACE=1)
  startIpcTraceTimer()

  const originalSend = webContents.send.bind(webContents)
  const isDev = !app.isPackaged

  webContents.send = (channel: string, ...args: unknown[]): void => {
    // IPC 频次埋点(先算 bytes,便于爆发警告一起报出)
    // 注意:所有通道都记(不只 LARGE/MEDIUM),便于发现意外通道的洪泛
    if (ipcTraceEnabled) {
      recordIpcTrace(channel, args.length > 0 ? payloadBytes(args[0]) : 0)
    }

    // 单参数:典型情况(payload 为 args[0])
    // 多参数:直接透传第一个做判断(其余不动)
    if (args.length === 0) {
      originalSend(channel, ...args)
      return
    }

    // 只在明确分类的通道上做守卫,其他通道直通
    let limit: number
    if (LARGE_PAYLOAD_CHANNELS.has(channel)) {
      limit = LARGE_LIMIT_BYTES
    } else if (MEDIUM_CHANNELS.has(channel)) {
      limit = MEDIUM_LIMIT_BYTES
    } else {
      originalSend(channel, ...args)
      return
    }

    const payload = args[0]
    const bytes = payloadBytes(payload)
    if (bytes <= limit) {
      originalSend(channel, ...args)
      return
    }

    // 超限 → 替换 args[0] 为 truncated payload,其他参数保持
    const truncated = truncatePayload(payload, bytes)
    if (isDev) {
      // 用原始 process.stdout 避免走 console → 回环
      // console.warn 会进 interceptConsole,可能形成 IPC → log store → 又发 IPC 的循环
      // 这里直接用 process.stderr 写一行,不进日志系统
      try {
        process.stderr.write(`[emitToRenderer] channel=${channel} truncated ${bytes}B → ~${payloadBytes(truncated)}B\n`)
      } catch {
        // ignore
      }
    }
    const newArgs = [truncated, ...args.slice(1)]
    originalSend(channel, ...newArgs)
  }
}

// 导出常量供测试使用
export const _internal = {
  LARGE_PAYLOAD_CHANNELS,
  MEDIUM_CHANNELS,
  LARGE_LIMIT_BYTES,
  MEDIUM_LIMIT_BYTES,
  SAFE_META_KEYS,
  payloadBytes,
  truncatePayload
}
