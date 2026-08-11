/**
 * 服务端 `AdminKeyStore`（W-B）的行为闸门 —— 决策卡 DC9「首次 adminKey 引导」四条规则。
 *
 * 规则出处（`.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:458-470`，逐字）：
 *   1. 生成时机：首次启动时若无密钥 → **生成并打印到标准输出一次**
 *   2. 一次性展示：仅首次生成时打印；之后启动不再打印（否则容器日志里长期留着有效凭据）
 *   3. 持久化权限：密钥文件权限 `0600`。**若无法设置该权限则拒绝启动**
 *   4. 支持预置：允许通过环境变量预置密钥，**此时不生成也不打印**
 *   负向验收：① 权限过宽 → 拒启 ② 环境变量与文件同时存在且不一致 → **拒绝启动并说明**，不猜优先级
 *            ③ **首次生成的密钥未出现在输出里 → 部署即失败**，需专门测试
 *
 * 第 5 条（不提供重置密钥的 HTTP 端点）本轮已成立，不由本文件测 ——
 * 它是「面板路由表里没有那个端点」这一**缺席**事实，归属
 * `test/main/architecture/webpanel_auth_constraints.test.ts` 那类结构闸门；
 * 在本文件写一条「我没写这个端点」的断言只会自证。
 *
 * ## 断言选在「可观察结局」上，不选在「调了哪个内部函数」上
 *
 * 每条测试的判据都是运维在服务器上真能看见的东西：盘上有没有那个文件 / 它的内容是什么 /
 * 终端里打印了什么 / 启动是被拒还是放行。故本文件不 mock `fs`、不 spy 内部调用 ——
 * 用真实临时目录跑真实读写。E-052 那一族（测试绿 ≠ 真达标）的成因正是断言选错时点。
 *
 * ## Windows 上如何测「POSIX 才有意义」的权限规则
 *
 * 本机实测(2026-08-12 · win32 · node v22.20.0)：`chmodSync(f, 0o600)` 之后
 * `statSync(f).mode & 0o777` 读回 **`0o666`**；`0o400`/`0o000` 读回 `0o444`、`0o777` 读回 `0o666`。
 * 即 POSIX 三段位在 Windows 上根本不存在（只映射一个只读位）。
 * 于是「权限过宽就拒启」这条规则若在 Windows 上按 POSIX 判据跑，**每次都会拒启**。
 *
 * 所以判据被抽成纯函数 `classifyKeyFilePermission(mode, platform)`，
 * 并且 `platform` 是可注入的：**两个平台分支在任何一台机器上都被真跑到**。
 * 不这么做的话，Windows 开发机上永远只走 win32 分支，Linux 分支要等上线才第一次执行 ——
 * 而它恰好是唯一真正承担安全职责的那条。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Conf from 'conf'

import {
  createServerAdminKeyStore,
  classifyKeyFilePermission,
  adminKeyFilePath,
  ADMIN_KEY_ENV,
  ADMIN_KEY_FILE_NAME
} from '@main/server/adminKeyStore'
import { PanelAuth } from '@main/webPanel/auth'
import { EXIT, ServerConfigError } from '@main/server/config'
import { ACCOUNT_STORE_NAME, ACCOUNT_STORE_ENCRYPTION_KEY } from '@main/persistence/accountStorePort'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `wb-${tag}-`))
}

/** 收集打印行的测试替身 —— 断言的是「运维在终端看到了什么」 */
function collector(): { lines: string[]; sink: (line: string) => void; text: () => string } {
  const lines: string[] = []
  return { lines, sink: (line) => lines.push(line), text: () => lines.join('\n') }
}

/** 无环境变量的干净 env（不继承宿主机可能已设的 KIRO_ADMIN_KEY） */
function emptyEnv(): NodeJS.ProcessEnv {
  return {}
}

