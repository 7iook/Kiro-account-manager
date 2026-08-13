import { useCallback, useEffect, useState } from 'react'
import {
  fetchProxyConfig,
  PanelProxyConfigResponseError,
  updateProxyConfig,
  type PanelProxyConfigView
} from '../api/panel'
import { PanelApiError } from '../api/client'

interface ProxyConfigSectionProps {
  onSessionLost: () => void
  onNotice: (msg: string) => void
  onError: (msg: string) => void
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
  onError
}: ProxyConfigSectionProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<ProxyConfigLoadState>({ status: 'loading' })
  const [draftLogRequests, setDraftLogRequests] = useState(false)
  const [saving, setSaving] = useState(false)
  const config = loadState.status === 'ready' ? loadState.config : null

  const loadConfig = useCallback(async (): Promise<void> => {
    setLoadState({ status: 'loading' })
    try {
      const next = await fetchProxyConfig()
      setDraftLogRequests(next.editable.logRequests)
      setLoadState({ status: 'ready', config: next })
    } catch (error) {
      if (error instanceof PanelApiError && error.isUnauthorized) {
        onSessionLost()
        return
      }
      const missing = error instanceof PanelProxyConfigResponseError
      const message = missing ? MISSING_CONFIG_MESSAGE : describeLoadError(error)
      setLoadState({ status: missing ? 'missing' : 'error', message })
      onError(message)
    }
  }, [onError, onSessionLost])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

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
            {config.apiKeys.hints.length > 0 && (
              <ul aria-label="API Key 提示" className="mt-1 space-y-1">
                {config.apiKeys.hints.map((hint, index) => (
                  <li key={index}>
                    <code className="break-all text-xs text-slate-600 dark:text-slate-300">
                      {hint}
                    </code>
                  </li>
                ))}
              </ul>
            )}
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
                      <code className="text-xs text-slate-500 dark:text-slate-400">{item.key}</code>
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
  )
}
