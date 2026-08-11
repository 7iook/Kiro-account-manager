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
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Conf from 'conf'

import {
  createServerAdminKeyStore,
  classifyKeyFilePermission,
  classifyAdminKeyStrength,
  adminKeyFilePath,
  ADMIN_KEY_ENV,
  ADMIN_KEY_FILE_NAME,
  ALLOW_UNPROTECTED_KEY_FILE_ENV,
  MIN_ADMIN_KEY_LENGTH
} from '@main/server/adminKeyStore'
import { PanelAuth, generateAdminKey } from '@main/webPanel/auth'
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

/**
 * 无环境变量的干净 env（不继承宿主机可能已设的 KIRO_ADMIN_KEY），
 * **并带上「Windows 密钥文件保护无从证明」的开发机 opt-in**。
 *
 * 为什么 opt-in 放在这个共享 helper 里而不是逐条测试加：P1-2 之后 win32 上
 * 「盘上有密钥文件」默认拒启（决策卡规则 3 逐字：无法设置 0600 则拒绝启动）。
 * 而本文件绝大多数测试用 `platform:'win32'` 的目的是**把权限这个变量中和掉**，
 * 好单看别的判据（写事务 / 冲突 / 强度 / 打印）。它们的主题不是权限策略，
 * 故在这里一次性承担那个风险，语义与它们原本的意图完全一致。
 *
 * 要真的验「拒启」这一态的测试请用 `bareEnv()` —— 它不带 opt-in。
 */
function emptyEnv(): NodeJS.ProcessEnv {
  return { [ALLOW_UNPROTECTED_KEY_FILE_ENV]: '1' }
}

