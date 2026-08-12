# Electron 耦合面剖析 · 侦察报告（Mode R）

- 日期：2026-08-09
- 范围：`src/main/` 的 electron 耦合面 · 业务层间接依赖 · 持久化层
- 性质：**只读侦察**，未修改任何业务文件
- 工具：git grep / Select-String（文件系统级，含未跟踪文件）/ desktop-commander read_file / exa

## 0. 结论速览

1. **耦合面是 13 个文件，不是 11 个。** 派单给出的 11 文件清单由 `git grep "from 'electron'"` 得出，
   漏掉两个用 **CJS `require('electron')`** 的文件：
   - `src/main/proxy/proxyServer.ts:648 / :668 / :680` —— `const { app } = require('electron')`
   - `src/main/registration/registrar.ts:314` —— `const { app } = require('electron')`
   这两个都是**代理/注册主链路上的承重文件**，不是边缘 UI。按原清单拆包会漏掉它们。
   证据：`Get-ChildItem src -Recurse -Include *.ts,*.tsx | Select-String "require\(.electron.\)|from .electron.|import\(.electron.\)"`
   （文件系统级扫描而非 git grep，同时覆盖 ESM / CJS / 动态 import 三种形态）

2. **业务层「不直接 import electron」成立，但间接依赖链存在且承重。**
   `accountService/verify.ts:19-24` → `proxy/kiroApi.ts:19` → `proxy/logger.ts:4 (import { app })`。
   这是**值导入**（非 type-only），无头环境下 electron 解析失败会在 import 阶段就炸。
   同链带出第二跳 `kiroApi.ts:20 → kproxy/index.ts:2 (import { app })`。

3. **`safeStorage` 不是硬阻塞。** 代码已有降级路径（`secureBackup.ts:33-43`：不可用 → 退回明文 JSON），
   electron 官方文档亦确认 Linux 无 secret store 时落到 `basic_text` 后端。详见 §C.3。

4. **账号数据持久化收口干净。** 全仓只有 **1 处** 真实写 `accountData`（`accountService/state.ts:181`），
   外加 1 处 bootstrap 期有注释说明的绕过（`index.ts:1981`）。但 `electron-store` 还承载 **20+ 个非账号配置键**，
   这些是分散直写（`index.ts` 内 28 处 `store.set(`），迁移时要一并接管。

5. **唯一真业务阻塞是 `proton-mail-window.ts`** —— 靠隐藏 BrowserWindow 加载 `mail.proton.me` 抓码，
   无头下没有等价 electron API，必须换方案或保留侧车。其余 (a) 类文件都可直接丢弃。

## A. 耦合文件分类表（13 个）

分类：(a) 纯 UI/窗口/托盘 · (b) `ipcMain` 注册 · (c) `electron-store` 持久化 · (d) 运行时能力等价实现 · (e) 其他

