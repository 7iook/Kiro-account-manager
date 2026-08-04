/**
 * C1 返修 · 跨端并发下「用户操作绝不静默丢弃」的合并语义
 *
 * 被治的病灶（reviewer C1）:
 *   flushSaveImmediately 收到 STALE_REVISION 后只调 reloadFromStorageQuiet,
 *   而后者整表覆盖内存 ⇒ 用户刚做的删除/编辑被磁盘数据冲掉,磁盘上从未写入,且无任何提示。
 *
 * 这里锁住的是合并语义本身（纯函数,真实业务时序在 storeStaleReplay.test.ts 里跑）。
 */
import { describe, it, expect } from 'vitest'
import { mergeSyncBlob } from '@/store/syncMerge'

const acc = (id: string, token: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  credentials: { accessToken: token },
  ...extra
})

describe('mergeSyncBlob · 跨端并发时用户操作不能被外部写覆盖', () => {
  it('用户删掉 3 个账号时 ProactiveRenewal 正好刷了第 4 个的 token · 删除必须留住且刷新也要留住', () => {
    // base: 我这份内存状态所基于的磁盘快照（4 个账号）
    const base = {
      accounts: { A: acc('A', 'a1'), B: acc('B', 'b1'), C: acc('C', 'c1'), D: acc('D', 'd1') },
      revision: 5
    }
    // ours: 用户删掉 A/B/C（内存里只剩 D,D 未动）
    const ours = { accounts: { D: acc('D', 'd1') }, revision: 5 }
    // theirs: 磁盘上 ProactiveRenewal 把 D 的 token 刷成 d2（A/B/C 还在,它没删）
    const theirs = {
      accounts: { A: acc('A', 'a1'), B: acc('B', 'b1'), C: acc('C', 'c1'), D: acc('D', 'd2') },
      revision: 6
    }

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const accounts = merged.accounts as Record<string, unknown>

    // 用户的删除必须落实 —— 这是 C1 的核心:reload 覆盖会让它们复活
    expect(Object.keys(accounts).sort()).toEqual(['D'])
    // 外部对 D 的 token 刷新也要留住（我没动 D,不该把它按回旧值）
    expect((accounts.D as { credentials: { accessToken: string } }).credentials.accessToken).toBe('d2')

    expect(stats.localDeletionsHonored).toBe(3)
    expect(stats.remoteRecordsAdopted).toBe(1)
  })

  it('外部新增的账号（别人在手机端导入的）必须出现在结果里 · 不能被我的整表快照抹掉', () => {
    const base = { accounts: { A: acc('A', 'a1') } }
    const ours = { accounts: { A: acc('A', 'a1') } } // 我什么都没改
    const theirs = { accounts: { A: acc('A', 'a1'), NEW: acc('NEW', 'n1') } } // 手机端导入了 NEW

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const accounts = merged.accounts as Record<string, unknown>

    expect(Object.keys(accounts).sort()).toEqual(['A', 'NEW'])
    expect(stats.remoteRecordsAdopted).toBe(1)
    expect(stats.localDeletionsHonored).toBe(0) // NEW 不在 base 里 ⇒ 不是"我删的"
  })

  it('同一账号我改了备注、别人刷了 token · 用户刚做的编辑优先(记录级 last-writer=用户)', () => {
    const base = { accounts: { A: acc('A', 'a1', { note: 'old' }) } }
    const ours = { accounts: { A: acc('A', 'a1', { note: 'MY-EDIT' }) } }
    const theirs = { accounts: { A: acc('A', 'a2', { note: 'old' }) } }

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const a = (merged.accounts as Record<string, { note: string }>).A

    expect(a.note).toBe('MY-EDIT')
    expect(stats.localRecordsKept).toBe(1)
  })

  it('别人删了某账号而我没动过它 · 采纳外部删除,不能把它复活', () => {
    const base = { accounts: { A: acc('A', 'a1'), B: acc('B', 'b1') } }
    const ours = { accounts: { A: acc('A', 'a1'), B: acc('B', 'b1') } }
    const theirs = { accounts: { A: acc('A', 'a1') } } // 手机端删了 B

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)

    expect(Object.keys(merged.accounts as Record<string, unknown>)).toEqual(['A'])
    expect(stats.remoteDeletionsAdopted).toBe(1)
  })

  it('我刚把检查间隔改成 10 分钟、别人同时刷了 token · 我改的设置值不能被磁盘旧值按回去', () => {
    const base = { accounts: {}, autoSwitchInterval: 5, theme: 'default' }
    const ours = { accounts: {}, autoSwitchInterval: 10, theme: 'default' } // 我改了间隔
    const theirs = { accounts: {}, autoSwitchInterval: 5, theme: 'ocean' } // 别人改了主题

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)

    expect(merged.autoSwitchInterval).toBe(10) // 我改的留住
    expect(merged.theme).toBe('ocean') // 我没动主题 → 采纳别人的
    expect(stats.localScalarsKept).toContain('autoSwitchInterval')
    expect(stats.localScalarsKept).not.toContain('theme')
  })

  it('合并结果绝不携带陈旧 revision · revision 由收口函数权威赋值', () => {
    const base = { accounts: {}, revision: 5 }
    const ours = { accounts: {}, revision: 5 }
    const theirs = { accounts: {}, revision: 9 }

    const { merged } = mergeSyncBlob(base, ours, theirs)

    // 合并产物里的 revision 必须是 theirs 的（我们要基于它重放）,绝不能是 ours 的陈旧值
    expect(merged.revision).toBe(9)
  })

  it('base 缺失（首次加载前就发生冲突）· 退化为保留本地,绝不静默丢用户操作', () => {
    // 极端时序:还没有可信 base。此时宁可保守保留本地（用户可见的东西不消失）,
    // 也不能像现状那样整表覆盖把用户操作抹掉。
    const ours = { accounts: { A: acc('A', 'a1') } }
    const theirs = { accounts: { B: acc('B', 'b1') } }

    const { merged } = mergeSyncBlob({}, ours, theirs)
    const accounts = merged.accounts as Record<string, unknown>

    // 无 base ⇒ ours 的 A 视为"我加的"(base 里没有), theirs 的 B 视为"别人加的" ⇒ 并集
    expect(Object.keys(accounts).sort()).toEqual(['A', 'B'])
  })
})

