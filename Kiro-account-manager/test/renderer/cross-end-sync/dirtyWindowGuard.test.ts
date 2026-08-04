/**
 * C1-again 返修 · 「防抖窗内的用户编辑不能被任何一条同步通道复活」
 *
 * 被治的病灶（reviewer C1-again 探针实测）:
 *   isSyncing 只在 flushSaveImmediately 执行期间为 true（IPC 在途）。
 *   而用户编辑后的真实时序是:
 *     set() 改内存 → saveToStorage 启动防抖 timer（500ms,最长 5000ms）→ flushNow → isSyncing=true
 *                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                    这段 isSyncing 恒为 false,但内存里已有未落盘的编辑
 *   三条 reload 通道（广播 / 聚焦 / 短轮询）都用 isSyncing 做守卫 ⇒ 防抖窗内全部畅通
 *   ⇒ reloadFromStorageQuiet 整表覆盖 ⇒ 用户的删除被磁盘数据复活,且 syncError 为 null（完全静默）。
 *
 * 根因:isSyncing（IPC 在途）≠ dirty（内存有未落盘编辑）。缺的是后者这个概念。
 *
 * 终点断言 = 用户的删除在**内存与磁盘**上都存活,不是"某函数被调用了"。
 *
 * 单独一个文件:flushSaveImmediately 的 finally 有 fire-and-forget 对账,跨用例会污染别的 fake 盘面。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import { mkAcc, makeFakeMain, CLEAN_STATE } from './fixtures'

beforeEach(() => {
  useAccountsStore.setState({ ...CLEAN_STATE })
})

afterEach(() => {
  useAccountsStore.getState().stopAutoSave()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 建立「用户删了 3 个账号,落盘还在防抖窗里等」这个状态,并让外部写把磁盘 revision 推高 */
async function arrangeDirtyWindow(): Promise<{
  fake: ReturnType<typeof makeFakeMain>
  savePromise: Promise<void>
}> {
  const fake = makeFakeMain({
    accounts: { A: mkAcc('A'), B: mkAcc('B'), C: mkAcc('C'), D: mkAcc('D', 'old-token') }
  })
  await useAccountsStore.getState().loadFromStorage()
  expect(useAccountsStore.getState().currentRevision).toBe(5)

  // 用户删掉 A/B/C —— 只改内存
  const accounts = new Map(useAccountsStore.getState().accounts)
  accounts.delete('A')
  accounts.delete('B')
  accounts.delete('C')
  useAccountsStore.setState({ accounts })

  // 走真实的防抖落盘路径（**不 await** —— 正在等防抖,这正是病灶窗口）
  const savePromise = useAccountsStore.getState().saveToStorage()

  // 此刻 IPC 并未在途
  expect(useAccountsStore.getState().isSyncing).toBe(false)

  // 防抖窗内 main 侧 ProactiveRenewal 刷了 D 的 token → 磁盘 revision 6
  fake.externalWrite((d) => {
    const accs = d.accounts as Record<string, { credentials: { accessToken: string } }>
    accs.D.credentials.accessToken = 'refreshed-token'
    return d
  })

  return { fake, savePromise }
}

/** 防抖到期 → 真实落盘完成 */
async function letDebounceFlush(savePromise: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(600)
  await savePromise
}

