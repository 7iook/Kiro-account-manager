/**
 * 服务端入口的**纯配置层**：环境变量契约 · 退出码 · 启动期数据故障分类。
 *
 * 为什么独立成文件而不并进 `entry.ts`：本文件全是纯函数，测试要能直接 import 它
 * 而**不触发** `entry.ts` 的顶层副作用（读 `process.env` / 装信号处理器 / 起服务器）。
 * 塞进 entry.ts 就等于「想测一个 parseInt，先起一个 HTTP 服务器」。
 *
 * ## 环境变量 vs store 键：谁是哪一半的真源
 *
 * 决策卡 I1a/I1b 定的迁移工件是「`kiro-accounts.json` 原样直拷」，也就是说
 * **盘上那份配置是桌面写的**，服务端只是读它。于是这里的分工是：
 *
 *   - **盘上（store）**：业务配置 —— `proxyConfig` / `webPanelConfig` / `accountData` /
 *     反代统计计数。它们跨两端共享同一份字节。
 *   - **环境变量**：部署事实 —— 数据目录在哪、面板监听哪个地址、密钥从哪来。
 *     它们是「这台机器怎么跑」，不是「这个用户的账号怎么配」。
 *
 * **环境变量覆盖一律只读，绝不回写 store**。这条是硬纪律：数据文件与桌面副本字节共享，
 * 一旦服务端把 `KIRO_PANEL_PORT` 落进 `webPanelConfig`，用户把文件拷回桌面时
 * 桌面面板就会去监听一个服务器上的端口 —— 而他完全不知道这个值是哪来的。
 * 服务端只有一个键需要独立持久化（adminKey），而那已由 `adminKeyStore.ts` 用
 * **独立文件**承担，不进 `kiro-accounts.json`（决策卡 DC9）。
 *
 * ## 退出码：让 `journalctl` 能区分四种拒启
 *
 * 决策卡「运营注册 · 启动失败反馈」要求四种拒启都有可读退出信息。只有 stderr 文案
 * 不够 —— 进程托管（systemd）看到的是**退出码**，运维排障时 `systemctl status` 顶行
 * 显示的也是它。故按 BSD sysexits 惯例分配（`/usr/include/sysexits.h`，systemd 与
 * 多数 init 系统的既有约定），不自造 1/2/3：
 *
 *   64 EX_USAGE     环境变量缺失 / 非法（KIRO_DATA_DIR 未设、端口不是数字）
 *   65 EX_DATAERR   数据文件在但用不了（解不开 / 读不了 / 版本过新）
 *   69 EX_UNAVAILABLE 服务起不来（端口被占、面板/反代拒绝启动）
 *   73 EX_CANTCREAT 权限问题（数据目录或文件不可写、密钥文件权限设不上）
 *   78 EX_CONFIG    配置自相矛盾（环境变量与密钥文件冲突）
 *
 * 「解不开」与「不可写」分成 65/73 是刻意的：运维看到 65 该去查加密密钥与文件完整性，
 * 看到 73 该去查 `chown` / 挂载选项。混成一个码就等于让他每次都两头都查。
 */
import {
  accountStoreFilePath,
  assertAccountStoreVersion,
  assertAccountStoreWritable,
  classifyAccountStoreFile,
  decodeAccountStoreBytes,
  ACCOUNT_STORE_ENCRYPTION_KEY
} from '../persistence/accountStorePort'
import { readFileSync } from 'node:fs'

/** 退出码（BSD sysexits 惯例，见文件头「退出码」节） */
export const EXIT = {
  OK: 0,
  /** EX_USAGE —— 环境变量缺失或非法 */
  USAGE: 64,
  /** EX_DATAERR —— 数据文件在但用不了 */
  DATA_ERROR: 65,
  /** EX_UNAVAILABLE —— 服务起不来（端口占用等） */
  UNAVAILABLE: 69,
  /** EX_CANTCREAT —— 权限问题 */
  CANNOT_CREATE: 73,
  /** EX_CONFIG —— 配置自相矛盾 */
  CONFIG: 78
} as const

/** 环境变量名集中在此，避免字面量散落（改名时一处可查全） */
export const ENV = {
  /** 数据目录。**必填、无默认值** —— 理由见 `readServerConfig` */
  DATA_DIR: 'KIRO_DATA_DIR',
  /** 面板监听地址覆盖（默认取盘上 webPanelConfig.host，最终兜底 127.0.0.1） */
  PANEL_HOST: 'KIRO_PANEL_HOST',
  /** 面板监听端口覆盖（默认取盘上 webPanelConfig.port） */
  PANEL_PORT: 'KIRO_PANEL_PORT',
  /**
   * 日志截断开关。桌面端是 `setLogTruncationEnabled(app.isPackaged)`（`index.ts:3191`），
   * 即「打包态截断、开发态全量」。服务端没有 `isPackaged` 这个概念，故默认**开启截断**
   * （服务器上日志进 journal / 容器日志，全量 payload 会把磁盘写满且夹带凭据），
   * 排障时用 `KIRO_LOG_FULL=1` 临时关掉。
   */
  LOG_FULL: 'KIRO_LOG_FULL'
} as const

