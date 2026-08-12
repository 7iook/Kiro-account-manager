import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const releaseId = `${pkg.name}-server-v${pkg.version}`
const outputRoot = resolve(process.argv[2] ?? join(repoRoot, 'out', 'release'))
const releaseRoot = join(outputRoot, releaseId)

const requiredInputs = [
  'package.json',
  'package-lock.json',
  'scripts/postinstall.mjs',
  'deploy/systemd/kiro-account-manager.service',
  'deploy/systemd/server.env.example',
  'out/server/index.js',
  'out/server/index.js.map',
  'out/webPanel/index.html'
]

for (const input of requiredInputs) {
  if (!existsSync(join(repoRoot, input))) {
    throw new Error(`缺少发布输入 ${input}；请先运行 npm run build:server`)
  }
}

if (existsSync(releaseRoot)) {
  throw new Error(
    `发布目录已存在，拒绝覆盖：${releaseRoot}\n` +
      '请先人工归档旧制品，或把新的输出根目录作为第一个参数传入本脚本。'
  )
}
mkdirSync(join(releaseRoot, 'scripts'), { recursive: true })
mkdirSync(join(releaseRoot, 'out'), { recursive: true })

for (const file of ['package.json', 'package-lock.json']) {
  cpSync(join(repoRoot, file), join(releaseRoot, file))
}
cpSync(join(repoRoot, 'scripts', 'postinstall.mjs'), join(releaseRoot, 'scripts', 'postinstall.mjs'))
cpSync(join(repoRoot, 'deploy'), join(releaseRoot, 'deploy'), { recursive: true })
cpSync(join(repoRoot, 'out', 'server'), join(releaseRoot, 'out', 'server'), { recursive: true })
cpSync(join(repoRoot, 'out', 'webPanel'), join(releaseRoot, 'out', 'webPanel'), {
  recursive: true
})

const gitCommit = git(['rev-parse', 'HEAD']) ?? 'unknown'
const sourceTreeDirty = (git(['status', '--porcelain']) ?? '').length > 0
const metadata = {
  schemaVersion: 1,
  name: pkg.name,
  version: pkg.version,
  releaseId,
  gitCommit,
  sourceTreeDirty,
  builtAt: new Date().toISOString(),
  buildNode: process.version,
  supportedNode: pkg.engines?.node ?? null,
  entrypoint: 'out/server/index.js',
  panelAssets: 'out/webPanel/',
  installCommand: 'npm ci --omit=dev',
  startCommand: 'npm run start:server'
}
writeFileSync(join(releaseRoot, 'RELEASE.json'), `${JSON.stringify(metadata, null, 2)}\n`)

const checksummed = listFiles(releaseRoot)
  .filter((file) => basename(file) !== 'SHA256SUMS')
  .sort()
const checksumLines = checksummed.map((file) => {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  return `${digest}  ${relative(releaseRoot, file).split(sep).join('/')}`
})
writeFileSync(join(releaseRoot, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`)

console.log(`[release] 已生成 ${releaseRoot}`)
console.log(`[release] 版本 ${releaseId} (${gitCommit}${sourceTreeDirty ? ', dirty' : ''})`)
console.log('[release] 交付整个目录；目标机在该目录运行 npm ci --omit=dev')

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function listFiles(root) {
  const files = []
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(root)
  return files
}
