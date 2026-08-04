/**
 * webPanel 列表 DTO —— 白名单投影（决定「给什么」）
 *
 * 决策卡 §3「输出脱敏与照搬豁免」· recon-http-layer.md §3.1 / §3.4
 *
 * ## 为什么需要这一层
 *
 * `accountService/accounts.ts:20 loadAccounts()` 返回 `Promise<unknown>` —— 整表 blob
 * 原样出盘、零投影零脱敏（含全量明文凭据）。桌面 renderer 依赖这份明文工作
 * （`AccountCard.tsx:226-243` 把 token 当参数回传主进程），所以**不能在数据源头脱敏**。
 * 面板要经局域网发数据，必须在出主进程这条边上做投影。
 *
 * ## 与 respond.ts 的两层分工
 *
 * - 本文件（白名单 · 内层）：决定**给什么**。只输出桌面端界面上已经显示的字段。
 * - `respond.ts`（denylist · 外层）：保证**什么都不会漏出去**。`sendJson()` 无条件
 *   过 `redactValue`，即使有人绕过本文件直接丢内部对象，凭据也已打码。
 *
 * 两层缺一不可：白名单是可选的（下一个端点作者可以不调它），所以需要外层强制兜底；
 * 而外层打码后仍泄漏长度与首尾字符，所以不能当"可以随便返回内部对象"的许可证。
 *
 * ## 字段清单的来源（不是拍脑袋定的）
 *
 * 对 `AccountCard.tsx`（31 个 `account.*` 访问）与 `AccountListRow.tsx`（18 个）做
 * 全量属性访问抽取后取**交集** = 18 个字段。两组件都消费即"列表视图必需"；
 * 卡片独有的用量分解字段（`baseLimit` / `bonuses` / `nextResetDate` 等 8 个）
 * 一并给出 —— 它们是纯数字统计，无凭据风险，且卡片视图照搬需要。
 *
 * 凭据侧只给三样：`expiresAt`（时间戳，桌面端 `AccountListRow.tsx:524` 直接渲染）
 * 加两个存在性布尔。桌面 UI 实测**从不渲染 token**，只做存在性判定或回传主进程当参数，
 * 所以"不给 token"零功能损失。
 */

