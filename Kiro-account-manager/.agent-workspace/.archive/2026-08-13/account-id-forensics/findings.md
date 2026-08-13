# 账号 ID 跨账号复用取证

- 日期：2026-08-13
- 取证基线：`10bdf3440d3b1500821918899c8b81701be2dbda`
- 范围：只读源码、测试、Git 状态和既有归档；除本报告外未修改、暂存或提交任何文件

## 结论

**台账 #31 可以关闭为：YES，`account.id` 能在两个不同的上游账号之间复用；而且不需要等待 UUID 随机碰撞。**

`account.id` 不是 Kiro/AWS 身份系统签发的永久自然键。它是本应用的本地记录键，来源混合：

1. 大多数新增路径在本地生成 UUID v4；
2. 启动时自动同步本机 SSO 的一条路径生成 ``${email}-${Date.now()}``；
3. 完整导出文件再次导入时，直接接受并保留文件中的 `id`；
4. 编辑账号凭据时不生成新 ID，而是把验证得到的新 `email/userId/credentials` 写回旧 ID。

第 4 条是决定性证据。编辑窗口把用户填写的凭据送去验证，验证 API 的入参不含“原账号应为哪个 userId”，成功后返回凭据实际对应的 `email/userId`（`src/main/accountService/verify.ts:343-359,377-435,469-500`）。保存逻辑再调用
`updateAccount(account.id, { email: result.data.email, userId: result.data.userId, credentials: ... })`
（`src/renderer/src/components/accounts/EditAccountDialog.tsx:117-160,175-219`）；store 只在原 Map key 上展开覆盖，未比较旧、新 `userId/profileArn/email`，也未跑新增账号的判重逻辑（`src/renderer/src/store/accounts.ts:1196-1207`）。

因此，只要操作者持有账号 A 和 B 的有效凭据，就可以打开 A 的编辑框、填入 B 的凭据并保存；记录仍叫 A 的 `id`，身份字段和凭据已经变成 B。对非 Enterprise 的 BuilderId/IdC 路径，这条链不依赖旧 `profileArn`。这是应用支持的 UI 路径，不是理论上的哈希碰撞。

完整导出导入是第二条确定可达路径：导出类型包含完整 `Account`，因此包含 `id`
（`src/renderer/src/types/account.ts:108-121,197-205`）；导入只按 `userId` 或
`(email, provider, profileArn)` 判重，不检查 ID，随后执行 `accounts.set(acc.id, acc)`
（`src/renderer/src/store/accounts.ts:1811-1866,1880-1889`）。一个与现存 ID 相同、但身份三元组不同的用户提供文件会静默替换原 Map 项；同一导入文件内两个不同账号使用同一 ID 时，后一个也会覆盖前一个，而成功计数仍按输入项累计。

所以，先前“需要上游唯一性合同才能判定”的前提不成立：上游没有签发这里的主 ID。上游合同最多能说明 `userId/profileArn` 的语义，不能替本地 UUID、时间串、导入字段或编辑行为提供永久唯一性。

## 1. ID 从哪里来

### 1.1 数据模型本身不声明来源或不变性

`Account` 同时保存本地 `id`、上游 `userId`、`profileArn` 和认证信息，但没有把它们声明为等价字段
（`src/renderer/src/types/account.ts:108-121`）。`AccountRuntimeDeps` 也把 ID 当普通字符串传递，不含 generation/version（`src/main/accountService/types.ts:150-177`）。

这说明代码里的 `id` 是记录身份，而非可从类型层证明的上游主体身份。

### 1.2 常规新增：本地 UUID v4

store 的统一 `addAccount` 在调用方不能传 ID 的情况下执行 `uuidv4()`，再把 ID 放入
`Map<string, Account>`（`src/renderer/src/store/accounts.ts:788-798,1169-1193`）。

下列入口最终都走它，因此 ID 均由本应用随机生成，而不是来自上游响应：

- 本机 SSO 手动导入、Refresh Token/IdC 导入、批量 profile 导入和 SSO Token 导入：
  `src/renderer/src/components/accounts/AddAccountDialog.tsx:288-313,477-501,579-603,868-922`；
- 社交登录和 external-idp/profile 登录：
  `src/renderer/src/components/accounts/AddAccountDialog.tsx:1127-1154,1277-1305`；
