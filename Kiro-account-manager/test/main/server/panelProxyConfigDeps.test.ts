import { describe, expect, it } from 'vitest'

import { AccountPool } from '../../../src/main/proxy/accountPool'
import { proxyLogStore } from '../../../src/main/proxy/logger'
import type { ProxyConfig } from '../../../src/main/proxy/types'
import { buildPanelProxyDeps } from '../../../src/main/ipc/panelProxyDeps'
import {
  PANEL_PROXY_API_KEY_CREATE_CONFIRMATION,
  PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION,
  PANEL_PROXY_PORT_CONFIRMATION,
  type PanelProxyApiKeyCreateResult,
  type PanelProxyApiKeyListResult,
  type PanelProxyApiKeyVerifyResult,
  type PanelProxyApiKeyRevokeResult,
  type PanelProxyConfigResult,
  type PanelProxyConfigView,
  type PanelProxyPortChangeResult
} from '../../../src/main/webPanel/proxyConfigPolicy'

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: string; message: string }

interface ConfigDeps {
  proxyGetConfig: () => Promise<PanelProxyConfigView>
  proxyUpdateConfig: (
    input: unknown,
    actor: { clientIP: string; userAgent: string }
  ) => Promise<Outcome<PanelProxyConfigResult>>
  proxyChangePort: (
    input: unknown,
    actor: { clientIP: string; userAgent: string }
  ) => Promise<Outcome<PanelProxyPortChangeResult>>
  proxyListApiKeys: () => Promise<PanelProxyApiKeyListResult>
  proxyCreateApiKey: (
    input: unknown,
    actor: { clientIP: string; userAgent: string }
  ) => Promise<Outcome<PanelProxyApiKeyCreateResult>>
  proxyVerifyApiKey: (
    input: unknown,
    actor: { clientIP: string; userAgent: string }
  ) => Promise<Outcome<PanelProxyApiKeyVerifyResult>>
  proxyRevokeApiKey: (
    input: unknown,
    actor: { clientIP: string; userAgent: string }
  ) => Promise<Outcome<PanelProxyApiKeyRevokeResult>>
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

function harness(initial = config(), running = true): {
  deps: ConfigDeps
  runtime: () => ProxyConfig
  persisted: () => ProxyConfig
  persistCount: () => number
  restartCount: () => number
  failNextPersist: () => void
  failNextRestart: () => void
  markUsed: (id: string, at: number) => void
} {
  let runtime = initial
  let persisted = initial
  let persists = 0
  let restarts = 0
  let failPersist = 0
  let failRestart = 0
  let isRunning = running
  const pool = new AccountPool()
  const server = {
    isRunning: () => isRunning,
    getAccountPool: () => pool,
    getConfig: () => runtime,
    updateConfig: (patch: Partial<ProxyConfig>) => {
      runtime = { ...runtime, ...patch }
    },
    invalidateSessionAffinity: () => 0,
    start: async () => {
      isRunning = true
    },
    stop: async () => {
      isRunning = false
    },
    restartServer: async () => {
      restarts++
      if (failRestart > 0) {
        failRestart--
        isRunning = false
        throw new Error('synthetic restart failure')
      }
      isRunning = true
    },
    needsRestart: () => false,
    getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0 }),
    getHoldAutoReleaseState: () => ({
      autoReleaseEnabled: false,
      nextAutoReleaseAt: null,
      autoReleaseCount: 0
    }),
    getHeldRequestsInfo: () => ({
      count: 0,
      autoReleaseEnabled: false,
      nextAutoReleaseAt: null,
      autoReleaseCount: 0,
      currentEpisode: null,
      recentEpisodes: []
    }),
    releaseHeldRequests: () => 0
  }

  const built = buildPanelProxyDeps({
    getProxyServer: () => server,
    initProxyServer: () => server,
    getLatestProxyConfig: () => runtime,
    loadAccountData: () => ({ accounts: {} }),
    persistProxyConfig: (next: ProxyConfig) => {
      persists++
      if (failPersist > 0) {
        failPersist--
        throw new Error('synthetic persist failure')
      }
      persisted = next
    }
  } as never) as unknown as ConfigDeps

  return {
    deps: built,
    runtime: () => runtime,
    persisted: () => persisted,
    persistCount: () => persists,
    restartCount: () => restarts,
    failNextPersist: () => {
      failPersist++
    },
    failNextRestart: () => {
      failRestart++
    },
    markUsed: (id, at) => {
      const entry = runtime.apiKeys?.find((candidate) => candidate.id === id)
      if (entry) entry.lastUsedAt = at
    }
  }
}

const ACTOR = { clientIP: '127.0.0.1', userAgent: 'panel-config-test' }

