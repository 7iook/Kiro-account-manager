/**
 * 面板内账号集合失效通知。
 *
 * 事件只表示“去服务端重读”，不携带账号快照，更不成为第二个数据真源。AccountCard
 * 无权直接改 ProxyPanel 的候选列表；后者收到通知后重新 GET `/accounts`，避免删除
 * 成功后仍从 App 的旧 props 展示已不存在的账号。
 */
export const PANEL_ACCOUNTS_INVALIDATED_EVENT = 'kiro-panel:accounts-invalidated'

export function announcePanelAccountsInvalidated(): void {
  window.dispatchEvent(new Event(PANEL_ACCOUNTS_INVALIDATED_EVENT))
}
