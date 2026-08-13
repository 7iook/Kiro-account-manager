import type { ProxyConfig } from './types'

export interface ProxyConfigApplyTarget {
  getConfig: () => ProxyConfig
  updateConfig: (patch: Partial<ProxyConfig>) => void
  isRunning: () => boolean
  restartServer: () => Promise<void>
  stop: () => Promise<void>
}

export interface ApplyProxyConfigUpdateDeps {
  getLatestConfig: () => ProxyConfig
  getProxyServer: () => ProxyConfigApplyTarget | null
  persistProxyConfig: (config: ProxyConfig) => void | Promise<void>
}

export type ProxyConfigApplyMode = 'hot' | 'restart'

export interface AppliedProxyConfigUpdate {
  config: ProxyConfig
  restarted: boolean
}

export class ProxyConfigUpdateError extends Error {
  constructor(
    public readonly phase: 'apply' | 'persist' | 'rollback',
    public readonly rollbackSucceeded: boolean
  ) {
    super(`Proxy config update failed during ${phase}`)
    this.name = 'ProxyConfigUpdateError'
  }
}

function previousPatch(
  previous: ProxyConfig,
  patch: Partial<ProxyConfig>
): Partial<ProxyConfig> {
  const rollback: Partial<ProxyConfig> = {}
  for (const key of Object.keys(patch) as Array<keyof ProxyConfig>) {
    ;(rollback as Record<keyof ProxyConfig, unknown>)[key] = previous[key]
  }
  return rollback
}

async function rollbackRuntime(
  server: ProxyConfigApplyTarget | null,
  rollback: Partial<ProxyConfig>,
  mustRestart: boolean
): Promise<boolean> {
  if (!server) return true
  try {
    if (mustRestart) {
      // start() 绑定失败后 ProxyServer 仍可能暂存失败的 listener；先 stop 清理，
      // 再恢复旧 config 并重新监听，才能证明旧端口真的回来了。
      await server.stop()
    }
    server.updateConfig(rollback)
    if (mustRestart) await server.restartServer()
    return true
  } catch {
    // 失败不会被伪装成成功：布尔会进入 ProxyConfigUpdateError.rollbackSucceeded，
    // 上层据此返回明确失败并写审计；此层不持有 logger，不能凭空猜日志设施。
    return false
  }
}

async function rollbackPersistence(
  persist: ApplyProxyConfigUpdateDeps['persistProxyConfig'],
  previous: ProxyConfig
): Promise<boolean> {
  try {
    await persist(previous)
    return true
  } catch {
    // 同上：将回滚失败编码进领域错误，不吞后继续返回成功。
    return false
  }
}

export async function applyProxyConfigUpdate(
  deps: ApplyProxyConfigUpdateDeps,
  patch: Partial<ProxyConfig>,
  mode: ProxyConfigApplyMode = 'hot'
): Promise<AppliedProxyConfigUpdate> {
  const previous = deps.getLatestConfig()
  const next = { ...previous, ...patch }
  const server = deps.getProxyServer()
  const mustRestart = mode === 'restart' && server?.isRunning() === true
  const rollback = previousPatch(previous, patch)

  try {
    server?.updateConfig(patch)
    if (mustRestart) await server.restartServer()
  } catch {
    const rollbackSucceeded = await rollbackRuntime(server, rollback, mustRestart)
    throw new ProxyConfigUpdateError('apply', rollbackSucceeded)
  }

  const applied = server?.getConfig() ?? next
  try {
    await deps.persistProxyConfig(applied)
  } catch {
    const runtimeRollback = await rollbackRuntime(server, rollback, mustRestart)
    const persistenceRollback = await rollbackPersistence(deps.persistProxyConfig, previous)
    throw new ProxyConfigUpdateError('persist', runtimeRollback && persistenceRollback)
  }
  return { config: applied, restarted: mustRestart }
}
