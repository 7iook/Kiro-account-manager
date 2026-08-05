/**
 * 端点链构造 · EU 账号的 V1 fallback(实测 2026-08-05)
 *
 * 病灶:`getSortedEndpoints` 对 EU 账号返回**单一端点** `[KiroRuntime-EU]`,失败即无路可走。
 * 而实测 KiroRuntime-EU 当日非 200 率 41%(US 侧 1%),用户表现为 AI SUB 频繁莫名中断。
 *
 * 原决策依据(RCA 2026-08-03 hold-gate-fallback-cross-region)成立但不完整:
 *   「EU 账户 fallback 到 V1 **us** 端点必 403 Invalid token」—— 三把 ksk 实测复现,保留该结论。
 * 它遗漏的是:V1 **也有 eu 变体**。实测(三把真实 ksk,含一把健康 EU key):
 *
 *   runtime.eu-central-1        → 200 流式正常
 *   q.eu-central-1              → 200 流式正常  ← 可作 EU 的 V1 fallback
 *   codewhisperer.eu-central-1  → ECONNRESET(确实停服)
 *   q.us-east-1 / cw.us-east-1  → 403 bearer token invalid(跨区,印证原结论)
 *
 * 「eu 侧 V1 已停服」这句注释是把 codewhisperer.eu 的停服误推到了整个 V1 —— REST 侧
 * (`index.ts` KIRO_REST_API_ENDPOINTS_V1_FALLBACK)其实早就配了 q.eu-central-1 并在用,
 * 只有反代对话链跟着错误注释实现成了空数组。
 *
 * 本测试守护三件事:US 链不变(回归)· EU 获得 eu 变体 fallback · EU 链绝不含任何 us host。
 */
import { describe, it, expect } from 'vitest'
import { getSortedEndpoints } from '@main/proxy/kiroApi'

const names = (eps: ReturnType<typeof getSortedEndpoints>): string[] => eps.map((e) => e.name)
const urls = (eps: ReturnType<typeof getSortedEndpoints>): string[] => eps.map((e) => e.url)

describe('getSortedEndpoints · region 分发与 V1 fallback', () => {
  it('US 账号:V2-US 优先 + 两个 V1 us fallback(既有行为,回归保护)', () => {
    const eps = getSortedEndpoints(undefined, 'us-east-1')
    expect(names(eps)[0]).toBe('KiroRuntime-US')
    expect(names(eps)).toContain('CodeWhisperer')
    expect(names(eps)).toContain('AmazonQ')
    expect(names(eps)).not.toContain('KiroRuntime-EU')
  })

  it('EU 账号:V2-EU 优先,且有 V1 eu fallback(不再是孤零零一个端点)', () => {
    const eps = getSortedEndpoints(undefined, 'eu-central-1')
    expect(names(eps)[0]).toBe('KiroRuntime-EU')
    // 关键:必须存在 fallback —— 旧实现这里长度为 1,EU 端点抽风时直接失败
    expect(eps.length).toBeGreaterThan(1)
  })

  it('EU 链里绝不能出现任何 us host(守护 RCA 2026-08-03:跨区必 403)', () => {
    const eps = getSortedEndpoints(undefined, 'eu-central-1')
    for (const u of urls(eps)) {
      expect(u).not.toContain('us-east-1')
    }
    // 且不得含实测停服的 codewhisperer.eu
    expect(urls(eps).some((u) => u.includes('codewhisperer.eu-central-1'))).toBe(false)
  })

  it('EU 的 V1 fallback 用的是 q.eu-central-1(实测唯一可用的 eu V1 host)', () => {
    const eps = getSortedEndpoints(undefined, 'eu-central-1')
    expect(urls(eps).some((u) => u.startsWith('https://q.eu-central-1.amazonaws.com'))).toBe(true)
  })

  it('其它 region(ap-*/ca-* 等)归并到 US 链 —— 官方仅部署 us-east-1 与 eu-central-1', () => {
    for (const r of ['ap-southeast-1', 'ca-central-1', 'sa-east-1', undefined]) {
      const eps = getSortedEndpoints(undefined, r)
      expect(names(eps)[0]).toBe('KiroRuntime-US')
    }
  })

  it('amazonq-cli:单端点不回退(既有行为)', () => {
    const eps = getSortedEndpoints('amazonq-cli', 'us-east-1')
    expect(names(eps)).toEqual(['AmazonQCLI'])
  })

  it('preferredEndpoint 只影响 V1 内部顺序,不能把 V2 挤掉首位', () => {
    const eps = getSortedEndpoints('amazonq', 'us-east-1')
    expect(names(eps)[0]).toBe('KiroRuntime-US')
    expect(names(eps).indexOf('AmazonQ')).toBeLessThan(names(eps).indexOf('CodeWhisperer'))
  })
})

describe('getSortedEndpoints · ksk_(API_KEY)与 amazonq-cli 偏好冲突的防御', () => {
  // 实测 2026-08-05:AmazonQCLI 端点(SendMessageStreaming)明确拒绝 API key 认证 ——
  //   q.eu-central-1/SendMessageStreaming + Bearer ksk_… →
  //   403 {"message":"API key authentication is not supported for this operation"}
  // 该端点的既有语义是「单端点不回退」,若对 ksk_ 账号照锁,等于 100% 必败且无退路。
  it('ksk_ 账号即使把首选端点设成 amazonq-cli,也不锁死在 AmazonQCLI 上', () => {
    const eps = getSortedEndpoints('amazonq-cli', 'us-east-1', true)
    expect(names(eps)).not.toEqual(['AmazonQCLI'])
    expect(names(eps)[0]).toBe('KiroRuntime-US')
  })

  it('ksk_ 的 EU 账号同理,回落到 EU 链(含 q.eu fallback)', () => {
    const eps = getSortedEndpoints('amazonq-cli', 'eu-central-1', true)
    expect(names(eps)[0]).toBe('KiroRuntime-EU')
    expect(urls(eps).some((u) => u.startsWith('https://q.eu-central-1.amazonaws.com'))).toBe(true)
  })

  it('非 API_KEY 账号(SSO/social)的 amazonq-cli 偏好保持既有单端点行为', () => {
    expect(names(getSortedEndpoints('amazonq-cli', 'us-east-1', false))).toEqual(['AmazonQCLI'])
    expect(names(getSortedEndpoints('amazonq-cli', 'us-east-1'))).toEqual(['AmazonQCLI'])
  })
})
