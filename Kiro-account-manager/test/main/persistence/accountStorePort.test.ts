/**
 * 持久化端口（K-3）的失败四态与格式兼容性闸门。
 *
 * ## 为什么这些断言是「盘上字节」级的，而不是「接口形状」级的
 *
 * ADR-0002 Decision 3 定的迁移工件是**原始 `kiro-accounts.json` 直拷**
 * （决策卡 DC:244 / DC:538 把它写成「本轮唯一正式支持的迁移工件」）。
 * 于是服务端实现必须能读**桌面 electron-store 写出来的那一份字节**，
 * 「满足同一个 get/set 接口」是不够的 —— 一个只满足接口的实现会在
 * 用户拷完文件、启动服务端、看到空账号库的那一刻才暴露。
 *
 * 故本文件的核心断言是：用桌面写入路径产出的字节，能被服务端读取路径原样读回。
 *
 * ## 四态来自决策卡，不是本文件自创
 *
 * `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:103-106`：
 *   ① 文件不存在        → 空库启动 + 提示（不崩溃、也不静默建空库）
 *   ② 存在但解不开      → **拒绝启动**，绝不以空库启动（否则用户以为账号丢了）
 *   ③ 版本比预期新      → 拒绝启动，不向下猜测解析
 *   ④ 数据目录无写权限  → 拒绝启动（只读运行会让所有写操作静默失败）
 *
 * ② 是四态里最危险的一条，也是与 K-1 `secureBackup` 同一条不变量：
 * **只有「确实不存在」才映射成「什么都没有」，任何「在但读不出来」都必须是错误。**
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Conf from 'conf'

import {
  ACCOUNT_STORE_ENCRYPTION_KEY,
  ACCOUNT_STORE_NAME,
  accountStoreFilePath,
  adaptRawStoreToPort,
  assertAccountStoreWritable,
  classifyAccountStoreFile,
  decodeAccountStoreBytes,
  assertAccountStoreUsable,
  preflightAccountStore,
  SUPPORTED_ACCOUNT_STORE_VERSION,
  type AccountStorePort
} from '@main/persistence/accountStorePort'

import { createConfAccountStore } from '@main/persistence/accountStore.conf'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `k3-${tag}-`))
}

/** 用**桌面侧同一套参数**写一份真实的 store 文件（electron-store 只是 conf 的薄壳，见其 index.js） */
function writeDesktopShapedStore(dir: string, data: Record<string, unknown>): string {
  const c = new Conf({
    cwd: dir,
    configName: ACCOUNT_STORE_NAME,
    encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
  })
  for (const [k, v] of Object.entries(data)) c.set(k, v)
  return c.path
}

describe('K-3 持久化端口：盘上格式与桌面写入路径逐字节兼容', () => {
  it('服务端读取路径能读回桌面写入路径产出的字节（迁移路径的承重断言）', () => {
    const dir = tempDir('compat')
    const blob = { accounts: { a1: { id: 'a1', email: 'x@y.z' } }, revision: 42 }
    writeDesktopShapedStore(dir, { accountData: blob, proactiveRenewalEnabled: true })

    const store = createConfAccountStore({ dataDir: dir })
    expect(store.get('accountData', null)).toEqual(blob)
    expect(store.get('proactiveRenewalEnabled', false)).toBe(true)
  })

  it('盘上文件确实是加密的（16 字节 IV + 第 17 字节为 `:`），不是明文 JSON', () => {
    const dir = tempDir('enc')
    const p = writeDesktopShapedStore(dir, { accountData: { revision: 1 } })
    const bytes = readFileSync(p)
    // 这条守的是「加密没被顺手改掉」：ADR-0002 已定 encryptionKey 是混淆而非安全，
    // 但它必须**保持不变** —— 改了值或去掉它，用户现有的 kiro-accounts.json 就读不开了。
    expect(bytes[0]).not.toBe(0x7b) // 不是 '{'
    expect(bytes[16]).toBe(0x3a) // ':'
  })

  it('文件路径与桌面一致（kiro-accounts.json，非另起名字）', () => {
    const dir = tempDir('path')
    expect(accountStoreFilePath(dir)).toBe(join(dir, 'kiro-accounts.json'))
    expect(createConfAccountStore({ dataDir: dir }).path).toBe(accountStoreFilePath(dir))
  })

  it('写入后再开一个实例能读回（往返，且 revision 语义不被吞）', () => {
    const dir = tempDir('roundtrip')
    const a = createConfAccountStore({ dataDir: dir })
    a.set('accountData', { accounts: {}, revision: 3 })
    const b = createConfAccountStore({ dataDir: dir })
    expect((b.get('accountData', null) as { revision: number }).revision).toBe(3)
  })
})

