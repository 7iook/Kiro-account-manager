/**
 * `secureBackup` 的端口契约测试：模块本身不认识 electron，只认识一个注入的 cipher。
 *
 * 这组用例守两件事：
 *   ① 桌面端语义**一字不变**（safeStorage 可用→写 .enc + 删旧明文；不可用→退明文；
 *      读时先 .enc 后旧明文）—— 这是既有行为，回归了就是灾难恢复能力静默消失；
 *   ② 服务端语义（cipher 不可用时不写明文、密钥错时读操作抛而不是返回 null）。
 *
 * 用假 cipher 而不是真 safeStorage/真 AES：这里要证明的是**分支走对了**，
 * 密码学正确性由 `aesGcmCipher.test.ts` 用真实现证。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSecureBackupAvailable,
  writeSecureBackup,
  readSecureBackup,
  type BackupCipher
} from '../../../src/main/secureBackup'

const ENC = 'kiro-accounts.backup.enc'
const LEGACY = 'kiro-accounts.backup.json'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kam-backup-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 可用的假 cipher：ROT-ish 可逆变换，足以证明「写的是密文、读回是明文」 */
function fakeCipher(available = true): BackupCipher {
  return {
    available,
    encrypt: (plain) => {
      if (!available) throw new Error('cipher unavailable')
      return Buffer.from('FAKEENC:' + plain, 'utf-8')
    },
    decrypt: (blob) => {
      const s = blob.toString('utf-8')
      if (!s.startsWith('FAKEENC:')) throw new Error('bad envelope')
      return s.slice('FAKEENC:'.length)
    }
  }
}

describe('secureBackup：cipher 可用（桌面 safeStorage / 服务端已配密钥）', () => {
  it('写入 .enc，且内容是密文而非明文 JSON', async () => {
    await writeSecureBackup(dir, { accounts: ['secret-token-xyz'] }, fakeCipher())

    expect(existsSync(join(dir, ENC))).toBe(true)
    const raw = readFileSync(join(dir, ENC), 'utf-8')
    expect(raw.startsWith('FAKEENC:')).toBe(true)
  })

  it('写 .enc 时清理遗留明文备份（避免明文长期残留 —— 既有行为）', async () => {
    writeFileSync(join(dir, LEGACY), '{"accounts":["old-plaintext"]}', 'utf-8')

    await writeSecureBackup(dir, { accounts: ['new'] }, fakeCipher())

    expect(existsSync(join(dir, LEGACY))).toBe(false)
  })

  it('往返：写完能读回同一对象', async () => {
    const data = { accounts: [{ id: 'a1', token: 't1' }], revision: 7 }
    await writeSecureBackup(dir, data, fakeCipher())

    expect(await readSecureBackup(dir, fakeCipher())).toEqual(data)
  })

  it('无 .enc 但有旧明文 → 读回旧明文（平滑迁移，既有行为）', async () => {
    writeFileSync(join(dir, LEGACY), '{"accounts":["legacy"]}', 'utf-8')

    expect(await readSecureBackup(dir, fakeCipher())).toEqual({ accounts: ['legacy'] })
  })

  it('目录里什么都没有 → 返回 null（「没有备份」是正常状态，不是错误）', async () => {
    expect(await readSecureBackup(dir, fakeCipher())).toBeNull()
  })

  it('isSecureBackupAvailable 如实反映注入的 cipher', () => {
    expect(isSecureBackupAvailable(fakeCipher(true))).toBe(true)
    expect(isSecureBackupAvailable(fakeCipher(false))).toBe(false)
  })
})

describe('secureBackup：cipher 不可用', () => {
  it('退回明文 JSON（桌面端无 keyring 时的既有兜底：丢备份比明文更糟）', async () => {
    await writeSecureBackup(dir, { accounts: ['plain'] }, fakeCipher(false))

    expect(existsSync(join(dir, LEGACY))).toBe(true)
    expect(existsSync(join(dir, ENC))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, LEGACY), 'utf-8'))).toEqual({ accounts: ['plain'] })
  })

  it('仍能读到旧明文备份（不因 cipher 不可用就读不了）', async () => {
    writeFileSync(join(dir, LEGACY), '{"accounts":["p"]}', 'utf-8')

    expect(await readSecureBackup(dir, fakeCipher(false))).toEqual({ accounts: ['p'] })
  })
})

describe('secureBackup：解密失败不得退化成「没有备份」', () => {
  it('.enc 存在但解密抛（密钥错/文件损坏）→ 向上抛，不返回 null', async () => {
    // 这是本轮**刻意改变**的语义:旧实现 catch 后去读明文、最终返回 null,
    // 于是「密钥配错」看起来和「没有备份」一模一样 —— 恢复现场最不该有的歧义。
    writeFileSync(join(dir, ENC), 'NOT-A-VALID-ENVELOPE', 'utf-8')

    await expect(readSecureBackup(dir, fakeCipher())).rejects.toThrow()
  })

  it('.enc 解密失败时，即使旁边有旧明文也不静默改读明文', async () => {
    writeFileSync(join(dir, ENC), 'NOT-A-VALID-ENVELOPE', 'utf-8')
    writeFileSync(join(dir, LEGACY), '{"accounts":["stale-plaintext"]}', 'utf-8')

    // 静默回退会用**过期**明文覆盖账号数据，比报错糟得多
    await expect(readSecureBackup(dir, fakeCipher())).rejects.toThrow()
  })
})

