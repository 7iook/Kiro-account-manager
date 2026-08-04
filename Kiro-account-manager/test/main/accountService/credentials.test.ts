/**
 * 本机 Kiro 凭证读取（get-local-active-account / load-kiro-credentials）
 *
 * 抽取来源：index.ts:5365 · :5395
 *
 * 这两个函数做真实磁盘 IO（~/.aws/sso/cache）。为了可测 + 让 HTTP 面板复用，
 * 把「读文件 / 列目录 / homedir」三个副作用做成注入点（CredentialFsDeps），
 * 生产装配传 fs/promises + os.homedir，测试传内存假文件系统。
 * 注意 mock 打在**被调用代码真正使用的注入点**，不是高层 handler。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  getLocalActiveAccount,
  loadKiroCredentials,
  type CredentialFsDeps
} from '../../../src/main/accountService/credentials'

/** 内存假文件系统；键 = 归一化后的相对路径片段拼接 */
function makeFs(files: Record<string, string>, homedir = '/home/u'): CredentialFsDeps {
  return {
    homedir: () => homedir,
    readTextFile: async (p: string) => {
      const key = p.replace(/\\/g, '/')
      if (!(key in files)) throw new Error(`ENOENT: ${key}`)
      return files[key]
    },
    readDir: async (p: string) => {
      const prefix = p.replace(/\\/g, '/') + '/'
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    }
  }
}

const CACHE = '/home/u/.aws/sso/cache'
const TOKEN = `${CACHE}/kiro-auth-token.json`