describe('防抖窗内的用户编辑 · 三条同步通道都不得复活它（C1-again）', () => {
  it('内存有未落盘编辑时 · 判据必须为真（isSyncing 为假也一样）', async () => {
    vi.useFakeTimers()
    const { savePromise } = await arrangeDirtyWindow()

    // 这就是缺失的概念:IPC 不在途,但内存里有未落盘的删除
    expect(useAccountsStore.getState().isSyncing).toBe(false)
    expect(useAccountsStore.getState().hasPendingLocalEdits()).toBe(true)

    await letDebounceFlush(savePromise)

    // 落盘完成后不再 dirty
    expect(useAccountsStore.getState().hasPendingLocalEdits()).toBe(false)
  })

  it('通道①短轮询/聚焦（syncIfRevisionDrifted）落在防抖窗内 · 3 个删除仍在内存与磁盘上生效', async () => {
    vi.useFakeTimers()
    const { fake, savePromise } = await arrangeDirtyWindow()

    // 轮询 / 聚焦都走这条：磁盘 revision 确实变了,早退判据挡不住
    await useAccountsStore.getState().syncIfRevisionDrifted()

    // 用户的删除不能被磁盘数据复活
    expect(Array.from(useAccountsStore.getState().accounts.keys()).sort()).toEqual(['D'])

    await letDebounceFlush(savePromise)

    // 终点:磁盘上删除真的发生了,外部刷的 token 也没被按回去
    const disk = fake.disk.accounts as Record<string, { credentials: { accessToken: string } }>
    expect(Object.keys(disk).sort()).toEqual(['D'])
    expect(disk.D.credentials.accessToken).toBe('refreshed-token')
    expect(Array.from(useAccountsStore.getState().accounts.keys()).sort()).toEqual(['D'])
  })

  it('通道②广播（reconcilePendingExternalRevision）落在防抖窗内 · 同样不得整表覆盖', async () => {
    vi.useFakeTimers()
    const { fake, savePromise } = await arrangeDirtyWindow()

    // App.tsx 广播 consumer 的动作：先记账,再（在非 dirty 时）补拉
    useAccountsStore.getState().noteExternalRevision(6)
    await useAccountsStore.getState().reconcilePendingExternalRevision()

    expect(Array.from(useAccountsStore.getState().accounts.keys()).sort()).toEqual(['D'])

    await letDebounceFlush(savePromise)

    const disk = fake.disk.accounts as Record<string, unknown>
    expect(Object.keys(disk).sort()).toEqual(['D'])
  })

  it('通道③IDE token 变更（loadFromStorage 全量重载）落在防抖窗内 · 同样不得复活删除', async () => {
    vi.useFakeTimers()
    const { fake, savePromise } = await arrangeDirtyWindow()

    // App.tsx 的 onKiroIdeTokenChanged 原本无条件 loadFromStorage —— 第 4 条通道,同根因
    await useAccountsStore.getState().syncAfterIdeTokenChanged()

    expect(Array.from(useAccountsStore.getState().accounts.keys()).sort()).toEqual(['D'])

    await letDebounceFlush(savePromise)

    const disk = fake.disk.accounts as Record<string, unknown>
    expect(Object.keys(disk).sort()).toEqual(['D'])
  })

  it('被守卫挡下的外部改动不能丢 · 落盘结束后必须补拉回来', async () => {
    vi.useFakeTimers()
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    // 用户改了备注 → 进入防抖窗
    const accounts = new Map(useAccountsStore.getState().accounts)
    accounts.set('A', { ...accounts.get('A')!, nickname: 'MY-EDIT' } as never)
    useAccountsStore.setState({ accounts })
    const savePromise = useAccountsStore.getState().saveToStorage()

    // 防抖窗内手机端导入了新账号 + 广播到达（被守卫挡下,必须记账）
    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).FROM_PHONE = mkAcc('FROM_PHONE')
      return d
    })
    useAccountsStore.getState().noteExternalRevision(6)
    await useAccountsStore.getState().reconcilePendingExternalRevision()
    expect(useAccountsStore.getState().accounts.has('FROM_PHONE')).toBe(false)

    await letDebounceFlush(savePromise)

    // 我的编辑与别人的新增都在（合并重放 + 挡下后对账补拉,两者都没丢）
    const disk = fake.disk.accounts as Record<string, { nickname?: string }>
    expect(Object.keys(disk).sort()).toEqual(['A', 'FROM_PHONE'])
    expect(disk.A.nickname).toBe('MY-EDIT')
    expect(useAccountsStore.getState().accounts.has('FROM_PHONE')).toBe(true)
  })
})