| # | 文件 | electron API 符号 | 类 | 无头迁移判断 |
|---|---|---|---|---|
| 1 | `src/main/index.ts:1` | `app` `shell` `BrowserWindow` `ipcMain` `dialog` `globalShortcut`；`:2` 另 import `electron-updater` 的 `autoUpdater` | a+b+c+d 全占 | **最重**。142 处 `ipcMain.handle/on`；`app.getPath('userData')` 见 :510 / :3079 / :6309；`electron-store` 初始化见 :1958 |
| 2 | `src/main/ipc/proxyPool.ts:6` | `ipcMain` | b | 2 个 handler：`proxy-pool:validate` (:17)、`proxy-pool:diagnose-chain` (:102)。纯薄壳，替 HTTP 端点最容易 |
| 3 | `src/main/ipc/webPanelWiring.ts:14` | `ipcMain` | b (+c 注入) | 7 个 handler（:229/:234/:239/:249/:259/:274/:290）。`:100` 注释写明 AdminKeyStore 用 electron-store 实现并注入 —— 端口已抽好，换实现即可 |
| 4 | `src/main/kproxy/index.ts:2` | `app.getPath('userData')` (:36) | d | 单点。构造函数里拼 `dataPath`，注入 basePath 即可 |
| 5 | `src/main/machineId.ts:11` | `app.getPath('exe')` (:224)、`app.getPath('userData')` (:399/:437)、`app.getVersion()` (:591)、`app.quit()` (:260/:277/:292)、`dialog.showMessageBox` (:627)、`shell.openExternal` (:255，动态 import :254) | a+d 混合 | **需拆**。`getPath`/`getVersion` 是 (d) 可等价；`dialog.showMessageBox` + `shell.openExternal` + `app.quit()` 是 (a) 交互式重启流程，无头下无对应语义 |
| 6 | `src/main/proxy/logger.ts:4` | `app.getPath('userData')` (:45，在 `configure()` 内)、`app.isPackaged` (:461，在日志格式化内) | d | **关键节点**（见 §B）。两处调用都在方法体内而非模块顶层，所以「import 本身」不炸，但 `configure()` / 日志写入一跑就炸 |
| 7 | `src/main/proxy/proxyServer.ts:648/:668/:680` | `require('electron').app.getPath('userData')`（3 处，均为自签证书路径） | d | **原 11 文件清单漏项**。均传给 `ensureProxySelfSignedCert(...)`（`selfSignedCert.ts:24` 注释已把 dataPath 当参数化入口，抽参成本低） |
| 8 | `src/main/registration/registrar.ts:314` | `require('electron').app.getPath('userData')` (:328 `userDataDir`) | d | **原 11 文件清单漏项**。注册主链路 |
| 9 | `src/main/registration/ipc-handlers.ts:1` | `ipcMain`、`BrowserWindow`（仅作 `getMainWindow: () => BrowserWindow \| null` 的类型+句柄，:11） | b | 9 个 handler。`BrowserWindow` 只当不透明句柄传递，不调用其方法 → 无头下可传 null／替换为 no-op 通道 |
| 10 | `src/main/registration/proton-mail-window.ts:16` | `BrowserWindow` (:25/:59/:72/:109/:129)、`session.fromPartition` (:60)、`type Session`、`sess.setProxy`（:47 `applyProxy`） | a | **硬阻塞（业务性）**。隐藏 BrowserWindow 加载 `mail.proton.me` 抓验证码，依赖渲染引擎 + 持久化 session + 逐 session 代理。无头下无等价物，只能换方案（IMAP/API）或保留 headless-chromium 侧车 |
| 11 | `src/main/secureBackup.ts:9` | `safeStorage.isEncryptionAvailable` (:26)、`.encryptString` (:36)、`.decryptString` (:52) | d | 已自带明文降级（§C.3）。仅 index.ts 两处动态 import 消费（:1974 / :2395） |
| 12 | `src/main/tray.ts:2` | `Tray` `Menu` `nativeImage` `BrowserWindow` `dialog` `MenuItemConstructorOptions` `NativeImage`；`app.isPackaged` (:14/:118/:124/:130)；`require('electron').clipboard` (:257) | a | 无头环境整体不需要，直接不装配 |
| 13 | `src/main/utils/emitToRenderer.ts:31-32` | `type WebContents`（type-only）、`app.isPackaged` (:227) | a+d | 本质是 `webContents.send` 的 size guard 收口。无头下 renderer 不存在 → 整体退化 no-op，只需保留 `app.isPackaged` 的等价开关 |

补充（非 electron import 但同族）：`src/preload/index.ts:1` 用 `contextBridge`/`ipcRenderer` —— preload 属渲染侧，无头形态整体不加载。

### A 小结（按迁移工作量）
- (a) 可整体丢弃：`tray.ts`、`emitToRenderer.ts`（退化 no-op）、`preload/`
- (a) 不可丢弃需换方案：`proton-mail-window.ts`（唯一真业务阻塞）
- (b) 需换传输：**160 个 handler**（index.ts 142 + ipc-handlers 9 + webPanelWiring 7 + proxyPool 2）
- (c) 需换持久化：`index.ts:1958` 一处初始化，但 28 处直写散落
- (d) 需等价实现：`app.getPath('userData')`（7 个文件命中）、`app.getPath('exe')`、`app.getVersion()`、`app.isPackaged`、`safeStorage`

## B. 业务层是否真解耦

### B.1 结论：目录级「无直接 import」为真，但**间接依赖链存在且是值导入**

`accountService/` 与 `webPanel/` 内 **0 处** electron import（已用文件系统级扫描确认，非仅 git grep）。
`webPanel/auth.ts:23` 注释、`ipc/webPanelWiring.ts:100` 注释均写明这是刻意的端口注入设计 —— 属**有意设计，不是偏差**。

但外部值导入清单里有一条穿透到 electron：

```
accountService/verify.ts:19-24   import { resolveApiKeyProfileArnIfEligible, validateApiKeyCredential,
                                          parseRegionFromProfileArn, fetchEnterpriseProfileArn }
                                   from '../proxy/kiroApi'        <- 值导入，非 type-only
  |- proxy/kiroApi.ts:19          import { proxyLogger } from './logger'
  |     |- proxy/logger.ts:4      import { app } from 'electron'          [X]
  |- proxy/kiroApi.ts:20          import { getKProxyService } from '../kproxy'
        |- kproxy/index.ts:2      import { app } from 'electron'          [X]
```

