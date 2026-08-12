# machineId.ts 服务器化侦察报告(K-2)

- **日期**: 2026-08-10
- **仓库**: `F:\Kiro-account-manager\Kiro-account-manager`(git 根在上一层 `F:\Kiro-account-manager`)
- **基线**: `main` @ `181b169`(K-1 已落地)
- **模式**: Mode R · 现实侦察(只读,未改任何源文件,未提交)
- **关联**: `docs/architecture/ADR-0002-shared-kernel-extraction.md` · `181b169`(K-1) · `.agent-workspace/.archive/2026-08-09/headless-server-migration/recon-electron-coupling.md`

---

## 0. 结论先行(三句)

1. **`machineId.ts` 与反代零关系。** 反代取 machineId 走 `kiroApi.ts:1878` 的**局部** `getAccountMachineId()`,数据来自持久化账号字段 + kproxy 映射 + 账号 ID 哈希兜底,**全链不 import `machineId.ts`**。服务端形态**根本不需要这个模块**。
2. **门禁绿是因为 `machineId.ts` 真的不可达,但门禁同时存在一个真实缺口** —— 缺口不在 `machineId.ts`,在 `proxy/proxyServer.ts`:它有 3 处 `require('electron')`,是 ADR-0002 点名的内核成员,却**不在门禁入口的闭包内**,门禁看不见它。这是本轮更重要的发现。
3. **推荐方案不是"拆分",而是"改归属 + 缩窄"**:`machineId.ts` 整体是桌面专属,应移入桌面壳目录;唯一需要共享的是 32 字节随机 ID 生成,而它**在 kproxy 里已有同语义实现**(`generateDeviceId`),属重复实现,应收口而非再造。

---

## 1. 计划假设清单(来自派单)

| # | 派单中的假设 | 现实判定 |
|---|---|---|
| A1 | `machineId.ts` 是"仅剩的内核邻接文件" | **[偏差]** 它压根不在内核可达集里;真正的内核内 electron 残留是 `proxy/proxyServer.ts` |
| A2 | "machineId 是发往上游的设备指纹的一部分,故对反代重要" | **[部分成立,但来源判错]** 指纹确实含 machineId,但**不来自本模块**;见 §2 |
| A3 | "`ProxyAccount` 带 `machineId` 字段,需判定反代是按请求从本模块读还是从持久化账号数据读" | **[已判定:持久化账号数据]** 本模块零参与 |
| A4 | "文件大部分是桌面专属桥接" | **[匹配]** 且比预估更彻底:**全部**导出都是桌面专属或与内核无关 |
| A5 | "`machine-id-override` 会随数据目录一起走" | **[成立但无意义]** 该文件仅 macOS 分支读写(§4),Linux 分支压根不读它 |
| A6 | "门禁算传递闭包,`machineId.ts` 仍 import electron 而门禁绿 ⇒ 要么不可达,要么门禁有缺口" | **[两者都对,但对象不同]** `machineId.ts` 确实不可达(非缺口);缺口另有其人 |

---

## 2. 反代到底消费什么(A2/A3 定论)

### 2.1 出站请求里的 machineId 来源链

反代出站 header 的完整链路(每一跳都已核实):

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| 账号绑定 ID | 持久化账号字段 `ProxyAccount.machineId`(`proxy/types.ts:436`,注释写"64 位十六进制") | `kiroApi.ts:1879` `if (accountMachineId) return accountMachineId` | ✅ 完整 · **首选路径** |
| kproxy 设备映射 | `kproxy/index.ts:200` `getDeviceIdForAccount()`(内存 `deviceIdMappings`) | `kiroApi.ts:1880-1883` | ✅ 完整 · 次选 |
| 账号 ID 稳定哈希兜底 | `kiroApi.ts:1867` `generateStableMachineId()` = `sha256('kiro-device-'+accountId)` | `kiroApi.ts:1884` `return generateStableMachineId(accountId)` | ✅ 完整 · 保证永不为空 |
| 汇聚点 | `kiroApi.ts:1878` `getAccountMachineId(accountId, accountMachineId)` | `getAuthHeaders()` 等 7 处(`:1893/3976/4068/4180/4380/4433/4485`) | ✅ 完整 |
| 最终出口 | `getKiroUserAgent()` `kiroApi.ts:347` / `getKiroAmzUserAgent()` `:353` / `getSubscriptionUserAgent()` `:4366` | header `user-agent` / `x-amz-user-agent` | ✅ 完整 |

