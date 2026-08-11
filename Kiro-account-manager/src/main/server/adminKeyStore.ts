/**
 * 服务端 `AdminKeyStore`（W-B）—— 决策卡 DC9「首次 adminKey 引导」四条规则的实现。
 *
 * 规则出处：`.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:458-470`
 * 行为闸门：`test/main/server/adminKeyStore.test.ts`（先于本文件写成，是本文件的规格）
 *
 * ## 为什么服务端不能复用桌面那份 `AdminKeyStore`
 *
 * 桌面实现（`ipc/webPanelWiring.ts:createAdminKeyStore`）把 key 存在**账号数据文件里**
 * （`webPanelAdminKey` 键，走 electron-store），首次由设置页 IPC 拉取时生成并显示。
 * 服务器上这两个前提都不成立：没有设置页可显示，且 `import electron` 在服务端形态里不可用。
 * 所以服务端换了两件事 —— **独立密钥文件**（数据文件是要跨机搬运的，凭据不该跟着它走）
 * 与**首启打印到 stdout 一次**（那是运维在服务器上唯一能看到它的地方）。
 * 端口本身不变（`webPanel/auth.ts:AdminKeyStore` 的 `get`/`set`），故面板侧零改动。
 *
 * ## 三个来源，语义各不相同（`source` 字段就是这件事）
 *
 * | source | 含义 | 打印 | `set()` 轮换 |
 * |---|---|---|---|
 * | `generated` | 首启无密钥 → 现生成 | **打印一次**（规则 1、负向验收 ③） | 允许（重写文件） |
 * | `file` | 盘上已有 → 读回 | 不打印（规则 2：容器日志不留长期凭据） | 允许（重写文件） |
 * | `env` | 环境变量预置 | 不打印（规则 4：运维自己给的，他已经知道） | **拒绝**（见 `set`） |
 *
 * 三个来源的**强度判据完全相同**（`classifyAdminKeyStrength`）：自动生成是 256bit 随机，
 * 预置值也必须够长，否则拒启。此前只有生成路径有熵、预置路径只判空，
 * 于是 `KIRO_ADMIN_KEY=x` 会被当成局域网面板的管理员凭据接受。
 *
 * ## 密钥文件的保护证明是**拒启条件**，不是告警
 *
 * 决策卡规则 3 逐字是「若无法设置该权限则拒绝启动」。POSIX 上按权限位判；
 * Windows 上 POSIX 位不存在（实测 `chmod(0600)` 读回 `0o666`），
 * 于是那里**无法证明**密钥文件只有服务账户可读 —— 该态同样拒启，
 * 除非显式设置 `KIRO_ALLOW_UNPROTECTED_KEY_FILE=1`（开发机用，每次启动都告警）。
 * 理由与不去解析 NTFS ACL 的理由都在 `enforceKeyFilePermission` 上。
 * 注意 Windows 上不受支持的是**密钥文件**，不是服务端形态：走 `env` 预置根本不落文件。
 *
 * ## 「引导」发生在构造期，不在首次 `get()`
 *
 * 桌面是惰性的（设置页第一次问才生成），服务端刻意不是：拒绝启动的四种判定
 * （权限过宽 / 环境变量与文件冲突 / 环境变量为空 / 文件在但读不出来）必须在**进程启动时**
 * 就把进程打死，而不是等某个 HTTP 请求触发 `get()` 时才在请求路径里抛。
 * 于是 `createServerAdminKeyStore()` 返回时，要么密钥已就绪、要么已经抛了。
 * 拒启判定共六道：权限无法证明 / 权限过宽 / env 与文件冲突 / env 为空 /
 * **预置值强度不足** / 文件在但读不出来。
 *
 * ## 迁移决定：**不**回退读数据文件里的 `webPanelAdminKey`
 *
 * 手工直拷 `kiro-accounts.json` 是本轮唯一正式支持的迁移工件（ADR-0002 Decision 3），
 * 那份文件里带着桌面的 adminKey。仍然生成新密钥，因为桌面那把钥匙有**未知暴露史**
 * （设置页展示过、随数据文件跨机搬运过、可能进过截图或聊天记录）。静默继承它会让运维
 * 得不到任何信号 —— 而「新密钥被打印出来」就是那个信号。调用方若已知数据文件里有旧密钥，
 * 传 `legacyDesktopKeyPresent: true`，打印里会明说那把旧钥匙不生效（这是运维最可能的困惑）。
 */
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

import { generateAdminKey, type AdminKeyStore } from '../webPanel/auth'
import { EXIT, ServerConfigError } from './config'

/**
 * 预置密钥的环境变量名（适配 Docker secrets / systemd `Environment=` / 编排工具）。
 * 与 `k5-recon.md:287` 的 W-B 行一致。
 */
export const ADMIN_KEY_ENV = 'KIRO_ADMIN_KEY'

/**
 * 密钥文件名（位于 dataDir 下，与 `kiro-accounts.json` **同目录但不同文件**）。
 *
 * 为什么独立成文件而不是塞进账号数据：数据文件是迁移工件，会被整份拷到别的机器 /
 * 进备份 / 被贴到工单里。凭据跟着它走等于每次搬数据都搬一次密码。
 * 独立文件还让「遗失恢复」有一个不损坏账号数据的动作 —— 删它、重启、重新生成。
 */
export const ADMIN_KEY_FILE_NAME = 'adminKey'

/** 密钥文件的目标权限：仅属主可读写（决策卡规则 3） */
const KEY_FILE_MODE = 0o600

/**
 * 「我知道这台机器上无法证明密钥文件只有服务账户可读，仍然放行」的显式开关。
 *
 * 存在的唯一理由是**开发机**：Windows 是本项目的主开发平台，而 Windows 上
 * POSIX 位不存在（见 `classifyKeyFilePermission`），于是决策卡规则 3
 * 「无法设置 0600 则拒绝启动」在那里会挡住本地跑服务端。
 *
 * 刻意做成 opt-in 而不是「Windows 上自动放行」：后者是把安全判据**降级**成告警，
 * 而告警建立不了任何访问控制；前者让运维显式承担风险，且每次启动都会再告警一次。
 * 生产上想在 Windows 跑而不打开这个开关，正确姿势是用 `KIRO_ADMIN_KEY` 预置
 * （那条路径根本不落密钥文件，因此没有「无法证明其权限」的对象）。
 */