/**
 * 反代 orphan 会话快照的 store 键。
 *
 * ⚠️ **必须与 `src/main/index.ts:447` 的 `PROXY_ORPHAN_SESSION_KEY` 逐字一致**。
 * 那边是模块私有 const、未导出，而 `index.ts` 本轮由另一个 agent 持有、且它 import
 * electron（服务端不能引用它）。故这里镜像一份字面量，并由
 * `test/main/server/serverConfig.test.ts` 读 `index.ts` 源码断言两者相等 ——
 * 靠注释同步的副本是 §4.3 点名要消灭的形态，靠测试同步的副本才拦得住漂移。
 *
 * 键值漂移的后果不是崩溃而是静默：服务端写 A、桌面读 B，于是崩溃后的会话统计
 * 永远归档不到，而两边都「看起来正常」。
 */
export const PROXY_ORPHAN_SESSION_KEY = 'proxyOrphanSessionSnapshot'

/** 环境变量解析失败 —— 带上退出码，让 entry 不必再猜 */
export class ServerConfigError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number = EXIT.USAGE) {
    super(message)
    this.name = 'ServerConfigError'
    this.exitCode = exitCode
  }
}

export interface ServerConfig {
  /** 数据目录绝对路径（原样取自环境变量，不做推导） */
  dataDir: string
  /** 面板地址覆盖；`undefined` = 用盘上配置 */
  panelHost?: string
  /** 面板端口覆盖；`undefined` = 用盘上配置 */
  panelPort?: number
  /** 是否截断日志（true = 截断，同桌面打包态） */
  truncateLogs: boolean
}

/**
 * 解析环境变量。
 *
 * ## 为什么 `KIRO_DATA_DIR` 没有默认值
 *
 * 与 `persistence/accountStore.conf.ts:ConfAccountStoreOptions.dataDir` 同一条理由，
 * 这里把它抬到进程层再说一次：一个**推导出来的**数据目录会让运维以为数据写在他
 * 以为的位置、实际写在别处，而且不报错。服务器上这个失效形态尤其贵 —— 他会先看到
 * 「0 个账号」，然后在那个空库上导入几个号，等发现搞错目录时，两份数据都残缺了。
 * 决策卡把「账号数据路径写错」列为本项目**最高危失效**（Must NOT #1），故这里必填。
 *
 * 端口非法一律拒启而不取默认值：决策卡「运营注册 · 配置校验」明确
 * 「非法值拒绝启动而非取默认值静默跑」—— 把 `KIRO_PANEL_PORT=808o` 静默当成
 * 「用默认 5590」，运维会以为自己改成功了，然后在 8080 上怎么也连不上。
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawDataDir = (env[ENV.DATA_DIR] ?? '').trim()
  if (!rawDataDir) {
    throw new ServerConfigError(
      `缺少必填环境变量 ${ENV.DATA_DIR}（账号数据目录的绝对路径）。\n` +
        `刻意不提供默认值：推导出来的目录会让你以为数据在 A、实际写在 B，且不报错 ——` +
        `随后你会先看到「0 个账号」，再在那个空库上导入，最终两份数据都残缺。\n` +
        `迁移做法：把桌面端的 kiro-accounts.json 拷进该目录（复制，别移动），再启动本服务。`,
      EXIT.USAGE
    )
  }

  const config: ServerConfig = {
    dataDir: rawDataDir,
    truncateLogs: !isTruthyFlag(env[ENV.LOG_FULL])
  }

  const rawHost = (env[ENV.PANEL_HOST] ?? '').trim()
  if (rawHost) config.panelHost = rawHost

  const rawPort = (env[ENV.PANEL_PORT] ?? '').trim()
  if (rawPort) config.panelPort = parsePort(rawPort, ENV.PANEL_PORT)

  return config
}

/**
 * 端口解析。`0` 合法（内核分配，`WebPanelServer.getListeningAddress()` 会回报真实端口）。
 *
 * 用 `Number()` 而非 `parseInt`：`parseInt('808o')` 会得到 `808`，正是本函数要拒绝的
 * 那种「看起来改成功了、其实听在别的端口上」。`Number('808o')` 是 NaN，拒得干净。
 */
