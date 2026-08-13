# 账号记录 ID 身份不漂移守卫

- 日期：2026-08-13
- 基线：用户给定 `28fab53`
- 裁决：同一记录 ID 已有非空 `userId` / `email` 后，不允许清空或换成别的值；缺失字段首次补齐允许；删除后以新 ID 重加不报警
- 数据处置：守卫拒绝写入；启动审计只报告，绝不修改或删除账号数据

## 1. 交付结果

### 1.1 最低共享写入点

不可绕过的最终守卫放在：

- `src/shared/accountIdentity.ts`
  - `findAccountIdentityTransitionViolation`：比较单条记录的新旧 `id/userId/email`
  - `findAccountIdentityMutationViolations`：比较整份账号 blob，并识别本次新引入的 record-key/id 不一致和重复 record id
  - `assertAccountIdentityInvariant` / `AccountIdentityDriftError`
- `src/main/accountService/state.ts`
  - `applyAccountDataMutation` 在 mutator 返回、真正 `store.set` 和广播之前调用 `assertAccountIdentityInvariant(prev, next)`

该位置覆盖两端的理由：

1. 桌面 renderer 的 `saveAccounts` 最终调用 `accountService/accounts.ts -> applyAccountDataMutation`。
2. 已核对手机面板 `src/main/webPanel/routes.ts`：账号编辑、删除、撤销恢复分别直接调用 `applyAccountDataMutation`；API Key 导入由 deps 注入同一 mutation。没有发现面板账号写入绕过共享点直接 `store.set`。
3. main 后台的额度、刷新、异步结果回写同样走该收口，因此即使未来 UI 层漏掉检查，持久化 sink 仍拒绝同 ID 换身份。

已有脏数据不会把所有后续无关写入锁死：整表检查只拒绝“本次新引入”的结构问题；原样保留的旧问题交给启动审计报告。删除记录以及“旧 ID 删除、同一身份以新 ID 新增”均允许。

### 1.2 桌面编辑 UX

`src/renderer/src/store/accounts.ts::updateAccount` 在修改 Zustand Map 前复用共享 transition 校验，失败返回结构化 `ACCOUNT_IDENTITY_DRIFT`，不改内存、不触发保存。

`EditAccountDialog.tsx`：

- 验证返回的 `userId/email` 与原记录不一致时，保存被拒并显示“这是另一个账号，请改用新增”；
- refresh token / client id / client secret / region 被改动后，必须重新验证，避免形成“A 的身份字段 + B 的凭据”混合记录；
- 账号已被其他端删除时显示刷新重试提示。

### 1.3 完整导入的 ID 冲突策略

选择：**逐项拒绝冲突项，不另分配 ID**。

导入先按 `id` 查既有记录和本批已接纳记录，再做旧有的 userId/三元组判重：

- 同 ID 且任一已建立的 `userId/email` 不同：`failed + 1`，返回带冲突字段的错误，不执行 `Map.set`；
- 同 ID 且身份一致：按“已存在”跳过，也不覆盖已有凭据；
- 本批两个不同身份使用同一 ID：后项被拒。

拒绝而非静默重 mint 的原因：完整导出的 ID 可能被 activeAccountId、代理绑定、机器码等外部引用；擅自改 ID 会把一个损坏/冲突输入伪装成成功，并产生引用语义不明确的新记录。明确拒绝可审计，也让用户通过正常“新增账号”流程获得新 ID。

特别把 ID 冲突检查放在普通 userId 判重之前；否则“同 userId、不同 email、同 ID”会被静默记为普通 skip，违背 email 也不可漂移的裁决。

## 2. 启动只读审计

挂载点：`src/main/accountService/accounts.ts::loadAccounts`。同一个 store 实例每进程只运行一次，避免面板轮询反复刷日志。桌面 renderer 启动加载账号时会立即触发；裸 Node 服务端当前会在首次账号列表请求时触发。

当前可报告：

- `RECORD_KEY_ID_MISMATCH`：对象存储 key 与记录内 `id` 不一致；
- `DUPLICATE_RECORD_ID`：多条记录声明同一 `id`；
- `HISTORICAL_IDENTITY_MISMATCH`：
  - 当前 email 与 `accountData.machineIdHistory.accountEmail` 中同 ID 历史不一致；
  - 可选历史快照与当前同 ID 的 `id/userId/email` 不一致。

单条格式示例：

```text
[AccountIdentityAudit] suspicious account record "A": HISTORICAL_IDENTITY_MISMATCH; fields=email; sources=machineIdHistory; report-only, no data changed
```

汇总格式：

```text
[AccountIdentityAudit] startup scan complete: 1 suspicious record(s); report-only, no data changed
```

桌面端写 console，既有 console 拦截会进入日志通道；裸 Node 服务端额外写 `proxyLogStore`，category 为 `AccountIdentityAudit`。审计及历史读取失败只记错误，不影响账号加载，更不会写回数据。没有按 UUID 或 `email-时间戳` 外形猜测，两种合法 ID 形态均不会因此报警。

### 2.1 历史证据的客观边界 / 装配需求

单份 keyed-object 当前快照在覆盖发生后只剩胜者；若既没有 `machineIdHistory`，也没有保留旧快照，从信息上无法推回被覆盖前的 `userId/email`。

为此 `AccountStoreDeps` 已预留只读 `loadAccountIdentityHistory?: () => Promise<readonly unknown[]>`，但按文件所有权没有修改以下装配点：

- 桌面：`src/main/index.ts` 的 `accountDeps`
- 服务端：`src/main/server/assembly.ts::buildStoreDeps`