export const ALLOW_UNPROTECTED_KEY_FILE_ENV = 'KIRO_ALLOW_UNPROTECTED_KEY_FILE'

/**
 * 预置密钥的最小长度。
 *
 * ## 为什么是「最小长度」而不是「必须等于生成器的格式」
 *
 * 生成器出的是 43 字符 base64url（32B CSPRNG）。要求逐字同格式看起来更严，
 * 实际会**误拒更强的值** —— 密码管理器给的 64 字符 hex、运维自己 `openssl rand`
 * 出来的 base64 都不是那个形状。那会把「运维把凭据收得更紧」变成故障，
 * 与权限判据用「不得更宽」而非「必须等于 0600」是同一条取舍。
 *
 * ## 为什么 32 这个数不是随手定的
 *
 * `secureBackupCipher.aesGcm.ts:47` 的 `MIN_BACKUP_KEY_LENGTH` 已经是 32，
 * 那是本项目既有的口令下界。沿用它 = 全项目一套口令故事，不造第二套判据。
 *
 * ## 为什么不做熵评分
 *
 * adminKey 的威胁模型是**在线**猜测：攻击者只能对着面板试，而
 * `loginThrottle.ts:18-22` 已经按 IP「5 次失败后指数锁定、上限 30 分钟」。
 * 没有可离线爆破的密文，故「足够长」就够了。复杂度评分器会冒充真实熵证明
 * （`'a'.repeat(32)` 照样通过），那是自欺 —— 与备份口令那条的结论一致。
 */
export const MIN_ADMIN_KEY_LENGTH = 32

/** 强度判定结果。三态而非布尔 —— 运维要知道是「太短」还是「字符不合法」 */
export type AdminKeyStrengthVerdict =
  /** 长度达标且字符合法 —— 放行 */
  | { kind: 'ok' }
  /** 短于下界 —— 拒绝（`KIRO_ADMIN_KEY=x` 就是这一态） */
  | { kind: 'too-short'; length: number }
  /** 含控制字符或内部空白 —— 拒绝（格式风险，不是熵判据） */
  | { kind: 'bad-chars' }

/** 密钥的来源。决定「是否打印」与「`set()` 是否合法」，见文件头的表 */
export type AdminKeySource = 'generated' | 'file' | 'env'

/** 权限判定结果。`unenforceable` 是 Windows 专有的第三态，不是「过宽」的同义词 */
export type KeyFilePermissionVerdict =
  /** 属主之外无任何权限位 —— 放行 */
  | { kind: 'ok'; mode: number }
  /** 组 / 其他用户存在任一权限位 —— 拒绝启动 */
  | { kind: 'too-open'; mode: number; offending: number }
  /** 该平台上 POSIX 三段位不存在，判据无从施加 —— 放行但告警 */
  | { kind: 'unenforceable'; mode: number; warning: string }

/** 服务端密钥存储：既满足面板端口，又对外暴露来源与文件位置（供启动日志 / 部署文档） */
export interface ServerAdminKeyStore extends AdminKeyStore {
  /** 本次启动时密钥从哪来 —— 描述**引导那一刻**的事实，不随后续 `set()` 改变 */
  readonly source: AdminKeySource
  /** 密钥文件的完整路径（`source === 'env'` 时该文件可能并不存在） */
  readonly file: string
}

export interface ServerAdminKeyStoreOptions {
  /** 数据目录（服务端由 `KIRO_DATA_DIR` 决定）。不存在时会被建出来 */
  dataDir: string
  /** 环境变量表。显式注入而非直读 `process.env` —— 否则测试无法构造「干净环境」 */
  env?: NodeJS.ProcessEnv
  /** 平台。可注入的理由见 `classifyKeyFilePermission` 的注释 */
  platform?: string
  /** 打印首次生成的密钥。默认 stdout（运维在终端 / 容器日志里看它） */
  print?: (line: string) => void
  /** 告警通道（权限无法施加等「不阻塞但不能静默」的情况）。默认 stderr */
  warn?: (line: string) => void
  /**
   * 调用方是否已确认「账号数据文件里带着桌面端的 `webPanelAdminKey`」。
   *
   * 由装配层传入而不是本模块自己去读数据文件：装配层为了跑
   * `preflightAccountStoreForServer` 本来就已经解出了盘上内容（那个函数返回 `decoded`），
   * 让本模块再解一遍等于把账号数据的解密密钥、四态判定重新耦合进密钥模块。
   */
  legacyDesktopKeyPresent?: boolean
  /**
   * 显式承担「这台机器上无法证明密钥文件只有服务账户可读」的风险。
   *
   * 与 `${ALLOW_UNPROTECTED_KEY_FILE_ENV}` 环境变量等价（任一为真即放行），
   * 选项形式是给装配层与测试用的，环境变量形式是给开发机用的。
   * 放行后**每次启动都会告警** —— 一个只说一次的风险提示等于没说。
   */
  allowUnprotectedKeyFile?: boolean
}

/** 密钥文件位置的**单一真源**（部署文档 / 遗失恢复步骤都引用它） */
export function adminKeyFilePath(dataDir: string): string {
  return resolve(join(dataDir, ADMIN_KEY_FILE_NAME))
}

/**
 * 预置密钥的强度判据（纯函数）。**env 与文件两条路径共用它，`set()` 也共用**。
 *
 * ## 这条判据在补一个缺口，不是在加一道门
 *
 * 自动生成路径有 256bit 熵（`auth.ts:213-215`），而预置路径此前只 trim + 判空 ——
 * 于是 `KIRO_ADMIN_KEY=x` 会被当成局域网面板的管理员凭据接受，且这件事
 * **在启动期不报错**，要等到有人把它撞开才可见。判据放在来源归一化的单一入口，
 * 就是为了让它在启动期暴露。
 *
 * 策略选择的理由见 `MIN_ADMIN_KEY_LENGTH` 的注释（为什么是长度下界而不是格式、
 * 为什么是 32、为什么不做熵评分）。
 *
 * ## 为什么 `set()` 也要过这道判据
 *
 * `set()` 若放过一个弱值并落盘，下次启动就会被上面那道文件闸门拒启 ——
 * 运维被永久锁在面板外。这不是多加一道校验，是**不造出「不可启动状态」**。
 * 生产上 `set()` 的唯一喂食者是 `PanelAuth.rotateAdminKey()`（`auth.ts:133-138`，
 * 恒用 `generateAdminKey()` 的输出），故这条判据对真实轮换零影响。
 *
 * @param key 已 trim 过的候选密钥
 */
