# 挂起账号重启后不回池 —— 是设计还是缺陷

侦察模式:Mode R(现实校对) · 只读 · 未改任何代码
日期:2026-08-10

## 结论(先给底线)

**混合缺陷。** 不是「每个触发都是真永久」,也不是「全盘错」:

- 走 `markSuspended` 的四个反代触点里,**`TEMPORARILY_SUSPENDED`(Kiro 风控临时封) 是瞬时态,永久排除对它是错的**;
- 更严重的是:真正把账号钉死在池外的闸门是 `status !== 'active'`,而 **`status: 'error'` 有一大批与封禁无关的写入者** —— 其中 `check.ts:629` 的 catch-all 把**网络错误 / 超时 / DNS 失败**也写成 `error`。这类账号从此永久出不了池,而它压根没被任何后端封禁。

一句话:**缺陷,因为 (a) `TEMPORARILY_SUSPENDED` 是瞬时的,以及 (b) 后台测活的网络异常会伪装成永久封禁。**

---

## 1. suspendReason 清单与瞬时/永久裁决

分类器唯一真源:`src/main/proxy/proxyServer.ts:1196-1225` `detectSuspendedError()`。四条分支:

| # | reason | 触发条件(file:line) | 裁决 |
|---|---|---|---|
| 1 | `TEMPORARILY_SUSPENDED` | `proxyServer.ts:1201` 显式 body `"reason":"TEMPORARILY_SUSPENDED"`;`:1208` 文本特征 `/temporarily suspended/i`、`/User ID is (temporarily )?suspended/i` | **瞬时** —— 名字里就写着 temporarily。源码注释自称「Kiro 风控」。风控限流按定义会自行解除 |
| 2 | `ACCOUNT_SUSPENDED` | `proxyServer.ts:1201` 同一正则的枚举项 | 永久(需人工) |
| 3 | `PERMANENTLY_SUSPENDED` | `proxyServer.ts:1201` 同一正则的枚举项 | 永久(字面) |
| 4 | `AccountSuspendedException` | `proxyServer.ts:1214` CodeWhisperer 异常名 / `Account suspended` 字面 | 永久(需联系 AWS Support,见 `types.ts:454` 注释) |
| 5 | `ACCOUNT_LOCKED` | `proxyServer.ts:1220` HTTP 423 + `locked\|suspended` | 永久偏向(423 Locked 语义是被锁定),但无 TTL 依据 |

关键点:**分支 1 和分支 2/3 共用同一个正则、走同一条返回路径、下游零区分**。`markSuspended(accountId, reason, message)`(`accountPool.ts:372`)只存 reason 字符串,`onAccountSuspended` 回调(`index.ts:653-680`)对所有 reason 一律写 `status: 'error'`。**「临时」和「永久」在写入点被抹平** —— 这就是缺陷的第一个来源。

反代侧四个触点(全部调同一个分类器,语义一致):
`proxyServer.ts:1737`(callWithRetry 主路径) · `:3263`(OpenAI 兼容路径) · `:3523`(单行 hold-gate 记账) · `:4468`(403 补检)。

另一处独立分类器 `kiroApi.ts:615-700`(`verifyApiKey` 风格的状态机)把 **429 限流和 5xx 明确判为 `INDETERMINATE` 而非 `SUSPENDED`**(`:637-641`)—— 说明这套代码库里**已经存在**「瞬时错误不该判死」的正确认知,只是没贯彻到反代侧的持久化路径。

## 2. `status !== 'active'` 过滤是刻意还是顺手?

**顺手复用(incidental),证据有三层。**

过滤本体 `src/main/proxy/activation.ts:186`:

```ts
if (asString(a.status) !== 'active') continue
```

零注释。`git log -L 186,187:src/main/proxy/activation.ts` 显示该行随文件在 `fab59a8 feat(proxy): 反代编排下沉主进程 · 面板可选号启停` 一次性新建落地,**没有单独的「为什么用 status 当可用性闸门」的提交或说明**。

对比:**同文件、同函数族里,凡是刻意的可用性设计都写了长注释。** `activation.ts:220-224`:

```
// 步骤 1:入池 / 刷凭据。用 upsert 而非 addAccount —— 后者是重置式,会按
// 不带 suspendedAt 的映射重算 isAvailable=true 并清零断路器,等于「切一下
// 账号就静默解除运行期风控封禁」。
```

