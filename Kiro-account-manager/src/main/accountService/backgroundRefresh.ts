/**
 * 后台批量刷新 Token(background-batch-refresh) · 从 ipcMain.handle 抽出
 *
 * 原位置:`src/main/index.ts:3959` 内联的 `backgroundBatchRefresh`(约 320 行)。
 *
 * ## 为什么必须搬出 index.ts
 *
 * 它是**服务器形态下唯一的 token 续期路径**(主进程调度器 `runMainPoolTokenRefreshTick`
 * 每 60s 调它),而 index.ts 依赖 electron、在纯 node 下加载不了 ——
 * 留在那里就等于「服务器要跑的东西长在跑不起来的文件里」。
 * 搬进 accountService 后与 `check.ts:backgroundBatchCheck` 同构:
 * 传输通道无关、可单测、服务端壳可直接调。
 *
 * ## 行为逐字保留(改动过的地方只有「多了落盘」)
 *
 *   - 去重集合 `refreshInFlightIds` 与主进程调度器共享:已在途则跳过本次,
 *     **不计入成败**(等在途那次的结果回流)。对同一 refreshToken 并发刷新
 *     会让其中一个用到被 rotate 作废的旧 token。
 *   - `needsTokenRefresh !== false` 默认为 true(兼容旧版本调用方)。
 *   - IDE token 文件同步的**双判据**(磁盘 refreshToken 匹配 或 lastSwitchedAccountId 匹配),
 *     以及它读的是 `diskToken?.profileArn`(与单账号路径 `refresh.ts` 读 `account.profileArn`
 *     不同 —— 这是既有差异,不在本轮统一)。
 *   - 仅 Enterprise / external_idp 才调 API 补 profileArn。
 *   - `syncInfo` 决定是否调用量/用户信息 API;封禁错误(423 / AccountSuspendedException)
 *     只标 status,不抛。
 *   - 事件 channel 名 / payload 形状 / 发射时机原样保留。
 */

import { parseCreditUsage, parseSubscription, type RawUsageResponse } from './parseUsage'
import {
  persistBatchRefreshResults,
  type BatchRefreshItem
} from './persistRefreshBatchResults'
import { syncDesktopAutoSwitchScheduler } from './autoSwitch'
import type { AccountRuntimeDeps, BatchSummary, UserInfoLike } from './types'
import { isAccountSuspensionError } from '../../shared/accountSuspension'

/** background-batch-refresh 的入参形状(镜像原 index.ts 的同名类型) */
export type BackgroundRefreshAccount = {
  id: string
  idp?: string
  profileArn?: string
  needsTokenRefresh?: boolean
  machineId?: string
  credentials: {
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    accessToken?: string
    provider?: string
    profileArn?: string
    /** external_idp (Azure AD) 刷新走微软 tokenEndpoint,缺字段会导致后台自动刷新失败 */
    tokenEndpoint?: string
    issuerUrl?: string
    scopes?: string
    audience?: string
  }
}

/** 本次刷新产出的额度明细(与 emit payload 的 `data.usage` 同形) */
interface ParsedUsagePayload {
  current: number
  limit: number
  baseCurrent: number
  baseLimit: number
  freeTrialCurrent: number
  freeTrialLimit: number
  freeTrialExpiry?: string
  bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
  nextResetDate?: string
  resourceDetail?: {
    displayName?: string
    displayNamePlural?: string
    resourceType?: string
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageEnabled?: boolean
  }
}

/**
 * 后台批量刷新账号 Token。
 *
 * @param deps 依赖包(上游 API / 事件出口 / 共享可变状态)
 * @param accounts 待刷新账号快照
 * @param concurrency 每切片并发数
 * @param syncInfo 是否同时同步用量/订阅/用户信息
 */
