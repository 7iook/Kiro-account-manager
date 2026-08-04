/**
 * accountService · 账号业务函数汇总导出
 *
 * 定位：`ipcMain.handle` 回调里原本内联的业务逻辑，剥离到此目录后成为
 * **传输通道无关**的可复用函数。IPC 与（即将新增的）局域网 web 面板 HTTP 路由
 * 调用同一份实现 —— 决策卡 §1 不变量 1「web 面板不得包含任何业务逻辑」的落点。
 *
 * 硬约束（本目录所有文件）：
 *   - 不 import 'electron'（web 面板路径没有 BrowserWindow；vitest node env 里也会炸）
 *   - 不 import preload（preload 是 renderer 的桥，不是 main 的依赖）
 *   - 函数签名不接受 IpcMainInvokeEvent
 *   - 账号写入只经 state.ts 的 applyAccountDataMutation（revision 乐观锁 SSOT），
 *     不得新增 store.set('accountData', …) 路径
 *
 * 装配方：src/main/index.ts（app 生命周期 + deps 组装 + 薄 handler 注册）。
 */

// 写入收口（W1）
export {
  applyAccountDataMutation,
  setStoreRef,
  setLastSavedDataSetter,
  setBroadcaster,
  type AccountsBlob,
  type ApplyResult,
  type BroadcastPayload
} from './state'

// 依赖契约与共享类型
export type {
  AccountStoreDeps,
  AccountStoreRef,
  UsageApiShape,
  NormalizedUsage
} from './types'

// 账号数据读写
export { loadAccounts, saveAccounts } from './accounts'

// 本机 Kiro 凭证读取
export {
  getLocalActiveAccount,
  loadKiroCredentials,
  type CredentialFsDeps,
  type LocalActiveAccountResult,
  type LoadKiroCredentialsResult
} from './credentials'

// 凭证验证与导入
export {
  computeTokenFingerprint,
  verifyApiKey,
  importFromSsoToken,
  verifyAccountCredentials,
  type VerifyApiDeps,
  type VerifyCredentialsInput,
  type VerifyCredentialsResult
} from './verify'

// ksk_ 导入用例（桌面端 IPC 与 web 面板 HTTP 的唯一实现 —— 判重 / 四态 / userId 派生的 SSOT）
export {
  importApiKeys,
  type ApiKeyImportDeps,
  type ApiKeyImportInput,
  type ApiKeyImportResult,
  type ApiKeyImportItemResult,
  type ApiKeyImportCode
} from './importApiKey'

// 归一化工具（SSOT · 消除 index.ts 内的逐字副本）
// 订阅类型判定 SSOT 统一到 parseUsage.ts（W2/W3 曾各抽一份等价实现，合并时合一）
export { classifySubscriptionType } from './parseUsage'
export { normalizeCreditUsage, computeDaysRemaining } from './usage'
