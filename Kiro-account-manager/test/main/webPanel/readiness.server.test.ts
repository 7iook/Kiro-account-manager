import { afterEach, describe, expect, it } from 'vitest'
import { WebPanelServer } from '../../../src/main/webPanel/server'
import { PanelAuth } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import type { PanelRouteDeps } from '../../../src/main/webPanel/routes'

const ADMIN_KEY = 'readiness-test-admin-key-0123456789'
const servers: WebPanelServer[] = []

function makeServer(isReady: () => boolean): WebPanelServer {
  const auth = new PanelAuth({ get: () => ADMIN_KEY, set: () => undefined })
  const server = new WebPanelServer({
    auth,
    routeDeps: {} as PanelRouteDeps,
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1' }),
    isReady
  })
  servers.push(server)
  return server
}

function base(server: WebPanelServer): string {
  const address = server.getListeningAddress()
  if (!address) throw new Error('server not listening')
  return `http://127.0.0.1:${address.port}${PANEL_PATH_PREFIX}`
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.stop()
})

describe('WebPanelServer · readiness 与 liveness 分离', () => {
  it('匿名 readiness 只按代理实际运行态返回 503/200，不泄漏业务状态', async () => {
    let proxyRunning = false
    const server = makeServer(() => proxyRunning)
    await server.start()

    const degraded = await fetch(`${base(server)}/readyz`)
    expect(degraded.status).toBe(503)
    expect(degraded.headers.get('content-type')).toContain('application/json')
    expect(await degraded.json()).toEqual({ status: 'not_ready' })

    proxyRunning = true
    const ready = await fetch(`${base(server)}/readyz`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready' })
  })
})