describe('getLocalActiveAccount · 读本机当前登录账号', () => {
  it('Kiro IDE 已登录时返回本机缓存中的凭证，供"导入当前账号"使用', async () => {
    const fs = makeFs({
      [TOKEN]: JSON.stringify({
        refreshToken: 'rt-1',
        accessToken: 'at-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })
    })
    const r = await getLocalActiveAccount(fs)
    expect(r).toEqual({
      success: true,
      data: { refreshToken: 'rt-1', accessToken: 'at-1', authMethod: 'IdC', provider: 'BuilderId' }
    })
  })

  it('缓存里缺 refreshToken 时明确报"没有 refreshToken"，而不是返回半份凭证', async () => {
    const fs = makeFs({ [TOKEN]: JSON.stringify({ accessToken: 'at-1' }) })
    expect(await getLocalActiveAccount(fs)).toEqual({
      success: false,
      error: '本地缓存中没有 refreshToken'
    })
  })

  it('用户从未在 Kiro IDE 登录过（文件不存在）时给出可读提示', async () => {
    expect(await getLocalActiveAccount(makeFs({}))).toEqual({
      success: false,
      error: '无法读取本地 SSO 缓存'
    })
  })

  it('缓存文件被写坏（非法 JSON）时不抛异常，走同一条读取失败提示', async () => {
    expect(await getLocalActiveAccount(makeFs({ [TOKEN]: '{not json' }))).toEqual({
      success: false,
      error: '无法读取本地 SSO 缓存'
    })
  })
})

describe('loadKiroCredentials · 从 Kiro 本地配置导入凭证', () => {
  it('IdC 登录：token 文件带 clientIdHash 时直接读对应的客户端注册文件', async () => {
    const fs = makeFs({
      [TOKEN]: JSON.stringify({
        refreshToken: 'rt',
        accessToken: 'at',
        clientIdHash: 'abc123',
        region: 'eu-central-1',
        authMethod: 'IdC',
        provider: 'BuilderId',
        profileArn: 'arn:x'
      }),
      [`${CACHE}/abc123.json`]: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' })
    })
    const r = await loadKiroCredentials(fs)
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({
      refreshToken: 'rt',
      accessToken: 'at',
      clientId: 'cid',
      clientSecret: 'csec',
      region: 'eu-central-1',
      authMethod: 'IdC',
      provider: 'BuilderId',
      profileArn: 'arn:x'
    })
  })

  it('token 文件没有 clientIdHash 时按标准 startUrl 算出 hash 去找注册文件', async () => {
    // sha1(JSON.stringify({startUrl:'https://view.awsapps.com/start'}))
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha1')
      .update(JSON.stringify({ startUrl: 'https://view.awsapps.com/start' }))
      .digest('hex')
    const fs = makeFs({
      [TOKEN]: JSON.stringify({ refreshToken: 'rt' }),
      [`${CACHE}/${hash}.json`]: JSON.stringify({ clientId: 'cid2', clientSecret: 'csec2' })
    })
    const r = await loadKiroCredentials(fs)
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ clientId: 'cid2', clientSecret: 'csec2' })
  })

  it('算出的 hash 对不上时扫描缓存目录找任意一份含 clientId+clientSecret 的注册文件', async () => {
    const fs = makeFs({
      [TOKEN]: JSON.stringify({ refreshToken: 'rt', clientIdHash: 'missing-hash' }),
      [`${CACHE}/junk.json`]: '{broken',
      [`${CACHE}/no-secret.json`]: JSON.stringify({ clientId: 'only-id' }),
      [`${CACHE}/real.json`]: JSON.stringify({ clientId: 'cid3', clientSecret: 'csec3' })
    })
    const r = await loadKiroCredentials(fs)
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ clientId: 'cid3', clientSecret: 'csec3' })
  })

  it('扫描时绝不把 kiro-auth-token.json 自己当成客户端注册文件', async () => {
    const fs = makeFs({
      // token 文件里"恰好"也有 clientId/clientSecret —— 不能被误取
      [TOKEN]: JSON.stringify({ refreshToken: 'rt', clientIdHash: 'nope', clientId: 'WRONG', clientSecret: 'WRONG' })
    })
    const r = await loadKiroCredentials(fs)
    expect(r.success).toBe(false)
    expect(r.error).toContain('找不到客户端注册文件')
  })

  it('社交登录账号没有 clientId/clientSecret 也应导入成功（社交无此概念）', async () => {
    const fs = makeFs({
      [TOKEN]: JSON.stringify({ refreshToken: 'rt', authMethod: 'social', provider: 'Google' })
    })
    const r = await loadKiroCredentials(fs)
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ clientId: '', clientSecret: '', authMethod: 'social', provider: 'Google' })
  })

  it('external_idp（Azure AD）账号同样不要求 clientSecret', async () => {
    const byAuthMethod = await loadKiroCredentials(
      makeFs({ [TOKEN]: JSON.stringify({ refreshToken: 'rt', authMethod: 'external_idp' }) })
    )
    expect(byAuthMethod.success).toBe(true)

    const byProvider = await loadKiroCredentials(
      makeFs({ [TOKEN]: JSON.stringify({ refreshToken: 'rt', provider: 'ExternalIdp' }) })
    )
    expect(byProvider.success).toBe(true)
  })

  it('IdC 账号缺客户端注册文件时拒绝导入（半份凭证刷不了 token）', async () => {
    const fs = makeFs({ [TOKEN]: JSON.stringify({ refreshToken: 'rt', clientIdHash: 'x' }) })
    const r = await loadKiroCredentials(fs)
    expect(r).toMatchObject({ success: false })
    expect(r.error).toContain('找不到客户端注册文件')
  })

  it('用户还没在 Kiro IDE 登录过时给出"请先登录"提示', async () => {
    const r = await loadKiroCredentials(makeFs({}))
    expect(r.success).toBe(false)
    expect(r.error).toContain('找不到 kiro-auth-token.json')
  })

  it('token 文件里缺 refreshToken 时明确指出缺哪个字段', async () => {
    const r = await loadKiroCredentials(makeFs({ [TOKEN]: JSON.stringify({ accessToken: 'at' }) }))
    expect(r).toEqual({ success: false, error: 'kiro-auth-token.json 中缺少 refreshToken' })
  })

  it('缺省 region / authMethod / provider 时回退到既有默认值', async () => {
    const fs = makeFs({
      [TOKEN]: JSON.stringify({ refreshToken: 'rt', clientIdHash: 'h' }),
      [`${CACHE}/h.json`]: JSON.stringify({ clientId: 'c', clientSecret: 's' })
    })
    const r = await loadKiroCredentials(fs)
    expect(r.data).toMatchObject({ region: 'us-east-1', authMethod: 'IdC', provider: 'BuilderId', accessToken: '' })
  })

  it('列目录本身失败时不抛异常，仍走"找不到注册文件"的既有提示', async () => {
    const fs = makeFs({ [TOKEN]: JSON.stringify({ refreshToken: 'rt', clientIdHash: 'x' }) })
    fs.readDir = vi.fn().mockRejectedValue(new Error('EACCES'))
    const r = await loadKiroCredentials(fs)
    expect(r.success).toBe(false)
    expect(r.error).toContain('找不到客户端注册文件')
  })
})
