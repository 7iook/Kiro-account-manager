/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node 直接执行 .mjs，不能写 TS 返回类型 */
/**
 * 提交前只看 Git 暂存区：命中 `src/webPanel/**` 时自动重建手机面板。
 *
 * 不用文件 mtime 判断“是否需要构建”：
 * - checkout 会刷新工作树 mtime，却不代表开发者改了面板；
 * - `.ace-tool/` 等 ignored 缓存可能比产物新，却不是提交内容。
 *
 * 暂存区是提交流程的真实输入。只有它包含面板源码变更时才付出一次 Vite 构建，
 * 其他提交只执行一次 `git diff --quiet`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message, status = 1) {
  console.error(`[pre-commit] ${message}`)
  process.exit(status)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    ...options
  })
}

const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: packageRoot,
  encoding: 'utf8'
})
if (rootResult.error) {
  fail(`无法启动 Git：${rootResult.error.message}`)
}
if (rootResult.status !== 0) {
  fail('无法定位 Git 工作树，提交已阻止。', rootResult.status ?? 1)
}

const gitRoot = rootResult.stdout.trim()
const packageRelative = relative(gitRoot, packageRoot).split(sep).join('/')
if (!packageRelative || packageRelative === '..' || packageRelative.startsWith('../')) {
  fail(`Node 包根不在 Git 工作树内：${packageRoot}`)
}

const sourcePath = `${packageRelative}/src/webPanel`
const staged = spawnSync(
  'git',
  ['diff', '--cached', '--quiet', '--diff-filter=ACMRD', '--', sourcePath],
  { cwd: gitRoot, stdio: 'inherit' }
)
if (staged.error) {
  fail(`检查暂存区失败：${staged.error.message}`)
}
if (staged.status === 0) {
  process.exit(0)
}
if (staged.status !== 1) {
  fail('检查暂存区失败，提交已阻止。', staged.status ?? 1)
}

console.log('[pre-commit] 检测到已暂存的 src/webPanel/ 变更，自动运行 `npm run build:webpanel`。')
// Windows 的 npm 是 .cmd shim，必须由 cmd.exe 解析；命令是固定字面量，不拼接外部输入。
const build =
  process.platform === 'win32'
    ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build:webpanel'])
    : run('npm', ['run', 'build:webpanel'])
if (build.error) {
  console.error(`[pre-commit] 无法启动面板构建：${build.error.message}`)
}
if (build.error || build.status !== 0) {
  console.error('[pre-commit] 面板构建失败，提交已阻止。')
  console.error('[pre-commit] 在 Kiro-account-manager 目录运行：npm run build:webpanel')
  process.exit(build.status ?? 1)
}

const entry = join(packageRoot, 'out', 'webPanel', 'index.html')
if (!existsSync(entry)) {
  console.error(`[pre-commit] 构建命令成功，但入口产物不存在：${entry}`)
  console.error('[pre-commit] 提交已阻止。请运行：npm run build:webpanel')
  process.exit(1)
}

console.log('[pre-commit] 手机面板产物已更新。')
