/**
 * 登录页 —— 输入 adminKey 换会话 cookie。
 *
 * ## 手机优先的取舍
 *
 * - 密钥是 43 字符 base64url，手机上多为**粘贴**而非手打 → 输入框够大、`autoComplete="off"`
 *   避免浏览器拿它当密码存（它不是用户密码，是设备间共享的短期凭据）
 * - `type="password"` + 明文切换：局域网场景常有旁人，但粘贴出错也常见，
 *   所以给一个「显示」开关，而不是二选一
 * - 提交按钮 `h-12`（48px），达到触控目标下限；键盘 Enter 也能提交（`<form onSubmit>`）
 *
 * ## 为什么错误提示只有一句「密钥不正确」
 *
 * 服务端对「密钥错」与「面板未设密钥」返回**同一个 401**（`server.ts` 注释：
 * 不告诉攻击者面板还没设密钥）。UI 不该编造出服务端没给的区分。
 */
import { useState, type FormEvent } from 'react'
import { login } from '../api/panel'
import { PanelApiError } from '../api/client'

interface LoginScreenProps {
  /** 登录成功 —— 由父层切到列表并拉数据 */
  onSuccess: () => void
}

export function LoginScreen({ onSuccess }: LoginScreenProps): React.JSX.Element {
  const [adminKey, setAdminKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    // 空密钥不发请求 —— 服务端会计入失败次数触发限流，白白消耗用户的重试额度
    if (adminKey.trim().length === 0) {
      setError('请输入管理密钥')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await login(adminKey.trim())
      onSuccess()
    } catch (err) {
      if (err instanceof PanelApiError) {
        // 429 带 Retry-After：把秒数告诉用户，否则「操作过于频繁」没有下一步动作
        setError(
          err.retryAfterSec !== undefined
            ? `尝试过于频繁，请等待 ${err.retryAfterSec} 秒后重试`
            : err.status === 401
              ? '管理密钥不正确'
              : err.message
        )
      } else {
        setError('登录失败，请重试')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Kiro 账号管理
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            输入桌面端设置页显示的管理密钥
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="admin-key"
            className="block text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            管理密钥
          </label>
          <div className="flex gap-2">
            <input
              id="admin-key"
              // 密钥是粘贴来的随机串，不该被输入法纠正 / 自动大写 / 存成密码
              type={reveal ? 'text' : 'password'}
              inputMode="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              disabled={busy}
              className="h-12 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              // 独立可点区域 48px，不是 hover 才出现的图标
              className="h-12 shrink-0 rounded-xl border border-slate-300 px-3 text-sm text-slate-600 active:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:active:bg-slate-800"
              aria-pressed={reveal}
            >
              {reveal ? '隐藏' : '显示'}
            </button>
          </div>
        </div>

        {error !== null && (
          <div
            role="alert"
            className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="h-12 w-full rounded-xl bg-blue-600 text-base font-medium text-white active:bg-blue-700 disabled:opacity-60"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
