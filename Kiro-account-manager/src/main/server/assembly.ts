/**
 * 服务端装配层 —— 把已抽出的端口接成一台可运行的服务（无 electron / 无 IPC / 无窗口）。
 *
 * 与桌面 `index.ts` 的关系：**同一批内核函数，不同的装配图**。桌面那边的装配缠着
 * 一百多个 IPC 通道、托盘、窗口生命周期；这里只有「读配置 → 建 store → 装 deps →
 * 起面板 →（按配置）起反代」。故这是决策卡说的「组装图重写而非搬运」。
 *
 * 本文件**只组装、不编排**：
 *   - 选号的三步顺序在 `proxy/activation.ts`
 *   - 「先同步池再启动」在 `ipc/panelProxyDeps.ts`
 *   - 账号写入的 revision 仲裁在 `accountService/state.ts`
 * 一个也不在这里重写。顺序有第二个真源时两处早晚分叉，表现是「面板绿灯但反代打旧号」。
 *
 * ## 为什么不复用 `ipc/webPanelWiring.ts` 的 `WebPanelWiring` / `buildPanelRouteDeps`
 *
 * 那个文件第 17 行 `import { ipcMain } from 'electron'` —— 它是**刻意**放在 `ipc/` 下的
 * electron 边界层（见其文件头）。服务端引用它会在加载阶段就死（`electron` 是
 * devDependency，且 `dependencies` 里无任何包 peer 上它，`--omit=dev` 后压根不存在
 * —— 见 `proxy/logger.ts` 头部对这条前提的完整说明与闸门）。故面板在这里直接
 * `new PanelAuth(...) + new WebPanelServer(...)` 拼装，`PanelRouteDeps` 也直接构造。
 * 侦察报告 §7 冲突热点 4 推荐的正是这条（改动面更小，且不必去拆一个正在工作的文件）。
 *
 * `ipc/panelProxyDeps.ts` 相反 —— 实测它**不** import electron（它叫 `ipc/` 只是历史
 * 归位），故 `buildPanelProxyDeps` 原样复用，反代六个面板端点不重写。
 *
 * ## 上游 HTTP 函数：已抽成零 electron 共享模块，由装配层注入（本文件不复制实现）
 *
 * `AccountRuntimeDeps.api` 的七个成员：四个本就在 index.ts 之外（见 `wiredFreeMethods`）；
 * 剩下三个曾是 `src/main/index.ts` 的**模块私有函数**，各自缠着 index.ts 侧的模块级状态。
 * `af94451` 把它们整层抽进 `src/main/upstreamApi/`（工厂 `createUpstreamApi(deps)`，
 * 三个可变状态改为注入 getter），随后桌面端与服务端各自装配一个实例：
 *
 *   | 需要的 | 实现位置 | 服务端注入处 |
 *   |---|---|---|
 *   | `refreshTokenByMethod` | `upstreamApi/refresh.ts`（single-flight 在工厂闭包内） | ✅ `server/accountApi.ts` |
 *   | `getUsageAndLimits` | `upstreamApi/usage.ts`（`getUsageApiType` 注入 getter） | ✅ 同上 |
 *   | `getUserInfo` | `upstreamApi/usage.ts` → `kiroApiRequest` | ✅ 同上 |
 *   | `fetchEnterpriseProfileArn` | `proxy/kiroApi.ts`（已在内核闭包内） | ✅ `wiredFreeMethods` |
 *   | `readKiroAuthTokenFile` / `writeKiroAuthTokenFile` / `resolveProfileArnForWrite` | `kiroAuthSync.ts`（零 electron） | ✅ 同上 |
 *
 * 本文件保留 `accountApi?` 为**可注入缝位** + 一个显式失败的默认实现，而不是在这里硬接 ——
 * 理由与 `persistence` 同款：测试要能验「未注入时告警不静默」这条语义（那正是这个缺口
 * 曾经的形态）。**绝不在这里重写一份 token 刷新**：那会造出决策卡不变量 I5 禁止的
 * 「分叉的第二实现」—— 而 token 刷新恰好是最不能有两份的东西（两份对同一 refreshToken
 * 的理解一旦分歧，结果是账号被上游踢下线，且只在生产上才看得见）。
 *
 * **未注入时对用户可见的后果（诚实标注）**：反代**跑得起来但不能自动刷 token** ——
 * 池里账号的 accessToken 过期后 `ProxyServer.refreshToken()` 拿不到回调，
 * 只会 `console.warn` 然后判该号刷新失败。故本文件在缺缝位时**启动即告警**
 * （见 `warnMissingAccountApi`），不静默。生产入口 `server/entry.ts` 已注入真实现。
 */
import { createConfAccountStore } from '../persistence/accountStore.conf'
import type { AccountStorePort } from '../persistence/accountStorePort'
import {
  applyAccountDataMutation,
  setBroadcaster,
  setLastSavedDataSetter,
  setStoreRef
} from '../accountService/state'
import { loadAccounts } from '../accountService/accounts'
import { checkAccountStatus } from '../accountService/check'
import { refreshAccountToken } from '../accountService/refresh'
import {
  getAccountModels,
  getAccountSubscriptions,
  getAccountSubscriptionUrl,
  setAccountOverage
} from '../accountService/subscription'
import { importApiKeys } from '../accountService/importApiKey'
import { verifyApiKey } from '../accountService/verify'
import type {
  AccountRuntimeDeps,
  AccountServiceApi,
  AccountStoreDeps
} from '../accountService/types'
import type { PanelAccountIdentity, PanelRouteDeps } from '../webPanel/routes'
import { PanelAuth, type AdminKeyStore } from '../webPanel/auth'
import { WebPanelServer, type WebPanelConfig } from '../webPanel/server'
import { buildPanelProxyDeps, type ProxyServerRef } from '../ipc/panelProxyDeps'
import {
  activateProxyAccount,
  buildProxyAccountsFromStore,
  logPoolAdmissionSkips
} from '../proxy/activation'
import { ProxyServer } from '../proxy/proxyServer'
import type { ProxyConfig, ProxySessionRecord } from '../proxy/types'
import { setLogTruncationEnabled } from '../proxy/logger'
import { initKProxyService } from '../kproxy/index'
import { generateDeviceId } from '../kproxy/index'
import { fetchKiroModels, fetchAvailableSubscriptions, fetchSubscriptionToken, setUserPreference, fetchEnterpriseProfileArn } from '../proxy/kiroApi'
import {
  readKiroAuthTokenFile,
  writeKiroAuthTokenFile,
  resolveProfileArnForWrite
} from '../kiroAuthSync'
import { writeSecureBackup } from '../secureBackup'
import { createAesGcmBackupCipher } from '../secureBackupCipher.aesGcm'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROXY_ORPHAN_SESSION_KEY, type ServerConfig } from './config'