describe('真值表歧义格 · 语义必须被测试钉住(I2)', () => {
  it('G3 我改了备注、别人刷了 token · 我的编辑留住,而我没碰过的凭证采纳别人刷新的（I-a）', () => {
    // I-a:记录级"ours 整条胜出"会把 main 侧刚刷的 token 回滚成旧值。
    // 后果不是"下次 ProactiveRenewal 会补回"——它用内存 newExpiresAt 调度、不重读 store,
    // 且上游会轮换 refreshToken 并已写进 IDE 磁盘 token 文件 ⇒ store 与 IDE 文件分叉,
    // 旧 refreshToken 可能已失效 ⇒ 续期失败即停调度 ⇒ 可能需要用户重新登录。
    // 修法:仅当**我没碰过 credentials** 时采纳 theirs 的 credentials（main 侧是凭证权威源）。
    const base = { accounts: { A: acc('A', 'a1', { note: 'old' }) } }
    const ours = { accounts: { A: acc('A', 'a1', { note: 'MY-EDIT' }) } } // 我只改了 note
    const theirs = { accounts: { A: acc('A', 'a2-refreshed', { note: 'old' }) } } // 别人刷了 token

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const a = (merged.accounts as Record<string, { note: string; credentials: { accessToken: string } }>).A

    expect(a.note).toBe('MY-EDIT') // 用户编辑优先
    expect(a.credentials.accessToken).toBe('a2-refreshed') // 凭证不回滚
    expect(stats.localRecordsKept).toBe(1)
    expect(stats.remoteCredentialsAdopted).toBe(1)
  })

  it('G3 我自己刷了这个账号的 token、别人也刷了 · 保留我的,不被覆盖', () => {
    // renderer 的 refreshAccountToken（accounts.ts:1755）确实会写 credentials,
    // 那种情况下"我碰过凭证",必须保留我的值 —— 凭证例外只在我没碰时生效。
    const base = { accounts: { A: acc('A', 'a1') } }
    const ours = { accounts: { A: acc('A', 'MY-REFRESH') } }
    const theirs = { accounts: { A: acc('A', 'THEIR-REFRESH') } }

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const a = (merged.accounts as Record<string, { credentials: { accessToken: string } }>).A

    expect(a.credentials.accessToken).toBe('MY-REFRESH')
    expect(stats.remoteCredentialsAdopted).toBe(0)
  })

  it('G5 我删了账号而别人同时刷了它的 token · 删除优先(账号已不存在,其凭证无意义)', () => {
    const base = { accounts: { A: acc('A', 'a1'), B: acc('B', 'b1') } }
    const ours = { accounts: { B: acc('B', 'b1') } } // 我删了 A
    const theirs = { accounts: { A: acc('A', 'a2-refreshed'), B: acc('B', 'b1') } } // 别人刷了 A

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)

    expect(Object.keys(merged.accounts as Record<string, unknown>)).toEqual(['B'])
    expect(stats.localDeletionsHonored).toBe(1)
  })

  it('G6 我改了账号而别人删了它 · 用户编辑优先,账号不消失', () => {
    const base = { accounts: { A: acc('A', 'a1', { note: 'old' }) } }
    const ours = { accounts: { A: acc('A', 'a1', { note: 'MY-EDIT' }) } }
    const theirs = { accounts: {} } // 别人删了 A

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)
    const a = (merged.accounts as Record<string, { note: string }>).A

    expect(a.note).toBe('MY-EDIT')
    expect(stats.localRecordsKept).toBe(1)
  })

  it('G9 两端同时新增了同一个 id（base 里没有）· 保留本地,语义显式钉住', () => {
    // accountId 是 uuid / 指纹,实际撞车概率≈0;此用例存在的意义是把"取本地"这个选择固定下来,
    // 免得后来者重构时无从判断它是有意还是遗漏。
    const ours = { accounts: { X: acc('X', 'MINE') } }
    const theirs = { accounts: { X: acc('X', 'THEIRS') } }

    const { merged } = mergeSyncBlob({}, ours, theirs)
    const x = (merged.accounts as Record<string, { credentials: { accessToken: string } }>).X

    expect(x.credentials.accessToken).toBe('MINE')
  })
})