export function classifyAdminKeyStrength(key: string): AdminKeyStrengthVerdict {
  // 判据 = 「只允许可打印 ASCII」。空白与 C0/C1 控制字符因此都被挡掉。
  //
  // 该值要进 HTTP 头、URL、输入框与编排文件；带空白的值在传输链上任何一环
  // 被截断都会变成「密钥突然不对了」，而那种故障极难归因。
  // 这不是熵判据（`'a'.repeat(32)` 照样通过），是格式风险。
  //
  // 用「白名单可打印区间」而不是「黑名单空白 + 控制字符」：后者要写
  // 控制字符区间，而那种字面量在跨 shell / 跨工具传输时会被静默改写
  // （本轮实测：写入时 `\x00-\x1f` 段被吞掉，判据静默变成只查空白）。
  if (/[^\x21-\x7e]/.test(key)) return { kind: 'bad-chars' }

  if (key.length < MIN_ADMIN_KEY_LENGTH) return { kind: 'too-short', length: key.length }

  return { kind: 'ok' }
}

/**
 * 权限判据（纯函数 · 平台可注入）。
 *
 * ## 为什么 `platform` 是参数而不是读 `process.platform`
 *
 * 本机实测(2026-08-12 · win32 · node v22.20.0)：`chmodSync(f, 0o600)` 之后
 * `statSync(f).mode & 0o777` 读回 **`0o666`**（`0o400`/`0o000` 读回 `0o444`）——
 * Windows 只映射一个只读位，POSIX 三段位在那里根本不存在。
 * 于是规则 3 若在 Windows 上按 POSIX 判据施加，**每次启动都会拒启**。
 *
 * 把判据抽成注入平台的纯函数，换来的是：两个平台分支在**任何一台机器上都被真跑到**。
 * 否则 Windows 开发机永远只走 win32 分支，而 Linux 分支 —— 唯一真正承担安全职责的那条 ——
 * 要等上线才第一次执行。
 *
 * ## 判据是「不得更宽」，不是「必须等于 0600」
 *
 * 决策卡的理由是「世界可读的凭据文件等于没有凭据」，那是一条上界。`0400`（只读）
 * 与 `0000`（连属主都不给，root 仍可读）都比 `0600` 更严，拒绝它们只会让
 * 「运维把权限收得更紧」变成故障。
 */
export function classifyKeyFilePermission(
  mode: number,
  platform: string = process.platform
): KeyFilePermissionVerdict {
  const bits = mode & 0o777

  if (platform === 'win32') {
    return {
      kind: 'unenforceable',
      mode: bits,
      warning:
        `Windows 上无法施加 POSIX 文件权限（本机实测 chmod(0600) 读回 ${bits.toString(8).padStart(3, '0')}），` +
        `密钥文件的保护完全依赖 NTFS ACL 与该目录的继承设置。` +
        `若这台机器是多用户或被共享，请手工确认只有服务账户能读取该文件。`
    }
  }

  // 组 + 其他用户的任一权限位存在即为过宽（读、写、执行都算 —— 写同样能换掉凭据）
  const offending = bits & 0o077
  if (offending !== 0) return { kind: 'too-open', mode: bits, offending }
  return { kind: 'ok', mode: bits }
}

/**
 * 服务端密钥引导。**返回即代表密钥已就绪**；任何拒启条件都在这里抛。
 *
 * 为什么引导在构造期而不在首次 `get()`：四种拒启判定（权限过宽 / env 与文件冲突 /
 * env 为空 / 文件在但读不出来）都必须在进程启动时把进程打死。放到 `get()` 里
 * 意味着它们第一次触发是在某个 HTTP 请求的处理路径上 —— 那时错误只会变成一条 500，
 * 而不是运维能看见的「服务起不来 + 原因」。
 *
 * @throws 上述四种拒启条件之一成立时抛，错误信息给出可执行补救、且**不含密钥明文**
 *   （错误会进日志 / 进 `systemctl status`）
 */
