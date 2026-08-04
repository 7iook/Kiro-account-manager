/**
 * 跨端同步三方合并（C1 返修 · 决策卡 §1 不变量 2）
 *
 * 为什么需要它:
 *   accountData 的写模型是**整表覆盖**（renderer 一次传整个 accounts/groups/tags + 设置字段）。
 *   在整表模型下,「收到 STALE_REVISION 后无脑 reload」必然丢用户操作:
 *   用户删了 3 个账号 → ProactiveRenewal 在防抖窗内 bump 了 revision → 本次 flush 被拒
 *   → reload 用磁盘数据整表覆盖内存 → 那 3 个账号原样回来,且磁盘上从未写入过删除。
 *
 * 为什么必须有 base:
 *   只有 ours 和 theirs 两方时,「某 key 在 ours 里没有」是**二义**的 ——
 *   可能是"我删了它",也可能是"别人刚加了它,我还没见过"。二义无法消除 ⇒ 必然误判一种。
 *   引入 base（我这份内存状态所基于的那个磁盘快照）后语义唯一:
 *     在 base 里有、ours 里没有  → 我删的     → 结果里删除
 *     在 base 里没有、ours 里有  → 我加的     → 保留 ours
 *     在 base 里没有、theirs 里有 → 别人加的  → 采纳 theirs
 *   这就是标准三方合并,不是启发式猜测。
 */

/** accountData 顶层 blob（字段清单见 store/accounts.ts buildPersistBlob） */
export type SyncBlob = Record<string, unknown>

/** 按「记录集合」语义合并的 key（值形状为 Record<id, record>） */
export const MAP_LIKE_KEYS = ['accounts', 'groups', 'tags'] as const

export type MergeStats = {
  /** 本地改动/新增被保留的记录数 */
  localRecordsKept: number
  /** 本地未动、采纳外部改动的记录数 */
  remoteRecordsAdopted: number
  /** 本地删除意图被保留的记录数 */
  localDeletionsHonored: number
  /** 本地未动、采纳外部删除的记录数 */
  remoteDeletionsAdopted: number
  /** 本地改动被保留的标量字段名（设置项等） */
  localScalarsKept: string[]
  /**
   * 本地记录整体胜出、但其中 `credentials` 采纳了外部值的记录数（I-a）。
   * 场景:我改了备注 / 分组 / 标签,而 main 侧同时刷了这个账号的 token。
   */
  remoteCredentialsAdopted: number
}

export type MergeResult = {
  merged: SyncBlob
  stats: MergeStats
}

/**
 * 三方合并 base / ours / theirs。
 *
 * @param base   我这份内存状态所基于的磁盘快照（上次 load 或上次成功写入的内容）
 * @param ours   当前内存状态（= 用户意图已施加其上）
 * @param theirs 刚从磁盘读到的最新状态（含别人的并发改动）
 *
 * 冲突消解（记录级,不做字段级）:
 *   - 三方都有且 ours 相对 base 有变 → ours 胜（用户刚做的操作优先,绝不静默丢弃）
 *   - 三方都有且 ours 相对 base 无变 → theirs 胜（采纳外部改动,如 ProactiveRenewal 刷的 token）
 *   - theirs 删了但 ours 相对 base 改过 → 保留 ours（用户编辑优先于外部删除）
 */
