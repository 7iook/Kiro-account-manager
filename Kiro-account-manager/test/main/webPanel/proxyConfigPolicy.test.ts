import { describe, expect, it } from 'vitest'

import {
  PANEL_PROXY_API_KEY_CREATE_CONFIRMATION,
  PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION,
  PANEL_PROXY_PORT_CONFIRMATION,
  projectPanelProxyApiKeyList,
  projectPanelProxyConfig,
  validatePanelProxyApiKeyCreate,
  validatePanelProxyApiKeyRevoke,
  validatePanelProxyApiKeyVerify,
  validatePanelProxyPortChange,
  validatePanelProxyConfigPatch
} from '../../../src/main/webPanel/proxyConfigPolicy'
import type { ApiKey, ProxyConfig } from '../../../src/main/proxy/types'

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-id-1',
    name: 'Panel key',
    key: 'sk-SECRET_DO_NOT_LEAK_0123456789',
    format: 'sk',
    enabled: true,
    createdAt: 100,
    usage: {
      totalRequests: 0,
      totalCredits: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      daily: {}
    },
    ...overrides
  }
}

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    enabled: true,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    ...overrides
  }
}

describe('PanelProxyConfig policy', () => {
  it('安全投影只回配置摘要，API key 原值、名称和 id 均不出网', () => {
    const rawSecret = 'sk-SECRET_DO_NOT_LEAK_0123456789'
    const view = projectPanelProxyConfig(
      config({
        apiKey: 'legacy-SECRET_DO_NOT_LEAK',
        apiKeys: [apiKey({ key: rawSecret })],
        logStreamEvents: true,
        enablePerfDiagLog: false,
        enableAuditLog: false,
        modelMappings: [
          {
            id: 'mapping-1',
            name: 'mapping',
            enabled: true,
            type: 'replace',
            sourceModel: 'source',
            targetModels: ['target'],
            priority: 1,
            apiKeyIds: ['key-id-1']
          }
        ],
        agentMode: 'spec',
        payloadSizeLimitKB: 128
      })
    )
    const text = JSON.stringify(view)

    expect(view.apiKeys).toEqual({
      configured: true,
      count: 2,
      hints: ['legacy:configured', expect.stringMatching(/^key:[a-f0-9]{12}$/)]
    })
    expect(text).not.toContain(rawSecret)
    expect(text).not.toContain('legacy-SECRET')
    expect(text).not.toContain('Panel key')
    expect(text).not.toContain('key-id-1')
    expect(view.readOnly.map((entry) => entry.key)).toEqual([
      'logStreamEvents',
      'enablePerfDiagLog',
      'enableAuditLog',
      'modelMappings',
      'agentMode',
      'payloadSizeLimitKB'
    ])
    expect(view.readOnly.every((entry) => entry.reason.length > 0)).toBe(true)
  })

  it('hint 只由非 secret id 计算，同一 id 换 key 后不变化', () => {
    const before = projectPanelProxyConfig(config({ apiKeys: [apiKey()] })).apiKeys.hints[0]
    const after = projectPanelProxyConfig(
      config({ apiKeys: [apiKey({ key: 'sk-a-completely-different-secret' })] })
    ).apiKeys.hints[0]
    expect(after).toBe(before)
  })

  it('专用 key 列表只发安全元数据，验证态来自真实 lastUsedAt', () => {
    const view = projectPanelProxyApiKeyList(
      config({
        apiKey: 'legacy-SECRET_DO_NOT_LEAK',
        apiKeys: [
          apiKey({ lastUsedAt: 101 }),
          apiKey({
            id: 'key-id-2',
            name: 'must-not-leak-name',
            key: 'sk-SECOND_SECRET_DO_NOT_LEAK',
            createdAt: 200,
            lastUsedAt: 199
          })
        ]
      })
    )
    const text = JSON.stringify(view)

    expect(view.keys).toEqual([
      { id: 'legacy', hint: 'legacy:configured', createdAt: null, verifiedAt: null },
      {
        id: 'key-id-1',
        hint: expect.stringMatching(/^key:[a-f0-9]{12}$/),
        createdAt: 100,
        verifiedAt: 101
      },
      {
        id: 'key-id-2',
        hint: expect.stringMatching(/^key:[a-f0-9]{12}$/),
        createdAt: 200,
        verifiedAt: null
      }
    ])
    expect(text).not.toContain('SECRET_DO_NOT_LEAK')
    expect(text).not.toContain('must-not-leak-name')
  })

  it('通用 patch 只允许自有布尔 logRequests 字段', () => {
    expect(validatePanelProxyConfigPatch({ changes: { logRequests: false } })).toEqual({
      ok: true,
      value: { changes: { logRequests: false } },
      fields: ['logRequests']
    })

    for (const invalid of [
      {},
      { changes: {} },
      { changes: [] },
      { changes: { logRequests: 'false' } },
      { changes: { port: 5599 } },
      { changes: { trustedTlsProxyIPs: ['127.0.0.1'] } },
      { changes: { adminKey: 'must-not-echo' } },
      { changes: { logRequests: true }, extra: true }
    ]) {
      const result = validatePanelProxyConfigPatch(invalid)
      expect(result.ok, JSON.stringify(invalid)).toBe(false)
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it('拒绝原型继承字段和非普通对象，不把继承值当 patch', () => {
    const inherited = Object.create({ logRequests: false }) as Record<string, unknown>
    const result = validatePanelProxyConfigPatch({ changes: inherited })
    expect(result.ok).toBe(false)
  })

  it('恶意字段名不会被原样拼进错误文案', () => {
    const secretAsFieldName = 'sk-SECRET_DO_NOT_LEAK_0123456789'
    const result = validatePanelProxyConfigPatch({ changes: { [secretAsFieldName]: true } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain(secretAsFieldName)
  })

  it('端口专用动作要求有效端口、当前值快照和固定确认词', () => {
    expect(
      validatePanelProxyPortChange(
        {
          port: 5599,
          expectedCurrentPort: 5580,
          confirmation: PANEL_PROXY_PORT_CONFIRMATION
        },
        5580
      )
    ).toMatchObject({ ok: true, value: { port: 5599 } })

    for (const invalid of [
      { port: 0, expectedCurrentPort: 5580, confirmation: PANEL_PROXY_PORT_CONFIRMATION },
      { port: 65536, expectedCurrentPort: 5580, confirmation: PANEL_PROXY_PORT_CONFIRMATION },
      { port: 5599.5, expectedCurrentPort: 5580, confirmation: PANEL_PROXY_PORT_CONFIRMATION },
      { port: 5580, expectedCurrentPort: 5580, confirmation: PANEL_PROXY_PORT_CONFIRMATION },
      { port: 5599, expectedCurrentPort: 5579, confirmation: PANEL_PROXY_PORT_CONFIRMATION },
      { port: 5599, expectedCurrentPort: 5580, confirmation: 'yes' },
      {
        port: 5599,
        expectedCurrentPort: 5580,
        confirmation: PANEL_PROXY_PORT_CONFIRMATION,
        host: '0.0.0.0'
      }
    ]) {
      expect(validatePanelProxyPortChange(invalid, 5580).ok, JSON.stringify(invalid)).toBe(false)
    }
  })

  it('API key 三步动作各自使用封闭 DTO，不能夹带 key 原值或通用 config', () => {
    expect(
      validatePanelProxyApiKeyCreate({
        confirmation: PANEL_PROXY_API_KEY_CREATE_CONFIRMATION
      }).ok
    ).toBe(true)
    expect(validatePanelProxyApiKeyVerify({ id: 'key-id-1' }).ok).toBe(true)
    expect(
      validatePanelProxyApiKeyRevoke({
        id: 'legacy',
        replacementId: 'key-id-1',
        confirmation: PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION
      }).ok
    ).toBe(true)

    for (const result of [
      validatePanelProxyApiKeyCreate({ confirmation: 'yes' }),
      validatePanelProxyApiKeyCreate({
        confirmation: PANEL_PROXY_API_KEY_CREATE_CONFIRMATION,
        key: 'caller-supplied-secret'
      }),
      validatePanelProxyApiKeyVerify({ id: '' }),
      validatePanelProxyApiKeyVerify({ id: 'key-id-1', key: 'caller-supplied-secret' }),
      validatePanelProxyApiKeyRevoke({
        id: 'key-id-1',
        replacementId: 'key-id-1',
        confirmation: PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION
      }),
      validatePanelProxyApiKeyRevoke({
        id: 'key-id-1',
        replacementId: 'key-id-2',
        confirmation: 'yes'
      })
    ]) {
      expect(result.ok).toBe(false)
    }
  })
})
