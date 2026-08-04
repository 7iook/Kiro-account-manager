/**
 * C1 返修 · 「用户删账号撞上主进程刷 token 的写入窗口,删除必须真的落盘」
 *
 * 被治的病灶（reviewer C1 · accounts.ts:2300-2309 原实现）:
 *   flushSaveImmediately 收到 STALE_REVISION 后只调 reloadFromStorageQuiet,
 *   而后者整表覆盖内存 ⇒ 用户刚做的删除被磁盘数据冲掉,磁盘上从未写入,且无任何提示。
 *
 * 终点断言 = **磁盘上最终存的内容**(fakeDisk),不是 store 内存,也不是"reload 被调用了"。
 *
 * 单独一个文件:flushSaveImmediately 的 finally 有 fire-and-forget 对账,
 * 跨用例会污染别的 fake 盘面 —— vitest 按文件隔离,拆文件才是真隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import { mkAcc, makeFakeMain, CLEAN_STATE, type FakeMain } from './fixtures'

/**
 * 让 main 侧在我方**每次提交落盘之前**抢先写一次盘，共 `times` 次 ——
 * 于是我方前 `times` 次提交必然 STALE，第 `times + 1` 次才成功。
 *
 * 为什么要能精确控制撞车次数：重放循环是**跨轮次传递状态**（base / 内存）的循环，
 * 这类循环的缺陷通常在第二轮才显形，只测「撞一次」和「撞到耗尽」会整段跳过中间区间。
 */
function makeStaleStorm(fake: FakeMain, times: number): void {
  let stolen = 0
  const origSave = fake.api.saveAccounts.getMockImplementation()!
  fake.api.saveAccounts.mockImplementation(async (data: Record<string, unknown>) => {
    if (stolen < times) {
      stolen++
      const tag = `refreshed-${stolen}`
      // 模拟 ProactiveRenewal 逐账号刷 token：多账号场景下它就是连续多次写盘
      fake.externalWrite((d) => {
        const accs = d.accounts as Record<string, { credentials: { accessToken: string } }>
        if (accs.D) accs.D.credentials.accessToken = tag
        return d
      })
    }
    return origSave(data)
  })
}