describe('W-B 服务端 AdminKeyStore · 规则 1+2：首启生成并只打印一次', () => {
  it('首启无密钥：生成密钥、落盘、并把密钥本身打印出来（负向验收 ③）', () => {
    const dir = tempDir('first')
    const out = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink
    })

    const key = store.get()
    expect(key).toBeTruthy()
    expect(store.source).toBe('generated')

    // 盘上确实有这个文件，且内容就是那把钥匙
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf-8').trim()).toBe(key)

    // 负向验收 ③：密钥必须真的出现在输出里，否则部署即失败（用户无法登录）
    expect(out.text()).toContain(key as string)
  })

  it('生成的密钥是 256bit 随机（不是默认口令），两次生成互不相同', () => {
    const a = createServerAdminKeyStore({
      dataDir: tempDir('rand-a'),
      env: emptyEnv(),
      platform: 'win32',
      print: () => {}
    }).get()
    const b = createServerAdminKeyStore({
      dataDir: tempDir('rand-b'),
      env: emptyEnv(),
      platform: 'win32',
      print: () => {}
    }).get()

    expect(a).not.toBe(b)
    // base64url(32B) = 43 字符；断言长度下限而非等值，避免锁死 auth.ts 的实现细节
    expect((a as string).length).toBeGreaterThanOrEqual(43)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('第二次启动（文件已在）：读回同一把钥匙，且**不再打印**（规则 2）', () => {
    const dir = tempDir('second')
    const first = collector()
    const generated = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: first.sink
    }).get()
    expect(first.text()).toContain(generated as string)

    // 模拟进程重启：同一目录再构造一次
    const second = collector()
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: second.sink
    })

    expect(store.get()).toBe(generated)
    expect(store.source).toBe('file')
    // 容器日志里不得长期留着有效凭据
    expect(second.lines).toEqual([])
  })

  it('「只打印一次」是按**密钥寿命**算，不是按进程寿命：同进程内重复取用不再打印', () => {
    const dir = tempDir('once-per-key')
    const out = collector()
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink
    })
    const printedAfterBootstrap = out.lines.length

    // 面板装配后会多次取用（server.start / hasAdminKey / login 每次都读）
    store.get()
    store.get()
    new PanelAuth(store).ensureAdminKey()
    new PanelAuth(store).hasAdminKey()

    expect(out.lines.length).toBe(printedAfterBootstrap)
  })

  it('默认打印到 stdout（console.log）—— 运维在终端 / 容器日志里能看到', () => {
    const dir = tempDir('stdout')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const key = createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'win32'
      }).get()
      const printed = spy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(printed).toContain(key as string)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('W-B 规则 3：密钥文件权限 —— 两个平台分支都在本机被真跑到', () => {
  it('POSIX + 0600 → 放行', () => {
    expect(classifyKeyFilePermission(0o600, 'linux').kind).toBe('ok')
  })

  it('POSIX + 更严（0400 / 0000）→ 放行（规则要的是「不得更宽」，不是「必须等于 0600」）', () => {
    expect(classifyKeyFilePermission(0o400, 'linux').kind).toBe('ok')
    expect(classifyKeyFilePermission(0o000, 'linux').kind).toBe('ok')
  })

  it('POSIX + 组可读 / 世界可读 / 世界可写 → 判定过宽', () => {
    for (const mode of [0o640, 0o644, 0o604, 0o666, 0o660, 0o777]) {
      const verdict = classifyKeyFilePermission(mode, 'linux')
      expect(verdict.kind, `mode ${mode.toString(8)}`).toBe('too-open')
    }
  })

  it('darwin 与 linux 同判据（POSIX 语义一致）', () => {
    expect(classifyKeyFilePermission(0o600, 'darwin').kind).toBe('ok')
    expect(classifyKeyFilePermission(0o644, 'darwin').kind).toBe('too-open')
  })

  it('win32 → 判定为「无法表达」而非过宽：POSIX 位在 Windows 上不存在', () => {
    // 本机实测：Windows 上 chmod(0o600) 读回 0o666，故若按 POSIX 判据会每次拒启
    const verdict = classifyKeyFilePermission(0o666, 'win32')
    expect(verdict.kind).toBe('unenforceable')
    if (verdict.kind === 'unenforceable') {
      expect(verdict.warning).toBeTruthy()
    }
  })

  it('POSIX 上文件权限过宽 → **拒绝启动**（负向验收 ①），错误信息给出可执行补救', () => {
    const dir = tempDir('perm-wide')
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    // 在 Windows 上普通写出的文件 stat 即 0o666 —— 恰好就是「过宽」的形状，
    // 于是这条端到端拒启在本机也能真跑到（不依赖能否真造出 0600 文件）
    writeFileSync(file, 'pre-existing-key-value-aaaaaaaaaaaaaaaaaaa\n')

    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'linux',
        print: () => {}
      })
    ).toThrowError(/权限|chmod/)
  })

  it('win32 上同一个文件 → 放行，但发出「保护弱」告警（不静默跳过）', () => {
    const dir = tempDir('perm-win')
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    writeFileSync(file, 'pre-existing-key-value-aaaaaaaaaaaaaaaaaaa\n')
    const warns = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {},
      warn: warns.sink
    })

    expect(store.get()).toBe('pre-existing-key-value-aaaaaaaaaaaaaaaaaaa')
    expect(warns.text()).toMatch(/Windows/)
  })

  it('生成路径在 POSIX 上会**校验自己刚写的权限**（写完不验 = 规则 3 形同虚设）', () => {
    // Windows 文件系统无法真的落到 0600，故 platform:'linux' + 真实 Windows 盘
    // 精确复现「我尝试设 0600 但设不上」这一态 —— 规则 3 要求此时拒绝启动
    const dir = tempDir('perm-selfcheck')
    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'linux',
        print: () => {}
      })
    ).toThrowError(/权限/)
  })
})

