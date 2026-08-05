/**
 * ksk_ 导入用例（两端共用）—— 行为契约
 *
 * 这组用例守的是**下沉的理由**：判重 / 四态状态机 / userId 派生这三处逻辑原先只活在
 * renderer 闭包里（`AddAccountDialog.tsx:79` `isAccountExists` · `:99`
 * `checkApiKeyFingerprintExists` · `:1495` userId 派生）。在面板里复制一份就是第二个真源，
 * 必然漂移。所以它们必须在这里被验证，而不是在任一端的 UI 测试里。
 *
 * 判重的账号集合来自 `applyAccountDataMutation` 的 `prev`（盘上权威态，且在收口的
 * 进程内串行锁之内）—— 不是来自任何 store。这正是共享层能成立的原因。
 */
import { describe, it, expect, vi } from 'vitest'
import { importApiKeys, type ApiKeyImportDeps } from '../../../src/main/accountService/importApiKey'
import type { VerifyApiKeyResult } from '../../../src/shared/types/credential'
import type { AccountsBlob, ApplyResult } from '../../../src/main/accountService/state'

const KEY_A = `ksk_${'a'.repeat(40)}`
const KEY_B = `ksk_${'b'.repeat(40)}`

/** VALID 态的标准返回（契约：VALID 必带 tokenFingerprint） */
function valid(over: Partial<VerifyApiKeyResult> = {}): VerifyApiKeyResult {
  return {
    state: 'VALID',
    success: true,
    tokenFingerprint: 'fp00000000000001',
    region: 'us-east-1',
    subscription: { type: 'Q_DEVELOPER_STANDALONE_PRO', title: 'KIRO PRO', currentUsage: 5, usageLimit: 100 },
    ...over
  }
}

/**
 * 假的盘：`applyMutation` 真的把 mutator 跑一遍并留下结果，
 * 这样「判重读的是 prev」这件事才真的被测到（mock 掉就只是空谈）。
 */
function fakeDisk(initial: AccountsBlob = { revision: 3, accounts: {} }): {
  blob: AccountsBlob
  applyMutation: ApiKeyImportDeps['applyMutation']
} {
  const state = { blob: { ...initial } }
  return {
    get blob() {
      return state.blob
    },
    applyMutation: async (mutate, opts): Promise<ApplyResult> => {
      const prev = { ...state.blob, revision: (state.blob.revision as number) ?? 0 }
      if (opts?.expectedRevision !== undefined && opts.expectedRevision !== prev.revision) {
        return { ok: false, code: 'STALE_REVISION', currentRevision: prev.revision }
      }
      const next = await mutate(prev)
      state.blob = { ...next, revision: prev.revision + 1 }
      return { ok: true, revision: prev.revision + 1 }
    }
  }
}

function deps(over: Partial<ApiKeyImportDeps> = {}): ApiKeyImportDeps {
  const disk = fakeDisk()
  return {
    verifyApiKey: vi.fn(async () => valid()),
    applyMutation: disk.applyMutation,
    now: () => 1_700_000_000_000,
    newId: (() => {
      let n = 0
      return () => `acc-${++n}`
    })(),
    newMachineId: () => 'f'.repeat(64),
    ...over
  }
}

function accountsOf(blob: AccountsBlob): Record<string, Record<string, unknown>> {
  return (blob.accounts ?? {}) as Record<string, Record<string, unknown>>
}

