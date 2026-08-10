/**
 * 面板展示层的纯格式化函数。
 *
 * 桌面端 `components/accounts/_helpers.ts` 里的同类函数**不能直接复用**：
 * 它们的入参是 `Account`（含 `credentials` 明文），而面板拿到的是投影后的
 * `AccountListItem`（无凭据、字段全部可缺失）。硬套会在字段缺失时产出 `NaN` / `Invalid Date`。
 *
 * 所以这里按面板的 DTO 形状重写，且**每个函数都要能吃 undefined** ——
 * `dto.ts` 的注释写明「输入是 unknown，缺字段是常态而非异常」。
 * 与桌面端保持一致的只有配色与文案口径（下面逐处标注来源）。
 */
import type { AccountListItem } from '../api/panel'

/** 额度数字：整数千分位。`undefined` → `-`（不是 0 —— 0 是真实值，未知不是） */
export function formatUsage(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '-'
  return Math.round(v).toLocaleString('zh-CN')
}

/** 百分比。上限不裁剪 —— 超额时 120% 是有意义的信息（桌面端同样显示超出量） */
export function formatPercent(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '-'
  return `${Math.round(v * 100)}%`
}

/**
 * Token 过期时间的相对表述。口径照桌面端 `_helpers.ts:formatTokenExpiry` 的中文分支。
 * `undefined` → `-`（DTO 里 `expiresAt` 是可缺失的）
 */
export function formatTokenExpiry(expiresAt: number | undefined): string {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return '-'
  const diff = expiresAt - Date.now()
  if (diff <= 0) return '已过期'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) {
    const rem = minutes % 60
    return rem > 0 ? `${hours} 小时 ${rem} 分` : `${hours} 小时`
  }
  const days = Math.floor(hours / 24)
  const remH = hours % 24
  return remH > 0 ? `${days} 天 ${remH} 小时` : `${days} 天`
}

/** 状态中文。照桌面端 `_helpers.ts:StatusLabelsZh`，未知状态原样显示而不吞掉 */
const STATUS_LABEL: Record<string, string> = {
  active: '正常',
  expired: '已过期',
  error: '错误',
  refreshing: '刷新中',
  unknown: '未知'
}

export function statusLabel(status: string | undefined): string {
  if (!status) return '未知'
  return STATUS_LABEL[status] ?? status
}

/**
 * 封禁判定。照桌面端 `_helpers.ts:isBannedError` 的关键词集合。
 *
 * 为什么面板也要自己判：DTO 给的是 `lastError` 原文，没有 `isBanned` 布尔。
 * 判据重复是已知的小债（见交付报告），但把关键词集合塞进 DTO 属于改契约，不在本轮范围。
 */
export function isBannedError(error: string | undefined): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('accountsuspendedexception') ||
    lower.includes('account suspended') ||
    lower.includes('temporarily_suspended') ||
    lower.includes('temporarily suspended') ||
    (lower.includes('user id is') && lower.includes('suspended')) ||
    lower.includes('账户已封禁') ||
    lower.includes('已封禁') ||
    /\b423\b/.test(lower)
  )
}

/** 订阅徽章配色。照桌面端 `_helpers.ts:getSubscriptionColor` */
export function subscriptionColor(item: AccountListItem): string {
  const text = (item.subscription?.title || item.subscription?.type || '').toUpperCase()
  if (text.includes('PRO+') || text.includes('PRO_PLUS') || text.includes('PROPLUS')) {
    return 'bg-purple-500'
  }
  if (text.includes('POWER')) return 'bg-amber-500'
  if (text.includes('PRO')) return 'bg-blue-500'
  return 'bg-gray-500'
}

/** 额度条颜色：接近/超出上限时变色（与 ui/progress.tsx 的阈值口径一致） */
export function usageBarClass(percentUsed: number | undefined): string {
  const p = (percentUsed ?? 0) * 100
  if (p >= 100) return 'bg-red-500'
  if (p >= 80) return 'bg-amber-500'
  return 'bg-blue-500'
}

/** 列表主标题：昵称优先，其次邮箱，再退到 userId。全缺时给 id 而不是空字符串 */
export function displayName(item: AccountListItem): string {
  return item.nickname || item.email || item.userId || item.id
}

/**
 * 倒计时文案：从绝对时间戳到现在的剩余时长（`mm:ss`）。
 *
 * 入参是**绝对** epoch ms（服务端只给时间戳，倒计时在本地渲染）。
 *
 * - `null` / `undefined` / 非有限值 → `-`（表示「没有下一次」）。
 *   注意判空必须区分 `null` 与 `0`：`0` 是合法 epoch，若把它当「无」，
 *   真实的 1970 时间戳就会被静默吞掉。这里的判据是 `Number.isFinite`，
 *   `0` 会照常走下面的计算（结果是负数 → 「即将放行」）。
 * - 已到点或时钟回拨导致为负 → `即将放行`（不显示负号 —— 负倒计时看起来像 bug，
 *   而它的真实含义是「这一刻正在放或马上放」）。
 */
export function formatCountdown(target: number | null | undefined, now: number = Date.now()): string {
  if (target === null || target === undefined || !Number.isFinite(target)) return '-'
  const diff = target - now
  if (diff <= 0) return '即将放行'
  const totalSec = Math.ceil(diff / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}
