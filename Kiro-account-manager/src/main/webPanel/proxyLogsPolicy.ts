import type { LogEntry } from '../proxy/logger'
import { normalizeAndRedactLogEntry, redactString } from '../utils/redact'

export const PANEL_PROXY_LOG_DEFAULT_LIMIT = 50
export const PANEL_PROXY_LOG_MAX_LIMIT = 100

export interface PanelProxyLogEntry {
  timestamp: string
  level: LogEntry['level']
  category: string
  message: string
}

export interface PanelProxyLogPage {
  total: number
  /**
   * 下一页在当前 store 快照中的排他结束下标；null 表示已经到最早一条。
   * 使用绝对下标而非“跳过 N 条”，新日志追加时不会让下一页整体向后漂移。
   */
  nextCursor: number | null
  entries: PanelProxyLogEntry[]
}

export type PanelProxyLogQuery =
  | { ok: true; limit: number; cursor?: number }
  | { ok: false; message: string }

function parseNonNegativeInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parsePanelProxyLogQuery(query: Record<string, string>): PanelProxyLogQuery {
  let limit = PANEL_PROXY_LOG_DEFAULT_LIMIT
  if (query.limit !== undefined) {
    const parsed = parseNonNegativeInteger(query.limit)
    if (parsed === null || parsed < 1 || parsed > PANEL_PROXY_LOG_MAX_LIMIT) {
      return {
        ok: false,
        message: `limit 必须是 1 到 ${PANEL_PROXY_LOG_MAX_LIMIT} 的整数。`
      }
    }
    limit = parsed
  }

  if (query.cursor === undefined) return { ok: true, limit }
  const cursor = parseNonNegativeInteger(query.cursor)
  if (cursor === null) return { ok: false, message: 'cursor 必须是非负整数。' }
  return { ok: true, limit, cursor }
}

function redactPanelLogText(value: unknown): string {
  return redactString(String(value ?? ''))
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
    .replace(
      /("?(?:access_?token|refresh_?token|id_?token|csrf_?token|password|api_?key|client_?secret|secret|epin)"?\s*[:=]\s*"?)([^",}\s]+)("?)/gi,
      '$1***$3'
    )
}

function projectEntry(entry: LogEntry): PanelProxyLogEntry | null {
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) return null
  const normalized = normalizeAndRedactLogEntry(entry.message, entry.data)
  const level =
    entry.level === 'DEBUG' ||
    entry.level === 'INFO' ||
    entry.level === 'WARN' ||
    entry.level === 'ERROR'
      ? entry.level
      : 'INFO'
  return {
    timestamp,
    level,
    category: redactPanelLogText(entry.category ?? 'General').slice(0, 120),
    message: redactPanelLogText(normalized.message).slice(0, 4000)
  }
}

/**
 * 响应只白名单投影 timestamp/level/category/message。
 *
 * `data` 即使已在 producer 入库时脱敏也永不下发：它是任意深层对象/数组，字段名可能是
 * 普通的 key/password，不能把“通用 redactor 恰好识别”当成手机端保密边界。
 */
export function projectPanelProxyLogs(
  allLogs: LogEntry[],
  query: { limit: number; cursor?: number }
): PanelProxyLogPage {
  const total = allLogs.length
  const end = Math.min(query.cursor ?? total, total)
  const start = Math.max(0, end - query.limit)
  const entries = allLogs
    .slice(start, end)
    .reverse()
    .map(projectEntry)
    .filter((entry): entry is PanelProxyLogEntry => entry !== null)
  return {
    total,
    nextCursor: start > 0 ? start : null,
    entries
  }
}