- 注册成功后的单个/批量入库：
  `src/renderer/src/components/pages/RegisterPage.tsx:994-1045,1429-1500,2146-2175`。

**观察结论：** 删除后经这些普通入口重加，即使是同一个上游账号，也会得到新的本地 UUID；这属于“同一身份换了记录 ID”，不是“旧 ID 被新身份复用”。

### 1.3 简化批量导入：本地 UUID v4

`importAccounts(AccountImportItem[])` 不接受 `id` 字段；每项都执行 `uuidv4()`
（`src/renderer/src/types/account.ts:208-232`；`src/renderer/src/store/accounts.ts:1707-1730`）。

这里没有按身份判重；相同凭据可得到多个不同 ID，但不会按正常执行路径复用同一个 ID。

### 1.4 API Key 导入：主进程 `crypto.randomUUID()`

API Key 导入的生产依赖把 `newId` 绑定为 `crypto.randomUUID`
（`src/main/index.ts:1042-1049`），`buildApiKeyAccount` 将其结果写入 `id`
（`src/main/accountService/importApiKey.ts:415-490`）。

这里的 `userId` 才是从上游资料派生：优先 `profileArn`，否则 token fingerprint；ID 本身仍是本地随机值
（`src/main/accountService/importApiKey.ts:442-465`）。

`DedupeIndex` 按 `userId`、token fingerprint 和
`email + provider + profileArn` 判重（`src/main/accountService/importApiKey.ts:151-223`）。
同一 API Key/上游身份在原记录仍存在时会被跳过；删除后再导入会生成新 UUID。

### 1.5 启动时自动同步本机 SSO：`email + 毫秒时间戳`

首次加载账号 store 后会异步运行 `syncLocalSsoAccountAsync`
（`src/renderer/src/store/accounts.ts:523-527,2619-2624`）。它只用 refresh token 精确相等寻找已有记录；找不到时生成：

```text
const now = Date.now()
const newId = `${verifyResult.data.email}-${now}`
```

证据：`src/renderer/src/store/accounts.ts:529-585`。

这个 ID 仍由本应用派生，不是上游 ID。它的唯一性依赖本机时钟、email 和调用时刻：

- 普通情况下，删除后重新自动导入会得到不同时间戳；
- 同 email、同毫秒，或系统时钟回拨到旧值时，代码没有碰撞检查；
- 即使上游允许 email 生命周期复用，跨生命周期是否会撞到同一个毫秒时间串仍需额外条件，不能仅凭仓库宣称会自然发生。

### 1.6 完整导出再导入：文件提供 ID，原样保留

`AccountExportData.accounts` 是 `Omit<Account, 'isActive'>[]`，所以 ID 在导出格式内
（`src/renderer/src/types/account.ts:197-205`）。`exportAccounts` 只去掉 `isActive`，保留其余字段
（`src/renderer/src/store/accounts.ts:1683-1704`）。

UI 对 JSON 文件执行 `JSON.parse` 后直接调用 `importFromExportData`
（`src/renderer/src/components/pages/SettingsPage.tsx:374-390`；
`src/renderer/src/components/accounts/AccountManager.tsx:90-104,148-152`）。
store 没有重新 mint ID，也没有校验 ID 形状/唯一性
（`src/renderer/src/store/accounts.ts:1811-1889`）。

**观察结论：** 这是用户提供 ID 的入口。未经修改的旧导出在删除后重导会恢复旧 ID；手工编辑或由外部工具生成的导出可以确定性制造“不同身份、相同 ID”。

### 1.7 编辑账号：保留旧 ID，可更换上游身份

这是本报告关闭问题的主证据：

- 编辑框预填旧凭据，但允许用户修改 refresh token/client 凭据
  （`src/renderer/src/components/accounts/EditAccountDialog.tsx:89-115`）；
- 验证函数只接收新凭据，不接收旧账号 ID/userId 作为期望值
  （`src/main/accountService/verify.ts:343-387`）；
- 上游返回的新 `email/userId` 被写回 `account.id`
  （`src/renderer/src/components/accounts/EditAccountDialog.tsx:175-219`）；
