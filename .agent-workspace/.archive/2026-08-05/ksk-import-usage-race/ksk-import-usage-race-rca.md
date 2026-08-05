# RCA · ksk_ 导入后额度停在 0/0(store 同步竞态被静默 return 吞掉)

- 日期:2026-08-05
- 引入提交:`fce8c89 feat(accountService): ksk_ 导入下沉共享层 · 面板可导入账号`
- 类型:🐛 Bug flow(回归)

## 🔴 1. 现象与上下文

用户导入新的 `ksk_` API Key 后,账号出现在列表里但额度一直显示 **0/0**,不会自动刷新;
手动点「检查账户信息」却能正常刷出来。用户最初怀疑「注册地区那一块」逻辑被改掉。

**成功态(用户视角)**:
> NOT「checkAccountStatus 被调用过」,BUT「用户导入一个 ksk_ 之后,不做任何额外操作,
> 账号卡片上就显示真实额度(如 2672.06 / 10000)」。
> 负条件:不得出现「显示 0/0 且无任何错误提示」这种无声失败。

来源:用户原话(「新增账户之后它不会自动的刷新余额度,他都会显示一个零零」)。

**现象锁定(单一可证伪命题)**:
导入完成后 renderer 侧那次自动 `checkAccountStatus` **从未把 IPC 发出去**,
因此 main 侧 `applyAccountDataMutation` 的额度落盘从未发生。

## 🔍 1.5 假设账本

| ID | 假设 | 状态 | 证据 |
|----|------|------|------|
| A | 跨区探测(`probeApiKeyCredentialAtRegion` / `KNOWN_CW_DATA_REGIONS`)在拆分时丢失 | 🔴 falsified | `verify.ts:141` 仍调 `validateApiKeyCredential(apiKey, region)`,注释明确 `probe.region` 是跨区探测实际命中的 region;另有专测 `test/main/api-key-validation/validateApiKeyCredential.crossRegion.test.ts` |
| B | check 路径 region 兜底成 `us-east-1` → 403 | 🔴 falsified | 实测日志 `GetUsageLimits [token:Vj10Wo] region=eu-central-1 → 200`;`[KiroAPI][DIAG] account.region=eu-central-1 \| dataPlaneRegion(used)=eu-central-1` |
| C | 上游返回 `limits:null`,parseUsage 取不到额度 | 🔴 falsified | 额度在 `usageBreakdownList[0]`(`currentUsage 2672.06` / `usageLimit 10000`),`parseUsage.ts:157` 宽判据 `resourceType==='CREDIT' \|\| displayName==='Credits'` 精确命中 |
| D | renderer store 尚未同步 → `if (!account) return` 静默退出 | 🟢 **confirmed** | `store/accounts.ts:2022` 原文即 `if (!account) return`;`AddAccountDialog.tsx:1466` 在 `importApiKeys` resolve 同 tick 调用;`git show fce8c89` 证明老代码靠同步 `addAccount` 才能命中 |
| E | 面板(手机端)导入路径同样不刷额度 | 🟢 **confirmed** | `routes.ts:handleImport` 原文 `const result = await task` 直接 `sendJson`,零 check 触发 |

## 🔍 2. 根因分析

**为什么现在的实现必然失败**:

拆分前(`fce8c89^`),renderer 自己把账号写进 store:

```ts
const newId = addAccount({ usage: { current, limit, percentUsed } })  // zustand 同步 set
void checkAccountStatus(id)      // 同一 tick 内 accounts.get(id) 必然命中
```

拆分后,判重/四态判定下沉主进程(动机正确 —— 两端共用一份实现),renderer 改为
依赖主进程写盘 + `accounts-data-changed` 广播 → `App.tsx:150` → `reloadFromStorageQuiet`。
但调用方式照搬了老写法:

```ts
const result = await window.api.importApiKeys({...})   // 主进程写盘完成 + 发广播
for (const r of result.results) {
  if (r.accountId) void checkAccountStatus(r.accountId)  // ← 广播链还没跑完
}
```

`importApiKeys` 的 Promise resolve 与 store 完成 reload 是**两条独立时序**:后者要经
IPC 广播 → 读盘 → 解密 → `set()`。前者先到,于是 `accounts.get(id)` 返回 `undefined`。

**首个断裂点**:`src/renderer/src/store/accounts.ts:2022` — `if (!account) return`

这行静默兜底把竞态完全吞掉:无日志、无报错、无重试。IPC 从未发出 ⇒ main 侧那次
`applyAccountDataMutation` 落盘从未发生 ⇒ 额度永远停在 `importApiKey.ts` 写的占位值
`{ current: 0, limit: 0 }`。手动点刷新能成功,因为那时 store 早已同步。

**Bug 类别**(§5.2 七类):**Execution Order / Async Race** — 兼 **Interface Contract Ambiguity**
(下沉改变了「调用本函数前 store 已含该账号」这一隐式前置条件,但调用点未随之调整)。

## 🕵️ 3. 变体扫描

重复实现检索:
- 内部 `Get-ChildItem src -Recurse | Select-String "checkAccountStatus\("` → renderer 侧 8 处调用点
  (AccountCard:307 / AccountGrid:73 / AccountList:45 / AccountListRow:236 / AddAccountDialog:1466 /
  store 内部 1820 · 1982 · 3124 · 3264 · 3268),**全部经由同一个 store action** ⇒ 修在该 action
  内即为收口,无需逐点改(SSOT)。
