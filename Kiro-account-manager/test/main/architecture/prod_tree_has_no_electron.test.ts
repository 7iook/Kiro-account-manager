/**
 * prod 树无 electron 的闸门 —— 钉住一条**没人显式声明、却被整个服务端形态依赖**的前提。
 *
 * ## 治的是什么
 *
 * 全仓至少 7 处注释/断言消息写着「electron 是 devDependency，`--omit=dev` 后不存在」
 * （`src/main/proxy/logger.ts` / `src/main/server/assembly.ts` / `vite.server.config.ts` /
 * `kernel_without_electron.test.ts` / `server_build_target.test.ts` /
 * `loggerElectronDecoupling.test.ts`）。K-1~K-4 整个立项都建立在这句话上。
 *
 * 而这句话在 2026-08-12 之前**是假的**。实测 `npm explain electron`：
 *
 *   electron@38.7.2
 *   node_modules/electron
 *     dev electron@"^38.1.2" from the root project
 *     peer electron@">=13.0.0" from @electron-toolkit/preload@3.0.2
 *     peer electron@">=13.0.0" from @electron-toolkit/utils@4.0.0
 *
 * 两个 toolkit 包当时待在 **`dependencies`** 里，它们的非 optional peer 把 electron
 * 拖进了 prod 树 —— 即 `npm ci --omit=dev` 会下载 ~100MB Electron 二进制并跑它的
 * `install.js`。npm 认为这是设计行为（npm/cli#6282：prod 依赖的 peer 不算 dev 依赖），
 * 所以这不会有任何警告。
 *
 * ## 为什么必须是闸门，而不是把注释写对就算完
 *
 * 「electron 不在 prod 树里」不是一条可以靠声明维持的事实，它是一条**涌现属性**：
 * 取决于 `dependencies` 的传递闭包里有没有任何包 peer 上 electron。
 * 任何人往 `dependencies` 加一个 electron 生态的包（`electron-log`、`electron-dl`、
 * 又一个 `@electron-toolkit/*`……）都会**静默**推翻它 —— package.json 的 diff 看起来
 * 只是「加了一个依赖」，而后果是服务端部署树重新长出 100MB Electron。
 * 失败还不是立刻可见的：prod 树里多了个 electron 通常不报错，只是变大、变慢、
 * 且上面那 7 处注释同时变成谎言。这正是本仓 E-052 母题（局部对、整条链断）。
 *
 * ## 为什么不真跑 `npm ci --omit=dev`
 *
 * 姿态同 `postinstall_conditional.test.ts`：真装一次 prod 树要 4s~26s + 网络 + registry，
 * 而**违规时**要下 100MB Electron（分钟级）。放进单测套件会让人去加 skip 而不是修。
 * 故这里断言的是**决定那个结果的输入**：package.json 的依赖分桶 + lockfile 的 dev 标记。
 * 二者都是 npm 自己算出来的传递闭包结论，不是我们重算的。
 *
 * ## 强度边界（诚实标注）
 *
 * | 层 | 断言对象 | 强度 | 抓不到 |
 * |---|---|---|---|
 * | L1 | 两个 toolkit 包在 devDependencies、不在 dependencies | 强 | 抓不到「别的包 peer 上 electron」 |
 * | L2 | lockfile 里 `node_modules/electron` 带 dev 标记 | 强（npm 算的闭包结论） | lockfile 未同步时会失效 → L4 兜 |
 * | L3 | `dependencies` 的**传递闭包**里没有任何包 peer/dep 上 electron | 强（真扫 manifest） | 抓不到只在源码里 import 的形态（那是 kernel_without_electron.test.ts L2 的职责） |
 * | L4 | package.json 与 lockfile 的 root 节点一致（防 lockfile 滞后） | 强 | — |
 * | L5 | 判定器自检：注入一个假的 peer 依赖必须让 L3 转红 | 强 | — |
 *
 * L5 是关键：没有它，若 L3 的闭包遍历哪天退化成「永远扫不到东西」，它会恒绿，
 * 而「恒绿」与「真的没有违规」在输出里完全同形。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const PKG_PATH = join(REPO_ROOT, 'package.json')
const LOCK_PATH = join(REPO_ROOT, 'package-lock.json')
const NODE_MODULES = join(REPO_ROOT, 'node_modules')

/** 桌面独有、绝不该出现在 prod 树里的包。 */
const ELECTRON_RUNTIME = 'electron'

type Manifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
}

const pkg: Manifest = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))

