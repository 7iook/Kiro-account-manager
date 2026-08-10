/**
 * 备份加密的 **cipher 端口** 与 AES-256-GCM 实现（服务端形态）。
 *
 * 分层姿态与 `utils/webPanelAssetRoot.ts` 头部记录的一致：把平台差异推到装配层，
 * 内核只认一个端口。`secureBackup.ts` 因此不再认识 `safeStorage`，两端各注入自己的实现：
 *   - 桌面：`secureBackupCipher.safeStorage.ts`（OS keyring：DPAPI / Keychain / libsecret）
 *   - 服务端：本文件（AES-256-GCM，密钥来自环境变量 —— ADR-0002 已定：服务端不用 keyring）
 *
 * ## 为什么服务端「没配密钥」默认是**拒绝**，而不是像桌面那样退回明文
 *
 * 桌面端退明文是对的：那里没有运维可以配密钥，`safeStorage` 不可用是环境事实而非配置
 * 失误，此时「丢掉容灾备份」确实比「明文落在自己的个人电脑上」更糟。
 *
 * 服务器上这个权衡**翻转**了，三点都变了：
 *   ① 密钥是运维能提供的 —— 缺失是**配置失误**，不是不可抗环境；静默退明文会把一次
 *      忘配环境变量，变成一份长期躺在网络可达主机上的账号 token 明文；
 *   ② 暴露面不同 —— 服务器 7×24 联网、多人可登、常有备份/快照/日志采集顺手把文件带走，
 *      而个人电脑基本只有本人物理接触；
 *   ③ 失败可见性不同 —— 桌面端用户看得到 UI 提示，服务端静默降级没人会发现，
 *      直到明文被人拿走。启动即失败反而是最便宜的纠正时机（fail fast）。
 *
 * 所以默认拒绝。但保留一个**显式**逃生舱 `KIRO_BACKUP_ALLOW_PLAINTEXT=1`：
 * 运维若判断自己的处境更接近桌面（例如内网单机、且认定丢备份不可接受），可以主动选明文。
 * 关键是这必须是一个**有意识的动作**，而不是忘配环境变量后的默认结果。
 *
 * ## 信封格式
 *
 *   magic(6) | salt(16) | iv(12) | tag(16) | ciphertext(...)
 *   'KAMBK1'   scrypt     GCM      GCM       AES-256-GCM
 *
 * 带 magic 头是为了让「把桌面 safeStorage 写的 .enc 喂给服务端」这种错配**明确报错**，
 * 而不是解出垃圾。密钥经 scrypt 派生而非直接当 key：运维给的是口令，长度/熵都不受控，
 * 直接截断成 32 字节会把弱口令变成弱密钥。salt 每次随机并随信封存储。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** 备份密钥的环境变量名 */
export const BACKUP_KEY_ENV = 'KIRO_BACKUP_KEY'

/** 显式接受明文备份的环境变量名（逃生舱，需运维主动设置） */
export const BACKUP_PLAINTEXT_OPT_IN_ENV = 'KIRO_BACKUP_ALLOW_PLAINTEXT'

/**
 * 密钥最小长度。32 字符不是密码学要求（scrypt 会派生出 32 字节 key），
 * 而是运维护栏：短口令在公网主机上等于没加密，而这类主机通常允许无限次离线爆破。
 */
export const MIN_BACKUP_KEY_LENGTH = 32

const MAGIC = Buffer.from('KAMBK1', 'utf-8')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
/** scrypt 代价参数。N=2^15 在服务端启动/备份这种低频路径上开销可忽略（~50ms 级）。 */
const SCRYPT_N = 32768

/**
 * 备份加解密端口。`secureBackup.ts` 只依赖这个接口，不认识任何具体平台 API。
 */
export interface BackupCipher {
  /** 是否真的能加密。false 时上层按「无加密能力」处理（写明文兜底） */
  readonly available: boolean
  /** 加密。available 为 false 时必须抛，不允许悄悄产出未加密字节 */
  encrypt(plain: string): Buffer
  /** 解密。密钥错 / 密文损坏 / 信封不匹配都必须抛，不允许返回垃圾或空值 */
  decrypt(blob: Buffer): string
}

/**
 * 创建服务端 AES-256-GCM cipher。
 *
 * @param env 环境变量来源（显式传入而非直接读 `process.env`，便于测试且让依赖可见）
 * @throws 未配密钥且未显式接受明文时抛；密钥过短时抛。**故意在构造期抛** ——
 *         启动时失败远好于第一次备份时才失败（那时才发现，往往已经跑了很久）。
 */
