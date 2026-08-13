/**
 * webPanel 路由表 —— 桌面端操作到 HTTP 端点的一对一映射
 *
 * 决策卡 §1 不变量 1：**本文件不另建业务真源**。每个 handler 只做三件事：
 *   ① 解析并校验 HTTP 入参 ② 调 `accountService` 的对应函数
 *   ③ 把结果经 `respond.ts` 出口写回，并把业务层的错误形状归一成稳定错误码。
 *
 * C2 的编辑 / 删除也遵守这条：字段补丁在这里由 HTTP 入参组装，但读改写、revision
 * 仲裁、落盘与广播全部只走 `applyAccountDataMutation`。绕过它直接 `store.set` 才会
 * 产生第二个写入真源，并让手机与桌面并发时互相覆盖。
 *
 * ## 为什么端点按 accountId 寻址（决策卡 §3 第二处照搬豁免）
 *
 * 桌面端多个 handler 把 `accessToken` 作为**第一个入参**
 * （`account-get-models` / `account-get-subscriptions` / `account-get-subscription-url` /
 * `account-set-overage`）。renderer 与 main 同机走 IPC，这没问题。
 *
 * 但 HTTP 端点若照抄这个签名，浏览器就必须把 token 经局域网发过来 —— 直接违反
 * §1 负条件 4。所以面板一律 `/:accountId/...` 寻址，token 由主进程内部按 id 从
 * store 取出后再交给 `accountService`。这是**有意分歧**，不是不一致的疏漏：
 * 照抄签名恰好是最省力、且看起来最「忠于原实现」的做法，所以必须写明。
 *
 * ## 错误码归一收在这里，不下沉业务层
 *
 * `accountService/types.ts:214` 已明确：业务层刻意保留现有 IPC 响应的**不统一**形状
 * （有的 `error` 是 string，有的是 `{ message }`），26 个 renderer 组件已适配它。
 * 面板的稳定错误码契约（决策卡 §3）在这一层做，不改业务层返回值。
 */
import type http from 'node:http'
import { sendJson, sendError, type PanelErrorCode } from './respond'
import { projectAccountsBlob, type AccountListPayload } from './dto'
import type { ApiKeyImportInput, ApiKeyImportResult } from '../accountService/importApiKey'
import { applyAccountDataMutation, type AccountsBlob } from '../accountService/state'
import type {
  PanelConfigAuditActor,
  PanelConfigOperationOutcome
} from '../ipc/panelProxyDeps'
import type {
  PanelProxyApiKeyCreateResult,
  PanelProxyApiKeyListResult,
  PanelProxyApiKeyRevokeResult,
  PanelProxyApiKeyVerifyResult,
  PanelProxyConfigResult,
  PanelProxyConfigView,
  PanelProxyPortChangeResult
} from './proxyConfigPolicy'

/** 业务层的通用返回形状 —— 两种 error 形状都要能吃（见文件头说明） */
type ServiceLike = {
  success?: boolean
  error?: string | { message?: string; isBanned?: boolean }
  [k: string]: unknown
}

/**
 * 路由层需要的远端 / 宿主能力由装配层注入（`accountService/*` 的函数加上已装配好的
 * deps），因此本文件**不 import electron、不碰 store**。C2 账号元数据写入直接调用
 * 共享内核的 `applyAccountDataMutation`；它自身使用启动时已注入的持久化端口，桌面壳
 * 与服务端壳仍是同一写入收口，不需要再给两个装配点各抄一层薄转发。
 *
 * 注意 identity 形状：调用方传的是 `AccountApiIdentity`（含 accessToken）——
 * token 是**主进程内部**从 store 取的，从未过网。
 */
export interface PanelAccountIdentity {
  accessToken: string
  region?: string
  profileArn?: string
  machineId?: string
  provider?: string
  authMethod?: string
  accountId?: string
}

export interface PanelRouteDeps {
  /** `accountService/accounts.ts:loadAccounts` —— 返回整表 blob（含明文凭据，绝不直出） */
  loadAccountsBlob: () => Promise<unknown>
  /**
   * `accountService/importApiKey.ts:importApiKeys` —— 手机端粘贴 ksk_ 导入。
   *
   * 与其它 dep 的形状差异：它返回自己的结果类型而不是 `ServiceLike`。**有意为之** ——
   * 逐条结果（哪条成功 / 哪条已存在 / 哪条被封）是这个端点的全部价值，
   * 压成一个 `{success}` 布尔就等于把它丢掉。`respondService` 的归一路径不适用于它。
   */
  importApiKeys: (input: ApiKeyImportInput) => Promise<ApiKeyImportResult>
  /** `accountService/check.ts:checkAccountStatus` —— 用户日常的「刷新额度」 */
  checkAccountStatus: (account: unknown) => Promise<ServiceLike>
  /** `accountService/refresh.ts:refreshAccountToken` */
  refreshAccountToken: (account: unknown) => Promise<ServiceLike>
  /** `accountService/switch.ts:switchAccountToIde` —— ⚠️ 写的是主进程所在机器的 SSO 缓存 */
  switchAccountToIde: (credentials: unknown) => Promise<ServiceLike>
  /** `accountService/switchCli.ts:switchAccountToCli` */
  switchAccountToCli: (credentials: unknown) => Promise<ServiceLike>
  /** `accountService/switch.ts:logoutAccount` */
  logoutFromIde: () => Promise<ServiceLike>
  /** `accountService/subscription.ts:getAccountModels` */
  getAccountModels: (identity: PanelAccountIdentity) => Promise<ServiceLike>
  /** `accountService/subscription.ts:getAccountSubscriptions` */
  getAccountSubscriptions: (identity: PanelAccountIdentity) => Promise<ServiceLike>
  /** `accountService/subscription.ts:getAccountSubscriptionUrl` */
  getAccountSubscriptionUrl: (
    identity: PanelAccountIdentity,
    subscriptionType?: string
  ) => Promise<ServiceLike>
  /** `accountService/subscription.ts:setAccountOverage` */
  setAccountOverage: (identity: PanelAccountIdentity, enabled: boolean) => Promise<ServiceLike>

