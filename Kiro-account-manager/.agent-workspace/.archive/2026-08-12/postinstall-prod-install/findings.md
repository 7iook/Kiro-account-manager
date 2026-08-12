# postinstall 阻断生产安装路径 — 调查与修复

> 增量写盘。任务:`npm ci --omit=dev` 因 `postinstall: electron-builder install-app-deps` 失败(POSIX 127 / Windows 1)。

## 0. 已确认事实(逐条带证据)

- `package.json:20` = `"postinstall": "electron-builder install-app-deps"`;`electron-builder` 在 devDependencies(`^25.1.8`)。→ `--omit=dev` 下二进制不存在,lifecycle 必失败。
- 既有闸门 `test/main/architecture/server_build_target.test.ts` 已断言 `electron` 必须留在 devDependencies、`conf` 必须在 dependencies,并且其头段注释已写明「electron 是 devDependency,--omit=dev 后不存在」——即本仓已把「服务端装 prod-only」当作正式契约。

## 1. 待验:本项目到底需不需要 install-app-deps

`install-app-deps` 只对 **dependencies 里的原生模块** 做 Electron ABI 重建。
候选原生路径:`tlsclientwrapper@4.2.0` → deps `koffi@^2.15.2` + `piscina@^5.1.4`。
(koffi 是 FFI,若为 Node-API/预编译则无需 rebuild。)


## 2. ⚠️ 任务前提被实测推翻(Tier 1 自纠 → 但影响结论方向,须上报)

派单说「`npm ci --omit=dev` 失败,原因是 postinstall 调 electron-builder(devDependency)不存在」。
实测复现(F:\_scratch-postinstall\prod-baseline,仅拷 package.json + package-lock.json):

- `npm ci --omit=dev` → `EXITCODE=1`(经 `*> log` + `$LASTEXITCODE` 读取,非管道)
- **但首个失败点不是 postinstall**,而是:
  ```
  npm error path F:\_scratch-postinstall\prod-baseline\node_modules\electron
  npm error command C:\Windows\system32\cmd.exe /d /s /c node install.js
  npm error RequestError: read ECONNRESET
  ```
  即 **`electron` 包本身进了 prod 树并跑它自己的 install.js**(下载 ~100MB Electron 二进制)。

### 为什么 electron 会进 --omit=dev 的树(lockfile 实证)

`package-lock.json` 里:
```
node_modules/electron        => {"version":"38.7.2","hasInstallScript":true}   ← 无 dev:true !
node_modules/electron-builder=> {"version":"25.1.8","dev":true}                ← 确实是 dev
```
`electron` 没有 `dev: true` 标记,因为两个 **生产** 依赖对它声明了 peerDependency:
- `@electron-toolkit/preload@3.0.2` → peerDependencies.electron `>=13.0.0`
- `@electron-toolkit/utils@4.0.0`  → peerDependencies.electron `>=13.0.0`

npm 7+ 自动安装 peer deps,故 electron 被算作生产依赖树的一部分,`--omit=dev` **omit 不掉它**。

### 这推翻了本仓多处已落盘的断言

`git grep "omit=dev"` 命中 7 处,其中这些逐字声称 electron 在 --omit=dev 后不存在:
- `src/main/proxy/logger.ts:7`
- `src/main/server/assembly.ts:18`
- `test/main/architecture/kernel_without_electron.test.ts:427`
- `test/main/architecture/server_build_target.test.ts:247`
- `test/main/proxy/loggerElectronDecoupling.test.ts:7`
- `vite.server.config.ts:101`

解耦工作(K-1~K-4)本身仍有价值(不下载 electron 二进制 / 不依赖 Electron ABI 才是目的),
但「--omit=dev 后 electron 不存在」这句事实是**假的**,需要修正措辞。

### 待确认(不能凭这一次 ECONNRESET 下结论)

ECONNRESET 是走 127.0.0.1:7897 代理下载 electron 二进制时的网络抖动。必须区分:
- (a) electron 进 prod 树 —— 结构性事实,lockfile 已证,与网络无关
- (b) 这一次下载失败 —— 网络偶发,重试可能成功

