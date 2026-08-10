// 安全备份：加密容灾备份文件，避免账号 token、代理账密以明文 JSON 落在磁盘上。
//
// 本文件属于**共享内核**：零 electron 依赖，能在纯 node（Linux 服务器）下加载。
// 加解密能力由调用方注入一个 `BackupCipher`（端口），两端各给自己的实现：
//   - 桌面：`secureBackupCipher.safeStorage.ts`（OS keyring：DPAPI / Keychain / libsecret）
//   - 服务端：`secureBackupCipher.aesGcm.ts`（AES-256-GCM，密钥来自环境变量）
// 平台差异收在装配层，本文件里没有 `if (isDesktop)` 之类分支
// —— 姿态见 `utils/webPanelAssetRoot.ts` 头部注释。
//
// 策略：
//   - 写：cipher 可用 → 写加密文件 *.backup.enc，并清理旧明文 *.backup.json
//          不可用 → 退回明文 JSON，并清理遗留的 *.backup.enc
//          （桌面端无 keyring 时的既有权衡；服务端要走这条必须显式 opt-in，
//            见 aesGcm 实现头部「为什么服务端默认拒绝」）
//   - 读：取**最后写入**的那一份；存在但读不出来 → 抛，绝不当成「没有备份」
//
// ## 不变量：任一时刻至多存在一种备份载体，且读到的总是最后写入的那份
//
// 两种载体（.enc / 旧明文）并存时，读路径必须回答「谁是新的」。原先的写法是
// 「优先 .enc」—— 于是 keyring 一度可用（写了 .enc）随后不可用（退明文）的机器上，
// 读到的是**过期**的 .enc，而更新的明文就躺在旁边；用不可用的 cipher 去读还会直接抛，
// 同一份新数据既读不到也报不出。两个方向都是静默丢数据。
//
// 故本文件同时守两道：
//   ① 写路径保证单载体 —— **先落新的，再删旧的**（顺序是承重的：反过来的话，
//      keyring 瞬时故障那一刻先删 .enc，再写明文失败，就把唯一的备份清空了）；
//      且删除失败会**向上抛**，不静默留下双载体。
//   ② 读路径不信任①的结果 —— 两份都在时按 mtime 取新。写路径可能在「新的已落盘、
//      旧的还没删掉」之间被杀（`flushBackupNow` 正是退出路径上跑的），那个窗口真实存在。
//
// 写入走**临时文件 + rename** 而非直接写目标路径：直写在崩溃/断电时留下截断文件，
// 而按下面的读语义，截断文件是**硬错误**而不再静默退回 —— 于是「没原子写」会从
// 「悄悄少一份备份」升级成「启动时报错」。rename 是同目录内的原子替换。
//
// ## 与重构前的一处**刻意的语义变化**（读路径）
//
// 旧实现把「解密失败」和「.enc 不存在」并成同一条 catch，然后去读旧明文、最终返回 null。
// 于是三种处境在调用方眼里完全一样：没有备份 / 密钥配错了 / 密文损坏了。
// 而调用方（`index.ts:initStore`）拿到 null 的行为是「静默跳过恢复」，拿到旧明文的行为是
// 「用它覆盖账号数据」—— 一个把配置失误变成静默无备份，另一个用**过期**明文覆盖现状。
// 灾难恢复现场最不该有的就是这种歧义，所以现在：**存在但读不出来 → 向上抛**，
// 无论卡在哪一步（打不开 / 解不开 / JSON 坏了）。
// 「没有备份」仍然返回 null —— 但只有 ENOENT / ENOTDIR 才算「没有」；
// EISDIR / EACCES 那类是「东西在，但读不了」，属于要人介入的故障。

import * as fs from 'fs/promises'
import * as path from 'path'
import type { BackupCipher } from './secureBackupCipher.aesGcm'

export type { BackupCipher } from './secureBackupCipher.aesGcm'

const ENC_NAME = 'kiro-accounts.backup.enc'
const LEGACY_JSON_NAME = 'kiro-accounts.backup.json'

function encPath(dir: string): string {
  return path.join(dir, ENC_NAME)
}
function legacyPath(dir: string): string {
  return path.join(dir, LEGACY_JSON_NAME)
}

/** 注入的 cipher 是否真能加密（桌面无 keyring / 服务端显式选明文时为 false） */
export function isSecureBackupAvailable(cipher: BackupCipher): boolean {
  return cipher.available
}

/**
 * 「文件确实不存在」的 errno 白名单。**只有这两个**算不存在：
 *   - ENOENT：路径上最后一段不存在
 *   - ENOTDIR：路径中间某段不是目录（等价于「这个文件不可能存在」）
 * 其余（EISDIR / EACCES / EPERM / EIO / EBUSY…）都是「东西在，但读不了」——
 * 那是故障，不能与「没有备份」同流，否则一次权限配错会表现为静默无备份。
 */
function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 读文件；不存在返回 null，其它错误（含 EISDIR）向上抛 */
async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch (e) {
    if (isNotFound(e)) return null
    throw new Error(`备份文件存在但无法读取：${file}（${(e as Error).message}）`, { cause: e })
  }
}

/** 删除文件；不存在视为成功，其它错误向上抛（静默失败会留下双载体 → 遮蔽新数据） */
async function removeIfExists(file: string): Promise<void> {
  try {
    await fs.unlink(file)
  } catch (e) {
    if (isNotFound(e)) return
    throw new Error(
      `清理旧备份失败：${file}（${(e as Error).message}）。` +
        `留着它会遮蔽刚写入的新备份，故此处不静默忽略。`,
      { cause: e }
    )
  }
}