/** 读一个已安装包的 manifest；读不到返回 null（未安装 / 未提升到顶层）。 */
function readInstalledManifest(name: string): Manifest | null {
  const p = join(NODE_MODULES, ...name.split('/'), 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Manifest
  } catch {
    return null
  }
}

/**
 * 从 `dependencies` 出发遍历传递闭包，找出「会把 electron 拖进 prod 树」的包。
 *
 * 判定依据是 npm 的实际行为（npm/cli#6282）：**非 optional 的 peerDependency 会被安装**。
 * 故三类边都要跟：dependencies / optionalDependencies（都装）+ 非 optional 的 peerDependencies。
 * `peerDependenciesMeta[x].optional === true` 的那条边不跟 —— 那种 peer 不会被自动安装。
 *
 * 用**已安装的 manifest** 而不是 lockfile 的边表：lockfile 的结构随 npm 版本演进，
 * 而 `node_modules/<pkg>/package.json` 里的 peerDependencies 是包作者的原始声明，
 * 是这条因果的真源。
 */
function findElectronPullers(
  roots: string[],
  resolveManifest: (name: string) => Manifest | null = readInstalledManifest
): { pkg: string; via: 'peer' | 'dep' | 'optional'; chain: string[] }[] {
  const hits: { pkg: string; via: 'peer' | 'dep' | 'optional'; chain: string[] }[] = []
  const seen = new Set<string>()
  const queue: { name: string; chain: string[] }[] = roots.map((r) => ({ name: r, chain: [r] }))

  while (queue.length > 0) {
    const { name, chain } = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    const m = resolveManifest(name)
    if (!m) continue

    // 本包是否直接把 electron 拉进来？
    const peerOptional = m.peerDependenciesMeta?.[ELECTRON_RUNTIME]?.optional === true
    if (m.dependencies?.[ELECTRON_RUNTIME]) {
      hits.push({ pkg: name, via: 'dep', chain })
    } else if (m.optionalDependencies?.[ELECTRON_RUNTIME]) {
      hits.push({ pkg: name, via: 'optional', chain })
    } else if (m.peerDependencies?.[ELECTRON_RUNTIME] && !peerOptional) {
      hits.push({ pkg: name, via: 'peer', chain })
    }

    // 继续走会被实际安装的边
    const next = new Set<string>([
      ...Object.keys(m.dependencies ?? {}),
      ...Object.keys(m.optionalDependencies ?? {}),
      ...Object.keys(m.peerDependencies ?? {}).filter(
        (d) => m.peerDependenciesMeta?.[d]?.optional !== true
      )
    ])
    for (const d of next) {
      if (d === ELECTRON_RUNTIME) continue // 已在上面判定
      if (!seen.has(d)) queue.push({ name: d, chain: [...chain, d] })
    }
  }

  return hits
}

