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
import {
  inspectAccountIdentityAudit,
  type AccountIdentityAuditIssue
} from '../../shared/accountIdentity'
import { proxyLogStore } from '../proxy/logger'

/** 同一个已装配 store 每个进程只做一次启动审计；HTTP 轮询 loadAccounts 不重复刷屏。 */
const identityAuditedStores = new WeakSet<object>()

function persistAuditLogForServer(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  data?: unknown
): void {
  // Electron 壳的 console 已由 interceptConsole 转入 proxyLogStore；裸 Node 服务端没有该拦截，
  // 因而只在服务端补写持久通道，避免桌面日志出现两份完全相同的记录。
  if (
    typeof process.versions.electron === 'string' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  ) {
    return
  }
  try {
    proxyLogStore.add({
      timestamp: new Date().toISOString(),
      level,
      category: 'AccountIdentityAudit',
      message,
      data
    })
  } catch (error) {
    // 审计日志落盘失败不能阻塞账号加载，但不能静默；固定前缀便于服务端运维检索。
    console.error('[AccountIdentityAudit] failed to persist server audit log:', error)
  }
}

function emitAuditLog(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  data?: unknown
): void {
  if (level === 'ERROR') console.error(message)
  else if (level === 'WARN') console.warn(message)
  else console.log(message)
  persistAuditLogForServer(level, message, data)
}

function describeAuditIssue(issue: AccountIdentityAuditIssue): string {
  return (
    `[AccountIdentityAudit] suspicious account record "${issue.accountId}": ` +
    `${issue.code}; fields=${issue.fields.join(',')}; sources=${issue.sources.join(',')}; ` +
    'report-only, no data changed'
  )
}

async function auditAccountDataOnce(deps: AccountStoreDeps, data: unknown): Promise<void> {
  const store = deps.getStore()
  if (identityAuditedStores.has(store)) return
  identityAuditedStores.add(store)

  let historicalBlobs: readonly unknown[] = []
  if (deps.loadAccountIdentityHistory) {
    try {
      historicalBlobs = await deps.loadAccountIdentityHistory()
    } catch (error) {
      emitAuditLog(
        'WARN',
        '[AccountIdentityAudit] historical identity source unavailable; current data was not changed',
        { error: error instanceof Error ? error.message : String(error) }
      )
    }
  }

  const issues = inspectAccountIdentityAudit(data, historicalBlobs)
  for (const issue of issues) {
    emitAuditLog('WARN', describeAuditIssue(issue), {
      code: issue.code,
      accountId: issue.accountId,
      fields: issue.fields,
      sources: issue.sources,
      relatedIds: issue.relatedIds
    })
  }
  emitAuditLog(
    'INFO',
    `[AccountIdentityAudit] startup scan complete: ${issues.length} suspicious record(s); ` +
      'report-only, no data changed'
  )
}

/**
 * 读取账号数据 blob。
 * @returns 盘上的 accountData；不存在或读取失败时返回 null
 */
export async function loadAccounts(deps: AccountStoreDeps): Promise<unknown> {
  try {
    await deps.ensureStore()
    const data = deps.getStore().get('accountData', null)
    try {
      await auditAccountDataOnce(deps, data)
    } catch (error) {
      // 检测通道是旁路：自身失败只留痕，绝不能把可读的账号数据变成 null。
      emitAuditLog('ERROR', '[AccountIdentityAudit] startup scan failed; account data was not changed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return data
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
