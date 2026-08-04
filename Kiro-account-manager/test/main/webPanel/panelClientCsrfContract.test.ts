/**
 * 客户端 CSRF 头 × 服务端闸门的**跨层契约**测试。
 *
 * ## 为什么这个测试必须存在，且必须用真的 PanelAuth
 *
 * 浏览器侧 `webPanel/api/client.ts` 发 `X-Panel-Request: 1`，服务端
 * `main/webPanel/auth.ts:guard()` 检查同名头。这是**同一个契约的两处消费点**，
 * 但两边各写一份字面量 —— 任一侧改动，另一侧不会有任何编译期报错，
 * 表现是「所有写操作静默 401」，而 401 与「会话过期」在服务端是同一个响应，
 * 极难定位到真因是头名不匹配。
 *
 * UI 层的测试（`test/renderer/web-panel-ui/panelApp.test.tsx`）只能断言
 * 「客户端确实发了这个头」，它 mock 掉了服务端，**证明不了服务端认这个头**。
 * 所以这里把客户端导出的常量喂给真实的 `guard()`，让两边真的握一次手。
 */
import { describe, it, expect } from 'vitest'
import { PanelAuth } from '../../../src/main/webPanel/auth'
import { SESSION_COOKIE_NAME } from '../../../src/main/webPanel/cookie'
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../../src/webPanel/api/client'

/** 建一个有效会话，返回其 sid —— guard 的另一半前置条件 */
function authWithSession(): { auth: PanelAuth; cookie: string } {
  let stored: string | null = null
  const auth = new PanelAuth({
    get: () => stored,
    set: (k) => {
      stored = k
    }
  })
  const adminKey = auth.ensureAdminKey()
  const result = auth.login(adminKey, '127.0.0.1')
  expect(result.ok, '前置条件失败：登录未成功').toBe(true)
  // 从 Set-Cookie 里取出 sid，拼成请求侧的 Cookie 头
  const sid = /kam_panel_sid=([^;]+)/.exec(result.setCookie ?? '')?.[1]
  expect(sid, '前置条件失败：Set-Cookie 里没有 sid').toBeTruthy()
  return { auth, cookie: `${SESSION_COOKIE_NAME}=${sid}` }
}

describe('客户端 CSRF 头与服务端闸门的契约', () => {
  it('客户端常量拼出的写请求能通过真实 guard()', () => {
    const { auth, cookie } = authWithSession()
    // 完全按 client.ts 的方式构造头（键名小写化由 Node 的 headers 语义负责）
    const guard = auth.guard({
      method: 'POST',
      headers: { cookie, [CSRF_HEADER.toLowerCase()]: CSRF_HEADER_VALUE }
    })
    expect(guard.ok, `写请求被拒（${guard.reason}）—— 客户端头名/值与服务端判据已漂移`).toBe(true)
  })

  it('去掉该头，同一个写请求被拒 —— 证明这个头真的是必需的', () => {
    // 这条是上一条的对照：若删了头仍然通过，上一条就什么都没证明。
    const { auth, cookie } = authWithSession()
    const guard = auth.guard({ method: 'POST', headers: { cookie } })
    expect(guard.ok).toBe(false)
    expect(guard.reason).toBe('CSRF_HEADER_MISSING')
  })

  it('读请求不带该头也能通过（客户端据此只给写操作加头）', () => {
    const { auth, cookie } = authWithSession()
    expect(auth.guard({ method: 'GET', headers: { cookie } }).ok).toBe(true)
  })

  it('无会话时写请求被拒，且原因不是 CSRF（客户端不该把它当缺头处理）', () => {
    const { auth } = authWithSession()
    const guard = auth.guard({
      method: 'POST',
      headers: { [CSRF_HEADER.toLowerCase()]: CSRF_HEADER_VALUE }
    })
    expect(guard.ok).toBe(false)
    expect(guard.reason).toBe('NO_SESSION')
  })
})
