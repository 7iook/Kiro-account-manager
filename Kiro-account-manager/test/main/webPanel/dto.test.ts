/**
 * webPanel DTO 白名单投影 · TDD Red
 *
 * 决策卡 §3「输出脱敏与照搬豁免」：列表 DTO 只含桌面端界面上**已经显示**的信息，
 * 凭据侧只给 `expiresAt` + 存在性布尔。
 *
 * 关键约束（recon §3.4 证据一）：`accountService/accounts.ts:20 loadAccounts()`
 * 返回 `Promise<unknown>` —— 投影的输入**真的是未知形状**，
 * 第一步必须做运行时形状校验，不能靠 TS 断言硬转。
 */
import { describe, it, expect } from 'vitest'
import { toAccountListItem, projectAccountsBlob } from '../../../src/main/webPanel/dto'

/** 一个结构完整的真实账号形状（含全部凭据字段，模拟盘上 blob） */
function fullAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    nickname: '主号',
    idp: 'Google',
    userId: 'uid-123',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC',
    machineId: 'a'.repeat(64),
    status: 'active',
    lastError: undefined,
    isActive: true,
    groupId: 'g-1',
    tags: ['t-1', 't-2'],
    weight: 100,
    createdAt: 1700000000000,
    lastUsedAt: 1700000001000,
    subscription: { type: 'Pro', title: 'KIRO PRO', daysRemaining: 12, rawType: 'RAW_PRO' },
    usage: {
      current: 40,
      limit: 100,
      percentUsed: 0.4,
      lastUpdated: 1700000002000,
      baseLimit: 90,
      baseCurrent: 30,
      freeTrialLimit: 10,
      freeTrialCurrent: 10,
      freeTrialExpiry: '2026-09-01',
      bonuses: [{ code: 'B1', name: 'bonus', current: 1, limit: 5 }],
      nextResetDate: '2026-09-01'
    },
    credentials: {
      accessToken: 'AT-PLAINTEXT-SECRET',
      csrfToken: 'CSRF-PLAINTEXT-SECRET',
      refreshToken: 'RT-PLAINTEXT-SECRET',
      clientId: 'CID-PLAINTEXT',
      clientSecret: 'CS-PLAINTEXT-SECRET',
      region: 'us-east-1',
      expiresAt: 1800000000000,
      authMethod: 'IdC',
      provider: 'Google',
      tokenFingerprint: 'fp-abc'
    },
    ...overrides
  }
}

const CREDENTIAL_NEEDLES = [
  'AT-PLAINTEXT-SECRET',
  'CSRF-PLAINTEXT-SECRET',
  'RT-PLAINTEXT-SECRET',
  'CS-PLAINTEXT-SECRET'
]

describe('toAccountListItem：白名单投影只给桌面端已显示的字段', () => {
  it('保留桌面端两组件共同消费的展示字段', () => {
    const dto = toAccountListItem(fullAccount()) as Record<string, unknown>
    expect(dto.id).toBe('acc-1')
    expect(dto.email).toBe('user@example.com')
    expect(dto.nickname).toBe('主号')
    expect(dto.idp).toBe('Google')
    expect(dto.userId).toBe('uid-123')
    expect(dto.status).toBe('active')
    expect(dto.isActive).toBe(true)
    expect(dto.groupId).toBe('g-1')
    expect(dto.tags).toEqual(['t-1', 't-2'])
    expect(dto.subscription).toEqual({ type: 'Pro', title: 'KIRO PRO', daysRemaining: 12 })
    expect((dto.usage as Record<string, unknown>).current).toBe(40)
    expect((dto.usage as Record<string, unknown>).percentUsed).toBe(0.4)
  })

  it('凭据侧只给 expiresAt 时间戳，不给任何 token', () => {
    const dto = toAccountListItem(fullAccount()) as Record<string, unknown>
    expect(dto.expiresAt).toBe(1800000000000)
    expect(dto).not.toHaveProperty('credentials')
    expect(dto).not.toHaveProperty('accessToken')
    expect(dto).not.toHaveProperty('refreshToken')
    expect(dto).not.toHaveProperty('clientSecret')
    expect(dto).not.toHaveProperty('csrfToken')
  })

  it('把凭据判定的**结论**送出去，而不是原料（照搬桌面端 UI 行为）', () => {
    // 桌面端 AccountListRow.tsx:141 / AccountCard.tsx:216 的判定
    const dto = toAccountListItem(fullAccount()) as Record<string, unknown>
    expect(dto.hasRefreshToken).toBe(true)
    expect(dto.canRefreshViaOidc).toBe(true)
  })

  it('缺 refreshToken 时 hasRefreshToken=false（对齐"凭证不完整无法切换"分支）', () => {
    const a = fullAccount()
    const cred = { ...(a.credentials as Record<string, unknown>) }
    delete cred.refreshToken
    const dto = toAccountListItem({ ...a, credentials: cred }) as Record<string, unknown>
    expect(dto.hasRefreshToken).toBe(false)
  })

  it('social / external_idp 不需要 clientId+clientSecret，canRefreshViaOidc 仍为 true', () => {
    // 对齐 AccountListRow.tsx:145 —— authMethod 是 social/external_idp 时跳过 OIDC 字段检查
    const a = fullAccount()
    const cred = { ...(a.credentials as Record<string, unknown>), authMethod: 'social' }
    delete cred.clientId
    delete cred.clientSecret
    const dto = toAccountListItem({ ...a, credentials: cred }) as Record<string, unknown>
    expect(dto.canRefreshViaOidc).toBe(true)
  })

  it('IdC 账号缺 clientSecret 时 canRefreshViaOidc=false', () => {
    const a = fullAccount()
    const cred = { ...(a.credentials as Record<string, unknown>) }
    delete cred.clientSecret
    const dto = toAccountListItem({ ...a, credentials: cred }) as Record<string, unknown>
    expect(dto.canRefreshViaOidc).toBe(false)
  })

  it('序列化后的 DTO 里不含任何凭证明文（含嵌套层）', () => {
    const serialised = JSON.stringify(toAccountListItem(fullAccount()))
    for (const needle of CREDENTIAL_NEEDLES) {
      expect(serialised).not.toContain(needle)
    }
    expect(serialised).not.toContain('ksk_')
  })

  it('ksk_ 账号：API Key 存在于 accessToken 也不出现在 DTO 里', () => {
    const a = fullAccount()
    const dto = toAccountListItem({
      ...a,
      credentials: {
        ...(a.credentials as Record<string, unknown>),
        accessToken: 'ksk_ABCDEFGH1234567890abcdefghijkl',
        authMethod: 'api_key'
      }
    })
    expect(JSON.stringify(dto)).not.toContain('ksk_')
  })
})

