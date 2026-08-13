import type { AccountsBlob } from '../accountService/state'

export const PANEL_UPSTREAM_PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const
export type PanelUpstreamProxyProtocol = (typeof PANEL_UPSTREAM_PROXY_PROTOCOLS)[number]
export type PanelUpstreamProxyStatus = 'untested' | 'testing' | 'alive' | 'dead' | 'slow'

export interface PanelUpstreamProxyView {
  id: string
  protocol: PanelUpstreamProxyProtocol
  host: string
  port: number
  label?: string
  status: PanelUpstreamProxyStatus
  enabled: boolean
  /**
   * 只能说明内部条目是否带用户名或密码，绝不返回用户名、密码或完整 URL。
   * 字段名刻意不用 auth/token/key，避免通用响应脱敏器把这个布尔状态误判成秘密。
   */
  hasCredentials: boolean
  usedCount: number
  failCount: number
}

export interface PanelUpstreamProxyPoolView {
  revision: number
  entries: PanelUpstreamProxyView[]
}

export interface PanelUpstreamProxyMutationView extends PanelUpstreamProxyPoolView {
  /** 盘上写入已成功，但正在运行的反代账号池未能立即重建。 */
  accountPoolSyncPending: boolean
}

export interface ParsedUpstreamProxy {
  url: string
  protocol: PanelUpstreamProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
}

export interface PanelUpstreamProxyCreateRequest {
  expectedRevision: number
  proxy: ParsedUpstreamProxy
  label?: string
  enabled: boolean
}

export interface PanelUpstreamProxyUpdateRequest {
  expectedRevision: number
  changes: {
    proxy?: ParsedUpstreamProxy
    label?: string
    enabled?: boolean
  }
}

export type PanelUpstreamProxyDeleteRequest = { expectedRevision: number }

export type PanelUpstreamValidation<T> = { ok: true; value: T } | { ok: false; message: string }

type UnknownRecord = Record<string, unknown>

const PANEL_UPSTREAM_PROXY_STATUSES = new Set<PanelUpstreamProxyStatus>([
  'untested',
  'testing',
  'alive',
  'dead',
  'slow'
])
const PANEL_UPSTREAM_PROXY_PROTOCOL_SET = new Set<string>(PANEL_UPSTREAM_PROXY_PROTOCOLS)

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function hasOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function readExpectedRevision(value: unknown): PanelUpstreamValidation<number> {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return { ok: false, message: '缺少有效的 expectedRevision，请刷新代理池后重试。' }
  }
  return { ok: true, value: value as number }
}

function readLabel(value: unknown): PanelUpstreamValidation<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false, message: 'label 必须是字符串。' }
  const label = value.trim()
  if (label.length > 100) return { ok: false, message: 'label 不能超过 100 个字符。' }
  return { ok: true, value: label || undefined }
}

function decodeUrlPart(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function explicitPortFromRawUrl(raw: string): number | null {
  const authorityWithCredentials = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0]
  const at = authorityWithCredentials.lastIndexOf('@')
  const authority = at >= 0 ? authorityWithCredentials.slice(at + 1) : authorityWithCredentials
  const match = authority.startsWith('[')
    ? authority.match(/^\[[^\]]+\]:(\d+)$/)
    : authority.match(/:(\d+)$/)
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * 手机端只接受明确带协议与端口的完整 URL。桌面端还支持若干无协议简写，但在手机
 * 密码输入框中猜测冒号分别属于 host、用户名还是密码会制造歧义，故不复制那套启发式。
 */
export function parsePanelUpstreamProxyUrl(input: unknown): ParsedUpstreamProxy | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw.length === 0 || raw.length > 2048 || !raw.includes('://')) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  const protocol = parsed.protocol.slice(0, -1).toLowerCase()
  if (!PANEL_UPSTREAM_PROXY_PROTOCOL_SET.has(protocol)) return null
  const port = explicitPortFromRawUrl(raw)
  if (!parsed.hostname || port === null) return null
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null
  const username = decodeUrlPart(parsed.username)
  const password = decodeUrlPart(parsed.password)
  if (username === null || password === null || (password && !username)) return null

  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : ''
  const normalized = `${protocol}://${auth}${parsed.hostname}:${port}`

  return {
    url: normalized,
    protocol: protocol as PanelUpstreamProxyProtocol,
    host: parsed.hostname,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  }
}

