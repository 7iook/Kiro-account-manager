import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { proxyLogStore } from '../../../src/main/proxy/logger'
import { assembleServer } from '../../../src/main/server/assembly'
import { readServerConfig } from '../../../src/main/server/config'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'

const ADMIN_KEY = 'panel-pool-and-logs-admin-key'
const LOG_TOKEN = 'sk-panel-raw-response-token-123456789'
const PROXY_PASSWORD = 'panel-upstream-password-123456'

type Server = ReturnType<typeof assembleServer>
interface StoredAccountData {
  proxyPool: Record<
    string,
    {
      username?: string
      password?: string
      url?: string
    }
  >
}

function storedAccountData(target: Server): StoredAccountData {
  return target.store.get('accountData') as unknown as StoredAccountData
}

function makeEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    KIRO_DATA_DIR: dataDir,
    KIRO_PANEL_ENABLED: 'true',
    KIRO_PANEL_HOST: '127.0.0.1',
    KIRO_PANEL_PORT: '0',
    KIRO_PROXY_ENABLED: 'false'
  }
}

function createServer(dataDir: string): Server {
  return assembleServer({
    config: readServerConfig(makeEnv(dataDir)),
    adminKeyStore: {
      get: () => ADMIN_KEY,
      set: () => undefined
    },
    log: () => undefined
  })
}

async function start(server: Server): Promise<string> {
  await server.panel.start()
  const address = server.panelAddress()
  if (!address) throw new Error('panel did not expose a listening address')
  return `http://127.0.0.1:${address.port}${PANEL_PATH_PREFIX}`
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Panel-Request': '1'
    },
    body: JSON.stringify({ adminKey: ADMIN_KEY })
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toMatch(/^[^=]+=/)
  return cookie!.split(';', 1)[0]
}

function authHeaders(cookie: string, write = false): Record<string, string> {
  return {
    Cookie: cookie,
    ...(write
      ? {
          'Content-Type': 'application/json',
          'X-Panel-Request': '1'
        }
      : {})
  }
}

