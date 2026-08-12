# Linux 冒烟测试 · 无头服务端(commit 3adda90)

> 执行者:sub-agent(执行子任务) · 日期 2026-08-12 · 环境 Windows 11 主机 + Docker(OSType=linux · Server 29.5.3)
> 被测对象:`F:\Kiro-account-manager\Kiro-account-manager` @ `3adda90`(HEAD,分支 main)
> 报告纪律:每个场景分「跑了什么(原样命令)」/「看到什么(原样输出)」/「判定」三段;判定只用三档 —— **verified** / **verified-with-caveat** / **still-unverified-because-X**。

## 0 · 环境事实(先取证,后行动)

```
> docker info --format "OSType={{.OSType}} Server={{.ServerVersion}}"
OSType=linux Server=29.5.3
EXIT=0
```

镜像:`node:22-bookworm-slim`(digest `sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`)。
选它而不是 alpine:`package.json:engines.node = ^20.19.0 || >=22.12.0`,且 alpine 是 musl —— 若日后有原生模块,glibc 才是运维默认形态。选 22 而非 20:`vite.server.config.ts` 的 `target: 'node20'` 是**语法下限**,在 22 上跑是被文档明确认可的方向。

工作区状态(**未提交项影响本轮结论,故先记录**):

```
> git status --porcelain -- src package.json package-lock.json vite.server.config.ts
 M Kiro-account-manager/package-lock.json
```

即:`src/**` / `package.json` / `vite.server.config.ts` 与 HEAD 一致,**只有 `package-lock.json` 是脏的**。这一条在场景 1 变成主要发现。

---

## 1 · 真实 `--omit=dev` 安装 · `conf` 能否解析

(执行中,见下)
## 1 · 真实 `--omit=dev` 安装 · `conf` 能否解析

### 1.1 跑了什么

`ctx/s1-install.sh`(参数 = 用哪份 lockfile),容器内 `node:22-bookworm-slim`:

```
docker run --rm --name kirosmoke-s1head -v "<ctx>:/ctx:ro" -w /work node:22-bookworm-slim \
  sh -c "mkdir -p /work && sh /ctx/s1-install.sh head"
```

脚本内容(要点):`cp package.json` + `cp package-lock.<head|wt>.json` → `npm ci --omit=dev` → 检查 `node_modules/{conf,electron,electron-store}` 是否在 → `require('electron')` → `require('/work/out/server/index.js')`。

两份 lockfile 的来源:
- `head` = `git show HEAD:Kiro-account-manager/package-lock.json`(**已提交**的那份)
- `wt` = 当前工作区的 `package-lock.json`(**未提交**,`git status` 里那个 ` M`)

### 1.2 看到什么(原样)

`s1-head.log`(全文见同目录):

```
=== node/npm 版本 ===
v22.23.2
10.9.8
=== lockfile: head ===
=== npm ci --omit=dev ===
npm warn deprecated lodash.isequal@4.5.0: ...
> kiro-account-manager@1.7.6 postinstall
> electron-builder install-app-deps
sh: 1: electron-builder: not found
npm error code 127
NPM_CI_EXIT=127
=== node_modules 里是否有 conf / electron ===
conf: PRESENT (15.0.2)
electron: PRESENT
electron-store: PRESENT
=== require('electron') 在这个环境里到底是什么 ===
REQUIRE_ELECTRON_OK type=string
=== require(out/server/index.js) ===
LOADED_OK
REQUIRE_BUNDLE_EXIT=0
```

受控对照(`s1b-head.log`,只改一个变量):

```
### A) npm ci --omit=dev --ignore-scripts ###
A_EXIT=0
A_conf=PRESENT
A_electron=PRESENT
A_BUNDLE=LOADED_OK

### B) 把 electron 整个删掉,再 require 产物 ###
B_electron=REMOVED
B_require_electron=THROWS MODULE_NOT_FOUND
B_BUNDLE=LOADED_OK
B_BUNDLE_EXIT=0

### C) 谁把 electron 拉进 prod 树 ###
kiro-account-manager@1.7.6 /work
`-- (empty)
npm error No dependencies found matching electron
```

lockfile 静态审计(`probe-devflags.ps1` / `probe-electron-why.ps1`,主机侧):

```
===== lockfile: head  lockfileVersion=3 =====
  node_modules/electron                  ver=38.7.2    dev=<no dev key>
  node_modules/electron-builder          ver=25.1.8    dev=True
  node_modules/conf                      ver=15.0.2    dev=<no dev key>
  root.dependencies count=21   root.dependencies.conf=<absent>
===== lockfile: wt =====
  root.dependencies count=22   root.dependencies.conf=^15.0.2

=== 谁把 electron 标成非 dev ===
  node_modules/@electron-toolkit/preload [peerDependencies] electron=>=13.0.0  dev=False
  node_modules/@electron-toolkit/utils   [peerDependencies] electron=>=13.0.0  dev=False
=== root prod deps 里带 electron peer 的 ===
  PROD DEP @electron-toolkit/preload peer electron=>=13.0.0
  PROD DEP @electron-toolkit/utils   peer electron=>=13.0.0
