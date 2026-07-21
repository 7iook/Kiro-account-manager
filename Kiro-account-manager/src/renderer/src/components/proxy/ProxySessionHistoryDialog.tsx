import { useState, useEffect, useCallback } from 'react'
import { X, Trash2, Download, History, RefreshCw } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'

export interface ProxySessionRecord {
  id: string
  startTime: number
  endTime: number
  durationMs: number
  totalRequests: number
  successRequests: number
  failedRequests: number
  credits: number
  inputTokens: number
  outputTokens: number
}

interface ProxySessionHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isEn: boolean
}

function fmtTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '-'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function ProxySessionHistoryDialog({ open, onOpenChange, isEn }: ProxySessionHistoryDialogProps) {
  const [sessions, setSessions] = useState<ProxySessionRecord[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.proxyGetSessionHistory()
      setSessions(result as ProxySessionRecord[])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const handleClear = async () => {
    await window.api.proxyClearSessionHistory()
    setSessions([])
  }

  const handleExport = () => {
    const header = 'startTime,endTime,durationMs,totalRequests,successRequests,failedRequests,credits,inputTokens,outputTokens'
    const rows = sessions.map(s =>
      [fmtTime(s.startTime), fmtTime(s.endTime), s.durationMs, s.totalRequests, s.successRequests, s.failedRequests, s.credits.toFixed(6), s.inputTokens, s.outputTokens].join(',')
    )
    const content = [header, ...rows].join('\n')
    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `proxy-sessions-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!open) return null

  const totalCredits = sessions.reduce((sum, s) => sum + s.credits, 0)
  const totalReq = sessions.reduce((sum, s) => sum + s.totalRequests, 0)
  const totalIn = sessions.reduce((sum, s) => sum + s.inputTokens, 0)
  const totalOut = sessions.reduce((sum, s) => sum + s.outputTokens, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/[0.12] dark:bg-black/50 backdrop-blur-xl" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[860px] max-h-[80vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong flex flex-col">
        <CardHeader className="pb-3 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              {isEn ? 'Session History' : '会话历史'}
              <Badge variant="secondary" className="text-xs">{sessions.length}</Badge>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={load} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                {isEn ? 'Refresh' : '刷新'}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleExport} disabled={sessions.length === 0}>
                <Download className="h-4 w-4 mr-1" />
                {isEn ? 'Export' : '导出'}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleClear} disabled={sessions.length === 0}>
                <Trash2 className="h-4 w-4 mr-1" />
                {isEn ? 'Clear' : '清空'}
              </Button>
              <button className="p-1 rounded hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground tabular-nums">
            <span>{isEn ? 'Total sessions' : '会话总数'}: <span className="text-foreground font-medium">{sessions.length}</span></span>
            <span>{isEn ? 'Total requests' : '总请求'}: <span className="text-foreground font-medium">{totalReq.toLocaleString()}</span></span>
            <span>{isEn ? 'Total credits' : '总额度'}: <span className="text-amber-500 font-medium">{totalCredits.toFixed(2)}</span></span>
            <span>{isEn ? 'Total tokens' : '总 Tokens'}: <span className="text-foreground font-medium">{(totalIn + totalOut).toLocaleString()}</span></span>
          </div>
        </CardHeader>

        <CardContent className="pt-2 overflow-y-auto flex-1">
          {sessions.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {isEn ? 'No session records yet. A session is recorded automatically when you stop the service.' : '暂无会话记录。每次停止服务后会自动记录本次会话。'}
            </div>
          ) : (
            <div className="text-xs">
              <div className="grid gap-2 py-2 px-2 font-medium text-muted-foreground border-b sticky top-0 bg-background/80 backdrop-blur" style={{ gridTemplateColumns: '1.5fr 1.5fr 0.7fr 0.6fr 0.55fr 0.55fr 0.85fr 0.9fr 0.8fr' }}>
                <span>{isEn ? 'Start' : '开始'}</span>
                <span>{isEn ? 'End' : '结束'}</span>
                <span className="text-right">{isEn ? 'Duration' : '时长'}</span>
                <span className="text-right">{isEn ? 'Requests' : '请求'}</span>
                <span className="text-right text-success">{isEn ? 'OK' : '成功'}</span>
                <span className="text-right text-destructive">{isEn ? 'Fail' : '失败'}</span>
                <span className="text-right">{isEn ? 'Credits' : '额度'}</span>
                <span className="text-right">{isEn ? 'Input' : '输入'}</span>
                <span className="text-right">{isEn ? 'Output' : '输出'}</span>
              </div>
              {sessions.map((s) => (
                <div key={s.id} className="grid gap-2 py-1.5 px-2 rounded hover:bg-muted/50 items-center font-mono tabular-nums" style={{ gridTemplateColumns: '1.5fr 1.5fr 0.7fr 0.6fr 0.55fr 0.55fr 0.85fr 0.9fr 0.8fr' }}>
                  <span className="text-muted-foreground whitespace-nowrap">{fmtTime(s.startTime)}</span>
                  <span className="text-muted-foreground whitespace-nowrap">{fmtTime(s.endTime)}</span>
                  <span className="text-right">{fmtDuration(s.durationMs)}</span>
                  <span className="text-right">{s.totalRequests.toLocaleString()}</span>
                  <span className="text-right text-success">{s.successRequests.toLocaleString()}</span>
                  <span className="text-right text-destructive">{s.failedRequests.toLocaleString()}</span>
                  <span className="text-right text-amber-500">{s.credits.toFixed(2)}</span>
                  <span className="text-right text-muted-foreground">{s.inputTokens.toLocaleString()}</span>
                  <span className="text-right text-muted-foreground">{s.outputTokens.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
