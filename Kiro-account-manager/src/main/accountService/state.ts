/**
 * accountData 写入收口 · revision 乐观锁仲裁
 *
 * 决策卡 §1 不变量 2：main 侧任何账号数据写入,无论来自 renderer IPC 还是 main 侧自动定时器,
 * 都必须经此函数,以防跨端（web 面板 + 桌面端）并发丢更新。
 *
 * 本轮（W1 T5+T6 骨架）语义：
 *   - opts.expectedRevision 存在时:比对陈旧 → 返回 { ok:false, code:'STALE_REVISION', currentRevision }
 *   - opts.expectedRevision 缺省时:降级为「无仲裁直写」,保证 T7（renderer 侧适配）尚未落地前
 *     现有 renderer saveAccounts 行为不断。这是渐进迁移的关键。
 *
 * 后续（T7/T8/T9）：
 *   - renderer 侧 saveToStorage 传 expectedRevision → 触发真正的仲裁
 *   - 收口成功后广播 `accounts-data-changed { revision, changedIds }`
 *   - 补 TDD Red
 */

/** electron-store 实例的最小接口签名（与 index.ts:1762 声明一致） */
type StoreRef = {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
}

/**
 * accountData 落盘 blob 顶层结构。
 * 现有代码里各处用 inline 类型断言（accounts / groups / tags / activeAccountId / …约 26 个字段）,
 * 无 SSOT 类型定义。本轮不硬编字段名,保守用 Record<string, unknown> + 显式 revision。
 * T7 renderer 侧接通后如需字段级 diff（changedIds 计算）,再抽取正式 AccountsBlob 类型。
 */
export type AccountsBlob = Record<string, unknown> & {
  /** 集合级乐观锁计数。旧盘无此字段视为 0,兼容读。 */
  revision?: number
}

export type MutationInput = AccountsBlob
export type MutationOutput = AccountsBlob

/**
 * mutate 回调签名：接收当前 blob（带 revision）,返回新 blob（不需要自己递增 revision,收口函数统一 +1）。
 * 允许 async,以便后续 T8 广播 changedIds 计算里可能需要异步查表。
 */
export type Mutator = (
  prev: AccountsBlob & { revision: number }
) => (AccountsBlob | Promise<AccountsBlob>)

export type ApplyOpts = {
  /**
   * 客户端持有的 revision 快照。存在且与当前不匹配 → 拒收 STALE_REVISION。
   * 缺省 → 无仲裁直写（main 侧自动写路径 / T7 前渐进兼容）。
   */
  expectedRevision?: number
}

export type ApplyResult =
  | { ok: true; revision: number }
  | { ok: false; code: 'STALE_REVISION'; currentRevision: number }

/**
 * store 实例引用（由 index.ts:initStore 完成后注入）。
 * 用注入而非 import { getStore } 是为了不侵入 index.ts 现有装配次序:
 * initStore 里 store 是模块内 let 变量,直接暴露 getter 会绕不过 lazy 初始化。
 */
let storeRef: StoreRef | null = null

/** 由 index.ts:initStore 末尾调用,注入已就绪的 store 实例。 */
export function setStoreRef(s: StoreRef): void {
  storeRef = s
}

/** 供 index.ts 收口后同步 lastSavedData 使用（避免 state.ts 反向依赖 index.ts）。 */
let lastSavedDataSetter: ((data: unknown) => void) | null = null

export function setLastSavedDataSetter(fn: (data: unknown) => void): void {
  lastSavedDataSetter = fn
}

/**
 * 进程内串行锁：所有 applyAccountDataMutation 调用排队执行,防止:
 *   - 定时器 A（ProactiveRenewal）与 IPC B（save-accounts）在同一 tick 交错读改写
 *   - mutate 是 async 时,await 期间 store 被第三方改动
 * 简单的 Promise 链式即可（无需引 p-queue）。
 */
let pending: Promise<unknown> = Promise.resolve()

/**
 * 5 条写路径的统一收口 · revision 仲裁 + 递增。
 *
 * @param mutate 接收 prev（带 revision）,返回 next（不必自己改 revision,收口函数统一 +1）
 * @param opts.expectedRevision 客户端持有的 revision;不传则降级为无仲裁直写
 * @returns 成功 → { ok:true, revision };冲突 → { ok:false, code:'STALE_REVISION', currentRevision }
 *
 * 注意：本函数**不**在此轮广播 accounts-data-changed（T8 才做）。
 */
export async function applyAccountDataMutation(
  mutate: Mutator,
  opts: ApplyOpts = {}
): Promise<ApplyResult> {
  // 串行化:每次调用挂到 pending 尾部,保证读→改→写原子
  const run = async (): Promise<ApplyResult> => {
    if (!storeRef) {
      // 收口函数被调用但 store 未注入 = 装配次序 bug（initStore 未先跑）
      // 抛错而不是默默 no-op,让上层立刻看见问题（§4.4 精准 catch,不吞异常）
      throw new Error(
        '[accountService/state] store not initialized. ' +
          'Call setStoreRef(store) after initStore() completes.'
      )
    }

    const raw = storeRef.get('accountData') as AccountsBlob | null | undefined
    const prev: AccountsBlob & { revision: number } = {
      ...(raw ?? {}),
      revision: typeof raw?.revision === 'number' ? raw.revision : 0
    }

    // 仲裁：只在客户端明确传入 expectedRevision 时启用
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== prev.revision) {
      return {
        ok: false,
        code: 'STALE_REVISION',
        currentRevision: prev.revision
      }
    }

    const next = await mutate(prev)
    const nextRevision = prev.revision + 1
    const toPersist: AccountsBlob = { ...next, revision: nextRevision }

    storeRef.set('accountData', toPersist)
    lastSavedDataSetter?.(toPersist)

    return { ok: true, revision: nextRevision }
  }

  // 挂到串行链尾;即便当前 run 抛错,也不阻塞后续（catch 后返回 rejected 让本次调用感知,pending 恢复 resolved）
  const task = pending.then(run, run)
  pending = task.catch(() => {
    /* 吞掉链本身的 reject,避免后续调用被前一次失败阻塞;本次调用者仍会拿到 rejected task */
  })
  return task
}