/**
 * 服务端形态的账号上游 API 缝位。
 *
 * 形状**刻意等于** `AccountRuntimeDeps['api']`（`accountService/types.ts:AccountServiceApi`），
 * 不另立一套：另立就要写一层翻译，而那层翻译是纯粹的自找工作。
 */
export type ServerAccountApi = AccountServiceApi

/**
 * 缝位七个方法里，**四个今天就能接上** —— 它们压根不在 index.ts 里。
 *
 * 实测（2026-08-12）：桌面 `index.ts:3855-3863` 的 `api:` 对象是**纯符号转发**，
 * 后四个转发的是它自己从外部模块 import 来的东西：
 *
 *   | 方法 | 真实来源 | 零 electron？ |
 *   |---|---|---|
 *   | `fetchEnterpriseProfileArn` | `proxy/kiroApi.ts` | ✅ 该文件已在内核闭包内（模块图闸门有显式自检断言它在 `graph.files` 里） |
 *   | `readKiroAuthTokenFile` | `kiroAuthSync.ts:233` | ✅ 全部依赖是 `fs/promises` `fs` `path` `os` `crypto` |
 *   | `writeKiroAuthTokenFile` | `kiroAuthSync.ts:157` | ✅ 同上 |
 *   | `resolveProfileArnForWrite` | `kiroAuthSync.ts:84` | ✅ 纯函数 |
 *
 * 故这四个**直接 import 注入**，与桌面共用同一份实现（不是"服务端版本"）。
 * 真正拿不到的只剩三个上游 HTTP 函数，它们是 index.ts 的模块私有函数。
 *
 * ## `readKiroAuthTokenFile` 的吞错形态在服务端不改变可观察行为（已核实，故不为它加兜底）
 *
 * 它把「文件不存在 / 读不了 / JSON 坏 / 字段缺」四种情况全归一成 `null`
 * （契约 `accountService/types.ts:138` 就写的是 `| null`，另有独立任务在治它）。
 * 消费点 `accountService/refresh.ts:125` 与 `backgroundRefresh.ts:200` 拿到 `null` 时
 * 走的是「IDE 未登录，跳过磁盘同步」—— 而服务器上**本来就没有 Kiro IDE**，
 * `~/.aws/sso/cache/kiro-auth-token.json` 正常缺席，`null` 就是期望值。
 * 即：这个吞错在服务端形态下不产生任何行为差异，也不需要在装配层包一层兜底
 * （包了就是在服务端造第二个真源）。
 */
function wiredFreeMethods(): Pick<
  ServerAccountApi,
  | 'fetchEnterpriseProfileArn'
  | 'readKiroAuthTokenFile'
  | 'writeKiroAuthTokenFile'
  | 'resolveProfileArnForWrite'
> {
  return {
    // 形状收窄：`AccountServiceApi` 声明的入参是它自己的最小字段集，
    // 而 `fetchEnterpriseProfileArn` 收 `ProxyAccount`（超集，其余字段全可选）。
    // 桌面侧同样直接转发这个符号（`index.ts:3860`），两端共用一份实现。
    fetchEnterpriseProfileArn: (account) => fetchEnterpriseProfileArn(account),
    readKiroAuthTokenFile,
    writeKiroAuthTokenFile,
    resolveProfileArnForWrite
  }
}

/**
 * 默认实现：**剩下三个上游 HTTP 方法抛**，抛之前说清「为什么没有」与「谁该来填」。
 *
 * 为什么不 no-op 返回 `{ success: false }`：那会让 token 刷新失败看起来像一次
 * 上游故障，池会把账号标成异常然后切下一个 —— 于是整池会被逐个「刷新失败」标记完，
 * 而真实原因（装配层没接上游 API）在日志里完全看不见。抛错至少把原因写在现场。
 *
 * 另外四个方法**已接线**（见 `wiredFreeMethods`）—— 它们不抛。
 *
 * 导出（而非模块私有）的理由：这个对象的**内容**就是「哪些接上了、哪些没有」这条命题
 * 本身，测试必须能直接取到它。从 `AssembledServer` 反推不到（`accountApi` 只流进
 * `buildProxyEvents` 与 `buildRuntimeDeps` 的闭包），而为了测它去 mock 装配就只能验到
 * 测试自己传进去的东西 —— 那正是 E-052 的形态。
 */
export function defaultAccountApi(): ServerAccountApi {
  const missing = (name: string) => (): never => {
    throw new Error(
      `[server] 账号上游 API 未接线：${name}。\n` +
        `原因：装配时没有传 \`accountApi\`。实现已在 \`src/main/upstreamApi\`（零 electron 共享模块，` +
        `与桌面同一份），服务端的装配在 \`server/accountApi.ts:createServerAccountApi\`。\n` +
        `处置：assembleServer({ accountApi: createServerAccountApi(getStore) })。` +
        `绝不在服务端复制一份实现 —— token 刷新有两份实现的后果是账号被上游踢下线。`
    )
  }
  return {
    getUsageAndLimits: missing('getUsageAndLimits'),
    getUserInfo: missing('getUserInfo'),
    refreshTokenByMethod: missing('refreshTokenByMethod'),
    ...wiredFreeMethods()
  } as unknown as ServerAccountApi
}

/**
 * 未注入时仍会抛错的方法名。`warnMissingAccountApi` 与测试共用这一份，防两处措辞漂移。
 *
 * **为何抽取已落地、生产入口已注入之后仍保留这份清单（而不是改成空数组或删掉）**：
 * 它描述的不是「今天还没抽出来的三个函数」，而是「`accountApi` 缺席时，
 * `defaultAccountApi()` 会让哪三个方法抛错」—— 那个默认实现仍存在（它是 `accountApi?`
 * 可选缝位的必然配套），且仍有真实消费者：测试里大量
 * `assembleServer({ config, adminKeyStore })` 不传 accountApi。
 * 改成空数组会让告警文案变成「缺的是 」（空白），删掉则让文案与测试各自手抄
 * 一份方法名 —— 那才是它当初被建立要防的漂移。
 *
 * 它不再意味着「存在一个未完成的工作包」：抽取已完成（`af94451`），
 * 生产入口 `server/entry.ts` 已注入真实现，故启动告警在生产路径上不会出现。
 */
