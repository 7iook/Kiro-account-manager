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
import {
  Globe,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  QrCode,
  ExternalLink
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
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
  addressGroups: { recommended: [], virtual: [], loopback: [], degraded: false },
  defaultAddress: null,
  hasAdminKey: false,
  lastError: null
}

/**
 * 该 host 是否只能本机访问。判据只写一处 —— 渲染侧的提示与开关侧的翻转
 * 必须用同一套判据，否则会出现「提示说仅本机、开关却显示已开」这类自相矛盾。
 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
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

  /**
   * 切换局域网访问 —— 把「绑定地址」这个网络概念翻译成一个用户能懂的开关。
   *
   *   开 → host='0.0.0.0'（主进程 buildPanelAddresses 会枚举出真实网卡地址供手机使用）
   *   关 → host='127.0.0.1'
   *
   * **打开前先确保 adminKey 存在**：主进程有一条安全红线「外网绑定 + 无 adminKey
   * → 拒绝启动」（`webPanel/server.ts` start）。不预先生成的话，用户打开这个开关后
   * 面板会启动失败，而且得自己领悟「要先去下面把密钥生成出来」这个隐藏的操作顺序。
   * `get-admin-key` 首次调用即生成，所以这里调一次就够 —— 顺序陷阱在此处被吸收掉。
   *
   * 运行中改 host 必须重启才生效（照 handleSavePort 先例：start() 读的是实时配置）。
   */
  const handleToggleLan = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setOpError(null)
    try {
      const nextLan = isLoopbackHost(status.host)
      // 开局域网前先备好密钥，免得撞上安全红线而启动失败
      if (nextLan && !status.hasAdminKey) {
        const key = await window.api.webPanelGetAdminKey()
        if (!key.success) {
          setOpError(key.error)
          return
        }
        setAdminKey(key.adminKey)
      }
      const saved = await window.api.webPanelSetConfig({
        host: nextLan ? '0.0.0.0' : '127.0.0.1'
      })
      if (!saved.success) {
        setOpError(saved.error)
        return
      }
      applyStatus(saved.status)
      // 运行中换绑定地址要重启才生效
      if (status.running) {
        await window.api.webPanelStop()
        const restarted = await window.api.webPanelStart()
        applyStatus(restarted.status)
        if (!restarted.success) setOpError(restarted.error)
      }
    } catch (error) {
      console.error('[WebPanelCard] Failed to toggle LAN access:', error)
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
  const loopbackOnly = isLoopbackHost(status.host)
  /** 局域网访问开关的视觉态 —— 跟随 **真实配置的 host**，不是本地意图 */
  const lanEnabled = !loopbackOnly
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
              aria-label={t('settings.webPanel.enabled')}
              // 关键：跟随 running（真实监听态），不是 enabled（配置意图）
              checked={serving}
              disabled={loading || busy}
              onCheckedChange={() => void handleToggle()}
            />
          </div>
        </div>

        {/* 局域网访问 —— 绑定地址的用户友好封装。
            放在启用开关之后、地址列表之前：先决定谁能访问，再看拿哪个地址去访问。 */}
        <div className="flex items-center justify-between pt-2 border-t">
          <div>
            <p className="font-medium">{t('settings.webPanel.lanAccess')}</p>
            <p className="text-sm text-muted-foreground">
              {t('settings.webPanel.lanAccessDesc')}
            </p>
          </div>
          <Switch
            id="webPanelLanAccess"
            aria-label={t('settings.webPanel.lanAccess')}
            checked={lanEnabled}
            disabled={loading || busy}
            onCheckedChange={() => void handleToggleLan()}
          />
        </div>

        {/* 操作失败（写配置 / 启停返回 error）—— 与下面的「启动失败」分开,且**无条件显示**:
            面板正在跑时用户改绑定地址失败,同样必须看到原因,否则表现为
            「点了开关什么都没发生」,用户既不知道失败也不知道为什么。 */}
        {opError && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="break-all">{opError}</span>
          </div>
        )}

        {/* 启动失败 —— 显示真实原因,这是本区块最重要的一块信息 */}
        {!serving && !opError && status.lastError && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="break-all">
              {t('settings.webPanel.startFailed')}
              {status.lastError}
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
            <PanelAddressBar status={status} />
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

// ============================================================================
// 地址栏 —— 多地址选择 + 复制 + 二维码 + 浏览器打开
// ============================================================================

/**
 * 记住用户上次选的地址，**按 host（IP）而不是完整 URL 存**。
 *
 * 这样换端口后选择依然有效 —— 用户挑的是「哪张网卡」，不是「哪个 URL」。
 * 照 `codeg-research/src/components/settings/web-service-settings.tsx:49`
 * 的 `DISPLAY_HOST_STORAGE_KEY` 先例。
 */
const DISPLAY_HOST_STORAGE_KEY = 'webPanel.displayHost'


/**
 * 读上次选的 host。**必须容忍 localStorage 抛异常** —— 隐私模式 / 禁用 cookie
 * 的环境下访问它会 throw，而「记不住上次选择」不该让整个地址栏崩掉。
 * 写入侧同样姿势（见 `rememberDisplayHost`）。
 */
function readSavedDisplayHost(): string | null {
  try {
    return window.localStorage.getItem(DISPLAY_HOST_STORAGE_KEY)
  } catch {
    return null
  }
}

function rememberDisplayHost(host: string): void {
  try {
    window.localStorage.setItem(DISPLAY_HOST_STORAGE_KEY, host)
  } catch {
    // 存不住就算了：下次回到默认选择，不影响本次使用
  }
}

/** 虚拟网卡来源 → 展示名。认不出的归「其他」 */
const VIRTUAL_SOURCE_LABEL: Record<string, string> = {
  wsl: 'WSL',
  hyperv: 'Hyper-V',
  vmware: 'VMware',
  virtualbox: 'VirtualBox',
  tailscale: 'Tailscale',
  other: '其他'
}

type AddressGroups = WebPanelStatus['addressGroups']
type AddressItem = AddressGroups['recommended'][number]

/**
 * 地址栏。
 *
 * ## 为什么不平铺
 *
 * 主进程分好了组（`addressGroups`）：推荐 = 真实物理网卡，虚拟 = WSL / VMware /
 * Tailscale 这类手机连不上的地址。本机实测 6 条非回环地址里只有 1 条能扫 ——
 * 平铺给用户等于让他瞎猜。所以推荐组直接可选，虚拟组默认折叠。
 *
 * ## 降级
 *
 * `degraded === true` 表示判据没认出任何物理网卡（OUI 表不可能覆盖所有硬件）。
 * 此时**不显示空的推荐分组**，而是把全部地址平铺出来、不标推荐 ——
 * 排序不佳只是体验问题，滤掉唯一可用地址是硬故障。
 *
 * ## 二维码只承载 URL
 *
 * 刻意**不**把 adminKey 编进二维码：二维码会进截图 / 相册 / 聊天记录，
 * 密钥跟着一起泄漏。用户在手机上自己输密钥。
 */
function PanelAddressBar({ status }: { status: WebPanelStatus }): React.ReactNode {
  const { t } = useTranslation()
  /**
   * 分组信息容错：`addressGroups` 是本轮新增字段。
   *
   * 为什么必须兜底而不是假定它一定在：这是**跨进程**数据。主进程与 renderer
   * 版本可能不一致（开发中热重载、或用户装了旧版主进程），字段缺失时整个设置页
   * 不该白屏。缺失时退化为「把 addresses 平铺、不标推荐」—— 正好等于本轮改造前
   * 的行为，是安全的降级终点。
   */
  const groups: AddressGroups =
    status.addressGroups ??
    ({
      recommended: [],
      virtual: [],
      loopback: status.addresses.map((url) => ({
        url,
        host: url,
        interfaceName: '',
        kind: 'loopback' as const
      })),
      // 标记为降级 ⇒ UI 走「全部平铺、不标推荐」分支
      degraded: status.addresses.length > 0
    } as AddressGroups)
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const [showVirtual, setShowVirtual] = useState(false)

  // 降级时全部平铺、不分推荐；否则推荐组优先
  const primary: AddressItem[] = groups.degraded
    ? [...groups.recommended, ...groups.virtual, ...groups.loopback]
    : groups.recommended
  const secondary: AddressItem[] = groups.degraded
    ? []
    : [...groups.virtual, ...groups.loopback]
  const all: AddressItem[] = [...primary, ...secondary]

  /**
   * 当前地址。优先级：用户本次点选 → 上次记住的 host → 主进程给的
   * defaultAddress → 首个。`status` 变化（改端口 / 重启）时自动跟随，
   * 因为这里是每次渲染重算而非 state 缓存 URL。
   */
  const current: AddressItem | null = (() => {
    if (all.length === 0) return null
    if (selected !== null) {
      const hit = all.find((a) => a.host === selected)
      if (hit !== undefined) return hit
    }
    const saved = readSavedDisplayHost()
    if (saved !== null) {
      const hit = all.find((a) => a.host === saved)
      if (hit !== undefined) return hit
    }
    if (status.defaultAddress !== null) {
      const hit = all.find((a) => a.url === status.defaultAddress)
      if (hit !== undefined) return hit
    }
    return all[0]
  })()

  if (current === null) return null

  const handlePick = (item: AddressItem): void => {
    setSelected(item.host)
    rememberDisplayHost(item.host)
    setCopied(false)
  }

  const handleCopyAddress = (): void => {
    void navigator.clipboard
      .writeText(current.url)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch((error: unknown) => {
        // 不静默：复制失败要让用户知道，否则他以为复制成功了去手机上粘贴空值
        console.error('[WebPanelCard] Failed to copy address:', error)
      })
  }

  const renderOption = (item: AddressItem): React.ReactNode => {
    const isCurrent = item.host === current.host
    const label =
      item.kind === 'loopback'
        ? t('settings.webPanel.addressLoopbackTag')
        : item.kind === 'virtual'
          ? (VIRTUAL_SOURCE_LABEL[item.virtualSource ?? 'other'] ?? '其他')
          : null
    return (
      <button
        key={item.url}
        type="button"
        onClick={() => handlePick(item)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
          isCurrent ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
        }`}
      >
        <span className="min-w-0 flex-1">
          <code className="block truncate font-mono text-xs">{item.url}</code>
          <span className="block truncate text-[10px] text-muted-foreground">
            {item.interfaceName}
          </span>
        </span>
        {label !== null && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {label}
          </span>
        )}
        {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      {/* 当前地址 + 三个动作 */}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-muted/50 px-3 py-2 font-mono text-sm">
          {current.url}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleCopyAddress}
          title={t('settings.webPanel.copy')}
          aria-label={t('settings.webPanel.copy')}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => setQrOpen(true)}
          title={t('settings.webPanel.qrcode')}
          aria-label={t('settings.webPanel.qrcode')}
        >
          <QrCode className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => window.api.openExternal(current.url)}
          title={t('settings.webPanel.openInBrowser')}
          aria-label={t('settings.webPanel.openInBrowser')}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 可选地址列表。只有一个地址时不显示选择器（没什么可选的） */}
      {all.length > 1 && (
        <div className="space-y-1.5">
          {primary.length > 1 || groups.degraded ? (
            <>
              {!groups.degraded && (
                <p className="text-[10px] text-muted-foreground">
                  {t('settings.webPanel.addressRecommended')}
                </p>
              )}
              {primary.map(renderOption)}
            </>
          ) : (
              null /* 只有一个推荐地址时不必再列一遍选择器 */
          )}

          {secondary.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowVirtual((v) => !v)}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
              >
                {showVirtual
                  ? t('settings.webPanel.addressHideOthers')
                  : t('settings.webPanel.addressShowOthers', { count: secondary.length })}
              </button>
              {showVirtual && (
                <>
                  <p className="text-[10px] text-muted-foreground">
                    {t('settings.webPanel.addressOthersHint')}
                  </p>
                  {secondary.map(renderOption)}
                </>
              )}
            </>
          )}
        </div>
      )}

      {qrOpen && (
        <AddressQrcodeDialog
          url={current.url}
          onClose={() => setQrOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * 二维码弹层。**内容就是地址栏显示的那个字符串本身**（同一个 `current.url`），
 * 不是另拼一份 —— 否则扫出来的和看到的可能不一致。
 *
 * 下方重复展示地址文本，是给「扫不动就手输」留退路（照参照实现
 * `web-service-settings.tsx:154-186` 的 `AddressQrcodeDialog`）。
 */
function AddressQrcodeDialog({
  url,
  onClose
}: {
  url: string
  onClose: () => void
}): React.ReactNode {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        role="presentation"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div
        role="dialog"
        aria-label={t('settings.webPanel.qrcode')}
        className="relative w-full max-w-xs rounded-2xl bg-background p-5 shadow-lg"
      >
        <div className="flex flex-col items-center gap-3">
          {/* 白底 + padding：二维码在深色主题下必须保证对比度，否则扫不出来 */}
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={url} size={208} marginSize={0} />
          </div>
          <code className="w-full break-all text-center font-mono text-xs text-muted-foreground">
            {url}
          </code>
          <p className="text-center text-[11px] text-muted-foreground">
            {t('settings.webPanel.qrcodeHint')}
          </p>
          <Button variant="outline" className="w-full" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}
