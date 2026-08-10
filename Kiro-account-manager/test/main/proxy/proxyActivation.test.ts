/**
 * 主进程侧反代编排下沉 —— 红灯先行
 *
 * 这批测试的存在理由是一个**已实证的失效模式**：只调 `pool.setActiveAccount()`
 * 移动指针，而不写 `config.selectedAccountIds`，在单账号模式下
 * （`proxyServer.ts:1582-1584` 取号读 `selectedAccountIds[0]`，`currentIndex`
 * 在那条路上不被消费）会表现为「接口返回成功、指针真的动了、反代仍打旧账号」。
 *
 * 所以断言必须**同时**覆盖池与 config 两侧 —— 只断言其一都无法排除该失效。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool } from '../../../src/main/proxy/accountPool'
import type { ProxyAccount, ProxyConfig } from '../../../src/main/proxy/types'
import {
  activateProxyAccount,
  toProxyAccountShared,
  buildProxyAccountsFromStore,
  type ProxyActivationHost
} from '../../../src/main/proxy/activation'

function acc(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return { id, email: `${id}@x.com`, accessToken: `tok-${id}`, ...extra }
}

/** 最小可用的宿主替身：真 AccountPool + 可观测的 config/粘性副作用 */
function makeHost(
  opts: {
    running?: boolean
    enableMultiAccount?: boolean
    accounts?: ProxyAccount[]
    storeAccounts?: Record<string, unknown>
  } = {}
): ProxyActivationHost & {
  pool: AccountPool
  config: Partial<ProxyConfig>
  affinityInvalidations: number
} {
  const pool = new AccountPool()
  for (const a of opts.accounts ?? []) pool.addAccount(a)
  const config: Partial<ProxyConfig> = {
    enableMultiAccount: opts.enableMultiAccount ?? false,
    selectedAccountIds: []
  }
  const host = {
    pool,
    config,
    affinityInvalidations: 0,
    isRunning: () => opts.running ?? true,
    getAccountPool: () => pool,
    getConfig: () => config as ProxyConfig,
    updateConfig: (patch: Partial<ProxyConfig>) => Object.assign(config, patch),
    invalidateSessionAffinity: () => {
      host.affinityInvalidations++
      return 1
    },
    loadAccountRecords: () => opts.storeAccounts ?? {}
  }
  return host
}

describe('toProxyAccountShared · 统一映射（吸收三份里最全的那份）', () => {
  it('带上 weight / groupId / proxyUrl —— 三份内联映射各漏其中之一', () => {
    const mapped = toProxyAccountShared(
      {
        id: 'a1',
        email: 'a1@x.com',
        machineId: 'mid-1',
        profileArn: 'arn:top',
        groupId: 'g1',
        weight: 42,
        idp: 'social',
        credentials: {
          accessToken: 'tok',
          refreshToken: 'rt',
          clientId: 'cid',
          clientSecret: 'csec',
          region: 'ap-northeast-1',
          authMethod: 'idc',
          expiresAt: 123456,
          tokenEndpoint: 'https://login.microsoftonline.com/x/token',
          issuerUrl: 'https://issuer',
          scopes: 'openid'
        }
      },
      'http://user:pass@127.0.0.1:8888'
    )
    expect(mapped).not.toBeNull()
    expect(mapped).toMatchObject({
      id: 'a1',
      accessToken: 'tok',
      refreshToken: 'rt',
      region: 'ap-northeast-1',
      authMethod: 'idc',
      profileArn: 'arn:top',
      machineId: 'mid-1',
      tokenEndpoint: 'https://login.microsoftonline.com/x/token',
      issuerUrl: 'https://issuer',
      scopes: 'openid',
      groupId: 'g1',
      weight: 42,
      proxyUrl: 'http://user:pass@127.0.0.1:8888'
    })
  })

  it('weight 缺省补 100（SWRR 权重策略靠它，缺省会让权重失真）', () => {
    const mapped = toProxyAccountShared({ id: 'a1', credentials: { accessToken: 't' } })
    expect(mapped?.weight).toBe(100)
  })

  it('region 缺省补 us-east-1（对齐三份既有映射的同一缺省）', () => {
    const mapped = toProxyAccountShared({ id: 'a1', credentials: { accessToken: 't' } })
    expect(mapped?.region).toBe('us-east-1')
  })

  it('provider 回落到 idp（credentials.provider 优先）', () => {
    expect(toProxyAccountShared({ id: 'a', idp: 'social', credentials: { accessToken: 't' } })?.provider).toBe('social')
    expect(
      toProxyAccountShared({ id: 'a', idp: 'social', credentials: { accessToken: 't', provider: 'idc' } })?.provider
    ).toBe('idc')
  })

  it('缺 accessToken / 缺 id → null（不产出半个账号灌进池）', () => {
    expect(toProxyAccountShared({ id: 'a1', credentials: {} })).toBeNull()
    expect(toProxyAccountShared({ credentials: { accessToken: 't' } })).toBeNull()
    expect(toProxyAccountShared(null)).toBeNull()
    expect(toProxyAccountShared('nope')).toBeNull()
  })
})