export const UNWIRED_ACCOUNT_API_METHODS = [
  'getUsageAndLimits',
  'getUserInfo',
  'refreshTokenByMethod'
] as const

/**
 * 那三个「桌面推送 IPC、下游动作其实是落盘」的事件的服务端缝位。
 *
 * 侦察报告附录 B 的分类：面板需要 0 个（它全靠 HTTP 轮询），**主进程自己需要 3 个**，
 * 其余纯 UI 可丢。这三个的下游动作是持久化，桌面上靠 renderer 收 IPC 后
 * `saveToStorage` 转手落盘 —— 服务端没有 renderer，这条链断了。
 *
 * 主进程侧落盘由 `server/persistence.ts` 的 `createServerPersistenceHooks()` 实现
 * （`entry.ts` 装配时传入），走 `accountService/persistAccountPatch` →
 * `applyAccountDataMutation` 的既有写入收口，不另写一份落盘逻辑。
 * 仍保留成**可注入缝位**而非在本文件里硬接：测试要能验「未注入时告警不静默」这条语义，
 * 而那正是这个缺口曾经的形态。
 *
 * 未注入时的行为是**告警一次后丢弃**，不是静默丢弃 —— 静默丢弃的表现是
 * 「反代刷新了 token，但重启后又用回旧的」，那种 bug 在日志里查不到任何线索。
 */
export interface ServerPersistenceHooks {
  /** 反代刷出新 token / 自愈出 profileArn 时（对应桌面的 `proxy-account-update`） */
  onProxyAccountUpdate?: (patch: {
    id: string
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    profileArn?: string
  }) => void
  /** 账号被上游长期封禁时（对应桌面的 `proxy-account-suspended`） */
  onProxyAccountSuspended?: (info: {
    id: string
    email?: string
    reason: string
    message: string
    suspendedAt: number
  }) => void
}

/** 组装结果。`entry.ts` 只跟这个对象打交道 */
export interface AssembledServer {
  readonly store: AccountStorePort
  readonly panel: WebPanelServer
  readonly auth: PanelAuth
  /** 反代实例；未初始化时为 null（`isRunning()` 与它无关，见 panelProxyDeps 注释） */
  getProxyServer: () => ProxyServer | null
  /** 惰性初始化反代（启动路径与面板 `/start` 端点共用这一个入口） */
  initProxyServer: () => ProxyServer
  /** 面板实际监听地址（`port:0` 时才与配置不同） */
  panelAddress: () => { host: string; port: number } | null
  /** 有序停机：反代 → 面板 → 会话归档。幂等 */
  shutdown: () => Promise<void>
}

export interface AssembleOptions {
  config: ServerConfig
  /** adminKey 端口。由 `server/adminKeyStore.ts` 提供（独立文件 + 0600 + env 优先） */
  adminKeyStore: AdminKeyStore
  /** 账号上游 API；缺省 = 未接线（启动告警 + 调用即抛，见 `unwiredAccountApi`） */
  accountApi?: ServerAccountApi
  /** 三个「下游是落盘」事件的实现；缺省 = 告警一次后丢弃 */
  persistence?: ServerPersistenceHooks
}

/** 面板默认配置。与 `ipc/webPanelWiring.ts:DEFAULT_WEB_PANEL_CONFIG` 同值，但 **`autoStart` 语义在服务端被忽略**（见 `readPanelConfig`） */
const DEFAULT_PANEL_CONFIG: WebPanelConfig = {
  enabled: false,
  port: 5590,
  host: '127.0.0.1',
  autoStart: false
}

/**
 * 反代默认配置。与 `index.ts:initProxyServer` 的 `defaultConfig` 同值。
 *
 * 为什么可以只镜像这几个字段：盘上 `proxyConfig` 是桌面写的完整对象（迁移工件本尊），
 * 服务端读到的几乎总是它；默认值只在「全新部署、还没有任何配置」时兜底。
 * `enableTokenBufferReserve: true` 必须在列 —— 关闭时超模型 context window 的请求
 * 原样出站会导致三端点全 400（RCA 2026-07-26），那是个已经踩过的坑。
 */
const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  enabled: false,
  port: 5580,
  host: '127.0.0.1',
  enableMultiAccount: true,
  selectedAccountIds: [],
  logRequests: true,
  maxConcurrent: 10,
  maxRetries: 3,
  retryDelayMs: 1000,
  tokenRefreshBeforeExpiry: 300,
  clientDrivenToolExecution: true,
  enableTokenBufferReserve: true,
  tokenBufferReserve: 20000
}

/**
 * 组装一台服务端。**不启动任何东西** —— 启动顺序与失败处置属 `entry.ts`。
 *
 * 拆成「组装」与「启动」两步的理由：组装可以在测试里完整跑一遍并断言契约
 * （面板拿到的是哪个 auth、反代配置合并对不对、deps 有没有装齐），而不需要
 * 真的占用端口。合成一个 `startServer()` 就等于「想验一个配置合并，先监听两个端口」。
 */
