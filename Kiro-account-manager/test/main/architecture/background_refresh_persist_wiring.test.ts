/**
 * Architecture fitness gate：后台批量刷新的**落盘**必须真的接在生产路径上。
 *
 * ## 为什么需要静态闸门（而不是只靠上面那套行为测试）
 *
 * 这个缺陷的原始形态正是 E-052「建好但没接线」：`backgroundBatchRefresh` 刷新成功后
 * 只 `emit('background-refresh-result', …)`，落盘长在渲染进程的 zustand reducer 里，
 * 而那个 reducer 尾部**没有** `saveToStorage()`。桌面端靠别的编辑顺带整表落盘掩盖了它；
 * 服务器形态下 `mainWindow` 为 undefined ⇒ send 是静默 no-op ⇒ 新签发的 refreshToken
 * 永不上盘，日志却每分钟都在报「刷新成功」。
 *
 * 这类缺陷的危险之处在于**删掉落盘调用不会有任何行为测试变红**（单测可以自己构造
 * deps 调业务函数，照样绿），只有「生产调用点是否存在」这一问的答案会变。故:
 *
 * ① **防退化成零调用方**：`persistBatchRefreshResults` 若失去生产调用方，
 *    刷新会安静地退回「只推事件、不落盘」。
 * ② **防主进程调度器绕开业务层**：`index.ts` 里若再出现一份内联的批量刷新实现
 *    （历史上就是那样），它不会经过落盘收口。
 * ③ **防落盘绕开 revision 收口**：账号数据的写入必须过 `applyAccountDataMutation`
 *    （跨端并发写仲裁的 SSOT），绝不允许新增 `store.set('accountData', …)` 路径。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

/**
 * 在 `src/` 下按**文件系统**遍历找调用点 —— 刻意不用 `git grep`。
 *
 * 实测(2026-08-12,本轮):`git grep` 只覆盖 **git 已跟踪**的文件,而本轮新增的
 * `backgroundRefresh.ts` / `persistRefreshBatchResults.ts` 尚未 `git add` ⇒ 零命中。
 * 而「零命中」与「真的不存在」在 git grep 的输出里长得一模一样 ⇒ 闸门会对着
 * **已接线的正确代码**报「零调用方」,也会对着真的漏接线报同一句话 —— 判定器失去分辨力。
 * 架构闸门断言的是「代码现在什么样」,不是「索引里什么样」,故走文件系统。
 */
function grepSrc(needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(p)
        continue
      }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue
      const lines = readFileSync(p, 'utf-8').split(/\r?\n/)
      lines.forEach((line, i) => {
        if (line.includes(needle)) {
          hits.push(`${relative(REPO_ROOT, p).replace(/\\/g, '/')}:${i + 1}: ${line.trim()}`)
        }
      })
    }
  }
  walk(resolve(REPO_ROOT, 'src'))
  return hits
}

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

describe('architecture: 后台批量刷新的落盘真的接在生产路径上', () => {
  it('backgroundRefresh 业务函数确实调用了落盘（零调用 = 退回「只推事件不落盘」）', () => {
    const src = readSrc('src/main/accountService/backgroundRefresh.ts')
    expect(
      src,
      '`backgroundRefresh.ts` 必须调用 `persistBatchRefreshResults` —— 否则刷新结果只经 ' +
        '`emit` 推给渲染进程，而服务器形态下没有渲染进程（mainWindow undefined ⇒ send 静默 no-op），' +
        '新签发的 refreshToken 永不上盘，旧的已被 IdP 作废 ⇒ 重启后账号全死。'
    ).toContain('persistBatchRefreshResults(')
  })

  it('落盘经 applyAccountDataMutation 收口，不新增 store.set(accountData) 旁路', () => {
    const src = readSrc('src/main/accountService/persistRefreshBatchResults.ts')
    expect(src).toContain('applyAccountDataMutation')
    // 账号数据写入的 SSOT 是收口函数；绕过它就绕过了跨端并发写的 revision 仲裁
    expect(
      /store\w*\.set\s*\(\s*['"]accountData['"]/.test(src),
      '落盘必须过 applyAccountDataMutation（revision 乐观锁收口），绝不允许直写 store'
    ).toBe(false)
  })

  it('index.ts 只做装配：不得再内联一份批量刷新实现（那份不经落盘收口）', () => {
    const src = readSrc('src/main/index.ts')
    // 历史形态：`const backgroundBatchRefresh = async (accounts…) => { …320 行… }`
    // 现在必须是「import 业务函数 + 注入 deps 调用」。
    expect(
      /const\s+backgroundBatchRefresh\s*=\s*async\s*\(/.test(src),
      'index.ts 里又出现了内联的 backgroundBatchRefresh 实现。它绕过 accountService 的' +
        '落盘收口，且长在依赖 electron、纯 node 下加载不了的文件里（服务器形态跑不到）。'
    ).toBe(false)
    expect(src).toContain("from './accountService/backgroundRefresh'")
  })

  it('主进程调度器（不依赖窗口存活的那条）真的走业务函数', () => {
    const src = readSrc('src/main/index.ts')
    // 调度器经 backgroundBatchRefreshImpl 间接调用；该变量必须被赋成业务函数的包装
    expect(src).toMatch(/backgroundBatchRefreshImpl\s*=\s*backgroundBatchRefreshLocal/)
    expect(src).toMatch(/backgroundBatchRefresh\(\s*accountServiceDeps/)
  })

  it('persistBatchRefreshResults 的生产调用方恰好 1 处（多写者会互相覆盖凭据）', () => {
    const hits = grepSrc('persistBatchRefreshResults(')
      // 只留真实调用：排除定义行与该模块自身（定义 + 内部引用都在 persistRefreshBatchResults.ts）
      .filter((l) => !l.includes('src/main/accountService/persistRefreshBatchResults.ts'))
      .filter((l) => !l.includes('import'))
    expect(
      hits,
      `落盘应只有一个生产调用方（backgroundRefresh.ts 的切片边界）。实际命中:\n${hits.join('\n') || '（零命中 —— 刷新又退回「只推事件、不落盘」）'}`
    ).toHaveLength(1)
    expect(hits[0]).toContain('src/main/accountService/backgroundRefresh.ts')
  })

  it('自检：判定器真的能扫到未跟踪的新文件（否则闸门是空转的）', () => {
    // 本轮的两个文件在写这条断言时都还是 untracked。若判定器退回 git grep，
    // 下面这条会零命中 —— 那正是本闸门刚踩过的坑，锚在这里防它复发。
    const hits = grepSrc('export async function persistBatchRefreshResults')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('sanity: 被守护的符号确实都还在（防判定器空转假绿）', () => {
    const persist = readSrc('src/main/accountService/persistRefreshBatchResults.ts')
    expect(persist).toContain('export async function persistBatchRefreshResults')
    expect(persist).toContain('export function patchAccountWithRefreshBatchResult')
    const refresh = readSrc('src/main/accountService/backgroundRefresh.ts')
    expect(refresh).toContain('export async function backgroundBatchRefresh')
  })

  it('内核约束：业务层不得 import electron（服务端形态要加载它）', () => {
    for (const f of [
      'src/main/accountService/backgroundRefresh.ts',
      'src/main/accountService/persistRefreshBatchResults.ts'
    ]) {
      const src = readSrc(f)
      expect(
        /\bfrom\s*['"]electron(?:\/[^'"]*)?['"]|\brequire\s*\(\s*['"]electron/.test(src),
        `${f} 依赖了 electron —— 服务器形态（纯 node，electron 是 devDependency）加载不了它。`
      ).toBe(false)
    }
  })
})
