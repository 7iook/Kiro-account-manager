/**
 * 运行时证明：electron **真的缺席**时，`upstreamApi` 仍能加载并真的发出请求。
 *
 * 这是本次抽取存在的**唯一理由**的直接验证 —— 四个函数原先困在
 * `src/main/index.ts`（一个 `import { app } from 'electron'` 的文件）里，
 * 于是服务端形态（`node out/server/index.js`，纯 node、`--omit=dev` 后 electron
 * 压根不存在）拿不到它们。「新模块编译通过」不能证明这一点。
 *
 * 手法与 `test/main/kernelWithoutElectron.runtime.test.ts` 一致：用抛异常的
 * `vi.mock('electron')` 让 electron 解析**本身**失败。为什么不能「在 node 下
 * import 一下就算过」—— 本仓 `node_modules/electron/index.js` 在纯 node 下导出的是
 * **字符串**（可执行文件路径），所以 `import { app } from 'electron'` 根本不抛，
 * 只是 `app === undefined`，直到第一次 `app.getPath()` 才炸。那样的测试在有缺陷的
 * 代码上也是绿的。
 *
 * ## 为什么这个文件现在不可或缺
 *
 * `kernel_without_electron.test.ts` 的模块图闸门是从内核入口算**传递闭包**的，
 * 而今天还没有任何内核入口 import `upstreamApi`（接线是工作包 C / F）。
 * 也就是说：新模块此刻**不在那道闸门的覆盖面内**，图级闸门对它照绿 ——
 * 与那个文件头部批评的「够不到所以照绿」同形。接线落地后它会被闭包自动纳管；
 * 在那之前，这个运行时用例是唯一真正验证过「服务端能加载它」的东西。
 */
import { describe, it, expect, vi } from 'vitest'

// 模拟 electron 完全不可解析（Linux 服务器形态）。工厂内不引用任何顶层变量。
vi.mock('electron', () => {
  throw new Error('ELECTRON_NOT_AVAILABLE_ON_SERVER')
})

// 出网必须拦住，且**不能**依赖「这台机器有没有系统代理」：
// 本机实测有(7897) → `getNetworkAgent()` 返回真 agent → 请求走 undici 真出网 → 失败。
// 故这里 mock undici 的 fetch（`getNetworkAgent` 返回 agent 时的那条通道）。
// `proxy/systemProxy` 刻意**保持真实** —— 下面「传递闭包可加载」那条要验的正是它
// 在 electron 缺席时能不能加载，mock 掉就白验了。
const undiciFetchMock = vi.fn()
vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  Agent: class {},
  ProxyAgent: class {}
}))

describe('runtime: electron 缺席时上游 API 仍可加载并可用', () => {
  it('自检：本用例的 mock 真的让 electron 不可解析（否则下面的断言无意义）', async () => {
    await expect(import('electron')).rejects.toThrow()
  })

  it('upstreamApi 可加载，工厂可调用', async () => {
    const m = await import('../../../src/main/upstreamApi')
    expect(typeof m.createUpstreamApi).toBe('function')

    const api = m.createUpstreamApi({
      useKProxy: () => false,
      getKProxyService: () => null,
      getUsageApiType: () => 'rest',
      getDeviceIdForUa: () => undefined
    })
    // 四个缝位方法都在
    expect(typeof api.refreshTokenByMethod).toBe('function')
    expect(typeof api.getUsageAndLimits).toBe('function')
    expect(typeof api.getUserInfo).toBe('function')
    expect(typeof api.ssoDeviceAuth).toBe('function')
  })

  it('传递闭包全部可加载（kiroAuthSync / proxy.kiroApi / oidcRefresh / systemProxy）', async () => {
    // 逐个点名，让「哪一个把 electron 拖进来了」在失败时可直接读出，
    // 而不是只看到一句「upstreamApi 加载失败」。
    await expect(import('../../../src/main/upstreamApi/transport')).resolves.toBeTruthy()
    await expect(import('../../../src/main/upstreamApi/refresh')).resolves.toBeTruthy()
    await expect(import('../../../src/main/upstreamApi/sso')).resolves.toBeTruthy()
    await expect(import('../../../src/main/upstreamApi/usage')).resolves.toBeTruthy()
    await expect(import('../../../src/main/kiroAuthSync')).resolves.toBeTruthy()
    await expect(import('../../../src/main/proxy/kiroApi')).resolves.toBeTruthy()
    await expect(import('../../../src/main/oidcRefresh')).resolves.toBeTruthy()
    await expect(import('../../../src/main/proxy/systemProxy')).resolves.toBeTruthy()
  })

  it('真的能发出一次请求并解析响应（不只是「import 了不抛」）', async () => {
    // 加载成功 ≠ 调用成功：函数体里若有任何 electron 依赖，要到执行时才炸。
    // 故这里真跑一次 refresh，断言它拿到了归一后的结果。
    const { createUpstreamApi } = await import('../../../src/main/upstreamApi')
    const api = createUpstreamApi({
      useKProxy: () => false,
      getKProxyService: () => null,
      getUsageApiType: () => 'rest',
      getDeviceIdForUa: () => 'e'.repeat(64)
    })

    // 两条通道都指向同一个假响应：有系统代理时走 undici(带 dispatcher)，
    // 没有时走全局 fetch。于是这条用例在**任何**机器上判据一致。
    const realFetch = globalThis.fetch
    const fakeResponse = {
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'srv-at', refreshToken: 'srv-rt', expiresIn: 3600 }),
      text: async () => ''
    }
    undiciFetchMock.mockReset()
    undiciFetchMock.mockResolvedValue(fakeResponse)
    globalThis.fetch = vi.fn(async () => fakeResponse) as unknown as typeof fetch

    try {
      const r = await api.refreshTokenByMethod('rt', 'cid', '', 'us-east-1', 'social')
      expect(r.success).toBe(true)
      expect(r.accessToken).toBe('srv-at')

      // UA 里带上了注入的设备 ID —— 说明整条 header 构造路径也真跑过了。
      // 取实际被用到的那条通道的入参，而不是假设是哪一条。
      const call =
        undiciFetchMock.mock.calls[0] ??
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(call, '两条出网通道都没被调用 —— 请求根本没发出去').toBeTruthy()
      const init = call[1] as { headers: Record<string, string> }
      expect(init.headers['User-Agent']).toContain('e'.repeat(64))
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
