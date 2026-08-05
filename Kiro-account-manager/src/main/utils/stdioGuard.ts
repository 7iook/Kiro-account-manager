// 主进程 stdio 错误收口（进程级 I/O 失效的唯一承接点）
//
// 2026-08-05 修复「A JavaScript error occurred in the main process · Error: EPIPE broken pipe, write」
// 两个弹窗（RCA: .agent-workspace/.archive/2026-08-05/main-process-epipe-crash/）。
//
// 为什么必须在这一层收口，而不是在每个日志调用点包 try-catch：
//   process.stdout / stderr 指向管道（非 TTY）时是异步 net.Socket —— 写入先入队，
//   失败在**后续 tick** 由流 emit('error')。EventEmitter 对无监听的 'error' 一律 throw，
//   于是冒成主进程未处理异常 → Electron 弹模态框。
//   实证：emitToRenderer.ts:150 那圈 try/catch 明明存在却仍崩溃 —— 同步 catch
//   在结构上拦不到异步事件。弹窗堆栈显示的是 Error 构造点（write 调用栈），不是抛出点。
//   因此逐 sink 打补丁既无效、又会造出第二个收口真源。
//
// 覆盖范围：一次安装即覆盖全仓所有 console.*（logger.ts 的 original*.apply 三处）
// 与所有 process.stderr.write（emitToRenderer.ts 四处），无需下游改一行。
//
// ⚠️ 不要把白名单放宽成「吞掉所有错误」：那会把真 bug 变成静默失败，
// 比崩溃更难诊断。非管道类错误一律原样重抛，单测 stdioGuard.test.ts 正向锁定。
import type { EventEmitter } from 'node:events'

/**
 * 视为「管道已消失」的错误码。
 *   EPIPE                : 对端关闭后继续写（父终端被关 / 启动器先退）
 *   ERR_STREAM_DESTROYED : 流已销毁后仍有排队写入落地
 *   EBADF                : 继承的 fd 失效（无 TTY 启动场景）
 *
 * ⚠️ 这三个码**只在流级监听里**用于判定，因为那里的来源已由事件源本身确定
 * （错误就是 stdout/stderr 这个流发出的，不需要猜）。
 * 顶层兜底**不得**按码判定 —— 见 handleTopLevel 处的长注释。
 */
const PIPE_GONE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'EBADF'])

function isPipeGone(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' && PIPE_GONE_CODES.has(code)
}

/**
 * 打在错误对象上的来源标记。
 *
 * 为什么需要它：顶层 uncaughtException 拿到的错误**不带来源信息**。若仅凭
 * `code === 'EPIPE'` 就静默，那么网络 socket / 文件流 / 原生插件抛出的 EPIPE
 * 也会被一并吞掉 —— 既不弹窗也不落盘，应用带病继续跑。那是比原 bug 更隐蔽的故障。
 * 所以顶层只静默**我们自己在 stdio 上识别并放行过**的那个错误对象（按身份，不按码）。
 */
const STDIO_ORIGIN = Symbol('stdioGuard.origin')

function markStdioOrigin(err: unknown): void {
  if (err != null && typeof err === 'object') {
    try {
      Object.defineProperty(err, STDIO_ORIGIN, { value: true, enumerable: false, configurable: true })
    } catch { /* 冻结对象等极端情况:放弃标记,顶层会按真错误处理(偏保守,可接受) */ }
  }
}

function isFromStdio(err: unknown): boolean {
  return err != null && typeof err === 'object' && (err as Record<symbol, unknown>)[STDIO_ORIGIN] === true
}

/**
 * 判定一个到达顶层的错误是否来自 stdio 的**同步**写入失败。
 *
 * 同步路径拿不到来源标记（错误没经过流级监听），所以只能从调用栈判断：
 * 栈里必须同时出现「stdio 写入的实现帧」与「一个管道类错误码」。
 * 只匹配码而不看栈会吞掉网络/文件流的 EPIPE（异构评审 p0）；
 * 只看栈不看码会吞掉 stdio 上的真故障（如 ENOSPC）。两者必须同时成立。
 *
 * 栈帧锚点取 Node 内部固定路径（node:internal/streams/writable、node:net、
 * node:internal/console/constructor）—— 用户弹窗里的堆栈正是这几帧。
 */
const STDIO_STACK_FRAMES = [
  'node:internal/streams/writable',
  'node:internal/console/constructor',
  'node:internal/net',
  'node:net'
]

