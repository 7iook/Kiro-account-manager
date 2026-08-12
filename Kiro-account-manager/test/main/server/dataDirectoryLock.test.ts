import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import {
  acquireDataDirectoryLock,
  attachDataDirectoryLock,
  canonicalizeDataDirectory,
  DataDirectoryLockedError
} from '@main/server/dataDirectoryLock'
import { bootstrap } from '@main/server/entry'
import { EXIT, ServerConfigError } from '@main/server/config'

type ChildMessage =
  | { type: 'acquired'; dataDir: string; pid: number }
  | { type: 'error'; name: string; message: string; holder?: { pid?: number; startedAt?: string } }
  | { type: 'released' }

const workspace = mkdtempSync(join(tmpdir(), 'kiro-data-lock-test-'))
const compiledLockModule = join(workspace, 'dataDirectoryLock.cjs')
const childRunner = join(workspace, 'lock-child.cjs')
const productionSource = resolve(process.cwd(), 'src/main/server/dataDirectoryLock.ts')

function waitForMessage(child: ChildProcess, type: ChildMessage['type']): Promise<ChildMessage> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待子进程消息 ${type} 超时`)), 5_000)
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== type) return
      clearTimeout(timer)
      child.off('exit', onExit)
      resolveMessage(message)
    }
    const onExit = (code: number | null): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      reject(new Error(`子进程在发送 ${type} 前退出（code=${code}）`))
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}

function startHolder(dataDir: string, cwd: string = process.cwd()): ChildProcess {
  return fork(childRunner, [compiledLockModule, dataDir], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const released = waitForMessage(child, 'released')
  child.send?.('release')
  await released
}

beforeAll(() => {
  const source = readFileSync(productionSource, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: productionSource
  }).outputText
  writeFileSync(compiledLockModule, compiled)
  writeFileSync(
    childRunner,
    `
const { acquireDataDirectoryLock } = require(process.argv[2])

void (async () => {
  try {
    const lock = await acquireDataDirectoryLock(process.argv[3])
    process.send({ type: 'acquired', dataDir: lock.dataDir, pid: process.pid })
    process.on('message', async (message) => {
      if (message !== 'release') return
      await lock.release()
      process.send({ type: 'released' })
      process.exit(0)
    })
  } catch (error) {
    process.send({
      type: 'error',
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      holder: error?.holder
    })
    setTimeout(() => process.exit(2), 10)
  }
})()
`
  )
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('数据目录单实例锁（真实跨进程）', () => {
  it('同一规范目录只能被一个进程持有，失败信息包含目录与持有者 PID', async () => {
    const dataDir = join(workspace, 'same-dir')
    mkdirSync(dataDir)
    const holder = startHolder(dataDir)

    try {
      const acquired = (await waitForMessage(holder, 'acquired')) as Extract<
        ChildMessage,
        { type: 'acquired' }
      >
      const contender = startHolder(join(dataDir, '.', ''))
      const refused = (await waitForMessage(contender, 'error')) as Extract<
        ChildMessage,
        { type: 'error' }
      >

      expect(refused.name).toBe(DataDirectoryLockedError.name)
      expect(refused.message).toContain(realpathSync.native(dataDir))
      expect(refused.message).toContain(String(acquired.pid))
      expect(refused.holder?.pid).toBe(acquired.pid)
    } finally {
      await stopHolder(holder)
    }
  })

  it('相对路径与目录联接指向同一目录时仍互斥', async () => {
    const target = join(workspace, 'canonical-target')
    const alias = join(workspace, 'canonical-alias')
    mkdirSync(target)
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const relativeTarget = relative(dirname(target), target)
    const holder = startHolder(relativeTarget, dirname(target))

    try {
      await waitForMessage(holder, 'acquired')
      const contender = startHolder(alias)
      const refused = (await waitForMessage(contender, 'error')) as Extract<
        ChildMessage,
        { type: 'error' }
      >
      expect(refused.name).toBe(DataDirectoryLockedError.name)
      expect(canonicalizeDataDirectory(alias)).toBe(canonicalizeDataDirectory(target))
    } finally {
      await stopHolder(holder)
    }
  })

  it('持有进程崩溃后内核释放锁，无需删除陈旧锁文件', async () => {
    const dataDir = join(workspace, 'crash-recovery')
    mkdirSync(dataDir)
    const crashed = startHolder(dataDir)
    await waitForMessage(crashed, 'acquired')
    const exited = new Promise<void>((resolveExit) => crashed.once('exit', () => resolveExit()))
    crashed.kill('SIGKILL')
    await exited

    const replacement = startHolder(dataDir)
    try {
      await expect(waitForMessage(replacement, 'acquired')).resolves.toMatchObject({
        type: 'acquired',
        dataDir: canonicalizeDataDirectory(dataDir)
      })
    } finally {
      await stopHolder(replacement)
    }
  })

  it('不同数据目录可同时持有', async () => {
    const a = join(workspace, 'independent-a')
    const b = join(workspace, 'independent-b')
    mkdirSync(a)
    mkdirSync(b)
    const first = startHolder(a)
    const second = startHolder(b)

    try {
      await Promise.all([waitForMessage(first, 'acquired'), waitForMessage(second, 'acquired')])
    } finally {
      await Promise.all([stopHolder(first), stopHolder(second)])
    }
  })

  it('同一进程释放后可重新获取', async () => {
    const dataDir = join(workspace, 'normal-release')
    mkdirSync(dataDir)
    const first = await acquireDataDirectoryLock(dataDir)
    await first.release()
    const second = await acquireDataDirectoryLock(dataDir)
    await second.release()
  })

  it('停机 drain 尚未完成时绝不提前释放锁', async () => {
    const events: string[] = []
    let finishShutdown!: () => void
    const server = {
      shutdown: async (): Promise<void> => {
        events.push('shutdown-start')
        await new Promise<void>((resolveShutdown) => {
          finishShutdown = resolveShutdown
        })
        events.push('shutdown-finished')
      }
    }
    const lock = {
      dataDir: 'unused',
      holder: { pid: process.pid, startedAt: new Date().toISOString() },
      release: async (): Promise<void> => {
        events.push('lock-released')
      }
    }
    attachDataDirectoryLock(server, lock)

    const stopping = server.shutdown()
    await Promise.resolve()
    expect(events).toEqual(['shutdown-start'])
    finishShutdown()
    await stopping
    expect(events).toEqual(['shutdown-start', 'shutdown-finished', 'lock-released'])
  })

  it('真实 bootstrap 在任何 store/adminKey 写入前拒绝同目录第二实例', async () => {
    const dataDir = join(workspace, 'bootstrap-wiring')
    mkdirSync(dataDir)
    const env = {
      KIRO_DATA_DIR: dataDir,
      KIRO_PANEL_PORT: '0',
      KIRO_ADMIN_KEY: 'single-lock-test-admin-key-000000000001'
    }
    const first = await bootstrap(env)

    try {
      let refused: unknown
      try {
        await bootstrap(env)
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(ServerConfigError)
      expect((refused as ServerConfigError).exitCode).toBe(EXIT.UNAVAILABLE)
      expect((refused as Error).message).toContain(canonicalizeDataDirectory(dataDir))
      expect((refused as Error).message).toContain(String(process.pid))
    } finally {
      await first.shutdown()
    }
  })
})
