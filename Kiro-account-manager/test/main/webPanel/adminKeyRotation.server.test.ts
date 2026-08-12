import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebPanelServer } from '../../../src/main/webPanel/server'
import { PanelAuth, type AdminKeyStore } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import type { PanelRouteDeps } from '../../../src/main/webPanel/routes'

const OLD_KEY = 'rotation-test-old-admin-key-0123456789'
const servers: WebPanelServer[] = []

function memoryKeyStore(options: { failWrites?: boolean } = {}): AdminKeyStore & {
  current: () => string
} {
  let key = OLD_KEY
  return {
    get: () => key,
    set: (next) => {
      if (options.failWrites) throw new Error('simulated key-store write failure')
      key = next
    },
    current: () => key
  }
}

function makeServer(keyStore: AdminKeyStore): WebPanelServer {
  const server = new WebPanelServer({
    auth: new PanelAuth(keyStore),
    routeDeps: {} as PanelRouteDeps,
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1' })
  })
  servers.push(server)
  return server
}

function base(server: WebPanelServer): string {
  const address = server.getListeningAddress()
  if (!address) throw new Error('server not listening')
  return `http://127.0.0.1:${address.port}${PANEL_PATH_PREFIX}`
}

async function login(server: WebPanelServer, key = OLD_KEY): Promise<Response> {
  return fetch(`${base(server)}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
    body: JSON.stringify({ adminKey: key })
  })
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('login did not set a cookie')
  return setCookie.split(';')[0]
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (servers.length) await servers.pop()?.stop()
})

describe('WebPanelServer · 管理员密钥轮换', () => {
  it('拒绝未登录或缺 CSRF 头的轮换请求', async () => {
    const store = memoryKeyStore()
    const server = makeServer(store)
    await server.start()

    const anonymous = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: { 'X-Panel-Request': '1' }
    })
    expect(anonymous.status).toBe(401)

    const cookie = sessionCookie(await login(server))
    const missingCsrf = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: { cookie }
    })
    expect(missingCsrf.status).toBe(401)
    expect(store.current()).toBe(OLD_KEY)
  })

  it('持久化新密钥后只在 no-store 响应交付一次，并失效所有旧会话', async () => {
    const store = memoryKeyStore()
    const server = makeServer(store)
    await server.start()
    const cookie = sessionCookie(await login(server))

    const rotated = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(rotated.status).toBe(200)
    expect(rotated.headers.get('cache-control')).toBe('no-store')
    expect(rotated.headers.get('set-cookie')).toContain('Max-Age=0')
    const body = (await rotated.json()) as { key?: unknown }
    expect(typeof body.key).toBe('string')
    expect(body.key).not.toBe(OLD_KEY)
    expect(body.key).toBe(store.current())

    const oldSession = await fetch(`${base(server)}/api/session`, { headers: { cookie } })
    expect(oldSession.status).toBe(401)
    expect((await login(server, OLD_KEY)).status).toBe(401)
    expect((await login(server, body.key as string)).status).toBe(200)
  })

  it('持久化失败时返回 500，保留旧密钥和现有会话', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = memoryKeyStore({ failWrites: true })
    const server = makeServer(store)
    await server.start()
    const cookie = sessionCookie(await login(server))

    const failed = await fetch(`${base(server)}/api/admin-key/rotate`, {
      method: 'POST',
      headers: { cookie, 'X-Panel-Request': '1' }
    })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ code: 'INTERNAL_ERROR' })
    expect(store.current()).toBe(OLD_KEY)

    const oldSession = await fetch(`${base(server)}/api/session`, { headers: { cookie } })
    expect(oldSession.status).toBe(200)
  })
})
