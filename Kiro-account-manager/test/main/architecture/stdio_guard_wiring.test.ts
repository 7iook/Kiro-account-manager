/**
 * stdio 收口装配闸门 —— 防 E-052「建而未接」+ 锁定装配时点与 onFatal 契约
 *
 * 2026-08-05 EPIPE 崩溃修复的三条不变量。前两条防死代码，第三条防「修复本身
 * 引入更严重的回归」：
 *
 *   1. 生产路径确有调用者（不是只存在于测试里）。
 *   2. 装配必须在 app ready 之前 —— 打包版无 TTY 启动时，启动早期的日志就能
 *      触发 EPIPE；放进 whenReady 等于漏掉那个窗口。判据用「出现在 whenReady
 *      之前」这个位置关系，而不是相信注释。
 *   3. **必须传 onFatal**。一旦注册 uncaughtException 监听，Electron
 *      lib/browser/init.ts 里的 `listenerCount('uncaughtException') > 1 → return`
 *      就让它自带的 showErrorBox 永久沉默。若不传 onFatal，非管道类真错误既不
 *      弹窗也不落盘 → 「可见崩溃」变「静默猝死」，比原 bug 更糟。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

/** 去掉注释，避免「注释里提到了」被当成真实调用 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('装配闭环: stdio 收口在生产路径上确有调用者', () => {
  it('index.ts 确实 import 并调用了 installStdioGuard', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(src).toMatch(/import\s*\{\s*installStdioGuard\s*\}\s*from\s*'\.\/utils\/stdioGuard'/)
    expect(
      src,
      'installStdioGuard 未被调用 —— 模块建了但 EPIPE 照样崩'
    ).toMatch(/installStdioGuard\s*\(/)
  })

  it('装配时点在 app ready 之前(晚于 ready 会漏掉启动早期的 EPIPE)', () => {
    const src = stripComments(read('src/main/index.ts'))
    const guardIdx = src.indexOf('installStdioGuard(')
    const readyIdx = src.indexOf('app.whenReady(')
    expect(guardIdx, 'installStdioGuard 调用不存在').toBeGreaterThan(-1)
    expect(readyIdx, 'app.whenReady 不存在，无法界定时点').toBeGreaterThan(-1)
    expect(
      guardIdx,
      'installStdioGuard 必须在 app.whenReady 之前调用'
    ).toBeLessThan(readyIdx)
  })

  it('装配在模块顶层执行,不是藏在从未被调用的函数里', () => {
    // 闸门若只做「文本出现 + 位置在 whenReady 之前」的判定,把调用塞进一个死函数
    // 里同样能过关,但生产进程其实没有监听器(E-052 的经典形状)。
    // 判据:installStdioGuard( 所在行必须是顶层语句 —— 行首无缩进。
    const raw = read('src/main/index.ts')
    const lines = raw.split(/\r?\n/)
    const callLines = lines.filter(l => /installStdioGuard\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/^import\b/.test(l))
    expect(callLines.length, 'installStdioGuard 调用不存在').toBeGreaterThan(0)
    expect(
      callLines.some(l => /^installStdioGuard\s*\(/.test(l)),
      'installStdioGuard 未在模块顶层调用（行首有缩进 = 可能位于函数体内，可能永不执行）'
    ).toBe(true)
  })

  it('必须传 onFatal —— 否则真错误既不弹窗也不落盘(静默猝死)', () => {
    const src = stripComments(read('src/main/index.ts'))
    const idx = src.indexOf('installStdioGuard(')
    const block = src.slice(idx, idx + 1400)
    expect(block, 'installStdioGuard 未传 onFatal').toMatch(/onFatal\s*:/)
    // 落盘必须走真会写盘的那条路。proxyLogger 的文件流默认 enabled:false 且
    // 全仓无 configure() 调用 —— 用它等于没落盘（异构评审 p1）。
    expect(
      block,
      'onFatal 未落盘到 proxyLogStore —— proxyLogger 默认不写磁盘,等于没留痕'
    ).toMatch(/proxyLogStore\.add\s*\(/)
    expect(
      block,
      'onFatal 未强制 flush —— 进程可能在定时保存前就没了'
    ).toMatch(/flushSaveNow\s*\(/)
    expect(block, 'onFatal 未补回错误弹窗 —— 可见崩溃变静默猝死').toMatch(/dialog\.showErrorBox\s*\(/)
  })
})

describe('收口单一真源: 不得在下游逐点补丁', () => {
  it('stdioGuard 是唯一注册 stdout/stderr error 与顶层兜底的地方', () => {
    for (const rel of [
      'src/main/proxy/logger.ts',
      'src/main/utils/emitToRenderer.ts'
    ]) {
      const src = stripComments(read(rel))
      expect(
        src,
        `${rel} 不得自己注册 stdio 'error' 监听 —— 收口真源只有 utils/stdioGuard.ts`
      ).not.toMatch(/process\.(stdout|stderr)\.on\s*\(/)
      expect(
        src,
        `${rel} 不得自己注册 uncaughtException —— 多处注册会互相抑制`
      ).not.toMatch(/process\.on\s*\(\s*'uncaughtException'/)
    }
  })

  it('stdioGuard 本身不得 import electron(要能在 node 环境单测)', () => {
    const src = read('src/main/utils/stdioGuard.ts')
    expect(src).not.toMatch(/from\s*'electron'/)
  })
})
