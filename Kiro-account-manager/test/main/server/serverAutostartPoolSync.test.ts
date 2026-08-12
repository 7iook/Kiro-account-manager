/**
 * 服务端**自启动路径**的池同步闸门（W-B）。
 *
 * ## 为什么必须驱动真的 `bootstrap()`
 *
 * 缺陷在 `entry.ts` 的**调用**里，不在 `assembly.ts` 的语义里：`assembleServer()`
 * 提供了 `initProxyServer()`，而「起之前先同步池」是调用方的责任。
 * 一个自己拼装 `assembleServer(...)` 再自己调 `initProxyServer().start()` 的测试，
 * 断言的是**测试自己写的那个顺序**，对着有缺陷的 `entry.ts` 照样绿
 * —— 本项目已经踩过一次（per-`assembleServer` 测试绿而真 `entry.ts` 漏传参数）。
 * 故本文件一律走 `bootstrap(env)`，env 用真实临时目录 + 真实 `conf` 数据文件。
 *
 * ## 断言选在「可观察状态」而不是「调了哪个函数」
 *
 * 判据是 `bootstrap()` 返回后 **`getProxyServer()!.getAccountPool().size > 0`**
 * 且 `isRunning()` 为真 —— 即「对外接流之前池里已经有号」。
 * 不 spy `syncPool`：spy 只能证明某个函数被调过，证不了池里真有号
 * （而「调了同步但同步产出为空」正是这个缺陷家族的形态）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Conf from 'conf'

import { bootstrap } from '@main/server/entry'
import { ENV } from '@main/server/config'
import {
  ACCOUNT_STORE_NAME,
  ACCOUNT_STORE_ENCRYPTION_KEY
} from '@main/persistence/accountStorePort'
import { ADMIN_KEY_ENV } from '@main/server/adminKeyStore'
import type { AssembledServer } from '@main/server/assembly'

const started: AssembledServer[] = []

afterEach(async () => {
  // 每个用例都真起了面板（+ 可能起了反代），必须关掉否则端口泄漏到后续用例
  while (started.length > 0) {
    const s = started.pop()
    await s?.shutdown().catch(() => {})
  }
  vi.restoreAllMocks()
})

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `k5-autostart-${tag}-`))
}

/** 一条**准入**的账号记录（有 accessToken 且 lastError 不含封禁原文） */
function admissibleAccount(id: string): Record<string, unknown> {
  return {
    id,
    email: `${id}@example.test`,
    status: 'active',
    credentials: { accessToken: `tok-${id}`, refreshToken: `rt-${id}`, region: 'us-east-1' }
  }
}

/**
 * 写一份真实数据文件 —— 桌面端同一套 `conf` 参数（决策卡唯一正式支持的迁移工件）。
 * 刻意不去碰 `%APPDATA%` 里那份真数据（那是机主的活凭据）。
 */
function writeStore(dir: string, data: Record<string, unknown>): void {
  const conf = new Conf({
    cwd: dir,
    configName: ACCOUNT_STORE_NAME,
    encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
  })
  for (const [k, v] of Object.entries(data)) conf.set(k, v)
}

/** 自启动所需的盘上配置：`enabled && autoStart`（`shouldAutoStartProxy` 的判据） */
function autoStartProxyConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    autoStart: true,
    // 端口 0 = 内核分配，避免用例之间抢固定端口
    port: 0,
    host: '127.0.0.1',
    enableMultiAccount: true,
    ...extra
  }
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return {
    [ENV.DATA_DIR]: dir,
    // 面板端口 0：本用例不测面板监听地址，只是不能让它抢端口
    [ENV.PANEL_PORT]: '0',
    // 预置 adminKey：该路径根本不落密钥文件，故 Windows 上不需要
    // KIRO_ALLOW_UNPROTECTED_KEY_FILE（见 adminKeyStore.ts:498）
    [ADMIN_KEY_ENV]: 'test-admin-key-000000000000000000000001'
  }
}

async function boot(dir: string): Promise<AssembledServer> {
  const s = await bootstrap(envFor(dir))
  started.push(s)
  return s
}

function makeClaudeRequest(): Readable & { headers: Record<string, string> } {
  const request = Readable.from([
    Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4.5',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      'utf8'
    )
  ]) as Readable & { headers: Record<string, string> }
  request.headers = { 'content-type': 'application/json' }
  return request
}

function makeResponse() {
  const writes: string[] = []
  const response = {
    writableEnded: false,
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    writeHead(status: number, headers?: Record<string, unknown>) {
      response.statusCode = status
      if (headers) response.headers = headers
      response.headersSent = true
      return response
    },
    write(chunk: string) {
      writes.push(chunk)
      return true
    },
    end(chunk?: string) {
      if (chunk) writes.push(chunk)
      response.writableEnded = true
      return response
    },
    on() {
      return response
    },
    once() {
      return response
    },
    writes
  }
  return response
}

async function fireEmptyPoolRequest(server: AssembledServer): Promise<ReturnType<typeof makeResponse>> {
  const proxy = server.getProxyServer()
  expect(proxy, '自启动应已创建反代实例').not.toBeNull()
  const response = makeResponse()
  void (proxy as any).handleClaudeMessages(makeClaudeRequest(), response)
  await new Promise((resolve) => setTimeout(resolve, 50))
  return response
}