`accountPool.ts:194-199`:

```
// 为何不能直接 addAccount:它是重置式——按入参重算 isAvailable(前端 mapper 不带
// suspendedAt ⇒ 算出 true)并清零 errorCount/requestCount/统计,于是"切一下账号"会静默
// 解除运行期风控封禁,并让 proxy-set-active-account 的 ACCOUNT_NOT_AVAILABLE 守卫失效。
// 详见 RCA §4.2b:.archive/2026-07-28/proxy-hot-switch-single-account/
```

这两处作者精确知道「盘上记录不带运行期状态」,并为此专门设计了 `upsertAccount` 去保护 `suspendedAt`。**但他们保护的是热切换场景(进程内),不是重启场景。** 而 `activation.ts:186` 的 `status` 过滤是**显示字段被当成可用性字段用** —— `status` 的其它写入者(见下)证明它从来不是一个可用性语义的字段。

第三层证据最有说服力:`accountPool.ts:137-138` 的注释

```
// 添加账号
// 如果传入的 account 已带 suspended 字段（启动复原场景），保留其 suspended 状态
```

**「启动复原场景」这条路径在今天的代码里到达不了。** 因为:
1. 落盘写入(`index.ts:670-675`)只写 `status` / `lastError` / `lastCheckedAt` —— **`suspendedAt` 从不落盘**(`index.ts:661` 的 `suspendedAt: Date.now()` 只进 IPC 事件,不进 store);
2. 读回的 mapper `toProxyAccountShared`(`activation.ts:101-142`)**完全不映射 `suspendedAt` / `suspendReason` / `suspendMessage`**;
3. 即使前两条修好,`activation.ts:186` 也会先把记录整个滤掉。

所以 `addAccount` 那句注释描述的是一个**设计意图,而非现实** —— 作者本意是「重启后带着封禁状态入池,由池内判据跳过」,现实变成「重启后压根不入池」。**这正是 incidental 的定义:真实行为是三处独立疏漏叠加的产物,不是任一处的设计决定。**

### 附带发现:`status: 'error'` 的其它写入者(比封禁问题更大)

`status` 是显示字段,写入者众多且语义各异:

| 写入点 | 触发 | 是否该永久出池 |
|---|---|---|
| `check.ts:629` `sliceResults.push({success:false, error:message})` → `persistCheckResult.ts:259` | 后台测活里**任何未捕获异常**:网络错误 / 超时 / DNS 失败 | **绝对不该**。账号完好,只是当时网不通 |
| `check.ts:567,594` | `AccountSuspendedException` / 423 | 合理 |
| `check.ts:574` → `status='expired'`(非 error) | 401/403 token 过期 | 走 expired,同样被 `!== 'active'` 滤掉 |
| `check.ts:601` | 用户状态非 Active/Stale | 合理偏向 |
| `store/accounts.ts:1893,1904` | 前端单账号刷新失败(含网络失败) | 不该 |
| `DiagnosePage.tsx:326` | 手动测活失败 | 不该 |

`persistCheckResult.ts:258-259` 是最锋利的一行:

```ts
if (!item.success) {
  return { ...account, status: 'error', lastError: item.error, lastCheckedAt: now }
}
```

**`!item.success` 不区分「被封禁」和「网络没通」。** 一次断网时的后台批量测活,足以把全部账号写成 `error`,此后它们永久不再进反代池,直到用户逐个手点。这与「挂起」无关,但共用同一个致命闸门。

## 3. 用户能看到信号吗?

**桌面端能,但信号错位;局域网面板不能;重启后的静默出池完全没有信号。**

有信号的部分:
- `AccountCard.tsx:377-386` 用 `lastError` 做文本匹配识别封禁(`accountsuspendedexception` / `temporarily_suspended` / `423` 等),置 `isUnauthorized`,渲染封禁态 + `showBanDialog` 详情弹窗;
- `AccountCard.tsx:888-889` 渲染 `lastError` 红条(仅 `!isUnauthorized` 时);
- 存在**手动解封**通路:`AccountCard.tsx:180-189` → IPC `proxy-clear-account-suspended`(`index.ts:6382-6402`)→ `clearSuspended()` + 盘上 `status` 回 `'active'`、`lastError` 清空。**这是唯一的恢复入口,且必须人工点。**
- HoldGate 挂起时 `proxyServer.ts:3823` 调 `describeBlockedAccounts()` 写 `proxyLogger.warn`,UI 可见。