export function mergeSyncBlob(base: SyncBlob, ours: SyncBlob, theirs: SyncBlob): MergeResult {
  const merged: SyncBlob = { ...theirs }
  const stats: MergeStats = {
    localRecordsKept: 0,
    remoteRecordsAdopted: 0,
    localDeletionsHonored: 0,
    remoteDeletionsAdopted: 0,
    localScalarsKept: [],
    remoteCredentialsAdopted: 0
  }

  const mapKeys = new Set<string>(MAP_LIKE_KEYS)

  // ---- 1. 集合类字段（accounts / groups / tags）按记录做三方合并 ----
  for (const key of MAP_LIKE_KEYS) {
    const baseMap = asRecord(base[key])
    const oursMap = asRecord(ours[key])
    const theirsMap = asRecord(theirs[key])

    // ours/theirs 都没有这个集合 → 不产出该字段（保持 theirs 的原样,含 undefined）
    if (ours[key] === undefined && theirs[key] === undefined) continue

    // m2:ours 里**根本没有这个集合 key** ≠ 「我把整个集合删空了」。
    // asRecord(undefined) 退化成 {} 会让 base∩theirs 的每条记录都被判为"我删的"⇒ 整个集合清空。
    // 生产上 buildPersistBlob 恒输出三个集合故不可达,但本函数是导出的纯函数（W5 web 面板可能
    // 只提交部分集合）,让它对「没参与」保持中立才是正确契约:原样采纳 theirs。
    if (ours[key] === undefined) continue

    const out: Record<string, unknown> = {}
    const allIds = new Set([...Object.keys(oursMap), ...Object.keys(theirsMap)])

    for (const id of allIds) {
      const inBase = Object.prototype.hasOwnProperty.call(baseMap, id)
      const inOurs = Object.prototype.hasOwnProperty.call(oursMap, id)
      const inTheirs = Object.prototype.hasOwnProperty.call(theirsMap, id)

      if (inOurs && inTheirs) {
        // 双方都有 → 看我这边相对 base 有没有改
        const iChanged = !inBase || !deepEqual(baseMap[id], oursMap[id])
        if (iChanged) {
          // I-a 凭证例外:ours 整条胜出时,若**我没碰过 credentials** 而别人改了它,采纳别人的。
          //
          // 为什么必须有这个例外:credentials 的权威源是 main 侧（ProactiveRenewal /
          // IDE 反向同步）,它刷新后已把新 token 写进 IDE 磁盘 token 文件（index.ts:2098）
          // 并会轮换 refreshToken（index.ts:2083）。记录级"ours 整条胜出"会把凭证回滚成旧值 ⇒
          // store 与 IDE token 文件分叉,且旧 refreshToken 可能已被上游作废 ⇒ 下次续期失败即
          // 停止调度（index.ts:2076）⇒ 可能需要用户重新登录。这不是"下次会自动补回"。
          //
          // 反过来,renderer 的 refreshAccountToken（accounts.ts:1755）也会写 credentials,
          // 那种情况下"我碰过凭证",必须保留我的值 —— 故条件是「我没改凭证」而非「一律取 theirs」。
          out[id] = mergeRecordWithCredentialException(
            baseMap[id],
            oursMap[id],
            theirsMap[id],
            inBase,
            stats
          )
          stats.localRecordsKept++
        } else {
          out[id] = theirsMap[id]
          if (!deepEqual(theirsMap[id], baseMap[id])) stats.remoteRecordsAdopted++
        }
        continue
      }

      if (inOurs && !inTheirs) {
        // 我有、别人没有 → base 里有过就是"别人删的",否则是"我新加的"
        if (inBase) {
          const iChanged = !deepEqual(baseMap[id], oursMap[id])
          if (iChanged) {
            // 我改过它、别人删了它 → 用户编辑优先(不静默丢弃用户操作)
            out[id] = oursMap[id]
            stats.localRecordsKept++
          } else {
            // 我没动过 → 采纳外部删除
            stats.remoteDeletionsAdopted++
          }
        } else {
          out[id] = oursMap[id]
          stats.localRecordsKept++
        }
        continue
      }

      // !inOurs && inTheirs → 我没有、别人有
      if (inBase) {
        // base 里有过而我现在没有 = 我删的 → 落实删除（C1 的核心）
        stats.localDeletionsHonored++
      } else {
        // base 里也没有 = 别人刚加的 → 采纳
        out[id] = theirsMap[id]
        stats.remoteRecordsAdopted++
      }
    }

    merged[key] = out
  }

  // ---- 2. 其余标量/对象字段（设置项等）：我改过的留住,没改过的采纳外部 ----
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (mapKeys.has(key)) continue
    // revision 由 theirs 决定（我们要基于它重放）,绝不能用 ours 的陈旧值
    if (key === 'revision') continue

    const inOurs = Object.prototype.hasOwnProperty.call(ours, key)
    if (!inOurs) continue

    const iChanged = !deepEqual(base[key], ours[key])
    if (iChanged) {
      merged[key] = ours[key]
      stats.localScalarsKept.push(key)
    }
    // 我没改 → merged 已经是 theirs 的值,无需动作
  }

  return { merged, stats }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * ours 整条胜出时的 `credentials` 字段级例外（I-a）。
 *
 * 只有一种情况取 theirs 的 credentials:**我没改过它,而别人改了**。
 * 其余（我改了凭证 / 别人没改 / base 缺失无从判断）一律保留 ours,保证不静默丢用户的凭证写入。
 *
 * 为什么只对 credentials 破例、不做全字段级合并:credentials 是唯一有明确「非 renderer 权威源」
 * 的字段（main 侧定时器 + IDE 磁盘 token 文件双写）,回滚它的后果是需要重新登录。其余字段
 * （note / groupId / tags / status）都由用户在界面上改,记录级"用户优先"就是正确语义。
 * 全字段级合并需要每个字段都有明确的权威源定义,那是更大的设计,不在本轮范围。
 */
function mergeRecordWithCredentialException(
  baseRec: unknown,
  oursRec: unknown,
  theirsRec: unknown,
  inBase: boolean,
  stats: MergeStats
): unknown {
  if (!inBase) return oursRec
  const b = asRecord(baseRec)
  const o = asRecord(oursRec)
  const t = asRecord(theirsRec)
  if (!('credentials' in o) || !('credentials' in t)) return oursRec

  const iChangedCreds = !deepEqual(b.credentials, o.credentials)
  const theyChangedCreds = !deepEqual(b.credentials, t.credentials)
  if (iChangedCreds || !theyChangedCreds) return oursRec

  stats.remoteCredentialsAdopted++
  return { ...o, credentials: t.credentials }
}

/**
 * 结构等价比较。用于判断「我相对 base 有没有改过这条记录 / 这个设置」。
 *
 * m1:值为 `undefined` 的 key 视为不存在。store 里确实会产生 `{ groupId: undefined }`
 * 这类对象（accounts.ts:1103）,而它序列化落盘后 key 会消失。若按 `Object.keys().length`
 * 比长度,同一份数据在"内存态"与"盘面态"下会被判为不等 ⇒ 误判"我改过" ⇒ 静默吞掉外部改动。
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual(ao[k], bo[k]))
}