describe('K-3 失败四态（决策卡 DC:103-106）', () => {
  it('① 文件不存在 → 判定为 absent（唯一映射成「什么都没有」的一态）', () => {
    const dir = tempDir('absent')
    const c = classifyAccountStoreFile(accountStoreFilePath(dir))
    expect(c.state).toBe('absent')
  })

  it('① 文件不存在 → 空库启动，get 返回默认值而不抛（不崩溃、不静默建空库）', () => {
    const dir = tempDir('absent2')
    const store = createConfAccountStore({ dataDir: dir })
    expect(store.get('accountData', null)).toBeNull()
  })

  it('② 密钥不符 → undecryptable，绝不当 absent（拿空库覆盖会让用户以为账号丢了）', () => {
    const dir = tempDir('badkey')
    const other = new Conf({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: 'some-other-key-entirely-different'
    })
    other.set('accountData', { accounts: { a: {} }, revision: 9 })

    const c = classifyAccountStoreFile(accountStoreFilePath(dir))
    expect(c.state).toBe('undecryptable')
    expect(c.state).not.toBe('absent')
  })

  it('② 密钥不符 → 服务端拒绝构造（fail fast，不返回一个「看起来是空库」的实例）', () => {
    const dir = tempDir('badkey2')
    const other = new Conf({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: 'some-other-key-entirely-different'
    })
    other.set('accountData', { revision: 1 })

    expect(() => createConfAccountStore({ dataDir: dir })).toThrow(/无法解密|undecryptable/i)
  })

  it('② 截断 / 垃圾字节 → undecryptable，同样拒绝，不静默退空库', () => {
    const dir = tempDir('garbage')
    mkdirSync(dir, { recursive: true })
    writeFileSync(accountStoreFilePath(dir), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))

    expect(classifyAccountStoreFile(accountStoreFilePath(dir)).state).toBe('undecryptable')
    expect(() => createConfAccountStore({ dataDir: dir })).toThrow()
  })

  it('② 目录被占用了文件名（EISDIR）→ unreadable，不是 absent', () => {
    const dir = tempDir('eisdir')
    mkdirSync(accountStoreFilePath(dir), { recursive: true })
    const c = classifyAccountStoreFile(accountStoreFilePath(dir))
    expect(['unreadable', 'undecryptable']).toContain(c.state)
    expect(c.state).not.toBe('absent')
  })

  it('③ 版本比预期新 → 拒绝，不向下猜测解析', () => {
    const dir = tempDir('newver')
    writeDesktopShapedStore(dir, {
      accountData: { revision: 1 },
      schemaVersion: SUPPORTED_ACCOUNT_STORE_VERSION + 1
    })
    expect(() => createConfAccountStore({ dataDir: dir })).toThrow(/版本|version/i)
  })

  it('③ 版本等于或低于预期 → 放行（不把兼容读也一并拒掉）', () => {
    const dir = tempDir('okver')
    writeDesktopShapedStore(dir, {
      accountData: { revision: 1 },
      schemaVersion: SUPPORTED_ACCOUNT_STORE_VERSION
    })
    expect(() => createConfAccountStore({ dataDir: dir })).not.toThrow()
  })

  it('③ 无版本字段（现存所有真实数据都是这一形态）→ 放行', () => {
    const dir = tempDir('nover')
    writeDesktopShapedStore(dir, { accountData: { revision: 1 } })
    expect(() => createConfAccountStore({ dataDir: dir })).not.toThrow()
  })

  it('④ 数据目录不可写 → 拒绝启动，而不是等第一次 set 才 EPERM', () => {
    const dir = tempDir('ro')
    // 实测(2026-08-10 本机 node v22)：conf 对只读**文件**是「构造成功、get 成功、
    // set 时才抛 EPERM」——即 ADR/决策卡 ④ 想避免的「只读运行让写操作静默失败」。
    // 故这条不可靠地依赖 conf，必须由端口自己在构造前检查。
    writeDesktopShapedStore(dir, { accountData: { revision: 1 } })
    chmodSync(accountStoreFilePath(dir), 0o444)

    let threw = false
    try {
      createConfAccountStore({ dataDir: dir })
    } catch {
      threw = true
    } finally {
      chmodSync(accountStoreFilePath(dir), 0o666)
    }
    expect(threw, '只读数据文件必须在构造期就被拒绝（否则写操作会静默失败）').toBe(true)
  })

  it('assertAccountStoreUsable 对 absent 放行、对 undecryptable 抛（四态判定的单一收口）', () => {
    expect(() => assertAccountStoreUsable({ state: 'absent', file: 'x' })).not.toThrow()
    expect(() =>
      assertAccountStoreUsable({ state: 'undecryptable', file: 'x', reason: 'bad' })
    ).toThrow()
    expect(() =>
      assertAccountStoreUsable({ state: 'unreadable', file: 'x', reason: 'EACCES' })
    ).toThrow()
  })
})

