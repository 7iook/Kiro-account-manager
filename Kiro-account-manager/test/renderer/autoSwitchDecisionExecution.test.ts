import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import { CLEAN_STATE, makeFakeMain, mkAcc } from './cross-end-sync/fixtures'

function installDesktopEffects(fake: ReturnType<typeof makeFakeMain>): {
  switchAccount: ReturnType<typeof vi.fn>
  switchAccountCli: ReturnType<typeof vi.fn>
  syncProxy: ReturnType<typeof vi.fn>
} {
  const switchAccount = vi.fn(async () => ({ success: true }))
  const switchAccountCli = vi.fn(async () => ({ success: true }))
  Object.assign(fake.api, {
    switchAccount,
    switchAccountCli,
    getLocalActiveAccount: vi.fn(async () => ({ success: false }))
  })
  const syncProxy = vi.fn(async () => ({ applied: true, mode: 'single' as const }))
  useAccountsStore.setState({ syncActiveAccountToProxy: syncProxy })
  return { switchAccount, switchAccountCli, syncProxy }
}

beforeEach(() => {
  useAccountsStore.setState({ ...CLEAN_STATE })
})

afterEach(() => {
  useAccountsStore.getState().stopAutoSave()
  vi.restoreAllMocks()
})

describe('renderer 只执行 main 的自动换号决定', () => {
  it('首次加载不重放磁盘上的历史决定', async () => {
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A'), B: mkAcc('B') },
      activeAccountId: 'B',
      autoSwitchDecision: {
        id: 'old-decision',
        fromAccountId: 'A',
        toAccountId: 'B',
        switchTarget: 'both',
        decidedAt: 1
      }
    })
    const effects = installDesktopEffects(fake)

    await useAccountsStore.getState().loadFromStorage()
    await Promise.resolve()

    expect(effects.switchAccount).not.toHaveBeenCalled()
    expect(effects.switchAccountCli).not.toHaveBeenCalled()
    expect(effects.syncProxy).not.toHaveBeenCalled()
  })

  it('新决定只执行一次，目标由 main 信封给定而不是 renderer 重新选择', async () => {
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A'), B: mkAcc('B'), C: mkAcc('C') },
      activeAccountId: 'A'
    })
    const effects = installDesktopEffects(fake)
    await useAccountsStore.getState().loadFromStorage()
    fake.api.backgroundBatchRefresh.mockClear()

    fake.externalWrite((disk) => ({
      ...disk,
      activeAccountId: 'C',
      autoSwitchDecision: {
        id: 'new-decision',
        fromAccountId: 'A',
        toAccountId: 'C',
        switchTarget: 'both',
        decidedAt: 2
      }
    }))
    await useAccountsStore.getState().reloadFromStorageQuiet()
    await useAccountsStore.getState().reloadFromStorageQuiet()

    expect(useAccountsStore.getState().activeAccountId).toBe('C')
    expect(effects.switchAccount).toHaveBeenCalledTimes(1)
    expect(effects.switchAccount.mock.calls[0][0]).toMatchObject({ accountId: 'C' })
    expect(effects.switchAccountCli).toHaveBeenCalledTimes(1)
    expect(effects.syncProxy).toHaveBeenCalledTimes(1)
    expect(effects.syncProxy).toHaveBeenCalledWith('C')
  })

  it('决定落在本地防抖编辑窗口时，经 STALE 三方合并后仍执行且不被整表写抹掉', async () => {
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A'), B: mkAcc('B') },
      activeAccountId: 'A',
      theme: 'default'
    })
    const effects = installDesktopEffects(fake)
    await useAccountsStore.getState().loadFromStorage()

    // 本地先产生尚未提交的编辑，main 的决定随后落盘，使本次保存必然走 STALE 合并。
    useAccountsStore.setState({ theme: 'ocean' })
    const pendingSave = useAccountsStore.getState().saveToStorage()
    fake.externalWrite((disk) => ({
      ...disk,
      activeAccountId: 'B',
      autoSwitchDecision: {
        id: 'decision-during-dirty-window',
        fromAccountId: 'A',
        toAccountId: 'B',
        switchTarget: 'ide',
        decidedAt: 3
      }
    }))

    await useAccountsStore.getState().flushSaveImmediately()
    await pendingSave
    await vi.waitFor(() => {
      expect(effects.switchAccount).toHaveBeenCalledTimes(1)
    })

    expect(effects.switchAccount.mock.calls[0][0]).toMatchObject({ accountId: 'B' })
    expect(fake.disk.autoSwitchDecision).toMatchObject({
      id: 'decision-during-dirty-window',
      toAccountId: 'B'
    })
    await useAccountsStore.getState().flushSaveImmediately()
  })
})
