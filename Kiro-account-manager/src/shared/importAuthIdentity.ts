/**
 * 导入 / 用量路径的身份归一化 SSOT。
 *
 * 字段优先级见 RCA
 * `.agent-workspace/.archive/2026-08-23/builderid-placeholder-arn/builderid-placeholder-arn-rca.md`
 * —— 先匹配先赢，禁止再叠「social 401 后改走 OIDC」第二套真源。
 */

export type ImportAuthIdentity = 'api_key' | 'external_idp' | 'enterprise' | 'social' | 'builder_id'
export type ImportAuthMethod = 'api_key' | 'external_idp' | 'social' | 'IdC'

export interface ImportAuthInput {
  authMethod?: string | null
  provider?: string | null
  clientId?: string | null
  clientSecret?: string | null
}

function present(value?: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function normalizeImportAuth(input: ImportAuthInput): {
  identity: ImportAuthIdentity
  authMethod: ImportAuthMethod
} {
  const authMethod = (input.authMethod || '').trim()
  const provider = (input.provider || '').trim()
  const hasOidcPair = present(input.clientId) && present(input.clientSecret)

  if (authMethod === 'api_key' || provider === 'ApiKey') {
    return { identity: 'api_key', authMethod: 'api_key' }
  }
  if (
    authMethod === 'external_idp' ||
    provider === 'AzureAD' ||
    provider === 'ExternalIdp'
  ) {
    return { identity: 'external_idp', authMethod: 'external_idp' }
  }
  if (provider === 'Enterprise') {
    return { identity: 'enterprise', authMethod: 'IdC' }
  }
  if (provider === 'Github' || provider === 'Google') {
    return { identity: 'social', authMethod: 'social' }
  }
  if (hasOidcPair) {
    return { identity: 'builder_id', authMethod: 'IdC' }
  }
  if (authMethod === 'social') {
    return { identity: 'social', authMethod: 'social' }
  }
  return { identity: 'builder_id', authMethod: 'IdC' }
}