**`machineId.ts` 不在这条链上的任何一跳。** 全文件系统检索(`src` + `test` + `scripts`,含未跟踪文件)确认 `machineId.ts` 的**唯一 importer 是 `src/main/index.ts:3`**,且 `index.ts` 不在内核里。

### 2.2 一个容易踩的同名陷阱(实测)

`index.ts:1208` 有一个**局部** `getCurrentMachineId()`,与 `machineId.ts:91` 导出的 `getCurrentMachineId()` **同名但语义完全不同**:

```ts
// src/main/index.ts:1208 —— 局部函数,返回 kproxy 的当前设备 ID
function getCurrentMachineId(): string | undefined {
  const kproxyService = getKProxyService()
  if (!kproxyService) return undefined
  return kproxyService.getDeviceId()
}
```

`index.ts:1017/1408/1597` 的裸调用 `getCurrentMachineId()` 走的是**这个局部函数**,不是模块导出的那个(模块的那个必须写成 `machineIdModule.getCurrentMachineId()`)。按名字 grep 会把两者混成一个消费者,得出"内核/主链路在用 machineId.ts"的错误结论。派单里的 A2 大概率来源于此。

### 2.3 顺带核实到的一处真实语义矛盾(非本轮修,登记)

两个 machineId **命名空间互不兼容**,而 `machineId.ts` 的校验器只认其中一个:

- 账号绑定形态 = **64 位 hex**(`proxy/types.ts:436` 注释;`kproxy/index.ts:275` `generateDeviceId()` 生成 32 字节 → 64 hex;测试 `importApiKey.test.ts:67` 用 `'f'.repeat(64)`)
- 系统机器码形态 = **UUID(36) 或 32 hex**(`machineId.ts:313` `isValidMachineId`)

实测(node 直跑该正则):`isValidMachineId('f'.repeat(64)) === false`。即**账号绑定的 machineId 全部不通过本模块的校验**——再次印证两者是不同域的东西,不该合并。

**另有一处名实不符**:`index.ts:1952-1953` 的注释写「`newMachineId` 用主进程的 `generateRandomMachineId` …… 两者产出同为 64 位 hex」,但 `machineId.ts:83` 实际是 `crypto.randomUUID()` → **36 字符 UUID**(实测),而 renderer 侧 `store/accounts.ts:33` 才是真 64 hex。故 `importApiKey` 经 IPC 路径(`index.ts:1962`)写入账号的 `machineId` 是 UUID 形态,与 `proxy/types.ts:436` 的契约和测试 fixture 都不一致。**这是既存缺陷,不在 K-2 范围**,但拆分时若顺手"统一"会改变桌面行为,故明确列为**不要动**,另开一轮(§4.5 风险 R3)。

---

## 3. 按受众切分文件(逐导出)

`src/main/machineId.ts`(637 行)。电子依赖锚点:`:11 import { app, dialog } from 'electron'` · `:224 app.getPath('exe')` · `:255 shell.openExternal`(动态 import `:254`) · `:261/:277/:292 app.quit()` · `:399/:437 app.getPath('userData')` · `:591 app.getVersion()` · `:627 dialog.showMessageBox`。

| 导出 | 行 | 分类 | 生产消费者(全部) |
|---|---|---|---|
| `OSType`(type) | `:56` | 桌面(类型) | `index.ts:6947` 经 IPC → `preload/index.ts:579` → `MachineIdPage.tsx:65` |
| `MachineIdResult`(interface) | `:58` | 桌面(类型) | 同上族 |
| `getOSType()` | `:67` | **桌面专属** | `index.ts:6947`(IPC `machine-id:get-os-type`) |
| `generateRandomMachineId()` | `:83` | **唯一内核候选**(见下) | `index.ts:1962`(`buildApiKeyImportDeps().newMachineId`) + `index.ts:6974`(IPC) |
| `getCurrentMachineId()` | `:91` | **桌面专属** | `index.ts:6953`(IPC `machine-id:get-current`)。**注意与 `index.ts:1208` 同名局部函数区分** |
| `setMachineId()` | `:116` | **桌面专属** | `index.ts:6959`(IPC `machine-id:set`) |
| `checkAdminPrivilege()` | `:154` | **桌面专属** | `index.ts:6979`(IPC `machine-id:check-admin`) |
| `requestAdminRestart()` | `:222` | **桌面专属**(重度) | `index.ts:6965` / `:6986` |
| `backupMachineIdToFile()` | `:582` | **桌面专属** | `index.ts:7003`(前置 `dialog.showSaveDialog`) |
| `restoreMachineIdFromFile()` | `:604` | **桌面专属** | `index.ts:7018`(前置 `dialog.showOpenDialog`) |
| `showAdminRequiredDialog()` | `:626` | **桌面专属** | `index.ts:6963` / `:6984` |

