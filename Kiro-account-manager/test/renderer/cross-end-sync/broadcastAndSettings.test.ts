/**
 * A-I2 + B-I1 + I3 返修
 *
 *   A-I2: isSyncing 反检会永久吞掉外部广播（原实现命中后直接 return,不留痕迹）
 *   B-I1: reloadFromStorageQuiet 同步了设置**值**但不施加副作用 ⇒ UI 显示与实际行为不一致
 *   I3  : 决策卡指定的兜底（聚焦比对 revision + 短轮询）0 命中,使广播成为唯一同步通道
 *
 * 断言策略:落在**真实可观测结果**上,不用 vi.spyOn 盯 store 方法。
 *   - 主题 → 断言 document.documentElement 上真实的 class（applyTheme 的实际产物）
 *   - 定时器 → 用 fake timers 推进时间,断言真实的触发节奏（"显示 10 分钟实际跑 5 分钟"正是本 bug）
 *   - 代理 → 断言 IPC 边界被调用（跨进程边界,mock 合理）
 * 顺带避开一个坑:vi.spyOn(useAccountsStore.getState(), fn) 会被后续 set() 展开进新 state 对象,
 * restoreAllMocks 只还原旧对象 ⇒ spy 泄漏到后续用例（本文件第一版就踩了这个）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAccountsStore } from '@/store/accounts'
import { mkAcc, makeFakeMain, CLEAN_STATE } from './fixtures'

/** 记录 checkAndAutoSwitch 的真实触发时刻 —— 它是自动换号定时器的唯一动作 */
let switchTicks: number[]

beforeEach(() => {
  switchTicks = []
  useAccountsStore.setState({
    ...CLEAN_STATE,
    // 换掉最底层的网络动作（真实实现会打上游 API）,保留定时器逻辑本体
    checkAndAutoSwitch: async () => {
      switchTicks.push(Date.now())
    }
  })
  document.documentElement.className = ''
})

afterEach(() => {
  useAccountsStore.getState().stopAutoSwitch()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('外部广播落在本机写入窗口内 · 不能被永久吞掉（A-I2）', () => {
  it('本机写入期间到达的外部改动 · 对账时必须被补拉回来,不能等到用户下次编辑', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    // 广播 revision=6 在本机写入在途时到达 → 记账（原实现在这里直接 return,信号丢失）
    useAccountsStore.setState({ isSyncing: true })
    useAccountsStore.getState().noteExternalRevision(6)

    // 本机写入随后成功把本地 revision 推到 7
    // （现状 bug 的关键:此后本地 revision > 6,revision 反检永久失效,那条外部写再也拉不回来）
    useAccountsStore.setState({ currentRevision: 7, isSyncing: false })

    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).EXTERNAL = mkAcc('EXTERNAL')
      return d
    })

    await useAccountsStore.getState().reconcilePendingExternalRevision()

    expect(useAccountsStore.getState().accounts.has('EXTERNAL')).toBe(true)
  })

  it('自己写入产生的回声 · 不触发补拉(否则每次保存都白读一次盘)', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()
    const loadCountBefore = fake.api.loadAccounts.mock.calls.length

    useAccountsStore.getState().noteExternalRevision(6, { selfOrigin: true })
    await useAccountsStore.getState().reconcilePendingExternalRevision()

    expect(fake.api.loadAccounts.mock.calls.length).toBe(loadCountBefore)
  })

  it('写入在途时对账 · 推迟而不丢弃,写入结束后仍能补上', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    useAccountsStore.setState({ isSyncing: true })
    useAccountsStore.getState().noteExternalRevision(6)
    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).LATER = mkAcc('LATER')
      return d
    })

    // 写入在途 ⇒ 不能整表覆盖（会踩掉正在提交的内存状态）
    await useAccountsStore.getState().reconcilePendingExternalRevision()
    expect(useAccountsStore.getState().accounts.has('LATER')).toBe(false)

    // 写入结束后对账把它补上（信号没丢）
    useAccountsStore.setState({ isSyncing: false })
    await useAccountsStore.getState().reconcilePendingExternalRevision()
    expect(useAccountsStore.getState().accounts.has('LATER')).toBe(true)
  })
})