因此本轮无需 assembly 才能完成“当前结构 + machineIdHistory”审计；若合并方有可用、可信且已解密的历史快照源，要覆盖没有 machineIdHistory 的历史漂移，需要在上述两处装配该 hook。现有单份安全备份通常跟随最新成功写入，不能假装成完整历史账本。

另一个明确的 server 装配缺口：`src/main/server/assembly.ts` 目前只把
`loadAccounts(storeDeps)` 暴露为面板路由依赖，服务进程启动本身不调用它。若要求“无须任何面板请求、Node 进程一启动就出审计日志”，该文件的 owner 需在
`proxyLogStore.initialize`、store 注入和 `storeDeps` 构造完成后主动 `await loadAccounts(storeDeps)` 一次。本轮遵守所有权没有修改；共享审计本身已具备 once 保护，补该调用不会因后续轮询重复刷屏。

## 3. 测试与回归

### 3.1 红灯

按真实入口先写测试：

- renderer 编辑 + 完整导入：`0/2` 通过，证明旧实现会返回 `undefined` / 允许覆盖；
- main 共享 mutation + 启动审计：`19/21` 通过，新增两条失败；
- 未重新验证凭据：`0/1` 通过。

均使用用户指定的双 reporter 和 `*>` 重定向方式，JSON 的 `numFailedTests` 与 default 日志分开读取。

### 3.2 绿灯

最终定向：

```text
npx vitest run test/renderer/accountIdentityInvariant.test.ts test/renderer/editAccountCredentialVerification.test.tsx test/renderer/multi-profile-import/store-isAccountExists.test.ts test/main/accountService/state.test.ts test/main/accountService/accounts.test.ts ...
34 passed / 0 failed（这些文件也包含在下方最终 357 项绿灯中）
```

账号、导入、跨端同步、accountService、账号池相关回归：

```text
npx vitest run test/main/accountService test/renderer/cross-end-sync test/renderer/multi-profile-import/store-isAccountExists.test.ts test/renderer/accountIdentityInvariant.test.ts test/renderer/editAccountCredentialVerification.test.tsx test/main/proxy/poolAdmission.test.ts test/main/proxy/poolResyncPreservesRuntime.test.ts test/main/proxy/quotaFeedToPool.test.ts test/main/proxy/accountPoolAvailabilityNotify.test.ts test/main/proxy/quotaSurvivesResync.test.ts ...
357 passed / 0 failed
```

类型检查：

```text
npm run typecheck:node  -> EXIT 0
npm run typecheck:web   -> EXIT 0
```

额度持久化旧测试曾把每个账号的上游身份统一伪造成 `x@example.com`，以及把 `old@example.com` 的记录刷新成 `new@example.com/uid-9`。新守卫正确把这些测试夹具识别为跨身份写入。没有为“可信刷新”增加绕过；测试改为上游返回与各自原记录一致的身份后，额度、revision、广播、并发删除、批量切片等 `14/14` 全绿。

### 3.3 全量套件的越界失败

最新全量尝试为 `1832 passed / 2 failed / 6 skipped`。两项失败均位于另一 executor 正在修改且本任务禁止改动的 web panel 范围：

1. `test/main/architecture/webpanel_build_assets.test.ts`：`src/webPanel/**` 新源码晚于构建产物，要求该 owner 执行 `npm run build:webpanel`；
2. `test/renderer/web-panel-ui/panelProxyConfig.test.tsx`：页面停在“等待反代配置读取完成”，找不到“新端口”输入框。

未修改或重建这些越界文件。上述 357 项账号相关回归和两个 typecheck 均为绿色。

## 4. 驳回的做法

- **只在 EditAccountDialog 判断**：手机/后台/整表保存可绕过，不能维护 sink 不变量。
- **只加 `id === id` 判断**：问题正是同一个 ID 下 `userId/email` 被换掉，比较 ID 自身没有保护作用。
- **导入冲突静默分配新 ID**：会隐瞒坏输入并擅自改变完整备份的引用语义。
- **把额度刷新等 main 路径标成 trusted 后绕过**：验证返回另一个身份时正是必须拒绝的场景；否则后台仍可制造漂移。
- **按 ID 字符串形状报警**：UUID 与 email-时间戳都是历史合法来源，会制造误报。
- **启动时自动修复、删除、合并记录**：历史证据可能不完整，自动处置会静默改用户凭据；严格保持 report-only。
- **新增永久身份账本/状态机**：超出用户边界；本轮只消费已有历史和可选只读快照。
- **改封禁/账号池继承语义**：根因在写入边界，`accountSuspension.ts` 和 proxy 运行态均未触碰。

## 5. 本任务修改范围

- `src/shared/accountIdentity.ts`（新增）
- `src/main/accountService/accounts.ts`
- `src/main/accountService/state.ts`
- `src/main/accountService/types.ts`
- `src/renderer/src/store/accounts.ts`
- `src/renderer/src/components/accounts/EditAccountDialog.tsx`
- `test/renderer/accountIdentityInvariant.test.ts`（新增）
- `test/renderer/editAccountCredentialVerification.test.tsx`（新增）
- `test/main/accountService/state.test.ts`
- `test/main/accountService/accounts.test.ts`
- `test/main/accountService/checkPersistence.test.ts`（仅将跨身份假数据改成同身份夹具）
- `test/main/accountService/quotaObservationOrdering.test.ts`（仅将跨身份假数据改成同身份夹具）

没有修改 `src/main/webPanel/**`、`src/webPanel/**`、`src/main/proxy/**`、`src/main/server/assembly.ts`、`src/main/index.ts`、`src/shared/accountSuspension.ts` 或 `vitest.config.ts`，没有 commit。