beforeEach(() => {
  useAccountsStore.setState({ ...CLEAN_STATE })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('用户删账号撞上主进程刷 token 的写入窗口 · 删除必须真的落盘（C1）', () => {
  it('用户删掉 3 个账号 + ProactiveRenewal 并发刷第 4 个 token · 3 个账号最终在磁盘上消失且不复活', async () => {
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A'), B: mkAcc('B'), C: mkAcc('C'), D: mkAcc('D', 'old-token') }
    })

    // 1. 桌面端加载（拿到 revision=5,并记下 base 快照）
    await useAccountsStore.getState().loadFromStorage()
    expect(useAccountsStore.getState().currentRevision).toBe(5)

    // 2. 用户删掉 A/B/C（只改内存,落盘走防抖）
    const accounts = new Map(useAccountsStore.getState().accounts)
    accounts.delete('A')
    accounts.delete('B')
    accounts.delete('C')
    useAccountsStore.setState({ accounts })

    // 3. 防抖窗内 ProactiveRenewal 在 main 侧刷了 D 的 token → 磁盘 revision 变 6
    fake.externalWrite((d) => {
      const accs = d.accounts as Record<string, { credentials: { accessToken: string } }>
      accs.D.credentials.accessToken = 'refreshed-token'
      return d
    })

    // 4. 防抖到期落盘 → 必然 STALE（本地 5,磁盘 6）
    const result = await useAccountsStore.getState().flushSaveImmediately()
    expect(result.ok).toBe(true)

    // ===== 终点断言:磁盘上的真实内容 =====
    const diskAccounts = fake.disk.accounts as Record<string, unknown>
    expect(Object.keys(diskAccounts).sort()).toEqual(['D']) // 用户的删除真的落盘了
    // 外部刷新的 token 也没被我的陈旧快照按回去
    expect(
      (diskAccounts.D as { credentials: { accessToken: string } }).credentials.accessToken
    ).toBe('refreshed-token')

    // 内存与磁盘一致（不会自己回来）
    expect(Array.from(useAccountsStore.getState().accounts.keys()).sort()).toEqual(['D'])
    expect(useAccountsStore.getState().currentRevision).toBe(fake.disk.revision)
    expect(useAccountsStore.getState().syncError).toBeNull()
  })

  it('外部在我提交期间新增了账号 · 重放后该账号仍在,不被我的整表快照抹掉', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    // 用户改了 A 的备注
    const accounts = new Map(useAccountsStore.getState().accounts)
    accounts.set('A', { ...accounts.get('A')!, nickname: 'MY-EDIT' } as never)
    useAccountsStore.setState({ accounts })

    // 手机端同时导入了 NEW
    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).NEW = mkAcc('NEW')
      return d
    })

    await useAccountsStore.getState().flushSaveImmediately()

    const diskAccounts = fake.disk.accounts as Record<string, { nickname?: string }>
    // 两边的改动都在:我的编辑 + 别人的新增
    expect(Object.keys(diskAccounts).sort()).toEqual(['A', 'NEW'])
    expect(diskAccounts.A.nickname).toBe('MY-EDIT')
  })

  it('连续撞车（每次重放又被抢）· 有重试上限,耗尽后明确报错让用户知道,绝不静默', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    // 每次读盘后磁盘又被别人写一次 ⇒ 重放永远赶不上
    const origLoad = fake.api.loadAccounts.getMockImplementation()!
    fake.api.loadAccounts.mockImplementation(async () => {
      const snapshot = await origLoad()
      fake.externalWrite((d) => d)
      return snapshot
    })

    const accounts = new Map(useAccountsStore.getState().accounts)
    accounts.delete('A')
    useAccountsStore.setState({ accounts })

    // 第一次提交就已经撞车
    fake.externalWrite((d) => d)

    const result = await useAccountsStore.getState().flushSaveImmediately()

    // 必须明确失败,而不是假成功
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SYNC_CONFLICT_UNRESOLVED')
    // 且必须留下用户可见的错误状态（不静默 —— 这是 C1 的原罪之一）
    expect(useAccountsStore.getState().syncError).not.toBeNull()
    expect(useAccountsStore.getState().syncError?.code).toBe('SYNC_CONFLICT_UNRESOLVED')
    // 重试有上限:不会无限循环打爆 IPC
    expect(fake.api.saveAccounts.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('写入成功后清除既有冲突提示 · 不让陈旧错误一直挂在界面上', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()
    useAccountsStore.setState({
      syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: 3, at: Date.now() - 1000 }
    })

    await useAccountsStore.getState().flushSaveImmediately()

    expect(useAccountsStore.getState().syncError).toBeNull()
    expect(fake.disk.revision).toBe(6)
  })
})

/**
 * C3 · 「重放循环连撞 N 次」的**区间**覆盖（不是只测边界值）
 *
 * 为什么必须按区间测:上面三个用例分别覆盖 撞 1 次成功 与 撞满 3 次耗尽,
 * 恰好**跳过了 stale=2**（第二轮重放）—— 而 base 的语义缺陷正是从第二轮起才显形:
 * 第一轮 base 还是 load 时的真盘面（正确）,第二轮的 base 已被上一轮写成「合并产物」,
 * 用户删掉的账号在其中不存在 ⇒ 下一轮判为「别人新加的」⇒ 删除复活,且 flush 返回 ok:true。
 *
 * 因此这里对 1..MAX_STALE_REPLAY_ATTEMPTS 的**每一个可成功值**都跑同一组业务断言。
 * 这类「跨轮次传递状态的循环」不能只测端点:端点上循环体只跑一次或不产出结果。
 */