非导出内部件:`findPowerShell()` `:19` · `isValidMachineId()` `:313` · `getWindowsMachineId()` `:324` · `setWindowsMachineId()` `:378` · `getMacOSMachineId()` `:396` · `setMacOSMachineId()` `:435` · `getLinuxMachineId()` `:468` · `setLinuxMachineId()` `:490` · `setLinuxMachineIdWithPkexec()` `:525` · `formatAsUUID()` `:573`。

**死代码:无。** 11 个导出全部有真实生产消费者(全部落在 `index.ts` 的 IPC 装配层 + 一处 `buildApiKeyImportDeps`)。

**检索方法留痕**:`git grep` 之外补了不依赖 git 索引的文件系统级检索 —— `Get-ChildItem -Recurse -Include *.ts,*.tsx,*.mjs,*.js` over `src`/`test`/`scripts` + `Select-String`,覆盖未跟踪文件(本仓有大量未跟踪工作)。两者结论一致:importer 只有 `index.ts:3`。

### 3.1 `generateRandomMachineId` 是唯一"看起来内核需要"的导出 —— 但它是重复实现

`index.ts:1962` 把它注入 `ApiKeyImportDeps.newMachineId`(`accountService/importApiKey.ts:117`,消费点 `:451 machineId: deps.newMachineId()`)。`importApiKey.ts` 是内核成员(在闭包内)。

但**内核并不依赖这个模块** —— 它依赖的是一个**注入的函数**,而实现由装配层给。全仓已有三份同语义实现:

| 实现 | 位置 | 产出 |
|---|---|---|
| `generateDeviceId()` | `kproxy/index.ts:275` | 32 字节 → **64 hex** ✅ 与 `proxy/types.ts:436` 契约一致 |
| `generateRandomMachineId()` | `renderer/src/store/accounts.ts:33` | Web Crypto → **64 hex** ✅ |
| `generateRandomMachineId()` | `machineId.ts:83` | `crypto.randomUUID()` → **36 字符 UUID** ❌ 与契约不符 |

`kproxy/index.ts` **已在内核闭包内**且**已在 K-1 中断掉 electron**。故服务端壳的 `newMachineId` 直接注入 `generateDeviceId` 即可 —— **零新增内核文件**。这符合 §2.6 预写存在闸门:能力已存在,不该再造。

> `⚡[动作闸门]` 即将判定"新建内核模块" · 命中 E-062/§2.6 重复实现母题 · 强制前置动作:检索同义能力 · 已做:文件系统级检索命中 `kproxy/index.ts:275 generateDeviceId`(64 hex,内核内,已断 electron)→ **判定:不新建,复用**。

---

## 4. 门禁现状:`machineId.ts` 不可达,但门禁有真实缺口(第 3 问定论)

### 4.1 我独立复算了闭包(未采信门禁自报)

用与门禁同算法的独立脚本(同一别名表 / 同一四形态正则 / 同一注释剥离)复算:

**门禁当前入口**(`kernel_without_electron.test.ts:46-51`):`kproxy/index.ts` · `secureBackup.ts` · `secureBackupCipher.aesGcm.ts` · `accountService/verify.ts`

```
CLOSURE_SIZE: 30
HAS_machineId.ts: false        ← 不可达,故门禁绿是「诚实的绿」
HAS_proxyServer.ts: false      ← 但内核成员没被扫到
HAS_webPanel_routes: false
HAS_webPanel_server: false
VIOLATIONS: 0 · UNRESOLVED: 0
```

门禁实跑亦确认:`npx vitest run test/main/architecture/kernel_without_electron.test.ts` → **11 passed**。

**所以对 `machineId.ts` 这一项,门禁没有说谎** —— 它 import electron 而门禁绿,是因为没有任何内核入口能到达它。派单假设 A6 的"要么不可达,要么门禁有缺口"里,**"不可达"成立**。

### 4.2 但换成 ADR-0002 声明的内核边界,门禁立刻转红

