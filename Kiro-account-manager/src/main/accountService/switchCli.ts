/**
 * accountService/switchCli.ts · 切号到 Kiro CLI(写本机 SQLite)的可复用业务实现
 *
 * 从 `index.ts` 的 `switch-account-cli` handler 抽出。抽离契约同 switch.ts:
 * 不依赖 preload / 不接受 IpcMainInvokeEvent / 不引用 index.ts 模块级 let / 不 import electron。
 *
 * ⚠️ 宿主机能力:写的是运行主进程那台机器的
 *    `%LOCALAPPDATA%\kiro-cli\data.sqlite3`(Windows)或 `~/.local/share/kiro-cli/data.sqlite3`。
 *    web 面板调用它 = 改主机的 CLI 登录态,不是浏览器所在设备。既有语义,本轮不改。
 *
 * ⚠️ 与 IDE 切号(switch.ts)的一处**有意**差异,不要"顺手统一":
 *    IDE 切号 refresh 失败会**拒绝写盘**(bug D);CLI 切号 refresh 失败**仍用旧 token 继续写**
 *    (原实现 `console.warn(...using existing token)`)。行为差异保持原样 —— 照搬原则下
 *    现有语义即正确语义,统一它属于改变行为,不在本轮范围。
 *
 * ⚠️ SQL 语句用字符串拼接 + `''` 转义单引号,是原实现的既有做法(写的是本机私有 DB、
 *    值来自本机凭证)。抽离时逐字保留,不改写为参数化 —— 改写会变更 SQL 文本,
 *    与「行为逐字节一致」的验收冲突。已登记为技术债,由后续独立轮次处理。
 */

/** 与 `index.ts:251 OidcRefreshResult` 结构一致 */
export interface CliRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

/** 入参 —— 与原 `switch-account-cli` IPC 的 credentials 参数逐字段一致 */
export interface SwitchAccountCliCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  profileArn?: string
  provider?: string
  scopes?: string[]
  tokenEndpoint?: string
  issuerUrl?: string
  audience?: string
}

export interface SwitchAccountCliResult {
  success: boolean
  dbPath?: string
  error?: string
}

export interface SwitchAccountCliDeps {
  refreshTokenByMethod: (
    token: string,
    clientId: string,
    clientSecret: string,
    region: string,
    authMethod?: string,
    proxyUrl?: string,
    externalIdp?: { tokenEndpoint?: string; scopes?: string }
  ) => Promise<CliRefreshResult>
  /** `kiroAuthSync.ts:84 resolveProfileArnForWrite` */
  resolveProfileArnForWrite: (input: {
    profileArn?: string
    authMethod?: string
    provider?: string
    region?: string
  }) => string | undefined
  /** 解析 kiro-cli 数据目录并确保存在,返回 data.sqlite3 的完整路径(宿主机能力) */
  resolveCliDbPath: () => Promise<string>
  /**
   * 对 kiro-cli SQLite 执行一批语句(宿主机能力)。
   * 实现方负责 sqlite3 命令行 → Node 内置 SQLite 的降级链。
   */
  execSqlite: (dbPath: string, statements: string[]) => Promise<void>
}

/** kiro-cli 里 state 表存 profileArn 的键名 */
const STATE_PROFILE_KEY = 'api.codewhisperer.profile'

/**
 * 切换账号到 Kiro CLI —— 写凭证进本机 SQLite 的 auth_kv / state 表。
 *
 * 副作用顺序(不可重排):refresh → 解析 dbPath → 构建 SQL → 执行。
 */