describe('运行时形状校验：输入是 unknown，不能靠 TS 断言', () => {
  it('null / undefined 输入不抛，返回 null', () => {
    expect(toAccountListItem(null)).toBeNull()
    expect(toAccountListItem(undefined)).toBeNull()
  })

  it('原始类型输入不抛，返回 null', () => {
    expect(toAccountListItem('not-an-object')).toBeNull()
    expect(toAccountListItem(42)).toBeNull()
    expect(toAccountListItem(true)).toBeNull()
  })

  it('缺 id 的对象被判为非法账号，返回 null（不产出半个 DTO）', () => {
    const a = fullAccount()
    delete a.id
    expect(toAccountListItem(a)).toBeNull()
  })

  it('嵌套子结构缺失时不抛，降级为 undefined 而非崩溃', () => {
    const dto = toAccountListItem({ id: 'x', email: 'e@x.c' }) as Record<string, unknown>
    expect(dto).not.toBeNull()
    expect(dto.id).toBe('x')
    expect(dto.subscription).toBeUndefined()
    expect(dto.usage).toBeUndefined()
    expect(dto.expiresAt).toBeUndefined()
    expect(dto.hasRefreshToken).toBe(false)
  })

  it('子结构是错误类型（string 而非 object）时不当对象用', () => {
    const dto = toAccountListItem({
      id: 'x',
      subscription: 'Pro',
      usage: 42,
      credentials: 'token'
    }) as Record<string, unknown>
    expect(dto.subscription).toBeUndefined()
    expect(dto.usage).toBeUndefined()
    expect(dto.expiresAt).toBeUndefined()
    expect(dto.hasRefreshToken).toBe(false)
  })

  it('tags 不是数组时降级为空数组（不把 string 逐字符散出去）', () => {
    const dto = toAccountListItem({ id: 'x', tags: 'not-an-array' }) as Record<string, unknown>
    expect(dto.tags).toEqual([])
  })
})

describe('projectAccountsBlob：整表 blob → DTO 列表', () => {
  it('accounts 是 Record<id, Account> 时逐个投影', () => {
    const blob = {
      accounts: { 'acc-1': fullAccount(), 'acc-2': fullAccount({ id: 'acc-2' }) },
      groups: {},
      tags: {},
      revision: 7
    }
    const out = projectAccountsBlob(blob)
    expect(out.accounts).toHaveLength(2)
    expect(out.revision).toBe(7)
    const serialised = JSON.stringify(out)
    for (const needle of CREDENTIAL_NEEDLES) {
      expect(serialised).not.toContain(needle)
    }
  })

  it('accounts 是数组时也能投影（兼容两种容器形状）', () => {
    const out = projectAccountsBlob({ accounts: [fullAccount()] })
    expect(out.accounts).toHaveLength(1)
    expect((out.accounts[0] as Record<string, unknown>).id).toBe('acc-1')
  })

  it('loadAccounts 返回 null（读盘失败/无数据）时返回空列表，不抛', () => {
    const out = projectAccountsBlob(null)
    expect(out.accounts).toEqual([])
    expect(out.revision).toBeUndefined()
  })

  it('blob 里混入非法账号条目时跳过它，不让整个列表崩掉', () => {
    const out = projectAccountsBlob({
      accounts: { 'acc-1': fullAccount(), bad: null, worse: 'string', 'no-id': { email: 'x@y.z' } }
    })
    expect(out.accounts).toHaveLength(1)
  })

  it('绝不透传 blob 的其他顶层字段（proxyUrl / switchTarget 等设置项）', () => {
    const out = projectAccountsBlob({
      accounts: {},
      proxyUrl: 'http://user:pass@127.0.0.1:7897',
      switchTarget: 'ide',
      activeAccountId: 'acc-1'
    }) as Record<string, unknown>
    expect(out).not.toHaveProperty('proxyUrl')
    expect(out).not.toHaveProperty('switchTarget')
    expect(JSON.stringify(out)).not.toContain('7897')
  })
})
