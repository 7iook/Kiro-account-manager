/**
 * 反代账号激活编排 —— 主进程侧唯一收口
 *
 * ## 为什么这个文件必须存在（不是"多一层抽象"）
 *
 * 「让反代用指定账号」在单账号模式下是**三步**，缺任何一步都会产生一种
 * 特别难排查的失效：接口返回成功、可观测状态也正确，唯独反代的实际行为不变。
 *
 * 已实证的那一种：只调 `pool.setActiveAccount()` 移动 `currentIndex`，
 * 而不写 `config.selectedAccountIds`。因为 `proxyServer.ts:1582-1584` 在
 * `enableMultiAccount === false` 时取号读的是 `config.selectedAccountIds[0]`
 * —— `currentIndex` 在那条代码路径上**根本不被消费**。于是
 * `proxy-set-active-account` 会返回 `{ success:true, account:{...} }`、池指针
 * 确实动了、`getAllAccounts()` 也确实能看到新账号，但下一个外部请求仍打旧号。
 * 2026-07-28 的 RCA（`.archive/2026-07-28/proxy-hot-switch-single-account/`）
 * 就是这个根因，当时的修复把三步收在了 **renderer** 的
 * `store/accounts.ts:4306 syncActiveAccountToProxy`。
 *
 * 局域网面板没有 renderer store，若在面板里重算一遍这三步，就会出现第二个
 * 顺序真源 —— 两处早晚分叉，而分叉的表现正是上面那种"绿灯但行为错"。
 * 所以顺序下沉到主进程，两个前端共用它。
 *
 * ## 顺序为什么不可颠倒
 *
 * 1. **先入池刷凭据**：单账号模式是严格模式（`proxyServer.ts:1596-1599`），
 *    指定账号不在池里直接拒绝且**刻意不 fallback** —— 旧的 fallback 行为会
 *    导致「用户配只用 A，却静默用了 B」。所以必须先保证在池。
 * 2. **再写 `selectedAccountIds`**（仅单账号模式）：这是单账号模式的真开关。
 *    多账号模式下**不能写** —— 写了等于把轮询降级成固定单号。
 * 3. **最后动指针 + 作废会话粘性**：粘性在账号选择之前短路返回旧账号，
 *    不校验配额也不校验是否仍是选定账号，600s 才过期。不作废它，
 *    带固定 session id 的客户端会继续粘在旧账号上。
 *
 * ## 凭据只从盘上现读
 *
 * 不接受调用方传入的账号对象。切换流程会走 OIDC 拿到 refresh_v2，而调用方
 * （组件 prop / HTTP 请求体）手里的往往是快照，可能带已被 rotate 作废的 v1；
 * 灌进池就是「到期刷新 401」。
 *
 * ## 不抛出
 *
 * 所有失败都降级成 `{ applied:false, reason }`。这不是吞异常：`applied:false`
 * 与 `reason` 都会一路回到调用方与用户界面，只是**不阻断**已经成功的其他动作
 * （桌面端的语义：反代同步失败不该让已完成的 IDE/CLI 切换回滚）。
 */
import type { AccountPool } from './accountPool'
import type { ProxyAccount, ProxyConfig } from './types'

/** 未分组账号在分组过滤里的哨兵值（与 renderer 侧同一约定） */
export const UNGROUPED_SENTINEL = '__ungrouped__'

/**
 * 编排所需的宿主能力。由 `index.ts` 用真实 `proxyServer` + `store` 注入。
 *
 * 抽成接口而不是直接 import 模块级 `proxyServer`：`index.ts` 里的
 * `proxyServer` 是模块级可变状态（惰性 `initProxyServer()`），直接依赖它
 * 会让本文件无法在 vitest 里独立跑，也会把 electron 依赖拖进来。
 */
export interface ProxyActivationHost {
  /** 真实运行态 —— 读 server 句柄，不是"我以为启动了" */
  isRunning: () => boolean
  getAccountPool: () => AccountPool
  getConfig: () => ProxyConfig
  updateConfig: (patch: Partial<ProxyConfig>) => void
  /** 显式换号后作废旧会话粘性；返回被清掉的条数 */
  invalidateSessionAffinity: () => number
  /** 从盘上现读账号记录表（`accountData.accounts`） */
  loadAccountRecords: () => Record<string, unknown>
}

