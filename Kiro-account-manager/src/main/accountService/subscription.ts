/**
 * 订阅标题 → 规范化订阅类型（SSOT）
 *
 * 抽取来源：index.ts 内 4 份逐字复制的 if-else 链
 *   :3848 (import-from-sso-token) · :4536 (background-batch-check) ·
 *   :4861 (check-account-status)  · :5236 (verify-account-credentials)
 * 本轮（W2）只把 import-from-sso-token 与 verify-account-credentials 两份收口到这里；
 * 另两份属于并行 executor 的行区间，由其各自收口到同一函数（见文件尾 TODO）。
 *
 * ⚠️ 判定顺序是业务约定，不是可整理的代码风格：
 *   'KIRO PRO+' 同时命中 PRO+ 与 PRO，必须先判 PRO+ 才不会被降级成 Pro。
 *   同理 POWER 必须先于 ENTERPRISE 之外的分支（历史上 POWER 归入 Enterprise 徽章）。
 * 顺序被改动 = 用户界面上的订阅徽章静默错档，故有表驱动测试钉死
 * （test/main/accountService/subscription.test.ts）。
 */
export function normalizeSubscriptionType(subscriptionTitle: string): string {
  const titleUpper = (subscriptionTitle || '').toUpperCase()
  if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
    return 'Pro_Plus'
  } else if (titleUpper.includes('POWER')) {
    return 'Enterprise'
  } else if (titleUpper.includes('PRO')) {
    return 'Pro'
  } else if (titleUpper.includes('ENTERPRISE')) {
    return 'Enterprise'
  } else if (titleUpper.includes('TEAMS')) {
    return 'Teams'
  }
  return 'Free'
}

// TODO(债 · 跨 executor)：index.ts:4536 / :4861 仍是本函数的逐字副本，
// 属于 check-account-status / background-batch-check 的行区间（并行 executor 负责）。
// 它们收口到本函数后，`git grep -c "PROPLUS" -- src/main/index.ts` 应为 0。
