// Smooth Weighted Round-Robin (SWRR) - nginx 同款算法
//
// 参考实现: src/renderer/src/components/pages/RegisterPage.tsx:1630-1666 (前端邮箱源)
// 抽到主进程通用工具, 服务于:
//   - AccountPool.pickWeighted (账号级按权重分流)
//   - proxyServer.applyModelMapping loadbalance (模型映射加权)
//
// 算法:
//   每次调用给所有候选 credit += weight, 挑选 credit 最高的, 然后该项 credit -= totalWeight
//   长期分布严格贴合权重比, 短窗口误差极小 (方差远低于 Math.random 加权随机)
//
// 累积状态 (credit) 挂在 SWRR instance 上, 不同 candidates 组合共享同一份 credit map;
// 通过 getId 映射保证 item 增减不重置其它 item 的历史累积
export interface SwrrOptions<T> {
  /** 提取 item 唯一 id (用于 credit 状态映射) */
  getId: (item: T) => string
  /** 提取 item 权重, 应返回非负整数; <=0 视为下线 */
  getWeight: (item: T) => number
}

export class SmoothWeightedRoundRobin<T> {
  private credits: Map<string, number> = new Map()
  private readonly getId: (item: T) => string
  private readonly getWeight: (item: T) => number

  constructor(opts: SwrrOptions<T>) {
    this.getId = opts.getId
    this.getWeight = opts.getWeight
  }

  /**
   * 从候选集中挑选一个 item.
   * @returns 挑中的 item; 若候选为空 或 所有候选权重都为 0, 返回 null
   */
  pick(candidates: readonly T[]): T | null {
    if (candidates.length === 0) return null
    if (candidates.length === 1) {
      const only = candidates[0]
      const w = Math.max(0, this.getWeight(only) || 0)
      return w > 0 ? only : null
    }

    let totalWeight = 0
    const effectiveWeights: number[] = []
    for (const c of candidates) {
      const w = Math.max(0, this.getWeight(c) || 0)
      effectiveWeights.push(w)
      totalWeight += w
    }
    if (totalWeight === 0) return null

    let best: T | null = null
    let bestCredit = -Infinity
    let bestIdx = -1

    for (let i = 0; i < candidates.length; i++) {
      const w = effectiveWeights[i]
      if (w <= 0) continue // 跳过 0 权重(下线)
      const id = this.getId(candidates[i])
      const prev = this.credits.get(id) ?? 0
      const nextCredit = prev + w
      this.credits.set(id, nextCredit)
      if (nextCredit > bestCredit) {
        best = candidates[i]
        bestCredit = nextCredit
        bestIdx = i
      }
    }
    if (best !== null && bestIdx >= 0) {
      const id = this.getId(best)
      this.credits.set(id, (this.credits.get(id) ?? 0) - totalWeight)
    }
    return best
  }

  /** 手动清除某个 id 的累积 credit (如账号删除时) */
  forget(id: string): void {
    this.credits.delete(id)
  }

  /** 清空所有累积状态 */
  reset(): void {
    this.credits.clear()
  }

  /** 调试用:返回当前所有 credit 快照 */
  snapshot(): Record<string, number> {
    const obj: Record<string, number> = {}
    for (const [k, v] of this.credits) obj[k] = v
    return obj
  }
}
