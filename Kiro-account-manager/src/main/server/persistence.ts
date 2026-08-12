/**
 * 服务端持久化 hooks —— 把反代的两个「下游动作是落盘」事件真正接到盘上。
 *
 * ## 治的病灶（这个文件存在的唯一理由）
 *
 * `server/assembly.ts:buildProxyEvents` 的 `onAccountUpdate` 在 `persistence` 缺席时是
 * **告警一次后 return**，而 `server/entry.ts` 从未传过 `persistence`。于是服务端形态下：
 * 反代刷出新 token → 只进了内存账号池 → 进程重启后用回盘上的旧 token。
 * 而 IdP **轮换** refreshToken 时旧的一签发新的就当场作废 ⇒ 重启后刷新直接 401
 * ⇒ 账号被判失败。**这比「压根不刷新」更糟**：token 有效期内它看起来完全正常。
 *
 * ## 为什么不是照搬桌面
 *
 * 桌面 `index.ts:661-698` 这两个回调的实现是「推 IPC 给 renderer，让 renderer 的
 * store 防抖落盘」，`onAccountSuspended` 还额外只改 `lastSavedData` 内存快照
 * （刻意省掉每次封禁都整库 AES 重写）。三处在服务端**都不成立**：
 *
 *   1. **IPC 推送**：服务端无 renderer。`assembly.ts` 已把 `setBroadcaster` 设成显式
 *      no-op、面板走 HTTP 轮询 —— 不是「还没做」，是没有消费者。
 *   2. **`lastSavedData` 内存快照捷径**：桌面靠它 + renderer 落盘两条腿走路；服务端
 *      只写这个快照**永远到不了盘**（它只在 `buildStoreDeps.createBackup` 被读），
 *      等于把本文件要修的 bug 原样保留。故服务端必须走真落盘路径。
 *   3. 桌面 renderer 那个 handler（`renderer/src/App.tsx:412`）开头是
 *      `if (!info.profileArn) return` —— 它**只处理 profileArn，token 三字段直接丢**。
 *      服务端刻意**不**照搬这条早退：照搬就是把要修的 bug 复制过来。这是本文件唯一
 *      一处刻意不与桌面逐字对齐的地方。
 *
 * ## 为什么走 `persistAccountPatch` 而不是别的
 *
 * `persistAccountPatch` 是「按 id 给单条账号打字段级补丁」的既有收口
 * （`accountService/persistAccountPatch.ts`），它已经处理好三件本文件不该重写的事：
 * accounts 的 Record / 数组两种历史形状、账号已被另一端删除时**零副作用中止**
 * （绝不重建 —— 那是「已删账号复活」病灶）、以及经 `applyAccountDataMutation`
 * 的进程内串行锁保证读-改-写原子。直调 `applyAccountDataMutation` 就要把这三段
 * traversal 抄第二遍，那正是该文件头点名反对的第二个 SSOT。
 *
 * **不复用 `persistRefreshResult`**：它的入参是 `expiresIn`（相对秒）并强制写
 * `status:'active'` / 清 `lastError` / 更新 `lastCheckedAt`。而反代给的是**已算好的
 * `expiresAt` 绝对毫秒**，且 `onAccountUpdate` 也在**切号**时触发
 * （`proxy/proxyServer.ts:1790` / `:1954` / `:2005`，单账号模式下切到下一个可用号），
 * 那时把 `status` 按成 active、清掉真实的 `lastError` 是没有依据的副作用。
 * 故本文件自带补丁纯函数，**只写 patch 真正带来的字段**。
 *
 * ## 为什么不防抖
 *
 * 实测 `onAccountUpdate` 四个触发点：`proxyServer.ts:1582`（刷新成功）+ 三个切号点，
 * 后三个都在 `if (!this.config.enableMultiAccount)` 分支内（仅单账号模式），且切号由
 * 配额耗尽 / 封禁触发、单请求内有 `triedIds` 去重 —— **都不是每请求一次**。默认多账号
 * 模式下只有 `:1582` 会触发，频率与刷新次数同阶。相反，给它加防抖会在停机时丢掉最后
 * 一次 token 落盘 —— 那正是本文件要修的东西。热路径上的三个统计回调才需要防抖
 * （`assembly.ts:makeDebouncedStoreSet` 已经在做那件事）。
 */
