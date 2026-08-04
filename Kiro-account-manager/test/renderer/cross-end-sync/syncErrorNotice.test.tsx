/**
 * C2 返修 · 「自动合并耗尽后必须弹窗告知用户,不能只进 store」
 *
 * 用户裁决（决策卡「用户裁决记录」2026-08-03）:弹窗立刻告知
 * ——「这次改动没保存成功，界面已同步到最新，请重新操作」。
 *
 * 被治的病灶（reviewer C2）:syncError 有 3 个写入点、0 个 UI 消费点。
 *   用户点了删除 → 界面上账号消失（内存态）→ 磁盘从未写入 → 下次启动全部回来。
 *   `console.error` 只在 devtools 可见 ⇒ 对普通用户与修复前的可见现象没有区别。
 *
 * 断言落在**用户屏幕上真的出现了提示**（window.alert 被调用 + 文案含关键信息）,
 * 不是"store 里有 syncError 字段"——后者正是被判 critical 的那个状态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import { useAccountsStore } from '@/store/accounts'
import { SyncErrorNotice } from '@/components/SyncErrorNotice'

let alertSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  useAccountsStore.setState({ syncError: null })
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  useAccountsStore.setState({ syncError: null })
  vi.restoreAllMocks()
})

describe('跨端同步冲突无法自动合并 · 用户必须立刻看到提示（C2）', () => {
  it('syncError 出现时弹窗告知用户「没保存成功 + 已同步到最新 + 请重新操作」', async () => {
    useAccountsStore.setState({ language: 'zh' })
    render(<SyncErrorNotice />)

    // 渲染时无冲突 ⇒ 不该弹
    expect(alertSpy).not.toHaveBeenCalled()

    // 合并重放耗尽 → store 置 syncError
    useAccountsStore.setState({
      syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: 3, at: Date.now() }
    })

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    const msg = String(alertSpy.mock.calls[0][0])
    expect(msg).toContain('没保存成功')
    expect(msg).toContain('重新操作')
  })

  it('弹过一次就清掉 syncError · 不重复弹窗骚扰用户', async () => {
    useAccountsStore.setState({ language: 'zh' })
    render(<SyncErrorNotice />)

    useAccountsStore.setState({
      syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: 3, at: Date.now() }
    })
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))

    // 清掉后再触发一次无关的 set,不应再弹
    await waitFor(() => expect(useAccountsStore.getState().syncError).toBeNull())
    useAccountsStore.setState({ privacyMode: true })
    expect(alertSpy).toHaveBeenCalledTimes(1)

    // 下一次真的又冲突了 → 应当再弹（不是只弹一辈子一次）
    useAccountsStore.setState({
      syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: 3, at: Date.now() + 1 }
    })
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2))
  })

  it('英文界面下用英文文案提示（i18n 照项目既有方式）', async () => {
    useAccountsStore.setState({ language: 'en' })
    render(<SyncErrorNotice />)

    useAccountsStore.setState({
      syncError: { code: 'SYNC_CONFLICT_UNRESOLVED', attempts: 3, at: Date.now() }
    })

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(String(alertSpy.mock.calls[0][0])).toContain('could not be saved')
  })
})
