import { describe, expect, it } from 'vitest'

import {
  applyProxyConfigUpdate,
  ProxyConfigUpdateError,
  type ProxyConfigApplyTarget
} from '../../../src/main/proxy/applyProxyConfigUpdate'
import type { ProxyConfig } from '../../../src/main/proxy/types'

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    enabled: true,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    ...overrides
  }
}

function target(initial: ProxyConfig, running = true): {
  ref: ProxyConfigApplyTarget
  current: () => ProxyConfig
  running: () => boolean
  restartCount: () => number
  stopCount: () => number
  failNextRestart: () => void
  failNextUpdate: () => void
} {
  let current = initial
  let isRunning = running
  let restarts = 0
  let stops = 0
  let restartFailures = 0
  let updateFailures = 0
  return {
    ref: {
      getConfig: () => current,
      updateConfig: (patch) => {
        if (updateFailures > 0) {
          updateFailures--
          throw new Error('synthetic apply failure')
        }
        current = { ...current, ...patch }
      },
      isRunning: () => isRunning,
      restartServer: async () => {
        restarts++
        if (restartFailures > 0) {
          restartFailures--
          isRunning = false
          throw new Error('synthetic restart failure')
        }
        isRunning = true
      },
      stop: async () => {
        stops++
        isRunning = false
      }
    },
    current: () => current,
    running: () => isRunning,
    restartCount: () => restarts,
    stopCount: () => stops,
    failNextRestart: () => {
      restartFailures++
    },
    failNextUpdate: () => {
      updateFailures++
    }
  }
}

describe('applyProxyConfigUpdate', () => {
  it('未初始化反代时只持久化完整 next，后续构造可消费', async () => {
    let persisted = config()
    const result = await applyProxyConfigUpdate(
      {
        getLatestConfig: () => persisted,
        getProxyServer: () => null,
        persistProxyConfig: (next) => {
          persisted = next
        }
      },
      { logRequests: false }
    )

    expect(result.config.logRequests).toBe(false)
    expect(result.restarted).toBe(false)
    expect(persisted.logRequests).toBe(false)
  })

  it('hot apply 成功后才持久化并返回真实 next', async () => {
    const runtime = target(config())
    let persisted = config()
    const result = await applyProxyConfigUpdate(
      {
        getLatestConfig: runtime.current,
        getProxyServer: () => runtime.ref,
        persistProxyConfig: (next) => {
          persisted = next
        }
      },
      { logRequests: false }
    )

    expect(runtime.current().logRequests).toBe(false)
    expect(persisted.logRequests).toBe(false)
    expect(result.config.logRequests).toBe(false)
  })

  it('运行态 apply 失败时不持久化，返回 apply 阶段失败', async () => {
    const previous = config()
    const runtime = target(previous)
    runtime.failNextUpdate()
    let persisted = previous

    const error = await applyProxyConfigUpdate(
      {
        getLatestConfig: runtime.current,
        getProxyServer: () => runtime.ref,
        persistProxyConfig: (next) => {
          persisted = next
        }
      },
      { logRequests: false }
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProxyConfigUpdateError)
    expect((error as ProxyConfigUpdateError).phase).toBe('apply')
    expect(runtime.current().logRequests).toBe(true)
    expect(persisted.logRequests).toBe(true)
  })

  it('persist 失败会把 hot 运行态和盘上值都回滚，不报假成功', async () => {
    const previous = config()
    const runtime = target(previous)
    let persisted = previous
    let failPersist = true

    const error = await applyProxyConfigUpdate(
      {
        getLatestConfig: runtime.current,
        getProxyServer: () => runtime.ref,
        persistProxyConfig: (next) => {
          if (failPersist) {
            failPersist = false
            throw new Error('synthetic persist failure')
          }
          persisted = next
        }
      },
      { logRequests: false }
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProxyConfigUpdateError)
    expect((error as ProxyConfigUpdateError).phase).toBe('persist')
    expect((error as ProxyConfigUpdateError).rollbackSucceeded).toBe(true)
    expect(runtime.current().logRequests).toBe(true)
    expect(persisted.logRequests).toBe(true)
  })

  it('restart 模式在持久化前完成真实受控重启', async () => {
    const runtime = target(config())
    let persisted = config()
    const result = await applyProxyConfigUpdate(
      {
        getLatestConfig: runtime.current,
        getProxyServer: () => runtime.ref,
        persistProxyConfig: (next) => {
          persisted = next
        }
      },
      { port: 5599 },
      'restart'
    )

    expect(result.restarted).toBe(true)
    expect(runtime.restartCount()).toBe(1)
    expect(runtime.running()).toBe(true)
    expect(runtime.current().port).toBe(5599)
    expect(persisted.port).toBe(5599)
  })

  it('新端口重启失败时清理失败 listener，恢复旧配置并重新监听旧端口', async () => {
    const previous = config()
    const runtime = target(previous)
    runtime.failNextRestart()
    let persisted = previous

    const error = await applyProxyConfigUpdate(
      {
        getLatestConfig: runtime.current,
        getProxyServer: () => runtime.ref,
        persistProxyConfig: (next) => {
          persisted = next
        }
      },
      { port: 5599 },
      'restart'
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProxyConfigUpdateError)
    expect((error as ProxyConfigUpdateError).phase).toBe('apply')
    expect((error as ProxyConfigUpdateError).rollbackSucceeded).toBe(true)
    expect(runtime.stopCount()).toBe(1)
    expect(runtime.restartCount()).toBe(2)
    expect(runtime.running()).toBe(true)
    expect(runtime.current().port).toBe(5580)
    expect(persisted.port).toBe(5580)
  })

  it('新端口已监听但 persist 失败时再次受控重启回旧端口', async () => {
    const previous = config()
    const runtime = target(previous)
    let persisted = previous
    let failPersist = true

    const error = await applyProxyConfigUpdate(
      {
        getLatestConfig: runtime.current,
        getProxyServer: () => runtime.ref,
        persistProxyConfig: (next) => {
          if (failPersist) {
            failPersist = false
            throw new Error('synthetic persist failure')
          }
          persisted = next
        }
      },
      { port: 5599 },
      'restart'
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProxyConfigUpdateError)
    expect((error as ProxyConfigUpdateError).phase).toBe('persist')
    expect((error as ProxyConfigUpdateError).rollbackSucceeded).toBe(true)
    expect(runtime.restartCount()).toBe(2)
    expect(runtime.running()).toBe(true)
    expect(runtime.current().port).toBe(5580)
    expect(persisted.port).toBe(5580)
  })
})
