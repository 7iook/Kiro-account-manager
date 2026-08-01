// ============================================================================
// Token 指纹工具 · 用于凭据去重(§6 Minimal Files #3 · RCA A6-R2 语义)
// ----------------------------------------------------------------------------
// 仅在主进程内使用(Node crypto),通过 IPC (verify-api-key / compute-token-fingerprint)
// 把 16 位 hex 结果透传给 renderer。renderer 不 import Node crypto,不重算。
//
// 语义:
//   fingerprint = sha256(accessToken).slice(0, 16)
//
// - 16 位 hex ⇒ 碰撞域 2^64,实用碰撞概率忽略。
// - 密钥轮换 ⇒ 新 fingerprint ⇒ 新账号入池(用户预期一致:轮换意味着"这是一个新凭据")。
// - 仅作凭据去重键 · 不承担账号身份真源职责。
// ============================================================================

import { createHash } from 'node:crypto'

/**
 * 计算 accessToken 的 sha256 hex 指纹前 16 位。
 * @param accessToken 原始 accessToken 字符串(如完整 ksk_ 密钥)
 * @returns 16 位小写 hex 字符串
 */
export function sha256Fingerprint(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'utf8').digest('hex').slice(0, 16)
}
