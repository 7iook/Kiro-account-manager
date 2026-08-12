/**
 * 数据目录进程锁。
 *
 * 这是进程生命周期/启动编排能力，故放在 `server/`，不放进 `persistence/`：
 * persistence 只负责数据格式与读写端口；锁由进程持有、随进程死亡释放，且不读写数据目录。
 *
 * 不使用 PID lockfile。lockfile 在 SIGKILL / 断电后会残留，而“检查 PID 后删除旧文件”
 * 无法原子地区分旧锁与刚被另一启动者替换的新锁，会把恢复过程本身变成竞态。
 * 这里使用内核持有的本地 IPC endpoint：
 *   - Windows：命名管道；
 *   - Linux：抽象 Unix domain socket（不落文件系统）；
 *   - 其它平台（主要是 macOS）：loopback TCP + 协议握手，哈希碰撞/外部占用时确定性换位。
 * endpoint 的所有权都在进程死亡时由内核回收，没有“陈旧文件”需要人工删除。
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join, relative, resolve } from 'node:path'

const PROTOCOL = 'kiro-account-manager/data-directory-lock/v1'
const MAX_WIRE_BYTES = 8 * 1024
const PROBE_TIMEOUT_MS = 500
const TCP_PORT_BASE = 30_000
// 质数长度使任意 1..RANGE-1 的步长都能遍历完整区间。
const TCP_PORT_RANGE = 10_007

export interface DataDirectoryLockHolder {
  pid: number
  startedAt: string
}

export interface DataDirectoryLock {
  /** 解析 symlink / 相对段后的数据目录；后续存储也应使用这一条路径。 */
  readonly dataDir: string
  readonly holder: DataDirectoryLockHolder
  release(): Promise<void>
}

interface WireMessage {
  protocol: typeof PROTOCOL
  key: string
  dataDir: string
  holder: DataDirectoryLockHolder
}

type ProbeResult =
  | { status: 'holder'; wire: WireMessage }
  | { status: 'absent' }
  | { status: 'unknown' }

export class DataDirectoryLockedError extends Error {
  readonly dataDir: string
  readonly holder?: DataDirectoryLockHolder

  constructor(dataDir: string, holder?: DataDirectoryLockHolder) {
    const holderLine = holder
      ? `持有者：PID ${holder.pid}（启动于 ${holder.startedAt}）。`
      : '持有者信息无法读取（本机已有进程占用了该锁端点）。'
    super(
      `数据目录已被另一个 Kiro Account Manager 实例占用：${dataDir}\n` +
        `${holderLine}\n` +
        `拒绝启动 —— 两个进程并发写同一份账号数据会造成静默覆盖。\n` +
        `请先停止持有该目录的实例再重试；若它刚刚崩溃，无需删除任何锁文件，` +
        `操作系统会自动释放锁。`
    )
    this.name = 'DataDirectoryLockedError'
    this.dataDir = dataDir
    this.holder = holder
  }
}

/**
 * 把配置路径解析成稳定的真实路径。
 *
 * 完整目录存在时直接 realpath（消除 symlink / junction / `..` / 实际大小写）。
 * 首次启动目录尚不存在时，从最近的已存在祖先 realpath 后再接回剩余部分；
 * Windows 的锁 key 另行转小写，从而让尚未创建目录的大小写拼法也归一。
 */
export function canonicalizeDataDirectory(input: string, cwd: string = process.cwd()): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('数据目录不能为空。')
  }

  const absolute = resolve(cwd, input)
  let cursor = absolute
  for (;;) {
    try {
      const canonicalAncestor = realpathSync.native(cursor)
      const suffix = relative(cursor, absolute)
      return suffix ? join(canonicalAncestor, suffix) : canonicalAncestor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }
}

export async function acquireDataDirectoryLock(input: string): Promise<DataDirectoryLock> {
  const dataDir = canonicalizeDataDirectory(input)
  const keyMaterial = process.platform === 'win32' ? dataDir.toLocaleLowerCase('en-US') : dataDir
  const key = createHash('sha256').update(keyMaterial).digest('hex')
  const holder: DataDirectoryLockHolder = {
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString()
  }
  const wire: WireMessage = { protocol: PROTOCOL, key, dataDir, holder }

  if (process.platform === 'win32') {
    const endpoint = `\\\\.\\pipe\\kiro-account-manager-data-${key}`
    return acquireExactEndpoint(endpoint, wire)
  }
  if (process.platform === 'linux') {
    // Linux abstract namespace：首字节 NUL，不产生 socket 文件，崩溃后无陈旧路径。
    return acquireExactEndpoint(`\0kiro-account-manager-data-${key}`, wire)
  }
  return acquireLoopbackEndpoint(wire)
}

