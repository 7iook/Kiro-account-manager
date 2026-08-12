/**
 * 源码级门禁：`createUpstreamApi` 每个进程只被调用一次。
 *
 * ## 为什么需要一道**门禁**而不是一个行为测试
 *
 * `createUpstreamApi` 的 single-flight 表在工厂闭包内（见
 * `src/main/upstreamApi/index.ts` 头部）。同一进程建两个实例 = 两张表 =
 * 同一个 rotating refreshToken 可能被并发刷两次 → 后到的那次用已作废的 token →
 * 401 → **账号被上游踢下线**。
 *
 * 这个缺陷的形状是「有人在别处又建了一个」，而端口级行为测试在**有人绕过**时
 * 照样绿（与 `afe80af` 给 `persistence_port_wiring.test.ts` 的理由同款）：
 * 你测的那个实例行为完全正确，问题在于世界上还有第二个。故判据必须是
 * 源码级的「装配点计数」。
 *
 * ## 判定器的作用域（明写以免被误当更强的保证）
 *
 * 本闸门数的是 **`src/` 下的静态调用点数量**，每个进程入口各自 ≤ 1。它**不**能证明
 * 运行时只有一个实例（同一行代码放在一个被调用两次的函数里就会建两个）——
 * 那属于代码评审与装配层设计的范畴。选这个判据是因为它能可靠地抓到真实的
 * 回归形态：「服务端/桌面端某处顺手又 create 了一个」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const SRC = resolve(REPO_ROOT, 'src')

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** 去注释后再数 —— 文档里正当地提到 `createUpstreamApi(deps)` 不是一个装配点。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CALL_RE = /\bcreateUpstreamApi\s*\(/g

interface CallSite { file: string; count: number }

function findCallSites(): CallSite[] {
  const sites: CallSite[] = []
  for (const abs of listSourceFiles(SRC)) {
    const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/')
    // 工厂自身的定义处不算调用点
    if (rel === 'src/main/upstreamApi/index.ts') continue
    const code = stripComments(readFileSync(abs, 'utf-8'))
    const count = (code.match(CALL_RE) || []).length
    if (count > 0) sites.push({ file: rel, count })
  }
  return sites
}

describe('architecture: 上游 API 工厂每进程单实例', () => {
  const sites = findCallSites()

  it('每个文件里最多出现一次 createUpstreamApi( 调用', () => {
    const multi = sites.filter((s) => s.count > 1)
    expect(
      multi.map((s) => `${s.file} × ${s.count}`),
      '同一文件里建了多个上游 API 实例 = 多张 single-flight 表。\n' +
        '后果:同一个 rotating refreshToken 被并发刷两次 → 后到的用已作废 token → 401 → 账号被上游踢下线。\n' +
        '改法:在装配处建一次，把实例传下去。'
    ).toEqual([])
  })

  it('桌面端与服务端各自最多一个装配点（互不共享实例，但各自唯一）', () => {
    // 允许的形态:桌面装配(src/main/index.ts)一处 + 服务端装配(src/main/server/*)一处。
    // 它们是两个**不同的进程**，各自一张表是正确的；同一进程内两处才是缺陷。
    const desktop = sites.filter((s) => s.file === 'src/main/index.ts')
    const server = sites.filter((s) => s.file.startsWith('src/main/server/'))
    const other = sites.filter((s) => !desktop.includes(s) && !server.includes(s))

    expect(desktop.length, '桌面端装配点应 ≤ 1').toBeLessThanOrEqual(1)
    expect(server.length, '服务端装配点应 ≤ 1').toBeLessThanOrEqual(1)
    expect(
      other.map((s) => s.file),
      'createUpstreamApi 只应在进程装配层调用(src/main/index.ts 或 src/main/server/*)。\n' +
        '出现在业务模块里意味着「谁需要就自己建一个」—— 那就是多张 single-flight 表的来源。'
    ).toEqual([])
  })

  it('自检：判定器真的能在源码里数到调用点（防正则写错导致空转假绿）', () => {
    const samples = [
      'const api = createUpstreamApi(deps)',
      'createUpstreamApi({ useKProxy: () => false })',
      'return createUpstreamApi (d)'
    ]
    for (const s of samples) {
      CALL_RE.lastIndex = 0
      expect((s.match(CALL_RE) || []).length, `判定器漏掉了调用形态: ${s}`).toBe(1)
    }
  })

  it('自检：注释 / 类型引用里的提及不被计入', () => {
    const code = stripComments(
      [
        '/** 用 createUpstreamApi(deps) 组装 */',
        '// 见 createUpstreamApi(...)',
        'import type { UpstreamApi } from "./upstreamApi"'
      ].join('\n')
    )
    expect((code.match(CALL_RE) || []).length).toBe(0)
  })

  it('自检：工厂本身存在且导出（防判定器指向一个已改名的符号而恒绿）', () => {
    const factory = readFileSync(resolve(REPO_ROOT, 'src/main/upstreamApi/index.ts'), 'utf-8')
    expect(factory).toMatch(/export function createUpstreamApi\s*\(/)
  })

  it('single-flight 表在工厂闭包内，不是注入项也不是模块级共享', () => {
    // 判据落在源码形状上:Map 必须声明在 createRefresh 的函数体内。
    // 若哪天有人把它提到模块顶层，两个实例就会共享一张表 —— 那是另一个方向的缺陷
    // （测试造的独立实例会互相污染，且桌面/服务端语义被悄悄合并）。
    const refresh = readFileSync(resolve(REPO_ROOT, 'src/main/upstreamApi/refresh.ts'), 'utf-8')
    const factoryIdx = refresh.indexOf('export function createRefresh')
    const mapIdx = refresh.indexOf('const inFlightRefreshByToken = new Map')
    expect(factoryIdx, 'createRefresh 工厂不见了').toBeGreaterThan(-1)
    expect(mapIdx, 'single-flight 表不见了').toBeGreaterThan(-1)
    expect(mapIdx, 'single-flight 表必须在工厂闭包内声明，不能提到模块顶层').toBeGreaterThan(factoryIdx)
    // 也不能变成注入参数
    expect(refresh).not.toMatch(/inFlightRefreshByToken\s*:/)
  })
})
