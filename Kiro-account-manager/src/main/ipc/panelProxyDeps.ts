/**
 * 面板反代端点的生产实现 —— 把 `proxy/activation.ts` 的编排接到真实 proxyServer
 *
 * ## 为什么单独一个文件
 *
 * `index.ts` 已 7000+ 行且有并行 executor 在改它。这里收下全部装配逻辑，
 * `index.ts` 只需在 `buildPanelRouteDeps({...})` 里多传一个展开
 * （`...buildPanelProxyDeps({...})`），冲突面最小。
 *
 * ## 这一层做什么、不做什么
 *
 * **做**：把 `index.ts` 持有的模块级可变状态（惰性 `proxyServer` / `store`）
 * 包装成 `ProxyActivationHost`，并把三个既有 IPC 背后的动作（start / stop /
 * 同步池）转成面板可调的形状。
 *
 * **不做**：任何顺序编排。选号的三步顺序在 `activation.ts`；「先同步池再启动」
 * 在本文件的 `proxyStart` 里且只此一处。路由层与面板 UI 都不重复这个顺序 ——
 * 顺序有第二个真源时，两处早晚分叉，表现是「面板绿灯但反代打旧号」。
 */
import {
  activateProxyAccount,
  buildProxyAccountsFromStore,
  type ProxyActivationHost,
  type ProxyBindingContext
} from '../proxy/activation'
import type { AccountPool } from '../proxy/accountPool'
import type { ProxyConfig } from '../proxy/types'

/** 反代服务器的最小接口（避免把整个 ProxyServer 类型拖进来） */
export interface ProxyServerRef {
  isRunning: () => boolean
  getAccountPool: () => AccountPool
  getConfig: () => ProxyConfig
  updateConfig: (patch: Partial<ProxyConfig>) => void
  invalidateSessionAffinity: () => number
  start: () => Promise<void>
  stop: () => Promise<void>
  getStats: () => { totalRequests: number; successRequests: number; failedRequests: number }
}

export interface PanelProxyDepsImpl {
  /**
   * 取已初始化的反代实例；未初始化返回 null。
   *
   * 刻意**不**在这里惰性 `initProxyServer()`：隐式初始化会让「反代未运行」这个
   * 状态难以如实回报，而面板的运行态判据必须真实。启动端点自己负责初始化。
   */
  getProxyServer: () => ProxyServerRef | null
  /** 惰性初始化并返回实例（仅启动路径用） */
  initProxyServer: () => ProxyServerRef
  /** 从盘上读 `accountData`（账号表 + 出口代理绑定） */
  loadAccountData: () => {
    accounts?: Record<string, unknown>
    accountProxyBindings?: Record<string, string>
    proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
  } | undefined
  /** 把当前配置写回 store（对齐 `proxy-update-config` 的持久化行为） */
  persistProxyConfig: (config: ProxyConfig) => void
  /** 托盘菜单状态刷新（桌面端启停后会做，面板启停也要做，否则托盘显示与实际不符） */
  updateTrayMenu?: () => void
  /** 停止前归档会话统计（对齐 `proxy-stop` 的既有行为） */
  archiveSessionIfAny?: () => void
}

/** 面板可见的反代状态。**不含任何凭据** —— 只有 id / email 级别的标识 */
export interface PanelProxyStatus {
  success: true
  running: boolean
  port?: number
  host?: string
  enableMultiAccount: boolean
  /** 单账号模式下用户指定的账号；多账号模式为 undefined */
  selectedAccountId?: string
  selectedAccountEmail?: string
  poolSize: number
  availableCount: number
  /**
   * 已服务的请求总数。
   *
   * 面板的「停止」不做优雅停止 —— 桌面端 `ProxyPanel.tsx:352` 也是直接停，
   * 引入面板独有的优雅停止会让两端行为分叉。取而代之：把请求统计如实回传，
   * 让用户自己判断现在停是否合适。这是有意的取舍，不是遗漏。
   */
  totalRequests: number
  successRequests: number
  failedRequests: number
}

function bindingContext(data: ReturnType<PanelProxyDepsImpl['loadAccountData']>): ProxyBindingContext {
  return {
    bindings: data?.accountProxyBindings ?? {},
    proxyPool: data?.proxyPool ?? {}
  }
}

/**
 * 把宿主能力包装成 `ProxyActivationHost`。
 *
 * `loadAccountRecords` 每次都从盘上现读 —— 编排的「凭据不接受调用方快照」
 * 这条纪律就落在这里：HTTP 请求体里只有 accountId，凭据一律现取。
 */
function makeActivationHost(impl: PanelProxyDepsImpl, server: ProxyServerRef): ProxyActivationHost {
  return {
    isRunning: () => server.isRunning(),
    getAccountPool: () => server.getAccountPool(),
    getConfig: () => server.getConfig(),
    updateConfig: (patch) => {
      server.updateConfig(patch)
      // 与 `proxy-update-config` 一致地持久化：不写盘的话，下次自启动会丢掉
      // 用户在手机上的选号，表现为「昨天选好的号今天自己变了」。
      impl.persistProxyConfig(server.getConfig())
    },
    invalidateSessionAffinity: () => server.invalidateSessionAffinity(),
    loadAccountRecords: () => impl.loadAccountData()?.accounts ?? {}
  }
}