/**
 * 原子落盘：同目录临时文件 + rename 覆盖。
 *
 * 同目录是必须的 —— 跨卷 rename 会退化成拷贝（甚至抛 EXDEV），失去原子性。
 * 临时文件名带 pid + 随机数：同机双开时两个进程可能同时备份（ADR-0002 Decision 3
 * 明确不做跨进程互斥），固定名字会让它们互相截断。
 */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
  } catch (e) {
    // 失败必须清掉临时文件:留下 *.tmp 不影响读(读只认两个固定名),
    // 但会在数据目录里越积越多,且让人误以为备份坏了。
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

/**
 * 写备份：cipher 可用则写加密 .enc，否则退回明文 JSON。两种情况都**清理另一种载体**，
 * 以维持「至多一种载体」的不变量（见文件头）。
 *
 * 顺序承重：**先落新的，再删旧的**。反过来会让一次瞬时故障（keyring 掉线那一刻）
 * 变成「唯一备份被清空」—— 删旧的动作必须发生在新的已经安全落盘之后。
 */
export async function writeSecureBackup(
  dir: string,
  data: unknown,
  cipher: BackupCipher
): Promise<void> {
  if (cipher.available) {
    const enc = cipher.encrypt(JSON.stringify(data))
    await writeAtomic(encPath(dir), enc)
    // 新的已落盘,现在才清理旧明文（避免明文长期残留 —— 既有行为）
    await removeIfExists(legacyPath(dir))
    return
  }
  // 兜底：环境不支持加密时仍写明文，优先保证不丢数据（桌面端无 keyring 的既有权衡）。
  await writeAtomic(legacyPath(dir), JSON.stringify(data, null, 2))
  // 对称的一半：遗留的 .enc 必须清掉，否则读路径会拿它遮蔽这份更新的明文。
  // 同样在新的落盘之后才删 —— 顺序反了就等于在瞬时故障时销毁唯一的加密备份。
  await removeIfExists(encPath(dir))
}

/**
 * 读备份。返回 null 只表示**确实没有备份**（两种载体都不存在）。
 *
 * ## 两份都在时的判定顺序（这里的顺序本身是承重的）
 *
 * 1. `.enc` 一旦存在，就**必须能读能解**，否则抛 —— 绝不越过一份读不开的密文去读旁边的
 *    明文。这条优先于「取新的」：密文坏掉时无法比对内容，而那份明文可能是很久以前的
 *    残留，用它覆盖账号数据比报错糟得多。「存在但读不出来」必须让人看见。
 * 2. `.enc` 完好、而明文**严格更新** → 返回明文。这是明文兜底路径在
 *    「明文已落盘、`.enc` 还没删掉」之间被杀留下的窗口（备份 flush 挂在退出路径上，
 *    窗口真实存在）。此时 `.enc` 已证明完好，取新的不丢任何东西。
 * 3. 其余情况取 `.enc`（含 mtime 并列：常态路径是「写 .enc + 删明文」，方向一致）。
 *
 * @throws 备份存在但读不出来 —— 打不开（EISDIR/EACCES…）/ 解不开（密钥错、密文损坏）
 *         / JSON 坏掉。见文件头「刻意的语义变化」。
 */
export async function readSecureBackup(dir: string, cipher: BackupCipher): Promise<unknown | null> {
  const enc = encPath(dir)
  const legacy = legacyPath(dir)

  const encBuf = await readIfExists(enc)

  if (encBuf) {
    // 先解密再谈「谁更新」：即使最终要用明文，也不允许一份解不开的密文被静默跳过。
    const encData = parseBackup(decryptBackup(encBuf, cipher), enc)

    const [encStat, legacyStat] = await Promise.all([statIfExists(enc), statIfExists(legacy)])
    const legacyIsNewer =
      legacyStat != null && encStat != null && legacyStat.mtimeMs > encStat.mtimeMs

    if (legacyIsNewer) {
      const content = await readIfExists(legacy)
      // 读到这里才没了 = 并发写刚把它删掉（正是写路径在做的事）→ 用已验完好的 .enc。
      if (content) return parseBackup(content.toString('utf-8'), legacy)
    }
    return encData
  }

  // 无 .enc → 旧明文（平滑迁移路径），或真的没有备份。
  const content = await readIfExists(legacy)
  if (content) return parseBackup(content.toString('utf-8'), legacy)

  return null // 两种载体都不存在 —— 正常状态，不是错误
}

/** stat；不存在返回 null，其它错误（EACCES 等）向上抛 —— 「读不了」不等于「不存在」 */
async function statIfExists(file: string): Promise<{ mtimeMs: number } | null> {
  try {
    return await fs.stat(file)
  } catch (e) {
    if (isNotFound(e)) return null
    throw new Error(`无法读取备份文件状态：${file}（${(e as Error).message}）`, { cause: e })
  }
}

/**
 * 解密。cipher 的异常一律裹上文件路径 —— 原始错误（如「bad envelope」）不带位置，
 * 运维拿到日志无从下手。
 */
function decryptBackup(buf: Buffer, cipher: BackupCipher): string {
  try {
    return cipher.decrypt(buf)
  } catch (e) {
    throw new Error(
      `备份解密失败：${ENC_NAME} 存在但解不开（密钥变更 / 文件损坏）。` +
        `原始错误：${(e as Error).message}`,
      { cause: e }
    )
  }
}

/** 解析。坏 JSON 是「备份存在但不可用」，绝不能与「没有备份」同流 */
function parseBackup(json: string, file: string): unknown {
  try {
    return JSON.parse(json)
  } catch (e) {
    throw new Error(`备份内容解析失败（JSON 损坏）：${file}（${(e as Error).message}）`, {
      cause: e
    })
  }
}
