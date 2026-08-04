/**
 * Cookie 序列化 / 解析。
 *
 * 重点覆盖 `Path=/panel` 与路由前缀的一致性 —— 二者不一致时浏览器
 * **静默不发送** cookie,表现为「登录成功但后续全 401」,极易误诊成鉴权 bug。
 */
import { describe, it, expect } from 'vitest'
import {
  buildSessionCookie,
  buildClearedSessionCookie,
  readCookie,
  SESSION_COOKIE_NAME,
  PANEL_PATH_PREFIX
} from '../../../src/main/webPanel/cookie'

describe('Set-Cookie 构造', () => {
  it('包含全部安全属性', () => {
    const c = buildSessionCookie('abc123', { isHttps: false, maxAgeSec: 86400 })
    expect(c.startsWith(`${SESSION_COOKIE_NAME}=abc123;`)).toBe(true)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain(`Path=${PANEL_PATH_PREFIX}`)
    expect(c).toContain('Max-Age=86400')
  })

  it('Path 与面板路由前缀严格一致', () => {
    // 前缀常量必须是 /panel;若谁改了它,路由挂载点也必须同步改
    expect(PANEL_PATH_PREFIX).toBe('/panel')
    expect(buildSessionCookie('s', { isHttps: false, maxAgeSec: 1 })).toContain('Path=/panel')
    // 不得写成带尾斜杠(/panel/ 不覆盖 /panel 本身)
    expect(PANEL_PATH_PREFIX.endsWith('/')).toBe(false)
  })

  it('Secure 仅在 HTTPS 下出现', () => {
    expect(buildSessionCookie('s', { isHttps: true, maxAgeSec: 1 })).toContain('Secure')
    expect(buildSessionCookie('s', { isHttps: false, maxAgeSec: 1 })).not.toContain('Secure')
  })

  it('Max-Age 取整,不产生小数', () => {
    expect(buildSessionCookie('s', { isHttps: false, maxAgeSec: 86400.7 })).toContain('Max-Age=86400')
  })

  it('清除用 cookie 属性与下发时一致且 Max-Age=0', () => {
    const c = buildClearedSessionCookie({ isHttps: false })
    expect(c).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Path=/panel')
    expect(c).toContain('Max-Age=0')
  })
})

describe('Cookie 请求头解析', () => {
  it('从多个 cookie 中取出目标值', () => {
    const h = `theme=dark; ${SESSION_COOKIE_NAME}=sid-value-here; lang=zh`
    expect(readCookie(h, SESSION_COOKIE_NAME)).toBe('sid-value-here')
  })

  it('容忍空格与顺序', () => {
    expect(readCookie(`  ${SESSION_COOKIE_NAME} = padded  `, SESSION_COOKIE_NAME)).toBe('padded')
    expect(readCookie(`${SESSION_COOKIE_NAME}=first`, SESSION_COOKIE_NAME)).toBe('first')
  })

  it('缺失 / 空值 / 空头一律 undefined', () => {
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeUndefined()
    expect(readCookie('', SESSION_COOKIE_NAME)).toBeUndefined()
    expect(readCookie('other=1', SESSION_COOKIE_NAME)).toBeUndefined()
    // 已被清除的 cookie(空值)必须视为未命中,不能返回空串让下游当成有效 sid
    expect(readCookie(`${SESSION_COOKIE_NAME}=`, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('不把名字前缀相同的 cookie 误当成目标', () => {
    const h = `${SESSION_COOKIE_NAME}_other=decoy; x=1`
    expect(readCookie(h, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it('base64url 值不被截断(含 - 与 _)', () => {
    const sid = 'aB3-_xY9zQ1w2E4r5T6y7U8i9O0pAsDfGhJkLzXcVbN'
    expect(readCookie(`${SESSION_COOKIE_NAME}=${sid}`, SESSION_COOKIE_NAME)).toBe(sid)
  })

  it('重复 Cookie 头(数组形态)也能解析', () => {
    expect(readCookie(['a=1', `${SESSION_COOKIE_NAME}=v`], SESSION_COOKIE_NAME)).toBe('v')
  })
})
