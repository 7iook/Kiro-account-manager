import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EXIT } from '../../../src/main/server/config'

const ROOT = resolve(__dirname, '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

function directive(unit: string, name: string): string {
  const line = unit
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${name}=`))
  if (!line) throw new Error(`systemd unit 缺少 ${name}=`)
  return line.slice(line.indexOf('=') + 1).trim()
}

describe('服务器生产交付合同', () => {
  it('npm 发布脚本串起构建与制品组装，运行脚本保留 source map', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.engines.node).toBe('^20.19.0 || >=22.12.0')
    expect(pkg.scripts['release:server']).toContain('npm run build:server')
    expect(pkg.scripts['release:server']).toContain('scripts/package-server-release.mjs')
    expect(pkg.scripts['start:server']).toBe(
      'node --enable-source-maps out/server/index.js'
    )
  })

  it('发布目录包含启动所需的完整相对路径，而不是只交付 bundle', () => {
    const packager = read('scripts/package-server-release.mjs')
    for (const required of [
      'package-lock.json',
      'scripts/postinstall.mjs',
      'out/server/index.js',
      'out/server/index.js.map',
      'out/webPanel/index.html',
      'deploy/systemd/kiro-account-manager.service',
      'RELEASE.json',
      'SHA256SUMS'
    ]) {
      expect(packager, `打包脚本未固定交付输入/产物：${required}`).toContain(required)
    }
    expect(packager).toContain('npm ci --omit=dev')
  })

  it('systemd 只按进程存活重启，不把 readiness 503 变成重启循环', () => {
    const unit = read('deploy/systemd/kiro-account-manager.service')
    expect(directive(unit, 'Type')).toBe('simple')
    expect(directive(unit, 'Restart')).toBe('on-failure')
    expect(directive(unit, 'ExecStart')).toBe(
      '/usr/bin/env node --enable-source-maps out/server/index.js'
    )

    const activeDirectives = unit
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
      .join('\n')
    expect(activeDirectives).not.toContain('/panel/readyz')
    expect(activeDirectives).not.toMatch(/HealthCheck|Watchdog|ExecStartPost/)
  })

  it('永久启动错误不重启，退出码直接来自代码的 EXIT 真源', () => {
    const unit = read('deploy/systemd/kiro-account-manager.service')
    const prevented = directive(unit, 'RestartPreventExitStatus')
      .split(/\s+/)
      .map(Number)
    expect(prevented).toEqual([
      EXIT.USAGE,
      EXIT.DATA_ERROR,
      EXIT.CANNOT_CREATE,
      EXIT.CONFIG
    ])
    expect(prevented).not.toContain(EXIT.UNAVAILABLE)
  })

  it('停止窗口覆盖 10 秒凭据排空，默认配置不公开绑定', () => {
    const unit = read('deploy/systemd/kiro-account-manager.service')
    const timeout = Number.parseInt(directive(unit, 'TimeoutStopSec'), 10)
    expect(timeout).toBeGreaterThan(10)
    expect(directive(unit, 'KillSignal')).toBe('SIGTERM')

    const env = read('deploy/systemd/server.env.example')
    expect(env).toContain('KIRO_DATA_DIR=/var/lib/kiro-account-manager')
    expect(env).toContain('KIRO_PANEL_HOST=127.0.0.1')
    expect(env).not.toMatch(/^KIRO_PANEL_HOST=0\.0\.0\.0$/m)
  })

  it('安装文档固定嵌套目录、版本、制品和 readiness 非重启语义', () => {
    const guide = read('docs/deployment/linux-systemd.md')
    expect(guide).toContain('Kiro-account-manager/')
    expect(guide).toContain('^20.19.0 || >=22.12.0')
    expect(guide).toContain('npm run release:server')
    expect(guide).toContain('npm ci --omit=dev')
    expect(guide).toContain('RELEASE.json.sourceTreeDirty')
    expect(guide).toContain('不得重启服务')
    expect(guide).toContain('tls-front-proxy.md')
    expect(guide).toContain('firewall-exposure.md')
    expect(guide).toContain('data-migration.md')

    const verification = read('docs/deployment/verification.md')
    expect(verification).toContain('unverified:')
    expect(verification).toContain('numFailedTests=0')
  })
})