同文件另有 `verify.ts:25 } from '../proxy/kiroApi'`（多行 import 尾行，单看 `^import` 会漏）。

**其余外部导入均干净**（逐个核实传递闭包，全部只依赖 node: 内置）：

| 被业务层导入的模块 | 自身外部依赖 | 洁净？ |
|---|---|---|
| `utils/netGuard.ts` | `node:crypto` | 是 |
| `utils/redact.ts` | 无 import | 是 |
| `utils/webPanelAssetRoot.ts` | `node:fs` `node:path` | 是（:22 注释明确「故意不写 app.isPackaged 分支」） |
| `utils/tokenFingerprint.ts` | `node:crypto` | 是 |
| `proxy/profile-selection.ts` | 仅 type import（`./types` `./kiroApi`） | 是，type-only 不产生运行时边 |
| `accountService/credentials.ts` | `node:path` `node:crypto` | 是 |
| `accountService/switch.ts` / `subscription.ts` / `importApiKey.ts` | 均 type import + `utils/tokenFingerprint` | 是 |
| `webPanel/*`（8 文件） | `node:http` `node:crypto` `node:net` `node:fs/promises` `node:path` + netGuard/redact/webPanelAssetRoot | 是 |

检索限制：`accountService/importApiKey.ts` 被 git 判为 binary file（含 BOM 或非常规编码），
`git grep` 对它输出 `Binary file ... matches` 而非行号。已用 Select-String 覆盖到「无 electron 命中」，
但该文件完整 import 清单**未逐行核**（列入未覆盖项）。

### B.2 `proxy/logger.ts` 的被导入者

`git grep -ln "proxy/logger|from './logger'"` → 3 个消费者：
- `src/main/index.ts`（本身已耦合，无增量）
- `src/main/proxy/proxyServer.ts:24`（本身已耦合，无增量）
- `src/main/proxy/kiroApi.ts:19` <- **唯一把 electron 带进业务层的边**

**它是整个耦合面里性价比最高的一刀**：`logger.ts` 只用 2 个 electron 符号，且都在方法体内
（`configure()` 里的 `app.getPath('userData')`、日志格式化里的 `app.isPackaged`）。
把这两个换成注入（logDir 由调用方传、isPackaged 换环境变量/构造参数）即可让
`kiroApi` → `accountService/verify` 这条链彻底脱离 electron。`kproxy/index.ts:36` 同形态（单点 `getPath`）。

## C. 持久化层

### C.1 `electron-store` 初始化与文件路径

- 唯一初始化点：`src/main/index.ts:1955-1966`（`initStore()`，惰性）
  ```ts
  const Store = (await import('electron-store')).default
  const storeInstance = new Store({
    name: 'kiro-accounts',
    encryptionKey: 'kiro-account-manager-secret-key'
  })
  ```
- 文件路径：**代码里不显式指定 `cwd`** → electron-store 默认落在 `app.getPath('userData')/kiro-accounts.json`。
  代码只在 `index.ts:1975` 用 `path.dirname(storeInstance.path)` 反推备份目录，说明路径由库自行决定。
  未实测运行时真实路径（列入未覆盖项）。
- `encryptionKey` 是**硬编码字面量**，electron-store 用它做 AES 混淆 —— 这是**混淆不是安全**（密钥在源码里）。
  迁移时不要把它当安全属性继承，但要注意**读旧文件必须用同一 key 才能解开**，否则老用户数据打不开。
- store 的类型契约被独立声明了多处（都是「最小接口」而非 electron-store 类型）：
  `index.ts:1878-1882`、`accountService/state.ts:15`、`accountService/types.ts:235`、`ipc/webPanelWiring.ts:27`。
  **这对迁移有利**：业务侧只认 `{ get, set, path }` 三成员，换实现不需要改业务类型。

### C.2 账号数据写入收口

- 收口函数：`accountService/state.ts:147 applyAccountDataMutation(mutate, opts)`
  - 内部：串行锁 → `storeRef.get('accountData')` (:162) → revision 乐观锁仲裁 (:169) → `storeRef.set('accountData', toPersist)` (**:181，全仓唯一真实写点**) → 广播
- **真实写 `accountData` 的点数 = 2**（`git grep "store.set('accountData'"` 全仓确认）：
  1. `accountService/state.ts:181` —— 正规收口
  2. `index.ts:1981` —— bootstrap 期从备份恢复，`store` 尚未注入 state.ts 故无法走收口；代码有注释说明并显式 `revision: 0` 保持乐观锁语义完整。**属有意设计，不是偏差**
  （另外 `accounts.ts:11` / `index.ts:13` 两处命中是注释里的禁令文字，非代码）
