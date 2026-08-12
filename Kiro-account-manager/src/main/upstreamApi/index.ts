/**
 * 上游 Kiro / AWS API 的共享实现 —— 桌面端与服务端形态**同一份**。
 *
 * ## 为什么这个模块存在
 *
 * 反代刷新 token 需要的四个能力（`refreshTokenByMethod` / `getUsageAndLimits` /
 * `getUserInfo` / `ssoDeviceAuth`）此前是 `src/main/index.ts` 的**模块私有函数**。
 * 那个文件 `import { app } from 'electron'`，于是服务端形态
 * （`node out/server/index.js`，纯 node、无 Electron 运行时、`--omit=dev` 后 electron
 * 压根不存在）拿不到它们 —— `assembleServer` 只能注入一个全抛错的
 * `unwiredAccountApi()`，后果是**服务器上 accessToken 过期后无法自动刷新**。
 *
 * 实测（见 `.agent-workspace/.archive/2026-08-12/upstream-api-recon/findings.md` §2.3）：
 * 这四个函数及其**全部传递闭包**零 electron 引用。它们不是「与 Electron 纠缠」，
 * 只是「被困在一个 import 了 electron 的文件里」。故这次抽取本质是机械的。
 *
 * ## 契约：零行为变化
 *
 * 函数体逐字搬运，注释一并搬（那些注释是 RCA 换来的业务知识本体，不是说明文字）。
 * 唯一的差异在**状态获取的缝位**：原先闭包直读 index.ts 的模块级变量，现在读注入的
 * getter。四项状态的归属裁决与理由见 `transport.ts` 头部。
 *
 * ## 一个进程一个实例
 *
 * `refreshTokenByMethod` 的 single-flight 表在工厂闭包内。同一进程建两个实例 =
 * 两张表 = 同一个 rotating refreshToken 可能被并发刷两次 → 后到的用已作废 token →
 * 401 → **账号被上游踢下线**。装配层必须只建一次；
 * `test/main/architecture/upstream_api_single_instance.test.ts` 是这一条的门禁。
 */
import { createTransport, type UpstreamApiDeps, type UpstreamTransport } from './transport'
import { createRefresh } from './refresh'
import { createSso } from './sso'
import { createUsage } from './usage'
import type { UsageLimitsResponse, UnifiedUsageResponse, UserInfoResponse, OidcRefreshResult, SsoAuthResult } from './types'

export type {
  UpstreamApiDeps,
  UpstreamTransport,
  KProxyServiceLike
} from './transport'
export type {
  UsageApiType,
  OidcRefreshResult,
  SsoAuthResult,
  UsageLimitsResponse,
  UnifiedUsageResponse,
  UserInfoResponse
} from './types'
export {
  KIRO_API_BASE,
  KIRO_AUTH_ENDPOINT,
  KIRO_VERSION,
  getRestApiBase,
  getFallbackRestApiBase,
  getKiroUserAgent,
  getKiroAmzUserAgent,
  generateInvocationId
} from './transport'
export { validateMicrosoftTokenEndpoint } from './refresh'
export { normalizeResetDate } from './usage'

/** 上游 API 实例。四个缝位方法 + 内部实现细节（供桌面端现有调用点复用）。 */
export interface UpstreamApi {
  // ---- AccountServiceApi / VerifyApiDeps 需要的四个缝位方法 ----
  refreshTokenByMethod: (
    token: string,
    clientId: string,
    clientSecret: string,
    region?: string,
    authMethod?: string,
    proxyUrl?: string,
    externalIdp?: { tokenEndpoint?: string; scopes?: string }
  ) => Promise<OidcRefreshResult>
  getUsageAndLimits: (
    accessToken: string,
    idp?: string,
    profileArn?: string,
    accountMachineId?: string,
    ssoRegion?: string,
    email?: string,
    authMethod?: string
  ) => Promise<UnifiedUsageResponse>
  getUserInfo: (
    accessToken: string,
    idp?: string,
    accountMachineId?: string,
    email?: string
  ) => Promise<UserInfoResponse>
  ssoDeviceAuth: (bearerToken: string, region?: string) => Promise<SsoAuthResult>

  // ---- 桌面端现有调用点仍需要的下层能力 ----
  /** REST GetUsageLimits（`getUsageAndLimits` 的 rest 分支实现，也有独立调用方） */
  getUsageLimitsRest: (
    accessToken: string,
    profileArn?: string,
    accountMachineId?: string,
    ssoRegion?: string,
    email?: string,
    authMethod?: string
  ) => Promise<UsageLimitsResponse>
  /** CBOR RPC 通道 */
  kiroApiRequest: UpstreamTransport['kiroApiRequest']
  /** 通用 fetch（四级代理优先级） */
  fetchWithAppProxy: UpstreamTransport['fetchWithAppProxy']
  /** 当次请求应使用的 agent；`getKProxyAgent` 在 index.ts 里是它的同义别名 */
  getNetworkAgent: UpstreamTransport['getNetworkAgent']
}

/**
 * 组装上游 API。**每个进程只调用一次**（见文件头「一个进程一个实例」）。
 *
 * deps 全部是 getter 而非值 —— 工厂实例化时机可能早于 store 就绪 / kproxy 启动。
 */
export function createUpstreamApi(deps: UpstreamApiDeps): UpstreamApi {
  const transport = createTransport(deps)
  const refresh = createRefresh(transport)
  const sso = createSso(transport)
  const usage = createUsage(transport, deps.getUsageApiType)

  return {
    refreshTokenByMethod: refresh.refreshTokenByMethod,
    getUsageAndLimits: usage.getUsageAndLimits,
    getUserInfo: usage.getUserInfo,
    ssoDeviceAuth: sso.ssoDeviceAuth,
    getUsageLimitsRest: usage.getUsageLimitsRest,
    kiroApiRequest: transport.kiroApiRequest,
    fetchWithAppProxy: transport.fetchWithAppProxy,
    getNetworkAgent: transport.getNetworkAgent
  }
}