describe('importApiKeys · 四态状态机', () => {
  it('VALID 才入池：INVALID / SUSPENDED / INDETERMINATE 一律拒绝且不写盘', async () => {
    for (const state of ['INVALID', 'SUSPENDED', 'INDETERMINATE'] as const) {
      const disk = fakeDisk()
      const result = await importApiKeys(
        deps({
          applyMutation: disk.applyMutation,
          verifyApiKey: async () => ({ state, success: false, error: `拒绝:${state}` })
        }),
        { rawInput: KEY_A }
      )
      expect(result.imported, `${state} 不得入池`).toBe(0)
      expect(result.results[0].code).toBe(state)
      expect(Object.keys(accountsOf(disk.blob))).toHaveLength(0)
    }
  })

  it('VALID 但缺 tokenFingerprint → 保守拒绝（契约破损，防污染池）', async () => {
    const disk = fakeDisk()
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async () => valid({ tokenFingerprint: undefined })
      }),
      { rawInput: KEY_A }
    )
    expect(result.imported).toBe(0)
    expect(result.results[0].code).toBe('MISSING_FINGERPRINT')
    expect(Object.keys(accountsOf(disk.blob))).toHaveLength(0)
  })

  it('格式错（非 ksk_ 前缀）在本地就拒，不浪费一次网络校验', async () => {
    const verifyApiKey = vi.fn(async () => valid())
    const result = await importApiKeys(deps({ verifyApiKey }), { rawInput: 'sk-not-a-kiro-key' })
    expect(result.results[0].code).toBe('BAD_FORMAT')
    expect(verifyApiKey).not.toHaveBeenCalled()
  })

  it('校验抛异常 → 归 VERIFY_ERROR，不影响同批其它密钥', async () => {
    const disk = fakeDisk()
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async ({ apiKey }) => {
          if (apiKey === KEY_A) throw new Error('socket hang up')
          return valid({ tokenFingerprint: 'fp00000000000002' })
        }
      }),
      { rawInput: `${KEY_A}\n${KEY_B}` }
    )
    expect(result.results[0].code).toBe('VERIFY_ERROR')
    expect(result.imported).toBe(1)
  })
})

describe('importApiKeys · 稳定 userId 派生', () => {
  it('有 profileArn → 取尾段', async () => {
    const disk = fakeDisk()
    await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async () =>
          valid({ profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF123456' })
      }),
      { rawInput: KEY_A }
    )
    const acc = Object.values(accountsOf(disk.blob))[0]
    expect(acc.userId).toBe('ABCDEF123456')
    expect(acc.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF123456')
  })

  it('无 profileArn（STANDALONE）→ 回退 tokenFingerprint，多个 STANDALONE 才不会互相判重', async () => {
    const disk = fakeDisk()
    let n = 0
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async () => valid({ profileArn: undefined, tokenFingerprint: `fp0000000000000${++n}` })
      }),
      { rawInput: `${KEY_A}\n${KEY_B}` }
    )
    expect(result.imported).toBe(2)
    const ids = Object.values(accountsOf(disk.blob)).map((a) => a.userId)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain('fp00000000000001')
  })
})

