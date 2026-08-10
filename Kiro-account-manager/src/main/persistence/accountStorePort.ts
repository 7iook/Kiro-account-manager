/**
 * 账号数据的**持久化端口**（共享内核 · 零 electron 依赖）。
 *
 * 内核此前已经在用注入的 store 引用干活（`accountService/state.ts:setStoreRef`），
 * 所以 K-3 不是「把内核解耦出来」——那一步前人已做完。K-3 要补的是另外两个缺口：
 *
 *   ① **端口类型没有 SSOT**：同一个 `{ get, set, path }` 形状被手抄了三遍
 *      （`accountService/state.ts:StoreRef` / `accountService/types.ts:AccountStoreRef` /
 *      `ipc/webPanelWiring.ts:WebPanelStoreRef`），三处注释都写着「与 index.ts 的声明一致」
 *      —— 靠注释同步的副本，正是 §4.3 要消灭的形态。本文件是那个真源。
 *   ② **失败四态无人实施**：决策卡 `decision-card.md:103-106` 定了四种数据故障的行为，
 *      但今天桌面端一条都没有强制（详见下面「与桌面现状的差异」）。
 *
 * ## 四态的适用范围：三条桌面 + 服务端，一条只服务端
 *
 * 那四条位于决策卡的**服务器迁移**章节（周围不变量 I1a/I1b/I1c 通篇在讲把数据文件
 * 拷到服务器，用户可见判据是「起服务端，面板上看到与本地桌面相同的账号」），
 * 即它们本是**服务端启动语义**。逐条看哪些也该管桌面：
 *
 *   ①②③（不存在 / 解不开 / 版本过新）→ **两边都要**。它们描述的是数据文件本身的
 *      状态，与跑在哪儿无关；②尤其有桌面价值（实测密钥不符时 `conf` 抛
 *      `SyntaxError: Unexpected token 'd'`，指不到真实原因）。
 *   ④（无写权限）→ **只服务端**。服务器上真实存在（挂载权限 / 容器卷 / 服务用户不拥有
 *      拷进来的文件），桌面上是「装了应用、它写自己的 `%APPDATA%`」，那个处境几乎不存在。
 *      加到桌面启动路径 = 用「多一条桌面拒绝启动的路」换「守一件桌面不会发生的事」。
 *
 * 落到函数上：`preflightAccountStore` = ①②③（两边共用），
 * `preflightAccountStoreForServer` = 它 + `assertAccountStoreWritable`（仅服务端）。
 *
 * ## 为什么端口只有 `get / set / path` 三个成员
 *
 * 实测(2026-08-10)全仓对 store 的消费面：`git grep` 出 66 处 `store.get/set`，
 * 外加 **两处** `path.dirname(store.path)`（`index.ts:1999` 读备份目录 / `:2436` 写备份目录），
 * 且 `onDidChange` / `has` / `delete` / `clear` / `size` / `store` getter / `openInEditor`
 * / 迁移(`migrations`) / schema 校验 **全仓零消费**。
 * 所以端口就是这三个 —— 把 conf 的完整能力面抄进端口只会让服务端实现背上没人要的契约。
 *
 * `delete` 不在端口面上，但**装配层**要用：`adaptRawStoreToPort` 需要底层实例的
 * `delete` 来把 `set(key, undefined)` 翻译成真正的清除（见该函数注释）。
 * 它是适配器的入参要求，不是端口对调用方的承诺 —— 调用方仍然只用 `get/set/path`。
 *
 * 注意 `path` 的**语义**：两个消费点都只取它的 `dirname`，即「数据目录」。
 * 端口仍然暴露文件路径而不是目录，是为了不改这两个调用点（它们同时也是
 * 「备份与主数据同目录」这条既有约定的载体）。
 *
 * ## 为什么服务端实现能与桌面共用同一个 `conf`
 *
 * 读过 `node_modules/electron-store/index.js`（v11.0.2，83 行）后确认：它是 `conf` 的
 * **薄壳**，`extends Conf` 且只做三件事 —— 从 `app.getPath('userData')` 取 `cwd`、
 * 从 `app.getVersion()` 取 `projectVersion`、把 `name` 改名成 `configName`。
 * 加解密、序列化、原子写、路径拼装**全在 `conf` 里**，而 `conf@15.0.2` 自身
 * `import` 零 electron（已核实其 `dist/source/index.js`）。
 *
 * 这一点是承重的：ADR-0002 Decision 3 定的迁移工件是**原始 `kiro-accounts.json` 直拷**
 * （决策卡 DC:244 / DC:538：「本轮唯一正式支持的迁移工件」）。一个自己写文件格式的
 * 服务端实现，会在用户拷完文件、启动服务端、看到空账号库的那一刻才暴露 —— 而复用
 * `conf` 让「字节级兼容」变成**结构性成立**，而不是靠一组我自己写的编解码测试去维持。
 * 故服务端实现（`accountStore.conf.ts`）直接用 `conf` + 显式 `cwd`，不自造格式。
 *
 * ## 加密密钥为什么保持硬编码、且必须**原样不动**
 *
 * ADR-0002 Consequences 已裁决：「主数据加密是混淆不是安全」，服务器上真正的保护层是
 * 文件系统权限。这里把它提成常量**不是**为了将来改成真密钥 —— 恰恰相反：
 * 改动这个值会让用户现有的 `kiro-accounts.json` **再也读不开**（`conf` 的解密失败
 * 会退化成把密文当明文 `JSON.parse`，抛 SyntaxError）。提成常量是为了让
 * 「桌面与服务端必须用同一个值」这件事有一个可被测试引用的单点，而不是散落两处字面量。
 */
