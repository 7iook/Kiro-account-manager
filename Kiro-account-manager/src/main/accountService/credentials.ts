/**
 * 本机 Kiro 凭证读取 · IPC 与 HTTP 面板共用
 *
 * 抽取来源：index.ts:5365 (get-local-active-account) · :5395 (load-kiro-credentials)
 *
 * 磁盘副作用（读文件 / 列目录 / homedir）通过 CredentialFsDeps 注入：
 *   - 生产装配传 fs/promises + os.homedir（index.ts 侧）
 *   - 测试传内存假文件系统，无需碰真实 ~/.aws
 * 原 handler 用 `await import('os'|'path'|'crypto'|'fs/promises')` 动态导入，
 * 这里改成静态 import node 内置模块（node: 前缀）+ 注入 IO —— 行为不变，可测性提升。
 */
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** 凭证读取所需的磁盘副作用注入点 */
export type CredentialFsDeps = {
  /** 用户主目录（生产 = os.homedir()） */
  homedir: () => string
  /** 读文本文件；不存在 / 无权限时抛 */
  readTextFile: (path: string) => Promise<string>
  /** 列目录下的文件名；失败时抛 */
  readDir: (path: string) => Promise<string[]>
}

export type LocalActiveAccountResult =
  | {
      success: true
      data: {
        refreshToken: string
        accessToken?: string
        authMethod?: string
        provider?: string
      }
    }
  | { success: false; error: string }

/** ~/.aws/sso/cache 目录 */
function ssoCacheDir(deps: CredentialFsDeps): string {
  return join(deps.homedir(), '.aws', 'sso', 'cache')
}

const TOKEN_FILE_NAME = 'kiro-auth-token.json'

/**
 * 读取本机 SSO 缓存中当前使用的账号（Kiro IDE 的登录态）。
 *
 * 任何读取 / 解析失败都归一到 '无法读取本地 SSO 缓存'（保留原 handler 的 catch{} 语义：
 * 这是**预期失败**——用户可能从未登录过 —— 用返回值而非异常表达，且不需要区分原因）。
 */
export async function getLocalActiveAccount(
  deps: CredentialFsDeps
): Promise<LocalActiveAccountResult> {
  try {
    const tokenPath = join(ssoCacheDir(deps), TOKEN_FILE_NAME)
    const tokenContent = await deps.readTextFile(tokenPath)
    const tokenData = JSON.parse(tokenContent)

    if (!tokenData.refreshToken) {
      return { success: false, error: '本地缓存中没有 refreshToken' }
    }

    return {
      success: true,
      data: {
        refreshToken: tokenData.refreshToken,
        accessToken: tokenData.accessToken,
        authMethod: tokenData.authMethod,
        provider: tokenData.provider
      }
    }
  } catch {
    return { success: false, error: '无法读取本地 SSO 缓存' }
  }
}

type KiroTokenFile = {
  accessToken?: string
  refreshToken?: string
  clientIdHash?: string
  region?: string
  authMethod?: string
  provider?: string
  profileArn?: string
  tokenEndpoint?: string
  issuerUrl?: string
  scopes?: string
}

type ClientRegistration = {
  clientId?: string
  clientSecret?: string
}

export type LoadKiroCredentialsResult =
  | {
      success: true
      data: {
        accessToken: string
        refreshToken: string
        clientId: string
        clientSecret: string
        region: string
        authMethod: string
        provider: string
        tokenEndpoint?: string
        issuerUrl?: string
        scopes?: string
        profileArn?: string
      }
    }
  | { success: false; error: string }

/**
 * 从 Kiro 本地配置（~/.aws/sso/cache）导入完整凭证。
 *
 * 客户端注册文件的三级查找顺序（原 handler 行为，逐字保留）：
 *   1. token 文件里的 clientIdHash → `<hash>.json`
 *   2. 没有 hash → 按标准 startUrl 算 sha1 → `<hash>.json`
 *   3. 都读不到 → 扫描缓存目录，取第一份同时含 clientId 与 clientSecret 的 .json
 *      （**必须排除 kiro-auth-token.json 自身**，否则会把 token 文件误当注册文件）
 * 社交登录 / external_idp 不需要 clientId/clientSecret，缺失也算成功。
 */
