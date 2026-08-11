/**
 * 服务端入口的**装配契约**闸门（W-A）。
 *
 * 断言选在「装配完成后可观察的事实」上：面板拿到的是哪个 auth / 配置合并的结果是什么 /
 * 反代该不该自启 / 停机顺序对不对。用真实临时目录 + 真实 `conf` 文件，不 mock fs ——
 * E-052 那一族（测试绿 ≠ 真达标）的成因正是断言选错时点。
 *
 * ## 为什么这里**不**测「entry.ts 能在无 electron 下 import」
 *
 * 那条断言在本机是**假绿**：`electron` 是 devDependency，而开发机上
 * `require('electron')` 会**成功并返回一个字符串**（electron.exe 的路径），
 * 于是 `import { app } from 'electron'` 不抛、只是 `app === undefined`。
 * 「import 了不抛就算过」的测试在有缺陷的代码上也是绿的。
 * 真正能判别的机制是模块图闸门 `test/main/architecture/kernel_without_electron.test.ts`
 * —— `src/main/server/entry.ts` 已加入其 `KERNEL_ENTRY_POINTS`。
 * 本文件测的是**装配语义**，不重复那件事。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Conf from 'conf'

import {
  assembleServer,
  readPanelConfig,
  readProxyConfig,
  shouldAutoStartProxy,
  archiveProxySession,
  restoreOrphanProxySession
} from '@main/server/assembly'
import {
  EXIT,
  ENV,
  ServerConfigError,
  readServerConfig,
  preflightForServerWithExitCode,
  PROXY_ORPHAN_SESSION_KEY
} from '@main/server/config'
import {
  ACCOUNT_STORE_NAME,
  ACCOUNT_STORE_ENCRYPTION_KEY,
  type AccountStorePort
} from '@main/persistence/accountStorePort'
import type { AdminKeyStore } from '@main/webPanel/auth'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `k5-${tag}-`))
}

/** 用桌面端同一套参数写一份真实数据文件（决策卡唯一正式支持的迁移工件） */
function writeStoreFile(dir: string, data: Record<string, unknown>): void {
  const conf = new Conf({
    cwd: dir,
    configName: ACCOUNT_STORE_NAME,
    encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
  })
  for (const [k, v] of Object.entries(data)) conf.set(k, v)
}

/** 内存 AdminKeyStore —— 本文件测装配，不测密钥引导（那是 adminKeyStore.test.ts 的事） */
function fakeAdminKeyStore(initial = 'test-admin-key-0000000000000000000001'): AdminKeyStore {
  let key: string | null = initial
  return { get: () => key, set: (k) => { key = k } }
}

function baseConfig(dataDir: string) {
  return { dataDir, truncateLogs: true }
}

describe('W-A 环境变量契约', () => {
  it('缺 KIRO_DATA_DIR → 拒绝启动，退出码 EX_USAGE(64)，且说明为什么没有默认值', () => {
    let thrown: ServerConfigError | null = null
    try {
      readServerConfig({})
    } catch (e) {
      thrown = e as ServerConfigError
    }
    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect(thrown?.exitCode).toBe(EXIT.USAGE)
    expect(thrown?.message).toContain(ENV.DATA_DIR)
  })

  it('端口非法 → 拒绝启动，**不**静默取默认值（决策卡：配置校验）', () => {
    for (const bad of ['808o', '-1', '70000', 'abc', '1.5']) {
      expect(
        () => readServerConfig({ [ENV.DATA_DIR]: 'C:/x', [ENV.PANEL_PORT]: bad }),
        `port=${bad}`
      ).toThrowError(ServerConfigError)
    }
  })

  it('端口 0 合法（内核分配）', () => {
    expect(readServerConfig({ [ENV.DATA_DIR]: 'C:/x', [ENV.PANEL_PORT]: '0' }).panelPort).toBe(0)
  })

  it('默认截断日志；KIRO_LOG_FULL=1 才关掉（服务器日志会写满磁盘且夹带凭据）', () => {
    expect(readServerConfig({ [ENV.DATA_DIR]: 'C:/x' }).truncateLogs).toBe(true)
    expect(readServerConfig({ [ENV.DATA_DIR]: 'C:/x', [ENV.LOG_FULL]: '1' }).truncateLogs).toBe(false)
  })
})