import { readFileSync, statSync, accessSync, constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pbkdf2Sync, createDecipheriv } from 'node:crypto'

/**
 * 主数据文件名（不含扩展名）。与桌面 `new Store({ name: 'kiro-accounts' })` 一致；
 * `conf` 会拼成 `<cwd>/kiro-accounts.json`。
 */
export const ACCOUNT_STORE_NAME = 'kiro-accounts'

/**
 * 混淆密钥。**禁止改动**：改了等于让所有既有用户数据读不开（见文件头）。
 * 与 `src/main/index.ts:initStore` 的字面量必须一致 —— 那一处已改为引用本常量。
 */
export const ACCOUNT_STORE_ENCRYPTION_KEY = 'kiro-account-manager-secret-key'

/**
 * 本程序能理解的数据格式版本。
 *
 * ⚠️ 现存所有真实数据**都没有这个字段**（已核实本机 `kiro-accounts.json` 的 16 个顶层键：
 * accountData / accountDataMigration / kproxyConfig / proactiveRenewalEnabled / proxyConfig /
 * proxy* 计数 / traySettings / webPanelAdminKey / webPanelConfig —— 无版本字段）。
 * 故「无版本字段」必须判为**兼容**，否则这道闸门上线即挡死全部现有用户。
 *
 * 决策卡 ④「版本比预期新 → 拒绝启动，不向下猜测解析」要求有一个可比较的版本号，
 * 而它此前不存在。这里**新建**这个字段而不是复用 `accountDataMigration`：后者是
 * `{ builderIdArn: 1 }` 形状的「迁移已执行」标记（`index.ts:2363`，且该迁移已停用），
 * 语义是「做过哪些一次性清理」，不是「盘上格式的版本」。把两者混用会让将来某次
 * 迁移标记的增减被误读成版本变化。
 */
export const SUPPORTED_ACCOUNT_STORE_VERSION = 1

/** 版本字段的键名（顶层，与 accountData 同级 —— 它描述整个文件，不只是账号那一块） */
export const ACCOUNT_STORE_VERSION_KEY = 'schemaVersion'

