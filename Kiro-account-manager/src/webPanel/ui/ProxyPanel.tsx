/**
 * 反代面板 —— 用户日常流程的第三、四步：选号 + 启停
 *
 * ## 运行态绝不乐观更新
 *
 * 本组件的 `running` **只**来自 `GET /proxy/status` 的响应（服务端读的是
 * `ProxyServer.isRunning()`，即真实 server 句柄）。发出启动请求后不会先把开关
 * 拨到「运行中」再去确认 —— 桌面设置页刚犯过这个 bug：开关显示「已开启」而服务
 * 其实没绑上端口。这里的对应失效是「显示运行中而反代没起来」，用户会以为能用，
 * 结果每个请求都失败。
 *
 * 所以每个写操作之后都重新拉一次状态，以服务端读数为唯一判据。
 *
 * ## 顺序不在这一层
 *
 * 「先同步池再启动」与选号的三步顺序都在服务端（`proxy/activation.ts` 与
 * `ipc/panelProxyDeps.ts`）。这里一个动作对应一次请求，不做客户端编排 ——
 * 客户端若自己排序，就成了第二个顺序真源，两处早晚分叉。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchProxyStatus,
  releaseHeldRequests,
  setProxyActiveAccount,
  startProxy,
  stopProxy,
  syncProxyPool,
  type AccountListItem,
  type ProxyStatus,
  type PanelHoldEpisode,
  type PanelHoldRelease
} from '../api/panel'
import { PanelApiError } from '../api/client'
import { formatCountdown, formatPercent } from './format'

interface ProxyPanelProps {
  /** 账号列表（已由 App 加载）—— 选号弹窗的候选来源 */
  accounts: AccountListItem[] | null
  /** 会话失效时通知 App 回登录页 */
  onSessionLost: () => void
  onNotice: (msg: string) => void
  /**
   * 错误上报给 App 的统一错误出口。
   *
   * 本组件刻意**不**自己渲染 `role="alert"` 框：页面上同时存在两个 alert 会让
   * 屏幕阅读器读出两条警报，且「当前有什么错」变成两个真源。App 顶部那一个
   * 已经是错误展示的收口点，这里只上报内容。
   */
  onError: (msg: string) => void
}

/**
 * 越过放行时刻后，等这么久再去重新取数。
 *
 * 不是 0：`nextAutoReleaseAt` 由服务端定时器产出，而倒计时用的是**手机自己的时钟**。
 * 两者有偏差时（手机快几百毫秒、或推进 `nextAt` 的那一拍还在事件循环里排队），
 * 到点即问会拿回同一个旧时刻。这点余量让绝大多数情况一次就取到新周期。
 */
const RECONCILE_GRACE_MS = 1500

/**
 * 取回来仍是同一个（已过期的）时刻时的重试间隔。
 *
 * 说明服务端这一拍确实还没走完（时钟偏差比余量大，或反代正忙）。此时**降频**重试而不是
 * 每秒追问：倒计时已经显示「即将放行」，用户看到的信息是对的，缺的只是新周期的数字。
 * 一旦服务端推进了 `nextAutoReleaseAt`，本效应会因依赖变化而重建，重试随之停止 ——
 * 所以这个循环是自终止的，不会变成常驻轮询。
 */
const RECONCILE_RETRY_MS = 15_000

/**
 * 错误文案取 `PanelApiError.message`。
 *
 * 刻意**不**在这里再写一张 code → 文案表：`api/client.ts:ERROR_TEXT` 已经是
 * 那张表的唯一真源（且它同时是 `isPanelErrorCode` 的判据）。第二份表会漂移，
 * 表现为同一个错误码在不同界面显示不同说明。
 */
function describeError(err: unknown): string {
  if (err instanceof PanelApiError) return err.message
  return '操作失败，请重试'
}

