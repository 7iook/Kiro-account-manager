/**
 * 鉴权与请求闸门的安全属性（决策卡 §3 授权模型）。
 *
 * 全部断言**可观测行为**：登录返回值 / 闸门布尔 / cookie 头文本 / 会话是否仍可用，
 * 不断言「有没有调 safeStringEq」这类内部调用（那种测试对错误实现同样会通过）。
 */
import { describe, it, expect } from 'vitest'
import { PanelAuth, generateAdminKey, type AdminKeyStore } from '../../../src/main/webPanel/auth'
import { PanelSessionStore, IDLE_TTL_MS, ABSOLUTE_TTL_MS } from '../../../src/main/webPanel/session'
import { LoginThrottle, MAX_FAILED_ATTEMPTS } from '../../../src/main/webPanel/loginThrottle'
import { SESSION_COOKIE_NAME } from '../../../src/main/webPanel/cookie'

function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

/** 内存版 adminKey 存储（生产由 index.ts 用 electron-store 实现注入） */
function memKeyStore(initial: string | null = null): AdminKeyStore & { value: string | null } {
  const box = {
    value: initial,
    get: (): string | null => box.value,
    set: (k: string): void => void (box.value = k)
  }
  return box
}

/** 从 Set-Cookie 头里取出 sid,再拼成浏览器会发回的 Cookie 请求头 */
function cookieHeaderFrom(setCookie: string): string {
  const sid = /kam_panel_sid=([^;]*)/.exec(setCookie)?.[1] ?? ''
  return `${SESSION_COOKIE_NAME}=${sid}`
}

/** 走完整登录链路,返回浏览器后续请求该带的 Cookie 头 */
function loginAndGetCookie(auth: PanelAuth, key: string, ip = '192.168.1.50'): string {
  const r = auth.login(key, ip)
  expect(r.ok, '前提:登录应成功').toBe(true)
  return cookieHeaderFrom(r.setCookie!)
}

describe('adminKey 生成与存储', () => {
  it('首次启用生成强随机 key,不存在默认密码', () => {
    const store = memKeyStore(null)
    const auth = new PanelAuth(store)
    expect(auth.hasAdminKey()).toBe(false)

    const key = auth.ensureAdminKey()

    expect(store.value).toBe(key)
    expect(auth.hasAdminKey()).toBe(true)
    // 256 bit → base64url 43 字符;且绝不是任何形态的弱默认值
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(['changeme', 'admin', 'password', '123456', '']).not.toContain(key)
  })

  it('已有 key 时 ensureAdminKey 不覆盖', () => {
    const store = memKeyStore('existing-key-value')
    const auth = new PanelAuth(store)
    expect(auth.ensureAdminKey()).toBe('existing-key-value')
    expect(store.value).toBe('existing-key-value')
  })

  it('连续生成的 key 互不相同', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateAdminKey()))
    expect(keys.size).toBe(100)
  })
})

describe('登录', () => {
  it('正确的 adminKey 换到会话 cookie,属性齐全', () => {
    const auth = new PanelAuth(memKeyStore('correct-admin-key'))
    const r = auth.login('correct-admin-key', '192.168.1.10')

    expect(r.ok).toBe(true)
    const c = r.setCookie!
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Path=/panel')
    expect(c).toContain(`Max-Age=${ABSOLUTE_TTL_MS / 1000}`)
    // 非 HTTPS 时不得加 Secure(否则 cookie 在 http 下直接失效)
    expect(c).not.toContain('Secure')
  })

  it('HTTPS 下追加 Secure 属性', () => {
    const auth = new PanelAuth(memKeyStore('k'), { isHttps: () => true })
    expect(auth.login('k', '10.0.0.1').setCookie).toContain('Secure')
  })

  it('错误的 adminKey 被拒且不签发会话', () => {
    const sessions = new PanelSessionStore()
    const auth = new PanelAuth(memKeyStore('correct-admin-key'), { sessions })

    const r = auth.login('wrong-admin-key', '192.168.1.10')

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('INVALID_KEY')
    expect(r.setCookie).toBeUndefined()
    expect(sessions.activeCount, '被拒的登录不得留下任何会话').toBe(0)
  })

  it('前缀正确但不完整的 key 被拒(不做前缀匹配)', () => {
    const auth = new PanelAuth(memKeyStore('correct-admin-key'))
    expect(auth.login('correct-admin-ke', '1.1.1.1').ok).toBe(false)
    expect(auth.login('correct', '1.1.1.2').ok).toBe(false)
    expect(auth.login('correct-admin-key-extra', '1.1.1.3').ok).toBe(false)
  })

  it('缺失 key / 空 key 被拒', () => {
    const auth = new PanelAuth(memKeyStore('correct-admin-key'))
    expect(auth.login(undefined, '1.1.1.1').ok).toBe(false)
    expect(auth.login('', '1.1.1.2').ok).toBe(false)
  })

  it('未配置 adminKey 时任何登录都被拒(空 key 不等于免鉴权)', () => {
    const auth = new PanelAuth(memKeyStore(null))
    const r = auth.login('', '1.1.1.1')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('NO_ADMIN_KEY')
  })
})

