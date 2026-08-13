/**
 * 无头自动换号生产接线门禁。
 *
 * 行为单测只能证明调度器“能工作”，不能证明生产装配真的启动了它，也不能证明 shutdown
 * 会等待在途决策。这里锁住服务端装配与桌面主进程入口都指向 accountService 的同一实现。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

function source(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

describe('无头自动换号调度器生产接线', () => {
  it('server assembly 创建并启动 accountService 的共享调度器', () => {
    const assembly = source('src/main/server/assembly.ts')

    expect(assembly).toMatch(
      /import\s*\{[^}]*createAutoSwitchScheduler[^}]*\}\s*from\s*['"]\.\.\/accountService\/autoSwitch['"]/
    )
    expect(assembly).toContain('autoSwitchScheduler.start()')
  })

  it('server 重启先对账仍有效的持久化决定，再启动下一轮调度', () => {
    const assembly = source('src/main/server/assembly.ts')
    const reconcileAt = assembly.indexOf(
      'const persistedDecision = getCurrentAutoSwitchDecision('
    )
    const startAt = assembly.indexOf('autoSwitchScheduler.start()')

    expect(reconcileAt).toBeGreaterThan(-1)
    expect(startAt).toBeGreaterThan(reconcileAt)
    expect(assembly).toContain('store.get(AUTO_SWITCH_APPLIED_DECISION_KEY)')
    expect(assembly).toContain(
      'store.set(AUTO_SWITCH_APPLIED_DECISION_KEY, decision.id)'
    )
  })

  it('shutdown 先停止并等待调度器，再 drain 持久化队列', () => {
    const assembly = source('src/main/server/assembly.ts')
    const stopAt = assembly.indexOf('await autoSwitchScheduler.stop()')
    const drainAt = assembly.indexOf('await options.persistence?.drain()')

    expect(stopAt).toBeGreaterThan(-1)
    expect(drainAt).toBeGreaterThan(stopAt)
  })

  it('桌面现有后台刷新入口只负责接线，同样启动共享主进程调度器', () => {
    const refresh = source('src/main/accountService/backgroundRefresh.ts')

    expect(refresh).toContain('syncDesktopAutoSwitchScheduler(deps)')
    expect(refresh).toMatch(
      /import\s*\{[^}]*syncDesktopAutoSwitchScheduler[^}]*\}\s*from\s*['"]\.\/autoSwitch['"]/
    )
  })

  it('服务端只推进全局激活编排，不绕过请求级 API-key 账号绑定过滤', () => {
    const assembly = source('src/main/server/assembly.ts')
    const serverSwitch = assembly.slice(
      assembly.indexOf('function applyServerAutoSwitchDecision'),
      assembly.indexOf('// ============ deps 装配 ============')
    )
    const proxySelection = source('src/main/proxy/proxyServer.ts')
    const singleAccountSelection = proxySelection.slice(
      proxySelection.indexOf('// 单账号模式的所有候选路径共用这一份准入 + 可用性判据'),
      proxySelection.indexOf('// 自动切换 K-Proxy 设备 ID')
    )

    expect(serverSwitch).toContain('activateProxyAccount(')
    expect(serverSwitch).not.toContain('getNextAvailableAccount(')
    // 真正替某个 API key 选号时，选中项和 fallback 都必须再次通过 isAllowed。
    expect(singleAccountSelection).toContain('isAllowed(acc)')
    expect(singleAccountSelection).toContain('.filter(acc => !isAllowed(acc))')
    expect(singleAccountSelection).toContain('no usable allowed account')
  })
})
