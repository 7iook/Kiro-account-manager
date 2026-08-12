> ⚠️ **本卡是开工前闸门，不是事后报告。**（Globalrules §6.0.1）

# 挂起门闸可观测性 —— 放行时间线与触发原因面板

- **日期**：2026-08-10
- **类型**：✨ Feature 流（新增可观测能力）→ Boundary Decision Card
- **上游**：`.archive/2026-08-09/hold-gate-auto-release/decision-card.md`（自动放行本体已交付）
- **触发**：用户 2026-08-10 —— 「前端增加类似日志，显示上一次是何时触发闸门（账号封禁 / 额度上限）、起始时间、下次放行预计时间、本轮会话已放行次数，并记录每次放行的起始与结束，方便观测」

---

## 📋 任务清单

- [x] T-1 `HoldGate` 时间线环形缓冲 + 触发原因入参（TDD red→green，FakeClock）
  - **Evidence** · `commit pending` · verify: red 基线 `npx vitest run test/main/proxy/holdGateTimeline.test.ts` → `16 failed / 0 passed`（失败原因全为 `getTimeline is not a function` / `settleLastRelease is not a function`，即功能缺失而非语法错误）→ green `16 passed`；`npx vitest run test/main/proxy/` → **`422 passed / 0 failed`**（既有 `holdGate.test.ts` 41 例 + `holdGateSessionLifecycle` 7 例无回归）· files: `src/main/proxy/holdGate.ts`（新增 `HoldReason` / `ReleaseOutcome` / `HoldRelease` / `HoldEpisode` 类型 + `getTimeline()` `:205` + `settleLastRelease()` `:223` + 三个私有埋点 `openEpisodeIfNeeded` / `finalizeEpisode` / `recordRelease`）· `test/main/proxy/holdGateTimeline.test.ts`（新增 16 例）· AC: §4 测试边界 1-12 全覆盖 + §1 I1/I2/I3
- [x] T-2 `ProxyServer` 采集触发原因 + 放行结局回填（`runWithHold` 三处埋点）
  - **Evidence** · `commit pending` · verify: `npm run typecheck:node` EXIT=0 · files: `src/main/proxy/proxyServer.ts:3934-3941`（`holdReason` 由**已有的** `poolBlocked` / `errKind` 映射，不新建第二套判据）· `:3871` `enterHold({ ..., reason, detail })` · `:3955` 拿不到号 → `settleLastRelease('re-held')` · `:3966` `attempt` 返回 `'done'` → `settleLastRelease('resumed-and-served')` · AC: §3 链路节点 2/3/4
- [x] T-3 读数出口：getter → IPC → preload → 推送形状（两个发射点同源）
  - **Evidence** · `commit pending` · verify: `npm run typecheck` 双 project EXIT=0 · files: `proxyServer.ts:103-113`（`HeldRequestsInfo` 扩两字段）· `:520-527`（`buildHeldRequestsInfo` 单一构造点，`:472`/`:521` 两发射点自动同源）· `:533` 新增公开 `getHeldRequestsInfo()` · `src/main/proxy/index.ts:7`（barrel 导出类型）· `src/main/index.ts:6472-6488`（**顺手治类**：两条兜底路径原各手抄一份字段字面量 → 收口为单个 `emptyInfo()`，此后加字段不会漏改一处）· preload 两文件已 `import type`，自动跟随 · AC: §3 链路节点 1/5/6
- [x] T-4 桌面端时间线 UI（触发原因 / 起始 / 下次放行 / 累计 / 每轮明细）
  - **Evidence** · `commit pending` · verify: `npm run typecheck:web` EXIT=0；全量 `npx vitest run --reporter=json` → `1335 passed / 0 failed` · files: `src/renderer/src/components/proxy/ProxyPanel.tsx:217-256`（`clockTime` / `humanDuration` / 视图类型）· `:257-420`（`HoldTimeline` 组件，含 outcome 徽标的逐态 title 解释）· `:1783`（挂载点，在自动放行块之后）· `:735-752`（`applyHeldInfo` 扩两字段 —— **拉取与推送共用这一个函数**，不可能一条路径漏读）· `:1752-1768`（补上此前界面缺失的「累计放行」读数）· AC: §5 注册清单前 3 项 + 口径差异写进 title
