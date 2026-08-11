/**
 * 条件化 postinstall 的行为闸门。
 *
 * ## 治的是什么
 *
 * `npm ci --omit=dev` 是部署文档写的服务端安装命令，而 postinstall 原本无条件调
 * `electron-builder install-app-deps`（devDependency）。实测（2026-08-12，纯净树）：
 * POSIX exit 127 / Windows exit 1 + `'electron-builder' is not recognized`。
 * 即**部署故事的第一步就失败**。
 *
 * 这个失败有个恶劣性质：它只在**没有 dev 依赖的树**里出现。开发机上永远绿，
 * 所以既有 1525 个测试全绿也抓不到它 —— 这正是本闸门要补的那一格。
 *
 * ## 为什么不真跑 `npm ci --omit=dev`
 *
 * 实测耗时：prod 树 5s~26s（网络好），完整树 9m（要下 ~100MB Electron 二进制），
 * 且依赖网络与 registry。放进单测套件会让「跑测试」变成「等安装」，
 * 人会去加 skip 而不是修 —— 闸门反而被拆掉（姿态同 server_build_target.test.ts 的 L3）。
 *
 * 故这里断言的是**脚本自身在两种条件下的行为**：把 `.bin` 目录做成受控输入，
 * 在临时目录里真实 spawn 一次脚本，读它的退出码与 stdout。这不是「读源码猜行为」，
 * 是真跑一个进程。
 *
 * ## 强度边界（诚实标注）
 *
 * | 层 | 断言对象 | 强度 | 抓不到 |
 * |---|---|---|---|
 * | L1 契约 | package.json 的 postinstall 指向本脚本、脚本文件在盘上 | 强 | 抓不到脚本内容退化 |
 * | L2 行为·缺 shim | 真 spawn，断言 exit 0 且打印跳过原因 | 强（真进程真退出码） | 抓不到「npm 是否真按这个 PATH 找命令」 |
 * | L3 行为·有 shim | 真 spawn 一个假 shim，断言它被调用且退出码被透传 | 强 | 同上 |
 * | L4 判定器自检 | 缺 shim 与有 shim 必须给出**不同**结果 | 强 | — |
 *
 * L4 是关键：没有它，若脚本哪天退化成「无论如何都 exit 0」，L2 仍恒绿，
 * 而「恒绿」与「行为正确」在输出里完全同形（本仓 E-052 母题）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterAll } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const SCRIPT_REL = 'scripts/postinstall.mjs'
const SCRIPT_ABS = join(REPO_ROOT, SCRIPT_REL)
const isWindows = process.platform === 'win32'

/** 待清理的临时目录 */
const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 清理失败不该让测试转红（Windows 上文件占用是常态）；留给 OS 的 temp 回收。
    }
  }
})

/**
 * 造一棵最小的假仓库树：`<tmp>/scripts/postinstall.mjs`(真脚本副本) + `<tmp>/node_modules/.bin/`。
 *
 * 拷脚本而非软链：脚本用 `dirname(import.meta.url)/..` 推导仓库根，
 * 软链会让它算回真仓库、去看**真的** node_modules —— 那样这组测试就变成了
 * 「当前开发机装没装 dev 依赖」的函数，而不是脚本行为的函数（假绿/假红两头都可能）。
 */
function makeFakeTree(opts: { withShim: boolean; shimExitCode?: number }): {
  dir: string
  markerPath: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'kam-postinstall-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'postinstall.mjs'), readFileSync(SCRIPT_ABS))

  const markerPath = join(dir, 'shim-was-called.txt')

  if (opts.withShim) {
    const code = opts.shimExitCode ?? 0
    const binDir = join(dir, 'node_modules', '.bin')
    // 假 shim：落一个标记文件证明「它真被调用了」，再按指定码退出。
    // 断言「标记文件出现」而不是只看退出码 —— 退出码 0 也可能是脚本走了跳过分支，
    // 二者必须能区分开。
    if (isWindows) {
      writeFileSync(
        join(binDir, 'electron-builder.cmd'),
        `@echo off\r\n> "${markerPath}" echo called %*\r\nexit /b ${code}\r\n`
      )
    } else {
      const p = join(binDir, 'electron-builder')
      writeFileSync(p, `#!/bin/sh\necho "called $*" > "${markerPath}"\nexit ${code}\n`)
      chmodSync(p, 0o755)
    }
  }

  return { dir, markerPath }
}