- `updateAccount` 在旧 Map key 上合并，没有身份一致性判断
  （`src/renderer/src/store/accounts.ts:1196-1207`）。

这条 UI 还有两种形态：

- 先点“验证”再保存：`accountInfo` 被 B 的 `email/userId/usage/subscription` 更新，保存后身份资料是 B，
  但 ID 以及未参与 patch 的 `idp/profileArn/groupId/tags/machineId/lastError` 等仍来自 A；
- 修改凭据后不重新验证就直接保存：`accountInfo` 仍是对话框打开时的 A，`handleSave` 没有
  “凭据已变更必须重验”的 guard，于是会形成“A 的 email/userId/usage/subscription + B 的凭据 + A 的 ID”
  的混合记录（初始化见 `src/renderer/src/components/accounts/EditAccountDialog.tsx:80-97`，保存见
  `:175-219`，保存按钮只要求已有 `accountInfo`，见 `:416-447`）。

### 1.8 备份、撤销恢复和整文件迁移：不 mint，原样保存旧 ID

- 安全备份序列化传入的 `accountData`，不改记录键
  （`src/main/secureBackup.ts:123-146`）；
- 启动恢复只在主 `accountData` 不存在时把整份备份写回，不与现存账号集合 merge
  （`src/main/index.ts:1109-1129`）；
- Web 面板删除撤销保留原账号对象/ID，恢复前若同 ID 已存在则返回
  `ACCOUNT_ALREADY_EXISTS`，不会覆盖（基线
  `src/main/webPanel/routes.ts:441-455,574-600`；碰撞守卫为基线 `:583-584`）；
- 桌面到 Linux 的文档流程是停机后复制整份主文件，并明确两端之后互相独立、不自动同步
  （`docs/operations/data-migration.md:1-3,40-50,116-135`）。

## 2. 哪些地方把 ID 当永久键，以及假设失效时会怎样

### 2.1 持久化账号表与导入合并

`buildPersistBlob` 把账号 Map 写成 `accounts[id] = record`
（`src/renderer/src/store/accounts.ts:192-235`）；历史真实 store 也是 keyed object，而非数组
（`.agent-workspace/.archive/2026-08-09/headless-server-migration/forensics-error-status-accounts.md:22-35`）。

同一个对象不可能同时容纳两个相同 key。ID 冲突的表现不是“出现两行重复账号”，而是：

- `Map.set`/对象赋值让后一记录覆盖前一记录；
- `activeAccountId`、代理绑定、机器码绑定等仍指向这个字符串，于是自动跟到新身份；
- 审计时只能看到一个最终记录，旧记录被静默消失。

API Key 导入的 `mergeAccounts` 对 Record 形状同样按 `[account.id]` 赋值
（`src/main/accountService/importApiKey.ts:401-408`）。该路径 ID 是随机生成的，所以普通可达风险是随机 UUID 碰撞；完整导入路径则允许文件直接控制 ID。

### 2.2 revision 仲裁与异步结果回写：存在 ABA 语义

`applyAccountDataMutation` 只保证进程内读改写串行，并在调用方传
`expectedRevision` 时拦截陈旧 revision（`src/main/accountService/state.ts:160-205`）。
它不保存“这个 ID 的第几代身份”。

多条异步写回路径只用调用开始时捕获的 `accountId` 查当前盘面记录：

- 单账号 token/check 等字段补丁：
  `src/main/accountService/persistAccountPatch.ts:62-107`；
- 批量 refresh 结果：
  `src/main/accountService/persistRefreshBatchResults.ts:185-218`。

若 A 的请求在飞时，同一个 ID 被编辑/导入为 B，A 的迟到结果仍能命中 B：

- token 刷新结果可把 A 的新 access/refresh token 写进 B；
- 批量结果还可把 A 的 email/userId/usage/subscription 写进 B
  （`src/main/accountService/persistRefreshBatchResults.ts:160-181,194-218`）。

“账号不存在则不复活”的守卫只能挡住 ID 消失；A→B 保持同 ID 时，它会把 B 误认成仍是 A。
revision 递增不会阻止这一点，因为这些内部权威写通常不传 `expectedRevision`
（`src/main/accountService/persistAccountPatch.ts:104-107`）。

### 2.3 renderer/main 三方合并

