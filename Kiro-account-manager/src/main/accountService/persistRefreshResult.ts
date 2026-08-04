/**
 * 「刷新 Token」结果落盘 · IPC 与 HTTP 面板共用的持久化层
 *
 * ## 治的病灶
 *
 * `refresh.ts:refreshAccountToken` 原先**只返回**新凭据，落盘长在 renderer store
 * （`store/accounts.ts:1843` 写内存 → `:1867 saveToStorage()` 落盘）—— 那是 renderer 独有的。
 * web 面板的 HTTP 路由（`webPanel/routes.ts:462`）调同一个业务函数却没有那个 store，
 * 于是新签发的 refreshToken 只出现在 HTTP 响应里、随渲染丢弃。
 *
 * 而 `refresh.ts:112` 是 `refreshResult.refreshToken || refreshToken` —— IdP **轮换** refresh
 * token 时，新的一签发、旧的服务端当场作废。盘上留着的那个已经是死凭据：下次续期 401 →
 * 停止调度 → **用户得重新登录**。这不是"下次会自动补回"。
 *
 * ## 字段清单的来源（不是重新设计的）
 *
 * 行为基线 = renderer store `refreshAccountToken` 那次 `set()`（`store/accounts.ts:1843-1866`）
 * 实际写进内存、随后被 `buildPersistBlob` 整表落盘的字段，逐字段对齐：
 *
 * | 字段 | renderer 的语义 | 这里 |
 * |---|---|---|
 * | `profileArn`（顶层） | `data.profileArn \|\| acc.credentials.profileArn \|\| acc.profileArn` | 同（回退次序保留） |
 * | `credentials.accessToken` | 直接取新值 | 同 |
 * | `credentials.refreshToken` | `data.refreshToken \|\| 旧值` | 同（`\|\|` 语义不变） |
 * | `credentials.expiresAt` | `Date.now() + expiresIn * 1000` | 同 |
 * | `credentials.profileArn` | 与顶层同一个 resolved 值 | 同 |
 * | `status` | `'active'` | 同 |
 * | `lastError` | `undefined`（刷新成功即清错误） | 同 |
 * | `lastCheckedAt` | `Date.now()` | 同 |
 *
 * ⚠️ `syncedToIde` / `syncSkipReason` **刻意不落盘**：它们是本次调用的 UI 反馈信号，
 * 不是账号状态。renderer 基线同样只 `console.log` 不存（`store/accounts.ts:1833-1841`）。
 *
 * ## 回退值取自盘面，不取自入参快照
 *
 * `profileArn` 的两级回退在 renderer 里读的是 store 内存里的账号；这里读的是
 * **mutator 内重新读盘拿到的那条记录**。入参快照可能已陈旧（手机端发起时快照来自那一刻），
 * 用它回退会把桌面端刚补上的 profileArn 按回 undefined。
 */

import { persistAccountPatch, asRecord, type PersistOutcome } from './persistAccountPatch'

/** 落盘所需的这次刷新产出（由 refresh.ts 在成功分支组装） */
export interface RefreshPersistInput {
  accessToken: string
  /** 已经过 `refreshResult.refreshToken || 旧值` 回退的最终值 */
  refreshToken: string
  expiresIn: number
  /** 仅 Enterprise / external_idp 分支可能拿到；其余为 undefined，走盘面回退 */
  resolvedEnterpriseArn?: string
}

/** 把一次刷新结果合并进一条账号记录（纯函数，便于单测逐字段固定） */
export function patchAccountWithRefreshResult(
  account: Record<string, unknown>,
  input: RefreshPersistInput,
  now: number = Date.now()
): Record<string, unknown> {
  const prevCred = asRecord(account.credentials) ?? {}
  // 回退次序照搬基线 store/accounts.ts:1849：新拿到的 > credentials 里的 > 顶层的。
  // 只是把"基线读入参快照"换成"读盘面当前值"（见文件头）。
  const resolvedProfileArn =
    input.resolvedEnterpriseArn || prevCred.profileArn || account.profileArn

  return {
    ...account,
    profileArn: resolvedProfileArn,
    credentials: {
      ...prevCred,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: now + input.expiresIn * 1000,
      profileArn: resolvedProfileArn
    },
    status: 'active',
    // 刷新成功即视为当前无错误（基线 store/accounts.ts:1864）。
    // JSON 落盘时 undefined 键会被丢弃 ⇒ 等价于清除。
    lastError: undefined,
    lastCheckedAt: now
  }
}

/**
 * 把一次「刷新 Token」的结果落到盘上。
 *
 * 写入经 `persistAccountPatch` → `applyAccountDataMutation`（revision 乐观锁收口）,
 * 与「刷新额度」走同一条持久化路径。收口成功后广播 `accounts-data-changed`,
 * 桌面端因此无需轮询即可得知手机刷了 Token。
 *
 * @throws 写盘异常向上抛 —— 调用方负责处理（绝不在这里吞掉后假装成功）
 */
export async function persistRefreshResult(
  accountId: string | undefined,
  input: RefreshPersistInput
): Promise<PersistOutcome> {
  const now = Date.now()
  return persistAccountPatch(
    accountId,
    (current) => patchAccountWithRefreshResult(current, input, now),
    'persistRefreshResult'
  )
}
