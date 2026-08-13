import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assembleServer, defaultAccountApi, type AssembledServer } from '@main/server/assembly'
import { ENV, readServerConfig } from '@main/server/config'
import { proxyLogStore } from '@main/proxy/logger'
import type { AdminKeyStore } from '@main/webPanel/auth'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `assembly-production-${tag}-`))
}

function fakeAdminKeyStore(): AdminKeyStore {
  let key: string | null = 'test-admin-key-0000000000000000000001'
  return {
    get: () => key,
    set: (next) => {
      key = next
    }
  }
}

describe('服务端生产装配接线', () => {
  let server: AssembledServer | null = null

  afterEach(async () => {
    if (server) await server.shutdown()
    server = null
    await proxyLogStore.flushSaveNow()
    vi.restoreAllMocks()
  })

  it('受信 TLS 代理只从环境配置注入实际面板与反代实例，不采用盘上值', async () => {
    const dataDir = tempDir('trusted-proxy')
    // 本用例关注 TLS 配置接线；先给全局日志 store 一个有效测试路径，避免反代构造日志
    // 在旧实现下因未初始化而把 30 秒保存 timer 留到用例结束。
    proxyLogStore.initialize(tempDir('trusted-proxy-logs'))
    const configured = ['127.0.0.1', '10.20.0.0/16']
    server = assembleServer({
      config: readServerConfig({
        [ENV.DATA_DIR]: dataDir,
        [ENV.TRUSTED_TLS_PROXY_IPS]: configured.join(',')
      }),
      adminKeyStore: fakeAdminKeyStore(),
      accountApi: defaultAccountApi()
    })

    const persistedPanel = {
      host: '127.0.0.1',
      port: 5590,
      trustedTlsProxyIPs: ['198.51.100.10']
    }
    const persistedProxy = {
      enabled: false,
      enableMultiAccount: false,
      selectedAccountIds: [],
      trustedTlsProxyIPs: ['198.51.100.20']
    }
    server.store.set('webPanelConfig', persistedPanel)
    server.store.set('proxyConfig', persistedProxy)

    // 从 assembleServer 构造出的真实 consumer 取它们当前会使用的配置，而不是单测 parser。
    const panelConfig = (
      server.panel as unknown as {
        getConfig: () => { trustedTlsProxyIPs?: string[] }
      }
    ).getConfig()
    const proxy = server.initProxyServer()
    const proxyConfig = proxy.getConfig() as {
      trustedTlsProxyIPs?: string[]
    }

    expect(panelConfig.trustedTlsProxyIPs).toEqual(configured)
    expect(proxyConfig.trustedTlsProxyIPs).toEqual(configured)
    // 环境声明是运行时只读覆盖；不能污染还要拷回 Electron 桌面端的数据。
    expect(server.store.get('webPanelConfig')).toEqual(persistedPanel)
    expect(server.store.get('proxyConfig')).toEqual(persistedProxy)

    // 走面板选号的真实装配写回边界。ProxyServer.getConfig() 带运行时扩展；写回共享
    // proxyConfig 时必须剥掉它，否则一次普通选号就会把环境信任持久化给 Electron。
    server.store.set('accountData', {
      accounts: {
        acc1: {
          id: 'acc1',
          email: 'a@example.com',
          status: 'active',
          credentials: { accessToken: 'access-token' }
        }
      }
    })
    vi.spyOn(proxy, 'isRunning').mockReturnValue(true)
    const activation = await (
      server.panel as unknown as {
        routeDeps: {
          proxyActivateAccount: (accountId: string) => Promise<Record<string, unknown>>
        }
      }
    ).routeDeps.proxyActivateAccount('acc1')

    expect(activation.success).toBe(true)
    const rewritten = server.store.get('proxyConfig') as {
      selectedAccountIds?: string[]
      trustedTlsProxyIPs?: string[]
    }
    expect(rewritten.selectedAccountIds).toEqual(['acc1'])
    expect(rewritten.trustedTlsProxyIPs).toBeUndefined()
  })

  it('assembleServer 用配置数据目录初始化 proxyLogStore，并在 shutdown 中强制刷盘', async () => {
    const dataDir = tempDir('proxy-log-store')
    const initialize = vi.spyOn(proxyLogStore, 'initialize')
    const flushSaveNow = vi.spyOn(proxyLogStore, 'flushSaveNow').mockResolvedValue()
    server = assembleServer({
      config: readServerConfig({ [ENV.DATA_DIR]: dataDir }),
      adminKeyStore: fakeAdminKeyStore(),
      accountApi: defaultAccountApi()
    })

    await server.shutdown()
    server = null

    expect(initialize).toHaveBeenCalledOnce()
    expect(initialize).toHaveBeenCalledWith(dataDir)
    expect(flushSaveNow).toHaveBeenCalledOnce()
  })
})
