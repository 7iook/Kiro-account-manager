/**
 * 账号数据读写（load / save） · IPC 与 HTTP 面板共用
 *
 * 抽取来源：index.ts:3540 (load-accounts) · :3555 (save-accounts)
 *
 * 行为契约必须逐字保留 —— renderer 26 个组件已适配这些返回形状与错误语义，
 * 任何"顺手统一"都会让用户的按钮全线变红（recon §7.2 第 6 条）：
 *   - load 失败 → 返回 null（不抛），日志 'Failed to load accounts:'
 *   - save 失败 → 向上抛（renderer 依赖 reject 分支），日志 'Failed to save accounts:'
 *   - save 必须走 applyAccountDataMutation 收口（W1 的 revision 乐观锁 SSOT），
 *     不得新增 store.set('accountData', …) 路径
 */
import { applyAccountDataMutation, type AccountsBlob, type ApplyResult } from './state'
import type { AccountStoreDeps } from './types'

/**
 * 读取账号数据 blob。
 * @returns 盘上的 accountData；不存在或读取失败时返回 null
 */
export async function loadAccounts(deps: AccountStoreDeps): Promise<unknown> {
  try {
    await deps.ensureStore()
    return deps.getStore().get('accountData', null)
  } catch (error) {
    // 保留既有容错：读盘失败不能让前端崩溃，返回 null 走空列表分支。
    // 不是"吞异常返回成功"—— null 本身就是「无数据」的合法返回值，且已记录日志。
    console.error('Failed to load accounts:', error)
    return null
  }
}

/**
 * 保存账号数据 blob（走 revision 乐观锁仲裁）。
 *
 * @param payload 整表 blob + 两个仲裁参数：
 *   - expectedRevision：客户端持有的 revision；不匹配 → { ok:false, code:'STALE_REVISION' }
 *     缺省 → 降级为无仲裁直写（向后兼容旧 renderer 调用点）
 *   - originId：发起窗口标识，原样带入广播 payload 供 consumer 区分自写回声
 *   两者均**不入盘**。
 *
 * @throws 写盘异常向上抛（renderer 依赖 reject 分支显示保存失败）
 */
export async function saveAccounts(
  deps: AccountStoreDeps,
  payload: { expectedRevision?: number; originId?: string; [k: string]: unknown }
): Promise<ApplyResult> {
  try {
    await deps.ensureStore()
    // 剥离仲裁参数；rest 展开产生**新对象**，不修改调用方传入的 payload
    const { expectedRevision, originId, ...blob } = payload ?? {}
    const result = await applyAccountDataMutation(() => blob as AccountsBlob, {
      ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
      ...(typeof originId === 'string' ? { originId } : {})
    })

    if (result.ok) {
      // lastSavedData 由收口内部的 setLastSavedDataSetter 同步（带新 revision 的 toPersist）；
      // 这里再赋一次是保留历史信号语义 —— 装配未完成时收口的 setter 尚未注入，
      // 否则 lastSavedData 会永久为 null，崩溃恢复拿不到东西（M1 评审已确认为有意冗余）。
      deps.setLastSavedData(blob)

      // 每次成功保存都创建备份；STALE 时不备份陈旧快照
      await deps.createBackup(blob)
    }

    return result
  } catch (error) {
    console.error('Failed to save accounts:', error)
    throw error
  }
}
