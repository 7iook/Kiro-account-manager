import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAutoSwitchScheduler,
  decideAutoSwitch,
  getCurrentAutoSwitchDecision,
  isAutoSwitchBannedError,
  persistAutoSwitchDecision,
  type AutoSwitchAccountData,
  type AutoSwitchDecision
} from '../../../src/main/accountService/autoSwitch'
import { setStoreRef } from '../../../src/main/accountService/state'

function account(
  id: string,
  remaining: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    email: `${id}@example.com`,
    usage: { current: 100 - remaining, limit: 100 },
    credentials: { accessToken: `at-${id}` },
    status: 'active',
    ...overrides
  }
}

function data(
  activeAccountId = 'current',
  accounts: Record<string, unknown> = {
    current: account('current', 5),
    next: account('next', 50)
  }
): AutoSwitchAccountData {
  return {
    accounts,
    activeAccountId,
    autoSwitchEnabled: true,
    autoSwitchThreshold: 10,
    autoSwitchInterval: 5,
    switchTarget: 'ide'
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('自动换号共享决策', () => {
  it('保持 renderer 既有语义：余额等于阈值即换，并取插入顺序中的首个健康账号', () => {
    const snapshot = data('current', {
      current: account('current', 10),
      banned: account('banned', 90, { lastError: 'AccountSuspendedException: 423' }),
      low: account('low', 10),
      firstHealthy: account('firstHealthy', 11),
      secondHealthy: account('secondHealthy', 90)
    })

    expect(decideAutoSwitch(snapshot, snapshot)).toMatchObject({
      fromAccountId: 'current',
      toAccountId: 'firstHealthy',
      switchTarget: 'ide'
    })
  })

  it('429 既不是封禁也不是额度信号，不会把高余额候选号排除', () => {
    const snapshot = data('current', {
      current: account('current', 0),
      rateLimited: account('rateLimited', 80, {
        lastError: 'HTTP 429 Too Many Requests'
      })
    })

    expect(isAutoSwitchBannedError('HTTP 429 Too Many Requests')).toBe(false)
    expect(decideAutoSwitch(snapshot, snapshot)?.toAccountId).toBe('rateLimited')
  })

  it('关闭开关、当前号仍高于阈值或没有高余额候选时不换', () => {
    expect(decideAutoSwitch({ ...data(), autoSwitchEnabled: false }, data())).toBeNull()
    expect(
      decideAutoSwitch(data(), data('current', {
        current: account('current', 11),
        next: account('next', 90)
      }))
    ).toBeNull()
    expect(
      decideAutoSwitch(
        data('current', {
          current: account('current', 1),
          next: account('next', 10)
        }),
        data('current', {
          current: account('current', 1),
          next: account('next', 10)
        })
      )
    ).toBeNull()
  })

  it('刷新后只用最新的当前号余额，但候选顺序/余额保持本轮开始时的快照', () => {
    const before = data('current', {
      current: account('current', 50),
      first: account('first', 20),
      second: account('second', 30)
    })
    const afterRefresh = data('current', {
      current: account('current', 0),
      // 刷新期间另一写方改了候选额度；迁移不偷偷改变原 renderer 的候选快照语义
      first: account('first', 0),
      second: account('second', 30)
    })

    expect(decideAutoSwitch(before, afterRefresh)?.toAccountId).toBe('first')
  })

  it('重启只重放仍与 activeAccountId 一致的持久化决定信封', () => {
    const decision: AutoSwitchDecision = {
      id: 'restart-decision',
      fromAccountId: 'current',
      toAccountId: 'next',
      switchTarget: 'both',
      decidedAt: 1234
    }

    expect(
      getCurrentAutoSwitchDecision({
        ...data('next'),
        autoSwitchDecision: decision
      })
    ).toEqual(decision)
    expect(
      getCurrentAutoSwitchDecision({
        ...data('manual'),
        autoSwitchDecision: decision
      })
    ).toBeNull()
    expect(
      getCurrentAutoSwitchDecision(
        {
          ...data('next'),
          autoSwitchDecision: decision
        },
        decision.id
      )
    ).toBeNull()
  })
})

describe('自动换号共享调度器', () => {
  it('先刷新当前号、原子提交决定，再执行壳副作用', async () => {
    let snapshot = data()
    const order: string[] = []
    const committed: AutoSwitchDecision[] = []
    const scheduler = createAutoSwitchScheduler({
      readAccountData: () => snapshot,
      refreshActiveAccount: async () => {
        order.push('refresh')
        snapshot = data('current', {
          current: account('current', 0),
          next: account('next', 50)
        })
      },
      applySwitch: async (decision) => {
        order.push(`apply:${decision.toAccountId}`)
        return true
      },
      commitDecision: async (decision) => {
        order.push(`commit:${decision.toAccountId}`)
        committed.push(decision)
        snapshot = data(decision.toAccountId, snapshot.accounts)
        return true
      },
      now: () => 1234,
      newDecisionId: () => 'decision-1'
    })

    await expect(scheduler.runNow()).resolves.toMatchObject({
      kind: 'switched',
      decision: { id: 'decision-1', decidedAt: 1234, toAccountId: 'next' }
    })
    expect(order).toEqual(['refresh', 'commit:next', 'apply:next'])
    expect(committed).toHaveLength(1)
  })

  it('决定已提交但壳副作用失败时明确报告，不把失败伪装成 switched', async () => {
    const commitDecision = vi.fn(async () => true)
    const scheduler = createAutoSwitchScheduler({
      readAccountData: () => data(),
      refreshActiveAccount: async () => {},
      applySwitch: async () => false,
      commitDecision
    })

    await expect(scheduler.runNow()).resolves.toEqual({
      kind: 'skipped',
      reason: 'switch-not-applied'
    })
    expect(commitDecision).toHaveBeenCalledTimes(1)
  })

  it('刷新期间用户手动换号导致决定陈旧时，绝不先执行壳副作用', async () => {
    const applySwitch = vi.fn(async () => true)
    const scheduler = createAutoSwitchScheduler({
      readAccountData: () => data(),
      refreshActiveAccount: async () => {},
      applySwitch,
      // 生产实现用 activeAccountId CAS 拒绝陈旧决定。
      commitDecision: async () => false
    })

    await expect(scheduler.runNow()).resolves.toEqual({
      kind: 'skipped',
      reason: 'decision-stale'
    })
    expect(applySwitch).not.toHaveBeenCalled()
  })

  it('并发 tick 合并为同一个 in-flight，避免两次决定打向不同账号', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const refreshActiveAccount = vi.fn(async () => gate)
    const commitDecision = vi.fn(async () => true)
    const scheduler = createAutoSwitchScheduler({
      readAccountData: () => data(),
      refreshActiveAccount,
      commitDecision
    })

    const first = scheduler.runNow()
    const second = scheduler.runNow()
    expect(refreshActiveAccount).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])
    expect(commitDecision).toHaveBeenCalledTimes(1)
  })

  it('stop 清 timer 并等待在途决定，保证 shutdown 后再 drain 不会被晚到写入追尾', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scheduler = createAutoSwitchScheduler({
      readAccountData: () => data(),
      refreshActiveAccount: async () => gate,
      commitDecision: async () => true
    })

    scheduler.start()
    const stopped = scheduler.stop()
    let settled = false
    void stopped.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await stopped
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('重启后从持久化 activeAccountId 重新判断；已切到健康号不会重复换号', async () => {
    const persisted = data('next', {
      current: account('current', 0),
      next: account('next', 50)
    })
    const commitDecision = vi.fn(async () => true)
    const scheduler = createAutoSwitchScheduler({
      readAccountData: () => persisted,
      refreshActiveAccount: async () => {},
      commitDecision
    })

    await expect(scheduler.runNow()).resolves.toEqual({
      kind: 'skipped',
      reason: 'threshold-not-reached'
    })
    expect(commitDecision).not.toHaveBeenCalled()
  })
})