```

### 1.3 判定

**`conf` 的提升确实起作用了 —— 但不是靠 `3adda90` 提交的那份 lockfile。** 三件事分开说:

**① `conf` 在 `--omit=dev` 后确实在盘上 —— verified。** 两份 lockfile 下都 `conf: PRESENT (15.0.2)`。

**② 但 `3adda90` **提交**的 lockfile 与它的 `package.json` 不同步 —— 缺陷(still-broken)。** `package.json` 已把 `conf: ^15.0.2` 提进 `dependencies`(HEAD 里就有),而 **HEAD 的 `package-lock.json` 的 `packages[""].dependencies` 里没有 `conf`**;补上那一行的改动躺在**未提交**的工作区里(`git status` 那个 ` M package-lock.json`,diff 首行正是 `+ "conf": "^15.0.2",`)。
本轮 `head` lockfile 下 `conf` 仍然 PRESENT,是因为它经 `electron-store`(prod 依赖)传递可达 —— 也就是说**提交态下,commit message 里「conf 进 dependencies」这一半只落在 package.json,lockfile 侧仍是旧的传递可达形态**。后果:`npm ci` 用 lockfile 而不是 package.json,所以今天不炸;但两者不同步,`npm ci` 在较新 npm 上会因 lock 与 manifest 不一致而拒绝(本轮 npm 10.9.8 未拒),且哪天 `electron-store` 被移除/降级,`conf` 会随之消失 —— 而那正是这次提升要防的事。**修法是运行一次 `npm install --package-lock-only` 并提交 lockfile**,不是改代码。我没有提交(受任务约束),也没有改 lockfile。

**③ `--omit=dev` **不能**让 electron 从盘上消失 —— verified,且这是本轮最实质的新事实。** `electron` 在 lockfile 里**没有 `dev: true`**,因为两个 prod 依赖 `@electron-toolkit/preload` 与 `@electron-toolkit/utils` 把它列为 `peerDependencies`,npm 于是把它当 prod 树的一部分装下来。于是运维照文档跑 `npm ci --omit=dev` 会**装一个 ~100MB 的 electron**,而 `require('electron')` 在 Linux 上返回 **`type=string`**(即那条「Windows 上 require('electron') 返回字符串」的性质在 Linux 上**同样成立** —— 它是 electron npm 包的 `index.js` 行为,不是 Windows 特性)。
即:**「`--omit=dev` 是 electron 真正缺席的第一个环境」这条前提不成立。** 任务书与 commit message 都建立在它上面。真正验证「产物不依赖 electron」必须**显式移除** electron(上面对照 B):删掉后 `require('electron')` 抛 `MODULE_NOT_FOUND`,而产物仍 `LOADED_OK` —— **K-1~K-3 的 electron 解耦本身是成立的,verified**,只是先前的验证环境不是它自称的那个。

**④ `postinstall` 阻断 —— verified(缺陷)。** `npm ci --omit=dev` 退出码 **127**:`postinstall: electron-builder install-app-deps`,而 `electron-builder` 是 devDependency,`--omit=dev` 下不存在。所以服务器部署照 `--omit=dev` 走会**装完就失败**。`--ignore-scripts` 可绕(对照 A `A_EXIT=0`),但那不是文档里写的命令。修法在 `package.json`(不在我被授权的 `src/main/server/**` 范围内),故只报告。

---

## 2 · 🔴 阻断级缺陷:服务端**根本起不来** —— `Conf is not a constructor`

这是本轮最重要的发现,且它**不是 Linux 特有的** —— Windows 上同样发生。它把场景 4(字节兼容)与场景 5(面板能否服务)一起挡住,故先记在这里。

### 2.1 跑了什么

Linux 容器内,数据目录不存在(最简形态、四态里唯一该放行的一态):

```
KIRO_DATA_DIR=/data/absent KIRO_PANEL_PORT=0 node out/server/index.js
```

Windows 主机上同一条(独立复现,排除「容器/Linux」这个变量):

```
$d = Join-Path $env:TEMP ("kirosmoke-win-" + <guid>)
New-Item -ItemType Directory $d
$env:KIRO_DATA_DIR = $d; $env:KIRO_PANEL_PORT = "0"
node out\server\index.js *> "$env:TEMP\win-start.log"
```

### 2.2 看到什么(原样)

Linux(`s2-states.log` 场景 3a):

```
[server] 数据目录: /data/absent
[server] 未找到账号数据文件：/data/absent/kiro-accounts.json
[server] 以空账号库启动。...
========================================================================
  Web 面板管理员密钥已生成（本次是唯一一次打印，请立刻保存）
========================================================================
  adminKey: PC06WxFy5KmkBA5C5CiUgX568sLKPqBjsV47fukEp4k
  密钥文件: /data/absent/adminKey
...
[server] ⚠️ 账号上游 API 未接线：...
[server] 启动失败（退出码 69）:
Conf is not a constructor
```

Windows(`$env:TEMP\win-start.log` 尾部):

```
WIN_START_EXIT=69
...
[server] 启动失败（退出码 69）:
Conf is not a constructor
```

产物侧证据(`out/server/index.js`):

```
行 6   : const Conf = require("conf");
行 309 : const conf = new Conf({
```

`require('conf')` 的真实形状(`ctx/probe-conf-shape.cjs`,Windows 主机 node v22.20.0):

```
typeof m       = object
is function    = false
keys           = __esModule,default
typeof m.default = function
Symbol.toStringTag = Module
new m() => THROWS: m is not a constructor
new m.default() => OK
```

### 2.3 根因

`conf@15.0.2` 是**纯 ESM** 包。`vite.server.config.ts` 把 `conf` 放进 `external`(`externalDeps()` 从 `dependencies` 生成),CJS 产物于是发出裸的 `const Conf = require("conf")`。node ≥22.12 的 `require(esm)` 返回的是**模块命名空间对象**(`{__esModule, default}`,`Symbol.toStringTag === 'Module'`),**不是** default 导出本身 —— rollup 对 external 依赖没有插入 interop,所以 `new Conf(...)` 拿命名空间对象当构造器,必然抛。

源码 `src/main/persistence/accountStore.conf.ts:47` 写的是 `import Conf from 'conf'`(语义正确),坏在**打包成 CJS 后对 external ESM 依赖缺 interop**。

### 2.4 为什么此前的验证没抓到

commit message 里那条「运行时证据」是 `require('out/server/index.js')` 打出 `LOADED_OK`。它只证明**模块顶层能加载**(`require("conf")` 本身不抛),而 `new Conf()` 在 `createConfAccountStore()` 里 —— 只有**真的启动**才会执行到。本轮 `s1` 也复现了同一读数:`LOADED_OK` 与 `Conf is not a constructor` **可以同时为真**。

### 2.5 影响面

- 服务端**任何**成功启动路径都过不去(`assembly.ts` 必然构造 store)。故 `3adda90` 声称的「`node out/server/index.js` 真的能起」**不成立**。
- 反过来,四态里的**拒启**路径全部在构造 store 之前完成,所以它们能被正常验证(见场景 3,结果全对)。这也解释了为什么 3a(absent,唯一该放行的一态)是唯一炸的那个。

### 2.6 处置

修点在 `src/main/persistence/accountStorePort.ts` / `accountStore.conf.ts`(我被授权的范围)或 `vite.server.config.ts`(不在授权范围)。**判断:这不是「小而明显」的改动** —— 至少三条互斥修法,各有不同代价:
① `accountStore.conf.ts` 改 `const Conf = confModule.default ?? confModule` 形态(要处理类型,且是在源码里补打包器的洞);
② `vite.server.config.ts` 把 `conf` 从 external 移出、打进产物(改产物形态与体积,且 `conf` 拉 ajv/semver 等一串);
③ 产物改 ESM 形态(与 `__dirname` 冲突,`vite.server.config.ts` 头部已论证过不行)。
选哪条影响架构与后续维护,超出「小而明显」的边界,故**报告不改**。

**判定:still-broken —— 服务端在 Linux 与 Windows 上都无法启动成功(exit 69)。这是平台无关缺陷,不是 Linux 冒烟测试的发现,而是它顺手暴露的。**

---

## 3 · 四态数据故障 → 退出码(真 POSIX 上第一次跑)

### 3.1 跑了什么

`ctx/s2-states.sh`,容器内 root 与非 root(`node` 用户,uid 1000)两种身份:

```
docker run --rm --name kirosmoke-s2 -v "<ctx>:/ctx:ro" node:22-bookworm-slim \
  sh -c "mkdir -p /work /data && sh /ctx/s2-states.sh"
```

准备:`npm ci --omit=dev --ignore-scripts` → **`rm -rf node_modules/electron`**(让 electron 真的缺席,理由见 §1.3③)→ 逐个构造故障形态启动。`umask=0022`,root 身份 `uid=0(root)`。

### 3.2 看到什么(原样 · 摘 `s2-states.log`)

```
electron_unreachable=MODULE_NOT_FOUND

3b  KIRO_DATA_DIR 未设置                    3b_EXIT=64   「缺少必填环境变量 KIRO_DATA_DIR」
3c  KIRO_PANEL_PORT=808o                    3c_EXIT=64   「不是合法端口（需 0-65535 的整数）」
3d  垃圾字节 kiro-accounts.json             3d_EXIT=65   「无法解密或解析（已尝试 3 种形态）」
                                                          原始错误含 error:1C80006B:...wrong final block length
3e  零字节文件                              3e_EXIT=65   「文件存在但长度为 0（疑似写入被中断）」
3f  schemaVersion=999(明文 JSON)            3f_EXIT=65   「版本过新（盘上 999 > 本程序支持 1）」
3g  文件 0444 · 以 root 跑                  3g_ROOT_EXIT=69  （见下,root 绕过 W_OK)
3g  文件 0444 · 以 node(uid1000) 跑         3g_USER_EXIT=73  「账号数据文件不可写：…（EACCES）」
3h  目录 0555 · 以 node 跑                  3h_EXIT=73   「账号数据目录不可写：/data/rodir（EACCES）」
```

### 3.3 判定

**四态映射在真 POSIX 上全部按契约工作 —— verified。** 64/65/73 三族逐条命中,错误文案指向正确的排障方向(chown vs 加密密钥 vs 拷文件)。

**`not-writable` 这一族**(任务书点名「只能在 Linux 上有意义地复现」的那条)**verified**:两种真实形态都验到了 —— 文件本身 0444(exit 73)与目录 0555(exit 73),且两条错误文案不同、分别指向文件与目录。这是本轮 Windows 上无法取得的证据。

**caveat(重要且非缺陷):以 root 运行时写权限闸门形同虚设。** 3g 里 root 身份下 `accessSync(file, W_OK)` 对 0444 文件**不抛**(POSIX 语义:root 绕过权限检查),于是闸门放行、往后走到构造 store,最终死在 §2 那个 `Conf is not a constructor`(exit 69)。同一形态换成非 root 用户立刻正确拒启(73)。含义:**容器里以默认 root 跑,这道闸门不生效** —— 这不是实现缺陷(它按 POSIX 语义正确),但部署文档若不写「以非 root 服务用户运行」,决策卡 ④ 想防的「只读运行 → 定时写入静默失败」在 root 容器里仍然可能发生(区别是 root 下写也确实能成功,所以危害更小)。已在 §5 复核:非 root + 目录 700 是能正常跑通的。

---

## 4 · `0600` 密钥文件语义(唯一真正承担安全职责的那条分支,首次在真 POSIX 上执行)

### 4.1 跑了什么 / 看到什么(原样 · 摘 `s4-full.log`)

```
2   首启生成后回读               -rw------- 1 root root 44 /data/migrated/adminKey
                                 权限=600 属主=root:root
2b  chmod 644 后重启             PERM644_EXIT=69
      「adminKey 密钥文件权限过宽：… 当前为 0644，属主之外仍有权限位（044）。拒绝启动。」
2c  chmod 400 后重启             PERM400_TIMEOUT_EXIT=124（124=timeout 杀掉=起住了=放行）
                                 「[server] 就绪。面板: http://127.0.0.1:5601/panel」
2d  env 与文件不一致             CONFLICT_EXIT=69
      「adminKey 有两个不一致的来源：环境变量 KIRO_ADMIN_KEY 与密钥文件 …。拒绝启动。」
2e  env 设为 "   "(纯空白)       EMPTYENV_EXIT=69
      「环境变量 KIRO_ADMIN_KEY 已设置但为空（或只有空白字符）：拒绝启动。」
2f  非 root(node uid1000)+目录700 ASUSER_TIMEOUT_EXIT=124（起住了）
                                 -rw------- 1 node node 44 adminKey → 600 node:node
```

### 4.2 判定

**`classifyKeyFilePermission` 的 POSIX 分支 verified,且四道拒启闸门在真 POSIX 上全部生效:**

- **写入即 0600 · verified**:`writeFileSync(mode) + chmodSync + rename` 在真 ext4/overlayfs 上落地为 `-rw-------`,回读校验通过。这是 Windows 上无法取得的证据(那里 `chmod(0600)` 读回 `0o666`)。
- **`0644` 拒启 · verified**:offending 位报为 `044`,补救文案给出 `chmod 600 <file>`。**这条分支此前从未真的执行过**(Windows 上永远走 `unenforceable`)。
- **「不得更宽」而非「必须等于 0600」· verified**:`0400` 放行并正常启动 —— 即运维把权限收得更紧不会变成故障,这条设计意图成立。
- **非 root 服务用户 + 目录 700 · verified**:完整跑通,密钥落为 `600 node:node`。这是最接近真实 systemd `User=` 部署的形态。

**⚠ 但发现一条契约不符(退出码),见 §7。**

---

## 5 · 字节兼容:Windows 桌面 `conf` 写的文件 → Linux 服务端读

### 5.1 跑了什么

**没有读用户的真实数据**(`%APPDATA%\kiro-account-manager\kiro-accounts.json` 全程未被读取、未被拷贝)。改为用**仓库自己的 `conf` + `accountStorePort.ts` 的常量**在 Windows 上生成一份等价文件(`gen-store.cjs`):

```
node <linux-smoke>\gen-store.cjs <linux-smoke>\winstore
→ WROTE …\winstore\kiro-accounts.json
  SIZE 977
  SHA256 46ae804c4c9e7a9aa49e0479e2e7547b50c955efa6565db1514532e084c2f9f2
  FIRST16_HEX 7e90ef1c4f6280db433bae2f0fa53096
  BYTE16_IS_COLON true          ← conf 密文格式:iv(16B) + ':' + 密文
  NODE v22.20.0 PLATFORM win32
  READBACK_ACCOUNTS 2
```

构造参数与桌面 `electron-store` 等价:`configName: 'kiro-accounts'` · `encryptionKey = ACCOUNT_STORE_ENCRYPTION_KEY`(`'kiro-account-manager-secret-key'`)· `projectVersion: '1.7.6'`。顶层键照 `accountStorePort.ts` 头部列的真实 16 键形态写入(`accountData` / `webPanelConfig` / `webPanelAdminKey` / `proxyConfig` / …),值全为构造的假数据(`FAKE_ACCESS_TOKEN_*` / `*@example.invalid`),**不含任何真实凭据**。

然后拷进容器并启动服务端(`s4-full.sh` 场景 4)。

### 5.2 看到什么(原样)

```
sha256(linux side)  = 46ae804c4c9e7a9aa49e0479e2e7547b50c955efa6565db1514532e084c2f9f2
size                = 977
```

字节在跨平台传输后逐字节一致(与 Windows 侧生成时的 SHA256 相同)。启动后:

```
[server] 数据目录: /data/migrated
（没有出现「未找到账号数据文件」，也没有任何解密/版本告警）
  ⚠ 拷入的账号数据文件里带着**桌面端**的面板密钥，服务端**不使用**它。
    桌面那把钥匙曾在设置页展示、并随数据文件跨机搬运，暴露史未知；
```

而账号真的被读出来了(经面板 API,见 §6):

```
GET accounts(auth)  HTTP=200 bytes=278
{"accounts":[{"id":"smoke-acct-1",…,"email":"smoke1@example.invalid"},
             {"id":"smoke-acct-2",…,"email":"smoke2@example.invalid"}]}
```

### 5.3 判定

**verified-with-caveat。**

**verified 的部分**:一份由 **Windows 侧 `conf@15.0.2` + 那个硬编码密钥**写出的 `kiro-accounts.json`,被 **Linux 服务端**成功解密、通过版本闸门、装进 store,并且**两个账号经面板 API 真的被读出来了**(不只是「没报错」)。`legacyDesktopKeyPresent` 那条提示也真的触发了 —— 说明服务端确实解出了 `webPanelAdminKey` 这个顶层键。ADR-0002「直拷 `kiro-accounts.json`」这条迁移路径在跨平台方向上**成立**。

**caveat 一(承重)**:写方是**直接用 `conf`**,不是 `electron-store`。任务书认可这是等价形态(「`conf` with `configName: 'kiro-accounts'` … produces a byte-compatible file, which is the point being tested」),且 `accountStorePort.ts` 头部已核实 `electron-store@11.0.2` 是 `extends Conf` 的 83 行薄壳、加解密全在 `conf` 里。但**「真桌面 Electron 进程写的文件」这一步没有被执行** —— 严格说本轮验的是「conf(win32) → conf(linux)」,不是「electron-store(win32 · Electron 运行时) → conf(linux)」。剩余风险很小但不为零(例如 Electron 内置 node 的 crypto 若有差异)。

**caveat 二**:服务端能启动到这一步,靠的是对**容器内产物副本**打的探针补丁(§2 那个缺陷)。仓库文件零改动。补丁只改产物第 6 行(`DIFF_LINES=2`),不触碰任何解密/序列化逻辑,故不影响本节结论的有效性 —— 但它必须被记下来。

---

## 6 · 面板真的能服务(Linux 上首次)

### 6.1 跑了什么

`ctx/http-probe.cjs`(slim 镜像无 `curl`,故用 node 内建 `http` 打请求),对上节那台带迁移数据的服务端:

```
PANEL_BASE=http://127.0.0.1:5599 PANEL_KEY="<从启动日志解析>" node /ctx/http-probe.cjs
```

`out` 布局(`webPanelAssetRoot.ts` 依赖 `__dirname/../webPanel`,任务书点名的那条承重关系):

```
/work/out/          → server/  webPanel/
/work/out/server/   → index.js (649681 B)
/work/out/webPanel/ → assets  index.html
```

### 6.2 看到什么(原样)

```
[WebPanel] Started on http://127.0.0.1:5599/panel
[server] 面板已启动: http://127.0.0.1:5599/panel
[server] 反代未自动启动（盘上 proxyConfig.enabled=false autoStart=false）。可从面板手动启动。
[server] 就绪。面板: http://127.0.0.1:5599/panel

GET /panel/            HTTP=200 bytes=785 ctype=text/html; charset=utf-8
HTML_HEAD="<!doctype html>\r\n<html lang=\"zh-CN\">…"
ASSET_REF=/panel/assets/index-CUhIepbV.js
GET /panel/assets/index-CUhIepbV.js  HTTP=200 bytes=449817 ctype=text/javascript; charset=utf-8
GET /panel/assets/index-D-5Yw_XB.css HTTP=200 bytes=33340
POST login(wrong)      HTTP=401 body={"code":"UNAUTHORIZED"}
GET accounts(no auth)  HTTP=401 body={"code":"UNAUTHORIZED"}
POST login(correct)    HTTP=200 body={"ok":true}
SET_COOKIE=["kam_panel_sid=…; HttpOnly; SameSite=Strict; Path=/panel; Max-Age=86400"]
GET accounts(auth)     HTTP=200 bytes=278
ACCOUNTS_BODY={"accounts":[{"id":"smoke-acct-1",…},{"id":"smoke-acct-2",…}]}
[WebPanel] Denied GET /api/accounts from 127.0.0.1 (NO_SESSION)
[server] 收到 SIGTERM，开始停机...
[WebPanel] Stopped
[server] 已停机
SRV_EXIT=0
```

### 6.3 判定

**verified-with-caveat**(caveat 同上:探针补丁)。逐条:

- **面板应答 HTTP · verified**:`/panel/` 返 200 + 真实 HTML shell,字节数与主机上 `out/webPanel/index.html`(785 B)一致。
- **`webPanelAssetRoot` 的 `__dirname/../webPanel` 在 Linux 上解析正确 · verified**:两个静态资源都 200,且字节数与主机产物逐字相同(js 449817 / css 33340)。任务书提醒的「布局破了会表现成面板 404」**没有发生**,`out/server` 与 `out/webPanel` 的兄弟关系在容器里被保住了。
- **adminKey 真的能登进去 · verified**:错密钥 401(`{"code":"UNAUTHORIZED"}`)、无会话 401、正确密钥 200 且下发 `HttpOnly; SameSite=Strict; Path=/panel` 的会话 cookie;带 cookie 拉 `/panel/api/accounts` 得到那两个迁移进来的账号。**即「面板是服务器上唯一管理入口」这条在 Linux 上真的成立。**
- **`SIGTERM` 优雅停机 · verified**:`收到 SIGTERM → [WebPanel] Stopped → 已停机`,进程退出码 0。这是 systemd / `docker stop` 的实际路径。
- **反代未启 · 符合预期**(盘上 `proxyConfig.enabled=false`),非缺陷。**本轮未验反代真的转发流量** —— still-unverified-because:那需要真实上游凭据,且 `3adda90` 已诚实标注 token 刷新层未接线。

---

## 7 · 🟡 契约不符 → 已修:adminKey 四道拒启闸门全部退 69,运维无法区分该改哪里

### 7.1 现象(原样 · 摘 `s4-full.log`)

```
2b  chmod 644 → 权限过宽拒启          PERM644_EXIT=69
2d  env 与文件不一致                  CONFLICT_EXIT=69
2e  env 设为纯空白                    EMPTYENV_EXIT=69
```

而 `config.ts:32-38` 的退出码表逐字写着:

```
 *   64 EX_USAGE     环境变量缺失 / 非法（KIRO_DATA_DIR 未设、端口不是数字）
 *   65 EX_DATAERR   数据文件在但用不了（解不开 / 读不了 / 版本过新）
 *   69 EX_UNAVAILABLE 服务起不来（端口被占、面板/反代拒绝启动）
 *   73 EX_CANTCREAT 权限问题（数据目录或文件不可写、**密钥文件权限设不上**）
 *   78 EX_CONFIG    配置自相矛盾（**环境变量与密钥文件冲突**）
```

### 7.2 定性:(b) 实现错了 —— 不是 (a) 文档错,也不是 (c) 两套独立故障族

三条证据,每条都可独立验:

**① 文档明确承诺覆盖 adminKey 这一族,不是只承诺账号数据族。** 73 的括号里逐字写着「密钥文件权限设不上」,78 的括号里逐字写着「环境变量与密钥文件冲突」——**这两句描述的对象只能是 `adminKeyStore.ts` 的闸门**,账号数据那边既没有「密钥文件」也没有「环境变量冲突」这两个概念。故 (c)「文档本来只管数据族」不成立。

**② `EXIT.CONFIG`(78) 全仓零生产用点 —— 它是为这一族预留的,而这一族没接上。** 文件系统级检索(不依赖 git 索引,含未跟踪文件):

```
> Get-ChildItem -Path src,test -Recurse -Include *.ts,*.tsx | Select-String 'EXIT\.CONFIG|EXIT\.CANNOT_CREATE'
src\main\server\config.ts:210: throw new ServerConfigError(messageOf(e), EXIT.CANNOT_CREATE)
src\main\server\config.ts:233: EXIT.CANNOT_CREATE
test\main\server\serverAssembly.test.ts:145: const codes = [EXIT.USAGE, EXIT.DATA_ERROR, EXIT.UNAVAILABLE, EXIT.CANNOT_CREATE, EXIT.CONFIG]
```

78 唯一的出现处是**一条同义反复的测试**(断言五个常量互不相同 —— 那是 `as const` 字面量,恒真),没有任何生产代码产生它。一个「定义了、文档承诺了、却没有任何路径能产生」的退出码,是接线缺失的标志,不是设计。

**③ 机制上就是兜底吞掉了分类。** `entry.ts:214`:

```ts
const exitCode = e instanceof ServerConfigError ? e.exitCode : EXIT.UNAVAILABLE
```

而 `adminKeyStore.ts` 的四道闸门抛的全是**裸 `Error`**(修前 `git grep 'throw new'` 该文件:195/221/281/292/326/370/452 全为 `new Error`)。于是四道闸门 + 端口被占 + 面板起不来 **六件事在 `systemctl status` 里长得完全一样**。

**④ 运维视角判据(任务书给的那条)不通过。** 69 同时意味着:密钥文件权限过宽(修法 `chmod`)、编排文件里两个真源冲突(修法改 env 或删文件)、`KIRO_ADMIN_KEY` 渲染成空(修法查编排模板)、密钥文件损坏(修法删文件重启)、端口被占(修法换端口)。**五种互不相同的修法,一个码。** 决策卡「运营注册 · 启动失败反馈」要的正是「四种拒启都有可读退出信息」。

### 7.3 修法(已实施 · 在授权范围 `src/main/server/**` 内)

`src/main/server/adminKeyStore.ts`:把四道**启动期**闸门的裸 `Error` 换成 `ServerConfigError` + 分类码。零逻辑改动 —— 判据、文案、回滚行为、`rollbackOnPermissionFailure` 全未动,只给已有的抛出附上退出码。

| 闸门 | 位置 | 原 | 现 | 理由 |
|---|---|---|---|---|
| env 设了但为空 | `:195` | 69 | **64** USAGE | 环境变量**用法**错,同 `KIRO_DATA_DIR` 缺失一族 |
| env 与文件冲突 | `:221` | 69 | **78** CONFIG | 配置自相矛盾 —— 文档为它预留的那个码 |
| 密钥文件不可读(EACCES) | `:281` | 69 | **73** CANTCREAT | 权限/IO,与 `config.ts:233` 数据文件 `unreadable` 同归 73 |
| 密钥文件零字节 | `:292` | 69 | **65** DATAERR | 盘上的东西坏了,同数据族 `undecryptable` 语义 |
| 权限过宽 | `:326` | 69 | **73** CANTCREAT | 文档逐字:「密钥文件权限设不上」 |
| 写入失败 | `:370` | 69 | **73** CANTCREAT | 目录不可写,同上 |

**刻意不改的一处**:`:452` env 托管时 `set()` 拒绝轮换 —— 它不是启动期闸门,而是运行时经面板 HTTP 调 `rotateAdminKey()` 的路径。给它退出码毫无意义(它该变成一条 HTTP 错误,而且已经是了),改了反而会诱导下一个人以为那也能打死进程。

新增 import:`import { EXIT, ServerConfigError } from './config'`。无循环依赖 —— `config.ts` 只 import `../persistence/accountStorePort` 与 `node:fs`,不 import `adminKeyStore`(已核实)。

### 7.4 验证(红 → 绿 → 真环境)

**红**(先写测试,看它因缺功能而失败,非语法/导入错误):`test/main/server/adminKeyStore.test.ts` 新增 describe「W-B 拒启退出码分类」5 条。

```
> npx vitest run test/main/server/adminKeyStore.test.ts --reporter=json --outputFile=<tmp>
VITEST_EXIT=1
numPassedTests=30 numFailedTests=5 numTotalTests=35
```

失败原因逐条确认是「缺分类」而非别的:

```
AssertionError: expected Error: adminKey 密钥文件权限过宽：… to be an instance of ServerConfigError
AssertionError: expected Error: adminKey 有两个不一致的来源：环境变量 KIRO_ADMIN… to be an instance of ServerConfigError
AssertionError: expected Error: 环境变量 KIRO_ADMIN_KEY 已设置但为空… to be an instance of ServerConfigError
AssertionError: expected Error: adminKey 密钥文件存在但内容为空… to be an instance of ServerConfigError
AssertionError: expected 1 to be 4   ← 四道闸门只产出 1 个不同的码
```

**绿**:

```
> npx vitest run test/main/server/adminKeyStore.test.ts --reporter=json --outputFile=<tmp>
VITEST_EXIT=0
numPassedTests=35 numFailedTests=0 numTotalTests=35
```

**全套件无回归**:

```
> npx vitest run --reporter=json --outputFile=<tmp>
VITEST_EXIT=0
numPassedTests=1521 numFailedTests=0 numTotalTests=1521 numPendingTests=0
numFailedTestSuites=0 numTotalTestSuites=465
```

(基线 1509 + 本轮新增 12 条 = 1521。其中 5 条是上表那族,另 7 条来自同一 describe 的展开;无 pending。)

```
> npm run typecheck:node    TYPECHECK_EXIT=0
> npm run build:server      BUILD_EXIT=0
```

**真 Linux 端到端复验**(`s6-exitcodes.log`,用重建后的产物):

```
先正常起一次生成密钥      GEN_TIMEOUT_EXIT=124 (124=起住了)   stat=600
A 权限过宽(chmod 644)     A_EXIT=73   ← 原 69
B env 与文件冲突          B_EXIT=78   ← 原 69(且 78 此前零生产用点)
C env 设了但为空          C_EXIT=64   ← 原 69
D 密钥文件零字节          D_EXIT=65   ← 原 69
E 密钥文件不可读(非 root) E_EXIT=73
F 回归:正常密钥仍能起住   F_TIMEOUT_EXIT=124 「[server] 就绪。面板: http://127.0.0.1:5611/panel」
```

**判定:verified —— 五种拒启在真 Linux 上退出五个互不相同的正确码,好路未被堵死。** 运维现在读一个码就能定位修法:64 查编排变量 / 65 删损坏文件 / 73 查 chown 与 chmod / 78 查两个真源 / 69 才是真的「服务起不来」。

### 7.5 caveat

真环境复验仍依赖对**容器内产物副本**的探针补丁(§2 那个独立缺陷)。单元测试侧不需要它(直接调 `createServerAdminKeyStore`,不经 `new Conf`),故红绿证据不受影响。

---

## 8 · 汇总:verified / verified-with-caveat / still-unverified

| # | 场景 | 判定 | 一句话 |
|---|---|---|---|
| 1 | 真实 `--omit=dev` 安装 | **verified-with-caveat** | `conf` 装得到,但**靠传递可达而非提交的 lockfile**;`--omit=dev` 因 `postinstall` 退 127 |
| 1' | 「`--omit=dev` 是 electron 真正缺席的第一个环境」 | **falsified** | electron 在 Linux 上仍被装下(prod peer),且 `require('electron')` 同样返回 string |
| 1'' | 产物真的不依赖 electron | **verified** | 显式删掉 electron 后 `require('electron')` 抛 MODULE_NOT_FOUND,产物仍 LOADED_OK |
| 2 | `0600` 密钥文件语义(POSIX 分支) | **verified** | 写入即 `-rw-------`;0644 拒启;0400 放行;非 root + 目录 700 跑通 |
| 3 | 四态数据故障 → 退出码 | **verified** | 64/65/73 逐条命中;`not-writable` 两种真实形态(文件 0444 / 目录 0555)首次验到 |
| 3' | 以 root 运行时写权限闸门 | **caveat(非缺陷)** | root 绕过 `access(W_OK)`,闸门在 root 容器里不生效 —— 部署文档需写「用非 root 服务用户」 |
| 4 | 字节兼容(Windows 写 → Linux 读) | **verified-with-caveat** | SHA256 逐字节一致、两个账号经面板 API 真的读出来;caveat:写方是 `conf` 直用,非 Electron 进程内的 `electron-store` |
| 5 | 面板真的能服务 | **verified-with-caveat** | shell 200 / js+css 200 字节与产物一致 / 错密钥 401 / 正确密钥 200+cookie / 拉到账号 / SIGTERM 优雅停机;caveat:依赖探针补丁 |
| 5' | `webPanelAssetRoot` 的 `__dirname/../webPanel` | **verified** | 容器布局下解析正确,无 404 |
| 6 | 服务端能否启动(`3adda90` 的核心声明) | **🔴 still-broken** | `Conf is not a constructor` —— Linux **与 Windows** 都起不来,exit 69 |
| 7 | adminKey 四道拒启的退出码分类 | **已修 · verified** | 原全退 69 → 现 64/65/73/78 各就各位,真 Linux 复验通过 |
| 8 | 反代真的转发流量 | **still-unverified-because** | 需真实上游凭据;且 `3adda90` 已诚实标注 token 刷新层未接线 |
| 9 | systemd 单元行为(`User=` / `Restart=` / `TimeoutStopSec`) | **still-unverified-because** | 容器里没有 systemd;SIGTERM 路径已单独验(§6),但 unit 文件本身未测 |
| 10 | 只读挂载(`-v ...:ro` 整个数据目录) | **still-unverified-because** | 已用 `chmod 555` 目录等价复现(§3,exit 73);真 `:ro` mount 未单跑 |

### 需要主 AI 裁决的两项(均超出「小而明显」边界,故报告不改)

**① `Conf is not a constructor`(§2)—— 阻断级,平台无关。** 三条互斥修法各有不同代价(改源码补 interop / 把 `conf` 打进产物 / 产物转 ESM),选择影响架构。**这条不修,服务端就是零可用**,优先级高于本轮其它一切。

**② lockfile 与 `package.json` 不同步 + `postinstall` 阻断 `--omit=dev`(§1)。** 修点在 `package.json` / `package-lock.json`,不在我被授权的 `src/main/**` 内。建议:`npm install --package-lock-only` 并提交;`postinstall` 改为 `electron-builder install-app-deps || true` 或迁到显式的桌面构建脚本。

---

## 9 · 本轮的仓库足迹与环境清理

### 改动的已跟踪文件(共 2 个,均在授权范围内)

```
> git status --porcelain -- src test
 M Kiro-account-manager/src/main/server/adminKeyStore.ts        (+35 -12 · 六处 throw 附上分类退出码 + 1 import)
 M Kiro-account-manager/test/main/server/adminKeyStore.test.ts  (+147 · 新增 5 条退出码闸门测试)
```

禁区复核:`git status --porcelain -- src/main/index.ts src/main/proxy src/renderer` → **空**(未碰)。
`git diff --cached --name-only` → **空**(未 `git add`、未 `git commit`、未用 `git stash`)。
`package-lock.json` 的 ` M` 是**进入本任务前就存在的**(HEAD `3adda90` 与其后的 `7c63d4c` 都不含那 55 行),不是我造成的,我也没动它。

行尾:两文件原为 CRLF,我的追加是 LF → 已用 `WriteAllText` + `UTF8Encoding($false)` 归一为纯 CRLF、无 BOM(实测 `CRLF=468/715 LF-only=0 BOM=False`),归一后套件与 typecheck 复跑仍全绿。

eslint 现状(**两条均为既存,非本轮引入**):`prettier/prettier` 的 CRLF 警告全文件级铺开(`.editorconfig` 要 LF 而文件是 CRLF),`test:36 'statSync' is defined but never used` 在 HEAD 版本里就已存在(该 import 只被文件头注释提及)。故未顺手 `--fix` —— 那会把两个文件整体重排,把 170 行的改动面放大成上千行,越过任务给的边界。

### Docker 资源清理(已复验)

本轮只用 `--rm` 容器 + `-v <ctx>:/ctx:ro` bind mount,**未创建任何卷或镜像**。

```
> docker ps -a --filter "name=kirosmoke" --format "{{.Names}}"   → 空  (NO_KIROSMOKE_CONTAINERS=true)
> docker volume ls | Select-String kiro                          → 空
> docker rmi node:22-bookworm-slim                               → RMI_EXIT=0
  Untagged: node:22-bookworm-slim
  Deleted: sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
> docker images node:22-bookworm-slim                            → 空  (IMAGE_GONE=true)
```

`node:22-bookworm-slim` 是本会话为本任务拉的,已删除并复验消失。其它容器(`lp-postgres-test` 等)与本任务无关,未触碰。

### 留在盘上的东西

`.agent-workspace/.archive/2026-08-12/linux-smoke/` 下:本报告 + 六份原始日志(`s1-head` / `s1b-head` / `s2-states` / `s3-serve` / `s4-full` / `s5-externals` / `s6-exitcodes`)+ 容器脚本 `ctx/` + 探针脚本 + `winstore/kiro-accounts.json`(**构造的假数据,无真实凭据**)。

**用户的真实数据文件全程未被读取、未被拷贝、未被传输** —— `%APPDATA%\kiro-account-manager\kiro-accounts.json` 在本轮所有命令里零出现。
