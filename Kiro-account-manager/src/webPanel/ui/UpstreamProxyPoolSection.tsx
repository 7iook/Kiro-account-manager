import { useCallback, useEffect, useState } from 'react'
import {
  createUpstreamProxy,
  deleteUpstreamProxy,
  fetchUpstreamProxyPool,
  PanelUpstreamProxyPoolResponseError,
  updateUpstreamProxy,
  type PanelUpstreamProxyChanges,
  type PanelUpstreamProxyPoolView,
  type PanelUpstreamProxyView
} from '../api/panel'
import { PanelApiError } from '../api/client'

interface UpstreamProxyPoolSectionProps {
  onSessionLost: () => void
  onNotice: (message: string) => void
}

type PoolLoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; value: PanelUpstreamProxyPoolView }

const STATUS_TEXT: Record<PanelUpstreamProxyView['status'], string> = {
  untested: '未检测',
  testing: '检测中',
  alive: '可用',
  dead: '不可用',
  slow: '较慢'
}

function describeError(error: unknown): string {
  if (error instanceof PanelApiError) return error.serverMessage ?? error.message
  return '操作失败，请重试'
}

export function UpstreamProxyPoolSection({
  onSessionLost,
  onNotice
}: UpstreamProxyPoolSectionProps): React.JSX.Element {
  const [state, setState] = useState<PoolLoadState>({ kind: 'loading' })
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [syncPending, setSyncPending] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    setOperationError(null)
    try {
      setState({ kind: 'ready', value: await fetchUpstreamProxyPool() })
      setSyncPending(false)
    } catch (error) {
      if (error instanceof PanelApiError && error.isUnauthorized) {
        onSessionLost()
        return
      }
      if (error instanceof PanelUpstreamProxyPoolResponseError) {
        setState({ kind: 'missing' })
        return
      }
      setState({ kind: 'failed', message: describeError(error) })
    }
  }, [onSessionLost])

  useEffect(() => {
    void load()
  }, [load])

  const applyServerProjection = useCallback(
    (
      value: Awaited<
        ReturnType<
          typeof createUpstreamProxy | typeof updateUpstreamProxy | typeof deleteUpstreamProxy
        >
      >,
      notice: string
    ): void => {
      setState({ kind: 'ready', value: { revision: value.revision, entries: value.entries } })
      setSyncPending(value.accountPoolSyncPending)
      setOperationError(null)
      onNotice(notice)
    },
    [onNotice]
  )

  const runMutation = useCallback(
    async (
      key: string,
      action: () => ReturnType<
        typeof createUpstreamProxy | typeof updateUpstreamProxy | typeof deleteUpstreamProxy
      >,
      notice: string
    ): Promise<boolean> => {
      setBusy(key)
      setOperationError(null)
      try {
        applyServerProjection(await action(), notice)
        return true
      } catch (error) {
        if (error instanceof PanelApiError && error.isUnauthorized) {
          onSessionLost()
          return false
        }
        setOperationError(describeError(error))
        if (error instanceof PanelApiError && error.code === 'STALE_REVISION') {
          await load()
        }
        return false
      } finally {
        setBusy(null)
      }
    },
    [applyServerProjection, load, onSessionLost]
  )

  const ready = state.kind === 'ready' ? state.value : null

  return (
    <section
      aria-labelledby="upstream-proxy-pool-title"
      className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="upstream-proxy-pool-title"
            className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            上游代理池
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            管理账号出网使用的 HTTP / SOCKS 代理；凭据写入后不会再次显示。
          </p>
        </div>
        {ready ? (
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy !== null}
            className="h-11 shrink-0 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
          >
            刷新
          </button>
        ) : null}
      </div>

      {state.kind === 'loading' ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">代理池加载中…</p>
      ) : null}

      {state.kind === 'missing' ? (
        <div className="mt-3 rounded-xl border border-amber-300 p-3 dark:border-amber-800">
          <p className="text-sm text-amber-800 dark:text-amber-300">代理池数据不可用，请重试</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 h-11 w-full rounded-xl border border-amber-300 text-sm dark:border-amber-800"
          >
            重试加载代理池
          </button>
        </div>
      ) : null}

      {state.kind === 'failed' ? (
        <div className="mt-3 rounded-xl border border-red-300 p-3 dark:border-red-800">
          <p className="text-sm text-red-700 dark:text-red-300">代理池加载失败：{state.message}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 h-11 w-full rounded-xl border border-red-300 text-sm dark:border-red-800"
          >
            重试加载代理池
          </button>
        </div>
      ) : null}

      {ready ? (
        <>
          <form
            className="mt-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
            onSubmit={(event) => {
              event.preventDefault()
              const currentUrl = url.trim()
              if (!currentUrl) {
                setOperationError('请输入代理 URL')
                return
              }
              void runMutation(
                'create',
                () => createUpstreamProxy(ready.revision, currentUrl, label.trim() || undefined),
                '上游代理已新增'
              ).then((ok) => {
                if (!ok) return
                setUrl('')
                setLabel('')
              })
            }}
          >
            <label className="block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">代理 URL（含凭据）</span>
              <input
                aria-label="代理 URL（含凭据）"
                type="password"
                autoComplete="new-password"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="socks5://user:password@host:1080"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base dark:border-slate-600 dark:bg-slate-950"
              />
            </label>
            <label className="mt-2 block text-sm text-slate-700 dark:text-slate-200">
              <span className="mb-1 block">代理标签</span>
              <input
                aria-label="代理标签"
                value={label}
                maxLength={100}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="可选备注"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base dark:border-slate-600 dark:bg-slate-950"
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null || url.trim().length === 0}
              className="mt-3 h-11 w-full rounded-xl bg-blue-600 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy === 'create' ? '新增中…' : '新增代理'}
            </button>
          </form>

          {operationError ? (
            <p className="mt-2 text-sm text-red-700 dark:text-red-300">{operationError}</p>
          ) : null}
          {syncPending ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              配置已落盘；运行中的反代账号池尚未同步，请稍后点“重新同步账号池”。
            </p>
          ) : null}

          {ready.entries.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">尚未配置上游代理</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {ready.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {entry.label ?? '未命名代理'}
                      </p>
                      <p className="mt-0.5 break-all font-mono text-xs text-slate-600 dark:text-slate-300">
                        {entry.protocol}://{entry.host}:{entry.port}
                      </p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {entry.hasCredentials ? '已配置凭据（不回显）' : '未配置凭据'} ·{' '}
                        {STATUS_TEXT[entry.status]} · 已用 {entry.usedCount} / 失败{' '}
                        {entry.failCount}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-xs ${
                        entry.enabled
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                      }`}
                    >
                      {entry.enabled ? '已启用' : '已停用'}
                    </span>
                  </div>

                  {editingId === entry.id ? (
                    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                      <label className="block text-sm text-slate-700 dark:text-slate-200">
                        <span className="mb-1 block">编辑标签</span>
                        <input
                          aria-label="编辑标签"
                          value={editLabel}
                          maxLength={100}
                          onChange={(event) => setEditLabel(event.target.value)}
                          className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base dark:border-slate-600 dark:bg-slate-950"
                        />
                      </label>
                      <label className="mt-2 block text-sm text-slate-700 dark:text-slate-200">
                        <span className="mb-1 block">新代理 URL（留空保留原凭据）</span>
                        <input
                          aria-label="新代理 URL（留空保留原凭据）"
                          type="password"
                          autoComplete="new-password"
                          value={editUrl}
                          onChange={(event) => setEditUrl(event.target.value)}
                          placeholder="不填写即保留现有地址与凭据"
                          className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base dark:border-slate-600 dark:bg-slate-950"
                        />
                      </label>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null)
                            setEditUrl('')
                          }}
                          disabled={busy !== null}
                          className="h-11 rounded-xl border border-slate-300 text-sm dark:border-slate-600"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const changes: PanelUpstreamProxyChanges = { label: editLabel }
                            if (editUrl.trim()) changes.url = editUrl.trim()
                            void runMutation(
                              `update:${entry.id}`,
                              () => updateUpstreamProxy(entry.id, ready.revision, changes),
                              '上游代理已更新'
                            ).then((ok) => {
                              if (!ok) return
                              setEditingId(null)
                              setEditUrl('')
                            })
                          }}
                          disabled={busy !== null}
                          className="h-11 rounded-xl bg-blue-600 text-sm font-medium text-white disabled:opacity-50"
                        >
                          {busy === `update:${entry.id}` ? '保存中…' : '保存修改'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        aria-label={`编辑 ${entry.id}`}
                        onClick={() => {
                          setEditingId(entry.id)
                          setEditLabel(entry.label ?? '')
                          setEditUrl('')
                          setConfirmDeleteId(null)
                        }}
                        disabled={busy !== null}
                        className="h-11 rounded-xl border border-slate-300 text-sm dark:border-slate-600"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runMutation(
                            `toggle:${entry.id}`,
                            () =>
                              updateUpstreamProxy(entry.id, ready.revision, {
                                enabled: !entry.enabled
                              }),
                            entry.enabled ? '上游代理已停用' : '上游代理已启用'
                          )
                        }
                        disabled={busy !== null}
                        className="h-11 rounded-xl border border-slate-300 text-sm dark:border-slate-600"
                      >
                        {entry.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${entry.id}`}
                        onClick={() => setConfirmDeleteId(entry.id)}
                        disabled={busy !== null}
                        className="h-11 rounded-xl border border-red-300 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
                      >
                        删除
                      </button>
                    </div>
                  )}

                  {confirmDeleteId === entry.id ? (
                    <div className="mt-2 rounded-xl bg-red-50 p-2 dark:bg-red-950/40">
                      <p className="text-xs text-red-700 dark:text-red-300">
                        删除会解除所有账号与此代理的绑定，确定继续？
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="h-11 rounded-xl border border-slate-300 text-sm dark:border-slate-600"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          aria-label={`确认删除 ${entry.id}`}
                          onClick={() =>
                            void runMutation(
                              `delete:${entry.id}`,
                              () => deleteUpstreamProxy(entry.id, ready.revision),
                              '上游代理已删除'
                            ).then((ok) => {
                              if (ok) setConfirmDeleteId(null)
                            })
                          }
                          disabled={busy !== null}
                          className="h-11 rounded-xl bg-red-600 text-sm font-medium text-white disabled:opacity-50"
                        >
                          {busy === `delete:${entry.id}` ? '删除中…' : '确认删除'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  )
}
