/**
 * 共享内核的**模块图**闸门：从内核入口出发，可达的**每一个**文件都不得依赖 electron。
 *
 * ## 为什么不能是「手列几个文件」的清单
 *
 * 上一版本闸门手列三个叶子文件逐个扫。评审实测(2026-08-10)证明它挡不住真实回归：
 * 往 `proxy/kiroApi.ts` 重新塞回一个**真被使用**的 electron import，K-1 全套仍报
 * 21/21 通过 —— 因为 kiroApi.ts 不在那三个名字里。而内核的真实边界是
 * `accountService/verify.ts → proxy/kiroApi.ts → proxy/logger.ts` 这条**传递链**
 * (ADR-0002 Decision 2 把它列为「必须先断的一条穿透链」)，服务端形态要加载的是整条链，
 * 不是三个孤立文件。清单式闸门的失效方式还很安静：新增内核文件时没人记得加名字，
 * 闸门照绿，边界在无人察觉中腐烂。故这里**从入口算传递闭包**，文件集由 import 关系
 * 自己长出来 —— 新增的内核文件自动纳管，无需维护清单。
 *
 * ## 为什么必须是**源码/图**级判定，而不是「在 node 下 import 一下」
 *
 * 两个实测事实(2026-08-10，本机 node v22)决定了运行时断言看不见这类缺陷：
 *
 *   ① `electron` 是 **devDependency**，而开发机上 `require('electron')` **成功**并返回
 *      一个字符串(electron.exe 的路径)。于是 `import { app } from 'electron'` 不抛，
 *      只是 `app === undefined`，直到第一次 `app.getPath()` 才炸。
 *      → 「import 了不抛就算过」的测试，在有缺陷的代码上**也是绿的**。
 *   ② **未被使用**的 `import { app } from 'electron'` 会被 TS/esbuild 的 import elision
 *      整行擦掉，标识符压根进不了运行时模块图 —— `vi.mock` / alias 都拦不到。
 *      → 那种形态**只有**源码级或图级断言看得见。
 *
 * 这正是本仓 E-052(「建好但没接线」/ 测试绿 ≠ 真达标)的同族形态：断言选错时点，
 * 于是缺陷与修复在测试眼里毫无区别。故本文件走图 + 源码，
 * `kernelWithoutElectron.runtime.test.ts` 另从运行时侧证明「真缺席也能跑」。
 *
 * ## 三种形态都要扫
 *
 * ADR-0002 Decision 2 记录过一个检索陷阱：`git grep "from 'electron'"` 只匹配 ESM，
 * 漏掉了两个用 CJS `require('electron')` 的承重文件。故 ESM / CJS / 动态 import
 * 三形态同扫 —— 少扫一种，绕过闸门就只是换个写法的事。
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

/**
 * 内核**入口**（不是全量清单）。服务端壳要加载的就是这些，其余内核文件由 import 关系
 * 自动纳入闭包。新增入口才需要动这里 —— 新增内核文件不需要。
 *
 * `accountService/verify.ts` 是 ADR-0002 Decision 2 点名的那条穿透链的头，
 * 必须在列：闸门要覆盖的正是它拉进来的整棵子树。
 *
 * `proxy/proxyServer.ts` 是 K-2 补进来的。实测(2026-08-10)：K-1 的四个入口算出的闭包
 * 是 30 个文件，**不含** proxyServer.ts —— 它的两个 value 消费者（`proxy/index.ts` 与
 * `src/main/index.ts`）都在闭包外，`ipc/panelProxyDeps.ts` 只 `import type`。
 * 于是它当时藏着三处**函数体内**的 `require('electron')`（喂自签证书目录），
 * 闸门却照绿：不是判定器漏了形态，而是它够不到这个文件。加为入口后闭包变 40 个文件，
 * 违规恰好 1 条 —— 就是它自己，修完转绿。反代服务器本身就是服务端形态要跑的东西，
 * 它必须是入口，不能靠「将来某个文件 import 它」间接进闭包。
 * `src/main/accountService/state.ts` 与 `persistence/accountStorePort.ts` 是 K-3 补的。
 * 实测(2026-08-10)：K-2 的五个入口算出的闭包是 40 个文件，**不含** `state.ts`、
 * 也不含 `accounts.ts` —— 它们是 accountData 写入的收口(`applyAccountDataMutation`)与
 * load/save 路径，服务端形态必然要加载，但从那五个入口一个都到不了
 * （真实依赖方向是 `accountService/index.ts` → `state.ts`，而 index.ts 本身在闭包外；
 * `verify.ts` 不 import 它们）。同一个「够不到所以照绿」的形态在 K-1 → K-2 已重现过一次，
 * 这是第三次：**闭包能覆盖多少，取决于入口列全没列全，而入口是手列的**。
 *
 * `persistence/accountStorePort.ts` 加为入口而非依赖 `state.ts` 间接带入：
 * `state.ts` 只 `import type` 它，而类型导入会被 esbuild 擦除 —— 若只靠这条边，
 * 端口文件在运行时其实不在模块图里，靠它「间接进闭包」是把闸门建在一条会消失的边上。
 * 服务端实现 `accountStore.conf.ts` 由端口文件的 value 消费者带入？不 —— 它没有被
 * 端口 import（方向相反）。故也显式列为入口。
 */
