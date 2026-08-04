/**
 * 额度百分比单位收口 —— 行为测试（红→绿）
 *
 * 病灶：`percentUsed` 的单位在全仓分裂成两派。写入侧 `check.ts:127` /
 * `persistCheckResult.ts` / `store/accounts.ts` 存 0~1 小数，而
 * `RegisterPage.tsx` 四处存 `Math.round(x*100)` 的百分数。显示侧同样分裂：
 * `AccountCard` 乘 100（对小数正确），面板 `ProxyPanel` 不乘（对小数恒显 0%）。
 *
 * 用户看到的现象是「已用永远 0%」—— 那是小数派账号走到了不乘 100 的显示点。
 * 这里锁住「字段是 0~1 小数」这一唯一语义，并锁住显示点按该语义换算。
 *
 * 为什么断言渲染文本而非 helper 返回值：要证明用户在屏幕上看到 42%，
 * 而不是断言我调了自己写的函数。helper 正确但组件走了另一个分支时，
 * 只测 helper 会全绿而 bug 依旧（这正是 ProxyPanel 的现状：format.ts
 * 早有 usageBarClass 在做 *100，而选号列表自己写了 Math.round）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProxyPanel } from '../../../src/webPanel/ui/ProxyPanel'
import type { AccountListItem } from '../../../src/main/webPanel/dto'
import { formatPercent } from '../../../src/webPanel/ui/format'

function panelAccounts(usage: AccountListItem['usage']): AccountListItem[] {
  return [
    {
      id: 'acc-a',
      email: 'alice@example.com',
      status: 'active',
      isActive: false,
      tags: [],
      hasRefreshToken: true,
      canRefreshViaOidc: true,
      usage
    } as AccountListItem
  ]
}

function stubStatus(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    // 选号入口要求 running=true（`disabled={busy !== null || !running}`），
    // 故这里必须报运行中，否则点不开弹层 —— 测试会因找不到弹层而红，
    // 那是测试自身的问题，不是被测缺陷。
    if (url.endsWith('/proxy/status')) {
      return json({
        running: true,
        port: 8080,
        poolSize: 1,
        availableCount: 1,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0
      })
    }
    return json({ success: true })
  })
}

const noop = (): void => undefined

async function openPicker(usage: AccountListItem['usage']): Promise<HTMLElement> {
  vi.stubGlobal('fetch', stubStatus())
  render(
    <ProxyPanel
      accounts={panelAccounts(usage)}
      onNotice={noop}
      onError={noop}
      onSessionLost={noop}
    />
  )
  await waitFor(() => expect(screen.getByRole('button', { name: '选择账号' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: '选择账号' }))
  return await waitFor(() => screen.getByRole('dialog', { name: '选择反代账号' }))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('percentUsed 单位语义 = 0~1 小数（SSOT）', () => {
  it('formatPercent 把小数换算成百分数文本', () => {
    expect(formatPercent(0.42)).toBe('42%')
  })

  it('formatPercent 不裁剪超额 —— 超出上限是用户要知道的事实', () => {
    expect(formatPercent(1.2)).toBe('120%')
  })

  it('formatPercent 对 undefined 给 `-` 而不是 0%（未知 ≠ 用了 0）', () => {
    expect(formatPercent(undefined)).toBe('-')
  })
})

describe('面板选号列表显示真实百分比（用户报的恒 0% 现象）', () => {
  it('percentUsed=0.42 → 显示 42%，不是 0%', async () => {
    const dialog = await openPicker({ current: 42, limit: 100, percentUsed: 0.42 })
    expect(dialog.textContent).toContain('42%')
    expect(dialog.textContent).not.toContain('已用 0%')
  })

  it('超额 percentUsed=1.2 → 显示 120%，与桌面 AccountCard 口径一致（不裁剪）', async () => {
    const dialog = await openPicker({ current: 120, limit: 100, percentUsed: 1.2 })
    expect(dialog.textContent).toContain('120%')
  })

  it('limit=0 时不崩，且不谎报 0%', async () => {
    const dialog = await openPicker({ current: 0, limit: 0, percentUsed: 0 })
    expect(dialog.textContent).toContain('alice@example.com')
  })
})
