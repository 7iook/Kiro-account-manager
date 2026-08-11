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
 * ## 「引导」发生在构造期，不在首次 `get()`
 *
 * 桌面是惰性的（设置页第一次问才生成），服务端刻意不是：拒绝启动的四种判定
 * （权限过宽 / 环境变量与文件冲突 / 环境变量为空 / 文件在但读不出来）必须在**进程启动时**
 * 就把进程打死，而不是等某个 HTTP 请求触发 `get()` 时才在请求路径里抛。
 * 于是 `createServerAdminKeyStore()` 返回时，要么密钥已就绪、要么已经抛了。
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
}

/** 密钥文件位置的**单一真源**（部署文档 / 遗失恢复步骤都引用它） */
export function adminKeyFilePath(dataDir: string): string {
  return resolve(join(dataDir, ADMIN_KEY_FILE_NAME))
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
    legacyDesktopKeyPresent = false
  } = options

  const file = adminKeyFilePath(dataDir)
  const presetRaw = env[ADMIN_KEY_ENV]
  const hasPreset = presetRaw !== undefined
  const preset = presetRaw?.trim() ?? ''

  // ① env 存在但为空 / 纯空白 → 拒启，**不**当成「未设置」静默生成。
  //    静默生成的后果：运维以为编排文件里那个（其实没渲染出值的）变量在生效，
  //    实际登录用的是一把他从没见过的钥匙，而下次他修好变量就变成冲突拒启。
  if (hasPreset && preset.length === 0) {
    throw new Error(
      `环境变量 ${ADMIN_KEY_ENV} 已设置但为空（或只有空白字符）：拒绝启动。\n` +
        `不把它当成「未设置」而静默生成新密钥 —— 那会让你以为预置生效了，实际用的是另一把钥匙。\n` +
        `请给它一个真实值，或彻底移除该变量（移除后首次启动会生成并打印一把新密钥）。`
    )
  }

  // ② 读盘上的密钥文件。「在但读不出来」绝不映射成「没有」（与
  //    `persistence/accountStorePort.ts` 同一条不变量 —— 那里的 `isNotFound`
  //    白名单同样只承认 ENOENT / ENOTDIR）。
  const onDisk = readKeyFile(file)

  // ③ 文件在且能读 → 先过权限闸门。放在与 env 比对**之前**：
  //    一个世界可读的密钥文件是安全问题，无论它最终是否被采用。
  if (onDisk.state === 'present') {
    enforceKeyFilePermission(onDisk.mode, platform, file, warn)
  }

  if (hasPreset) {
    // ④ env 与文件同时存在且不一致 → 拒启并说明，**不猜优先级**（负向验收 ②）。
    //    猜任何一边都会造成「运维以为改了密钥，实际没生效」，而这种误解只会在
    //    他登不进去时才暴露 —— 那时他会怀疑服务坏了，不会怀疑有两个真源。
    if (onDisk.state === 'present' && onDisk.key !== preset) {
      throw new Error(
        `adminKey 有两个不一致的来源：环境变量 ${ADMIN_KEY_ENV} 与密钥文件 ${file}。拒绝启动。\n` +
          `不猜哪个优先 —— 猜错的那一半会让你以为已经换了密钥，而实际生效的是另一把。\n` +
          `请二选一：删除该环境变量（改用文件里的密钥），或删除该文件（改用环境变量的密钥）。`
      )
    }

    // ⑤ env 生效：不生成文件、不打印（规则 4）。
    //    不生成文件的理由不止「没必要」：写出去会凭空造出第二个真源，
    //    下次运维改了环境变量就直接撞上 ④ 的冲突拒启。
    return makeStore({ key: preset, source: 'env', file, envManaged: true, platform, warn })
  }

  // ⑥ 文件已在 → 读回同一把钥匙，**不再打印**（规则 2：
  //    否则容器日志里长期留着一份有效凭据，而日志的读者面远大于运维本人）。
  if (onDisk.state === 'present') {
    return makeStore({ key: onDisk.key, source: 'file', file, envManaged: false, platform, warn })
  }

  // ⑦ 首启：生成 → 落盘（0600）→ **校验自己刚写的权限** → 打印一次。
  const generated = generateAdminKey()
  writeKeyFileSecurely(file, generated, platform, warn, { rollbackOnPermissionFailure: true })

  print(formatBootstrapNotice(generated, file, legacyDesktopKeyPresent))

  return makeStore({ key: generated, source: 'generated', file, envManaged: false, platform, warn })
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
    throw new Error(
      `adminKey 密钥文件存在但无法读取：${file}（${code}）。拒绝启动。\n` +
        `绝不把「读不出来」当成「没有密钥」而生成新的 —— 那一次写入会覆盖掉你正在用的凭据，` +
        `连手机上已保存的登录也会一起失效。\n` +
        `请检查该路径是文件而非目录、且服务账户对它有读权限。原始错误：${(e as Error).message}`
    )
  }

  const key = raw.trim()
  if (key.length === 0) {
    throw new Error(
      `adminKey 密钥文件存在但内容为空（长度 0 或只有空白字符）：${file}。拒绝启动。\n` +
        `这通常是上一次写入被中断留下的残骸。不当成「没有密钥」而生成新的 —— ` +
        `覆盖它会静默换掉凭据，而它旁边可能还有一份能用的备份。\n` +
        `确认无需恢复后，删除该文件再重启即可重新生成并打印一把新密钥。`
    )
  }

  return { state: 'present', key, mode }
}