describe('K-3 解码器：与 conf 的字节格式一致（这是迁移可行性的根据）', () => {
  it('能解 conf 写的密文', () => {
    const dir = tempDir('dec')
    const p = writeDesktopShapedStore(dir, { accountData: { revision: 5 } })
    const decoded = decodeAccountStoreBytes(readFileSync(p)) as Record<string, unknown>
    expect((decoded.accountData as { revision: number }).revision).toBe(5)
  })

  it('能解**明文** JSON（手工拷贝 / 早期未加密数据的兼容读；实测 conf 自己也吃这条）', () => {
    const dir = tempDir('plain')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      accountStoreFilePath(dir),
      JSON.stringify({ accountData: { revision: 2 } }, null, '\t'),
      'utf-8'
    )
    const decoded = decodeAccountStoreBytes(readFileSync(accountStoreFilePath(dir))) as Record<
      string,
      unknown
    >
    expect((decoded.accountData as { revision: number }).revision).toBe(2)
    // 且这条不能走成「解不开」而拒绝启动 —— 否则明文迁移路径会被自己的闸门挡死
    expect(() => createConfAccountStore({ dataDir: dir })).not.toThrow()
  })

  it('对垃圾字节抛错，而不是返回空对象（空对象 = 静默空库 = 四态②的病灶）', () => {
    expect(() => decodeAccountStoreBytes(Buffer.from([9, 9, 9, 9]))).toThrow()
  })
})

describe('K-3 端口类型是三处重复声明的 SSOT', () => {
  it('AccountStorePort 可直接充当 accountService 的 store 引用（结构兼容）', async () => {
    const dir = tempDir('ssot')
    const store: AccountStorePort = createConfAccountStore({ dataDir: dir })

    // state.ts 的 StoreRef / types.ts 的 AccountStoreRef / webPanelWiring 的 WebPanelStoreRef
    // 都是同一形状的手抄副本。端口若不能原样喂给它们，就说明抽的不是同一个东西。
    const { setStoreRef, applyAccountDataMutation } = await import('@main/accountService/state')
    setStoreRef(store)
    const r = await applyAccountDataMutation((prev) => ({ ...prev, accounts: {} }))
    expect(r.ok).toBe(true)
    expect((store.get('accountData', null) as { revision: number }).revision).toBe(1)
  })
})

describe('K-3 裁决 1：写权限闸门只属于服务端启动路径', () => {
  // 决策卡 `decision-card.md:103-106` 的四态**位于该卡的服务器迁移段**：周围的
  // 不变量 I1a/I1b/I1c 全是「把数据文件拷到服务器」，用户可见判据是「起服务端，
  // 面板上看到与本地桌面相同的账号」。写权限那一条是**服务端启动语义** ——
  // 服务器上它真实存在（挂载权限 / 容器卷 / 服务用户不拥有该文件），
  // 桌面上则是「装了应用、它写自己的 %APPDATA%」，那个处境几乎不存在。
  // 把它加到桌面启动路径上，等于用「多一条桌面拒绝启动的路」换「守一件桌面不会发生的事」。
  it('preflightAccountStore 对只读数据文件放行 —— 桌面启动走的就是这一条', () => {
    const dir = tempDir('ro-shared')
    writeDesktopShapedStore(dir, { accountData: { revision: 1 } })
    chmodSync(accountStoreFilePath(dir), 0o444)
    try {
      expect(
        () => preflightAccountStore(dir),
        '共用前置校验不得包含写权限闸门 —— 否则桌面端会因此多一条拒绝启动的路'
      ).not.toThrow()
    } finally {
      chmodSync(accountStoreFilePath(dir), 0o666)
    }
  })

  it('preflightAccountStore 仍然拒绝解不开的数据文件（另外三态在桌面上保留）', () => {
    const dir = tempDir('ro-still-undec')
    const other = new Conf({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: 'some-other-key-entirely-different'
    })
    other.set('accountData', { revision: 1 })
    // 这一态在桌面上有真实价值：实测密钥不符时 conf 抛的是
    // `SyntaxError: Unexpected token 'd'` 之类的 JSON 语法错误，指不到真实原因。
    expect(() => preflightAccountStore(dir)).toThrow(/无法解密|拒绝以空账号库启动/)
  })

  it('assertAccountStoreWritable 本体保留且仍对只读文件抛（服务端实现要调它）', () => {
    const dir = tempDir('ro-cap')
    writeDesktopShapedStore(dir, { accountData: { revision: 1 } })
    chmodSync(accountStoreFilePath(dir), 0o444)
    try {
      expect(() => assertAccountStoreWritable(accountStoreFilePath(dir))).toThrow(/不可写/)
    } finally {
      chmodSync(accountStoreFilePath(dir), 0o666)
    }
  })
})