- 调用 `applyAccountDataMutation` 的上游收口点 5 个：`accounts.ts:51`、`persistAccountPatch.ts:79`、
  `persistCheckResult.ts:333`、`persistRefreshResult.ts`（经 persistAccountPatch 间接）、`index.ts:1949`（deps 注入转发）
- **非账号数据是分散直写**：`index.ts` 内 28 处 `store.set(`，键包括
  `proxyConfig`（7 处）· `proxySessionHistory` · `PROXY_ORPHAN_SESSION_KEY` · `MIGRATION_KEY`（3 处）·
  `showWindowShortcut` · `traySettings` · `proactiveRenewalEnabled` · `proxyTotalCredits` ·
  `proxyInputTokens` · `proxyOutputTokens` · `proxyTotalRequests` · `proxySuccessRequests` ·
  `proxyFailedRequests` · `usageApiType` · `useKProxyForApi` · `kproxyConfig`，
  外加 `:423 store.set(key, value)` 一个**泛化直写通道**（任意 key）。
  账号数据有收口，配置数据没有 —— 迁移时这 28 处都要跟着换。

### C.3 `safeStorage`：无 keyring 下**不是硬阻塞**，有降级

用在 `secureBackup.ts`，加密对象 = **容灾备份文件**（账号 token + 代理账密），不是主数据。
主数据仍在 electron-store 里（靠上面那个硬编码 encryptionKey 混淆）。

三条证据：

1. **代码自带降级**（`secureBackup.ts:33-43`）：`isSecureBackupAvailable()` 用 try/catch 包住
   `isEncryptionAvailable()`，false → 直接写明文 `kiro-accounts.backup.json`；读路径 (:47-64) 也是
   先试 `.enc` 再退明文。文件头注释明确写了「不可用（极少数 Linux 无 keyring）→ 退回明文 JSON，保证容灾不丢」。
   **即使 safeStorage 完全不可用，业务不中断，只是备份退明文。**
2. **electron 官方文档**（exa 检索 `Electron safeStorage isEncryptionAvailable Linux headless no keyring`，
   top1 = https://electronjs.org/docs/latest/api/safe-storage 《safeStorage | Electron》）：
   「not all Linux setups have an available secret store. If no secret store is available, items stored
   using the safeStorage API will be unprotected as they are encrypted via hardcoded plaintext password.
   You can detect when this happens when `safeStorage.getSelectedStorageBackend()` returns `basic_text`.」
3. **但 `basic_text` 后端需显式 opt-in**：同轮检索命中 PR
   `fix(desktop): allow remote gateway token storage on keyring-less Linux`
   （https://github.com/NousResearch/hermes-agent/pull/62319）指出 ——
   「Launching with `--password-store=basic` didn't help either, because the app never called
   `safeStorage.setUsePlainTextEncryption(true)`, which Electron requires on Linux for the basic
   backend to count as available」。本项目**没有调用** `setUsePlainTextEncryption`（全仓 grep 无此符号），
   所以无 keyring 的 Linux 上会走**本项目自己的明文 JSON 降级**，而不是 electron 的 basic_text。

**结论**：无头 Linux 上 `isEncryptionAvailable()` 返回 false → 走项目自带明文备份分支 →
**不阻塞，但备份从加密退化为明文落盘**。若无头形态要保住加密，别去修 keyring，
直接把这一层换成自管密钥（Node `crypto` + 环境变量/文件密钥）更干净 —— 反正主数据的
electron-store encryptionKey 本来就是硬编码明文，安全等级已经在那里，不在 safeStorage 这里。

## D. 未覆盖项（本轮工具预算内未查完）

1. `src/main/accountService/importApiKey.ts` 被 git 判为 binary（BOM/编码问题），未逐行核其完整 import 清单。
   Select-String 已覆盖到「无 electron 命中」，但传递闭包未逐一展开。
2. electron-store 的**运行时真实文件路径**未实测（结论「默认 userData/kiro-accounts.json」
   来自库默认行为推断，非实测输出）。
3. `index.ts` 142 个 `ipcMain` handler 的**逐个语义分类**（哪些纯 UI、哪些业务能力）未做 ——
   这是拆包的主要工作量，本轮只给了总数。
4. `src/main/index.ts:423 store.set(key, value)` 泛化直写通道的调用方未追
   （可能是通用 settings handler，意味着 store key 空间不是编译期封闭的）。
5. `renderer/` 侧未看（本轮范围限定 `src/main/`）。
6. `electron-updater`（`index.ts:2` autoUpdater）的耦合面未展开。