信号缺口(三处,按严重度):
1. **`describeBlockedAccounts()` 只遍历池内账号**(`accountPool.ts:454-457` `for (const a of this.accounts.values())`)。**重启后被过滤掉的账号根本不在池里,所以永远不会出现在这份「被封禁清单」里。** 用户看到的是「池空 / 无号可试」,而非「你有 5 个号因为上次的网络抖动被挡在池外」。诊断信号恰好在最需要它的场景下消失。
2. **局域网面板零覆盖**:`git grep -n "suspend" -- src/main/webPanel/ src/main/ipc/` 返回空。面板 DTO(`webPanel/dto.ts:152-153`)只透传 `status` 字符串,没有解封动作、没有封禁解释。面板用户无法自救 —— 这对无头/服务器部署是硬阻塞。
3. **网络错误伪装成封禁后无法识别**:`AccountCard` 靠 `lastError` 文本匹配判封禁,网络错误消息匹配不上 → 只渲染一条普通红字。用户看到「一条不起眼的错误」,不会想到这个号已被永久踢出反代池。

## 4. 修复选项与代价(仅估算,未实现)

| 方案 | 做法 | 代价 | 评价 |
|---|---|---|---|
| **A. 写入点区分瞬时/永久**(推荐主干) | `detectSuspendedError` 返回值加 `permanent: boolean`;`TEMPORARILY_SUSPENDED` / `ACCOUNT_LOCKED` → 瞬时,不落盘 `status:'error'`(仅内存 `suspendedAt`,与 402 额度耗尽语义对齐);`ACCOUNT_SUSPENDED` / `PERMANENTLY_SUSPENDED` / `AccountSuspendedException` → 落盘 | 改 1 个分类器 + 1 个回调;`kiroApi.ts:615-700` 已有同类三态状态机可参照 | 治的是「临时被当永久」这个根因,而非症状。**且与现有 402 路径的持久化语义统一** |
| **B. 池闸门与显示字段解耦**(推荐,与 A 并行) | `activation.ts:186` 不再用 `status`,改判专用可用性字段(如落盘的 `suspendedAt` + `suspendPermanent`);`toProxyAccountShared` 补映射这三个字段,让 `addAccount:138` 那条「启动复原场景」注释真正成立 | 改 mapper + 过滤 + 落盘写入点三处;需回归「热切换不得静默解封」(`accountPool.ts:194-199` 已有 RCA 保护) | **治附带发现的网络错误误杀** —— 只做 A 不做 B,`check.ts:629` 那条路仍在钉死好账号 |
| **C. TTL 自动恢复** | 瞬时 reason 存 `suspendedAt`,超过 TTL(如 30min)自动放行重试一次 | 需一个定时器或懒判定;TTL 取值无依据,得靠观测 | 可作 A 的补充,但**不能替代 A** —— 没有 A 的区分,TTL 会把真永久封禁也放回去反复撞墙 |
| **D. 显式「重新启用」动作补齐到面板** | 把 `proxy-clear-account-suspended` 暴露到 `webPanel/routes.ts` + 面板 UI | 小(桌面端 IPC 已存在,照搬) | **无论 A/B 是否做都该做** —— 无头部署当前没有任何自救手段 |
| **E. 只补可观测性** | `describeBlockedAccounts` 扩展到「盘上被过滤掉的账号」,HoldGate 日志里点名 | 小 | 不修复行为,但把静默失败变成可诊断失败。**若决定「文档化而非修复」,这条是最低限度** |

建议组合:**A + B + D**。A 修分类,B 修闸门(覆盖网络错误误杀),D 解无头部署的死锁。C 可选,E 被 A/B 内含。

## 5. 未验证项

- 未运行任何测试或实际启动应用 —— 全部结论来自静态读码,`unverified: 只读侦察,未做运行时复现`。
- `TEMPORARILY_SUSPENDED` 的真实解除时长无数据(Kiro 后端行为),故方案 C 的 TTL 取值缺依据。
- 未核查 `store/accounts.ts:2300` 一线的前端手动置 active 路径是否还有其它隐式恢复分支(任务给定信息,本轮未复验)。
