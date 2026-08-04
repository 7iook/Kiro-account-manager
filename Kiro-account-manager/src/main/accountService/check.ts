/**
 * 账号状态检查(单个 + 批量) · 从 ipcMain.handle 抽出
 *
 * 原位置:
 *   - checkAccountStatus     ← src/main/index.ts:3938 'check-account-status'(约 330 行)
 *   - backgroundBatchCheck   ← src/main/index.ts:4643 'background-batch-check'(约 330 行)
 *
 * 用量/订阅解析统一走 ./parseUsage(SSOT);原先三处内联副本的 4 处分歧见该文件头部注释。
 *
 * 行为保留要点:
 *   - profileArn 必须透传给 getUsageAndLimits,否则 400 "Improperly formed request" →
 *     usage 永远 0(commit 627d655 · RCA 2026-07-14 usage-refresh-zero · recon §7.2)
 *   - 单个检查用 Promise.all + catch(封禁错误必须向上抛),批量检查用 Promise.allSettled
 *     (逐项判定 fulfilled/rejected)—— 两种错误处理**不可互换**,原样保留
 *   - 进度/逐条结果事件的 channel 名、payload 形状、发射时机原样保留
 */

import {
  parseCreditUsage,
  parseSubscription,
  type RawUsageResponse
} from './parseUsage'
import {
  persistCheckResult,
  persistBatchCheckResults,
  type BatchCheckItem
} from './persistCheckResult'
import type {
  AccountLike,
  AccountRuntimeDeps,
  BatchSummary,
  UserInfoLike
} from './types'

/** check-account-status 成功返回的 data 形状(与原 handler 逐字段一致) */
export interface CheckAccountStatusData {
  status: 'active' | 'error'
  email?: string
  userId?: string
  idp?: string
  userStatus?: string
  featureFlags?: string[]
  subscriptionTitle: string
  usage: {
    current: number
    limit: number
    percentUsed: number
    lastUpdated: number
    baseLimit: number
    baseCurrent: number
    freeTrialLimit: number
    freeTrialCurrent: number
    freeTrialExpiry?: string
    bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
    nextResetDate?: string
    resourceDetail?: {
      resourceType?: string
      displayName?: string
      displayNamePlural?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      overageEnabled?: boolean
    }
  }
  subscription: {
    type: string
    title: string
    rawType?: string
    expiresAt?: number
    daysRemaining?: number
    upgradeCapability?: string
    overageCapability?: string
    managementTarget?: string
  }
  newCredentials?: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
  }
}

export type CheckAccountStatusResult =
  | { success: true; data: CheckAccountStatusData }
  | { success: false; error: { message: string; isBanned?: boolean } }

/**
 * 把上游用量响应组装成 renderer 消费的 check 结果。
 *
 * 这是原 handler 内联 `parseUsageResponse` 的**组装部分**(解析部分已收口到 ./parseUsage)。
 * 独立导出的理由:它是"响应 → DTO"的纯映射,与下方的 API 编排(重试/封禁判定)是两个关注点;
 * 将来 web 面板若要复用同一 DTO 而换一套取数方式,直接调它即可。
 */
export function buildCheckResult(
  result: RawUsageResponse,
  opts: {
    /** 标题无可识别关键词时的兜底订阅类型(原行为:account.subscription?.type ?? 'Free') */
    fallbackSubscriptionType?: string
    newCredentials?: { accessToken: string; refreshToken?: string; expiresIn?: number }
    userInfo?: UserInfoLike
  } = {}
): { success: true; data: CheckAccountStatusData } {
  const usage = parseCreditUsage(result)
  const subscription = parseSubscription(result, {
    fallbackType: opts.fallbackSubscriptionType
  })

  const { newCredentials, userInfo } = opts

  return {
    success: true,
    data: {
      status:
        !userInfo?.status || userInfo.status === 'Active' || userInfo.status === 'Stale'
          ? 'active'
          : 'error',
      email: result.userInfo?.email,
      userId: result.userInfo?.userId,
      idp: userInfo?.idp,
      userStatus: userInfo?.status,
      featureFlags: userInfo?.featureFlags,
      subscriptionTitle: subscription.title,
      usage: {
        current: usage.totalCurrent,
        limit: usage.totalLimit,
        percentUsed: usage.totalLimit > 0 ? usage.totalCurrent / usage.totalLimit : 0,
        lastUpdated: Date.now(),
        baseLimit: usage.baseLimit,
        baseCurrent: usage.baseCurrent,
        freeTrialLimit: usage.freeTrialLimit,
        freeTrialCurrent: usage.freeTrialCurrent,
        freeTrialExpiry: usage.freeTrialExpiry,
        bonuses: usage.bonuses,
        nextResetDate: usage.nextResetDate,
        resourceDetail: usage.resourceDetail
      },
      subscription: {
        type: subscription.type,
        title: subscription.title,
        rawType: subscription.rawType,
        expiresAt: subscription.expiresAt,
        daysRemaining: subscription.daysRemaining,
        upgradeCapability: subscription.upgradeCapability,
        overageCapability: subscription.overageCapability,
        managementTarget: subscription.managementTarget
      },
      // 如果刷新了 token，返回新的凭证
      newCredentials: newCredentials
        ? {
            accessToken: newCredentials.accessToken,
            refreshToken: newCredentials.refreshToken,
            expiresAt: newCredentials.expiresIn
              ? Date.now() + newCredentials.expiresIn * 1000
              : undefined
          }
        : undefined
    }
  }
}