/**
 * 持久化端口。**这是那三处手抄声明的真源**。
 *
 * 有意保持 `unknown` 而非泛型键值映射：全仓 16 个 store 键的值形状各不相同，
 * 且现有 66 个调用点全部就地 `as` 断言。引入泛型 schema 会让这 66 处一起改，
 * 属于 K-3 之外的改动面（真要做，是独立一轮「store 键的类型化」）。
 */
export interface AccountStorePort {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  /** 主数据文件的**完整路径**。消费点只取其 `dirname`（备份与主数据同目录） */
  readonly path: string
}

/** 数据文件的四种判定结果（对应决策卡 DC:103-106） */
export type AccountStoreFileState =
  /** 确实不存在 —— **唯一**允许映射成「什么都没有」的一态 */
  | { state: 'absent'; file: string }
  /** 存在且能解开 */
  | { state: 'ok'; file: string }
  /** 存在但解不开（密钥不符 / 密文损坏 / 截断 / 非本程序写的） */
  | { state: 'undecryptable'; file: string; reason: string }
  /** 存在但读不了（EACCES / EISDIR / EIO …）—— 是故障，不是「没有」 */
  | { state: 'unreadable'; file: string; reason: string }

export function accountStoreFilePath(dataDir: string): string {
  return resolve(join(dataDir, `${ACCOUNT_STORE_NAME}.json`))
}

/**
 * 「文件确实不存在」的 errno 白名单。姿态与 `secureBackup.ts:isNotFound` 逐字一致
 * （K-1 已为备份路径定过同一条不变量，这里不新造第二套判据）：
 * 只有 ENOENT / ENOTDIR 算不存在，其余都是「东西在，但读不了」。
 */
function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 解码 `conf` 写出的字节。
 *
 * 逐字复刻 `conf@15.0.2` 的 `_decryptData` 主路径（`dist/source/index.js`）：
 *   aes-256-cbc · iv = 前 16 字节 · 第 17 字节是 `:` 分隔符 · key = pbkdf2(密钥, iv, 10000, 32, sha512)
 *
 * 为什么**明文 JSON 也要能解**：实测(2026-08-10) `conf` 在设了 `encryptionKey` 的情况下
 * 依然能读明文 JSON —— 它的解密失败分支会把原字节当字符串返回，于是 `JSON.parse` 成功。
 * 这不是巧合而是它的兼容读设计（「未加密 → 加密」的平滑升级）。若这里判成「解不开」，
 * 手工拷贝明文数据的迁移路径会被自己的闸门挡死，而那正是 ADR 认可的路径之一。
 *
 * @throws 字节既非合法密文也非合法 JSON 时抛 —— **绝不返回空对象**。
 *   返回空对象就是决策卡 ② 点名的病灶：把「解不开」伪装成「没有数据」。
 */
export function decodeAccountStoreBytes(
  bytes: Buffer,
  encryptionKey: string = ACCOUNT_STORE_ENCRYPTION_KEY
): unknown {
  const attempts: Array<() => string> = [
    // ① 当作 conf 密文
    () => {
      const iv = bytes.subarray(0, 16)
      const password = pbkdf2Sync(encryptionKey, iv, 10_000, 32, 'sha512')
      const decipher = createDecipheriv('aes-256-cbc', password, iv)
      return Buffer.concat([decipher.update(bytes.subarray(17)), decipher.final()]).toString('utf-8')
    },
    // ② 当作 conf 的 legacy 密文（iv.toString() 当 salt —— conf 自己也留着这条回退）
    () => {
      const iv = bytes.subarray(0, 16)
      const password = pbkdf2Sync(encryptionKey, iv.toString(), 10_000, 32, 'sha512')
      const decipher = createDecipheriv('aes-256-cbc', password, iv)
      return Buffer.concat([decipher.update(bytes.subarray(17)), decipher.final()]).toString('utf-8')
    },
    // ③ 当作明文（见上：conf 的兼容读，也是手工迁移可能的形态）
    () => bytes.toString('utf-8')
  ]

  const failures: string[] = []
  for (const attempt of attempts) {
    let text: string
    try {
      text = attempt()
    } catch (e) {
      failures.push((e as Error).message)
      continue
    }
    try {
      const parsed = JSON.parse(text)
      // JSON.parse 会把 "123" / "null" 也解成合法值；数据文件顶层必须是对象。
      // 不加这道检查，一个恰好解出数字的坏文件会被当成合法空库。
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      failures.push(`解出的顶层不是对象（得到 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`)
    } catch (e) {
      failures.push((e as Error).message)
    }
  }

  throw new Error(
    `账号数据文件无法解密或解析（已尝试 ${attempts.length} 种形态：conf 密文 / conf legacy 密文 / 明文 JSON）。` +
      `若刚更换过加密密钥或文件被截断，请勿覆盖它 —— 先备份再排查。原始错误：${failures.join(' | ')}`
  )
}