// ============================================================================
// 以下三组用例来自一次异构评审 + 实测复现（2026-08-10）。它们守的不是「功能能用」，
// 而是**灾难恢复现场的两条底线**：读到的必须是最后写入的那份；存在但读不出来必须报错。
// 上面那组用例全绿的同时，下面这些场景是红的 —— 差别在于上面每条只走**一次**写入，
// 而事故形态出在**两种载体并存**时谁遮蔽谁。
// ============================================================================

/** 目录里现存的备份载体（用于断言「任一时刻至多一种」这条不变量） */
function backupForms(d: string): string[] {
  return readdirSync(d).sort()
}

describe('secureBackup：任一时刻至多存在一种备份载体（防旧载体遮蔽新数据）', () => {
  it('明文兜底写入后，遗留的 .enc 不再遮蔽更新的明文（读到的是最后写入的那份）', async () => {
    // 复现形态：keyring 一度可用（写了 .enc），随后不可用（退明文）。
    // 读路径优先 .enc —— 若旧 .enc 还在，拿到的就是**过期**数据，且调用方无从察觉。
    await writeSecureBackup(dir, { gen: 'OLD' }, fakeCipher(true))
    await writeSecureBackup(dir, { gen: 'NEW' }, fakeCipher(false))

    expect(await readSecureBackup(dir, fakeCipher(true))).toEqual({ gen: 'NEW' })
  })

  it('明文兜底写入后，用不可用的 cipher 也能读回最新数据（不因残留 .enc 而抛）', async () => {
    // 同一处境的另一面：keyring 仍不可用时读备份。旧 .enc 残留会让读路径去解密，
    // 而 cipher 不可用必然抛 —— 于是「旁边就躺着一份更新的明文」却读不到。
    await writeSecureBackup(dir, { gen: 'OLD' }, fakeCipher(true))
    await writeSecureBackup(dir, { gen: 'NEW' }, fakeCipher(false))

    expect(await readSecureBackup(dir, fakeCipher(false))).toEqual({ gen: 'NEW' })
  })

  it('加密写入后目录里只剩 .enc（既有行为，与下一条构成对称）', async () => {
    writeFileSync(join(dir, LEGACY), '{"gen":"OLD"}', 'utf-8')
    await writeSecureBackup(dir, { gen: 'NEW' }, fakeCipher(true))

    expect(backupForms(dir)).toEqual([ENC])
  })

  it('明文写入后目录里只剩明文（本轮补齐的对称一半）', async () => {
    await writeSecureBackup(dir, { gen: 'OLD' }, fakeCipher(true))
    await writeSecureBackup(dir, { gen: 'NEW' }, fakeCipher(false))

    expect(backupForms(dir)).toEqual([LEGACY])
  })

  it('写入不留临时文件（原子写的落地证据，也防临时文件被误当成备份）', async () => {
    await writeSecureBackup(dir, { gen: 'A' }, fakeCipher(true))
    expect(backupForms(dir)).toEqual([ENC])

    await writeSecureBackup(dir, { gen: 'B' }, fakeCipher(false))
    expect(backupForms(dir)).toEqual([LEGACY])
  })
})

describe('secureBackup：清理旧载体的**顺序**（先落新的，再删旧的）', () => {
  it('明文写入失败时不得删掉已有的 .enc（否则一次瞬时故障就把唯一备份清空）', async () => {
    // 造一个必然写失败的明文路径：把明文文件名占成目录 → EISDIR。
    await writeSecureBackup(dir, { gen: 'ENCRYPTED' }, fakeCipher(true))
    mkdirSync(join(dir, LEGACY))

    await expect(writeSecureBackup(dir, { gen: 'NEW' }, fakeCipher(false))).rejects.toThrow()

    // 关键断言:写失败了,那份加密备份必须还在 —— 它此刻是唯一的备份。
    expect(existsSync(join(dir, ENC))).toBe(true)

    // 移除那个占位目录后（模拟运维清掉故障源），加密备份的内容仍然完好可读。
    // 留着它读会抛 EISDIR，那是**另一条**已被单独覆盖的不变量（存在但读不出来必须报错），
    // 不是本用例要证的东西。
    rmSync(join(dir, LEGACY), { recursive: true })
    expect(await readSecureBackup(dir, fakeCipher(true))).toEqual({ gen: 'ENCRYPTED' })
  })

  it('加密写入失败时不得删掉已有的旧明文备份（同一条不变量的镜像形态）', async () => {
    writeFileSync(join(dir, LEGACY), '{"gen":"LEGACY"}', 'utf-8')
    mkdirSync(join(dir, ENC))

    await expect(writeSecureBackup(dir, { gen: 'NEW' }, fakeCipher(true))).rejects.toThrow()

    expect(existsSync(join(dir, LEGACY))).toBe(true)
  })
})

