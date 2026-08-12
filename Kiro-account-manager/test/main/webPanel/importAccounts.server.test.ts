/**
 * `POST /panel/api/accounts` 导入端点 —— 真 `http.Server` + 真 `fetch` 端到端
 *
 * 为什么必须端到端：本包最容易的失败方式不是逻辑写错，而是**「用例写好了但没接在生产路由上」**
 * （仓内 E-052 母题）。只有真发一次 POST、再真 GET 一次列表，才能证明
 * 「手机粘贴 → 账号出现在列表里」这条链真的通了，而不是只有单测在调它。
 *
 * 姿态照 `staticAssets.server.test.ts`：真服务器、真 cookie、真 CSRF 头。
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { WebPanelServer } from '../../../src/main/webPanel/server'
import { PanelAuth } from '../../../src/main/webPanel/auth'
import { PANEL_PATH_PREFIX } from '../../../src/main/webPanel/cookie'
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../../src/webPanel/api/client'
import type { PanelRouteDeps } from '../../../src/main/webPanel/routes'
import type {
  AccountsBlob,
  ApplyResult,
  Mutator,
  ApplyOpts
} from '../../../src/main/accountService/state'
import type { VerifyApiKeyResult } from '../../../src/shared/types/credential'

const ADMIN_KEY = 'test-admin-key-0123456789abcdef'
const KEY_A = `ksk_${'a'.repeat(40)}`

type ServerType = InstanceType<typeof WebPanelServer>

/** 真的一份「盘」，让 GET /accounts 能读回 POST 刚写进去的东西 */
function makeDisk(): {
  read: () => AccountsBlob
  loadAccountsBlob: () => Promise<unknown>
  applyMutation: (m: Mutator, o?: ApplyOpts) => Promise<ApplyResult>
} {
  let blob: AccountsBlob = { revision: 5, accounts: {} }
  return {
    read: () => blob,
    loadAccountsBlob: async () => blob,
    applyMutation: async (mutate, opts) => {
      const prev = { ...blob, revision: (blob.revision as number) ?? 0 }
      if (opts?.expectedRevision !== undefined && opts.expectedRevision !== prev.revision) {
        return { ok: false, code: 'STALE_REVISION', currentRevision: prev.revision }
      }
      const next = await mutate(prev)
      blob = { ...next, revision: prev.revision + 1 }
      return { ok: true, revision: prev.revision + 1 }
    }
  }
}

let disk: ReturnType<typeof makeDisk>
let verifyResult: () => Promise<VerifyApiKeyResult>
let checkedIds: string[]
/** 导入后是否真的触发了额度刷新(fire-and-forget)—— 记录被 checkAccountStatus 打到的账号 id */
let checkCalledIds: string[]

function stubRouteDeps(): PanelRouteDeps {
  return {
    // 文件级共享 server；每次请求都读 beforeEach 刚换好的那份内存盘。
    loadAccountsBlob: () => disk.loadAccountsBlob(),
    importApiKeys: async (input) => {
      const { importApiKeys } = await import('../../../src/main/accountService/importApiKey')
      const result = await importApiKeys(
        {
          verifyApiKey: () => verifyResult(),
          applyMutation: disk.applyMutation,
          now: () => 1_700_000_000_000,
          newId: () => 'acc-new-1',
          newMachineId: () => 'f'.repeat(64)
        },
        input
      )
      for (const r of result.results) if (r.accountId) checkedIds.push(r.accountId)
      return result
    },
    checkAccountStatus: async (account) => {
      checkCalledIds.push(String((account as { id?: unknown })?.id ?? '(no-id)'))
      return { success: true }
    },
    refreshAccountToken: async () => ({ success: true }),
    switchAccountToIde: async () => ({ success: true }),
    switchAccountToCli: async () => ({ success: true }),
    logoutFromIde: async () => ({ success: true }),
    getAccountModels: async () => ({ success: true, models: [] }),
    getAccountSubscriptions: async () => ({ success: true, plans: [] }),
    getAccountSubscriptionUrl: async () => ({ success: true, url: 'https://example.com' }),
    setAccountOverage: async () => ({ success: true })
  }
}

let server: ServerType
let base: string
let cookie: string

async function startServer(): Promise<void> {
  const auth = new PanelAuth({ get: () => ADMIN_KEY, set: () => undefined })
  server = new WebPanelServer({
    auth,
    routeDeps: stubRouteDeps(),
    getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1' })
  })
  await server.start()
  const addr = server.getListeningAddress()
  base = `http://127.0.0.1:${addr?.port}${PANEL_PATH_PREFIX}`
}

async function login(): Promise<void> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
    body: JSON.stringify({ adminKey: ADMIN_KEY })
  })
  expect(res.status).toBe(200)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      Cookie: cookie
    },
    body: JSON.stringify(body)
  })
}

function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Cookie: cookie } })
}

function resetCaseState(): void {
  disk = makeDisk()
  checkedIds = []
  checkCalledIds = []
  verifyResult = async () => ({
    state: 'VALID',
    success: true,
    tokenFingerprint: 'fp00000000000001',
    region: 'us-east-1',
    subscription: {
      type: 'Q_DEVELOPER_STANDALONE_PRO',
      title: 'KIRO PRO',
      currentUsage: 1,
      usageLimit: 50
    }
  })
}

beforeAll(async () => {
  resetCaseState()
  await startServer()
})

beforeEach(async () => {
  resetCaseState()
  await login()
})

afterAll(async () => {
  await server.stop()
})