export function createServerAdminKeyStore(
  options: ServerAdminKeyStoreOptions
): ServerAdminKeyStore {
  const {
    dataDir,
    env = process.env,
    platform = process.platform,
    print = (line: string): void => console.log(line),
    warn = (line: string): void => console.error(line),
    legacyDesktopKeyPresent = false,
    allowUnprotectedKeyFile = false
  } = options

  const file = adminKeyFilePath(dataDir)
  // 环境变量与选项等价（任一为真即放行）。环境变量形式是给开发机的 ——
  // 本地跑服务端不该需要改代码；选项形式是给装配层与测试的。
  const allowUnprotected = allowUnprotectedKeyFile || isTruthy(env[ALLOW_UNPROTECTED_KEY_FILE_ENV])
  const presetRaw = env[ADMIN_KEY_ENV]
  const hasPreset = presetRaw !== undefined
  const preset = presetRaw?.trim() ?? ''

  // ① env 存在但为空 / 纯空白 → 拒启，**不**当成「未设置」静默生成。
  //    静默生成的后果：运维以为编排文件里那个（其实没渲染出值的）变量在生效，
  //    实际登录用的是一把他从没见过的钥匙，而下次他修好变量就变成冲突拒启。
  if (hasPreset && preset.length === 0) {
    // EX_USAGE：环境变量的**用法**错了（给了变量但没给值），不是数据坏也不是权限问题。
    // 与 `readServerConfig` 里缺 KIRO_DATA_DIR / 端口非法同族 —— 运维看到 64 就该去查编排文件。
    throw new ServerConfigError(
      `环境变量 ${ADMIN_KEY_ENV} 已设置但为空（或只有空白字符）：拒绝启动。\n` +
        `不把它当成「未设置」而静默生成新密钥 —— 那会让你以为预置生效了，实际用的是另一把钥匙。\n` +
        `请给它一个真实值，或彻底移除该变量（移除后首次启动会生成并打印一把新密钥）。`,
      EXIT.USAGE
    )
  }

  // ①.5 env 预置值强度不达标 → 拒启。
  //
  //     这一步补的是「自动生成 256bit，而预置只判空」这个不对称：
  //     `KIRO_ADMIN_KEY=x` 此前会被当成局域网面板的管理员凭据接受，
  //     且启动期不报错 —— 要等到有人把它撞开才可见。
  //     判据与文件路径**完全同一个函数**，见 `classifyAdminKeyStrength`。
  if (hasPreset) {
    assertAdminKeyStrength(preset, {
      // EX_USAGE：与「env 已设置但为空」同族 —— 运维要改的是编排文件里那个值。
      exitCode: EXIT.USAGE,
      describeSource: `环境变量 ${ADMIN_KEY_ENV}`,
      remedy:
        `请把它改成一个足够长的随机值（建议用密码管理器或 \`openssl rand -base64 32\` 生成），\n` +
        `或彻底移除该变量 —— 移除后首次启动会自动生成一把 256bit 随机密钥并打印出来。`
    })
  }

  // ② 读盘上的密钥文件。「在但读不出来」绝不映射成「没有」（与
  //    `persistence/accountStorePort.ts` 同一条不变量 —— 那里的 `isNotFound`
  //    白名单同样只承认 ENOENT / ENOTDIR）。
  const onDisk = readKeyFile(file)

  // ③ 文件在且能读 → 先过权限闸门，再过强度闸门。两者都放在与 env 比对**之前**：
  //    一个世界可读、或内容是 `admin` 的密钥文件都是安全问题，无论它最终是否被采用。
  if (onDisk.state === 'present') {
    enforceKeyFilePermission(onDisk.mode, platform, file, warn, allowUnprotected)
    assertAdminKeyStrength(onDisk.key, {
      // EX_DATAERR：盘上那个东西不合规，与「文件内容为空」同族 ——
      // 运维要动的是那个文件，不是编排配置。
      exitCode: EXIT.DATA_ERROR,
      describeSource: `密钥文件 ${file}`,
      remedy:
        `**不**自动覆盖它 —— 覆盖会静默换掉你可能仍在用的凭据（同「文件内容为空」那条不变量）。\n` +
        `确认无需保留后，删除该文件再重启即可重新生成并打印一把 256bit 随机密钥；\n` +
        `或把文件内容换成一个足够长的随机值。`
    })
  }

  if (hasPreset) {
    // ④ env 与文件同时存在且不一致 → 拒启并说明，**不猜优先级**（负向验收 ②）。
    //    猜任何一边都会造成「运维以为改了密钥，实际没生效」，而这种误解只会在
    //    他登不进去时才暴露 —— 那时他会怀疑服务坏了，不会怀疑有两个真源。
    if (onDisk.state === 'present' && onDisk.key !== preset) {
      // EX_CONFIG：配置自相矛盾（两个真源不一致）—— `config.ts` 的退出码表把 78 就是
      // 分配给这一条。它与「权限」「数据坏」都不同：要修的是编排配置或那个文件，二选一。
      throw new ServerConfigError(
        `adminKey 有两个不一致的来源：环境变量 ${ADMIN_KEY_ENV} 与密钥文件 ${file}。拒绝启动。\n` +
          `不猜哪个优先 —— 猜错的那一半会让你以为已经换了密钥，而实际生效的是另一把。\n` +
          `请二选一：删除该环境变量（改用文件里的密钥），或删除该文件（改用环境变量的密钥）。`,
        EXIT.CONFIG
      )
    }

    // ⑤ env 生效：不生成文件、不打印（规则 4）。
    //    不生成文件的理由不止「没必要」：写出去会凭空造出第二个真源，
    //    下次运维改了环境变量就直接撞上 ④ 的冲突拒启。
    return makeStore({
      key: preset,
      source: 'env',
      file,
      envManaged: true,
      platform,
      warn,
      allowUnprotected
    })
  }

  // ⑥ 文件已在 → 读回同一把钥匙，**不再打印**（规则 2：
  //    否则容器日志里长期留着一份有效凭据，而日志的读者面远大于运维本人）。
  if (onDisk.state === 'present') {
    return makeStore({
      key: onDisk.key,
      source: 'file',
      file,
      envManaged: false,
      platform,
      warn,
      allowUnprotected
    })
  }

  // ⑦ 首启：生成 → 落盘(0600) → 校验权限 → **打印** —— 四步同一个事务。
  //    打印是这条路径上「交付」的含义：它是运维在服务器上唯一一次看见这把钥匙的机会。
  //    所以 print 抛出（stdout 已关闭 / 容器日志驱动故障）必须回滚掉刚写的文件 ——
  //    留着它意味着下次启动按规则 2 不再打印，运维永久拿不到凭据。
  const generated = generateAdminKey()
  writeKeyFileSecurely(file, generated, platform, warn, {
    allowUnprotected,
    deliver: () => print(formatBootstrapNotice(generated, file, legacyDesktopKeyPresent))
  })

  return makeStore({
    key: generated,
    source: 'generated',
    file,
    envManaged: false,
    platform,
    warn,
    allowUnprotected
  })
}

/** 盘上密钥文件的判定结果 —— 只有「确实不存在」才是 `absent` */
type KeyFileState = { state: 'absent' } | { state: 'present'; key: string; mode: number }

/**
 * 「文件确实不存在」的 errno 白名单。**逐字沿用**
 * `persistence/accountStorePort.ts:isNotFound`（它又沿用 K-1 的 `secureBackup.ts`）——
 * 这里不新造第二套判据。只有 ENOENT / ENOTDIR 算不存在，其余都是「东西在，但读不了」。
 */
function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 读密钥文件。**「在但读不出来」≠「没有」** —— 这是与账号数据端口共享的那条不变量。
 *
 * 为什么这条在密钥上比在账号数据上更要紧：把读失败当成「没密钥」会走到生成分支，
 * 而生成分支要写这个文件。于是一次权限故障（EACCES）或一个写入残骸（零字节）
 * 会被**一次覆盖**换掉运维手上那把还在用的钥匙，且他手机上已保存的凭据同时失效。
 *
 * @throws 文件存在但不可用（零字节 / EISDIR / EACCES / EIO …）时抛，**不覆盖原文件**
 */
