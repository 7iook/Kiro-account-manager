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
  maxWaitMs: 600000, // 10min · 兜底轮询周期(非单请求挂起上限,上限由 totalBudgetMs 定)
  totalBudgetMs: 1680000, // 28min · 保持默认不变(升到 6h 需用户显式设,避免静默改行为)
  graceMs: 15000, // 15s
  timeoutAction: 'keep_blocking'
}

// clamp 边界(方案 §3)
const PING_MIN = 1000
const PING_MAX = 40000 // < 45s watchdog
const BUDGET_MIN = 10000
// 实测 2026-08-06(claude-cli/2.1.220 · 探针实验):客户端总超时由 API_TIMEOUT_MS 决定,
// 默认 600000(10min),可由用户上调(本机实测设为 1800000=30min 生效)。旧注释写的
// 「客户端 30min 顶」源自误读 —— 那个 1800000 是 429 退避时长常量,不是请求超时。
// 真正掐断挂起的是客户端 idle watchdog:v2.1.196 起默认开启,无语义正文字节则 ~5min
// 断开重连(实测掐断周期恒定 310s,ping 心跳不算正文、挡不住它)。
// 故预算上限不再假设客户端顶,取 6h —— 与客户端 rate-limit reset 上限同量级;
// 真实可挂时长由「客户端 API_TIMEOUT_MS」与「idle watchdog 重连」共同决定,非本值。
// 生产实证:曾成功挂起 4172s(69.5min)后放行续接,故上限必须 > 1h。
const BUDGET_MAX = 21600000 // 6h
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
