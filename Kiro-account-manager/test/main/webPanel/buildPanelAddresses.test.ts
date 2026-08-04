/**
 * `buildPanelAddresses` 改造后的契约测试。
 *
 * 这个函数原来返回 `string[]`（判据 `family === 'IPv4' && !entry.internal`，
 * 与 codeg-research 等价的平铺）。改造成返回 `{ addresses, groups, defaultAddress }`
 * 后，两条既有语义必须保住，否则就是拿新功能换掉了旧行为：
 *
 *   1. 绑非通配地址（`127.0.0.1`）时只返回那一个地址；
 *   2. 回环兜底无条件出现在 `addresses` 里。
 *
 * `addresses` 仍是跨 IPC 契约（设置页与 19 例 WebPanelCard 测试都在用），
 * 所以这里也钉住它仍然是 `string[]` 且与 groups 同源（无重复、无遗漏）。
 */
import { describe, it, expect } from 'vitest'
import { buildPanelAddresses } from '../../../src/main/ipc/webPanelWiring'

describe('buildPanelAddresses · 既有语义保持', () => {
  it('绑 127.0.0.1 时只给本机地址（此时二维码给手机扫无意义）', () => {
    const r = buildPanelAddresses('127.0.0.1', 5590)
    expect(r.addresses).toEqual(['http://127.0.0.1:5590/panel'])
    // 推荐组为空 = UI 据此提示「当前仅本机可访问」
    expect(r.groups.recommended).toEqual([])
    expect(r.groups.loopback.map((a) => a.host)).toEqual(['127.0.0.1'])
  })

  it('绑用户显式指定的非回环地址时，该地址进推荐组', () => {
    const r = buildPanelAddresses('192.168.31.28', 5590)
    expect(r.addresses).toEqual(['http://192.168.31.28:5590/panel'])
    expect(r.groups.recommended.map((a) => a.host)).toEqual(['192.168.31.28'])
    expect(r.defaultAddress).toBe('http://192.168.31.28:5590/panel')
  })

  it('绑 0.0.0.0 时回环兜底必然出现（原实现的无条件 push 行为）', () => {
    const r = buildPanelAddresses('0.0.0.0', 5590)
    expect(r.addresses).toContain('http://127.0.0.1:5590/panel')
  })

  it('addresses 与 groups 同源：数量相等且无重复', () => {
    const r = buildPanelAddresses('0.0.0.0', 5590)
    const fromGroups = [
      ...r.groups.recommended.map((a) => a.url),
      ...r.groups.virtual.map((a) => a.url),
      ...r.groups.loopback.map((a) => a.url)
    ]
    expect(r.addresses).toEqual(fromGroups)
    expect(new Set(r.addresses).size).toBe(r.addresses.length)
  })

  it('每个地址都含 /panel 前缀与端口 —— 用户可直接用的完整 URL', () => {
    const r = buildPanelAddresses('0.0.0.0', 7788)
    for (const url of r.addresses) {
      expect(url).toMatch(/^http:\/\/[^/]+:7788\/panel$/)
    }
  })

  it('defaultAddress 必定是 addresses 里的一个（不会指向不存在的地址）', () => {
    const r = buildPanelAddresses('0.0.0.0', 5590)
    expect(r.defaultAddress).not.toBeNull()
    expect(r.addresses).toContain(r.defaultAddress!)
  })

  it('端口变化时地址跟着变（不缓存旧端口）', () => {
    const a = buildPanelAddresses('0.0.0.0', 5590)
    const b = buildPanelAddresses('0.0.0.0', 6000)
    expect(a.addresses[0]).not.toBe(b.addresses[0])
    expect(b.addresses.every((u) => u.includes(':6000/'))).toBe(true)
  })
})
