/**
 * batchLivenessCheck: 走反代真实测活探活/探封禁，结果精确回写主界面。
 *
 * 核心断点(本测试守护)：额度接口(GetUsageLimits)对封禁号常仍返回成功而漏判封禁；
 * batchLivenessCheck 走真实对话路径(diagnose:account-liveness)，把返回的原始错误文案
 * 原样写入 lastError，让 isBannedAccountError / 卡片 isUnauthorized 能识别"已封禁"。
 *
 * 验证三类结果的回写：
 *   - 真实可用 → status:active, lastError 清除
 *   - 封禁(423/AccountSuspended) → status:error, lastError 被 isBannedAccountError 命中
 *   - 掉线/超时(非封禁) → status:error, lastError 不被 isBannedAccountError 命中
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore, isBannedAccountError } from '@/store/accounts'
import type { Account } from '@/types/account'

function mkAcc(overrides: Partial<Account> & { credentials?: Partial<Account['credentials']> } = {}): Account {
  const { credentials: credOverrides, ...rest } = overrides
  return {
    id: 'acc-x',
    email: 'x@y.com',
    idp: 'Google',
    subscription: { type: 'Free', title: 'Free' },
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now(),
    ...rest,
    credentials: {
      accessToken: 'access-tok',
      csrfToken: '',
      refreshToken: 'r',
      clientId: '',
      clientSecret: '',
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'social',
      provider: 'Google',
      ...(credOverrides || {})
    }
  } as Account
}

interface LivenessResult {
  success: boolean
  latencyMs: number
  error?: string
}

interface WindowApi {
  diagnoseAccountLiveness: (params: { account: { id?: string } }) => Promise<LivenessResult>
  saveAccounts?: (data: unknown) => Promise<void>
}

beforeEach(() => {
  useAccountsStore.setState({ accounts: new Map(), livenessProgress: null })
  // saveToStorage 内部会调 window.api 存盘 IPC + triggerWebhook；测试里都做成 no-op
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    saveAccounts: vi.fn(async () => {}),
    triggerWebhook: vi.fn(async () => {}),
    proxySyncAccounts: vi.fn(async () => ({ success: true }))
  }
})

/** 按 accountId → 预置测活返回值 装配 mock */
function stubLiveness(byId: Record<string, LivenessResult>): void {
  const api = (window as unknown as { api: Record<string, unknown> }).api
  api.diagnoseAccountLiveness = vi.fn(async (params: { account: { id?: string } }) => {
    const id = params.account.id || ''
    return byId[id] ?? { success: true, latencyMs: 1 }
  })
}

describe('store.batchLivenessCheck 探活/探封禁回写', () => {
  it('封禁号(423 / AccountSuspended)→ status:error 且 lastError 被 isBannedAccountError 命中', async () => {
    useAccountsStore.setState({
      accounts: new Map([
        ['banned1', mkAcc({ id: 'banned1', email: 'b1@x.com', status: 'active' })],
        ['banned2', mkAcc({ id: 'banned2', email: 'b2@x.com', status: 'active' })]
      ])
    })
    stubLiveness({
      banned1: { success: false, latencyMs: 5, error: 'HTTP 423 Locked: account temporarily suspended' },
      banned2: { success: false, latencyMs: 5, error: 'AccountSuspendedException: user id is X suspended' }
    })

    const result = await useAccountsStore.getState().batchLivenessCheck(['banned1', 'banned2'])

    expect(result.failed).toBe(2)
    expect(result.success).toBe(0)

    const accounts = useAccountsStore.getState().accounts
    for (const id of ['banned1', 'banned2']) {
      const acc = accounts.get(id)!
      expect(acc.status).toBe('error')
      // 关键断言：原始封禁文案写入 lastError，且能被封禁判定识别 → 卡片渲染"已封禁"
      expect(isBannedAccountError(acc.lastError)).toBe(true)
    }
  })

  it('真实可用号 → status:active 且清除历史 lastError（解除误标）', async () => {
    useAccountsStore.setState({
      accounts: new Map([
        // 该号此前被误标 error，测活证明其实可用
        ['ok1', mkAcc({ id: 'ok1', email: 'ok@x.com', status: 'error', lastError: '423 locked' })]
      ])
    })
    stubLiveness({ ok1: { success: true, latencyMs: 12 } })

    const result = await useAccountsStore.getState().batchLivenessCheck(['ok1'])

    expect(result.success).toBe(1)
    const acc = useAccountsStore.getState().accounts.get('ok1')!
    expect(acc.status).toBe('active')
    expect(acc.lastError).toBeUndefined()
    expect(isBannedAccountError(acc.lastError)).toBe(false)
  })

  it('掉线/超时(非封禁)→ status:error 但 lastError 不被判为封禁', async () => {
    useAccountsStore.setState({
      accounts: new Map([
        ['dead1', mkAcc({ id: 'dead1', email: 'd1@x.com', status: 'active' })]
      ])
    })
    stubLiveness({ dead1: { success: false, latencyMs: 45000, error: '超时 (45000ms)' } })

    const result = await useAccountsStore.getState().batchLivenessCheck(['dead1'])

    expect(result.failed).toBe(1)
    const acc = useAccountsStore.getState().accounts.get('dead1')!
    expect(acc.status).toBe('error')
    // 掉线号不能被误判为封禁
    expect(isBannedAccountError(acc.lastError)).toBe(false)
  })

  it('无 accessToken 的账号被跳过，不发起测活', async () => {
    useAccountsStore.setState({
      accounts: new Map([
        ['empty1', mkAcc({ id: 'empty1', credentials: { accessToken: '' } })]
      ])
    })
    stubLiveness({})
    const spy = (window as unknown as { api: Record<string, unknown> }).api.diagnoseAccountLiveness

    const result = await useAccountsStore.getState().batchLivenessCheck(['empty1'])

    expect(result.success).toBe(0)
    expect(result.failed).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('结束后 livenessProgress 复位为 null', async () => {
    useAccountsStore.setState({
      accounts: new Map([['ok1', mkAcc({ id: 'ok1' })]])
    })
    stubLiveness({ ok1: { success: true, latencyMs: 1 } })

    await useAccountsStore.getState().batchLivenessCheck(['ok1'])
    expect(useAccountsStore.getState().livenessProgress).toBeNull()
  })
})
