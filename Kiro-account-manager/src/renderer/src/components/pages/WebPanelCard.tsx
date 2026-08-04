/**
 * 设置页「网页管理面板」区块（局域网访问）
 *
 * 独立成组件的理由：照本文件同目录 `SettingsPage.tsx` 尾部 `ConfigSyncCard` 的既有先例
 * —— 需要自己的异步状态与生命周期的区块单独拆出，SettingsPage 只放一行 `<WebPanelCard />`。
 * 同时使它可以被单独渲染测试，不必挂载整个 1300 行的设置页。
 *
 * 契约权威源：`src/main/ipc/webPanelWiring.ts`（7 条 `web-panel:*` 通道）。
 *
 * ⚠️ **本组件唯一必须守住的不变量**（决策卡 §5 场景 S3）：
 *
 *     开关的视觉状态由 `status.running`（**真实监听态**）驱动，
 *     绝不由 `status.enabled`（用户意图 / 持久化配置）驱动。
 *
 * 主进程把两者分成了两个字段，正是因为它们会不一致：端口被占用、或外网绑定却没配
 * adminKey 被安全红线拒绝时，`enabled` 仍是 true 而服务器**没有在监听**。若用 `enabled`
 * 渲染开关，界面显示「已开启」而手机根本连不上，用户拿不到任何可行动信息。
 *
 * 同理不做乐观更新：点开关只发 IPC，然后用**返回的 status** 整体覆盖本地状态。
 */
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Switch } from '../ui'
import { Globe, Eye, EyeOff, Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * 面板状态 / 配置类型 —— **从全局 `window.api` 的声明反推，不另写一份 interface**。
 *
 * 为什么这么绕：契约的权威定义在主进程 `src/main/ipc/webPanelWiring.ts`，
 * 而 `tsconfig.web.json` 不 include `src/main/**`，renderer 直接 import 不到；
 * `@preload` 别名只在 `vitest.config.ts` 里有，`tsconfig.web.json` 与生产构建都没有，
 * 用它会让 typecheck:web 与打包失败。
 *
 * 但 `preload/index.d.ts` 里的 `declare global { interface Window { api: KiroApi } }`
 * 是 renderer 侧本来就能看见的（web tsconfig include 了 `src/preload/*.d.ts`）。
 * 于是从 `window.api` 的方法返回值里把类型摘出来 —— 主进程改字段时，
 * 这里会**跟着变**并在编译期暴露不一致，不会出现第二个各自漂移的 SSOT。
 */
type WebPanelStatus = Awaited<ReturnType<Window['api']['webPanelGetStatus']>>['status']
type WebPanelConfig = Awaited<ReturnType<Window['api']['webPanelGetConfig']>>['config']

/**
 * 加载完成前的占位。与主进程 `DEFAULT_WEB_PANEL_CONFIG` 一致（默认关闭、5590、仅本机），
 * 但**只用于首帧**；拿到真实状态后一律被覆盖。
 */
const PLACEHOLDER_STATUS: WebPanelStatus = {
  running: false,
  enabled: false,
  host: '127.0.0.1',
  port: 5590,
  listeningPort: null,
  addresses: [],
  hasAdminKey: false,
  lastError: null
}

export function WebPanelCard(): React.ReactNode {
  const { t } = useTranslation()

  const [status, setStatus] = useState<WebPanelStatus>(PLACEHOLDER_STATUS)
  const [loading, setLoading] = useState(true)
  /** 正在执行启停 / 轮换等操作 —— 期间禁用控件，防止手抖连点 */
  const [busy, setBusy] = useState(false)
  /**
   * adminKey **按需拉取**：`web-panel:get-admin-key` 首次调用会**生成**密钥。
   * 页面加载时预取就等于「打开设置页即生成」，用户永远看不到「尚未生成」这个状态。
   */
  const [adminKey, setAdminKey] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  /** 端口输入框草稿值（未提交前不改真实配置） */
  const [portDraft, setPortDraft] = useState<string>('')
  const [portError, setPortError] = useState(false)
  /** 操作层面的失败（IPC 返回 success:false / 抛异常），与 status.lastError 分开 */
  const [opError, setOpError] = useState<string | null>(null)

  const applyStatus = useCallback((next: WebPanelStatus): void => {
    setStatus(next)
    setPortDraft(String(next.port))
  }, [])

  /** 拉真实状态。失败不静默 —— 至少把原因显示出来 */
  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.webPanelGetStatus()
      if (res.success) applyStatus(res.status)
    } catch (error) {
      console.error('[WebPanelCard] Failed to load web panel status:', error)
      setOpError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [applyStatus])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  /**
   * 开关。启用 = 写配置 `enabled:true` + `start()` 两步（主进程没有把两者合成一条通道）。
   * 停用同理。**不做乐观更新** —— 一律用返回的 status 覆盖。
   */
  const handleToggle = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setOpError(null)
    try {
      if (status.running) {
        const stopped = await window.api.webPanelStop()
        applyStatus(stopped.status)
        if (!stopped.success) setOpError(stopped.error)
        // 停用后把意图也落盘，否则下次自启动又会拉起来
        const saved = await window.api.webPanelSetConfig({ enabled: false })
        if (saved.success) applyStatus(saved.status)
      } else {
        // 先落盘意图，再启动 —— 启动失败时配置里的 enabled 与真实态不一致，
        // 而这恰恰是本组件要如实呈现的情况（开关关着 + 显示失败原因）。
        const saved = await window.api.webPanelSetConfig({ enabled: true })
        if (!saved.success) {
          setOpError(saved.error)
          return
        }
        applyStatus(saved.status)
        const started = await window.api.webPanelStart()
        applyStatus(started.status)
        if (!started.success) setOpError(started.error)
      }
    } catch (error) {
      console.error('[WebPanelCard] Toggle failed:', error)
      setOpError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleSavePort = async (): Promise<void> => {
    const parsed = Number(portDraft)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setPortError(true)
      return
    }
    setPortError(false)
    setBusy(true)
    setOpError(null)
    try {
      const saved = await window.api.webPanelSetConfig({ port: parsed })
      if (!saved.success) {
        setOpError(saved.error)
        return
      }
      applyStatus(saved.status)
      // 运行中改端口要重启才生效 —— 主进程 start() 读的是实时配置
      if (status.running) {
        await window.api.webPanelStop()
        const restarted = await window.api.webPanelStart()
        applyStatus(restarted.status)
        if (!restarted.success) setOpError(restarted.error)
      }
    } catch (error) {
      console.error('[WebPanelCard] Failed to set port:', error)
      setOpError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /** 用户点「显示」才拉密钥（首次拉取即生成） */
  const handleRevealKey = async (): Promise<void> => {
    if (adminKey !== null) {
      setShowKey(!showKey)
      return
    }
    setBusy(true)
    try {
      const res = await window.api.webPanelGetAdminKey()
      if (res.success) {
        setAdminKey(res.adminKey)
        setShowKey(true)
        void loadStatus() // hasAdminKey 可能刚从 false 变 true
      } else {
        setOpError(res.error)
      }
    } catch (error) {
      console.error('[WebPanelCard] Failed to read admin key:', error)
      setOpError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 轮换 adminKey。**必须先确认** —— 轮换会立即失效所有既存会话，
   * 所有已连接的手机 / 电脑都会被登出（决策卡 §3「轮换/退出」）。
   * 用户取消 ⇒ 一个 IPC 都不发。
   */
  const handleRegenerate = async (): Promise<void> => {
    if (busy) return
    if (!confirm(t('settings.webPanel.regenerateConfirm'))) return

    setBusy(true)
    setOpError(null)
    try {
      const res = await window.api.webPanelRotateAdminKey()
      if (res.success) {
        setAdminKey(res.adminKey)
        alert(t('settings.webPanel.regenerateDone'))
        void loadStatus()
      } else {
        setOpError(res.error)
      }
    } catch (error) {
      console.error('[WebPanelCard] Failed to rotate admin key:', error)
      setOpError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = (value: string, field: string): void => {
    void navigator.clipboard?.writeText(value)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  /** 只有 running 才算「能用」 */
  const serving = status.running
  /**
   * 仅绑定本机 ⇒ 手机连不上。判据用 **host**（不是「地址列表为空」）——
   * 主进程对非通配 host 会返回恰好一条地址，列表非空但那是回环地址。
   */
  const loopbackOnly =
    status.host === '127.0.0.1' || status.host === '::1' || status.host === 'localhost'
  /** 真实失败原因：优先操作返回的 error，否则主进程记录的 lastError */
  const failureReason = opError ?? status.lastError

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Globe className="h-4 w-4 text-primary" />
          </div>
          {t('settings.webPanel.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 开关 + 真实运行态徽标 */}
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{t('settings.webPanel.enabled')}</p>
            <p className="text-sm text-muted-foreground">{t('settings.webPanel.enabledDesc')}</p>
          </div>
          <div className="flex items-center gap-3">
            <StateBadge status={status} hasFailure={failureReason !== null} />
            <Switch
              id="webPanelEnabled"
              // 关键：跟随 running（真实监听态），不是 enabled（配置意图）
              checked={serving}
              disabled={loading || busy}
              onCheckedChange={() => void handleToggle()}
            />
          </div>
        </div>

        {/* 启动失败 —— 显示真实原因,这是本区块最重要的一块信息 */}
        {!serving && failureReason && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="break-all">
              {t('settings.webPanel.startFailed')}
              {failureReason}
            </span>
          </div>
        )}

        {/* 局域网访问地址 */}
        <div className="space-y-2 pt-2 border-t">
          <div>
            <p className="font-medium">{t('settings.webPanel.address')}</p>
            <p className="text-sm text-muted-foreground">{t('settings.webPanel.addressDesc')}</p>
          </div>
          {!serving || status.addresses.length === 0 ? (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
              {t('settings.webPanel.addressNone')}
            </p>
          ) : (
            <div className="space-y-2">
              {status.addresses.map((url) => (
                <div key={url} className="flex items-center gap-2">
                  <code className="flex-1 text-sm font-mono bg-muted/50 rounded-lg px-3 py-2 break-all">
                    {url}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleCopy(url, url)}
                    title={t('settings.webPanel.copy')}
                  >
                    {copiedField === url ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {loopbackOnly && (
            <p className="text-xs text-amber-500 bg-amber-500/10 rounded-lg p-3">
              {t('settings.webPanel.addressLoopbackOnly')}
            </p>
          )}
        </div>

        {/* 端口 */}
        <div className="flex items-center justify-between pt-2 border-t">
          <div>
            <p className="font-medium">{t('settings.webPanel.port')}</p>
            <p className="text-sm text-muted-foreground">{t('settings.webPanel.portDesc')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              className="w-24 h-9 text-center"
              value={portDraft}
              min={1}
              max={65535}
              disabled={loading || busy}
              onChange={(e) => {
                setPortDraft(e.target.value)
                setPortError(false)
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={loading || busy || portDraft === String(status.port)}
              onClick={() => void handleSavePort()}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
        {portError && <p className="text-xs text-destructive">{t('settings.webPanel.portInvalid')}</p>}

        {/* 访问密钥 */}
        <div className="space-y-2 pt-2 border-t">
          <div>
            <p className="font-medium">{t('settings.webPanel.adminKey')}</p>
            <p className="text-sm text-muted-foreground">{t('settings.webPanel.adminKeyDesc')}</p>
          </div>

          {!status.hasAdminKey && adminKey === null ? (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
              {t('settings.webPanel.adminKeyNone')}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  // 照 ProxyPanel.tsx:703 既有敏感值约定：默认遮蔽,按钮切换明文
                  type={showKey && adminKey !== null ? 'text' : 'password'}
                  value={adminKey ?? '****************'}
                  readOnly
                  className="pr-9 h-9 font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-2.5 hover:bg-transparent"
                  disabled={busy}
                  onClick={() => void handleRevealKey()}
                  title={showKey ? t('settings.webPanel.hide') : t('settings.webPanel.show')}
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                disabled={adminKey === null}
                onClick={() => handleCopy(adminKey as string, 'adminKey')}
                title={t('settings.webPanel.copy')}
              >
                {copiedField === 'adminKey' ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          )}

          {/* 常驻警告 —— 不能只在 confirm 弹窗里才告知后果 */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-amber-500 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {t('settings.webPanel.regenerateWarning')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={loading || busy}
              onClick={() => void handleRegenerate()}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('settings.webPanel.regenerate')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * 真实运行态徽标 —— 与开关分开呈现，让「意图」与「事实」在界面上也不混淆。
 * 没在跑且有失败原因 ⇒ 「启动失败」；没在跑也没失败 ⇒ 「已停止」。
 */
function StateBadge({
  status,
  hasFailure
}: {
  status: WebPanelStatus
  hasFailure: boolean
}): React.ReactNode {
  const { t } = useTranslation()
  if (status.running) {
    return (
      <span className="text-xs px-2 py-1 rounded-md text-success bg-success/10">
        {t('settings.webPanel.stateListening')}
      </span>
    )
  }
  if (hasFailure) {
    return (
      <span className="text-xs px-2 py-1 rounded-md text-destructive bg-destructive/10">
        {t('settings.webPanel.stateError')}
      </span>
    )
  }
  return (
    <span className="text-xs px-2 py-1 rounded-md text-muted-foreground bg-muted/50">
      {t('settings.webPanel.stateStopped')}
    </span>
  )
}

/** 供测试复用的类型别名（同样源自 `window.api` 声明，不是第二份定义） */
export type { WebPanelStatus, WebPanelConfig }