/** 运行时类型收窄：只有真正的普通对象才当对象用（`typeof null === 'object'` 的坑） */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  return v as Record<string, unknown>
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asBoolean(v: unknown): boolean {
  return v === true
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/** 非空字符串判定 —— 对齐桌面端 `!credentials.refreshToken` 的真值语义 */
function isPresent(v: unknown): boolean {
  return typeof v === 'string' ? v.length > 0 : v !== undefined && v !== null
}

/** 列表 DTO 的形状（全部字段可缺失 —— 输入是 unknown，缺字段是常态而非异常） */
export interface AccountListItem {
  id: string
  email?: string
  nickname?: string
  idp?: string
  userId?: string
  profileArn?: string
  machineId?: string
  status?: string
  lastError?: string
  isActive: boolean
  groupId?: string
  tags: string[]
  subscription?: {
    type?: string
    title?: string
    daysRemaining?: number
  }
  usage?: {
    current?: number
    limit?: number
    percentUsed?: number
    baseLimit?: number
    baseCurrent?: number
    freeTrialLimit?: number
    freeTrialCurrent?: number
    freeTrialExpiry?: string
    bonuses?: unknown[]
    nextResetDate?: string
  }
  /** 凭据侧唯一放行的原始值：token 过期时间戳（桌面端已在界面上显示） */
  expiresAt?: number
  /** 凭据判定的**结论**，替代原料：对齐 `AccountListRow.tsx:141` 的 `!credentials.refreshToken` */
  hasRefreshToken: boolean
  /** 对齐 `AccountListRow.tsx:145`：social / external_idp 跳过 OIDC 字段检查 */
  canRefreshViaOidc: boolean
}

/**
 * 把一个来源未知的账号对象投影成列表 DTO。
 *
 * **第一步是运行时形状校验，不是 TS 断言** —— 输入来自 `loadAccounts(): Promise<unknown>`，
 * 硬转会在盘上 blob 结构变化时静默产出 `undefined` 字段（recon §3.4 净修正 1）。
 *
 * @returns 合法账号的 DTO；输入不是对象、或缺 `id`（无法寻址）时返回 `null`
 */
export function toAccountListItem(input: unknown): AccountListItem | null {
  const a = asRecord(input)
  if (!a) return null

  const id = asString(a.id)
  // id 是端点寻址的唯一键（决策卡 §3 第二处豁免：按 accountId 寻址）。
  // 没有 id 的条目对面板毫无用处，跳过它比产出半个 DTO 安全。
  if (!id) return null

  const sub = asRecord(a.subscription)
  const usage = asRecord(a.usage)
  const cred = asRecord(a.credentials)

  const authMethod = asString(cred?.authMethod)
  // 桌面端 AccountListRow.tsx:145 / AccountCard.tsx:220 的原判定：
  //   social / external_idp 不需要 clientId+clientSecret；其余认证方式两者都要有。
  const skipsOidcFields = authMethod === 'social' || authMethod === 'external_idp'

  const item: AccountListItem = {
    id,
    isActive: asBoolean(a.isActive),
    tags: asStringArray(a.tags),
    hasRefreshToken: isPresent(cred?.refreshToken),
    canRefreshViaOidc: skipsOidcFields
      ? true
      : isPresent(cred?.clientId) && isPresent(cred?.clientSecret)
  }

  // 展示字段：逐个显式赋值。此处**故意不用展开语法** ——
  // `{ ...a, credentials: undefined }` 形态的"减法"会随盘上 blob 新增字段自动泄漏，
  // 白名单必须是加法。
  const email = asString(a.email)
  if (email !== undefined) item.email = email
  const nickname = asString(a.nickname)
  if (nickname !== undefined) item.nickname = nickname
  const idp = asString(a.idp)
  if (idp !== undefined) item.idp = idp
  const userId = asString(a.userId)
  if (userId !== undefined) item.userId = userId
  const profileArn = asString(a.profileArn)
  if (profileArn !== undefined) item.profileArn = profileArn
  const machineId = asString(a.machineId)
  if (machineId !== undefined) item.machineId = machineId
  const status = asString(a.status)
  if (status !== undefined) item.status = status
  const lastError = asString(a.lastError)
  if (lastError !== undefined) item.lastError = lastError
  const groupId = asString(a.groupId)
  if (groupId !== undefined) item.groupId = groupId

  if (sub) {
    item.subscription = {
      type: asString(sub.type),
      title: asString(sub.title),
      daysRemaining: asNumber(sub.daysRemaining)
    }
  }

  if (usage) {
    item.usage = {
      current: asNumber(usage.current),
      limit: asNumber(usage.limit),
      percentUsed: asNumber(usage.percentUsed),
      baseLimit: asNumber(usage.baseLimit),
      baseCurrent: asNumber(usage.baseCurrent),
      freeTrialLimit: asNumber(usage.freeTrialLimit),
      freeTrialCurrent: asNumber(usage.freeTrialCurrent),
      freeTrialExpiry: asString(usage.freeTrialExpiry),
      bonuses: Array.isArray(usage.bonuses) ? usage.bonuses : undefined,
      nextResetDate: asString(usage.nextResetDate)
    }
  }

  const expiresAt = asNumber(cred?.expiresAt)
  if (expiresAt !== undefined) item.expiresAt = expiresAt

  return item
}

/** 整表投影结果：只有账号列表与 revision，blob 的其他顶层字段一律不出 */
export interface AccountListPayload {
  accounts: AccountListItem[]
  /** 集合级乐观锁版本（W1 `applyAccountDataMutation` 的仲裁依据），供 web 端写回时带上 */
  revision?: number
}

/**
 * 把 `loadAccounts()` 的整表 blob 投影成面板列表响应。
 *
 * blob 的 `accounts` 容器在 renderer 落盘侧是 `Record<id, Account>`
 * （`store/accounts.ts:198 buildPersistBlob` → `Object.fromEntries`），
 * 但历史数据/导入路径可能是数组，两种都接受。
 *
 * 顶层其他字段（`proxyUrl` / `switchTarget` / `activeAccountId` 等约 26 个设置项）
 * **一律不透传** —— `proxyUrl` 可能含代理账密，面板列表也用不到它们。
 */
export function projectAccountsBlob(input: unknown): AccountListPayload {
  const blob = asRecord(input)
  if (!blob) return { accounts: [] }

  const raw = blob.accounts
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : asRecord(raw)
      ? Object.values(asRecord(raw) as Record<string, unknown>)
      : []

  const accounts: AccountListItem[] = []
  for (const entry of entries) {
    const dto = toAccountListItem(entry)
    // 非法条目跳过而不抛：一条脏数据不该让整个列表 500（决策卡 §4 边界 9）
    if (dto) accounts.push(dto)
  }

  const revision = asNumber(blob.revision)
  return revision !== undefined ? { accounts, revision } : { accounts }
}

