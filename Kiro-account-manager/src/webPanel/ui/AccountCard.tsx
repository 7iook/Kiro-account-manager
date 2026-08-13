/**
 * 单个账号卡片 —— 面板的主体。
 *
 * ## 为什么是卡片而不是桌面端那种一行 N 列
 *
 * 桌面端 `AccountListRow.tsx` 把邮箱/状态/订阅/额度/过期/7 个图标按钮压在一行里，
 * 靠 hover `title` 提示每个图标的含义。手机上这两条都不成立：横向没有那么多像素，
 * 且**没有 hover** —— 图标按钮在触屏上是无标签的谜题。
 * 所以这里纵向堆叠 + 按钮带文字，图标只作辅助。
 *
 * ## 主次分明
 *
 * 用户自述的日常动线是「导入 → 刷新额度 → 挑号 → 开代理」。所以：
 *   - 额度是卡片里视觉权重最高的元素（大字 + 进度条）
 *   - 「刷新额度」是唯一的常驻主按钮（48px 高，拇指可达）
 *   - 其余操作（切换 / 刷新 Token / 超额 / 订阅）折叠进「更多操作」，
 *     展开才出现 —— 不是藏起来，是不让它们跟主动作抢注意力
 */
import { useEffect, useState } from 'react'
import {
  deleteAccount,
  fetchAccountGroups,
  fetchAccounts,
  restoreDeletedAccount,
  unsuspendAccount,
  updateAccountMetadata,
  type AccountListItem,
  type PanelAccountGroup
} from '../api/panel'
import { PanelApiError } from '../api/client'
import { announcePanelAccountsInvalidated } from './accountDataEvents'
import {
  displayName,
  formatPercent,
  formatTokenExpiry,
  formatUsage,
  isBannedError,
  statusLabel,
  subscriptionColor,
  usageBarClass
} from './format'

export interface AccountCardProps {
  item: AccountListItem
  /** 正在进行中的操作名（用于禁用按钮 + 显示进度），无则 null */
  pending: string | null
  onCheck: () => void
  onRefreshToken: () => void
  onSwitch: () => void
  onSwitchCli: () => void
  onToggleOverage: (enabled: boolean) => void
  onOpenSubscription: () => void
}