describe('主进程连续刷多个账号 token 期间我删了 3 个账号 · 撞车 1..N 次删除都必须落盘（C3）', () => {
  // MAX_STALE_REPLAY_ATTEMPTS = 3 ⇒ 撞 1 次和 2 次都还能在上限内成功
  for (const staleTimes of [1, 2]) {
    it(`main 侧连抢 ${staleTimes} 次 · 我删的 3 个账号最终在磁盘上消失,不复活`, async () => {
      const fake = makeFakeMain({
        accounts: { A: mkAcc('A'), B: mkAcc('B'), C: mkAcc('C'), D: mkAcc('D', 'old-token') }
      })
      await useAccountsStore.getState().loadFromStorage()

      // 用户删掉 A/B/C（只改内存,落盘走防抖）
      const accounts = new Map(useAccountsStore.getState().accounts)
      accounts.delete('A')
      accounts.delete('B')
      accounts.delete('C')
      useAccountsStore.setState({ accounts })

      makeStaleStorm(fake, staleTimes)

      const result = await useAccountsStore.getState().flushSaveImmediately()
      expect(result.ok).toBe(true)

      // ===== 终点断言:磁盘上的真实内容 =====
      const diskAccounts = fake.disk.accounts as Record<string, unknown>
      expect(Object.keys(diskAccounts).sort()).toEqual(['D'])
      // 外部最后一次刷新的 token 仍在（我的重放没把它按回旧值）
      expect(
        (diskAccounts.D as { credentials: { accessToken: string } }).credentials.accessToken
      ).toBe(`refreshed-${staleTimes}`)
      expect(Array.from(useAccountsStore.getState().accounts.keys()).sort()).toEqual(['D'])
      expect(useAccountsStore.getState().syncError).toBeNull()
    })

    it(`main 侧连抢 ${staleTimes} 次 · 我改的备注最终在磁盘上,不被合并产物抹掉`, async () => {
      const fake = makeFakeMain({
        accounts: { A: mkAcc('A'), D: mkAcc('D', 'old-token') }
      })
      await useAccountsStore.getState().loadFromStorage()

      const accounts = new Map(useAccountsStore.getState().accounts)
      accounts.set('A', { ...accounts.get('A')!, nickname: 'MY-NOTE' } as never)
      useAccountsStore.setState({ accounts })

      makeStaleStorm(fake, staleTimes)

      const result = await useAccountsStore.getState().flushSaveImmediately()
      expect(result.ok).toBe(true)

      const diskAccounts = fake.disk.accounts as Record<string, { nickname?: string }>
      expect(Object.keys(diskAccounts).sort()).toEqual(['A', 'D'])
      expect(diskAccounts.A.nickname).toBe('MY-NOTE')
    })
  }

  it('main 侧连抢 2 次期间还真的新增了账号 · 我的删除落实、别人的新增保留（二者必须可区分）', async () => {
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A'), D: mkAcc('D', 'old-token') }
    })
    await useAccountsStore.getState().loadFromStorage()

    // 我删掉 A
    const accounts = new Map(useAccountsStore.getState().accounts)
    accounts.delete('A')
    useAccountsStore.setState({ accounts })

    // main 侧抢两次:第 2 次顺带导入一个新账号 PHONE（手机端真的新增）
    let stolen = 0
    const origSave = fake.api.saveAccounts.getMockImplementation()!
    fake.api.saveAccounts.mockImplementation(async (data: Record<string, unknown>) => {
      if (stolen < 2) {
        stolen++
        const n = stolen
        fake.externalWrite((d) => {
          const accs = d.accounts as Record<string, unknown>
          ;(accs.D as { credentials: { accessToken: string } }).credentials.accessToken = `refreshed-${n}`
          if (n === 2) accs.PHONE = mkAcc('PHONE')
          return d
        })
      }
      return origSave(data)
    })

    const result = await useAccountsStore.getState().flushSaveImmediately()
    expect(result.ok).toBe(true)

    const diskAccounts = fake.disk.accounts as Record<string, unknown>
    // A 是我删的 → 必须消失；PHONE 是别人真加的 → 必须保留。两者若共用同一分支就无从区分。
    expect(Object.keys(diskAccounts).sort()).toEqual(['D', 'PHONE'])
  })
})

