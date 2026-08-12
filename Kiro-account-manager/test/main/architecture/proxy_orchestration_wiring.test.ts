/**
 * 反代编排装配闭环闸门 —— 防 E-052「建而未接」+ 防顺序真源分叉
 *
 * 本仓反复出现的失败模式：模块写好了、单测全绿、**生产路径没有任何调用者**。
 * `webPanel/` 六个模块曾经正是这个状态。所以这里用静态断言检查生产装配确实
 * 存在，而不是相信「我记得接了」。判据排除 `test/` —— 只在测试里被调用的代码
 * 就是死代码。
 *
 * 第二类不变量更要紧：**顺序不得有第二个真源**。选号的三步顺序（入池 → 单账号
 * 模式写 selectedAccountIds → 移指针+作废粘性）只允许存在于
 * `proxy/activation.ts`。若 `webPanel/` 或面板 UI 里出现同样的三步，两处早晚
 * 分叉，而分叉的表现是「面板绿灯但反代打旧号」—— 已实证过一次的那个失效。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

/** 去掉行注释与块注释，避免「注释里提到了」被当成真实调用 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 统计同一源码片段内由 `initProxyServer()` 取得的反代实例启动次数。
 *
 * 单独命名是为了让下面的受控样本能直接证伪扫描器；否则「全仓扫到 0 个」
 * 无法区分仓库确实没有启动点，还是扫描器已经失明。
 */
function countProxyStartCalls(src: string): number {
  const receivers = new Set<string>()
  const binding =
    /\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?initProxyServer\s*\(\s*\)/g
  let match: RegExpExecArray | null
  while ((match = binding.exec(src)) !== null) receivers.add(match[1])

  let count = 0
  for (const receiver of receivers) {
    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const call = new RegExp(
      `\\b${escaped}\\s*(?:(?:\\?\\.|\\.)\\s*start|(?:\\?\\.)?\\s*\\[\\s*(['"])start\\1\\s*\\])\\s*\\(\\s*\\)`,
      'g'
    )
    count += (src.match(call) ?? []).length
  }
  return count
}