describe('K-3 裁决 2：set(key, undefined) 必须真的把键从盘上清掉', () => {
  /** 直接从盘上字节读回顶层键，绕开任何实例内存缓存 —— 断言的是「盘上还有没有」 */
  function keysOnDisk(dir: string): string[] {
    const decoded = decodeAccountStoreBytes(readFileSync(accountStoreFilePath(dir))) as Record<
      string,
      unknown
    >
    return Object.keys(decoded)
  }

  it('conf 原始行为：set(key, undefined) 抛 TypeError，且旧值**留在盘上**（这是被修的形状）', () => {
    const dir = tempDir('conf-undef')
    const raw = new Conf<Record<string, unknown>>({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
    })
    raw.set('proxyOrphanSessionSnapshot', { totalRequests: 5055 })

    expect(() => raw.set('proxyOrphanSessionSnapshot', undefined)).toThrow(TypeError)
    // 承重的是这一条：抛错本身只是噪音，真正的缺陷是「清理没发生」。
    // 桌面端三处调用点都裹在只 console.warn 的 catch 里，于是这个快照会
    // 每次启动被重新归档一次 —— 历史里出现字节完全相同的重复条目。
    expect(keysOnDisk(dir)).toContain('proxyOrphanSessionSnapshot')
  })

  it('端口适配后：set(key, undefined) 不抛，且该键从盘上消失', () => {
    const dir = tempDir('port-undef')
    const raw = new Conf<Record<string, unknown>>({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
    })
    raw.set('accountData', { revision: 7 })
    raw.set('proxyOrphanSessionSnapshot', { totalRequests: 5055 })

    const store = adaptRawStoreToPort(raw)
    expect(() => store.set('proxyOrphanSessionSnapshot', undefined)).not.toThrow()

    const keys = keysOnDisk(dir)
    expect(keys, '清理必须落到盘上 —— 断言的是「键不在了」，不是「我们调了 delete」').not.toContain(
      'proxyOrphanSessionSnapshot'
    )
    // 并且不能顺手把别的键也清掉
    expect(keys).toContain('accountData')
  })

  it('端口适配后：清理一个本来就不存在的键 —— 不抛、不产生该键（幂等）', () => {
    const dir = tempDir('port-undef-absent')
    const raw = new Conf<Record<string, unknown>>({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
    })
    raw.set('accountData', { revision: 1 })

    const store = adaptRawStoreToPort(raw)
    expect(() => store.set('proxyOrphanSessionSnapshot', undefined)).not.toThrow()
    expect(keysOnDisk(dir)).not.toContain('proxyOrphanSessionSnapshot')
  })

  it('端口适配后：写正常值仍然落盘（防适配器把写路径改坏）', () => {
    const dir = tempDir('port-normal')
    const raw = new Conf<Record<string, unknown>>({
      cwd: dir,
      configName: ACCOUNT_STORE_NAME,
      encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY
    })
    const store = adaptRawStoreToPort(raw)
    store.set('accountData', { revision: 11 })
    // null 是**值**不是「清除」——不能被适配器误当 undefined 处理掉
    store.set('proxyLastError', null)

    expect((store.get('accountData', null) as { revision: number }).revision).toBe(11)
    const keys = keysOnDisk(dir)
    expect(keys).toContain('accountData')
    expect(keys).toContain('proxyLastError')
  })

  it('服务端实现走的是同一条适配（不是各自实现一遍 undefined 翻译）', () => {
    const dir = tempDir('conf-store-undef')
    const store = createConfAccountStore({ dataDir: dir })
    store.set('accountData', { revision: 1 })
    store.set('proxyOrphanSessionSnapshot', { totalRequests: 1 })
    store.set('proxyOrphanSessionSnapshot', undefined)

    const keys = keysOnDisk(dir)
    expect(keys).not.toContain('proxyOrphanSessionSnapshot')
    expect(keys).toContain('accountData')
  })
})