describe('请求闸门(会话 + CSRF 单一布尔)', () => {
  const KEY = 'admin-key-for-guard'

  it('有效会话 + 写操作带 X-Panel-Request → 放行', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    const cookie = loginAndGetCookie(auth, KEY)
    const r = auth.guard({ method: 'POST', headers: { cookie, 'x-panel-request': '1' } })
    expect(r.ok).toBe(true)
  })

  it('写操作缺 X-Panel-Request 头 → 拒绝(即便会话完全有效)', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    const cookie = loginAndGetCookie(auth, KEY)

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = auth.guard({ method, headers: { cookie } })
      expect(r.ok, `${method} 缺 CSRF 头必须被拒`).toBe(false)
      expect(r.reason).toBe('CSRF_HEADER_MISSING')
    }
  })

  it('写操作带错误的 X-Panel-Request 值 → 拒绝', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    const cookie = loginAndGetCookie(auth, KEY)
    expect(auth.guard({ method: 'POST', headers: { cookie, 'x-panel-request': '0' } }).ok).toBe(false)
    expect(auth.guard({ method: 'POST', headers: { cookie, 'x-panel-request': 'true' } }).ok).toBe(false)
  })

  it('读操作不要求 CSRF 头(GET 无副作用)', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    const cookie = loginAndGetCookie(auth, KEY)
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(auth.guard({ method, headers: { cookie } }).ok, `${method} 应放行`).toBe(true)
    }
  })

  it('无 cookie → 拒绝(带齐 CSRF 头也不行)', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    const r = auth.guard({ method: 'POST', headers: { 'x-panel-request': '1' } })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('NO_SESSION')
  })

  it('伪造的 sid → 拒绝', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    loginAndGetCookie(auth, KEY)
    const r = auth.guard({
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=forged-session-id`, 'x-panel-request': '1' }
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('SESSION_EXPIRED')
  })

  it('过期会话 → 拒绝(空闲与绝对两种都覆盖)', () => {
    // 空闲过期
    const clockIdle = fakeClock()
    const authIdle = new PanelAuth(memKeyStore(KEY), {
      sessions: new PanelSessionStore({ now: clockIdle.now })
    })
    const cookieIdle = loginAndGetCookie(authIdle, KEY)
    expect(authIdle.guard({ method: 'GET', headers: { cookie: cookieIdle } }).ok).toBe(true)
    clockIdle.advance(IDLE_TTL_MS)
    expect(authIdle.guard({ method: 'GET', headers: { cookie: cookieIdle } }).ok).toBe(false)

    // 绝对过期(期间保持活跃)
    const clockAbs = fakeClock()
    const authAbs = new PanelAuth(memKeyStore(KEY), {
      sessions: new PanelSessionStore({ now: clockAbs.now })
    })
    const cookieAbs = loginAndGetCookie(authAbs, KEY)
    for (let h = 0; h < 23; h++) {
      clockAbs.advance(60 * 60 * 1000)
      expect(authAbs.guard({ method: 'GET', headers: { cookie: cookieAbs } }).ok).toBe(true)
    }
    clockAbs.advance(60 * 60 * 1000)
    expect(authAbs.guard({ method: 'GET', headers: { cookie: cookieAbs } }).ok).toBe(false)
  })

  it('闸门无法只过一半:两个条件各自失效都导致同一个布尔为 false', () => {
    const auth = new PanelAuth(memKeyStore(KEY))
    const cookie = loginAndGetCookie(auth, KEY)
    // 仅会话有效(缺 CSRF) / 仅 CSRF 有效(无会话) → 都必须 false
    expect(auth.guard({ method: 'POST', headers: { cookie } }).ok).toBe(false)
    expect(auth.guard({ method: 'POST', headers: { 'x-panel-request': '1' } }).ok).toBe(false)
    // 两者齐备才 true
    expect(auth.guard({ method: 'POST', headers: { cookie, 'x-panel-request': '1' } }).ok).toBe(true)
  })
})

describe('adminKey 轮换', () => {
  it('轮换后所有既存会话立即失效', () => {
    const store = memKeyStore('old-admin-key')
    const auth = new PanelAuth(store)

    // 两个不同客户端都已登录
    const cookieA = loginAndGetCookie(auth, 'old-admin-key', '192.168.1.10')
    const cookieB = loginAndGetCookie(auth, 'old-admin-key', '192.168.1.11')
    expect(auth.guard({ method: 'GET', headers: { cookie: cookieA } }).ok).toBe(true)
    expect(auth.guard({ method: 'GET', headers: { cookie: cookieB } }).ok).toBe(true)

    const newKey = auth.rotateAdminKey()

    // 可观测结果:两个会话都不再放行
    expect(auth.guard({ method: 'GET', headers: { cookie: cookieA } }).ok).toBe(false)
    expect(auth.guard({ method: 'GET', headers: { cookie: cookieB } }).ok).toBe(false)
    expect(auth.sessionStore.activeCount).toBe(0)

    // 旧 key 不再能登录,新 key 可以
    expect(auth.login('old-admin-key', '192.168.1.12').ok).toBe(false)
    expect(auth.login(newKey, '192.168.1.13').ok).toBe(true)
    expect(store.value).toBe(newKey)
    expect(newKey).not.toBe('old-admin-key')
  })
})

describe('登出', () => {
  it('服务端销毁会话,同一 cookie 不再可用', () => {
    const auth = new PanelAuth(memKeyStore('k'))
    const cookie = loginAndGetCookie(auth, 'k')
    expect(auth.guard({ method: 'GET', headers: { cookie } }).ok).toBe(true)

    const out = auth.logout({ method: 'POST', headers: { cookie } })

    expect(out.destroyed).toBe(true)
    expect(auth.guard({ method: 'GET', headers: { cookie } }).ok, '登出后同一 sid 必须失效').toBe(false)
    expect(auth.sessionStore.activeCount).toBe(0)
    // 清除 cookie 的属性必须与下发时一致,否则浏览器不清除
    expect(out.setCookie).toContain('Path=/panel')
    expect(out.setCookie).toContain('Max-Age=0')
  })

  it('登出只影响自己的会话', () => {
    const auth = new PanelAuth(memKeyStore('k'))
    const a = loginAndGetCookie(auth, 'k', '10.0.0.1')
    const b = loginAndGetCookie(auth, 'k', '10.0.0.2')
    auth.logout({ method: 'POST', headers: { cookie: a } })
    expect(auth.guard({ method: 'GET', headers: { cookie: b } }).ok).toBe(true)
  })
})

describe('登录限流(按 IP)', () => {
  const KEY = 'throttle-test-key'

  it('同一 IP 连续失败达阈值后被限流,正确 key 也进不来', () => {
    const clock = fakeClock()
    const auth = new PanelAuth(memKeyStore(KEY), {
      throttle: new LoginThrottle({ now: clock.now })
    })
    const ip = '192.168.1.99'

    // 前 N-1 次:返回 INVALID_KEY(尚未锁定)
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      const r = auth.login('wrong', ip)
      expect(r.ok).toBe(false)
      expect(r.reason, `第 ${i} 次失败应是 INVALID_KEY`).toBe('INVALID_KEY')
    }

    // 第 N 次失败触发锁定
    const nth = auth.login('wrong', ip)
    expect(nth.ok).toBe(false)
    expect(nth.reason).toBe('RATE_LIMITED')
    expect(nth.retryAfterMs).toBeGreaterThan(0)

    // 锁定期内即便 key 正确也拒(这才是真限流,否则暴破者可继续试)
    const correct = auth.login(KEY, ip)
    expect(correct.ok, '锁定期内正确 key 也必须被拒').toBe(false)
    expect(correct.reason).toBe('RATE_LIMITED')
  })

  it('限流按 IP 隔离,不牵连其它客户端', () => {
    const auth = new PanelAuth(memKeyStore(KEY), { throttle: new LoginThrottle() })
    const attacker = '10.0.0.66'
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) auth.login('wrong', attacker)
    expect(auth.login(KEY, attacker).reason).toBe('RATE_LIMITED')
    // 另一台机器不受影响
    expect(auth.login(KEY, '10.0.0.67').ok).toBe(true)
  })

  it('锁定到期后恢复,正确 key 可登录', () => {
    const clock = fakeClock()
    const auth = new PanelAuth(memKeyStore(KEY), {
      throttle: new LoginThrottle({ now: clock.now })
    })
    const ip = '192.168.1.77'
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) auth.login('wrong', ip)
    const blocked = auth.login(KEY, ip)
    expect(blocked.reason).toBe('RATE_LIMITED')

    clock.advance(blocked.retryAfterMs! + 1)

    expect(auth.login(KEY, ip).ok, '锁定到期后应恢复').toBe(true)
  })

  it('成功登录清零失败计数,合法用户不被自己的历史失败拖累', () => {
    const auth = new PanelAuth(memKeyStore(KEY), { throttle: new LoginThrottle() })
    const ip = '192.168.1.88'
    // 输错几次但未达阈值
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) auth.login('typo', ip)
    expect(auth.login(KEY, ip).ok).toBe(true)
    // 清零后又能重新容错 N-1 次而不锁定
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      expect(auth.login('typo', ip).reason).toBe('INVALID_KEY')
    }
  })

  it('反复触发锁定时退避时长指数增长', () => {
    const clock = fakeClock()
    const auth = new PanelAuth(memKeyStore(KEY), {
      throttle: new LoginThrottle({ now: clock.now })
    })
    const ip = '10.1.1.1'
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) auth.login('wrong', ip)
    const first = auth.login('wrong', ip).retryAfterMs!

    clock.advance(first + 1)
    const second = auth.login('wrong', ip).retryAfterMs!

    expect(second, `第二轮锁定(${second}ms)应长于第一轮(${first}ms)`).toBeGreaterThan(first)
  })
})