describe('装配闭环: 面板反代端点在生产路径上确有调用者', () => {
  it('index.ts 确实 import 并展开了 buildPanelProxyDeps（不是只存在于测试）', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(src).toMatch(/import\s*\{\s*buildPanelProxyDeps\s*\}\s*from\s*'\.\/ipc\/panelProxyDeps'/)
    expect(
      src,
      'buildPanelProxyDeps 未展开进 routeDeps —— 端点建了但面板调不到'
    ).toMatch(/\.\.\.buildPanelProxyDeps\s*\(/)
  })

  it('装配注入的是真实 proxyServer 与真实 store，不是替身', () => {
    const src = stripComments(read('src/main/index.ts'))
    const idx = src.indexOf('buildPanelProxyDeps(')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 900)
    // 运行态判据必须来自真实实例；注入常量或替身会让面板显示假状态
    expect(block).toMatch(/getProxyServer:\s*\(\)\s*=>\s*proxyServer/)
    expect(block).toMatch(/initProxyServer:\s*\(\)\s*=>\s*initProxyServer\s*\(\)/)
    expect(block).toMatch(/loadAccountData:\s*\(\)\s*=>\s*store\?\.get\('accountData'\)/)
  })

  it('路由层五个 proxy 端点都被分派（不是只声明在接口里）', () => {
    const src = stripComments(read('src/main/webPanel/routes.ts'))
    for (const path of [
      '/api/proxy/status',
      '/api/proxy/start',
      '/api/proxy/stop',
      '/api/proxy/sync-pool',
      '/api/proxy/active-account'
    ]) {
      expect(src, `${path} 未在路由里分派`).toContain(path)
    }
    // proxy 命名空间必须真的被分流出去
    expect(src).toMatch(/routeProxyApi\s*\(\s*ctx\s*,\s*res\s*,\s*deps\s*\)/)
  })

  it('浏览器侧确实调这些端点（UI 挂进了 App，不是孤立组件）', () => {
    const app = stripComments(read('src/webPanel/App.tsx'))
    expect(app).toMatch(/import\s*\{\s*ProxyPanel\s*\}\s*from\s*'\.\/ui\/ProxyPanel'/)
    expect(app, 'ProxyPanel 未被渲染 —— 组件建了但用户看不到').toMatch(/<ProxyPanel\b/)
    const panel = stripComments(read('src/webPanel/ui/ProxyPanel.tsx'))
    expect(panel).toMatch(/fetchProxyStatus\s*\(/)
    expect(panel).toMatch(/setProxyActiveAccount\s*\(/)
    expect(panel).toMatch(/startProxy\s*\(/)
    expect(panel).toMatch(/stopProxy\s*\(/)
  })
})

describe('顺序单一真源: 三步编排不得在面板侧重现', () => {
  it('activation.ts 里三步齐全（缺任一步就是已实证的那个失效）', () => {
    const src = stripComments(read('src/main/proxy/activation.ts'))
    // 1) 入池用 upsert（addAccount 是重置式，会静默解除风控封禁）
    expect(src).toMatch(/pool\.upsertAccount\s*\(/)
    expect(src, 'activation 不得用重置式 addAccount').not.toMatch(/pool\.addAccount\s*\(\s*mapped/)
    // 2) 单账号模式的真开关 —— 这一条正是曾经漏掉的那半
    expect(src).toMatch(/selectedAccountIds:\s*\[\s*accountId\s*\]/)
    // 3) 指针 + 会话粘性失效
    expect(src).toMatch(/pool\.setActiveAccount\s*\(/)
    expect(src).toMatch(/invalidateSessionAffinity\s*\(/)
  })

  it('单账号模式判据只出现在 activation.ts，不在 webPanel/ 里重算', () => {
    // `selectedAccountIds` 是单账号模式的真开关。webPanel/ 里若出现对它的写入，
    // 说明顺序被复制到了第二处。
    for (const rel of [
      'src/main/webPanel/routes.ts',
      'src/main/webPanel/server.ts',
      'src/main/ipc/panelProxyDeps.ts'
    ]) {
      const src = stripComments(read(rel))
      expect(
        src,
        `${rel} 不得直接写 selectedAccountIds —— 顺序真源只有 proxy/activation.ts`
      ).not.toMatch(/selectedAccountIds\s*:/)
    }
  })

  it('浏览器侧不得自己拆开三步（只允许调一个端点完成选号）', () => {
    const panel = stripComments(read('src/webPanel/ui/ProxyPanel.tsx'))
    // 浏览器侧不该知道 selectedAccountIds / 池指针这些实现概念
    expect(panel).not.toMatch(/selectedAccountIds/)
    expect(panel).not.toMatch(/upsertAccount|setActiveAccount|invalidateSessionAffinity/)
  })

  it('panelProxyDeps 的启动路径先同步池再启动（顺序颠倒 = 空池启动）', () => {
    const src = stripComments(read('src/main/ipc/panelProxyDeps.ts'))
    // 锚在**实现体**上（`proxyStart: async () =>`），不是 `proxyStart:` ——
    // 后者第一次出现在返回类型声明里（`proxyStart: () => Promise<unknown>`），
    // 从那里切片只会拿到一行类型签名,然后给出"没有同步池"的假失败。
    const startIdx = src.indexOf('proxyStart: async')
    expect(startIdx, 'proxyStart 实现体不存在').toBeGreaterThan(-1)
    const stopIdx = src.indexOf('proxyStop: async', startIdx)
    expect(stopIdx, 'proxyStop 实现体不存在,无法界定 proxyStart 的范围').toBeGreaterThan(startIdx)
    const block = src.slice(startIdx, stopIdx)
    // 同步这一步允许两种写法:薄封装 `syncPool(` 或直接调导出的
    // `syncProxyPoolFromStore(`(服务端入口用的正是后者)。只认死一个名字时,
    // 一次纯改名重构会让本闸门给出"没有同步池"的假失败 —— 承重的判据是**顺序**,不是名字。
    const syncCall = /\b(syncPool|syncProxyPoolFromStore)\s*\(/.exec(block)
    // 匹配到的名字必须在本文件里真有定义或导入。否则闸门是在拿一个全仓已不存在的
    // 名字自说自话 —— 本仓已实证过两次"匹配不到东西的闸门"(零结果与不存在不可区分)。
    if (syncCall) {
      const syncName = syncCall[1]
      expect(
        new RegExp(`(?:function|const)\\s+${syncName}\\b|import[^\\n]*\\b${syncName}\\b`).test(src),
        `${syncName} 在 panelProxyDeps.ts 里既无定义也无导入 —— 闸门匹配的是个不存在的名字`
      ).toBe(true)
    }
    const syncIdx = syncCall ? syncCall.index : -1
    const startCallIdx = block.indexOf('server.start()')
    expect(syncIdx, '启动路径没有同步池 —— 会用空池启动').toBeGreaterThan(-1)
    expect(startCallIdx, '启动路径没有真的调 start()').toBeGreaterThan(-1)
    expect(syncIdx, '同步池必须在 start() 之前').toBeLessThan(startCallIdx)
    // 空池必须拒绝启动，而不是启动成功后每个请求都失败
    expect(block).toMatch(/EMPTY_POOL/)
  })

  /**
   * 服务端入口的同一条顺序 —— 本组是「按文件手列」这个形状漏掉的那一格
   *
   * 上一条 `it` 只读 `panelProxyDeps.ts`。服务端入口 `server/entry.ts` 当初写成
   * `initProxyServer()` → `start()`（中间没有同步池）时，上一条**照样全绿** ——
   * 闸门的作用域就是它读的那个文件，而缺陷在另一个文件里。这正是本仓反复出现的
   * 形状：判据只覆盖了一条路，另一条路静默分叉。故这里补上服务端那一格，
   * 并在下一个 describe 里加一条「出现新起点就红」的发现式判据，
   * 让手列的名单不能再悄悄过期。
   */
  it('server/entry.ts 的自启动分支先同步池再启动（顺序颠倒 = 空池启动）', () => {
    const src = stripComments(read('src/main/server/entry.ts'))
    // 作用域限定在**自启动分支**内，而不是整个文件：
    // 文件里另有 `server.panel.start()`（面板，⑤ 先于反代），从全文件切片会把它
    // 也算进来，于是「同步在 start 之前」这句断言就变成了在比对面板启动的位置。
    const branchIdx = src.indexOf('if (shouldAutoStartProxy(')
    expect(branchIdx, '自启动分支不存在 —— 服务端不再按盘上配置起反代了?').toBeGreaterThan(-1)
    // 下界锚在紧随其后的顶层函数声明上（`bootstrap` 之后的第一个 function），
    // 不用固定字符数窗口：窗口大小会随文案增删而失效，而失效的方向是**变绿**。
    const tail = src.slice(branchIdx)
    const endMatch = /\n(?:export\s+)?function\s/.exec(tail)
    expect(endMatch, '自启动分支之后找不到下一个顶层函数,无法界定分支范围').not.toBeNull()
    const block = tail.slice(0, endMatch!.index)

    const syncIdx = block.indexOf('syncProxyPoolFromStore(')
    const startCallIdx = block.indexOf('proxy.start()')
    expect(syncIdx, '服务端自启动没有同步池 —— 会用空池启动(反代在监听/面板显示运行中/没有账号可服务)').toBeGreaterThan(-1)
    expect(startCallIdx, '服务端自启动没有真的调 proxy.start()').toBeGreaterThan(-1)
    expect(syncIdx, '同步池必须在 proxy.start() 之前').toBeLessThan(startCallIdx)
    // 同步必须走共用实现,不得在服务端重写一份顺序(第二个真源 = 两处早晚分叉)
    expect(
      src,
      "server/entry.ts 未从 ipc/panelProxyDeps 导入 syncProxyPoolFromStore —— 顺序不得有第二份实现"
    ).toMatch(/import\s*\{[^}]*syncProxyPoolFromStore[^}]*\}\s*from\s*'\.\.\/ipc\/panelProxyDeps'/)

    // **刻意不要求 `EMPTY_POOL`** —— 两端在「空池怎么处置」上是刻意分叉的:
    // 面板前有人看着屏幕,故拒启并回 EMPTY_POOL 让他当场改;服务端自启动发生在
    // 开机时、无人在场,拒启会连带关掉 `onPoolEmpty` 懒加载补池那条自愈路
    // (assembly.ts:701 已接),把「先起服务、后拷 kiro-accounts.json」这个合法首启
    // 场景变成必须人工上面板点启动。
    expect(
      block,
      'server/entry.ts 不应照搬面板的 EMPTY_POOL 拒启(会关掉 onPoolEmpty 自愈路)'
    ).not.toMatch(/EMPTY_POOL/)

    // 取而代之的负条件:**不得打印一条会让人以为一切正常的日志**。
    // 缺陷最贵的部分不是空池本身,而是启动播报里没有池大小 —— 运维在第一个请求
    // 到来之前无法判断池是不是空的,所有指示灯都是绿的。
    expect(
      block,
      '启动播报未使用 poolSize —— 只说"反代已启动"就是那个全绿的假信号'
    ).toMatch(/poolSize/)
    // 三态必须真的分叉:池>0 / 盘上零账号 / 有账号但全不准入。
    // 后两者要求的运维动作相反(去拷数据 vs 去查为什么不准入),合并成一条就等于没区分。
    expect(
      block,
      '未区分「盘上还没有账号」与「有账号但全不准入」—— 两者要求的运维动作相反'
    ).toMatch(/recordCount\s*===\s*0/)
    const warnCount = (block.match(/console\.warn\s*\(/g) ?? []).length
    expect(
      warnCount,
      `空池两态各需一条告警,实际 ${warnCount} 条 —— 少一条就有一态被静默`
    ).toBeGreaterThanOrEqual(2)
  })
})

/**
 * 发现式判据: 出现新的「起反代」位置就红
 *
 * 上面两条 `it` 是**按文件手列**的。而「按文件手列」正是服务端入口当初能溜过去的
 * 原因:闸门只读它列出的那些文件,新写的第四条启动路径不在名单里,于是全绿。
 * 本组不再手列文件,而是扫 `src/main/**` 全量,把「起反代的位置」数出来 ——
 * 数目一变(新增一条启动路径,或删掉一条)就红,红的信息是「去把新路径归类:
 * 要么它必须水合池,要么在此处写明为什么豁免」。
 *
 * 为什么不写成「每个起点都必须水合池」那样的全自动判据:实测全仓有 5 个
 * `server|proxy.start()` 起点,其中桌面托盘开关(`index.ts` onToggleProxy)与
 * `proxy-start` IPC 两处**确实没有**水合 —— 它们靠 `onPoolEmpty`(index.ts:672)
 * 懒加载补池兜底,且都是「屏幕前的人刚点了按钮」的场景。把它们判红会得到一个
 * 长期挂红、随后被人加豁免清单绕过的闸门。故此处只锁**数目 + 归类**:
 * 名单可以有豁免项,但名单不能悄悄过期。
 */
describe('发现式: 起反代的位置数目锁定(新增启动路径必须归类)', () => {
  it('扫描器受控自检：别名、await、可选链与 bracket 调用都能发现，非调用不误报', () => {
    for (const source of [
      'const p = initProxyServer(); p.start()',
      'const p = initProxyServer(); await p.start()',
      'const p = initProxyServer(); p?.start()',
      "const p = initProxyServer(); p['start']()"
    ]) {
      expect(countProxyStartCalls(source), source).toBe(1)
    }

    for (const source of [
      'const p = initProxyServer; p.start()',
      'const p = initProxyServer(); p.start',
      'initProxyServer(); unrelated.start()',
      'const p = initProxyServer(); p.restart()'
    ]) {
      expect(countProxyStartCalls(source), source).toBe(0)
    }
  })

  /** 扫 src/main 下所有 .ts,返回 [相对路径, 命中数] */
  function scanStarters(): Array<[string, number]> {
    const base = resolve(REPO_ROOT, 'src/main')
    const out: Array<[string, number]> = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          const src = stripComments(readFileSync(p, 'utf-8'))
          const hits = countProxyStartCalls(src)
          if (hits > 0) out.push([relative(base, p).replace(/\\/g, '/'), hits])
        }
      }
    }
    walk(base)
    return out.sort((a, b) => a[0].localeCompare(b[0]))
  }

  /**
   * 当前全仓「起反代」位置的完整归类。改动这张表**必须**同时说明新增那条
   * 到底水合不水合池 —— 这就是本闸门存在的全部意义。
   *
   * | 位置 | 是否水合池 | 判据 |
   * |---|---|---|
   * | `index.ts` onToggleProxy(托盘开关) | ❌ 靠 onPoolEmpty 兜底 | 屏幕前的人刚点了按钮 |
   * | `index.ts` 桌面自启动 | ✅ `syncAccountsToPool()` 在 start 之前 | 开机无人在场 |
   * | `index.ts` `proxy-start` IPC | ❌ 靠 onPoolEmpty 兜底 | 渲染进程点的按钮 |
   * | `ipc/panelProxyDeps.ts` proxyStart | ✅ `syncPool` + EMPTY_POOL 拒启 | 面板前有人看着 |
   * | `server/entry.ts` 服务端自启动 | ✅ `syncProxyPoolFromStore` + 三态播报 | 开机无人在场 |
   */
  const EXPECTED: Record<string, number> = {
    'index.ts': 3,
    'ipc/panelProxyDeps.ts': 1,
    'server/entry.ts': 1
  }

  it('起反代的文件与位置数目与归类表一致(不一致 = 有未归类的新启动路径)', () => {
    const found = scanStarters()
    const actual = Object.fromEntries(found)
    expect(
      actual,
      '起反代的位置发生了变化。这不是让你改这张表就完事 —— 先回答新增/变动的那条:\n' +
        '  它在 start() 之前水合池了吗?若没有,它靠什么兜底(onPoolEmpty?),' +
        '且它是「有人在屏幕前」还是「开机无人在场」?\n' +
        '  无人在场的那种**必须**水合(server/entry.ts 当初漏掉它 = 空池启动/指示灯全绿/没有账号可服务),' +
        '然后把结论写进本 describe 的归类表。'
    ).toEqual(EXPECTED)
  })

  it('归类表里标了「水合」的三处,水合调用确实在 start() 之前', () => {
    // 桌面自启动:同步函数调用点必须早于 start()。
    // 这一处的 initProxyServer() 与 start() 相隔近百行(中间是重试逻辑),
    // 任何固定字符窗口的判据都会漏掉它 —— 故按「自启动块」的显式锚点切片。
    const main = stripComments(read('src/main/index.ts'))
    const autoIdx = main.indexOf("store.get('proxyConfig')")
    expect(autoIdx, '桌面自启动块的锚点消失了').toBeGreaterThan(-1)
    const autoBlock = main.slice(autoIdx)
    const syncIdx = autoBlock.indexOf('syncAccountsToPool()')
    const startIdx = autoBlock.indexOf('server.start()')
    expect(syncIdx, '桌面自启动没有同步账号到池').toBeGreaterThan(-1)
    expect(startIdx, '桌面自启动没有调 server.start()').toBeGreaterThan(-1)
    expect(syncIdx, '桌面自启动必须先同步池再 start()').toBeLessThan(startIdx)
    // 另外两处(面板 / 服务端)各由上面两条专门的 it 逐字断言,不在此重复。
  })
})

describe('统一映射: 不得出现第四份 Account→ProxyAccount 映射', () => {
  it('webPanel/ 与 panelProxyDeps 都不自己组装 ProxyAccount 字段', () => {
    for (const rel of [
      'src/main/webPanel/routes.ts',
      'src/main/ipc/panelProxyDeps.ts',
      'src/webPanel/ui/ProxyPanel.tsx'
    ]) {
      const src = stripComments(read(rel))
      // 手抄映射的特征：同时出现 accessToken 与 clientSecret 的字段赋值
      expect(
        src,
        `${rel} 疑似手抄了 Account→ProxyAccount 映射，应调 toProxyAccountShared`
      ).not.toMatch(/accessToken:\s*\w+\.credentials/)
    }
  })

  it('panelProxyDeps 走的是 activation.ts 的统一映射', () => {
    const src = stripComments(read('src/main/ipc/panelProxyDeps.ts'))
    expect(src).toMatch(/buildProxyAccountsFromStore\s*\(/)
    expect(src).toMatch(/activateProxyAccount\s*\(/)
  })
})

/**
 * 池准入判据不得有第二个真源 —— 这一组是「只修了面板路径」的闸门
 *
 * 本轮的实际教训：`activation.ts:186` 的 `status !== 'active'` 只被面板路径
 * (`panelProxyDeps.ts syncPool`) 消费，而用户报的「重启后账号不回池」走的是
 * `index.ts` 里**两份手抄的同一过滤器**（autostart `syncAccountsToPool` /
 * `onPoolEmpty` 惰性补池）。只改 activation.ts 会得到「新测试全绿、缺陷照旧」
 * —— 正是 E-052 的形状。所以判据本身也要有装配实证。
 */
describe('池准入判据: 三条水合路径共用同一真源', () => {
  it('index.ts 的两处水合都走 checkPoolAdmission，而不是自己判 status', () => {
    const src = stripComments(read('src/main/index.ts'))
    // 两处水合（autostart + onPoolEmpty）各一次调用
    const hits = src.match(/checkPoolAdmission\s*\(/g) ?? []
    expect(
      hits.length,
      'index.ts 的水合路径没有全部走 checkPoolAdmission —— 只改 activation.ts 等于只修了面板路径'
    ).toBeGreaterThanOrEqual(2)
    expect(src).toMatch(/import\s*\{[^}]*checkPoolAdmission[^}]*\}\s*from\s*'\.\/proxy\/activation'/)
  })

  it('入池过滤器里不得复活 `status === active` 判据', () => {
    // 作用域限定在**水合入口**：`pool.addAccount` 的喂料链。
    // index.ts:5447 也有一处 `status === 'active' && credentials` —— 那是
    // `get-kiro-available-models` 挑一个号去拉模型列表，不进反代池，不在本闸门管辖内
    // （它挑不到号的后果是"模型列表为空"，不是"号被永久踢出池"）。
    for (const rel of ['src/main/proxy/activation.ts', 'src/main/ipc/panelProxyDeps.ts']) {
      const src = stripComments(read(rel))
      expect(
        src,
        `${rel} 疑似用 status 当池准入闸门 —— status 是显示字段，断网测活会把好号写成 error`
      ).not.toMatch(/status\s*===\s*'active'|status\s*!==\s*'active'/)
    }
    // index.ts 的两条水合路径：过滤器紧邻处不得再出现 status 判据。
    // 锚在 checkPoolAdmission 调用点前后 400 字符的窗口里，避免把全文件其它
    // 无关的 status 用法误判成入池闸门。
    const main = stripComments(read('src/main/index.ts'))
    const re = /checkPoolAdmission\s*\(/g
    let m: RegExpExecArray | null
    let windows = 0
    while ((m = re.exec(main)) !== null) {
      windows++
      const win = main.slice(Math.max(0, m.index - 400), m.index + 400)
      expect(
        win,
        'index.ts 水合路径的过滤器旁边仍有 status 判据 —— 两个真源早晚分叉'
      ).not.toMatch(/status\s*===\s*'active'\s*&&\s*\w+\.credentials/)
    }
    expect(windows, 'index.ts 没有任何 checkPoolAdmission 调用点').toBeGreaterThanOrEqual(2)
  })

  it('被挡在池外的号必须点名进日志（静默缩池是本缺陷最贵的部分）', () => {
    // describeBlockedAccounts 只遍历池内成员，看不见「压根没入池」的号，
    // 所以信号必须落在水合点本身。三条路径各一次。
    const main = stripComments(read('src/main/index.ts'))
    expect(main).toMatch(/logPoolAdmissionSkips\s*\(\s*admissionSkips\s*,\s*'autostart'\s*\)/)
    expect(main).toMatch(/logPoolAdmissionSkips\s*\(\s*admissionSkips\s*,\s*'lazy-refill'\s*\)/)
    const panel = stripComments(read('src/main/ipc/panelProxyDeps.ts'))
    expect(panel).toMatch(/logPoolAdmissionSkips\s*\(/)
  })
})
