/**
 * webPanel 唯一 JSON 响应出口 —— 强制脱敏兜底（denylist 外层）
 *
 * 决策卡 §3「输出脱敏与照搬豁免」· recon-http-layer.md §3.3
 *
 * ## 为什么脱敏收在这条边上，而不是数据源头
 *
 * `loadAccounts()` 与 `applyAccountDataMutation` 是**读写共用的内部数据通道**，
 * 桌面 renderer 依赖明文凭据工作（`AccountCard.tsx:226-243` 把 token 当参数回传主进程）。
 * 在源头脱敏会直接打断桌面端。脱敏必须贴在「出主进程且面向网络」这一条边上。
 *
 * ## 与 dto.ts 的两层分工（缺一不可）
 *
 * | 层 | 文件 | 机制 | 抓什么 | 另一层抓不到的部分 |
 * |---|---|---|---|---|
 * | 内层 | `dto.ts` | allowlist 白名单投影 | 决定**给什么** | 只有它能防"多给了不该给的非凭据字段"（`proxyUrl` / 设置项 / 未来新增字段） |
 * | 外层 | 本文件 | denylist 无条件脱敏 | 保证**什么都不漏** | 只有它能防"端点作者根本没调 dto"（白名单是可选的，可选的必然被绕过） |
 *
 * ⚠️ 外层是**兜底网，不是许可证**：`maskMiddle` 打码后仍泄漏长度与首尾字符，
 * 所以不能把它当"可以随便返回内部对象"的理由。正常端点必须走 `dto.ts` 投影。
 *
 * ## 第三层：静态闸门
 *
 * 光有 `sendJson` 约定仍可能被 `res.end(JSON.stringify(x))` 绕过，而
 * `loadAccounts(): Promise<unknown>` 意味着**编译期零保护** —— TypeScript 拦不住
 * 把内部对象丢给 socket。故 `test/main/architecture/webpanel_no_direct_res_end.test.ts`
 * 用静态断言禁止本目录出现直接 `res.end(`。那是唯一能把"不许绕过"从愿望变成事实的机制。
 */
import type http from 'node:http'
import { redactValue } from '../utils/redact'

/** 决策卡 §3 的稳定错误码（非错误字符串） */
export type PanelErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIAL'
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'ACCOUNT_NOT_FOUND'
  | 'TOKEN_REFRESH_FAILED'
  | 'STALE_REVISION'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  // ===== 反代编排（W8）=====
  /** 反代未运行 —— 选号 / 读当前账号在此前提下无意义 */
  | 'PROXY_NOT_RUNNING'
  /** 指定账号不在池里。单账号模式是严格模式，刻意不 fallback 到随机账号 */
  | 'ACCOUNT_NOT_IN_POOL'
  /** 账号被风控封禁或不可用 */
  | 'ACCOUNT_NOT_AVAILABLE'
  /** 池是空的 —— 拒绝启动。空池启动会「起来了、状态正常、每个请求都失败」 */
  | 'EMPTY_POOL'
  /** 启停失败（端口占用等） */
  | 'PROXY_START_FAILED'

/**
 * 面板唯一的 JSON 出口。**所有** `/panel/api/*` 响应必须经此函数。
 *
 * payload 无条件过 `redactValue`：键名级（accessToken / refreshToken / clientSecret /
 * csrfToken …）+ 值级（JWT / `ksk_` 前缀密钥）双路识别，递归覆盖嵌套层。
 */
