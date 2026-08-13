import { describe, expect, it } from 'vitest'
import { ENV, EXIT, ServerConfigError, readServerConfig } from '../../../src/main/server/config'

describe('受信 TLS 前置代理环境变量', () => {
  it('未声明时保持关闭，不改变既有直连/桌面行为', () => {
    const config = readServerConfig({ [ENV.DATA_DIR]: 'C:/data' })
    expect(config.trustedTlsProxyIPs).toEqual([])
  })

  it('显式地址列表会去空白、去重，并保留精确 IP/CIDR', () => {
    const config = readServerConfig({
      [ENV.DATA_DIR]: 'C:/data',
      [ENV.TRUSTED_TLS_PROXY_IPS]: ' 127.0.0.1, ::1, 10.20.0.0/16,127.0.0.1 '
    })

    expect(config.trustedTlsProxyIPs).toEqual(['127.0.0.1', '::1', '10.20.0.0/16'])
  })

  it('非法地址拒绝启动，而不是静默忽略后退到 socket peer', () => {
    let thrown: ServerConfigError | null = null
    try {
      readServerConfig({
        [ENV.DATA_DIR]: 'C:/data',
        [ENV.TRUSTED_TLS_PROXY_IPS]: '127.0.0.1,not-an-ip'
      })
    } catch (error) {
      thrown = error as ServerConfigError
    }

    expect(thrown).toBeInstanceOf(ServerConfigError)
    expect(thrown?.exitCode).toBe(EXIT.USAGE)
    expect(thrown?.message).toContain(ENV.TRUSTED_TLS_PROXY_IPS)
  })
})
