# 侦察报告 · 机器码副作用 / 主进程落盘路径 / 阈值单位

- 模式: **Mode R(现实侦察)** · 只读,未改任何代码
- 日期: 2026-08-10
- 上游侦察: `.agent-workspace/.archive/2026-08-09/headless-server-migration/recon-autoswitch-consolidation.md`
- 目标: 结算上一轮侦察留下的三个阻塞未知项,给出可用于估工的裁决

---

## Q1 机器码副作用 —— 裁决: **not needed because Y(反代不读它)**

### 它实际做什么

触发点 `src/renderer/src/store/accounts.ts:1161`,在 `setActiveAccount(id)` 内部,门闸 `machineIdConfig.autoSwitchOnAccountChange`(默认 `false`,accounts.ts:183)。

取值分支(accounts.ts:1167-1187):

| 条件 | 写入的值 |
|---|---|
| `bindMachineIdToAccount` 开 + `useBindedMachineId` 开 | `accountMachineIds[id]`(缺失则 `machineIdGenerateRandom()` 现生成并经 `bindMachineIdToAccount` 落盘) |
| `bindMachineIdToAccount` 开 + `useBindedMachineId` 关 | 随机新机器码 |
| `bindMachineIdToAccount` 关 | 随机新机器码 |

写入链路(逐跳已核实):

| 节点 | 位置 | 状态 |
|---|---|---|
| store 编排 | `renderer/src/store/accounts.ts:1161-1205` | existing(renderer) |
| `changeMachineId()` | `renderer/src/store/accounts.ts:3754` | existing(renderer) |
| IPC `machine-id:set` | `main/index.ts:6893` | existing(main) |
| `setMachineId()` | `main/machineId.ts:116` | existing(main) |
| Windows 落地 | `main/machineId.ts:378-382` → `reg add "HKLM\SOFTWARE\Microsoft\Cryptography" /v MachineGuid /t REG_SZ /d <新值> /f` | existing(main · **需管理员**,失败返回 `requiresAdmin`) |

除注册表写入外还有两个附带效果:向 `machineIdHistory` 追加一条 `action:'auto_switch'` 记录(accounts.ts:1190-1203)、`changeMachineId` 内部 `saveToStorage()`(accounts.ts:3780)。

**结论: 它改的是操作系统级 MachineGuid(全机唯一的那一个),不是任何"按账号绑定"的值。**

### 主进程有等价物吗

**写入能力本来就在主进程** —— `machineId.ts` 是唯一真源,renderer 只是通过 IPC 编排它。主进程缺的不是能力,是**触发编排**:

- `git grep -n "setMachineId" -- src/main` 只有两处:定义(machineId.ts:116)+ IPC handler(index.ts:6895)。没有任何主进程内部调用方。
- 主进程无处读 `machineIdConfig.autoSwitchOnAccountChange` 或 `accountMachineIds` —— 这两个字段只存在于 `preload/index.d.ts` 类型声明和 renderer store 里(`git grep autoSwitchOnAccountChange -- src/` 13 处命中全在 renderer/preload/types)。

所以把切号决策下沉后,主进程要新写的是 ~20 行门闸+取值编排,不是重新实现机器码写入。

### 缺了它会坏什么 —— 具体到"上游看到的是什么"

**不影响反代。** 反代的 machineId 来自完全独立的三级回落(`main/proxy/kiroApi.ts:1745-1753`):

```
getAccountMachineId(accountId, accountMachineId)
  ① account.machineId            ← 盘上账号记录的字段,由 activation.ts:129 assign('machineId', asString(a.machineId)) 映射进池
  ② kproxyService.getDeviceIdForAccount(accountId)   ← main/kproxy/index.ts:163
  ③ generateStableMachineId(accountId) = sha256(`kiro-device-${accountId}`)  ← 永不为空
```

该值仅用于构造 `x-amz-user-agent` / `user-agent` 请求头(kiroApi.ts:1766-1767)。**三级中没有一级读注册表 MachineGuid。**

关键的一条容易看错:`accountMachineIds`(机器码页的绑定表)与 `account.machineId`(账号记录字段,生成于 accounts.ts:1053 / 1604 / 2424)是**两张互不同步的表**。`git grep "accountMachineIds\["` 全仓仅 2 处(accounts.ts:1169 读、3859 读),没有任何一处把它写进 `account.machineId`。所以即使这个副作用被移植,反代拿到的值也不会因此改变。

