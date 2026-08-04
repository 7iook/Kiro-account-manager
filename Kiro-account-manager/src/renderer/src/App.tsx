import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AccountManager } from './components/accounts'
import { Sidebar, TitleBar, type PageType } from './components/layout'
import { HomePage, AboutPage, SettingsPage, MachineIdPage, KiroSettingsPage, ProxyPage, KProxyPage, ProxyPoolPage, WebhooksPage, DiagnosePage, ConfigSyncPage, RegisterPage, SubscriptionPage, LogsPage } from './components/pages'
import { useWebhookStore } from './store/webhooks'
import { UpdateDialog } from './components/UpdateDialog'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { SyncErrorNotice } from './components/SyncErrorNotice'
import { useAccountsStore, isBannedAccountError, SYNC_ORIGIN_ID } from './store/accounts'

// 存盘 revision 短轮询间隔（I3 · 决策卡兜底列要求"5s 级"）。
// 轻量:仅比对 revision,相同则不做整表 set（见 store.syncIfRevisionDrifted）。
//
// ⚠️ 刻意取 5000 的**质数邻近值**而非 5000（C1-again 返修）:
//   accounts.ts 的 SAVE_MAX_WAIT_MS 也是 5000。两个同周期定时器会**系统性共振** ——
//   每一轮防抖最大等待都恰好与一次轮询对齐,撞车不再是偶发而是稳定发生。
//   加上抖动后两者相位持续漂移,任何单次对齐都不会重复出现。
const REVISION_POLL_BASE_MS = 5300
/** 每轮随机抖动上限,进一步打散与其它周期性任务（自动保存 30s / token 刷新等）的相位 */
const REVISION_POLL_JITTER_MS = 700

