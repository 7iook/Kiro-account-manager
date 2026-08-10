/**
 * `AccountStorePort` 的 **`conf` 实现**（服务端形态 · 零 electron 依赖）。
 *
 * 命名沿用 K-1 `secureBackupCipher.aesGcm.ts` / `.safeStorage.ts` 的形态：
 * `<端口>.<实现手段>.ts`，一个文件一个实现，装配层挑一个注入。
 *
 * ## 为什么服务端实现用 `conf` 而不自己写文件格式
 *
 * 读过 `node_modules/electron-store/index.js`（v11.0.2）后确认桌面那条路径是
 * `ElectronStore extends Conf`，壳里只做三件事：从 `app.getPath('userData')` 取 `cwd`、
 * 从 `app.getVersion()` 取 `projectVersion`、把 `name` 改名 `configName`。
 * 加解密 / 序列化 / 原子写 / 路径拼装全在 `conf` 里，而 `conf@15.0.2` 零 electron 依赖。
 *
 * 于是「服务端能读桌面写的字节」这件事，用 `conf` 是**结构性成立**的，
 * 而自己写编解码只能靠一组我自己写的测试去维持 —— 而 ADR-0002 Decision 3 把
 * 「原始 `kiro-accounts.json` 直拷」定为本轮唯一正式支持的迁移工件，这条兼容性
 * 是用户数据能不能被读出来的问题，不该建立在「我的编解码器和它们的一致」这个假设上。
 *
 * 桌面端为什么不也换成本文件：`electron-store` 还额外做了 renderer 侧的 IPC 桥
 * （`initRenderer` / `electron-store-get-data`）。本项目 renderer 侧未使用它
 * （全仓零 `initRenderer` 调用），但换掉桌面的构造方式属于「改一个正在工作的东西」，
 * 收益仅是少一层薄壳，风险是 `projectVersion` 等隐式行为差异。故桌面保持原样，
 * 本文件只承担服务端形态与测试。
 *
 * ## 与 `conf` 默认行为的三处**刻意偏离**（都在构造期）
 *
 * 实测(2026-08-10 本机 node v22 · conf 15.0.2) `conf` 在三种数据故障下的行为，
 * 与决策卡 `decision-card.md:103-106` 的要求不一致，故本文件在构造前自己把闸门补上：
 *
 *   ① **解不开 → conf 抛的是 `SyntaxError: Unexpected token`**（它把解密失败退化成
 *      「把密文当明文 JSON.parse」）。抛是对的，但错误信息完全不指向真实原因，
 *      运维看到 JSON 语法错误不会想到密钥不符。本文件换成明确文案。
 *   ② **只读文件 → conf 构造成功、get 成功，只在第一次 `set` 时才抛 EPERM**。
 *      这正是决策卡 ④ 要避免的形态（本程序的写路径大多在定时器里，异常只进日志）。
 *      本文件在构造期就拒。**这一条只在服务端形态生效** —— 它是服务器启动语义
 *      （挂载权限 / 容器卷 / 服务用户不拥有拷进来的文件），桌面上那个处境几乎不存在，
 *      故桌面走的 `preflightAccountStore` 不含它。见端口的 `assertAccountStoreWritable`。
 *   ③ **版本字段 → conf 没有这个概念**（它的 `migrations` 是另一回事，且本项目未用）。
 *      决策卡 ③ 要求「版本比预期新则拒绝」，故由端口实现。
 *
 * ①③ 走 `accountStorePort.ts` 的 `preflightAccountStore`（桌面与服务端共用同一判据），
 * ② 由本文件经 `preflightAccountStoreForServer` 额外叠加。
 */
import Conf from 'conf'

import {
  ACCOUNT_STORE_ENCRYPTION_KEY,
  ACCOUNT_STORE_NAME,
  accountStoreFilePath,
  adaptRawStoreToPort,
  preflightAccountStoreForServer,
  type AccountStorePort
} from './accountStorePort'

export interface ConfAccountStoreOptions {
  /**
   * 数据目录。桌面端传 `app.getPath('userData')`，服务端由运维给（命令行 / 环境变量）。
   *
   * **必填，无默认值**：`conf` 在没有 `cwd` 时会走 `env-paths(projectName)` 推导一个
   * 平台默认目录。那对服务端是错的 —— 一个推导出来的目录会让运维以为数据写在他指定的
   * 位置，实际写在别处，而且不报错。姿态与 K-2 `proxyServer` 的 `userDataPath` 一致：
   * 路径是装配期事实，必须由装配层显式给出。
   */
  dataDir: string
  /** 仅测试用；生产不传。改动它等于让既有数据读不开（见端口文件头） */
  encryptionKey?: string
}

/**
 * 创建 `conf` 支撑的账号数据 store。
 *
 * @throws 数据文件存在但解不开 / 读不了 / 版本过新 / 目录或文件不可写时 **构造期抛**。
 *   刻意 fail fast：这四种都是「继续跑下去会静默损坏或静默丢数据」的处境，
 *   而启动那一刻是最便宜的纠正时机（姿态同 K-1 `createAesGcmBackupCipher`）。
 *   注意「不可写」这一条**只有本文件（服务端形态）会抛** —— 桌面装配走的是
 *   不含写权限闸门的 `preflightAccountStore`。
 */
export function createConfAccountStore(options: ConfAccountStoreOptions): AccountStorePort {
  const encryptionKey = options.encryptionKey ?? ACCOUNT_STORE_ENCRYPTION_KEY

  // 四态 + 版本 + 写权限。必须在 new Conf 之前 —— 构造它会创建目录并可能写入，
  // 而「拒绝启动」不该留下副作用。
  //
  // 用 `...ForServer`（含写权限闸门）而非桌面那条：写权限是服务端启动语义
  // （挂载权限 / 容器卷 / 服务用户不拥有拷进来的文件），桌面上那个处境几乎不存在。
  // 见 `accountStorePort.ts:assertAccountStoreWritable` 头部注释。
  preflightAccountStoreForServer(options.dataDir, encryptionKey)

  const conf = new Conf<Record<string, unknown>>({
    cwd: options.dataDir,
    configName: ACCOUNT_STORE_NAME,
    encryptionKey
  })

  // `set(key, undefined)` → `delete(key)` 的翻译走端口的共用适配器，不在这里重写一遍：
  // 桌面装配（`index.ts:initStore`）用的是同一个 `adaptRawStoreToPort`，
  // 两条路径共享同一份翻译逻辑，才不会哪天只修了一边。
  return adaptRawStoreToPort({
    get: (key: string, defaultValue?: unknown) => conf.get(key, defaultValue),
    set: (key: string, value: unknown) => conf.set(key, value),
    delete: (key: string) => conf.delete(key),
    path: accountStoreFilePath(options.dataDir)
  })
}