/**
 * 解析账号应使用的 idp。
 * 社交登录用实际 provider(Github/Google),IdC 用 BuilderId。
 */
function resolveIdp(account: AccountLike): string {
  const { authMethod, provider } = account.credentials || {}
  if (authMethod === 'social') return provider || account.idp || 'BuilderId'
  if (provider) return provider
  return 'BuilderId'
}

/**
 * 检查单个账号的用量 / 订阅 / 封禁状态(用户日常的"刷新额度")。
 *
 * 成功后**落盘**（`./persistCheckResult`）—— 这是 IPC 与 web 面板共用的持久化点。
 * 原先落盘只长在 renderer store 里（`store/accounts.ts:2013/2079`），面板走 HTTP 调同一
 * 函数却没有那个 store ⇒ 手机端刷出的新数字重载即丢、桌面端也不知情。
 *
 * 取数编排在 `performAccountStatusCheck`，落盘在这里收口 —— 那边有三个成功返回点
 * （api_key / 首次成功 / 刷新后重试成功），三处各写一次落盘就是 Shotgun Surgery。
 */
export async function checkAccountStatus(
  deps: AccountRuntimeDeps,
  account: AccountLike
): Promise<CheckAccountStatusResult> {
  const result = await performAccountStatusCheck(deps, account)
  if (!result.success) return result

  // 落盘失败 ⇒ 整个「刷新额度」失败。
  //
  // 为什么不吞掉后照样返回成功：本轮要交付的成功状态是**用户视角**的
  // 「刷新后重载页面数字仍是新的」。落不了盘就交付不了这件事,返回 success 只会让
  // 用户看到一个重载即消失的数字 —— 正是本轮在修的那个 bug,只是变得更隐蔽。
  // 现实成因就两种:收口的 store 未注入（装配次序 bug）/ 写盘异常（磁盘满）,两者都该响。
  try {
    const outcome = await persistCheckResult(account.id, result.data)
    if (!outcome.persisted && outcome.reason === 'account-not-found') {
      // 另一端刚把这个账号删了。不是错误 —— 数据本身有效,只是没有归属可写。
      // 绝不重建（那是 C1/C3「已删账号复活」）。
      console.log(
        `[IPC] check-account-status: account ${account.id} no longer on disk, skipped persist`
      )
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[IPC] check-account-status: failed to persist result:', e)
    return { success: false, error: { message: `额度已取到但保存失败: ${message}` } }
  }

  return result
}

/**
 * 取数编排:api_key 走单请求;其余并行 GetUserInfo + GetUsageLimits,
 * 401/403 且具备刷新凭证 → refresh 后重试一次。
 *
 * 不落盘 —— 落盘由上面的 `checkAccountStatus` 统一收口。
 */
async function performAccountStatusCheck(
  deps: AccountRuntimeDeps,
  account: AccountLike
): Promise<CheckAccountStatusResult> {
  console.log(`[IPC] check-account-status [${account?.email || 'unknown'}]`)

  // 原行为:订阅类型兜底用账号已知类型,避免标题无关键词时把已知 Pro 降级为 Free
  const fallbackSubscriptionType = account.subscription?.type ?? 'Free'

  try {
    const {
      accessToken,
      refreshToken,
      clientId,
      clientSecret,
      region,
      authMethod,
      provider,
      tokenEndpoint,
      scopes
    } = account.credentials || {}

    // 查询账号绑定的代理（账号池）
    const boundProxyUrl = deps.proxyServer
      ? deps.proxyServer.getAccountPool().getAccount(account.id || '')?.proxyUrl
      : undefined

    const idp = resolveIdp(account)

    if (!accessToken) {
      console.log('[IPC] Missing accessToken')
      return { success: false, error: { message: '缺少 accessToken' } }
    }

    // 获取账户绑定的设备 ID
    const accountMachineId = account?.machineId as string | undefined

    // 网页 API Key(ksk_)账户：静态长凭证,无 token 刷新概念。
    // getUserInfo(CBOR/控制面)对 API_KEY 返 403 噪音,故跳过;仅走 getUsageLimits(REST + TokenType: API_KEY)
    // 拉取额度/订阅/邮箱(实测 2026-07-21 返 200 完整数据)。userInfo 由 getUsageLimits 响应内的 userInfo 提供。
    if (authMethod === 'api_key' || provider === 'ApiKey') {
      const usageResult = (await deps.api.getUsageAndLimits(
        accessToken,
        idp,
        account?.profileArn,
        accountMachineId,
        region,
        account?.email,
        authMethod
      )) as RawUsageResponse
      return buildCheckResult(usageResult, { fallbackSubscriptionType })
    }

    // 第一次尝试：使用当前 accessToken
    try {
      // 并行调用 GetUserInfo 和 getUsageAndLimits
      const [userInfoResult, usageResult] = await Promise.all([
        deps.api
          .getUserInfo(accessToken, idp, accountMachineId, account?.email)
          .catch((err: Error) => {
            // 封禁错误不能吞掉，必须向上抛出
            if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
              throw err
            }
            return undefined
          }),
        deps.api.getUsageAndLimits(
          accessToken,
          idp,
          account?.profileArn,
          accountMachineId,
          region,
          account?.email,
          authMethod
        ) as Promise<RawUsageResponse>
      ])
      return buildCheckResult(usageResult, {
        fallbackSubscriptionType,
        userInfo: userInfoResult
      })
    } catch (apiError) {
      const errorMsg = apiError instanceof Error ? apiError.message : ''

      // 检查是否是明确封禁错误（423 或 AccountSuspendedException）
      if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
        console.log('[IPC] Account suspended/banned')
        return { success: false, error: { message: errorMsg, isBanned: true } }
      }

      // 检查是否是 auth 错误 (token 过期 / 失效)
      // - 401 ：OIDC/CBOR API 无效 token 的典型返回
      // - 403 ：CodeWhisperer REST API 对 external_idp 过期 token 返回 "User is not authorized to make this call." /
      //   "The bearer token included in the request is invalid."
      //   已在上方排除了 AccountSuspended/423 封禁类 403，这里剥 401||403 都当作 token 问题转 refresh；
      //   刷新成功则继续，失败则报 error 无伤
      // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret，external_idp 需 tokenEndpoint
      const canRefresh =
        refreshToken &&
        (authMethod === 'social' || authMethod === 'external_idp' || (clientId && clientSecret))
      if ((errorMsg.includes('401') || errorMsg.includes('403')) && canRefresh) {
        console.log(
          `[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`
        )

        // 尝试刷新 token - 根据 authMethod 选择刷新方式（透传账号代理）
        const refreshResult = await deps.api.refreshTokenByMethod(
          refreshToken,
          clientId || '',
          clientSecret || '',
          region || 'us-east-1',
          authMethod,
          boundProxyUrl,
          { tokenEndpoint, scopes }
        )

        if (refreshResult.success && refreshResult.accessToken) {
          console.log('[IPC] Token refreshed, retrying API call...')

          // 用新 token 并行调用 GetUserInfo 和 getUsageAndLimits
          const [userInfoResult, usageResult] = await Promise.all([
            deps.api.getUserInfo(refreshResult.accessToken, idp, accountMachineId).catch((err: Error) => {
              if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                throw err
              }
              return undefined
            }),
            deps.api.getUsageAndLimits(
              refreshResult.accessToken,
              idp,
              account?.profileArn,
              accountMachineId,
              region,
              undefined,
              authMethod
            ) as Promise<RawUsageResponse>
          ])

          // 返回结果并包含新凭证
          return buildCheckResult(usageResult, {
            fallbackSubscriptionType,
            newCredentials: {
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresIn: refreshResult.expiresIn
            },
            userInfo: userInfoResult
          })
        } else {
          console.error('[IPC] Token refresh failed:', refreshResult.error)
          return {
            success: false,
            error: { message: `Token 过期且刷新失败: ${refreshResult.error}` }
          }
        }
      }

      // 不是 401 或没有刷新凭证，抛出原错误
      throw apiError
    }
  } catch (error) {
    console.error('check-account-status error:', error)
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
}

