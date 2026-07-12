/**
 * Multi-profile 导入相关的 pure fn helper。
 *
 * 决策卡 v2 §6.6 §4.3:SSOT — 所有多 profile 决策/批量导入逻辑收口于此文件,
 * AddAccountDialog 只做 UI orchestration,不做业务判断。
 *
 * 本文件与轨 A 交付的 preload/index.d.ts KiroProfile 契约(4 字段)对齐,
 * renderer 侧直接消费 preload 的内联副本,不跨界到 main proxy 内部。
 */
import type { Account } from '@/types/account'

/**
 * KiroProfile 的 renderer-side 类型副本(与 preload/index.d.ts:472-477 一致)。
 * 单独命名以强调这是 UI 层类型,不引用 main 侧 kiroApi.ts。
 */
export interface KiroProfileForSelect {
  profileArn: string
  profileName?: string
  accountName?: string
  region?: string
}

export type ProfileImportStrategy =
  | { mode: 'auto' }
  | {
      mode: 'select'
      profiles: KiroProfileForSelect[]
      alreadyImportedArns: Set<string>
    }

/**
 * 收集同 email + 指定 provider 列表下已导入的 profileArn 集合,用于 UI 层置灰。
 * §4.8 双保险:与 isAccountExists 副键扩展形成防御性拦截,即使副键漏也拦得住。
 */
export function collectAlreadyImportedArns(
  accounts: Map<string, Account>,
  email: string,
  providers: string[]
): Set<string> {
  const set = new Set<string>()
  if (!email) return set
  for (const acc of accounts.values()) {
    if (acc.email !== email) continue
    const p = acc.credentials.provider
    if (!p || !providers.includes(p)) continue
    const arn = acc.credentials.profileArn
    if (arn) set.add(arn)
  }
  return set
}

/**
 * 判断某 (email, provider, profileArn) 三元组是否已有账户 —— 与 isAccountExists 副键三元组语义一致。
 * 供 batch 循环里逐个 profile 判定用。
 */
export function isProfileAlreadyImported(
  accounts: Map<string, Account>,
  email: string,
  provider: string,
  profileArn: string
): boolean {
  if (!email || !provider || !profileArn) return false
  for (const acc of accounts.values()) {
    if (
      acc.email === email &&
      acc.credentials.provider === provider &&
      acc.credentials.profileArn === profileArn
    ) {
      return true
    }
  }
  return false
}

/**
 * completeExternalIdpLogin 返回的 profiles 数组决策分叉:
 *  - 0 / 1 profile → mode='auto'(N=1 走原路径,零 UI 变化;N=0 靠登录 token 老兜底)
 *  - ≥2 profile   → mode='select' 弹选择框,携带 alreadyImportedArns 供 UI 置灰
 *
 * providers 默认覆盖 external_idp + IdC 两种登录方式(决策卡 scope=B sweep)。
 */
export function pickProfileImportStrategy(
  profiles: KiroProfileForSelect[] | undefined,
  accounts: Map<string, Account>,
  email: string,
  providers: string[] = ['ExternalIdp', 'IdC']
): ProfileImportStrategy {
  const list = profiles ?? []
  if (list.length < 2) return { mode: 'auto' }
  return {
    mode: 'select',
    profiles: list,
    alreadyImportedArns: collectAlreadyImportedArns(accounts, email, providers)
  }
}

// ---- runBatchProfileImport ----

export interface BatchProfileVerifyOk {
  success: true
  data: {
    email?: string
    userId: string
    accessToken: string
    refreshToken?: string
    profileArn?: string
    [key: string]: unknown
  }
}
export interface BatchProfileVerifyErr {
  success: false
  error?: string
}
export type BatchProfileVerifyResult = BatchProfileVerifyOk | BatchProfileVerifyErr

export interface BatchImportError {
  profileArn: string
  profileName?: string
  message: string
}

export interface BatchImportOutcome {
  successCount: number
  errors: BatchImportError[]
}

export interface RunBatchProfileImportOptions {
  selected: KiroProfileForSelect[]
  verifyForProfile: (profileArn: string) => Promise<BatchProfileVerifyResult>
  addAccountForVerify: (
    verifyData: BatchProfileVerifyOk['data'],
    profile: KiroProfileForSelect
  ) => void
  /** 命中(true)则跳过 verify + addAccount 且计一条 already-imported 错误 */
  isDuplicate?: (profileArn: string) => boolean
  /** 命中 duplicate 时的错误信息文案(i18n 层可注入); 缺则用默认英文 */
  duplicateMessage?: string
}

/**
 * 串行(非并发)对每个选中的 profile:
 *   1. isDuplicate 命中 → 计错继续下一个
 *   2. verifyForProfile 成功 → 调 addAccountForVerify
 *   3. verifyForProfile 失败/抛错 → 计错继续
 *
 * 决策卡 v2 §3 「幂等 + 降级」:失败一个不阻塞其他,汇总错误返回。
 */
export async function runBatchProfileImport(
  opts: RunBatchProfileImportOptions
): Promise<BatchImportOutcome> {
  const errors: BatchImportError[] = []
  let successCount = 0

  for (const profile of opts.selected) {
    const arn = profile.profileArn
    if (opts.isDuplicate && opts.isDuplicate(arn)) {
      errors.push({
        profileArn: arn,
        profileName: profile.profileName,
        message: opts.duplicateMessage ?? 'already imported'
      })
      continue
    }
    try {
      const verify = await opts.verifyForProfile(arn)
      if (!verify.success || !('data' in verify) || !verify.data) {
        errors.push({
          profileArn: arn,
          profileName: profile.profileName,
          message: (verify as BatchProfileVerifyErr).error ?? 'verify failed'
        })
        continue
      }
      opts.addAccountForVerify(verify.data, profile)
      successCount++
    } catch (e) {
      errors.push({
        profileArn: arn,
        profileName: profile.profileName,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  return { successCount, errors }
}