describe('W-B 服务端自启动：先同步池，再对外接流', () => {
  it('盘上有准入账号 → bootstrap 返回时池里已经有号（不是等第一个请求才补）', async () => {
    const dir = tempDir('has-accounts')
    writeStore(dir, {
      proxyConfig: autoStartProxyConfig(),
      accountData: {
        accounts: { a1: admissibleAccount('a1'), a2: admissibleAccount('a2') }
      }
    })

    const server = await boot(dir)
    const proxy = server.getProxyServer()

    // 反代确实起来了（否则下面的池断言会变成一个空洞的真命题）
    expect(proxy).not.toBeNull()
    expect(proxy!.isRunning()).toBe(true)

    // 承重断言：**已在接流**，且池非空。
    // 缺陷形态下这里是 0 —— 反代在监听、状态绿、池是空的。
    expect(proxy!.getAccountPool().size).toBe(2)
  })

  it('启动日志必须带上池大小 —— 只说「反代已启动」的绿灯是这个缺陷最贵的部分', async () => {
    const dir = tempDir('log-poolsize')
    writeStore(dir, {
      proxyConfig: autoStartProxyConfig(),
      accountData: { accounts: { a1: admissibleAccount('a1') } }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await boot(dir)

    const started = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('反代已启动'))
    expect(started.length).toBeGreaterThan(0)
    // 池大小必须出现在那一行里：运维在请求到来**之前**就要能判断池是不是空的
    expect(started.join('\n')).toMatch(/池|pool/i)
    expect(started.join('\n')).toMatch(/\b1\b/)
  })

  it('反向对照 ①：盘上零账号（首次部署常态）→ 仍启动，但日志明说是空池且给出下一步', async () => {
    const dir = tempDir('empty-store')
    writeStore(dir, {
      proxyConfig: autoStartProxyConfig(),
      accountData: { accounts: {} }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const server = await boot(dir)

    // 不拒启：零账号是合法首启态，且拒启会同时关掉 onPoolEmpty 那条自愈路
    expect(server.getProxyServer()?.isRunning()).toBe(true)
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toMatch(/空池/)
    // 「还没有账号」与「有账号但全不准入」必须能区分 —— 两者运维动作不同
    expect(text).toMatch(/还没有任何账号|尚无账号/)
  })

  it('反向对照 ②：盘上有号但全不准入 + HoldGate 开启 → 请求被挂起并提示排查准入', async () => {
    const dir = tempDir('all-inadmissible')
    writeStore(dir, {
      proxyConfig: autoStartProxyConfig({ holdWhenNoAccount: true }),
      accountData: {
        accounts: {
          // 无 accessToken → no_credentials
          bad1: { id: 'bad1', email: 'bad1@example.test', credentials: {} },
          // 被上游明确拒绝 → backend_rejected
          bad2: {
            id: 'bad2',
            email: 'bad2@example.test',
            credentials: { accessToken: 'x' },
            lastError: 'AccountSuspendedException: account suspended'
          }
        }
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const server = await boot(dir)
    const response = await fireEmptyPoolRequest(server)
    const proxy = server.getProxyServer()!

    expect(proxy.getAccountPool().size).toBe(0)
    expect(proxy.getHeldRequestsCount()).toBe(1)
    expect(response.writableEnded).toBe(false)
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n')
    // 这一态与「盘上还没有账号」必须给出不同文案：这里是真故障，运维要去查为什么不准入
    expect(text).toMatch(/未通过池准入|全部未通过/)
    expect(text).toMatch(/\b2\b/)
    // 且不得把它说成首次部署常态
    expect(text).not.toMatch(/还没有任何账号/)
    // 请求已被真实路径挂起，启动告警不得反过来说成「每个请求都会失败」。
    expect(text).not.toMatch(/每个外部请求都会失败|挂起门闸也不会触发/)
  })

  it('反向对照 ③：盘上有号但全不准入 + HoldGate 关闭 → 请求立即 503', async () => {
    const dir = tempDir('all-inadmissible-no-hold')
    writeStore(dir, {
      proxyConfig: autoStartProxyConfig({ holdWhenNoAccount: false }),
      accountData: {
        accounts: {
          bad1: { id: 'bad1', email: 'bad1@example.test', credentials: {} }
        }
      }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const server = await boot(dir)
    const response = await fireEmptyPoolRequest(server)
    const proxy = server.getProxyServer()!

    expect(proxy.getHeldRequestsCount()).toBe(0)
    expect(response.writableEnded).toBe(true)
    expect(response.statusCode).toBe(503)
    expect(response.writes.join('')).toContain('No available accounts')
  })

  it('未配置自启动 → 不初始化反代（本闸门不得顺手改变「不自启」的语义）', async () => {
    const dir = tempDir('no-autostart')
    writeStore(dir, {
      proxyConfig: { ...autoStartProxyConfig(), autoStart: false },
      accountData: { accounts: { a1: admissibleAccount('a1') } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const server = await boot(dir)
    expect(server.getProxyServer()).toBeNull()
  })
})