describe('importApiKeys · 双重判重（读的是盘上 prev，不是任何 store）', () => {
  it('指纹已在盘上 → ALREADY_EXISTS', async () => {
    const disk = fakeDisk({
      revision: 1,
      accounts: {
        old: {
          id: 'old',
          userId: 'whatever',
          credentials: { provider: 'ApiKey', accessToken: KEY_A, tokenFingerprint: 'fp00000000000001' }
        }
      }
    })
    const result = await importApiKeys(deps({ applyMutation: disk.applyMutation }), { rawInput: KEY_A })
    expect(result.imported).toBe(0)
    expect(result.results[0].code).toBe('ALREADY_EXISTS')
    expect(Object.keys(accountsOf(disk.blob))).toHaveLength(1)
  })

  it('老账号缺 tokenFingerprint 但有 accessToken → 按需补算后仍能判出重复（A3-R5 竞态消除）', async () => {
    const disk = fakeDisk({
      revision: 1,
      accounts: {
        legacy: {
          id: 'legacy',
          userId: 'legacy-user',
          // 没有 tokenFingerprint —— 历史账号
          credentials: { provider: 'ApiKey', accessToken: KEY_A }
        }
      }
    })
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        // 真算一次指纹：用例要证明补算路径真的接上了
        verifyApiKey: async ({ apiKey }) => {
          const { sha256Fingerprint } = await import('../../../src/main/utils/tokenFingerprint')
          return valid({ tokenFingerprint: sha256Fingerprint(apiKey) })
        }
      }),
      { rawInput: KEY_A }
    )
    expect(result.results[0].code).toBe('ALREADY_EXISTS')
    expect(result.imported).toBe(0)
  })

  it('userId 主键已在盘上 → ALREADY_EXISTS（即便指纹不同）', async () => {
    const disk = fakeDisk({
      revision: 1,
      accounts: {
        old: {
          id: 'old',
          userId: 'ABCDEF123456',
          credentials: { provider: 'ApiKey', tokenFingerprint: 'fp-something-else' }
        }
      }
    })
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async () =>
          valid({ profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ABCDEF123456' })
      }),
      { rawInput: KEY_A }
    )
    expect(result.results[0].code).toBe('ALREADY_EXISTS')
  })

  it('同一批里粘两遍同一个 key → 只入池一次（批内判重，不靠逐个写盘产生的副作用）', async () => {
    const disk = fakeDisk()
    const result = await importApiKeys(deps({ applyMutation: disk.applyMutation }), {
      rawInput: `${KEY_A}\n${KEY_A}\n  ${KEY_A}  `
    })
    expect(result.total).toBe(1)
    expect(result.imported).toBe(1)
    expect(Object.keys(accountsOf(disk.blob))).toHaveLength(1)
  })

  it('批内两个不同 key 派生出同一 userId → 第二个判重（累积集合参与判定）', async () => {
    const disk = fakeDisk()
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async ({ apiKey }) =>
          valid({
            profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/SAME',
            tokenFingerprint: apiKey === KEY_A ? 'fp00000000000001' : 'fp00000000000002'
          })
      }),
      { rawInput: `${KEY_A}\n${KEY_B}` }
    )
    expect(result.imported).toBe(1)
    expect(result.results.filter((r) => r.code === 'ALREADY_EXISTS')).toHaveLength(1)
  })
})