- [x] T-5 手机面板同等读数（只看，不加操作）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/ipc/ test/main/webPanel/ test/renderer/web-panel-ui/` 全绿（含 3 条原本因替身缺 `getHeldRequestsInfo` 而红的既有用例）；`npm run build:webpanel` EXIT=0（产物新鲜度闸门 `webpanel_build_assets.test.ts` 由红转绿） · files: `src/main/ipc/panelProxyDeps.ts:29-30`（类型导入）· `:59`（`ProxyServerRef` 加签名）· `:130-138`（`PanelProxyStatus` 扩两字段，**必填**，沿用该文件既有决策：留 `?` 会把契约漂移渲染成一个平静的合法业务态）· `:220-223`（未初始化分支）· `:248`（改走单一构造点 `getHeldRequestsInfo()`，丢弃面板用不上的 `count`）· `src/webPanel/api/panel.ts:228-253`（`PanelHoldRelease` / `PanelHoldEpisode`）· `:272-279`（`ProxyStatus` 扩两字段）· `src/webPanel/ui/ProxyPanel.tsx:351-515`（`HoldTimelineBlock` + 挂载，复用父组件既有 1s 心跳的 `now`，不自建定时器）· AC: §5 手机面板项 + 「只看不改」边界
- [x] T-6 单测全绿 + 归档写回
  - **Evidence** · `commit pending` · verify: **`npx vitest run --reporter=json` → `numTotalTests=1335 / numPassed=1335 / numFailed=0 / success=true`**（JSON 口径，不用 `| Select-String` 后读 `$LASTEXITCODE` —— 那读的是管道最后一个命令的退出码，上一轮已产出过假绿）；`npm run typecheck` 双 project EXIT=0 · 生产接线逐符号验证（非仅 tests/）：`settleLastRelease` ← `proxyServer.ts:3955` `:3966` + `holdGate.ts:522` `:529`；`getTimeline` ← `proxyServer.ts:520`；`getHeldRequestsInfo` ← `index.ts:6484` + `panelProxyDeps.ts:248`；`HoldTimeline` ← `ProxyPanel.tsx:1783` · AC: 全卡


每项完成前先写回：勾 `[x]` + `**Evidence**`（commit / verify+EXIT / files / AC）+ 追加 `## Update Log` 一行。

---

## 🏗️ 1. Boundary Decisions

### Success State（§0.15B · 来源已标注 · 非自拟）

**NOT** 「后端多打了几行日志」，
**BUT** 用户在界面上能回答三个问题：① 这次挂起是**什么原因**触发的（账号封禁 / 额度上限 / 授权失效 / 池空）、**几点**开始 ② 下次自动放行还有多久 ③ 本轮会话已放行几次、**每次几点放的、放完之后请求是活了还是又挂回去了**。

**来源**：用户 2026-08-10 原话（见上「触发」栏）逐项对应。第③项的后半句「放完之后是活了还是又挂回去」是我加的一个字段，理由见下。

**Must NOT happen**：
1. 观测设施本身影响挂起/放行时序（埋点必须是旁路，不得进入 CAS 认领路径）
2. 时间线无上限增长 → 长会话内存泄漏
3. 时间线里的时间戳与倒计时用不同时钟源 → 界面自相矛盾
4. 触发原因显示「未知」却实际有明确原因可取（`describeBlockedAccounts()` 已有现成数据）

### 为什么必须加「放行结局」这个字段（用户未要求，但它是本轮唯一能证伪承重假设的读数）

上一轮决策卡 §1 自己标注：**「放行为何能重置客户端计时的内部机制未逐字节取证」**。而 `holdGate.ts:159-166` 的注释断言「放行让上游重跑，产生客户端可见的流活动」。

顺 `runWithHold` 读下来，池仍无号时这条链**一个下游字节都不写**：