/** 同步整池：清空后按盘上账号重建（对齐 `proxy-sync-accounts` 的语义） */
function syncPool(impl: PanelProxyDepsImpl, server: ProxyServerRef): number {
  const data = impl.loadAccountData()
  const accounts = buildProxyAccountsFromStore(data?.accounts, bindingContext(data))
  const pool = server.getAccountPool()
  pool.clear()
  for (const a of accounts) pool.addAccount(a)
  return pool.size
}

/**
 * 组装面板的五个反代端点实现。
 *
 * 返回值直接展开进 `buildPanelRouteDeps({...})`。
 */
export function buildPanelProxyDeps(impl: PanelProxyDepsImpl): {
  proxyGetStatus: () => Promise<unknown>
  proxySyncPool: () => Promise<unknown>
  proxyActivateAccount: (accountId: string) => Promise<unknown>
  proxyStart: () => Promise<unknown>
  proxyStop: () => Promise<unknown>
} {
  const status = (): PanelProxyStatus | { success: true; running: false; poolSize: 0; availableCount: 0; enableMultiAccount: boolean; totalRequests: 0; successRequests: 0; failedRequests: 0 } => {
    const server = impl.getProxyServer()
    if (!server) {
      // 未初始化 ≠ 出错。如实回报「没在跑」，让面板显示真实状态。
      return {
        success: true,
        running: false,
        poolSize: 0,
        availableCount: 0,
        enableMultiAccount: false,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0
      }
    }
    const config = server.getConfig()
    const pool = server.getAccountPool()
    const stats = server.getStats()
    const selectedId = config.enableMultiAccount === false ? config.selectedAccountIds?.[0] : undefined
    const out: PanelProxyStatus = {
      success: true,
      // 真实判据：读 server 句柄。不是"我发过启动请求所以应该在跑"
      running: server.isRunning(),
      port: config.port,
      host: config.host,
      enableMultiAccount: config.enableMultiAccount === true,
      poolSize: pool.size,
      availableCount: pool.availableCount,
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests
    }
    if (selectedId) {
      out.selectedAccountId = selectedId
      const acc = pool.getAccount(selectedId)
      if (acc?.email) out.selectedAccountEmail = acc.email
    }
    return out
  }

  return {
    proxyGetStatus: async () => status(),

    proxySyncPool: async () => {
      const server = impl.getProxyServer()
      if (!server) return { success: false, error: 'PROXY_NOT_RUNNING' }
      const poolSize = syncPool(impl, server)
      return { success: true, poolSize }
    },

    proxyActivateAccount: async (accountId: string) => {
      const server = impl.getProxyServer()
      // 反代没跑就没有"当前账号"。不隐式启动 —— 那会绕过启动路径的空池检查。
      if (!server) return { success: false, error: 'PROXY_NOT_RUNNING' }
      const result = activateProxyAccount(
        accountId,
        makeActivationHost(impl, server),
        bindingContext(impl.loadAccountData())
      )
      if (!result.applied) return { success: false, error: result.reason }
      impl.updateTrayMenu?.()
      return { success: true, mode: result.mode, accountId: result.accountId, email: result.email }
    },

    proxyStart: async () => {
      try {
        const server = impl.initProxyServer()
        // 顺序承重：**先同步池，再启动**。颠倒或漏掉同步会用空池启动 ——
        // 反代起来了、状态显示正常、但每个外部请求都失败，且所有指示灯都是绿的。
        const poolSize = syncPool(impl, server)
        if (poolSize === 0) {
          // 空池启动是负条件。宁可拒绝启动，也不让用户面对"看起来正常但全失败"。
          return { success: false, error: 'EMPTY_POOL' }
        }
        await server.start()
        impl.updateTrayMenu?.()
        return {
          success: true,
          // 真实读数，不是乐观更新
          running: server.isRunning(),
          port: server.getConfig().port,
          poolSize
        }
      } catch (error) {
        // 启动失败原因如实回传（端口占用是最常见的一种），不吞
        console.error('[panelProxy] start failed:', error)
        return { success: false, error: error instanceof Error ? error.message : 'PROXY_START_FAILED' }
      }
    },

    proxyStop: async () => {
      try {
        const server = impl.getProxyServer()
        // 已经没在跑 → 幂等成功。手机端连点停止不该报错。
        if (!server) return { success: true, running: false }
        impl.archiveSessionIfAny?.()
        await server.stop()
        impl.updateTrayMenu?.()
        return { success: true, running: server.isRunning() }
      } catch (error) {
        console.error('[panelProxy] stop failed:', error)
        return { success: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }
      }
    }
  }
}
