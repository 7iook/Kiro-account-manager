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
import { useCallback, useEffect, useState } from 'react'
import {
  fetchProxyStatus,
  setProxyActiveAccount,
  startProxy,
  stopProxy,
  syncProxyPool,
  type AccountListItem,
  type ProxyStatus
} from '../api/panel'
import { PanelApiError } from '../api/client'

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
                        已用 {Math.round(a.usage.percentUsed)}%
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
