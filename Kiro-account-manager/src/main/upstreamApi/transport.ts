/**
 * 上游 API 的传输层：代理选择策略 + 通用 fetch + CBOR RPC + UA / 设备 ID 生成。
 *
 * ## 为什么是工厂而不是模块级函数
 *
 * `createUpstreamApi(deps)` 让「**一个进程一个实例**」在类型上可见。理由是
 * single-flight 表（见 `refresh.ts` 的 `inFlightRefreshByToken`）：两个实例 =
 * 两张表 = 同一个 rotating refreshToken 可能被并发刷两次 → 后到的用已作废 token
 * → 401 → **账号被上游踢下线**。工厂形态下测试可以造独立实例互不污染，
 * 生产侧由装配层保证只建一次（门禁 `upstream_api_single_instance.test.ts` 守这一条）。
 *
 * ## 注入什么、不注入什么（四项裁决，理由见 upstream-api-recon/findings.md §5）
 *
 * 1. **single-flight Map 不注入** —— 它的不变量作用域就是模块实例。做成注入项就
 *    多了个「谁传进来」的问题，任何调用方漏传 / 传新 Map，去重静默失效，
 *    而失效表现是账号掉线、只在生产并发下出现。
 * 2. **`getUsageApiType` 注入 getter，真源留在 store**（`usageApiType` 键，两端已由
 *    `AccountStorePort` 统一）。新模块自己持一份 `let` 会造第二个真源：
 *    设置页显示 cbor、实际发 rest，且无任何报错。
 * 3. **`getNetworkAgent` 整块下沉，只注入 `useKProxy` 一个布尔 getter**。四级优先级
 *    （账号绑定代理 > K-Proxy > env > 系统代理 > 直连）是一段**策略**不是状态；
 *    把 `useKProxyForApi` 与 `getKProxyService` 分开注入会让策略散在两端装配层，
 *    日后改优先级要改两处。
 * 4. **设备 ID 注入 getter 且改名 `getDeviceIdForUa`** —— index.ts 里那个本地
 *    `getCurrentMachineId` 与 `machineId.ts` 的同名导出**不是一回事**：后者是系统机器码
 *    命名空间（UUID / Windows MachineGuid），这里要的是**账号绑定域**的
 *    （`kproxy.getDeviceId()`，64 hex）。混用有先例：commit `fce8c89` 误注入
 *    `generateRandomMachineId`，UUID 形态拼进 UA 后匹配不上
 *    `kproxy/mitmProxy.ts:17 KIRO_UA_REGEX`（只认 64 hex），ksk_ 账号的设备 ID 改写
 *    **静默失效**。改名是为了物理上消除这个同名歧义。
 */
import { encode, decode } from 'cbor-x'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Dispatcher } from 'undici'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'
import type { UsageApiType } from './types'

// ============ Kiro API 调用 ============
export const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'
// REST API 端点配置(2026-07 迁移,per-region)
// - V2:management.{region}.kiro.dev — 实测 eu 账户发到 us host 会 403 Invalid token
// - V1:q.{region}.amazonaws.com(旧,保留作 fallback — eu 侧已停服/us 侧 grace period)
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://management.us-east-1.kiro.dev',
  'eu-central-1': 'https://management.eu-central-1.kiro.dev'
}
const KIRO_REST_API_ENDPOINTS_V1_FALLBACK: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

// 根据 SSO 区域映射到最近的 REST API 端点(V2 全局)
export function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

// 获取备用 REST API 端点(用于 fallback,返 V1 旧 host)
export function getFallbackRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS_V1_FALLBACK['us-east-1']
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS_V1_FALLBACK['eu-central-1']
  return KIRO_REST_API_ENDPOINTS_V1_FALLBACK['us-east-1']
}

// 社交登录 (GitHub/Google) 的 Token 刷新端点
export const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// Kiro 版本和 User-Agent 生成
export const KIRO_VERSION = '0.6.18'

export function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
}