/** 在假树里真 spawn 一次脚本，返回退出码与合并输出。 */
function runScript(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'postinstall.mjs')], {
    cwd: dir,
    encoding: 'utf-8'
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe('postinstall 条件化 · L1 契约', () => {
  it('package.json 的 postinstall 指向 scripts/postinstall.mjs', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(
      pkg.scripts?.postinstall,
      'postinstall 缺失 —— 桌面端将不再按 Electron ABI 准备原生模块'
    ).toBeTruthy()
    expect(
      pkg.scripts.postinstall,
      'postinstall 又变回直接调 electron-builder —— `npm ci --omit=dev` 会重新炸\n' +
        '（POSIX exit 127 / Windows `is not recognized`）'
    ).toBe(`node ${SCRIPT_REL}`)
  })

  it('脚本文件真在盘上（postinstall 指向一个不存在的文件 = 每次安装都失败）', () => {
    expect(existsSync(SCRIPT_ABS), `缺 ${SCRIPT_REL}`).toBe(true)
  })

  it('electron-builder 仍是 devDependency（若它进了 dependencies，本条件化就没有意义了）', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.devDependencies?.['electron-builder']).toBeTruthy()
    expect(pkg.dependencies?.['electron-builder']).toBeUndefined()
  })
})

describe('postinstall 条件化 · L2 缺 shim 时（服务端安装路径）', () => {
  it('退出码 0 —— 这条就是 `npm ci --omit=dev` 能否通过的判据', () => {
    const { dir } = makeFakeTree({ withShim: false })
    const { status, out } = runScript(dir)
    expect(status, `脚本在无 electron-builder 时应 exit 0，实际 ${status}。输出:\n${out}`).toBe(0)
  })

  it('打印跳过原因 —— 静默跳过会让桌面开发者在很久之后才炸且看不出关联', () => {
    const { dir } = makeFakeTree({ withShim: false })
    const { out } = runScript(dir)
    expect(out, '跳过时无任何输出 —— 桌面开发者无从知道 install-app-deps 没跑').not.toBe('')
    // 三件信息都要在：跳过了什么 / 为什么 / 桌面开发者看到该怎么办。
    expect(out).toContain('install-app-deps')
    expect(out).toContain('devDependency')
    expect(out.toLowerCase()).toContain('omit=dev')
  })

  it('没有去调用不存在的命令（不该留下 shell 的 not recognized / 127 痕迹）', () => {
    const { dir } = makeFakeTree({ withShim: false })
    const { out } = runScript(dir)
    expect(out).not.toMatch(/is not recognized|command not found/i)
  })
})

describe('postinstall 条件化 · L3 有 shim 时（桌面开发路径）', () => {
  it('真的调用了 electron-builder install-app-deps', () => {
    const { dir, markerPath } = makeFakeTree({ withShim: true, shimExitCode: 0 })
    const { status, out } = runScript(dir)
    expect(status, `有 shim 时应透传 shim 的 0，实际 ${status}。输出:\n${out}`).toBe(0)
    expect(
      existsSync(markerPath),
      'shim 未被调用 —— 脚本在有 electron-builder 时也走了跳过分支，' +
        '桌面端会静默失去 install-app-deps'
    ).toBe(true)
    expect(readFileSync(markerPath, 'utf-8')).toContain('install-app-deps')
  })

  it('shim 失败时退出码被透传（吞掉真实故障 = 把安装失败报成成功）', () => {
    const { dir, markerPath } = makeFakeTree({ withShim: true, shimExitCode: 3 })
    const { status } = runScript(dir)
    expect(existsSync(markerPath), 'shim 未被调用').toBe(true)
    expect(status, 'electron-builder 失败时脚本仍返回 0 —— 桌面端的真实构建故障被吞掉了').not.toBe(
      0
    )
  })
})

describe('postinstall 条件化 · L4 判定器自检', () => {
  it('两种条件必须给出不同结果（否则脚本可能只是恒 exit 0）', () => {
    // 没有这条，L2 的「exit 0」与「脚本什么都不做」同形。
    const withoutShim = makeFakeTree({ withShim: false })
    const withShim = makeFakeTree({ withShim: true, shimExitCode: 0 })

    const a = runScript(withoutShim.dir)
    const b = runScript(withShim.dir)

    expect(existsSync(withoutShim.markerPath), '无 shim 树里竟出现了调用标记').toBe(false)
    expect(existsSync(withShim.markerPath), '有 shim 树里没有调用标记').toBe(true)

    // 输出也必须可区分：跳过分支打印说明，转发分支不打印那段说明。
    expect(a.out).toContain('install-app-deps')
    expect(b.out).not.toContain('devDependency')
  })

  it('自检前提：假 shim 机制在本平台确实可用（否则 L3 全是空转）', () => {
    // 若 shim 的造法在某平台不生效，L3 的两条会因为「shim 从未被调用」而
    // 以错误的理由通过/失败。这条独立验证「造 shim → 被 spawn 调到」这条链本身。
    const { dir, markerPath } = makeFakeTree({ withShim: true, shimExitCode: 7 })
    const shimName = isWindows ? 'electron-builder.cmd' : 'electron-builder'
    expect(
      existsSync(join(dir, 'node_modules', '.bin', shimName)),
      `假 shim 没造出来（platform=${process.platform}）—— L3 的断言将失去意义`
    ).toBe(true)
    const { status } = runScript(dir)
    expect(status, '假 shim 的退出码 7 没有透传上来 —— shim 链路没打通').toBe(7)
    expect(existsSync(markerPath)).toBe(true)
  })
})