export async function backgroundBatchRefresh(
  deps: AccountRuntimeDeps,
  accounts: BackgroundRefreshAccount[],
  concurrency: number = 10,
  syncInfo: boolean = true
): Promise<BatchSummary> {
  // renderer 用既有 IPC 的空批次作为一次性启动/唤醒信号。timer 与决策均在 main，
  // 空批次本身不刷新任何账号；普通非空后台刷新不会反复触碰调度器。
  if (accounts.length === 0 && concurrency === 1 && syncInfo === false) {
    syncDesktopAutoSwitchScheduler(deps)
  }

  console.log(
    `[BackgroundRefresh] Starting batch refresh for ${accounts.length} accounts, concurrency: ${concurrency}, syncInfo: ${syncInfo}`
  )

  let completed = 0
  let success = 0
  let failed = 0

  // 串行处理每批，避免并发过高
  for (let i = 0; i < accounts.length; i += concurrency) {
    const batch = accounts.slice(i, i + concurrency)
    /**
     * 本切片待落盘的结果。事件仍逐条即时发（UI 响应性不变），落盘攒到切片边界。
     * 每个 emit 点旁边都要 push —— 两者是同一个事实的两个出口，
     * 漏一个就是「UI 显示了但盘上没有」(服务器上则是「日志说刷新成功但盘上没有」)。
     */
    const sliceResults: BatchRefreshItem[] = []

    await Promise.allSettled(
      batch.map(async (account) => {
        // 去重：渲染进程定时器与主进程调度器可能同时触发刷新，
        // 对同一账号并发刷新会让其中一个用到被 rotate 作废的旧 refreshToken。
        // 已在途则跳过本次（不计入成败，等在途那次的结果回流即可）。
        if (account.id && deps.refreshInFlightIds.has(account.id)) {
          return
        }
        if (account.id) deps.refreshInFlightIds.add(account.id)
        try {
          const {
            refreshToken,
            clientId,
            clientSecret,
            region,
            authMethod,
            accessToken,
            provider,
            tokenEndpoint,
            scopes
          } = account.credentials
          const needsTokenRefresh = account.needsTokenRefresh !== false // 默认为 true（兼容旧版本）

          // 查询账号绑定的代理（从主进程账号池）
          const boundProxyUrl = deps.proxyServer
            ? deps.proxyServer.getAccountPool().getAccount(account.id)?.proxyUrl
            : undefined

          // 确定正确的 idp
          let idp = 'BuilderId'
          if (authMethod === 'social') {
            idp = provider || account.idp || 'BuilderId'
          } else if (provider) {
            idp = provider
          }

          let newAccessToken = accessToken
          let newRefreshToken = refreshToken
          let newExpiresIn: number | undefined

          // 只有需要刷新 Token 时才刷新
          if (needsTokenRefresh) {
            if (!refreshToken) {
              failed++
              completed++
              return
            }

            // 刷新 Token（透传账号绑定代理）
            const refreshResult = await deps.api.refreshTokenByMethod(
              refreshToken,
              clientId || '',
              clientSecret || '',
              region || 'us-east-1',
              authMethod,
              boundProxyUrl,
              { tokenEndpoint, scopes }
            )

            if (!refreshResult.success) {
              failed++
              completed++
              // 通知渲染进程刷新失败
              deps.emit('background-refresh-result', {
                id: account.id,
                success: false,
                error: refreshResult.error
              })
              sliceResults.push({
                id: account.id,
                success: false,
                error: refreshResult.error
              })
              return
            }

            newAccessToken = refreshResult.accessToken || accessToken
            newRefreshToken = refreshResult.refreshToken || refreshToken
            newExpiresIn = refreshResult.expiresIn

            // 仅当该账号是 Kiro IDE 当前激活账号时，同步新 token 到磁盘 token 文件。
            // 否则 IDE 在 ~50min 后会用磁盘上"被自动刷新作废"的旧 refreshToken 调 OIDC → 401 → logoutAndForget。
            // 判定优先级（任一命中）：1) 磁盘 refresh 匹配账号  2) lastSwitchedAccountId 匹配
            if (newAccessToken && newRefreshToken && newExpiresIn) {
              try {
                const diskToken = await deps.api.readKiroAuthTokenFile()
                const matchByRefresh = !!diskToken && diskToken.refreshToken === refreshToken
                const matchByLastSwitch = deps.getLastSwitchedAccountId() === account.id
                if (matchByRefresh || matchByLastSwitch) {
                  const resolvedProfileArn = deps.api.resolveProfileArnForWrite({
                    profileArn: diskToken?.profileArn,
                    authMethod,
                    provider,
                    region
                  })
                  await deps.api.writeKiroAuthTokenFile({
                    accessToken: newAccessToken,
                    refreshToken: newRefreshToken,
                    expiresAtIso: new Date(Date.now() + newExpiresIn * 1000).toISOString(),
                    authMethod:
                      authMethod === 'social'
                        ? 'social'
                        : authMethod === 'external_idp'
                          ? 'external_idp'
                          : 'IdC',
                    provider: provider || (diskToken?.provider as string | undefined) || 'BuilderId',
                    region: region || diskToken?.region,
                    // background-batch-refresh 没传 startUrl，但 disk 的 clientIdHash 不再变；
                    // helper 会用默认 startUrl 计算同一 hash，写入的 client 注册文件路径也不会变
                    clientId: clientId || undefined,
                    clientSecret: clientSecret || undefined,
                    profileArn: resolvedProfileArn
                  })
                  deps.setLastWrittenTokenSignature(`${newAccessToken}|${newRefreshToken}`)
                  if (account.id) deps.setLastSwitchedAccountId(account.id)
                  console.log(
                    `[BackgroundRefresh] Synced refreshed token to Kiro IDE for account ${account.id}`
                  )
                  if (deps.isProactiveRenewalEnabled() && account.id) {
                    deps.scheduleProactiveRenewal(account.id, Date.now() + newExpiresIn * 1000)
                  }
                }
              } catch (e) {
                console.warn(`[BackgroundRefresh] sync to IDE failed for ${account.id}:`, e)
              }
            }
          }

          // Enterprise 账号：后台刷新后自动获取 profileArn（BuilderId/Social 不需要调 API）
          const existingProfileArn = account.profileArn || account.credentials?.profileArn
          let resolvedBgProfileArn: string | undefined
          const isEnt = (provider || account.idp) === 'Enterprise' || authMethod === 'external_idp'
          if (!existingProfileArn && newAccessToken && isEnt) {
            try {
              resolvedBgProfileArn = await deps.api.fetchEnterpriseProfileArn({
                id: account.id || '',
                accessToken: newAccessToken,
                region: region || 'us-east-1',
                provider: provider || account.idp,
                authMethod: authMethod as
                  | 'IdC'
                  | 'social'
                  | 'idc'
                  | 'external_idp'
                  | undefined,
                machineId: account.machineId
              })
              if (resolvedBgProfileArn) {
                console.log(
                  `[BackgroundRefresh] Enterprise profileArn auto-resolved: ${resolvedBgProfileArn} (${account.id})`
                )
              }
            } catch (e) {
              console.warn(
                `[BackgroundRefresh] Failed to fetch Enterprise profileArn for ${account.id}:`,
                e
              )
            }
          }

          // 获取账号信息
          if (!newAccessToken) {
            failed++
            completed++
            return
          }

          // 根据 syncInfo 决定是否检测账户信息
          let parsedUsage: ParsedUsagePayload | undefined
          let userInfoData: UserInfoLike | undefined
          let subscriptionData:
            | {
                type: string
                title: string
                daysRemaining?: number
                expiresAt?: number
                overageCapability?: string
                upgradeCapability?: string
                subscriptionManagementTarget?: string
              }
            | undefined
          let status = 'active'
          let errorMessage: string | undefined

          if (syncInfo) {
            // 调用 getUsageAndLimits API（根据配置选择 REST 或 CBOR 格式）
            try {
              console.log(
                `[BackgroundRefresh] Account ${account.id} machineId: ${account.machineId || 'undefined'}`
              )
              const rawUsage = (await deps.api.getUsageAndLimits(
                newAccessToken,
                idp,
                account.profileArn,
                account.machineId,
                region,
                undefined,
                authMethod
              )) as RawUsageResponse

              // 解析使用量与订阅（走 accountService/parseUsage SSOT）
              // 原先此处内联第三份副本，其 CREDIT 判据只认 resourceType，
              // resourceType 缺失的响应会让额度恒为 0；SSOT 采用 displayName 兜底的宽判据。
              const usage = parseCreditUsage(rawUsage)
              const subscription = parseSubscription(rawUsage, { emptyTitleAsDefault: true })

              parsedUsage = {
                current: usage.totalCurrent,
                limit: usage.totalLimit,
                baseCurrent: usage.baseCurrent,
                baseLimit: usage.baseLimit,
                freeTrialCurrent: usage.freeTrialCurrent,
                freeTrialLimit: usage.freeTrialLimit,
                freeTrialExpiry: usage.freeTrialExpiry,
                bonuses: usage.bonuses,
                nextResetDate: usage.nextResetDate,
                resourceDetail: usage.resourceDetail
              }

              subscriptionData = {
                type: subscription.type,
                title: subscription.title,
                daysRemaining: subscription.daysRemaining,
                expiresAt: subscription.expiresAt,
                overageCapability: subscription.overageCapability,
                upgradeCapability: subscription.upgradeCapability,
                subscriptionManagementTarget: subscription.managementTarget
              }
            } catch (apiError) {
              const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
              console.log(`[BackgroundRefresh] Usage API error for ${account.id}:`, errMsg)
              if (isAccountSuspensionError(errMsg)) {
                status = 'error'
                errorMessage = errMsg
              }
            }

            // 调用 GetUserInfo API 获取用户状态
            try {
              userInfoData = await deps.api.getUserInfo(newAccessToken, idp, account.machineId)
            } catch (apiError) {
              const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
              if (isAccountSuspensionError(errMsg)) {
                status = 'error'
                errorMessage = errMsg
              }
            }
          }

          success++
          completed++

          // 通知渲染进程更新账号
          const resultData = {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresIn: newExpiresIn,
            profileArn: resolvedBgProfileArn || undefined,
            usage: parsedUsage,
            subscription: subscriptionData,
            userInfo: syncInfo ? userInfoData : undefined,
            status,
            errorMessage
          }
          deps.emit('background-refresh-result', {
            id: account.id,
            success: true,
            data: resultData
          })
          sliceResults.push({ id: account.id, success: true, data: resultData })
        } catch (e) {
          failed++
          completed++
          const message = e instanceof Error ? e.message : 'Unknown error'
          deps.emit('background-refresh-result', {
            id: account.id,
            success: false,
            error: message
          })
          sliceResults.push({ id: account.id, success: false, error: message })
        } finally {
          if (account.id) deps.refreshInFlightIds.delete(account.id)
        }
      })
    )

    // 本切片落盘（一次 revision 递增 + 一条广播）。
    //
    // 这是服务器形态下**唯一**的持久化出口:没有渲染进程,
    // `emit` 是静默 no-op,不落在这里新签发的 refreshToken 就永远上不了盘,
    // 而它对应的旧 token 已被 IdP 当场作废 ⇒ 重启后账号全死。
    //
    // 失败**不中断整个批量** —— 为一片写盘失败放弃后面所有账号是更差的选择;
    // 那一片的结果仍已通过事件到达 UI,下一轮调度会重新刷到。
    // **绝不静默**:错误日志是唯一的可观测出口。
    if (sliceResults.length > 0) {
      try {
        const applied = await persistBatchRefreshResults(sliceResults)
        console.log(
          `[BackgroundRefresh] Persisted ${applied}/${sliceResults.length} results of this slice`
        )
      } catch (e) {
        console.error('[BackgroundRefresh] Failed to persist slice results:', e)
      }
    }

    // 通知进度
    deps.emit('background-refresh-progress', {
      completed,
      total: accounts.length,
      success,
      failed
    })

    // 批次间延迟，让主进程有喘息时间
    if (i + concurrency < accounts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`)
  return { success: true, completed, successCount: success, failedCount: failed }
}
