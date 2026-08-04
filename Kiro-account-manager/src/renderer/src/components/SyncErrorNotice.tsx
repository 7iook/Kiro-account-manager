/**
 * 跨端同步冲突提示（C2 返修 · 用户裁决:弹窗立刻告知）
 *
 * 为什么需要它:`syncError` 原来只写进 store、没有任何 UI 消费点 ⇒ 对用户依然是**静默**。
 * 用户点了删除、界面上账号消失了（内存态）、磁盘从未写入、下次启动全部回来 ——
 * 与修复前的可见现象没有区别。「静默」是首轮 C1 判据的一半,不闭合就不算修好。
 *
 * 为什么用 alert:项目现有错误提示全部是 alert（renderer 无 toast 基建,
 * `git grep toast -- src/renderer/` 零命中）。照既有方式做,不为这一个提示引入新的提示系统。
 *
 * 分层:store 不直接调 alert（store 是数据层,不该碰宿主 UI API）。
 * 由本组件订阅 syncError 后弹出,弹完调 clearSyncError 避免重复弹。
 */
import { useEffect } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'

export function SyncErrorNotice(): null {
  const syncError = useAccountsStore((s) => s.syncError)
  const { t } = useTranslation()

  useEffect(() => {
    if (!syncError) return
    // 与项目其它文案一致的语言判定方式（照 SettingsPage.tsx:200 的既有做法）
    const isEn = t('common.unknown') === 'Unknown'
    window.alert(
      isEn
        ? 'Your latest change could not be saved — another device or the background token refresh kept modifying the same data. The list has been synced to the newest state; please redo your change.'
        : '这次改动没保存成功（另一端或后台自动续期一直在改同一份数据）。界面已同步到最新，请重新操作。'
    )
    useAccountsStore.getState().clearSyncError()
  }, [syncError, t])

  return null
}

export default SyncErrorNotice