即使 (b) 成功,(a) 仍是缺陷:运维机上装 100MB+ Electron 二进制 + 需要能连 github release。

## 3. 受控实验:剥掉 electron 二进制下载后,postinstall 缺陷确实存在

变量只改一个:`ELECTRON_SKIP_BINARY_DOWNLOAD=1`(让 electron 的 install.js 跳过下载而成功)。

`F:\_scratch-postinstall\prod-skipbin` + `npm ci --omit=dev`:
```
> kiro-account-manager@1.7.6 postinstall
> electron-builder install-app-deps
'electron-builder' is not recognized as an internal or external command
npm error command C:\Windows\system32\cmd.exe /d /s /c electron-builder install-app-deps
EXITCODE=1
```
→ 派单描述的 postinstall 缺陷**成立**,但它是 **第二** 道墙,前面还有一道
「electron 包本身进 prod 树并下载二进制」。修 postinstall 只能让人走到第一道墙前。

**两个缺陷是独立的**(受控对照证明:固定其他变量,只放开 electron 下载 → 失败点从 electron/install.js 变为 postinstall)。

## 4. install-app-deps 到底需不需要 —— 实测答案:**不需要**

三条独立证据:

1. **`electron-builder.yml:101` 已有 `npmRebuild: false`**(2026-01-16 commit 89872d0 引入)。
   即打包时本仓已明确关闭原生模块重建。postinstall 里的 `install-app-deps` 与它语义矛盾 ——
   一边说「装依赖时按 Electron ABI 重建」,一边说「打包时不重建」。

2. **dependencies 里没有需要按 ABI 重建的原生模块**。全树扫 `binding.gyp` / `*.node`(27 命中)后分类:
   - `koffi@2.16.2` — 预编译多平台 `.node`,`index.js` 按 `<os>_<arch>` triplet 直接 require
     `./build/koffi/win32_x64/koffi.node` 等 26 个预编译产物;install 脚本是
     `cnoke.js --prebuild`(下载/取预编译,不是 gyp 编译)。且 koffi 用 Node-API(ABI 稳定)。
   - `cbor-extract@2.2.0`(cbor-x 的 **optional** dep)— `install: node-gyp-build-optional-packages`
     取平台包 `@cbor-extract/cbor-extract-win32-x64`,内含 `node.napi.node`(N-API)与
     `node.abi115.node`。有 napi 变体 ⇒ 跨 ABI 可用。
   - `@napi-rs/nice`(piscina 的 optional dep)— N-API,名字即是。
   - 其余(`@rollup/*`、`@tailwindcss/oxide`、`lightningcss`)全是 **devDependencies** 的构建工具,
     跑在 node 下,与 Electron ABI 无关。
   ⇒ **无 gyp-编译型 non-N-API 生产原生模块**。这也解释了 `npmRebuild: false` 为何一直没出事。

3. 桌面端至今**在 postinstall 真跑过 install-app-deps 的前提下**工作,但由于 (1) 打包不重建、
   (2) 所有原生件是 N-API/预编译,它做的实际工作是空的。

→ 诚实的修法比「加条件跳过」更小:**postinstall 可以直接删掉**。
   但删掉是不可逆的语义改动(未来若引入 gyp 原生模块会静默缺重建),故仍需保守取舍 —— 见 §5。

## 5. 缺陷 A(electron 进 prod 树)的机制已由权威源确认

`npm explain electron`(在完整开发树里跑,2026-08-12):
```
electron@38.7.2
node_modules/electron
  dev electron@"^38.1.2" from the root project
  peer electron@">=13.0.0" from @electron-toolkit/utils@4.0.0
  peer electron@">=13.0.0" from @electron-toolkit/preload@3.0.2
```
两个 **非 optional** peer 声明来自 **生产** 依赖(`@electron-toolkit/utils` 被
`src/main/index.ts:5` 用,`@electron-toolkit/preload` 被 `src/preload/index.ts:2` 用)。

外部证据(exa):
- npm/cli#6282 维护者 ljharb 逐字:「If it's an optional peer of a prod dep, then it's not a dev dep.」
  → 非 optional peer of prod dep **更是** prod dep。这是 npm 的设计而非 bug。
