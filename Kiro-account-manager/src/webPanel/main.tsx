/**
 * 局域网 Web 面板浏览器端入口 —— **占位实现,待 W6 UI 包替换**。
 *
 * 本文件当前唯一职责:让构建管线(HTML entry → tsx → React → tailwind → out/webPanel/)
 * 端到端可验证。渲染一个可被断言识别的标记(见 WEBPANEL_BUILD_MARKER),
 * 打包产物校验测试靠它确认 bundle 真的被构建进去了。
 *
 * 替换本文件时请保留:
 *   - 挂载点 id `webpanel-root`(index.html 中定义)
 *   - `./styles.css` 的导入(tailwind entry)
 */
import { createRoot } from 'react-dom/client'
import './styles.css'

/** 打包产物校验测试据此断言 bundle 真实存在,勿随意改动字面量。 */
export const WEBPANEL_BUILD_MARKER = 'kiro-webpanel-bundle-ok'

function PlaceholderApp(): React.JSX.Element {
  return (
    <div className="p-6 font-sans text-sm">
      <h1 className="text-lg font-semibold">Kiro 账号管理 · 局域网面板</h1>
      <p data-testid="webpanel-placeholder">{WEBPANEL_BUILD_MARKER}</p>
      <p>构建管线占位页,UI 实现由 W6 提供。</p>
    </div>
  )
}

const container = document.getElementById('webpanel-root')
if (container) {
  createRoot(container).render(<PlaceholderApp />)
}
