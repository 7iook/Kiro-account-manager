/**
 * accountService/switch.ts · 切号 / 退出登录的可复用业务实现
 *
 * 为什么这个文件存在:这些逻辑原先内联在 `index.ts` 的 `ipcMain.handle` 回调里,只有 IPC
 * 通道能触达。决策卡 §3 要求 web 面板「每个端点一对一映射到现有 IPC handler 背后的 main
 * 侧实现」—— 复用同一份实现,而不是照着抄第二份。故抽到此处,由 IPC 与将来的 HTTP 层共用。
 *
 * 抽离契约(不可打破):
 *   - 不依赖 preload(preload 是 renderer 的桥,main 侧业务层碰不到)
 *   - 不接受 Electron `IpcMainInvokeEvent`
 *   - 不引用 `index.ts` 的模块级 `let`,一律走 deps 显式传入
 *   - 不 import electron —— 保持可在 vitest node env 直接跑
 *
 * ⚠️ 模块级状态为什么必须走 getter/setter 而不能私有化到本文件:
 *   `lastSwitchedAccountId` / `lastWrittenTokenSignature` 是 v1.7.3(commit 5a2d54f)
 *   为「Kiro IDE Token 双向同步」引入的。写方是切号/刷新路径,**读方是留在 `index.ts` 的
 *   fs.watch watcher**(`index.ts:1875` 防回环判定 · `:1937` 账号匹配兜底)。若在本文件
 *   声明模块私有副本,watcher 读到的将是另一份,双向同步立刻失效 —— 表现为「IDE 自刷后
 *   反代 store 不更新」或「反代刚写的数据被 watcher 当成 IDE 的改动再回写一次」。
 *   故此处只接受写入回调,真源始终是 `index.ts` 的那一份。
 *
 * ⚠️ v1.7.3 修掉的四个真实故障,抽离时最易被"顺手简化"掉(全都会重演「切号后 Kiro IDE
 *    约一小时被强制登出」):
 *   bug A · 落盘必须是 OIDC 轮换后的 refreshToken(旧值已被服务端作废)
 *   bug C · expiresAt 用真实 expiresIn,不硬编码 3600
 *   bug D · refresh 失败必须拒绝写盘
 *   bug F · 回传 refreshedCredentials 让 renderer 同步反代 store
 */

import type { WriteKiroAuthTokenInput, WriteKiroAuthTokenResult } from '../kiroAuthSync'

/** 与 `index.ts:251 OidcRefreshResult` 结构一致;此处独立声明避免反向依赖 index.ts */
export interface SwitchRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  resolvedRegion?: string
}

/** 切号入参 —— 与原 `switch-account` IPC 的 credentials 参数逐字段一致 */
export interface SwitchAccountCredentials {
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
  region?: string
  startUrl?: string
  authMethod?: 'IdC' | 'social' | 'external_idp' | 'api_key'
  provider?: 'BuilderId' | 'Github' | 'Google' | 'Enterprise' | 'AzureAD' | 'ExternalIdp'
  profileArn?: string
  tokenEndpoint?: string
  issuerUrl?: string
  scopes?: string
  audience?: string
  accountId?: string
}

export interface SwitchAccountResult {
  success: boolean
  error?: string
  /** bug F 支持:回传 refresh 后的最新凭证,让 renderer 更新反代 store */
  refreshedCredentials?: {
    accessToken: string
    refreshToken: string
    expiresIn: number
  }
}