describe('W-B 规则 4 + 负向验收 ②：环境变量预置与冲突', () => {
  it('环境变量存在、文件不存在 → 用环境变量，**不生成文件也不打印**', () => {
    const dir = tempDir('env-only')
    const out = collector()
    const preset = 'preset-admin-key-from-orchestrator-000001'

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: { [ADMIN_KEY_ENV]: preset },
      platform: 'linux',
      print: out.sink
    })

    expect(store.get()).toBe(preset)
    expect(store.source).toBe('env')
    // 不生成：写出文件会凭空造出第二个真源，且下次运维改了环境变量就变成冲突拒启
    expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(false)
    // 不打印：密钥是运维自己给的，他已经知道；打印只会把它复制进容器日志
    expect(out.lines).toEqual([])
  })

  it('环境变量与文件**一致** → 放行（这是运维把读到的密钥钉进编排文件的自然做法）', () => {
    const dir = tempDir('env-agree')
    const key = 'same-key-in-both-places-0000000000000001'
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), `${key}\n`)
    const out = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: { [ADMIN_KEY_ENV]: key },
      platform: 'win32',
      print: out.sink
    })

    expect(store.get()).toBe(key)
    expect(out.lines).toEqual([])
  })

  it('环境变量与文件**不一致** → 拒绝启动，且错误信息同时点名两个来源与各自位置（不猜优先级）', () => {
    const dir = tempDir('env-conflict')
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'key-that-lives-on-disk-000000000000001\n')

    let thrown: Error | null = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: { [ADMIN_KEY_ENV]: 'key-that-came-from-the-environment-0001' },
        platform: 'win32',
        print: () => {}
      })
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).toBeInstanceOf(Error)
    // 必须能让运维知道「查哪两个地方」：环境变量名 + 文件路径
    expect(thrown?.message).toContain(ADMIN_KEY_ENV)
    expect(thrown?.message).toContain(join(dir, ADMIN_KEY_FILE_NAME))
    // 且不得泄漏任一密钥明文到错误信息（错误会进日志 / 进 systemd status）
    expect(thrown?.message).not.toContain('key-that-lives-on-disk')
    expect(thrown?.message).not.toContain('key-that-came-from-the-environment')
  })

  it('环境变量存在但为空 / 纯空白 → 拒绝启动，**不**当成「未设置」静默生成新密钥', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const dir = tempDir('env-empty')
      expect(
        () =>
          createServerAdminKeyStore({
            dataDir: dir,
            env: { [ADMIN_KEY_ENV]: raw },
            platform: 'win32',
            print: () => {}
          }),
        `raw=${JSON.stringify(raw)}`
      ).toThrowError(new RegExp(ADMIN_KEY_ENV))
      // 关键：拒启时不得顺手把新密钥写到盘上（否则下次启动变成冲突态）
      expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(false)
    }
  })

  it('环境变量两侧空白被容忍（编排文件里的换行 / 缩进不该变成故障）', () => {
    const dir = tempDir('env-trim')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: { [ADMIN_KEY_ENV]: '  padded-preset-key-0000000000000000001  \n' },
      platform: 'win32',
      print: () => {}
    })
    expect(store.get()).toBe('padded-preset-key-0000000000000000001')
  })
})

