/**
 * KProxyService 的 dataPath 契约：构造时就必须拿到正确的绝对路径。
 *
 * 为什么盯「构造时」这个时点：dataPath 在构造函数里算完就交给
 * `createCertManager(this.dataPath)`（index.ts:50），CA 证书与私钥都落在这个目录下。
 * 如果改成「先构造、后 setter 注入」，那个窗口里 dataPath 是空串 —— 一旦有人在窗口内
 * 触发 initialize()，CA 就会被写到进程 cwd 而不是用户数据目录，且**不会报错**：
 * 用户下次启动会拿到一张全新 CA（旧的信任全失效），而现场只能看到「证书莫名失效」。
 * 所以契约必须是构造参数，测试也必须断在构造这一刻。
 */
import { describe, it, expect } from 'vitest'
import { join, isAbsolute } from 'node:path'
import { KProxyService, resolveKProxyDataPath } from '../../../src/main/kproxy/index'

const USER_DATA = process.platform === 'win32' ? 'C:\\Users\\t\\AppData\\Roaming\\kam' : '/home/t/.config/kam'

describe('KProxyService: dataPath 构造时契约', () => {
  it('用注入的 userDataPath 拼出 <userData>/kproxy', () => {
    const svc = new KProxyService({}, {}, USER_DATA)
    expect(svc.dataPath).toBe(join(USER_DATA, 'kproxy'))
  })

  it('dataPath 构造后立即可用且是绝对路径（不存在「稍后注入」的空窗）', () => {
    const svc = new KProxyService({}, {}, USER_DATA)
    expect(svc.dataPath).not.toBe('')
    expect(isAbsolute(svc.dataPath)).toBe(true)
  })

  it('缺少 userDataPath → 构造即抛（宁可启动失败，也不要把 CA 写到 cwd）', () => {
    // 静默用 cwd 兜底 = 用户信任的 CA 每次换位置，且没有任何报错
    expect(() => new KProxyService({}, {}, undefined as unknown as string)).toThrow()
    expect(() => new KProxyService({}, {}, '')).toThrow()
  })

  it('相对路径 → 构造即抛（相对路径会随 cwd 漂移，等价于路径写错）', () => {
    expect(() => new KProxyService({}, {}, 'relative/data')).toThrow()
  })

  it('resolveKProxyDataPath 是路径拼法的唯一来源（两端共用同一算法）', () => {
    expect(resolveKProxyDataPath(USER_DATA)).toBe(join(USER_DATA, 'kproxy'))
  })

  it('不同 userDataPath 得到互不干扰的 dataPath（服务端多实例/测试隔离前提）', () => {
    const a = new KProxyService({}, {}, join(USER_DATA, 'a'))
    const b = new KProxyService({}, {}, join(USER_DATA, 'b'))
    expect(a.dataPath).not.toBe(b.dataPath)
  })
})

describe('initKProxyService: 单例工厂同样要求 userDataPath', () => {
  it('工厂把 userDataPath 透传给实例', async () => {
    // 独立 module registry，避免污染其它用例里的单例
    const mod = await import('../../../src/main/kproxy/index')
    const svc = mod.initKProxyService({}, {}, USER_DATA)
    expect(svc.dataPath).toBe(join(USER_DATA, 'kproxy'))
  })
})
