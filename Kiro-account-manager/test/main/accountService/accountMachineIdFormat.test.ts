/**
 * 账号绑定 machineId 的格式契约闸门 —— 防「注入了错命名空间的生成器」
 *
 * 本仓存在**两个互不兼容的 machineId 命名空间**，同名函数分居两侧：
 *   - 账号绑定设备 ID  = 64 位 hex（`proxy/types.ts:436` 契约 · `kproxy/index.ts:275`
 *     `generateDeviceId` · renderer `store/accounts.ts:33`）
 *   - 系统机器码       = UUID(36) 或 32 hex（`machineId.ts:83` `generateRandomMachineId`
 *     → 写 Windows 注册表 MachineGuid，UUID 在**它自己的域里是正确的**）
 *
 * 两者从不交汇，所以谁也没报错 —— 直到 `fce8c89` 把**系统机器码**的生成器注入到
 * 期望**账号绑定 ID** 的 `ApiKeyImportDeps.newMachineId`（`index.ts:1962`）。
 *
 * 为什么单测抓不到：`importApiKey.test.ts:67` 自己注入 `'f'.repeat(64)`，测的是
 * 桩而不是生产装配（典型的 mock-vs-production 失配）。故这里必须**静态断言生产
 * 注入点**，而不是再写一个带桩的用例。
 *
 * 真实后果不是「格式不好看」：`kproxy/mitmProxy.ts:17` 的 `KIRO_UA_REGEX`
 * （抓真实 Kiro IDE 报文写出来的）只认 `KiroIDE-<ver>-<64hex>`。UUID 形态的
 * machineId 拼进 UA 后**匹配不上**，K-Proxy 的设备 ID 改写对这些账号静默失效。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { generateDeviceId } from '../../../src/main/kproxy'

const REPO_ROOT = resolve(__dirname, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 账号绑定设备 ID 的唯一合法形态（`proxy/types.ts:436`） */
const ACCOUNT_DEVICE_ID = /^[0-9a-f]{64}$/

/** 逐字复制 `kproxy/mitmProxy.ts:17` —— 抓包写出来的真实 Kiro IDE UA 形态 */
const KIRO_UA_REGEX = /KiroIDE[-\s][\d.]+[-\s]([a-f0-9]{64})/i

describe('账号绑定 machineId 的格式契约', () => {
  it('生成器产出 64 位 hex，且能被 K-Proxy 的 UA 改写正则识别', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateDeviceId()
      expect(id).toMatch(ACCOUNT_DEVICE_ID)
      // 端到端判据：拼进 UA 后 K-Proxy 必须能认出来，否则设备 ID 改写静默失效
      expect(KIRO_UA_REGEX.test(`KiroIDE-0.12.155-${id}`)).toBe(true)
    }
  })

  it('系统机器码的 UUID 形态不满足账号绑定契约（两个命名空间不可互换）', async () => {
    const { randomUUID } = await import('node:crypto')
    const uuid = randomUUID().toLowerCase()
    expect(uuid).not.toMatch(ACCOUNT_DEVICE_ID)
    expect(KIRO_UA_REGEX.test(`KiroIDE-0.12.155-${uuid}`)).toBe(false)
  })

  it('生产装配的 newMachineId 用账号域生成器，不是系统机器码生成器', () => {
    const src = stripComments(read('src/main/index.ts'))
    const idx = src.indexOf('function buildApiKeyImportDeps')
    expect(idx, 'buildApiKeyImportDeps 不见了 —— 装配点被改名或移走').toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 600)

    expect(
      block,
      'newMachineId 注入了 machineId.ts 的 generateRandomMachineId（UUID 形态）——' +
        '它属于系统机器码命名空间，会写出不符 proxy/types.ts:436 契约的账号绑定 ID'
    ).not.toMatch(/newMachineId:.*generateRandomMachineId/)

    expect(
      block,
      'newMachineId 必须注入 kproxy 的 generateDeviceId（64 hex，账号绑定域）'
    ).toMatch(/newMachineId:\s*\(\)\s*=>\s*generateDeviceId\s*\(\)/)
  })
})
