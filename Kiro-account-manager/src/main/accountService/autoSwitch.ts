/**
 * 自动换号共享内核。
 *
 * renderer 只负责桌面专属的 IDE / CLI / 机器码副作用；阈值判断、候选号选择、
 * 单飞与周期调度全部在 main 进程。Electron 与无头服务端都实例化本文件里的同一个
 * 调度器，避免两份决策逻辑随时间漂移。
 */
import { randomUUID } from 'node:crypto'
import { checkAccountStatus } from './check'
import {
  applyAccountDataMutation,
  getAccountDataSnapshot,
  type AccountsBlob
} from './state'
import type { AccountLike, AccountRuntimeDeps } from './types'
import { isAccountSuspensionError } from '../../shared/accountSuspension'

export type AutoSwitchTarget = 'ide' | 'cli' | 'both'

export type AutoSwitchAccountData = Record<string, unknown> & {
  accounts?: Record<string, unknown>
  activeAccountId?: string | null
  autoSwitchEnabled?: boolean
  autoSwitchThreshold?: number
  autoSwitchInterval?: number
  switchTarget?: AutoSwitchTarget
}

export interface AutoSwitchPlan {
  fromAccountId: string
  toAccountId: string
  switchTarget: AutoSwitchTarget
}

export interface AutoSwitchDecision extends AutoSwitchPlan {
  id: string
  decidedAt: number
}

export type AutoSwitchRunResult =
  | { kind: 'switched'; decision: AutoSwitchDecision }
  | {
      kind: 'skipped'
      reason:
        | 'disabled'
        | 'no-data'
        | 'no-active-account'
        | 'active-account-missing'
        | 'threshold-not-reached'
        | 'no-candidate'
        | 'switch-not-applied'
        | 'decision-stale'
    }

export interface AutoSwitchScheduler {
  /** 幂等启动；启动时立即检查一次，随后按盘上的分钟配置继续。 */
  start: () => void
  /** 设置变化时提前检查；已有决定在途时不重入。 */
  wake: () => void
  /** 测试/显式触发入口；并发调用共享同一个 in-flight。 */
  runNow: () => Promise<AutoSwitchRunResult>
  /** 清 timer 并等待在途决定结束。 */
  stop: () => Promise<void>
}