/** background-batch-check 的账号入参形状(与原 handler 一致) */
export interface BatchCheckAccount {
  id: string
  email: string
  profileArn?: string
  credentials: {
    accessToken: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    provider?: string
  }
  idp?: string
}

/**
 * 批量检查账号状态(不刷新 Token,只检查状态)。
 *
 * 逐条结果经 `deps.emit('background-check-result', …)` 推送,每批结束推
 * `background-check-progress` —— channel 名 / payload 形状 / 发射时机与原 handler 一致。
 *
 * **每切片落盘一次**（`persistBatchCheckResults`）：事件照原样先发（UI 逐条更新的响应性不受影响），
 * 落盘在切片边界做。为什么是切片而不是逐账号 / 最后一次性，见 persistCheckResult.ts 的注释。
 */
export async function backgroundBatchCheck(
  deps: AccountRuntimeDeps,
  accounts: BatchCheckAccount[],
  concurrency: number = 10
): Promise<BatchSummary> {
  console.log(
    `[BackgroundCheck] Starting batch check for ${accounts.length} accounts, concurrency: ${concurrency}`
  )

  let completed = 0
  let success = 0
  let failed = 0

  // 串行处理每批
  for (let i = 0; i < accounts.length; i += concurrency) {
    const batch = accounts.slice(i, i + concurrency)
    /**
     * 本切片待落盘的结果。事件仍逐条即时发（UI 响应性不变），落盘攒到切片边界。
     * 每个 emit 点旁边都要 push —— 两者是同一个事实的两个出口，漏一个就是「UI 显示了但盘上没有」。
     */
    const sliceResults: BatchCheckItem[] = []

    await Promise.allSettled(
      batch.map(async (account) => {
        try {
          const { accessToken, authMethod, provider } = account.credentials

          if (!accessToken) {
            failed++
            completed++
            deps.emit('background-check-result', {
              id: account.id,
              success: false,
              error: '缺少 accessToken'
            })
            sliceResults.push({ id: account.id, success: false, error: '缺少 accessToken' })
            return
          }

          // 确定 idp
          let idp = account.idp || 'BuilderId'
          if (authMethod === 'social' && provider) {
            idp = provider
          }

          // 调用 API 获取用量和用户信息（根据配置选择 REST 或 CBOR 格式）
          // profileArn 必须透传：Kiro REST GetUsageLimits 对社交/Enterprise 有效账户要求 profileArn
          // 存在，undefined 会 400 "Improperly formed request" → usage 永远 0。
          // RCA: .agent-workspace/.archive/2026-07-14/usage-refresh-zero/
          const [usageRes, userInfoRes] = await Promise.allSettled([
            deps.api.getUsageAndLimits(
              accessToken,
              idp,
              account.profileArn,
              undefined,
              account.credentials?.region,
              account.email,
              account.credentials?.authMethod
            ) as Promise<RawUsageResponse>,
            // 原实现直接调 kiroApiRequest('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp, undefined, account.email)
            // getUserInfo 就是该调用的具名封装(index.ts:1762),逐参数等价
            deps.api.getUserInfo(accessToken, idp, undefined, account.email).catch((err: Error) => {
              // 封禁错误不能吞掉，需要在后续逻辑中检测
              if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                throw err
              }
              return null as unknown as UserInfoLike
            })
          ])

          // 解析响应（上游直接返回数据或抛出异常）
          let usageData: {
            current: number
            limit: number
            baseCurrent?: number
            baseLimit?: number
            freeTrialCurrent?: number
            freeTrialLimit?: number
            freeTrialExpiry?: string
            bonuses?: Array<{
              code: string
              name: string
              current: number
              limit: number
              expiresAt?: string
            }>
            nextResetDate?: string
          } | null = null
          let subscriptionData: {
            type: string
            title: string
            daysRemaining?: number
            expiresAt?: number
            overageCapability?: string
            upgradeCapability?: string
            subscriptionManagementTarget?: string
          } | null = null
          let resourceDetail:
            | {
                displayName?: string
                displayNamePlural?: string
                resourceType?: string
                currency?: string
                unit?: string
                overageRate?: number
                overageCap?: number
                overageEnabled?: boolean
              }
            | undefined
          let userInfoData: {
            email?: string
            userId?: string
            status?: string
          } | null = null
          let status = 'active'
          let errorMessage: string | undefined

          // 处理用量响应
          if (usageRes.status === 'fulfilled') {
            const rawUsage = usageRes.value
            // 解析 Credits 使用量 / 订阅（与单个检查共用 SSOT）
            const usage = parseCreditUsage(rawUsage)
            const subscription = parseSubscription(rawUsage)

            usageData = {
              current: usage.totalCurrent,
              limit: usage.totalLimit,
              baseCurrent: usage.baseCurrent,
              baseLimit: usage.baseLimit,
              freeTrialCurrent: usage.freeTrialCurrent,
              freeTrialLimit: usage.freeTrialLimit,
              freeTrialExpiry: usage.freeTrialExpiry,
              bonuses: usage.bonuses,
              nextResetDate: usage.nextResetDate
            }

            // 解析资源详情（含超额信息）
            resourceDetail = usage.resourceDetail

            subscriptionData = {
              type: subscription.type,
              title: subscription.title,
              daysRemaining: subscription.daysRemaining,
              expiresAt: subscription.expiresAt,
              overageCapability: subscription.overageCapability,
              upgradeCapability: subscription.upgradeCapability,
              subscriptionManagementTarget: subscription.managementTarget
            }
          } else if (usageRes.status === 'rejected') {
            // API 调用失败（可能是封禁或 Token 过期）
            const errorMsg = usageRes.reason?.message || String(usageRes.reason)
            console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg)
            if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
              status = 'error'
              errorMessage = errorMsg
            } else if (errorMsg.includes('401') || errorMsg.includes('403')) {
              // external_idp 过期 token 返回 403，已排除上方封禁类（423/AccountSuspended），剩下的 403 当 token 问题
              status = 'expired'
              errorMessage = 'Token 已过期，请刷新'
            } else {
              status = 'error'
              errorMessage = errorMsg
            }
          }

          // 处理用户信息响应
          if (userInfoRes.status === 'fulfilled' && userInfoRes.value) {
            const rawUserInfo = userInfoRes.value
            userInfoData = {
              email: rawUserInfo.email,
              userId: rawUserInfo.userId,
              status: rawUserInfo.status
            }
            // 检查用户状态（Stale 视为正常，仅 Suspended/Disabled 等视为异常）
            if (
              rawUserInfo.status &&
              rawUserInfo.status !== 'Active' &&
              rawUserInfo.status !== 'Stale' &&
              status !== 'error'
            ) {
              status = 'error'
              errorMessage = `用户状态异常: ${rawUserInfo.status}`
            }
          } else if (userInfoRes.status === 'rejected') {
            // GetUserInfo 失败（封禁错误会到这里）
            const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason)
            if (errMsg.includes('423') || errMsg.includes('AccountSuspended')) {
              status = 'error'
              errorMessage = errMsg
            }
          }

          success++
          completed++

          // 通知渲染进程更新账号
          const resultData = {
            usage: usageData ? { ...usageData, resourceDetail } : null,
            subscription: subscriptionData,
            userInfo: userInfoData,
            status,
            errorMessage
          }
          deps.emit('background-check-result', {
            id: account.id,
            success: true,
            data: resultData
          })
          sliceResults.push({ id: account.id, success: true, data: resultData })
        } catch (e) {
          failed++
          completed++
          const message = e instanceof Error ? e.message : 'Unknown error'
          deps.emit('background-check-result', {
            id: account.id,
            success: false,
            error: message
          })
          sliceResults.push({ id: account.id, success: false, error: message })
        }
      })
    )

    // 本切片落盘（一次 revision 递增 + 一条广播）。
    // 失败**不中断整个批量** —— 为一片写盘失败放弃后面所有账号是更差的选择；
    // 结果已通过事件到达 UI，下次刷新会重新取到。绝不静默：日志是唯一可观测出口。
    if (sliceResults.length > 0) {
      try {
        const applied = await persistBatchCheckResults(sliceResults)
        console.log(
          `[BackgroundCheck] Persisted ${applied}/${sliceResults.length} results of this slice`
        )
      } catch (e) {
        console.error('[BackgroundCheck] Failed to persist slice results:', e)
      }
    }

    // 通知进度
    deps.emit('background-check-progress', {
      completed,
      total: accounts.length,
      success,
      failed
    })

    // 批次间延迟
    if (i + concurrency < accounts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`)
  return { success: true, completed, successCount: success, failedCount: failed }
}