/**
 * I6 · 「我删掉的账号绝不会自己回到磁盘上」—— 不变量断言（§4.9 Layer-1 闸门）
 *
 * C1 与 C3 同属一个母题:丢用户数据时缺少"这不对"的信号。syncError 弹窗只覆盖「重试耗尽」,
 * 覆盖不到「合并返回 ok:true 但删除没了」。重放循环里现在有一道守恒闸门:
 * 本次落盘期间我删过的 id,若重新出现在合并产物里,直接拒绝落盘并置 syncError。
 *
 * 这里断言的是**用户可感知的那句话**:别人一直在写盘、我删掉的账号也不许复活;
 * 且无论走哪条路径（正确落实删除 / 被闸门拦下）,磁盘上都绝不能出现复活的账号。
 */
describe('别人持续写盘时我删掉的账号绝不复活到磁盘上（I6 守恒闸门）', () => {
  it('每轮读盘时别人都把我删的账号重新写回盘面 · 磁盘上最终仍然没有它', async () => {
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A'), D: mkAcc('D', 'old-token') }
    })
    await useAccountsStore.getState().loadFromStorage()

    // 用户删掉 A
    const accounts = new Map(useAccountsStore.getState().accounts)
    accounts.delete('A')
    useAccountsStore.setState({ accounts })

    makeStaleStorm(fake, 2)

    await useAccountsStore.getState().flushSaveImmediately()

    // 唯一的硬要求:磁盘上不许有 A。
    // 要么删除被正确落实（ok:true 且 A 不在盘上）,要么闸门拦下不写盘（A 仍是别人盘面上的旧值,
    // 但我方绝不会把"复活后的整表"写上去）—— 两条路径都不产生"用户删了却又回来"的结果。
    expect(Object.keys(fake.disk.accounts as Record<string, unknown>)).not.toContain('A')
  })
})

/**
 * C3 变体 · 「loadFromStorage 生成的 machineId 不许被合并抹掉」（对象别名污染）
 *
 * 与 C3 同母题:base 的**内容**必须是盘面原样。C3 的表现是 base 取了合并产物;
 * 这里的表现更隐蔽 —— base 的取值来源已经改对（deriveBaseFromDisk(data, …)）,
 * 但 `data.accounts[id]` 与内存 Map 里的 value 是**同一个对象引用**,
 * 生成 machineId 时就地写 `account.machineId = …` 直接污染了 data 本身。
 * 于是 base 与 ours 都含新 machineId ⇒ 合并读作"我没改过" ⇒ 采纳盘面（无 machineId）⇒ 静默丢失。
 *
 * 终点断言 = 磁盘上最终有没有这个 machineId。
 */
describe('加载时为老账号生成的 machineId 撞上并发写盘 · 不许被静默抹掉（C3 别名变体）', () => {
  it('账号原本没有 machineId · 加载时生成 · 主进程并发写盘一次 · 生成的 machineId 最终在磁盘上', async () => {
    // 故意造一个「盘面上没有 machineId」的老账号（真实老数据就是这样,fixtures 默认补了 machineId）
    const legacy = mkAcc('A')
    delete (legacy as { machineId?: string }).machineId
    const fake = makeFakeMain({ accounts: { A: legacy, D: mkAcc('D', 'old-token') } })

    await useAccountsStore.getState().loadFromStorage()

    // 加载时应当已为 A 生成 machineId（内存里）
    const generated = useAccountsStore.getState().accounts.get('A')?.machineId
    expect(generated).toBeTruthy()

    // 主进程抢先写一次盘 → 我方首次提交 STALE → 进重放合并
    makeStaleStorm(fake, 1)

    await useAccountsStore.getState().flushSaveImmediately()

    // 生成的 machineId 必须真的落盘,不能在合并里被判成"我没改过"而回退成无 machineId
    const diskA = (fake.disk.accounts as Record<string, { machineId?: string }>).A
    expect(diskA.machineId).toBe(generated)
  })
})