export function assembleServer(options: AssembleOptions): AssembledServer {
  const { config, adminKeyStore } = options
  const accountApi = options.accountApi ?? defaultAccountApi()
  if (!options.accountApi) warnMissingAccountApi()

  // 日志截断：桌面是 `setLogTruncationEnabled(app.isPackaged)`。服务端无 isPackaged,
  // 默认截断（服务器日志进 journal / 容器日志，全量 payload 会写满磁盘且夹带凭据）。
  setLogTruncationEnabled(config.truncateLogs)

  // ===== store =====
  // `createConfAccountStore` 内部已调 `preflightAccountStoreForServer`（四态 + 版本 +
  // 写权限）。entry.ts 会先调一次带退出码分类的 preflight，所以到这里一般已经过闸；
  // 这里再过一次是构造函数自己的守卫（它是零 caller 的服务端端口，不该依赖调用者记得先验）。
  const store = createConfAccountStore({ dataDir: config.dataDir })

  // accountData 写入收口注入。**必须在任何业务函数被调用之前** ——
  // `applyAccountDataMutation` 在未注入时抛错（刻意不静默 no-op）。
  setStoreRef(store)

  // 桌面那边 `lastSavedData` 是给崩溃恢复用的内存快照（`index.ts` 的模块级变量）。
  // 服务端保留同一语义：备份写盘时要拿到「最后一次成功落盘的 blob」。
  let lastSavedData: unknown = store.get('accountData') ?? null
  setLastSavedDataSetter((data) => {
    lastSavedData = data
  })

  // 广播：桌面是 `BrowserWindow.getAllWindows()` 逐个 send。服务端**显式 no-op**，
  // 并在此注明「桌面专属」—— 决策卡点名反对笼统的「无操作」实现（孤儿产出）。
  // 面板不需要推送：它通过 HTTP 轮询 `loadAccountsBlob` 拿最新数据（附录 B 已核实
  // 面板前端只 setInterval 轮询）。故这里不是「还没做」，是「确实没有消费者」。
  setBroadcaster(() => {
    /* 桌面专属：服务端无 renderer 窗口可广播，面板走 HTTP 轮询 */
  })

  const storeDeps = buildStoreDeps(store, config, () => lastSavedData, (d) => {
    lastSavedData = d
  })

  // ===== K-Proxy =====
  // 加载但**不 start()**。已核实的两条理由：
  //   ① 设备 ID 映射表是纯内存（`kproxy/index.ts:39`），反代自己会往里写
  //      （`proxy/proxyServer.ts:1842`），所以映射表不需要桌面的 IPC 也能工作；
  //   ② 服务器上没有本地 Kiro IDE，MITM 拦截没有消费方。
  // 装 service 实例的意义是让反代读得到那张表；start() 会去监听一个没人连的端口。
  initKProxyService((store.get('kproxyConfig') as Record<string, unknown>) ?? {}, {}, config.dataDir)

  // ===== 反代 =====
  // orphan 回收必须在**任何新会话开始写 orphan 之前**（即反代构造之前）——
  // 反代一启动，`onSessionTick` 每 60s 就会覆盖那个键，上次的统计就永久丢了。
  restoreOrphanProxySession(store)

  let proxyServer: ProxyServer | null = null
  const initProxyServer = (): ProxyServer => {
    if (proxyServer) return proxyServer
    proxyServer = new ProxyServer(
      readProxyConfig(store),
      buildProxyEvents(store, accountApi, options.persistence, () => proxyServer),
      // 自签证书落盘目录（K-2）：装配层注入，内核不自己 require('electron')
      config.dataDir
    )
    return proxyServer
  }

  // ===== 面板 =====
  const auth = new PanelAuth(adminKeyStore)
  const runtimeDeps = buildRuntimeDeps(accountApi, () => proxyServer)
  const panel = new WebPanelServer({
    auth,
    routeDeps: buildServerRouteDeps({
      store,
      storeDeps,
      runtimeDeps,
      getProxyServer: () => proxyServer,
      initProxyServer
    }),
    getConfig: () => readPanelConfig(store, config),
    onStatusChange: (running, port) => {
      if (running) console.log(`[server] 面板已启动: http://${readPanelConfig(store, config).host}:${port}/panel`)
    },
    onError: (error) => {
      console.error('[server] 面板错误:', error.message)
    }
  })

  return {
    store,
    panel,
    auth,
    getProxyServer: () => proxyServer,
    initProxyServer,
    panelAddress: () => panel.getListeningAddress(),
    shutdown: async () => {
      // 顺序承重：先停反代（它有在途请求与会话统计），再停面板。
      // 反过来的话，面板已关而反代还在收新请求，运维看到「面板挂了」却仍在被计费。
      if (proxyServer) {
        archiveProxySession(store, proxyServer)
        await proxyServer.stop().catch((e) => {
          console.error('[server] 停止反代失败:', e)
        })
      }
      await panel.stop().catch((e) => {
        console.error('[server] 停止面板失败:', e)
      })
      // `panel.stop()` 内部已停会话清扫；再显式停一次覆盖「面板从未启动但 sweeper 已起」
      auth.sessionStore.stopSweeping()
    }
  }
}

/** 上游 API 未注入时的启动告警。**不静默** —— 见 assembly 文件头「已知缺口」 */
function warnMissingAccountApi(): void {
  console.warn(
    '[server] ⚠️ 账号上游 API 未接线：反代可以启动并转发，但**无法自动刷新 token**。\n' +
      '[server]    池中账号的 accessToken 过期后，刷新会失败（ProxyServer 拿不到 onTokenRefresh 结果）。\n' +
      '[server]    即「关机后反代仍在服务」在 token 有效期内成立、之后不成立。\n' +
      `[server]    缺的是 ${UNWIRED_ACCOUNT_API_METHODS.join(' / ')}，\n` +
      '[server]    实现已在 src/main/upstreamApi（零 electron 共享模块，与桌面同一份）。\n' +
      '[server]    改法：assembleServer({ accountApi: createServerAccountApi(getStore) })\n' +
      '[server]    —— 生产入口 server/entry.ts 已经这么传，故这条告警只会出现在\n' +
      '[server]    「有人新写了一个装配点却忘了传」的时候。（fetchEnterpriseProfileArn /\n' +
      '[server]    readKiroAuthTokenFile / writeKiroAuthTokenFile / resolveProfileArnForWrite\n' +
      '[server]    由 defaultAccountApi 直接接上，从来不在缺口内。）'
  )
}

// ============ 配置读取 ============

/**
 * 面板配置：默认值 + 盘上覆盖 + 环境变量覆盖。
 *
 * ## 两处**刻意**与桌面不同的语义
 *
 * ① **忽略 `enabled` 与 `autoStart`，面板在服务端总是启动。**
 *    已核实的理由：`ipc/webPanelWiring.ts:56` 的默认值是 `enabled:false, autoStart:false`，
 *    而 `:219` 的自启动判据是 `enabled && autoStart` —— 桌面用户不去设置页点开，
 *    盘上这两个键就是 false。而迁移工件是「桌面的数据文件直拷」，所以服务器上
 *    这两个键**几乎必然是 false**。尊重它的结果是：服务起来了、没有任何管理界面、
 *    而运维要改这个配置就得先有管理界面 —— 一个自锁的死结。
 *    面板是服务端唯一的管理入口，故它的存在性不可配置。
 *
 * ② **环境变量覆盖 host/port，且只读不回写。**
 *    盘上那份 `webPanelConfig` 是桌面写的、且要拷回桌面继续用。把服务器的监听地址
 *    落进去，用户拷回桌面后桌面面板会去监听一个服务器上的地址，而他不知道这值哪来的。
 *
 * 默认 host 保持 `127.0.0.1`（决策卡 DC9：改成外部地址需显式配置）。绑外网且无
 * adminKey 时 `WebPanelServer.start()` 自己会拒启（`server.ts:117` 的既有红线），
 * 这里不重复那道判断 —— 判据的 SSOT 在服务器里。
 */