/**
 * 把锁的释放接到完整 shutdown 之后。
 *
 * `shutdown()` 内部先停入口，再 drain 凭据、flush 统计、归档会话；只有它 settle 后
 * 才释放。即使 shutdown 抛错也要释放，否则优雅停机失败会把进程托管的重启永久挡住。
 */
export function attachDataDirectoryLock<T extends { shutdown(): Promise<void> }>(
  server: T,
  lock: DataDirectoryLock
): T {
  const shutdown = server.shutdown.bind(server)
  server.shutdown = async (): Promise<void> => {
    try {
      await shutdown()
    } finally {
      await lock.release()
    }
  }
  return server
}

async function acquireExactEndpoint(
  endpoint: string,
  wire: WireMessage
): Promise<DataDirectoryLock> {
  // EADDRINUSE 后 holder 可能恰在退出；探测不到时重试 bind，交给内核裁决。
  for (let attempt = 0; attempt < 3; attempt++) {
    const server = makeProtocolServer(wire)
    try {
      await listen(server, endpoint)
      return lockFromServer(server, wire)
    } catch (error) {
      await closeAfterFailedListen(server)
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      const probe = await probeEndpoint(endpoint, wire.key)
      if (probe.status === 'holder') {
        throw new DataDirectoryLockedError(wire.dataDir, probe.wire.holder)
      }
      if (probe.status === 'unknown') {
        throw new DataDirectoryLockedError(wire.dataDir)
      }
      await delay(20)
    }
  }
  throw new DataDirectoryLockedError(wire.dataDir)
}

async function acquireLoopbackEndpoint(wire: WireMessage): Promise<DataDirectoryLock> {
  const hash = Buffer.from(wire.key, 'hex')
  const start = hash.readUInt32BE(0) % TCP_PORT_RANGE
  const step = (hash.readUInt32BE(4) % (TCP_PORT_RANGE - 1)) + 1

  for (let index = 0; index < TCP_PORT_RANGE; index++) {
    const port = TCP_PORT_BASE + ((start + index * step) % TCP_PORT_RANGE)
    const server = makeProtocolServer(wire)
    try {
      await listen(server, { host: '127.0.0.1', port, exclusive: true })
      return lockFromServer(server, wire)
    } catch (error) {
      await closeAfterFailedListen(server)
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      const probe = await probeEndpoint({ host: '127.0.0.1', port }, wire.key)
      if (probe.status === 'holder') {
        throw new DataDirectoryLockedError(wire.dataDir, probe.wire.holder)
      }
      // 其它本机服务或极小概率哈希碰撞：不误判成同目录，按确定序列找下一端点。
    }
  }
  throw new Error('无法分配数据目录锁端点：本机候选 loopback 端口全部被占用。')
}

function makeProtocolServer(wire: WireMessage): Server {
  const payload = `${JSON.stringify(wire)}\n`
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.end(payload)
  })
  ;(server as Server & { lockSockets?: Set<Socket> }).lockSockets = sockets
  return server
}

function listen(
  server: Server,
  endpoint: string | { host: string; port: number; exclusive: boolean }
): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    if (typeof endpoint === 'string') server.listen(endpoint, onListening)
    else server.listen(endpoint, onListening)
  })
}

function lockFromServer(server: Server, wire: WireMessage): DataDirectoryLock {
  let released = false
  return {
    dataDir: wire.dataDir,
    holder: wire.holder,
    release: async (): Promise<void> => {
      if (released) return
      released = true
      const sockets = (server as Server & { lockSockets?: Set<Socket> }).lockSockets
      for (const socket of sockets ?? []) socket.destroy()
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()))
      })
    }
  }
}

function probeEndpoint(
  endpoint: string | { host: string; port: number },
  expectedKey: string
): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    let settled = false
    let received = ''
    const socket =
      typeof endpoint === 'string' ? createConnection(endpoint) : createConnection(endpoint)
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(result)
    }

    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish({ status: 'unknown' }))
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (received.length > MAX_WIRE_BYTES) finish({ status: 'unknown' })
    })
    socket.once('end', () => {
      try {
        const wire = JSON.parse(received.trim()) as Partial<WireMessage>
        if (
          wire.protocol === PROTOCOL &&
          wire.key === expectedKey &&
          typeof wire.dataDir === 'string' &&
          typeof wire.holder?.pid === 'number' &&
          typeof wire.holder.startedAt === 'string'
        ) {
          finish({ status: 'holder', wire: wire as WireMessage })
        } else {
          finish({ status: 'unknown' })
        }
      } catch {
        finish({ status: 'unknown' })
      }
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        finish({ status: 'absent' })
      } else {
        finish({ status: 'unknown' })
      }
    })
  })
}

async function closeAfterFailedListen(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
