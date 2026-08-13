/**
 * 自动换号调度器所有权门禁。
 *
 * 本缺口不能靠“服务端也加一个 timer”修：renderer timer 与 server timer 同时存在时，
 * 两边会基于不同快照各自换号。这里直接锁死 renderer 只能发送一次启动信号和执行
 * 桌面专属副作用，不能再持有周期调度器或阈值决策。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../..')

function source(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

describe('自动换号只有主进程调度器', () => {
  it('renderer store 不再声明或启动自动换号 timer/决策函数', () => {
    const src = source('src/renderer/src/store/accounts.ts')

    expect(src).not.toContain('autoSwitchTimer')
    expect(src).not.toMatch(/\bstartAutoSwitch\s*:/)
    expect(src).not.toMatch(/\bstopAutoSwitch\s*:/)
    expect(src).not.toMatch(/\bcheckAndAutoSwitch\s*:/)

    const autoSwitchSection = src.slice(
      src.indexOf('// ==================== 自动换号 ===================='),
      src.indexOf('// ==================== 自动 Token 刷新 ====================')
    )
    expect(autoSwitchSection).not.toMatch(/\bsetInterval\s*\(/)
    expect(autoSwitchSection).not.toMatch(/\bsetTimeout\s*\(/)
  })

  it('renderer 只通过既有 IPC 发一次主进程调度器同步信号', () => {
    const src = source('src/renderer/src/store/accounts.ts')

    expect(src).toContain('syncMainAutoSwitchScheduler')
    expect(src).toMatch(/backgroundBatchRefresh\s*\(\s*\[\]\s*,/)
  })
})