describe('W-A 启动期数据故障 → 分类退出码（运维要能从 journalctl 区分四种）', () => {
  it('文件不存在 → 放行（空库启动），decoded 为 null', () => {
    const dir = tempDir('absent')
    const r = preflightForServerWithExitCode(dir)
    expect(r.decoded).toBeNull()
    // 关键：**不得**顺手把文件建出来（拒启/放行都不该有副作用）
    expect(existsSync(join(dir, `${ACCOUNT_STORE_NAME}.json`))).toBe(false)
  })

  it('文件存在但解不开 → 拒启，退出码 EX_DATAERR(65)，且提示先备份', () => {
    const dir = tempDir('undec')
    writeFileSync(join(dir, `${ACCOUNT_STORE_NAME}.json`), 'not-a-valid-conf-payload')
    let thrown: ServerConfigError | null = null
    try {
      preflightForServerWithExitCode(dir)
    } catch (e) {
      thrown = e as ServerConfigError
    }
    expect(thrown?.exitCode).toBe(EXIT.DATA_ERROR)
    expect(thrown?.message).toMatch(/备份/)
  })

  it('版本比本程序新 → 拒启 EX_DATAERR(65)，不向下猜测解析', () => {
    const dir = tempDir('newver')
    writeStoreFile(dir, { schemaVersion: 999, accountData: { accounts: {} } })
    let thrown: ServerConfigError | null = null
    try {
      preflightForServerWithExitCode(dir)
    } catch (e) {
      thrown = e as ServerConfigError
    }
    expect(thrown?.exitCode).toBe(EXIT.DATA_ERROR)
  })

  it('正常数据 → 放行并带回已解出的内容（调用方不必再读一遍盘）', () => {
    const dir = tempDir('ok')
    writeStoreFile(dir, { accountData: { accounts: { a1: { id: 'a1' } }, revision: 3 } })
    const r = preflightForServerWithExitCode(dir)
    expect((r.decoded?.accountData as { revision?: number })?.revision).toBe(3)
  })

  it('四种退出码互不相同（否则运维无法区分该改 chown 还是查密钥）', () => {
    const codes = [EXIT.USAGE, EXIT.DATA_ERROR, EXIT.UNAVAILABLE, EXIT.CANNOT_CREATE, EXIT.CONFIG]
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('W-A 面板配置：服务端与桌面的两处刻意语义差', () => {
  it('盘上 enabled/autoStart 为 false（桌面默认值）时，服务端仍强制面板启动', () => {
    const dir = tempDir('panel-force')
    // 这正是「桌面数据文件直拷」的真实形状：用户没去设置页点开过面板
    writeStoreFile(dir, { webPanelConfig: { enabled: false, autoStart: false, port: 5590, host: '127.0.0.1' } })
    const store = makeMemStore({ webPanelConfig: { enabled: false, autoStart: false, port: 5590, host: '127.0.0.1' } })

    const cfg = readPanelConfig(store, baseConfig(dir))
    // 尊重那两个 false 的结果是「服务起来了但没有任何管理入口」—— 一个自锁的死结
    expect(cfg.enabled).toBe(true)
    expect(cfg.autoStart).toBe(true)
  })

  it('环境变量覆盖 host/port，且**不回写 store**（那份文件要拷回桌面继续用）', () => {
    const dir = tempDir('panel-env')
    const raw: Record<string, unknown> = {
      webPanelConfig: { enabled: true, autoStart: true, port: 5590, host: '127.0.0.1' }
    }
    const store = makeMemStore(raw)

    const cfg = readPanelConfig(store, { ...baseConfig(dir), panelHost: '0.0.0.0', panelPort: 9999 })
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.port).toBe(9999)
    // 盘上那份一个字节都没变 —— 否则用户拷回桌面后，桌面面板会去监听服务器的地址
    expect(raw.webPanelConfig).toEqual({ enabled: true, autoStart: true, port: 5590, host: '127.0.0.1' })
  })

  it('无环境变量覆盖时用盘上的值；盘上也没有则默认 127.0.0.1（决策卡 DC9）', () => {
    const dir = tempDir('panel-default')
    expect(readPanelConfig(makeMemStore({}), baseConfig(dir)).host).toBe('127.0.0.1')
    expect(
      readPanelConfig(makeMemStore({ webPanelConfig: { host: '10.0.0.5' } }), baseConfig(dir)).host
    ).toBe('10.0.0.5')
  })
})

describe('W-A 反代配置与自启判据', () => {
  it('autoStart 判据 = enabled && autoStart（同桌面语义）', () => {
    expect(shouldAutoStartProxy({ enabled: true, autoStart: true } as never)).toBe(true)
    expect(shouldAutoStartProxy({ enabled: true, autoStart: false } as never)).toBe(false)
    expect(shouldAutoStartProxy({ enabled: false, autoStart: true } as never)).toBe(false)
    // autoStart 缺省（老配置里可能没有这个键）→ 不自启，不猜
    expect(shouldAutoStartProxy({ enabled: true } as never)).toBe(false)
  })

  it('enableTokenBufferReserve 默认为 true（关闭会导致超 context window 请求三端点全 400）', () => {
    // RCA 2026-07-26：这是个已经踩过的坑，默认值必须带它
    expect(readProxyConfig(makeMemStore({})).enableTokenBufferReserve).toBe(true)
  })

  it('盘上配置覆盖默认值，但**不做**桌面那次一次性迁移写盘（I1b：迁移不改源数据）', () => {
    const raw: Record<string, unknown> = {
      proxyConfig: { enabled: true, autoStart: true, port: 6000, enableTokenBufferReserve: false }
    }
    const store = makeMemStore(raw)
    const cfg = readProxyConfig(store)

    expect(cfg.port).toBe(6000)
    // 盘上写的是 false 就读 false —— 服务端不替用户强开（桌面已跑过那次迁移）
    expect(cfg.enableTokenBufferReserve).toBe(false)
    // 且读配置这个动作**没有写**任何键
    expect(raw.accountDataMigration).toBeUndefined()
    expect(raw.proxyConfig).toEqual({
      enabled: true,
      autoStart: true,
      port: 6000,
      enableTokenBufferReserve: false
    })
  })
})

describe('W-A 会话归档：三处必须与桌面逐条一致（两端读同一份 proxySessionHistory）', () => {
  const rec = (totalRequests: number): Record<string, unknown> => ({
    totalRequests,
    successRequests: totalRequests,
    failedRequests: 0,
    credits: 1
  })

  it('空会话（0 请求）不记录 —— 否则误点启停会刷一堆垃圾条目', () => {
    const raw: Record<string, unknown> = {}
    const store = makeMemStore(raw)
    archiveProxySession(store, { snapshotSession: () => rec(0) } as never)
    expect(raw.proxySessionHistory).toBeUndefined()
  })

  it('非空会话**追加在尾部**（桌面按越新越靠后读，头插会让两端时间顺序相反）', () => {
    const raw: Record<string, unknown> = { proxySessionHistory: [rec(1)] }
    const store = makeMemStore(raw)
    archiveProxySession(store, { snapshotSession: () => rec(2) } as never)
    const hist = raw.proxySessionHistory as Array<{ totalRequests: number }>
    expect(hist.map((h) => h.totalRequests)).toEqual([1, 2])
  })

  it('归档后清 orphan 键（否则下次启动重复归档同一条 —— 桌面实测产生过 7 条重复）', () => {
    const raw: Record<string, unknown> = { [PROXY_ORPHAN_SESSION_KEY]: rec(5) }
    const store = makeMemStore(raw)
    archiveProxySession(store, { snapshotSession: () => rec(2) } as never)
    // 端口适配器把 set(key, undefined) 翻译成 delete —— 键必须真的不见了
    expect(PROXY_ORPHAN_SESSION_KEY in raw).toBe(false)
  })

  it('历史超过 200 条时保留**最新的** 200（slice(-LIMIT)，不是前 200）', () => {
    const raw: Record<string, unknown> = {
      proxySessionHistory: Array.from({ length: 200 }, (_, i) => rec(i + 1))
    }
    archiveProxySession(makeMemStore(raw), { snapshotSession: () => rec(999) } as never)
    const hist = raw.proxySessionHistory as Array<{ totalRequests: number }>
    expect(hist.length).toBe(200)
    expect(hist[hist.length - 1].totalRequests).toBe(999) // 新的在
    expect(hist[0].totalRequests).toBe(2) // 最旧的被挤掉
  })

  it('归档抛错不向上传播（停机流程后面还要停面板）', () => {
    const store = makeMemStore({})
    expect(() =>
      archiveProxySession(store, {
        snapshotSession: () => {
          throw new Error('boom')
        }
      } as never)
    ).not.toThrow()
  })

  it('回收 orphan：非空则并入历史并清键（服务器上非正常退出是常态）', () => {
    const raw: Record<string, unknown> = { [PROXY_ORPHAN_SESSION_KEY]: rec(7) }
    restoreOrphanProxySession(makeMemStore(raw))
    expect((raw.proxySessionHistory as unknown[]).length).toBe(1)
    expect(PROXY_ORPHAN_SESSION_KEY in raw).toBe(false)
  })

  it('回收 orphan：0 请求的空快照只清键、不并入历史', () => {
    const raw: Record<string, unknown> = { [PROXY_ORPHAN_SESSION_KEY]: rec(0) }
    restoreOrphanProxySession(makeMemStore(raw))
    expect(raw.proxySessionHistory).toBeUndefined()
    expect(PROXY_ORPHAN_SESSION_KEY in raw).toBe(false)
  })
})

/**
 * 内存 store，行为对齐 `adaptRawStoreToPort`：**`set(key, undefined)` = 删除**。
 * 这一条是承重的 —— 直接对 `conf` 调 `set(key, undefined)` 会抛且旧值留在盘上，
 * 端口那层做了翻译。测试替身若不照做，「归档后清 orphan」那条断言就测不到真语义。
 */
function makeMemStore(backing: Record<string, unknown>): AccountStorePort {
  return {
    get: (key: string, defaultValue?: unknown) => backing[key] ?? defaultValue,
    set: (key: string, value: unknown) => {
      if (value === undefined) {
        delete backing[key]
        return
      }
      backing[key] = value
    },
    path: join('C:', 'fake', `${ACCOUNT_STORE_NAME}.json`)
  }
}