function isSyncStdioWriteFailure(err: unknown): boolean {
  if (!isPipeGone(err)) return false
  const stack = (err as Error)?.stack
  if (typeof stack !== 'string') return false
  return STDIO_STACK_FRAMES.some(frame => stack.includes(frame))
}

/** 可注入的进程句柄（单测用假流替身，生产传真 process） */
export interface StdioGuardTargets {
  stdout: EventEmitter
  stderr: EventEmitter
  proc: EventEmitter
  /**
   * 非管道类致命错误的接管回调。**必须由装配侧提供**，因为它要承接
   * Electron 原本的行为（见下方长注释），而本模块不得 import electron。
   */
  onFatal?: (err: unknown, origin: 'uncaughtException' | 'unhandledRejection') => void
}

let installed = false

/**
 * 安装 stdio + 进程级错误收口。幂等；必须在 app ready 之前、任何日志之前调用，
 * 否则启动早期的写入仍会崩（打包版从资源管理器双击启动即命中该窗口）。
 *
 * ⚠️⚠️ 为什么非管道错误是「交给 onFatal」而不是 `throw err`：
 *   Electron 在 lib/browser/init.ts 里自带一个 uncaughtException 处理器，
 *   开头就是 `if (process.listenerCount('uncaughtException') > 1) return` ——
 *   我们一注册，它那个 dialog.showErrorBox 就永久沉默了。
 *   而在 uncaughtException 处理器**内部** throw 会让 Node 直接硬退（不再走
 *   任何恢复路径）→ 等于把「可见的错误弹窗」换成「GUI 静默猝死」，比原 bug 更糟。
 *   所以这里既不抛也不吞：把非管道错误交给装配侧的 onFatal，由它落盘 + 复现弹窗。
 *   缺 onFatal 时（如单测）行为是不抛不弹，故生产装配必须传 —— 架构闸门锁定这一点。
 */
export function installStdioGuard(targets?: Partial<StdioGuardTargets>): void {
  if (installed) return
  installed = true

  const stdout = targets?.stdout ?? (process.stdout as unknown as EventEmitter)
  const stderr = targets?.stderr ?? (process.stderr as unknown as EventEmitter)
  const proc = targets?.proc ?? (process as unknown as EventEmitter)
  const onFatal = targets?.onFatal

  // 流级：来源已由事件源确定（这个错误就是 stdout/stderr 发出的），故可按码判定。
  // 管道类静默 + 打上来源标记；其余重抛（stdio 上的 ENOSPC 之类是真故障，必须可见）。
  // 这里 throw 是安全的 —— 'error' 处理器不是 uncaughtException 处理器，
  // 抛出会正常冒到顶层，再由下面的兜底按「非 stdio 来源」处理并弹窗。
  const onStreamError = (err: unknown): void => {
    if (isPipeGone(err)) {
      markStdioOrigin(err)
      return
    }
    throw err
  }
  stdout.on('error', onStreamError)
  stderr.on('error', onStreamError)

  // 顶层兜底：覆盖**同步**抛出的 stdio EPIPE —— write 在某些句柄状态下同步失败，
  // 此时流级监听拦不到，错误直接从 console.log 调用点冒到顶层。
  //
  // ⚠️⚠️ 这里绝不可放宽成只看 `code === 'EPIPE'`：
  //   顶层拿到的错误不带来源。只看码的话，网络 socket / 文件写入流 / 原生插件
  //   抛出的 EPIPE 会被一并静默 —— 既无弹窗也无落盘，应用带病继续跑，
  //   比原本的可见崩溃更难诊断。（异构评审 p0，2026-08-05）
  //   两条静默通道，都要求来源可证：
  //     ① 流级监听放行时打的来源标记（异步路径）
  //     ② 栈帧命中 Node stdio 写入实现帧 + 管道类错误码（同步路径）
  const handleTopLevel = (
    origin: 'uncaughtException' | 'unhandledRejection'
  ) => (err: unknown): void => {
    if (isFromStdio(err) || isSyncStdioWriteFailure(err)) return
    if (onFatal) {
      // 留痕/弹窗失败不得掩盖原始错误，也不得二次崩溃
      try { onFatal(err, origin) } catch { /* ignore */ }
    }
  }
  proc.on('uncaughtException', handleTopLevel('uncaughtException'))
  proc.on('unhandledRejection', handleTopLevel('unhandledRejection'))
}

/** 仅供测试重置模块级 installed 闸 */
export const _internal = {
  reset(): void { installed = false },
  isPipeGone
}
