/**
 * K-1 回归测试：`proxy/logger.ts` 与 Electron 解耦。
 *
 * 为什么这组测试值钱：logger 是「共享内核在纯 node 下加载不起来」这条链的第一环
 * （`accountService/verify.ts` → `proxy/kiroApi.ts` → `proxy/logger.ts`）。
 * 而 `electron` 在本仓是 **devDependency**（`package.json`），且 `dependencies` 里
 * **无任何包 peer 上它**（这第二个条件曾一度不成立，见 `src/main/proxy/logger.ts` 头部
 * 与 `prod_tree_has_no_electron.test.ts`）。两个条件都成立，服务器上
 * `npm install --omit=dev` 之后该模块才根本不存在 —— 静态 `import { app } from 'electron'`
 * 会在模块加载期解析失败，整条链直接死在 require 上。
 *
 * ## 关于「怎样让加载测试不是假绿」
 *
 * 开发机上 `node_modules/electron` 是存在的，且实测（2026-08-10）：
 *   `require('electron')` 在纯 node 下 **不抛错**，它返回一个字符串
 *   （electron.exe 的绝对路径），于是 `app` 静默变成 `undefined`。
 * 也就是说「直接 import logger 看它不抛」这种写法在本仓是**恒绿的假测试** ——
 * 它既不能证明解耦，也抓不到 `app.xxx` 在纯 node 下变 undefined 的软失败。
 *
 * 所以这里用两条**互补且分工明确**的断言。先说清楚哪条承重：
 *
 *   L1 源码级 —— **本文件的承重闸门**。logger.ts 不得出现 electron 引用
 *              （静态或动态）。与 `stdio_guard_wiring.test.ts` /
 *              `webpanel_auth_constraints.test.ts` 同一套既有形态。
 *              **只有它能抓住静态 import 的回归**，理由见下。
 *   L2 行为级 —— 把 `electron` mock 成「解析即抛」（模拟服务器上模块缺失），
 *              再动态 import logger。**它的覆盖范围严格小于 L1**：只能抓住
 *              「加载期真的发生了解析」的写法（顶层 `await import('electron')`
 *              / `require('electron')`，以及被实际使用的静态 import）。
 *
 * ## L2 抓不到「未被使用的静态 import」—— 这不是 L2 写错了，是编译期擦除
 *
 * 2026-08-10 实测四个变体（每次只重新引入一种写法，跑 --reporter=json 读计数）：
 *
 *   | 重新引入的写法                                    | L1     | L2     |
 *   |---------------------------------------------------|--------|--------|
 *   | `import { app } from 'electron'`（未使用）        | 🔴 红  | 🟢 绿  |
 *   | `import { app } from 'electron'` + `void app`     | 🔴 红  | 🔴 红  |
 *   | 顶层 `const m = await import('electron')`         | 🔴 红  | 🔴 红  |
 *   | 函数体内 `void (async()=>{await import(...)})()`  | 🔴 红  | 🟢 绿  |
 *
 * L1 四种全红；L2 只在「加载期真的发生解析」时红。
 *
 * 根因用 esbuild 单独验证过（非推测）：**未被使用的 import 在转译期就被整条
 * 擦除**，产物里根本不出现 `electron` 这个字符串 —— 于是运行时没有任何解析
 * 动作，任何 mock（`vi.mock` / `vi.doMock` / alias）都无从拦截。这是
 * TS/esbuild 的 import elision，不是 vitest mock 时机问题。
 *   unused → 产物: `import * as path from "path"` （electron 消失）
 *   used   → 产物: `import { app } from "electron"; void app`
 *
 * 推论：**运行时探测这条路，原理上就无法覆盖「import 了但还没用」这个中间态**，
 * 而这恰好是回归最可能的样子（先加回 import，下一次编辑才用它）。所以 L1 是
 * 承重的那条，L2 是它的补充 —— 覆盖 L1 的源码正则可能被绕过的动态形态。
 * 删掉 L2 会丢掉动态 import 的行为级证据；把 L2 当成「服务器可加载性证明」
 * 则是高估它。两者都不对，故在此写明分工。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')
const LOGGER_REL = 'src/main/proxy/logger.ts'

describe('K-1 · logger 与 electron 解耦', () => {
  /**
   * 剥掉注释后再断言。
   *
   * 必须这么做的理由：logger.ts 的文件头**刻意**解释了「为什么这里没有
   * `import { app } from 'electron'`」，裸扫全文的正则会命中这段说明，
   * 于是闸门变成「禁止记录该决策」—— 逼着后人删掉最该留下的注释。
   * 闸门要管的是**代码**，不是散文。
   */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释 / JSDoc
      .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 URL 里的 //）

  it('L1 · logger.ts 源码不得引用 electron（静态或动态）', () => {
    const raw = readFileSync(resolve(REPO_ROOT, LOGGER_REL), 'utf-8')
    const src = stripComments(raw)

    // 自检：剥离逻辑本身别失效 —— 文件头那段说明必须真的被剥掉了，
    // 否则下面四条断言会因为「注释里提到 electron」而假红/假绿。
    expect(raw, '前提:文件头应保留解释性注释').toMatch(/为什么这里没有/)
    expect(src, '剥离注释后不应再出现该说明文字').not.toMatch(/为什么这里没有/)

    expect(src, 'logger.ts 不得静态 import electron').not.toMatch(
      /from\s+['"]electron['"]/
    )
    expect(src, 'logger.ts 不得 require electron').not.toMatch(
      /require\(\s*['"]electron['"]\s*\)/
    )
    // 动态 import 只是把依赖藏得更晚、并且躲过静态检查，等价于没解耦
    expect(src, 'logger.ts 不得动态 import electron').not.toMatch(
      /import\(\s*['"]electron['"]\s*\)/
    )
    // app.getPath / app.isPackaged 这类残留引用（即便 import 被删）
    expect(src, 'logger.ts 不得引用 electron 的 app 对象').not.toMatch(
      /\bapp\.(getPath|isPackaged)\b/
    )
  })

  /**
   * 补充闸门（**非承重**）：覆盖「加载期真的去解析 electron」这一形态。
   *
   * 实测能抓（2026-08-10，各自单独重新引入后本条转红）：
   *   - 模块顶层 `await import('electron')`
   *   - 被实际使用的静态 import（`import { app }` + 用到 app）
   * 实测抓不到：
   *   - 未被使用的静态 import —— 转译期整条擦除，运行时无解析动作可拦
   *   - 延迟到函数体内、且 rejection 被吞掉的动态 import
   *     （如 `void (async () => { await import('electron') })()` —— 实测本条仍绿）
   *
   * 所以本条**不构成**「服务器可加载」的证明；它只证明「加载期没有解析动作」。
   * 承重的是 L1。详见文件头对照表。
   */
  it('L2(补充) · 加载期不得解析 electron —— 覆盖顶层动态 import 形态', async () => {
    vi.resetModules()
    // 模拟「服务器上 electron 根本不存在」：解析该模块即抛。
    // logger 若在运行时真的去解析 electron，这个 import 就会失败。
    vi.doMock('electron', () => {
      throw new Error("Cannot find module 'electron'")
    })

    const mod = await import('../../../src/main/proxy/logger')

    expect(typeof mod.interceptConsole).toBe('function')
    expect(mod.proxyLogger).toBeDefined()
    expect(mod.proxyLogStore).toBeDefined()

    vi.doUnmock('electron')
    vi.resetModules()
  })
})

/**
 * INFO 级 data 截断闸门的两侧行为。
 *
 * 这条闸门是**活的**（`interceptConsole()` 由 `src/main/index.ts` 调用），
 * 来源见 2026-07-23 frontend-freeze RCA 假设 B：生产环境下 INFO 级 data
 * 必须走 200B preview，消除 stringify 全对象的 CPU 峰值。
 *
 * 测试要绕开一个坑：`ProxyLogStore.add()` 自己还有一层 4096B 上限截断
 * （`__truncated` + 200 字符 preview）。为了只测 interceptConsole 这一层闸门，
 * payload 必须 >200B 且 <4096B，否则两层截断叠在一起，断言分不清是谁干的。
 */
describe('K-1 · INFO data 截断闸门（生产 / 开发两侧）', () => {
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    // interceptConsole 会替换全局 console，必须还原，否则污染同文件后续用例
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    vi.resetModules()
  })

  /** >200B 且 <4096B：只触发 interceptConsole 那层闸门 */
  const midSizedPayload = { blob: 'x'.repeat(300) }

  it('生产模式：INFO 级 data 截断为 200B preview', async () => {
    const mod = await import('../../../src/main/proxy/logger')
    mod.setLogTruncationEnabled(true)
    mod.interceptConsole()

    console.log('[TruncCase] hello', midSizedPayload)

    const [entry] = mod.proxyLogStore.getLast(1)
    expect(entry.level).toBe('INFO')
    expect(typeof entry.data).toBe('string')
    expect(entry.data as string).toMatch(/…\[\+\d+B\]$/)
    expect((entry.data as string).length).toBeLessThan(240)
  })

  it('开发模式：INFO 级 data 保留完整结构（不截断）', async () => {
    const mod = await import('../../../src/main/proxy/logger')
    mod.setLogTruncationEnabled(false)
    mod.interceptConsole()

    console.log('[TruncCase] hello', midSizedPayload)

    const [entry] = mod.proxyLogStore.getLast(1)
    expect(entry.level).toBe('INFO')
    // 未截断 → 仍是对象，且内容完整
    expect(entry.data).toEqual(midSizedPayload)
  })

  it('默认值（无人注入时）= 截断开启 —— 服务器不得静默退化成 dev 行为', async () => {
    const mod = await import('../../../src/main/proxy/logger')
    // 刻意不调用 setLogTruncationEnabled
    mod.interceptConsole()

    console.log('[TruncCase] hello', midSizedPayload)

    const [entry] = mod.proxyLogStore.getLast(1)
    expect(typeof entry.data, '默认必须是安全侧(截断)').toBe('string')
    expect(entry.data as string).toMatch(/…\[\+\d+B\]$/)
  })

  it('WARN / ERROR 级不受该闸门影响（仅 INFO 走 preview）', async () => {
    const mod = await import('../../../src/main/proxy/logger')
    mod.setLogTruncationEnabled(true)
    mod.interceptConsole()

    console.warn('[TruncCase] warn', midSizedPayload)

    const [entry] = mod.proxyLogStore.getLast(1)
    expect(entry.level).toBe('WARN')
    expect(entry.data).toEqual(midSizedPayload)
  })
})