ADR-0002 的 Scope 明写内核 = `src/main/proxy` + `src/main/accountService` + `src/main/webPanel`。以这 55 个文件为入口复算:

```
CLOSURE_SIZE: 67
VIOLATIONS: 1
  ! src/main/proxy/proxyServer.ts   <- src/main/proxy/index.ts
UNRESOLVED: 0
```

**`proxy/proxyServer.ts` 有 3 处 `require('electron')`,已核实**:

- `:731` 自签证书生成 → `ensureProxySelfSignedCert(app.getPath('userData'), hostnames)`
- `:751` `getSelfSignedCertInfo()`
- `:763` `regenerateSelfSignedCert()`

这正是 ADR-0002 Decision 2 里点名的「原 11 文件清单漏项」(CJS 形态,`git grep "from 'electron'"` 扫不到)。**门禁自己的注释花了 30 行论证"清单式门禁会静默腐烂,所以改算传递闭包",但入口只选了 4 个,于是闭包同样漏掉了 `proxy/index.ts` 这棵子树。** 缺陷形态从"漏掉文件名"变成了"漏掉入口",病灶同源:边界仍由手工清单决定。

**这是门禁缺口,且是本轮最重要的发现。** 它的危险性与 K-1 修掉的那个假绿同级:今天写 `proxy/proxyServer.ts` 的人拿不到任何红灯,而这个文件是反代主链路 —— 服务端加载 `proxy/index.ts` 就会拉进它,`require('electron')` 在纯 node 下**加载期即抛**(不像 ESM 那样静默 undefined)。

第 4 个内核 electron 残留 `registration/registrar.ts:314` 不在 ADR 内核三目录内,故不在此闭包;但它是注册主链路,服务端若要注册功能需另行处置。

### 4.3 修法建议(独立于 machineId,建议优先于 K-2)

把门禁入口从 4 个手写文件改为**按目录展开** `src/main/proxy` + `src/main/accountService` + `src/main/webPanel` 的全部 `.ts`(与 ADR-0002 Scope 对齐,新增内核文件自动纳管),并把 `proxyServer.ts` 的 `app.getPath('userData')` 按 K-1 姿态改为注入 —— `selfSignedCert.ts:24` 的注释已把 `dataPath` 当参数化入口(`:28-33 ensureProxySelfSignedCert(dataPath, ...)`),抽参成本低。

**注意:`proxyServer.ts` 正被并行 agent 编辑,本轮不得触碰(见 §6.2)。**

---

## 5. 逐 OS 行为盘点(第 4 问)

`getCurrentMachineId()` `:91` 按 `getOSType()` 分派:

| OS | 读路径实际行为 | 是否读 `machine-id-override` | 纯 node 可跑? |
|---|---|---|---|
| Windows `:324` | ① `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` → ② PowerShell `Get-ItemProperty`(多路径探测 `findPowerShell()` `:19`) → ③ `wmic csproduct get UUID`(过滤全 F 值) | **否** | 是(纯 `child_process`),但 Windows 专属 |
| macOS `:396` | ① `app.getPath('userData')/machine-id-override` `:399` → ② `~/Library/Application Support/Kiro/machineid` `:408` → ③ `ioreg -rd1 -c IOPlatformExpertDevice \| awk '/IOPlatformUUID/'` | **是(仅此分支)** | **否** —— `:399` 触 `app.getPath` |
| Linux `:468` | 依次读 `/etc/machine-id`、`/var/lib/dbus/machine-id`;取到后 `formatAsUUID()` `:573` 把 32 hex 转 UUID 形态;全不存在则 `{success:false,error:'无法获取Linux机器码'}` | **否** | **是** —— 纯 `fs`,零 electron |

**Linux 服务器上的实际结论(直接回答第 4 问)**:读路径**今天就能在无 Electron 下跑**,因为 `getLinuxMachineId()` 只用 `fs`。**但整个模块仍会在加载期炸** —— `:11` 是顶层值导入 `import { app, dialog } from 'electron'`,`--omit=dev` 后 `electron` 包不存在,解析期即失败(K-1 提交信息已记录这个失败形态)。

**更要紧的是:这个"能跑"没有任何价值。** Linux 分支返回的是**宿主机的 `/etc/machine-id`**,而反代出站需要的是**每账号绑定的 64 hex 设备 ID**(§2.1)。二者连格式都不兼容(§2.3 实测 64 hex 不过 `isValidMachineId`)。服务端读宿主 machine-id 无任何消费者。