它服务的是**本机安装的 Kiro IDE / CLI**(`switchTarget === 'ide' | 'both'` 路径,accounts.ts:3153+):IDE 自己读系统 MachineGuid 上报,换号时同步换掉,避免同一设备指纹在多账号间被关联。

**因此:** 反代无状态化 / headless 部署里若不在该机器上跑 Kiro IDE,缺这个副作用**不会**让上游看到过期指纹,**不会**让请求被拒,连"装饰性"都算不上 —— 它对反代路径完全无输入。

另有一个独立事实使移植在服务器上不可行:Windows 落地方式是 `reg add HKLM\...`,需要管理员;失败路径会 `showAdminRequiredDialog()`(index.ts:6898-6903)弹 GUI 对话框 —— headless 环境下这是个挂起点。

### 裁决

**not needed because 反代的 machineId 走 `account.machineId` / kproxy deviceId / sha256 三级回落,与系统 MachineGuid 无数据通路;且该副作用的两张表(`accountMachineIds` 与 `account.machineId`)本就不同步。**

附条件(会翻转裁决的唯一情形):若 headless 主机上同时要驱动本地 Kiro IDE 切号(`switchTarget` 含 `ide`/`both`),则降级为 "must port",且必须先解决 `reg add` 的管理员依赖与 `showAdminRequiredDialog()` 的 GUI 弹窗阻塞。默认 headless(仅反代服务)= 不需要。

---

## Q2 主进程是否已有部分落盘路径 —— 裁决: **上一轮的断言成立,且比它说的更弱**

### `onAccountUpdate`(main/index.ts:641)做什么

它**只发一条 IPC**,不落盘:

```ts
onAccountUpdate: (account) => {
  mainWindow?.webContents.send('proxy-account-update', {
    id: account.id, accessToken: ..., refreshToken: ..., expiresAt: ...
  })
}
```

触发方(全部在 `main/proxy/proxyServer.ts`):`:1399`(token 刷新成功)、`:1607`(单账号模式选定号不可用时换号)、`:1771`(402/429 额度耗尽换号)、`:1822`(账号被 suspended 换号)。

### 反应式切号(402)时有任何东西到盘吗 —— **没有**

`proxyServer.ts:1765-1774`(402/quota 分支)只做两件事:

```ts
if (!this.config.enableMultiAccount) {
  this.config.selectedAccountIds = [nextAccount.id]   // 直接改内存字段,无 persist 调用
  this.events.onAccountUpdate?.(nextAccount)
}
```

而这条 IPC **在消费端被提前 return 掉了**。唯一消费者 `renderer/src/App.tsx:411-425`:

```ts
const unsubscribe = window.api.onProxyAccountUpdate((info) => {
  if (!info.profileArn) return          // ← index.ts:641 的 payload 永远不含 profileArn
  ...updateAccount(...)                 // 只有 Enterprise profileArn 自愈会走到这里
})
```

`index.ts:641` 的载荷字段是 `{id, accessToken, refreshToken, expiresAt}` —— 无 `profileArn`,消费端第一行就返回。真正能落盘的是另外两个发送点 `index.ts:772` 和 `index.ts:809`(它们带 `profileArn`)。`git grep onProxyAccountUpdate` 确认全仓只有 App.tsx:413 一个消费者。

**因此上一轮的断言(反应式切号只改内存 `selectedAccountIds`、不持久化 `activeAccountId`)成立**,并且可以更强地表述:该路径发出的 IPC 到达消费端后是空操作 —— 连"通知前端"这一层实际都没生效。

补充证据:`activeAccountId` 在整个 `src/main` 里**没有任何写点**。`git grep -n activeAccountId -- src/main` 只有 2 处命中,均为注释(`accountService/state.ts:24`、`webPanel/dto.ts:202`);已按要求补一次文件系统级检索(`Get-ChildItem -Recurse | Select-String`,含未跟踪文件)确认同样只有这 2 条注释。持久化 `activeAccountId` 的唯一真源是 renderer `setActiveAccount` 尾部的 `saveToStorage()`(accounts.ts:1210)。