export async function switchAccountToCli(
  deps: SwitchAccountCliDeps,
  credentials: SwitchAccountCliCredentials
): Promise<SwitchAccountCliResult> {
  try {
    const {
      refreshToken,
      clientId,
      clientSecret,
      region = 'us-east-1',
      profileArn,
      provider,
      scopes,
      tokenEndpoint,
      issuerUrl,
      audience
    } = credentials
    let { accessToken } = credentials

    // external_idp (Azure AD) 判定:切 CLI 全程复用
    const isExternalIdp = provider === 'AzureAD' || provider === 'ExternalIdp'

    // 切号前先刷新 token(和 IDE 切号一致)
    let finalRefreshToken = refreshToken
    let finalExpiresIn = 3600
    if (refreshToken) {
      const authMethod =
        provider === 'Google' || provider === 'Github'
          ? 'social'
          : isExternalIdp
            ? 'external_idp'
            : undefined
      console.log(`[Switch CLI] Refreshing token before switch (provider: ${provider})...`)
      const refreshResult = await deps.refreshTokenByMethod(
        refreshToken,
        clientId || '',
        clientSecret || '',
        region,
        authMethod,
        undefined,
        { tokenEndpoint, scopes: scopes?.join(' ') }
      )
      if (refreshResult.success && refreshResult.accessToken) {
        accessToken = refreshResult.accessToken
        // 微软 external_idp 刷新会轮换 refreshToken,必须写回轮换后的值,否则下次 CLI 自刷用作废 v1
        finalRefreshToken = refreshResult.refreshToken || refreshToken
        finalExpiresIn = refreshResult.expiresIn ?? 3600
        console.log('[Switch CLI] Token refreshed successfully')
      } else {
        console.warn(
          `[Switch CLI] Token refresh failed: ${refreshResult.error}, using existing token`
        )
      }
    }

    const dbPath = await deps.resolveCliDbPath()

    // 判断 token key:external_idp→external-idp:token,social→social:token,IdC→odic:token
    const isSocial = provider === 'Google' || provider === 'Github'
    const preferredTokenKey = isExternalIdp
      ? 'kirocli:external-idp:token'
      : isSocial
        ? 'kirocli:social:token'
        : 'kirocli:odic:token'
    const preferredRegKey = 'kirocli:odic:device-registration'

    // profileArn 决策统一由 helper:BuilderId 不带 profileArn
    // kiro-cli 同样不应该在 SQLite 里塞占位符 ARN(实测会触发 REST 端点 403)
    const resolvedProfileArn = deps.resolveProfileArnForWrite({
      profileArn,
      authMethod: isExternalIdp ? 'external_idp' : isSocial ? 'social' : 'IdC',
      provider,
      region
    })

    // 构建 token JSON(snake_case 字段名,与 kiro-cli Rust 结构一致)
    const expiresAt = new Date(Date.now() + finalExpiresIn * 1000).toISOString()
    const tokenData: Record<string, unknown> = {
      access_token: accessToken,
      refresh_token: finalRefreshToken,
      expires_at: expiresAt,
      region
    }
    // profileArn 仅在解析出有效值时附加,BuilderId 等不带(避免 kiro-cli 拿占位符 ARN 调 REST 触发 403)
    if (resolvedProfileArn) {
      tokenData.profile_arn = resolvedProfileArn
    }
    if (scopes) tokenData.scopes = scopes
    // external_idp: 补齐 kiro-cli 二进制声明的微软元数据字段(参考 kiro-switch cli_writer.py inject_external_idp)
    if (isExternalIdp) {
      tokenData.auth_method = 'external_idp'
      tokenData.provider = 'ExternalIdp'
      if (tokenEndpoint) tokenData.token_endpoint = tokenEndpoint
      if (issuerUrl) {
        tokenData.issuer = issuerUrl
        tokenData.issuer_url = issuerUrl
      }
      if (clientId) tokenData.client_id = clientId
      if (audience) tokenData.audience = audience
    }

    // 构建 SQL 语句
    const sqlStatements: string[] = [
      'CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);',
      'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);',
      `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredTokenKey}', '${JSON.stringify(tokenData).replace(/'/g, "''")}');`
    ]

    // state 表 api.codewhisperer.profile:external_idp / social 必须写,否则 kiro-cli 报
    // "profileArn is required for this request"(实测,见 kiro-switch cli_writer.py inject_external_idp/inject_social)。
    // ★ 严格只含 arn + profile_name 两键——多写 profileName/profile_arn 会让 kiro-cli 的 serde 判 profileArn 无效。
    // IdC/BuilderId 不写(走 device-registration 路径,占位符 ARN 反而触发 REST 403);无 ARN 时清掉残留。
    if ((isExternalIdp || isSocial) && resolvedProfileArn) {
      const profileName = isExternalIdp ? 'ExternalIdp_Default_Profile' : 'Social_Default_Profile'
      const profileObj = { arn: resolvedProfileArn, profile_name: profileName }
      sqlStatements.push(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('${STATE_PROFILE_KEY}', '${JSON.stringify(profileObj).replace(/'/g, "''")}');`
      )
    } else if (!resolvedProfileArn) {
      // BuilderId 等无 ARN:清掉可能残留的上一个账号 profile,避免 CLI 误用旧 ARN
      sqlStatements.push(`DELETE FROM state WHERE key = '${STATE_PROFILE_KEY}';`)
    }

    // 写入 device-registration(仅 IdC 登录;social/external_idp 不需要)
    if (clientId && clientSecret && !isSocial && !isExternalIdp) {
      const regData = { client_id: clientId, client_secret: clientSecret, region }
      sqlStatements.push(
        `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredRegKey}', '${JSON.stringify(regData).replace(/'/g, "''")}');`
      )
    }

    // 清除其他优先级的旧 key
    const cliTokenKeys = [
      'kirocli:social:token',
      'kirocli:odic:token',
      'kirocli:external-idp:token',
      'codewhisperer:odic:token'
    ]
    for (const key of cliTokenKeys) {
      if (key !== preferredTokenKey) {
        sqlStatements.push(`DELETE FROM auth_kv WHERE key = '${key}';`)
      }
    }

    await deps.execSqlite(dbPath, sqlStatements)

    console.log(`[Switch CLI] Token saved to SQLite key: ${preferredTokenKey}`)
    console.log(`[Switch CLI] Account switched successfully in ${dbPath}`)
    return { success: true, dbPath }
  } catch (error) {
    console.error('[Switch CLI] Error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'CLI 切换失败' }
  }
}