export interface SwitchAccountDeps {
  /** `index.ts:1030 refreshTokenByMethod`(带 in-flight 去重) */
  refreshTokenByMethod: (
    token: string,
    clientId: string,
    clientSecret: string,
    region: string,
    authMethod?: string,
    proxyUrl?: string,
    externalIdp?: { tokenEndpoint?: string; scopes?: string }
  ) => Promise<SwitchRefreshResult>
  /** `kiroAuthSync.ts:157` —— 宿主机能力:写 ~/.aws/sso/cache */
  writeKiroAuthTokenFile: (input: WriteKiroAuthTokenInput) => Promise<WriteKiroAuthTokenResult>
  /** `kiroAuthSync.ts:84 resolveProfileArnForWrite` */
  resolveProfileArnForWrite: (input: {
    profileArn?: string
    authMethod?: string
    provider?: string
    region?: string
  }) => string | undefined
  /** 写 `index.ts:2242 lastSwitchedAccountId`(读方是 index.ts 的 watcher,见文件头说明) */
  setLastSwitchedAccountId: (id: string | null) => void
  /** 写 `index.ts:2246 lastWrittenTokenSignature`(watcher 防回环依据) */
  setLastWrittenTokenSignature: (signature: string | null) => void
  /** 读 `index.ts:2255 proactiveRenewalEnabled` */
  isProactiveRenewalEnabled: () => boolean
  /** `index.ts:2014 scheduleProactiveRenewal` */
  scheduleProactiveRenewal: (accountId: string, expiresAtMs: number) => void
}

/**
 * 切换账号到 Kiro IDE —— 写入本机 SSO 缓存 `~/.aws/sso/cache/kiro-auth-token.json`。
 *
 * ⚠️ 宿主机能力:本函数落地到调用方所在机器的磁盘。web 面板调用它 = 改的是**运行主进程
 *    那台机器**的 IDE 登录态,不是浏览器所在设备。这是照搬原则下的既有语义,不在本轮改动。
 *
 * 副作用顺序(不可重排):refresh → 解析 profileArn → 写盘 → 记状态 → 排续期。
 * 写盘之前不碰任何模块级状态,保证「写盘失败 ⇒ 状态不脏」。
 */
export async function switchAccountToIde(
  deps: SwitchAccountDeps,
  credentials: SwitchAccountCredentials
): Promise<SwitchAccountResult> {
  try {
    const {
      refreshToken,
      clientId,
      clientSecret,
      region = 'us-east-1',
      startUrl,
      authMethod = 'IdC',
      provider = 'BuilderId',
      profileArn,
      tokenEndpoint,
      issuerUrl,
      scopes,
      audience,
      accountId
    } = credentials
    let finalAccessToken = credentials.accessToken
    let finalRefreshToken = refreshToken
    let finalExpiresIn = 3600

    // 切号前先 refresh,确保磁盘里写的是最新 access + 最新 refresh(rotating)
    if (refreshToken) {
      console.log(`[Switch Account] Refreshing token before switch (authMethod: ${authMethod})...`)
      const refreshResult = await deps.refreshTokenByMethod(
        refreshToken,
        clientId,
        clientSecret,
        region,
        authMethod,
        undefined,
        { tokenEndpoint, scopes }
      )
      if (refreshResult.success && refreshResult.accessToken) {
        finalAccessToken = refreshResult.accessToken
        // bug A 修复:OIDC 返回新 refreshToken 时必须替换;否则下次 IDE/反代 refresh 会撞已作废的 v1
        finalRefreshToken = refreshResult.refreshToken || refreshToken
        finalExpiresIn = refreshResult.expiresIn ?? 3600
        console.log('[Switch Account] Token refreshed successfully (rotated refreshToken updated)')
      } else {
        // bug D 修复:refresh 失败不写文件 + 直接报错,避免给 IDE 留下"半坏"token
        const errMsg = refreshResult.error || 'Unknown refresh error'
        console.warn(`[Switch Account] Token refresh failed, aborting switch: ${errMsg}`)
        return {
          success: false,
          error: `刷新 Token 失败，未写入 Kiro IDE 磁盘文件，避免下次自动刷新失败导致 IDE 强制登出。原因：${errMsg}`
        }
      }
    }

    // profileArn 决策统一由 helper:Enterprise 用区域化备用 ARN,BuilderId 用占位符
    const resolvedProfileArn = deps.resolveProfileArnForWrite({
      profileArn,
      authMethod,
      provider,
      region
    })

    // bug C 修复:用真实 expiresIn 算 expiresAt
    const expiresAtIso = new Date(Date.now() + finalExpiresIn * 1000).toISOString()

    const { tokenPath, clientRegPath } = await deps.writeKiroAuthTokenFile({
      accessToken: finalAccessToken,
      refreshToken: finalRefreshToken,
      expiresAtIso,
      authMethod: authMethod === 'api_key' ? 'IdC' : authMethod,
      provider,
      region,
      startUrl,
      clientId,
      clientSecret,
      profileArn: resolvedProfileArn,
      tokenEndpoint,
      issuerUrl,
      scopes,
      audience
    })
    console.log('[Switch Account] Token written to:', tokenPath)
    if (clientRegPath) {
      console.log('[Switch Account] Client registration written to:', clientRegPath)
    }

    // 记录 lastSwitchedAccountId(供 watcher 反向同步时识别 IDE 当前账号)
    if (accountId) {
      deps.setLastSwitchedAccountId(accountId)
      // 同步记录 access/refresh 的"信任源头",避免 watcher 把刚写的同一份数据再回写一次
      deps.setLastWrittenTokenSignature(`${finalAccessToken}|${finalRefreshToken}`)
      // 如启用了主动续期,立刻 schedule 下一次(基于刚写入的 expiresAt)
      if (deps.isProactiveRenewalEnabled()) {
        deps.scheduleProactiveRenewal(accountId, Date.now() + finalExpiresIn * 1000)
      }
    }

    return {
      success: true,
      // bug F 支持:回传 refresh 后的最新 credentials 让 renderer 更新 store
      refreshedCredentials: {
        accessToken: finalAccessToken,
        refreshToken: finalRefreshToken,
        expiresIn: finalExpiresIn
      }
    }
  } catch (error) {
    console.error('[Switch Account] Error:', error)
    return { success: false, error: error instanceof Error ? error.message : '切换失败' }
  }
}

