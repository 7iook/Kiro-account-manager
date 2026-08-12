# conf ESM interop —— 服务端产物启动即炸(退出码 69)

> 增量写入。任务开始 2026-08-12。分支实际在 `7c63d4c`(不是派单说的 `3adda90`,后者是其父)。

## 1. 现象复核(已亲验)

- `require('conf')` → `typeof object` · `keys ['__esModule','default']` · `callable false` · `.default` 是 function。
- `conf@15.0.2`:`"type":"module"` · 无 `main` · `exports` 只有 `types` + `default`。纯 ESM,确认。
- node v22.20.0。
- `out/server/index.js:6` = `const Conf = require("conf")`,**无任何 interop 包装**;`:311` = `new Conf({...})` → 必炸。

其它 external 复核(全部按命名空间消费,健康):
`uuid` object/`v4` function · `undici` object/`fetch` function · `node-forge` object/`pki` object ·
`js-tiktoken` object · `socks` object。**只有 `conf` 是 default-import 消费**,故只有它炸。

## 2. 根因比派单描述的更上游

派单把根因定位在「call site 缺 interop」。实测产物里 rollup **确实**发了 interop 助手 ——
但只发给 `import * as` 形态(`_interopNamespaceDefault`,产物 :23/:39-49 命中 11 处),
`import Conf from 'conf'` 这种 **default import 一个都没有**。

这不是 rollup 漏了,是 `output.interop` 的默认值 `'default'` 的语义:
它**假定所有 external 都是 CJS**,`require(x)` 的返回值本身就是 default 导出。
对真 CJS 包成立,对真 ESM 包(`conf`)不成立 —— `require(真ESM)` 返回的是带
`.default` 的命名空间对象。

于是这不是 `conf` 一个包的问题,而是**产物边界上对所有 external 的一条错误假设**:
今天只有 `conf` 用 default import 所以只炸它,明天任何人 `import X from '<ESM-only包>'`
都会得到同一个形态 —— 而失败点在函数体内,构建绿、顶层 import 绿。

## 3. 采取的方向:**第四个** —— 修在构建边界(rollup `output.interop: 'auto'`)

派单给了三条路,我选了第四条,理由是前三条都在处理**症状的位置**,而不是那条错误假设:

- **选项 1(调用点 interop)**:`(Conf as any).default ?? Conf` 能让今天这一处变绿,
  但错误假设仍留在产物边界上,对**每个** external 都成立。下一个 ESM-only 包
  以完全相同的方式复发,且构建绿 / 顶层 require 绿 / 只在执行到那行才炸。
  它还要求在业务源码里写一句只为迁就打包器的类型断言 —— 那是 §0.18 信号 2
  (改本来是对的代码去迁就错的东西)。
- **选项 2(打包 conf 进产物)**:与既有闸门直接冲突 ——
  `server_build_target.test.ts:~370` 已断言 `require('conf')` 必须留在产物里,
  理由写明「conf 是 ESM-only,内联进 CJS 产物会引入难查的互操作差异」。
  且 `accountStorePort.ts` 头段那条「服务端能读桌面写的字节是**结构性成立**的」
  论证,依赖两端走**同一个 conf 实例**;打包进去就变成两份代码,
  兼容性从结构性退化成「我维持的」。
- **选项 3(产物改 ESM)**:`webPanelAssetRoot.ts:88` 用 `__dirname`(已复核),
  ESM 下不存在,失败形态是「启动正常、有人访问面板时才 404/炸」——
  比本缺陷更难归因。`vite.server.config.ts` 头段已用整节把这条定为硬约束。
- **选项 4(采用)**:`output.interop: 'auto'` 让 rollup 对每个 default import 发
  `e && e.__esModule ? e : { default: e }` 探测助手。**两个方向都对**:
  真 ESM 取 `.default`,真 CJS 包一层。一行配置,零业务代码改动,
  且天然覆盖「下一个 ESM-only 包」。

