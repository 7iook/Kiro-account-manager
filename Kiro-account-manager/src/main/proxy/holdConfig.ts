// 挂起门闸(Hold Gate)配置归一化 —— clamp / 跨字段校验的唯一收口(SSOT)
//
// 方案:.archive/2026-07-28/hold-gate-blocking/hold-gate-blocking-design.md §3 配置校验
//   非有限值 / 越界一律 clamp 到默认并 warn;校验只在此处做,不散落进 UI/IPC/proxy 三处。
//   输出结构 = HoldGate 构造所需的 HoldGateRuntimeConfig(pingIntervalMs/maxWaitMs/
//   totalBudgetMs/graceMs/timeoutAction),proxyServer 归一化后直接注入 HoldGate。
import type { ProxyConfig } from './types'
import type { HoldGateRuntimeConfig, HoldTimeoutAction } from './holdGate'

/** 挂起门闸运行配置默认值(方案 §3 表)。 */
export const HOLD_DEFAULTS: HoldGateRuntimeConfig = {
  pingIntervalMs: 10000, // 10s < 45s watchdog
  maxWaitMs: 600000, // 10min
  totalBudgetMs: 1680000, // 28min < 客户端 30min 硬顶
  graceMs: 15000, // 15s
  timeoutAction: 'keep_blocking'
}

// clamp 边界(方案 §3)
const PING_MIN = 1000
const PING_MAX = 40000 // < 45s watchdog
const BUDGET_MIN = 10000
const BUDGET_MAX = 1740000 // 29min,硬留 1min < 客户端 30min 顶
const GRACE_MIN = 1000
const GRACE_MAX = 60000

const VALID_ACTIONS: readonly HoldTimeoutAction[] = ['keep_blocking', 'error', 'graceful_stop']

/** 有限数才 clamp 到 [min,max];非有限值(NaN/Infinity/非 number)回落 fallback。 */
function clampOrDefault(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

/**
 * 归一化 ProxyConfig 里的 hold* 字段为 HoldGate 运行配置。
 * 跨字段约束:maxWaitMs ≤ totalBudgetMs;graceMs < totalBudgetMs。
 */
export function normalizeHoldConfig(config: Partial<ProxyConfig>): HoldGateRuntimeConfig {
  const pingIntervalMs = clampOrDefault(config.holdPingIntervalMs, PING_MIN, PING_MAX, HOLD_DEFAULTS.pingIntervalMs)
  const totalBudgetMs = clampOrDefault(config.holdTotalBudgetMs, BUDGET_MIN, BUDGET_MAX, HOLD_DEFAULTS.totalBudgetMs)

  // maxWaitMs 先 clamp 到独立区间,再受 totalBudgetMs 截断(方案:min(maxWaitMs, totalBudget))
  let maxWaitMs = clampOrDefault(config.holdMaxWaitMs, BUDGET_MIN, BUDGET_MAX, HOLD_DEFAULTS.maxWaitMs)
  if (maxWaitMs > totalBudgetMs) maxWaitMs = totalBudgetMs

  // graceMs 先 clamp 到 [GRACE_MIN, GRACE_MAX],再保证严格 < totalBudgetMs
  let graceMs = clampOrDefault(config.holdGraceMs, GRACE_MIN, GRACE_MAX, HOLD_DEFAULTS.graceMs)
  if (graceMs >= totalBudgetMs) graceMs = Math.max(1, totalBudgetMs - 1)

  const rawAction = config.holdTimeoutAction
  const timeoutAction: HoldTimeoutAction =
    typeof rawAction === 'string' && VALID_ACTIONS.includes(rawAction as HoldTimeoutAction)
      ? (rawAction as HoldTimeoutAction)
      : HOLD_DEFAULTS.timeoutAction

  return { pingIntervalMs, maxWaitMs, totalBudgetMs, graceMs, timeoutAction }
}