### 意外收获(影响估工,上一轮未提)

`src/main/proxy/activation.ts`(251 行)已经把**显式激活**的三步顺序下沉到主进程了:入池 upsert → 写 `selectedAccountIds`(仅单账号模式)→ 移指针 + 作废会话粘性。它自带详尽的 why 注释(引 2026-07-28 RCA)、`ProxyActivationHost` 依赖注入接口(可在 vitest 独立跑)、以及 `toProxyAccountShared` / `buildProxyAccountsFromStore` 两个共享映射。桌面 renderer 与局域网面板共用它。

对合并工作的含义:**"切号的执行"已经有主进程真源,缺的只是"切号的决策"**(阈值比较 + 候选筛选,现仅存于 renderer `checkAndAutoSwitch`,accounts.ts:3112)。新决策函数应产出 accountId 后调用 `activateProxyAccount`,而不是另起一套执行路径 —— 否则就是 activation.ts 头部注释明确警告过的"第二个顺序真源"。

反应式切号路径(proxyServer.ts:1770 直接改 `this.config`)**绕过了** activation.ts,是既有的第二真源萌芽:它不作废会话粘性、不 upsert 刷凭据。这一点值得在合并时一并收口。

---

## Q3 `autoSwitchThreshold` 单位 —— 裁决: **credits(积分),整数输入,与 `usage.limit/current` 同单位**

比较式:`remaining = updatedAccount.usage.limit - updatedAccount.usage.current`,判据 `remaining <= autoSwitchThreshold`(accounts.ts:3130-3134);候选筛选用同一判据(accounts.ts:3144-3145)。

单位溯源(主进程解析侧):`main/accountService/parseUsage.ts:165-210`

- `usage.limit` = `totalLimit = baseLimit + freeTrialLimit(仅 ACTIVE) + bonusLimit(仅 ACTIVE)`
- `baseLimit` = `creditUsage.usageLimitWithPrecision ?? creditUsage.usageLimit ?? 0`
- `creditUsage` = `usageBreakdownList` 里 `resourceType === 'CREDIT' || displayName === 'Credits'` 的那条(parseUsage.ts:152-159)

`ResourceDetail`(`renderer/src/types/account.ts:85-95`)给出上游语义:`resourceType: CREDIT` · `displayName: Credit` · `unit: INVOCATIONS` · `currency: USD` · `overageRate: 0.04`。

即:**这个数是 credits;上游以 INVOCATIONS 计量 credit,超额按 $0.04/credit 计费。不是 token 数。**

用户设置位置与文案(`renderer/src/components/pages/SettingsPage.tsx:906-917`):

- 标签: `余额阈值` / `Balance Threshold`
- 副文案: `余额低于此值时自动切换` / `Switch when balance below this`
- 控件: `<input type="number" min={0}>`,`onChange` 用 `parseInt(...) || 0`
- 默认值 `0`(accounts.ts:176);另有 `ConfigSyncPage.tsx:151/290` 参与配置导入导出

### 对边界测试设计的四个直接后果

1. **输入被 `parseInt` 截断为整数,但被比较的 `remaining` 可为小数** —— `*WithPrecision` 字段是带精度的。阈值 0 时 `0.5 <= 0` 为 false,即账号会被榨到严格 ≤ 0 才切。测试需覆盖 fractional remaining。
2. **`remaining` 可为负**(overage 开启时 current > limit),`negative <= 0` 成立 —— 已覆盖,但需断言不会把负余额账号选为候选。
3. **`limit === 0` 的未刷新账号是双向陷阱**:`remaining = 0`,`0 <= 0` 成立 → 被判为"已耗尽"需切换;而候选筛选用同一判据,同样把它排除 → 一池全是未刷新账号时找不到 `availableAccount`,静默不切。这是新决策函数最该先写红的边界。
4. 副文案说"低于此值",代码是 `<=`(等于也切)。文案与实现有一处轻微不一致,不影响功能但会影响测试命名与用户预期表述。

---

## 未覆盖 / 需跑代码才能定论