受控实验(`tmp-interop-probe.mts`,已删):同一份最小样本
(`import Conf from 'conf'` + `new Conf()`),只改 `interop` 一个变量 ——
`'default'` → `const Conf = require("conf"); new Conf({})`(炸);
`'auto'` → `_interopDefault` + `new Conf__default.default({})`(对)。**结果翻转 = 根因确认**。

## 4. 验证证据(全部真跑)

| 项 | 命令 | 结果 |
|---|---|---|
| 红(修前) | `npx vitest run test/main/architecture/server_bundle_esm_interop.test.ts` | **failed 3 / passed 1**;L2 报 `TypeError: Conf is not a constructor` at `createConfAccountStore (out/server/index.js:311)` → `assembleServer` → `bootstrap` —— **与退出码 69 同一处栈**,即红的理由正确 |
| 绿(修后)· 本组+既有 | `npx vitest run ...esm_interop... ...server_build_target...` | **passed 26 / failed 0 / skipped 0**(skipped=0 证明 L2/L3 真跑了,没被 skipIf 静默跳过) |
| 全量 | `npx vitest run --reporter=json` | **passed 1525 / failed 0 / skipped 0**(基线 1521,+4 为本组新增) |
| 构建 | `npm run build:server` | **exit 0**;产物 :23 `_interopDefault` · :42 `Conf__default` · :316 `new Conf__default.default({` |
| typecheck | `npm run typecheck:node` | **exit 0** |
| **真启动** | `node out\server\index.js`(KIRO_DATA_DIR=临时目录) | **进程存活不退**;`[server] 就绪。面板: http://127.0.0.1:58070/panel`。修前同一命令 **exit 69 + Conf is not a constructor** |
| 面板真出内容 | `Invoke-WebRequest http://127.0.0.1:5599/panel` | **HTTP 200 · 634 字节 · 含 `<html`** —— 顺带证明 `__dirname` 资源定位仍成立(即选项 3 会破坏的正是这条) |

退出码一律用 `*> file` 重定向后读 `$LASTEXITCODE`,未用管道。

## 5. 回归测试为什么抓得到这一类(而顶层 import 抓不到)

新增 `test/main/architecture/server_bundle_esm_interop.test.ts`,三层:

- **L1** 钉 `vite.server.config.ts` 的 `output.interop === 'auto'`(有人改回默认值即红)。
- **L2(最承重)** 从**真实产物**里 `require` 出 `bootstrap()` 并**真启动一台服务端**
  (端口 0 + 预置 adminKey + 临时数据目录),再对 store 做 set/get 往返 +
  `set(k, undefined)` → delete 的端口契约 + 数据文件真落在指定目录,最后 `shutdown()`。
  **判据刻意不是「模块能不能 import」** —— 上一轮 `require(产物)` 得到 `LOADED_OK`
  是真读数,但 `new Conf()` 在 `bootstrap` 的装配步骤里,顶层加载永远碰不到它。
  断言点位置错了,不是结论错了。
- **L3(治这一类)** 扫产物里所有第三方 `const X = require("pkg")`,凡是被
  **当可调用值使用**(`new X(` / `X(`)的,就真 `require` 一次确认它可调用;
  不可调用且 `.default` 可调用 = ESM-only 缺 interop 的特征形态 → 红。
  **下一个 ESM-only 包会被同一条抓到**,不需要有人记得回来加断言。
  另配自检用例(不带 skipIf):缺 interop 的样本必被抓、`'auto'` 的正确形态不误报、
  内建模块被排除 —— 防止扫描器哪天失效变成恒绿(本仓 E-052 母题)。

## 6. 其它 external 复核(不是「相信派单」,是实测)