/**
 * 施加规则 3。POSIX 上过宽即拒启；Windows 上告警但放行。
 *
 * Windows 不拒启不是放松要求，而是那条要求在那里**无从表达**：本机实测
 * `chmod(0600)` 读回 `0o666`，按 POSIX 判据会导致每次启动都拒启 ——
 * 一个 100% 误报的闸门等于没有闸门，且会逼下一个人去把它注释掉。
 * 换成告警，保住「不静默跳过」这一半。
 */
function enforceKeyFilePermission(
  mode: number,
  platform: string,
  file: string,
  warn: (line: string) => void
): void {
  const verdict = classifyKeyFilePermission(mode, platform)
  if (verdict.kind === 'ok') return

  if (verdict.kind === 'unenforceable') {
    warn(`[adminKey] ${verdict.warning}（文件：${file}）`)
    return
  }

  throw new Error(
    `adminKey 密钥文件权限过宽：${file} 当前为 ${verdict.mode.toString(8).padStart(4, '0')}，` +
      `属主之外仍有权限位（${verdict.offending.toString(8).padStart(3, '0')}）。拒绝启动。\n` +
      `世界可读的凭据文件等于没有凭据 —— 同机上任何其他用户都能直接登录面板。\n` +
      `补救：chmod 600 ${file}（必要时先 chown 到运行服务的用户）。`
  )
}

/**
 * 写密钥文件：临时文件 → 设权限 → rename 就位 → **回读校验权限**。
 *
 * 三个细节都是必需的：
 *   - **临时文件 + rename**：直接写目标文件时，进程在 write 中途死掉会留下一个
 *     半截密钥，而它长度非零、能通过读闸门 —— 变成一把谁也登不进去的钥匙。
 *   - **权限在 rename 前设**：先就位再 chmod 会留下一个「已可读但还是默认权限」的窗口。
 *   - **写完回读校验**（决策卡规则 3 的后半句）：不校验的话，`chmod` 在那些
 *     无声失败的文件系统上（Windows、部分网络挂载、某些容器卷）就形同虚设 ——
 *     规则会「看起来实施了」，而这正是比漏做更糟的那一类。
 *
 * @throws 权限无法设置到位（POSIX 上）时抛；此时按 `rollbackOnPermissionFailure`
 *   删掉刚写出的文件，避免留下一把**从未被打印过**的密钥（下次启动会读到它、
 *   不再打印，运维便永久无法登录）。
 */
function writeKeyFileSecurely(
  file: string,
  key: string,
  platform: string,
  warn: (line: string) => void,
  opts: { rollbackOnPermissionFailure: boolean }
): void {
  mkdirSync(join(file, '..'), { recursive: true })

  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${key}\n`, { encoding: 'utf-8', mode: KEY_FILE_MODE })
    chmodSync(temp, KEY_FILE_MODE)
    renameSync(temp, file)
  } catch (e) {
    // 临时文件不留在盘上（它含明文密钥，且 `.tmp` 不会被任何闸门看管）
    try {
      unlinkSync(temp)
    } catch {
      // 它本来就没建出来 —— 无需处理，原始错误更重要
    }
    throw new Error(
      `无法写入 adminKey 密钥文件：${file}（${(e as NodeJS.ErrnoException).code ?? ''}）。拒绝启动。\n` +
        `密钥必须能持久化，否则每次重启都会换一把 —— 面板上的登录会随机失效。\n` +
        `请确认该目录存在且服务账户可写。原始错误：${(e as Error).message}`
    )
  }

  try {
    enforceKeyFilePermission(statSync(file).mode, platform, file, warn)
  } catch (e) {
    if (opts.rollbackOnPermissionFailure) {
      // 留着它的后果是**永久锁死**：下次启动读到这把钥匙、按规则 2 不再打印，
      // 而它从未出现在任何输出里 —— 运维手上没有、也没法再让它被打印出来。
      try {
        unlinkSync(file)
      } catch {
        // 删不掉就让原始的权限错误上浮 —— 那条信息里已经有 chmod 补救步骤
      }
    }
    throw e
  }
}

/** 首启打印文案。密钥必须**逐字出现**在里面（负向验收 ③：没出现就是部署即失败） */
function formatBootstrapNotice(key: string, file: string, legacyDesktopKeyPresent: boolean): string {
  const lines = [
    '',
    '='.repeat(72),
    '  Web 面板管理员密钥已生成（本次是唯一一次打印，请立刻保存）',
    '='.repeat(72),
    `  adminKey: ${key}`,
    `  密钥文件: ${file}`,
    '',
    '  · 之后启动不再打印它 —— 否则容器日志里会长期留着一份有效凭据。',
    `  · 遗失恢复：停止服务 → 删除 ${file} → 重启（会重新生成并打印）。`,
    `  · 预置密钥：设置环境变量 ${ADMIN_KEY_ENV}（此时不生成也不打印）。`,
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
      writeKeyFileSecurely(args.file, next, args.platform, args.warn, {
        // 轮换失败时**不删**文件：盘上那把是仍在生效的旧密钥，删了运维就彻底进不来了。
        // 抛错让调用方看见轮换没成功，旧密钥继续可用 —— 这是此处唯一安全的失败姿态。
        rollbackOnPermissionFailure: false
      })
      current = next
    }
  }
}