- npm/cli#7740 / #7772 同类,全部 closed as 设计如此。
⇒ 这**不是**能靠改 postinstall 解决的问题,也不是 npm bug 等修。

实测 prod 树(`F:\_scratch-postinstall\prod-skipbin\node_modules`,159 个顶层包):
```
electron          PRESENT   ← 缺陷 A
electron-builder  absent    ← dev 正确剥离
vitest / eslint   absent
conf / koffi / tlsclientwrapper / cbor-x / piscina  PRESENT (服务端要用,正确)
```
`node_modules/electron` 内容:`checksums.json, cli.js, electron.d.ts, index.js, install.js, LICENSE, package.json, README.md`
—— **无 `dist/`**(因为我用 ELECTRON_SKIP_BINARY_DOWNLOAD=1 跳过了)。
不跳过时它会去下载 ~100MB 二进制,即 §2 的 ECONNRESET。

**判定器纠正**:我曾试 `npm ci --omit=dev --dry-run` 想看理想树 —— 它列出了
electron-builder / vitest / eslint 等 906 个包,与真实安装(159 个顶层)矛盾。
`--dry-run` 报的是 lockfile 全树而非 --omit=dev 结果,**不能用作本命题的仪器**,已弃用。

## 6. 🛑 自我纠正:§4 说「install-app-deps 是空转」——**错了**,受控实验证伪

完整安装(`F:\_scratch-postinstall\full-baseline`,`npm ci` 无 flag,EXITCODE=0,耗时 9m):
```
> kiro-account-manager@1.7.6 postinstall
> electron-builder install-app-deps
  • electron-builder  version=25.1.8
  • executing @electron/rebuild  electronVersion=38.7.2 arch=x64 buildFromSource=false appDir=./
  • installing native dependencies  arch=x64
  • preparing       moduleName=cbor-extract arch=x64
  • finished        moduleName=cbor-extract arch=x64
  • completed installing native dependencies
```
它**确实做了事**:产出 `node_modules/cbor-extract/build/Release/extract.node`(111616 B)。
本仓 node_modules 里同一文件也在(2026-07-07),即桌面开发树一直靠它。
`buildFromSource=false` ⇒ 取的是预编译,不是本地 gyp 编译(故不需要 VS 工具链)。

### 关键受控对照:这个产物对「能不能用」是否必需?

固定其他变量,只比较两棵树里 `cbor-extract` 的真实解析路径与可用性:

| 树 | `build/Release/extract.node` | `node-gyp-build-optional-packages` 解析到 | `require('cbor-extract')` | `cbor-x` 编解码往返 |
|---|---|---|---|---|
| FULL(install-app-deps 跑过) | 存在 | `cbor-extract/build/Release/extract.node` | ✅ `extractStrings` 是 function | ✅ `{"a":1,"s":"x"}` |
| PROD(postinstall 失败) | **不存在** | `@cbor-extract/cbor-extract-win32-x64/node.napi.node` | ✅ 同样 ok | ✅ 同样 ok |

⇒ **两条路都能用**。`node-gyp-build-optional-packages` 的回退顺序是
「先 `build/Release`,没有则用平台包里的 `node.napi.node`(N-API,ABI 稳定)」。
install-app-deps 做的事是「把平台包的 .node 拷/建到 build/Release 并针对 electronVersion=38.7.2 对齐」;
缺了它,**纯 node 侧照样解析到 N-API 变体并正常工作**。

### 因此修正后的结论(比 §4 更精确,方向不变)

- `install-app-deps` **不是空转**(§4 错),但它产出的东西对 **纯 node 服务端** 是**不必要**的
  —— 服务端要的那条路(N-API 平台包)本来就在,且与 Electron ABI 无关。
- 对 **桌面端**,`electron-builder.yml: npmRebuild: false` 已关闭打包期重建;
  开发期 `electron-vite dev` 跑在 Electron 38 下,此时 `build/Release/extract.node`
  是按 electronVersion 对齐过的那一份 —— 所以**桌面端这条路不能随手删掉**,
  否则 Electron 主进程加载 cbor-extract 时会落到 `node.napi.node`(N-API 跨 ABI 可用,
  但这是我尚未在 Electron 运行时实测的一步,不能声称等价)。