1. **`setLinuxMachineId` / `setMacOSMachineId` 的具体落地方式未读**(只核实了 Windows 走 `reg add MachineGuid`)。若 Q1 附条件被触发(headless 主机要驱动本地 IDE),Linux 分支写什么文件、是否也要 root,必须补读 `main/machineId.ts` 对应函数。
2. **`host.updateConfig()` 是否持久化 `ProxyConfig` 未核实**。Q2 的结论针对反应式路径(`proxyServer.ts:1770` 直接改 `this.config` 字段,该处确定无 persist 调用)。但 `activation.ts:230` 的显式激活走 `host.updateConfig({selectedAccountIds})`,其实现由 `index.ts` 注入 —— 若那里有落盘,则"显式激活"与"反应式切号"的持久化行为不对称,这会影响合并后是否需要统一。**需读 index.ts 里 `ProxyActivationHost` 的注入实现**(一次定点 grep + 单段读即可)。
3. **`machineIdHistory` 的落盘体积未评估**。副作用每次切号追加一条,若移植到 headless 高频自动切号场景,需确认有无上限裁剪(`clearMachineIdHistory` 存在但触发方未查)。
4. **运行时行为未实测**:以上全部结论来自静态读码。特别是 Q1 的"反代不读 MachineGuid"是通过穷尽 `getAccountMachineId` 三级回落得出的静态结论 —— 要 100% 排除某处间接读取(例如 kproxy 内部或 `getKiroUserAgent` 深层),需实跑一次带 machineId 断点的请求确认头部实际取值。静态证据强度已足够支撑估工,但正式移除该副作用前建议实测一次。
5. **未读**(按硬约束刻意规避):`main/index.ts` 全文(7133 行)、`renderer/src/store/accounts.ts` 全文(4585 行)。所有引用均为 `git grep` 定位后的定点切片(每次 ≤120 行)。

## P3 · 两条换号路径的持久化对称性

侦察范围：只回答「显式激活 vs 402 反应式换号，落盘是否对称」+ 反应式绕过 `activation.ts` 的具体后果。只读，未改任何代码。

### 结论一句话

**不对称。显式激活落盘，反应式换号纯内存。**

### 1. 显式激活：`updateConfig` 确实到盘

链路已逐跳核实到真实写盘调用：

| 跳 | 位置 | 动作 |
|---|---|---|
| 1 | `src/main/proxy/activation.ts:230` | `host.updateConfig({ selectedAccountIds: [accountId] })`（仅单账号模式） |
| 2 | `src/main/ipc/panelProxyDeps.ts:107-112` | `server.updateConfig(patch)` **紧接** `impl.persistProxyConfig(server.getConfig())` |
| 3 | `src/main/index.ts:4432-4434` | `persistProxyConfig: (config) => { store?.set('proxyConfig', config) }` ← 真实写盘 |

`activation.ts` 自身**不落盘**：落盘是 `ProxyActivationHost.updateConfig` 这个注入实现的职责。目前 `activateProxyAccount` 全仓只有一个调用点 —— `panelProxyDeps.ts:194`（局域网面板），而这个唯一 host 实现落盘。panelProxyDeps.ts:109-110 的注释明确写了为什么必须落盘：「不写盘的话，下次自启动会丢掉用户在手机上的选号，表现为『昨天选好的号今天自己变了』」。

桌面端 renderer 走的是另一条（`store/accounts.ts` 的 `syncActiveAccountToProxy` → `proxyUpdateConfig` IPC），其落盘点在 `index.ts:5931 store.set('proxyConfig', newConfig)`。**未逐跳核实**该链，本轮不做断言。

### 2. 反应式换号：纯内存，且连 `updateConfig()` 都没走

三处直接改字段，均无落盘：

- `proxyServer.ts:1606`（选定账号额度耗尽 → 自动切）
- `proxyServer.ts:1770`（账号被 suspend → 切下一个）
- `proxyServer.ts:1821`（402/429 两端点都试过 → 切下一个）

三处形态一致：`this.config.selectedAccountIds = [nextAccount.id]` + `this.events.onAccountUpdate?.(nextAccount)`。

两条证据支持「确实无落盘」：