```
自动放行 → releaseAll() → resume → settleHold(true)
  → proxyServer.ts:3925  waitInHold() 返回 true
  → :3926  pickFresh() → null（池全挂）
  → :3927  triedIds.clear() 再试 → 仍 null
  → :3928  continue → 回到 for(;;) 顶
  → :3888  decideHoldAction → 'hold' → 再次 waitInHold()
```

全程唯一下游写入是 `enterHold` 起的 `sendPing`，而 `2026-08-06` RCA §2.1 已 🟢 证实 **watchdog 只认语义正文字节，ping 不重置它**。

所以「放行了 N 次」这个数字**单独存在时无法区分两种截然不同的世界**：

| 世界 | 放行后 | 客户端 600s 计时 | 用户观感 |
|---|---|---|---|
| 甲 · 放行拿到号、真吐正文 | `attempt` → `'done'` | **被重置** | 功能有效（= 用户手动实测到的那次） |
| 乙 · 放行仍无号、又挂回去 | 重新 `enterHold` | **未重置** | 「放行了 5 次但请求还是断了」 |

**记一个 `outcome` 字段（`resumed-and-served` / `re-held` / `ended`）就能让用户一眼分辨**，这也正是上一轮 E1 验收要花 20 分钟才能得出的结论 —— 观测上去后它自己就浮出来。用户说「你去复现很浪费时间」，这个字段是复现的替代品。

### 状态机（时间线条目的生命周期）

```
enterHold(第一个条目) → 开一条 HoldEpisode { reason, startedAt, releases: [] }
   ↓
自动放行到点 → push 一条 release { at, trigger:'auto', outcome:'pending' }
   ↓
主循环回填 outcome ──┬─ 拿到号且 attempt 完成 → 'resumed-and-served'  ← 甲世界
                     ├─ 仍无号、重新 enterHold → 're-held'            ← 乙世界
                     └─ 超时/abort 终态       → 'ended'
   ↓
集合空 → 关闭该 episode（endedAt）
```

### 不变量

- **I1**：埋点全部旁路 —— 时间线写入失败/异常不得影响放行本身（try-catch 隔离，失败静默）
- **I2**：环形缓冲上限 **20 个 episode × 每 episode 最多 50 条 release**（超出丢最旧），随 `resetSessionState()` 清空 —— 与 `autoReleaseCount` 同生命周期（已有先例，勿新造口径）
- **I3**：时间戳统一用 `HoldClock.now()`（与 `nextAutoReleaseAt` 同源，防 Must NOT #3）
- **I4**：触发原因在 `enterHold` **入参**传入，不由 `HoldGate` 自行推断（它不认识账号池 —— 同 `autoReleaseEnabled` 生效值那次的教训：门闸不知 `holdWhenNoAccount`）

### 裁决

| # | 议题 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 时间线存内存还是落盘 | **仅内存** | 用户诉求是「本轮会话观测」；落盘要引入 `ProxyLogStore` 那套 save/截断/滚动，与"会话内归零"语义冲突 |
| D2 | 是否复用 `proxyLogger` | **不复用，另立结构化时间线** | `proxyLogger` 是**扁平字符串流**且 2026-08-06 RCA §1.6 已证「无请求 ID + 批量放行 ⇒ 任何时间戳配对结论无效」。本轮要的正是配对（起始↔结束），必须结构化 |
| D3 | 是否顺手给挂起/放行日志加请求 ID | **加** | 侦察报告 §8 风险 7 已建议、至今未做；不加则下次排查重演 4172s 仪器错误。属 §4.8 顺手治类 |

### ADR admission

**不需要**。纯可观测性增强，不改边界 / 状态机 / 依赖方向；`enterHold` 加一个可选入参属向后兼容的实现细节。

---

## 🔍 2. 既有实现检索（§2.2）

### 内部

