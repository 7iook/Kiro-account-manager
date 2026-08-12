/**
 * 服务端形态的上游 API 装配 —— 工作包 F。
 *
 * 桌面端在 `index.ts` 里 `createUpstreamApi({...})` 一次；服务端在这里一次。
 * 两个**不同的进程**各一个实例是正确的（各自一张 single-flight 表）；
 * 同一进程两处才是缺陷，门禁 `test/main/architecture/upstream_api_single_instance.test.ts` 守它。
 *
 * ## 为什么单独一个文件而不是塞进 `assembly.ts`
 *
 * `assembly.ts` 已 932 行，且它的职责是「把端口接成一台服务」。这里做的是
 * 「决定服务端形态下那四个 deps 各读什么」—— 三条裁决各有独立理由（见下），
 * 它们会被单独审阅、单独回归，不该埋在装配流程中间。
 *
 * ## 三条服务端语义裁决（`useKProxy` / `getUsageApiType` / `getDeviceIdForUa`）
 *
 * 1. **`useKProxy: () => false`（常量，不是 getter 读状态）**
 *    服务器上没有本地 Kiro IDE 出网流量需要拦截，故 K-Proxy **只载不启**
 *    （`assembly.ts` 的 K-Proxy 段落记了这条：装 service 实例只为让反代读得到设备 ID
 *    映射表，`start()` 会去监听一个没人连的端口）。既然不 `start()`，
 *    `getNetworkAgent()` 的第一级分支里 `kproxyService?.isRunning()` 恒为 false ——
 *    传常量 `false` 与传一个永远读到「未运行」的 getter 可观察行为完全相同，
 *    但常量把「服务端不走 K-Proxy」这条判断写在了它被决定的地方，
 *    而不是留给读者去 `isRunning()` 反推。
 *
 * 2. **`getUsageApiType` 读 store，不缓存**
 *    真源是 store 的 `usageApiType` 键（K-3 的 `AccountStorePort` 已统一两端）。
 *    桌面端因为有 IPC，额外持一份内存缓存（`index.ts:currentUsageApiType`）；
 *    服务端没有 IPC，**直读 store 反而少一个真源** —— 也顺带没有桌面那个
 *    「启动早期 store 还没载入 ⇒ 短暂读到默认值」的窗口。
 *    默认 `'rest'` 与桌面 `index.ts` 的初值逐字一致。
 *
 * 3. **`getDeviceIdForUa` 走 kproxy 的 `getDeviceId()`，与桌面同一个来源**
 *    这是**账号绑定域**的 64 位 hex，**不是** `machineId.ts` 的系统机器码（UUID 形态）。
 *    混用有先例：`fce8c89` 误注入 `generateRandomMachineId`，UUID 拼进 UA 后匹配不上
 *    `kproxy/mitmProxy.ts:17 KIRO_UA_REGEX`（只认 64 hex），ksk_ 账号的设备 ID 改写
 *    **静默失效**。服务端不另找来源：`assembly.ts` 已 `initKProxyService(...)`，
 *    它从盘上 `kproxyConfig.deviceId` 读同一个值，与桌面 `getCurrentMachineId()` 同源。
 */
import { createUpstreamApi } from '../upstreamApi'
import { getKProxyService } from '../kproxy/index'
import type { AccountStorePort } from '../persistence/accountStorePort'
import type { ServerAccountApi } from './assembly'
import {
  readKiroAuthTokenFile,
  writeKiroAuthTokenFile,
  resolveProfileArnForWrite
} from '../kiroAuthSync'
import { fetchEnterpriseProfileArn } from '../proxy/kiroApi'

/** store 的**惰性**取用。见下方 `createServerAccountApi` 头部对时序的说明。 */
export type StoreGetter = () => AccountStorePort | null

/**
 * 组装服务端的 `accountApi`。**每个进程只调一次**（`entry.ts` 的装配处）。
 *
 * ## 为什么收 `getStore` 而不是 `store`
 *
 * store 是 `assembleServer()` **内部**建的（它同时负责 `setStoreRef` 的写入收口，
 * 在外面再建一个就是第二个真源）。而 `accountApi` 又必须在 `assembleServer()`
 * **之前**构造好才能作为参数传进去 —— 于是构造时 store 还不存在。
 * `createUpstreamApi` 的 deps 全部是 getter 正是为这种时序留的（与 `afe80af` 让
 * `accountDeps.getStore` 用惰性 getter 同一理由）：getter 在**调用时**求值，
 * 那时装配早已完成。
 *
 * 拿不到 store 时 `getUsageApiType` 退回 `'rest'`（与桌面初值一致）——
 * 这不是兜底掩错：能走到 usage 查询说明服务已在跑，store 必然就位；
 * 而在那之前没有任何调用方。
 */
export function createServerAccountApi(getStore: StoreGetter): ServerAccountApi {
  const upstream = createUpstreamApi({
    useKProxy: () => false,
    // K-Proxy 只载不启（见文件头 ①）。仍把 service 传进去而不是给 null：
    // 判定权留在 `getNetworkAgent` 那一段策略里，装配层不替它做「反正也不会命中」的裁剪。
    getKProxyService: () => getKProxyService(),
    getUsageApiType: () => (getStore()?.get('usageApiType') === 'cbor' ? 'cbor' : 'rest'),
    getDeviceIdForUa: () => getKProxyService()?.getDeviceId()
  })

  return {
    // 三个曾经拿不到的上游 HTTP 方法 —— 与桌面**同一份实现**（src/main/upstreamApi）。
    refreshTokenByMethod: upstream.refreshTokenByMethod,
    getUsageAndLimits: upstream.getUsageAndLimits,
    getUserInfo: upstream.getUserInfo,
    // 四个自由方法：`d6e5586`（工作包 A）已确认它们本就在 index.ts 之外、零 electron，
    // 故直接转发同一批符号，与 `assembly.ts:wiredFreeMethods` 取自同一处。
    // 形状收窄同桌面 `index.ts` 的 `api:` 对象（入参是 `AccountServiceApi` 的最小字段集）。
    fetchEnterpriseProfileArn: (account) => fetchEnterpriseProfileArn(account),
    readKiroAuthTokenFile,
    writeKiroAuthTokenFile,
    resolveProfileArnForWrite
  }
}
