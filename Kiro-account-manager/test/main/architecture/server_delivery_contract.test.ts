import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EXIT } from '../../../src/main/server/config'

const ROOT = resolve(__dirname, '../../..')
const INSTALL_GUIDE = 'docs/deployment/linux-systemd.md'
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

function directive(unit: string, name: string): string {
  const line = unit.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(`${name}=`))
  if (!line) throw new Error(`systemd unit 缺少 ${name}=`)
  return line.slice(line.indexOf('=') + 1).trim()
}

interface InternalDocumentLink {
  href: string
  absolutePath: string
}

/**
 * 找出 Markdown 中指向仓库内文档的链接。
 *
 * 不把文件名当合同：文档改名并同步更新链接后仍应通过；真正承重的是链接目标存在，
 * 且链接到的文档集合覆盖所需运行语义。
 */
function internalDocumentLinks(markdown: string, sourcePath: string): InternalDocumentLink[] {
  const sourceDirectory = dirname(resolve(ROOT, sourcePath))
  const pattern = /\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g
  const links: InternalDocumentLink[] = []

  for (const match of markdown.matchAll(pattern)) {
    const href = match[1] ?? match[2]
    if (href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) {
      continue
    }

    const target = href.split(/[?#]/, 1)[0]
    if (!/\.md$/i.test(target)) continue

    const decodedTarget = decodeURIComponent(target)
    links.push({
      href,
      absolutePath: decodedTarget.startsWith('/')
        ? resolve(ROOT, decodedTarget.slice(1))
        : resolve(sourceDirectory, decodedTarget)
    })
  }

  return links
}

function documentLinkResolves(link: InternalDocumentLink): boolean {
  const repositoryRelativePath = relative(ROOT, link.absolutePath)
  const staysInsideRepository =
    repositoryRelativePath !== '..' &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath)
  return (
    staysInsideRepository && existsSync(link.absolutePath) && statSync(link.absolutePath).isFile()
  )
}

function coversTlsExposureGuidance(markdown: string): boolean {
  return [
    /\bTLS\b/i,
    /\bKIRO_TRUSTED_TLS_PROXY_IPS\b/,
    /\bX-Forwarded-For\b/i,
    /防火墙/,
    /\/panel\/readyz/
  ].every((required) => required.test(markdown))
}

function coversDataMigrationGuidance(markdown: string): boolean {
  return [
    /桌面.*Linux|Linux.*桌面/,
    /\bkiro-accounts\.json\b/,
    /Get-FileHash|sha256sum/,
    /复制/,
    /回退/
  ].every((required) => required.test(markdown))
}

describe('服务器生产交付合同', () => {
  it('npm 发布脚本串起构建与制品组装，运行脚本保留 source map', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.engines.node).toBe('^20.19.0 || >=22.12.0')
    expect(pkg.scripts['release:server']).toContain('npm run build:server')
    expect(pkg.scripts['release:server']).toContain('scripts/package-server-release.mjs')
    expect(pkg.scripts['start:server']).toBe('node --enable-source-maps out/server/index.js')
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
    const prevented = directive(unit, 'RestartPreventExitStatus').split(/\s+/).map(Number)
    expect(prevented).toEqual([EXIT.USAGE, EXIT.DATA_ERROR, EXIT.CANNOT_CREATE, EXIT.CONFIG])
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

  it('内部文档链接与语义扫描器能区分有效、无效和无关样本', () => {
    const links = internalDocumentLinks(
      [
        '[existing](./linux-systemd.md)',
        '[missing](./definitely-not-present.md)',
        '[external](https://example.com/manual.md)',
        '[section](#readiness)'
      ].join('\n'),
      INSTALL_GUIDE
    )
    expect(links.map((link) => link.href)).toEqual([
      './linux-systemd.md',
      './definitely-not-present.md'
    ])
    expect(links.map(documentLinkResolves)).toEqual([true, false])

    const tlsExposureSample = [
      '# TLS 前置',
      'KIRO_TRUSTED_TLS_PROXY_IPS',
      'X-Forwarded-For',
      '防火墙',
      '/panel/readyz'
    ].join('\n')
    expect(coversTlsExposureGuidance(tlsExposureSample)).toBe(true)
    expect(
      coversTlsExposureGuidance(tlsExposureSample.replace('X-Forwarded-For', 'Forwarded'))
    ).toBe(false)

    const migrationSample = [
      '# 桌面数据迁移到 Linux',
      '复制 kiro-accounts.json',
      'Get-FileHash / sha256sum',
      '失败回退'
    ].join('\n')
    expect(coversDataMigrationGuidance(migrationSample)).toBe(true)
    expect(coversDataMigrationGuidance(migrationSample.replace('失败回退', '迁移完成'))).toBe(false)
  })

  it('安装文档固定嵌套目录、版本、制品和 readiness 非重启语义', () => {
    const guide = read(INSTALL_GUIDE)
    expect(guide).toContain('Kiro-account-manager/')
    expect(guide).toContain('^20.19.0 || >=22.12.0')
    expect(guide).toContain('npm run release:server')
    expect(guide).toContain('npm ci --omit=dev')
    expect(guide).toContain('RELEASE.json.sourceTreeDirty')
    expect(guide).toContain('不得重启服务')

    const documentLinks = internalDocumentLinks(guide, INSTALL_GUIDE)
    const unresolved = documentLinks
      .filter((link) => !documentLinkResolves(link))
      .map((link) => link.href)
    expect(
      unresolved,
      `安装文档含未解析到仓库真实文件的内部文档链接：${unresolved.join(', ')}`
    ).toEqual([])

    const linkedGuidance = documentLinks
      .map((link) => readFileSync(link.absolutePath, 'utf8'))
      .join('\n')
    expect(
      coversTlsExposureGuidance(linkedGuidance),
      '安装文档没有把读者引到覆盖 TLS、受信转发头、防火墙和 readiness 的真实文档'
    ).toBe(true)
    expect(
      coversDataMigrationGuidance(linkedGuidance),
      '安装文档没有把读者引到覆盖桌面数据复制、校验与回退的真实文档'
    ).toBe(true)

    const verification = read('docs/deployment/verification.md')
    expect(verification).toContain('unverified:')
    expect(verification).toContain('numFailedTests=0')
  })
})