/**
 * 判定数据文件处于四态中的哪一态。**只读**，不创建任何东西。
 *
 * 为什么判定与构造分开：构造一个 store 实例会**创建目录**（`conf` 的
 * `_ensureDirectory` 在读不到文件时就 mkdir）。而「先判定再决定要不要启动」
 * 必须在不产生副作用的前提下完成，否则一次「拒绝启动」也会顺手把目录建出来。
 */
export function classifyAccountStoreFile(
  file: string,
  encryptionKey: string = ACCOUNT_STORE_ENCRYPTION_KEY
): AccountStoreFileState {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch (e) {
    if (isNotFound(e)) return { state: 'absent', file }
    return { state: 'unreadable', file, reason: `${(e as NodeJS.ErrnoException).code ?? ''} ${(e as Error).message}`.trim() }
  }

  // 零字节文件：不是「没有」，而是上一次写入被打断留下的残骸。
  // 当成 absent 会让下一次写入把它当空库覆盖 —— 而它旁边可能还有一份能用的备份。
  if (bytes.length === 0) {
    return { state: 'undecryptable', file, reason: '文件存在但长度为 0（疑似写入被中断）' }
  }

  try {
    decodeAccountStoreBytes(bytes, encryptionKey)
    return { state: 'ok', file }
  } catch (e) {
    return { state: 'undecryptable', file, reason: (e as Error).message }
  }
}

/**
 * 四态判定的**单一收口**：absent 放行（空库启动），其余「在但用不了」一律抛。
 *
 * 与 K-1 `secureBackup` 的读语义同源，也是决策卡 ② 那条最危险的规则：
 * **绝不越过一份读不开的数据去以空库启动** —— 用户会以为账号丢了，
 * 而更糟的是他接着做的任何操作都会把这份「空库」写回盘上，覆盖掉本来可修复的数据。
 */
export function assertAccountStoreUsable(state: AccountStoreFileState): void {
  if (state.state === 'absent' || state.state === 'ok') return
  throw new Error(
    `拒绝以空账号库启动：${state.file} ${state.state === 'unreadable' ? '存在但无法读取' : '存在但无法解密'}。` +
      `原因：${state.reason}\n` +
      `绝不静默以空库启动 —— 那会让你以为账号丢了，且随后任何一次写入都会覆盖这份可能仍可修复的数据。` +
      `请先备份该文件，再检查加密密钥与文件权限。`
  )
}

/**
 * 版本闸门：只拒**更新**的版本，不拒无版本与旧版本。
 *
 * @throws 盘上版本高于本程序支持的版本时抛。
 */
