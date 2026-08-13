import { createHash } from 'node:crypto'
import type { ProxyConfig } from '../proxy/types'

export interface PanelProxyConfigView {
  editable: { logRequests: boolean }
  readOnly: Array<{ key: string; value: unknown; reason: string }>
  apiKeys: { configured: boolean; count: number; hints: string[] }
  proxyListen: { host: string; port: number; requiresRestart: boolean }
}

export interface PanelProxyConfigPatch {
  changes: Record<string, unknown>
}

export interface PanelProxyConfigResult {
  appliedFields: string[]
  requiresRestart: boolean
  config: PanelProxyConfigView
}

export const PANEL_PROXY_PORT_CONFIRMATION = 'CHANGE_PROXY_PORT'
export const PANEL_PROXY_API_KEY_CREATE_CONFIRMATION = 'CREATE_PROXY_API_KEY'
export const PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION = 'REVOKE_PROXY_API_KEY'

export interface PanelProxyPortChangeRequest {
  port: number
  expectedCurrentPort: number
  confirmation: typeof PANEL_PROXY_PORT_CONFIRMATION
}

export interface PanelProxyPortChangeResult {
  previousPort: number
  port: number
  restarted: boolean
  requiresRestart: false
  config: PanelProxyConfigView
}

export interface PanelProxyApiKeyCreateRequest {
  confirmation: typeof PANEL_PROXY_API_KEY_CREATE_CONFIRMATION
}

export interface PanelProxyApiKeyCreateResult {
  id: string
  /** 只在创建成功的这一次响应出现；普通 GET、错误和审计均不得包含。 */
  key: string
  hint: string
  createdAt: number
  config: PanelProxyConfigView
}

export interface PanelProxyApiKeyVerifyRequest {
  id: string
}

export interface PanelProxyApiKeyVerifyResult {
  id: string
  verified: true
  verifiedAt: number
  config: PanelProxyConfigView
}

export interface PanelProxyApiKeyRevokeRequest {
  /** 普通 key 的 UUID，或旧版单 key 的固定选择器 `legacy`。 */
  id: string
  replacementId: string
  confirmation: typeof PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION
}

export interface PanelProxyApiKeyRevokeResult {
  revokedId: string
  replacementId: string
  config: PanelProxyConfigView
}

export interface PanelProxyApiKeyListItem {
  id: string
  hint: string
  createdAt: number | null
  verifiedAt: number | null
}

export interface PanelProxyApiKeyListResult {
  keys: PanelProxyApiKeyListItem[]
}