export function createAesGcmBackupCipher(
  env: Record<string, string | undefined> = process.env
): BackupCipher {
  const raw = env[BACKUP_KEY_ENV]
  const key = typeof raw === 'string' ? raw.trim() : ''
  const plaintextOptIn = isTruthy(env[BACKUP_PLAINTEXT_OPT_IN_ENV])

  if (key.length === 0) {
    if (plaintextOptIn) {
      // 运维显式选择了明文：返回一个 available=false 的 cipher，
      // 让上层走「无加密能力」分支（与桌面无 keyring 时同一条路）。
      return unavailableCipher(
        `${BACKUP_KEY_ENV} 未设置，且已通过 ${BACKUP_PLAINTEXT_OPT_IN_ENV} 显式接受明文备份`
      )
    }
    throw new Error(
      `备份加密密钥缺失：请设置环境变量 ${BACKUP_KEY_ENV}（至少 ${MIN_BACKUP_KEY_LENGTH} 字符）。\n` +
        `拒绝静默写明文备份 —— 备份含账号 token 与代理账密，明文落在联网主机上等于公开。\n` +
        `若确实接受明文（例如隔离内网、且认为丢备份比明文更糟），请显式设置 ` +
        `${BACKUP_PLAINTEXT_OPT_IN_ENV}=1。`
    )
  }

  if (key.length < MIN_BACKUP_KEY_LENGTH) {
    throw new Error(
      `${BACKUP_KEY_ENV} 过短（${key.length} 字符）：至少需要 ${MIN_BACKUP_KEY_LENGTH} 字符。\n` +
        `弱口令在可离线爆破的主机上等于没加密。`
    )
  }

  return {
    available: true,

    encrypt(plain: string): Buffer {
      const salt = randomBytes(SALT_LEN)
      const iv = randomBytes(IV_LEN)
      const derived = deriveKey(key, salt)
      const cipher = createCipheriv('aes-256-gcm', derived, iv)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([MAGIC, salt, iv, tag, ciphertext])
    },

    decrypt(blob: Buffer): string {
      const headerLen = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN
      // 长度校验放在切片之前:Buffer.subarray 对越界是静默返回短 buffer,
      // 不检查就会把「截断的文件」变成一个看似合法却解不开的密文,错误信息毫无指向性。
      if (blob.length < headerLen) {
        throw new Error(
          `备份密文长度不足（${blob.length} < ${headerLen}）：文件被截断或不是本程序写的备份。`
        )
      }
      if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error(
          `备份密文信封头不匹配：该文件不是服务端 AES-GCM 备份` +
            `（若来自桌面端 safeStorage 备份，需在桌面端解密后再迁移）。`
        )
      }

      let offset = MAGIC.length
      const salt = blob.subarray(offset, (offset += SALT_LEN))
      const iv = blob.subarray(offset, (offset += IV_LEN))
      const tag = blob.subarray(offset, (offset += TAG_LEN))
      const ciphertext = blob.subarray(offset)

      const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, salt), iv)
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
      } catch (e) {
        // GCM 认证失败 —— 密钥不对或密文被改。**必须抛**：
        // 返回 null 会让「密钥配错」看起来和「没有备份」一样，恢复现场最不该有的歧义。
        throw new Error(
          `备份解密失败（GCM 认证不通过）：${BACKUP_KEY_ENV} 与写入时不一致，或密文已损坏/被篡改。` +
            `原始错误：${(e as Error).message}`
        )
      }
    }
  }
}

/** 无加密能力的 cipher：如实报告 available=false，且 encrypt 一定抛 */
function unavailableCipher(reason: string): BackupCipher {
  return {
    available: false,
    encrypt(): Buffer {
      // 上层理应先看 available 再决定写明文；真调到这里说明分支写错了，
      // 此时抛出去比返回未加密字节安全得多。
      throw new Error(`无可用备份加密能力（${reason}）：不产出未加密字节。`)
    },
    decrypt(): string {
      throw new Error(`无可用备份加密能力（${reason}）：无法解密 .enc 备份。`)
    }
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // maxmem 需显式抬高：N=32768 时默认 32MB 上限会被 scrypt 判为超限而抛。
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, maxmem: 128 * 1024 * 1024 })
}

function isTruthy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}
