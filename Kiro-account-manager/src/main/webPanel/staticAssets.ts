/**
 * webPanel 静态资源托管 —— 把 `out/webPanel/` 的构建产物发给局域网浏览器
 *
 * 「资源在哪」由 `utils/webPanelAssetRoot.ts` 独家回答(SSOT),本文件只负责
 * 「怎么安全地把它发出去」。两件事分开,是因为构建路径改动只应触达前者。
 *
 * ## 为什么路径解析是本文件最承重的部分
 *
 * 面板会绑到 `0.0.0.0` 供手机访问,这一层等于把一个文件读取接口挂上局域网。
 * 路径穿越是这类服务的头号洞:`/panel/../../../etc/passwd`。而**幼稚实现的失败
 * 方式极其安静** —— 它照样返回 200,只是内容变成了别人的私钥。
 *
 * 所以判定收在一个纯函数 `resolveAssetPath()` 上(可穷举测试、无 IO),
 * 且采用**白名单式的 fail-closed**:不是「挡掉已知坏形态」,而是
 * 「只放行形状明确合法的相对路径」。理由:黑名单必然被新编码绕过
 * (`..%2f` / `%252e` / `..\` / ADS 各是一次绕过史),而 Vite 产物的文件名
 * 形态极窄 —— 不含 `%`、`:`、`\`、NUL,拒绝它们零业务代价。
 *
 * ### 解码只做一次,且在校验之前
 *
 * 顺序错一次就全线失守:先查 `..` 再 decode,`%2e%2e%2f` 直接穿过。
 * 解码两次同样是洞(`%252e%252e%252f` → `%2e%2e%2f` → `../`),所以**只解一次**,
 * 并拒绝解码后仍含 `%` 的结果 —— 合法产物文件名里不会有裸百分号。
 *
 * ### 最终判据是 resolve 后的包含关系,不是字符串黑名单
 *
 * 段级 `..` 检查是第一道,但权威判据是 `resolve()` 之后
 * 「结果是否仍在 root 之内」—— 那是唯一不依赖「我想全了所有坏形态」的判据。
 *
 * ## 鉴权决策:静态资源**不过**会话闸门(有意为之,见 serveStaticAsset 注释)
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type http from 'node:http'
import { sendAsset, sendError } from './respond'
import { WEB_PANEL_ENTRY_HTML, type WebPanelAssets } from '../utils/webPanelAssetRoot'

/**
 * 路径解析结果。失败原因分两类是为了让上层给出不同状态码:
 * 畸形输入 = 客户端错(400),逃逸 = 拒绝(404,**不回 403** —— 403 等于确认
 * 「这条路径存在但你不能看」,给探测者多余信息;404 什么都不透露)。
 */
export type AssetResolution =
  | { ok: true; absPath: string; relPath: string }
  | { ok: false; reason: 'MALFORMED' | 'ESCAPE' }

/**
 * 解码后仍不允许出现的字符。逐个都有理由,不是凑数:
 *   - `%`  二次编码的残迹(`%252e` → `%2e`);合法产物名不含裸百分号
 *   - `\`  win32 下 path 把它当分隔符 → `..\..\` 是等价穿越
 *   - `:`  盘符(`C:\`)与 Windows ADS(`file.js::$DATA`,可绕扩展名白名单读原文)
 */
const FORBIDDEN_CHARS = /[%\\:]/

/**
 * NUL 单独判(不进上面的正则)。
 *
 * 不是为了让 lint 闭嘴 —— `no-control-regex` 的提醒是对的:控制字符写进正则
 * 字面量既难读也容易被后人误删。而这里要表达的其实是一个更简单的命题:
 * **文件名里永远不该有 NUL**(旧 fs 层的截断攻击面)。用显式 includes 表达它,
 * 比藏在字符类里的 `\u0000` 清楚得多。
 */
const NUL = '\u0000'

/** Vite 内容哈希产物的文件名形态(`index-C_sieKU2.js`)—— 决定能否 immutable 缓存 */
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i

/** 构建产物目录名(Vite 的 `assets/`)—— 该前缀下一律是真实文件,不做 SPA 回退 */
const ASSETS_DIR = 'assets'