function readKeyFile(file: string): KeyFileState {
  let raw: string
  let mode: number
  try {
    raw = readFileSync(file, 'utf-8')
    mode = statSync(file).mode
  } catch (e) {
    if (isNotFound(e)) return { state: 'absent' }
    const code = (e as NodeJS.ErrnoException).code ?? ''
    throw new ServerConfigError(
      `adminKey 密钥文件存在但无法读取：${file}（${code}）。拒绝启动。\n` +
        `绝不把「读不出来」当成「没有密钥」而生成新的 —— 那一次写入会覆盖掉你正在用的凭据，` +
        `连手机上已保存的登录也会一起失效。\n` +
        `请检查该路径是文件而非目录、且服务账户对它有读权限。原始错误：${(e as Error).message}`,
      EXIT.CANNOT_CREATE
    )
  }

  const key = raw.trim()
  if (key.length === 0) {
    throw new ServerConfigError(
      `adminKey 密钥文件存在但内容为空（长度 0 或只有空白字符）：${file}。拒绝启动。\n` +
        `这通常是上一次写入被中断留下的残骸。不当成「没有密钥」而生成新的 —— ` +
        `覆盖它会静默换掉凭据，而它旁边可能还有一份能用的备份。\n` +
        `确认无需恢复后，删除该文件再重启即可重新生成并打印一把新密钥。`,
      EXIT.DATA_ERROR
    )
  }

  return { state: 'present', key, mode }
}

/**
 * 施加规则 3（逐字：「若无法设置该权限则拒绝启动」）。
 *
 * 三态各自的处置：
 *   - `ok` → 放行。
 *   - `too-open` → 拒启。POSIX 上组/其他用户有权限位 = 同机任何用户都能登面板。
 *   - `unenforceable` → **拒启**，除非 `allowUnprotected`。见下。
 *
 * ## 为什么 `unenforceable` 也拒启（此前是告警放行，那违反规则 3）
 *
 * 原实现的推理是「POSIX 判据在 Windows 上 100% 误报，故降级为告警」。
 * 前半句是对的（实测 `chmod(0600)` 读回 `0o666`），后半句不成立：
 * **告警建立不了任何访问控制**。若那台 Windows 主机的 dataDir 继承了宽 NTFS ACL，
 * 同机其他账户可以直接读出有效的管理员凭据，而运维只在 stderr 里看到一行字。
 * 「无法证明它受保护」与「已证明它不受保护」在安全裁决上应当同权 —— 都不放行。
 *
 * ## 为什么不去读 NTFS ACL 来真的证明它
 *
 * 纯 Node 无原生依赖时只能 shell 出 `icacls` / `Get-Acl` 并解析**本地化**输出
 * （中文系统上是「完全控制」而不是 `(F)`）。用一个会静默误判的解析器做安全裁决，
 * 比诚实地说「证明不了」更糟；且会给一个刻意零 electron / 零原生依赖的内核模块
 * 引进 `child_process`。故这里不假装能证明。
 *
 * ## 开发机怎么办：显式 opt-in，且每次启动都告警
 *
 * Windows 是本项目的主开发平台，硬拒启会挡住本地跑服务端。出路两条，都写在错误文案里：
 *   - `KIRO_ADMIN_KEY` 预置密钥 —— 该路径根本不落密钥文件，因此没有「无法证明其权限」
 *     的对象；这也是 Windows 上受支持的生产形态（Docker secrets / systemd `Environment=`）。
 *   - `KIRO_ALLOW_UNPROTECTED_KEY_FILE=1` —— 显式承担风险。放行后**每次启动都告警**，
 *     不是只在首启说一次（一个只说一次的风险提示等于没说）。
 *
 * 注意 opt-in **只覆盖 `unenforceable` 这一态**，不能放过 POSIX 上真正的 `too-open` ——
 * 那不是「证明不了」，那是「已经证明不安全」。
 */
function enforceKeyFilePermission(
  mode: number,
  platform: string,
  file: string,
  warn: (line: string) => void,
  allowUnprotected: boolean
): void {
  const verdict = classifyKeyFilePermission(mode, platform)
  if (verdict.kind === 'ok') return

  if (verdict.kind === 'unenforceable') {
    if (allowUnprotected) {
      // 放行了，但每次启动都要再说一次 —— 这是运维显式接受的风险，不是背景噪音。
      warn(
        `[adminKey] ⚠️ 已按 ${ALLOW_UNPROTECTED_KEY_FILE_ENV} 放行：${verdict.warning}` +
          `（文件：${file}）\n` +
          `[adminKey]    这台机器上**无法证明**该密钥文件只有服务账户可读。` +
          `生产环境请改用 ${ADMIN_KEY_ENV} 预置密钥（该方式不落密钥文件）。`
      )
      return
    }

    throw new ServerConfigError(
      `无法证明 adminKey 密钥文件只有服务账户可读：${file}。拒绝启动。\n` +
        `${verdict.warning}\n` +
        `决策卡规则 3 是「若无法设置 0600 则拒绝启动」—— 告警建立不了访问控制，` +
        `故这里不降级为告警：若该目录继承了宽 NTFS ACL，同机其他账户可直接读出有效的管理员凭据。\n` +
        `两条出路：\n` +
        `  1. 用环境变量 ${ADMIN_KEY_ENV} 预置密钥（推荐 · 该方式根本不落密钥文件，` +
        `适配 Docker secrets / systemd Environment=）；\n` +
        `  2. 开发机上显式承担风险：设置 ${ALLOW_UNPROTECTED_KEY_FILE_ENV}=1` +
        `（每次启动都会告警）。`,
      EXIT.CANNOT_CREATE
    )
  }

  throw new ServerConfigError(
    `adminKey 密钥文件权限过宽：${file} 当前为 ${verdict.mode.toString(8).padStart(4, '0')}，` +
      `属主之外仍有权限位（${verdict.offending.toString(8).padStart(3, '0')}）。拒绝启动。\n` +
      `世界可读的凭据文件等于没有凭据 —— 同机上任何其他用户都能直接登录面板。\n` +
      `补救：chmod 600 ${file}（必要时先 chown 到运行服务的用户）。`,
    EXIT.CANNOT_CREATE
  )
}

