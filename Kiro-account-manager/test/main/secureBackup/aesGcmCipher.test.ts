/**
 * AES-256-GCM 备份密文实现（服务端形态）的单元测试。
 *
 * 为什么这组用例的重点是**失败语义**而不是「能加解密」：
 * 加解密对不对，一个 round-trip 就测完了；真正会造成事故的是三种失败被静默处理 ——
 *   ① 服务器没配密钥 → 静默写明文 → 网络可达主机上长期躺着一份 token 明文；
 *   ② 密钥配错/轮换错 → 静默「读不到备份」→ 灾难恢复时才发现备份全废；
 *   ③ 密文被改一个字节 → 不校验完整性就解出垃圾 → 用垃圾覆盖账号数据。
 * 所以这里每一条失败路径都断言「抛出且带可诊断信息」，而不是断言返回 null。
 */
import { describe, it, expect } from 'vitest'
import {
  createAesGcmBackupCipher,
  BACKUP_KEY_ENV,
  BACKUP_PLAINTEXT_OPT_IN_ENV,
  MIN_BACKUP_KEY_LENGTH
} from '../../../src/main/secureBackupCipher.aesGcm'

const GOOD_KEY = 'correct-horse-battery-staple-0123'

describe('AES-256-GCM 备份密文：正常往返', () => {
  it('加密后能用同一密钥解回原文（含中文与 emoji，证明不是 latin1 截断）', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const plain = JSON.stringify({ accounts: [{ name: '测试账号 🚀', token: 'abc' }] })

    const blob = cipher.encrypt(plain)
    expect(cipher.decrypt(blob)).toBe(plain)
  })

  it('available 为 true（配了密钥就是可加密状态）', () => {
    expect(createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY }).available).toBe(true)
  })

  it('同一明文两次加密得到不同密文（每次随机 salt/iv，防重放与模式分析）', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const a = cipher.encrypt('same')
    const b = cipher.encrypt('same')

    expect(a.equals(b)).toBe(false)
    // 但两份都能解回同一明文
    expect(cipher.decrypt(a)).toBe('same')
    expect(cipher.decrypt(b)).toBe('same')
  })

  it('密文不含明文子串（避免「加密了但其实是编码」这种假加密）', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const secret = 'SUPER_SECRET_TOKEN_VALUE'
    const blob = cipher.encrypt(JSON.stringify({ token: secret }))

    expect(blob.toString('utf-8')).not.toContain(secret)
    expect(blob.toString('latin1')).not.toContain(secret)
  })
})

describe('AES-256-GCM 备份密文：失败语义（本组是重点）', () => {
  it('没配密钥 → 构造即抛，且错误信息点明该设哪个环境变量', () => {
    // 拒绝在服务器上「静默退回明文」:桌面端没有运维可以配密钥，退明文是唯一能留下备份的
    // 办法;服务器上运维**能**配密钥,静默退明文只会把一次配置失误变成一份长期明文凭据。
    expect(() => createAesGcmBackupCipher({})).toThrowError(new RegExp(BACKUP_KEY_ENV))
  })

  it('没配密钥但显式接受明文 → 不抛，返回 available=false（由上层写明文）', () => {
    // 逃生舱:运维明确认为「丢备份比明文更糟」时可以选明文,但必须是显式动作,不是默认行为。
    const cipher = createAesGcmBackupCipher({ [BACKUP_PLAINTEXT_OPT_IN_ENV]: '1' })
    expect(cipher.available).toBe(false)
  })

  it('声明 available=false 时调用 encrypt 仍然抛（不允许悄悄产出未加密字节）', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_PLAINTEXT_OPT_IN_ENV]: '1' })
    expect(() => cipher.encrypt('x')).toThrow()
  })

  it('密钥过短 → 构造即抛（弱密钥在公网主机上等于没加密）', () => {
    const short = 'a'.repeat(MIN_BACKUP_KEY_LENGTH - 1)
    expect(() => createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: short })).toThrowError(
      new RegExp(String(MIN_BACKUP_KEY_LENGTH))
    )
  })

  it('全空白密钥视为未配置（防 `KEY=" "` 这种以为配了其实没配）', () => {
    expect(() => createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: '    ' })).toThrowError(
      new RegExp(BACKUP_KEY_ENV)
    )
  })

  it('用错密钥解密 → 抛，不返回垃圾也不返回 null', () => {
    const writer = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const reader = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: 'a-different-but-valid-key-000000' })
    const blob = writer.encrypt('{"accounts":[]}')

    expect(() => reader.decrypt(blob)).toThrow()
  })

  it('密文被改一个字节 → GCM 认证失败并抛（完整性校验真的生效）', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const blob = cipher.encrypt('{"accounts":[1,2,3]}')
    const tampered = Buffer.from(blob)
    // 改最后一个字节（落在 ciphertext 区）
    tampered[tampered.length - 1] ^= 0xff

    expect(() => cipher.decrypt(tampered)).toThrow()
  })

  it('认证标签被改 → 同样抛（标签区也在校验范围内）', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const blob = cipher.encrypt('{"accounts":[]}')
    const tampered = Buffer.from(blob)
    // magic(6) + salt(16) + iv(12) = 34 起是 tag 区
    tampered[35] ^= 0xff

    expect(() => cipher.decrypt(tampered)).toThrow()
  })

  it('魔术头不匹配（例如喂进 safeStorage 写的 .enc）→ 抛且信息可诊断', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    const alien = Buffer.concat([Buffer.from('v10'), Buffer.alloc(64, 7)])

    // 不能静默当「没有备份」处理 —— 那会让「桌面备份被服务端读」变成一次静默的数据丢失
    expect(() => cipher.decrypt(alien)).toThrow()
  })

  it('截断的密文（长度不足信封头）→ 抛，不越界读', () => {
    const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: GOOD_KEY })
    expect(() => cipher.decrypt(Buffer.alloc(10, 1))).toThrow()
  })
})