⇒ 故「直接删 postinstall」被否决;**条件化**是正确取舍(与派单推荐一致,但理由不同:
   不是「它没用」,而是「它对 prod 树没用、对 dev 树有用」)。

## 7. 探测机制:实测选型(派单要求「说明为什么」)

四个候选在三棵树里的真实读数(`F:\_scratch-postinstall\probe-detect2.cjs`,脚本置于**仓外**以暴露 §7.1 陷阱):

| 检查 | PROD 树 | FULL 树 | REPO 树 | 可用? |
|---|---|---|---|---|
| `require.resolve('electron-builder')` 裸调 | THROW | **THROW** | **THROW** | ❌ 全假阴性 |
| `require.resolve(..., {paths:[cwd]})` | THROW | 命中 out/index.js | 命中 | ✅ |
| `require.resolve('electron-builder/package.json',{paths:[cwd]})` | THROW | 命中 | 命中 | ✅ |
| `.bin/electron-builder{,.cmd}` 存在性 | false | true | true | ✅ |

### 7.1 为什么裸 `require.resolve` 在有 dev 依赖的树里也 THROW

它按 **调用它的那个文件** 的位置向上找 `node_modules`,不是按 cwd。上表探针位于
`F:\_scratch-postinstall\`,该路径向上没有装了 electron-builder 的 node_modules ⇒ 恒 THROW。
放进仓内脚本时它恰好能工作 —— 即**这个检查是否正确取决于脚本放在哪**,
是个会静默反转的判据。**弃用**。

### 7.2 最终选:`.bin` shim 存在性(而非 require.resolve)

派单问「哪个检查真正预测该命令能不能跑」。答案是 **`.bin` shim**,理由是同构:
- npm 跑 `postinstall` 时,把 `node_modules/.bin` 前置进 `PATH`,然后交给 shell 解析命令名。
  失败信息逐字就是 `'electron-builder' is not recognized`(Windows)/ `127`(POSIX)
  —— 即**失败发生在 PATH 查找层**,不是模块解析层。
- 所以「shim 在不在」与「这条命令能不能跑」是**同一个事实**;`require.resolve` 是另一个事实
  (包的 JS 入口能不能被 import),二者可以分叉:
  包目录存在但 bin 未链接(`--no-bin-links` / 手工装)⇒ resolve 成功而命令仍失败。
- 平台差异:POSIX 用无扩展名的 `electron-builder`,Windows 用 `.cmd`(还有 `.ps1`)。
  两个都查,任一存在即认为可跑。

## 8. 修复方案(两个缺陷分开处置)

### 缺陷 B(postinstall)—— 本轮修
`scripts/postinstall.mjs`:查 `.bin` shim,缺失则打印一行说明并 `exit 0`;存在则
`spawnSync` 转发 `electron-builder install-app-deps` 并透传退出码。
`package.json` 的 postinstall 改为 `node scripts/postinstall.mjs`。

不选 `npm ci --omit=dev --ignore-scripts` 的理由(实测支撑,非只是论证):
- 本轮实测已证 prod 树里 `cbor-extract` 的 N-API 回退路径要靠 **`node-gyp-build-optional-packages`**
  这个 install 脚本(它是 cbor-extract 的 `install` 生命周期)。`--ignore-scripts` 会
  **一并跳过它** —— 那才是「静默跳过一个真正需要的生产生命周期脚本」的现成实例,
  不是假想的未来风险。(待验:见 §9 实验)
- 且它把 flag 推给运维,漏敲即回到 EXITCODE=1。

### 缺陷 A(electron 进 prod 树)—— 本轮**不修**,上报
非 npm bug(§5 维护者结论),修法都超出「改 postinstall + 加脚本」的授权面:
① 用 `--omit=peer` —— ljharb 明言会让依赖图失效,危险
② 把 `@electron-toolkit/{utils,preload}` 移进 devDependencies —— 它们被
   `src/main/index.ts` / `src/preload/index.ts` **import**,但那两条链只在桌面端跑,
   服务端 bundle 已剥离 ⇒ 技术上可行,但改的是 dependencies 归属(需要 owner 裁决)
③ `.npmrc` 里 `omit=peer` + 显式补装 —— 同 ①
后果量化:运维机每次 `npm ci --omit=dev` 会下载 ~100MB Electron 二进制,
需能连 github release(本轮 baseline 就是在这一步 ECONNRESET 挂掉的)。

## 9. 🛑 第二次自我纠正:§8 反对 `--ignore-scripts` 的那条理由被我自己的实验证伪

我在 §8 断言「`--ignore-scripts` 会跳过 cbor-extract 的 `install` 脚本
(`node-gyp-build-optional-packages`),那才是真实的静默跳过案例」。跑了才发现是**错的**。

`F:\_scratch-postinstall\prod-ignorescripts`(`npm ci --omit=dev --ignore-scripts`,
`ELECTRON_SKIP_BINARY_DOWNLOAD=1`):
```
EXITCODE=0
cbor-extract build/Release/extract.node : False   (不存在,预期)
@cbor-extract/cbor-extract-win32-x64   : node.abi115.node, node.napi.node  (平台包自带)
cbor-x roundtrip      : {"a":1}          ✅
cbor-extract          : extractStrings 是 function  ✅
conf                  : OK               ✅
koffi                 : OK               ✅
```
原因:平台包(`@cbor-extract/cbor-extract-win32-x64`、koffi 的 `build/koffi/<triplet>/`)
里的 `.node` 是**随包发布的预编译产物**,不靠 install 脚本生成 —— install 脚本只是
「挑一个/下一个」,包已在盘上时它无事可做。所以 `--ignore-scripts` 在**当下**是功能完好的。

### 修正后对两个方案的取舍(诚实版)

`--ignore-scripts` 的真实代价只剩两条,都不是「现在就坏」:
1. 把 flag 推给运维,漏敲即回到 EXITCODE=1(**当下成立**,是真实成本)
2. 未来若引入需要 install 期真工作的生产依赖,会静默跳过(**假设性**,当下无实例)

条件化 postinstall 的优势也相应缩小:它主要解决 (1) —— 默认命令就能过,不依赖运维记得加 flag。
这仍然是选它的充分理由(部署文档写的就是 `npm ci --omit=dev`,让文档里的命令真的能跑),
但我不再声称 (2) 有当下实证。派单的推荐方向成立,论证基础换成 (1)。

## 10. 修复后实测:`npm ci --omit=dev` 通了

`F:\_scratch-postinstall\fixed-prod`(拷 package.json + package-lock.json + scripts/postinstall.mjs):
```
> kiro-account-manager@1.7.6 postinstall
> node scripts/postinstall.mjs
[postinstall] 跳过 electron-builder install-app-deps：node_modules/.bin 下没有 electron-builder（它是 devDependency）。
[postinstall] 这在服务端安装（npm ci --omit=dev）下是预期的 —— 服务端跑纯 node，不需要按 Electron ABI 重建原生模块。
[postinstall] 若你是在做桌面开发并看到这行，说明 dev 依赖没装全：请改跑不带 --omit=dev / --production 的 npm ci。
added 174 packages in 5s
EXITCODE=0     ← 派单要求的判据
```
运行时依赖可解析性(prod 树内逐个 require):
```
conf OK / koffi OK / tlsclientwrapper OK / cbor-x OK / undici OK / socks OK / node-forge OK / uuid OK
electron-store THROW: Electron failed to install correctly, please delete node_modules/electron and try installing again
```
`electron-store` 挂是**缺陷 A 的下游后果**(它 require('electron') → electron 的 index.js 找不到
dist/ 就抛)。**服务端不受影响**,证据:`out/server/index.js` 的 23 个 external 里
`electron` 的唯一出现是注释(正则取上下文确认:`// 自签证书落盘目录（K-2）：装配层注入，内核不自己 require('electron')`),
且无 `electron-store` —— 它只在 `src/main/index.ts:1996` 被桌面端 `await import`。