1. `proxyServer.ts` 全文 grep `store|persist|writeFile` 只命中会话快照相关注释（:75/:333/:574），无任何 config 写盘。`ProxyServer` 类不持有 store 句柄。
2. 唯一的对外通知 `onAccountUpdate` 也不落 `proxyConfig`：`index.ts:641-647` 只把 `{id, accessToken, refreshToken, expiresAt}` 推给 renderer（**不含 profileArn**），而 renderer 侧唯一消费者 `src/renderer/src/App.tsx:413-415` 第一行就是 `if (!info.profileArn) return` —— 对反应式换号而言这是个 no-op。该 useEffect 的注释也自陈用途是「Enterprise profileArn 自愈」，与换号持久化无关。

绝对存在性已用文件系统级检索复核（`Get-ChildItem -Recurse | Select-String`，含未跟踪文件）：`proxy-account-update` / `onProxyAccountUpdate` 全仓消费者只有 App.tsx:413 一处。

### 3. 重启后的实际状态差

`index.ts:2825-2830` 自启动读 `store.get('proxyConfig')` 后 `server.updateConfig(savedProxyConfig)` —— **反应式换号的结果被回滚到最后一次显式选号**。

用户可见形态：手机面板选了 A → 跑着跑着 A 额度耗尽自动切到 B → 重启 → 选号显示回 A。

但要如实标注一个**收敛性抵消**：`accountPool` 的 `quotaExhaustedAt` 也是内存态（`accountPool.ts:544-604` recordError 只改内存 Map），重启同样丢失。所以重启后行为是「重试 A 一次 → 402 → 在 `proxyServer.ts:1601-1607` 再次切到 B」，最终态自愈。代价 = 每次重启一发浪费的 402 往返 + UI 显示落后。
> unverified：未穷尽核实 `accountPool` 状态是否有别处落盘（本轮只 grep 了 `proxyServer.ts`）。若实际有落盘，这条抵消不成立，不对称的后果会更重。

### 4. 反应式路径相对显式激活漏掉了什么（逐项 + 可观测后果）

| 漏掉的步骤 | 显式侧位置 | 具体可观测后果 | 是否有下游抵消 |
|---|---|---|---|
| **会话粘性失效** | `activation.ts:239 host.invalidateSessionAffinity()` | 带固定 session hint 的客户端**继续粘在已额度耗尽的旧账号上**：`pickAccountWithAffinity`（`proxyServer.ts:4716-4730`）只校验 `isSuspended` 和 `isAvailable !== false`，**不校验 `isQuotaExhausted`** → 粘性条目存活，每个请求先命中旧号、发一发注定 402 的上游调用、进重试循环再切号。持续到 600s TTL 过期（`proxyServer.ts:4703-4704`） | **suspend 分支有**（`isSuspended` 被校验，粘性自动清）；**402/额度分支没有** |
| **凭据从盘上现读** | `activation.ts:220-222` `loadAccountRecords()` + `toProxyAccountShared` | 反应式用池里既有副本。若池里那份 refresh token 已被 rotate 作废，下次到期刷新 401 | 部分抵消：401/403 分支 `proxyServer.ts:1779-1785` 先试 `refreshToken`，失败再切号；粘性路径 `1554-1560` 也做临期刷新。用作废 v1 刷新仍会失败一次，退化为多一次往返 |
| **`upsertAccount` 入池** | `activation.ts:225` | 无后果 —— `getNextAccount` / `getNextAvailableAccount` 只返回已在池的账号，无需 upsert |  n/a（不是缺陷） |
| **`setActiveAccount` 指针** | `activation.ts:238` | 单账号模式下取号读 `selectedAccountIds[0]`（`proxyServer.ts:1598-1600`），指针不被消费；多账号模式 `getNextAccount` 自己推进 currentIndex | 不构成缺陷 |
| **落盘** | `panelProxyDeps.ts:111` | 见第 3 节 | 收敛性抵消（内存池状态同时丢失） |

### 5. 判定