describe('W-B 文件故障态：与账号数据端口同一条不变量（「在但读不出来」≠「没有」）', () => {
  it('文件存在但长度为 0 → 拒绝启动，**绝不**当成没有密钥而生成新的', () => {
    const dir = tempDir('empty-file')
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    writeFileSync(file, '')

    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'win32',
        print: () => {}
      })
    ).toThrowError(/0|空/)

    // 原文件不得被新密钥覆盖（它旁边可能还有一份能用的备份，且覆盖会静默换掉凭据）
    expect(readFileSync(file, 'utf-8')).toBe('')
  })

  it('密钥文件是个目录（EISDIR）→ 拒绝启动而非视为不存在', () => {
    const dir = tempDir('isdir')
    mkdirSync(join(dir, ADMIN_KEY_FILE_NAME))

    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'win32',
        print: () => {}
      })
    ).toThrow()
  })

  it('数据目录尚不存在 → 自己建出来（首次启动的真实形态），不因 ENOENT 崩掉', () => {
    const parent = tempDir('mkdir')
    const dataDir = join(parent, 'nested', 'kiro-data')

    const store = createServerAdminKeyStore({
      dataDir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {}
    })

    expect(store.get()).toBeTruthy()
    expect(existsSync(join(dataDir, ADMIN_KEY_FILE_NAME))).toBe(true)
  })
})

describe('W-B 迁移决定：**不**回退读桌面 store 里的 webPanelAdminKey', () => {
  it('手工直拷来的 kiro-accounts.json 带着桌面密钥时，服务端仍生成自己的新密钥并打印', () => {
    const dir = tempDir('migrate')
    const desktopKey = 'desktop-panel-key-copied-in-data-file-01'

    // 用桌面侧同一套参数写一份真实的 store 文件（决策卡唯一正式支持的迁移工件）
    const conf = new Conf({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
    })
    conf.set('webPanelAdminKey', desktopKey)
    conf.set('accountData', { accounts: { a1: { id: 'a1' } }, revision: 1 })
    expect(existsSync(join(dir, `${ACCOUNT_STORE_NAME}.json`))).toBe(true)

    const out = collector()
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink
    })

    // 决定：服务端从零开始 —— 桌面密钥有未知暴露史（设置页展示过、随数据文件跨机搬运过），
    // 静默继承它会让运维得不到任何信号。新密钥被打印出来，这就是那个信号。
    expect(store.get()).not.toBe(desktopKey)
    expect(store.source).toBe('generated')
    expect(out.text()).toContain(store.get() as string)

    // 且不得改动那份被直拷进来的账号数据（I1b：迁移不改源数据）
    const reread = new Conf({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
    })
    expect(reread.get('webPanelAdminKey')).toBe(desktopKey)
  })

  it('运维给了「数据文件里有桌面密钥」的提示时，打印里明说那把旧钥匙不生效', () => {
    const dir = tempDir('migrate-hint')
    const out = collector()

    createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink,
      legacyDesktopKeyPresent: true
    })

    // 最可能的运维困惑是「我拷了数据文件，为什么桌面上的密钥登不进去」
    expect(out.text()).toMatch(/桌面/)
  })
})