// 托盘信息防抖延迟：后台刷新风暴时合并多次跨进程 IPC 为单次
const TRAY_UPDATE_DEBOUNCE_MS = 400
// 后台刷新结果批量化间隔：N 条结果合并到一次 set，避免 N 次 Map 全量复制 + 渲染抖动
const BACKGROUND_RESULT_FLUSH_MS = 120

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)

  const {
    loadFromStorage,
    startAutoTokenRefresh,
    stopAutoTokenRefresh,
    applyBackgroundRefreshResults,
    applyBackgroundCheckResults,
    flushSaveImmediately,
    accounts,
    activeAccountId,
    setActiveAccount,
    checkAndRefreshExpiringTokens,
    updateAccountStatus,
    updateAccount
  } = useAccountsStore()

  // 切换到下一个可用账户
  const switchToNextAccount = useCallback(() => {
    const activeAccounts = Array.from(accounts.values()).filter(acc => acc.status === 'active')
    if (activeAccounts.length <= 1) return

    const currentIndex = activeAccounts.findIndex(acc => acc.id === activeAccountId)
    const nextIndex = (currentIndex + 1) % activeAccounts.length
    setActiveAccount(activeAccounts[nextIndex].id)
  }, [accounts, activeAccountId, setActiveAccount])

  // 托盘信息防抖：账号 Map 频繁变更（后台刷新风暴）时合并 N 次 IPC 为 1 次
  const trayDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateTrayInfo = useCallback(() => {
    if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    trayDebounceRef.current = setTimeout(() => {
      trayDebounceRef.current = null
      const currentState = useAccountsStore.getState()
      const currentAccounts = currentState.accounts
      const currentActiveId = currentState.activeAccountId

      const accountList = Array.from(currentAccounts.values()).map(acc => ({
        id: acc.id,
        email: acc.email || 'Unknown',
        idp: acc.idp || 'Unknown',
        status: acc.status
      }))
      window.api.updateTrayAccountList(accountList)

      if (currentActiveId) {
        const activeAccount = currentAccounts.get(currentActiveId)
        if (activeAccount) {
          window.api.updateTrayAccount({
            id: activeAccount.id,
            email: activeAccount.email || 'Unknown',
            idp: activeAccount.idp || 'Unknown',
            status: activeAccount.status,
            subscription: activeAccount.subscription?.title || undefined,
            usage: activeAccount.usage ? {
              usedCredits: activeAccount.usage.current || 0,
              totalCredits: activeAccount.usage.limit || 0,
              totalRequests: 0,
              successRequests: 0,
              failedRequests: 0
            } : undefined
          })
        } else {
          window.api.updateTrayAccount(null)
        }
      } else {
        window.api.updateTrayAccount(null)
      }
    }, TRAY_UPDATE_DEBOUNCE_MS)
  }, [])

  // 应用启动时加载数据并启动自动刷新
  useEffect(() => {
    loadFromStorage().then(() => {
      startAutoTokenRefresh()
    })
    // 同步主动续期开关（持久化在 main 进程的 electron-store）
    useAccountsStore.getState().loadProactiveRenewalEnabled()
    // 加载 Webhook 配置
    useWebhookStore.getState().loadFromStorage()

    return () => {
      stopAutoTokenRefresh()
    }
  }, [loadFromStorage, startAutoTokenRefresh, stopAutoTokenRefresh])

  // 订阅 Kiro IDE 自己 refresh token 后反代检测到的事件
  // 触发时间点：Kiro IDE 在后台 refresh loop 把磁盘 token 写新了，反代 watcher 反向同步到 store
  // 这里收到事件后同步账号数据，让 UI 立刻显示最新 expiresAt / accessToken
  //
  // C1-again:原实现无条件 loadFromStorage() —— 那是**第 4 条无守卫的整表覆盖通道**,
  // 且比另外三条更狠(还会跑 syncLocalSsoAccountAsync 重新导入本机 SSO = 幽灵账号回归)。
  // ProactiveRenewal 刷 token 时同时发这个事件与 accounts-data-changed,于是防抖窗内
  // 用户的删除会被这条通道复活。改走与其余三条同一套 dirty 守卫 + revision 比对。
  useEffect(() => {
    if (typeof window.api.onKiroIdeTokenChanged !== 'function') return
    const unsubscribe = window.api.onKiroIdeTokenChanged((data) => {
      console.log(`[App] Kiro IDE refreshed token for account ${data.accountId} (${data.reason}), syncing...`)
      void useAccountsStore
        .getState()
        .syncAfterIdeTokenChanged()
        .catch((e) => console.warn('[App] sync after IDE token change failed:', e))
    })
    return unsubscribe
  }, [])

  // T8 · 决策卡 §1 不变量 3 · 订阅账号数据变更广播
  //   触发时间点:main 侧任何 applyAccountDataMutation 成功后(本进程 save-accounts / ProactiveRenewal /
  //             关窗 flush / 退出 flush / 解封 / 未来 web 面板)
  //
  // 反检依据 = originId（A-I2 返修 · 取代原来的 isSyncing 时间窗）:
  //   ① originId === SYNC_ORIGIN_ID  → 自写回声,忽略（IPC response 会正确 set revision）
  //   ② 否则 = 真正的外部写（ProactiveRenewal / IDE 反向同步 / 其它窗口 / 未来 web 端）
  //        - 本机写入不在途 → 立即 reloadFromStorageQuiet
  //        - 本机写入在途   → noteExternalRevision 记账,flush 结束后由 finally 对账补拉
  //
  // 为什么不再用 isSyncing 判回声:时间窗无法区分「我的回声」与「恰好落在窗口内的外部写」,
  // 两者一起被吞且不留痕迹;本机写入随后把 revision 推得更高 ⇒ revision 反检此后永久失效
  // ⇒ 用户若不再编辑,那次外部改动永远看不到（reviewer A-I2 证实的永久漏消息路径）。
  useEffect(() => {
    if (typeof window.api.onAccountsDataChanged !== 'function') return
    const unsubscribe = window.api.onAccountsDataChanged((data) => {
      const store = useAccountsStore.getState()

      if (data.originId && data.originId === SYNC_ORIGIN_ID) {
        // 自写回声:本窗口自己触发的写入。忽略,但仍登记（selfOrigin 会被 store 直接丢弃）
        store.noteExternalRevision(data.revision, { selfOrigin: true })
        return
      }

      // 外部写:先记账（即便随后因写入在途而暂不拉取,也绝不丢失这个信号）
      store.noteExternalRevision(data.revision)

      if (store.isSyncing) {
        console.log(
          `[App] accounts-data-changed (server=${data.revision}) arrived mid-save; deferred to reconcile`
        )
        return
      }

      console.log(
        `[App] accounts-data-changed (server=${data.revision}, local=${store.currentRevision}); reloading quietly`
      )
      void store
        .reconcilePendingExternalRevision()
        .catch((e) => console.warn('[App] reconcilePendingExternalRevision failed:', e))
    })
    return unsubscribe
  }, [])

  // I3 · 决策卡「跨端同步机制」表格兜底列:窗口聚焦时比对 revision,不一致则拉取 + 短轮询。
  //
  // 为什么必须有:广播是**不可靠**通道（窗口销毁 / IPC guard 拦截 / send 抛错 / 主进程在
  // renderer 未就绪时写入 —— broadcaster 的 catch 只 warn 不重发）。若广播是唯一通道,
  // 任何一次丢失都会让桌面端停在陈旧数据上直到用户下次编辑。兜底把「丢消息」从永久降为最多 5s。
  useEffect(() => {
    const reconcile = (): void => {
      void useAccountsStore
        .getState()
        .syncIfRevisionDrifted()
        .catch((e) => console.warn('[App] syncIfRevisionDrifted failed:', e))
    }

    const onFocus = (): void => reconcile()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') reconcile()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    // 短轮询:只做一次轻量 revision 比对（相同则不整表 set,见 store.syncIfRevisionDrifted）。
    // 用「自重排的 setTimeout + 抖动」而不是 setInterval:固定周期会与 SAVE_MAX_WAIT_MS 共振
    // （两者原本都是 5000ms ⇒ 每轮都对齐 ⇒ 撞车由偶发变稳定）。每轮重算延迟使相位持续漂移。
    // 顺带:窗口不可见时跳过读盘（focus / visibilitychange 会在回到前台时立刻补一次）。
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleNextPoll = (): void => {
      pollTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') reconcile()
        scheduleNextPoll()
      }, REVISION_POLL_BASE_MS + Math.floor(Math.random() * REVISION_POLL_JITTER_MS))
    }
    scheduleNextPoll()

    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [])

  // C2 的提示逻辑放在 <SyncErrorNotice /> 组件里（见 JSX 挂载点）,不在此处内联 ——
  // 单一实现点,且可被组件测试直接覆盖。

  // 反代关键事件 → 触发 webhook（v1.8 新增）
  // 由 main/proxyServer 内置的 webhookTrigger 通过 IPC 推送过来，统一在 renderer 调 useWebhookStore
  useEffect(() => {
    const unsubscribe = window.api.onProxyWebhookTrigger?.((event, payload) => {
      try {
        const store = useWebhookStore.getState()
        // 映射反代事件名 → Webhook 事件类型
        const webhookEventMap: Record<string, 'risk-warning' | 'account-banned'> = {
          'proxy-account-suspended': 'account-banned',
          'proxy-all-exhausted': 'risk-warning'
        }
        const targetEvent = webhookEventMap[event] || 'risk-warning'
        // 规范化 level（main 用 'error'/'info' 等字符串字面量，需要映射到 store 接受的类型）
        const rawLevel = (payload as { level?: string })?.level
        const level: 'info' | 'warn' | 'error' | 'success' =
          rawLevel === 'error' ? 'error'
          : rawLevel === 'info' ? 'info'
          : rawLevel === 'success' ? 'success'
          : 'warn'
        void store.triggerEvent(targetEvent, {
          title: String((payload as Record<string, unknown>).title ?? '反代告警'),
          message: String((payload as Record<string, unknown>).message ?? ''),
          level,
          fields: (payload as { fields?: Record<string, string | number> })?.fields
        })
      } catch (err) {
        console.error('[App] Proxy webhook trigger failed:', err)
      }
    })
    return () => { unsubscribe?.() }
  }, [])

  // 应用内页面跳转（轻量 CustomEvent，供深层组件无需 prop 钻取即可切页）
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<PageType>).detail
      if (detail) setCurrentPage(detail)
    }
    window.addEventListener('navigate-page', handler)
    return () => window.removeEventListener('navigate-page', handler)
  }, [])

  // 新增封禁账号 → 桌面通知（仅"新封禁"弹一次，去重 + 启动宽限期避免初次加载/批量刷新时刷屏）
  const bannedNotifyStartRef = useRef(Date.now())
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const KEY = 'kiro-notified-banned-ids'
    let notifiedSet: Set<string>
    try {
      notifiedSet = new Set<string>(JSON.parse(localStorage.getItem(KEY) || '[]'))
    } catch {
      notifiedSet = new Set<string>()
    }

    const currentBanned: string[] = []
    const fresh: { email: string; nickname?: string }[] = []
    for (const a of accounts.values()) {
      if (isBannedAccountError(a.lastError)) {
        currentBanned.push(a.id)
        if (!notifiedSet.has(a.id)) fresh.push({ email: a.email, nickname: a.nickname })
      }
    }

    // 启动后 8s 内只建立基线、不弹通知（覆盖异步加载 + 首次状态检查），之后才对新封禁弹窗
    const inGracePeriod = Date.now() - bannedNotifyStartRef.current < 8000
    if (!inGracePeriod && fresh.length > 0 && Notification.permission !== 'denied') {
      const fire = (): void => {
        const lang = useAccountsStore.getState().language
        const isEn = lang === 'en' || (lang === 'auto' && !navigator.language.startsWith('zh'))
        const title = fresh.length === 1
          ? (isEn ? 'Account banned' : '账号被封禁')
          : (isEn ? `${fresh.length} accounts banned` : `${fresh.length} 个账号被封禁`)
        const names = fresh.slice(0, 3).map((a) => a.nickname || a.email)
        const body = names.join('\n') + (fresh.length > 3 ? (isEn ? `\n+${fresh.length - 3} more` : `\n等 ${fresh.length} 个`) : '')
        try { new Notification(title, { body }) } catch { /* ignore */ }
      }
      if (Notification.permission === 'granted') fire()
      else void Notification.requestPermission().then((p) => { if (p === 'granted') fire() })
    }

    // 持久化当前仍封禁的集合：已解封的移出（将来再次封禁可重新提醒），新封禁的记入避免重复弹
    try { localStorage.setItem(KEY, JSON.stringify(currentBanned)) } catch { /* ignore */ }
  }, [accounts])

  // 关闭/刷新前强制 flush 防抖中的待保存数据，防止数据丢失
  useEffect(() => {
    const handleBeforeUnload = (): void => { void flushSaveImmediately() }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    }
  }, [flushSaveImmediately])

  // 账户/激活变化时触发托盘更新（内部防抖 + 直接从 store 读取最新数据，避免 stale closure）
  useEffect(() => {
    updateTrayInfo()
  }, [accounts, activeAccountId, updateTrayInfo])

  // 监听托盘刷新账户事件
  useEffect(() => {
    const unsubscribe = window.api.onTrayRefreshAccount(() => {
      checkAndRefreshExpiringTokens()
      updateTrayInfo()
    })
    return () => {
      unsubscribe()
    }
  }, [checkAndRefreshExpiringTokens, updateTrayInfo])

  // 监听托盘切换账户事件
  useEffect(() => {
    const unsubscribe = window.api.onTraySwitchAccount(() => {
      switchToNextAccount()
    })
    return () => {
      unsubscribe()
    }
  }, [switchToNextAccount])

  // 监听后台刷新结果：缓冲 + 批量化 flush，N 条结果合并为一次 set，消除 Map 复制风暴
  useEffect(() => {
    const refreshBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (refreshBuffer.length === 0) return
      const batch = refreshBuffer.splice(0)
      applyBackgroundRefreshResults(batch)
    }

    const unsubscribe = window.api.onBackgroundRefreshResult((data) => {
      refreshBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        // 卸载前 flush 剩余结果，防止丢失
        flush()
      }
    }
  }, [applyBackgroundRefreshResults])

  // 监听后台检查结果：同样的批量化策略
  useEffect(() => {
    const checkBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (checkBuffer.length === 0) return
      const batch = checkBuffer.splice(0)
      applyBackgroundCheckResults(batch)
    }

    const unsubscribe = window.api.onBackgroundCheckResult((data) => {
      checkBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flush()
      }
    }
  }, [applyBackgroundCheckResults])

  // 监听反代账号被封禁事件（TEMPORARILY_SUSPENDED / AccountSuspendedException）
  // 反代触发后，把封禁状态同步到 store 让 UI 显示
  useEffect(() => {
    const unsubscribe = window.api.onProxyAccountSuspended((info) => {
      console.warn(`[App] Account suspended via proxy: ${info.email || info.id} (${info.reason})`)
      updateAccountStatus(info.id, 'error', `[${info.reason}] ${info.message}`)
    })
    return () => {
      unsubscribe()
    }
  }, [updateAccountStatus])

  // 监听反代账号更新事件（Enterprise profileArn 自愈），持久化到 store + 磁盘
  useEffect(() => {
    const unsubscribe = window.api.onProxyAccountUpdate((info) => {
      if (!info.profileArn) return
      const account = useAccountsStore.getState().accounts.get(info.id)
      if (!account || account.credentials?.profileArn === info.profileArn) return
      updateAccount(info.id, {
        profileArn: info.profileArn,
        credentials: { ...account.credentials, profileArn: info.profileArn }
      })
      console.log(`[App] Persisted Enterprise profileArn for ${info.id}`)
    })
    return () => {
      unsubscribe()
    }
  }, [updateAccount])

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'accounts':
        return <AccountManager />
      case 'machineId':
        return <MachineIdPage />
      case 'kiroSettings':
        return <KiroSettingsPage />
      case 'proxy':
        return <ProxyPage />
      case 'kproxy':
        return <KProxyPage />
      case 'proxyPool':
        return <ProxyPoolPage />
      case 'register':
        return <RegisterPage />
      case 'subscription':
        return <SubscriptionPage />
      case 'webhooks':
        return <WebhooksPage />
      case 'diagnose':
        return <DiagnosePage />
      case 'configSync':
        return <ConfigSyncPage />
      case 'logs':
        return <LogsPage />
      case 'settings':
        return <SettingsPage />
      case 'about':
        return <AboutPage />
      default:
        return <HomePage />
    }
  }

  return (
    <div className="h-screen ambient-bg overflow-hidden flex flex-col">
      <TitleBar />
      <div className="flex-1 min-h-0 flex gap-2 p-2">
        <Sidebar
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main className="flex-1 min-w-0 overflow-hidden rounded-3xl page-surface">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="h-full flex flex-col"
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <UpdateDialog />
      <CloseConfirmDialog />
      {/* C2:跨端同步冲突无法自动合并时弹窗告知用户（决策卡「用户裁决记录」） */}
      <SyncErrorNotice />
    </div>
  )
}

export default App