describe('activateProxyAccount · 三步顺序（下沉蓝本 accounts.ts:4306）', () => {
  it('反代未运行 → not_running，且不产生任何副作用', () => {
    const host = makeHost({ running: false, storeAccounts: { a1: { id: 'a1', credentials: { accessToken: 't' } } } })
    const r = activateProxyAccount('a1', host)
    expect(r).toEqual({ applied: false, reason: 'not_running' })
    expect(host.pool.size).toBe(0)
    expect(host.config.selectedAccountIds).toEqual([])
    expect(host.affinityInvalidations).toBe(0)
  })

  it('盘上无该账号 / 无凭据 → no_credentials（不写 config、不动池）', () => {
    const host = makeHost({ storeAccounts: { a1: { id: 'a1', credentials: {} } } })
    expect(activateProxyAccount('a1', host)).toEqual({ applied: false, reason: 'no_credentials' })
    expect(activateProxyAccount('ghost', host)).toEqual({ applied: false, reason: 'no_credentials' })
    expect(host.config.selectedAccountIds).toEqual([])
  })

  it('单账号模式：入池 + **写 selectedAccountIds** + 动指针（三者缺一即已实证的失效）', () => {
    const host = makeHost({
      enableMultiAccount: false,
      storeAccounts: {
        a1: { id: 'a1', email: 'a1@x.com', credentials: { accessToken: 'tok-a1' } },
        a2: { id: 'a2', email: 'a2@x.com', credentials: { accessToken: 'tok-a2' } }
      }
    })
    const r = activateProxyAccount('a2', host)
    expect(r).toEqual({ applied: true, mode: 'single', accountId: 'a2', email: 'a2@x.com' })
    // 1) 入池
    expect(host.pool.getAccount('a2')?.accessToken).toBe('tok-a2')
    // 2) 单账号模式的真开关 —— 这一条是 2026-07-28 RCA 的核心
    expect(host.config.selectedAccountIds).toEqual(['a2'])
    // 3) 指针 + 粘性失效
    expect(host.affinityInvalidations).toBe(1)
  })

  it('多账号模式：**不写** selectedAccountIds（写了会把轮询降级成单账号）', () => {
    const host = makeHost({
      enableMultiAccount: true,
      storeAccounts: { a1: { id: 'a1', credentials: { accessToken: 'tok-a1' } } }
    })
    const r = activateProxyAccount('a1', host)
    expect(r).toMatchObject({ applied: true, mode: 'multi' })
    expect(host.config.selectedAccountIds).toEqual([])
    expect(host.pool.getAccount('a1')).not.toBeNull()
    expect(host.affinityInvalidations).toBe(1)
  })

  it('凭据从盘上现读，不接受调用方快照（组件快照可能带已 rotate 作废的 refresh）', () => {
    const host = makeHost({
      storeAccounts: { a1: { id: 'a1', credentials: { accessToken: 'fresh-v2', refreshToken: 'rt-v2' } } }
    })
    // 池里先有一份旧凭据
    host.pool.addAccount(acc('a1', { accessToken: 'stale-v1', refreshToken: 'rt-v1' }))
    activateProxyAccount('a1', host)
    expect(host.pool.getAccount('a1')?.accessToken).toBe('fresh-v2')
    expect(host.pool.getAccount('a1')?.refreshToken).toBe('rt-v2')
  })

  it('已在池的账号走 upsert：保留封禁与断路器状态（不静默解除风控）', () => {
    const host = makeHost({
      storeAccounts: { a1: { id: 'a1', credentials: { accessToken: 'fresh' } } }
    })
    host.pool.addAccount(acc('a1', { suspendedAt: Date.now(), suspendReason: 'SUSPENDED' }))
    expect(host.pool.isSuspended(host.pool.getAccount('a1')!)).toBe(true)
    activateProxyAccount('a1', host)
    // 凭据刷新了，但封禁没被抹掉
    expect(host.pool.getAccount('a1')?.accessToken).toBe('fresh')
    expect(host.pool.isSuspended(host.pool.getAccount('a1')!)).toBe(true)
  })

  it('幂等：连点两次结果一致，不产生第二份池成员', () => {
    const host = makeHost({ storeAccounts: { a1: { id: 'a1', credentials: { accessToken: 't' } } } })
    activateProxyAccount('a1', host)
    activateProxyAccount('a1', host)
    expect(host.pool.size).toBe(1)
    expect(host.config.selectedAccountIds).toEqual(['a1'])
  })

  it('不抛出：宿主某一步失败时降级为 { applied:false, reason:"error" }', () => {
    const host = makeHost({ storeAccounts: { a1: { id: 'a1', credentials: { accessToken: 't' } } } })
    host.updateConfig = () => {
      throw new Error('store write failed')
    }
    expect(activateProxyAccount('a1', host)).toEqual({ applied: false, reason: 'error' })
  })
})

