/**
 * 局域网 Web 面板浏览器端入口。
 *
 * 挂载点 id `webpanel-root`（`index.html` 中定义）与 `./styles.css` 的导入
 * 都必须保留 —— 前者是 HTML 契约，后者是 tailwind entry。
 */
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'

/**
 * 打包产物校验测试据此断言 bundle 真实存在，勿改动字面量。
 *
 * 占位页被真实 UI 替换后仍保留它：`test/main/architecture/webpanel_build_assets.test.ts`
 * 校验的是「入口 HTML 引用的 JS/CSS 真的在盘上」，而这个常量是 bundle 内容里
 * 唯一一个稳定可 grep 的锚点 —— 若哪天需要断言「产物里确有面板代码而非空 chunk」，
 * 靠的就是它。导出而非内联，避免被 tree-shaking 判成死代码删掉。
 */
export const WEBPANEL_BUILD_MARKER = 'kiro-webpanel-bundle-ok'

const container = document.getElementById('webpanel-root')
if (container) {
  // 标记写进挂载点的 data 属性：既保证常量被真实引用（不被 tree-shake），
  // 又不在界面上显示一串对用户无意义的字符。
  container.dataset.webpanelBuild = WEBPANEL_BUILD_MARKER
  createRoot(container).render(<App />)
}
