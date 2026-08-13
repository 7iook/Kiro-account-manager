import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { EditAccountDialog } from '@/components/accounts/EditAccountDialog'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'

const originalAccount: Account = {
  id: 'record-A',
  email: 'a@example.com',
  userId: 'user-A',
  idp: 'BuilderId',
  credentials: {
    accessToken: 'access-A',
    csrfToken: '',
    refreshToken: 'refresh-A',
    expiresAt: Date.now() + 3_600_000,
    authMethod: 'social',
    provider: 'BuilderId'
  },
  subscription: { type: 'Free' },
  usage: { current: 0, limit: 50, percentUsed: 0, lastUpdated: Date.now() },
  tags: [],
  status: 'active',
  isActive: false,
  createdAt: Date.now(),
  lastUsedAt: Date.now()
}

beforeEach(() => {
  vi.useFakeTimers()
  window.api = {
    saveAccounts: vi.fn(async () => ({ ok: true as const, revision: 1 })),
    loadAccounts: vi.fn(async () => null)
  } as typeof window.api
  useAccountsStore.setState({
    accounts: new Map([[originalAccount.id, originalAccount]]),
    currentRevision: 0,
    isSyncing: false,
    language: 'zh'
  })
})

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
})

describe('编辑账号凭据必须对应本轮验证结果', () => {
  it('修改 Refresh Token 后未重新验证，保存被拒且不会把新凭据塞进 A 的记录', () => {
    const onOpenChange = vi.fn()
    render(
      <EditAccountDialog open onOpenChange={onOpenChange} account={originalAccount} />
    )

    fireEvent.change(screen.getByPlaceholderText('aorAAAAA...'), {
      target: { value: 'refresh-B' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    expect(screen.getByText('凭据已修改，请先验证再保存')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(
      useAccountsStore.getState().accounts.get('record-A')?.credentials.refreshToken
    ).toBe('refresh-A')
    expect(window.api.saveAccounts).not.toHaveBeenCalled()
  })

  it('验证返回 B 的 userId/email 后点击保存，提示改用新增且 A 保持不变', async () => {
    window.api.verifyAccountCredentials = vi.fn(async () => ({
      success: true,
      data: {
        email: 'b@example.com',
        userId: 'user-B',
        accessToken: 'access-B',
        refreshToken: 'refresh-B',
        subscriptionType: 'Free',
        subscriptionTitle: 'Free',
        usage: { current: 0, limit: 50 },
        daysRemaining: 30
      }
    }))
    const onOpenChange = vi.fn()
    render(
      <EditAccountDialog open onOpenChange={onOpenChange} account={originalAccount} />
    )

    fireEvent.change(screen.getByPlaceholderText('aorAAAAA...'), {
      target: { value: 'refresh-B' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '验证并刷新凭证信息' }))
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    expect(screen.getByText('这是另一个账号，请改用新增')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(useAccountsStore.getState().accounts.get('record-A')).toMatchObject({
      email: 'a@example.com',
      userId: 'user-A',
      credentials: {
        accessToken: 'access-A',
        refreshToken: 'refresh-A'
      }
    })
    expect(window.api.saveAccounts).not.toHaveBeenCalled()
  })
})