**派单里"`machine-id-override` 会随数据目录走"的推论(A5)对 Linux 不成立** —— Linux 读路径 `:468-486` 压根不看 override 文件,只有 macOS 的 `:399` 和写路径 `:437` 用它。

**写路径**(服务端不需要,仅记录):Windows `reg add MachineGuid` 需管理员;macOS 写 override + 同步 Kiro IDE `machineid`;Linux 直写 `/etc/machine-id`,EACCES/EPERM 时 `setLinuxMachineIdWithPkexec()` `:525` 走 `pkexec`/`gksudo`/`kdesudo` + `tee` —— 服务器无交互式 polkit agent,必然失败。

---

## 6. 建议方案(第 5 问)

### 6.1 边界应该落在哪:整体改归属,不做函数级拆分

**判定:`machineId.ts` 不需要拆成"内核安全模块 + 桌面模块"。** 理由是 §3 的事实 —— 11 个导出全部只被 `index.ts` 的 IPC 装配层消费,内核零消费;唯一沾到内核的 `generateRandomMachineId` 是**注入点的实现方**,而更符合契约的实现(`generateDeviceId`,64 hex)已在内核内存在。拆出一个"kernel-safe machineId 模块"会造出第二个真源,正是 K-1 提交信息里拒绝过的那类"凭空造第二个可疑真源"。

**推荐动作(按性价比排序)**:

**M1 · 改归属(主体)** —— 把 `src/main/machineId.ts` 整体视为桌面壳组件。两个选项:

- **M1-a(推荐 · 零风险)**:**原地不动,仅补一段头部归属注释** + 在门禁里加一条"`machineId.ts` 不得被内核引用"的反向断言。理由:文件内容不变 ⇒ 桌面行为零风险;而"它是桌面专属"这个事实是靠**门禁**而非注释保证的(§4.9 Layer 1 优先)。
- **M1-b(结构更干净 · 有风险)**:移到 `src/main/desktop/machineId.ts`。代价:改 `index.ts:3` 的 import 路径;收益仅是目录语义。**本轮不建议**——`index.ts` 正是装配层重写的目标,先移动等于给后续 diff 制造噪声。

**M2 · 收口 `newMachineId` 注入(真正让服务端可用的一刀)** —— 服务端壳的 `ApiKeyImportDeps.newMachineId` 注入 `kproxy/index.ts:275` 的 `generateDeviceId`,**不引用 `machineId.ts`**。桌面端 `index.ts:1962` **保持现状不动**(改成 `generateDeviceId` 会把新导入账号的 machineId 从 UUID 变成 64 hex —— 那是行为变更,见 R3)。

**M3 · 修门禁缺口(建议提到 K-2 之前)** —— §4.3。这一条与 machineId 无关,但它是本轮侦察发现的最高价值项。

### 6.2 命名与放置约定(对齐既有姿态)

参考既有三例:`secureBackupCipher.aesGcm.ts` / `secureBackupCipher.safeStorage.ts`(同一端口的两端实现,`<port>.<impl>.ts`)、`utils/webPanelAssetRoot.ts`(单一职责 SSOT 解析点,头部长注释讲清 why)。

**本轮按 M1-a + M2 不需要新文件。** 若未来确实要给"设备 ID 生成"立端口(例如服务端要可复现的确定性 ID),那时才按既有命名法产出 `deviceId.random.ts` / `deviceId.deterministic.ts`,并把 `kproxy/index.ts:275` 收进去。**现在做属于为虚构的未来过度设计**(§4.3 务实节制)。

### 6.3 风险(桌面行为必须不变)

| ID | 风险 | 触发条件 | 处置 |
|---|---|---|---|
| R1 | 移动文件导致 `index.ts:3` import 断裂 | 选 M1-b | 本轮不选 M1-b |
| R2 | "顺手把 `machineId.ts` 也断 electron" | 执行者误读派单为"要断依赖" | **明确不要断**:桌面端 `requestAdminRestart` 需要 `app.getPath('exe')`/`app.quit()`,`showAdminRequiredDialog` 需要 `dialog` —— 无头下无对应语义,断了等于删桌面功能 |
| R3 | 统一 `generateRandomMachineId` 到 64 hex | 执行者为"修 §2.3 的名实不符"而改 `machineId.ts:83` | **本轮禁止**。它会改变桌面端新导入账号的 machineId 形态,属既存缺陷另开一轮;登记为架构债 |
| R4 | 给 `machineId.ts` 加"服务端桩实现" | 执行者认为服务端也要这个 IPC 面 | 服务端零消费者(§2),加桩即死代码(E-052 同族) |

