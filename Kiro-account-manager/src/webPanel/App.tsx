/**
 * 面板根组件 —— 会话状态机 + 账号列表状态的唯一持有者。
 *
 * ## 会话为什么必须问服务端
 *
 * 会话装在 `HttpOnly` cookie 里（`main/webPanel/cookie.ts`），JS 读不到。
 * 所以「我登录了吗」只能靠一次 `GET /panel/api/session` 的成败判定，
 * 不能存 localStorage 标记 —— 那个标记会在 cookie 过期后继续为真，
 * 表现为「界面显示已登录，但每个按钮都失败」。
 *
 * ## 401 的统一处置
 *
 * 任何请求拿到 401 都意味着会话没了（服务端对「过期」与「缺 CSRF 头」返回同一个 401）。
 * 处置收在 `runAction` 与 `loadAccounts` 两处入口，而不是每个按钮各写一遍 ——
 * 漏一处的后果是那个按钮永远转圈不给反馈。
 *
 * ## 刷新额度的结果为什么要就地合并
 *
 * `accountService/check.ts:checkAccountStatus` **只返回结果、不落盘**：桌面端的持久化
 * 发生在 renderer store（`store/accounts.ts:1996` 收到结果后 set 并落盘）。面板走的是
 * 同一个业务函数，但没有那个 store。所以刷完再 `GET /accounts` 只会拿回盘上的旧值——
 * 必须把响应里的 usage/subscription 合并进内存中的列表项。
 * 这是本轮最重要的契约发现，已在交付报告里作为遗留缺口列出。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  checkAccount,
  fetchAccounts,
  logout as apiLogout,
  refreshToken as apiRefreshToken,
  setOverage,
  switchToCli,
  switchToIde,
  checkSession,
  fetchSubscriptions,
  type AccountListItem,
  type CheckAccountResponse
} from './api/panel'
import { PanelApiError } from './api/client'
import { LoginScreen } from './ui/LoginScreen'
import { AccountCard } from './ui/AccountCard'
import { ImportPanel } from './ui/ImportPanel'
import { ProxyPanel } from './ui/ProxyPanel'

/** 会话三态。`unknown` 是启动时的真实状态，不能默认成 `logged-out`（会闪一下登录页） */
type SessionState = 'unknown' | 'logged-in' | 'logged-out'

/** 进行中的操作：账号 id → 操作名。用 Map 而非单个 flag，允许不同账号并行 */
type PendingMap = Record<string, string>

