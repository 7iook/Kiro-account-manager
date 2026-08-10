/**
 * ProxyServer 的 userDataPath 注入契约（服务器化 K-2）。
 *
 * ## 缺陷形态：三处 `require('electron')` 藏在方法体里
 *
 * 修复前 `proxyServer.ts` 有三处 **函数体内** 的 `const { app } = require('electron')`
 * （`getTlsOptions` / `getSelfSignedCertInfo` / `regenerateSelfSignedCert`），
 * 全部用于给 `ensureProxySelfSignedCert(app.getPath('userData'), ...)` 喂自签证书落盘目录。
 * 叶子函数本来就收路径参数（`selfSignedCert.ts` 的 `@param dataPath`），
 * 唯一的 electron 耦合就在这三个调用方。
 *
 * ## 为什么 K-1 的图闸门当时没红（实测，不是推测）
 *
 * 复跑 `kernel_without_electron.test.ts` 的走图器：四个内核入口的传递闭包 = 30 个文件，
 * `proxy/proxyServer.ts` **不在其中**（它的两个 value 消费者是 `proxy/index.ts` 与
 * `src/main/index.ts`，都不在闭包里；`ipc/panelProxyDeps.ts` 只 `import type`）。
 * 把它加为第 5 个入口后闭包变 40 个文件，违规恰好 1 条 —— 就是它自己。
 * 也就是说闸门的 CJS 形态判定本来就能抓到这三行，只是它当时够不到这个文件。
 * 故本轮修完把 `proxyServer.ts` 加进 `KERNEL_ENTRY_POINTS`，让闸门永久覆盖它，
 * 而不是在这里另写一个平行的源码扫描闸门（两个判定器日后必然漂移）。
 *
 * ## 为什么断言只能落在「行为 + 源码」，不能落在「import 一下不抛」
 *
 * 两个实测事实（K-1 提交信息已记录，本轮复核仍成立）：
 * electron 是 devDependency，开发机上 `require('electron')` **成功**并返回字符串
 * （electron.exe 路径），于是 `app` 静默变 `undefined`，直到 `app.getPath()` 才炸。
 * 所以「加载不抛就算过」的测试在缺陷存在时也是绿的。这里改为：让 electron **不可解析**
 * （抛异常的 mock，与 Linux 服务器上模块压根不存在同形），再断言三条真实路径仍能拿到证书。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, isAbsolute } from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')

/** 让 electron 完全不可解析：服务器形态。工厂内不引用任何顶层变量。 */
vi.mock('electron', () => {
  throw new Error('ELECTRON_NOT_AVAILABLE_ON_SERVER')
})

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kam-k2-proxytls-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('自检：本用例的前提真的成立', () => {
  it('electron 在本文件里不可解析（否则下面所有断言都无意义）', async () => {
    await expect(import('electron')).rejects.toThrow()
  })
})