### 6.4 §0.17 业务现实核验(逐项)

| 候选新建 | 真实场景 | 缺失影响 | 既有覆盖 | 判级 |
|---|---|---|---|---|
| 内核安全版 machineId 读取模块 | 找不到 —— 服务端无人消费宿主 machine-id | 无(反代用账号绑定 ID) | `kiroApi.ts:1878` 三级兜底已全覆盖 | **D 技术整洁强迫症 · 不建** |
| 内核版 `generateRandomMachineId` | `importApiKey` 需要 `newMachineId` | 服务端导入 ksk_ 账号无 machineId | **已有** `kproxy/index.ts:275 generateDeviceId`(64 hex,契约相符) | **复用,不新建** |
| 门禁入口按目录展开 + `proxyServer.ts` 断依赖 | 服务端加载 `proxy/index.ts` 即崩(CJS 加载期抛) | 服务端形态压根起不来 | 无 | **A 业务必须**(但归属 K-2 之外/之前) |

**『业务现实建议』**:派单第 1-5 问隐含"machineId.ts 需要被拆分"这一前提,核验后判为 **D 类**。K-2 若按字面执行"拆分 machineId.ts",产出物在服务端零消费者。**建议把 K-2 重新定义为**「确认 machineId.ts 为桌面专属并用门禁固化 + 修补门禁入口缺口」。

### 6.5 『架构级建议』· 门禁边界仍是手工清单

K-1 已经识别出"清单式门禁会静默腐烂"并改为算闭包,但**入口清单本身仍是手工的**,于是同一个病灶换了个层级复现(§4.2)。建议把门禁入口与 ADR-0002 Scope **绑定为同一真源**(按目录展开),否则每加一个内核入口都要有人记得改测试 —— 这正是 K-1 注释里判过死刑的形态。这是**上游修法**,不是给 `proxyServer.ts` 单点打补丁。

---

## 7. 真实修改范围

**按建议方案(M1-a + M2 + M3 分离)**:

| 文件 | 动作 | 属 K-2? |
|---|---|---|
| `src/main/machineId.ts` | 仅加头部归属注释(内容不变);**不断 electron** | 是 |
| `test/main/architecture/kernel_without_electron.test.ts` | ① 加反向断言:内核闭包不得含 `machineId.ts` ② 入口改为按 ADR-0002 三目录展开 | 是(①)/ M3(②) |
| `src/main/proxy/proxyServer.ts` | `app.getPath('userData')` 改注入 | **否 —— 并行 agent 正在编辑** |
| 服务端壳(尚不存在) | `newMachineId: generateDeviceId` | 后续 K-x |
| `src/main/index.ts` | **不动** | — |

**不改的文件(诱人但不该碰)**:`machineId.ts` 的 electron 导入 · `index.ts:1962` · `machineId.ts:83` 的 UUID 形态 · `kproxy/index.ts:275`。

---

## 8. 工作包切分与派单建议

| 包 | 范围 | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| **P1** | `machineId.ts` 头部注释 + 门禁加"内核不得引用 machineId.ts"反向断言 | 把"桌面专属"从判断固化为门禁 | 无 | ✅ | 1(小,≈30 分钟) |
| **P2** | 门禁入口改按 ADR-0002 三目录展开 | 消除门禁入口缺口;**会转红并暴露 `proxyServer.ts`** | 无 | ⚠️ 与 P3 强序 | 1 |
| **P3** | `proxyServer.ts:731/751/763` `userData` 改注入 | 断内核最后一处 electron | **必须在 P2 之后**(先有红灯再修);**且必须等并行 agent 交出 `proxyServer.ts`** | ❌ 串行 | 1 |

**一个执行者足够跑 P1**;P2+P3 是另一条线,量级与 K-1 的 `logger.ts` 相当。**P2 若先落地会让套件转红**(暴露 `proxyServer.ts`),因此要么 P2+P3 同一轮同一执行者,要么 P2 落地时用基线豁免(只减不增)。

### 8.1 与并行 agent 的冲突判定(第 6 问)