describe('buildProxyAccountsFromStore · 同步池的候选筛选', () => {
  // 判据是「有凭据 且 未被后端拒绝」，不是 `status === 'active'`：status 是显示字段，
  // 断网时的后台测活会把好号写成 'error'（`persistCheckResult.ts:325`），
  // 用它当闸门等于让一次网络抖动把好号永久钉在池外。所以这里的 `inactive`
  // 必须带**封禁形状**的 lastError 才该被挡 —— 光有 status:'error' 不算。
  it('只收有凭据且未被后端拒绝的账号', () => {
    const records = {
      ok: { id: 'ok', status: 'active', credentials: { accessToken: 't' } },
      noToken: { id: 'noToken', status: 'active', credentials: {} },
      inactive: {
        id: 'inactive',
        status: 'error',
        lastError: 'AccountSuspendedException',
        credentials: { accessToken: 't' }
      }
    }
    const out = buildProxyAccountsFromStore(records)
    expect(out.map((a) => a.id)).toEqual(['ok'])
  })

  it('按分组过滤（groups 模式）· __ungrouped__ 命中无 groupId 的账号', () => {
    const records = {
      g1: { id: 'g1', status: 'active', groupId: 'ga', credentials: { accessToken: 't' } },
      g2: { id: 'g2', status: 'active', groupId: 'gb', credentials: { accessToken: 't' } },
      none: { id: 'none', status: 'active', credentials: { accessToken: 't' } }
    }
    expect(buildProxyAccountsFromStore(records, { groupIds: ['ga'] }).map((a) => a.id)).toEqual(['g1'])
    expect(buildProxyAccountsFromStore(records, { groupIds: ['__ungrouped__'] }).map((a) => a.id)).toEqual(['none'])
  })

  it('绑定的出口代理：仅 enabled 且非 dead 才透传 proxyUrl', () => {
    const records = { a1: { id: 'a1', status: 'active', credentials: { accessToken: 't' } } }
    const live = buildProxyAccountsFromStore(records, {
      bindings: { a1: 'p1' },
      proxyPool: { p1: { url: 'http://1.1.1.1:1', enabled: true, status: 'alive' } }
    })
    expect(live[0].proxyUrl).toBe('http://1.1.1.1:1')
    const dead = buildProxyAccountsFromStore(records, {
      bindings: { a1: 'p1' },
      proxyPool: { p1: { url: 'http://1.1.1.1:1', enabled: true, status: 'dead' } }
    })
    expect(dead[0].proxyUrl).toBeUndefined()
  })

  it('脏数据不抛：非对象条目跳过而不是让整次同步失败', () => {
    const out = buildProxyAccountsFromStore({ bad: null, worse: 'str', ok: { id: 'ok', status: 'active', credentials: { accessToken: 't' } } })
    expect(out.map((a) => a.id)).toEqual(['ok'])
  })
})