describe('W-B set()：轮换语义在两种来源下不同', () => {
  it('文件来源 → set() 重写文件，读回是新值（供桌面式轮换复用同一端口）', () => {
    const dir = tempDir('set-file')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {}
    })
    const before = store.get()

    store.set('rotated-key-value-000000000000000000001')

    expect(store.get()).toBe('rotated-key-value-000000000000000000001')
    expect(readFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'utf-8').trim()).toBe(
      'rotated-key-value-000000000000000000001'
    )
    expect(store.get()).not.toBe(before)
  })

  it('文件来源 → set() 不打印新密钥（轮换不该把凭据写进容器日志）', () => {
    const dir = tempDir('set-noprint')
    const out = collector()
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink
    })
    const printedAtBootstrap = out.lines.length

    store.set('rotated-key-value-000000000000000000002')

    expect(out.lines.length).toBe(printedAtBootstrap)
    expect(out.text()).not.toContain('rotated-key-value-000000000000000000002')
  })

  it('环境变量来源 → set() 抛错：写文件会造出下次启动必然拒启的冲突态', () => {
    const dir = tempDir('set-env')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: { [ADMIN_KEY_ENV]: 'env-managed-key-00000000000000000001' },
      platform: 'win32',
      print: () => {}
    })

    expect(() => store.set('anything-else-00000000000000000000001')).toThrowError(
      new RegExp(ADMIN_KEY_ENV)
    )
    // 抛错之后盘上仍然没有文件（否则下次启动就撞上冲突拒启）
    expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(false)
    expect(store.get()).toBe('env-managed-key-00000000000000000001')
  })
})

describe('W-B 与面板的契约：满足既有 AdminKeyStore 端口，面板红线自然成立', () => {
  it('可直接注入 PanelAuth：ensureAdminKey 不再走生成分支，hasAdminKey 为真', () => {
    const dir = tempDir('panel')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {}
    })
    const bootstrapped = store.get()

    const auth = new PanelAuth(store)
    // 外网绑定红线（server.ts:117）判的就是 hasAdminKey —— 装配即成立，无需装配层记得先生成
    expect(auth.hasAdminKey()).toBe(true)
    expect(auth.ensureAdminKey()).toBe(bootstrapped)
    // 文件内容没被 ensureAdminKey 换掉
    expect(readFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'utf-8').trim()).toBe(bootstrapped)
  })

  it('注入后可用该密钥登录成功，用别的密钥登录失败（端到端凭据真的生效）', () => {
    const dir = tempDir('panel-login')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {}
    })
    const auth = new PanelAuth(store)

    const good = auth.login(store.get() as string, '10.0.0.7')
    expect(good.ok).toBe(true)
    expect(good.setCookie).toBeTruthy()

    const bad = auth.login('not-the-key', '10.0.0.8')
    expect(bad.ok).toBe(false)
  })

  it('adminKeyFilePath 是密钥文件位置的单一真源（供部署文档 / 遗失恢复引用）', () => {
    const dir = tempDir('path')
    expect(adminKeyFilePath(dir)).toBe(join(dir, ADMIN_KEY_FILE_NAME))
  })
})

describe('W-B 零 electron 依赖（服务端形态的前提）', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('platform 缺省时取 process.platform（装配层无需显式传）', () => {
    const dir = tempDir('default-platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const store = createServerAdminKeyStore({ dataDir: dir, env: emptyEnv(), print: () => {} })
    expect(store.get()).toBeTruthy()
  })
})