export function ProxyPanel({
  accounts,
  onSessionLost,
  onNotice,
  onError
}: ProxyPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  /**
   * 本地时钟，仅用于渲染倒计时。
   *
   * 服务端只给 `nextAutoReleaseAt`（绝对 epoch ms），倒计时在这里本地自减 ——
   * **绝不轮询服务端拿倒计时数值**：倒计时是连续量，轮询它会让请求频率被刷新率
   * 绑架（手机上还意味着持续耗电与流量）。
   */
  const [now, setNow] = useState(() => Date.now())

  /** 拉真实状态。所有写操作之后都要调它 —— 这是运行态的唯一判据 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchProxyStatus())
    } catch (err) {
      if (err instanceof PanelApiError && err.isUnauthorized) {
        onSessionLost()
        return
      }
      onError(describeError(err))
    }
  }, [onSessionLost, onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 最新的 `refresh`，供下面两个「按时机重新对齐」的效应调用。
   *
   * 为什么用 ref 而不是把 `refresh` 写进依赖：那两个效应的重建时机应当只由
   * **服务端读数**（`nextAutoReleaseAt`）决定。若依赖里带上 `refresh`，父组件换一个
   * `onError` 回调身份就会重建定时器、把已经走过的等待清零 —— 表现为「界面偶尔就是不更新」，
   * 且与放行周期毫无关系，极难定位。
   */
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  /**
   * 倒计时的本地心跳。
   *
   * 只在**真有下一次放行**时起表 —— 没有 `nextAutoReleaseAt` 时空转会让手机在后台
   * 每秒重渲染一次，白耗电。依赖里带上 `nextAutoReleaseAt`，它变化时重建计时器。
   */
  const nextAt = status?.nextAutoReleaseAt
  useEffect(() => {
    if (nextAt === null || nextAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [nextAt])

  /**
   * 跨放行周期后与服务端重新对齐。
   *
   * ## 为什么必须有这一段
   *
   * 桌面端消费推送事件（`onProxyHeldRequestsChanged`），周期一过自然拿到新读数；
   * **面板没有那条推送通道**。挂载时拉一次之后，界面对服务端的认知就永久停在那一刻：
   * 服务端在 T1 放行并排好 T2，手机却继续拿本地时钟去减那个作废的 T1 ——
   * 渲染成永久「即将放行」、次数永远是挂载时那个数，除非用户手动刷新或做一次写操作。
   *
   * ## 为什么这不违反「倒计时不轮询」
   *
   * 决策卡禁的是「每秒向服务端要一个递减的数值」（连续量被刷新率绑架）。这里是
   * **事件驱动**：只在「本地时钟越过了服务端给的那个时刻」这一个离散事件上取一次数。
   * 一个 8 分钟周期 = 一次请求，与倒计时刷新率无关。倒计时本身仍然纯本地自减
   * （上面那个 1 秒心跳一个字节都没往外发）。
   *
   * ## 手机侧的取舍
   *
   * - 没有下一次放行（`null`）时**不挂任何表** —— 保持既有的「不空转」性质。
   * - 时刻已过（重新取回来还是旧值 / 后台挂了一小时回来）→ 按 `RECONCILE_RETRY_MS`
   *   降频重试，不是每秒追问。
   * - 后台被冻结的标签页里定时器本就不跑；回到前台由下面的 `visibilitychange` 兜住，
   *   这也是本效应在长时间后台后能立刻收敛的原因。
   */
  useEffect(() => {
    if (nextAt === null || nextAt === undefined) return
    const delay = nextAt - Date.now()
    // 已过期 → 降频重试；未到点 → 到点后加一点余量再问。
    const wait = delay <= 0 ? RECONCILE_RETRY_MS : delay + RECONCILE_GRACE_MS
    const timer = setTimeout(() => {
      void refreshRef.current()
    }, wait)
    return () => clearTimeout(timer)
  }, [nextAt])

  /**
   * 回到前台时重新对齐。
   *
   * 手机上息屏 / 切走后浏览器会冻结定时器，回来时本地时钟可能已远远越过那个时刻
   * （放了好几轮）。上面的定时器在冻结期间不触发，所以**必须**在可见性恢复时补一次 ——
   * 否则用户切回来看到的是一个陈旧界面，而这正是最常见的使用姿势（锁屏、过一会儿再看）。
   *
   * 只在**有下一次放行**时监听：反代没跑 / 自动放行关着时，切前台不该产生任何请求。
   */
  useEffect(() => {
    if (nextAt === null || nextAt === undefined) return
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [nextAt])

  const run = useCallback(
    async (name: string, action: () => Promise<void>): Promise<void> => {
      if (busy !== null) return
      setBusy(name)
      try {
        await action()
      } catch (err) {
        if (err instanceof PanelApiError && err.isUnauthorized) {
          onSessionLost()
          return
        }
        onError(describeError(err))
      } finally {
        // 无论成败都重新拉状态：失败时界面也必须反映真实运行态，
        // 而不是停留在操作前的假设上。
        await refresh()
        setBusy(null)
      }
    },
    [busy, onSessionLost, refresh, onError]
  )

  const running = status?.running === true
  const selectedEmail =
    status?.selectedAccountEmail ??
    accounts?.find((a) => a.id === status?.selectedAccountId)?.email ??
    status?.selectedAccountId

  return (
    <section
      aria-label="反代服务"
      className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">反代服务</h2>
          <p className="mt-1 flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                running ? 'bg-emerald-500' : 'bg-slate-400'
              }`}
            />
            <span className={running ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500'}>
              {status === null ? '读取中…' : running ? `运行中 · 端口 ${status.port ?? '—'}` : '未运行'}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            void run(running ? 'stop' : 'start', async () => {
              if (running) {
                await stopProxy()
                onNotice('反代已停止')
              } else {
                const r = await startProxy()
                onNotice(`反代已启动 · 账号池 ${r.poolSize ?? 0} 个`)
              }
            })
          }
          disabled={busy !== null || status === null}
          className={`h-11 shrink-0 rounded-xl px-4 text-sm font-medium disabled:opacity-60 ${
            running
              ? 'border border-red-300 text-red-700 active:bg-red-50 dark:border-red-800 dark:text-red-300 dark:active:bg-red-950'
              : 'bg-emerald-600 text-white active:bg-emerald-700'
          }`}
        >
          {busy === 'start' ? '启动中…' : busy === 'stop' ? '停止中…' : running ? '停止' : '启动'}
        </button>
      </div>

      {/* 当前账号 + 选号入口 */}
      <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 dark:text-slate-400">当前账号</p>
            <p className="truncate text-sm text-slate-800 dark:text-slate-200">
              {status?.enableMultiAccount === true
                ? '多账号轮询中'
                : (selectedEmail ?? '未指定（用第一个可用账号）')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={busy !== null || !running}
            className="h-11 shrink-0 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
          >
            选择账号
          </button>
        </div>
        {!running && (
          // 选号需要反代在运行（服务端会返回 PROXY_NOT_RUNNING）。把原因说在前面，
          // 而不是让用户点了才看到报错。
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            选择账号需要反代处于运行状态
          </p>
        )}
        {status?.enableMultiAccount === true && running && (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
            当前是多账号轮询模式，选择账号只会让轮询从该账号开始，不会固定用它。
            要固定单个账号请在桌面端关闭多账号轮询。
          </p>
        )}
      </div>

      {/* 账号池 + 请求统计。停止会掐断在飞请求，这些数字是用户自己判断的依据 */}
      {status !== null && (
        <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-center dark:border-slate-800">
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">账号池</dt>
            <dd className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {status.availableCount}/{status.poolSize}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">已服务</dt>
            <dd className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {status.totalRequests}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">失败</dt>
            <dd
              className={`text-sm font-medium ${
                status.failedRequests > 0
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-slate-800 dark:text-slate-200'
              }`}
            >
              {status.failedRequests}
            </dd>
          </div>
        </dl>
      )}

      {running && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          停止会中断正在进行的请求。已服务 {status?.totalRequests ?? 0} 次。
        </p>
      )}

      {/*
        自动放行读数 + 立即放行。
        账号不可用时反代把客户端请求挂起等待恢复，调度器周期性放行一次让客户端的
        idle 看守不把请求掐断。这里让用户在手机上看到「还有多久放下一次 / 已放了几次」，
        并能立刻补一次（例如刚换了新号，不想等剩余时间）。
        刻意**没有**间隔与开关控件 —— 配置留在桌面端（手机误触代价大于收益）。
      */}
      <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              自动放行
              {status?.autoReleaseEnabled === true ? (
                <span className="ml-1 text-emerald-700 dark:text-emerald-400">已开启</span>
              ) : (
                <span className="ml-1 text-slate-400">未开启</span>
              )}
            </p>
            <p className="mt-0.5 flex items-baseline gap-3 text-sm text-slate-800 dark:text-slate-200">
              <span>
                <span className="text-xs text-slate-500 dark:text-slate-400">下次 </span>
                {/* 绝对时间戳 → 本地倒计时。null 显示「-」而不是 0:00（0 是合法 epoch） */}
                {formatCountdown(status?.nextAutoReleaseAt, now)}
              </span>
              <span>
                <span className="text-xs text-slate-500 dark:text-slate-400">已放行 </span>
                {status?.autoReleaseCount ?? 0}
                <span className="text-xs text-slate-500 dark:text-slate-400"> 次</span>
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              void run('release', async () => {
                // `released` 是必填契约（`api/panel.ts`）—— 不写 `?? 0`：那会把
                // 「服务端没给放行数」静默说成「当前没有挂起的请求」。
                const { released } = await releaseHeldRequests()
                // released=0 不是失败 —— 放行是幂等的，「点了没东西可放」是正常结果。
                // 如实说出来，而不是报错让用户以为坏了。
                onNotice(released > 0 ? `已放行 ${released} 个挂起请求` : '当前没有挂起的请求')
              })
            }
            disabled={busy !== null || !running}
            className="h-11 shrink-0 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
          >
            {busy === 'release' ? '放行中…' : '立即放行'}
          </button>
        </div>
        {!running && (
          // 放行需要反代在运行（服务端会返回 PROXY_NOT_RUNNING）。原因说在前面，
          // 而不是让用户点了才看到报错。
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            放行需要反代处于运行状态
          </p>
        )}
        {/* Hold timeline: why it started, when, and what each release led to.
            A run of "又挂回" means those releases did not deliver content to the client. */}
        <HoldTimelineBlock current={status?.currentEpisode ?? null} recent={status?.recentEpisodes ?? []} now={now} />
      </div>

      <button
        type="button"
        onClick={() =>
          void run('sync', async () => {
            const r = await syncProxyPool()
            onNotice(`账号池已同步 · ${r.poolSize ?? 0} 个账号`)
          })
        }
        disabled={busy !== null || !running}
        className="mt-3 h-11 w-full rounded-xl border border-slate-300 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
      >
        {busy === 'sync' ? '同步中…' : '重新同步账号池'}
      </button>

      {picking && (
        <AccountPicker
          accounts={accounts}
          selectedId={status?.selectedAccountId}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false)
            void run('activate', async () => {
              const r = await setProxyActiveAccount(id)
              onNotice(`反代已切换到 ${r.email ?? id}`)
            })
          }}
        />
      )}
    </section>
  )
}

interface AccountPickerProps {
  accounts: AccountListItem[] | null
  selectedId?: string
  onClose: () => void
  onPick: (id: string) => void
}

/**
 * 选号弹窗。
 *
 * **候选范围与桌面端 `AccountSelectDialog` 一致:列出全部账号,不按状态筛。**
 *
 * 曾经这里多了一层 `filter(a => a.status === 'active')`,理由写的是「其余账号服务端会以
 * ACCOUNT_NOT_IN_POOL 拒绝,列出来只会让用户白点」。实测推翻(2026-08-05,用户在手机上
 * 报「选择账号什么都列不出来」):7 个账号里 6 个 `status='error'`,但它们全部能正常刷出
 * 额度数据 —— `status` 并不可靠到能拿来当「能不能选」的判据;而这层过滤把候选从 7 个
 * 砍到 1 个(仅剩的那一个恰好就是当前已选中的),表现为功能完全不可用。
 *
 * 桌面端的做法是「全部列出」——`AccountSelectDialog` 里只有搜索框会过滤,全文不用 status
 * 做筛选。选了不可用的号失败是一次可恢复的报错,而看不到号、无法选是死路。两端候选范围
 * 必须一致,否则同一个号在桌面能选、在手机上凭空消失。
 */
function AccountPicker({ accounts, selectedId, onClose, onPick }: AccountPickerProps): React.JSX.Element {
  const usable = accounts ?? []
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div
        role="dialog"
        aria-label="选择反代账号"
        className="relative max-h-[70dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl dark:bg-slate-900"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">选择反代账号</h3>
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl px-3 text-sm text-slate-600 active:bg-slate-100 dark:text-slate-300 dark:active:bg-slate-800"
          >
            取消
          </button>
        </div>
        {usable.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">暂无账号</p>
        ) : (
          <ul className="space-y-2">
            {usable.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onPick(a.id)}
                  className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left active:bg-slate-100 dark:active:bg-slate-800 ${
                    a.id === selectedId
                      ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950'
                      : 'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-800 dark:text-slate-200">
                      {a.email ?? a.nickname ?? a.id}
                    </span>
                    {a.usage?.percentUsed !== undefined && (
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        已用 {formatPercent(a.usage.percentUsed)}
                      </span>
                    )}
                  </span>
                  {a.id === selectedId && (
                    <span className="shrink-0 text-xs text-emerald-700 dark:text-emerald-400">当前</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** epoch ms -> HH:MM:SS(本地时区)。时间线看的是本轮会话内的钟点,不显示日期。 */
function holdClockTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 时长 ms -> 「X 分 Y 秒」/「Y 秒」。 */
function holdDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

const HOLD_REASON_TEXT: Record<PanelHoldEpisode['reason'], string> = {
  'account-blocked': '账号封禁或额度上限',
  'account-auth-failure': '账号授权失效',
  'pool-empty': '池内无号可试'
}

const HOLD_TRIGGER_TEXT: Record<PanelHoldRelease['trigger'], string> = {
  auto: '定时',
  manual: '手动',
  'pool-available': '池恢复',
  poll: '轮询'
}

/**
 * 放行结局的显示样式。
 *
 * 这一列是整个时间线里最要紧的信息：它区分两种结果相反的情况。
 * - `resumed-and-served`：放行真的拿到号并转发成功 → 客户端收到真实内容 → 它的空闲看守重新计时
 * - `re-held`：放行没找到号，请求立刻又挂回去 → 客户端只看到心跳 → 看守**没有**重新计时
 *
 * 所以连续几行「又挂回」意味着「已放行 N 次」这个数字并不代表请求能一直活着。
 */
const HOLD_OUTCOME_STYLE: Record<
  PanelHoldRelease['outcome'],
  { text: string; cls: string }
> = {
  'resumed-and-served': { text: '已续接', cls: 'text-emerald-700 dark:text-emerald-400' },
  're-held': { text: '又挂回', cls: 'text-amber-700 dark:text-amber-400' },
  ended: { text: '已结束', cls: 'text-rose-700 dark:text-rose-400' },
  pending: { text: '进行中', cls: 'text-slate-400' }
}

/** 一轮挂起里的放行明细（最新在前 —— 长时间挂起时用户最关心刚刚那几次）。 */
function HoldReleaseList({ ep }: { ep: PanelHoldEpisode }): React.JSX.Element {
  if (ep.releases.length === 0) {
    return <p className="mt-0.5 pl-3 text-xs text-slate-400">尚未放行过</p>
  }
  const omittedCount = Math.max(0, ep.totalReleaseCount - ep.releases.length)
  return (
    <div className="mt-0.5 space-y-0.5 pl-3">
      {omittedCount > 0 && (
        <p className="text-xs text-slate-400">
          仅显示最近 {ep.releases.length} 条，前 {omittedCount} 条已省略
        </p>
      )}
      {[...ep.releases].reverse().map((r, i) => {
        const style = HOLD_OUTCOME_STYLE[r.outcome]
        return (
          <p
            key={`${ep.id}-${r.at}-${i}`}
            className="flex items-baseline gap-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-300"
          >
            <span className="text-slate-400">#{ep.totalReleaseCount - i}</span>
            <span>{holdClockTime(r.at)}</span>
            <span className="text-slate-400">{HOLD_TRIGGER_TEXT[r.trigger]}</span>
            <span className="text-slate-400">→</span>
            <span className={style.cls}>{style.text}</span>
            {r.outcomeAt !== null && r.outcomeAt > r.at && (
              <span className="text-slate-400">（{holdDuration(r.outcomeAt - r.at)}）</span>
            )}
          </p>
        )
      })}
    </div>
  )
}

/**
 * 手机端挂起时间线 —— 只读，无任何操作入口。
 *
 * 「只看不改」是既有的面板边界（`routes.ts` 刻意不接受配置参数：手机误触代价大于收益），
 * 本区块沿用它 —— 放行按钮已在上方，这里不再重复提供动作。
 *
 * `now` 由父组件的秒级心跳传入，不自建定时器：父组件已有一个用于倒计时的 1s tick，
 * 再开一个只会让手机多一次重渲染。无挂起记录时整块不渲染，不占屏。
 */
function HoldTimelineBlock({
  current,
  recent,
  now
}: {
  current: PanelHoldEpisode | null
  recent: PanelHoldEpisode[]
  now: number
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (!current && recent.length === 0) return null

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <p className="text-xs text-slate-500 dark:text-slate-400">挂起时间线（本轮会话）</p>

      {current && (
        <div className="mt-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-slate-800 dark:text-slate-200">
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-400">
              挂起中
            </span>
            <span>{HOLD_REASON_TEXT[current.reason]}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              始于 {holdClockTime(current.startedAt)}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              （{holdDuration(now - current.startedAt)}）
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              已放行 {current.totalReleaseCount} 次
            </span>
          </p>
          {current.detail.length > 0 && (
            <p className="mt-0.5 break-all pl-3 text-xs text-slate-500 dark:text-slate-400">
              {current.detail.join(' · ')}
            </p>
          )}
          <HoldReleaseList ep={current} />
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="h-11 text-xs text-slate-500 underline-offset-2 active:underline dark:text-slate-400"
          >
            {expanded ? '收起' : `更早的挂起轮次（${recent.length}）`}
          </button>
          {expanded && (
            <div className="space-y-1.5">
              {recent.map((ep) => (
                <div key={ep.id}>
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs tabular-nums text-slate-600 dark:text-slate-300">
                    <span className="text-slate-400">{HOLD_REASON_TEXT[ep.reason]}</span>
                    <span>{holdClockTime(ep.startedAt)}</span>
                    {ep.endedAt !== null && (
                      <>
                        <span className="text-slate-400">→</span>
                        <span>{holdClockTime(ep.endedAt)}</span>
                        <span className="text-slate-400">
                          （{holdDuration(ep.endedAt - ep.startedAt)}）
                        </span>
                      </>
                    )}
                    <span className="text-slate-400">{ep.totalReleaseCount} 次</span>
                  </p>
                  <HoldReleaseList ep={ep} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