export function assertAccountStoreVersion(
  decoded: unknown,
  supported: number = SUPPORTED_ACCOUNT_STORE_VERSION
): void {
  const raw = (decoded as Record<string, unknown> | null)?.[ACCOUNT_STORE_VERSION_KEY]
  if (raw === undefined || raw === null) return // 无字段 = 现存全部真实数据 = 兼容
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `账号数据格式版本字段 ${ACCOUNT_STORE_VERSION_KEY} 不是数字（得到 ${JSON.stringify(raw)}）：` +
        `拒绝猜测解析。`
    )
  }
  if (raw > supported) {
    throw new Error(
      `账号数据格式版本过新（盘上 ${raw} > 本程序支持 ${supported}）：拒绝启动。\n` +
        `向下猜测解析会把不认识的字段静默丢掉，而下一次写入就会把它们从盘上抹除。` +
        `请升级本程序，或使用与该数据匹配的版本。`
    )
  }
}

/**
 * 写权限闸门（**服务端启动语义** —— 桌面启动路径刻意不走它）。
 *
 * ## 为什么这一条只属于服务端
 *
 * 四态出自 `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:103-106`，
 * 而那段位于该卡的**服务器迁移**章节：周围的不变量 I1a/I1b/I1c 通篇在讲「把数据文件
 * 拷到服务器」，用户可见判据是「起服务端，面板上看到与本地桌面相同的账号」。
 * 也就是说这四条是**服务端启动语义**，不是「桌面也该照做一遍」的通用要求。
 *
 * 落到写权限这一条上，两边的处境完全不同：
 *   - **服务器**：真实存在。挂载权限、容器卷只读、服务用户不拥有那个被拷进来的文件 ——
 *     运维手工搬数据的路径天然会产生这些形态。
 *   - **桌面**：几乎不存在。用户装了应用，应用写自己的 `%APPDATA%` 目录。
 *     在这里加闸门，是用「多一条桌面拒绝启动的路」换「守一件桌面上不会发生的事」。
 *
 * 故本函数保留（服务端启动路径调它），但**不在** `preflightAccountStore` 里 ——
 * 后者是桌面也走的那一条。要把它加回桌面，得显式改桌面代码，而
 * `test/main/persistence/accountStorePort.test.ts` 的两条闸门会立刻红。
 *
 * ⚠️ 这道检查服务端**不能省**，因为 `conf` 不提供它：实测(2026-08-10 本机 node v22)
 * 对一个 `0o444` 的数据文件，`conf` 构造成功、`get` 也成功，**只在第一次 `set`
 * 时才抛 EPERM**。而本程序的写路径大多在定时器里（token 刷新 / 额度回写 / 会话归档），
 * 那里的异常只会进日志 —— 正是决策卡 ④「只读运行让所有写操作静默失败」描述的形态。
 *
 * 检查的是**目录**与**文件**两层：目录不可写则 `conf` 的原子写（临时文件 + rename）
 * 从第一步就失败；文件本身不可写则 rename 覆盖失败。两者都要看。
 */
export function assertAccountStoreWritable(file: string): void {
  const dir = dirname(file)
  try {
    accessSync(dir, fsConstants.W_OK)
  } catch (e) {
    if (isNotFound(e)) return // 目录还不存在 —— 属于「首次启动」，由构造方 mkdir
    throw new Error(
      `账号数据目录不可写：${dir}（${(e as NodeJS.ErrnoException).code}）。拒绝启动 —— ` +
        `只读运行会让 token 刷新、额度回写等定时写入全部静默失败，界面却显示一切正常。`
    )
  }

  try {
    statSync(file)
  } catch (e) {
    if (isNotFound(e)) return // 文件还不存在 —— 首次启动，目录可写就够了
    throw e
  }

  try {
    accessSync(file, fsConstants.W_OK)
  } catch (e) {
    throw new Error(
      `账号数据文件不可写：${file}（${(e as NodeJS.ErrnoException).code}）。拒绝启动 —— ` +
        `原因同上：写入会在定时器里静默失败，而不是在你面前报错。`
    )
  }
}

