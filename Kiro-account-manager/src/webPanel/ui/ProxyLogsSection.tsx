import { useCallback, useEffect, useState } from 'react'
import { fetchProxyLogs, PanelProxyLogsResponseError, type PanelProxyLogPage } from '../api/panel'
import { PanelApiError } from '../api/client'

interface ProxyLogsSectionProps {
  onSessionLost: () => void
}

type LogLoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; page: PanelProxyLogPage }

const LEVEL_CLASS: Record<PanelProxyLogPage['entries'][number]['level'], string> = {
  DEBUG: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  INFO: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  WARN: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  ERROR: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
}

function describeError(error: unknown): string {
  if (error instanceof PanelApiError) return error.serverMessage ?? error.message
  return '操作失败，请重试'
}

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString()
}

export function ProxyLogsSection({ onSessionLost }: ProxyLogsSectionProps): React.JSX.Element {
  const [state, setState] = useState<LogLoadState>({ kind: 'loading' })
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    setPageError(null)
    try {
      setState({ kind: 'ready', page: await fetchProxyLogs(undefined, 50) })
    } catch (error) {
      if (error instanceof PanelApiError && error.isUnauthorized) {
        onSessionLost()
        return
      }
      if (error instanceof PanelProxyLogsResponseError) {
        setState({ kind: 'missing' })
        return
      }
      setState({ kind: 'failed', message: describeError(error) })
    }
  }, [onSessionLost])

  useEffect(() => {
    void load()
  }, [load])

  const page = state.kind === 'ready' ? state.page : null

  return (
    <section
      aria-labelledby="proxy-logs-title"
      className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="proxy-logs-title"
            className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            反代日志
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            每次最多读取 50 条安全摘要；请求体、响应体和任意 data 字段不会发送到手机。
          </p>
        </div>
        {page ? (
          <button
            type="button"
            onClick={() => void load()}
            disabled={loadingOlder}
            className="h-11 shrink-0 rounded-xl border border-slate-300 px-3 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
          >
            刷新
          </button>
        ) : null}
      </div>

      {state.kind === 'loading' ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">日志加载中…</p>
      ) : null}

      {state.kind === 'missing' ? (
        <div className="mt-3 rounded-xl border border-amber-300 p-3 dark:border-amber-800">
          <p className="text-sm text-amber-800 dark:text-amber-300">日志数据不可用，请重试</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 h-11 w-full rounded-xl border border-amber-300 text-sm dark:border-amber-800"
          >
            重试加载日志
          </button>
        </div>
      ) : null}

      {state.kind === 'failed' ? (
        <div className="mt-3 rounded-xl border border-red-300 p-3 dark:border-red-800">
          <p className="text-sm text-red-700 dark:text-red-300">日志加载失败：{state.message}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 h-11 w-full rounded-xl border border-red-300 text-sm dark:border-red-800"
          >
            重试加载日志
          </button>
        </div>
      ) : null}

      {page ? (
        <>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            已显示 {page.entries.length} / 当前共 {page.total} 条
          </p>
          {page.entries.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">暂无反代日志</p>
          ) : (
            <ol className="mt-2 space-y-2">
              {page.entries.map((entry, index) => (
                <li
                  key={`${entry.timestamp}:${index}`}
                  className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_CLASS[entry.level]}`}
                    >
                      {entry.level}
                    </span>
                    <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {entry.category}
                    </span>
                    <time
                      dateTime={entry.timestamp}
                      className="ml-auto shrink-0 text-[11px] text-slate-400"
                    >
                      {formatLogTime(entry.timestamp)}
                    </time>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-200">
                    {entry.message}
                  </p>
                </li>
              ))}
            </ol>
          )}

          {pageError ? (
            <p className="mt-2 text-sm text-red-700 dark:text-red-300">{pageError}</p>
          ) : null}
          {page.nextCursor !== null ? (
            <button
              type="button"
              aria-label="加载更早日志"
              disabled={loadingOlder}
              onClick={() => {
                const cursor = page.nextCursor
                if (cursor === null) return
                setLoadingOlder(true)
                setPageError(null)
                void fetchProxyLogs(cursor, 50)
                  .then((older) => {
                    setState({
                      kind: 'ready',
                      page: {
                        total: older.total,
                        nextCursor: older.nextCursor,
                        entries: [...page.entries, ...older.entries]
                      }
                    })
                  })
                  .catch((error: unknown) => {
                    if (error instanceof PanelApiError && error.isUnauthorized) {
                      onSessionLost()
                      return
                    }
                    setPageError(
                      error instanceof PanelProxyLogsResponseError
                        ? '日志数据不可用，请重试'
                        : describeError(error)
                    )
                  })
                  .finally(() => setLoadingOlder(false))
              }}
              className="mt-3 h-11 w-full rounded-xl border border-slate-300 text-sm text-slate-700 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
            >
              {loadingOlder ? '加载中…' : '加载更早日志'}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
