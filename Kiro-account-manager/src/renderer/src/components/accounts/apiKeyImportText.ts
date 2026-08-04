/**
 * ksk_ 导入结果的展示文案 —— 纯函数，UI 层专用
 *
 * ## 为什么文案在这里，而判定在主进程
 *
 * `code` 是**唯一分支依据**，由共享用例 `main/accountService/importApiKey.ts` 产出；
 * 本文件只把 code 翻译成用户能看懂的话，**不做任何语义判定**。
 * 这个分工是有意的：判定放两份会漂移（同一个密钥在面板与桌面端得到不同结论），
 * 而文案放两份最多是措辞不一致 —— 且 web 面板是中文单语、桌面端要双语，
 * 本来就不该共用同一份字符串表。
 *
 * 共享层已经给了中文 `reason`。有 reason 就直接用（它带上游的具体原因，
 * 比这里的通用文案更有信息量）；英文界面才回落到本表。
 */

/** 与 `main/accountService/importApiKey.ts:ApiKeyImportCode` 一一对应 */
export type ApiKeyImportCode =
  | 'IMPORTED'
  | 'BAD_FORMAT'
  | 'INVALID'
  | 'SUSPENDED'
  | 'INDETERMINATE'
  | 'MISSING_FINGERPRINT'
  | 'ALREADY_EXISTS'
  | 'VERIFY_ERROR'
  | 'WRITE_CONFLICT'

const EN_TEXT: Record<ApiKeyImportCode, string> = {
  IMPORTED: 'imported',
  BAD_FORMAT: 'must start with ksk_',
  INVALID: 'key is invalid or revoked',
  SUSPENDED: 'account suspended by Kiro',
  INDETERMINATE: 'cannot verify right now, please retry later',
  MISSING_FINGERPRINT: 'missing token fingerprint from main process',
  ALREADY_EXISTS: 'already exists',
  VERIFY_ERROR: 'verification failed',
  WRITE_CONFLICT: 'data changed elsewhere, please retry'
}

const ZH_FALLBACK: Record<ApiKeyImportCode, string> = {
  IMPORTED: '已导入',
  BAD_FORMAT: '格式错误(应以 ksk_ 开头)',
  INVALID: '密钥无效或已吊销',
  SUSPENDED: '账号已被 Kiro 暂停',
  INDETERMINATE: '暂时无法验证，请稍后重试',
  MISSING_FINGERPRINT: '主进程未返回 fingerprint',
  ALREADY_EXISTS: '账户已存在',
  VERIFY_ERROR: '校验失败',
  WRITE_CONFLICT: '数据已被其它端修改，请重新提交'
}

/**
 * 把一条导入结果翻成展示文案。
 *
 * @param code  共享层给的稳定错误码 —— 分支只看它，不看文案
 * @param reason 共享层给的中文原因（可能带上游具体信息）；英文界面忽略它
 * @param isEn  当前界面是否英文
 */
export function apiKeyImportCodeText(
  code: ApiKeyImportCode,
  reason: string | undefined,
  isEn: boolean
): string {
  if (isEn) return EN_TEXT[code] ?? code
  // 中文界面优先用共享层的 reason —— 它可能含上游返回的具体原因，信息量更大
  return reason && reason.length > 0 ? reason : (ZH_FALLBACK[code] ?? code)
}