/**
 * 数据可用性前置校验：**四态 + 版本**。桌面与服务端共用这一条。
 *
 * ⚠️ **刻意不含写权限闸门**（`assertAccountStoreWritable`）。理由见那个函数的头部注释：
 * 写权限是服务端启动语义，桌面上那个处境几乎不存在，加进来只会给桌面多一条拒绝启动的路。
 * 服务端要的是 `preflightAccountStoreForServer`，它 = 本函数 + 写权限闸门。
 *
 * 这样切分而不是加个 `{ checkWritable?: boolean }` 选项：选项的默认值迟早会被
 * 「让两边一致」的直觉翻过来，而两个具名函数让「桌面走哪条、服务端走哪条」
 * 写在调用点上，看 diff 就能看见。
 *
 * 桌面端保留的三态里，「解不开」有真实价值：实测(2026-08-10)密钥不符时 `conf`
 * 抛的是 `SyntaxError: Unexpected token 'd'`（把密文当明文 JSON.parse 的结果），
 * 那条错误信息指不到真实原因，谁看了都不会想到是加密密钥。
 *
 * @returns 已解出的盘上内容（`absent` 时为 null）—— 让调用方不必再读一遍文件
 */
export function preflightAccountStore(
  dataDir: string,
  encryptionKey: string = ACCOUNT_STORE_ENCRYPTION_KEY
): { file: string; decoded: Record<string, unknown> | null } {
  const file = accountStoreFilePath(dataDir)
  const state = classifyAccountStoreFile(file, encryptionKey)
  assertAccountStoreUsable(state)
  if (state.state === 'absent') return { file, decoded: null }
  const decoded = decodeAccountStoreBytes(readFileSync(file), encryptionKey) as Record<
    string,
    unknown
  >
  assertAccountStoreVersion(decoded)
  return { file, decoded }
}

/**
 * 服务端启动路径的完整前置校验：`preflightAccountStore` **加上**写权限闸门。
 *
 * 写权限先查：它是四态里唯一「文件本身没问题、只是环境不让写」的一条，
 * 而运维搬完数据第一次起服务端时最可能撞的就是它。先报它，错误信息更贴近现场。
 */
export function preflightAccountStoreForServer(
  dataDir: string,
  encryptionKey: string = ACCOUNT_STORE_ENCRYPTION_KEY
): { file: string; decoded: Record<string, unknown> | null } {
  assertAccountStoreWritable(accountStoreFilePath(dataDir))
  return preflightAccountStore(dataDir, encryptionKey)
}

/**
 * 把一个 `conf`（或 `electron-store` —— 它是 `conf` 的薄壳）实例包成端口。
 *
 * ## 存在的理由：`set(key, undefined)` 在 `conf` 上不是「清除」
 *
 * 实测(2026-08-10 · conf 15.0.2)：`conf` 对 `set(key, undefined)` 抛
 * `TypeError: Use \`delete()\` to clear values`，**并且旧值留在盘上**。
 * 两条都验过。抛错本身只是噪音，真正的缺陷是清理没发生。
 *
 * 桌面端 `index.ts` 的 orphan session 清理有三处这种写法，且都裹在只 `console.warn`
 * 的 `catch` 里 —— 于是那个快照永远清不掉，每次启动被重新归档一次，历史里出现
 * **字节完全相同**的重复条目。本机实测该形态已造成 7 条重复（200 条上限里 193 唯一）。
 *
 * 语义上调用方要的就是「清掉这个键」，所以翻译放在端口这一层，而不是让每个调用点
 * 记得改写成 `delete()`：后者是三处各自记得一次，端口这里是一次管全部，
 * 且将来新增的调用点自动受益。`null` 不参与翻译 —— 它是**值**，不是清除。
 */
export function adaptRawStoreToPort(raw: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  delete: (key: string) => void
  path: string
}): AccountStorePort {
  return {
    get: (key, defaultValue) => raw.get(key, defaultValue),
    set: (key, value) => {
      if (value === undefined) {
        raw.delete(key)
        return
      }
      raw.set(key, value)
    },
    path: raw.path
  }
}
