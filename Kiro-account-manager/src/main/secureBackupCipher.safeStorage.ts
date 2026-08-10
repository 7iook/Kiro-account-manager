/**
 * 桌面装配层：把 Electron `safeStorage` 适配成内核的 `BackupCipher` 端口。
 *
 * 本文件**属于装配层，不属于共享内核** —— 它是允许 import electron 的那一侧。
 * 内核 (`secureBackup.ts`) 只认端口，两端各注入自己的实现；平台差异收在这里，
 * 与 `utils/webPanelAssetRoot.ts` 头部记录的姿态一致（差异推到装配层，内核里不留分支）。
 *
 * 行为与重构前的 `secureBackup.ts` **完全一致**：
 *   - `available` = `safeStorage.isEncryptionAvailable()`，异常吞掉当 false
 *     （少数 Linux 无 keyring 环境会抛，那属于环境事实，不是错误）；
 *   - 加解密直接透传 `encryptString` / `decryptString`。
 *
 * 注意这里的 `available=false` 会让上层退回明文备份 —— 那是桌面端**刻意**的权衡：
 * 个人电脑上没有运维可以配密钥，丢掉容灾备份比明文落在本机更糟。服务端的权衡相反，
 * 理由见 `secureBackupCipher.aesGcm.ts` 头部。
 */
import { safeStorage } from 'electron'
import type { BackupCipher } from './secureBackupCipher.aesGcm'

/**
 * 创建桌面 safeStorage cipher。
 *
 * `available` 用 getter 而非构造期快照：keyring 的可用性在进程生命周期内可能变化
 * （例如 Linux 上 keyring 服务后起），构造期定格会让之后永远走明文分支。
 */
export function createSafeStorageBackupCipher(): BackupCipher {
  return {
    get available(): boolean {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        // 无 keyring 的环境会抛 —— 这是环境事实，如实返回 false 让上层退明文
        return false
      }
    },

    encrypt(plain: string): Buffer {
      return safeStorage.encryptString(plain)
    },

    decrypt(blob: Buffer): string {
      return safeStorage.decryptString(blob)
    }
  }
}
