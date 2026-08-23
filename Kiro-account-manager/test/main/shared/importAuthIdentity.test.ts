import { describe, expect, it } from 'vitest'
import { normalizeImportAuth } from '@shared/importAuthIdentity'

describe('normalizeImportAuth · 导入身份唯一契约', () => {
  it('file2 脏标签：BuilderId + social + OIDC 三件套 → builder_id / IdC', () => {
    expect(
      normalizeImportAuth({
        authMethod: 'social',
        provider: 'BuilderId',
        clientId: 'cid',
        clientSecret: 'csec'
      })
    ).toEqual({ identity: 'builder_id', authMethod: 'IdC' })
  })

  it('真 social：Google + 仅 refresh 形状 → social', () => {
    expect(
      normalizeImportAuth({
        authMethod: 'social',
        provider: 'Google',
        clientId: '',
        clientSecret: undefined
      })
    ).toEqual({ identity: 'social', authMethod: 'social' })
  })

  it('Google provider 先于三件套：即使误带 client 仍 social', () => {
    expect(
      normalizeImportAuth({
        authMethod: 'IdC',
        provider: 'Google',
        clientId: 'cid',
        clientSecret: 'csec'
      })
    ).toEqual({ identity: 'social', authMethod: 'social' })
  })

  it('file1：IdC + BuilderId + 三件套 → builder_id', () => {
    expect(
      normalizeImportAuth({
        authMethod: 'IdC',
        provider: 'BuilderId',
        clientId: 'cid',
        clientSecret: 'csec'
      })
    ).toEqual({ identity: 'builder_id', authMethod: 'IdC' })
  })

  it('api_key / Enterprise / external_idp 各走自己的格', () => {
    expect(normalizeImportAuth({ authMethod: 'api_key', provider: 'ApiKey' })).toEqual({
      identity: 'api_key',
      authMethod: 'api_key'
    })
    expect(normalizeImportAuth({ provider: 'Enterprise', clientId: 'a', clientSecret: 'b' })).toEqual({
      identity: 'enterprise',
      authMethod: 'IdC'
    })
    expect(normalizeImportAuth({ authMethod: 'external_idp', provider: 'AzureAD' })).toEqual({
      identity: 'external_idp',
      authMethod: 'external_idp'
    })
  })

  it('无三件套的 social 标签 → social（不二次改道）', () => {
    expect(normalizeImportAuth({ authMethod: 'social', provider: 'BuilderId' })).toEqual({
      identity: 'social',
      authMethod: 'social'
    })
  })
})
