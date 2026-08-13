/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node 直接执行 .mjs，不能写 TS 返回类型 */
/**
 * 安装仓库自带的提交钩子。
 *
 * Node 包位于 Git 根的下一层，不能假设 `.git/` 在 package.json 旁边。
 * `git rev-parse --git-path hooks` 同时兼容普通 clone 与 linked worktree。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANAGED_MARKER = '# managed-by: kiro-account-manager webpanel-build'
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  return spawnSync('git', args, {
    cwd: packageRoot,
    encoding: 'utf8'
  })
}

const rootResult = git(['rev-parse', '--show-toplevel'])
if (rootResult.error) {
  console.warn(
    `[git-hooks] 未找到 Git，跳过本地钩子安装：${rootResult.error.message}\n` +
      '[git-hooks] 发布包或生产依赖安装不需要提交钩子。'
  )
  process.exit(0)
}
if (rootResult.status !== 0) {
  console.log('[git-hooks] 当前目录不在 Git 工作树内，跳过本地钩子安装。')
  process.exit(0)
}

const gitRoot = rootResult.stdout.trim()
const hookScript = join(packageRoot, 'scripts', 'pre-commit-webpanel.mjs')
const hookScriptRelative = relative(gitRoot, hookScript).split(sep).join('/')
if (
  !hookScriptRelative ||
  hookScriptRelative === '..' ||
  hookScriptRelative.startsWith('../') ||
  /["$`\r\n]/.test(hookScriptRelative)
) {
  console.error(`[git-hooks] 无法生成安全的仓库相对脚本路径：${hookScriptRelative}`)
  process.exit(1)
}

// 只给本仓源码 checkout 装钩子；若本包作为依赖落在别人的 node_modules，绝不改宿主仓库。
const manifestRelative = relative(gitRoot, join(packageRoot, 'package.json')).split(sep).join('/')
const trackedManifest = git([
  'ls-files',
  '--error-unmatch',
  '--',
  `:(top,literal)${manifestRelative}`
])
if (trackedManifest.error) {
  console.error(`[git-hooks] 核验 package.json 归属失败：${trackedManifest.error.message}`)
  process.exit(1)
}
if (trackedManifest.status !== 0) {
  console.log('[git-hooks] 当前包不是该 Git 工作树的已跟踪源码，跳过本地钩子安装。')
  process.exit(0)
}

const configuredHooksPath = git(['config', '--path', '--get', 'core.hooksPath'])
if (configuredHooksPath.error) {
  console.error(`[git-hooks] 读取 core.hooksPath 失败：${configuredHooksPath.error.message}`)
  process.exit(1)
}
if (configuredHooksPath.status !== 0 && configuredHooksPath.status !== 1) {
  console.error('[git-hooks] 读取 core.hooksPath 失败。')
  process.exit(configuredHooksPath.status ?? 1)
}

let hooksDir
if (configuredHooksPath.status === 0 && configuredHooksPath.stdout.trim()) {
  const configured = configuredHooksPath.stdout.trim()
  hooksDir = isAbsolute(configured) ? configured : resolve(gitRoot, configured)
} else {
  const hooksResult = git(['rev-parse', '--git-path', 'hooks'])
  if (hooksResult.error) {
    console.error(`[git-hooks] 定位 Git hooks 目录失败：${hooksResult.error.message}`)
    process.exit(1)
  }
  if (hooksResult.status !== 0) {
    console.error('[git-hooks] 定位 Git hooks 目录失败。')
    process.exit(hooksResult.status ?? 1)
  }
  const reported = hooksResult.stdout.trim()
  hooksDir = isAbsolute(reported) ? reported : resolve(packageRoot, reported)
}

const hookPath = join(hooksDir, 'pre-commit')
const wrapper =
  '#!/bin/sh\n' +
  `${MANAGED_MARKER}\n` +
  'repo_root="$(git rev-parse --show-toplevel)" || exit 1\n' +
  `exec node "$repo_root/${hookScriptRelative}"\n`

if (existsSync(hookPath)) {
  const current = readFileSync(hookPath, 'utf8')
  if (!current.includes(MANAGED_MARKER)) {
    console.error(
      `[git-hooks] 已存在非本项目管理的 pre-commit，拒绝覆盖：${hookPath}\n` +
        '[git-hooks] 请先合并两个钩子的职责，再重新运行：node scripts/install-git-hooks.mjs'
    )
    process.exit(1)
  }
  if (current === wrapper) {
    chmodSync(hookPath, 0o755)
    console.log(`[git-hooks] pre-commit 已是最新：${hookPath}`)
    process.exit(0)
  }
}

mkdirSync(hooksDir, { recursive: true })
writeFileSync(hookPath, wrapper, 'utf8')
chmodSync(hookPath, 0o755)
console.log(`[git-hooks] 已安装 pre-commit：${hookPath}`)