describe('prod 树（npm ci --omit=dev）不得包含 electron', () => {
  it('L1 · 两个 @electron-toolkit 包在 devDependencies，不在 dependencies', () => {
    // 这两个包是历史违规源：它们的 peer electron 曾把 100MB 二进制拖进 prod 树。
    // 桌面端仍在用（src/main/index.ts / src/preload/index.ts），但由 electron-vite
    // 内联进产物（externalizeDepsPlugin 只 external `dependencies`），故 devDep 足够。
    const toolkitPkgs = ['@electron-toolkit/utils', '@electron-toolkit/preload']
    for (const p of toolkitPkgs) {
      expect(
        pkg.dependencies?.[p],
        `${p} 不得出现在 dependencies —— 它 peer 上 electron，会把 ~100MB Electron 二进制\n` +
          `拖进 npm ci --omit=dev 的服务端部署树（npm/cli#6282）。\n` +
          `桌面端仍可正常使用：electron-vite 的 externalizeDepsPlugin 只把 dependencies\n` +
          `列为 external，移出后实现会被内联进 out/main|preload/index.js。`
      ).toBeUndefined()
      expect(pkg.devDependencies?.[p], `${p} 应在 devDependencies 里`).toBeTruthy()
    }
  })

  it('L2 · lockfile 里 node_modules/electron 带 dev 标记', () => {
    // lockfile 才是 `npm ci` 真正读的东西。package.json 对了而 lockfile 滞后时，
    // 部署树照旧长出 electron —— 本仓此前就发生过「改了 package.json、lockfile 没跟」。
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as {
      packages?: Record<string, { dev?: boolean; devOptional?: boolean }>
    }
    const node = lock.packages?.[`node_modules/${ELECTRON_RUNTIME}`]
    expect(node, 'lockfile 里应有 node_modules/electron 节点（它是 devDependency）').toBeTruthy()
    expect(
      node?.dev === true || node?.devOptional === true,
      `package-lock.json 的 node_modules/electron 未标记 dev —— 意味着它从某条 **prod** 路径\n` +
        `也可达，于是 npm ci --omit=dev 仍会安装它（~100MB 二进制 + install.js）。\n` +
        `跑 \`npm install --package-lock-only\` 重算，或检查是不是新加了 peer 上 electron 的 prod 依赖。`
    ).toBe(true)
  })

  it('L3 · dependencies 的传递闭包里没有任何包把 electron 拉进来', () => {
    // L1 只钉了两个已知包名；这条才是通用的 —— 任何人新加一个 electron 生态的
    // prod 依赖都会在这里转红，而不是等到部署时发现树里多了 100MB。
    const roots = Object.keys(pkg.dependencies ?? {})
    const hits = findElectronPullers(roots)
    const detail = hits
      .map((h) => `  ${h.pkg} (via ${h.via})\n    引入链: ${h.chain.join(' -> ')}`)
      .join('\n')

    expect(
      hits.map((h) => h.pkg),
      `以下 prod 依赖会把 electron 拖进服务端部署树（npm 会安装非 optional 的 peer，\n` +
        `见 npm/cli#6282）。后果：npm ci --omit=dev 下载 ~100MB Electron 二进制并跑\n` +
        `install.js，且全仓 7 处「electron 是 devDependency，--omit=dev 后不存在」的\n` +
        `注释与断言消息同时变成谎言。\n` +
        `处理：把该包移入 devDependencies（若只有桌面端用），或换一个不 peer electron 的包。\n${detail}`
    ).toEqual([])
  })

  it('L4 · package.json 与 lockfile 的 root 依赖分桶一致（防 lockfile 滞后）', () => {
    // npm ci 只读 lockfile。root 节点与 package.json 分叉时，上面几条断言全都可能
    // 对着一个「不会被实际使用的」package.json 报绿。
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as {
      packages?: Record<string, Manifest>
    }
    const root = lock.packages?.['']
    expect(root, 'lockfile 应有 root ("") 节点').toBeTruthy()

    const pkgDeps = Object.keys(pkg.dependencies ?? {}).sort()
    const lockDeps = Object.keys(root?.dependencies ?? {}).sort()
    expect(
      lockDeps,
      `package-lock.json 的 root dependencies 与 package.json 不一致 —— lockfile 滞后。\n` +
        `npm ci 只读 lockfile，故此时 package.json 的分桶是**无效的**。\n` +
        `跑 \`npm install --package-lock-only\` 同步。`
    ).toEqual(pkgDeps)

    const pkgDev = Object.keys(pkg.devDependencies ?? {}).sort()
    const lockDev = Object.keys(root?.devDependencies ?? {}).sort()
    expect(lockDev, 'package-lock.json 的 root devDependencies 与 package.json 不一致').toEqual(
      pkgDev
    )
  })

  it('L5 · 自检：判定器能真的抓到违规（否则 L3 恒绿 = 假绿）', () => {
    // 没有这条，findElectronPullers 若哪天退化（manifest 读不到就静默 continue、
    // 闭包遍历走错边），L3 会**永远报绿**，而「恒绿」与「真的没有违规」在输出里
    // 完全同形（本仓 E-052 母题）。姿态取自 postinstall_conditional.test.ts 的 L4。
    const fake: Record<string, Manifest> = {
      'some-prod-pkg': { dependencies: { 'nested-electron-thing': '^1.0.0' } },
      'nested-electron-thing': { peerDependencies: { electron: '>=13.0.0' } }
    }
    const hits = findElectronPullers(['some-prod-pkg'], (n) => fake[n] ?? null)
    expect(hits.map((h) => h.pkg), '注入的间接 peer 违规必须被抓到').toEqual([
      'nested-electron-thing'
    ])
    expect(hits[0].via).toBe('peer')
    expect(hits[0].chain).toEqual(['some-prod-pkg', 'nested-electron-thing'])

    // 反向控制：optional 的 peer **不该**被算作违规（npm 不会自动装它）
    const optionalCase: Record<string, Manifest> = {
      'opt-pkg': {
        peerDependencies: { electron: '>=13.0.0' },
        peerDependenciesMeta: { electron: { optional: true } }
      }
    }
    expect(
      findElectronPullers(['opt-pkg'], (n) => optionalCase[n] ?? null),
      'optional peer 不会被 npm 自动安装，不该判违规（否则闸门会误报）'
    ).toEqual([])
  })
})