export async function loadKiroCredentials(
  deps: CredentialFsDeps
): Promise<LoadKiroCredentialsResult> {
  try {
    const ssoCache = ssoCacheDir(deps)
    const tokenPath = join(ssoCache, TOKEN_FILE_NAME)
    console.log('[Kiro Credentials] Reading token from:', tokenPath)

    let tokenData: KiroTokenFile
    try {
      tokenData = JSON.parse(await deps.readTextFile(tokenPath))
    } catch {
      // 预期失败：用户还没在 Kiro IDE 登录过 → 用返回值表达，不抛
      return { success: false, error: '找不到 kiro-auth-token.json 文件，请先在 Kiro IDE 中登录' }
    }

    if (!tokenData.refreshToken) {
      return { success: false, error: 'kiro-auth-token.json 中缺少 refreshToken' }
    }

    // 确定 clientIdHash：优先使用文件中的，否则按标准 startUrl 计算（与 Kiro 客户端一致）
    let clientIdHash = tokenData.clientIdHash
    if (!clientIdHash) {
      const startUrl = 'https://view.awsapps.com/start'
      clientIdHash = createHash('sha1').update(JSON.stringify({ startUrl })).digest('hex')
      console.log('[Kiro Credentials] Calculated clientIdHash:', clientIdHash)
    }

    const clientRegPath = join(ssoCache, `${clientIdHash}.json`)
    console.log('[Kiro Credentials] Trying client registration from:', clientRegPath)

    let clientData: ClientRegistration | null = null
    try {
      clientData = JSON.parse(await deps.readTextFile(clientRegPath))
    } catch {
      // 找不到 → 扫描目录里其他 .json（排除 token 文件自身）
      console.log('[Kiro Credentials] Client file not found, searching cache directory...')
      try {
        const files = await deps.readDir(ssoCache)
        for (const file of files) {
          if (file.endsWith('.json') && file !== TOKEN_FILE_NAME) {
            try {
              const data = JSON.parse(await deps.readTextFile(join(ssoCache, file)))
              if (data.clientId && data.clientSecret) {
                clientData = data
                console.log('[Kiro Credentials] Found client registration in:', file)
                break
              }
            } catch {
              // 忽略无法解析的文件（缓存目录里常有其它工具写的 json）
            }
          }
        }
      } catch {
        // 忽略目录读取错误（无权限等）；下面统一走"找不到注册文件"分支
      }
    }

    // 社交登录 / external_idp 不需要 clientId/clientSecret
    const isSocialAuth = tokenData.authMethod === 'social'
    const isExternalIdp =
      tokenData.authMethod === 'external_idp' || tokenData.provider === 'ExternalIdp'

    if (
      !isSocialAuth &&
      !isExternalIdp &&
      (!clientData || !clientData.clientId || !clientData.clientSecret)
    ) {
      return { success: false, error: '找不到客户端注册文件，请确保已在 Kiro IDE 中完成登录' }
    }

    console.log(
      `[Kiro Credentials] Successfully loaded credentials (authMethod: ${tokenData.authMethod || 'IdC'})`
    )

    return {
      success: true,
      data: {
        accessToken: tokenData.accessToken || '',
        refreshToken: tokenData.refreshToken,
        clientId: clientData?.clientId || '',
        clientSecret: clientData?.clientSecret || '',
        region: tokenData.region || 'us-east-1',
        authMethod: tokenData.authMethod || 'IdC',
        provider: tokenData.provider || 'BuilderId',
        tokenEndpoint: tokenData.tokenEndpoint,
        issuerUrl: tokenData.issuerUrl,
        scopes: tokenData.scopes,
        profileArn: tokenData.profileArn
      }
    }
  } catch (error) {
    console.error('[Kiro Credentials] Error:', error)
    return { success: false, error: error instanceof Error ? error.message : '未知错误' }
  }
}