/**
 * URL 路径 → 磁盘绝对路径。**纯函数,无 IO**,便于穷举测试。
 *
 * @param root 资源根(来自 `resolveWebPanelAssets().root`)
 * @param urlPath **已剥掉 `/panel/` 前缀**的相对路径,不含查询串。
 *   契约:不得以 `/` 或 `\` 开头 —— 以斜杠开头意味着调用方没剥前缀,
 *   或来源是 `/panel//etc/passwd` 这类载荷,两者都该 fail-closed 拒绝。
 */
export function resolveAssetPath(root: string, urlPath: string): AssetResolution {
  // 空路径 = 请求目录本身 → 交由上层映射到入口 HTML
  if (urlPath === '') return { ok: true, absPath: resolve(root), relPath: '' }

  // ① 只解码一次。畸形编码(`%`、`%zz`)在这里抛,归类为客户端错而非 500
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }

  // ② 字符白名单(fail-closed)。见 FORBIDDEN_CHARS / NUL 的逐条理由
  if (FORBIDDEN_CHARS.test(decoded) || decoded.includes(NUL)) {
    return { ok: false, reason: 'MALFORMED' }
  }

  // ③ 绝对路径 / UNC 一律拒绝。`isAbsolute` 在 win32 下也认 `\\server\share`
  if (decoded.startsWith('/') || isAbsolute(decoded)) return { ok: false, reason: 'ESCAPE' }

  // ④ 段级 `..` 检查(第一道)。normalize 会把 `a/../..` 折叠成 `..`,
  //    所以折叠后仍以 `..` 开头即为逃逸
  const normalized = normalize(decoded)
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('../')) {
    return { ok: false, reason: 'ESCAPE' }
  }

  // ⑤ 权威判据:resolve 后必须仍在 root 之内。
  //    这一条不依赖「我是否想全了所有坏形态」,是真正的兜底。
  const absPath = resolve(join(root, normalized))
  const rootResolved = resolve(root)
  if (absPath !== rootResolved && !absPath.startsWith(rootResolved + sep)) {
    return { ok: false, reason: 'ESCAPE' }
  }

  return { ok: true, absPath, relPath: normalized.split(sep).join('/') }
}

/**
 * 扩展名 → Content-Type。
 *
 * 覆盖面 = 「Vite 真的会吐什么」(实测 `npm run build:webpanel` 产物:
 * html / js / css;加上产物里可能出现的图标、字体、source map、内联资源)。
 * **不做 sniff、不给默认 `text/html`** —— 未知扩展名一律
 * `application/octet-stream`:让浏览器下载而不是解析,是未知类型唯一安全的处置。
 *
 * ⚠️ JS 的 `Content-Type` 错了(比如 `text/plain`)浏览器会**拒绝执行 module**,
 * 表现为白屏且控制台只有一句 MIME 报错 —— 所以 js/mjs 有专门用例锁住。
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json'
}

const DEFAULT_MIME = 'application/octet-stream'

export function contentTypeFor(relPath: string): string {
  const dot = relPath.lastIndexOf('.')
  if (dot < 0) return DEFAULT_MIME
  const ext = relPath.slice(dot + 1).toLowerCase()
  return MIME_TYPES[ext] ?? DEFAULT_MIME
}

/**
 * 缓存策略。分两类,依据是**文件名里有没有内容哈希**:
 *
 *   - `assets/index-C_sieKU2.js` → 内容变则**文件名变**,可以 immutable 一年
 *   - `index.html`               → 文件名恒定而内容随版本变,必须每次校验
 *
 * 把 index.html 也长缓存是升级后白屏的经典成因:浏览器拿旧 shell,
 * 里面引用的 hash 文件名在新版本里已被删 → 404 → 白屏。
 */
export function cacheControlFor(relPath: string): string {
  const inAssetsDir = relPath.startsWith(`${ASSETS_DIR}/`)
  if (inAssetsDir && HASHED_ASSET_NAME.test(relPath)) {
    return 'public, max-age=31536000, immutable'
  }
  // 未哈希资源(入口 HTML / favicon / manifest):允许缓存但每次必须回源校验。
  // 配合 ETag → 未变时 304,既不白屏也不浪费手机流量。
  return 'no-cache'
}