/**
 * 写密钥文件的**事务**：目标快照 → 临时文件 → 设权限 → **提交前校验权限** →
 * rename 提交 → 回读复校 → **交付** → 任一步失败则把目标恢复到快照。
 *
 * ## 不变量
 *
 * **在密钥「既通过权限验证、又已交付给需要它的人」之前，绝不让它成为盘上生效的那一把。**
 * 「交付」在两条路径上不是一回事：首启生成 = 已打印出来（`deliver` 即 print），
 * 轮换 = 已回到调用方手里（`set()` 正常返回）。两者共用同一个事务边界。
 *
 * ## 为什么必须是事务（此前不是，代价是两种锁死）
 *
 * `renameSync` **就是提交点**。原实现把权限复检与打印都放在它之后，于是：
 *   - 轮换时复检抛错 → 盘上已是新密钥、内存仍是旧密钥、新密钥从未返回给调用方。
 *     重启后服务用新的，而运维手上只有旧的 —— 面板是服务器上唯一的管理入口。
 *     （原 `rollbackOnPermissionFailure:false` 的注释说「盘上仍是旧密钥」，
 *     那个推理假定 rename 尚未发生；它已经发生了。）
 *   - 首启时 `print` 抛错（stdout 已关闭 / 容器日志驱动故障）→ 文件留在盘上，
 *     下次启动按规则 2 不再打印 → 运维永久拿不到凭据，也没有让它再出现的手段。
 *
 * ## 快照替代了 `rollbackOnPermissionFailure` 这个标志
 *
 * 不需要第三种模式：回滚动作从「目标原本是什么」自然得出 ——
 * 生成路径快照为「不存在」→ 回滚 = 删除；轮换路径快照为旧密钥 → 回滚 = 原子写回旧字节。
 * 后者正是原来那个 `false` 分支**想要**却没做到的效果。
 *
 * ## 权限闸门为什么前移到 rename 之前（并且没有削弱）
 *
 * 本机实测(2026-08-12 · win32 · node v22.20.0)：mode 跨 `renameSync` 不变（`0666 → 0666`），
 * 且 temp 与目标同目录、同文件系统、同 ACL 继承 —— 对 temp 的回读校验与对目标的校验等价。
 * 于是最常见的失败因（该文件系统上 chmod 无声失效）现在**根本不会触碰目标文件**。
 * 判据 `classifyKeyFilePermission` 逐字未改，检查次数从 1 次变成 2 次（提交前 + 提交后复校）。
 *
 * ## rename 与复检之间崩溃：不可回滚，只能声明
 *
 * 进程已死，没有代码能执行回滚。留下的状态是「盘上新密钥 / 从未交付」。
 * 可恢复，但只有一条路：停服 → 删除该文件 → 重启（重新生成并打印）——
 * 这需要对该文件的**文件系统访问权**，只能从面板进来的运维未必具备。
 * 前移权限闸门就是为了把这个窗口压到最窄：仅剩「rename 成功、紧接着 stat 也失败」这一极窄区间。
 *
 * @throws 权限无法设置到位（POSIX 上）/ 写盘失败 / `deliver` 抛出时抛。
 *   目标文件此时**已恢复到调用前的状态**（原本不存在则删除，原本有旧密钥则写回旧密钥）。
 */
