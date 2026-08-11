/**
 * 共享内核的**模块图**闸门：从内核入口出发，可达的**每一个**文件都不得依赖 electron。
 *
 * ## 判定器分层与「计算 vs 手列」的边界
 *
 * 本文件的判据分两类，含义不同、维护策略也不同：
 *
 * ### A · 由闭包**计算**出来的（不用维护清单）
 *
 * 1. **文件集** = 从 `KERNEL_ENTRY_POINTS` 的 9 个入口起走**传递闭包**，由 import 关系
 *    自己长出来（今天 44 个文件）。**新增内核文件自动纳管**，不用回来加名字。
 * 2. **electron 及其子路径**：一条正则 `electron(?:/[^'"]*)?` 同时覆盖裸导入
 *    (`from 'electron'`) 与 electron.d.ts 里声明的四条子路径
 *    (`electron/main` · `electron/renderer` · `electron/common` · `electron/utility`)。
 *    实测(2026-08-11)：`require.resolve('electron/main')` 在纯 node 下 `MODULE_NOT_FOUND`
 *    —— 子路径形态**加载即死**，且死得比 `'electron'` 更硬（后者 dev 机上会返回一个
 *    字符串路径）。故用通配子路径的正则一并覆盖 —— 未来 electron 再加子路径也自动纳管。
 *    判据末尾锚 `['"]` 是关键：确保 `electron-store` / `my-electron` / `./electron`
 *    等**不**误命中。
 * 3. **可达 electron 的第三方包**：对闭包引用的每个外部 specifier，做一次
 *    「这个包(含其 dependencies 传递闭包)是不是 import 了 electron」的**计算**
 *    (`packageReachesElectron`)。electron-store 就是这类活样本：它自己在 `index.js:3`
 *    直接 `import electron from 'electron'`，但**没在 manifest 里申明任何 electron 依赖**
 *    (`peerDependencies === undefined`，实测)—— 单靠 manifest 扫描无法识别，必须扫源文本。
 *    今天 44 文件闭包引用的传递包 38 个，扫下来 551 个 .js/.d.ts / 27 MB / 190 ms —— 单元测试可承受。
 *
 * ### B · 手列**很少几个**必须硬编码的（用「反漂移自检」防清单腐烂）
 *
 * 手列的只有两种：`KERNEL_ENTRY_POINTS`（内核入口 · 「谁是服务端形态要加载的」是**业务决策**，
 * 无法由代码算出），和 `ALIASES`（路径别名 · 必须与 vitest.config.ts / tsconfig.node.json
 * 保持一致，代码里无二义地反映即可）。
 * **除此之外没有别的手列清单** —— 特别是：**没有** electron-* 包名的黑名单
 * （findings.md 提过一版枚举 `electron-store` / `electron-updater` / ... 的方案，
 * 已放弃 —— 那正是本文件头部所批的「按名字查、不按能力查」·
 * 见 error-journal P-13）。
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
 * ## 三种形态都要扫（导入侧）
 *
 * ADR-0002 Decision 2 记录过一个检索陷阱：`git grep "from 'electron'"` 只匹配 ESM，
 * 漏掉了两个用 CJS `require('electron')` 的承重文件。故 ESM / CJS / 动态 import
 * 三形态同扫 —— 少扫一种，绕过闸门就只是换个写法的事。
 *
 * ## 已知边界（明写以免被误当漏洞）
 *
 * 1. **变量拼串的动态 import**（如 `import(['elec','tron'].join(''))`）**静态分析看不见**，
 *    本闸门不覆盖。运行时侧由 `kernelWithoutElectron.runtime.test.ts` 与代码评审兜。
 * 2. **ambient `Electron.X` 与 `process.<electron 独有成员>`**（不 import 直接用全局）
 *    本闸门**故意不加正则判据**。三条理由：
 *    (a) 今天 44 文件闭包内**零命中**（实测：全 `src/` 命中都在 preload / 桌面装配层，
 *        全部在闭包外），加了正则也逮不到现存问题；
 *    (b) 加了这条正则会有真实误报面：`Electron.X` 会被 `"see Electron.App docs"`
 *        这类字符串命中；`process.type` / `process.mas` 等成员名太通用，业务代码里
 *        碰巧同名的 `process` 包装对象（虽然今天 332 个文件里零遮蔽）就会误报，
 *        而闸门自己无法可靠区分「global process」和「同名局部对象」；
 *    (c) 电子端 `electron.d.ts` 会随 electron 大版本增改 Process 成员（本次实测
 *        26 个电子独有成员）—— 硬编码进正则会形成隐性维护清单，与本文件头段
 *        批的清单式做法同源。
 *    若日后内核**真出现**这种写法（哪怕一次），此判据就有明确的、可指名的驱动事实
 *    再引入 —— 那时它有实证支撑；今天没有。
 */
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
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
 *
 * `server/entry.ts` 是 K-5 补的，也是这份清单里**最承重的一个**：它是服务端进程的
 * 真入口（`node out/server/index.js` 跑的就是它），即「服务端形态要加载的东西」
 * 从此有了唯一的、真实的根。此前那 9 个入口是**代表**服务端会用到的子树，
 * 是人手挑的；从今天起闭包由真入口自己长出来 —— 这正是本文件头段说的
 * 「入口是手列的，覆盖多少取决于列全没列全」那个残余风险的收口。
 * 加它之后闭包从 44 涨到实测规模，且它把 `webPanel/*` 与 `ipc/panelProxyDeps.ts`
 * 一并拉进来（此前两者都不在任何入口的闭包里 —— 面板服务器本身从未被这道闸门覆盖过）。
 * `server/config.ts` / `server/assembly.ts` / `server/adminKeyStore.ts` 都由它带入，
 * 不必单列。
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
  'src/main/persistence/accountStore.conf.ts',
  'src/main/server/entry.ts'
]