/**
 * CSP 响应头。
 *
 * 为什么由响应头下发而不是 HTML 里的 `<meta>`(构建包已刻意不写 meta):
 * meta 只能约束**那一个 HTML 文档**,管不了 js/css/字体/图片,也管不了
 * `frame-ancestors` 这类只在头里生效的指令。
 *
 * 逐条理由:
 *   - `default-src 'none'`       其余全部显式开,漏写的默认被拒(fail-closed)
 *   - `script-src 'self'`        **最要紧的一条**:禁内联脚本与外部脚本 →
 *                                即使面板某处把账号备注原样插进 DOM,XSS 也执行不了
 *   - `style-src 'self' 'unsafe-inline'`  见下方说明(有意放宽)
 *   - `img-src 'self' data:`     Vite 会把小图内联成 data: URL
 *   - `connect-src 'self'`       只允许打回本面板的 `/panel/api/*`;
 *                                真被注入也无法把账号数据 POST 到外部
 *   - `object-src / frame-src 'none'`  无插件、无内嵌框架
 *   - `base-uri 'none'`          防 `<base>` 注入改写所有相对 URL 的解析基准
 *   - `form-action 'none'`       面板全走 fetch,不存在表单提交;禁掉即禁止
 *                                注入的表单把 adminKey POST 到外部
 *   - `frame-ancestors 'none'`   面板不得被别的页面嵌进 iframe(点击劫持)
 *
 * ## `'unsafe-inline'` 只给 style,且这是一笔明账
 *
 * React 的 `style={{...}}` 会落成内联 style 属性,严格 `style-src 'self'` 会
 * 静默吃掉它们 —— 表现为「布局全乱但控制台只有 CSP 警告」。而内联样式与内联
 * 脚本的风险量级完全不同:前者不执行代码。所以这里放宽 style、**死守 script**。
 * 要收紧的正路是 nonce/hash,需要在 HTML 上做逐响应改写 —— 记为技术债。
 */
const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
]

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join('; ')

/** 产物缺失时的可诊断提示 —— 裸 404 会让人以为是路由写错,而真因是没构建 */
export const ASSETS_MISSING_HINT =
  'Web panel assets are not built. Run `npm run build:webpanel` (or `npm run build`) and restart.'

/** 静态托管入口需要的最小请求形状(不让 http.IncomingMessage 渗进纯逻辑) */
export interface StaticRequest {
  method: string
  /** **已剥掉 `/panel/` 前缀**的相对路径,不含查询串 */
  relUrlPath: string
  /** `If-None-Match` 头原值(用于 304) */
  ifNoneMatch?: string
}

/**
 * 是否该走 SPA 回退(把入口 HTML 当作未知路径的响应)。
 *
 * 边界刻意收得很紧 —— 回退是一把「什么都返回 200 HTML」的钝器,滥用会把
 * 两类问题变成极难调试的假成功:
 *
 *   1. **`api/*` 绝不回退**:未知 API 路径必须是 JSON 404。回退成 HTML 后,
 *      前端 `res.json()` 抛「Unexpected token '<'」,排查方向被彻底带偏。
 *      (这一条在生产调用点由 server.ts 的分派顺序保证 —— API 走在静态之前;
 *      本函数再显式挡一次,防将来分派顺序被改。)
 *   2. **带扩展名的路径绝不回退**:`assets/index-OLD.js` 找不到就该是 404。
 *      回退成 HTML 会让「构建产物缺失」伪装成 200,而浏览器报的是 MIME 错误 ——
 *      离真因隔了两层。
 *   3. **`assets/` 目录下绝不回退**:那底下只有真实文件。
 *
 * 剩下的才是真正的客户端路由(`accounts` / `settings/proxy`),回退给 shell。
 */
export function shouldFallbackToShell(relPath: string): boolean {
  if (relPath === ASSETS_DIR || relPath.startsWith(`${ASSETS_DIR}/`)) return false
  if (relPath === 'api' || relPath.startsWith('api/')) return false
  const lastSegment = relPath.slice(relPath.lastIndexOf('/') + 1)
  if (lastSegment.includes('.')) return false
  return true
}

/** 弱 ETag:size + mtime。内容哈希已在文件名里,再算内容 hash 是白烧 CPU */
function etagFor(size: number, mtimeMs: number): string {
  const h = createHash('sha1').update(`${size}-${mtimeMs}`).digest('base64url').slice(0, 20)
  return `W/"${h}"`
}

