/**
 * accountService 共享类型 · 依赖注入契约
 *
 * 为什么存在：这些业务函数原先内联在 `ipcMain.handle` 回调里，闭包引用 index.ts 的
 * 模块级 `store` / `lastSavedData` / 顶层 async 函数。为了让 IPC 与（即将新增的）
 * HTTP 面板两个传输通道共用同一份实现，把闭包依赖显式化成参数。
 *
 * 硬约束：
 *   - 本目录不得 import 'electron'（web 面板路径没有 BrowserWindow；且 vitest node env
 *     里 import electron 会炸）→ 需要 electron 能力时由 index.ts 注入函数。
 *   - 本目录不得 import preload（preload 是 renderer 的桥，不是 main 的依赖）。
 *   - 不接受 IpcMainInvokeEvent。
 */

/** electron-store 实例的最小读接口（与 index.ts:1769 的 `store` 声明一致） */
export type AccountStoreRef = {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
}

/**
 * 账号业务函数的运行时依赖包。
 *
 * 只声明本轮（W2：accounts / credentials / verify）真正用到的成员 —— 不为将来的
 * switch / refresh / check 预留字段（YAGNI；它们由并行 executor 各自扩展本类型）。
 *
 * 注意 `store` 是**惰性初始化**的：index.ts 的 `initStore()` 跑完才有值。
 * 这里要求调用方保证「已 init」，而不是在业务函数里 `await initStore()` ——
 * 后者会让 accountService 反向依赖 index.ts，形成环。
 * 故 store 用 getter 而非直接值：装配时机（app.whenReady 内注册 handler）早于
 * 首次 initStore 完成，直接传值会永久捕获 null。
 */
export interface AccountRuntimeDeps {
  /** 取已就绪的 store 实例；未 init 时抛错（不静默 no-op，见 §4.4 精准错误） */
  getStore: () => AccountStoreRef
  /** 确保 store 已初始化（index.ts:initStore 的引用；幂等） */
  ensureStore: () => Promise<void>
  /** 写盘成功后的崩溃恢复备份（index.ts:createBackup 的引用，含节流） */
  createBackup: (data: unknown) => Promise<void>
  /** 记录「最后成功写盘的 blob」，供崩溃恢复读取（index.ts 模块级 lastSavedData 的 setter） */
  setLastSavedData: (data: unknown) => void
}

// ============ Kiro 用量 API 的响应形状 ============
// 说明：index.ts 里同一份 API 响应被 4 个 handler 各自用局部 interface 声明了一遍
// （:3811 UsageApiResponse / :5177 UsageResponse / batch 与 check 内各一份）。
// 本轮把「本目录内使用的两份」合并到下面一组类型；index.ts 中另两份属并行 executor 行区间。

export interface UsageBonus {
  bonusCode?: string
  displayName?: string
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentUsage?: number
  currentUsageWithPrecision?: number
  /** ⚠️ verify 路径按 status==='ACTIVE' 过滤，sso-import 路径不过滤 —— 差异是既有行为，见各调用点注释 */
  status?: string
  expiresAt?: string
}

export interface UsageFreeTrialInfo {
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentUsage?: number
  currentUsageWithPrecision?: number
  freeTrialStatus?: string
  freeTrialExpiry?: string
}

export interface UsageBreakdownItem {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentUsage?: number
  currentUsageWithPrecision?: number
  freeTrialInfo?: UsageFreeTrialInfo
  bonuses?: UsageBonus[]
}

export interface UsageApiShape {
  userInfo?: { email?: string; userId?: string }
  subscriptionInfo?: {
    type?: string
    subscriptionTitle?: string
    upgradeCapability?: string
    overageCapability?: string
    subscriptionManagementTarget?: string
  }
  usageBreakdownList?: UsageBreakdownItem[]
  nextDateReset?: string
  overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
}

/** 归一化后的额度明细（两条导入路径共用的输出形状） */
export interface NormalizedUsage {
  current: number
  limit: number
  baseLimit: number
  baseCurrent: number
  freeTrialLimit: number
  freeTrialCurrent: number
  freeTrialExpiry?: string
  bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
  resourceDetail?: {
    displayName?: string
    displayNamePlural?: string
    resourceType?: string
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageEnabled: boolean
  }
}