`mergeSyncBlob` 对 `accounts` 按 ID 做记录级三方合并：

- ours 相对 base 改过则 ours 胜；
- ours 未改则 theirs 胜；
- ours 整条胜出但本地没改 credentials 时，可单独采纳 theirs 的 credentials
  （`src/renderer/src/store/syncMerge.ts:49-61,74-156,183-213`）。

如果两边同 ID 实际是两个身份，结果会静默丢掉其中一个，或出现“本地身份字段 + 外部凭据”的混合记录。相关测试甚至把
“ID 由 UUID/fingerprint 生成、碰撞概率约等于 0”写成冲突裁决依据
（`test/renderer/cross-end-sync/syncMerge.test.ts:163-186`）。

注意：这是同一 store 的 renderer/main 并发重放机制，不是跨设备云同步。

### 2.4 反代账号池：运行态直接跨身份继承

池本身是 `Map<accountId, ProxyAccount>`。热切换 `upsertAccount` 发现 ID 已存在时，只替换凭据/路由字段，刻意保留 suspension、errorCount、lastUsed 等运行态
（`src/main/proxy/accountPool.ts:212-236`）。

全量 `replaceAll` 先按 ID 快照旧池，再把以下状态并进同 ID 新记录
（`src/main/proxy/accountPool.ts:771-857,860-896`）：

- `quotaUsed/quotaLimit/quotaResetAt/quotaUpdatedAt/quotaExhaustedAt`；
- `suspendedAt/suspendReason/suspendMessage`；
- `errorCount/lastUsed`；
- `modelCapabilities/lastListModelsAt/lastListModelsStatus`；
- 合并后的 `isAvailable`。

因此 A→B 同 ID 后，B 可被误判额度耗尽、继续处于 A 的风控封禁/断路退避，或继承 A 的模型能力探测结论。反方向也可能让 B 获得 A 的额度/可用性读数。现有测试明确要求同 ID 时迁移这些字段，说明这是设计合同而非偶然实现
（`test/main/proxy/poolResyncPreservesRuntime.test.ts:125-169`）。

池内请求统计也以 ID 为 key（`src/main/proxy/accountPool.ts:76-78,167-175,550-569`）。
`replaceAll` 会重置大部分计数，但热切换 `upsertAccount` 不会重建该项；加权轮询的 credit 同样按
candidate ID 保存（`src/main/utils/smoothWeightedRoundRobin.ts:20-24,56-62`）。因此不经过整池重建的
A→B 还会短期混用调度信用和统计归属。

### 2.5 API Key 账号白名单：授权边界别名化

`apiKeyAccountBindings` 的合同是 `apiKey id -> 允许的 accountId[]`
（`src/main/proxy/types.ts:643-650`），取号时转成 ID Set
（`src/main/proxy/proxyServer.ts:1675-1683`）。

若获授权的 A 被同 ID 的 B 替换，调用方无需修改 API Key 配置就获得 B 的使用权。这不是单纯状态显示错误，而是账号级授权对象发生静默替换。

基线全树只找到该字段的类型、consumer、说明和测试，没有专门的生产写入 UI/API；但已存在或手工写入的
`proxyConfig` 会被整对象加载并展开到运行配置
（`src/main/index.ts:480-487,506-525`）。所以当前影响面是“配置里实际已有该字段”的部署，而不是所有默认安装。

### 2.6 激活/选择/自动换号引用

- renderer 持久化 `activeAccountId`，加载时据此重算 `isActive`
  （`src/renderer/src/store/accounts.ts:198-205,248-257`）；
- 单账号反代持久化 `selectedAccountIds` 并按首个 ID 取账号
  （`src/main/proxy/types.ts:549-555`；
  `src/main/proxy/proxyServer.ts:1848-1859`）；
- 自动换号决策保存 `fromAccountId/toAccountId`，落盘时按 ID 改 active 标记
  （`src/main/accountService/autoSwitch.ts:332-367`）。

同 ID 换身份后，所有既有选择都会无提示地选中 B。完整导入覆盖当前 active ID 时，`activeAccountId` 字符串本身不变；下一次归一化会把 B 标成 active。

### 2.7 会话粘性