- **落盘不对称 = 不是独立 bug，但是合并任务的真实设计约束。** 它不产生持久错状态（内存池状态同生共死，重启后自愈），但把决策收口进主进程时必须显式裁决一件事：反应式换号要不要落盘？**若要，就是在热请求路径上加一次 `store.set` 全库加解密 IO** —— `index.ts:661-663` 的注释表明这个项目已经为了避免「每次封禁都触发整库加解密」而刻意改走内存快照。所以「顺手让它也落盘」不是免费的，需要按那条既有先例走内存快照 + 防抖。这是合并方案里必须写进契约的一格，不能留白。
- **粘性未失效（402/额度分支）= 真 latent bug，值得单独修，但量级小、边界清楚。** 后果具体可述：开了 `sessionAffinityEnabled` 且客户端带固定 session id 时，账号因额度耗尽换号后，最长 600s 内每个请求多发一发注定 402 的上游调用。根因是单点的判据缺项 —— `pickAccountWithAffinity` 的可用性校验少了 `isQuotaExhausted`。最小修法是在 `proxyServer.ts:4721` 那个 if 里补上该判据（这样 402 与 suspend 两个分支都自愈，比在三处换号点各插一次 `invalidateSessionAffinity` 更收口），但**具体取舍留给主 AI/用户裁决，本轮不改代码**。
- **第二个顺序真源的判定**：反应式路径确实绕过 `activation.ts`，但它与显式激活的意图不同（前者是请求内重试编排，后者是用户级换号），不宜简单合并成一个函数调用。真正需要统一的是**判据**（粘性可用性、落盘策略），不是三步顺序本身。


## P5 · accountPool 运行时状态的持久化核实

**结论:补偿论据部分崩塌 —— 配额/冷却类状态确实纯内存,但「长期封禁」(suspension)有一条独立的落盘路径,且落盘后不可自愈。**

### 核实范围与判据

`ProxyAccount` 的运行时字段全集(`src/main/proxy/types.ts:440-457`):
`lastUsed` / `requestCount` / `errorCount` / `isAvailable` / `cooldownUntil` / `quotaUsed` / `quotaLimit` / `quotaExhaustedAt` / `quotaResetAt` / `suspendedAt` / `suspendReason` / `suspendMessage`。

逐字段核实写侧(是否被复制进落盘记录)与恢复侧(启动时是否从盘上回填)。

### 恢复侧:全部干净 —— 每个账号都是全新起步

启动 hydration 的唯一入口是 `syncPool`(`src/main/ipc/panelProxyDeps.ts:119-127`):
`pool.clear()` 后按盘上记录逐个 `pool.addAccount(a)`,账号对象由 `buildProxyAccountsFromStore`
(`src/main/proxy/activation.ts:174-195`)→ `toProxyAccountShared`(同文件 `:101-142`)映射产出。

`toProxyAccountShared` 的 `assign` 白名单**只含凭据/路由类字段**:
`email` / `refreshToken` / `profileArn` / `expiresAt` / `machineId` / `clientId` / `clientSecret` /
`authMethod` / `provider` / `tokenEndpoint` / `issuerUrl` / `scopes` / `groupId` / `proxyUrl`,
加显式构造的 `id` / `accessToken` / `region` / `weight`。

**上述 12 个运行时字段一个都不在其中。** 所以 `quotaExhaustedAt` / `cooldownUntil` / `errorCount` /
`suspendedAt` / `quotaUsed` 在重启后全部为 `undefined` —— 这一半的补偿论据成立。

补充证据:`accountPool.upsertAccount`(`accountPool.ts:199-217`)反向印证了同一份词汇表 ——
它显式解构剔除 `isAvailable` / `suspendedAt` / `suspendReason` / `suspendMessage` /
`requestCount` / `errorCount` / `lastUsed`,注释指明"前端 mapper 不带 suspendedAt ⇒ 算出
true",即代码作者明确知道**盘上记录不携带运行期状态**。

### 写侧:配额/冷却类干净,suspension 泄漏到盘上

文件系统级扫描(`Get-ChildItem -Recurse | Select-String`,不依赖 git index,已排除
`src/main/proxy/` 自身):

- `quotaUsed` / `quotaLimit` / `quotaResetAt` → **0 处**池外命中(唯一命中是
  `RegisterPage.tsx:1216-1241` 的 `dailyQuotaUsed/Limit`,那是注册页自己的
  localStorage 日配额计数器,与账号池无关)。
- `quotaExhaustedAt` / `cooldownUntil` → **0 处**池外命中。
- `suspendedAt` / `suspendReason` → 池外有命中,见下。

**泄漏路径(两条,并行落盘同一份语义):**