/**
 * ESM / CJS / 动态 import 三形态。正则里的 `electron(?:\/[^'"]*)?` 一并覆盖裸导入与
 * electron.d.ts 声明的四条子路径。末尾锚 `['"]` 挡住 `electron-store` / `./electron`
 * 等**不**是 electron 本身的名字。
 */
const ELECTRON_IMPORT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ESM  import ... from 'electron[/subpath]'", re: /\bfrom\s*['"]electron(?:\/[^'"]*)?['"]/ },
  { name: "ESM  import 'electron[/subpath]'", re: /\bimport\s*['"]electron(?:\/[^'"]*)?['"]/ },
  { name: "CJS  require('electron[/subpath]')", re: /\brequire\s*\(\s*['"]electron(?:\/[^'"]*)?['"]\s*\)/ },
  { name: "动态 import('electron[/subpath]')", re: /\bimport\s*\(\s*['"]electron(?:\/[^'"]*)?['"]\s*\)/ }
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

/** 只跟踪仓内源码；第三方包(node_modules)与 node: 内置不在**图**扫描范围内；
 *  但外部包会被**包审计**层单独判定（见 `packageReachesElectron`）。 */
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

/** 一个外部包是不是 import 了 electron（含子路径），只在其发布产物里扫。 */
const EXTERNAL_ELECTRON_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]electron(?:\/[^'"]*)?['"]/

/**
 * 包审计：给一个外部说明符（形如 `electron-store` 或 `@scope/name` 或 `pkg/deep/sub`），
 * 递归看它自己 + 其 `dependencies` / `peerDependencies` / `optionalDependencies` 传递闭包
 * 里，有没有任何**发布文件**（.js / .cjs / .mjs / .d.ts）**在源文本里**引用 `'electron'`
 * 或其子路径。
 *
 * 为什么源文本扫而不是仅 manifest：electron-store 是活样本 —— manifest 里没有任何
 * 关于 electron 的字段（`peerDependencies` 就没写），但 `index.js:3` 直接
 * `import electron from 'electron'`。manifest 扫描**看不见**这种。故必须扫源文本。
 *
 * 缓存 & 递归防环。返回 { reached: boolean; via: string }。
 */
interface PkgAuditResult { reached: boolean; via: string; missing?: boolean }
const pkgCache = new Map<string, PkgAuditResult>()

function findPkgDir(pkgName: string): string | null {
  // 从仓根往上找一次 node_modules；本仓 node_modules 就在 REPO_ROOT 里
  const cand = join(REPO_ROOT, 'node_modules', pkgName)
  if (existsSync(join(cand, 'package.json'))) return cand
  return null
}

function packageReachesElectron(spec: string): PkgAuditResult {
  // 提取包名（`electron-store/dist` → `electron-store`；`@scope/name/foo` → `@scope/name`）
  const parts = spec.split('/')
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (pkgCache.has(pkgName)) return pkgCache.get(pkgName)!

  // 占位，防递归环
  const placeholder: PkgAuditResult = { reached: false, via: '' }
  pkgCache.set(pkgName, placeholder)

  // 特例：electron 本身当然「可达 electron」—— 但内核代码不会走这条路径进包审计，
  // 因为 electron 直接 import 已由主判据在 §ELECTRON_IMPORT_PATTERNS 挡下；
  // 这里返回 reached=true 只是让审计逻辑自洽。
  if (pkgName === 'electron') {
    const r: PkgAuditResult = { reached: true, via: 'electron (self)' }
    pkgCache.set(pkgName, r)
    return r
  }

  const dir = findPkgDir(pkgName)
  if (!dir) {
    // 找不到 = node: 内置或未安装。node: 内置永远不 import electron，视为 clean。
    const r: PkgAuditResult = { reached: false, via: '', missing: true }
    pkgCache.set(pkgName, r)
    return r
  }

  // 1) 扫本包源文本
  const stack: string[] = [dir]
  const seen = new Set<string>()
  while (stack.length) {
    const d = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test' || e.name === 'tests') continue
        stack.push(p)
      } else if (/\.(m?js|cjs|d\.ts|d\.mts|d\.cts)$/.test(e.name)) {
        if (seen.has(p)) continue
        seen.add(p)
        let txt: string
        try {
          txt = readFileSync(p, 'utf-8')
        } catch {
          continue
        }
        if (EXTERNAL_ELECTRON_RE.test(txt)) {
          const r: PkgAuditResult = { reached: true, via: `${pkgName} :: ${relative(dir, p).replace(/\\/g, '/')}` }
          pkgCache.set(pkgName, r)
          return r
        }
      }
    }
  }

  // 2) 递归 dependencies + peerDependencies + optionalDependencies
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    const deps = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {})
    ]
    for (const d of deps) {
      const sub = packageReachesElectron(d)
      if (sub.reached) {
        const r: PkgAuditResult = { reached: true, via: `${pkgName} -> ${sub.via}` }
        pkgCache.set(pkgName, r)
        return r
      }
    }
  } catch {
    /* 读不了 package.json 视为 clean */
  }

  const r: PkgAuditResult = { reached: false, via: '' }
  pkgCache.set(pkgName, r)
  return r
}