**本报告的建议不触碰 `src/main/proxy/proxyServer.ts`** —— P1 完全不涉及它。

**但 P2 会与之产生间接冲突**:P2 只改测试文件,不改 `proxyServer.ts`,却会让**全套件转红**,并行 agent 会看到一个不是它造成的红灯。**建议:P2/P3 排到并行 agent 交出 `proxyServer.ts` 之后。** P1 现在就能派,零交集。

**风险交叉区**:`test/main/architecture/kernel_without_electron.test.ts` 被 P1 与 P2 同时触及 → **P1 与 P2 不要并行派给两个执行者**,或让 P1 只改 `machineId.ts` 注释、把反向断言并入 P2。

---

## 9. 领域模型对账(第 8 节)

**判定:不适用于新建模型文档,但需登记一条跨切维度矛盾。**

`docs/domain/` 下无 `machineId` 相关模型文档。machineId 不构成跨切中间层(无状态机、无持久化生命周期、无速率限制通道),按 `domain-model.md` 的准入标准不需要建模文档。

**需登记的不变量矛盾(§2.3)**:系统内存在**两个不兼容的 machineId 命名空间**(64 hex 账号绑定 vs UUID/32hex 系统机器码),而 `machineId.ts:313` 的校验器只认后者。今天没炸,是因为两条链**从不交汇**;`index.ts:1952` 的注释误以为它们同形态,是这个矛盾的第一个受害者。建议记入 `ARCHITECTURE.md` 技术债:**"machineId 双命名空间;`machineId.ts:83` 产出 UUID 但被注入到期望 64 hex 的 `ApiKeyImportDeps.newMachineId`(`index.ts:1962`)"**。

---

## 10. 对派单前提的纠正(明确列出)

1. ❌ **"`machineId.ts` 是仅剩的内核邻接文件"** → 内核内真正的 electron 残留是 `proxy/proxyServer.ts`(3 处 CJS `require`)+ 内核外的 `registration/registrar.ts:314`。`machineId.ts` 不在内核可达集内。
2. ❌ **"machineId 是发往上游的设备指纹,故本模块对反代重要"** → 指纹成立,但来源是持久化账号字段 + kproxy 映射 + accountId 哈希(`kiroApi.ts:1878`),本模块零参与。混淆源大概率是 `index.ts:1208` 的**同名局部函数**。
3. ❌ **"`machine-id-override` 会随数据目录走(对 Linux 有意义)"** → 仅 macOS 分支读写它;Linux 读路径 `:468` 完全不看。
4. ⚠️ **"门禁绿而 `machineId.ts` 仍 import electron ⇒ 要么不可达要么门禁有缺口"** → **两个都对,但不是同一件事**:`machineId.ts` 是真不可达(门禁诚实);门禁缺口独立存在,对象是 `proxyServer.ts`。
5. ⚠️ **"拆分 machineId.ts"这个任务前提** → §0.17 核验判为 D 类。建议改为"用门禁固化其桌面专属身份 + 修门禁入口"。

---

## 检索留痕

- `git log -1 --stat 181b169` · `git log --oneline -8 -- src/main/machineId.ts`
- `git grep -n -E "app\.get|from 'electron'|dialog\.|shell\." -- src/main/machineId.ts`
- 文件系统级(含未跟踪):`Get-ChildItem -Recurse -Include *.ts,*.tsx,*.mjs,*.js` over `src`/`test`/`scripts` + `Select-String`(patterns: `machineIdModule` / `getAccountMachineId` / `machine-id` / 各导出名)
- 独立闭包复算脚本:`.agent-workspace/hold-probe/closure-probe.mjs`(同门禁算法,两组入口)
- 门禁实跑:`npx vitest run test/main/architecture/kernel_without_electron.test.ts` → 11 passed
- 正则实测:`isValidMachineId('f'.repeat(64)) === false`;`crypto.randomUUID().length === 36`
- 读:`ADR-0002` 全文 · `kernel_without_electron.test.ts` 全文 · `machineId.ts` 全文 · `webPanelAssetRoot.ts:1-45` · `recon-electron-coupling.md` 相关行

**未验证项(诚实标注)**:`unverified` —— Linux 服务器上 `/etc/machine-id` 的真实内容与权限、`--omit=dev` 后的真实加载失败(K-1 提交信息已记录该形态,本轮未在 Linux 上复现);均不影响本报告结论,因为建议方案不依赖服务端读取宿主 machine-id。