会话粘性保存 `sessionHint -> { accountId, lastAt }`
（`src/main/proxy/proxyServer.ts:377-387,5231-5263`）。
命中时只用 ID 从当前池取账号并检查可用性；不会重新核对原身份。

若 A 从池中消失期间没有请求触发失效，而 B 以同 ID 入池，原会话下一次请求会直接发给 B。
可能结果是同一对话后续被计费到/路由到错误账号。若 ID 缺席时先来过请求，代码会删掉粘性，因此此后果有时序条件
（`src/main/proxy/proxyServer.ts:5233-5255`）。
编辑后热更新或全量重同步时 ID 可以始终存在，此时没有“缺席后触发清理”的窗口，既有 affinity 会直接跟到 B。

### 2.8 Prompt cache tracker

缓存模拟器按 `accountId` 保存最多 200 个 fingerprint/TTL 条目
（`src/main/proxy/promptCacheTracker.ts:50-54,104-179`）。

同 ID 的 B 会继承 A 的模拟命中历史；相同提示前缀可能被报告为 cache read，而不是 cache creation。
这里影响的是反代模拟出的 usage/cache 统计，不是把 A 的真实提示正文注入 B。

另一个模型列表缓存的 key 是
``${account.id}:${region}:${profileArn ?? 'no-arn'}``，TTL 为 5 分钟
（`src/main/proxy/kiroApi.ts:843-846,990-1000`）。若 A、B 同 ID 且 region/profileArn 部分也相同或都缺失，
B 会暂用 A 的模型列表。若 profileArn 不同，则该复合 key 会隔离这项缓存。

### 2.9 机器码与 K-Proxy 设备映射

- renderer 持久化 `accountMachineIds: Record<accountId, machineId>`
  （`src/renderer/src/store/accounts.ts:763-785,3826-3850`）；
- K-Proxy 运行态用 `Map<accountId, DeviceIdMapping>`，切号时按 ID 复用设备 ID
  （`src/main/kproxy/index.ts:34-40,183-218`）；
- 若没有显式绑定，`kiroApi` 仍以 accountId 哈希生成稳定 machine ID
  （`src/main/proxy/kiroApi.ts:1920-1939`）。

B 复用 A 的 ID，就会使用 A 的显式设备映射或同一哈希机器码，造成跨上游账号的设备身份关联，可能影响上游风控。正常 renderer 删除会清代理绑定，但没有同时删除
`accountMachineIds`（`src/renderer/src/store/accounts.ts:1209-1224`），所以旧机器码映射尤其容易在旧 ID 被导入恢复时重新附着。
持久化的 `machineIdHistory` 也记录 `accountId/accountEmail`（`src/renderer/src/store/accounts.ts:768-775,3834-3842`）；
复用后旧历史会与新身份共享同一个 ID，虽不直接驱动路由，但审计归属变得含混。

### 2.10 账号到出口代理的绑定

`accountProxyBindings` 是持久化的 `accountId -> proxyId`
（`src/renderer/src/store/accounts.ts:781-785,4214-4243`），主进程同步池时也按 accountId 解析出口
（`src/main/proxy/activation.ts:244-263`）。

导入覆盖或编辑换身份不会自动改变该 key；B 会沿用 A 的出口 IP/代理分桶。正常删除路径会清该绑定
（`src/renderer/src/store/accounts.ts:1216-1224`；基线
`src/main/webPanel/routes.ts:377-422`），因此“先删、确认已同步、普通 UUID 重加”不继承此项。

### 2.11 刷新去重、永久错误退避和 IDE 反向同步

- 主进程按 accountId 对批量 refresh 去重
  （`src/main/index.ts:1598-1618`；
  `src/main/accountService/backgroundRefresh.ts:120-132,396-405`）。
  A 在飞时换成同 ID 的 B，会让 B 被当成同一刷新任务；A 的迟到结果还可按 2.2 写进 B。
- ProxyServer 自己还有第二层 `refreshingTokens: Map<accountId, Promise>`。B 同 ID 时会等待并复用
  A 的在途 Promise；A 完成后又按这个 ID 更新当前池记录并触发持久化回调
  （`src/main/proxy/proxyServer.ts:377-379,1604-1632,1635-1658`）。
