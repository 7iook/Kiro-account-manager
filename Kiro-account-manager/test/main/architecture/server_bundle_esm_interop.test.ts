/**
 * 服务端产物的 **ESM-only 依赖互操作** 闸门。
 *
 * 治的是一次真实的启动即死：`node out/server/index.js` → 退出码 69 →
 * `Conf is not a constructor`（实测 2026-08-12 · node v22.20.0）。
 *
 * ## 为什么既有的闸门一条都没抓到
 *
 * `server_build_target.test.ts` 已经很密（L1 配置形状 / L2 相对契约 / L3 真实产物），
 * 但它对产物的断言全是**文本层**的：有 `require(` 吗、有顶层 `import` 吗、
 * 有 `require('conf')` 吗。而本缺陷的产物**逐项满足**这些断言 —— 它是 CJS、
 * 它 external 了 conf、它有 sourcemap —— 只是 `require('conf')` 拿到的东西
 * **不能 `new`**。文本形态正确，语义错误。
 *
 * 上一轮的验证跑的是 `require('out/server/index.js')` 并得到 `LOADED_OK`。
 * 那个读数是真的,但它只证明**模块顶层**能加载 —— `new Conf(...)` 在
 * `createConfAccountStore()` 函数体内,只有真启动才会执行。**断言点位置错了**,
 * 不是结论错了。故本组的判据刻意不是「能不能 import」,而是
 * 「**能不能真的构造出一个可用的 store**」。
 *
 * ## 根因比「conf 需要 interop」更上游（这决定了本组断言什么）
 *
 * rollup 的 `output.interop` 默认值是 `'default'`,它**假定所有 external 都是 CJS**
 * （`require(x)` 的返回值本身就是 default 导出）。对真 CJS 包成立;对真 ESM 包
 * （`conf@15` 是 `"type":"module"` 且无 CJS 入口）不成立 —— `require(真ESM)` 返回的是
 * `{__esModule:true, default:<class>}` 命名空间对象,`typeof` 是 `'object'`,不可调用。
 *
 * 于是这不是「conf 这个包的特例」,而是**产物边界上对所有 external 的一条错误假设**。
 * 今天只有 `conf` 用 default import 所以只有它炸;明天任何人写
 * `import X from '<下一个 ESM-only 包>'` 都会得到同一个形态,而且**构建照绿、
 * 顶层 import 照绿**,只在运行到那行代码时才炸。
 *
 * 故修法取在边界（`output.interop: 'auto'`,让 rollup 对每个 default import 发
 * `__esModule` 探测助手）,本组也照此分两层断言:
 *
 * | 层 | 断言对象 | 抓得到 |
 * |---|---|---|
 * | L1 配置 | `vite.server.config.ts` 的 `output.interop` 必须是 `'auto'` | 有人把它改回 `'default'` / 删掉它 |
 * | L2 真实产物 · 语义 | 从产物里**真构造一个 store 并读写它** | 任何让构造失败的原因,不限于 conf |
 * | L3 全类扫描 | 产物里每个 default-import 的 external 都真能按其被使用的形态使用 | 下一个 ESM-only 包 |
 *
 * L2 才是承重的那层:它执行的是**真代码路径**,而不是检查产物文本里有没有某个字样。
 * 一个只 `require()` 产物的测试永远抓不到本缺陷（已实测,见上）。
 */
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { describe, it, expect, afterAll } from 'vitest'
import serverConfig from '../../../vite.server.config'

const REPO_ROOT = resolve(__dirname, '../../..')
const cfg = serverConfig as Record<string, any>
const build = cfg.build as Record<string, any>
const OUT_DIR = build.outDir as string
const BUILT_ENTRY = join(OUT_DIR, 'index.js')
const built = existsSync(BUILT_ENTRY)
const SKIP_REASON =
  `未发现 ${BUILT_ENTRY} —— 先跑 \`npm run build:server\`。` +
  `本组校验真实产物的**运行时语义**，产物不存在时跳过而非误报（同 server_build_target.test.ts 的姿态）。`

/** 本组创建的临时数据目录，收尾统一清理 */
const tmpDirs: string[] = []
function freshDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'kiro-interop-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不该让测试红 —— 它不是被测契约的一部分。
      // 不静默:打一行，免得 TEMP 里长期堆积无人知道。
      console.warn(`[test] 临时目录清理失败（可手工删）: ${d}`)
    }
  }
})