describe('真实面板服务的日志与上游代理池链路', () => {
  let server: Server | null = null
  let dataDir: string

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kiro-panel-pool-and-logs-'))
  })

  afterEach(async () => {
    if (server) await server.shutdown()
    server = null
    proxyLogStore.clear()
    await proxyLogStore.flushSaveNow()
  })

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    await proxyLogStore.flushSaveNow()
    await new Promise((resolve) => setTimeout(resolve, 25))
    rmSync(dataDir, { recursive: true, force: true })
  })

  it.each([
    ['新增', '/api/proxy/upstreams', 'POST', { expectedRevision: 0, url: 'http://host:8080' }],
    [
      '编辑',
      '/api/proxy/upstreams/not-found',
      'PATCH',
      { expectedRevision: 0, changes: { enabled: false } }
    ],
    ['删除', '/api/proxy/upstreams/not-found/delete', 'POST', { expectedRevision: 0 }]
  ])('未认证时拒绝%s上游代理', async (_name, pathname, method, body) => {
    server = createServer(dataDir)
    const baseUrl = await start(server)

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Panel-Request': '1'
      },
      body: JSON.stringify(body)
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('登录后分页读取白名单日志摘要，原始响应文本不含 token 或任意 data 凭据', async () => {
    server = createServer(dataDir)
    proxyLogStore.clear()
    for (let index = 0; index < 120; index += 1) {
      proxyLogStore.add({
        timestamp: new Date(Date.UTC(2026, 7, 13, 0, 0, index)).toISOString(),
        level: 'DEBUG',
        category: 'PaginationProbe',
        message: `safe-log-${index}`
      })
    }
    proxyLogStore.add({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category: 'SecurityProbe',
      message:
        `Authorization: Bearer ${LOG_TOKEN}; ` +
        `upstream=socks5://log-user:${PROXY_PASSWORD}@127.0.0.1:1080`,
      data: [
        {
          key: LOG_TOKEN,
          password: PROXY_PASSWORD,
          nested: { token: LOG_TOKEN }
        }
      ]
    })
    const baseUrl = await start(server)
    const cookie = await login(baseUrl)

    const response = await fetch(`${baseUrl}/api/proxy/logs?limit=1`, {
      headers: authHeaders(cookie)
    })
    const rawText = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(rawText).not.toContain(LOG_TOKEN)
    expect(rawText).not.toContain(PROXY_PASSWORD)
    expect(rawText).not.toContain('log-user')
    expect(rawText).not.toContain('"data"')
    expect(JSON.parse(rawText)).toMatchObject({
      total: 121,
      nextCursor: 120,
      entries: [
        {
          level: 'INFO',
          category: 'SecurityProbe'
        }
      ]
    })

    const firstPage = await fetch(`${baseUrl}/api/proxy/logs?limit=100`, {
      headers: authHeaders(cookie)
    })
    expect(firstPage.status).toBe(200)
    expect(await firstPage.json()).toMatchObject({
      total: 121,
      nextCursor: 21,
      entries: expect.arrayContaining([expect.objectContaining({ category: 'SecurityProbe' })])
    })

    proxyLogStore.add({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category: 'AppendedAfterCursor',
      message: 'newer-entry-must-not-shift-the-older-page'
    })
    const lastPage = await fetch(`${baseUrl}/api/proxy/logs?limit=100&cursor=21`, {
      headers: authHeaders(cookie)
    })
    const lastPageBody = await lastPage.json()
    expect(lastPage.status).toBe(200)
    expect(lastPageBody.total).toBe(122)
    expect(lastPageBody.nextCursor).toBeNull()
    expect(lastPageBody.entries).toHaveLength(21)
    expect(lastPageBody.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'AppendedAfterCursor' })])
    )

    const overLimit = await fetch(`${baseUrl}/api/proxy/logs?limit=101`, {
      headers: authHeaders(cookie)
    })
    expect(overLimit.status).toBe(400)
    expect(await overLimit.json()).toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('新增、重启读盘、编辑及删除上游代理，所有响应都不回显密码', async () => {
    server = createServer(dataDir)
    server.store.set('accountData', {
      revision: 7,
      accounts: {},
      proxyPool: {},
      accountProxyBindings: {}
    })
    let baseUrl = await start(server)
    let cookie = await login(baseUrl)
    const proxyUrl = `socks5://panel-user:${PROXY_PASSWORD}@127.0.0.1:1080`

    const createResponse = await fetch(`${baseUrl}/api/proxy/upstreams`, {
      method: 'POST',
      headers: authHeaders(cookie, true),
      body: JSON.stringify({
        expectedRevision: 7,
        url: proxyUrl,
        label: '手机新增'
      })
    })
    const createRaw = await createResponse.text()
    expect(createResponse.status).toBe(200)
    expect(createRaw).not.toContain(PROXY_PASSWORD)
    expect(createRaw).not.toContain('panel-user')
    expect(createRaw).not.toContain(proxyUrl)
    const created = JSON.parse(createRaw)
    expect(created).toMatchObject({
      revision: 8,
      entries: [
        {
          protocol: 'socks5',
          host: '127.0.0.1',
          port: 1080,
          label: '手机新增',
          hasCredentials: true
        }
      ]
    })
    const proxyId = created.entries[0].id as string
    const savedAfterCreate = storedAccountData(server)
    expect(savedAfterCreate.proxyPool[proxyId]).toMatchObject({
      username: 'panel-user',
      password: PROXY_PASSWORD,
      url: proxyUrl
    })

    await server.shutdown()
    server = createServer(dataDir)
    baseUrl = await start(server)
    cookie = await login(baseUrl)
    const reloaded = storedAccountData(server)
    expect(reloaded.proxyPool[proxyId].password).toBe(PROXY_PASSWORD)

    const listResponse = await fetch(`${baseUrl}/api/proxy/upstreams`, {
      headers: authHeaders(cookie)
    })
    const listRaw = await listResponse.text()
    expect(listRaw).not.toContain(PROXY_PASSWORD)
    expect(listRaw).not.toContain('panel-user')

    const editResponse = await fetch(`${baseUrl}/api/proxy/upstreams/${proxyId}`, {
      method: 'PATCH',
      headers: authHeaders(cookie, true),
      body: JSON.stringify({
        expectedRevision: 8,
        changes: { label: '服务端投影标签', enabled: false }
      })
    })
    const editRaw = await editResponse.text()
    expect(editResponse.status).toBe(200)
    expect(editRaw).not.toContain(PROXY_PASSWORD)
    expect(JSON.parse(editRaw)).toMatchObject({
      revision: 9,
      entries: [{ id: proxyId, label: '服务端投影标签', enabled: false }]
    })
    expect(storedAccountData(server).proxyPool[proxyId].password).toBe(PROXY_PASSWORD)

    const deleteResponse = await fetch(`${baseUrl}/api/proxy/upstreams/${proxyId}/delete`, {
      method: 'POST',
      headers: authHeaders(cookie, true),
      body: JSON.stringify({ expectedRevision: 9 })
    })
    const deleteRaw = await deleteResponse.text()
    expect(deleteResponse.status).toBe(200)
    expect(deleteRaw).not.toContain(PROXY_PASSWORD)
    expect(JSON.parse(deleteRaw)).toMatchObject({ revision: 10, entries: [] })
    expect(storedAccountData(server).proxyPool).toEqual({})
  })
})