interface KernelGraph {
  /** 可达文件（仓库相对路径，正斜杠） */
  files: string[]
  /** 引用了 electron 的可达文件 → 命中的形态 + 引入链 */
  violations: Array<{ file: string; forms: string[]; chain: string[] }>
  /** 内核文件引用的、传递可达 electron 的外部包（含引入文件） */
  externalViolations: Array<{ file: string; spec: string; via: string }>
  /** 内核里出现过的所有外部包（用于反漂移自检） */
  externalSpecs: Map<string, Set<string>>
  /** 解析不了的仓内说明符。非空即闸门失效（漏扫子树），必须报错而不是忽略 */
  unresolved: string[]
}

function rel(abs: string): string {
  return relative(REPO_ROOT, abs).replace(/\\/g, '/')
}

/** 从入口计算传递闭包，并在闭包内扫 electron 依赖（内核源码 + 外部包审计） */
function buildKernelGraph(entries: string[]): KernelGraph {
  const visited = new Set<string>()
  const parent = new Map<string, string>()
  const violations: KernelGraph['violations'] = []
  const externalViolations: KernelGraph['externalViolations'] = []
  const externalSpecs: Map<string, Set<string>> = new Map()
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
      if (isInternalSpecifier(spec)) {
        const target = resolveInternal(norm, spec)
        if (!target) {
          unresolved.push(`${spec}  (from ${rel(norm)})`)
          continue
        }
        if (!parent.has(target)) parent.set(target, norm)
        walk(target)
        continue
      }
      // 外部说明符：登记 + 送去包审计
      if (spec.startsWith('node:')) continue // node: 内置永远 clean
      if (!externalSpecs.has(spec)) externalSpecs.set(spec, new Set())
      externalSpecs.get(spec)!.add(rel(norm))
      const audit = packageReachesElectron(spec)
      if (audit.reached) {
        externalViolations.push({ file: rel(norm), spec, via: audit.via })
      }
    }
  }

  for (const e of entries) walk(resolve(REPO_ROOT, e))

  return {
    files: [...visited].map(rel).sort(),
    violations,
    externalViolations,
    externalSpecs,
    unresolved
  }
}