export function validatePanelUpstreamProxyCreate(
  input: unknown
): PanelUpstreamValidation<PanelUpstreamProxyCreateRequest> {
  const body = asRecord(input)
  const allowed = new Set(['expectedRevision', 'url', 'label', 'enabled'])
  if (!body || !hasOnlyKeys(body, allowed)) {
    return { ok: false, message: '新增代理请求字段无效或包含不支持的字段。' }
  }
  const revision = readExpectedRevision(body.expectedRevision)
  if (!revision.ok) return revision
  const proxy = parsePanelUpstreamProxyUrl(body.url)
  if (!proxy) {
    return {
      ok: false,
      message: '代理 URL 必须是带显式端口的 http、https、socks4 或 socks5 完整 URL。'
    }
  }
  const label = readLabel(body.label)
  if (!label.ok) return label
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { ok: false, message: 'enabled 必须是布尔值。' }
  }
  return {
    ok: true,
    value: {
      expectedRevision: revision.value,
      proxy,
      ...(label.value ? { label: label.value } : {}),
      enabled: body.enabled !== false
    }
  }
}

export function validatePanelUpstreamProxyUpdate(
  input: unknown
): PanelUpstreamValidation<PanelUpstreamProxyUpdateRequest> {
  const body = asRecord(input)
  if (!body || !hasOnlyKeys(body, new Set(['expectedRevision', 'changes']))) {
    return { ok: false, message: '编辑代理请求字段无效或包含不支持的字段。' }
  }
  const revision = readExpectedRevision(body.expectedRevision)
  if (!revision.ok) return revision
  const changes = asRecord(body.changes)
  const allowedChanges = new Set(['url', 'label', 'enabled'])
  if (!changes || Object.keys(changes).length === 0 || !hasOnlyKeys(changes, allowedChanges)) {
    return { ok: false, message: 'changes 必须包含 url、label 或 enabled 中的至少一项。' }
  }

  const value: PanelUpstreamProxyUpdateRequest['changes'] = {}
  if (Object.prototype.hasOwnProperty.call(changes, 'url')) {
    const proxy = parsePanelUpstreamProxyUrl(changes.url)
    if (!proxy) {
      return {
        ok: false,
        message: '新代理 URL 必须是带显式端口的 http、https、socks4 或 socks5 完整 URL。'
      }
    }
    value.proxy = proxy
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'label')) {
    const label = readLabel(changes.label)
    if (!label.ok) return label
    value.label = label.value
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'enabled')) {
    if (typeof changes.enabled !== 'boolean') {
      return { ok: false, message: 'enabled 必须是布尔值。' }
    }
    value.enabled = changes.enabled
  }
  return { ok: true, value: { expectedRevision: revision.value, changes: value } }
}

export function validatePanelUpstreamProxyDelete(
  input: unknown
): PanelUpstreamValidation<PanelUpstreamProxyDeleteRequest> {
  const body = asRecord(input)
  if (!body || !hasOnlyKeys(body, new Set(['expectedRevision']))) {
    return { ok: false, message: '删除代理请求字段无效或包含不支持的字段。' }
  }
  const revision = readExpectedRevision(body.expectedRevision)
  return revision.ok ? { ok: true, value: { expectedRevision: revision.value } } : revision
}

function poolRecord(blob: unknown): UnknownRecord {
  return asRecord(asRecord(blob)?.proxyPool) ?? {}
}

function entryEndpoint(entry: UnknownRecord): ParsedUpstreamProxy | null {
  const parsed = parsePanelUpstreamProxyUrl(entry.url)
  if (parsed) return parsed
  if (
    typeof entry.protocol !== 'string' ||
    !PANEL_UPSTREAM_PROXY_PROTOCOL_SET.has(entry.protocol) ||
    typeof entry.host !== 'string' ||
    !Number.isInteger(entry.port) ||
    (entry.port as number) < 1 ||
    (entry.port as number) > 65535
  ) {
    return null
  }
  return {
    url: '',
    protocol: entry.protocol as PanelUpstreamProxyProtocol,
    host: entry.host,
    port: entry.port as number,
    ...(typeof entry.username === 'string' && entry.username ? { username: entry.username } : {}),
    ...(typeof entry.password === 'string' && entry.password ? { password: entry.password } : {})
  }
}

