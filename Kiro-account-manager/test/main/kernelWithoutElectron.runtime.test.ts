/**
 * 运行时证明：electron **真的缺席**时，内核模块仍能加载并完成核心操作。
 *
 * 关键设计：用 `vi.mock('electron', () => { throw ... })` 让 electron 模块解析本身失败。
 * 为什么不能简单地「在 node 下 import 一下就算过」——
 * 实测本仓 `node_modules/electron/index.js` 在纯 node 下导出的是**字符串**（electron
 * 可执行文件路径），所以旧代码 `import { app } from 'electron'` 在 vitest 里根本不抛，
 * 只是 `app === undefined`。那样的测试在修复前也是绿的，等于什么都没证明。
 *
 * 而抛异常的 mock 会让**任何**形态的 electron 依赖（ESM / CJS / 动态 import）在加载期
 * 就炸掉，与 Linux 服务器上 `require('electron')` 找不到模块的处境同形。实测确认这个
 * mock 生效：修复前的 secureBackup 在此 mock 下加载即失败。
 */
import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

// 模拟 electron 完全不可解析（Linux 服务器形态）。工厂内不引用任何顶层变量。
vi.mock('electron', () => {
  throw new Error('ELECTRON_NOT_AVAILABLE_ON_SERVER')
})

describe('runtime: electron 缺席时内核仍可加载', () => {
  it('自检：本用例的 mock 真的让 electron 不可解析（否则下面的断言无意义）', async () => {
    await expect(import('electron')).rejects.toThrow()
  })

  it('secureBackup 可加载', async () => {
    const m = await import('../../src/main/secureBackup')
    expect(typeof m.writeSecureBackup).toBe('function')
    expect(typeof m.readSecureBackup).toBe('function')
  })

  it('secureBackupCipher.aesGcm 可加载', async () => {
    const m = await import('../../src/main/secureBackupCipher.aesGcm')
    expect(typeof m.createAesGcmBackupCipher).toBe('function')
  })

  it('kproxy 可加载', async () => {
    const m = await import('../../src/main/kproxy/index')
    expect(typeof m.KProxyService).toBe('function')
  })

  it('KProxyService 能构造出正确 dataPath（构造时不碰 electron）', async () => {
    const { KProxyService } = await import('../../src/main/kproxy/index')
    const userData = process.platform === 'win32' ? 'C:\\srv\\kam' : '/srv/kam'

    const svc = new KProxyService({}, {}, userData)

    expect(svc.dataPath).toBe(join(userData, 'kproxy'))
  })

  it('AES-GCM 备份端到端可用：写 .enc 再读回（全程无 electron）', async () => {
    const { createAesGcmBackupCipher, BACKUP_KEY_ENV } = await import(
      '../../src/main/secureBackupCipher.aesGcm'
    )
    const { writeSecureBackup, readSecureBackup } = await import('../../src/main/secureBackup')

    const dir = mkdtempSync(join(tmpdir(), 'kam-srv-backup-'))
    try {
      const cipher = createAesGcmBackupCipher({ [BACKUP_KEY_ENV]: 'server-side-key-32-chars-min-ok!' })
      const data = { accounts: [{ id: 'srv1', token: 'tok' }], revision: 3 }

      await writeSecureBackup(dir, data, cipher)

      expect(existsSync(join(dir, 'kiro-accounts.backup.enc'))).toBe(true)
      expect(await readSecureBackup(dir, cipher)).toEqual(data)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