describe('自动换号决定持久化', () => {
  it('activeAccountId、逐账号 isActive 与命令信封在同一 revision 原子落盘', async () => {
    let stored: unknown = {
      ...data(),
      revision: 7
    }
    setStoreRef({
      path: 'memory://auto-switch',
      get: () => stored,
      set: (_key, value) => {
        stored = value
      }
    })

    await expect(
      persistAutoSwitchDecision({
        id: 'persisted-decision',
        fromAccountId: 'current',
        toAccountId: 'next',
        switchTarget: 'both',
        decidedAt: 4567
      })
    ).resolves.toBe(true)

    const blob = stored as Record<string, unknown>
    const accounts = blob.accounts as Record<string, Record<string, unknown>>
    expect(blob).toMatchObject({
      revision: 8,
      activeAccountId: 'next',
      autoSwitchDecision: {
        id: 'persisted-decision',
        fromAccountId: 'current',
        toAccountId: 'next'
      }
    })
    expect(accounts.current.isActive).toBe(false)
    expect(accounts.next).toMatchObject({ isActive: true, lastUsedAt: 4567 })
  })

  it('用户已在刷新期间手动换号时拒绝陈旧决定，且不空增 revision', async () => {
    let stored: unknown = {
      ...data('manual'),
      accounts: {
        current: account('current', 0),
        next: account('next', 50),
        manual: account('manual', 80)
      },
      revision: 11
    }
    const set = vi.fn((_key: string, value: unknown) => {
      stored = value
    })
    setStoreRef({
      path: 'memory://auto-switch-stale',
      get: () => stored,
      set
    })

    await expect(
      persistAutoSwitchDecision({
        id: 'stale-decision',
        fromAccountId: 'current',
        toAccountId: 'next',
        switchTarget: 'ide',
        decidedAt: 999
      })
    ).resolves.toBe(false)
    expect(set).not.toHaveBeenCalled()
    expect((stored as Record<string, unknown>).revision).toBe(11)
  })
})