- 模型 probe-once 锁使用 `${accountId}:${modelId}`，有效 30 秒。同 ID 的 B 可能因 A 的锁被跳过探测
  （`src/main/proxy/proxyServer.ts:1685-1713`）。
- 永久错误退避 Map 以 accountId 为 key
  （`src/main/index.ts:1626-1647,1701-1715`）。
  编辑账号会保留旧 `lastError`，因此 B 可继续命中 A 的 15 分钟至 24 小时退避。
- `lastSwitchedAccountId` 只保存 ID。IDE token watcher 若 JWT sub/refresh token 未匹配，使用这个 ID 兜底，再把磁盘 token 写进该记录
  （`src/main/index.ts:1579-1594,1254-1315`）。
  A 已切到 IDE、随后同 ID 记录被改成 B 时，A 的 IDE token 可能被兜底写回 B。
- 主动续期 timer 也只保存/回查 accountId
  （`src/main/index.ts:1327-1385`），身份替换后会对当前同 ID 记录执行原 timer 的后续动作。

### 2.12 删除撤销是少数显式防碰撞点

Web 面板的短期 tombstone 按 ID 保存，但恢复前显式检查 live store；同 ID 已存在就 409，不做覆盖
（基线 `src/main/webPanel/routes.ts:441-467,574-600`）。

因此“删除 A -> 新增 B 恰好占用 A 的 ID -> 点撤销”不会让 tombstone 覆盖 B。这个局部守卫不能保护编辑、完整导入、异步迟到结果或池重同步。

### 2.13 备份/恢复

内建安全备份保存的是 `accountData` 快照；启动恢复只在主 `accountData` 缺失时整份写回，并把 revision
初始化为 0（`src/main/index.ts:1109-1129,1517-1558,2131-2137`）。它不把备份账号与当前账号逐条 merge，
进程重启也会清掉池、affinity、prompt cache 等纯内存状态，所以它本身不是制造两个 live 记录 ID 冲突的路径。

但它会原样重放快照中已有的 ID 语义；而 `selectedAccountIds`/`apiKeyAccountBindings` 位于单独的
`proxyConfig`，不在该 `accountData` 备份内，主数据缺失时不会随恢复一起清空
（`src/main/index.ts:480-525`）。若这些外部引用仍在，它们会按字符串重新附着到恢复后的账号。
手工迁移整份 `kiro-accounts.json` 则是所有顶层键一起离线替换，不是 merge。

## 3. 场景可达性矩阵

| 场景 | 结论 | 理由 |
|---|---|---|
| 删除 A，再用普通登录/注册/profile 流程重加同一个 A | **通常不复用 ID** | 统一 `addAccount` mint 新 UUID；自动本机 SSO mint 新 `email-now`。身份相同但记录 ID 改变。 |
| 删除 API Key 账号，再导入同一 key | **不复用旧 ID** | 旧记录不存在后判重索引不再命中；新记录用 `crypto.randomUUID()`。 |
| 现存 A 时重复导入同一 API key/同一完整身份 | **通常被跳过** | API Key 路径按 fingerprint/userId 判重；完整导入按 userId 或三元组判重。 |
| 用简化 `AccountImportItem[]` 两次导入同一凭据 | **可产生重复身份，但 ID 不复用** | 该入口没有身份判重，每项各 mint 新 UUID；结果是同一上游身份对应多个本地 ID。 |
| 删除 A，再导入 A 的完整旧导出 | **复用旧 ID，但仍是同一上游身份** | 导出 ID 被保留。它证明 ID 可在时间上恢复，但本身不证明跨不同身份。 |
| 在编辑框把 A 的凭据换成 B | **确定可达；跨不同身份复用同 ID** | 验证 B 后按 `account.id` 写回，无旧/新身份等价校验、无判重。台账 #31 的决定性路径。 |
| 导入一个“ID=A、身份=B”的完整 JSON | **确定可达；会覆盖现存 A** | 文件控制 ID；身份判重不检查 ID；`Map.set` 后写覆盖。需要用户/外部工具提供这种文件。 |
| Web 面板删除后撤销 | **不会覆盖同 ID 新记录** | 恢复前有 `ACCOUNT_ALREADY_EXISTS` 守卫。 |
| 应用自动从安全备份覆盖一个已分叉的 live store | **内建流程不可达** | 只有 `accountData` 不存在才恢复；恢复整份数据，不 merge。 |
| 按运维文档把桌面文件复制到 Linux 后继续双向合并 | **不存在该产品能力** | 文档明确一次性初始化，之后两份数据独立。手工覆盖是整文件替换，不是 merge。 |
| 两设备独立新增同一上游账号，再自动同步 | **不存在自动同步；若经导入汇合，通常按身份判重** | 两端 UUID 不同；仓库没有跨设备合并服务。要把另一设备的完整 `Account/id` 汇入现有集合，只能走完整导入；简化/API Key 导入会另 mint 本地 ID。 |
| 两设备随机生成相同 UUID | **理论可达、工程上极低概率；代码无碰撞守卫** | UUID v4 是本地随机；若真碰撞，Map/merge 仍按同一记录处理。风险结论不依赖此事件。 |
| `email-Date.now()` 与历史 ID 碰撞 | **有条件可达** | 需同 email、同毫秒，或时钟回拨/受控时间；没有碰撞检测。归档证明该格式真实进入过 store，但未证明碰撞发生过。 |
| 同一进程 renderer/main 并发各新增相同 ID | **只有生成器/输入先发生碰撞后才会进入冲突分支** | `syncMerge` 会按记录冲突裁决，而不是识别两个身份。 |