  // ===== 反代编排（W8）=====
  //
  // 这五个的实现全部落在主进程 `proxy/activation.ts` + 既有 `proxy-*` IPC 背后的
  // 同一批函数上。**路由层不复制 ProxyPanel 的状态机** —— 顺序与判据都在编排层，
  // 这里只做「解析入参 → 调编排 → 归一响应」。
  //
  // 为什么没有 `proxyUpdateConfig` 这样的通用配置端点：`proxy-update-config` 有
  // 大量副作用分支（日志开关 / payload 上限 / agent 模式 / steering 重载），从手机
  // 误触的代价远大于收益。面板只暴露日常操作，端口 / API Key / 模型映射留在桌面端。

  /** 反代真实状态（running 读 server 句柄，不是"我发过启动请求"） */
  proxyGetStatus: () => Promise<ServiceLike>
  /** 从盘上账号表同步整池（启动前必须先做，否则空池启动） */
  proxySyncPool: () => Promise<ServiceLike>
  /**
   * 让反代使用指定账号 —— 内部固定三步顺序（入池 → 单账号模式写
   * selectedAccountIds → 指针+粘性失效）。只调其中一步会产生
   * 「接口成功但反代仍打旧号」的失效，故必须整体复用编排。
   */
  proxyActivateAccount: (accountId: string) => Promise<ServiceLike>
  /** 启动反代（实现内部先同步池，池空则拒绝启动） */
  proxyStart: () => Promise<ServiceLike>
  /** 停止反代 */
  proxyStop: () => Promise<ServiceLike>
  /**
   * 立刻放行全部挂起请求（挂起门闸的「放行」动作）。
   *
   * 复用既有 `ProxyServer.releaseHeldRequests()`，与桌面端按钮、自动放行调度器
   * 同一入口。面板刻意**只有这一个动作**、不接受任何配置参数 —— 改间隔 / 改开关
   * 留在桌面端（同上文「为什么没有 proxyUpdateConfig」的同一理由）。
   */
  proxyReleaseHeld: () => Promise<ServiceLike>
  /** 手机面板可见的反代配置安全投影；生产装配由 panelProxyDeps 注入。 */
  proxyGetConfig?: () => Promise<PanelProxyConfigView>
  proxyUpdateConfig?: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyConfigResult>>
  proxyChangePort?: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyPortChangeResult>>
  proxyListApiKeys?: () => Promise<PanelProxyApiKeyListResult>
  proxyCreateApiKey?: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyApiKeyCreateResult>>
  proxyVerifyApiKey?: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyApiKeyVerifyResult>>
  proxyRevokeApiKey?: (
    input: unknown,
    actor: PanelConfigAuditActor
  ) => Promise<PanelConfigOperationOutcome<PanelProxyApiKeyRevokeResult>>
}

/** 已解析的请求上下文（路径已去掉 `/panel` 前缀） */
export interface PanelRequestContext {
  method: string
  /** 去前缀后的路径，例如 `/api/accounts/acc-1/check` */
  path: string
  /** 已解析的 JSON body（非 JSON / 空 body → undefined） */
  body?: Record<string, unknown>
  /** 经 trusted-proxy 链解析后的客户端地址；不能直接采用 X-Forwarded-For。 */
  clientIP?: string
  /** 仅用于配置审计，服务端会截断并再次脱敏。 */
  userAgent?: string
}

/** 业务层返回的 error 归一成一句话（两种形状都吃） */
function errorMessage(result: ServiceLike | undefined): string | undefined {
  const e = result?.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message
  return undefined
}

/**
 * 业务层失败 → 稳定错误码 + HTTP 状态。
 *
 * 归一规则刻意保守：只有能确定语义的才细分，其余一律 `INTERNAL_ERROR` 500。
 * **绝不回传上游原始报文** —— message 只给已归一的短句（`sendJson` 的强制脱敏是第二道）。
 */
function mapServiceFailure(result: ServiceLike | undefined): {
  status: number
  code: PanelErrorCode
  message?: string
} {
  const msg = errorMessage(result)
  const e = result?.error
  const isBanned = typeof e === 'object' && e !== null && e.isBanned === true
  if (isBanned) {
    // 封禁不是可重试失败，语义上属凭据不可用
    return { status: 400, code: 'INVALID_CREDENTIAL', message: msg }
  }
  if (msg && /refresh\s*token|刷新/i.test(msg)) {
    return { status: 502, code: 'TOKEN_REFRESH_FAILED', message: msg }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: msg }
}

/** 统一把 `accountService` 的 ServiceLike 结果写回 */
function respondService(res: http.ServerResponse, result: ServiceLike | undefined): void {
  if (result?.success === false) {
    const { status, code, message } = mapServiceFailure(result)
    sendError(res, status, code, message)
    return
  }
  sendJson(res, 200, result ?? { success: true })
}

/** 从整表 blob 里取出某个账号的原始记录（含凭据，仅供主进程内部使用） */
function findAccountRecord(blob: unknown, accountId: string): Record<string, unknown> | null {
  if (!blob || typeof blob !== 'object') return null
  const raw = (blob as Record<string, unknown>).accounts
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>).id === accountId
      ) {
        return entry as Record<string, unknown>
      }
    }
    return null
  }
  const hit = (raw as Record<string, unknown>)[accountId]
  return hit && typeof hit === 'object' ? (hit as Record<string, unknown>) : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 手机编辑分组时所需的最小 DTO。description/createdAt 等管理字段不出网。 */