const KERNEL_ENTRY_POINTS = [
  'src/main/kproxy/index.ts',
  'src/main/secureBackup.ts',
  'src/main/secureBackupCipher.aesGcm.ts',
  'src/main/accountService/verify.ts',
  'src/main/proxy/proxyServer.ts',
  'src/main/accountService/state.ts',
  'src/main/accountService/accounts.ts',
  'src/main/persistence/accountStorePort.ts',
  'src/main/persistence/accountStore.conf.ts'
]

/** ESM / CJS / 动态 import 三形态 */
const ELECTRON_IMPORT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ESM  import ... from 'electron'", re: /\bfrom\s*['"]electron['"]/ },
  { name: "ESM  import 'electron'", re: /\bimport\s*['"]electron['"]/ },
  { name: "CJS  require('electron')", re: /\brequire\s*\(\s*['"]electron['"]\s*\)/ },
  { name: "动态 import('electron')", re: /\bimport\s*\(\s*['"]electron['"]\s*\)/ }
]

/**
 * 路径别名。必须与 `vitest.config.ts` / `tsconfig.node.json` 保持一致。
 *
 * 今天 `src/main` 里一个别名 import 都没有（已核实），但解析器仍必须认识它们：
 * 哪天有人用 `@main/xxx` 写内核代码，不认别名的走图器会**静默漏掉整棵子树** ——
 * 那就是本文件要消灭的「假绿」本身，只是换了个入口。
 */
const ALIASES: Record<string, string> = {
  '@main': 'src/main',
  '@shared': 'src/shared',
  '@preload': 'src/preload'
}

/** 只跟踪仓内源码；第三方包(node_modules)与 node: 内置不在内核约束范围内 */
function isInternalSpecifier(spec: string): boolean {
  return (
    spec.startsWith('.') || Object.keys(ALIASES).some((a) => spec === a || spec.startsWith(a + '/'))
  )
}

function resolveInternal(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('.')) {
    base = resolve(dirname(fromFile), spec)
  } else {
    const alias = Object.keys(ALIASES).find((a) => spec === a || spec.startsWith(a + '/'))
    if (!alias) return null
    base = resolve(REPO_ROOT, ALIASES[alias], spec.slice(alias.length).replace(/^\//, ''))
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js')
  ]
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/**
 * 去掉注释后再判定。必须**真的**剥掉块注释与行尾注释，不能只过滤「以注释符开头的行」——
 * 内核里的 JSDoc 会正当地提到 `app.getPath("userData")`（说明桌面端该传什么），
 * 那种提及不是依赖。判定器只看可执行代码。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释 / JSDoc
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 URL 里的 `://`）
}

/** 抓 import / export-from / require / 动态 import 的模块说明符 */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g

interface KernelGraph {
  /** 可达文件（仓库相对路径，正斜杠） */
  files: string[]
  /** 引用了 electron 的可达文件 → 命中的形态 + 引入链 */
  violations: Array<{ file: string; forms: string[]; chain: string[] }>
  /** 解析不了的仓内说明符。非空即闸门失效（漏扫子树），必须报错而不是忽略 */
  unresolved: string[]
}

function rel(abs: string): string {
  return relative(REPO_ROOT, abs).replace(/\\/g, '/')
}

/** 从入口计算传递闭包，并在闭包内扫 electron 依赖 */
function buildKernelGraph(entries: string[]): KernelGraph {
  const visited = new Set<string>()
  const parent = new Map<string, string>()
  const violations: KernelGraph['violations'] = []
  const unresolved: string[] = []

  function chainOf(file: string): string[] {
    const chain: string[] = []
    let cur = file
    while (parent.has(cur) && chain.length < 32) {
      cur = parent.get(cur)!
      chain.push(rel(cur))
    }
    return chain
  }

  function walk(abs: string): void {
    const norm = resolve(abs)
    if (visited.has(norm)) return
    visited.add(norm)

    const code = stripComments(readFileSync(norm, 'utf-8'))

    const forms = ELECTRON_IMPORT_PATTERNS.filter((p) => p.re.test(code)).map((p) => p.name)
    if (forms.length > 0) violations.push({ file: rel(norm), forms, chain: chainOf(norm) })

    SPECIFIER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SPECIFIER_RE.exec(code)) !== null) {
      const spec = m[1]
      if (!isInternalSpecifier(spec)) continue // 第三方 / node: 内置
      const target = resolveInternal(norm, spec)
      if (!target) {
        unresolved.push(`${spec}  (from ${rel(norm)})`)
        continue
      }
      if (!parent.has(target)) parent.set(target, norm)
      walk(target)
    }
  }

  for (const e of entries) walk(resolve(REPO_ROOT, e))

  return { files: [...visited].map(rel).sort(), violations, unresolved }
}

describe('architecture: 共享内核零 electron 依赖（模块图闸门）', () => {
  const graph = buildKernelGraph(KERNEL_ENTRY_POINTS)

  it('内核入口的传递闭包里没有任何文件依赖 electron', () => {
    const detail = graph.violations
      .map(
        (v) => `  ${v.file}\n    形态: ${v.forms.join(' / ')}\n    引入链: ${v.chain.join(' <- ')}`
      )
      .join('\n')

    expect(
      graph.violations.map((v) => v.file),
      `以下文件从内核入口可达，却依赖 electron。共享内核必须能在纯 node（Linux 服务器，\n` +
        `无 Electron 运行时；且 electron 是 devDependency，--omit=dev 后压根不存在）下加载。\n` +
        `平台差异应推到装配层（见 src/main/utils/webPanelAssetRoot.ts 头部注释的既有姿态），\n` +
        `而不是在内核里分支或用动态 import 规避静态依赖。\n${detail}`
    ).toEqual([])
  })

  it('所有仓内 import 都解析成功（解析不了 = 漏扫子树 = 闸门失效）', () => {
    // 这条不是洁癖:一个解析不出来的说明符意味着它背后整棵子树没被扫过,
    // 而闸门照样报绿 —— 与手列清单漏掉文件是同一种假绿。故宁可红在这里。
    expect(graph.unresolved).toEqual([])
  })

  it('自检：闭包真的穿透了 ADR-0002 点名的那条链（否则闭包是空转的）', () => {
    // verify.ts → kiroApi.ts → logger.ts。少了任何一环,说明走图器没真的在走图,
    // 上面那条「零违规」就只是因为它什么都没扫到。
    expect(graph.files).toContain('src/main/accountService/verify.ts')
    expect(graph.files).toContain('src/main/proxy/kiroApi.ts')
    expect(graph.files).toContain('src/main/proxy/logger.ts')
  })

  it('自检：闭包规模远大于入口数（防「只扫了入口」这种退化）', () => {
    expect(graph.files.length).toBeGreaterThan(KERNEL_ENTRY_POINTS.length * 3)
  })

  it('自检：判定器真的能抓到四种违规写法（防正则写错导致空转假绿）', () => {
    const samples = [
      "import { app } from 'electron'",
      "import 'electron'",
      "const { app } = require('electron')",
      "const m = await import('electron')"
    ]
    for (const s of samples) {
      const hit = ELECTRON_IMPORT_PATTERNS.some((p) => p.re.test(s))
      expect(hit, `判定器漏掉了违规写法: ${s}`).toBe(true)
    }
  })

  it('自检：走图器能识别别名 import（别名不认 → 静默漏子树）', () => {
    const resolved = resolveInternal(
      resolve(REPO_ROOT, 'src/main/secureBackup.ts'),
      '@shared/types/credential'
    )
    expect(resolved, '@shared 别名解析失败 —— 走图器会漏掉别名引入的整棵子树').not.toBeNull()
    expect(rel(resolved!)).toBe('src/shared/types/credential.ts')
  })

  it('自检：注释剥离真的生效（否则判定器会因注释提及而误报/漏报）', () => {
    const src = [
      '/** 桌面端应传 app.getPath("userData") */',
      "// 这里以前写的是 import { app } from 'electron'",
      'const x = 1 // 行尾注释 require("electron")',
      "import { y } from './local'"
    ].join('\n')
    const out = stripComments(src)

    expect(out).not.toContain('getPath')
    expect(out).not.toContain('electron')
    // 但真实代码必须留下来（防剥过头把代码也删了 → 判定器恒绿）
    expect(out).toContain("import { y } from './local'")
    expect(out).toContain('const x = 1')
  })

  it('自检：入口文件都真的存在（防路径写错导致空转假绿）', () => {
    for (const entry of KERNEL_ENTRY_POINTS) {
      expect(readFileSync(resolve(REPO_ROOT, entry), 'utf-8').length).toBeGreaterThan(0)
    }
  })

  it('kproxy 不再从 electron 取 userData，而是由构造参数注入', () => {
    const code = stripComments(
      readFileSync(resolve(REPO_ROOT, 'src/main/kproxy/index.ts'), 'utf-8')
    )
    // 注释已被剥离，且内核里的错误文案刻意不写成 `app.getPath("userData")` 形状
    // （改写为「Electron 的 userData 目录」）—— 于是这里任何命中都是真代码，不必再
    // 靠更聪明的正则去区分「代码」与「字符串内容」。判定器简单，才不会自己腐烂。
    expect(code).not.toMatch(/app\s*\.\s*getPath\s*\(/)
    // 而路径来源确实换成了注入
    expect(code).toMatch(/userDataPath/)
    expect(code).toMatch(/resolveKProxyDataPath/)
  })

  it('secureBackup 不再直接引用 safeStorage，而是依赖注入的 cipher 端口', () => {
    const code = stripComments(
      readFileSync(resolve(REPO_ROOT, 'src/main/secureBackup.ts'), 'utf-8')
    )
    expect(code).not.toMatch(/\bsafeStorage\b/)
    expect(code).toMatch(/BackupCipher/)
  })

  it('桌面装配层仍然提供 safeStorage 实现（防「解耦了但桌面端加密没了」）', () => {
    // 内核不许引用 safeStorage,但桌面端必须仍在用它 —— 否则就是把加密一并解耦掉了。
    const desktop = readFileSync(
      resolve(REPO_ROOT, 'src/main/secureBackupCipher.safeStorage.ts'),
      'utf-8'
    )
    expect(desktop).toMatch(/safeStorage/)
  })

  it('持久化端口不依赖 electron-store（它内部 import electron，见其 index.js:3）', () => {
    // electron-store 自己 `import electron from 'electron'`（v11.0.2 的第 3 行），
    // 而它从 `app.getPath('userData')` 推导 cwd —— 服务端既加载不了也用不上。
    // 内核只能依赖它的基类 `conf`（已核实 conf@15.0.2 零 electron 依赖）。
    for (const f of [
      'src/main/persistence/accountStorePort.ts',
      'src/main/persistence/accountStore.conf.ts'
    ]) {
      const code = stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf-8'))
      expect(code, `${f} 不应依赖 electron-store`).not.toMatch(/['"]electron-store['"]/)
    }
  })

  it('accountData 写入收口在闭包内（服务端形态必须能加载它）', () => {
    // 这条自检的对象是**闸门自己的覆盖面**，不是被测代码：state.ts 是所有
    // accountData 写入的唯一收口，它若在闭包外，「内核零 electron」就没覆盖写路径。
    expect(graph.files).toContain('src/main/accountService/state.ts')
    expect(graph.files).toContain('src/main/persistence/accountStorePort.ts')
  })
})