/** 真正空的 env（连 opt-in 都没有）—— 用于断言 win32 默认拒启 */
function bareEnv(): NodeJS.ProcessEnv {
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
      // 盘上有密钥文件 + win32 → 需要 opt-in（P1-2：无法证明其权限则拒启）。
      // 本条测的是「两个来源一致时放行」，故把权限这个变量中和掉。
      env: { ...emptyEnv(), [ADMIN_KEY_ENV]: key },
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

/**
 * 写事务：**在密钥「既通过权限验证、又已交付给需要它的人」之前，绝不提交到盘上。**
 *
 * 这一族的成因是 `renameSync` 就是提交点，而权限复检与打印原本都在它之后 ——
 * 于是失败会留下「盘上已生效、但没有任何人拿到过」的密钥。那是永久锁死：
 * 面板是服务器上唯一的管理入口，而按规则 2 那把钥匙再也不会被打印。
 *
 * 「交付」在两条路径上不是一回事，故分别验：
 *   - 首启生成 → 交付 = **打印出来**（那是运维唯一一次看见它的机会）
 *   - 轮换 → 交付 = **`set()` 正常返回**，新值回到调用方手里
 *
 * 断言一律选在可观察结局上：盘上是什么 / 调用方拿到了什么 / 模拟重启读到什么 /
 * 终端里有没有出现过它。不断言「调了哪个内部函数」（E-052 那族的成因正是断言选错时点）。
 */
describe('W-B 写事务：未交付的密钥绝不留在盘上（P1-1 / P1-3 回归）', () => {
  /**
   * 本组固定用 win32 + 显式承担风险（`allowUnprotectedKeyFile`）。
   *
   * 理由：本组要验的是**写事务的边界**，不是权限判据本身。win32 上无法证明
   * 「只有服务账户可读」，按 P1-2 的闸门默认拒启 —— 那条拒启与本组无关，
   * 所以显式 opt-in 把它排除掉，让每条测试只剩事务这一个变量。
   * 权限闸门自身的行为由「规则 3」那一组负责。
   */
  function txStore(
    dir: string,
    over: Partial<Parameters<typeof createServerAdminKeyStore>[0]> = {}
  ): ReturnType<typeof createServerAdminKeyStore> {
    return createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      allowUnprotectedKeyFile: true,
      print: () => {},
      warn: () => {},
      ...over
    })
  }

  it('首启打印失败 → 回滚：盘上不留文件，重启时重新生成并打印（P1-3）', () => {
    const dir = tempDir('tx-print-fail')
    const file = join(dir, ADMIN_KEY_FILE_NAME)

    // stdout 已关闭 / 容器日志驱动故障的真实形态：print 抛出
    expect(() =>
      txStore(dir, {
        print: () => {
          throw new Error('EPIPE: stdout 已关闭')
        }
      })
    ).toThrowError(/EPIPE/)

    // 结局①：盘上没有留下那把从未被打印的密钥
    expect(existsSync(file)).toBe(false)

    // 结局②：模拟重启 —— 仍走首启分支，重新生成并**打印**（不是静默读回一把没人有的钥匙）
    const out = collector()
    const restarted = txStore(dir, { print: out.sink })
    expect(out.text()).toContain(restarted.get())
    expect(readFileSync(file, 'utf-8').trim()).toBe(restarted.get())
  })

  it('轮换时提交失败（rename EPERM）→ 盘上、内存、重启后三者一致地留在旧密钥（P1-1）', () => {
    const dir = tempDir('tx-rotate-eperm')
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    const store = txStore(dir)
    const oldKey = store.get()

    // 本机实测(2026-08-12 · win32 · node v22.20.0)：目标文件只读时 rename 到它 → EPERM。
    // 这是「轮换写盘失败」的真实形态之一（只读挂载 / ACL 拒写同族）。
    const injected = 'rotated-but-never-delivered-000000000001'
    chmodSync(file, 0o444)
    try {
      expect(() => store.set(injected)).toThrowError(/adminKey/)
    } finally {
      chmodSync(file, 0o666)
    }

    // 结局①：调用方没拿到新值（`set()` 抛了）→ 内存必须还是旧的
    expect(store.get()).toBe(oldKey)
    // 结局②：盘上也必须还是旧的，且不含新值的任何痕迹
    expect(readFileSync(file, 'utf-8').trim()).toBe(oldKey)
    expect(readFileSync(file, 'utf-8')).not.toContain(injected)
    // 结局③：模拟重启读到的仍是运维手上那把（此前重启会切到一把没人拿到过的新密钥 = 锁死）
    expect(txStore(dir).get()).toBe(oldKey)
  })

  it('轮换时交付环节失败 → 盘上、内存、重启后三者一致地留在旧密钥（P1-1 核心）', () => {
    const dir = tempDir('tx-rotate-verify-fail')
    const file = join(dir, ADMIN_KEY_FILE_NAME)

    // 故障注入点是 `warn`：win32 上「无法证明只有服务账户可读」经它每次启动上报，
    // 而 stderr 被关闭 / 日志 sink 断开时写它就抛 —— 这是「权限环节失败」的真实形态之一。
    // 不假设实现在提交前还是提交后检查权限：无论闸门在哪一侧，下面断言的结局都必须成立。
    // （修复前只在提交后检查，于是这里必然留下内存/磁盘/重启三态分叉。）
    let armed = false
    const store = txStore(dir, {
      warn: () => {
        if (armed) throw new Error('EPIPE: stderr 已关闭')
      }
    })
    const oldKey = store.get()
    expect(readFileSync(file, 'utf-8').trim()).toBe(oldKey)

    armed = true
    const injected = 'rotated-but-never-delivered-000000000001'
    expect(() => store.set(injected)).toThrowError(/EPIPE/)

    // 结局①：调用方没拿到新值（`set()` 抛了）→ 内存必须还是旧的
    expect(store.get()).toBe(oldKey)
    // 结局②：盘上也必须还是旧的。修复前这里是新密钥 —— 内存/磁盘分叉的核心
    expect(readFileSync(file, 'utf-8').trim()).toBe(oldKey)
    expect(readFileSync(file, 'utf-8')).not.toContain(injected)
    // 结局③：重启后读到的仍是运维手上那把。修复前重启会切到一把从未交付的新密钥 = 锁死
    expect(txStore(dir).get()).toBe(oldKey)
    // 结局④：盘上不留 .tmp / .rollback 残骸（它们含明文密钥且不受任何闸门看管）
    expect(readdirSync(dir)).toEqual([ADMIN_KEY_FILE_NAME])
  })

  it('轮换成功时三者一致前进，且不留含明文密钥的中间文件（事务的正向形态）', () => {
    const dir = tempDir('tx-rotate-ok')
    const file = join(dir, ADMIN_KEY_FILE_NAME)

    // 前几条都在验失败结局；这一条守住成功结局不被回滚逻辑改坏 ——
    // 「失败就恢复旧值」的实现最容易顺手把成功路径也一起挡住。
    // 另外它守住「盘上不留中间文件」：.tmp / .rollback 都含明文密钥，
    // 且它们不受任何权限闸门看管（闸门只认那个固定文件名）。
    const store = txStore(dir)
    const oldKey = store.get()

    const rotated = 'rotated-and-delivered-0000000000000001'
    store.set(rotated)
    expect(store.get()).toBe(rotated)
    expect(readFileSync(file, 'utf-8').trim()).toBe(rotated)
    expect(readFileSync(file, 'utf-8')).not.toContain(oldKey)
    // 成功路径也不得留下含明文密钥的 .tmp / .rollback 残骸
    expect(readdirSync(dir)).toEqual([ADMIN_KEY_FILE_NAME])
    // 重启后读到的是轮换后那把
    expect(txStore(dir).get()).toBe(rotated)
  })

  it('首启权限校验失败 → 盘上不留文件（未交付的密钥不得成为下次启动读到的那把）', () => {
    const dir = tempDir('tx-gen-perm')
    const file = join(dir, ADMIN_KEY_FILE_NAME)

    // platform:'linux' + 真实 Windows 盘 = 「我尝试设 0600 但设不上」这一态（规则 3 要求拒启）
    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'linux',
        print: () => {},
        warn: () => {}
      })
    ).toThrowError(/权限/)

    // 留着它就是永久锁死：下次启动读到它、按规则 2 不再打印，而它从未出现在任何输出里
    expect(existsSync(file)).toBe(false)
    // 明文密钥也不得以 .tmp 形态留在盘上
    expect(readdirSync(dir)).toEqual([])
  })

  it('写入前读不出目标 → 拒绝开始事务，且不覆盖任何东西（无法保证能恢复就不该动它）', () => {
    const dir = tempDir('tx-snapshot-unreadable')
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    const store = txStore(dir)
    const oldKey = store.get()

    // 让目标路径变成「在，但读不出来」（EISDIR —— 与 `readKeyFile` 那条不变量同源）。
    // 事务此时必须拒绝开始：读不出旧内容就等于失败后无法恢复，而覆盖一把正在生效的凭据
    // 却无法回滚，正是这轮要消除的那类锁死。
    unlinkSync(file)
    mkdirSync(file)

    const injected = 'must-not-be-written-00000000000000000001'
    expect(() => store.set(injected)).toThrowError(/adminKey/)

    // 结局：那个位置仍是原来的目录（没被换成新密钥文件），内存也没前进
    expect(statSync(file).isDirectory()).toBe(true)
    expect(store.get()).toBe(oldKey)
    // 明文密钥不得以 .tmp 残骸形态留在盘上
    expect(readdirSync(dir)).toEqual([ADMIN_KEY_FILE_NAME])
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

describe('W-B P1-5：预置密钥的强度校验 —— env 与文件两条路径同判', () => {
  /**
   * 缺陷本体：自动生成路径有 256bit 熵，而 env / 文件预置路径此前只 trim + 判空，
   * 于是 `KIRO_ADMIN_KEY=x` 会被当成局域网面板的管理员凭据接受。
   *
   * 策略选择（min-length 32，而非「必须等于生成器的 43 字符 base64url」）：
   *   - 严格格式会误拒密码管理器给的 64 字符 hex 等**更强**的值 —— 一条把
   *     「运维把凭据收得更紧」变成故障的规则，与权限判据用「不得更宽」而非
   *     「必须等于 0600」是同一条取舍。
   *   - 32 这个数不是新造的：`secureBackupCipher.aesGcm.ts:47` 的
   *     `MIN_BACKUP_KEY_LENGTH` 已经是同一套口令故事，全项目保持一套判据。
   *   - 威胁模型是**在线**猜测（无离线密文可爆破，`loginThrottle.ts:18-22` 已按 IP
   *     5 次失败指数锁定），故「足够长」就够，不需要熵评分器 —— 那种东西只会
   *     冒充真实熵证明（同 P2-1 的结论）。
   */
  it('纯函数：明显过短的值被判 too-short（这就是 KIRO_ADMIN_KEY=x 的形状）', () => {
    for (const weak of ['x', 'admin', 'changeme', 'kiro-admin-2026', 'a'.repeat(31)]) {
      const verdict = classifyAdminKeyStrength(weak)
      expect(verdict.kind, `weak=${weak}`).toBe('too-short')
    }
  })

  it('纯函数：生成器自己的输出必须通过（否则新校验会把首启路径判死）', () => {
    for (let i = 0; i < 20; i++) {
      expect(classifyAdminKeyStrength(generateAdminKey()).kind).toBe('ok')
    }
  })

  it('纯函数：密码管理器风格的长随机值通过（判据是「不得更弱」，不是「必须同格式」）', () => {
    // 64 字符 hex：比生成器的 43 字符 base64url 更长，熵更高，不该被误拒
    expect(classifyAdminKeyStrength('f'.repeat(64)).kind).toBe('ok')
    // 32 字符正好在门槛上
    expect(classifyAdminKeyStrength('a'.repeat(32)).kind).toBe('ok')
  })

  it('纯函数：含控制字符 / 内部空白 → bad-chars（该值要进 HTTP 头与输入框）', () => {
    const a = 'a'.repeat(20)
    const b = 'b'.repeat(20)
    const codes = [32, 9, 10, 13, 0, 127]
    for (const code of codes) {
      const value = a + String.fromCharCode(code) + b
      // 先自证样本真的含了那个字符 —— 否则断言可能在测一个空插入而假绿。
      // （构造用 fromCharCode 而非字面控制字符：后者跨工具写入会被静默改写，
      //   本轮实测字面 NUL 被写成了空字符串。）
      expect(value.length, `code=${code}`).toBe(41)
      expect(classifyAdminKeyStrength(value).kind, `code=${code}`).toBe('bad-chars')
    }
  })

  it('纯函数：base64 与 base64url 的字母表都不被误拒（判据是白名单可打印 ASCII）', () => {
    // 实测判据行为（一次性 probe，已删）：生成器 43 字符 ok · hex64 ok ·
    // `-`/`_` ok · `+`/`/`/`=` ok · NUL/DEL/tab/空格 bad-chars · CJK bad-chars。
    // `-` 与 `_` 必须通过 —— 那是生成器 base64url 的合法字母表，误拒会把首启路径判死。
    expect(classifyAdminKeyStrength(`${'-_'.repeat(20)}abc`).kind).toBe('ok')
    // 标准 base64（运维用 `openssl rand -base64 32` 的自然产物）同样通过
    expect(classifyAdminKeyStrength(`${'a'.repeat(30)}+/=`).kind).toBe('ok')
  })

  it('纯函数：非 ASCII（含 CJK）被判 bad-chars —— 这是白名单的**有意**后果', () => {
    // 不是漏网也不是歧视：该值要经 HTTP 头传输，而 HTTP 头历史上是 latin-1 语义，
    // 非 ASCII 在某一环被重编码就变成「密钥突然不对了」，且极难归因。
    // 运维想用中文口令的正确答案是「用生成的随机值」，不是让它在传输链上碰运气。
    expect(classifyAdminKeyStrength('密'.repeat(40)).kind).toBe('bad-chars')
  })

  it('env 预置一个单字符密钥 → **拒绝启动**（此前会被当成合法管理员凭据放行）', () => {
    const dir = tempDir('weak-env')

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: { [ADMIN_KEY_ENV]: 'x' },
        platform: 'linux',
        print: () => {}
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    // 用法错（env 给了个不合规的值），与「env 已设置但为空」同族 → 64
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.USAGE)
    expect((thrown as Error).message).toContain(ADMIN_KEY_ENV)
    expect((thrown as Error).message).toMatch(new RegExp(String(MIN_ADMIN_KEY_LENGTH)))
    // 不得把弱密钥明文抄进错误信息（它会进 journal / systemctl status）
    expect((thrown as Error).message).not.toMatch(/[:：]\s*x\s*$/m)
    // 拒启不得留副作用（否则下次启动撞上冲突拒启）
    expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(false)
  })

  it('盘上文件里是个弱密钥 → **拒绝启动**，且不覆盖该文件', () => {
    const dir = tempDir('weak-file')
    const file = join(dir, ADMIN_KEY_FILE_NAME)
    writeFileSync(file, 'admin\n')

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: emptyEnv(),
        platform: 'win32', // 排除权限闸门这个变量，单看强度这一条
        print: () => {},
        allowUnprotectedKeyFile: true
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    // 盘上的东西不合规 → 与「文件内容为空」同族 65
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.DATA_ERROR)
    expect((thrown as Error).message).toContain(file)
    // 绝不「修复」它：覆盖会静默换掉运维可能仍在用的凭据（同零字节那条不变量）
    expect(readFileSync(file, 'utf-8')).toBe('admin\n')
  })

  it('env 与文件**两条路径判据完全一致**（同一个弱值，两边都拒启）', () => {
    const weak = 'too-short-key'

    const envDir = tempDir('same-env')
    expect(() =>
      createServerAdminKeyStore({
        dataDir: envDir,
        env: { [ADMIN_KEY_ENV]: weak },
        platform: 'win32',
        print: () => {},
        allowUnprotectedKeyFile: true
      })
    ).toThrowError(ServerConfigError)

    const fileDir = tempDir('same-file')
    writeFileSync(join(fileDir, ADMIN_KEY_FILE_NAME), `${weak}\n`)
    expect(() =>
      createServerAdminKeyStore({
        dataDir: fileDir,
        env: emptyEnv(),
        platform: 'win32',
        print: () => {},
        allowUnprotectedKeyFile: true
      })
    ).toThrowError(ServerConfigError)
  })

  it('强度校验发生在**启动期**，不是等到有人猜中密钥才暴露', () => {
    // 判据：构造函数就抛，故不存在「服务在跑、但凭据是 x」这个状态
    const dir = tempDir('startup-not-login')
    let store: unknown = null
    try {
      store = createServerAdminKeyStore({
        dataDir: dir,
        env: { [ADMIN_KEY_ENV]: 'x' },
        platform: 'win32',
        print: () => {}
      })
    } catch {
      /* 期望走到这里 */
    }
    expect(store).toBeNull()
  })

  it('set() 轮换也走同一校验：拒绝写入弱密钥，且盘上旧密钥不变', () => {
    // 为什么 set() 必须共用校验器：放过一个弱值并落盘 → 下次启动被新的文件闸门拒启，
    // 运维就被永久锁在面板外。这不是镀金，是不造出「不可启动状态」。
    const dir = tempDir('set-weak')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {},
      allowUnprotectedKeyFile: true
    })
    const before = store.get()

    expect(() => store.set('x')).toThrowError(new RegExp(String(MIN_ADMIN_KEY_LENGTH)))

    expect(store.get()).toBe(before)
    expect(readFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'utf-8').trim()).toBe(before as string)
  })

  it('set() 接受生成器输出（面板轮换的真实形态不受影响）', () => {
    const dir = tempDir('set-rotate-ok')
    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: () => {},
      allowUnprotectedKeyFile: true
    })

    // PanelAuth.rotateAdminKey() 就是「generateAdminKey() → keyStore.set()」
    const rotated = new PanelAuth(store).rotateAdminKey()

    expect(classifyAdminKeyStrength(rotated).kind).toBe('ok')
    expect(store.get()).toBe(rotated)
    expect(readFileSync(join(dir, ADMIN_KEY_FILE_NAME), 'utf-8').trim()).toBe(rotated)
  })
})