| 查什么 | 工具 + query | 结果 |
|---|---|---|
| 是否已有事件历史/环形缓冲设施 | ACE `环形缓冲区保存最近若干条事件历史供前端展示` | 命中 `proxy/logger.ts:374-473`（`ProxyLogStore`：`maxLogs` + 5% 均摊 splice + 落盘）与 `types.ts:739` `recentRequests: RequestLog[]` —— **均为扁平字符串/请求级，非挂起 episode 结构**，见 D2 不复用 |
| 触发原因是否已有现成数据 | `git grep describeBlockedAccounts` | ✅ `accountPool.ts:471` 已返回封禁/额度描述数组；`proxyServer.ts:3903` 已在挂起时调它打日志 —— **直接复用，零新建** |
| 挂起决策分类 | 读 `proxyServer.ts:3975-4030` | `shouldHoldForNoAccount()`(池权威) + `isAccountLevelAuthFailure()` + `decideHoldAction()` 三段已把原因分好类 —— **原因枚举照它现成的分类，不自造** |
| 首字节标志能否复用 | `git grep bodyStarted` | ⛔ `proxyServer.ts:3561` 是 `attempt` **闭包内局部变量**，`runWithHold` 拿不到。故 outcome 改由主循环的**控制流走向**判定（拿到号→`'done'` vs 回到 `enterHold`），**不改 attempt 签名** |
| 放行入口 | 读 `holdGate.ts:296` | `releaseAll()` 复用，不新建第三入口（守上一轮 I2） |

**结论：原因数据、分类逻辑、放行入口全部现成；本轮只加「结构化时间线容器 + 三处埋点 + 读数出口」。**

### 外部

| query | 工具 | 结论 |
|---|---|---|
| 客户端 stall 阈值与判据 | 复用 `2026-08-06` RCA §5 已取证结论（`code.claude.com/docs/en/env-vars` + issues #47623 / #61001 / #57088） | `CLAUDE_ENABLE_STREAM_WATCHDOG` v2.1.196 起默认开；判据是语义正文字节；sub 路径 600s 不恢复。**本轮不重复检索**（同一事实 4 天内已取证两次） |

**无可复用第三方库** —— 项目特有的门闸 episode 语义。

---

## 📐 3. 接口契约

### 新增类型（`holdGate.ts` 导出）

```ts
/** 挂起触发原因（照 proxyServer 现有决策分类，不自造）。 */
export type HoldReason =
  | 'account-blocked'      // 池内有号被封禁/额度耗尽（shouldHoldForNoAccount）
  | 'account-auth-failure' // 最近错误是账号级授权失效（isAccountLevelAuthFailure）
  | 'pool-empty'           // 无 pre-body 错误：池空 / UI 指定号不在池 / 池未同步
/** 一次放行的结局 —— 本卡新增的关键判据字段，理由见 §1。 */
export type ReleaseOutcome = 'pending' | 'resumed-and-served' | 're-held' | 'ended'

export interface HoldRelease {
  at: number                    // 放行时刻（HoldClock.now()）
  trigger: 'auto' | 'manual' | 'pool-available' | 'poll'
  outcome: ReleaseOutcome
  outcomeAt: number | null      // 结局落定时刻；null = 尚未回填
}
export interface HoldEpisode {
  id: number                    // 单调递增，全实例不复用
  reason: HoldReason
  detail: string[]              // describeBlockedAccounts() 原样，可空数组
  startedAt: number
  endedAt: number | null        // null = 仍在挂起中
  releases: HoldRelease[]
}
```

### 读数字段（扩现有 `HeldRequestsInfo`，向后兼容加字段）

| 字段 | 类型 | 语义 | 空态 |
|---|---|---|---|
| `currentEpisode` | `HoldEpisode \| null` | 当前进行中的挂起（含 reason / startedAt / 已放行明细） | `null` = 当前无挂起 |
| `recentEpisodes` | `HoldEpisode[]` | 最近已结束的 episode（最新在前，≤20） | `[]` |

