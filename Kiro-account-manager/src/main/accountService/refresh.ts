/**
 * 单账号 Token 刷新 · 从 ipcMain.handle('refresh-account-token') 抽出
 *
 * 原位置:src/main/index.ts:3585(约 150 行内联)
 * 行为逐字节保留,包括:
 *   - ksk_(api_key)账户 no-op 直接原样返回(不走"缺少 Refresh Token"错误分支)
 *   - syncedToIde 的**双判据**(磁盘 refreshToken 匹配 或 lastSwitchedAccountId 匹配)。
 *     ⚠️ 不可简化为只看 lastSwitchedAccountId:会导致刷新后 IDE 磁盘不同步 →
 *     IDE 用旧 token 调 OIDC → 401 → logoutAndForget(bug B 回归 · recon §7.2 要点 1)
 *   - refreshTokenByMethod 的完整参数(region / tokenEndpoint / scopes 都有自愈作用,
 *     不可"简化" · commit 77f73c0 / 1b8faa6 跨区域重试依赖它)
 *   - 仅 Enterprise / external_idp 才调 API 补 profileArn(BuilderId/Social 不调)
 */

import type { AccountLike, AccountRuntimeDeps } from './types'

/** refresh-account-token 的返回形状(与原 handler 逐字段一致) */
export type RefreshAccountTokenResult =
  | {
      // api_key 分支:平铺字段,**不包 data**(原行为如此,renderer 已适配)
      success: true
      accessToken?: string
      refreshToken?: undefined
      expiresAt?: number
      profileArn?: string
    }
  | {
      success: true
      data: {
        accessToken: string
        refreshToken: string
        expiresIn: number
        profileArn?: string
        syncedToIde: boolean
        syncSkipReason?: string
      }
    }
  | { success: false; error: { message: string } }

/**
 * 刷新单个账号的 access token。
 *
 * @param deps 依赖包(proxyServer 查绑定代理 / api 上游调用 / 共享可变状态读写)
 * @param account renderer 传入的账号快照
 */