## 11. 闸门 `test/main/architecture/postinstall_conditional.test.ts`(10 条,全绿)

不真跑 `npm ci`(prod 5-26s / full 9m + 要下 100MB 二进制 + 依赖网络 —— 放进单测套件
会让人去加 skip 而不是修,姿态同 server_build_target.test.ts 的 L3)。
改为:在临时目录造最小假树(拷真脚本 + 造假 `.bin` shim),**真 spawn** 脚本读退出码与 stdout。
四层:L1 契约(package.json 指向 / 脚本在盘 / electron-builder 仍是 dev)·
L2 缺 shim(exit 0 + 打印三件信息 + 不留 not-recognized 痕迹)·
L3 有 shim(标记文件证明真被调 + 退出码 3 被透传)·L4 判定器自检(两种条件必须给出不同结果 + shim 机制本身可用)。

### 🔴→🟢 这个闸门当场抓到我的脚本一个真 bug(不是走形式)

第一版脚本**按绝对路径检测、按裸命令名调用**:
```
const result = spawnSync(found, ['install-app-deps'], { shell: true })   // found = 'electron-builder.cmd'
```
红:`numFailedTests 4 / numPassedTests 6`。失败信息:
```
有 shim 时应透传 shim 的 0，实际 1。输出:
  • electron-builder  version=25.1.8
  ⨯ Cannot compute electron version from installed node modules
```
即裸名走了 PATH 解析 → 跑的是**仓库真实的** electron-builder,而不是临时树里那个假 shim;
「我检测到的对象」与「我执行的对象」是两个东西。假树里 marker 文件从未出现 ⇒ L3/L4 报红。