describe('ProxyServer: userDataPath 注入契约', () => {
  it('electron 缺席时 proxyServer 模块仍可加载', async () => {
    const m = await import('../../../src/main/proxy/proxyServer')
    expect(typeof m.ProxyServer).toBe('function')
  })

  it('注入 userDataPath 后，getSelfSignedCertInfo 在无 electron 下返回真实证书', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    const server = new ProxyServer({ host: '127.0.0.1' }, {}, dataDir)

    const info = server.getSelfSignedCertInfo()

    // 不是「不抛就算过」：必须真的产出证书，并真的落在注入的目录下
    expect(info).not.toBeNull()
    expect(info!.cert).toContain('BEGIN CERTIFICATE')
    expect(info!.key).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(existsSync(join(dataDir, 'proxy-tls', 'proxy.crt'))).toBe(true)
    expect(existsSync(join(dataDir, 'proxy-tls', 'proxy.key'))).toBe(true)
  })

  it('证书落在注入目录，而不是进程 cwd（防静默兜底到 cwd）', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    const server = new ProxyServer({ host: '127.0.0.1' }, {}, dataDir)

    server.getSelfSignedCertInfo()

    // cwd 下不得凭空长出 proxy-tls —— 那正是「路径为空时静默用 cwd」的现场
    expect(existsSync(join(process.cwd(), 'proxy-tls'))).toBe(false)
  })

  it('regenerateSelfSignedCert 在无 electron 下换出一张新证书（指纹变化）', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    const server = new ProxyServer({ host: '127.0.0.1' }, {}, dataDir)

    const first = server.getSelfSignedCertInfo()
    expect(first).not.toBeNull()

    const regenerated = server.regenerateSelfSignedCert()
    expect(regenerated).not.toBeNull()
    // 断真实副作用:强制重生成必须真的换掉指纹,而不是把旧的再读一遍
    expect(regenerated!.fingerprint).not.toBe(first!.fingerprint)
  })

  it('TLS 自动生成路径（getTlsOptions）在无 electron 下也能起 HTTPS', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    // tls.enabled 且不给 cert/key → 走自动生成分支,即修复前第三处 require('electron')
    const server = new ProxyServer(
      { host: '127.0.0.1', port: 0, tls: { enabled: true } } as never,
      {},
      dataDir
    )

    await server.start()
    try {
      expect(server.isRunning()).toBe(true)
      // 证书真的由注入路径产出
      expect(existsSync(join(dataDir, 'proxy-tls', 'proxy.crt'))).toBe(true)
    } finally {
      await server.stop(0)
    }
  })

  it('未注入 userDataPath → 三条证书路径明确失败，绝不静默写到 cwd', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    // 装配层漏接线的形态。宁可显式失败,也不要把用户信赖的证书写到随机目录:
    // 静默兜底会让证书每次换位置且无任何报错,现场只能看到「证书莫名失效」。
    const server = new ProxyServer({ host: '127.0.0.1' }, {})

    expect(server.getSelfSignedCertInfo()).toBeNull()
    expect(server.regenerateSelfSignedCert()).toBeNull()
    expect(existsSync(join(process.cwd(), 'proxy-tls'))).toBe(false)
  })

  it('相对路径 → 构造即抛（相对路径随 cwd 漂移，等价于路径写错）', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    expect(() => new ProxyServer({}, {}, 'relative/data')).toThrow()
  })

  it('注入路径不进 getConfig()（它会被持久化并跨 IPC，机器路径不该混进去）', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    const server = new ProxyServer({ host: '127.0.0.1' }, {}, dataDir)

    // src/main/index.ts 有 6 处 `store.set('proxyConfig', server.getConfig())`,
    // 且启动时把它读回来喂构造函数。若把机器绝对路径塞进 config,备份/换机/换安装位置
    // 都会把一个**陈旧的外部路径**恢复回来并当成证书目录用。
    expect(JSON.stringify(server.getConfig())).not.toContain(dataDir)
  })

  it('多实例各用自己的注入路径（不共享进程级单例）', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    const other = mkdtempSync(join(tmpdir(), 'kam-k2-proxytls-b-'))
    try {
      const a = new ProxyServer({ host: '127.0.0.1' }, {}, dataDir)
      const b = new ProxyServer({ host: '127.0.0.1' }, {}, other)

      a.getSelfSignedCertInfo()
      b.getSelfSignedCertInfo()

      // 模块级注入(logger.ts 那种形态)在这里是错的:39 个测试构造点 + 未来服务端多实例
      // 会共享同一个路径,互相覆盖证书。故必须是 per-instance。
      expect(existsSync(join(dataDir, 'proxy-tls', 'proxy.crt'))).toBe(true)
      expect(existsSync(join(other, 'proxy-tls', 'proxy.crt'))).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('源码级：三处 electron 耦合真的被删掉了', () => {
  // 运行时断言看不见「未使用的 import」(会被 esbuild 擦掉),也看不见走不到的分支。
  // 故这里补一条源码断言 —— 与图闸门同源的判定思路。
  const src = readFileSync(join(REPO_ROOT, 'src/main/proxy/proxyServer.ts'), 'utf-8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('proxyServer.ts 可执行代码里没有任何 electron 引用', () => {
    expect(code).not.toMatch(/\brequire\s*\(\s*['"]electron['"]\s*\)/)
    expect(code).not.toMatch(/\bfrom\s*['"]electron['"]/)
    expect(code).not.toMatch(/\bimport\s*\(\s*['"]electron['"]\s*\)/)
  })

  it('proxyServer.ts 里不再出现 app.getPath(', () => {
    expect(code).not.toMatch(/app\s*\.\s*getPath\s*\(/)
  })
})

describe('装配层真的接线了（防「解耦了但桌面端证书没了」/ E-052）', () => {
  it('src/main/index.ts 构造 ProxyServer 时传入了 userData 目录', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/main/index.ts'), 'utf-8')
    const open = src.indexOf('new ProxyServer(')
    expect(open, '找不到 ProxyServer 构造点 —— 断言锚点失效').toBeGreaterThan(-1)

    // 只断言「文件里某处有 app.getPath」是不够的：index.ts 里到处都是 app.getPath，
    // 必须落在**这个构造调用的实参**里。故按括号配平取出调用的真实范围
    // （该调用含大段内联回调，跨 170+ 行，任何固定窗口都是错的）。
    const from = src.indexOf('(', open)
    let depth = 0
    let end = -1
    for (let i = from; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end, '括号未配平 —— 取不到构造调用范围').toBeGreaterThan(from)

    const callArgs = src.slice(from, end)
    expect(callArgs).toMatch(/getPath\(\s*['"]userData['"]\s*\)/)
  })

  it('注入的是绝对路径这一约束在契约里（构造校验存在）', async () => {
    const { ProxyServer } = await import('../../../src/main/proxy/proxyServer')
    expect(() => new ProxyServer({}, {}, 'not/absolute')).toThrow()
    // 反向控制:合法绝对路径不得被误拒
    expect(isAbsolute(dataDir)).toBe(true)
    expect(() => new ProxyServer({}, {}, dataDir)).not.toThrow()
  })
})