`count` / `autoReleaseEnabled` / `nextAutoReleaseAt` / `autoReleaseCount` 四个既有字段**语义不变**（`autoReleaseCount` 仍是周期数，与 `releases.length` 口径不同：前者含「触发了但 0 条可放」的周期，后者只记真放了的 —— 界面上两个数不一致是**正常的**，需在 title 里说明，否则用户会以为有 bug）。

### 链路（照上一轮 7 节点，逐格钉死符号名）

| # | 节点 | 生产者 | 消费者 |
|---|---|---|---|
| 1 | `HoldGate` 时间线 + getter | to-build `getTimeline(): { current, recent }` | `proxyServer.buildHeldRequestsInfo()` |
| 2 | 触发原因入参 | to-build `EnterHoldParams.reason` + `.detail` | `holdGate.enterHold` |
| 3 | 原因采集 | `proxyServer.ts:3888-3905`（decision/poolBlocked/errKind/blockedList **已全在手**） | 传入 `enterHold` |
| 4 | outcome 回填 | to-build `holdGate.settleLastRelease(outcome)` | `proxyServer.ts:3926-3930`（拿号成功/失败两分支）+ 终态分支 |
| 5 | 单一构造点 | `proxyServer.ts:515 buildHeldRequestsInfo()`（**已存在**，扩两字段即可，两发射点自动同源） | IPC `index.ts:6418` + 推送 `:472`/`:521` |
| 6 | preload | `src/preload/index.ts` + `index.d.ts` 复用 `HeldRequestsInfo` 类型（**已是 import type，非手抄**） | 渲染进程 |
| 7 | 桌面/手机 UI | `renderer/.../ProxyPanel.tsx:1465-1540` 自动放行块内扩展；`webPanel/ui/ProxyPanel.tsx` | 用户 |

**最终 sink**：桌面端自动放行面板下方新增时间线区（截图中「自动放行 间隔(分钟) 8 下次放行 —」那一行下方）；手机面板同区只读。

**真跑一次的 e2e 姿态**：单测层用 FakeClock 造「挂起→自动放行→仍无号→re-held→再放行→拿到号→resumed-and-served」完整时间线并断言字段；**客户端侧仍标 `unverified`**（沿用用户裁决不复现），但**本功能本身就是为了让这个 unverified 在真实使用中自然消解**。

---

## 🧪 4. Test Boundaries（TDD Red）

1. `首次挂起时开一条episode_记录触发原因与起始时刻`
2. `自动放行时向当前episode追加一条release_trigger为auto且outcome初始为pending`
3. `放行后仍无号重新挂起_上一条release的outcome回填为re-held`
4. `放行后拿到号并完成_outcome回填为resumed-and-served`（**甲世界，承重**）
5. `超时收尾终态_outcome回填为ended`
6. `集合清空时episode被关闭并写入endedAt_移入recentEpisodes`
7. `episode数超过20_丢最旧不无限增长`（Must NOT #2）
8. `单个episode的release超过50条_丢最旧`
9. `resetSessionState清空时间线_与autoReleaseCount同步归零`
10. `时间线时间戳与nextAutoReleaseAt同源_均来自注入时钟`（Must NOT #3）
11. `手动放行与自动放行的trigger可区分_且autoReleaseCount只统计auto周期`（口径不混）
12. `时间线写入抛异常时放行仍正常完成`（I1 旁路隔离）

边界（§5.4）：并发多条挂起同时放行（一次 `releaseAll` 放 3 条 → **1 条 release 记录还是 3 条**？→ 裁决：**1 条**，因为 release 是「周期动作」不是「条目动作」，与 `autoReleaseCount` 口径一致）· episode 跨 stop/start · 时钟回拨。

---

## 🛡️ 5. 注册检查清单

