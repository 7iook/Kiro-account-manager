/**
 * 条件化 postinstall —— 让 `npm ci --omit=dev` 这条**部署文档里写的命令**真的能跑通。
 *
 * ## 治的是什么
 *
 * 原 postinstall 是 `electron-builder install-app-deps`，而 `electron-builder` 是
 * devDependency。于是服务端安装路径第一步就炸：
 *   - POSIX  : exit 127（shell 的 command-not-found 约定）
 *   - Windows: exit 1 + `'electron-builder' is not recognized`
 * 实测锚点（2026-08-12，纯净树 `npm ci --omit=dev`）：
 *   > kiro-account-manager@1.7.6 postinstall
 *   > electron-builder install-app-deps
 *   'electron-builder' is not recognized as an internal or external command
 *   npm error command C:\Windows\system32\cmd.exe /d /s /c electron-builder install-app-deps
 *
 * ## 为什么不是「运维加 --ignore-scripts」
 *
 * 那把一个 flag 推给运维，漏敲就回到上面那个失败；而部署文档写的命令是
 * `npm ci --omit=dev`，让文档里的命令能跑是本脚本存在的理由。
 * （注：实测该 flag 在**当下**功能无损 —— 生产侧原生件都是随包预编译，
 *   install 脚本无事可做。故这里不夸大它的风险，只说它的人因成本。）
 *
 * ## 为什么用 `.bin` shim 存在性判定，而不是 `require.resolve`
 *
 * npm 跑生命周期脚本时把 `node_modules/.bin` 前置进 PATH，再交给 shell 解析命令名 ——
 * 失败发生在 **PATH 查找层**（错误原文即 `is not recognized` / 127），不是模块解析层。
 * 所以「shim 在不在」与「这条命令能不能跑」是同一个事实。
 *
 * `require.resolve('electron-builder')` 判的是另一个事实（包的 JS 入口能否被 require），
 * 二者会分叉：`--no-bin-links` 或手工装的树里，包目录在、resolve 成功，而命令仍然跑不起来。
 * 更要命的是**裸 `require.resolve` 按调用文件的位置**向上找 node_modules，不按 cwd ——
 * 实测（probe，脚本置于仓外）它在**装了 dev 依赖的完整树里同样 THROW MODULE_NOT_FOUND**，
 * 即这个判据是否正确取决于脚本放在哪，是会静默反转的假阴性来源。
 *
 * ## 为什么不干脆删掉 postinstall
 *
 * 因为 install-app-deps **不是空转**（我先猜是，被实验证伪）。完整 `npm ci` 下它真产出
 * `node_modules/cbor-extract/build/Release/extract.node`（111616 B，
 * `electronVersion=38.7.2 buildFromSource=false`）。桌面开发树一直用着这一份。
 * 而纯 node 的 prod 树缺了它照样工作 —— `node-gyp-build-optional-packages` 回退到平台包的
 * `node.napi.node`（N-API，跨 ABI 稳定）。即：**对 prod 树不必要，对 dev 树有用**，
 * 故条件化而非删除。
 *
 * ## 为什么是 .mjs 脚本而不是 shell 条件式
 *
 * 本仓主开发平台 Windows、部署目标 Linux。`&&` / `||` / `command -v` / `test -x`
 * 在两边不同形（cmd 不认 `command -v`；PowerShell 与 sh 的 `&&` 语义/可用性有别），
 * 而 npm 在 Windows 上把脚本交给 `cmd.exe /d /s /c`。`node <script>` 是两边逐字同形的唯一形状。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根 = 本脚本所在的 scripts/ 的父目录。不用 cwd：npm 保证 cwd 是包根，但显式推导更抗调用方差异。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(repoRoot, 'node_modules', '.bin')

/**
 * 开发 checkout 顺手安装提交钩子；服务端发布目录没有该脚本，故保持原安装路径不变。
 *
 * 不把安装器写进 package.json 的独立 lifecycle：服务端制品会复制 package.json，
 * 却有意只带运行必需的 postinstall.mjs。独立 lifecycle 会在目标机引用一个不存在
 * 的开发脚本，直接弄坏 `npm ci --omit=dev`。
 */
const hookInstaller = join(repoRoot, 'scripts', 'install-git-hooks.mjs')
if (existsSync(hookInstaller)) {
  const hookInstall = spawnSync(process.execPath, [hookInstaller], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (hookInstall.error) {
    console.error('[postinstall] 启动 Git hook 安装器失败：', hookInstall.error.message)
    process.exit(1)
  }
  if (hookInstall.status !== 0) {
    process.exit(hookInstall.status ?? 1)
  }
}

/**
 * 三个平台形态全查：POSIX 无扩展名 / Windows 的 cmd 与 ps1。
 * 任一存在即认为 shell 能解析到这条命令。
 */
const shims = ['electron-builder', 'electron-builder.cmd', 'electron-builder.ps1']
const found = shims.find((s) => existsSync(join(binDir, s)))

if (!found) {
  // 明确打印跳过原因。静默跳过的代价是：桌面开发者的 install 悄悄没跑 install-app-deps，
  // 之后在「加载原生模块」那一刻才炸，而现场看不出与安装有关 —— 最难归因的一类。
  console.log(
    '[postinstall] 跳过 electron-builder install-app-deps：' +
      'node_modules/.bin 下没有 electron-builder（它是 devDependency）。\n' +
      '[postinstall] 这在服务端安装（npm ci --omit=dev）下是预期的 —— ' +
      '服务端跑纯 node，不需要按 Electron ABI 重建原生模块。\n' +
      '[postinstall] 若你是在做桌面开发并看到这行，说明 dev 依赖没装全：' +
      '请改跑不带 --omit=dev / --production 的 npm ci。'
  )
  process.exit(0)
}

// 存在则原样转发，并**透传退出码** —— 桌面端真需要它成功，失败必须让 install 失败，
// 否则就成了「把一个真实故障吞掉」。
//
// 用**绝对路径**启动，不用裸命令名：裸名会走 PATH 解析，于是「我检测到的那个 shim」
// 与「实际被执行的那个可执行文件」可以是两个不同的东西。这不是假想 —— 本仓的闸门测试
// 在临时树里造了假 shim，脚本却顺着 PATH 跑了**仓库真实的** electron-builder
// （报 `Cannot compute electron version from installed node modules`）。
// 检测与调用必须指向同一个对象。
//
// 路径加引号后交给 shell：Windows 的 .cmd/.ps1 必须经 cmd 解析，且路径可能含空格。
const shimAbs = join(binDir, found)
const result = spawnSync(`"${shimAbs}"`, ['install-app-deps'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true
})

if (result.error) {
  console.error('[postinstall] 启动 electron-builder 失败：', result.error.message)
  process.exit(1)
}

// signal 终止时 status 为 null —— 当成失败，不能落成 0（那是把非正常终止报成成功）。
process.exit(result.status ?? 1)