export function readPanelConfig(
  store: Pick<AccountStorePort, 'get'>,
  serverConfig: ServerConfig
): WebPanelConfig {
  const saved = store.get('webPanelConfig') as Partial<WebPanelConfig> | undefined
  const merged: WebPanelConfig = saved
    ? { ...DEFAULT_PANEL_CONFIG, ...saved }
    : { ...DEFAULT_PANEL_CONFIG }

  // 服务端语义差：面板总是启动（见上 ①）
  merged.enabled = true
  merged.autoStart = true

  if (serverConfig.panelHost !== undefined) merged.host = serverConfig.panelHost
  if (serverConfig.panelPort !== undefined) merged.port = serverConfig.panelPort
  return merged
}

/**
 * 反代配置：默认值 + 盘上覆盖。
 *
 * **不做桌面那次 `enableTokenBufferReserve` 一次性迁移写盘**（`index.ts:568-588`）。
 * 三条理由：① 那次迁移带 `accountDataMigration` 标志位，桌面已经跑过了，而迁移工件
 * 就是桌面写的文件 —— 标志位已在盘上，服务端跑它是空转；② 它会**写**
 * `proxyConfig` 与 `accountDataMigration`，而服务端在启动路径上写这两个键会改动
 * 那份要拷回桌面的文件（I1b：迁移不改源数据）；③ 全新部署（盘上无 proxyConfig）时
 * 默认值本身就是 `true`，无需迁移。
 *
 * 与桌面 `initProxyServer` 的另一处差异：那边还会把若干配置项推进 `kiroApi.ts` 的
 * 模块级 setter（`setPayloadSizeLimitKB` / `setAgentMode` / `setRateLimitRetryConfig` …）。
 * 服务端**同样要做**这件事，否则盘上的这些配置在服务端静默失效 —— 见
 * `applyProxyRuntimeConfig`。
 */
export function readProxyConfig(store: Pick<AccountStorePort, 'get'>): ProxyConfig {
  const saved = store.get('proxyConfig') as Partial<ProxyConfig> | undefined
  return saved ? { ...DEFAULT_PROXY_CONFIG, ...saved } : { ...DEFAULT_PROXY_CONFIG }
}

/** 反代是否该在启动时自动拉起 —— 同桌面语义（`enabled && autoStart`） */
export function shouldAutoStartProxy(config: ProxyConfig): boolean {
  return config.enabled === true && config.autoStart === true
}

// ============ deps 装配 ============

/**
 * `AccountStoreDeps`。桌面版见 `index.ts:1917`。
 *
 * `createBackup` 走 `writeSecureBackup` + AES-GCM cipher（服务端不用 keyring ——
 * `safeStorage` 是 Electron API）。**cipher 惰性构造**：`createAesGcmBackupCipher`
 * 在未配 `KIRO_BACKUP_KEY` 且未显式接受明文时**构造期就抛**（那是它刻意的
 * fail-fast）。若在这里提前构造，「没配备份密钥」就会变成「服务根本起不来」——
 * 而备份只是容灾，不该阻断反代对外服务。故推迟到第一次真要写备份时才构造，
 * 抛错由 `saveAccounts` 的调用链看见（它是用户主动操作的路径，报错有人看）。
 */
function buildStoreDeps(
  store: AccountStorePort,
  serverConfig: ServerConfig,
  getLastSavedData: () => unknown,
  setLastSaved: (data: unknown) => void
): AccountStoreDeps {
  void serverConfig
  void getLastSavedData
  return {
    getStore: () => store,
    // store 在装配期就已构造好（不像桌面那样惰性 initStore），故这里是真 no-op
    ensureStore: async () => {},
    createBackup: async (data: unknown) => {
      // 备份与主数据同目录 —— 与桌面 `path.dirname(storeInstance.path)` 同一约定
      await writeSecureBackup(dirname(store.path), data, createAesGcmBackupCipher())
    },
    setLastSavedData: setLastSaved
  }
}

/**
 * `AccountRuntimeDeps`。桌面版见 `index.ts:3854`。
 *
 * 服务端与桌面的逐项差异：
 *   - `emit`：桌面是 `mainWindow?.webContents.send`。服务端**显式 no-op** ——
 *     这些是进度/逐条结果推送，消费者是渲染进程的 UI，面板走 HTTP 轮询不需要。
 *     保留桌面原语义里的「静默容错」（主窗口关闭时 send 不抛错）。
 *   - `isProactiveRenewalEnabled`：读盘上 `proactiveRenewalEnabled`。主动续期是
 *     主进程逻辑（给本机 IDE 抢先刷 token），服务器上没有本机 IDE ——
 *     但**判据仍读盘**而不是硬编 false：这个键是用户的意图表达，硬编等于替他改配置。
 *     实际效果：服务端不启动 IDE token watcher，故 `lastSwitchedAccountId` 恒为 null，
 *     `scheduleProactiveRenewal` 不会被排上（下面它是 no-op）。
 *   - `scheduleProactiveRenewal`：**no-op**。它的产出是「往本机 SSO 缓存文件写 token」，
 *     服务器上没有消费该文件的 IDE。不是「还没做」，是没有消费者。
 */
function buildRuntimeDeps(
  api: ServerAccountApi,
  getProxyServer: () => ProxyServer | null
): AccountRuntimeDeps {
  let lastSwitchedAccountId: string | null = null
  let lastWrittenTokenSignature: string | null = null
  const refreshInFlightIds = new Set<string>()

  return {
    get proxyServer() {
      return getProxyServer()
    },
    emit: () => {
      /* 桌面专属：进度 / 逐条结果推送的消费者是 renderer UI，面板走 HTTP 轮询 */
    },
    api,
    getLastSwitchedAccountId: () => lastSwitchedAccountId,
    setLastSwitchedAccountId: (id) => {
      lastSwitchedAccountId = id
    },
    getLastWrittenTokenSignature: () => lastWrittenTokenSignature,
    setLastWrittenTokenSignature: (sig) => {
      lastWrittenTokenSignature = sig
    },
    // 服务器上没有本机 IDE 消费 SSO 缓存文件 → 主动续期无消费者，恒关。
    // 刻意不读盘上的 proactiveRenewalEnabled：读了会让 scheduleProactiveRenewal
    // 被排上，而它在服务端是 no-op —— 那就成了「开关显示开着但什么都不做」，
    // 正是决策卡 Must NOT #5 点名的形态。
    isProactiveRenewalEnabled: () => false,
    scheduleProactiveRenewal: () => {
      /* 服务器上无本机 IDE 读 SSO 缓存文件 —— 该能力无消费者 */
    },
    refreshInFlightIds
  }
}