1. **主进程内存快照直写** —— `src/main/index.ts:649-677` 的 `onAccountSuspended` 回调:
   ```
   data.accounts[info.accountId] = {
     ...data.accounts[info.accountId],
     status: 'error',
     lastError: `[${info.reason}] ${info.message}`,
     lastCheckedAt: Date.now()
   }
   ```
   写在 `lastSavedData` 上,随下一次防抖落盘进盘。
2. **IPC → renderer store → 落盘** —— 同一回调 `:653` 发 `proxy-account-suspended`,
   `src/renderer/src/App.tsx:402-404` 接收后 `updateAccountStatus(info.id, 'error', ...)`。

触发点在池侧共 4 处 `markSuspended` + `onAccountSuspended` 配对
(`proxyServer.ts:1737-1739` / `:3262-3263` / `:3522` / `:4467-4469`),
全部走 `newlyMarked` 去抖后触发。

**关键:这不是"两套独立词汇表"。** 池侧的 `suspendedAt`(内存)与盘上的
`status`/`lastError`(持久)是**同一事件的两个投影** —— 池里的标记会消失,盘上的不会。

### 落盘后的真实重启行为

`buildProxyAccountsFromStore:186` 有一道硬过滤:

```
if (asString(a.status) !== 'active') continue
```

因此被 suspend 过的账号在重启后的行为不是"封禁被清除、重新可用",而是
**根本不进池**(`status === 'error'`)。方向与"重启自愈"相反 —— 它比内存态更严格且更持久。

**且没有自动恢复路径。** 全仓扫描 `status` 被写回 `'active'` 的位置,只有用户手动动作:
`AccountCard.tsx:189` / `AccountListRow.tsx:266`(手动点按)、`accounts.ts:2300`
(批量操作)、以及各处新增账号时的初始赋值。**没有任何定时任务 / 启动逻辑 /
配额重置会把 `'error'` 翻回 `'active'`。**

### 对补偿论据的裁决

| 状态类别 | 纯内存? | 重启后 | 补偿论据 |
|---|---|---|---|
| `quotaExhaustedAt` / `quotaResetAt` | ✅ 是 | 清零,账号重新可选 | **成立** |
| `cooldownUntil` / `errorCount` | ✅ 是 | 清零 | **成立** |
| `quotaUsed` / `quotaLimit` | ✅ 是 | 清零 | **成立** |
| `suspendedAt` / `suspendReason` | ⛔ **否** | 以 `status:'error'` 形式存续,账号被过滤出池,需人工点回 active | **崩塌** |

原 recon 说的"两者一起死、系统收敛"对 402/配额路径成立(那正是它实际讨论的
反应式切号触发条件)。但它把 suspension 归入"同样只在内存里"是错的:suspension
有独立落盘路径,且落盘后是单向的。

**实际后果不是"更差的反应式切号",而是一个方向相反的问题**:反应式切号(402)
的内存态确实会在重启后蒸发;而 suspension(403/风控)的效果会在重启后**固化为
账号彻底不进池**,且只能靠用户在 UI 上手动改回 active 才能恢复。这两条路径的
持久性语义不一致,是真实的不对称。

### 证据锚点汇总

- 运行时字段全集:`src/main/proxy/types.ts:440-457`
- hydration 入口:`src/main/ipc/panelProxyDeps.ts:119-127`
- 映射白名单(恢复侧不回填):`src/main/proxy/activation.ts:101-142`
- `status !== 'active'` 硬过滤:`src/main/proxy/activation.ts:186`
- upsert 剔除运行期字段(反向印证):`src/main/proxy/accountPool.ts:199-217`
- 落盘路径 1(主进程):`src/main/index.ts:649-677`
- 落盘路径 2(renderer):`src/renderer/src/App.tsx:402-404`
- 池侧触发点:`src/main/proxy/proxyServer.ts:1737` / `:3262` / `:3522` / `:4467`
- 无自动恢复(仅手动):`AccountCard.tsx:189` / `AccountListRow.tsx:266` / `accounts.ts:2300`
- 检索方式:`git grep -n` + 文件系统级 `Get-ChildItem -Recurse | Select-String`
  (后者不依赖 git index,覆盖未跟踪文件)