import { persistAccountPatch, asRecord } from '../accountService/persistAccountPatch'
import type { ServerPersistenceHooks } from './assembly'

/** 反代刷出的新凭据 / 自愈出的 profileArn。字段与 `ServerPersistenceHooks` 逐字对齐 */
export interface ProxyAccountUpdatePatch {
  id: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  profileArn?: string
}

/** 上游长期封禁的判定结果。字段与 `ServerPersistenceHooks` 逐字对齐 */
export interface ProxyAccountSuspendedInfo {
  id: string
  email?: string
  reason: string
  message: string
  suspendedAt: number
}

/** 停机默认最多等 10 秒；超时后由调用方继续退出，但日志会明确列出未确认落盘的写入。 */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000

export interface ServerPersistenceOptions {
  drainTimeoutMs?: number
}

/**
 * 把一次反代账号更新合并进一条账号记录（纯函数，便于单测逐字段固定）。
 *
 * ## 双写 `profileArn`（顶层 + `credentials`）不是笔误
 *
 * 全仓两处都在读：业务侧 `accountService/refresh.ts:173` 判
 * `account.profileArn || account.credentials?.profileArn`，`persistRefreshResult` 也同时
 * 写两处。只写一处会让另一处的读者继续拿旧值 —— 这是既有形状，不在这里"统一一下"。
 *
 * ## 为什么每个字段都判 `!== undefined` 而不是直接展开
 *
 * `onAccountUpdate` 在**切号**时也触发，那时传进来的 `ProxyAccount` 可能没有
 * `refreshToken`（该字段在 `proxy/types.ts:425` 是可选的）。直接
 * `refreshToken: patch.refreshToken` 会把盘上真实的 refreshToken 覆盖成 `undefined`
 * —— 落盘后那个账号就再也刷不了 token 了。这是本文件最容易写错、且错了只在生产
 * 才看得见的一行。
 */
export function patchAccountWithProxyUpdate(
  account: Record<string, unknown>,
  patch: ProxyAccountUpdatePatch
): Record<string, unknown> {
  const prevCred = asRecord(account.credentials) ?? {}
  const nextCred: Record<string, unknown> = { ...prevCred }

  if (patch.accessToken !== undefined) nextCred.accessToken = patch.accessToken
  if (patch.refreshToken !== undefined) nextCred.refreshToken = patch.refreshToken
  if (patch.expiresAt !== undefined) nextCred.expiresAt = patch.expiresAt
  if (patch.profileArn !== undefined) nextCred.profileArn = patch.profileArn

  const next: Record<string, unknown> = { ...account, credentials: nextCred }
  // 顶层 profileArn 与 credentials 那份同值（见上「双写」）
  if (patch.profileArn !== undefined) next.profileArn = patch.profileArn
  return next
}

/**
 * 把一次封禁判定合并进一条账号记录（纯函数）。
 *
 * 字段与桌面 `index.ts:683-687` 对 `lastSavedData` 做的那次更新逐字段一致
 * （`status:'error'` / `lastError:'[reason] message'` / `lastCheckedAt`），只是这里真落盘。
 * 桌面 renderer 侧 `App.tsx:401` 的 `updateAccountStatus(id,'error','[reason] message')`
 * 也是同一形状 —— 两端读同一份 accountData，措辞必须一致，否则用户在手机面板和桌面上
 * 看到同一个账号的错误文案不同。
 */
export function patchAccountWithSuspension(
  account: Record<string, unknown>,
  info: ProxyAccountSuspendedInfo
): Record<string, unknown> {
  return {
    ...account,
    status: 'error',
    lastError: `[${info.reason}] ${info.message}`,
    lastCheckedAt: info.suspendedAt
  }
}

