// TDD: 主进程 stdio 错误收口(2026-08-05 main-process-epipe-crash RCA §6)
//
// 为什么这些断言长这样:EPIPE 在管道场景是**异步**报出的 —— 写入先入队,
// 失败在后续 tick 由流 emit('error')。所以本测试用 emit('error') 而非
// 直接调 write() 来复现,这正是调用点 try-catch 拦不住的那条路径(RCA 假设 B)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import { installStdioGuard, _internal } from '@main/utils/stdioGuard'

/** 造一个可 emit('error') 的假 stdio 流 */
function mkStream(): EventEmitter {
  return new EventEmitter()
}

function mkErr(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  e.code = code
  return e
}

describe('stdioGuard · 管道断开不得崩主进程', () => {
  let stdout: EventEmitter
  let stderr: EventEmitter
  let proc: EventEmitter & { on: EventEmitter['on'] }

  beforeEach(() => {
    _internal.reset()
    stdout = mkStream()
    stderr = mkStream()
    proc = new EventEmitter() as never
  })

  afterEach(() => {
    _internal.reset()
    vi.restoreAllMocks()
  })

  it('stdout 异步 EPIPE 被吞掉(无监听时 EventEmitter 会 throw)', () => {
    installStdioGuard({ stdout, stderr, proc } as never)
    // 无监听器时 emit('error') 直接 throw —— 这就是弹窗的成因
    expect(() => stdout.emit('error', mkErr('EPIPE'))).not.toThrow()
  })

  it('stderr 异步 EPIPE 同样被吞掉(IPC-TRACE 那条 60s timer 的路径)', () => {
    installStdioGuard({ stdout, stderr, proc } as never)
    expect(() => stderr.emit('error', mkErr('EPIPE'))).not.toThrow()
  })

  it('ERR_STREAM_DESTROYED / EBADF 同属管道消失,一并吞掉', () => {
    installStdioGuard({ stdout, stderr, proc } as never)
    expect(() => stdout.emit('error', mkErr('ERR_STREAM_DESTROYED'))).not.toThrow()
    expect(() => stderr.emit('error', mkErr('EBADF'))).not.toThrow()
  })

  it('非管道类错误必须重抛 —— 不得把真 bug 变成静默失败', () => {
    installStdioGuard({ stdout, stderr, proc } as never)
    const boom = mkErr('ENOSPC')
    expect(() => stdout.emit('error', boom)).toThrow(boom)
  })

  it('幂等:重复安装不重复注册监听器', () => {
    installStdioGuard({ stdout, stderr, proc } as never)
    installStdioGuard({ stdout, stderr, proc } as never)
    installStdioGuard({ stdout, stderr, proc } as never)
    expect(stdout.listenerCount('error')).toBe(1)
    expect(stderr.listenerCount('error')).toBe(1)
    expect(proc.listenerCount('uncaughtException')).toBe(1)
  })

  it('uncaughtException 里来源可证的 EPIPE 被吞(冒到顶层的那一路兜底)', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const e = mkErr('EPIPE')
    e.stack = 'Error: EPIPE\n    at writeOrBuffer (node:internal/streams/writable:572:12)'
    proc.emit('uncaughtException', e)
    // stdio 来源的 EPIPE 属预期噪声,不该上报为致命错误
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('uncaughtException 里的真错误交给 onFatal 接管,且不得再抛', () => {
    // 不抛是刻意的:Electron init.ts 见到 listenerCount>1 就不弹窗了,
    // 而在 uncaughtException 处理器内 throw 会让 Node 硬退 —— 那是静默猝死,
    // 比原本的可见弹窗更糟。故由 onFatal(装配侧)负责落盘 + 复现弹窗。
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const boom = new Error('real bug')
    expect(() => proc.emit('uncaughtException', boom)).not.toThrow()
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0][0]).toBe(boom)
    expect(onFatal.mock.calls[0][1]).toBe('uncaughtException')
  })

  it('unhandledRejection 同样区分 stdio EPIPE 与真错误', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const pipe = mkErr('EPIPE')
    pipe.stack = 'Error: EPIPE\n    at writeOrBuffer (node:internal/streams/writable:572:12)'
    proc.emit('unhandledRejection', pipe)
    expect(onFatal).not.toHaveBeenCalled()
    proc.emit('unhandledRejection', new Error('real rejection'))
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0][1]).toBe('unhandledRejection')
  })

  it('onFatal 自己抛错不得二次崩溃', () => {
    const onFatal = vi.fn(() => { throw new Error('logger died') })
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    expect(() => proc.emit('uncaughtException', new Error('original'))).not.toThrow()
  })
})