describe('比较与集合边界（m1 / m2）', () => {
  it('m1 显式 undefined 字段不算差异 · 不能因此误判"我改过"而吞掉外部改动', () => {
    // store 里确实会产生 { groupId: undefined } 这种对象（accounts.ts:1103）。
    // 若按 Object.keys().length 比长度,它与 base 的 {id,...} 判为不等 ⇒ 误判本地改过 ⇒ 丢 theirs。
    const base = { accounts: { A: { id: 'A', note: 'old' } } }
    const ours = { accounts: { A: { id: 'A', note: 'old', groupId: undefined } } }
    const theirs = { accounts: { A: { id: 'A', note: 'THEIR-EDIT' } } }

    const { merged } = mergeSyncBlob(base, ours, theirs)
    const a = (merged.accounts as Record<string, { note: string }>).A

    expect(a.note).toBe('THEIR-EDIT') // 我实质没改 ⇒ 采纳外部
  })

  it('m2 ours 里整个集合 key 缺失 · 视为"我没参与这个集合",不是"我删光了它"', () => {
    // 生产上 buildPersistBlob 恒输出三个集合故不可达,但 mergeSyncBlob 是导出的纯函数,
    // 对未来调用方（W5 web 面板可能只传部分集合）是陷阱:整个 groups 会被当成本地删除清空。
    const base = { accounts: {}, groups: { g1: { id: 'g1' } } }
    const ours = { accounts: {} } // 完全没有 groups key
    const theirs = { accounts: {}, groups: { g1: { id: 'g1' }, g2: { id: 'g2' } } }

    const { merged, stats } = mergeSyncBlob(base, ours, theirs)

    expect(Object.keys(merged.groups as Record<string, unknown>).sort()).toEqual(['g1', 'g2'])
    expect(stats.localDeletionsHonored).toBe(0)
  })
})
