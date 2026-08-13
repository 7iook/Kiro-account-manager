/**
 * 受信 TLS 前置代理的真实 hop 回归。
 *
 * 这里刻意起两个真实 http.Server：测试请求先到 front，再由 front 连接 ProxyServer。
 * 因此后端 socket peer 确实是 127.0.0.1；只在 helper 上断言会重演本缺陷的假绿。
 */
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyServer } from '@main/proxy/proxyServer'
import type { ProxyConfig } from '@main/proxy/types'

type TrustedProxyConfig = ProxyConfig & { trustedTlsProxyIPs?: string[] }

const backends: ProxyServer[] = []
const fronts: http.Server[] = []

afterEach(async () => {
  while (fronts.length) {
    const front = fronts.pop()
    front?.closeAllConnections?.()
    await new Promise<void>((resolve) => front?.close(() => resolve()) ?? resolve())
  }
  while (backends.length) await backends.pop()?.stop(0)
})

async function startBackend(config: Partial<TrustedProxyConfig>): Promise<number> {
  const backend = new ProxyServer({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    logRequests: false,
    ...config
  } as Partial<ProxyConfig>)
  backends.push(backend)
  await backend.start()
  const address = (backend as unknown as { server: http.Server }).server.address()
  if (!address || typeof address === 'string') throw new Error('backend not listening')
  return address.port
}

async function startFront(backendPort: number, forwardedFor?: string): Promise<string> {
  const front = http.createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers }
    if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: backendPort,
        method: incoming.method,
        path: incoming.url,
        headers
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      }
    )
    upstream.on('error', (error) => outgoing.destroy(error))
    incoming.pipe(upstream)
  })
  fronts.push(front)
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(0, '127.0.0.1', () => {
      front.removeListener('error', reject)
      resolve()
    })
  })
  const address = front.address()
  if (!address || typeof address === 'string') throw new Error('front not listening')
  return `http://127.0.0.1:${address.port}`
}

describe('ProxyServer · 受信 TLS 前置代理', () => {
  it('真实请求经过代理 hop 后，allowedIPs 按转发的客户端 IP 判定', async () => {
    const backendPort = await startBackend({
      trustedTlsProxyIPs: ['127.0.0.1'],
      allowedIPs: ['203.0.113.42']
    })
    const front = await startFront(backendPort, '203.0.113.42')

    const response = await fetch(`${front}/health`)

    expect(response.status).toBe(200)
  })

  it('未显式信任 socket peer 时忽略伪造的 X-Forwarded-For', async () => {
    const backendPort = await startBackend({
      allowedIPs: ['203.0.113.42']
    })

    const response = await fetch(`http://127.0.0.1:${backendPort}/health`, {
      headers: { 'X-Forwarded-For': '203.0.113.42' }
    })

    expect(response.status).toBe(403)
  })

  it('从右向左剥离受信 hop，不采用客户端预置的最左伪造值', async () => {
    const backendPort = await startBackend({
      trustedTlsProxyIPs: ['127.0.0.1'],
      allowedIPs: ['198.51.100.20']
    })
    const front = await startFront(backendPort, '203.0.113.42, 198.51.100.20')

    const response = await fetch(`${front}/health`)

    expect(response.status).toBe(200)
  })

  it('受信 peer 缺少 X-Forwarded-For 时明确拒绝，不退回代理自身地址', async () => {
    const backendPort = await startBackend({
      trustedTlsProxyIPs: ['127.0.0.1'],
      allowedIPs: ['127.0.0.1']
    })
    const front = await startFront(backendPort)

    const response = await fetch(`${front}/health`)

    expect(response.status).toBe(400)
  })
})