describe('跨端改设置 · 同步了值就必须真的生效（B-I1）', () => {
  it('另一端把换号间隔从 5 改成 10 分钟 · 定时器真的按 10 分钟跑,不是显示 10 实跑 5', async () => {
    vi.useFakeTimers()
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A') },
      autoSwitchEnabled: true,
      autoSwitchInterval: 5
    })
    await useAccountsStore.getState().loadFromStorage()
    useAccountsStore.getState().startAutoSwitch() // 建立 5 分钟节奏的定时器

    // 另一端改成 10 分钟
    fake.externalWrite((d) => ({ ...d, autoSwitchInterval: 10 }))
    await useAccountsStore.getState().reloadFromStorageQuiet()
    expect(useAccountsStore.getState().autoSwitchInterval).toBe(10)

    switchTicks = []
    // 推进 5 分钟:若定时器仍是旧的 5 分钟节奏,这里就会触发 —— 那正是 B-I1 的病灶
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(switchTicks.length).toBe(0)

    // 再推进到第 10 分钟:按新值应当触发
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(switchTicks.length).toBe(1)
  })

  it('另一端关掉了自动换号 · 定时器真的停了,不再偷偷换号', async () => {
    vi.useFakeTimers()
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A') },
      autoSwitchEnabled: true,
      autoSwitchInterval: 5
    })
    await useAccountsStore.getState().loadFromStorage()
    useAccountsStore.getState().startAutoSwitch()

    fake.externalWrite((d) => ({ ...d, autoSwitchEnabled: false }))
    await useAccountsStore.getState().reloadFromStorageQuiet()

    switchTicks = []
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(switchTicks.length).toBe(0)
  })

  it('另一端改了主题 · 本端界面真的变色(DOM class 变了),不是只存值等重启', async () => {
    const fake = makeFakeMain({ accounts: {}, theme: 'default', darkMode: false })
    await useAccountsStore.getState().loadFromStorage()

    fake.externalWrite((d) => ({ ...d, theme: 'ocean', darkMode: true }))
    await useAccountsStore.getState().reloadFromStorageQuiet()

    expect(useAccountsStore.getState().theme).toBe('ocean')
    // 真实产物:applyTheme 把类挂到 documentElement 上（原实现不调它 ⇒ 跨端改主题桌面端不变色）
    expect(document.documentElement.classList.contains('theme-ocean')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('另一端改了代理设置 · 必须通知主进程真正切换,不只是存个值', async () => {
    const fake = makeFakeMain({ accounts: {}, proxyEnabled: false, proxyUrl: '' })
    await useAccountsStore.getState().loadFromStorage()

    fake.externalWrite((d) => ({ ...d, proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897' }))
    await useAccountsStore.getState().reloadFromStorageQuiet()

    expect(fake.api.setProxy).toHaveBeenCalledWith(true, 'http://127.0.0.1:7897')
  })

  it('设置值没变时不做多余副作用(避免每次广播都重建定时器/闪主题)', async () => {
    vi.useFakeTimers()
    const fake = makeFakeMain({
      accounts: { A: mkAcc('A') },
      autoSwitchEnabled: true,
      autoSwitchInterval: 5,
      theme: 'default'
    })
    await useAccountsStore.getState().loadFromStorage()
    useAccountsStore.getState().startAutoSwitch()

    switchTicks = []
    // 只有账号变了,设置一个都没动
    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).NEW = mkAcc('NEW')
      return d
    })
    await useAccountsStore.getState().reloadFromStorageQuiet()

    expect(useAccountsStore.getState().accounts.has('NEW')).toBe(true)
    // startAutoSwitch 会立即跑一次 checkAndAutoSwitch;若被无谓重启,这里就会多出一次触发
    expect(switchTicks.length).toBe(0)
    expect(fake.api.setProxy).not.toHaveBeenCalled()
  })
})

describe('丢消息兜底 · 广播不是唯一同步通道（I3）', () => {
  it('广播完全没送到 · 聚焦/轮询时比对 revision 并拉取最新状态', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    // 外部写了,但广播丢了（renderer 完全没收到）
    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).GHOST = mkAcc('GHOST')
      return d
    })
    expect(useAccountsStore.getState().accounts.has('GHOST')).toBe(false)

    await useAccountsStore.getState().syncIfRevisionDrifted()

    expect(useAccountsStore.getState().accounts.has('GHOST')).toBe(true)
  })

  it('revision 一致时不做无谓整表覆盖(避免每次切窗口/每 5s 都重建 Map)', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    const mapBefore = useAccountsStore.getState().accounts
    await useAccountsStore.getState().syncIfRevisionDrifted()

    // 引用不变 = 没有整表 set（不会引发无谓 re-render）
    expect(useAccountsStore.getState().accounts).toBe(mapBefore)
    // 只允许一次轻量比对读
    expect(fake.api.loadAccounts.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('本机写入在途时聚焦 · 不整表覆盖,记账留待写入结束后对账', async () => {
    const fake = makeFakeMain({ accounts: { A: mkAcc('A') } })
    await useAccountsStore.getState().loadFromStorage()

    useAccountsStore.setState({ isSyncing: true })
    fake.externalWrite((d) => {
      ;(d.accounts as Record<string, unknown>).LATER = mkAcc('LATER')
      return d
    })

    await useAccountsStore.getState().syncIfRevisionDrifted()
    expect(useAccountsStore.getState().accounts.has('LATER')).toBe(false)

    useAccountsStore.setState({ isSyncing: false })
    await useAccountsStore.getState().reconcilePendingExternalRevision()
    expect(useAccountsStore.getState().accounts.has('LATER')).toBe(true)
  })
})
