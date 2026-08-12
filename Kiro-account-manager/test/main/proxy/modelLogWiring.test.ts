import { describe, expect, it, vi } from 'vitest'
import { ProxyServer } from '@main/proxy/proxyServer'

/**
 * 接线验证:`resolveLoggedModel` 必须真的作用在**生产日志通道**上,而不只是单测里绿。
 *
 * 为什么单独写这个文件(E-052「built but not wired」):`modelLogLabel.test.ts` 只证明
 * 纯函数返回值对;它绿了也完全可能出现「函数造好了但 recordRequest / onResponse 没接」——
 * 那正是本轮要修的现场(日志显示 gpt-5.6,而真实计费档是 gpt-5.6-sol)。
 * 本文件从两个收口点验证:
 *   ① `this.events.onResponse` 包装层(20 个调用点共用)
 *   ② `recordRequest` → `stats.recentRequests`(UI 请求日志的数据源)
 */
describe('请求日志接线:实际档位必须进入生产日志通道', () => {
  it('onResponse 事件被包装:客户端传裸名 → 消费者收到实际档 + 原始名', () => {
    const onResponse = vi.fn()
    const server = new ProxyServer({}, { onResponse })

    // 直接打生产事件通道(与 handler 里那 20 处 this.events.onResponse?.(...) 同一条路)
    const events = (server as unknown as {
      events: { onResponse?: (info: { path: string; model?: string; status: number }) => void }
    }).events
    events.onResponse?.({ path: '/v1/messages', model: 'gpt-5.6', status: 200 })

    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.6-sol',        // 实际发往上游、真正计费的那一档
      requestedModel: 'gpt-5.6'    // 客户端原来传的
    })
  })

  it('onResponse:客户端已传 canonical id → 不产生冗余 requestedModel', () => {
    const onResponse = vi.fn()
    const server = new ProxyServer({}, { onResponse })
    const events = (server as unknown as {
      events: { onResponse?: (info: { path: string; model?: string; status: number }) => void }
    }).events
    events.onResponse?.({ path: '/v1/messages', model: 'gpt-5.6-terra', status: 200 })

    expect(onResponse.mock.calls[0][0].model).toBe('gpt-5.6-terra')
    expect(onResponse.mock.calls[0][0].requestedModel).toBeUndefined()
  })

  it('onResponse 未接线时构造不炸(包装是条件式的)', () => {
    expect(() => new ProxyServer({}, {})).not.toThrow()
  })

  it('recordRequest → recentRequests(UI 日志数据源)记的是实际档', () => {
    const server = new ProxyServer({}, {})
    const s = server as unknown as {
      recordRequest: (log: { path: string; model?: string; success: boolean }) => void
      stats: { recentRequests: Array<{ model: string; requestedModel?: string }> }
    }

    s.recordRequest({ path: '/v1/chat/completions', model: 'gpt-4o', success: true })
    s.recordRequest({ path: '/v1/messages', model: 'claude-opus-5', success: true })
    s.recordRequest({ path: '/v1/messages', success: false })

    const logs = s.stats.recentRequests
    expect(logs[0]).toMatchObject({ model: 'gpt-5.6-sol', requestedModel: 'gpt-4o' })
    // canonical id 原样,无冗余字段
    expect(logs[1].model).toBe('claude-opus-5')
    expect(logs[1].requestedModel).toBeUndefined()
    // 无 model 的请求保持既有 'unknown' 语义,不编造归一结果
    expect(logs[2].model).toBe('unknown')
    expect(logs[2].requestedModel).toBeUndefined()
  })
})