## 4. 磁盘证据与测试所编码的假设

### 4.1 既有台账为什么一直是 unverified

归档对账把 #31 写成：

> 仓库内没有上游唯一性证明或碰撞测试；需要上游文档或实测样本。

证据：`.agent-workspace/.archive/2026-08-13/ledger-reconciliation/findings.md:49-53,191-193,221-224`；
当前总台账仍把它列为“拿到外部证据前 unverified”
（`.agent-workspace/TASKS-2026-08-13.md:343-351`）。

该判断漏掉了两个事实：`id` 多数由本应用生成而非上游签发；编辑账号可以在不改 ID 的情况下接受另一个身份。因此无需等待上游唯一性合同，静态调用链已经能关闭“是否可能”。

### 4.2 真实历史数据形状

既有只读取证对本机 6 份真实/历史 store 的结论是：

- `accountData.accounts` 是按 ID 键控的对象；
- 历史样本中出现过 UUID ID：
  `9a1bbbf1-…`；
- 也出现过 email+13 位毫秒时间戳 ID：
  `<email>-1783971256990`；
- 同一个 UUID 在相隔约 9 分钟的两份备份中仍指向同一脱敏 email，只是错误文本变化。

证据：`.agent-workspace/.archive/2026-08-09/headless-server-migration/forensics-error-status-accounts.md:22-35,53-66,70-90`。

这证明两种生产 ID 形状都真实落过盘，也提供了一个账号短期稳定使用同 ID 的正样本；它**不能**证明从未跨账号复用，因为该归档没有为每个快照保存可比对的 `userId/profileArn/token fingerprint`，且 keyed object 在碰撞后只留下胜者。

### 4.3 测试中的明确假设

1. `replaceAll` 测试要求同 ID 时继承 quota、suspension、errorCount/lastUsed，正面编码了
   “同 ID = 同一账号”的运行态合同
   （`test/main/proxy/poolResyncPreservesRuntime.test.ts:125-169`）。
2. 三方合并测试明确写：
   “现实里 id 是 uuid/fingerprint，碰撞概率约等于 0；真碰撞时本地用户操作优先”
   （`test/renderer/cross-end-sync/syncMerge.test.ts:163-186`）。
   这段注释与现实偏离两点：至少一条生产 ID 是 `email-Date.now()`；完整导入和编辑都绕过随机碰撞前提。
3. 完整导入判重测试证明判据是 `userId` 或
   `(email, provider, profileArn)`，而不是 ID
   （`test/renderer/multi-profile-import/store-isAccountExists.test.ts:44-155`）。
4. 未找到覆盖以下行为的测试：完整导入 ID 与现存不同身份冲突、编辑凭据返回不同 userId、
   A 的异步结果在同 ID 已变成 B 后回写。文件系统级 Everything 检索也没有发现未跟踪测试中的
   `id collision` / `id reuse` 用例。

### 4.4 Git 考古