describe('W-B 拒启退出码分类（运维在 journalctl 里要能区分该改哪里）', () => {
  /**
   * 为什么这一族必须有分类退出码，而不是一律 69：
   *
   * `config.ts` 头部的退出码表把 73 EX_CANTCREAT 明确分配给「密钥文件权限设不上」、
   * 把 78 EX_CONFIG 明确分配给「环境变量与密钥文件冲突」——那两句描述的就是本文件
   * 这四道拒启闸门，不是账号数据那一族（数据那族的四态已由 `preflightForServerWithExitCode`
   * 覆盖 64/65/73）。而实测(2026-08-12 · Linux 容器 · node v22.23.2)四道闸门全部退 **69**：
   * `entry.ts:214` 只对 `ServerConfigError` 取 `exitCode`，`adminKeyStore` 抛的是裸 `Error`，
   * 于是统统落进 `EXIT.UNAVAILABLE` 兜底。
   *
   * 后果是运维视角的：`chmod` 问题、编排文件里两个真源冲突、端口被占、面板起不来
   * 在 `systemctl status` 里长得**完全一样**（都是 69），而这四件事的修法互不相同。
   * 决策卡「运营注册 · 启动失败反馈」要求的正是「四种拒启都有可读退出信息」。
   */
  it('权限过宽拒启 → 带 EXIT.CANNOT_CREATE(73)，不是兜底的 69', () => {
    const dir = tempDir('exit-perm')
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'pre-existing-key-value-aaaaaaaaaaaaaaaaaaa\n')

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'linux',
        print: () => {}
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.CANNOT_CREATE)
    expect((thrown as Error).message).toMatch(/权限|chmod/)
  })

  it('env 与文件不一致拒启 → 带 EXIT.CONFIG(78)（此前 78 全仓零生产用点）', () => {
    const dir = tempDir('exit-conflict')
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'key-from-file-aaaaaaaaaaaaaaaaaaaaaaaaaa\n')

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: { ...emptyEnv(), [ADMIN_KEY_ENV]: 'key-from-env-bbbbbbbbbbbbbbbbbbbbbbbb' },
        platform: 'win32', // 排除权限闸门这个变量，单看冲突这一条
        print: () => {}
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.CONFIG)
    expect((thrown as Error).message).toMatch(new RegExp(ADMIN_KEY_ENV))
  })

  it('env 设置但为空拒启 → 带 EXIT.USAGE(64)（环境变量用法错，非数据也非权限）', () => {
    const dir = tempDir('exit-emptyenv')

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: { ...emptyEnv(), [ADMIN_KEY_ENV]: '   ' },
        platform: 'linux',
        print: () => {}
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.USAGE)
  })

  it('密钥文件在但内容为空拒启 → 带 EXIT.DATA_ERROR(65)（盘上的东西坏了，同数据族语义）', () => {
    const dir = tempDir('exit-zerobyte')
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), '')

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'linux',
        print: () => {}
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.DATA_ERROR)
  })

  it('四道闸门的退出码互不相同（否则运维读一个码仍不知该改哪里）', () => {
    const codes = new Set<number>()

    const permDir = tempDir('distinct-perm')
    writeFileSync(join(permDir, ADMIN_KEY_FILE_NAME), 'k'.repeat(40) + '\n')
    try {
      createServerAdminKeyStore({ dataDir: permDir, env: emptyEnv(), platform: 'linux', print: () => {} })
    } catch (e) {
      codes.add((e as ServerConfigError).exitCode)
    }

    const conflictDir = tempDir('distinct-conflict')
    writeFileSync(join(conflictDir, ADMIN_KEY_FILE_NAME), 'f'.repeat(40) + '\n')
    try {
      createServerAdminKeyStore({
        dataDir: conflictDir,
        env: { ...emptyEnv(), [ADMIN_KEY_ENV]: 'e'.repeat(40) },
        platform: 'win32',
        print: () => {}
      })
    } catch (e) {
      codes.add((e as ServerConfigError).exitCode)
    }

    const emptyDir = tempDir('distinct-empty')
    try {
      createServerAdminKeyStore({
        dataDir: emptyDir,
        env: { ...emptyEnv(), [ADMIN_KEY_ENV]: '  ' },
        platform: 'linux',
        print: () => {}
      })
    } catch (e) {
      codes.add((e as ServerConfigError).exitCode)
    }

    const zeroDir = tempDir('distinct-zero')
    writeFileSync(join(zeroDir, ADMIN_KEY_FILE_NAME), '')
    try {
      createServerAdminKeyStore({ dataDir: zeroDir, env: emptyEnv(), platform: 'linux', print: () => {} })
    } catch (e) {
      codes.add((e as ServerConfigError).exitCode)
    }

    // 四道闸门各退一个不同的码，且没有一个是兜底的 UNAVAILABLE
    expect(codes.size).toBe(4)
    expect(codes.has(EXIT.UNAVAILABLE)).toBe(false)
  })
})