export interface AutoSwitchSchedulerDeps {
  /** 每次现读持久化数据；绝不长期缓存账号或配置快照。 */
  readAccountData: () => AutoSwitchAccountData | null
  /** 刷新当前账号额度。实现会经 accountService 的持久化收口写回盘。 */
  refreshActiveAccount: (account: Record<string, unknown>) => Promise<void>
  /**
   * 壳层副作用。服务端用于推进反代；桌面省略，由 renderer 消费持久化决定后执行
   * IDE / CLI / 机器码 / 反代热切换。
   */
  applySwitch?: (decision: AutoSwitchDecision) => Promise<boolean>
  /** 原子写 activeAccountId / isActive / 决定信封；返回 false 表示决定已陈旧。 */
  commitDecision: (decision: AutoSwitchDecision) => Promise<boolean>
  now?: () => number
  newDecisionId?: () => string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function remainingCredits(account: Record<string, unknown>): number {
  const usage = asRecord(account.usage)
  // 保持旧 renderer 的算式语义：非法旧数据得到 NaN；当前号不会触发，候选号沿用旧行为。
  return Number(usage?.limit) - Number(usage?.current)
}

/**
 * 自动换号保留既有函数名，封禁语义委托给跨进程共享分类器。
 *
 * 额度阈值仍由本模块单独判断；429 是瞬时限流，不属于封禁信号。
 */
export function isAutoSwitchBannedError(error?: unknown): boolean {
  return isAccountSuspensionError(error)
}

/**
 * 读取重启后仍有效的决定信封。
 *
 * 信封本身会长期留盘；只有它的目标仍等于当前 activeAccountId、目标账号仍存在，
 * 且壳尚未确认应用该 id 时才可重放。用户后来手动换号会让二者不一致，此时旧信封作废。
 */
export function getCurrentAutoSwitchDecision(
  data: AutoSwitchAccountData | null,
  appliedDecisionId?: unknown
): AutoSwitchDecision | null {
  if (!data) return null
  const raw = asRecord(data.autoSwitchDecision)
  if (!raw) return null

  const id = asString(raw.id)
  const fromAccountId = asString(raw.fromAccountId)
  const toAccountId = asString(raw.toAccountId)
  const switchTarget = raw.switchTarget
  const decidedAt = raw.decidedAt
  if (
    !id ||
    !fromAccountId ||
    !toAccountId ||
    (switchTarget !== 'ide' && switchTarget !== 'cli' && switchTarget !== 'both') ||
    typeof decidedAt !== 'number' ||
    !Number.isFinite(decidedAt) ||
    asString(data.activeAccountId) !== toAccountId ||
    appliedDecisionId === id
  ) {
    return null
  }

  const accounts = asRecord(data.accounts)
  if (!accounts || !asRecord(accounts[toAccountId])) return null

  return { id, fromAccountId, toAccountId, switchTarget, decidedAt }
}

/**
 * 纯决策：保持旧 renderer 的可观察顺序。
 *
 * - 阈值和候选集合取检查开始时快照；
 * - 仅当前账号额度取刷新后的快照；
 * - switchTarget 在刷新后现读；
 * - 候选号按账号对象插入顺序取第一个。
 */
export function decideAutoSwitch(
  beforeRefresh: AutoSwitchAccountData,
  afterRefresh: AutoSwitchAccountData
): AutoSwitchPlan | null {
  if (beforeRefresh.autoSwitchEnabled !== true) return null

  const activeAccountId = asString(beforeRefresh.activeAccountId)
  if (!activeAccountId) return null

  const beforeAccounts = asRecord(beforeRefresh.accounts)
  const afterAccounts = asRecord(afterRefresh.accounts)
  const refreshedActive = afterAccounts ? asRecord(afterAccounts[activeAccountId]) : undefined
  if (!beforeAccounts || !refreshedActive) return null

  const threshold =
    typeof beforeRefresh.autoSwitchThreshold === 'number'
      ? beforeRefresh.autoSwitchThreshold
      : 0
  if (!(remainingCredits(refreshedActive) <= threshold)) return null

  for (const raw of Object.values(beforeAccounts)) {
    const candidate = asRecord(raw)
    if (!candidate) continue
    const candidateId = asString(candidate.id)
    if (!candidateId || candidateId === activeAccountId) continue
    if (isAutoSwitchBannedError(candidate.lastError)) continue
    if (remainingCredits(candidate) <= threshold) continue

    const switchTarget =
      afterRefresh.switchTarget === 'cli' || afterRefresh.switchTarget === 'both'
        ? afterRefresh.switchTarget
        : 'ide'
    return {
      fromAccountId: activeAccountId,
      toAccountId: candidateId,
      switchTarget
    }
  }

  return null
}

function classifyNoPlan(
  beforeRefresh: AutoSwitchAccountData,
  afterRefresh: AutoSwitchAccountData
): AutoSwitchRunResult {
  if (beforeRefresh.autoSwitchEnabled !== true) return { kind: 'skipped', reason: 'disabled' }
  const activeAccountId = asString(beforeRefresh.activeAccountId)
  if (!activeAccountId) return { kind: 'skipped', reason: 'no-active-account' }
  const afterAccounts = asRecord(afterRefresh.accounts)
  const active = afterAccounts ? asRecord(afterAccounts[activeAccountId]) : undefined
  if (!active) return { kind: 'skipped', reason: 'active-account-missing' }
  const threshold =
    typeof beforeRefresh.autoSwitchThreshold === 'number'
      ? beforeRefresh.autoSwitchThreshold
      : 0
  return remainingCredits(active) <= threshold
    ? { kind: 'skipped', reason: 'no-candidate' }
    : { kind: 'skipped', reason: 'threshold-not-reached' }
}

async function runOnce(deps: AutoSwitchSchedulerDeps): Promise<AutoSwitchRunResult> {
  const beforeRefresh = deps.readAccountData()
  if (!beforeRefresh) return { kind: 'skipped', reason: 'no-data' }
  if (beforeRefresh.autoSwitchEnabled !== true) {
    return { kind: 'skipped', reason: 'disabled' }
  }

  const activeAccountId = asString(beforeRefresh.activeAccountId)
  if (!activeAccountId) return { kind: 'skipped', reason: 'no-active-account' }
  const beforeAccounts = asRecord(beforeRefresh.accounts)
  const activeAccount = beforeAccounts ? asRecord(beforeAccounts[activeAccountId]) : undefined
  if (!activeAccount) return { kind: 'skipped', reason: 'active-account-missing' }

  try {
    await deps.refreshActiveAccount(activeAccount)
  } catch (error) {
    // 与旧 renderer 一致：刷新失败不让 timer 死掉，仍按盘上最后一份额度继续判断。
    console.warn('[AutoSwitch] Failed to refresh active account before decision:', error)
  }

  const afterRefresh = deps.readAccountData() ?? beforeRefresh
  const plan = decideAutoSwitch(beforeRefresh, afterRefresh)
  if (!plan) return classifyNoPlan(beforeRefresh, afterRefresh)

  const decision: AutoSwitchDecision = {
    ...plan,
    id: (deps.newDecisionId ?? randomUUID)(),
    decidedAt: (deps.now ?? Date.now)()
  }

  // activeAccountId 是防陈旧 CAS：必须先提交，才能执行不可回滚的壳副作用。
  // 否则刷新期间用户手动换号时，持久化会正确拒绝决定，反代指针却已被旧决定改走。
  if (!(await deps.commitDecision(decision))) {
    return { kind: 'skipped', reason: 'decision-stale' }
  }
  if (deps.applySwitch && !(await deps.applySwitch(decision))) {
    return { kind: 'skipped', reason: 'switch-not-applied' }
  }

  console.log(
    `[AutoSwitch] Switched ${decision.fromAccountId} -> ${decision.toAccountId} ` +
      `(target=${decision.switchTarget})`
  )
  return { kind: 'switched', decision }
}

function intervalMs(data: AutoSwitchAccountData | null): number {
  const minutes = data?.autoSwitchInterval
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
    ? minutes * 60 * 1000
    : 5 * 60 * 1000
}

export function createAutoSwitchScheduler(deps: AutoSwitchSchedulerDeps): AutoSwitchScheduler {
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<AutoSwitchRunResult> | null = null

  const clearTimer = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const schedule = (): void => {
    if (!started || timer) return
    timer = setTimeout(() => {
      timer = null
      void launch().catch(() => {
        /* 错误已由 launch 记录 */
      })
    }, intervalMs(deps.readAccountData()))
    timer.unref?.()
  }

  const launch = (): Promise<AutoSwitchRunResult> => {
    if (inFlight) return inFlight
    const task = runOnce(deps)
    inFlight = task
    const settled = (): void => {
      if (inFlight === task) inFlight = null
      schedule()
    }
    // 不用 finally 后丢弃返回 Promise：原 task reject 时那会再造一个无人接的 rejection。
    void task.then(settled, (error) => {
      console.error('[AutoSwitch] Scheduler tick failed:', error)
      settled()
    })
    return task
  }

  return {
    start: () => {
      if (started) return
      started = true
      void launch().catch(() => {
        /* 错误已由 launch 的 rejection handler 记录；timer 仍会续排 */
      })
    },
    wake: () => {
      if (!started || inFlight) return
      clearTimer()
      void launch().catch(() => {
        /* 同上 */
      })
    },
    runNow: () => launch(),
    stop: async () => {
      started = false
      clearTimer()
      const current = inFlight
      if (current) await current.then(() => undefined, () => undefined)
    }
  }
}

class StaleAutoSwitchDecision extends Error {}

/** 决定落盘的唯一实现；activeAccountId 与每条 isActive 在同一 revision 内更新。 */
export async function persistAutoSwitchDecision(decision: AutoSwitchDecision): Promise<boolean> {
  try {
    const result = await applyAccountDataMutation((prev) => {
      // 刷新/上游调用期间用户可能手动换号。此时决定已陈旧，绝不能把用户选择覆盖回去。
      if (prev.activeAccountId !== decision.fromAccountId) {
        throw new StaleAutoSwitchDecision()
      }
      const accounts = asRecord(prev.accounts)
      if (!accounts || !asRecord(accounts[decision.toAccountId])) {
        throw new StaleAutoSwitchDecision()
      }

      const nextAccounts: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(accounts)) {
        const account = asRecord(raw)
        if (!account) {
          nextAccounts[key] = raw
          continue
        }
        const id = asString(account.id) ?? key
        nextAccounts[key] = {
          ...account,
          isActive: id === decision.toAccountId,
          ...(id === decision.toAccountId ? { lastUsedAt: decision.decidedAt } : {})
        }
      }

      return {
        ...prev,
        accounts: nextAccounts,
        activeAccountId: decision.toAccountId,
        // renderer 把它当命令信封消费；服务端无 renderer，但保留同一盘面形状。
        autoSwitchDecision: decision
      } as AccountsBlob
    })
    return result.ok
  } catch (error) {
    if (error instanceof StaleAutoSwitchDecision) return false
    throw error
  }
}