- `EditAccountDialog` 的“验证新资料后仍 `updateAccount(account.id, ...)`”从根提交
  `89872d0` 就存在；`git log -S "updateAccount(account.id"` 没显示后来引入过身份一致性约束。
  因此它不是近期 `replaceAll` 重构造成的偶发回归，而是长期记录编辑语义。
- `email-Date.now()` 自动 SSO ID 和批量化的完整导入 `accounts.set(acc.id, acc)` 都可追到
  `67e4928`（v1.7.0）；随后 `52adb46` 扩展了身份副键到 profileArn，但仍没有增加 ID 冲突判定。
- `mergeRuntimeState` 由 `90ac4d8`（“全量同步不再擦额度”）引入。代码注释和测试都表明按 ID
  迁移 quota/封禁/断路器是为修复真实运行态丢失而刻意做出的选择，不应把它误报成无意的 Map 行为；
  本次取证发现的是其“同 ID 仍代表同一身份”前提并未由写入边界维护。

## 5. 最终判词

### 已解决

- **“账号 ID 是否可能跨两个不同账号复用？”——是。**
- **“ID 是否来自上游并受上游全局唯一合同保护？”——否；它主要是本地记录 ID，且有导入提供和编辑保留路径。**
- **“`replaceAll` 按 ID 迁移运行态的前提是否由当前写入路径保证？”——否。**
- **“风险是否只存在于 UUID 极小概率碰撞？”——否。编辑凭据和可控完整导入都能确定性到达。**

最直接的失败形态是：A 的记录 ID 不变但身份变成 B；B 会保留 A 未被编辑 patch 覆盖的持久化字段
（若跳过重验，连 email/userId/usage/subscription 也仍是 A），随后在热切换或全量同步时继续继承 A 的
quota/402、suspension、断路器和能力状态。与此同时，API Key 白名单、单账号选择、会话粘性、出口代理、
机器码和异步写回都仍把这个字符串解释为原对象。

### 仍未由现有磁盘材料回答，但不影响上述 verdict

**真实用户数据里历史上是否已经发生过 A→B 复用，以及发生频率是多少，仍无证据。**
要回答的是“发生史”，不是“可达性”。能关闭该次级问题的外部证据应是：

1. 至少两份按时间排序的真实 store 快照，对每个 ID 比较脱敏稳定身份元组
   `(userId, provider, profileArn, HMAC(refreshToken或API-key fingerprint))`；
2. 编辑账号前后的审计样本，记录旧/新脱敏身份元组和不变的 record ID；
3. 若只关心普通生成器碰撞率，收集真实 ID 全量并按 ID 分组，再检查同 ID 下身份元组是否变化。

原始 token 不需要、也不应进入证据；带固定审计密钥的 HMAC 足以做跨快照等值比较。仅提供一份最终 keyed object、账号总数或 email 列表无法证明“从未复用”，因为覆盖发生后旧值已经不在文件中。

## 6. 方法与边界

- `codegraph-codegraph_explore` 本轮返回 `Not connected`；没有把它的零结果当作不存在。
- 调用链由 `fast-context-fast_context_search` 与
  `codebase-context-engine-search_context` 交叉定位，再用逐文件读取确认。
- tracked 源码用文本检索复核；未跟踪/ignored 区域另用 Everything 文件系统级内容搜索，避免
  `git grep` 的索引盲区。
- Git HEAD 确为 `10bdf3440d3b1500821918899c8b81701be2dbda`。工作树并非用户描述的 clean：
  存在其他会话的未提交 WebPanel/测试改动和大量 untracked 归档。核心取证文件
  `accounts.ts`、`EditAccountDialog.tsx`、`verify.ts`、`importApiKey.ts`、`accountPool.ts`、
  `proxyServer.ts`、`syncMerge.ts` 及三份引用测试相对 HEAD 均无 diff。
  `webPanel/routes.ts` 有一组无关的 unsuspend 在飞改动，本文该文件的行号特意按 HEAD 基线给出。
- 本报告判断“可达”基于代码接受任意能验证成功的凭据这一观察；若要把 UI 链在真实服务上做动态复现，
  需要两个授权测试账号。动态复现会证明发生过程，但不会改变静态代码已经给出的可达性结论。