function endpointKey(proxy: ParsedUpstreamProxy): string {
  return `${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}|${proxy.username ?? ''}`
}

export function hasDuplicatePanelUpstreamProxy(
  blob: unknown,
  proxy: ParsedUpstreamProxy,
  exceptId?: string
): boolean {
  const key = endpointKey(proxy)
  return Object.entries(poolRecord(blob)).some(([id, value]) => {
    if (id === exceptId) return false
    const entry = asRecord(value)
    const parsed = entry ? entryEndpoint(entry) : null
    return parsed ? endpointKey(parsed) === key : false
  })
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function projectEntry(id: string, value: unknown): PanelUpstreamProxyView | null {
  const entry = asRecord(value)
  if (!entry) return null
  const endpoint = entryEndpoint(entry)
  if (!endpoint) return null
  const status = PANEL_UPSTREAM_PROXY_STATUSES.has(entry.status as PanelUpstreamProxyStatus)
    ? (entry.status as PanelUpstreamProxyStatus)
    : 'untested'
  const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 100) : ''
  return {
    id,
    protocol: endpoint.protocol,
    host: endpoint.host,
    port: endpoint.port,
    ...(label ? { label } : {}),
    status,
    enabled: entry.enabled !== false,
    hasCredentials: Boolean(endpoint.username || endpoint.password),
    usedCount: finiteCount(entry.usedCount),
    failCount: finiteCount(entry.failCount)
  }
}

export function projectPanelUpstreamProxyPool(blob: unknown): PanelUpstreamProxyPoolView {
  const root = asRecord(blob)
  const revision =
    Number.isInteger(root?.revision) && (root?.revision as number) >= 0
      ? (root?.revision as number)
      : 0
  const entries = Object.entries(poolRecord(blob))
    .map(([id, value]) => projectEntry(id, value))
    .filter((entry): entry is PanelUpstreamProxyView => entry !== null)
  return { revision, entries }
}

export function addPanelUpstreamProxy(
  prev: AccountsBlob & { revision: number },
  id: string,
  request: PanelUpstreamProxyCreateRequest,
  now: number
): AccountsBlob {
  const proxyPool = { ...poolRecord(prev) }
  proxyPool[id] = {
    id,
    ...request.proxy,
    ...(request.label ? { label: request.label } : {}),
    source: '手机面板',
    status: 'untested',
    usedCount: 0,
    failCount: 0,
    enabled: request.enabled,
    createdAt: now
  }
  return { ...prev, proxyPool }
}

export function updatePanelUpstreamProxy(
  prev: AccountsBlob & { revision: number },
  id: string,
  request: PanelUpstreamProxyUpdateRequest
): AccountsBlob {
  const proxyPool = { ...poolRecord(prev) }
  const current = asRecord(proxyPool[id])
  if (!current) return prev
  const updated: UnknownRecord = { ...current }
  if (request.changes.proxy) {
    delete updated.username
    delete updated.password
    Object.assign(updated, request.changes.proxy, {
      status: 'untested',
      usedCount: 0,
      failCount: 0
    })
    delete updated.latencyMs
    delete updated.lastTestedAt
    delete updated.lastError
  }
  if (Object.prototype.hasOwnProperty.call(request.changes, 'label')) {
    if (request.changes.label) updated.label = request.changes.label
    else delete updated.label
  }
  if (typeof request.changes.enabled === 'boolean') {
    updated.enabled = request.changes.enabled
  }
  proxyPool[id] = updated
  return { ...prev, proxyPool }
}

export function deletePanelUpstreamProxy(
  prev: AccountsBlob & { revision: number },
  id: string
): AccountsBlob {
  const proxyPool = { ...poolRecord(prev) }
  delete proxyPool[id]
  const bindings = asRecord(prev.accountProxyBindings)
  if (!bindings) return { ...prev, proxyPool }
  const accountProxyBindings = { ...bindings }
  for (const [accountId, proxyId] of Object.entries(accountProxyBindings)) {
    if (proxyId === id) delete accountProxyBindings[accountId]
  }
  return { ...prev, proxyPool, accountProxyBindings }
}

export function hasPanelUpstreamProxy(blob: unknown, id: string): boolean {
  return asRecord(poolRecord(blob)[id]) !== null
}
