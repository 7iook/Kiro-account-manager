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
