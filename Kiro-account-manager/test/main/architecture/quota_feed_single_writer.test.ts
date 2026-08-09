/**
 * Architecture fitness gate:真实额度写入池必须只有**一个**生产写者。
 *
 * 背景（本轮修的缺陷）:`accountPool.updateQuota` 自 v1.6.0 引入起**零生产调用方** ——
 * quotaUsed/quotaLimit 永不被写,isQuotaExhausted 的第三条判据在生产中恒为 false,
 * 池只能靠一个 402 失败请求才知道账号没额度了。本轮把落盘收口
 * (`accountService/persistCheckResult`)接成它的唯一调用方。
 *
 * 为什么要静态闸门而不只是改代码:
 *
 * ① **防重新退化成零调用方**。这个函数已经「建好但没接线」过一次(E-052 形态),
 *    删掉调用方不会有任何测试变红 —— 池只是安静地退回「靠失败请求学习」。
 *
 * ② **防出现第二个写者**。`quotaUsed/quotaLimit` 与 `quotaExhaustedAt` 是同一状态机的
 *    字段,而 `recordError`(402 打标)/ `recordSuccess`(清误标)已经是两个写者。
 *    再加一个不同新鲜度的写者就会出现「A 说 90/100、B 说 20/100,谁赢取决于调度顺序」,
 *    而赢错一次的代价是账号被钉死到 quotaResetAt(recordSuccess 的 realQuotaUsedUp
 *    短路刻意不清真实额度数据)。这类缺陷单看新增的那一行永远是对的,code review 抓不住。
 *
 * ③ **防「快用光」谓词渗进可用性判据**。剩余额度低 ≠ 账号不可用。一旦「剩余 ≤ 阈值」
 *    流进 isAccountAvailable / hasBlockedAccount,挂起门闸就会冻结那些其实还能用的号 ——
 *    RCA 2026-08-02 与 2026-08-04 两次生产事故都是这个形状(换号判据与挂起判据混用)。
 *    换号判据(便宜:换个号,失败也就浪费一次)与挂起判据(极贵:冻结用户请求)必须分开。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

/** 用 git grep 找生产代码里的调用点（只扫 src/，不含 tests/） */
function grepProduction(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-n', pattern, '--', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8'
    })
    return out.split(/\r?\n/).filter((l) => l.trim().length > 0)
  } catch (e) {
    // git grep 无命中时 exit code 1
    const err = e as { status?: number; stdout?: string }
    if (err.status === 1) return []
    throw e
  }
}

describe('architecture: 真实额度进池只有一个生产写者', () => {
  it('updateQuota 的生产调用方恰好 1 处（零 = 退回未接线，多 = 多写者互相覆盖）', () => {
    const hits = grepProduction('\\.updateQuota(')
    expect(
      hits,
      `\`accountPool.updateQuota\` 的生产调用方必须恰好 1 处（落盘收口 ` +
        `\`accountService/persistCheckResult.ts:feedQuotaToPool\`）。\n` +
        `实际命中:\n${hits.join('\n') || '（零命中 —— 池又退回「只能靠 402 失败请求学习额度」）'}`
    ).toHaveLength(1)
    expect(hits[0]).toContain('src/main/accountService/persistCheckResult.ts')
  })

  it('可用性判据内不得出现「剩余额度 / 快用光」类计算（换号判据 ≠ 挂起判据）', () => {
    // 判据函数体内出现 remaining / nearExhaust / threshold 就是把「快用光」接进了
    // 「不可用」——那会让挂起门闸冻结其实还能用的号（RCA 2026-08-02 / 08-04）。
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/proxy/accountPool.ts'), 'utf-8')
    const GUARDED = ['isAccountAvailable', 'isQuotaExhausted', 'hasBlockedAccount', 'availableCount']
    const FORBIDDEN = /\b(remainingCredits|isNearExhausted|nearExhaust)\b/

    const violations: string[] = []
    const lines = src.split(/\r?\n/)
    for (const fn of GUARDED) {
      // 定位函数/getter 声明行，取其后 40 行作为函数体窗口（这四个都远短于 40 行）
      const startIdx = lines.findIndex(
        (l) => new RegExp(`(get\\s+${fn}\\b|\\b${fn}\\s*\\()`).test(l) && !/^\s*(\*|\/\/)/.test(l)
      )
      if (startIdx < 0) continue
      const body = lines
        .slice(startIdx, startIdx + 40)
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join('\n')
      if (FORBIDDEN.test(body)) violations.push(`${fn} (accountPool.ts:${startIdx + 1})`)
    }

    expect(
      violations,
      `「剩余额度 ≤ 阈值」是**换号**判据（便宜），绝不能流进**可用性 / 挂起**判据（极贵）。\n` +
        `一旦流进去，挂起门闸会冻结那些其实还能用的号 —— RCA 2026-08-02 / 2026-08-04 两次` +
        `生产事故就是这个形状。违规:\n${violations.join('\n')}`
    ).toEqual([])
  })

  it('sanity: 被守护的四个判据函数确实都还在（防判定器空转假绿）', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/main/proxy/accountPool.ts'), 'utf-8')
    for (const fn of ['isAccountAvailable', 'isQuotaExhausted', 'hasBlockedAccount', 'availableCount']) {
      expect(src).toContain(fn)
    }
  })
})