describe('secureBackup：读失败不得伪装成「没有备份」（只有真的不存在才是 null）', () => {
  it('旧明文是坏 JSON → 抛，且错误信息点明是解析失败与文件名', async () => {
    // 返回 null 会让调用方以为「没有备份」→ 静默跳过恢复。
    // 而这份文件**存在**,只是内容坏了 —— 那是需要人介入的故障,不是正常状态。
    writeFileSync(join(dir, LEGACY), '{"accounts": [', 'utf-8')

    await expect(readSecureBackup(dir, fakeCipher(true))).rejects.toThrow(/解析|parse/i)
  })

  it('旧明文路径是个目录（EISDIR）→ 抛，不当成「不存在」', async () => {
    mkdirSync(join(dir, LEGACY))

    await expect(readSecureBackup(dir, fakeCipher(true))).rejects.toThrow()
  })

  it('.enc 路径是个目录（EISDIR）→ 抛，且不悄悄改读旁边的旧明文', async () => {
    // 最隐蔽的一条:.enc 读失败被吞 → 落到明文分支 → 读回**过期**明文,
    // 且调用方会拿它覆盖账号数据。必须抛。
    mkdirSync(join(dir, ENC))
    writeFileSync(join(dir, LEGACY), '{"gen":"STALE"}', 'utf-8')

    await expect(readSecureBackup(dir, fakeCipher(true))).rejects.toThrow()
  })

  it('.enc 内容坏掉（解密抛）时错误里带得出文件位置，便于运维定位', async () => {
    writeFileSync(join(dir, ENC), 'NOT-A-VALID-ENVELOPE', 'utf-8')

    await expect(readSecureBackup(dir, fakeCipher(true))).rejects.toThrow(/backup\.enc/)
  })

  it('备份目录整个不存在 → 仍然是 null（ENOENT 才是「没有备份」）', async () => {
    // 目录缺失与文件缺失同义:都表示这台机器上没有备份,不是故障。
    expect(await readSecureBackup(join(dir, 'no-such-subdir'), fakeCipher(true))).toBeNull()
  })
})

describe('secureBackup：双载体并存（写路径被杀在「新的已落盘、旧的还没删」之间）', () => {
  /** 直接构造崩溃窗口状态：两个载体都在，并显式拉开 mtime，不依赖写入的偶然时序 */
  function seedBothForms(opts: {
    encData: unknown
    legacyData: unknown
    newer: 'enc' | 'legacy'
  }): void {
    writeFileSync(join(dir, ENC), 'FAKEENC:' + JSON.stringify(opts.encData), 'utf-8')
    writeFileSync(join(dir, LEGACY), JSON.stringify(opts.legacyData), 'utf-8')

    // 用显式 mtime 而非 sleep：sleep 依赖文件系统时间戳粒度（NTFS/ext4 差异大），
    // 在 CI 上就是间歇性假绿的来源。
    const older = new Date(Date.now() - 60_000)
    const newer = new Date()
    const target = opts.newer === 'enc' ? ENC : LEGACY
    const other = opts.newer === 'enc' ? LEGACY : ENC
    utimesSync(join(dir, target), newer, newer)
    utimesSync(join(dir, other), older, older)
  }

  it('明文更新（keyring 掉线后兜底写完就被杀）→ 读回明文，而不是过期的 .enc', async () => {
    seedBothForms({ encData: { gen: 'OLD' }, legacyData: { gen: 'NEW' }, newer: 'legacy' })

    expect(await readSecureBackup(dir, fakeCipher(true))).toEqual({ gen: 'NEW' })
  })

  it('.enc 更新（加密写完就被杀，旧明文还没删）→ 读回 .enc', async () => {
    seedBothForms({ encData: { gen: 'NEW' }, legacyData: { gen: 'OLD' }, newer: 'enc' })

    expect(await readSecureBackup(dir, fakeCipher(true))).toEqual({ gen: 'NEW' })
  })

  it('明文更新但 .enc 已损坏 → 仍然抛，不用明文绕过一份读不开的密文', async () => {
    // 这条是**刻意**让「取最新」让位于「存在但读不出来必须报错」：密文坏掉时无从判断
    // 那份明文是不是很久以前的残留，静默用它覆盖账号数据比报错糟得多。
    writeFileSync(join(dir, ENC), 'NOT-A-VALID-ENVELOPE', 'utf-8')
    writeFileSync(join(dir, LEGACY), '{"gen":"NEWER-BUT-UNTRUSTED"}', 'utf-8')
    const older = new Date(Date.now() - 60_000)
    utimesSync(join(dir, ENC), older, older)

    await expect(readSecureBackup(dir, fakeCipher(true))).rejects.toThrow(/backup\.enc/)
  })
})