describe('stdioGuard · 来源可证才静默(异构评审 p0 回归)', () => {
  let stdout: EventEmitter
  let stderr: EventEmitter
  let proc: EventEmitter

  beforeEach(() => {
    _internal.reset()
    stdout = mkStream()
    stderr = mkStream()
    proc = new EventEmitter()
  })

  afterEach(() => { _internal.reset() })

  it('非 stdio 来源的 EPIPE 必须上报,不得静默 —— 网络 socket 断连', () => {
    // 这是修复前的缺陷:顶层只看 code,把网络层 EPIPE 也吞了
    // → 应用既不弹窗也不落盘,带病继续跑
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const netErr = mkErr('EPIPE')
    netErr.stack = 'Error: EPIPE\n    at Socket._write (node:internal/some-upstream-api)\n    at ProxyServer.forward (src/main/proxy/proxyServer.ts:1)'
    proc.emit('uncaughtException', netErr)
    expect(
      onFatal,
      '非 stdio 来源的 EPIPE 被静默 —— 真故障变静默失败'
    ).toHaveBeenCalledTimes(1)
  })

  it('非 stdio 来源的 EBADF / ERR_STREAM_DESTROYED 同样必须上报', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    for (const code of ['EBADF', 'ERR_STREAM_DESTROYED']) {
      const e = mkErr(code)
      e.stack = `Error: ${code}\n    at FileWriter.write (src/main/somewhere.ts:1)`
      proc.emit('uncaughtException', e)
    }
    expect(onFatal).toHaveBeenCalledTimes(2)
  })

  it('流级监听放行过的那个错误对象,冒到顶层时按 stdio 静默(异步路径)', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const e = mkErr('EPIPE')
    stdout.emit('error', e)          // 流级识别 → 打来源标记
    proc.emit('uncaughtException', e) // 同一对象冒到顶层
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('栈帧命中 Node stdio 写入实现帧的 EPIPE 按 stdio 静默(同步路径)', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const e = mkErr('EPIPE')
    // 用户弹窗里的真实堆栈形状
    e.stack = [
      'Error: EPIPE: broken pipe, write',
      '    at Socket._write (node:net:63:18)',
      '    at writeOrBuffer (node:internal/streams/writable:572:12)',
      '    at console.log (node:internal/console/constructor:384:26)'
    ].join('\n')
    proc.emit('uncaughtException', e)
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('stdio 栈帧上的非管道错误(ENOSPC)必须上报 —— 栈对但码不对', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const e = mkErr('ENOSPC')
    e.stack = 'Error: ENOSPC\n    at writeOrBuffer (node:internal/streams/writable:572:12)'
    proc.emit('uncaughtException', e)
    expect(onFatal).toHaveBeenCalledTimes(1)
  })

  it('无 stack 的管道类错误按真错误上报(不可证来源 → 偏保守)', () => {
    const onFatal = vi.fn()
    installStdioGuard({ stdout, stderr, proc, onFatal } as never)
    const e = mkErr('EPIPE')
    e.stack = undefined
    proc.emit('uncaughtException', e)
    expect(onFatal).toHaveBeenCalledTimes(1)
  })
})