`uuid` / `undici` / `node-forge` / `js-tiktoken` / `socks` 全部按**命名空间**消费
(`import * as` → rollup 发 `_interopNamespaceDefault`),形态健康。
全仓扫 `^import X from '<裸包名>'`:`src/main` 与 `src/shared` 里**只有**
`accountStore.conf.ts:44` 一处是第三方 default import,其余全是 node 内建
(`http`/`fs`/`crypto`/`net`)—— 对内建 rollup 的 CJS 假设永远成立。
故「只有 conf 炸」这条结论有全仓依据,不是只看了报错那一处。

## 7. 两个依赖侧缺陷:我实测的结论与派单描述**有出入**(未改任何依赖文件)

**我没有改 `package.json` / `package-lock.json`** —— 按要求留给你审。
我的 diff 只有两个文件:`vite.server.config.ts`(+46 行,一处 `interop: 'auto'` + 注释)
与新增 `test/main/architecture/server_bundle_esm_interop.test.ts`。
(工作区另有 `package-lock.json` / `src/main/server/adminKeyStore.ts` / 其测试的改动,
**不是我做的** —— 进场时就在,我没碰。)

### 7.1 lockfile 缺 root `conf`:**是真的,但它不阻塞服务端**(与派单判断不同)

复核(`git show HEAD:./package-lock.json`):
- root `packages[""].dependencies.conf` → **ABSENT**(派单说的成立)
- 但 `packages["node_modules/conf"]` → **present 且 `dev` 标记为 false**

关键在第二条:`conf` 是 `electron-store@11.0.2` 的**生产**依赖
(实测 `electron-store` 的 `dependencies` = `{conf:^15.0.2, type-fest:^5.0.1}`),
而 `electron-store` 在 root `dependencies` 里。npm 会把它**提升到 node_modules 顶层**。

**实测判据(不是推理)**:用 **HEAD 的** package.json + package-lock.json 建一棵
`npm ci --omit=dev` 树 → `node_modules/conf` **存在**,
`require.resolve('conf')` → `<tree>/node_modules/conf/dist/source/index.js`;
把本轮产物拷进去真启动 → **面板起来、进程存活**(`[server] 就绪 ... :56382/panel`)。

即:**「promotion 只落一半」当前不产生可观测故障**,因为传递依赖已经把 `conf` 放在了
解析得开的位置。但这不代表 promotion 无意义 —— 它是**显式契约**:
今天 `conf` 能解析开是 `electron-store` 的副作用,而 `electron-store` 是**桌面专属**
包。哪天有人把 `electron-store` 挪进 devDependencies(服务端不需要它,这是很自然的
清理动作),`conf` 就会一起消失,而服务端**启动即 MODULE_NOT_FOUND**。
现有闸门 `server_build_target.test.ts` 已断言 `pkg.dependencies.conf` 必须存在 ——
它守的正是这条,而 lockfile 没跟上等于闸门只覆盖了 package.json 一侧。

**我的建议**:把工作区里那 55 行 lockfile 改动提交(它就是 `npm install` 对
promotion 的正常记账,我核对过 root deps 多了 `conf: ^15.0.2`、`node_modules/conf`
的 `dev` 仍是 false)。**理由是显式契约而非救火** —— 定级 B(稳定性防护),不是 A。
选项 2(打包 conf)会让 promotion 变成多余,但我没选它(理由见 §3),故 promotion 仍有意义。

### 7.2 `npm ci --omit=dev` 失败:**机制成立,但退出码不是 127**(平台差异)

派单说 exit 127。我在本机(Windows)实测得到的是 **exit 1**,且**两种不同的失败**:

1. **带 scripts 跑**:死在 `electron` 自己的 `install.js`(它要下载 electron 二进制)
   → `RequestError: read ECONNRESET`。这是**我这台机器的网络**,不是仓库缺陷,
   且它发生在 `postinstall` **之前**,会把真正的问题掩盖掉。
2. **`--ignore-scripts` 装完再单独跑 `npm run postinstall`** → 干净复现:
   ```
   > electron-builder install-app-deps
   'electron-builder' is not recognized as an internal or external command
   POSTINSTALL_EXIT=1
   ```
   且 `node_modules\.bin\electron-builder.cmd` **不存在**(实测 Test-Path False)。