describe('W-B P1-2：Windows 上无法证明密钥文件只有服务账户可读 → 拒启，而非告警放行', () => {
  /**
   * 决策卡规则 3 逐字是「若无法设置该权限则拒绝启动」。此前 win32 走告警放行，
   * 直接违反它 —— 而告警建立不了任何访问控制。
   *
   * 为什么不去读 NTFS ACL 来证明：纯 Node 无原生依赖时只能 shell 出
   * `icacls` / `Get-Acl` 并解析**本地化**输出（中文系统上是「完全控制」而非
   * `(F)`）。用一个会静默误判的解析器做安全裁决，比诚实地说「证明不了」更糟；
   * 且会给一个刻意零 electron / 零原生依赖的内核模块引进 `child_process`。
   *
   * 于是判据回到诚实的形状：**证明不了就不放行**，除非运维显式承担这个风险。
   * 精确边界：Windows 上不被支持的是**密钥文件**，不是服务端形态本身 ——
   * 走 `KIRO_ADMIN_KEY` 预置时根本不落密钥文件，那条路径在 Windows 上仍完全受支持。
   */
  it('win32 + 盘上已有密钥文件 → 拒绝启动，退出码 73，文案给出两条出路', () => {
    const dir = tempDir('win-refuse-existing')
    const key = generateAdminKey()
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), `${key}\n`)

    let thrown: unknown = null
    try {
      createServerAdminKeyStore({
        dataDir: dir,
        env: bareEnv(),
        platform: 'win32',
        print: () => {}
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect((thrown as ServerConfigError).exitCode).toBe(EXIT.CANNOT_CREATE)
    const msg = (thrown as Error).message
    // 出路一：用环境变量预置（不落密钥文件，Windows 上受支持）
    expect(msg).toContain(ADMIN_KEY_ENV)
    // 出路二：开发机显式承担风险
    expect(msg).toContain(ALLOW_UNPROTECTED_KEY_FILE_ENV)
    // 不得泄漏密钥明文（错误会进日志）
    expect(msg).not.toContain(key)
  })

  it('win32 + 首启生成 → 同样拒绝启动，且**不留下**那个刚写的密钥文件', () => {
    // 留下它的后果是永久锁死：下次启动读到它、按规则 2 不再打印，
    // 而它从未出现在任何输出里 —— 与既有 rollback 不变量同源。
    const dir = tempDir('win-refuse-generate')

    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: bareEnv(),
        platform: 'win32',
        print: () => {}
      })
    ).toThrowError(ServerConfigError)

    expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(false)
  })

  it('win32 + 显式 opt-in（选项形式）→ 放行，但**每次启动都告警**（不是一次性提示）', () => {
    const dir = tempDir('win-optin')
    const first = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: bareEnv(),
      platform: 'win32',
      print: () => {},
      warn: first.sink,
      allowUnprotectedKeyFile: true
    })
    expect(store.get()).toBeTruthy()
    expect(first.text()).toMatch(/Windows/)

    // 重启：文件已在，告警必须再来一次 —— 一个只在首启说一次的风险提示等于没说
    const second = collector()
    createServerAdminKeyStore({
      dataDir: dir,
      env: bareEnv(),
      platform: 'win32',
      print: () => {},
      warn: second.sink,
      allowUnprotectedKeyFile: true
    })
    expect(second.text()).toMatch(/Windows/)
  })

  it('win32 + 环境变量 opt-in → 放行（开发机用 env 而不必改代码）', () => {
    const dir = tempDir('win-optin-env')
    const warns = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: { [ALLOW_UNPROTECTED_KEY_FILE_ENV]: '1' },
      platform: 'win32',
      print: () => {},
      warn: warns.sink
    })

    expect(store.get()).toBeTruthy()
    expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(true)
    expect(warns.text()).toMatch(/Windows/)
  })

  it('win32 + env 预置密钥 → 放行且不需要 opt-in（该路径根本不落密钥文件）', () => {
    // 这是 Windows 上受支持的服务端形态：Docker secrets / systemd Environment=
    const dir = tempDir('win-env-preset')
    const preset = generateAdminKey()
    const warns = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: { [ADMIN_KEY_ENV]: preset },
      platform: 'win32',
      print: () => {},
      warn: warns.sink
    })

    expect(store.get()).toBe(preset)
    expect(store.source).toBe('env')
    // 没有密钥文件 → 没有「无法证明其权限」的对象 → 无需 opt-in、也无需告警
    expect(existsSync(join(dir, ADMIN_KEY_FILE_NAME))).toBe(false)
    expect(warns.lines).toEqual([])
  })

  it('POSIX 路径不受本条影响：linux + 0600 仍正常放行，不要求任何 opt-in', () => {
    // 判据仍是平台事实（POSIX 位存在即可施加），不是「所有平台都要 opt-in」
    expect(classifyKeyFilePermission(0o600, 'linux').kind).toBe('ok')
    const dir = tempDir('posix-unaffected')
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), `${generateAdminKey()}\n`)
    // 真实 Windows 盘上 stat 读回 0o666 = POSIX 判据下的「过宽」，
    // 故这里只能断言分类器；端到端 linux+0600 由既有那条覆盖。
    expect(classifyKeyFilePermission(0o666, 'linux').kind).toBe('too-open')
  })

  it('opt-in **不能**放过 POSIX 上真正过宽的权限（它只覆盖「无法表达」这一态）', () => {
    const dir = tempDir('optin-not-a-bypass')
    writeFileSync(join(dir, ADMIN_KEY_FILE_NAME), `${generateAdminKey()}\n`)

    // 真实 Windows 盘写出的文件 stat 即 0o666，按 linux 判据是 too-open
    expect(() =>
      createServerAdminKeyStore({
        dataDir: dir,
        env: { [ALLOW_UNPROTECTED_KEY_FILE_ENV]: '1' },
        platform: 'linux',
        print: () => {},
        allowUnprotectedKeyFile: true
      })
    ).toThrowError(/权限|chmod/)
  })
})

