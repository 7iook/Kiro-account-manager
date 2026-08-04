/**
 * accountService 共享契约 · 依赖注入形状
 *
 * 目的:让账号业务逻辑脱离 ipcMain.handle 回调,IPC 与(将来的)web 面板 HTTP 两个
 * 传输通道复用同一份实现。约束(决策卡 §3):
 *   - 业务层**不得**依赖 preload(preload 是 renderer 的桥)
 *   - 业务层**不得**接收 Electron IpcMainInvokeEvent
 *   - 原先闭包捕获的模块级可变状态(mainWindow / lastSwitchedAccountId /
 *     lastWrittenTokenSignature / proactiveRenewalEnabled / proxyServer)改为显式依赖
 *
 * 可变状态一律走 getter/setter 而非传值:index.ts 里的 IDE token watcher 与
 * ProactiveRenewal 定时器**也读**这些变量,传值会产生两个副本(recon §3 要点 2)。
 */

/** 反代账号池中账号的最小形状(只用到绑定代理) */
export interface PoolAccountRef {
  proxyUrl?: string
}

/**
 * 反代服务实例的最小形状(账号池查询)。
 * getAccount 返回 `| null | undefined` 两种空值:ProxyServer 实际返回 null,
 * 这里放宽以兼容(调用方一律 `?.proxyUrl`,两者行为相同)。
 */
export interface ProxyServerRef {
  getAccountPool: () => {
    getAccount: (id: string) => PoolAccountRef | null | undefined
  }
}

/**
 * 事件出口:替代原先直接调用 `mainWindow?.webContents.send(...)`。
 *
 * 保留原语义中的**静默 no-op 容错**:主窗口已关闭时 send 不抛错(recon §7.2 要点 7)。
 * 实现方(index.ts)负责这一点;业务层只管调用。
 * 将来 web 面板注入 SSE / WebSocket 广播版本即可复用同一批业务函数。
 */
export type EmitEvent = (channel: string, payload: unknown) => void

/** OIDC 刷新结果(镜像 index.ts refreshTokenByMethod 的返回形状) */
export interface RefreshTokenResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

/** GetUserInfo 响应(镜像 index.ts:1754 UserInfoResponse) */
export interface UserInfoLike {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

/** 写入 Kiro IDE SSO token 文件的入参(镜像 kiroAuthSync.WriteKiroAuthTokenInput) */
export interface WriteKiroTokenInput {
  accessToken: string
  refreshToken: string
  expiresAtIso: string
  authMethod: 'IdC' | 'social' | 'external_idp'
  /** 上游必填;调用方一律用 `provider || diskToken?.provider || 'BuilderId'` 兜底 */
  provider: string
  region?: string
  startUrl?: string
  clientId?: string
  clientSecret?: string
  profileArn?: string
}

/** 磁盘上的 Kiro IDE SSO token 文件形状(只用到这几个字段) */
export interface KiroTokenFileLike {
  refreshToken?: string
  provider?: unknown
  region?: string
  profileArn?: string
}

/**
 * 上游 API / 磁盘同步依赖。
 *
 * 为何注入而非直接 import:`getUsageAndLimits` / `refreshTokenByMethod` / `getUserInfo` /
 * `kiroApiRequest` 都是 index.ts 内部的**模块私有函数**(:1030 / :1281 / :1608 / :1762),
 * 且它们依赖 index.ts 里的模块级配置(currentUsageApiType 等)。本轮范围是抽 handler 业务体,
 * 把这些 API 层函数一并搬走会溢出到 index.ts 的其它区段(与并行的两个 executor 撞车),
 * 故本轮注入。它们各自成模块是独立的后续项(见报告"技术债")。
 */
export interface AccountServiceApi {
  getUsageAndLimits: (
    accessToken: string,
    idp?: string,
    profileArn?: string,
    accountMachineId?: string,
    ssoRegion?: string,
    email?: string,
    authMethod?: string
  ) => Promise<unknown>
  getUserInfo: (
    accessToken: string,
    idp?: string,
    accountMachineId?: string,
    email?: string
  ) => Promise<UserInfoLike>
  refreshTokenByMethod: (
    token: string,
    clientId: string,
    clientSecret: string,
    region?: string,
    authMethod?: string,
    proxyUrl?: string,
    externalIdp?: { tokenEndpoint?: string; scopes?: string }
  ) => Promise<RefreshTokenResult>
  fetchEnterpriseProfileArn: (account: {
    id: string
    accessToken: string
    region: string
    provider?: string
    authMethod?: 'IdC' | 'social' | 'idc' | 'external_idp'
    machineId?: string
  }) => Promise<string | undefined>
  readKiroAuthTokenFile: () => Promise<KiroTokenFileLike | null>
  writeKiroAuthTokenFile: (input: WriteKiroTokenInput) => Promise<unknown>
  resolveProfileArnForWrite: (input: {
    profileArn?: string
    authMethod?: string
    provider?: string
    region?: string
  }) => string | undefined
}

/** 账号业务函数的依赖包 */
export interface AccountRuntimeDeps {
  /** 反代服务;未启动时为 null(账号绑定代理查询会退化为 undefined) */
  proxyServer: ProxyServerRef | null
  /** 事件出口(进度 / 逐条结果推送) */
  emit: EmitEvent
  /** Kiro 上游 API + 磁盘同步(见 AccountServiceApi 注释:为何注入而不 import) */
  api: AccountServiceApi