| 项 | 状态 |
|---|---|
| `buildHeldRequestsInfo()` 单一构造点扩两字段（两发射点自动同源） | ⛔ 必做 |
| preload `index.ts` + `index.d.ts` 类型（复用 import type，勿手抄） | ⛔ 必做 |
| 桌面端 UI + 中英文对照（现有 hold 控件全部双语，勿只写中文） | ⛔ 必做 |
| 手机面板 `PanelProxyStatus` 扩字段（**只看，不加操作** —— 守 `routes.ts:364-378` 既有边界） | ⛔ 必做 |
| 挂起/放行日志加请求标识（D3 · 顺手治类） | ⛔ 必做 |
| `autoReleaseCount` 与 `releases.length` 口径差异写进 UI title | ⛔ 必做（否则用户以为是 bug） |
| 面板产物重建 `npm run build:webpanel`（有新鲜度闸门） | ⛔ 必做 |
| 第三方 SDK 隔离 | N/A（无新依赖） |

---

## Update Log

- 2026-08-10 · 初稿。检索确认触发原因数据（`accountPool.ts:471`）与分类逻辑（`proxyServer.ts:3975-4030`）全部现成，本轮只加结构化时间线容器 + 三处埋点 + 读数出口。在用户要求的四项之外增加 `ReleaseOutcome` 字段，理由：它是唯一能区分「放行真吐正文」与「放行空转」两个世界的读数，也是上一轮决策卡自标未取证的那个承重假设的判据。

- 2026-08-10 · **实现完成（T-1~T-6 全绿）**。全量 `1335 passed / 0 failed`，`typecheck` 双 project 干净，面板产物已重建。
  - **实施期改了一个设计决定（归档时机）**：初版把「集合变空即关闭 episode」放在 `claim()` 里，测试立刻抓到它会把**一轮挂起切碎** —— 放行的正常形态是 `releaseAll` 清空集合 → 主循环拿号 → 拿不到又立刻 `enterHold`，于是同一轮被切成 N 个「各自只放行了 1 次」的 episode，而用户问的正是「这次挂起从几点开始、一共放了几次」，切碎后这个问题答不了。改为由**显式结局**驱动归档：`resumed-and-served` / `ended` 归档，`re-held` 视为同一轮延续。
  - **中途走过一次弯路并纠正**：第二版试图在 `openEpisodeIfNeeded` 里用 `held.size === 0` 推断「上一轮是否已结束」，但该方法在 `held.set` **之前**被调用，故这个判据对「re-held 延续」与「全新一轮」没有区分力（两者都是 0），测试再次转红。最终改为完全不推断，归档只由 `settleLastRelease` / `onTimeout` / `abort` / 手动放行四个**显式**结局点驱动。教训：靠集合大小猜调用方意图，正是把 re-held 切碎的同一个错误的第二次形态。
  - **顺手治类（§4.8）**：`index.ts` 的 `proxy-get-held-requests` 两条兜底路径原本各手抄一份字段字面量，每次给 `HeldRequestsInfo` 加字段都要同步改两处、漏一处就是「前端字段时有时无」（E-060 形态）。已收口为单个 `emptyInfo()`。同时发现桌面端界面此前**根本没有显示 `autoReleaseCount`**（只有倒计时），本轮补上 —— 用户要的「本轮会话已放行次数」原先只存在于 IPC 里。
  - **口径差异已写进 UI title**：`autoReleaseCount`（周期数，含「触发了但当时无可放对象」的空周期）与时间线 `releases.length`（真放了的次数）**本来就会不一致**，不说明用户会当成 bug。
  - **命令层教训**：本轮连续三次 `edit_block` 的非 ASCII `old_string` 在传输中被改写（全角/半角逗号不匹配），第三次起按 `mcp-tooling-policy §2.0` 切到 `edit_lines`（行号寻址 + 纯 ASCII 载荷）后一次成功；另有一次 PowerShell 相对路径被解析到 mcphub 的 cwd（`E:\MCP\mcphub`），改绝对路径后正常 —— 两条都是既有规则里写着的坑。
  - **客户端侧效果仍标 `unverified`**：本轮交付的是**观测能力**，不是对「放行能否重置客户端 600s 计时」的验证。但这正是本卡的用意 —— `outcome` 字段让该问题在真实使用中自然浮现：连续 `re-held` ⇒ 放行在空转（乙世界）；出现 `resumed-and-served` ⇒ 那次真的续上了（甲世界）。用户无需专门复现。