describe('W-B P1-4：首启打印必须诚实说出「这把钥匙已经在日志里」', () => {
  /**
   * 保留 stdout 交付（决策卡明文裁决，且无头机器上运维没有第二通道 ——
   * 一个需要第二通道的方案比现状更糟）。真正的缺陷是**文案在说谎**：
   * 旧文案「之后启动不再打印它 —— 否则容器日志里长期留着有效凭据」暗示
   * 日志里没有它，而第一次打印早已在 journal / 容器日志 / 终端回滚缓冲里
   * 留下持久副本，且日志读者面远大于「该管面板的人」。
   *
   * 断言选在「运维读到了什么」上：暴露事实 + 一个真实可用的补救动作。
   * 轮换是真闭环而不是空口建议 —— `rotateAdminKey()` 不打印，
   * 故轮换后的新钥匙从未碰过日志。
   */
  it('打印里明说这把钥匙已进入日志 / journal，且读日志者都能看到', () => {
    const dir = tempDir('notice-exposure')
    const out = collector()

    createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink,
      allowUnprotectedKeyFile: true
    })

    const text = out.text()
    // 暴露载体要被点名（运维得知道去哪儿清）
    expect(text).toMatch(/journal|容器日志/)
    // 「谁能看到」要被说出来 —— 这是与旧文案自相矛盾处的正面修正
    expect(text).toMatch(/日志.*(权限|读|可见)|凡能读/)
  })

  it('打印里给出「首次登录后立刻轮换」这个可执行补救，并说明轮换不进日志', () => {
    const dir = tempDir('notice-rotate')
    const out = collector()

    createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink,
      allowUnprotectedKeyFile: true
    })

    expect(out.text()).toMatch(/轮换/)
  })

  it('打印里给出「彻底不经日志交付」的那条路：环境变量预置', () => {
    const dir = tempDir('notice-preset')
    const out = collector()

    createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink,
      allowUnprotectedKeyFile: true
    })

    expect(out.text()).toContain(ADMIN_KEY_ENV)
  })

  it('文案不再声称「不打印就等于日志里没有凭据」这个自相矛盾的威胁模型', () => {
    const dir = tempDir('notice-no-lie')
    const out = collector()

    createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink,
      allowUnprotectedKeyFile: true
    })

    // 旧文案的谎言形状：「之后启动不再打印它 —— 否则容器日志里会长期留着一份有效凭据」
    // 它把「以后不打印」说成了「日志里没有凭据」的保证。
    expect(out.text()).not.toMatch(/否则容器日志里会长期留着一份有效凭据/)
  })

  it('负向验收 ③ 仍然成立：密钥本身必须逐字出现（改文案不能把交付改没了）', () => {
    const dir = tempDir('notice-still-delivers')
    const out = collector()

    const store = createServerAdminKeyStore({
      dataDir: dir,
      env: emptyEnv(),
      platform: 'win32',
      print: out.sink,
      allowUnprotectedKeyFile: true
    })

    expect(out.text()).toContain(store.get() as string)
  })
})