export interface LogoutAccountDeps {
  /** `index.ts:2002 clearProactiveRenewal` */
  clearProactiveRenewal: (reason?: string) => void
  setLastSwitchedAccountId: (id: string | null) => void
  setLastWrittenTokenSignature: (signature: string | null) => void
  /**
   * 列出 SSO 缓存里待删除的条目,返回**完整路径**;目录不存在时返回空数组(宿主机能力)。
   * 返回完整路径而非文件名,是为了让失败日志与原实现逐字一致(原实现 warn 的是 filePath)。
   */
  listSsoCacheFiles: () => Promise<string[]>
  /** 删除给定完整路径的文件(宿主机能力) */
  deleteSsoCacheFile: (filePath: string) => Promise<void>
}

export interface LogoutAccountResult {
  success: boolean
  deletedCount?: number
  error?: string
}

/**
 * 退出登录 —— 清空本机 `~/.aws/sso/cache`。
 *
 * ⚠️ 宿主机能力:删的是运行主进程那台机器的 SSO 缓存。
 *
 * 顺序要求:**先**停主动续期 timer 与清"IDE 当前账号"记忆,**再**动磁盘。反了的话,
 * 续期定时器可能在删文件的间隙里把凭证重新写回去,用户看到"退出了又没退出"。
 * 状态清除在 try 之外,保证磁盘操作失败时状态依然已清干净(与原实现一致)。
 */
export async function logoutAccount(deps: LogoutAccountDeps): Promise<LogoutAccountResult> {
  // 立刻清掉主动续期 timer 和"激活账号"记忆,避免 watcher / timer 误同步
  deps.clearProactiveRenewal('logout-account')
  deps.setLastSwitchedAccountId(null)
  deps.setLastWrittenTokenSignature(null)

  try {
    const files = await deps.listSsoCacheFiles()

    for (const filePath of files) {
      // 单个文件删不掉(被 IDE 占用等)不阻断其余文件 —— 与原实现的 .catch 逐个兜底一致。
      // 不静默:失败原因打日志,便于「退出后 IDE 仍登录」时定位。
      await deps.deleteSsoCacheFile(filePath).catch((e) => {
        console.warn('[Logout] Failed to delete file:', filePath, e)
      })
    }

    console.log('[Logout] SSO cache cleared, deleted', files.length, 'files')
    return { success: true, deletedCount: files.length }
  } catch (error) {
    console.error('[Logout] Error:', error)
    return { success: false, error: error instanceof Error ? error.message : '退出失败' }
  }
}