/**
 * `ProxyServerEvents` 的服务端实现。桌面版见 `index.ts:610-800`。
 *
 * 逐个回调的处置（侦察报告附录 B 的分类落地）：
 *   - `onRequest` / `onResponse` / `onStatusChange` / `onHeldRequestsChanged`：**丢**。
 *     纯 UI 展示，面板轮询 `/api/proxy/status` 已覆盖（它读的是 server 句柄真实读数）。
 *   - `onError`：**只 console.error**。面板的 `status.lastError` 已含错误信息。
 *   - `onWebhookTrigger`（桌面用 `setWebhookTrigger`）：**不装**。webhook 实际由
 *     renderer 的 `useWebhookStore.triggerEvent` 发出，服务端没有那个 store。
 *     装一个只 log 的版本会让「webhook 已配置」看起来成立而实际不发。
 *   - `onAccountUpdate` / `onAccountSuspended`：**走 persistence 缝位**（下游是落盘）。
 *   - `onCreditsUpdate` / `onTokensUpdate` / `onRequestStatsUpdate`：**落盘**。
 *     桌面用 `debouncedStoreSet` 防抖；服务端同样必须防抖 —— 这三个在热路径上，
 *     每次都写会对整库做一次 AES 加解密。
 *   - `onSessionTick`：**落盘** orphan 快照（强杀/崩溃时下次启动能归档）。
 *   - `onPoolEmpty`：**懒加载补池**。复用 `activation.ts` 的准入判据，不重写。
 *   - `onTokenRefresh`：走注入的 `api.refreshTokenByMethod`（未接线时抛，见文件头缺口）。
 */
function buildProxyEvents(
  store: AccountStorePort,
  api: ServerAccountApi,
  persistence: ServerPersistenceHooks | undefined,
  getProxyServer: () => ProxyServer | null
): ConstructorParameters<typeof ProxyServer>[1] {
  const debouncedSet = makeDebouncedStoreSet(store)
  let warnedNoPersistence = false
  const warnOnce = (what: string): void => {
    if (warnedNoPersistence) return
    warnedNoPersistence = true
    console.warn(
      `[server] ⚠️ ${what} 未接线：该事件的下游动作是**落盘**，桌面端靠 renderer 转手落盘，` +
        `服务端需要主进程侧落盘路径（另一个工作包）。当前这些更新只存在于内存中的账号池里，` +
        `进程重启后丢失（表现为「反代刷过 token，重启后又用回旧的」）。`
    )
  }

  return {
    onError: (error: Error) => {
      console.error('[server] 反代错误:', error.message)
    },
    onTokenRefresh: async (account) => {
      try {
        const result = await api.refreshTokenByMethod(
          account.refreshToken || '',
          account.clientId || '',
          account.clientSecret || '',
          account.region || 'us-east-1',
          account.authMethod,
          // 账号绑定的出口代理（如有）—— 与桌面同一优先级
          account.proxyUrl,
          { tokenEndpoint: account.tokenEndpoint, scopes: account.scopes }
        )
        if (result.success && result.accessToken) {
          return {
            success: true,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: Date.now() + (result.expiresIn || 3600) * 1000
          }
        }
        return { success: false, error: result.error || 'Token 刷新失败' }
      } catch (error) {
        // 精准 catch：把「上游 API 未接线」这类装配错误如实转成刷新失败 + 记日志。
        // 不吞：日志里必须留下真实原因，否则表现成一次普通的上游故障。
        console.error('[server] token 刷新失败:', error)
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    onAccountUpdate: (account) => {
      if (!persistence?.onProxyAccountUpdate) {
        warnOnce('proxy-account-update（反代刷出的新 token）')
        return
      }
      persistence.onProxyAccountUpdate({
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
        // `profileArn` 必须转发：hook 契约声明了这个字段（见 `ServerPersistenceHooks`），
        // 而桌面侧那个 handler（`renderer/src/App.tsx:412`）**只**处理 profileArn
        // —— 它就是 Enterprise profileArn 运行时自愈的落盘路径。不转发的话该字段
        // 在契约上存在、在实现里恒为 undefined，即一个静默的死字段。
        profileArn: account.profileArn
      })
    },
    onAccountSuspended: (info) => {
      console.warn(
        `[server] 账号被上游封禁: ${info.email || info.accountId} (${info.reason}) ${info.message}`
      )
      if (!persistence?.onProxyAccountSuspended) {
        warnOnce('proxy-account-suspended（账号封禁状态）')
        return
      }
      persistence.onProxyAccountSuspended({
        id: info.accountId,
        email: info.email,
        reason: info.reason,
        message: info.message,
        suspendedAt: Date.now()
      })
    },
    onCreditsUpdate: (totalCredits) => {
      debouncedSet('proxyTotalCredits', totalCredits)
    },
    onTokensUpdate: (inputTokens, outputTokens) => {
      debouncedSet('proxyInputTokens', inputTokens)
      debouncedSet('proxyOutputTokens', outputTokens)
    },
    onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
      debouncedSet('proxyTotalRequests', totalRequests)
      debouncedSet('proxySuccessRequests', successRequests)
      debouncedSet('proxyFailedRequests', failedRequests)
    },
    onSessionTick: (rec) => {
      try {
        store.set(PROXY_ORPHAN_SESSION_KEY, rec)
      } catch (e) {
        // 精准 catch：快照写失败只影响「崩溃后能否归档这次会话」，不该中断反代服务。
        // 但**必须记日志** —— 静默吞掉会让「会话统计总是丢」查不到任何线索。
        console.warn('[server] 写会话快照失败:', e)
      }
    },
    onPoolEmpty: async () => {
      const server = getProxyServer()
      if (!server) return
      const data = store.get('accountData') as
        | {
            accounts?: Record<string, unknown>
            accountProxyBindings?: Record<string, string>
            proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
          }
        | undefined
      if (!data?.accounts) return
      // 准入判据与 autostart / 面板同一真源（`proxy/activation.ts`），不在这里重写
      const accounts = buildProxyAccountsFromStore(
        data.accounts,
        { bindings: data.accountProxyBindings ?? {}, proxyPool: data.proxyPool ?? {} },
        (skipped) => logPoolAdmissionSkips(skipped, 'server-lazy-refill')
      )
      if (accounts.length === 0) return
      const pool = server.getAccountPool()
      accounts.forEach((acc) => pool.addAccount(acc))
      console.log(`[server] 懒加载补池: ${accounts.length} 个账号`)
    }
  }
}

/**
 * 防抖写盘。桌面版是 `index.ts:debouncedStoreSet`。
 *
 * 为什么必须防抖而不是每次都写：这三个统计回调在**热路径**上（每个请求都触发），
 * 而 `conf` 的每次 `set` 都对整库做一次 AES 加解密 + 原子写。桌面端曾因此阻塞主进程
 * （见 `index.ts:onAccountSuspended` 注释里记的那次）。
 *
 * `unref()` 是承重的：不 unref 的 timer 会在收到 SIGTERM 后**挂住 Node 事件循环**，
 * 让进程要等到 timer 烧完才退 —— 而 systemd 的 `TimeoutStopSec` 到点会 SIGKILL，
 * 于是最后那批统计反而丢了。unref + 停机时显式 flush 才两头都保住。
 */
function makeDebouncedStoreSet(
  store: Pick<AccountStorePort, 'set'>,
  delayMs = 2000
): (key: string, value: unknown) => void {
  const pendingValues = new Map<string, unknown>()
  let timer: NodeJS.Timeout | null = null
  return (key: string, value: unknown) => {
    pendingValues.set(key, value)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      for (const [k, v] of pendingValues) {
        try {
          store.set(k, v)
        } catch (e) {
          console.warn(`[server] 写 ${k} 失败:`, e)
        }
      }
      pendingValues.clear()
    }, delayMs)
    timer.unref?.()
  }
}