export type ProxyActivationResult =
  | { applied: true; mode: 'single' | 'multi'; accountId: string; email?: string }
  | { applied: false; reason: 'not_running' | 'no_credentials' | 'not_in_pool' | 'error' }

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  return v as Record<string, unknown>
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * `Account`（盘上形状） → `ProxyAccount`（池成员）的统一映射。
 *
 * 字段集吸收了此前三份并存映射里最全的那一份（`index.ts:2797` 自启动同步），
 * 三份各自漏掉不同字段的实际后果：
 *   - 漏 `weight` → SWRR 权重策略失真（缺省必须补 100）
 *   - 漏 `groupId` → 多账号轮询的分组过滤失效
 *   - 漏 `proxyUrl` → 账号绑定的出口代理不生效
 *
 * @param input 盘上的账号记录（`unknown` —— 盘上 blob 无编译期保护）
 * @param proxyUrl 该账号绑定的出口代理 URL；调用方按绑定表算好后传入
 * @returns 映射结果；缺 `id` 或缺 `accessToken` 时返回 `null`（不产出半个账号）
 */
export function toProxyAccountShared(input: unknown, proxyUrl?: string): ProxyAccount | null {
  const a = asRecord(input)
  if (!a) return null
  const id = asString(a.id)
  if (!id) return null
  const cred = asRecord(a.credentials) ?? {}
  const accessToken = asString(cred.accessToken)
  // 没有 access token 的账号进池只会在第一次请求时失败，且失败点远离原因
  if (!accessToken) return null

  const account: ProxyAccount = {
    id,
    accessToken,
    // 缺省对齐三份既有映射
    region: asString(cred.region) ?? 'us-east-1',
    // SWRR 权重缺省 100 —— 缺省会让权重策略失真
    weight: asNumber(a.weight) ?? 100
  }

  const assign = <K extends keyof ProxyAccount>(key: K, value: ProxyAccount[K] | undefined): void => {
    if (value !== undefined) account[key] = value
  }

  assign('email', asString(a.email))
  assign('refreshToken', asString(cred.refreshToken))
  // profileArn 顶层优先、凭据兜底（BuilderId/Social 可缺省，resolveProfileArn 会兜底）
  assign('profileArn', asString(a.profileArn) ?? asString(cred.profileArn))
  assign('expiresAt', asNumber(cred.expiresAt))
  assign('machineId', asString(a.machineId))
  assign('clientId', asString(cred.clientId))
  assign('clientSecret', asString(cred.clientSecret))
  assign('authMethod', asString(cred.authMethod) as ProxyAccount['authMethod'])
  // credentials.provider 优先，回落到顶层 idp
  assign('provider', asString(cred.provider) ?? asString(a.idp))
  // external_idp（Azure AD 等）刷新走外部 IdP 端点，不传会报"缺 tokenEndpoint"
  assign('tokenEndpoint', asString(cred.tokenEndpoint))
  assign('issuerUrl', asString(cred.issuerUrl))
  assign('scopes', asString(cred.scopes))
  assign('groupId', asString(a.groupId))
  assign('proxyUrl', proxyUrl)

  return account
}

/** 出口代理绑定信息（`accountData` 的两个同级字段） */
export interface ProxyBindingContext {
  bindings?: Record<string, string>
  proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
  /** 分组过滤白名单；不传 = 不过滤。含 `__ungrouped__` 时命中无 groupId 的账号 */
  groupIds?: string[]
}

/**
 * 解析某账号绑定的出口代理 URL。
 *
 * 只有「绑定存在 + 代理 enabled + 状态非 dead」才返回 —— 与既有两处内联
 * 映射的 `buildProxyUrl` 判定一致。把死代理透传进池会让该账号所有请求超时。
 */