/** 用 accountService 的检查/持久化原语构造生产调度器，两种壳只替换 applySwitch。 */
export function createPersistentAutoSwitchScheduler(
  runtimeDeps: AccountRuntimeDeps,
  applySwitch?: (decision: AutoSwitchDecision) => Promise<boolean>
): AutoSwitchScheduler {
  return createAutoSwitchScheduler({
    readAccountData: getAccountDataSnapshot,
    refreshActiveAccount: async (account) => {
      await checkAccountStatus(runtimeDeps, account as AccountLike)
    },
    applySwitch,
    commitDecision: persistAutoSwitchDecision
  })
}

let desktopScheduler: AutoSwitchScheduler | null = null

/**
 * renderer 通过既有 background-batch-refresh IPC 发一次同步信号；真正的 timer 和决策
 * 都留在 Electron main。重复信号只唤醒同一个单例，不会创建第二个 scheduler。
 */
export function syncDesktopAutoSwitchScheduler(runtimeDeps: AccountRuntimeDeps): void {
  if (!desktopScheduler) {
    desktopScheduler = createPersistentAutoSwitchScheduler(runtimeDeps)
    desktopScheduler.start()
    return
  }
  desktopScheduler.wake()
}

/** 测试与显式生命周期收尾用；生产 Electron 退出会结束整个 main 进程。 */
export async function stopDesktopAutoSwitchScheduler(): Promise<void> {
  const scheduler = desktopScheduler
  desktopScheduler = null
  await scheduler?.stop()
}