describe('服务端产物 ESM 互操作 · L1 配置形状', () => {
  it("rollup output.interop 是 'auto' —— 默认的 'default' 假定所有 external 都是 CJS", () => {
    // 这条是修法的锚。`'default'`（rollup 默认值）对 ESM-only 包会发出
    // `const X = require('pkg')` 而不带 __esModule 探测，于是 default import
    // 拿到的是命名空间对象。失败形态是运行时 `X is not a constructor`，
    // 而构建与顶层 import 全绿 —— 最难归因的一类。
    expect(
      build.rollupOptions?.output?.interop,
      "output.interop 不是 'auto' —— ESM-only 依赖的 default import 在产物里会拿到" +
        '命名空间对象而非其 default 导出，运行到那行才炸（实测: Conf is not a constructor）'
    ).toBe('auto')
  })
})

describe('服务端产物 ESM 互操作 · L2 真实产物的运行时语义（最承重）', () => {
  it.skipIf(!built)(
    '产物真的能启动一台服务端，且 store 可读写（不是「模块能 import」）',
    async () => {
      // ## 为什么断言「真启动」，而不是 import
      //
      // 本缺陷下 `require(产物)` **成功**（上一轮拿到 LOADED_OK）—— `new Conf()`
      // 在 `bootstrap()` 的装配步骤里，只有真启动才执行。故判据必须走真代码路径。
      //
      // 用 `bootstrap()` 而不是 `main()`：main 内部会 `process.exit`，在 vitest 里
      // 会把测试进程本身杀掉（entry.ts 头段正是为此把两者分开的）。
      //
      // 环境刻意**显式构造**而非用 `process.env`：一个干净 env 才能保证读到的是
      // 本测试给的数据目录，而不是开发机上恰好设着的某个 KIRO_* 变量。
      const req = createRequire(BUILT_ENTRY)
      const bundle = req(BUILT_ENTRY) as {
        bootstrap: (env: NodeJS.ProcessEnv) => Promise<{
          store: {
            get: (k: string, d?: unknown) => unknown
            set: (k: string, v: unknown) => void
            path: string
          }
          shutdown: () => Promise<void>
        }>
      }
      expect(
        typeof bundle.bootstrap,
        '产物未导出 bootstrap —— 本组断言的是它的运行时可用性；\n' +
          '入口若改名，请同步改本断言（不要删：这条是「启动即死」的回归锚）'
      ).toBe('function')

      const dataDir = freshDataDir()
      const env: NodeJS.ProcessEnv = {
        KIRO_DATA_DIR: dataDir,
        // 端口 0 = 由内核分配。写死端口会让本测试在开发机上偶发撞占用，
        // 而那种红是噪声，人会去加 skip —— 闸门反而被拆掉。
        KIRO_PANEL_PORT: '0',
        KIRO_PANEL_HOST: '127.0.0.1',
        // 预置 adminKey：避免每跑一次测试就生成并打印一个真实凭据。
        KIRO_ADMIN_KEY: 'interop-probe-key-not-a-real-secret-000000'
      }

      // 本缺陷下这一行 reject：`Conf is not a constructor`
      //（与真启动的退出码 69 同一处）。
      const server = await bundle.bootstrap(env)
      try {
        // store 真读写。conf 的 set/get 走 AES 加解密 + 原子写 ——
        // 能往返说明拿到的是真实现，而不是某个恰好可 new 的别的东西。
        server.store.set('__interopProbe', { ok: true, n: 42 })
        expect(server.store.get('__interopProbe')).toEqual({ ok: true, n: 42 })

        // 端口契约：`set(key, undefined)` 必须被翻译成 delete（accountStorePort 的
        // 适配器）。顺带钉住产物里的适配器也在工作，不只是 conf 本身能用。
        server.store.set('__interopProbe', undefined)
        expect(server.store.get('__interopProbe')).toBeUndefined()

        // 数据文件真落在运维指定的目录，而不是 conf 用 env-paths 推导的平台默认目录
        expect(server.store.path).toBe(join(dataDir, 'kiro-accounts.json'))
        expect(existsSync(server.store.path)).toBe(true)
      } finally {
        // 必须停机：面板已监听一个真实端口，泄漏会让 vitest 挂住不退。
        await server.shutdown()
      }
    }
  )
})

