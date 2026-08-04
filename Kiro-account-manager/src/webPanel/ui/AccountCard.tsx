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
import { useState } from 'react'
import type { AccountListItem } from '../api/panel'
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
  const banned = isBannedError(item.lastError)
  const percent = item.usage?.percentUsed
  // 进度条宽度必须裁到 100%，但**文字百分比不裁** —— 超额时 120% 是用户要知道的事实
  const barWidth = Math.min(100, Math.max(0, (percent ?? 0) * 100))
  const busy = pending !== null

  return (
    <li
      className={[
        'rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-900',
        banned
          ? 'border-red-400 dark:border-red-800'
          : item.isActive
            ? 'border-blue-400 dark:border-blue-700'
            : 'border-slate-200 dark:border-slate-700'
      ].join(' ')}
    >
      {/* ── 标题行：身份 + 状态 ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium text-slate-900 dark:text-slate-100">
            {displayName(item)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {item.subscription && (
              <span
                className={`rounded px-1.5 py-0.5 font-medium text-white ${subscriptionColor(item)}`}
              >
                {item.subscription.title || item.subscription.type || '未知方案'}
              </span>
            )}
            {item.idp && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {item.idp}
              </span>
            )}
            {item.isActive && (
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
              : item.status === 'active'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          ].join(' ')}
        >
          {banned ? '已封禁' : statusLabel(item.status)}
        </span>
      </div>

      {/* ── 额度：卡片里最重的信息 ── */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatUsage(item.usage?.current)}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            / {formatUsage(item.usage?.limit)}
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
        {item.usage?.nextResetDate !== undefined && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            重置于 {item.usage.nextResetDate}
          </p>
        )}
      </div>

      {/* ── 次要事实：订阅剩余 / Token 过期 ── */}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {item.subscription?.daysRemaining !== undefined && (
          <div className="flex gap-1">
            <dt>订阅剩余</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {item.subscription.daysRemaining} 天
            </dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt>Token</dt>
          <dd className="text-slate-700 dark:text-slate-200">
            {formatTokenExpiry(item.expiresAt)}
          </dd>
        </div>
      </dl>

      {item.lastError !== undefined && (
        <p className="mt-2 break-words rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {item.lastError}
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
              disabled={busy || !item.hasRefreshToken || !item.canRefreshViaOidc}
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
          {(!item.hasRefreshToken || !item.canRefreshViaOidc) && (
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
          {/*
            桌面端有「复制凭据」「详情」「编辑」「删除」。
            前者被决策卡 §3 明确豁免（web 端不展示凭据）；后三者没有对应路由。
            与其放一个点了没反应的按钮，不如说明去哪做。
          */}
          <p className="border-t border-slate-200 pt-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            复制凭据、编辑、删除请在桌面端操作。
          </p>
        </div>
      )}
    </li>
  )
}