export function App(): React.JSX.Element {
  const [session, setSession] = useState<SessionState>('unknown')
  const [accounts, setAccounts] = useState<AccountListItem[] | null>(null)
  const [pending, setPending] = useState<PendingMap>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)

  /** 会话失效的统一落点：清空数据并回登录页 */
  const dropSession = useCallback((): void => {
    setSession('logged-out')
    setAccounts(null)
    setPending({})
    setError(null)
  }, [])

  const loadAccounts = useCallback(async (): Promise<void> => {
    setListLoading(true)
    try {
      const payload = await fetchAccounts()
      setAccounts(payload.accounts)
      setError(null)
    } catch (err) {
      if (err instanceof PanelApiError && err.isUnauthorized) {
        dropSession()
        return
      }
      setError(err instanceof PanelApiError ? err.message : '加载账号列表失败')
    } finally {
      setListLoading(false)
    }
  }, [dropSession])

  // 启动时问一次服务端「这个 cookie 还有效吗」
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ok = await checkSession()
        if (cancelled) return
        setSession(ok ? 'logged-in' : 'logged-out')
      } catch {
        // 网络不通：当作未登录进登录页，但把原因写出来 ——
        // 否则用户会反复输正确的密钥却一直失败，真因是连不上面板。
        if (cancelled) return
        setSession('logged-out')
        setError('无法连接面板服务，请确认电脑端面板仍在运行且手机处于同一局域网')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 登录后拉列表
  useEffect(() => {
    if (session !== 'logged-in') return
    void loadAccounts()
  }, [session, loadAccounts])

  /**
   * 执行一个有副作用的操作。
   *
   * 同一账号同一时刻只允许一个操作在飞（按钮 disabled + 这里的守卫）。
   * 服务端 `routes.ts:singleFlight` 已做去重兜底，但客户端也拦一道 ——
   * 手机上连点两次不该让界面出现两个「刷新中…」。
   */
  const runAction = useCallback(
    async (id: string, name: string, action: () => Promise<void>): Promise<void> => {
      if (pending[id] !== undefined) return
      setPending((p) => ({ ...p, [id]: name }))
      setError(null)
      setNotice(null)
      try {
        await action()
      } catch (err) {
        if (err instanceof PanelApiError && err.isUnauthorized) {
          dropSession()
          return
        }
        setError(err instanceof PanelApiError ? err.message : '操作失败，请重试')
      } finally {
        setPending((p) => {
          const next = { ...p }
          delete next[id]
          return next
        })
      }
    },
    [pending, dropSession]
  )

  /** 把 check 的响应合并进内存列表项（见文件头「为什么要就地合并」） */
  const mergeCheckResult = useCallback((id: string, res: CheckAccountResponse): void => {
    const data = res.data
    if (!data) return
    setAccounts((prev) => {
      if (prev === null) return prev
      return prev.map((item) => {
        if (item.id !== id) return item
        const next: AccountListItem = { ...item }
        if (data.usage) {
          next.usage = { ...item.usage, ...data.usage }
        }
        if (data.subscription) {
          next.subscription = { ...item.subscription, ...data.subscription }
        }
        if (data.status !== undefined) next.status = data.status
        if (data.email !== undefined) next.email = data.email
        // 刷新成功即视为该账号当前无错误 —— 否则旧的 lastError 会一直挂着，
        // 让用户以为刷新没生效。
        if (data.status === 'active') delete next.lastError
        return next
      })
    })
  }, [])

  if (session === 'unknown') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-slate-500">
        正在检查登录状态…
      </div>
    )
  }

  if (session === 'logged-out') {
    return (
      <>
        {error !== null && (
          <div
            role="alert"
            className="mx-auto mt-4 max-w-sm rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            {error}
          </div>
        )}
        <LoginScreen
          onSuccess={() => {
            setError(null)
            setSession('logged-in')
          }}
        />
      </>
    )
  }

  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl px-4 pb-10 pt-4">
      {/* 顶栏：sticky，手机上滚很长的列表时刷新/登出仍可达 */}
      <header className="sticky top-0 z-10 -mx-4 mb-3 flex items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-4 pb-3 pt-1 backdrop-blur dark:border-slate-700 dark:bg-slate-950/95">
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          账号
          {accounts !== null && (
            <span className="ml-1.5 text-sm font-normal text-slate-500">{accounts.length}</span>
          )}
        </h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void loadAccounts()}
            disabled={listLoading}
            className="h-11 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 active:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
          >
            {listLoading ? '加载中…' : '重新加载'}
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                // 登出失败也要回登录页：本地会话已经不该继续用了
                try {
                  await apiLogout()
                } catch {
                  /* 服务端可能已失效该会话，忽略 */
                }
                dropSession()
              })()
            }}
            className="h-11 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 active:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
          >
            退出
          </button>
        </div>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="mb-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {notice !== null && (
        <div
          role="status"
          className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
        >
          {notice}
        </div>
      )}

      {/* 反代服务 —— 用户日常流程的第三、四步（选号 + 启停）。
          放最上面：日常打开面板多半是为了启停反代，而账号列表可能很长，
          放后面在手机上要一直滚。 */}
      <ProxyPanel
        accounts={accounts}
        onSessionLost={dropSession}
        onNotice={setNotice}
        onError={setError}
      />

      {/* 导入 —— 日常流程的第一步，但**频次低于启停**（账号加一次用很久），
          故排在反代之后、列表之前。导入成功后重拉列表：服务端写入已落盘，
          重拉能拿到真实的新账号（而不是把响应拼进本地状态）。 */}
      <ImportPanel onImported={() => loadAccounts()} />

      {accounts === null ? (
        <p className="py-10 text-center text-sm text-slate-500">加载中…</p>
      ) : accounts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center dark:border-slate-700">
          <p className="text-sm text-slate-600 dark:text-slate-300">还没有账号</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            用上面的「粘贴 API Key 导入账号」添加第一个账号。
          </p>
        </div>
      ) : (
        <>
          <ul aria-label="账号列表" className="space-y-3">
            {accounts.map((item) => (
              <AccountCard
                key={item.id}
                item={item}
                pending={pending[item.id] ?? null}
                onCheck={() =>
                  void runAction(item.id, 'check', async () => {
                    const res = await checkAccount(item.id)
                    // 业务层用 `success:false` + error 表达失败，HTTP 已由路由层归一；
                    // 但 `success` 缺失也是合法的（部分函数原样透传上游），所以只在显式 false 时报错。
                    if (res.success === false) {
                      setError('刷新失败，请稍后重试')
                      return
                    }
                    mergeCheckResult(item.id, res)
                  })
                }
                onRefreshToken={() =>
                  void runAction(item.id, 'refresh-token', async () => {
                    await apiRefreshToken(item.id)
                    // Token 过期时间变了，重拉列表拿新的 expiresAt（这个字段服务端确实会落盘）
                    await loadAccounts()
                    setNotice('Token 已刷新')
                  })
                }
                onSwitch={() =>
                  void runAction(item.id, 'switch', async () => {
                    await switchToIde(item.id)
                    await loadAccounts()
                    setNotice('已切换电脑端 IDE 登录态')
                  })
                }
                onSwitchCli={() =>
                  void runAction(item.id, 'switch-cli', async () => {
                    await switchToCli(item.id)
                    setNotice('已切换电脑端 CLI 登录态')
                  })
                }
                onToggleOverage={(enabled) =>
                  void runAction(item.id, 'overage', async () => {
                    await setOverage(item.id, enabled)
                    setNotice(enabled ? '已开启超额使用' : '已关闭超额使用')
                  })
                }
                onOpenSubscription={() =>
                  void runAction(item.id, 'subscription', async () => {
                    // 订阅**管理链接**端点（`GET /subscription-url`）当前不可用：
                    // 它的 subscriptionType 从 `ctx.body` 读，而服务端只对
                    // POST/PUT/PATCH 解析 body，GET 的 query 也未解析 → 永远拿不到参数；
                    // 且返回的 URL 会被响应出口的强制脱敏打码（实测 JWT 段变成 eyJhbG***EjXk）。
                    // 详见交付报告的契约发现。这里退而列出可用方案，让用户知道去桌面端办。
                    const res = await fetchSubscriptions(item.id)
                    if (res.success === false) {
                      setError('获取订阅信息失败')
                      return
                    }
                    setNotice('订阅升级/管理请在桌面端打开，面板暂只能查看方案')
                  })
                }
              />
            ))}
          </ul>
          <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
            凭据不会发送到浏览器；账号备注、分组与删除操作由服务器完成。
          </p>
        </>
      )}
    </div>
  )
}
