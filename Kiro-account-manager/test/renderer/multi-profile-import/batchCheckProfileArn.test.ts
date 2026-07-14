/**
 * batchCheckStatus 应把 account.profileArn 一并塞进 IPC payload 传给主进程，
 * 否则 background-batch-check → getUsageAndLimits → getUsageLimitsRest 会以 undefined
 * profileArn 打 Kiro REST，遇到 Google/Github 社交或严格账户后端返 400
 * "Improperly formed request"，前端 usage 永远保持初始 0。
 *
 * RCA: .agent-workspace/.archive/2026-07-14/usage-refresh-zero/usage-refresh-zero-rca.md
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
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

interface BatchCheckPayloadEntry {
  id: string
  email: string
  profileArn?: string
  credentials: Record<string, unknown>
  idp?: string
}

interface WindowApi {
  backgroundBatchCheck: (
    accounts: BatchCheckPayloadEntry[],
    concurrency?: number
  ) => Promise<{ success: number; failed: number; errors: unknown[] }>
}

declare global {
  interface Window {
    api: WindowApi
  }
}

beforeEach(() => {
  useAccountsStore.setState({ accounts: new Map() })
})

describe('store.batchCheckStatus profileArn passthrough', () => {
  it('sends account.profileArn as a top-level field in IPC payload', async () => {
    const captured: BatchCheckPayloadEntry[][] = []
    const mockApi: WindowApi = {
      backgroundBatchCheck: vi.fn(async (accounts) => {
        captured.push(accounts)
        return { success: accounts.length, failed: 0, errors: [], successCount: accounts.length, failedCount: 0 } as unknown as { success: number; failed: number; errors: unknown[] }
      })
    }
    ;(window as unknown as { api: WindowApi }).api = mockApi

    useAccountsStore.setState({
      accounts: new Map([
        [
          'a1',
          mkAcc({
            id: 'a1',
            email: 'social@example.com',
            profileArn: 'arn:aws:codewhisperer:us-east-1:132597214442:profile/XCWC44P4HNKY',
            credentials: { authMethod: 'social', provider: 'Google' }
          })
        ]
      ])
    })

    await useAccountsStore.getState().batchCheckStatus(['a1'])

    expect(mockApi.backgroundBatchCheck).toHaveBeenCalledTimes(1)
    const [payload] = captured
    expect(payload).toHaveLength(1)
    expect(payload[0].id).toBe('a1')
    expect(payload[0].profileArn).toBe('arn:aws:codewhisperer:us-east-1:132597214442:profile/XCWC44P4HNKY')
  })

  it('omits profileArn if account has none (BuilderId etc.)', async () => {
    const captured: BatchCheckPayloadEntry[][] = []
    const mockApi: WindowApi = {
      backgroundBatchCheck: vi.fn(async (accounts) => {
        captured.push(accounts)
        return { success: accounts.length, failed: 0, errors: [], successCount: accounts.length, failedCount: 0 } as unknown as { success: number; failed: number; errors: unknown[] }
      })
    }
    ;(window as unknown as { api: WindowApi }).api = mockApi

    useAccountsStore.setState({
      accounts: new Map([
        ['a2', mkAcc({ id: 'a2', email: 'builder@example.com' })]
      ])
    })

    await useAccountsStore.getState().batchCheckStatus(['a2'])

    expect(mockApi.backgroundBatchCheck).toHaveBeenCalledTimes(1)
    const [payload] = captured
    expect(payload[0].profileArn).toBeUndefined()
  })
})