describe('importApiKeys · 原子性与落盘形状', () => {
  it('整批只写一次盘：20 个 key 只让 revision 涨 1', async () => {
    const disk = fakeDisk()
    const keys = Array.from({ length: 20 }, (_, i) => `ksk_${String(i).padStart(2, '0')}${'z'.repeat(38)}`)
    let n = 0
    const result = await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async () => valid({ tokenFingerprint: `fp${String(++n).padStart(14, '0')}` })
      }),
      { rawInput: keys.join('\n') }
    )
    expect(result.imported).toBe(20)
    expect(disk.blob.revision).toBe(4) // 初始 3 → 一次写入 → 4
  })

  it('全部失败时不发起写入（revision 不动）', async () => {
    const disk = fakeDisk()
    await importApiKeys(
      deps({
        applyMutation: disk.applyMutation,
        verifyApiKey: async () => ({ state: 'INVALID', success: false, error: 'nope' })
      }),
      { rawInput: KEY_A }
    )
    expect(disk.blob.revision).toBe(3)
  })

  it('账号对象形状与桌面端一致：api_key 认证 / ApiKey provider / 远期 expiresAt / 落 groupId', async () => {
    const disk = fakeDisk()
    await importApiKeys(deps({ applyMutation: disk.applyMutation }), {
      rawInput: KEY_A,
      groupId: 'grp-7'
    })
    const acc = Object.values(accountsOf(disk.blob))[0]
    const cred = acc.credentials as Record<string, unknown>
    expect(acc.idp).toBe('ApiKey')
    expect(acc.groupId).toBe('grp-7')
    expect(acc.status).toBe('active')
    expect(acc.isActive).toBe(false)
    expect(cred.authMethod).toBe('api_key')
    expect(cred.provider).toBe('ApiKey')
    expect(cred.accessToken).toBe(KEY_A)
    expect(cred.region).toBe('us-east-1')
    // ksk 永不过期 —— 远期到期时间，避免自动刷新/过期判定误触发
    expect(cred.expiresAt as number).toBeGreaterThan(1_700_000_000_000 + 50 * 365 * 24 * 3600 * 1000)
    expect(acc.machineId).toBe('f'.repeat(64))
  })

  it('usage.percentUsed 是 0~1 比例（全仓 SSOT 口径），不是 0-100 百分数', async () => {
    // fixture: currentUsage 5 / usageLimit 100 ⇒ 比例 0.05。
    //
    // 为什么必须钉住:消费侧一律按比例解读 —— renderer `usagePercentValue = percentUsed * 100`、
    // 面板 `formatPercent(v) = Math.round(v * 100)%`。若这里写 0-100 的百分数(旧实现
    // `Math.round((current / limit) * 100)` 得 5),再乘 100 就显示成 500%。
    // 这一处是 fce8c89 从老 AddAccountDialog 逐字搬过来的漏网点:老代码里该占位值很快被
    // checkAccountStatus 覆盖成比例,单位错误被掩盖;导入后 check 一旦不跑(store 竞态),
    // 它就直接留在盘上。既有守护见 test/renderer/usage-percent-ssot/percentUsedUnit.test.tsx。
    const disk = fakeDisk()
    await importApiKeys(deps({ applyMutation: disk.applyMutation }), { rawInput: KEY_A })
    const acc = Object.values(accountsOf(disk.blob))[0]
    const usage = acc.usage as Record<string, number>
    expect(usage.current).toBe(5)
    expect(usage.limit).toBe(100)
    expect(usage.percentUsed).toBeCloseTo(0.05, 6)
  })

  it('保留盘上其它顶层字段与既有账号（不是整表覆盖成只剩新账号）', async () => {
    const disk = fakeDisk({
      revision: 2,
      accounts: { keep: { id: 'keep', userId: 'u-keep', credentials: { provider: 'BuilderId' } } },
      proxyUrl: 'http://user:pass@host:1080',
      activeAccountId: 'keep'
    })
    await importApiKeys(deps({ applyMutation: disk.applyMutation }), { rawInput: KEY_A })
    expect(disk.blob.proxyUrl).toBe('http://user:pass@host:1080')
    expect(disk.blob.activeAccountId).toBe('keep')
    expect(Object.keys(accountsOf(disk.blob))).toHaveLength(2)
  })

  it('盘上 accounts 是数组形态（历史/导入数据）时按数组写回', async () => {
    const disk = fakeDisk({
      revision: 1,
      accounts: [{ id: 'arr', userId: 'u-arr', credentials: { provider: 'BuilderId' } }] as unknown as Record<
        string,
        unknown
      >
    })
    const result = await importApiKeys(deps({ applyMutation: disk.applyMutation }), { rawInput: KEY_A })
    expect(result.imported).toBe(1)
    expect(Array.isArray(disk.blob.accounts)).toBe(true)
    expect((disk.blob.accounts as unknown[]).length).toBe(2)
  })

  it('写入被 STALE_REVISION 拒 → 如实上报失败，绝不谎报导入成功', async () => {
    const result = await importApiKeys(
      deps({
        applyMutation: async () => ({ ok: false, code: 'STALE_REVISION', currentRevision: 99 })
      }),
      { rawInput: KEY_A, expectedRevision: 1 }
    )
    expect(result.imported).toBe(0)
    expect(result.staleRevision).toBe(99)
    expect(result.results[0].code).toBe('WRITE_CONFLICT')
  })
})

describe('importApiKeys · 输出绝不含密钥明文', () => {
  it('结果里的标签是掩码，且整个返回体序列化后不含原始 key', async () => {
    const disk = fakeDisk()
    const result = await importApiKeys(deps({ applyMutation: disk.applyMutation }), {
      rawInput: `${KEY_A}\nbad-key`
    })
    expect(JSON.stringify(result)).not.toContain(KEY_A)
    expect(result.results[0].label).not.toContain('a'.repeat(20))
    expect(result.results[0].label.startsWith('ksk_')).toBe(true)
  })

  it('空输入 → EMPTY_INPUT，不写盘', async () => {
    const disk = fakeDisk()
    const result = await importApiKeys(deps({ applyMutation: disk.applyMutation }), { rawInput: '   \n\n  ' })
    expect(result.total).toBe(0)
    expect(result.emptyInput).toBe(true)
    expect(disk.blob.revision).toBe(3)
  })
})
