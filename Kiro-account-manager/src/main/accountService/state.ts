/**
 * accountData 写入收口 · revision 乐观锁仲裁
 *
 * 决策卡 §1 不变量 2：main 侧任何账号数据写入,无论来自 renderer IPC 还是 main 侧自动定时器,
 * 都必须经此函数,以防跨端（web 面板 + 桌面端）并发丢更新。
 *
 * 语义（T5~T9 已全部落地）：
 *   - opts.expectedRevision 存在时:比对陈旧 → 返回 { ok:false, code:'STALE_REVISION', currentRevision }
 *     renderer 侧 flushSaveImmediately 收到后走三方合并重放（store/syncMerge.ts）。
 *   - opts.expectedRevision 缺省时:「无仲裁直写」—— main 侧自动写路径（ProactiveRenewal /
 *     IDE 反向同步 / 关窗 flush / 退出 flush / 解封）是权威源,不参与仲裁。
 *   - 写入成功后广播 `accounts-data-changed { revision, changedIds, originId }`（payload 白名单）。
 */

/**
 * store 实例的最小接口签名。
 *
 * K-3 起改为引用 `persistence/accountStorePort` 的 `AccountStorePort` —— 此前这里、
 * `types.ts:AccountStoreRef`、`ipc/webPanelWiring.ts:WebPanelStoreRef` 三处各手抄了
 * 一份同形状声明，每份注释都写着「与 index.ts 的声明一致」。靠注释同步的副本正是
 * §4.3 要消灭的形态：改一处另两处不会报错，直到某天形状真的分叉。
 *
 * 保留 `StoreRef` 这个本地名字是为了不动本文件其余引用点（纯别名，零行为变化）。
 */
import type { AccountStorePort } from '../persistence/accountStorePort'
import { assertAccountIdentityInvariant } from '../../shared/accountIdentity'

type StoreRef = AccountStorePort

/**
 * accountData 落盘 blob 顶层结构。
 * 现有代码里各处用 inline 类型断言（accounts / groups / tags / activeAccountId / …约 26 个字段）,
 * 无 SSOT 类型定义。此处不硬编字段名,保守用 Record<string, unknown> + 显式 revision。
 * renderer 侧的字段清单 SSOT 是 store/accounts.ts:buildPersistBlob;若将来要算字段级 diff
 * （changedIds,见 BroadcastPayload 的 defer 说明）,再抽取正式 AccountsBlob 类型。
 */
export type AccountsBlob = Record<string, unknown> & {
  /** 集合级乐观锁计数。旧盘无此字段视为 0,兼容读。 */
  revision?: number
}

export type MutationInput = AccountsBlob
export type MutationOutput = AccountsBlob

/**
 * mutate 回调签名：接收当前 blob（带 revision）,返回新 blob（不需要自己递增 revision,收口函数统一 +1）。
 * 允许 async,以便将来算 changedIds（字段级 diff）时可以异步查表。
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
  /**
   * 发起本次写入的来源标识（A-I2 返修）。原样带入广播 payload,
   * 供 consumer 精确区分「自写回声」与「外部写」——而不是靠 isSyncing 时间窗猜。
   * main 侧自动写路径（ProactiveRenewal / 关窗 flush 等）不传 ⇒ 所有窗口都视为外部写。
   */
  originId?: string
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

/**
 * main 侧后台调度器读取账号盘面。
 *
 * 返回 store 当前值而非缓存：自动换号必须看见 renderer / 手机面板刚写入的阈值与账号。
 * 未装配时抛错，与写入收口一致地把启动顺序错误暴露出来。
 */
export function getAccountDataSnapshot(): AccountsBlob | null {
  if (!storeRef) {
    throw new Error(
      '[accountService/state] store not initialized. ' +
        'Call setStoreRef(store) after initStore() completes.'
    )
  }
  return (storeRef.get('accountData') as AccountsBlob | null | undefined) ?? null
}

/** 供 index.ts 收口后同步 lastSavedData 使用（避免 state.ts 反向依赖 index.ts）。 */
let lastSavedDataSetter: ((data: unknown) => void) | null = null

export function setLastSavedDataSetter(fn: (data: unknown) => void): void {
  lastSavedDataSetter = fn
}