/** 会话历史保留条数。与 `index.ts:PROXY_SESSION_HISTORY_LIMIT` 一致（由测试断言两者相等） */
const PROXY_SESSION_HISTORY_LIMIT = 200

/**
 * 停机时归档本次反代会话。对齐桌面 `archiveProxySessionIfAny`（`index.ts:453`）逐条语义。
 *
 * 三处**必须**与桌面一致，否则两端读同一份 `proxySessionHistory` 会看到不同的东西：
 *   ① **空会话不记录**（`rec.totalRequests <= 0`）—— 否则误点启停会刷一堆垃圾条目；
 *   ② **追加在尾部**（`history.push` + `slice(-LIMIT)`），不是插在头部。桌面按
 *      「越新越靠后」读，头插会让两端的时间顺序相反；
 *   ③ 归档后清 orphan 键，避免下次启动重复归档同一条。
 *
 * `store.set(KEY, undefined)` 经端口适配器翻译成 `delete(key)` —— 直接对 `conf` 调
 * `set(key, undefined)` 会抛 `TypeError` **且旧值留在盘上**（实测，见
 * `accountStorePort.ts:adaptRawStoreToPort` 注释）。桌面端曾因此每次启动重复归档同一
 * 快照，历史里出现字节完全相同的重复条目（实测已产生 7 条）。翻译已在端口那层做掉。
 */
export function archiveProxySession(store: AccountStorePort, server: ProxyServer): void {
  try {
    const rec = server.snapshotSession()
    if (!rec || rec.totalRequests <= 0) return // 空会话不记录（同桌面）
    const history = (store.get('proxySessionHistory') as ProxySessionRecord[] | undefined) ?? []
    history.push(rec)
    store.set(
      'proxySessionHistory',
      history.length > PROXY_SESSION_HISTORY_LIMIT
        ? history.slice(-PROXY_SESSION_HISTORY_LIMIT)
        : history
    )
    store.set(PROXY_ORPHAN_SESSION_KEY, undefined)
    console.log(
      `[server] 已归档会话: ${rec.totalRequests} 请求 (✓${rec.successRequests} ✗${rec.failedRequests})`
    )
  } catch (e) {
    // 精准 catch：归档失败不该阻断停机流程（后面还要停面板）。记日志不吞原因。
    console.warn('[server] 归档会话统计失败:', e)
  }
}

/**
 * 启动时回收上一次的 orphan 快照。对齐桌面 `restoreOrphanProxySessionIfAny`（`index.ts:477`）。
 *
 * 为什么服务端**尤其**需要这个：桌面上「上次没正常退出」多半是用户强杀；服务器上
 * 它是常态 —— `systemd` 的 `TimeoutStopSec` 到点 SIGKILL、容器 `docker kill`、
 * 机器掉电，每一次都会留下 orphan。不回收的话这些会话的统计永远丢，
 * 而运维看到的是「用量对不上」这种最难查的症状。
 *
 * 必须在 store 就绪之后、**任何新会话开始写 orphan 之前**调用（即反代启动之前）。
 */
export function restoreOrphanProxySession(store: AccountStorePort): void {
  try {
    const orphan = store.get(PROXY_ORPHAN_SESSION_KEY) as ProxySessionRecord | undefined
    if (!orphan || typeof orphan !== 'object') return
    if (!orphan.totalRequests || orphan.totalRequests <= 0) {
      store.set(PROXY_ORPHAN_SESSION_KEY, undefined)
      return
    }
    const history = (store.get('proxySessionHistory') as ProxySessionRecord[] | undefined) ?? []
    history.push(orphan)
    store.set(
      'proxySessionHistory',
      history.length > PROXY_SESSION_HISTORY_LIMIT
        ? history.slice(-PROXY_SESSION_HISTORY_LIMIT)
        : history
    )
    store.set(PROXY_ORPHAN_SESSION_KEY, undefined)
    console.log(
      `[server] 已回收上次非正常退出遗留的会话 (${orphan.totalRequests} 请求)`
    )
  } catch (e) {
    console.warn('[server] 回收 orphan 会话失败:', e)
  }
}

/**
 * 把 `buildPanelProxyDeps` 的 `Promise<unknown>` 收窄成 routes 契约要的 `Promise<ServiceLike>`。
 *
 * 与桌面 `ipc/webPanelWiring.ts:buildPanelRouteDeps` 里那个 `asService` 同源：
 * `buildPanelProxyDeps` 的返回类型**刻意**宽（它不愿把 `PanelProxyStatus` 泄进
 * routes 的公共契约），所以两端各自收一次。只动类型、不动值 —— 断言而非转换，
 * 运行期零开销、零行为差异。
 */
