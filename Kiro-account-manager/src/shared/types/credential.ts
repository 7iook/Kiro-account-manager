// ============================================================================
// 凭据校验 · 类型 SSOT (§6 Minimal Files #8 · RCA A2-R5)
// ----------------------------------------------------------------------------
// 主进程 kiroApi.ts 只从此文件 import 类型,不再自己导出。
// preload / renderer 也走此文件消费,防止类型双真源漂移。
// ============================================================================

/**
 * 凭据探测状态(有限互斥集 · 一个响应只映射到一个 state)
 * - VALID:       认证有效 + 后端明确返回订阅类型,允许入池。
 *                不隐含"额度充足"或"能成功推理"(仅入池决策)。
 * - INVALID:     认证失败/密钥吊销,拒绝入池。
 * - SUSPENDED:   账号被 Kiro 平台暂停,拒绝入池。
 * - INDETERMINATE: 暂时/未知无法判定,不入池,提示用户重新提交。
 *
 * 详见 RCA §6 「凭据探测状态机 · 互斥决策表」 11 行。
 */
export type CredentialState = 'VALID' | 'INVALID' | 'SUSPENDED' | 'INDETERMINATE'

/** 订阅摘要 · 来自 GetUsageLimits 响应的 subscriptionInfo */
export interface SubscriptionSummary {
  /** AWS 内部标识 · 如 `Q_DEVELOPER_STANDALONE_POWER`(不同于用户可读的 title) */
  type: string
  /** 用户可读订阅名 · 如 `KIRO POWER` */
  title?: string
  /** 订阅状态 · `ACTIVE` / `SUSPENDED` 等 */
  status?: string
  /** 订阅管理来源 · `MANAGE` / `IDC` 等 */
  managementTarget?: string
  currentUsage?: number
  usageLimit?: number
}

/**
 * 凭据探测结果 · validateApiKeyCredential 的返回值。
 *
 * 契约:
 * - state 是唯一分类字段;调用方按 state 分支处理,不得依赖 success/error 的字面组合。
 * - tokenFingerprint 仅在 state=VALID 时填充(其他 state 一定 undefined);
 *   由主进程内部 sha256(accessToken).slice(0,16) 计算,renderer 不重算。
 */
export interface CredentialProbeResult {
  state: CredentialState
  subscription?: SubscriptionSummary
  /** 16 位 hex · sha256(accessToken) 前 16 位 · 仅 VALID 态填充 */
  tokenFingerprint?: string
  /** 人类可读原因(用于结果面板展示) */
  reason?: string
  httpStatus?: number
}

/**
 * verify-api-key IPC 返回体 · CredentialProbeResult + 附加 profileArn / success / error。
 * profileArn 是可选元数据(state=VALID 时通过 GetProfile 附赠尝试拿),undefined 合法。
 */
export interface VerifyApiKeyResult extends CredentialProbeResult {
  /** 是否允许入池的二值汇总;renderer 分类 SSOT 仍是 state,success 只是辅助 */
  success: boolean
  /** GetProfile 拿到的真 profileArn · 拿不到 undefined · 不影响 state */
  profileArn?: string
  profileName?: string
  profileType?: string
  /** 数据面 region · 从 profileArn 解析或回退 region 参数 */
  region?: string
  /** state=INVALID/SUSPENDED/INDETERMINATE 时 renderer 展示用 */
  error?: string
}