  // ---- 与 index.ts 内 watcher / 定时器共享的可变状态(getter/setter,不可传值) ----
  /** 最近一次 switch-account 的账号 id;IDE 反向同步匹配兜底 */
  getLastSwitchedAccountId: () => string | null
  setLastSwitchedAccountId: (id: string | null) => void
  /** 上次刷写 SSO 磁盘的 `access|refresh` 指纹;用于 dedupe watcher 回环 */
  getLastWrittenTokenSignature: () => string | null
  setLastWrittenTokenSignature: (sig: string | null) => void
  /** 主动续期开关(用户可在设置页切换,故必须实时读) */
  isProactiveRenewalEnabled: () => boolean
  /** 主动续期调度(基于新 expiresAt 覆盖旧 timer) */
  scheduleProactiveRenewal: (accountId: string, expiresAtMs: number) => void

  /**
   * 并发刷新去重集合(与 index.ts 的主进程调度器共享同一实例)。
   * 渲染进程定时器与主进程调度器可能同时触发同一账号的刷新,
   * 对同一 refreshToken 并发刷新会让其中一个用到被 rotate 作废的旧 token。
   */
  refreshInFlightIds: Set<string>
}

/** 账号凭证(各字段均可缺失,由 authMethod 决定哪些必需) */
export interface AccountCredentials {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  provider?: string
  startUrl?: string
  tokenEndpoint?: string
  scopes?: string
  expiresAt?: number
  profileArn?: string
}

/** 单账号检查 / 刷新的入参形状(renderer 传入的账号快照) */
export interface AccountLike {
  id?: string
  email?: string
  idp?: string
  profileArn?: string
  machineId?: string
  credentials?: AccountCredentials
  subscription?: { type?: string }
}

/**
 * 业务函数返回形状。
 *
 * ⚠️ 刻意保留现有 IPC 响应的**不统一**形状(有的 error 是 string,有的是 `{ message }`)。
 * 26 个 renderer 组件已适配这种不一致,"顺手统一"会让前端全线炸(recon §7.2 要点 6)。
 * web 面板的统一错误码契约(决策卡 §3)在 HTTP 适配层做,不改业务层返回值。
 */
export type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: { message: string; isBanned?: boolean } }

/** 批量操作的汇总结果(与原 handler 返回形状一致) */
export interface BatchSummary {
  success: true
  completed: number
  successCount: number
  failedCount: number
}