export type PanelProxyConfigValidation<T> =
  | { ok: true; value: T; fields: string[] }
  | { ok: false; message: string; fields: string[] }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function panelProxyApiKeyHint(id: string): string {
  return `key:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

const READ_ONLY_REASONS = {
  logStreamEvents: '流式事件日志会显著放大日志量，只能在桌面端或配置文件中修改。',
  enablePerfDiagLog: '性能诊断会持续写入按天 JSONL 文件，只能在桌面端或配置文件中修改。',
  enableAuditLog: '数据面审计开关只读；手机配置审计始终开启且不受此开关控制。',
  modelMappings: '模型映射影响全部客户端路由，按决策仅提供只读摘要。',
  agentMode: 'Agent 模式影响请求语义，按决策仅提供只读展示。',
  payloadSizeLimitKB: 'Payload 上限影响请求完整性，按决策仅提供只读展示。'
} as const

export function projectPanelProxyConfig(
  config: ProxyConfig,
  requiresRestart = false
): PanelProxyConfigView {
  const activeKeys = (config.apiKeys ?? []).filter((entry) => entry.enabled && entry.key)
  const hints = activeKeys.map((entry) => panelProxyApiKeyHint(entry.id))
  if (config.apiKey) hints.unshift('legacy:configured')
  return {
    editable: { logRequests: config.logRequests === true },
    readOnly: [
      {
        key: 'logStreamEvents',
        value: config.logStreamEvents ?? false,
        reason: READ_ONLY_REASONS.logStreamEvents
      },
      {
        key: 'enablePerfDiagLog',
        value: config.enablePerfDiagLog ?? false,
        reason: READ_ONLY_REASONS.enablePerfDiagLog
      },
      {
        key: 'enableAuditLog',
        value: config.enableAuditLog ?? false,
        reason: READ_ONLY_REASONS.enableAuditLog
      },
      {
        key: 'modelMappings',
        value: { configured: (config.modelMappings?.length ?? 0) > 0, count: config.modelMappings?.length ?? 0 },
        reason: READ_ONLY_REASONS.modelMappings
      },
      {
        key: 'agentMode',
        value: config.agentMode ?? 'vibe',
        reason: READ_ONLY_REASONS.agentMode
      },
      {
        key: 'payloadSizeLimitKB',
        value: config.payloadSizeLimitKB ?? null,
        reason: READ_ONLY_REASONS.payloadSizeLimitKB
      }
    ],
    apiKeys: {
      configured: hints.length > 0,
      count: hints.length,
      hints
    },
    proxyListen: {
      host: config.host,
      port: config.port,
      requiresRestart
    }
  }
}

export function projectPanelProxyApiKeyList(config: ProxyConfig): PanelProxyApiKeyListResult {
  const keys: PanelProxyApiKeyListItem[] = (config.apiKeys ?? [])
    .filter((entry) => entry.enabled && entry.key)
    .map((entry) => ({
      id: entry.id,
      hint: panelProxyApiKeyHint(entry.id),
      createdAt: entry.createdAt,
      verifiedAt:
        typeof entry.lastUsedAt === 'number' && entry.lastUsedAt >= entry.createdAt
          ? entry.lastUsedAt
          : null
    }))
  if (config.apiKey) {
    keys.unshift({
      id: 'legacy',
      hint: 'legacy:configured',
      createdAt: null,
      verifiedAt: null
    })
  }
  return { keys }
}

function exactObject(input: unknown, keys: string[]): input is Record<string, unknown> {
  if (!isPlainRecord(input)) return false
  const actual = Object.keys(input)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function validApiKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

export function validatePanelProxyPortChange(
  input: unknown,
  currentPort: number
): PanelProxyConfigValidation<PanelProxyPortChangeRequest> {
  if (!exactObject(input, ['port', 'expectedCurrentPort', 'confirmation'])) {
    return { ok: false, message: '端口动作请求字段不完整或包含额外字段。', fields: ['port'] }
  }
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65535) {
    return { ok: false, message: 'port 必须是 1 到 65535 的整数。', fields: ['port'] }
  }
  if (!Number.isInteger(input.expectedCurrentPort) || input.expectedCurrentPort !== currentPort) {
    return {
      ok: false,
      message: '当前端口已变化，请刷新配置后重新确认。',
      fields: ['port']
    }
  }
  if (input.port === currentPort) {
    return { ok: false, message: '新端口必须与当前端口不同。', fields: ['port'] }
  }
  if (input.confirmation !== PANEL_PROXY_PORT_CONFIRMATION) {
    return { ok: false, message: '端口变更缺少有效确认词。', fields: ['port'] }
  }
  return {
    ok: true,
    value: {
      port: input.port as number,
      expectedCurrentPort: input.expectedCurrentPort as number,
      confirmation: PANEL_PROXY_PORT_CONFIRMATION
    },
    fields: ['port']
  }
}

export function validatePanelProxyApiKeyCreate(
  input: unknown
): PanelProxyConfigValidation<PanelProxyApiKeyCreateRequest> {
  if (
    !exactObject(input, ['confirmation']) ||
    input.confirmation !== PANEL_PROXY_API_KEY_CREATE_CONFIRMATION
  ) {
    return {
      ok: false,
      message: '新增 API Key 请求必须只包含有效确认词；密钥只能由服务端生成。',
      fields: ['apiKeys']
    }
  }
  return {
    ok: true,
    value: { confirmation: PANEL_PROXY_API_KEY_CREATE_CONFIRMATION },
    fields: ['apiKeys']
  }
}

export function validatePanelProxyApiKeyVerify(
  input: unknown
): PanelProxyConfigValidation<PanelProxyApiKeyVerifyRequest> {
  if (!exactObject(input, ['id']) || !validApiKeyId(input.id) || input.id === 'legacy') {
    return {
      ok: false,
      message: '验证动作需要一个有效的新 API Key id。',
      fields: ['apiKeys']
    }
  }
  return { ok: true, value: { id: input.id }, fields: ['apiKeys'] }
}

export function validatePanelProxyApiKeyRevoke(
  input: unknown
): PanelProxyConfigValidation<PanelProxyApiKeyRevokeRequest> {
  if (
    !exactObject(input, ['id', 'replacementId', 'confirmation']) ||
    !(input.id === 'legacy' || validApiKeyId(input.id)) ||
    !validApiKeyId(input.replacementId) ||
    input.replacementId === 'legacy' ||
    input.id === input.replacementId ||
    input.confirmation !== PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION
  ) {
    return {
      ok: false,
      message: '吊销动作需要不同的旧 key、新 key 以及有效确认词。',
      fields: ['apiKeys']
    }
  }
  return {
    ok: true,
    value: {
      id: input.id,
      replacementId: input.replacementId,
      confirmation: PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION
    },
    fields: ['apiKeys']
  }
}

export function validatePanelProxyConfigPatch(
  input: unknown
): PanelProxyConfigValidation<PanelProxyConfigPatch> {
  if (!isPlainRecord(input)) {
    return { ok: false, message: '请求体必须是普通 JSON 对象。', fields: [] }
  }
  const topLevelKeys = Object.keys(input)
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'changes') {
    return {
      ok: false,
      message: '请求体只能包含 changes 字段。',
      fields: []
    }
  }
  const changes = input.changes
  if (!isPlainRecord(changes)) {
    return { ok: false, message: 'changes 必须是普通 JSON 对象。', fields: [] }
  }
  const fields = Object.keys(changes)
  if (fields.length === 0) {
    return { ok: false, message: 'changes 至少要包含一个可修改字段。', fields: [] }
  }
  const unknown = fields.find((field) => field !== 'logRequests')
  if (unknown) {
    const knownFieldNames = new Set([
      'port',
      'apiKey',
      'apiKeys',
      'trustedTlsProxyIPs',
      'adminKey',
      ...Object.keys(READ_ONLY_REASONS)
    ])
    const safeName = knownFieldNames.has(unknown) ? unknown : '名称已隐藏的字段'
    const reason =
      unknown === 'port'
        ? '反代端口只能使用专用二次确认动作修改。'
        : unknown === 'apiKey' || unknown === 'apiKeys'
          ? '反代 API Key 只能使用专用新增、验证、吊销动作修改。'
          : unknown in READ_ONLY_REASONS
            ? READ_ONLY_REASONS[unknown as keyof typeof READ_ONLY_REASONS]
            : ['trustedTlsProxyIPs', 'adminKey'].includes(unknown)
              ? '该字段属于控制面或部署信任边界，禁止远程修改。'
              : '该字段不在远程配置白名单中。'
    return {
      ok: false,
      message: `不允许修改 ${safeName}：${reason}`,
      fields: [safeName]
    }
  }
  if (typeof changes.logRequests !== 'boolean') {
    return {
      ok: false,
      message: 'logRequests 必须是 boolean。',
      fields: ['logRequests']
    }
  }
  return {
    ok: true,
    value: { changes: { logRequests: changes.logRequests } },
    fields: ['logRequests']
  }
}