function writeKeyFileSecurely(
  file: string,
  key: string,
  platform: string,
  warn: (line: string) => void,
  opts: { deliver?: () => void; allowUnprotected: boolean }
): void {
  mkdirSync(join(file, '..'), { recursive: true })

  // ① 目标快照。「在但读不出来」时**不开始事务** —— 无法保证能恢复的东西就不该被覆盖
  //    （与 `readKeyFile` 同一条不变量：读失败绝不当成「没有」）。
  const snapshot = snapshotForRollback(file)

  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${key}\n`, { encoding: 'utf-8', mode: KEY_FILE_MODE })
    chmodSync(temp, KEY_FILE_MODE)
    // ② 提交前就把规则 3 施加在 temp 上：它与目标同目录同文件系统，实测 mode 跨 rename 不变。
    //    失败在这里 = 目标文件从未被碰过，无需回滚。
    enforceKeyFilePermission(statSync(temp).mode, platform, file, warn, opts.allowUnprotected)
  } catch (e) {
    // 临时文件不留在盘上（它含明文密钥，且 `.tmp` 不会被任何闸门看管）
    discardTemp(temp)
    if (e instanceof ServerConfigError) throw e
    throw new ServerConfigError(
      `无法写入 adminKey 密钥文件：${file}（${(e as NodeJS.ErrnoException).code ?? ''}）。拒绝启动。\n` +
        `密钥必须能持久化，否则每次重启都会换一把 —— 面板上的登录会随机失效。\n` +
        `请确认该目录存在且服务账户可写。原始错误：${(e as Error).message}`,
      EXIT.CANNOT_CREATE
    )
  }

  try {
    renameSync(temp, file)
  } catch (e) {
    discardTemp(temp)
    throw new ServerConfigError(
      `无法写入 adminKey 密钥文件：${file}（${(e as NodeJS.ErrnoException).code ?? ''}）。拒绝启动。\n` +
        `密钥必须能持久化，否则每次重启都会换一把 —— 面板上的登录会随机失效。\n` +
        `请确认该目录存在且服务账户可写。原始错误：${(e as Error).message}`,
      EXIT.CANNOT_CREATE
    )
  }

  // ③ 提交后复校（决策卡规则 3 的后半句）：temp 上的判定不能替代对**目标路径本身**的回读 ——
  //    rename 若在某些文件系统上重置了权限位，只有查目标才看得见。
  try {
    enforceKeyFilePermission(statSync(file).mode, platform, file, warn, opts.allowUnprotected)
    // ④ 交付。抛出即视为「凭据没到手」，与权限失败同等对待 —— 都要回滚，
    //    因为留下一把从未交付的密钥就是那两种锁死本身。
    opts.deliver?.()
  } catch (e) {
    restoreSnapshot(file, snapshot, warn)
    throw e
  }
}

/** 事务开始时目标路径的状态 —— 回滚要恢复的正是**盘上真实存在过的东西** */
type KeyFileSnapshot = { existed: false } | { existed: true; bytes: string }

/**
 * 为回滚快照目标文件。
 *
 * 为什么读盘而不用内存里的 `current`：回滚要恢复的是盘上真实存在过的字节
 * （它可能被外部改动过），内存值只是它的一份副本。
 *
 * 秘密暴露面：轮换路径的旧密钥本来就常驻内存（`makeStore` 的 `current`），
 * 事务期间多持有一份等长字符串不新增任何暴露面；生成路径没有旧值可持有。
 *
 * @throws 文件存在但读不出来时抛 —— 此时**不开始事务**，因为无法保证覆盖后能恢复。
 */
function snapshotForRollback(file: string): KeyFileSnapshot {
  try {
    return { existed: true, bytes: readFileSync(file, 'utf-8') }
  } catch (e) {
    if (isNotFound(e)) return { existed: false }
    throw new ServerConfigError(
      `无法写入 adminKey 密钥文件：${file}（${(e as NodeJS.ErrnoException).code ?? ''}）。拒绝启动。\n` +
        `写入前必须能读出当前内容 —— 否则一旦新密钥写到一半失败，就再也没法把你正在用的那把恢复回来。\n` +
        `请确认该路径是文件而非目录、且服务账户对它可读可写。原始错误：${(e as Error).message}`,
      EXIT.CANNOT_CREATE
    )
  }
}

/**
 * 把目标恢复到事务开始前的状态。
 *
 * 恢复走「临时文件 + rename」而不是直接覆写：回滚本身也不能留下半截文件，
 * 否则一次失败的轮换会把仍在生效的旧密钥换成一把谁也登不进去的钥匙。
 *
 * **回滚自身失败不吞掉、也不掩盖原始错误**：原始错误里才有可执行的补救步骤（chmod / 权限），
 * 所以它继续上浮；而「盘上现在是一把从未交付的新密钥」这件事只有这里知道，
 * 必须走 `warn` 说出来 —— 它是运维唯一能据以自救的信息（删文件 → 重启 → 重新生成并打印）。
 */
function restoreSnapshot(
  file: string,
  snapshot: KeyFileSnapshot,
  warn: (line: string) => void
): void {
  try {
    if (!snapshot.existed) {
      unlinkSync(file)
      return
    }
    const temp = `${file}.${randomUUID()}.rollback`
    try {
      writeFileSync(temp, snapshot.bytes, { encoding: 'utf-8', mode: KEY_FILE_MODE })
      chmodSync(temp, KEY_FILE_MODE)
      renameSync(temp, file)
    } catch (e) {
      discardTemp(temp)
      throw e
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    warn(
      `[adminKey] 写入失败后回滚也失败了：${file}（${code}）。\n` +
        `  盘上现在是一把**从未交付给任何人**的新密钥 —— 服务重启后会采用它，而你手上没有它。\n` +
        `  自救：停止服务 → 删除 ${file} → 重启（会重新生成并打印一把新密钥）。\n` +
        `  回滚失败原因：${(e as Error).message}`
    )
  }
}

/**
 * 把强度判定翻译成运维能照着做的一句话。**绝不包含密钥明文** ——
 * 这段文字会进 stderr / journal / `systemctl status`。
 *
 * 长度是可以说的：知道「你给的值只有 1 个字符」不构成对密钥的泄漏
 * （运维本来就知道自己配了什么），而不说长度他就无从判断该改多长。
 */
function describeStrengthVerdict(verdict: AdminKeyStrengthVerdict): string {
  if (verdict.kind === 'too-short') {
    return `长度只有 ${verdict.length} 个字符，至少需要 ${MIN_ADMIN_KEY_LENGTH} 个。`
  }
  if (verdict.kind === 'bad-chars') {
    return (
      `含空白或控制字符，只允许可打印 ASCII。` +
      `（该值要经 HTTP 头 / URL / 编排文件传输，带空白会在某一环被截断，` +
      `表现为「密钥突然不对了」而极难归因。）`
    )
  }
  return ''
}

/**
 * 强度闸门：不达标即拒启。**env 与文件两条路径共用**（这是 P1-5 的「单一入口」）。
 *
 * 退出码由调用方给，因为「该去改哪里」两条路径不同：env 弱值要改编排配置（64 EX_USAGE），
 * 文件弱值要动那个文件（65 EX_DATAERR）。运维读退出码就该知道去哪。
 *
 * @throws `ServerConfigError` 当强度不达标
 */
function assertAdminKeyStrength(
  key: string,
  ctx: { exitCode: number; describeSource: string; remedy: string }
): void {
  const verdict = classifyAdminKeyStrength(key)
  if (verdict.kind === 'ok') return

  throw new ServerConfigError(
    `${ctx.describeSource} 里的 adminKey 不符合强度要求：${describeStrengthVerdict(verdict)}拒绝启动。\n` +
      `面板是服务器上唯一的管理入口，弱密钥等于把它交给任何能访问该端口的人 —— ` +
      `自动生成的密钥是 256bit 随机值，预置值不该比它弱得多。\n` +
      `${ctx.remedy}`,
    ctx.exitCode
  )
}

/**
 * 布尔型环境变量：只认明确的真值，其余（含未设置）为假。
 *
 * 判据与 `config.ts:isTruthyFlag` 逐字一致 —— 那个是模块私有函数，
 * 不导出；这里镜像一份而不是把它导出，理由是本模块刻意不依赖 `config.ts` 的
 * 内部实现细节（只用它的 `EXIT` 与 `ServerConfigError`）。
 * 两处都只有四个字面量，漂移的代价是一个环境变量不生效而非静默错误。
 */
function isTruthy(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 丢弃临时文件。它本来就可能没建出来 —— 那种情况下原始错误更重要 */
function discardTemp(temp: string): void {
  try {
    unlinkSync(temp)
  } catch {
    // 没建出来 / 已被 rename 掉 —— 无需处理
  }
}


/**
 * 首启打印文案。密钥必须**逐字出现**在里面（负向验收 ③：没出现就是部署即失败）。
 *
 * ## 为什么保留 stdout 交付，但改掉文案
 *
 * 决策卡明文裁决「生成并打印到标准输出一次」，理由是无头机器上那是运维**唯一**
 * 能看见它的地方。换成需要第二通道（邮件 / 密钥管理服务 / 交互式确认）的方案，
 * 在一台只有 SSH 的服务器上比现状更糟 —— 运维根本拿不到凭据，服务等于没部署成。
 * 故机制不动。
 *
 * 真正要修的是**旧文案在声称一个它并没有实现的威胁模型**：
 * 「之后启动不再打印它 —— 否则容器日志里会长期留着一份有效凭据」——
 * 这句话把「以后不打印」说成了「日志里没有凭据」的保证，而第一次打印早已在
 * journal / 容器日志 / 终端回滚缓冲 / 日志收集器及其备份里留下了持久副本，
 * 且能读日志的人（支持人员、日志系统服务账号）远多于该管面板的人。
 * 「声称已做而实际没做，比漏做更糟」——决策卡自己的话。
 *
 * 所以文案改成三件事：说清这份副本已经存在、给一个真实可用的补救（轮换 ——
 * `rotateAdminKey()` 不打印，故轮换后的新钥匙从未碰过日志）、给一条彻底不经
 * 日志的路（`KIRO_ADMIN_KEY` 预置，该路径既不生成也不打印）。
 */
function formatBootstrapNotice(key: string, file: string, legacyDesktopKeyPresent: boolean): string {
  const lines = [
    '',
    '='.repeat(72),
    '  Web 面板管理员密钥已生成（本次是唯一一次打印，请立刻保存）',
    '='.repeat(72),
    `  adminKey: ${key}`,
    `  密钥文件: ${file}`,
    '',
    '  ⚠ 这把密钥现在已经在本机的标准输出里，也就是说：systemd journal、',
    '    docker logs、终端回滚缓冲、以及任何日志收集器和它的备份里，都有一份副本。',
    '    凡能读这些日志的人（支持人员、日志系统的服务账号）都能看到它 ——',
    '    这个范围通常远大于「应该能管理面板的人」。之后启动不再打印，',
    '    但那**不会**移除已经留下的这份副本。',
    '',
    '  ✅ 建议动作：用它登录面板后**立刻在面板内轮换一次**。轮换出的新密钥只在',
    '    面板里显示、不写任何日志，于是生效的那把钥匙从此没有出现在日志中。',
    `  · 想彻底不经日志交付：改用环境变量 ${ADMIN_KEY_ENV} 预置密钥`,
    '    （适配 Docker secrets / systemd Environment= · 该方式既不生成也不打印）。',
    `  · 遗失恢复：停止服务 → 删除 ${file} → 重启（会重新生成并打印）。`,
    '  · 经公网访问面板时必须前置 TLS —— 明文 HTTP 上传输该密钥等于公开它。'
  ]

  if (legacyDesktopKeyPresent) {
    // 运维最可能的困惑：「我把数据文件拷过来了，为什么桌面上那个密钥登不进去」
    lines.push(
      '',
      '  ⚠ 拷入的账号数据文件里带着**桌面端**的面板密钥，服务端**不使用**它。',
      '    桌面那把钥匙曾在设置页展示、并随数据文件跨机搬运，暴露史未知；',
      '    静默继承会让你得不到任何信号。请改用上面这把新密钥登录。'
    )
  }

  lines.push('='.repeat(72), '')
  return lines.join('\n')
}

/**
 * 组装出满足 `AdminKeyStore` 端口的对象。
 *
 * `get()` 返回内存里的值而不是每次回读文件：引导已经在构造期完成，且面板会**频繁**调用
 * 它（`server.start` 的红线判据 / `hasAdminKey` / 每次 `login`）。每次都读盘只会
 * 把一个热路径变成 IO，还让「文件在启动后被外部改动」这种半吊子热重载变成隐式行为。
 */
function makeStore(args: {
  key: string
  source: AdminKeySource
  file: string
  envManaged: boolean
  platform: string
  warn: (line: string) => void
  allowUnprotected: boolean
}): ServerAdminKeyStore {
  let current = args.key

  return {
    source: args.source,
    file: args.file,
    get: () => current,
    /**
     * 轮换落盘（供面板的 `rotateAdminKey()` 复用同一端口）。**不打印新密钥** ——
     * 轮换的发起者是已登录的运维，他在面板上就看到了新值；打印只会把凭据抄进容器日志。
     */
    set: (next: string) => {
      if (args.envManaged) {
        // 写文件会造出「env 与文件都在且不一致」的形态 —— 下次启动必然拒启。
        // 与其留一个下次启动才爆的雷，不如现在就把这条路堵死并说清楚该改哪里。
        throw new Error(
          `adminKey 由环境变量 ${ADMIN_KEY_ENV} 预置，拒绝在运行时轮换。\n` +
            `此时写入密钥文件会造出「环境变量与文件不一致」的状态，下次启动将直接拒启。\n` +
            `请改在编排配置里更新 ${ADMIN_KEY_ENV} 的值后重启服务。`
        )
      }
      // 轮换值也过强度判据 —— 与 env / 文件两条路径**同一个函数**。
      //
      // 不是多加一道校验：放过一个弱值并落盘，下次启动就会被文件强度闸门拒启，
      // 运维被永久锁在面板外。生产上唯一的喂食者是 `PanelAuth.rotateAdminKey()`
      // （恒用 `generateAdminKey()` 的输出），故这条对真实轮换零影响。
      //
      // 抛裸 `Error` 而非 `ServerConfigError`：这是**运行时**轮换失败，不是启动期
      // 拒启，没有退出码可言（同上面 envManaged 那条）。
      const verdict = classifyAdminKeyStrength(next.trim())
      if (verdict.kind !== 'ok') {
        throw new Error(
          `拒绝把不合规的值写入 adminKey：${describeStrengthVerdict(verdict)}\n` +
            `盘上仍是当前生效的那把密钥，未被改动。\n` +
            `轮换请走面板的 rotateAdminKey()（它用 256bit CSPRNG 生成新密钥）。`
        )
      }

      // 事务化的写：失败时目标文件被恢复成旧密钥（`writeKeyFileSecurely` 的快照回滚）。
      // 此处**不传 `deliver`** —— 轮换路径上「交付」的含义是「`set()` 正常返回、
      // 新密钥回到调用方手里」，而那正是下一行之后的事；轮换不打印（发起者是已登录的运维，
      // 他在面板上就看到了新值，打印只会把凭据抄进容器日志）。
      writeKeyFileSecurely(args.file, next, args.platform, args.warn, {
        allowUnprotected: args.allowUnprotected
      })
      current = next
    }
  }
}
