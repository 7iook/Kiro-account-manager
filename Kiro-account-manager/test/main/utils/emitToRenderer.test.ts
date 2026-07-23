// TDD: emitToRenderer size guard(2026-07-23 frontend-freeze RCA §6)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// electron 的 app 在 node 环境下不可用,mock 掉
vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

// 注意:emitToRenderer.ts 内部用 process.stderr.write 输出 dev 告警,不用 console
// 所以本测试不需要 mock console

import { installIpcSizeGuard, _internal } from '@main/utils/emitToRenderer'

// 最小 mock:只需要 send 方法
function mkWc(): { send: (channel: string, ...args: unknown[]) => void; sent: Array<{ channel: string; args: unknown[] }> } {
  const sent: Array<{ channel: string; args: unknown[] }> = []
  const wc = {
    send: (channel: string, ...args: unknown[]): void => {
      sent.push({ channel, args })
    },
    sent
  }
  return wc
}

describe('emitToRenderer · size guard', () => {
  let wc: ReturnType<typeof mkWc>

  beforeEach(() => {
    wc = mkWc()
    installIpcSizeGuard(wc as never)
  })

  it('LARGE 通道 小 payload 直通(不截断)', () => {
    wc.send('proxy-response', { path: '/v1/messages', status: 200, tokens: 42 })
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBeUndefined()
    expect(payload.status).toBe(200)
    expect(payload.tokens).toBe(42)
  })

  it('LARGE 通道 超 2KB payload 被截断,保留定长短字段', () => {
    // 造一个 > 2KB 的 payload
    const bigBody = 'x'.repeat(3000)
    wc.send('proxy-response', {
      path: '/v1/messages',
      status: 200,
      tokens: 100,
      body: bigBody,
      extra: bigBody
    })
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBe(true)
    // 定长字段保留
    expect(payload.path).toBe('/v1/messages')
    expect(payload.status).toBe(200)
    expect(payload.tokens).toBe(100)
    // 大字段被折叠
    expect(payload.body).toBeUndefined()
    expect(payload.extra).toBeUndefined()
    // 摘要字段存在
    expect(typeof payload.originalBytes).toBe('number')
    expect((payload.originalBytes as number) > 2000).toBe(true)
    expect(typeof payload.preview).toBe('string')
    expect((payload.preview as string).length).toBeLessThanOrEqual(200)
    // 被 drop 的 keys 记录
    expect(payload._keys).toEqual(expect.arrayContaining(['body', 'extra']))
  })

  it('MEDIUM 通道 小 payload 直通', () => {
    wc.send('proxy-account-update', { id: 'a1', accessToken: 'short' })
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBeUndefined()
    expect(payload.id).toBe('a1')
  })

  it('MEDIUM 通道 超 8KB payload 被截断', () => {
    const bigToken = 't'.repeat(9000)
    wc.send('proxy-account-update', { id: 'a1', accessToken: bigToken })
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBe(true)
    expect(payload.id).toBe('a1')
    expect(payload.accessToken).toBeUndefined()
  })

  it('MEDIUM 通道 6KB payload 不截断(阈值边界内)', () => {
    const midToken = 't'.repeat(6000)
    wc.send('proxy-account-update', { id: 'a1', accessToken: midToken })
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBeUndefined()
    expect(payload.accessToken).toBe(midToken)
  })

  it('未分类通道 直通(不做守卫,即使 payload 很大)', () => {
    const bigBody = 'x'.repeat(5000)
    wc.send('some-unknown-channel', { data: bigBody })
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBeUndefined()
    expect(payload.data).toBe(bigBody)
  })

  it('通道分类常量:LARGE / MEDIUM 覆盖 RCA 表格枚举', () => {
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('proxy-request')).toBe(true)
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('proxy-response')).toBe(true)
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('kproxy-request')).toBe(true)
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('kproxy-response')).toBe(true)
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('kproxy-mitm')).toBe(true)
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('background-refresh-result')).toBe(true)
    expect(_internal.LARGE_PAYLOAD_CHANNELS.has('background-check-result')).toBe(true)

    expect(_internal.MEDIUM_CHANNELS.has('proxy-account-update')).toBe(true)
    expect(_internal.MEDIUM_CHANNELS.has('proxy-account-suspended')).toBe(true)
    expect(_internal.MEDIUM_CHANNELS.has('background-refresh-progress')).toBe(true)
    expect(_internal.MEDIUM_CHANNELS.has('background-check-progress')).toBe(true)
    expect(_internal.MEDIUM_CHANNELS.has('proxy-webhook-trigger')).toBe(true)
  })

  it('null / undefined payload 不崩', () => {
    wc.send('proxy-response', null)
    wc.send('proxy-response', undefined)
    expect(wc.sent).toHaveLength(2)
  })

  it('幂等:重复安装不会双 wrap', () => {
    // 前面 beforeEach 已经装了一次,这里再装一次
    installIpcSizeGuard(wc as never)
    wc.send('proxy-response', { path: '/x', status: 200 })
    expect(wc.sent).toHaveLength(1)
  })

  it('非对象 payload(字符串)超限也走摘要', () => {
    const bigStr = 'y'.repeat(3000)
    wc.send('proxy-response', bigStr)
    expect(wc.sent).toHaveLength(1)
    const payload = wc.sent[0].args[0] as Record<string, unknown>
    expect(payload.__truncated).toBe(true)
    expect(typeof payload.preview).toBe('string')
    expect((payload.preview as string).length).toBeLessThanOrEqual(200)
  })
})