根因修法:用 `join(binDir, found)` 绝对路径启动(加引号防路径含空格)。
绿:`EXIT=0 / failed 0 / passed 10 / total 10`。

这个 bug 在真实场景下的后果:`.bin` 里有 shim 但 PATH 里另有一个不同版本的
electron-builder 时,脚本会跑错的那一个 —— 沉默且难归因。**测试先红才有意义**这条在这里是实证。

## 12. 验证矩阵(全部真跑,退出码经 `*> file` + `$LASTEXITCODE` 读取,非管道)

| # | 场景 | 树 | 结果 |
|---|---|---|---|
| 1 | `npm ci --omit=dev`(修复前) | prod-baseline | **EXITCODE=1** · 挂在 electron/install.js ECONNRESET |
| 2 | `npm ci --omit=dev`(修复前,跳二进制下载) | prod-skipbin | **EXITCODE=1** · `'electron-builder' is not recognized` |
| 3 | `npm ci`(修复前,完整) | full-baseline | EXITCODE=0 · install-app-deps 真跑(cbor-extract 111616 B) |
| 4 | `npm ci --omit=dev --ignore-scripts`(修复前) | prod-ignorescripts | EXITCODE=0 · 但功能实测无损(§9) |
| 5 | **`npm ci --omit=dev`(修复后)** | fixed-prod | **EXITCODE=0** · 打印跳过原因 · conf/koffi/tlsclientwrapper/cbor-x/undici/socks/node-forge/uuid 全部 require OK |
| 6 | **`npm ci`(修复后,完整)** | fixed-full | **EXITCODE=0** · install-app-deps **真跑**(日志逐字 `preparing/finished moduleName=cbor-extract`) |
| 7 | 闸门单测 | 仓内 | EXIT=0 · failed 0 / passed 10 |

## 13. 检查过但**不构成问题**的一项:`electron-builder.yml` 排除 `scripts/**`

`electron-builder.yml:25` 有 `- '!scripts/**'`。乍看像是「打包时脚本被排除 → postinstall 找不到它」。
实际两回事:
- `files:` 里的排除只影响**打进 app 包的内容**(运行时的 asar),不影响开发/安装期。
- `postinstall` 在 `npm ci` 时于**源码树**里跑,那时 `scripts/postinstall.mjs` 在盘上。
- 已实测:`npm run build` EXIT=0(见 §14)。且 `scripts/patch-kiro-ide.cjs` 早已存在于同一目录
  并被同样排除,这条排除本身就是**刻意的**(别把开发脚本打进安装包)。
