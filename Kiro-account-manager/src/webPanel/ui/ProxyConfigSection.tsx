import { useCallback, useEffect, useState } from 'react'
import {
  changeProxyPort,
  createProxyApiKey,
  fetchProxyApiKeys,
  fetchProxyConfig,
  PanelProxyConfigResponseError,
  revokeProxyApiKey,
  updateProxyConfig,
  verifyProxyApiKey,
  type PanelProxyApiKeyListResult,
  type PanelProxyConfigView
} from '../api/panel'
import { PanelApiError } from '../api/client'
import { PanelSectionBoundary } from './PanelSectionBoundary'

interface ProxyConfigSectionProps {
  onSessionLost: () => void
  onNotice: (msg: string) => void
  onError: (msg: string) => void
  onProxyStatusChanged: () => Promise<void>
}

type ProxyConfigLoadState =
  | { status: 'loading' }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; config: PanelProxyConfigView }

const MISSING_CONFIG_MESSAGE = '服务端没有返回完整的反代配置。面板其他功能仍可使用，请重试读取。'

const READ_ONLY_LABELS: Record<string, string> = {
  logStreamEvents: '流式事件日志',
  enablePerfDiagLog: '性能诊断日志',
  enableAuditLog: '反代审计日志',
  modelMapping: '模型映射',
  modelMappings: '模型映射',
  agentMode: 'Agent 模式',
  maxPayloadBytes: '请求载荷上限',
  payloadLimit: '请求载荷上限',
  payloadSizeLimitKB: '请求载荷上限'
}

function describeError(error: unknown): string {
  if (error instanceof PanelApiError) return error.message
  return '读取反代配置失败，请重试'
}

function describeLoadError(error: unknown): string {
  return `读取反代配置失败：${describeError(error)}。面板其他功能仍可使用；若持续失败，请检查电脑端面板服务。`
}

/**
 * 只读投影原则上已经由服务端去除 secret；这里再按字段名 fail closed，
 * 防止未来服务端误把敏感项塞进通用 readOnly 数组时由 UI 原样渲染。
 * 字段本身与不可改原因仍会展示，满足「不隐藏」。
 */
function formatReadOnlyValue(key: string, value: unknown): string {
  if (/api.?key|token|secret|password/i.test(key)) return '敏感值不在面板显示'
  if (value === null || value === undefined || value === '') return '未设置'
  if (typeof value === 'boolean') return value ? '已开启' : '已关闭'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return JSON.stringify(value) ?? '未设置'
}