export function AccountCard({
  item,
  pending,
  onCheck,
  onRefreshToken,
  onSwitch,
  onSwitchCli,
  onToggleOverage,
  onOpenSubscription
}: AccountCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [metadata, setMetadata] = useState<{
    nickname?: string
    groupId?: string
    isActive: boolean
    status?: string
    lastError?: string
  } | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [unsuspendOpen, setUnsuspendOpen] = useState(false)
  const [groups, setGroups] = useState<PanelAccountGroup[]>([])
  const [editRevision, setEditRevision] = useState(0)
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [groupDraft, setGroupDraft] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [unsuspendConfirmation, setUnsuspendConfirmation] = useState('')
  const [unsuspendNotice, setUnsuspendNotice] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<{
    undoUntil: number
    proxyPoolSyncPending: boolean
  } | null>(null)
  const [undoExpired, setUndoExpired] = useState(false)
  const [managementBusy, setManagementBusy] = useState(false)
  const [managementError, setManagementError] = useState<string | null>(null)

  useEffect(() => {
    if (!deleted) return
    const timer = window.setTimeout(
      () => setUndoExpired(true),
      Math.max(0, deleted.undoUntil - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [deleted])

  const viewItem: AccountListItem = metadata ? { ...item, ...metadata } : item
  const confirmationTarget = viewItem.email ?? viewItem.id

  const describeManagementError = (error: unknown): string => {
    if (error instanceof PanelApiError) return error.message
    return error instanceof Error ? error.message : '操作失败，请重试'
  }

  const handleManagementError = (error: unknown): void => {
    if (error instanceof PanelApiError && error.isUnauthorized) {
      // AccountCard 没有会话状态所有权；整页重载会让 App 重新问 `/session` 并回登录页。
      // 不在组件内另造一套 logged-in 状态机。
      window.location.reload()
      return
    }
    setManagementError(describeManagementError(error))
  }

  const loadFreshAccountSnapshot = async (): Promise<{
    revision: number
    account: AccountListItem
  }> => {
    const payload = await fetchAccounts()
    const fresh = payload.accounts.find((candidate) => candidate.id === item.id)
    if (!fresh) throw new Error('账号已不存在，请重新加载列表')
    return { revision: payload.revision ?? 0, account: fresh }
  }

  const openEditor = async (): Promise<void> => {
    if (managementBusy) return
    setManagementBusy(true)
    setManagementError(null)
    try {
      const [snapshot, groupPayload] = await Promise.all([
        loadFreshAccountSnapshot(),
        fetchAccountGroups()
      ])
      setEditRevision(snapshot.revision)
      setNicknameDraft(snapshot.account.nickname ?? '')
      setGroupDraft(snapshot.account.groupId ?? '')
      setGroups(groupPayload.groups)
      setEditOpen(true)
    } catch (error) {
      handleManagementError(error)
    } finally {
      setManagementBusy(false)
    }
  }

  const saveMetadata = async (): Promise<void> => {
    if (managementBusy) return
    setManagementBusy(true)
    setManagementError(null)
    try {
      const response = await updateAccountMetadata(item.id, editRevision, {
        nickname: nicknameDraft === '' ? null : nicknameDraft,
        groupId: groupDraft === '' ? null : groupDraft
      })
      setMetadata((current) => ({
        ...current,
        nickname: response.account.nickname,
        groupId: response.account.groupId,
        isActive: response.account.isActive
      }))
      announcePanelAccountsInvalidated()
      setEditOpen(false)
    } catch (error) {
      handleManagementError(error)
    } finally {
      setManagementBusy(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (managementBusy || deleteConfirmation !== confirmationTarget) return
    setManagementBusy(true)
    setManagementError(null)
    try {
      // 点最终确认时才取 revision，避免用户在确认框里停留期间桌面端已经改过数据。
      const snapshot = await loadFreshAccountSnapshot()
      const response = await deleteAccount(item.id, snapshot.revision)
      setUndoExpired(false)
      setDeleted({
        undoUntil: response.undoUntil,
        proxyPoolSyncPending: response.proxyPoolSyncPending
      })
      announcePanelAccountsInvalidated()
      setDeleteOpen(false)
      setDeleteConfirmation('')
    } catch (error) {
      handleManagementError(error)
    } finally {
      setManagementBusy(false)
    }
  }

  const undoDelete = async (): Promise<void> => {
    if (managementBusy) return
    setManagementBusy(true)
    setManagementError(null)
    try {
      const response = await restoreDeletedAccount(item.id)
      setMetadata((current) => ({
        ...current,
        nickname: response.account.nickname,
        groupId: response.account.groupId,
        // 恢复账号不静默恢复为当前激活账号，服务端明确返回 false。
        isActive: response.account.isActive
      }))
      setDeleted(null)
      setUndoExpired(false)
      announcePanelAccountsInvalidated()
      setManagementError(
        response.proxyPoolSyncPending
          ? '账号已恢复，但反代账号池尚未同步；请在反代面板点“重新同步账号池”。'
          : null
      )
    } catch (error) {
      handleManagementError(error)
    } finally {
      setManagementBusy(false)
    }
  }

  const confirmUnsuspend = async (): Promise<void> => {
    if (managementBusy || unsuspendConfirmation !== confirmationTarget) return
    setManagementBusy(true)
    setManagementError(null)
    setUnsuspendNotice(null)
    try {
      const response = await unsuspendAccount(item.id)
      setMetadata((current) => ({
        ...current,
        nickname: response.account.nickname,
        groupId: response.account.groupId,
        isActive: response.account.isActive,
        status: response.account.status,
        lastError: response.account.lastError
      }))
      const poolState = response.runtime.proxyPoolSyncPending
        ? '反代账号池同步尚未完成，请在反代面板重新同步账号池'
        : response.runtime.inProxyPool
          ? '已回到反代池'
          : response.runtime.proxyInitialized
            ? '当前未进入反代池'
            : '反代尚未初始化'
      setUnsuspendNotice(`本机封禁标记已清除，${poolState}；上游状态未验证，可能立刻再次被封。`)
      setUnsuspendOpen(false)
      setUnsuspendConfirmation('')
      announcePanelAccountsInvalidated()
    } catch (error) {
      handleManagementError(error)
    } finally {
      setManagementBusy(false)
    }
  }

  if (deleted) {
    return (
      <li className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-100">账号已删除</p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
          {undoExpired
            ? '撤销窗口已结束；请刷新账号列表。'
            : '当前页面可在 10 分钟内撤销；刷新页面或服务重启后不能恢复。'}
        </p>
        {deleted.proxyPoolSyncPending && (
          <p className="mt-2 text-xs text-red-700 dark:text-red-300">
            账号已从磁盘删除，但反代账号池尚未同步；请在反代面板点“重新同步账号池”。
          </p>
        )}
        {managementError !== null && (
          <p role="status" className="mt-2 text-xs text-red-700 dark:text-red-300">
            {managementError}
          </p>
        )}
        <button
          type="button"
          onClick={() => void undoDelete()}
          disabled={managementBusy || undoExpired}
          className="mt-3 h-11 w-full rounded-xl border border-amber-400 text-sm font-medium text-amber-900 active:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-100 dark:active:bg-amber-900"
        >
          {managementBusy ? '恢复中…' : '撤销删除'}
        </button>
      </li>
    )
  }

  const banned = isBannedError(viewItem.lastError)
  const percent = viewItem.usage?.percentUsed
  // 进度条宽度必须裁到 100%，但**文字百分比不裁** —— 超额时 120% 是用户要知道的事实
  const barWidth = Math.min(100, Math.max(0, (percent ?? 0) * 100))
  const busy = pending !== null

  return (
    <li
      className={[
        'rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-900',
        banned
          ? 'border-red-400 dark:border-red-800'
          : viewItem.isActive
            ? 'border-blue-400 dark:border-blue-700'
            : 'border-slate-200 dark:border-slate-700'
      ].join(' ')}
    >
      {/* ── 标题行：身份 + 状态 ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium text-slate-900 dark:text-slate-100">
            {displayName(viewItem)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {viewItem.subscription && (
              <span
                className={`rounded px-1.5 py-0.5 font-medium text-white ${subscriptionColor(viewItem)}`}
              >
                {viewItem.subscription.title || viewItem.subscription.type || '未知方案'}
              </span>
            )}
            {viewItem.idp && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {viewItem.idp}
              </span>
            )}
            {viewItem.isActive && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                当前账号
              </span>
            )}
          </div>
        </div>
        <span
          className={[
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            banned
              ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
              : viewItem.status === 'active'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          ].join(' ')}
        >
          {banned ? '已封禁' : statusLabel(viewItem.status)}
        </span>
      </div>

      {/* ── 额度：卡片里最重的信息 ── */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatUsage(viewItem.usage?.current)}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            / {formatUsage(viewItem.usage?.limit)}
            {percent !== undefined && <> · {formatPercent(percent)}</>}
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className={`h-full rounded-full transition-all ${usageBarClass(percent)}`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        {/* 额度分解只在服务端真给了值时才出现，不显示一排 `-` */}
        {viewItem.usage?.nextResetDate !== undefined && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            重置于 {viewItem.usage.nextResetDate}
          </p>
        )}
      </div>

      {/* ── 次要事实：订阅剩余 / Token 过期 ── */}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {viewItem.subscription?.daysRemaining !== undefined && (
          <div className="flex gap-1">
            <dt>订阅剩余</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {viewItem.subscription.daysRemaining} 天
            </dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt>Token</dt>
          <dd className="text-slate-700 dark:text-slate-200">
            {formatTokenExpiry(viewItem.expiresAt)}
          </dd>
        </div>
      </dl>

      {viewItem.lastError !== undefined && (
        <p className="mt-2 break-words rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {viewItem.lastError}
        </p>
      )}
      {unsuspendNotice !== null && (
        <p
          role="status"
          className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {unsuspendNotice}
        </p>
      )}

      {/* ── 主动作：刷新额度 ── */}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCheck}
          disabled={busy}
          className="h-12 flex-1 rounded-xl bg-blue-600 text-base font-medium text-white active:bg-blue-700 disabled:opacity-60"
        >
          {pending === 'check' ? '刷新中…' : '刷新额度'}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="h-12 shrink-0 rounded-xl border border-slate-300 px-4 text-sm text-slate-700 active:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
        >
          更多操作
        </button>
      </div>

      {/* ── 折叠区：其余桌面端操作 ── */}
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          {/*
            切换目标是**运行桌面端那台电脑**的 SSO 缓存（routes.ts 已注明）。
            必须写清楚，否则手机上点它的人会以为是在给手机登录。
          */}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            以下「切换」写入的是运行桌面端那台电脑的登录态，不是本手机。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onSwitch}
              disabled={busy || banned}
              className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
            >
              {pending === 'switch' ? '切换中…' : '切换到 IDE'}
            </button>
            <button
              type="button"
              onClick={onSwitchCli}
              disabled={busy || banned}
              className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
            >
              {pending === 'switch-cli' ? '切换中…' : '切换到 CLI'}
            </button>
            <button
              type="button"
              onClick={onRefreshToken}
              // DTO 送的是判定结论：没有 refreshToken 或不具备 OIDC 字段就刷不了
              disabled={busy || !viewItem.hasRefreshToken || !viewItem.canRefreshViaOidc}
              className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
            >
              {pending === 'refresh-token' ? '刷新中…' : '刷新 Token'}
            </button>
            <button
              type="button"
              onClick={onOpenSubscription}
              disabled={busy}
              className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
            >
              管理订阅
            </button>
          </div>
          {(!viewItem.hasRefreshToken || !viewItem.canRefreshViaOidc) && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              该账号缺少刷新凭证，无法刷新 Token（网页密钥账号属正常情况）。
            </p>
          )}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-sm text-slate-700 dark:text-slate-200">允许超额使用</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onToggleOverage(true)}
                disabled={busy}
                className="h-11 rounded-xl border border-slate-300 px-4 text-sm active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:active:bg-slate-800"
              >
                开启
              </button>
              <button
                type="button"
                onClick={() => onToggleOverage(false)}
                disabled={busy}
                className="h-11 rounded-xl border border-slate-300 px-4 text-sm active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:active:bg-slate-800"
              >
                关闭
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            {banned && (
              <button
                type="button"
                onClick={() => {
                  setManagementError(null)
                  setUnsuspendNotice(null)
                  setUnsuspendConfirmation('')
                  setUnsuspendOpen(true)
                }}
                disabled={busy || managementBusy}
                className="col-span-2 h-11 rounded-xl border border-amber-400 text-sm font-medium text-amber-800 active:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-200 dark:active:bg-amber-950"
              >
                强制解除封禁
              </button>
            )}
            <button
              type="button"
              onClick={() => void openEditor()}
              disabled={busy || managementBusy}
              className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
            >
              {managementBusy && !deleteOpen ? '加载中…' : '编辑账号'}
            </button>
            <button
              type="button"
              onClick={() => {
                setManagementError(null)
                setDeleteConfirmation('')
                setDeleteOpen(true)
              }}
              disabled={busy || managementBusy}
              className="h-11 rounded-xl border border-red-300 text-sm font-medium text-red-700 active:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:active:bg-red-950"
            >
              删除账号
            </button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">凭据不会显示或通过手机编辑。</p>
          {managementError !== null && !editOpen && !deleteOpen && !unsuspendOpen && (
            <p role="status" className="text-xs text-red-700 dark:text-red-300">
              {managementError}
            </p>
          )}
        </div>
      )}

      {unsuspendOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={`unsuspend-account-title-${item.id}`}
            className="max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id={`unsuspend-account-title-${item.id}`}
              className="text-lg font-semibold text-amber-800 dark:text-amber-200"
            >
              强制解除账号封禁
            </h2>
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <p>此操作只会清除本机封禁标记，不会向上游验证账号是否恢复。</p>
              <p className="mt-2 font-medium">结果仍是未验证状态，账号可能立刻再次被封。</p>
            </div>
            <label className="mt-4 block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">输入 {confirmationTarget} 以确认强制解除</span>
              <input
                value={unsuspendConfirmation}
                onChange={(event) => setUnsuspendConfirmation(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 w-full rounded-xl border border-amber-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-amber-500 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            {managementError !== null && (
              <p role="status" className="mt-3 text-sm text-red-700 dark:text-red-300">
                {managementError}
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setUnsuspendOpen(false)
                  setUnsuspendConfirmation('')
                  setManagementError(null)
                }}
                disabled={managementBusy}
                className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmUnsuspend()}
                disabled={managementBusy || unsuspendConfirmation !== confirmationTarget}
                className="h-11 rounded-xl bg-amber-600 text-sm font-medium text-white active:bg-amber-700 disabled:opacity-50"
              >
                {managementBusy ? '解除中…' : '确认强制解除'}
              </button>
            </div>
          </section>
        </div>
      )}

      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={`edit-account-title-${item.id}`}
            className="max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id={`edit-account-title-${item.id}`}
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              编辑账号
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              仅修改备注和分组；登录凭据不会发送到本页面。
            </p>
            <div className="mt-4 space-y-4">
              <label className="block text-sm text-slate-700 dark:text-slate-200">
                <span className="mb-1 block">账号备注</span>
                <input
                  value={nicknameDraft}
                  onChange={(event) => setNicknameDraft(event.target.value)}
                  maxLength={120}
                  autoComplete="off"
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-blue-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="block text-sm text-slate-700 dark:text-slate-200">
                <span className="mb-1 block">账号分组</span>
                <select
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-blue-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                >
                  <option value="">不分组</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {managementError !== null && (
              <p role="status" className="mt-3 text-sm text-red-700 dark:text-red-300">
                {managementError}
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditOpen(false)
                  setManagementError(null)
                }}
                disabled={managementBusy}
                className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void saveMetadata()}
                disabled={managementBusy}
                className="h-11 rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700 disabled:opacity-60"
              >
                {managementBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={`delete-account-title-${item.id}`}
            className="max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id={`delete-account-title-${item.id}`}
              className="text-lg font-semibold text-red-700 dark:text-red-300"
            >
              确认删除账号
            </h2>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
              删除会从所有账号列表移除该账号。为防止误触，请输入
              <strong className="mx-1 break-all">{confirmationTarget}</strong>
              确认。
            </p>
            <label className="mt-4 block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">输入 {confirmationTarget} 以确认</span>
              <input
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 w-full rounded-xl border border-red-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-red-500 dark:border-red-800 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              成功后当前页面提供 10 分钟撤销入口；服务重启后不能恢复。
            </p>
            {managementError !== null && (
              <p role="status" className="mt-3 text-sm text-red-700 dark:text-red-300">
                {managementError}
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false)
                  setDeleteConfirmation('')
                  setManagementError(null)
                }}
                disabled={managementBusy}
                className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={managementBusy || deleteConfirmation !== confirmationTarget}
                className="h-11 rounded-xl bg-red-600 text-sm font-medium text-white active:bg-red-700 disabled:opacity-50"
              >
                {managementBusy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      )}
    </li>
  )
}