export function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ${suffix}`
}

export function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** K-Proxy 服务的最小形状：只要 `getNetworkAgent` 真正读到的那三个方法。
 *  与 `afe80af` 给持久化端口定的规矩同源 —— 端口只放实测有消费者的成员。 */
export interface KProxyServiceLike {
  isRunning: () => boolean
  getConfig: () => { host: string; port: number }
}

/** 上游 API 工厂的依赖包。全部是 **getter 而非值** —— 工厂实例化时机可能早于
 *  store 就绪 / kproxy 启动（与 `afe80af` 让 `accountDeps.getStore` 用惰性 getter 同一理由）。 */
export interface UpstreamApiDeps {
  /**
   * 是否用 K-Proxy 发 API 请求。桌面端可由 IPC 切换，服务端固定 `false`
   * （服务器上没有本地 IDE 出网流量要拦截，K-Proxy 不运行）。
   */
  useKProxy: () => boolean
  /** K-Proxy 服务单例访问器；未启动 / 服务端形态返回 null。 */
  getKProxyService: () => KProxyServiceLike | null
  /**
   * 用量 API 类型。真源是 store 的 `usageApiType` 键，**不是**本模块的状态：
   * 桌面端传 `() => currentUsageApiType`（保留现有 IPC 语义），
   * 服务端传 `() => (store.get('usageApiType') ?? 'rest')`。
   */
  getUsageApiType: () => UsageApiType
  /**
   * 账号绑定域的设备 ID（`kproxy.getDeviceId()`，64 hex）。
   * **不是** `machineId.ts` 的系统机器码 —— 见文件头第 4 项。
   */
  getDeviceIdForUa: () => string | undefined
}

/** 传输层：代理选择 + fetch + CBOR RPC。由 `createUpstreamApi` 组装一次后共享。 */
export interface UpstreamTransport {
  /** 获取网络代理 agent（优先 K-Proxy，其次用户设置代理，其次系统代理） */
  getNetworkAgent: () => Dispatcher | undefined
  fetchWithAppProxy: (url: string, options: RequestInit, overrideProxyUrl?: string) => Promise<Response>
  kiroApiRequest: <T>(
    operation: string,
    body: Record<string, unknown>,
    accessToken: string,
    idp?: string,
    accountMachineId?: string,
    email?: string
  ) => Promise<T>
  getDeviceIdForUa: () => string | undefined
}

export function createTransport(deps: UpstreamApiDeps): UpstreamTransport {
  // 获取网络代理 agent（优先 K-Proxy，其次用户设置代理，其次系统代理）
  function getNetworkAgent(): Dispatcher | undefined {
    if (deps.useKProxy()) {
      const kproxyService = deps.getKProxyService()
      if (kproxyService?.isRunning()) {
        const config = kproxyService.getConfig()
        const proxyUrl = `http://${config.host}:${config.port}`
        const agent = safeCreateProxyAgent(proxyUrl)
        if (agent) return agent
      }
    }
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    const envAgent = safeCreateProxyAgent(envProxy)
    if (envAgent) return envAgent
    return safeCreateProxyAgent(getSystemProxy())
  }

  /**
   * 通用 fetch 函数
   * @param url 请求 URL
   * @param options fetch 选项
   * @param overrideProxyUrl 可选：账号绑定的代理 URL（优先级最高，覆盖全局代理逻辑）
   *
   * 优先级：overrideProxyUrl > K-Proxy > 用户设置代理 > 系统代理 > 直连
   */
  async function fetchWithAppProxy(
    url: string,
    options: RequestInit,
    overrideProxyUrl?: string
  ): Promise<Response> {
    // 优先尝试账号绑定代理
    if (overrideProxyUrl) {
      const accountAgent = safeCreateProxyAgent(overrideProxyUrl)
      if (accountAgent) {
        return await undiciFetch(url, { ...options, dispatcher: accountAgent } as UndiciRequestInit) as unknown as Response
      }
    }
    const agent = getNetworkAgent()
    if (agent) {
      return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
    }
    return await fetch(url, options)
  }

  async function kiroApiRequest<T>(
    operation: string,
    body: Record<string, unknown>,
    accessToken: string,
    idp: string = 'BuilderId',  // 支持 BuilderId, Github, Google
    accountMachineId?: string,  // 账户绑定的设备 ID
    email?: string              // 用于日志标识
  ): Promise<T> {
    // 优先使用账户绑定的设备 ID，其次使用 K-Proxy 全局设备 ID
    const machineId = accountMachineId || deps.getDeviceIdForUa()
    const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
    console.log(`[Kiro API] ${operation} [${logTag}] ${idp} machineId=${machineId?.slice(0, 8) || 'none'}`)
    const agent = getNetworkAgent()
    
    // 使用 undici fetch 支持代理
    const headers: Record<string, string> = {
      'accept': 'application/cbor',
      'content-type': 'application/cbor',
      'smithy-protocol': 'rpc-v2-cbor',
      'amz-sdk-invocation-id': generateInvocationId(),
      'amz-sdk-request': 'attempt=1; max=1',
      'x-amz-user-agent': getKiroAmzUserAgent(machineId),
      'authorization': `Bearer ${accessToken}`,
      'cookie': `Idp=${idp}; AccessToken=${accessToken}`
    }
    
    let response: Response
    if (agent) {
      response = await undiciFetch(`${KIRO_API_BASE}/${operation}`, {
        method: 'POST',
        headers,
        body: Buffer.from(encode(body)),
        dispatcher: agent
      } as UndiciRequestInit) as unknown as Response
    } else {
      response = await fetchWithAppProxy(`${KIRO_API_BASE}/${operation}`, {
        method: 'POST',
        headers,
        body: Buffer.from(encode(body))
      })
    }

    if (!response.ok) {
      // 尝试解析 CBOR 格式的错误响应
      let errorMessage = `HTTP ${response.status}`
      const errorBuffer = await response.arrayBuffer()
      try {
        const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
        if (errorData.__type && errorData.message) {
          // 提取错误类型名称（去掉命名空间）
          const errorType = errorData.__type.split('#').pop() || errorData.__type
          // 在错误消息中包含 HTTP 状态码，便于封禁检测
          errorMessage = `HTTP ${response.status}: ${errorType}: ${errorData.message}`
        } else if (errorData.message) {
          errorMessage = `HTTP ${response.status}: ${errorData.message}`
        }
        console.error(`[Kiro API] Error:`, errorData)
      } catch {
        // 如果 CBOR 解析失败，显示原始内容
        const errorText = Buffer.from(errorBuffer).toString('utf-8')
        console.error(`[Kiro API] Error (raw): ${errorText}`)
      }
      throw new Error(errorMessage)
    }

    const arrayBuffer = await response.arrayBuffer()
    const result = decode(Buffer.from(arrayBuffer)) as T
    // 精简响应日志：一行摘要 + 完整数据放 data（ⓘ 展开）
    const r = result as Record<string, unknown>
    const resSummary = r.email ? `${r.email} [${r.status || 'ok'}]` : `${response.status}`
    console.log(`[Kiro API] ${operation} [${logTag}] → ${resSummary}`, result)
    return result
  }

  return { getNetworkAgent, fetchWithAppProxy, kiroApiRequest, getDeviceIdForUa: deps.getDeviceIdForUa }
}
