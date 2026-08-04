/**
 * 安全属性：adminKey 比较耗时不随「前缀匹配长度」变化（决策卡 §4 测试边界 3）。
 *
 * ⚠️ 本测试的核心设计 = **自带阳性对照**（positive control）。
 *
 * 本项目反复吃过的亏：闸门看起来正确，但结构上观察不到它声称检查的东西
 * （error-journal E-091）。朴素 `===` 与 `timingSafeEqual` 的差异在短字符串上是
 * 纳秒级，会被 V8 JIT / GC / OS 调度噪声完全淹没 —— 那样的计时测试即使
 * 实现是朴素 `===` 也会「通过」，属于「为错误的原因而通过」。
 *
 * 因此本测试做两件事：
 *   ① 放大信号：用 4MB 量级字符串，让 `===` 背后 memcmp 的提前退出
 *      从纳秒放大到毫秒，物理上可测。
 *   ② 阳性对照：同一套测量装置先量朴素 `===`，**断言它必须能看到泄漏**。
 *      若机器噪声大到连朴素实现的泄漏都测不出来，对照断言先失败 → 测试转红，
 *      而不是静默放过。测量装置失去分辨力时本测试 fail-closed。
 *
 * 判据是**比值**而非绝对耗时：两者在同一次运行、同一台机器上测量，
 * 比值自归一化，不受机器快慢影响。
 */
import { describe, it, expect } from 'vitest'
import { safeStringEq } from '../../../src/main/utils/netGuard'

/** 放大到 4MB：memcmp 扫完全程约数百微秒，提前退出约纳秒级，差异可测 */
const LEN = 4_000_000

const secret = 'a'.repeat(LEN)
/** 与 secret 等长、**第 0 字节**即不同 → 朴素比较立刻退出 */
const earlyMismatch = `b${'a'.repeat(LEN - 1)}`
/** 与 secret 等长、**最后一字节**才不同 → 朴素比较必须扫完全程 */
const lateMismatch = `${'a'.repeat(LEN - 1)}b`

type Compare = (a: string, b: string) => boolean

/** 阳性对照用的朴素实现 —— 正是本测试必须能判死的那种写法 */
const naiveEq: Compare = (a, b) => a === b

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 计时 iters 次比较；sink 消费返回值防 V8 把整个循环优化掉 */
function timeCompare(cmp: Compare, a: string, b: string, iters: number): number {
  let sink = 0
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) {
    if (cmp(a, b)) sink++
  }
  const elapsed = performance.now() - t0
  // 前提校验：两个输入必须不相等，否则测的不是「不匹配位置」而是「相等路径」
  if (sink !== 0) throw new Error('测量前提被破坏：输入不应相等')
  return elapsed
}

/** 返回 late/early 耗时比 —— 朴素实现应显著 > 1，常数时间实现应 ≈ 1 */
function asymmetryRatio(cmp: Compare, iters: number, rounds: number): number {
  // 预热：触发 JIT + 把 ConsString(拼接产生的 rope) 摊平，避免首次摊平成本计入 early
  timeCompare(cmp, secret, earlyMismatch, iters)
  timeCompare(cmp, secret, lateMismatch, iters)

  const early: number[] = []
  const late: number[] = []
  for (let r = 0; r < rounds; r++) {
    // 交错测量，摊平测量期间的系统性漂移（GC / 频率调节）
    early.push(timeCompare(cmp, secret, earlyMismatch, iters))
    late.push(timeCompare(cmp, secret, lateMismatch, iters))
  }
  // early 可能量到 0，夹一个下限避免除零得到 Infinity
  return median(late) / Math.max(median(early), 0.001)
}

describe('安全属性：adminKey 比较为常数时间', () => {
  it('比较耗时不随前缀匹配长度变化，且测量装置能判死朴素 === 实现', () => {
    // 朴素实现迭代多些（单次极快）；safeStringEq 单次含 2 次 4MB Buffer.from，迭代少些。
    // 比值在各自内部归一化，迭代次数不同不影响可比性。
    const naiveRatio = asymmetryRatio(naiveEq, 25, 5)
    const safeRatio = asymmetryRatio(safeStringEq, 5, 5)

    // ① 阳性对照：装置必须真能观测到前缀长度泄漏。
    //    此断言失败 = 测量装置失去分辨力 → 本测试不允许「通过」。
    expect(
      naiveRatio,
      `阳性对照失效：朴素 === 的 late/early 耗时比仅 ${naiveRatio.toFixed(1)}x，` +
        `说明本测试的测量装置观测不到前缀匹配长度泄漏，其「通过」不构成证据。`
    ).toBeGreaterThan(5)

    // ② 真正的安全属性：常数时间实现不随不匹配位置变化
    expect(
      safeRatio,
      `safeStringEq 的 late/early 耗时比 ${safeRatio.toFixed(2)}x 偏离 1，疑似泄漏前缀匹配长度`
    ).toBeLessThan(2)

    // ③ 相对判据：与朴素实现相比必须显著更平坦（自归一化，不吃机器快慢）
    expect(
      safeRatio,
      `safeStringEq(${safeRatio.toFixed(2)}x) 未显著优于朴素 ===(${naiveRatio.toFixed(1)}x)`
    ).toBeLessThan(naiveRatio / 3)
  })

  it('长度不同、内容不同、完全相同三种输入的返回值均正确', () => {
    // 正确性（非安全属性）—— 朴素 === 同样能过，故单独成例、不与上面的安全断言混淆
    expect(safeStringEq('kam-admin-key', 'kam-admin-key')).toBe(true)
    expect(safeStringEq('kam-admin-key', 'kam-admin-keX')).toBe(false)
    expect(safeStringEq('short', 'much-longer-value')).toBe(false)
    expect(safeStringEq('', '')).toBe(true)
    expect(safeStringEq('', 'x')).toBe(false)
    // 多字节：Buffer.from(utf8) 后长度不同，仍必须安全返回 false 而非抛错
    expect(safeStringEq('密钥', 'ab')).toBe(false)
    expect(safeStringEq('密钥', '密钥')).toBe(true)
  })
})