**结论**:缺陷本身完全成立 —— `postinstall` 调 `electron-builder`,而它是
devDependency,`--omit=dev` 后不存在,故**文档化的服务端安装路径在 install 步就失败**。
只是**退出码按平台不同**:Windows/cmd 的「命令找不到」是 1,POSIX sh 的是 **127**
(127 正是 shell 的 "command not found" 约定)。所以派单的 127 应该是在 Linux 上量的,
和我在 Windows 上量的 1 是**同一个缺陷的两个平台读数**,不矛盾。

**我的建议(按代价从低到高)**:
- 推荐 **`postinstall` → `preinstall` 无关的独立脚本名 + 条件化**:把
  `electron-builder install-app-deps` 换成一个「仅当 electron-builder 可用时才跑」的
  形态,例如新增 `scripts.postinstall` = `node scripts/postinstall.mjs`,
  内部 `try { require.resolve('electron-builder') } catch { process.exit(0) }`。
  这样桌面开发装依赖行为不变,服务端 `--omit=dev` 不再炸。
- 或最小改动:服务端安装文档改用 `npm ci --omit=dev --ignore-scripts`。
  **但我不推荐把它当终态** —— 它要求运维记住一个额外 flag,而忘记的代价是
  一个看不懂的报错;且 `--ignore-scripts` 会顺带跳过将来任何**真正必要**的
  prod 脚本,属于把问题挪到人身上。
- 二者都属 **A 类(业务必要)**:决策卡把「关机后反代仍在服务」定为成功状态,
  而当前**运维照文档装不上**,这条链在第一步就断了。

### 7.3 顺带证实你的那条判断:`--omit=dev` **不移除 electron**

实测同一棵 prod-only 树:`node_modules/electron` **存在**(38.7.2),
`electron-builder` / `vitest` / `jsdom` **不存在**。
lockfile 里 `node_modules/electron` 的 `dev` 标记是 **false**,原因是
`@electron-toolkit/preload` 与 `@electron-toolkit/utils`(都在 root `dependencies`)
声明了 `electron: ">=13.0.0"` 的 **peerDependency**,npm 因此不把它算成纯 dev。
**你的判断成立,且不是 Windows 特有** —— 这是那两个包在任何平台上的行为。

含义(值得单独当一条风险看):`kernel_without_electron.test.ts` 与
`vite.server.config.ts:failOnElectronImport` 这两道「零 electron」闸门,
**从来没有在真正没有 electron 的环境里跑过**。它们都是**源码/产物文本级**判定,
所以仍然有效(不依赖 electron 是否安装);但「Linux 上 electron 压根不存在」这个
写进多处注释的前提,与 npm 的实际行为不符 —— 真实情况是「它存在,只是没有二进制/
没有 GUI」。这不改变闸门的正确性,但**注释里那句推理的依据是错的**,
将来有人据此推断别的结论会出错。我没有改这些注释(不在本轮范围),登记在此。

## 8. 未做 / 诚实边界

- **未改** `package.json` / `package-lock.json`(按要求)。§7.1 / §7.2 只给建议。
- **未在 Linux 上验证**。本轮所有读数都在 Windows + node v22.20.0。
  `interop: 'auto'` 是打包器行为、与平台无关(产物文本已核),但「Linux 上真启动」
  我没有环境,标注 `unverified: 无 Linux 环境`。
- **未碰** `src/main/index.ts` / `src/main/proxy/**` / `src/renderer/**`(约束)。
- **未提交**(约束):`git add` / `commit` / `stash` 全未执行。
- 反代未在本轮真启动(盘上 `proxyConfig.enabled=false`,空数据目录的默认值);
  验证覆盖到的是「进程起来 + 面板可用」,即本缺陷的失败面。
- 桌面构建复核 `npx electron-vite build` → **exit 0**,未被本改动波及。