function resolveBoundProxyUrl(accountId: string, ctx: ProxyBindingContext): string | undefined {
  const proxyId = ctx.bindings?.[accountId]
  if (!proxyId) return undefined
  const p = ctx.proxyPool?.[proxyId]
  if (!p || !p.enabled || p.status === 'dead') return undefined
  return asString(p.url)
}

/**
 * 从盘上账号表构建池成员列表（同步整池用）。
 *
 * 过滤条件对齐既有两处内联映射：`status === 'active'` 且有 `accessToken`。
 * 脏条目跳过而不抛 —— 一条坏数据不该让整次同步失败（那会表现成"池是空的
 * 但启动成功"，即空池启动）。
 */
export function buildProxyAccountsFromStore(
  records: Record<string, unknown> | undefined,
  ctx: ProxyBindingContext = {}
): ProxyAccount[] {
  if (!records) return []
  const groupFilter = ctx.groupIds ? new Set(ctx.groupIds) : null
  const out: ProxyAccount[] = []
  for (const raw of Object.values(records)) {
    const a = asRecord(raw)
    if (!a) continue
    if (asString(a.status) !== 'active') continue
    const id = asString(a.id)
    if (!id) continue
    if (groupFilter) {
      const gid = asString(a.groupId)
      const hit = gid ? groupFilter.has(gid) : groupFilter.has(UNGROUPED_SENTINEL)
      if (!hit) continue
    }
    const mapped = toProxyAccountShared(a, resolveBoundProxyUrl(id, ctx))
    if (mapped) out.push(mapped)
  }
  return out
}

/**
 * 让反代使用指定账号 —— 固定三步顺序，两个前端（桌面 renderer / 局域网面板）共用。
 *
 * @param accountId 目标账号 id
 * @param host 宿主能力（真实 proxyServer + store）
 * @param ctx 出口代理绑定信息（可选；不传则不透传 proxyUrl）
 */
export function activateProxyAccount(
  accountId: string,
  host: ProxyActivationHost,
  ctx: ProxyBindingContext = {}
): ProxyActivationResult {
  try {
    // 反代没跑就没有"当前账号"这个概念。返回 not_running 而不是"顺手启动"——
    // 隐式启动会绕过调用方的空池检查，正是空池启动的来源之一。
    if (!host.isRunning()) return { applied: false, reason: 'not_running' }

    // 凭据从盘上现读：调用方（HTTP body / 组件 prop）手里的可能是已作废的快照
    const record = asRecord(host.loadAccountRecords()[accountId])
    const mapped = record ? toProxyAccountShared(record, resolveBoundProxyUrl(accountId, ctx)) : null
    if (!mapped) return { applied: false, reason: 'no_credentials' }

    const pool = host.getAccountPool()

    // 步骤 1：入池 / 刷凭据。用 upsert 而非 addAccount —— 后者是重置式，会按
    // 不带 suspendedAt 的映射重算 isAvailable=true 并清零断路器，等于「切一下
    // 账号就静默解除运行期风控封禁」。
    pool.upsertAccount(mapped)

    // 步骤 2：单账号模式的真开关。多账号模式**不写** —— 写了会把轮询降级成单号。
    const isSingle = host.getConfig().enableMultiAccount === false
    if (isSingle) {
      host.updateConfig({ selectedAccountIds: [accountId] })
    }

    // 步骤 3：指针 + 会话粘性失效。粘性在账号选择之前短路返回旧账号，
    // 不作废它，带固定 session id 的客户端会继续粘在旧号上直到 600s 过期。
    pool.setActiveAccount(accountId)
    host.invalidateSessionAffinity()

    const result: ProxyActivationResult = {
      applied: true,
      mode: isSingle ? 'single' : 'multi',
      accountId
    }
    if (mapped.email !== undefined) result.email = mapped.email
    return result
  } catch (err) {
    // 不抛：反代同步失败不该阻断调用方已经成功的其他动作。失败对调用方可见
    // （applied:false + reason），且原因进日志 —— 不是吞异常返回成功。
    console.error('[proxyActivation] activate failed:', err)
    return { applied: false, reason: 'error' }
  }
}