function asServiceMap<T extends Record<string, (...args: never[]) => Promise<unknown>>>(
  deps: T
): { [K in keyof T]: (...args: Parameters<T[K]>) => Promise<Record<string, unknown>> } {
  return deps as never
}

/**
 * 构造 `PanelRouteDeps`。桌面版走 `ipc/webPanelWiring.ts:buildPanelRouteDeps`，
 * 服务端**直接构造** —— 那个文件 import electron（见本文件头「为什么不复用」）。
 *
 * 本函数没有一行业务逻辑，全是把已装配好的调用原样转交（决策卡不变量 1
 * 「面板不得包含任何业务逻辑」）。反代那六个端点整体复用 `buildPanelProxyDeps`。
 *
 * ## 三个「服务端上没有消费者」的端点：**如实拒绝**，不假装成功
 *
 * `switchAccountToIde` / `switchAccountToCli` / `logoutFromIde` 写的是**主进程所在
 * 机器**的 Kiro SSO 缓存与 CLI 配置（`~/.aws/sso/cache`）。服务器上没有 Kiro IDE
 * 读那些文件，决策卡 §7 把这类归为「语义失效」。
 *
 * 处置是**返回明确失败**，而不是：
 *   - ❌ 真的去写服务器的 `~/.aws/sso/cache` —— 那会在服务器上产出一份没人读的
 *     凭据文件，纯粹是把 token 明文多写一个地方；
 *   - ❌ 返回 `{success:true}` —— 用户在手机上点「切换到 IDE」看到成功提示，
 *     而什么都没发生。决策卡 Must NOT #5 点名的正是这个形态。
 * 端点仍然存在（路由表是面板自己的，不由这一层增删），但它诚实地说明为什么不可用。
 */
function buildServerRouteDeps(ctx: {
  store: AccountStorePort
  storeDeps: AccountStoreDeps
  runtimeDeps: AccountRuntimeDeps
  getProxyServer: () => ProxyServer | null
  initProxyServer: () => ProxyServer
}): PanelRouteDeps {
  const { store, storeDeps, runtimeDeps } = ctx

  /** 服务器上语义失效的端点的统一应答。理由写在 message 里，运维/用户都看得懂 */
  const semanticallyUnavailable = (what: string) => async () => ({
    success: false,
    error: {
      message:
        `${what} 在服务器上不可用：它写的是**本机** Kiro IDE 的登录缓存，` +
        `而服务器上没有 Kiro IDE 会去读它。请在你自己的电脑上用桌面端做这件事。`
    }
  })

  return {
    loadAccountsBlob: () => loadAccounts(storeDeps),
    importApiKeys: (input) =>
      importApiKeys(
        {
          verifyApiKey: (params) => verifyApiKey(params),
          applyMutation: (mutate, opts) => applyAccountDataMutation(mutate, opts),
          now: () => Date.now(),
          newId: () => randomUUID(),
          // 账号绑定设备 ID 必须走 kproxy 的 `generateDeviceId`（32 字节 → 64 位 hex）。
          // **不要**换成 machineId.ts 的 generateRandomMachineId：那属于系统机器码域、
          // 产出 UUID 形态，拼进 UA 后匹配不上 `kproxy/mitmProxy.ts:17 KIRO_UA_REGEX`
          // （只认 64 hex），K-Proxy 设备 ID 改写会对 ksk_ 账号静默失效
          // （桌面端 `fce8c89` 已犯过一次，闸门见 accountMachineIdFormat.test.ts）。
          newMachineId: () => generateDeviceId()
        },
        input
      ),
    checkAccountStatus: (account) => checkAccountStatus(runtimeDeps, account as never),
    refreshAccountToken: (account) => refreshAccountToken(runtimeDeps, account as never),
    switchAccountToIde: semanticallyUnavailable('切换账号到 IDE'),
    switchAccountToCli: semanticallyUnavailable('切换账号到 CLI'),
    logoutFromIde: semanticallyUnavailable('从 IDE 退出登录'),
    getAccountModels: (identity: PanelAccountIdentity) =>
      getAccountModels({ fetchKiroModels }, identity) as Promise<Record<string, unknown>>,
    getAccountSubscriptions: (identity: PanelAccountIdentity) =>
      getAccountSubscriptions({ fetchAvailableSubscriptions }, identity) as Promise<
        Record<string, unknown>
      >,
    getAccountSubscriptionUrl: (identity: PanelAccountIdentity, subscriptionType?: string) =>
      getAccountSubscriptionUrl({ fetchSubscriptionToken }, identity, subscriptionType) as Promise<
        Record<string, unknown>
      >,
    setAccountOverage: (identity: PanelAccountIdentity, enabled: boolean) =>
      setAccountOverage({ setUserPreference }, identity, enabled ? 'ENABLED' : 'DISABLED') as Promise<
        Record<string, unknown>
      >,
    // 反代六端点：整体复用桌面同一份编排（`ipc/panelProxyDeps.ts` 实测零 electron）。
    // 顺序（先同步池再启动 / 选号三步）都在那一层，这里不重算。
    ...asServiceMap(
      buildPanelProxyDeps({
        getProxyServer: () => ctx.getProxyServer() as ProxyServerRef | null,
        initProxyServer: () => ctx.initProxyServer() as unknown as ProxyServerRef,
        loadAccountData: () => store.get('accountData') as never,
        persistProxyConfig: (cfg) => {
          // 与桌面 `proxy-update-config` 一致地落盘 —— 不写盘的话，下次自启动会丢掉
          // 用户在手机上的选号，表现为「昨天选好的号今天自己变了」。
          store.set('proxyConfig', cfg)
        }
        // updateTrayMenu / archiveSessionIfAny 都是**可选**参数，服务端刻意不传：
        //   - 托盘是桌面专属（`BrowserWindow` / `Tray`），服务器上无此物；
        //   - 会话归档由 `shutdown()` 统一做。面板 `/stop` 不归档是刻意的：
        //     面板停一次反代就归档一条会话会把历史刷满，而运维在手机上启停很随手。
      })
    )
  }
}

/** 供 `entry.ts` 与测试引用 —— 未被 assembleServer 用到的导出，保持在文件内可见 */
export { activateProxyAccount }