describe('architecture: 共享内核零 electron 依赖（模块图闸门）', () => {
  const graph = buildKernelGraph(KERNEL_ENTRY_POINTS)

  it('内核入口的传递闭包里没有任何文件直接依赖 electron（含子路径）', () => {
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

  it('内核可达的任何第三方包，其自身或依赖闭包不得 import electron', () => {
    // 这条堵的是 electron-store 这类活样本：manifest 里可以完全不申明 electron
    // （实测：`peerDependencies === undefined`），但 index.js:3 直接
    // `import electron from 'electron'` —— manifest 扫描看不见，只能扫源文本。
    // 递归到 dependencies / peerDependencies / optionalDependencies 的传递闭包，
    // 让新增的 `electron-XYZ` 等**自动**纳管；不再手列包名。
    const detail = graph.externalViolations
      .map((v) => `  ${v.file}\n    import '${v.spec}'\n    可达链: ${v.via}`)
      .join('\n')
    expect(
      graph.externalViolations.map((v) => `${v.file}::${v.spec}`),
      `以下内核文件引入了「传递可达 electron 的第三方包」，服务端形态既加载不了也用不上。\n${detail}`
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

  it('自检：判定器真的能抓到导入侧十种违规写法（含子路径 · 防正则写错导致空转假绿）', () => {
    const samples = [
      "import { app } from 'electron'",
      "import { app } from 'electron/main'",
      "import { x } from 'electron/renderer'",
      "import { x } from 'electron/common'",
      "import { x } from 'electron/utility'",
      "import 'electron'",
      "const { app } = require('electron')",
      "const { app } = require('electron/main')",
      "const m = await import('electron')",
      "const m = await import('electron/main')"
    ]
    for (const s of samples) {
      const hit = ELECTRON_IMPORT_PATTERNS.some((p) => p.re.test(s))
      expect(hit, `判定器漏掉了违规写法: ${s}`).toBe(true)
    }
  })

  it('自检：判定器不会误伤名字里带 electron 的无关包（辨别力）', () => {
    // 这些**不**是 electron 本身，是名字里碰巧带 electron 的包 / 相对路径。
    // 若它们被本判据命中 = 正则末尾锚丢失 = 会把 electron-updater 等桌面装配层
    // 正当使用的包一起打红 —— 但这是**内核**闸门，只在闭包内运行；桌面装配层
    // 本来就不进闭包，问题不会显形；但仍在此断言拦住误改。
    const notElectron = [
      "import Store from 'electron-store'",
      "import { autoUpdater } from 'electron-updater'",
      "import log from 'electron-log'",
      "import x from 'electronify'",
      "import x from 'my-electron'",
      "import x from './electron'",
      "import x from 'electron-store/dist'"
    ]
    for (const s of notElectron) {
      const hit = ELECTRON_IMPORT_PATTERNS.some((p) => p.re.test(s))
      expect(hit, `导入侧判据误伤了非 electron 包: ${s}`).toBe(false)
    }
  })

  it('自检：包审计能识别 electron-store（活样本 · 反漂移锚）', () => {
    // 这条同时是**反漂移自检**：如果哪天 electron-store 内部不再 import electron
    // （它换实现了），本条会转红 —— 提示我们「这个活样本已消失，判据的驱动事实
    // 需要重新确认」。这正是 findings.md 要求的「dead entries 不能静默积累」的
    // 反面：这里锚的是「活样本仍活着」，如果它不再活，就该有人来看看。
    const r = packageReachesElectron('electron-store')
    expect(r.reached, `electron-store 应仍可达 electron。若它换实现了，请核实并更新此自检。`).toBe(true)
    expect(r.via).toMatch(/electron-store/)
  })

  it('自检：包审计对不涉 electron 的包不误报（辨别力）', () => {
    // conf 是 electron-store 的基类，实测(2026-08-11)零 electron 依赖；其余是闭包引用的常见包。
    for (const pkg of ['conf', 'uuid', 'undici', 'js-tiktoken', 'node-forge', 'socks']) {
      const r = packageReachesElectron(pkg)
      expect(r.reached, `${pkg} 不应被判为可达 electron，实测: ${r.via}`).toBe(false)
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

  it('accountData 写入收口在闭包内（服务端形态必须能加载它）', () => {
    // 这条自检的对象是**闸门自己的覆盖面**，不是被测代码：state.ts 是所有
    // accountData 写入的唯一收口，它若在闭包外，「内核零 electron」就没覆盖写路径。
    expect(graph.files).toContain('src/main/accountService/state.ts')
    expect(graph.files).toContain('src/main/persistence/accountStorePort.ts')
  })
})