describe('buildPanelProxyDeps · C1 配置用例', () => {
  it('合法 logRequests patch 同时更新运行态和盘上值，返回安全投影', async () => {
    const h = harness()
    const result = await h.deps.proxyUpdateConfig(
      { changes: { logRequests: false } },
      ACTOR
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      appliedFields: ['logRequests'],
      requiresRestart: false,
      config: { editable: { logRequests: false } }
    })
    expect(h.runtime().logRequests).toBe(false)
    expect(h.persisted().logRequests).toBe(false)
  })

  it('unknown key 返回 invalid 且运行态、盘上、persist 调用数都不变', async () => {
    const h = harness()
    const result = await h.deps.proxyUpdateConfig(
      { changes: { trustedTlsProxyIPs: ['203.0.113.10'] } },
      ACTOR
    )

    expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(h.runtime()).toEqual(config())
    expect(h.persisted()).toEqual(config())
    expect(h.persistCount()).toBe(0)
  })

  it('persist 失败明确返回失败并回滚运行态，审计不受 enableAuditLog=false 控制', async () => {
    const h = harness(config({ enableAuditLog: false }))
    const auditStart = proxyLogStore.count()
    h.failNextPersist()

    const result = await h.deps.proxyUpdateConfig(
      { changes: { logRequests: false } },
      ACTOR
    )

    expect(result).toMatchObject({ ok: false, kind: 'persist' })
    expect(h.runtime().logRequests).toBe(true)
    expect(h.persisted().logRequests).toBe(true)
    const audit = proxyLogStore
      .getAll()
      .slice(auditStart)
      .filter((entry) => entry.category === 'PanelConfigAudit')
    expect(audit.some((entry) => JSON.stringify(entry.data).includes('"outcome":"failed"'))).toBe(
      true
    )
  })

  it('端口动作真实受控重启；新端口失败时恢复旧端口且不落盘新值', async () => {
    const okHarness = harness()
    const changed = await okHarness.deps.proxyChangePort(
      {
        port: 5599,
        expectedCurrentPort: 5580,
        confirmation: PANEL_PROXY_PORT_CONFIRMATION
      },
      ACTOR
    )
    expect(changed).toMatchObject({
      ok: true,
      value: { previousPort: 5580, port: 5599, restarted: true, requiresRestart: false }
    })
    expect(okHarness.restartCount()).toBe(1)
    expect(okHarness.runtime().port).toBe(5599)
    expect(okHarness.persisted().port).toBe(5599)

    const failedHarness = harness()
    failedHarness.failNextRestart()
    const failed = await failedHarness.deps.proxyChangePort(
      {
        port: 5599,
        expectedCurrentPort: 5580,
        confirmation: PANEL_PROXY_PORT_CONFIRMATION
      },
      ACTOR
    )
    expect(failed).toMatchObject({ ok: false, kind: 'apply' })
    expect(failedHarness.restartCount()).toBe(2)
    expect(failedHarness.runtime().port).toBe(5580)
    expect(failedHarness.persisted().port).toBe(5580)
  })

  it('API Key 必须新增、真实使用后验证、再吊销旧 key；secret/hint 不进审计', async () => {
    const oldSecret = 'legacy-SECRET_MUST_NOT_LEAK'
    const h = harness(config({ apiKey: oldSecret, enableAuditLog: false }))
    const auditStart = proxyLogStore.count()
    const created = await h.deps.proxyCreateApiKey(
      { confirmation: PANEL_PROXY_API_KEY_CREATE_CONFIRMATION },
      ACTOR
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const { id, key, hint, createdAt } = created.value
    expect(key).toMatch(/^sk-[a-f0-9]{48}$/)

    const listText = JSON.stringify(await h.deps.proxyListApiKeys())
    expect(listText).not.toContain(key)
    expect(listText).not.toContain(oldSecret)

    const premature = await h.deps.proxyVerifyApiKey({ id }, ACTOR)
    expect(premature).toMatchObject({ ok: false, kind: 'conflict' })

    h.markUsed(id, createdAt + 1)
    const verified = await h.deps.proxyVerifyApiKey({ id }, ACTOR)
    expect(verified).toMatchObject({
      ok: true,
      value: { id, verified: true, verifiedAt: createdAt + 1 }
    })

    const revoked = await h.deps.proxyRevokeApiKey(
      {
        id: 'legacy',
        replacementId: id,
        confirmation: PANEL_PROXY_API_KEY_REVOKE_CONFIRMATION
      },
      ACTOR
    )
    expect(revoked).toMatchObject({
      ok: true,
      value: { revokedId: 'legacy', replacementId: id }
    })
    expect(h.runtime().apiKey).toBeUndefined()
    expect(h.persisted().apiKey).toBeUndefined()

    const auditText = JSON.stringify(
      proxyLogStore
        .getAll()
        .slice(auditStart)
        .filter((entry) => entry.category === 'PanelConfigAudit')
    )
    expect(auditText).not.toContain(key)
    expect(auditText).not.toContain(oldSecret)
    expect(auditText).not.toContain(hint)
    expect(auditText).toContain('"operation":"create"')
    expect(auditText).toContain('"operation":"verify"')
    expect(auditText).toContain('"operation":"revoke"')
  })
})
