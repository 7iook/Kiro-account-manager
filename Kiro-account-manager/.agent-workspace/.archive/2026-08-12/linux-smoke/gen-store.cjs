// 生成一份「桌面端形态」的 kiro-accounts.json —— 用仓库自己的 conf + accountStorePort 的常量。
// 目的:测「Windows 桌面 electron-store 写出的字节,能否被 Linux 服务端读开」。
// 不读用户真实数据(含真凭据),而是构造等价文件 —— 这正是被测的那条性质。
const path = require('node:path')
const fs = require('node:fs')

const outDir = process.argv[2]
if (!outDir) { console.error('usage: node gen-store.cjs <outDir>'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })

const ACCOUNT_STORE_ENCRYPTION_KEY = 'kiro-account-manager-secret-key'
const ACCOUNT_STORE_NAME = 'kiro-accounts'

async function main() {
  // conf 15 是 ESM;用 require(esm)(node>=22.12 已 unflag)
  const mod = require('conf')
  const Conf = mod.default ?? mod
  const store = new Conf({
    cwd: outDir,
    configName: ACCOUNT_STORE_NAME,
    encryptionKey: ACCOUNT_STORE_ENCRYPTION_KEY,
    // electron-store 会传 projectVersion;conf 直接用时给一个,避免它去找 package.json
    projectVersion: '1.7.6',
    clearInvalidConfig: false
  })

  // 顶层键形态照 accountStorePort.ts 文件头列的 16 个真实键(值为构造的假数据,无真凭据)
  store.set('accountData', {
    accounts: [
      {
        id: 'smoke-acct-1',
        email: 'smoke1@example.invalid',
        accessToken: 'FAKE_ACCESS_TOKEN_smoke1',
        refreshToken: 'FAKE_REFRESH_TOKEN_smoke1',
        authMethod: 'social',
        addedAt: 1760000000000
      },
      {
        id: 'smoke-acct-2',
        email: 'smoke2@example.invalid',
        accessToken: 'FAKE_ACCESS_TOKEN_smoke2',
        refreshToken: 'FAKE_REFRESH_TOKEN_smoke2',
        authMethod: 'idc',
        addedAt: 1760000001000
      }
    ],
    currentAccountId: 'smoke-acct-1'
  })
  store.set('webPanelConfig', { enabled: true, autoStart: false, host: '127.0.0.1', port: 5590 })
  store.set('webPanelAdminKey', 'DESKTOP-LEGACY-ADMIN-KEY-smoke')
  store.set('proxyConfig', { enabled: false, autoStart: false, host: '127.0.0.1', port: 8118 })
  store.set('kproxyConfig', { enabled: false })
  store.set('proactiveRenewalEnabled', false)
  store.set('traySettings', { minimizeToTray: true })
  store.set('proxyTotalRequests', 42)

  const file = path.join(outDir, `${ACCOUNT_STORE_NAME}.json`)
  const bytes = fs.readFileSync(file)
  console.log('WROTE', file)
  console.log('SIZE', bytes.length)
  console.log('SHA256', require('node:crypto').createHash('sha256').update(bytes).digest('hex'))
  console.log('FIRST16_HEX', bytes.subarray(0, 16).toString('hex'))
  console.log('BYTE16_IS_COLON', bytes[16] === 0x3a)
  console.log('NODE', process.version, 'PLATFORM', process.platform)
  // 回读自证:conf 自己能读回来
  console.log('READBACK_ACCOUNTS', store.get('accountData').accounts.length)
}
main().catch((e) => { console.error('FAILED', e); process.exit(1) })