⇒ 不需要改 electron-builder.yml。

## 14. 最终验证(全部真跑 · 退出码经 `*> file` + `$LASTEXITCODE`,非管道)

| 检查 | 命令 | 结果 |
|---|---|---|
| 派单验证 1 | `npm ci --omit=dev`(scratch: fixed-prod) | **EXITCODE=0** · conf 可 require · 打印跳过原因 |
| 派单验证 2 | `npm ci`(scratch: fixed-full) | **EXITCODE=0** · install-app-deps **真跑**(`preparing/finished moduleName=cbor-extract`,产出 extract.node 111616 B @05:29:37) |
| 派单验证 3 | `npm run build`(仓内) | **BUILD_EXIT=0** |
| 全量套件 | `npx vitest run --reporter=json` | **SUITE_EXIT=0** · failed 0 / passed **1550** / suites 475 / failedSuites 0 |
| 类型 | `npm run typecheck:node` | **TC_EXIT=0** |
| lint | `npx eslint scripts/postinstall.mjs <新测试>` | **ESLINT_EXIT=0**(先有 1 个 prettier warning,已按它的建议改) |
| 新闸门 | `npx vitest run test/main/architecture/postinstall_conditional.test.ts` | **EXIT=0** · failed 0 / passed 10 |

### prettier --check 的读数说明(避免误判成我引入的问题)

`npx prettier --check package.json <新测试>` 报 warn。追查后是**仓库既有的 CRLF 状况**,非我引入:
- `git config core.autocrlf` = `true`(全局 `C:/Program Files/Git/etc/gitconfig`)⇒ 工作区文件是 CRLF
- HEAD 里的 `package.json` 是纯 LF 且 `prettier --check` **通过**;工作区那份 87 个 CRLF、检查不通过
- 我**没碰过**的 `server_build_target.test.ts` / `kernel_without_electron.test.ts` / `vite.server.config.ts`
  同样 `prettier --check` 失败(EXIT=1)
- 我的两个新文件是纯 LF(与 git 存储形态一致);内容层面 `prettier package.json` 的输出与工作区
  **逐行零差异**(88 行全同)
⇒ 这是仓库级 EOL 现状,`npm run lint`(eslint,走 prettier 插件)对我的文件 EXIT=0。不改。

## 15. package.json 变更(派单要求显式报告)

```diff
-    "postinstall": "electron-builder install-app-deps",
+    "postinstall": "node scripts/postinstall.mjs",
```
`git diff --stat`:`1 file changed, 1 insertion(+), 1 deletion(-)`。
**依赖块零改动** —— dependencies / devDependencies 逐字未动。
新增两个未跟踪文件:`scripts/postinstall.mjs`、`test/main/architecture/postinstall_conditional.test.ts`。
未 `git add` / 未 commit / 未 stash(按派单约束)。

## 16. 留给 owner 的决策:缺陷 A(electron 进 prod 树)

本轮**未修**,因为超出「改 postinstall + 加脚本」的授权面,且需要业务裁决。
现状:运维跑 `npm ci --omit=dev` 会连带装 `electron` 并下载 ~100MB 二进制(本轮 baseline 就在这一步
ECONNRESET 挂过一次)。服务端**不加载**它(`out/server/index.js` 的 external 里 electron 只出现在注释),
所以功能不受影响,代价是安装体积/时长/需要能连 github release + `electron-store` 在 prod 树里 require 会抛。

三条候选(互斥,需 owner 选):
1. **把 `@electron-toolkit/{utils,preload}` 移进 devDependencies** —— 它们只被
   `src/main/index.ts:5` / `src/preload/index.ts:2` 用,这两条链只在桌面端跑,服务端 bundle 已剥离。
   代价:改 dependencies 归属;需确认桌面打包(`files:` 只排除 `src/*`,产物已 bundle)不受影响。**推荐**
2. `--omit=peer` —— npm 维护者 ljharb 明言会让依赖图失效。不推荐。
3. 接受现状,在部署文档写明「需要能连 github release / 会多装 ~100MB」。