export async function refreshAccountToken(
  deps: AccountRuntimeDeps,
  account: AccountLike
): Promise<RefreshAccountTokenResult> {
  try {
    const {
      refreshToken,
      clientId,
      clientSecret,
      region,
      authMethod,
      startUrl,
      provider,
      tokenEndpoint,
      scopes
    } = account.credentials || {}

    // 网页 API Key(ksk_)账户：静态长凭证，无 refreshToken、永不过期，刷新是 no-op。
    // 返回成功并原样带回现有 token/profileArn，避免走下面"缺少 Refresh Token"错误分支误标账号异常。
    if (authMethod === 'api_key' || provider === 'ApiKey') {
      return {
        success: true,
        accessToken: account.credentials?.accessToken,
        refreshToken: undefined,
        expiresAt: account.credentials?.expiresAt,
        profileArn: account.profileArn || account.credentials?.profileArn
      }
    }

    if (!refreshToken) {
      return { success: false, error: { message: '缺少 Refresh Token' } }
    }

    // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret；external_idp 只需 tokenEndpoint+clientId
    if (
      authMethod !== 'social' &&
      authMethod !== 'external_idp' &&
      (!clientId || !clientSecret)
    ) {
      return { success: false, error: { message: '缺少 OIDC 刷新凭证 (clientId/clientSecret)' } }
    }

    // 查找账号绑定的代理 URL（账号池中已有 proxyUrl 字段）
    const boundProxyUrl = deps.proxyServer
      ? deps.proxyServer.getAccountPool().getAccount(account.id || '')?.proxyUrl
      : undefined

    console.log(
      `[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`
    )

    // 根据 authMethod 选择刷新方式（透传账号绑定代理）
    const refreshResult = await deps.api.refreshTokenByMethod(
      refreshToken,
      clientId || '',
      clientSecret || '',
      region || 'us-east-1',
      authMethod,
      boundProxyUrl,
      { tokenEndpoint, scopes }
    )

    if (!refreshResult.success || !refreshResult.accessToken) {
      return { success: false, error: { message: refreshResult.error || 'Token 刷新失败' } }
    }

    const newAccess = refreshResult.accessToken
    const newRefresh = refreshResult.refreshToken || refreshToken
    const expiresIn = refreshResult.expiresIn ?? 3600

    // bug B 修复：仅当该账号是 Kiro IDE 当前激活账号时，同步写入磁盘 token 文件
    // 判定优先级（任一命中即视为"是当前激活账号"）：
    //   1) 磁盘 token 的 refreshToken === renderer 传入的 account.credentials.refreshToken（最准）
    //   2) account.id === lastSwitchedAccountId（反代刚切过号的兜底）
    // 不同步的场景：用户在反代里刷新的是"非当前激活账号"，避免误覆盖 IDE 当前账号
    let syncedToIde = false
    let syncSkipReason: string | undefined
    try {
      const diskToken = await deps.api.readKiroAuthTokenFile()
      const matchByRefresh = !!diskToken && diskToken.refreshToken === refreshToken
      const matchByLastSwitch = !!account.id && deps.getLastSwitchedAccountId() === account.id
      if (matchByRefresh || matchByLastSwitch) {
        const resolvedProfileArn = deps.api.resolveProfileArnForWrite({
          profileArn: account.profileArn,
          authMethod,
          provider,
          region
        })
        await deps.api.writeKiroAuthTokenFile({
          accessToken: newAccess,
          refreshToken: newRefresh,
          expiresAtIso: new Date(Date.now() + expiresIn * 1000).toISOString(),
          authMethod:
            authMethod === 'social'
              ? 'social'
              : authMethod === 'external_idp'
                ? 'external_idp'
                : 'IdC',
          provider: provider || (diskToken?.provider as string | undefined) || 'BuilderId',
          region: region || diskToken?.region,
          startUrl,
          clientId: clientId || undefined,
          clientSecret: clientSecret || undefined,
          profileArn: resolvedProfileArn
        })
        // 记录刚写入的签名，避免 watcher 触发反向同步回环
        deps.setLastWrittenTokenSignature(`${newAccess}|${newRefresh}`)
        if (account.id) deps.setLastSwitchedAccountId(account.id)
        syncedToIde = true
        console.log(
          `[Refresh] Synced refreshed token to Kiro IDE for account ${account.email || account.id}`
        )
        // 重新 schedule 主动续期 timer（基于新 expiresAt，覆盖任何旧 timer）
        if (deps.isProactiveRenewalEnabled() && account.id) {
          deps.scheduleProactiveRenewal(account.id, Date.now() + expiresIn * 1000)
        }
      } else {
        syncSkipReason = diskToken
          ? '该账号不是 Kiro IDE 当前激活账号，跳过磁盘同步'
          : '磁盘上未找到 kiro-auth-token.json（IDE 未登录），跳过磁盘同步'
      }
    } catch (e) {
      syncSkipReason = `磁盘同步异常：${e instanceof Error ? e.message : String(e)}`
      console.warn('[Refresh] Failed to sync token to IDE:', e)
    }

    // 刷新后自动获取 profileArn（仅 Enterprise 需要调 API，其他类型不调）
    let resolvedEnterpriseArn: string | undefined
    const existingProfileArn = account.profileArn || account.credentials?.profileArn
    if (!existingProfileArn) {
      const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
      if (isEnt) {
        try {
          resolvedEnterpriseArn = await deps.api.fetchEnterpriseProfileArn({
            id: account.id || '',
            accessToken: newAccess,
            region: region || 'us-east-1',
            provider,
            authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined,
            machineId: account.machineId
          })
          if (resolvedEnterpriseArn) {
            console.log(`[Refresh] Enterprise profileArn auto-resolved: ${resolvedEnterpriseArn}`)
          }
        } catch (e) {
          console.warn('[Refresh] Failed to fetch Enterprise profileArn:', e)
        }
      }
      // BuilderId/Social 不调 API，不需要返回 profileArn（反代自愈时用 resolveProfileArn 兜底）
    }

    return {
      success: true,
      data: {
        accessToken: newAccess,
        refreshToken: newRefresh,
        expiresIn,
        // Enterprise 自动获取的 profileArn（renderer 需要存储到账号数据）
        profileArn: resolvedEnterpriseArn || undefined,
        // 让 renderer 决定是否给用户显示"已同步到 IDE"的反馈
        syncedToIde,
        syncSkipReason
      }
    }
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
}