describe('POST /panel/api/accounts · 手机端导入 ksk_', () => {
  it('粘贴一个 ksk_ → 导入成功，且**重新 GET 列表**能看到它（链路真的通了）', async () => {
    const res = await post('/api/accounts', { apiKeys: KEY_A })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported: number; results: Array<{ code: string }> }
    expect(body.imported).toBe(1)
    expect(body.results[0].code).toBe('IMPORTED')

    // 关键断言：重新拉一次列表 —— 证明它真的落盘了，不只是响应体好看
    const listRes = await get('/api/accounts')
    const list = (await listRes.json()) as { accounts: Array<{ id: string; idp?: string }> }
    expect(list.accounts).toHaveLength(1)
    expect(list.accounts[0].idp).toBe('ApiKey')
  })

  it('导入成功后自动拉一次真实额度 —— 手机端不再停在 0/0（与桌面端对称）', async () => {
    // 病灶:`importApiKey.ts` 只写额度**占位值**({ current: 0, limit: 0 },注释
    // 「导入后由调用方触发 check」)。桌面端 AddAccountDialog 有 `void checkAccountStatus(id)`,
    // 面板此前完全没有这一步 ⇒ 手机端导入的账号一直显示 0/0 直到用户手动点刷新。
    const res = await post('/api/accounts', { apiKeys: KEY_A })
    expect(res.status).toBe(200)

    // fire-and-forget:响应先回,额度刷新在后台跑(20 个 key 不该串 20 次上游往返阻塞手机端)
    await vi.waitFor(() => expect(checkCalledIds).toContain('acc-new-1'), { timeout: 2000 })
  })

  it('一条都没导进去时不触发额度刷新（不白打一次上游）', async () => {
    verifyResult = async () => ({ state: 'INVALID', success: false, error: '密钥无效或已吊销' })

    const res = await post('/api/accounts', { apiKeys: KEY_A })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { imported: number }).imported).toBe(0)

    await new Promise((r) => setTimeout(r, 120))
    expect(checkCalledIds).toHaveLength(0)
  })

  it('重复粘贴同一个 key → 不产生第二条记录', async () => {
    expect(
      ((await (await post('/api/accounts', { apiKeys: KEY_A })).json()) as { imported: number })
        .imported
    ).toBe(1)

    const second = (await (await post('/api/accounts', { apiKeys: KEY_A })).json()) as {
      imported: number
      results: Array<{ code: string }>
    }
    expect(second.imported).toBe(0)
    expect(second.results[0].code).toBe('ALREADY_EXISTS')

    const list = (await (await get('/api/accounts')).json()) as { accounts: unknown[] }
    expect(list.accounts).toHaveLength(1)
  })

  it('响应体绝不含密钥明文（label 是掩码）', async () => {
    const res = await post('/api/accounts', { apiKeys: KEY_A })
    const text = await res.text()
    expect(text).not.toContain(KEY_A)
    expect(text).not.toContain('a'.repeat(20))
    expect(text).toContain('ksk_')
  })

  it('列表响应同样不含密钥明文（凭据不出网）', async () => {
    await post('/api/accounts', { apiKeys: KEY_A })
    const text = await (await get('/api/accounts')).text()
    expect(text).not.toContain(KEY_A)
    expect(text).not.toContain('a'.repeat(20))
  })

  it('非 VALID 态（SUSPENDED）→ 不入池，列表仍为空', async () => {
    verifyResult = async () => ({ state: 'SUSPENDED', success: false, error: '账号已被 Kiro 暂停' })
    const body = (await (await post('/api/accounts', { apiKeys: KEY_A })).json()) as {
      imported: number
      results: Array<{ code: string }>
    }
    expect(body.imported).toBe(0)
    expect(body.results[0].code).toBe('SUSPENDED')
    const list = (await (await get('/api/accounts')).json()) as { accounts: unknown[] }
    expect(list.accounts).toHaveLength(0)
  })

  it('缺 apiKeys 字段 → 400 INVALID_CREDENTIAL，不当成空导入', async () => {
    const res = await post('/api/accounts', {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CREDENTIAL')
  })

  it('只有空白行 → 400，且不写盘', async () => {
    const before = disk.read().revision
    const res = await post('/api/accounts', { apiKeys: '   \n  \n' })
    expect(res.status).toBe(400)
    expect(disk.read().revision).toBe(before)
  })

  it('未登录（无 cookie）→ 401，不得导入', async () => {
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ apiKeys: KEY_A })
    })
    expect(res.status).toBe(401)
    expect(disk.read().accounts).toEqual({})
  })

  it('缺 CSRF 头 → 401（写操作第二道闸门）', async () => {
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ apiKeys: KEY_A })
    })
    expect(res.status).toBe(401)
  })

  it('手机连点两次并发提交同一批 → 盘上只有一条记录', async () => {
    const [a, b] = await Promise.all([
      post('/api/accounts', { apiKeys: KEY_A }),
      post('/api/accounts', { apiKeys: KEY_A })
    ])
    const bodyA = (await a.json()) as { imported: number }
    const bodyB = (await b.json()) as { imported: number }

    // 刻意**不**断言两个响应的 imported 相等：body 读取是异步的，第二个请求可能在
    // 第一个执行完之后才进 handler ⇒ 走的是 mutator 内判重（imported=0）而非
    // single-flight 共享（imported=1）。两条路径都正确，断言其中一条就是在测时序巧合。
    // 承重的不变量只有一个 —— 无论走哪条路径，账号只能有一条。
    expect(bodyA.imported + bodyB.imported).toBe(1)
    const list = (await (await get('/api/accounts')).json()) as { accounts: unknown[] }
    expect(list.accounts).toHaveLength(1)
  })

  it('GET /api/accounts 仍是列表（未被新路由抢走）', async () => {
    const res = await get('/api/accounts')
    expect(res.status).toBe(200)
    expect((await res.json()) as { accounts: unknown[] }).toHaveProperty('accounts')
  })
})