export function ProxyConfigSection({
  onSessionLost,
  onNotice,
  onError,
  onProxyStatusChanged
}: ProxyConfigSectionProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<ProxyConfigLoadState>({ status: 'loading' })
  const [draftLogRequests, setDraftLogRequests] = useState(false)
  const [saving, setSaving] = useState(false)
  const config = loadState.status === 'ready' ? loadState.config : null

  const loadConfig = useCallback(async (): Promise<PanelProxyConfigView | null> => {
    setLoadState({ status: 'loading' })
    try {
      const next = await fetchProxyConfig()
      setDraftLogRequests(next.editable.logRequests)
      setLoadState({ status: 'ready', config: next })
      return next
    } catch (error) {
      if (error instanceof PanelApiError && error.isUnauthorized) {
        onSessionLost()
        return null
      }
      const missing = error instanceof PanelProxyConfigResponseError
      const message = missing ? MISSING_CONFIG_MESSAGE : describeLoadError(error)
      setLoadState({ status: missing ? 'missing' : 'error', message })
      onError(message)
      return null
    }
  }, [onError, onSessionLost])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const acceptServerConfig = useCallback((next: PanelProxyConfigView): void => {
    setDraftLogRequests(next.editable.logRequests)
    setLoadState({ status: 'ready', config: next })
  }, [])

  const saveConfig = async (): Promise<void> => {
    if (config === null || saving || draftLogRequests === config.editable.logRequests) {
      return
    }

    const requestedLogRequests = draftLogRequests
    setSaving(true)
    try {
      const result = await updateProxyConfig({
        changes: { logRequests: requestedLogRequests }
      })

      // 只有服务端返回的安全投影能成为下一帧状态；请求值从不乐观写入 config。
      setLoadState({ status: 'ready', config: result.config })
      setDraftLogRequests(result.config.editable.logRequests)

      if (result.requiresRestart) {
        onNotice('配置已保存，需重启反代服务后才生效')
      } else if (
        result.config.editable.logRequests !== requestedLogRequests ||
        !result.appliedFields.includes('logRequests')
      ) {
        onNotice('服务端未应用所选值，已显示实际配置')
      } else {
        onNotice(`请求日志已${requestedLogRequests ? '开启' : '关闭'}，已生效`)
      }
    } catch (error) {
      if (error instanceof PanelApiError && error.isUnauthorized) {
        onSessionLost()
        return
      }
      onError(describeError(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <section
        aria-labelledby="proxy-config-title"
        className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800"
      >
        <h3
          id="proxy-config-title"
          className="text-sm font-semibold text-slate-900 dark:text-slate-100"
        >
          反代配置
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          普通保存只修改低风险项；高影响设置会展示当前位置和不可改原因。
        </p>

        {loadState.status === 'loading' && (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            正在读取反代配置…面板其他功能仍可使用。
          </p>
        )}

        {(loadState.status === 'missing' || loadState.status === 'error') && (
          <div
            className={`mt-3 rounded-xl border p-3 ${
              loadState.status === 'missing'
                ? 'border-amber-200 dark:border-amber-900'
                : 'border-red-200 dark:border-red-900'
            }`}
          >
            <p
              className={`text-sm ${
                loadState.status === 'missing'
                  ? 'text-amber-800 dark:text-amber-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {loadState.message}
            </p>
            <button
              type="button"
              onClick={() => void loadConfig()}
              className="mt-2 h-11 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 active:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:active:bg-slate-800"
            >
              重试读取配置
            </button>
          </div>
        )}

        {config !== null && (
          <>
            <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">可编辑</p>
              <label className="mt-2 flex min-h-11 items-center justify-between gap-3">
                <span>
                  <span className="block text-sm text-slate-800 dark:text-slate-200">
                    记录反代请求日志
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    服务端当前值：{config.editable.logRequests ? '已开启' : '已关闭'}
                  </span>
                  {draftLogRequests !== config.editable.logRequests && (
                    <span className="block text-xs text-amber-700 dark:text-amber-400">
                      有未保存更改
                    </span>
                  )}
                </span>
                <input
                  type="checkbox"
                  aria-label="记录反代请求日志"
                  checked={draftLogRequests}
                  onChange={(event) => setDraftLogRequests(event.target.checked)}
                  className="h-5 w-5 shrink-0 accent-blue-600"
                />
              </label>
              <button
                type="button"
                onClick={() => void saveConfig()}
                disabled={saving || draftLogRequests === config.editable.logRequests}
                className="mt-2 h-11 w-full rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存请求日志设置'}
              </button>
            </div>

            <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                API Key（仅安全摘要）
              </p>
              <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">
                {config.apiKeys.configured ? `已配置 ${config.apiKeys.count} 个` : '未配置'}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                具体提示与轮换状态见下方“API Key 生命周期”。
              </p>
            </div>

            <div className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">反代监听</p>
              <p className="mt-1 font-mono text-sm text-slate-800 dark:text-slate-200">
                {config.proxyListen.host}:{config.proxyListen.port}
              </p>
              {config.proxyListen.requiresRestart && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  修改监听地址后需重启反代服务才会生效。
                </p>
              )}
            </div>

            <div className="mt-3 rounded-xl border border-dashed border-amber-300 p-3 dark:border-amber-800">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300">高影响操作</p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                端口与 API Key 会影响连接或鉴权，必须通过专用操作二次确认；普通保存不会修改。
              </p>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                面板监听、IP
                规则、转发信任和部署字段属于控制面与部署信任边界，永久不能从手机面板修改，只能在本机或部署配置中调整。
              </p>
            </div>

            <div className="mt-3">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">只读设置</p>
              {config.readOnly.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">暂无只读设置</p>
              ) : (
                <ul aria-label="只读配置" className="mt-2 space-y-2">
                  {config.readOnly.map((item) => (
                    <li
                      key={item.key}
                      className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                          {READ_ONLY_LABELS[item.key] ?? item.key}
                        </span>
                        <code className="text-xs text-slate-500 dark:text-slate-400">
                          {item.key}
                        </code>
                      </div>
                      <p className="mt-1 break-all text-sm text-slate-700 dark:text-slate-300">
                        当前：{formatReadOnlyValue(item.key, item.value)}
                      </p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        不可远程修改：{item.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
      <PanelSectionBoundary name="更改反代端口">
        <ProxyPortSection
          config={config}
          configStatus={loadState.status}
          onAcceptConfig={acceptServerConfig}
          onReloadConfig={loadConfig}
          onProxyStatusChanged={onProxyStatusChanged}
          onSessionLost={onSessionLost}
          onNotice={onNotice}
        />
      </PanelSectionBoundary>
      <PanelSectionBoundary name="API Key 生命周期">
        <ProxyApiKeyLifecycleSection
          onAcceptConfig={acceptServerConfig}
          onSessionLost={onSessionLost}
        />
      </PanelSectionBoundary>
    </>
  )
}

interface ProxyPortSectionProps {
  config: PanelProxyConfigView | null
  configStatus: ProxyConfigLoadState['status']
  onAcceptConfig: (config: PanelProxyConfigView) => void
  onReloadConfig: () => Promise<PanelProxyConfigView | null>
  onProxyStatusChanged: () => Promise<void>
  onSessionLost: () => void
  onNotice: (message: string) => void
}

function ProxyPortSection({
  config,
  configStatus,
  onAcceptConfig,
  onReloadConfig,
  onProxyStatusChanged,
  onSessionLost,
  onNotice
}: ProxyPortSectionProps): React.JSX.Element {
  const [portDraft, setPortDraft] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)

  const applyPort = async (): Promise<void> => {
    if (!config || busy || confirmation !== '更改端口') return
    const nextPort = Number(portDraft)
    setBusy(true)
    setOperationError(null)
    try {
      const result = await changeProxyPort(nextPort, config.proxyListen.port)
      if (
        result.requiresRestart !== false ||
        result.port !== nextPort ||
        result.config.proxyListen.port !== nextPort
      ) {
        throw new Error('服务端未确认新端口已经监听')
      }
      onAcceptConfig(result.config)
      setPortDraft(String(result.port))
      setConfirmOpen(false)
      setConfirmation('')
      await onProxyStatusChanged()
      onNotice(
        result.restarted
          ? `反代已重启并监听新端口 ${result.port}`
          : `反代当前未运行；端口已保存为 ${result.port}，下次启动将监听该端口`
      )
    } catch (error) {
      if (error instanceof PanelApiError && error.isUnauthorized) {
        onSessionLost()
        return
      }
      setOperationError(
        error instanceof PanelApiError
          ? (error.serverMessage ?? error.message)
          : error instanceof Error
            ? error.message
            : '端口变更失败，请重试'
      )
      setConfirmOpen(false)
      setConfirmation('')
      // 失败后重新读取服务端投影；只有这次读数能说明旧端口是否真的恢复。
      const actual = await onReloadConfig()
      setPortDraft(String(actual?.proxyListen.port ?? config.proxyListen.port))
      await onProxyStatusChanged()
    } finally {
      setBusy(false)
    }
  }

  const parsedPort = Number(portDraft)
  const validPort =
    Number.isInteger(parsedPort) &&
    parsedPort >= 1 &&
    parsedPort <= 65535 &&
    config !== null &&
    parsedPort !== config.proxyListen.port

  return (
    <section
      aria-labelledby="proxy-port-action-title"
      className="mt-3 rounded-xl border border-amber-300 p-3 dark:border-amber-800"
    >
      <h3
        id="proxy-port-action-title"
        className="text-sm font-semibold text-slate-900 dark:text-slate-100"
      >
        更改反代端口
      </h3>
      {config === null ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {configStatus === 'loading'
            ? '等待反代配置读取完成…'
            : '反代配置当前不可用，请先重试读取配置；其它反代操作仍可使用。'}
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
            当前监听：{config.proxyListen.host}:{config.proxyListen.port}
          </p>
          <label className="mt-3 block text-sm text-slate-700 dark:text-slate-200">
            <span className="mb-1 block">新端口</span>
            <input
              type="number"
              min={1}
              max={65535}
              step={1}
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-amber-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setOperationError(null)
              setConfirmation('')
              setConfirmOpen(true)
            }}
            disabled={busy || !validPort}
            className="mt-3 h-11 w-full rounded-xl bg-amber-600 text-sm font-medium text-white active:bg-amber-700 disabled:opacity-50"
          >
            更改反代端口
          </button>
        </>
      )}
      {operationError !== null && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {operationError}
        </p>
      )}

      {confirmOpen && config !== null && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-port-confirm-title"
            className="w-full rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id="proxy-port-confirm-title"
              className="text-lg font-semibold text-amber-800 dark:text-amber-200"
            >
              确认更改反代端口
            </h2>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
              应用会触发反代真实重启，现有连接会短暂中断。
            </p>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
              若新端口启动失败，服务端会自动回滚旧端口；界面随后重新读取实际监听端口。
            </p>
            <label className="mt-4 block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">输入“更改端口”以确认</span>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                className="h-11 w-full rounded-xl border border-amber-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-amber-500 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false)
                  setConfirmation('')
                }}
                disabled={busy}
                className="h-11 rounded-xl border border-slate-300 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void applyPort()}
                disabled={busy || confirmation !== '更改端口'}
                className="h-11 rounded-xl bg-amber-600 text-sm font-medium text-white active:bg-amber-700 disabled:opacity-50"
              >
                {busy ? '重启中…' : '确认更改并应用'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

interface ProxyApiKeyLifecycleSectionProps {
  onAcceptConfig: (config: PanelProxyConfigView) => void
  onSessionLost: () => void
}

type ProxyApiKeyItem = PanelProxyApiKeyListResult['keys'][number]

function ProxyApiKeyLifecycleSection({
  onAcceptConfig,
  onSessionLost
}: ProxyApiKeyLifecycleSectionProps): React.JSX.Element {
  const [listState, setListState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; keys: ProxyApiKeyItem[] }
  >({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createConfirmation, setCreateConfirmation] = useState('')
  const [delivery, setDelivery] = useState<{ id: string; key: string } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string
    hint: string
    replacementId: string
  } | null>(null)
  const [revokeConfirmation, setRevokeConfirmation] = useState('')

  const loadKeys = useCallback(
    async (showLoading = true): Promise<void> => {
      if (showLoading) setListState({ status: 'loading' })
      try {
        const result = await fetchProxyApiKeys()
        setListState({ status: 'ready', keys: result.keys })
      } catch (error) {
        if (error instanceof PanelApiError && error.isUnauthorized) {
          onSessionLost()
          return
        }
        const detail =
          error instanceof PanelApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : '未知错误'
        setListState({
          status: 'error',
          message: `读取 API Key 列表失败：${detail}。其它反代操作仍可使用。`
        })
      }
    },
    [onSessionLost]
  )

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  const handleActionError = (error: unknown, fallback: string): void => {
    if (error instanceof PanelApiError && error.isUnauthorized) {
      onSessionLost()
      return
    }
    setOperationError(
      error instanceof PanelApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : fallback
    )
  }

  const createKey = async (): Promise<void> => {
    if (busy !== null || createConfirmation !== '新增') return
    setBusy('create')
    setOperationError(null)
    try {
      const result = await createProxyApiKey()
      onAcceptConfig(result.config)
      // 完整 key 只存在这个一次性交付状态，不并入可持久列表。
      setDelivery({ id: result.id, key: result.key })
      setCreateOpen(false)
      setCreateConfirmation('')
      await loadKeys(false)
    } catch (error) {
      handleActionError(error, '新增 API Key 失败')
    } finally {
      setBusy(null)
    }
  }

  const verifyKey = async (id: string): Promise<void> => {
    if (busy !== null) return
    setBusy(`verify:${id}`)
    setOperationError(null)
    try {
      const result = await verifyProxyApiKey(id)
      onAcceptConfig(result.config)
      await loadKeys(false)
    } catch (error) {
      handleActionError(error, '验证 API Key 失败')
    } finally {
      setBusy(null)
    }
  }

  const revokeKey = async (): Promise<void> => {
    if (!revokeTarget || busy !== null || revokeConfirmation !== '吊销') return
    setBusy(`revoke:${revokeTarget.id}`)
    setOperationError(null)
    try {
      const result = await revokeProxyApiKey(revokeTarget.id, revokeTarget.replacementId)
      onAcceptConfig(result.config)
      setRevokeTarget(null)
      setRevokeConfirmation('')
      await loadKeys(false)
    } catch (error) {
      handleActionError(error, '吊销 API Key 失败')
    } finally {
      setBusy(null)
    }
  }

  const keys = listState.status === 'ready' ? listState.keys : []
  const replacementFor = (targetId: string): ProxyApiKeyItem | undefined =>
    keys.find((candidate) => candidate.id !== targetId && candidate.verifiedAt !== null)

  return (
    <section
      aria-labelledby="proxy-api-key-lifecycle-title"
      className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
    >
      <h3
        id="proxy-api-key-lifecycle-title"
        className="text-sm font-semibold text-slate-900 dark:text-slate-100"
      >
        API Key 生命周期
      </h3>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        先新增 Key，用它发起真实请求验证可用，再吊销旧 Key；完整新 Key 只显示一次。
      </p>

      {listState.status === 'loading' && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">正在读取 API Key 列表…</p>
      )}
      {listState.status === 'error' && (
        <div className="mt-3 rounded-xl border border-red-200 p-3 dark:border-red-900">
          <p className="text-sm text-red-700 dark:text-red-300">{listState.message}</p>
          <button
            type="button"
            onClick={() => void loadKeys()}
            className="mt-2 h-11 rounded-xl border border-slate-300 px-3 text-sm dark:border-slate-600"
          >
            重试读取 API Key
          </button>
        </div>
      )}
      {listState.status === 'ready' && (
        <>
          {keys.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">尚未配置 API Key。</p>
          ) : (
            <ul aria-label="API Key 生命周期列表" className="mt-3 space-y-2">
              {keys.map((item) => {
                const replacement = replacementFor(item.id)
                return (
                  <li
                    key={item.id}
                    className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="break-all text-sm text-slate-800 dark:text-slate-200">
                        {item.hint}
                      </code>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {item.verifiedAt === null ? '未验证' : '已验证'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.id !== 'legacy' && item.verifiedAt === null && (
                        <button
                          type="button"
                          onClick={() => void verifyKey(item.id)}
                          disabled={busy !== null}
                          className="h-10 rounded-xl border border-blue-300 px-3 text-sm text-blue-700 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300"
                        >
                          {busy === `verify:${item.id}` ? '验证中…' : '验证新 Key'}
                        </button>
                      )}
                      {replacement !== undefined && (
                        <button
                          type="button"
                          aria-label={`吊销 ${item.hint}`}
                          onClick={() => {
                            setOperationError(null)
                            setRevokeConfirmation('')
                            setRevokeTarget({
                              id: item.id,
                              hint: item.hint,
                              replacementId: replacement.id
                            })
                          }}
                          disabled={busy !== null}
                          className="h-10 rounded-xl border border-red-300 px-3 text-sm text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-300"
                        >
                          吊销
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <button
            type="button"
            onClick={() => {
              setOperationError(null)
              setCreateConfirmation('')
              setCreateOpen(true)
            }}
            disabled={busy !== null}
            className="mt-3 h-11 w-full rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700 disabled:opacity-50"
          >
            新增 API Key
          </button>
        </>
      )}
      {operationError !== null && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {operationError}
        </p>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-api-key-create-title"
            className="w-full rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id="proxy-api-key-create-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              新增 API Key
            </h2>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
              新 Key 创建后只显示一次。保存后必须先验证，再吊销旧 Key。
            </p>
            <label className="mt-4 block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">输入“新增”以确认</span>
              <input
                value={createConfirmation}
                onChange={(event) => setCreateConfirmation(event.target.value)}
                autoComplete="off"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreateOpen(false)
                  setCreateConfirmation('')
                }}
                disabled={busy !== null}
                className="h-11 rounded-xl border border-slate-300 text-sm dark:border-slate-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void createKey()}
                disabled={busy !== null || createConfirmation !== '新增'}
                className="h-11 rounded-xl bg-blue-600 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy === 'create' ? '新增中…' : '确认新增'}
              </button>
            </div>
          </section>
        </div>
      )}

      {delivery && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-api-key-delivery-title"
            className="w-full rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id="proxy-api-key-delivery-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              保存新的 API Key
            </h2>
            <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">
              这是完整 Key 的唯一一次显示；关闭后只能看到不可逆提示。
            </p>
            <code className="mt-3 block break-all rounded-xl bg-slate-100 p-3 text-sm text-slate-900 dark:bg-slate-950 dark:text-slate-100">
              {delivery.key}
            </code>
            <button
              type="button"
              onClick={() => setDelivery(null)}
              className="mt-4 h-11 w-full rounded-xl bg-blue-600 text-sm font-medium text-white"
            >
              我已保存，关闭
            </button>
          </section>
        </div>
      )}

      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 sm:items-center sm:justify-center">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-api-key-revoke-title"
            className="w-full rounded-2xl bg-white p-4 shadow-xl sm:max-w-md dark:bg-slate-900"
          >
            <h2
              id="proxy-api-key-revoke-title"
              className="text-lg font-semibold text-red-700 dark:text-red-300"
            >
              吊销 API Key
            </h2>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
              将吊销 {revokeTarget.hint}；服务端只会接受已经验证的新 Key
              作为替代，避免切断所有客户端。
            </p>
            <label className="mt-4 block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">输入“吊销”以确认</span>
              <input
                value={revokeConfirmation}
                onChange={(event) => setRevokeConfirmation(event.target.value)}
                autoComplete="off"
                className="h-11 w-full rounded-xl border border-red-300 bg-white px-3 text-base text-slate-900 dark:border-red-800 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setRevokeTarget(null)
                  setRevokeConfirmation('')
                }}
                disabled={busy !== null}
                className="h-11 rounded-xl border border-slate-300 text-sm dark:border-slate-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void revokeKey()}
                disabled={busy !== null || revokeConfirmation !== '吊销'}
                className="h-11 rounded-xl bg-red-600 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy?.startsWith('revoke:') ? '吊销中…' : '确认吊销'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
