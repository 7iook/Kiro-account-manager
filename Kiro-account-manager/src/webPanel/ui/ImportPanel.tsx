/**
 * 手机端导入 ksk_ 密钥 —— 折叠式表单
 *
 * ## 为什么是折叠的
 *
 * 面板的主视角是「看额度 / 刷额度」，导入是低频动作。默认展开会把账号列表推下一屏，
 * 而手机屏幕高度是稀缺资源。折起来只占一行。
 *
 * ## 为什么不做「导入前先测活」
 *
 * 桌面端有 `handleApiKeyProbe`（`AddAccountDialog.tsx:1400` 起），它对每个密钥发一次
 * **真实推理请求**来判断是否可用。手机端刻意不做，三个理由：
 *   1. 它烧真实额度 —— 用户在手机上点一下就消耗配额，代价不直观；
 *   2. 它串行、每个密钥一次网络往返，手机上等待感极差且没有取消入口；
 *   3. 导入路径**已经**有凭据校验（`verifyApiKey` 的四态判定），无效 / 被封 / 暂时无法验证的
 *      密钥根本进不了池。测活解决的是"能不能推理"（额度层），不是"密钥有没有效"（凭据层），
 *      而后者才是导入要拦的。
 * 需要测活的用户去桌面端 —— 那里有完整的逐行进度与额度展示。
 */
import { useState } from 'react'
import { importApiKeys, type ApiKeyImportResponse, type ApiKeyImportCode } from '../api/panel'
import { PanelApiError } from '../api/client'

/** code → 中文文案。服务端给的 `reason` 优先（含上游具体原因），这里是兜底 */
const CODE_TEXT: Record<ApiKeyImportCode, string> = {
  IMPORTED: '已导入',
  BAD_FORMAT: '格式错误（应以 ksk_ 开头）',
  INVALID: '密钥无效或已吊销',
  SUSPENDED: '账号已被 Kiro 暂停',
  INDETERMINATE: '暂时无法验证，请稍后重试',
  MISSING_FINGERPRINT: '校验结果异常，已跳过',
  ALREADY_EXISTS: '账号已存在',
  VERIFY_ERROR: '校验失败',
  WRITE_CONFLICT: '数据已被其它端修改，请重新提交'
}

export interface ImportPanelProps {
  /**
   * 导入成功后触发（调用方据此重拉列表）。
   * 只在**至少有一条成功**时调用 —— 全部失败时重拉列表是白跑一次请求。
   */
  onImported: () => void | Promise<void>
}

export function ImportPanel({ onImported }: ImportPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApiKeyImportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (busy) return
    if (input.trim().length === 0) {
      setError('请先粘贴至少一个 ksk_ 密钥')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await importApiKeys(input)
      setResult(res)
      if (res.imported > 0) {
        // 成功项已落盘，清空输入框避免用户再点一次（再点会得到 ALREADY_EXISTS，
        // 不会产生脏数据，但会让人以为出错了）
        setInput('')
        await onImported()
      }
    } catch (err) {
      // 401 由 App 顶层的 runAction 统一处置；这里是独立提交路径，所以自己也要认它
      if (err instanceof PanelApiError && err.isUnauthorized) {
        setError('登录已失效，请重新登录')
      } else {
        setError(err instanceof PanelApiError ? err.message : '导入失败，请重试')
      }
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 h-11 w-full rounded-xl border border-dashed border-slate-300 text-sm text-slate-600 active:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:active:bg-slate-800"
      >
        + 粘贴 API Key 导入账号
      </button>
    )
  }

  return (
    <section
      aria-label="导入 API Key"
      className="mb-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">导入 API Key</h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setResult(null)
            setError(null)
          }}
          className="h-9 rounded-lg px-2 text-sm text-slate-500 active:bg-slate-100 dark:active:bg-slate-800"
        >
          收起
        </button>
      </div>

      <label htmlFor="apikey-input" className="sr-only">
        API Key（每行一个，ksk_ 开头）
      </label>
      <textarea
        id="apikey-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={'ksk_...\n每行一个，可一次粘贴多个'}
        rows={3}
        // 手机键盘不要自动大写 / 自动纠错 —— 密钥被改一个字符就白跑一次校验
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
      />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="mt-2 h-11 w-full rounded-xl bg-slate-900 text-sm font-medium text-white active:bg-slate-700 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
      >
        {busy ? '导入中…' : '导入'}
      </button>

      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {result !== null && (
        <div role="status" className="mt-2 text-sm">
          <p className="text-slate-700 dark:text-slate-200">
            共 {result.total} 个 · 成功 {result.imported} · 失败 {result.failed}
          </p>
          {result.results.some((r) => r.code !== 'IMPORTED') && (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
              {result.results
                .filter((r) => r.code !== 'IMPORTED')
                .map((r, i) => (
                  // label 是服务端给的掩码，不是明文密钥
                  <li key={`${r.label}-${i}`}>
                    <span className="font-mono">{r.label}</span>：{r.reason ?? CODE_TEXT[r.code]}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