describe('服务端产物 ESM 互操作 · L3 全类扫描（下一个 ESM-only 包也要抓到）', () => {
  /**
   * 从产物里抽出所有 `const X = require("pkg")` 形态的**第三方**外部依赖。
   *
   * 刻意排除 node 内建模块:对它们 rollup 的 CJS 假定永远成立（它们真是 CJS）,
   * 而把它们纳入会让本组变成「断言 node 自己没坏」。
   */
  function externalRequires(src: string): Array<{ local: string; pkg: string }> {
    const out: Array<{ local: string; pkg: string }> = []
    const re = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\);?$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const pkg = m[2]
      if (pkg.startsWith('node:')) continue
      // 裸内建名（'fs' / 'http' / 'crypto' …）也排除
      if (!pkg.includes('/') && isBuiltin(pkg)) continue
      out.push({ local: m[1], pkg })
    }
    return out
  }

  function isBuiltin(name: string): boolean {
    // 用 node 自己的清单，别手列（手列会随 node 版本漂移）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { builtinModules } = require('node:module') as { builtinModules: string[] }
    return builtinModules.includes(name)
  }

  it.skipIf(!built)('产物里被 default-import 消费的 external 都真的可按该形态使用', () => {
    const src = readFileSync(BUILT_ENTRY, 'utf-8')
    const req = createRequire(BUILT_ENTRY)
    const externals = externalRequires(src)

    // 自检：扫描器真的扫到了东西。零命中与「全部健康」在输出里同形（本仓 E-052 母题）。
    expect(
      externals.length,
      '产物里没扫到任何第三方 require —— 扫描正则失效或产物形态变了，本组等于空转'
    ).toBeGreaterThan(0)

    /**
     * 对每个 external:若产物里存在 `new <local>(` 或 `<local>(` 这种把它**当值调用**
     * 的用法,那么它必须真的可调用。这正是 default-import 与命名空间对象的分水岭。
     */
    const broken: string[] = []
    for (const { local, pkg } of externals) {
      const usedAsCallable =
        new RegExp(`\\bnew\\s+${escapeRe(local)}\\s*\\(`).test(src) ||
        new RegExp(`(?<![.\\w])${escapeRe(local)}\\s*\\(`).test(src)
      if (!usedAsCallable) continue

      let mod: unknown
      try {
        mod = req(pkg)
      } catch (e) {
        broken.push(`${pkg}: require 失败 —— ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      if (typeof mod !== 'function') {
        const hasDefault =
          typeof (mod as { default?: unknown })?.default === 'function'
        broken.push(
          `${pkg}: 产物把它当可调用值使用（\`new ${local}(\` / \`${local}(\`），` +
            `但 require('${pkg}') 返回 ${typeof mod}` +
            (hasDefault
              ? '，其 .default 才是那个可调用值 —— 这是 ESM-only 包缺 interop 的特征形态'
              : '')
        )
      }
    }

    expect(
      broken,
      'produt 里存在「被当可调用值使用、但 require 回来不可调用」的 external。\n' +
        '这是 rollup output.interop 假定所有 external 是 CJS 造成的（见本文件头段）。\n' +
        "修法在构建边界：vite.server.config.ts 的 output.interop: 'auto'。\n" +
        '细节:\n  ' +
        broken.join('\n  ')
    ).toEqual([])
  })

  it('自检：扫描器对受控样本有辨别力（缺 interop 必抓 · 正确形态不误报）', () => {
    // 不带 skipIf —— 验判定器本身，与产物是否存在无关。
    // 缺 interop 的形态（本缺陷的产物）
    const bad = `const Conf = require("conf");\nconst c = new Conf({});`
    expect(externalRequires(bad)).toEqual([{ local: 'Conf', pkg: 'conf' }])

    // 正确形态（interop:'auto' 的产物）：真正被 new 的是 Conf__default.default，
    // 而 `Conf` 本身只被传给助手函数 —— 扫描器不该把它当「被当类使用」。
    const good =
      `const Conf = require("conf");\n` +
      `const _interopDefault = (e) => e && e.__esModule ? e : { default: e };\n` +
      `const Conf__default = _interopDefault(Conf);\n` +
      `const c = new Conf__default.default({});`
    const goodExternals = externalRequires(good)
    expect(goodExternals).toEqual([{ local: 'Conf', pkg: 'conf' }])
    // `new Conf(` 在 good 里不存在;`Conf(` 也不该匹配（它只作为实参出现）
    expect(/\bnew\s+Conf\s*\(/.test(good)).toBe(false)
    expect(/(?<![.\w])Conf\s*\(/.test(good)).toBe(false)

    // 内建模块被排除（否则本组变成「断言 node 没坏」）
    expect(externalRequires(`const fs = require("node:fs");`)).toEqual([])
    expect(externalRequires(`const http = require("http");`)).toEqual([])
  })
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
