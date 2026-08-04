/**
 * 跨端同步测试共用夹具。
 *
 * 提取原因:C1（STALE 重放）与 A-I2/B-I1/I3（广播反检 / 设置副作用 / 兜底）必须放在不同文件 ——
 * flushSaveImmediately 的 finally 里有**故意不阻塞调用方**的 fire-and-forget 对账
 * （生产上正确:不能让用户的保存等待一次对账读盘）,它会跨用例边界落到下一个用例的 fake 盘面上。
 * vitest 按文件隔离,拆文件是真隔离;在同一文件里塞 sleep 只是掩盖。
 */
import { vi, type Mock } from 'vitest'
import type { Account } from '@/types/account'

export function mkAcc(id: string, token = 'tok'): Account {
  return {
    id,
    email: `${id}@example.com`,
    idp: 'BuilderId',
    // 必须有 machineId:loadFromStorage 对缺失 machineId 的账号会**生成并触发 saveToStorage**
    // （accounts.ts:2259 needsSave）。少了它,每个用例 load 完就无端处于"有未落盘编辑"状态,
    // 把被测场景污染成 dirty 窗口。真实盘面上的账号一律带 machineId,故补齐才是保真。
    machineId: `machine-${id}-0123456789abcdef`,
    credentials: {
      accessToken: token,
      csrfToken: '',
      refreshToken: 'rt',
      clientId: 'cid',
      clientSecret: 'csec',
      region: 'us-east-1',
      expiresAt: Date.now() + 3600_000,
      authMethod: 'sso',
      provider: 'BuilderId'
    },
    subscription: { type: 'FREE', title: 'FREE' },
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now()
  } as Account
}

/** makeFakeMain 的返回形状（显式声明:eslint 要求导出函数有返回类型） */
export type FakeMain = {
  disk: Record<string, unknown>
  api: {
    loadAccounts: Mock
    saveAccounts: Mock
    setProxy: Mock
    updateTrayLanguage: Mock
    getAppVersion: Mock
    triggerBackgroundRefresh: Mock
  }
  externalWrite: (mutate: (d: Record<string, unknown>) => Record<string, unknown>) => void
}

/**
 * 模拟 main 侧 electron-store + applyAccountDataMutation 的 revision 仲裁。
 * 真实实现见 src/main/accountService/state.ts:applyAccountDataMutation。
 */
export function makeFakeMain(initial: Record<string, unknown>): FakeMain {
  const disk: Record<string, unknown> = { revision: 5, ...initial }

  const api = {
    loadAccounts: vi.fn(async () => JSON.parse(JSON.stringify(disk))),
    saveAccounts: vi.fn(async (data: Record<string, unknown>) => {
      const { expectedRevision, originId, ...blob } = data
      void originId
      const cur = disk.revision as number
      if (typeof expectedRevision === 'number' && expectedRevision !== cur) {
        return { ok: false as const, code: 'STALE_REVISION' as const, currentRevision: cur }
      }
      const next = cur + 1
      for (const k of Object.keys(disk)) delete disk[k]
      Object.assign(disk, blob, { revision: next })
      return { ok: true as const, revision: next }
    }),
    setProxy: vi.fn(async () => ({ normalizedUrl: undefined })),
    updateTrayLanguage: vi.fn(),
    getAppVersion: vi.fn(async () => '1.7.6'),
    triggerBackgroundRefresh: vi.fn(async () => ({ success: true }))
  }

  ;(globalThis as unknown as { window: Record<string, unknown> }).window =
    (globalThis as unknown as { window?: Record<string, unknown> }).window || {}
  ;((globalThis as unknown as { window: Record<string, unknown> }).window as { api?: unknown }).api = api

  /** 模拟 main 侧权威源直写（ProactiveRenewal / 关窗 flush 等,不带 expectedRevision） */
  const externalWrite = (mutate: (d: Record<string, unknown>) => Record<string, unknown>): void => {
    const next = mutate(JSON.parse(JSON.stringify(disk)))
    const rev = (disk.revision as number) + 1
    for (const k of Object.keys(disk)) delete disk[k]
    Object.assign(disk, next, { revision: rev })
  }

  return { disk, api, externalWrite }
}

/** store 全量归位(含设置类字段,否则上个用例的 interval/theme 会被误判为"跨端改了设置") */
export const CLEAN_STATE = {
  accounts: new Map(),
  groups: new Map(),
  tags: new Map(),
  activeAccountId: null,
  currentRevision: 0,
  isSyncing: false,
  syncError: null,
  autoSwitchEnabled: false,
  autoSwitchInterval: 5,
  autoRefreshEnabled: true,
  autoRefreshInterval: 5,
  theme: 'default',
  darkMode: false,
  proxyEnabled: false,
  proxyUrl: ''
} as const