function parsePort(raw: string, varName: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ServerConfigError(
      `环境变量 ${varName}=${JSON.stringify(raw)} 不是合法端口（需 0-65535 的整数；0 = 由内核分配）。` +
        `拒绝启动而不是取默认值 —— 静默回落会让你以为端口改成功了，然后在那个端口上怎么也连不上。`,
      EXIT.USAGE
    )
  }
  return n
}

/** 布尔型环境变量：只认明确的真值，其余（含未设置）为假 */
function isTruthyFlag(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 启动期数据故障 → 退出码 + 运维可读文案。
 *
 * ## 为什么不直接把端口抛的 Error 打出去就完事
 *
 * `preflightAccountStoreForServer` 把四态判得很准，抛的文案也够详细，但它**只抛
 * `Error`** —— 于是调用方只能拿到一段字符串。而运维在 `journalctl` 里真正要的
 * 第一件事是「这属于哪一类」：改 `chown`，还是查加密密钥，还是根本没拷数据文件。
 * 本函数不重写它的判据（那会造第二个真源），只做**分类**：重新走一遍同样的只读
 * 判定原语，把结果映射到退出码。
 *
 * 判定顺序与 `preflightAccountStoreForServer` 一致（写权限先查），理由同它：
 * 运维搬完数据第一次起服务端时最可能撞的就是权限，先报它错误信息最贴近现场。
 *
 * @returns `decoded` = 盘上已解出的内容（absent 时 null），供调用方免去二次读盘
 * @throws {ServerConfigError} 带分类退出码
 */
export function preflightForServerWithExitCode(
  dataDir: string,
  encryptionKey: string = ACCOUNT_STORE_ENCRYPTION_KEY
): { file: string; decoded: Record<string, unknown> | null } {
  const file = accountStoreFilePath(dataDir)

  // ① 写权限（EX_CANTCREAT）—— 只读运行会让定时器里的写入全部静默失败
  try {
    assertAccountStoreWritable(file)
  } catch (e) {
    throw new ServerConfigError(messageOf(e), EXIT.CANNOT_CREATE)
  }

  // ② 四态。absent 是**唯一**允许放行的「没有数据」
  const state = classifyAccountStoreFile(file, encryptionKey)
  if (state.state === 'absent') {
    // 决策卡：文件不存在 → 以空账号库启动 + 明确提示，**不是**崩溃也不是静默建空库。
    // 提示走 stderr 而非 stdout：它是异常状况的告知，而 stdout 那一行留给 adminKey
    // （运维要从容器日志里抄它，混进别的内容只会增加他找错的概率）。
    console.error(
      `[server] 未找到账号数据文件：${file}\n` +
        `[server] 以空账号库启动。请在面板里导入 ksk_ 账号，` +
        `或停止服务、把桌面端的 kiro-accounts.json 拷到 ${dataDir} 后重启。`
    )
    return { file, decoded: null }
  }
  if (state.state === 'unreadable') {
    throw new ServerConfigError(
      `账号数据文件存在但无法读取：${file}\n原因：${state.reason}\n` +
        `拒绝以空库启动 —— 那会让你以为账号丢了，且随后任何一次写入都会覆盖这份可能仍可修复的数据。\n` +
        `请检查文件权限与属主（服务用户是否拥有这个被拷进来的文件）。`,
      // 「读不了」是权限/IO 而非内容问题，归 EX_CANTCREAT 与写权限同类,
      // 让运维看到 73 就知道该去查 chown / 挂载,不必两头都查。
      EXIT.CANNOT_CREATE
    )
  }
  if (state.state === 'undecryptable') {
    throw new ServerConfigError(
      `账号数据文件无法解密或解析：${file}\n原因：${state.reason}\n` +
        `拒绝以空库启动。**先备份这个文件再排查**。最常见的两种原因：` +
        `① 它不是本程序写的 / 传输中被截断；② 桌面端与本服务的加密密钥不一致` +
        `（两端必须同为编译进代码的同一个常量，见 persistence/accountStorePort.ts）。`,
      EXIT.DATA_ERROR
    )
  }

  // ③ 版本闸门（EX_DATAERR）—— 只拒更新的版本，无版本字段判为兼容
  const decoded = decodeAccountStoreBytes(readFileSync(file), encryptionKey) as Record<
    string,
    unknown
  >
  try {
    assertAccountStoreVersion(decoded)
  } catch (e) {
    throw new ServerConfigError(messageOf(e), EXIT.DATA_ERROR)
  }

  return { file, decoded }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