- 面板侧 `routes.ts:457` 是服务端直接 `loadAccountsBlob()` → `findAccountRecord` → check,
  同步等写盘后再读,**结构上不存在此竞态**。

指纹:**「跨进程/异步写入后,在同一 tick 按 id 读本地缓存」**。

| 变体 | 位置 | 风险 | 本轮修 |
|---|---|---|---|
| 桌面端导入后自动刷额度 | `AddAccountDialog.tsx:1466` → `store:2022` | 高(用户实测命中) | ✅ 在 store action 内自愈收口 |
| **面板导入完全不触发 check** | `routes.ts:handleImport` | 高(手机端导入必然 0/0) | ✅ 补 fire-and-forget 触发 |
| `percentUsed` 单位 0-100 混入比例口径 | `importApiKey.ts:478` | 中(有值时显示 500%) | ✅ 改为比例 0~1 |
| 同母题「静默跳过导致毫无反应」 | `batchRefreshTokens` 的 `!refreshToken → continue` | — | 已由 `test/renderer/liveness/batchRefreshApiKey.test.ts` 守护(前人已修) |

## 👥 4. 真实场景模拟

1. **导入即刷新的时序赛跑**(本 bug 本体):广播链慢于 Promise resolve。防御 = 自愈 reload 重试。
2. **手机连点两次提交同一批**:`importInFlight` 以粘贴内容为键做 single-flight(既有),
   新增的 check 触发挂在 `singleFlight('check:<id>')` 上,并发导入不会重复打上游。
3. **一批 20 个 key**:check 走 fire-and-forget,不阻塞 HTTP 响应;否则手机端会以为卡死。
4. **账号导入后立刻被删**:reload 后仍找不到 → 记 `console.warn` 后安全退出,不抛异常。
5. **额度接口失败**:不翻转「已导入」这一既成事实,但留痕(不再无声)。

未处理(明确登记):额度刷新失败目前只进 `console.warn`,未在 UI 上给用户可见提示 —— 属独立的
可观测性改进,不在本轮范围。

## 📚 5. 行业参照

未做外部检索:根因由本仓代码 + 实测日志直接判定(`git show fce8c89` 的 diff 即证据),
不依赖外部结论。同类模式在本仓已有先例并被测试固化 —— `test/renderer/liveness/batchRefreshApiKey.test.ts`
文件头记录的正是同一母题(「静默跳过 → 用户看到毫无反应」),可作内部参照。

## 🛠️ 6. 外科手术式修复

| 文件 | 改动 |
|---|---|
| `src/renderer/src/store/accounts.ts` | `checkAccountStatus` 找不到账号时先 `reloadFromStorageQuiet()` 对齐盘面再重试;仍找不到才 `console.warn` + return(不再静默) |
| `src/main/webPanel/routes.ts` | `handleImport` 导入成功后 fire-and-forget 触发额度刷新,与桌面端对称 |
| `src/main/accountService/importApiKey.ts` | `percentUsed` 由 `Math.round(x*100)` 改为比例 `currentUsage / usageLimit` |

**刻意不改**:
- `importApiKey.ts` 的「只写占位值、额度由调用方触发」分层 —— 导入是写盘、check 是网络,
  耦合会让导入 20 个 key 变成串行 20 次上游往返。
- `AddAccountDialog.tsx:1466` 的调用点 —— 修在被调方(store action)才是收口;
  若逐个调用方 `await` 广播,判据散落且新增调用方仍会再踩。
- `updateAccountStatus` 的落盘行为(既有技术债,已在源码注释登记)。

## ⚠️ 7. 影响面与回归风险

**影响面**:renderer 侧 8 个 `checkAccountStatus` 调用点全部受益;正常路径(store 已有账号)
新增 0 次读盘(用例 2 专门守护这点)。面板新增一次导入后的后台额度拉取。

**回归测试**:
- `test/renderer/ksk-import-usage-race/checkAccountStatusReload.test.ts`(新增 3 例)
  - store 未同步 → reload 自愈 → 额度落进 store + `percentUsed` 为比例
  - store 已有 → 不做多余 reload
  - reload 后仍无 → 不发 IPC 但留 warn
- `test/main/accountService/importApiKey.test.ts`(新增 1 例)`percentUsed` 比例断言
- `test/main/webPanel/importAccounts.server.test.ts`(新增 2 例)导入后触发 / 全失败不触发

**Mutation 验证**:
- 移除 store 自愈 → 3 例中 2 红(用例 2 保持绿,证明非恒红)
- `percentUsed` 改回 `Math.round(*100)` → 1 红(19 绿)
- 面板 `if (false && ...)` 禁用触发 → 1 红(12 绿)

**消费锚点**:最终 sink = 账号卡片上的额度数字。端到端姿态 = 面板测试真起
`http.Server` + 真 `fetch` POST `/panel/api/accounts` 后断言 check 被打出;
桌面端为 store action 级(IPC 边界以 mock 断言,真实链路已由本次线上复现覆盖)。

**验证**:`npm run typecheck` EXIT=0;`npx vitest run` → **97 files / 1029 tests 全绿**。

## 🧩 8. 边界加固

补了两处此前缺失的边界:
1. `checkAccountStatus` 对「store 与盘面不一致」这一现实的自愈能力(此前假设调用方保证一致)。
2. 面板导入路径的「导入后刷额度」编排(此前只有桌面端有,两端行为不一致 ——
   违反用户明确要求的「面板与桌面端行为一致」)。