/**
 * 构造服务端的 `ServerPersistenceHooks`。`entry.ts` 把它传进 `assembleServer`。
 *
 * ## 为什么两个 hook 都要 `.catch()`
 *
 * hook 的签名是**同步** `void`（由 `ProxyServerEvents` 决定 —— 反代不 await 它们），
 * 而落盘是 async。不接 `.catch()` 的话一次落盘失败会变成 unhandledRejection，
 * 而 `entry.ts:main()` 给 unhandledRejection 装的是 `process.exit(EXIT.UNAVAILABLE)`
 * —— 即「一次写盘失败 → 整台服务被进程托管重启」。反代的正确行为是继续服务并把
 * 失败写进日志，故在这里收口。
 *
 * **但绝不静默吞**：`console.error` 带账号 id 与原因。静默吞的表现正是
 * 「反代刷过 token，重启后又用回旧的」而日志里查不到任何线索 —— 与未接线时一模一样，
 * 那就等于这个文件白写了。
 *
 * ## `account-not-found` 不是错误
 *
 * 运维在手机面板上删了某个账号，而反代那一侧的内存池里它还在（下次同步池才消失）。
 * 此时新凭据本身有效，只是没有归属可写。`persistAccountPatch` 返回
 * `{persisted:false, reason:'account-not-found'}` 并**零副作用中止**（不重建那条记录）。
 * 这里按 info 级别记一行，让日志能自证「不是写失败，是账号没了」。
 */
export function createServerPersistenceHooks(
  options: ServerPersistenceOptions = {}
): ServerPersistenceHooks {
  const pendingWrites = new Map<Promise<void>, string>()
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS

  const track = (description: string, task: Promise<void>): void => {
    const tracked = task.finally(() => {
      pendingWrites.delete(tracked)
    })
    pendingWrites.set(tracked, description)
  }

  const drain = async (): Promise<void> => {
    const deadline = Date.now() + drainTimeoutMs
    while (pendingWrites.size > 0) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break

      let timeout: NodeJS.Timeout | undefined
      const completed = await Promise.race([
        Promise.allSettled([...pendingWrites.keys()]).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), remainingMs)
        })
      ])
      if (timeout) clearTimeout(timeout)
      if (!completed) break
    }

    if (pendingWrites.size > 0) {
      const pending = [...pendingWrites.values()].join('；')
      console.error(
        `[server] ❌ 停机持久化等待超过 ${drainTimeoutMs}ms，` +
          `以下写入尚未确认落盘：${pending}。` +
          '若其中包含 refreshToken，进程退出后盘上可能仍是已被上游吊销的旧 token。'
      )
    }
  }

  return {
    onProxyAccountUpdate: (patch) => {
      track(
        `反代账号更新（id=${patch.id}）`,
        persistAccountPatch(
          patch.id,
          (current) => patchAccountWithProxyUpdate(current, patch),
          'server/onProxyAccountUpdate'
        )
          .then((outcome) => {
            if (outcome.persisted) return
            if (outcome.reason === 'account-not-found') {
              console.log(
                `[server] 反代账号更新未落盘：账号 ${patch.id} 已不在盘上（另一端刚删了它），跳过`
              )
              return
            }
            console.warn(`[server] 反代账号更新未落盘：${outcome.reason}（id=${patch.id}）`)
          })
          .catch((e) => {
            // 落盘失败必须留痕：这条日志是「反代刷了 token 但重启后用回旧的」唯一线索。
            console.error(
              `[server] ⚠️ 反代刷出的新凭据落盘失败（id=${patch.id}）—— ` +
                `进程重启后该账号会用回盘上的旧 token，若上游已轮换 refreshToken 则会 401：`,
              e
            )
          })
      )
    },
    onProxyAccountSuspended: (info) => {
      track(
        `账号封禁状态（id=${info.id}）`,
        persistAccountPatch(
          info.id,
          (current) => patchAccountWithSuspension(current, info),
          'server/onProxyAccountSuspended'
        )
          .then((outcome) => {
            if (outcome.persisted) return
            if (outcome.reason === 'account-not-found') {
              console.log(
                `[server] 封禁状态未落盘：账号 ${info.id} 已不在盘上（另一端刚删了它），跳过`
              )
              return
            }
            console.warn(`[server] 封禁状态未落盘：${outcome.reason}（id=${info.id}）`)
          })
          .catch((e) => {
            console.error(
              `[server] ⚠️ 账号封禁状态落盘失败（id=${info.id}）—— ` +
                `重启后面板上看不到这个号被封禁的原因：`,
              e
            )
          })
      )
    },
    drain
  }
}
