/**
 * Cookie 序列化 / 解析（服务端方向 · 手写 · 净新增依赖 0）
 *
 * ⚠️ 仓内既有 cookie 代码是**客户端方向**、不可复用：
 *   - `registration/http-utils.ts:124 saveCookies()` 解析上游 `Set-Cookie` 存进 Map
 *   - `registration/registrar.ts:437 cookieString()` 拼发给上游的 `Cookie` 头
 * 二者都不处理 `HttpOnly` / `SameSite` / `Path` 属性（服务端下发才需要）。
 *
 * 不引 `cookie` npm 包：只发一种 cookie、只读一个 name，
 * 为此给一个 AGPL 桌面应用多加一条供应链不划算。
 */

/** 会话 cookie 名 */
export const SESSION_COOKIE_NAME = 'kam_panel_sid'

/**
 * 面板路由前缀。
 *
 * ⛔ `Path` 必须与实际路由前缀**严格一致**，否则浏览器静默不发送 cookie，
 * 表现为「登录成功但后续请求全 401」—— 最容易误诊成鉴权 bug。
 * 服务/路由包挂载端点时必须复用此常量，不得另写字面量。
 */
export const PANEL_PATH_PREFIX = '/panel'

/**
 * 构造 `Set-Cookie` 头值。
 *
 * @param sid 会话 id（base64url，无需 encodeURIComponent）
 * @param opts.isHttps 走 TLS 时追加 `Secure`（HTTP 下加 `Secure` 会让 cookie 直接失效）
 * @param opts.maxAgeSec cookie 存活秒数，应与会话绝对过期一致
 */
export function buildSessionCookie(
  sid: string,
  opts: { isHttps: boolean; maxAgeSec: number }
): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${sid}`,
    'HttpOnly', // JS 读不到 → XSS 偷不走
    'SameSite=Strict', // 跨站请求不携带 → CSRF 第一道
    `Path=${PANEL_PATH_PREFIX}`,
    `Max-Age=${Math.floor(opts.maxAgeSec)}`
  ]
  if (opts.isHttps) attrs.push('Secure')
  return attrs.join('; ')
}

/**
 * 构造清除会话 cookie 的 `Set-Cookie` 头值（登出用）。
 * 属性必须与下发时一致（尤其 `Path`），否则浏览器不认为是同一个 cookie、不会清除。
 */
export function buildClearedSessionCookie(opts: { isHttps: boolean }): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${PANEL_PATH_PREFIX}`,
    'Max-Age=0'
  ]
  if (opts.isHttps) attrs.push('Secure')
  return attrs.join('; ')
}

/**
 * 从 `Cookie` 请求头里取指定 cookie 值。
 *
 * @param header `req.headers.cookie` 原值（可能是 undefined 或 string[]）
 * @returns 命中的值；未命中 → undefined。空值 cookie（`name=`）视为未命中
 */
export function readCookie(
  header: string | string[] | undefined,
  name: string
): string | undefined {
  if (!header) return undefined
  // Node 正常只给 string，但类型上允许 string[]（重复头）
  const raw = Array.isArray(header) ? header.join('; ') : header
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}