/**
 * 静态资源主入口。
 *
 * ## 鉴权决策:静态资源**不要求会话**(与 `/panel/api/*` 相反)
 *
 * 理由,按权重:
 *   1. **登录页就是这个 shell**。面板是客户端路由的 SPA —— 登录表单由
 *      `index.html` + bundle 渲染出来。把 bundle 放进会话闸门后面,等于
 *      「必须先登录才能拿到登录页」,只能另做一套无鉴权的服务端登录页 ——
 *      为一个不存在的收益造第二套 UI。
 *   2. **bundle 里没有秘密**。账号数据全部来自 `/panel/api/*`,那些端点的
 *      闸门一行未动。未鉴权客户端拿到的只是一个空壳。
 *   3. **前置防线仍在**:IP allow/deny 门禁跑在本函数之前(server.ts 最外层),
 *      局域网暴露面由它控制,不由静态层控制。
 *
 * 代价(明账):未鉴权的局域网客户端可以判断出「这台机器跑着 Kiro 账号管理面板」。
 * 端口本身已经暴露了这一点,而替代方案会破坏登录,所以接受。
 */
export async function serveStaticAsset(
  req: StaticRequest,
  res: http.ServerResponse,
  assets: WebPanelAssets
): Promise<void> {
  const method = req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    sendError(res, 405, 'ACCOUNT_NOT_FOUND', 'Method not allowed')
    return
  }

  // 产物没构建 → 可诊断的 503,而不是裸 404。
  // 503 而非 404 是有意的:资源本该存在,是**服务未就绪**,不是路径不存在。
  if (!assets.available) {
    sendAsset(res, {
      status: 503,
      contentType: 'text/plain; charset=utf-8',
      cacheControl: 'no-store',
      csp: CONTENT_SECURITY_POLICY,
      body: Buffer.from(ASSETS_MISSING_HINT, 'utf-8'),
      headOnly: method === 'HEAD'
    })
    return
  }

  const resolution = resolveAssetPath(assets.root, req.relUrlPath)
  if (!resolution.ok) {
    // 逃逸与畸形都不回 403 —— 见 AssetResolution 注释(不确认路径存在性)
    if (resolution.reason === 'MALFORMED') {
      sendError(res, 400, 'INVALID_CREDENTIAL', 'Malformed asset path')
    } else {
      sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'Not found')
    }
    return
  }

  // 目录本身(`/panel/` 或 `/panel`)→ 入口 HTML
  const isRootRequest = resolution.relPath === ''
  const relPath = isRootRequest ? WEB_PANEL_ENTRY_HTML : resolution.relPath
  const absPath = isRootRequest ? assets.entryHtml : resolution.absPath

  const direct = await tryServeFile(req, res, absPath, relPath, method)
  if (direct) return

  // 文件不存在 → 视边界决定是回 shell 还是 404
  if (shouldFallbackToShell(relPath)) {
    const served = await tryServeFile(req, res, assets.entryHtml, WEB_PANEL_ENTRY_HTML, method)
    if (served) return
  }
  sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'Not found')
}

/**
 * 试着发一个文件。存在且是普通文件 → 已响应,返回 true;不存在 / 是目录 → false。
 *
 * 目录当作「不存在」而非报错:请求 `assets`(无斜杠)不该 500,
 * 也**不该列目录** —— 目录列表会把全部产物文件名泄露出去。
 */
async function tryServeFile(
  req: StaticRequest,
  res: http.ServerResponse,
  absPath: string,
  relPath: string,
  method: string
): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOENT / ENOTDIR 是「没这个文件」的正常语义;其余(EACCES / EIO)是真异常,
    // 不能一并当成 404 静默吞掉 —— 那会把权限配置错误伪装成「文件不存在」。
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
  if (!info.isFile()) return false

  const etag = etagFor(info.size, info.mtimeMs)
  const cacheControl = cacheControlFor(relPath)

  // 条件请求:未变则 304。入口 HTML 走 `no-cache`,没有验证器的话每次都要
  // 重下整个 shell —— 手机端流量与首屏都吃亏。
  if (req.ifNoneMatch && req.ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
    sendAsset(res, {
      status: 304,
      contentType: contentTypeFor(relPath),
      cacheControl,
      etag,
      csp: CONTENT_SECURITY_POLICY,
      body: Buffer.alloc(0),
      headOnly: true
    })
    return true
  }

  const body = await readFile(absPath)
  sendAsset(res, {
    status: 200,
    contentType: contentTypeFor(relPath),
    cacheControl,
    etag,
    csp: CONTENT_SECURITY_POLICY,
    body,
    headOnly: method === 'HEAD'
  })
  return true
}
