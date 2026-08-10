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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

/** 去掉行注释与块注释，避免「注释里提到了」被当成真实调用 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
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
    const syncIdx = block.indexOf('syncPool(')
    const startCallIdx = block.indexOf('server.start()')
    expect(syncIdx, '启动路径没有同步池 —— 会用空池启动').toBeGreaterThan(-1)
    expect(startCallIdx, '启动路径没有真的调 start()').toBeGreaterThan(-1)
    expect(syncIdx, '同步池必须在 start() 之前').toBeLessThan(startCallIdx)
    // 空池必须拒绝启动，而不是启动成功后每个请求都失败
    expect(block).toMatch(/EMPTY_POOL/)
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