interface PanelAccountGroup {
  id: string
  name: string
  color?: string
  order: number
}

function projectAccountGroups(blob: unknown): PanelAccountGroup[] {
  const raw = asRecord(blob)?.groups
  const entries = Array.isArray(raw)
    ? raw
    : asRecord(raw)
      ? Object.values(raw as Record<string, unknown>)
      : []

  const groups: PanelAccountGroup[] = []
  for (const entry of entries) {
    const group = asRecord(entry)
    if (!group || typeof group.id !== 'string' || typeof group.name !== 'string') continue
    const item: PanelAccountGroup = {
      id: group.id,
      name: group.name,
      order: typeof group.order === 'number' && Number.isFinite(group.order) ? group.order : 0
    }
    if (typeof group.color === 'string') item.color = group.color
    groups.push(item)
  }
  return groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

function hasGroup(blob: unknown, groupId: string): boolean {
  return projectAccountGroups(blob).some((group) => group.id === groupId)
}

function accountMutationSummary(accountId: string, account: Record<string, unknown>): ServiceLike {
  const summary: Record<string, unknown> = {
    id: accountId,
    isActive: account.isActive === true
  }
  if (typeof account.nickname === 'string') summary.nickname = account.nickname
  if (typeof account.groupId === 'string') summary.groupId = account.groupId
  return summary
}

function readExpectedRevision(
  res: http.ServerResponse,
  body: Record<string, unknown> | undefined
): number | undefined {
  const value = body?.expectedRevision
  if (!Number.isInteger(value) || (value as number) < 0) {
    sendError(res, 400, 'INVALID_CREDENTIAL', '缺少有效的 expectedRevision，请刷新列表后重试')
    return undefined
  }
  return value as number
}

function respondAccountMutation(res: http.ServerResponse, result: ServiceLike): void {
  if (result.success !== false) {
    sendJson(res, 200, result)
    return
  }
  switch (result.error) {
    case 'STALE_REVISION':
      sendError(res, 409, 'STALE_REVISION')
      return
    case 'ACCOUNT_ALREADY_EXISTS':
      sendError(res, 409, 'ACCOUNT_ALREADY_EXISTS')
      return
    case 'ACCOUNT_NOT_FOUND':
      sendError(res, 404, 'ACCOUNT_NOT_FOUND')
      return
    default:
      sendError(res, 500, 'INTERNAL_ERROR')
  }
}

/**
 * 账号集合写盘后，让已经初始化的反代池立刻重建。
 *
 * `PROXY_NOT_RUNNING` 表示根本没有内存池需要同步，不算待处理；其它失败不能把已经
 * 成功落盘的删除/恢复翻转成 HTTP 失败（否则客户端重试会得到完全不同的语义），
 * 因此用响应标志诚实交给 UI 提示手动同步。
 */
async function syncProxyPoolAfterAccountSetChange(deps: PanelRouteDeps): Promise<boolean> {
  try {
    const result = await deps.proxySyncPool()
    if (result.success !== false || errorMessage(result) === 'PROXY_NOT_RUNNING') return false
  } catch {
    // 下方统一记不含账号/凭据的固定日志；异常原文可能夹上游敏感内容，不直接打印。
  }
  console.warn('[webPanel] account data changed, but live proxy pool refresh is pending')
  return true
}

/**
 * 在 object / 历史 array 两种账号容器里替换单条记录。
 *
 * 调用前已经用同一份 blob 验过账号存在，且 apply 带 expectedRevision；若执行时找不到，
 * 说明盘面违反了 revision 契约，抛错比递增 revision 后假装成功更诚实。
 */
function replaceAccount(
  prev: AccountsBlob,
  accountId: string,
  update: (account: Record<string, unknown>) => Record<string, unknown>
): AccountsBlob {
  const raw = prev.accounts
  if (Array.isArray(raw)) {
    const index = raw.findIndex((entry) => asRecord(entry)?.id === accountId)
    if (index < 0) throw new Error(`account ${accountId} disappeared without a revision change`)
    const current = asRecord(raw[index])
    if (!current) throw new Error(`account ${accountId} is not an object`)
    const accounts = [...raw]
    accounts[index] = update(current)
    return { ...prev, accounts }
  }

  const accountsRecord = asRecord(raw)
  const current = accountsRecord ? asRecord(accountsRecord[accountId]) : null
  if (!accountsRecord || !current) {
    throw new Error(`account ${accountId} disappeared without a revision change`)
  }
  return {
    ...prev,
    accounts: { ...accountsRecord, [accountId]: update(current) }
  }
}

function removeAccount(
  prev: AccountsBlob,
  accountId: string
): {
  next: AccountsBlob
  account: Record<string, unknown>
  container: 'array' | 'record'
  proxyBinding?: unknown
} {
  const raw = prev.accounts
  let account: Record<string, unknown> | null = null
  let nextAccounts: unknown
  let container: 'array' | 'record'

  if (Array.isArray(raw)) {
    const index = raw.findIndex((entry) => asRecord(entry)?.id === accountId)
    if (index >= 0) account = asRecord(raw[index])
    if (!account) throw new Error(`account ${accountId} disappeared without a revision change`)
    nextAccounts = raw.filter((_, i) => i !== index)
    container = 'array'
  } else {
    const accountsRecord = asRecord(raw)
    account = accountsRecord ? asRecord(accountsRecord[accountId]) : null
    if (!accountsRecord || !account) {
      throw new Error(`account ${accountId} disappeared without a revision change`)
    }
    const copy = { ...accountsRecord }
    delete copy[accountId]
    nextAccounts = copy
    container = 'record'
  }

  const bindings = asRecord(prev.accountProxyBindings)
  const proxyBinding = bindings?.[accountId]
  const nextBindings = bindings ? { ...bindings } : undefined
  if (nextBindings) delete nextBindings[accountId]

  return {
    account,
    container,
    ...(proxyBinding !== undefined ? { proxyBinding } : {}),
    next: {
      ...prev,
      accounts: nextAccounts,
      ...(prev.activeAccountId === accountId ? { activeAccountId: null } : {}),
      ...(nextBindings ? { accountProxyBindings: nextBindings } : {})
    }
  }
}

const DELETE_UNDO_WINDOW_MS = 10 * 60 * 1000

interface DeletedAccountTombstone {
  account: Record<string, unknown>
  container: 'array' | 'record'
  proxyBinding?: unknown
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * 删除撤销只保存在主进程内存，不经网络回传凭据，也不另造第二份盘上账号库。
 *
 * 这是一道防手机误触的短期安全网，不是假装成永久回收站：服务重启或超过 10 分钟即失效，
 * UI 会把这个边界写清楚。盘上另存 tombstone 会被桌面端下一次整表保存丢掉，反而制造
 * 一个看似可靠、实际随机消失的恢复机制。
 */
const deletedAccounts = new Map<string, DeletedAccountTombstone>()

function rememberDeletedAccount(
  accountId: string,
  deleted: Omit<DeletedAccountTombstone, 'expiresAt' | 'timer'>
): number {
  const previous = deletedAccounts.get(accountId)
  if (previous) clearTimeout(previous.timer)
  const expiresAt = Date.now() + DELETE_UNDO_WINDOW_MS
  const timer = setTimeout(() => deletedAccounts.delete(accountId), DELETE_UNDO_WINDOW_MS)
  timer.unref?.()
  deletedAccounts.set(accountId, { ...deleted, expiresAt, timer })
  return expiresAt
}

function takeValidTombstone(accountId: string): DeletedAccountTombstone | null {
  const tombstone = deletedAccounts.get(accountId)
  if (!tombstone) return null
  if (tombstone.expiresAt <= Date.now()) {
    clearTimeout(tombstone.timer)
    deletedAccounts.delete(accountId)
    return null
  }
  return tombstone
}

async function handleAccountEdit(
  res: http.ServerResponse,
  accountId: string,
  blob: unknown,
  body: Record<string, unknown> | undefined
): Promise<void> {
  const expectedRevision = readExpectedRevision(res, body)
  if (expectedRevision === undefined) return

  const allowed = new Set(['expectedRevision', 'nickname', 'groupId'])
  const unknownKey = Object.keys(body ?? {}).find((key) => !allowed.has(key))
  if (unknownKey) {
    sendError(res, 400, 'INVALID_CREDENTIAL', `不支持修改字段 ${unknownKey}`)
    return
  }

  const hasNickname = Object.prototype.hasOwnProperty.call(body, 'nickname')
  const hasGroupId = Object.prototype.hasOwnProperty.call(body, 'groupId')
  if (!hasNickname && !hasGroupId) {
    sendError(res, 400, 'INVALID_CREDENTIAL', '请至少修改备注或分组')
    return
  }
  const nickname = body?.nickname
  const groupId = body?.groupId
  if (hasNickname && nickname !== null && typeof nickname !== 'string') {
    sendError(res, 400, 'INVALID_CREDENTIAL', 'nickname 必须是字符串或 null')
    return
  }
  if (hasGroupId && groupId !== null && typeof groupId !== 'string') {
    sendError(res, 400, 'INVALID_CREDENTIAL', 'groupId 必须是字符串或 null')
    return
  }
  if (typeof groupId === 'string' && groupId.length > 0 && !hasGroup(blob, groupId)) {
    sendError(res, 400, 'INVALID_CREDENTIAL', '所选分组不存在，请刷新后重试')
    return
  }

  const key = `account-edit:${accountId}:${expectedRevision}:${JSON.stringify({
    nickname,
    groupId
  })}`
  const result = await singleFlight(key, async () => {
    let updated: Record<string, unknown> | null = null
    const applied = await applyAccountDataMutation(
      (prev) =>
        replaceAccount(prev, accountId, (current) => {
          updated = { ...current }
          if (hasNickname) {
            if (nickname === null || nickname === '') delete updated.nickname
            else updated.nickname = nickname
          }
          if (hasGroupId) {
            if (groupId === null || groupId === '') delete updated.groupId
            else updated.groupId = groupId
          }
          return updated
        }),
      { expectedRevision }
    )
    if (!applied.ok) return { success: false, error: applied.code }
    if (!updated) return { success: false, error: 'ACCOUNT_NOT_FOUND' }
    return {
      success: true,
      revision: applied.revision,
      account: accountMutationSummary(accountId, updated)
    }
  })
  respondAccountMutation(res, result)
}

async function handleAccountDelete(
  res: http.ServerResponse,
  deps: PanelRouteDeps,
  accountId: string,
  body: Record<string, unknown> | undefined
): Promise<void> {
  const expectedRevision = readExpectedRevision(res, body)
  if (expectedRevision === undefined) return

  const result = await singleFlight(`account-delete:${accountId}:${expectedRevision}`, async () => {
    const capture: { deleted?: ReturnType<typeof removeAccount> } = {}
    const applied = await applyAccountDataMutation(
      (prev) => {
        const deleted = removeAccount(prev, accountId)
        capture.deleted = deleted
        return deleted.next
      },
      { expectedRevision }
    )
    if (!applied.ok) return { success: false, error: applied.code }
    const deleted = capture.deleted
    if (!deleted) return { success: false, error: 'ACCOUNT_NOT_FOUND' }

    const undoUntil = rememberDeletedAccount(accountId, {
      account: deleted.account,
      container: deleted.container,
      ...(deleted.proxyBinding !== undefined ? { proxyBinding: deleted.proxyBinding } : {})
    })
    const proxyPoolSyncPending = await syncProxyPoolAfterAccountSetChange(deps)
    return { success: true, revision: applied.revision, undoUntil, proxyPoolSyncPending }
  })
  respondAccountMutation(res, result)
}

async function handleAccountRestore(
  res: http.ServerResponse,
  deps: PanelRouteDeps,
  accountId: string
): Promise<void> {
  const tombstone = takeValidTombstone(accountId)
  if (!tombstone) {
    sendError(res, 404, 'ACCOUNT_NOT_FOUND', '撤销窗口已结束，无法恢复该账号')
    return
  }

  const blob = await deps.loadAccountsBlob()
  if (findAccountRecord(blob, accountId)) {
    sendError(res, 409, 'ACCOUNT_ALREADY_EXISTS')
    return
  }
  const expectedRevision =
    typeof asRecord(blob)?.revision === 'number' ? (asRecord(blob)?.revision as number) : 0

  const result = await singleFlight(`account-restore:${accountId}`, async () => {
    const restoredAccount = { ...tombstone.account, isActive: false }
    const applied = await applyAccountDataMutation(
      (prev) => {
        const raw = prev.accounts
        const accounts = Array.isArray(raw)
          ? [...raw, restoredAccount]
          : { ...(asRecord(raw) ?? {}), [accountId]: restoredAccount }
        const bindings = asRecord(prev.accountProxyBindings)
        return {
          ...prev,
          accounts,
          ...(tombstone.proxyBinding !== undefined
            ? {
                accountProxyBindings: {
                  ...(bindings ?? {}),
                  [accountId]: tombstone.proxyBinding
                }
              }
            : {})
        }
      },
      { expectedRevision }
    )
    if (!applied.ok) return { success: false, error: applied.code }
    clearTimeout(tombstone.timer)
    deletedAccounts.delete(accountId)
    const proxyPoolSyncPending = await syncProxyPoolAfterAccountSetChange(deps)
    return {
      success: true,
      revision: applied.revision,
      account: accountMutationSummary(accountId, restoredAccount),
      proxyPoolSyncPending
    }
  })
  respondAccountMutation(res, result)
}

/**
 * 把账号记录组装成 `accountService/subscription.ts` 需要的 identity。
 *
 * **token 在这里第一次也是唯一一次离开 store，去向是同进程内的函数调用，不是网络。**
 */
function toIdentity(
  accountId: string,
  account: Record<string, unknown>
): PanelAccountIdentity | null {
  const cred = (account.credentials ?? {}) as Record<string, unknown>
  const accessToken = typeof cred.accessToken === 'string' ? cred.accessToken : undefined
  if (!accessToken) return null
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    accessToken,
    accountId,
    region: str(cred.region),
    profileArn: str(account.profileArn) ?? str(cred.profileArn),
    machineId: str(account.machineId),
    provider: str(cred.provider) ?? str(account.idp),
    authMethod: str(cred.authMethod)
  }
}

/** `/api/accounts/:id/...` 的路径解析 → { accountId, action } */
function parseAccountPath(path: string): { accountId: string; action: string } | null {
  const m = /^\/api\/accounts\/([^/]+)(?:\/([^/]+))?$/.exec(path)
  if (!m) return null
  return { accountId: decodeURIComponent(m[1]), action: m[2] ?? '' }
}

/** 单飞去重键 → 进行中的 promise（防手机端连点重复执行副作用，决策卡 §3 幂等） */
const inFlight = new Map<string, Promise<ServiceLike>>()

/**
 * 同一 key 的并发请求共享同一次执行（single-flight）。
 *
 * 决策卡 §3：有副作用的操作（切换 / 删除 / 刷新）同一 id 的并发或重复请求必须去重，
 * 否则手机端双击会真的执行两次。
 */
async function singleFlight(key: string, run: () => Promise<ServiceLike>): Promise<ServiceLike> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const task = run().finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/** 配置动作的并发双击去重；不同请求仍由 panelProxyDeps 的串行队列依次合并最新值。 */
const configInFlight = new WeakMap<
  PanelRouteDeps,
  Map<string, Promise<PanelConfigOperationOutcome<unknown>>>
>()

async function configSingleFlight<T>(
  scope: PanelRouteDeps,
  key: string,
  run: () => Promise<PanelConfigOperationOutcome<T>>
): Promise<PanelConfigOperationOutcome<T>> {
  let flights = configInFlight.get(scope)
  if (!flights) {
    flights = new Map()
    configInFlight.set(scope, flights)
  }
  const existing = flights.get(key)
  if (existing) return existing as Promise<PanelConfigOperationOutcome<T>>
  const task = run().finally(() => flights?.delete(key))
  flights.set(key, task as Promise<PanelConfigOperationOutcome<unknown>>)
  return task
}

/** 列表：`load-accounts` → 白名单投影后出网 */
async function handleList(res: http.ServerResponse, deps: PanelRouteDeps): Promise<void> {
  const blob = await deps.loadAccountsBlob()
  const payload: AccountListPayload = projectAccountsBlob(blob)
  sendJson(res, 200, payload)
}

/**
 * 进行中的导入（single-flight 用）。
 *
 * 与上面的 `inFlight` 分开是因为返回类型不同（`ApiKeyImportResult` 而非 `ServiceLike`）。
 * 键是**粘贴内容本身**而非固定字符串：手机上连点提交按钮会发两个一样的请求，
 * 共享一次执行才不会产生两条记录；而两次粘贴**不同**内容是两个正当请求，不该互相阻塞。
 *
 * ⚠️ 键里含密钥明文，所以这个 Map **绝不能**被日志打印或出网 —— 它只在内存里活到本次执行结束。
 */
const importInFlight = new Map<string, Promise<ApiKeyImportResult>>()

/**
 * 导入 ksk_ 密钥（手机端「添加账号」的落点）。
 *
 * 本 handler 只做三件事（与文件头不变量 1 一致）：读参数 → 调共享用例 → 经 `respond.ts` 写回。
 * 四态判定 / 判重 / userId 派生**全在 `accountService/importApiKey.ts`**，
 * 与桌面端是同一份实现 —— 在这里再写一遍判重就是第二个真源。
 */
async function handleImport(
  res: http.ServerResponse,
  deps: PanelRouteDeps,
  body: Record<string, unknown> | undefined
): Promise<void> {
  const raw = body?.apiKeys
  if (typeof raw !== 'string') {
    sendError(res, 400, 'INVALID_CREDENTIAL', '请提供 apiKeys（每行一个 ksk_ 密钥）')
    return
  }
  // 空白输入在这一层就拒：让它进业务层会得到一个 total=0 的「成功」响应，
  // 手机上表现为「点了导入、没报错、也没东西」—— 最难自查的一种反馈。
  if (raw.trim().length === 0) {
    sendError(res, 400, 'INVALID_CREDENTIAL', '请粘贴至少一个 ksk_ 密钥')
    return
  }

  const input: ApiKeyImportInput = {
    rawInput: raw,
    ...(typeof body?.region === 'string' ? { region: body.region } : {}),
    ...(typeof body?.groupId === 'string' ? { groupId: body.groupId } : {})
    // expectedRevision 刻意**不**从请求体读:面板没有可信的 revision 快照(它拿到的
    // 列表可能已经旧了),带上只会让正常导入被 STALE 拒。导入是"增加一条",
    // 不是"覆盖整表",无仲裁直写才是正确语义 —— 收口函数内部的串行锁保证原子。
  }

  const key = `import:${raw}`
  const existing = importInFlight.get(key)
  const task = existing ?? deps.importApiKeys(input).finally(() => importInFlight.delete(key))
  if (!existing) importInFlight.set(key, task)

  const result = await task

  // 导入成功的账号立刻拉一次真实额度 —— 与桌面端 `AddAccountDialog` 导入后
  // `void checkAccountStatus(r.accountId)` 对称。`importApiKey.ts` 只写额度**占位值**
  // ({ current: 0, limit: 0 },注释「导入后由调用方触发 check」),面板此前完全没有这一步,
  // 于是手机端导入的账号一直显示 0/0 直到用户手动点一次刷新。
  //
  // 这不是「在 handler 里重写业务判定」(不变量 1 禁止的是第二个判重/四态真源),
  // 而是调用方编排 —— 判定仍然只在共享层那一份。
  //
  // fire-and-forget:不阻塞本次响应(20 个 key 就要串 20 次上游往返,手机端会以为卡死);
  // 额度拉取失败也不该翻转「已导入」这个既成事实,但必须留痕,不做无声失败。
  const importedIds = result.results
    .map((r) => r.accountId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (importedIds.length > 0) {
    void (async () => {
      try {
        // 此处读盘必然能看到新账号:importApiKeys 已 await 完成写盘,不存在桌面端那种
        // 「广播尚未处理完」的竞态(面板每次都从盘取真值,不走 renderer store)。
        const blob = await deps.loadAccountsBlob()
        for (const id of importedIds) {
          const account = findAccountRecord(blob, id)
          if (!account) continue
          await singleFlight(`check:${id}`, () => deps.checkAccountStatus(account))
        }
      } catch (error) {
        console.warn('[Panel] post-import usage refresh failed:', error)
      }
    })()
  }

  // 逐条结果原样回（label 已是掩码，业务层保证不含明文）。
  // 即使一条都没成功也回 200 —— 「3 个里 2 个已存在」不是 HTTP 层的错误，
  // 是需要逐条展示给用户的业务结果。
  sendJson(res, 200, result)
}

/**
 * 反代编排层返回的 error 串 → 稳定错误码 + HTTP 状态。
 *
 * 编排层（`proxy/activation.ts`）与既有 `proxy-*` IPC 用的都是**已归一的短串**
 * （`not_running` / `no_credentials` / `EMPTY_POOL` …），不是上游原始报文，
 * 所以这里是一张确定的对照表而非模糊匹配。表外一律 500 `INTERNAL_ERROR`。
 */
function mapProxyFailure(result: ServiceLike | undefined): {
  status: number
  code: PanelErrorCode
} {
  const raw = errorMessage(result)
  switch (raw) {
    case 'not_running':
    case 'PROXY_NOT_RUNNING':
      // 409：反代没跑不是请求本身有错，是当前状态不允许这个操作
      return { status: 409, code: 'PROXY_NOT_RUNNING' }
    case 'no_credentials':
    case 'ACCOUNT_NOT_IN_POOL':
      return { status: 404, code: 'ACCOUNT_NOT_IN_POOL' }
    case 'ACCOUNT_NOT_AVAILABLE':
      return { status: 409, code: 'ACCOUNT_NOT_AVAILABLE' }
    case 'EMPTY_POOL':
      // 空池启动是负条件之一 —— 必须让用户看到"没有可用账号"，而不是启动成功
      return { status: 409, code: 'EMPTY_POOL' }
    default:
      return { status: 500, code: 'INTERNAL_ERROR' }
  }
}

/** 反代端点统一响应：失败走 `mapProxyFailure`，成功原样出（经 sendJson 强制脱敏） */
function respondProxy(res: http.ServerResponse, result: ServiceLike | undefined): void {
  if (result?.success === false) {
    const { status, code } = mapProxyFailure(result)
    sendError(res, status, code)
    return
  }
  sendJson(res, 200, result ?? { success: true })
}

function respondConfig<T>(
  res: http.ServerResponse,
  result: PanelConfigOperationOutcome<T>,
  noStore = false
): void {
  if (noStore) res.setHeader('Cache-Control', 'no-store')
  if (result.ok) {
    sendJson(res, 200, result.value)
    return
  }
  if (result.kind === 'invalid') {
    sendError(res, 400, 'INVALID_CONFIG', result.message)
    return
  }
  if (result.kind === 'conflict') {
    sendError(res, 409, 'INVALID_CONFIG', result.message)
    return
  }
  sendError(res, 500, 'INTERNAL_ERROR', result.message)
}

/**
 * 反代命名空间路由 —— `/api/proxy/*`
 *
 * ## 为什么启动端点不接受任何配置参数
 *
 * 端口 / API Key / 模型映射 / 日志开关都留在桌面端。它们是一次性配置而非日常操作，
 * 且 `proxy-update-config` 有大量副作用分支（steering 重载 / agent 模式 / payload
 * 上限），从手机误触的代价远大于收益。面板只做用户日常的第三、四步：选号 + 启停。
 *
 * ## 顺序不在这一层
 *
 * 「先同步池、再启动」与选号的三步顺序都在 `proxy/activation.ts` 与
 * `proxyStart` 的实现内部。路由层若自己编排这个顺序，就会成为第二个顺序真源
 * —— 两处早晚分叉，而分叉的表现是「面板绿灯但反代行为错」。
 *
 * @returns true = 已处理；false = 不属于本命名空间
 */
async function routeProxyApi(
  ctx: PanelRequestContext,
  res: http.ServerResponse,
  deps: PanelRouteDeps
): Promise<boolean> {
  const { method, path, body } = ctx

  // 真实状态（读）：running / 端口 / 池大小 / 当前账号 / 在飞请求数
  if (path === '/api/proxy/status' && method === 'GET') {
    respondProxy(res, await deps.proxyGetStatus())
    return true
  }

  if (path === '/api/proxy/config' && method === 'GET') {
    if (!deps.proxyGetConfig) {
      throw new Error('proxy config route is not wired')
    }
    res.setHeader('Cache-Control', 'no-store')
    sendJson(res, 200, await deps.proxyGetConfig())
    return true
  }

  if (path === '/api/proxy/api-keys' && method === 'GET') {
    if (!deps.proxyListApiKeys) {
      throw new Error('proxy API key list route is not wired')
    }
    res.setHeader('Cache-Control', 'no-store')
    sendJson(res, 200, await deps.proxyListApiKeys())
    return true
  }

  if (method !== 'POST') return false

  const actor: PanelConfigAuditActor = {
    clientIP: ctx.clientIP ?? 'unknown',
    userAgent: ctx.userAgent ?? ''
  }
  const mutationKey = `${path}:${JSON.stringify(body ?? {})}`

  switch (path) {
    case '/api/proxy/config':
      if (!deps.proxyUpdateConfig) throw new Error('proxy config update route is not wired')
      respondConfig(
        res,
        await configSingleFlight(deps, mutationKey, () => deps.proxyUpdateConfig!(body ?? {}, actor)),
        true
      )
      return true

    case '/api/proxy/config/port':
      if (!deps.proxyChangePort) throw new Error('proxy port route is not wired')
      respondConfig(
        res,
        await configSingleFlight(deps, mutationKey, () => deps.proxyChangePort!(body ?? {}, actor)),
        true
      )
      return true

    case '/api/proxy/api-keys/create':
      if (!deps.proxyCreateApiKey) throw new Error('proxy API key create route is not wired')
      respondConfig(
        res,
        await configSingleFlight(deps, mutationKey, () => deps.proxyCreateApiKey!(body ?? {}, actor)),
        true
      )
      return true

    case '/api/proxy/api-keys/verify':
      if (!deps.proxyVerifyApiKey) throw new Error('proxy API key verify route is not wired')
      respondConfig(
        res,
        await configSingleFlight(deps, mutationKey, () => deps.proxyVerifyApiKey!(body ?? {}, actor)),
        true
      )
      return true

    case '/api/proxy/api-keys/revoke':
      if (!deps.proxyRevokeApiKey) throw new Error('proxy API key revoke route is not wired')
      respondConfig(
        res,
        await configSingleFlight(deps, mutationKey, () => deps.proxyRevokeApiKey!(body ?? {}, actor)),
        true
      )
      return true

    // 启动。单飞去重：手机端连点不会真启两次（实现侧幂等，这里再收一道）
    case '/api/proxy/start':
      respondProxy(res, await singleFlight('proxy-start', () => deps.proxyStart()))
      return true

    case '/api/proxy/stop':
      respondProxy(res, await singleFlight('proxy-stop', () => deps.proxyStop()))
      return true

    // 只同步池，不启动（用户改了账号后想刷新池）
    case '/api/proxy/sync-pool':
      respondProxy(res, await singleFlight('proxy-sync-pool', () => deps.proxySyncPool()))
      return true

    // 立刻放行全部挂起请求。**不接受任何参数** —— 面板只有「放一次」这个动作，
    // 间隔与开关留在桌面端。单飞去重：手机连点共享同一次执行，
    // 否则第二次点到的是已被第一次清空的集合，用户看到「放行了 0 个」而困惑。
    case '/api/proxy/release-held':
      respondProxy(res, await singleFlight('proxy-release-held', () => deps.proxyReleaseHeld()))
      return true

    // 选号。走编排的三步，不在这里拆开调
    case '/api/proxy/active-account': {
      const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
      if (!accountId) {
        // 刻意不把缺失当成「清空指定」—— 单账号模式下清空会退化成"用第一个可用号"，
        // 那与用户点了某个账号的意图相反，而且从手机上无法区分是误触还是有意。
        sendError(res, 400, 'INVALID_CREDENTIAL', '缺少 accountId')
        return true
      }
      respondProxy(
        res,
        await singleFlight(`proxy-activate:${accountId}`, () =>
          deps.proxyActivateAccount(accountId)
        )
      )
      return true
    }

    default:
      return false
  }
}

/**
 * 路由分派。
 *
 * @returns true = 本函数已处理（响应已写出）；false = 路径不属于 API 命名空间，交给调用方兜底
 */
export async function routePanelApi(
  ctx: PanelRequestContext,
  res: http.ServerResponse,
  deps: PanelRouteDeps
): Promise<boolean> {
  const { method, path } = ctx

  // 账号列表（读）
  if (path === '/api/accounts' && method === 'GET') {
    await handleList(res, deps)
    return true
  }

  // 账号编辑用的分组下拉。只发 id/name/color/order 白名单，不把整个 accountData 出网。
  if (path === '/api/account-groups' && method === 'GET') {
    const blob = await deps.loadAccountsBlob()
    sendJson(res, 200, { groups: projectAccountGroups(blob) })
    return true
  }

  // 导入 ksk_ 密钥（写）—— 必须在下面 parseAccountPath 之前判，
  // 否则 `/api/accounts` 会被当成 accountId 为空的子路径。
  if (path === '/api/accounts' && method === 'POST') {
    await handleImport(res, deps, ctx.body)
    return true
  }

  // 退出本机 IDE 登录态（写，无 accountId）
  if (path === '/api/local/logout' && method === 'POST') {
    respondService(res, await singleFlight('local-logout', () => deps.logoutFromIde()))
    return true
  }

  // 反代编排（读+写）。放在账号路径解析**之前** —— `/api/proxy/*` 与
  // `/api/accounts/:id/...` 是两个不相交命名空间，先分流可读性更好，
  // 也避免将来有人给 accounts 加通配路径时误吞 proxy 路径。
  if (path === '/api/proxy' || path.startsWith('/api/proxy/')) {
    return routeProxyApi(ctx, res, deps)
  }

  const parsed = parseAccountPath(path)
  if (!parsed) return false

  const { accountId, action } = parsed

  // 撤销发生在账号已经从当前列表消失之后，必须先于 findAccountRecord 判定。
  if (method === 'POST' && action === 'restore') {
    await handleAccountRestore(res, deps, accountId)
    return true
  }

  const blob = await deps.loadAccountsBlob()
  const account = findAccountRecord(blob, accountId)
  if (!account) {
    sendError(res, 404, 'ACCOUNT_NOT_FOUND')
    return true
  }

  // C2 只开放桌面端已有的账号备注（nickname）与分组（groupId）语义。
  // 凭据编辑刻意不开放：手机误填 token 的损失远高于收益，且 ksk_ 账号已有导入路径。
  if (method === 'PATCH' && action === '') {
    await handleAccountEdit(res, accountId, blob, ctx.body)
    return true
  }

  if (method === 'POST' && action === 'delete') {
    await handleAccountDelete(res, deps, accountId, ctx.body)
    return true
  }

  // 需要凭据的端点统一在这里取 identity —— 取不到 accessToken 说明账号数据不完整
  const identity = toIdentity(accountId, account)

  switch (`${method} ${action}`) {
    // 刷新额度 / 检查账户信息（桌面端「检查账户信息」）
    case 'POST check':
      respondService(
        res,
        await singleFlight(`check:${accountId}`, () => deps.checkAccountStatus(account))
      )
      return true

    // 刷新 Token（桌面端「刷新 Token」）
    case 'POST refresh-token':
      respondService(
        res,
        await singleFlight(`refresh:${accountId}`, () => deps.refreshAccountToken(account))
      )
      return true

    // 切换到此账号（桌面端「切换到此账号」）
    // ⚠️ 写的是**运行主进程那台机器**的 SSO 缓存，不是浏览器所在设备。
    //    这是照搬原则下的既有语义（switch.ts 文件头已注明），不在本轮改动。
    case 'POST switch':
      respondService(
        res,
        await singleFlight(`switch:${accountId}`, () =>
          deps.switchAccountToIde({ ...(account.credentials as object), accountId })
        )
      )
      return true

    case 'POST switch-cli':
      respondService(
        res,
        await singleFlight(`switch-cli:${accountId}`, () =>
          deps.switchAccountToCli({ ...(account.credentials as object), accountId })
        )
      )
      return true

    // 以下四个是「桌面端把 accessToken 当第一个入参」的那批 —— 面板按 id 寻址
    case 'GET models':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(res, await deps.getAccountModels(identity))
      return true

    case 'GET subscriptions':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(res, await deps.getAccountSubscriptions(identity))
      return true

    case 'GET subscription-url':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(
        res,
        await deps.getAccountSubscriptionUrl(
          identity,
          typeof ctx.body?.subscriptionType === 'string' ? ctx.body.subscriptionType : undefined
        )
      )
      return true

    case 'POST overage':
      if (!identity) {
        sendError(res, 400, 'INVALID_CREDENTIAL', '账号缺少可用凭据')
        return true
      }
      respondService(res, await deps.setAccountOverage(identity, ctx.body?.enabled === true))
      return true

    default:
      return false
  }
}