export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const safe = redactValue(payload)
  let body: string
  try {
    body = JSON.stringify(safe ?? null)
    // JSON.stringify 对 undefined / 函数 / Symbol 返回 undefined，不是合法响应体
    if (body === undefined) body = 'null'
  } catch (error) {
    // 循环引用等序列化失败：redactValue 已用 WeakSet 把环替换成 '[circular]'，
    // 理论上不该走到这里。但响应出口是横切咽喉点 —— 它自身抛异常会让请求悬挂（无响应、
    // 客户端超时），比返回一个错误码严重得多。故降级为 500 + 稳定错误码，并保留日志。
    // 这不是吞异常返回成功：状态码被强制改写为 500，调用方与用户都看得到失败。
    console.error('[webPanel] Failed to serialise response payload:', error)
    status = 500
    body = JSON.stringify({ code: 'INTERNAL_ERROR' satisfies PanelErrorCode })
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * 错误响应 —— 复用同一出口，因此同样受强制脱敏保护。
 *
 * @param code 稳定错误码（决策卡 §3 表）；客户端按 code 分支，不按 message 文案
 * @param message 可选的补充说明。**绝不回传上游原始报文** —— 即使调用方误传，
 *   `sendJson` 的脱敏也会把其中的凭据打码
 */
export function sendError(
  res: http.ServerResponse,
  status: number,
  code: PanelErrorCode,
  message?: string
): void {
  sendJson(res, status, message === undefined ? { code } : { code, message })
}

/**
 * 静态资源出口(第二条车道)—— 发**字节**,不发对象
 *
 * ## 为什么加在这里,而不是在 staticAssets.ts 里直接 res.end
 *
 * `webpanel_no_direct_res_end.test.ts` 的不变量是「本目录所有 socket 写入都汇聚在
 * `respond.ts` 一个文件里」。静态托管天然要写字节,若在 staticAssets.ts 里 `res.end`,
 * 就必须把它加进闸门白名单 —— 那等于把「唯一出口」变成「两个出口」,而闸门存在的
 * 理由正是**出口唯一**。所以选择相反的方向:把静态资源的写入也搬进这个咽喉点。
 * 闸门白名单一行未改,不变量字面上仍然成立(Globalrules §4.9 Layer-1;不绕闸门)。
 *
 * ## 与 sendJson 的分工:刻意不共用脱敏
 *
 * `sendJson` 对 payload 无条件跑 `redactValue`,那是**对象**语义的保护。
 * 本函数收的是已经成型的 `Buffer`(JS bundle / CSS / 图片),对它跑 redact 毫无意义
 * (二进制里匹配「键名」是无稽之谈),且会把几百 KB 的 bundle 反复扫一遍。
 *
 * 这不是「绕过脱敏」—— 两条车道的**输入来源根本不同**:
 *   - `sendJson`  ← 业务对象(`loadAccounts()` 的 `unknown` 整表 blob,含明文凭据)
 *   - `sendAsset` ← 磁盘上的构建产物字节(`out/webPanel/` 内,由 vite 生成)
 *
 * 危险的是前者,因为 `unknown` 让编译期零保护。后者的 body **只能**来自
 * `staticAssets.ts` 的 `readFile(资源根内的路径)`,而那条路径已由
 * `resolveAssetPath()` 的 fail-closed 校验锁死在资源根内。
 *
 * ⚠️ 因此有一条硬约束,由 `webpanel_static_exit.test.ts` 静态断言守住:
 * **`sendAsset` 只允许 `staticAssets.ts` 调用**。任何业务端点想用它发响应,
 * 就绕过了 `redactValue` 兜底 —— 那正是闸门要防的事。
 */
export interface AssetResponse {
  status: number
  contentType: string
  /** `Cache-Control` 值(由 staticAssets 按「文件名是否含内容哈希」决定) */
  cacheControl: string
  /** 弱 ETag,用于条件请求;304 响应也要带 */
  etag?: string
  /** CSP 响应头值。静态资源必须带 —— meta 标签管不了非 HTML 资源 */
  csp: string
  /** 响应体字节。304 / HEAD 时不发体,但 Content-Length 仍按 body 长度给 */
  body: Buffer
  /** HEAD 或 304:只发头不发体(Content-Length 仍须如实反映资源大小) */
  headOnly?: boolean
}

export function sendAsset(res: http.ServerResponse, asset: AssetResponse): void {
  const headers: Record<string, string | number> = {
    'Content-Type': asset.contentType,
    'Cache-Control': asset.cacheControl,
    'Content-Security-Policy': asset.csp,
    // 静态资源同样要禁 sniff:MIME 猜测能把一个 .txt 当 HTML 执行
    'X-Content-Type-Options': 'nosniff',
    // 面板不该被嵌进任何页面。CSP frame-ancestors 是正路,这条是老浏览器的兜底
    'X-Frame-Options': 'DENY',
    // 局域网页面不需要向外发 referrer(会泄漏内网地址与路径)
    'Referrer-Policy': 'no-referrer'
  }
  if (asset.etag) headers['ETag'] = asset.etag
  // 304 按规范不带 Content-Length(否则部分客户端会等一个永不到来的 body)
  if (asset.status !== 304) headers['Content-Length'] = asset.body.byteLength

  res.writeHead(asset.status, headers)
  if (asset.headOnly || asset.status === 304) {
    res.end()
    return
  }
  res.end(asset.body)
}