/**
 * 收口成功后向所有 renderer 窗口广播 accounts-data-changed 事件的回调（T8 新增）。
 *
 * 通过依赖注入而非 import electron,让 state.ts 保持"纯业务逻辑 / 无 electron 依赖",
 * 单元测试可直接跑（否则 vitest node env 里 import electron 会炸）。
 *
 * 决策卡 §1 不变量 3：广播必须带 revision 反检,防止「写→广播→reload→触发写」环路抖动。
 * payload 严格白名单:仅 revision + changedIds,绝不含凭证等敏感字段（§3 输出脱敏）。
 *
 * 由 index.ts 在 initStore 完成后注入实际的 emitter 实现（`BrowserWindow.getAllWindows()`
 * 逐个 `webContents.send('accounts-data-changed', payload)`,照 kiro-ide-token-changed 先例）。
 */
export type BroadcastPayload = {
  /** 收口后的新 revision（收口内部已 +1）。renderer 用它反检:<= 本地 = 自己写的回声, > 本地 = 别人的写。 */
  revision: number
  /**
   * 变更账号 id 集合。
   *
   * ⚠️ 当前**恒为 undefined**,语义 = "未知,请全量重取"。这是**有意的 defer,不是遗漏**（m4）:
   *   现有 mutator 几乎全是"整表覆盖"（renderer.saveToStorage 一次传整表 · main 侧定时器
   *   直接改 accountData 后整体回写）,算精确 diff 需要在收口处对两份完整 blob 做逐记录比较,
   *   而 consumer 目前也只用 revision 判漂移、不消费 changedIds ⇒ 现在实现它是纯成本。
   *   保留字段声明是因为它已进 preload 契约（preload/index.d.ts:249）与决策卡链路表;
   *   删掉会让契约与文档反复来回改。
   * 何时兑现:W5 web 面板接入后若出现"只想刷新某几行"的真实需求,或 renderer 改走增量
   *   updateAccount 时。届时在 applyAccountDataMutation 内比较 prev/next 的 accounts 产出。
   */
  changedIds?: string[]
  /**
   * 触发这次写入的来源标识（A-I2 返修）。
   *
   * 为什么需要:renderer 侧原先只能用 `isSyncing` 猜「这条广播是不是我自己的回声」,
   * 而 isSyncing 窗口内到达的**别人的**写入会被一并吞掉且不留痕迹 ⇒ 永久错过。
   * main 侧写入时**知道**是谁触发的（save-accounts 携带 originId / main 侧定时器无 originId）,
   * 把它带上,consumer 就能精确区分回声与外部写,不必再靠时间窗猜。
   *
   * - 有值且等于本窗口 originId → 自写回声,忽略
   * - 无值或不等 → 外部写（main 侧定时器 / 其它窗口 / web 面板）,必须处理
   */
  originId?: string
}

let broadcaster: ((payload: BroadcastPayload) => void) | null = null

export function setBroadcaster(fn: (payload: BroadcastPayload) => void): void {
  broadcaster = fn
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
 * 成功写入后会广播 accounts-data-changed { revision, changedIds, originId }（payload 严格白名单）。
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
    // 所有桌面 IPC、手机面板与 main 后台写入最终都经过这里。
    // 在真正 set 之前比较同一记录键的旧/新身份，拒绝 A 的 id 原地变成 B。
    assertAccountIdentityInvariant(prev, next)
    const nextRevision = prev.revision + 1
    const toPersist: AccountsBlob = { ...next, revision: nextRevision }

    storeRef.set('accountData', toPersist)
    lastSavedDataSetter?.(toPersist)

    // T8 广播：收口成功后通知所有 renderer 窗口。
    // 反检依据：originId 精确判自写回声（A-I2 返修：原先仅靠 revision 比对 + isSyncing 时间窗猜,会误吃写入窗口内到达的外部写）。
    // 无脑发,payload 严格白名单 { revision, changedIds } —— 绝不含凭证。
    // broadcaster 未注入时静默跳过,不影响写入结果。
    if (broadcaster) {
      try {
        broadcaster({ revision: nextRevision, changedIds: undefined, originId: opts.originId })
      } catch (e) {
        // 广播失败不能影响主业务:renderer 端已关闭 / IPC guard 拦截 都可能抛错。
        // 精准 catch:只吞广播的错,不吞持久化的错（§4.4 分层错误）。
        console.warn('[accountService/state] broadcast failed:', e)
      }
    }

    return { ok: true, revision: nextRevision }
  }

  // 挂到串行链尾;即便当前 run 抛错,也不阻塞后续（catch 后返回 rejected 让本次调用感知,pending 恢复 resolved）
  const task = pending.then(run, run)
  pending = task.catch(() => {
    /* 吞掉链本身的 reject,避免后续调用被前一次失败阻塞;本次调用者仍会拿到 rejected task */
  })
  return task
}
