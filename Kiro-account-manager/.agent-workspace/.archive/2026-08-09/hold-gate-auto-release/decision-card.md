> ⚠️ **本卡是开工前闸门，不是事后报告。** 未过评审 P0 不得写实现代码（Globalrules §6.0.1）。

## 📋 任务清单

- [x] T-1 配置项落地：`ProxyConfig` 两个新字段 + `holdConfig.ts` clamp + **`HOLD_KEYS` 白名单加键**
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/holdConfig.test.ts` → `13 passed` EXIT=0 · files: `src/main/proxy/types.ts:679-690`（两字段声明）· `src/main/proxy/holdConfig.ts:83-103`（默认值 + clamp + Layer C warn 常量）· `src/main/proxy/proxyServer.ts:820-826`（HOLD_KEYS 7→9 键）· AC: §3 配置项表两行 + §1 边界值归一化表四条
- [x] T-2 `HoldGate` 自动放行调度器（TDD red→green，FakeClock）
  - **Evidence** · verify: `npx vitest run test/main/proxy/holdGate.test.ts test/main/proxy/holdConfig.test.ts` → `Tests 41 passed (41)` EXIT=0（red 基线 `7 failed | 34 passed` EXIT=1）· 全 main 套件 `81 files passed` EXIT=0 无回归 · `npm run typecheck:node` / `typecheck:web` EXIT=0 · files: `src/main/proxy/holdGate.ts` `src/main/proxy/holdConfig.ts` `src/main/proxy/types.ts` · AC: 池不可用仍到点放行 / 开关 / timer 生命周期跟随集合(activeTimerCount 回 0) / CAS 不重复 resume / D1 重建生效 / 计数口径 / D2 逐 action / nextAt 非 0 语义 + 重建不中间 null · commit: pending（主 AI 提交）
- [x] T-3 读数出口：`HoldGate` getter → `ProxyServer` → IPC 返回形状 + 推送事件形状（**两个发射点都改**）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/` → `252 passed / 26 files` EXIT=0 · files: `src/main/proxy/proxyServer.ts:91-99`（`HoldAutoReleaseState` 类型）· `:497-516`（`getHoldAutoReleaseState` + 私有 `buildHeldRequestsInfo` 唯一构造点）· `:472` + `:521`（两发射点同源，形状分叉结构上不可能）· `:832`（HOLD_KEYS 命中调 `applyAutoReleaseConfig`，D1 重建 timer）· `src/main/index.ts:6418-6430`（IPC 三字段 + `!proxyServer` 与 catch 两条兜底路径齐备）· `src/preload/index.ts` + `index.d.ts`（复用 `HeldRequestsInfo` 类型，非手抄字面量）· AC: §3 三字段契约表 + 读数链路 1-5 跳
- [x] T-4 桌面端界面：开关 + 间隔输入 + 倒计时 + 累计次数
  - **Evidence** · `commit pending` · verify: `npx vitest run` → `1097 passed / 102 files` EXIT=0；`npm run typecheck:node` + `typecheck:web` 均 EXIT=0 · files: `src/renderer/src/components/proxy/ProxyPanel.tsx`（+166 行：开关 / 间隔 / 倒计时 / 累计 / 超时策略联动提示 / 门闸关闭时置灰）· `:501-507`（同时消费拉取与推送两条路径，字段名与生产端逐字一致）· AC: §5 注册清单前 4 项 + 界面文案要求（`holdTimeoutAction` 非 keep_blocking 时提示自动放行将失效）
- [x] T-5 手机面板：扩 `PanelProxyStatus` 三个可选字段 + `POST /api/proxy/release-held`（契约见 §3 手机端段）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/webPanel/ test/main/ipc/ test/renderer/web-panel-ui/` → 全绿；面板产物已重建（`npm run build:webpanel`，新鲜度闸门实跑通过） · files: `src/main/ipc/panelProxyDeps.ts:109-200`（状态扩三字段）· `:307`（releaseHeldRequests dep）· `src/main/ipc/webPanelWiring.ts`（`buildPanelRouteDeps` 补装配 —— 派单范围外但缺它整链在装配处断）· `src/main/webPanel/routes.ts:421`（POST 路由，走 `server.ts:314 guard()` + `singleFlight('proxy-release-held')`）· `src/webPanel/api/panel.ts` · `src/webPanel/ui/ProxyPanel.tsx` · `src/webPanel/ui/format.ts`（`null` vs 合法 epoch `0` 语义）· `test/main/ipc/panelProxyDeps.test.ts`（新增）· AC: §3 手机端契约表全 9 行 + §5 手机面板项
- [x] T-6 单测全绿；客户端侧效果标 `unverified`（用户裁决不跑 E1-E4，留作待办验收）
  - **Evidence** · `commit pending` · verify: 整合态连跑两次 `npx vitest run --reporter=json` → **`1164 passed / 0 failed`（两次一致）**；`npm run typecheck:node` / `:web` 均干净；`git diff --check 4d60c44` `EXIT=0` · files（本项为汇总验收，逐项文件锚点如下）: `src/main/proxy/types.ts:679-690` · `src/main/proxy/holdConfig.ts:83-103` · `src/main/proxy/holdGate.ts:110-254` · `src/main/proxy/proxyServer.ts:95-99,497-516,659,787,820-826,844` · `src/main/index.ts:6418-6430` · `src/preload/index.ts` + `index.d.ts`（复用 `HeldRequestsInfo`）· `src/renderer/src/components/proxy/ProxyPanel.tsx:501-507` · `src/main/ipc/panelProxyDeps.ts:109-224` · `src/main/ipc/webPanelWiring.ts` · `src/main/webPanel/routes.ts:421` · `src/webPanel/api/panel.ts` · `src/webPanel/ui/ProxyPanel.tsx:135-174` · `src/webPanel/ui/format.ts` · AC: §4「单测必跑；E1-E4 本轮不跑」+ 客户端侧效果全程标 `unverified`，交付报告不写「已验证」
- [x] T-7 清理死代码（计划外 · 实施期发现 · 根因在主 AI 派单）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/` → `252 passed` EXIT=0；零调用者经**三重检索**确认（git 索引 / 文件系统级含未跟踪 / 全工作树多扩展名扫描） · files: `src/main/proxy/holdGate.ts`（删 `isAutoReleaseEnabled`，369→364 行；字节级确认 CRLF 与无 BOM UTF-8 未变） · AC: 交付物内无零调用生产符号（E-052 形态）
- [x] T-8 修计数不归零（审查 C3 · 已核实为真缺陷 · 已修）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/holdGateSessionLifecycle.test.ts` 红 `EXIT=1 · 7 failed`（其中 3 条钉住缺陷本体：`expected 2 to be +0` / `expected 1 to be +0` / `expected 0 to be greater than 0`，另 4 条为 `resetSessionState is not a function`）→ 绿 `EXIT=0 · 7 passed`；`npx vitest run --reporter=json` → `1151/1151 · failed=0` · files: `src/main/proxy/holdGate.ts`（新增 `resetSessionState()`：清挂起条目 + 停调度器 + 停兜底轮询 + 计数归零；改正错注释）· `src/main/proxy/proxyServer.ts:656`（listen 回调内，紧随 sessionStats 重置块）+ `:784`（`stop()` 的 `finish()` 内，与 activeRequests/sockets 清理同组）· `test/main/proxy/holdGateSessionLifecycle.test.ts`（新）· AC: §3 `autoReleaseCount` 行「反代停止归零」
  - **根因是一句错注释而非漏调用**：原字段注释写「随实例生命周期归零（反代 stop/start 即新实例）」—— 该前提为假（门闸只在构造函数创建一次），T-2 正是照此实现。注释已改正并记录其为根因。
  - **同类问题另查出三处**（非「其他都没事」）：① 调度器在 stop 后仍在跑（对已停服务放行 + timer 泄漏）② 挂起条目在 stop 后仍留存（`getHeldRequestsCount()` 仍返回 1）③ **内存归零但界面看不到** —— 桌面端挂载时拉一次、之后靠推送，故两处 reset 后各补一次 `emitHeldRequestsChanged()`，否则「测试里修好了、屏幕上还是旧值」。
  - **两端都重置的理由**：`stop()` 在 `!this.server` 时早返回，崩溃/被杀路径不会走 `finish()` → start 侧兜住；stop 侧则防「调度器对着已停服务跑」。reset 语义为 **void-don't-drive**（同 `abort` 类，不触发任何 hooks）；`seq` 刻意继续递增，避免上一会话的迟到 abort 命中新条目。
- [x] T-10 补两定时器同刻竞争测试（审查 Important-2 · 采纳）
  - **Evidence** · `commit pending` · verify: `npx vitest run test/main/proxy/holdGate.test.ts` → `33 passed`（28→33）`EXIT=0`；`npx vitest run test/main/proxy/` → `30 files / 294 passed` `EXIT=0` · files: `test/main/proxy/holdGate.test.ts`（+149 行，一个新 describe；**源码零改动**，已用 `git diff` 确认） · AC: §1 D3 + §3 计数口径两半
  - **变异验证（绿测试不等于有效测试）**：临时把 `autoReleaseCount++; releaseAll()` 改成 `autoReleaseCount += releaseAll()`（按条目数计），确认「一次放行三条_计数只加一」变红 —— 这正是要防的「静默改变界面数字含义」的重构；又把 `stopAutoReleaseIfIdle` 致残，确认竞争测试 + 2 条既有测试变红。源码已还原并复验。
  - **可构造性诚实边界**：「轮询先抢到」可构造（`FakeClock.advance` 用稳定排序，同 due 回落到插入顺序，而插入顺序由 `holdGate.ts:258-260` 固定为先轮询后自动放行）；「自动放行同刻先抢到」**不可构造**（`applyAutoReleaseConfig` 只会把自动 timer 追加到更后位置）→ 改用「自动周期严格短于轮询周期」覆盖同一风险面，并在 describe 顶部注明，免得后人重新推导。
- [x] T-9 修手机端跨周期失去同步（审查 C4 · 已核实为真缺陷 · 已修）
  - **Evidence** · `commit pending` · verify: 新增跨周期测试 红 `EXIT=1 · AssertionError: expected 1 to be greater than 1`（只有挂载那一次拉取）→ 绿 `EXIT=0`；`npx vitest run test/renderer/web-panel-ui/` → `2 files / 42 passed` **且 0 个 act 警告**；`npx vitest run test/main/webPanel/ test/main/ipc/` → `18 files / 257 passed`；`npm run build:webpanel` `EXIT=0`；新鲜度闸门 `test/main/architecture/webpanel_build_assets.test.ts` → `10 passed`（verbose 确认「产物不得旧于面板源码」是真 ✓ 非 skip） · files: `src/webPanel/ui/ProxyPanel.tsx`（两个新 effect，均只以 `nextAutoReleaseAt` 为 key）· `test/renderer/web-panel-ui/panelProxyPanel.test.tsx` · `test/renderer/web-panel-ui/panelApp.test.tsx` · AC: §3 手机端读数 + 「倒计时不轮询」纪律不变
  - **实现**：① **截止时刻武装重取** —— `setTimeout((nextAt - now) + 1500ms)`；截止已过则改 15s 重试，自终止（服务端推进 `nextAutoReleaseAt` 后 effect 按新值重建、重试停止）② **`visibilitychange` 重对齐** —— 手机浏览器后台会冻结定时器，这条处理「后台挂一小时」。`refreshRef` 持最新 `refresh`：刻意不放进依赖，否则父组件用新的 `onError` 身份重渲染就会重建定时器、重置已等时长（表现为「面板有时就是不更新」且与放行周期无关）。「无调度时零定时器」性质保留（两 effect 对 `null`/`undefined` 早返回）。
  - **三个被拒方案**：低频轮询（没事发生时也在发，且仍滞后一个周期）· 精确在 `nextAt` 重取（倒计时用手机时钟、时间戳来自服务端时钟，手机快几百 ms 就取回同一旧值 → 故留 1500ms 余量）· 新建推送通道 SSE/WebSocket（架构上更干净但需新服务端传输，超出面板拉取姿态与文件范围，已记为将来选项）
  - **成本上账**：8 分钟间隔 / 10 分钟挂起 → **每周期多 1 次请求**（t=8min 那个边界），加挂载 1 次、加每次回到前台 1 次。倒计时仍零流量（1s 心跳纯本地，既有「倒计时期间零状态请求」测试未改仍过）。
  - **顺带修**：`panelApp.test.tsx` 另一处 act 警告（根因不同：闸门解开后测试即结束，状态收敛落在卸载之后），并用该收敛点补了一条此前未断言的真实失败形态 —— 按钮卡在「导入中…」。
  - **发现的验证口径缺陷（影响本轮此前所有 EXIT 声明）**：PowerShell 下 `npx vitest ... | Select-String` 之后读 `$LASTEXITCODE` 得到的是**管道最后一个命令**的退出码，不是 vitest 的。该 SUB 自己头三次读到 `EXIT=0` 而套件实际在失败，改用 `--reporter=json` + `numFailedTests` 才看到真相。**本卡此前若干 EXIT=0 声明源自该不可靠写法**；主 AI 已用 JSON 口径复核全套件为 `1151 passed / 0 failed`（2026-08-10），后续一律用 JSON 口径。

每项完成前先写回：勾 `[x]` + `**Evidence**`（commit / verify+EXIT / files / AC）+ 追加 `## Update Log` 一行。

---

## 🏗️ 1. Boundary Decisions

### Success State（§0.15B · 来源已标注 · 非自拟）

**NOT** 「服务端挂起时长变长」或「日志出现自动放行记录」，
**BUT** 账号不可用期间，客户端（Claude Code / SUB）的请求**不会在 ~10 分钟处被自己的看守掐断**，而是持续等待直到账号恢复；用户在界面上能看到「距下次自动放行还有多久」与「本次启动以来放行了多少次」。

**来源**：用户 2026-08-09 原话——「我在9分钟之内点击一次放行，然后他就会又延续10分钟这个经过我实测是非常可行的」+「界面上能够显示下一次自动放行、单次启动之后累计放行」。

**机理（用户实测确立 · 非推理）**：用户 2026-08-09 实测——账号**仍处受限状态**（未恢复）时，在客户端 10 分钟窗口到点前（约 9 分钟）点一次「放行」，客户端那 10 分钟计时**被重置**，请求继续存活。故本功能 = 把这个手动动作自动化。

**为什么不是「定时发心跳」**：ping 心跳挡不住客户端看守（`holdConfig.ts:26-30` 实测记录：掐断周期恒定 310s，ping 不算语义正文）。**照心跳实现会做出一个日志正常、客户端照断的东西。** 有效的动作是**放行**（`releaseAll()`），不是心跳。

**机理的已知边界（诚实标注）**：「放行为何能重置客户端计时」的**内部机制**未逐字节取证——可能是重跑上游产生了字节、也可能是放行导致的响应流状态变化被客户端视作活动。这不影响功能成立（实测已证效果），但影响**间隔取值的安全边界**：故间隔默认取 8 分钟而非贴近 10 分钟极限，留 120s 余量。

**Must NOT happen**：
1. 自动放行在**池仍无可用号**时被跳过 —— 这正是要放的场景（与 `tryResume` 的语义差别，见 §2）
2. 已认领（超时/abort/已放行）的条目被重复 resume —— 破坏 `holdGate.ts` Invariant 2 的一次性 CAS 认领
3. 挂起集合为空时定时器空转 —— timer 泄漏，应用退出时挂住 Node
4. 改了间隔却要重启反代才生效 —— 现有 hold 控件刻意支持热生效（`proxyServer.ts:428-434` 持久引用 + `766` 原地更新）
5. 界面显示「自动放行已开启」而实际不执行 —— 参照 P-01 母题，必须有生产 caller 证据
6. **自动放行间隔 ≥ 未来 Layer C 的首字节超时** —— 见 §3 时间常数约束

### 状态机（自动放行循环 · 已核对现有主循环）

```
无号可用 → decideHoldAction=hold → enterHold(receivedAt=startTime)
   ↓                                      ↑
   ├─ [新] 自动放行 timer 到点 → releaseAll() → resume
   ├─ 池出现可用号(事件) → tryResume() → resume        │
   ├─ 兜底轮询(maxWaitMs) → tryResume() → resume       │
   └─ 绝对 deadline → onTimeout → keep_blocking(不认领,留在集合)
                                       ↓
   resume → runWithHold 主循环 continue → pickFresh()
              ├─ 拿到号 → attempt 转发 → 真实正文 → 客户端看守重置 ✅
              └─ 仍无号 → 重新 enterHold(同一 startTime) → 循环 ♾
```

### 不变量

- **I1**：绝对 deadline 从 `receivedAt` 起算、跨多次挂起循环**不重置**（现有 Invariant 3 原样保留，`startTime` 是 `runWithHold` 循环外常量）
- **I2**：自动放行走**现成 `releaseAll()`**，不新增第三个放行入口
- **I3**：调度器 timer 生命周期跟随挂起集合（非空启动 / 空则停表），与现有兜底轮询同形态
- **I4**：间隔配置变更时**重建 timer**（主 AI 裁决，见下）

### 三项主 AI 裁决（已定，理由留痕）

| # | 议题 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 改间隔对**当轮已启动的 timer** 是否生效 | **重建 timer** | 现有兜底轮询周期是启动时一次算好的（`holdGate.ts:104`），继承该语义会表现为「改了没反应」，用户只能靠重启反代碰运气。重建代价极小 |
| D2 | 预算耗尽（`keep_blocking` 下留在集合）的条目是否继续自动放行 | **继续放行**，语义见下表 | 用户诉求就是无限挂 |
| D3 | 是否合并 `tryResume` 与 `releaseAll` | **不合并** | 合并需布尔参数区分两个代价差一个数量级的语义，而这正是 RCA 2026-08-02 病灶原型（换号判据与挂起判据混用 → 正常请求被挂 600s，`proxyServer.ts:3862` 注释记着这条教训） |

### D2 展开 · 预算 / deadline / 自动放行的统一状态语义（A5 采纳）

三个时间量各管一件事，**互不覆盖**：

| 时间量 | 管什么 | 自动放行开启后 |
|---|---|---|
| `holdTotalBudgetMs`（绝对 deadline） | 从 `receivedAt` 起算，到点触发 `onTimeout` 按 `holdTimeoutAction` 收尾 | **语义不变**，仍会触发 |
| `holdTimeoutAction` | 到点做什么：`keep_blocking` 不认领不结束 / `error` 发错误 / `graceful_stop` 干净收尾 | **决定自动放行还有没有对象** |
| `holdAutoReleaseIntervalMs` | 多久放行一次 | 只作用于**仍在集合里且未认领**的条目 |

**deadline 到达后的合法状态（逐 action 钉死）**：

- `keep_blocking`（默认）：条目**留在集合、未认领**（`holdGate.ts:181-186` 明确不认领）→ 自动放行**仍能认领它并 resume** → 循环延续。**这才是「无限挂」成立的前提。**
- `error` / `graceful_stop`：`onTimeout` 已 `claim()` 并移出集合 → 自动放行**认领不到**（`claim` 返回 false）→ **不循环，请求已结束**。

**因此「覆盖预算上限」的准确表述**：自动放行**不修改** deadline，它只是在 `keep_blocking` 下让「已超预算但未结束」的条目继续被放行。**若 `holdTimeoutAction` 不是 `keep_blocking`，自动放行到点就失效** —— 界面必须显示这个联动（见 §5 注册清单），否则用户会遇到「自动放行开着却还是断了」且无从自查。

**边界值归一化（补 A5 指出的缺口，落在 `holdConfig.ts`）**：

| 输入 | 处置 |
|---|---|
| `holdTotalBudgetMs < 60000`（预算比间隔下限还小） | 间隔取 `min(60000, totalBudgetMs)` —— 预算优先，绝不让间隔超预算 |
| 间隔为 `0` / 负数 / `NaN` / 非 number | 回落默认 480000（与现有 `clampOrDefault` 同语义，不新增分支） |
| 间隔 > `holdTotalBudgetMs` | 截断到 `holdTotalBudgetMs`（照抄 `holdMaxWaitMs` 现有跨字段约束写法） |
| `holdAutoReleaseEnabled=true` 但 `holdWhenNoAccount=false` | 自动放行**不生效**（门闸本身没开，无条目可放）· 界面上后者关闭时前者置灰 |


### 停止条件（A7 部分采纳 · 不做纸上三方案对比，改为实测分叉）

评审要求比较「沿用现状 / 局部调整 / 移到响应流层」三条路径。**驳回该形式**：沿用现状就是用户当前手动点、正是要解决的问题；而是否需要移层完全取决于 E1 实测结果，实测前写三方案对比是纸上推演（§4.3 pragmatic restraint 先于评审器权威）。

**改为实测分叉 —— E1 是唯一分叉点**：

| E1 结果 | 结论 | 下一步 |
|---|---|---|
| 请求跨越 2 个 10min 窗口存活 | 责任层正确，功能成立 | 收尾交付 |
| 请求仍在 ~10min 处终止 | **HoldGate 层不是正确责任层** | **停止在门闸下游加 timer**；此时才启动方案对比（候选：在响应流层做续接 / 改客户端侧配置 / 放弃自动化保留手动） |

**停止条件（硬）**：E1 失败 → 不修 timer 参数、不加重试、不调间隔试运气（那是在错路上加尝试次数，§0.13/§0.14）。直接停下、按 §0.12 白话报用户三个候选方案与各自代价。

### ADR admission

**不需要**。理由：复用既有 HoldGate 架构与既有放行入口，不引入新边界、不改依赖方向、不做技术选型。属实现细节层增强。

---

## 🔍 2. 既有实现检索（§2.2 · 反造轮子）

### 内部

| 查什么 | 工具 + query | 结果 |
|---|---|---|
| 挂起门闸现状 | `fast-context: hold gate 挂起门闸 放行 release timeout` | 命中 `holdGate.ts` / `holdConfig.ts` / `proxyServer.ts` / 测试 —— **门闸已完整实现**，本轮只加调度器 |
| 放行入口 | `git grep "releaseAll\|releaseHeldRequests"` | `holdGate.ts:213` + `proxyServer.ts:445` + IPC `index.ts:6411` —— **复用，不新建** |
| 周期定时器模式 | 读 `holdGate.ts:99-125` | 兜底轮询已是「非空启动/空则停表」形态 —— **新调度器照抄该形态**，但语义不同故并列不合并（D3） |
| 配置 clamp 收口 | 读 `holdConfig.ts` | 唯一 SSOT，新字段走它，**不新开校验点** |
| 热更新白名单 | 亲读 `proxyServer.ts:762-765` | `HOLD_KEYS` 七个键 —— **新键必须加，漏了热更新静默失效**（本链路唯一陷阱点） |

**结论：内部已有 90% 基础设施，缺的只是「定时调用 releaseAll + 两个读数」。**

### 外部

| query | 工具 | 结论 |
|---|---|---|
| 客户端 idle watchdog 掐断机理 | 项目内实测记录 `holdConfig.ts:26-30`（claude-cli/2.1.220 探针实验，2026-08-06） | ping 不算正文、掐断周期恒定 310s；`API_TIMEOUT_MS` 默认 600000 可用户上调 |
| SUB 卡死是否可从反代侧解决 | `tavily: claude code subagent Task tool hangs stuck` | [#49150](https://github.com/anthropics/claude-code/issues/49150)（Windows 父子 stdio 通道卡死，明确排除 MCP/网络）· [#54434](https://github.com/anthropics/claude-code/issues/54434)（反向对照：只影响主线程、明确排除上下文大小）· [#16470](https://github.com/anthropics/claude-code/issues/16470)（子代理上下文不回收）→ **卡死在客户端进程通道，非 HTTP 层，反代侧无法解决**。本卡不试图解决它 |

**无可复用第三方库**——这是本项目特有的门闸编排逻辑。

---

## 📐 3. 接口契约

### 新增配置项（字段名钉死，照抄 `holdMaxWaitMs` 链路）

| 字段 | 类型 | 默认 | clamp | 语义 |
|---|---|---|---|---|
| `holdAutoReleaseEnabled` | `boolean` | **`true`** | — | **默认开启（用户裁决 2026-08-09）**。仅在 `holdWhenNoAccount` 开启时有对象可放，否则界面置灰 |
| `holdAutoReleaseIntervalMs` | `number` | **480000**（8min） | `[60000, holdTotalBudgetMs]` | 下限 60s：每轮放行都真发一次上游请求，过短会加深 RCA 2026-08-04 的 429 误标风险 |

**为什么默认 8 分钟而非用户实测的 9 分钟**：客户端 `API_TIMEOUT_MS` 默认 600s，8 分钟留 120s 余量吸收上游首字节延迟；用户可自行调到 9 分钟。

### 配置链路 7 节点（生产者 → 消费者 · 来源：recon §3.1，逐条已核）

| # | 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|---|
| 1 | `ProxyConfig` 字段 | ✅ `src/main/proxy/types.ts:679-690`（`holdAutoReleaseEnabled` / `holdAutoReleaseIntervalMs`） | ✅ `holdConfig.ts:83-103`（归一化 + clamp + Layer C warn） |
| 2 | 渲染进程本地类型 | ✅ `renderer/src/components/proxy/ProxyPanel.tsx`（本地 config 类型已含两字段） | 同文件界面控件 |
| 3 | 界面控件 | ✅ `renderer/.../ProxyPanel.tsx`（开关 + 间隔 + 倒计时 + 累计 + 超时策略联动提示，+166 行） | 用户 |
| 4 | IPC 出口 | ✅ `proxy-update-config`（泛型透传，未改） | `proxyServer.updateConfig` |
| 5 | 持久化 | ✅ 整对象落盘（未改） | `index.ts` 读回 |
| 6 | **归一化 SSOT + 热更新白名单** | ✅ `holdConfig.ts` 归一化 | ✅ `proxyServer.ts:820-826` HOLD_KEYS（7→9 键）→ `:832 applyAutoReleaseConfig`（D1 重建 timer） |
| 7 | `HoldGate` 消费 | ✅ `holdGate.ts:151-174` 调度器 | `setInterval` 周期 → `:165 releaseAll()` |

### 读数链路（倒计时 + 累计次数）· 字段契约钉死（A6 采纳）

**完整字段集（三个，此前正文只列两个与任务清单不一致 —— 评审 A6 抓到的笔误）**：

| 字段 | 类型 | 语义 | 关闭态 | 空集合 | 反代停止 | timer 重建瞬间 |
|---|---|---|---|---|---|---|
| `autoReleaseEnabled` | `boolean` | **有效**启用态 = 配置值 AND `holdWhenNoAccount`。**计算层归属：`ProxyServer`，不是 `HoldGate`** —— 门闸不知道 `holdWhenNoAccount`（W2 实施时发现，2026-08-09）。反代用 `holdRuntimeConfig` + `this.config.holdWhenNoAccount` 算出后，把同一有效值传入 `applyAutoReleaseConfig`，故门闸不会调度一个界面显示为未启用的定时器 | `false` | 同配置 | `false` | 不变 |
| `nextAutoReleaseAt` | `number \| null` | 下次放行的**绝对** epoch ms | `null` | `null`（无条目=无 timer） | `null` | **先算新值再赋值**，不出现中间 `null` |
| `autoReleaseCount` | `number` | 本次反代启动以来**自动**放行的**周期次数**（不是条目数） | 保持累计 | 保持累计 | 归零 | 不变 |

**语义纪律（消除三端各自猜测）**：
- `null` = **没有下一次**（关闭 / 无挂起条目 / 反代未运行）。**禁用 `0` 表达"无"** —— `0` 是合法 epoch。
- 倒计时由前端 `nextAutoReleaseAt - Date.now()` 本地每秒渲染；**主进程不推倒计时数值**（推送是事件驱动、倒计时是连续量）。
- 负数（时钟回拨 / 事件延迟）→ 前端显示「即将放行」，不显示负号。
- **计数口径**：一次 timer 触发 = +1，无论该次放行了 3 个条目还是 0 个（0 个也计数，代表"调度器确实在跑"）。手动放行**不计入**此计数。
  - **规则边界补充（T-10 实测纠正，2026-08-10）**：上述「0 个也计数」只适用于**回调真的执行了**的情况。若兜底轮询先抢到 CAS 认领，`claim()` 会顺带调 `stopAutoReleaseIfIdle()` **在自动放行 timer 触发前就把它清掉** —— 回调压根没运行，`autoReleaseCount++` 不可达，计数保持不变。**「释放了 0 条」与「从未触发」是两种不同状态**：把一个从未执行的周期计进去，会让界面声称调度器跑过而它没跑，反而背离该数字「证明调度器活着」的存在目的。两条路径均已锁测试（可达的 +1-on-0-released，与本条 stays-0）。

### 运行时 Goal→Outcome 链路（A2 采纳 · 补文件接线表之外的运行时链路）

| 跳 | producer | artifact | consumer | 消费后结果 | 失败行为 |
|---|---|---|---|---|---|
| 1 | 用户界面控件 | 开关 + 间隔 | `proxy-update-config` → `HOLD_KEYS` → `normalizeHoldConfig` | 配置热生效于**之后**的 timer | 漏注册 `HOLD_KEYS` → 界面显示已改、运行时用旧值（静默） |
| 2 | `runWithHold` 无号分支 | 挂起条目入集合 | `HoldGate.startAutoReleaseIfNeeded()` | 集合首个条目触发调度器启动 | 未启动 → 永不自动放行；重复启动 → 放行风暴 |
| 3 | 自动放行 timer 到点 | `releaseAll()` | 各条目 `claim()` + `hooks.resume()` | 未认领条目被 resume；已认领的 no-op | 与手动/超时竞争同一 CAS 位 → 只有首个胜出 |
| 4 | `resume` | Promise settle(true) | `runWithHold` 主循环 `continue` | 重新 `pickFresh()` | 拿到号→转发；仍无号→重新 `enterHold`（同一 `startTime`） |
| 5 | **放行动作本身** | 客户端可见的流活动 | **客户端 idle watchdog** | **10 分钟计时重置**（用户实测确立） | 若某次放行未产生客户端可见活动 → 该次续命失效，下一周期再试 |
| 6 | `HoldGate` getters | 三字段状态 | `ProxyServer` → IPC / 推送 → 桌面+手机 | 界面显示倒计时与累计次数 | **两个发射点形状不一致 → 字段时有时无** |
| 7 | 账号恢复 | 真实响应正文 | 客户端 | 请求正常完成 | 恢复前触及 Layer C 首字节超时 → 请求失败（见时间约束） |

**第 5 跳是本功能的承重跳**，其成立依据是用户实测（受限状态下手动放行即重置窗口），非文档推理。**验收必须逐跳取证第 5 跳**（见 §4 e2e）。


| # | 节点 | 状态 |
|---|---|---|
| 1 | `HoldGate` 三访问器 | ✅ `holdGate.ts:224 getAutoReleaseCount()` / `getNextAutoReleaseAt()` / `:202 applyAutoReleaseConfig()`。`isAutoReleaseEnabled()` 已删（零调用者，三重检索确认） |
| 2 | `ProxyServer` 出口 | ✅ `proxyServer.ts:497 getHoldAutoReleaseState(): HoldAutoReleaseState` —— **方法名与类型是契约的一部分**（下游 `import type` 引用，不得手抄形状）。另 `:515` 私有 `buildHeldRequestsInfo()` 为唯一构造点 |
| 3 | IPC 返回形状 | ✅ `index.ts:6426`（含 `!proxyServer` 与 catch 两条兜底路径均齐备三字段） |
| 4 | preload 类型 | ✅ `preload/index.ts` + `index.d.ts` 复用 `HeldRequestsInfo` 类型，非手抄字面量 |
| 5 | 推送事件 `onHeldRequestsChanged` | ✅ **两个发射点 `proxyServer.ts:472` + `:521` 都改为调用同一 `buildHeldRequestsInfo()`** —— 形状分叉在结构上不可能，非靠纪律 |
| 6 | 桌面端渲染 | ✅ `renderer/.../ProxyPanel.tsx:501-507` 同时消费拉取与推送两条路径，字段名逐字一致 |
| 7 | 手机面板 | ✅ 读：`panelProxyDeps.ts:200` 扩 `PanelProxyStatus` 三字段 → `webPanel/api/panel.ts` → `webPanel/ui/ProxyPanel.tsx`；写：`webPanel/routes.ts:421 POST /api/proxy/release-held` → `panelProxyDeps.ts:307 releaseHeldRequests()`，经 `server.ts:314 guard()` + `singleFlight('proxy-release-held')` |

**最终 sink 与实跑姿态（§0.15B 消费验证锚点）**：
- 桌面 sink = `renderer/.../ProxyPanel.tsx` 挂起徽标区的倒计时与累计次数；手机 sink = `webPanel/ui/ProxyPanel.tsx` 同两项 + 放行按钮
- **本轮实跑的 e2e 姿态**：单测层已覆盖「推进假时钟看倒计时数字变化、同时断言状态请求次数不涨」（手机端本地走时不轮询，已验证）；**客户端侧「10 分钟窗口真被续上」按用户裁决未跑，全程标 `unverified`**
- 生产接线已逐符号验证（非仅测试调用）：`applyAutoReleaseConfig` ← `proxyServer.ts:832`；`getHoldAutoReleaseState` ← `proxyServer.ts:515` / `panelProxyDeps.ts:200` / `index.ts:6426`；`releaseHeldRequests` ← `index.ts:6411` / `panelProxyDeps.ts:307` / `webPanel/api/panel.ts:326` / `webPanel/ui/ProxyPanel.tsx:288`；自动 timer → `releaseAll` ← `holdGate.ts:165`

**倒计时不走推送**：推送是事件驱动、倒计时是连续量。主进程只推**绝对时间戳** `nextAutoReleaseAt`（epoch ms），前端本地每秒自减渲染 → 推送频率不变。

**累计次数口径**：计在 `HoldGate` 实例上，随反代 stop/start 归零（与现有 `stats` 口径一致）。

### 最终 sink + 真跑一次的 e2e 姿势（A8 采纳 · 四场景逐跳取证）

**sink**：桌面端 `ProxyPanel` 挂起徽标区（倒计时 + 累计次数）· 手机面板同两项 · **以及客户端请求的实际存活时长**。

**单测必跑；E1-E4 本轮不跑（用户裁决，见下）。** 四场景保留为待办验收，各带「客户端侧判据 + 后端锚点」：

| # | 场景 | 怎么造 | 通过判据（客户端侧） | 后端锚点 |
|---|---|---|---|---|
| E1 | **持续无号跨越两个 10 分钟窗口** | 用受限账号触发挂起，全程不恢复账号，观察 20+ 分钟 | 请求**未在 ~10min 处终止**，仍在等待 | 日志出现 ≥2 次自动放行；`autoReleaseCount ≥ 2` |
| E2 | 挂起期间热改间隔 | E1 进行中把间隔 8min→3min | 倒计时按新值重算，不出现双重放行 | 新 timer 生效、旧回调未重复触发 |
| E3 | 手动 / 自动 / 超时三方竞争 | E1 中在自动放行到点瞬间手动点放行 | 请求只被 resume 一次，无重复转发 | `autoReleaseCount` 只在自动那次 +1 |
| E4 | `holdTimeoutAction` 非 `keep_blocking` | 改为 `error`，等预算到点 | 请求按 action 结束、**界面已提前提示自动放行将失效** | 到点后 `nextAutoReleaseAt` 变 `null` |

**E1 是承重验收** —— 它直接对应用户诉求，也是唯一能区分「自动放行真的续命」与「账号恰好恢复了」的场景（全程不恢复账号即排除后者）。

**⚠️ 用户裁决 2026-08-09：E1-E4 本轮不跑**（用户已手动实测过该机制，认为自动化只是把手动点击换成定时器，无需再验）。故：

- **本功能的客户端侧效果标记 `unverified: 用户裁决不跑 E1-E4；机制成立依据为用户手动实测（受限状态下点放行即重置 10 分钟窗口），自动路径与手动路径调用同一 releaseAll() 入口`**。
- 交付报告与 Decision Summary **不得**写「已验证」，只能写「服务端逻辑单测已验 / 客户端侧效果未跑专门验收」。
- 单测（§4 十二例）照跑 —— 它们验的是服务端定时器启停、CAS 竞争、配置边界，与客户端行为无关，不受本裁决影响。
- E1-E4 保留在本卡作为**待办验收**，用户下次真实遇到账号受限时可自然验证；若届时表现不符，走「停止条件」段的分叉。

**Layer C 组合场景**：Layer C 尚未落地，故本轮无法验；已在时间约束段落记为「Layer C 落地时必跑」。


### ⚠️ 跨模块时间约束（A3 采纳 · 从「谁后落地谁负责」升级为可执行契约）

并行分支 `feat/proxy-context-safety-net` 的 **Layer C** 设计了上游流停发看守：首字节超时默认 **200s**、chunk 间超时 360s，触发即 abort 上游并向下游发错误。

**冲突窗口**：放行后重跑上游，若 200s 内不吐首字节（账号仍受限 / 上游排队），Layer C 会在下一次自动放行（480s）**之前**掐死请求 → 用户看到「自动放行开着但请求还是失败」。

**唯一所有者：`holdConfig.ts`**（本卡的 clamp 收口）。它已是 hold* 归一化的 SSOT，跨模块时间关系挂在它身上不新增真源。

**兼容公式（写进代码注释与 clamp 逻辑）**：

```
holdAutoReleaseIntervalMs  <  firstChunkTimeoutMs × 0.75
```

0.75 系数留出上游首字节抖动余量。按 Layer C 默认 200s → 上限 150s；本卡默认 480s **不满足**该式，故：

**注册门禁（三条，缺一即视为未落地）**：
1. `holdConfig.ts` 顶部**常量化** `LAYER_C_FIRST_CHUNK_TIMEOUT_MS_ASSUMED = 200000` 并注明「若 Layer C 落地且实际值不同，改这里」。
2. 归一化时**校验并 warn**：`intervalMs >= assumed × 0.75` 时打 `proxyLogger.warn` 说明「Layer C 落地后本间隔会导致请求提前失败」。**只 warn 不强制下调** —— Layer C 未落地时下调反而无谓缩短周期、增加上游压力。
3. **Layer C 落地方的义务**（写进本卡供其读）：落地时必须跑 E1 + Layer C 组合场景，并回写实际 `firstChunkTimeoutMs` 到本卡与 `holdConfig.ts` 常量。

**当前状态**：Layer C **尚未落地** —— `git grep` + 文件系统级 `Select-String`（含未跟踪文件）双向零结果，2026-08-09 实测。故本轮为「设计约定」而非在飞代码冲突。

---

## 🧪 4. Test Boundaries（TDD Red）

失败测试名（描述真实业务场景，注入 FakeClock，挂在 `test/main/proxy/holdGate.test.ts`，现有 17 用例基线绿）：

1. `开启自动放行后，池仍无可用号也会到点放行挂起请求`（核心场景 · 覆盖 Must NOT #1）
2. `关闭自动放行时，到点不放行`（开关语义 —— 默认开启，但关掉必须真的不放）
3. `挂起集合为空时不启动自动放行 timer；最后一个请求被认领后停表`（覆盖 Must NOT #3 · timer 泄漏）
4. `已认领的条目不会被自动放行重复 resume`（覆盖 Must NOT #2 · Invariant 2）
5. `间隔配置变更后，下一次放行按新间隔`（覆盖 D1 / Must NOT #4）
6. `累计放行次数随每次自动放行递增，且手动放行不计入自动计数`（口径不混）
7. `预算耗尽的条目在 keep_blocking 下仍被自动放行认领`（覆盖 D2 —— 把「覆盖预算上限」这个决定锁成测试）
8. `holdConfig` clamp：间隔 < 60s 抬到 60s；> totalBudget 截断到 totalBudget
9. `holdTimeoutAction=error 时，预算到点后条目已被认领，自动放行认领不到`（锁 D2 展开的逐 action 语义）
10. `预算小于间隔下限时，间隔取预算值而非 60s`（锁边界值归一化第一条）
11. `无挂起条目时 nextAutoReleaseAt 为 null，不是 0`（锁字段语义纪律 · 防三端各自猜测）
12. `间隔热改的瞬间 nextAutoReleaseAt 不出现中间 null`（先算新值再赋值 · A6 指出的重建瞬间原子性）

边界场景（§5.4）：空集合 / 并发放行与超时竞争同一 CAS 位 / 间隔改为极小值时不出现放行风暴。

---

## 🛡️ 5. 注册检查清单

| 项 | 状态 |
|---|---|
| **`HOLD_KEYS` 白名单加两个新键**（`proxyServer.ts:762-765`） | ⛔ 必做 · 漏了热更新静默失效 |
| `holdConfig.ts` clamp 常量 + 归一化 | ⛔ 必做 |
| 桌面端界面控件 + i18n（现有 hold 控件有中英文对照） | ⛔ 必做 |
| `onHeldRequestsChanged` **两个**发射点同步扩形状 | ⛔ 必做 |
| preload 类型 + `index.d.ts` | ⛔ 必做 |
| 手机面板 `PanelProxyStatus` + `/api/proxy/release-held`（走 `singleFlight`） | ⛔ 必做 |
| 第三方 SDK 隔离 | N/A（无新依赖） |
| 界面文案说明「`holdTimeoutAction` 非 keep_blocking 时自动放行到点失效」（D2 展开） | ⛔ 必做 |

**手机面板边界**：只做「看 + 手动放行」，**不做改间隔** —— 尊重 `routes.ts:364-378` 既有决策（面板刻意不接受配置参数，手机误触代价大于收益）。

### 手机端手动放行接口契约（A4 部分采纳）

**业务必要性（§0.17 四问，评审质疑其为 Solution-Jumping，此处答复）**：

1. **真实场景**：用户不在电脑前（睡觉 / 外出），SUB 长任务因账号受限挂起，需要在手机上确认「调度器在跑」并在必要时**立刻补一次放行**（例如刚换了新号，不想等剩余 7 分钟）。
2. **缺失影响**：手机端只能看倒计时干等，无法干预。用户原话「他那个放行的意思是说点击一次」—— **点击是这个功能的核心动作**，只给看不给点是把功能砍掉一半。
3. **既有覆盖**：现有手动放行只有桌面端 IPC（`index.ts:6411`），手机端零端点 —— 不存在替代机制。
4. **分类：B 类（稳定性保护）** —— 不是 A 类业务必需（不放行也能等下个周期），但显著改善无人值守场景的可控性。

**契约（补齐评审指出的缺口）**：

| 项 | 约定 |
|---|---|
| 路由 | `POST /panel/api/proxy/release-held` |
| 鉴权 | 走**现有唯一闸门** `PanelAuth.guard()`（会话 cookie + CSRF 自定义头），**不新增鉴权路径** |
| 实例范围 | 单实例本机反代（面板与反代同进程），**无多租户概念** —— 与既有 `/api/proxy/*` 一致 |
| 幂等 / 并发 | 走现有 `singleFlight('proxy-release-held')`，与 `proxy-start` 同形态；手机连点共享一次执行 |
| 成功响应 | `200 { released: <number> }` —— 复用 `releaseHeldRequests()` 返回值 |
| 反代未运行 | `409 PROXY_NOT_RUNNING`（沿用 `mapProxyFailure` 现有映射，不新增错误码） |
| 无挂起条目 | `200 { released: 0 }` —— **不报错**，幂等语义（与 `releaseAll()` 一致） |
| 审计 | 复用 `proxyLogger.info('HoldGate', ...)` 现有留痕，放行来源标 `panel` 以区分桌面/手机/自动 |
| **不做** | 改间隔 / 改开关 / 任何配置写入 —— 手机端只有「立刻放一次」这一个动作 |

---

## Update Log

- 2026-08-09 · 初稿。三路侦察结论已并入；Layer C 冲突已实测确认为「尚未落地的设计约定」而非在飞代码冲突。
- 2026-08-09 · **R1 codex artifact-decision-card 评审处置**（`decision-card.review1.codex.md` · NEEDS_CHANGES · p0=1 p1=7）：
  - `R1 · A1(P0) 自动放行到客户端正文的因果断链` → **rejected**：用户实测反证 —— 账号**仍处受限状态**（未恢复）时手动点放行即重置客户端 10 分钟窗口。评审为纯文档内推理，无运行时证据，且其报告自标「代码事实需实现方核实」。已改写 §1 机理段：来源标为用户实测而非机理推导，并诚实标注「放行为何能重置」的内部机制未逐字节取证（不影响功能成立，影响间隔安全边界取值）。
  - `R1 · A2(P1) 缺运行时链路表` → **采纳**：§3 新增「运行时 Goal→Outcome 链路」7 跳表，含每跳 producer/artifact/consumer/结果/失败行为；第 5 跳（放行→客户端看守重置）标为承重跳。
  - `R1 · A3(P1) Layer C 冲突被悬置` → **采纳**：§3 时间约束段重写 —— 指定 `holdConfig.ts` 为唯一所有者、给出兼容公式 `interval < firstChunkTimeout × 0.75`、三条注册门禁（常量化假定值 / 归一化时 warn / Layer C 落地方回写义务）。**只 warn 不强制下调**：Layer C 未落地时下调反而无谓增加上游压力。
  - `R1 · A4(P1) 手机写接口属 Solution-Jumping` → **部分采纳**：保留接口（用户原话「放行的意思是说点击一次」—— 点击是核心动作，只给看不给点等于砍掉一半），但补齐 §0.17 四问答复 + 完整契约（鉴权走现有唯一闸门 / 实例范围 / 幂等 singleFlight / 成功响应 / 409 / 空集合 200 / 审计来源标记 / 明确不做配置写入）。分类 B 类稳定性保护。
  - `R1 · A5(P1) 预算/deadline/自动放行语义冲突` → **采纳**：§1 新增「D2 展开」—— 三个时间量各管一件事的对照表 + 逐 `holdTimeoutAction` 钉死 deadline 到达后的合法状态（`keep_blocking` 留集合可续放 / `error`+`graceful_stop` 已认领故自动放行失效）+ 四条边界值归一化规则。**修正「覆盖预算上限」这个不准确表述**：自动放行不修改 deadline。
  - `R1 · A6(P1) 读数字段形状未封闭` → **采纳**：抓到我方真笔误（正文两字段 vs 任务清单三字段）。§3 钉死三字段完整契约表 + 五条语义纪律（`null` 表示"无下一次"、禁用 `0`、计数口径为周期次数、负数显示「即将放行」）。
  - `R1 · A7(P1) 未比较三条替代路径` → **部分采纳/改法不同**：驳回纸上三方案对比（沿用现状即当前待解问题；是否移层取决于实测）。改为 §1 新增「停止条件」段 —— E1 实测为唯一分叉点，失败则停止在门闸下游加 timer 并按 §0.12 报用户，**硬性禁止调参数试运气**。
  - `R1 · A8(P1) e2e 未锁关键失败窗口` → **采纳**：§4 e2e 段重写为 E1-E4 四场景表（持续无号跨两窗口 / 热改间隔 / 三方竞争 / 非 keep_blocking），各带客户端侧判据 + 后端锚点。E1 标为承重验收（全程不恢复账号即排除「恰好恢复」的混淆）。
  - **P0 处置结论**：唯一 P0 经用户实测反证后 rejected，无未清 P0，可进实现。
- 2026-08-09 · **用户裁决：E1-E4 端到端验收本轮不跑**（理由：用户已手动实测该机制，自动化只是把手动点击换成定时器）。§4 已按此改写；客户端侧效果全程标 `unverified`，交付报告不得写「已验证」。单测 12 例仍必跑。
- 2026-08-09 · **T-6 任务改写**：由「端到端实测」改为「单测全绿 + 客户端侧效果标 unverified 并把 E1-E4 留作待办验收」。
- 2026-08-09 · **实施期契约缺口修正（主 AI 自省 · 两条都是本卡的缺陷，非 SUB 的）**：
  1. **链路表列了生产者与消费者，却漏了它们之间的「方法名 + 类型」那一格。** 后果被 W4 当场撞上：它只能自己发明 `getAutoReleaseStatus` 并做成可选调用以通过编译，而 W2 落的真名是 `getHoldAutoReleaseState()`（`proxyServer.ts:497`）→ 可选调用绑定到不存在的方法，**类型检查干净、测试通过、手机上永远显示「未开启」**。已改绑真名 + `import type` 引用对方接口 + 去掉可选标记（漏接线改为编译期失败）。**教训：跨 SUB 契约必须钉死符号名与类型出处，"某处会有个 getter" 不构成契约。**
  2. **`isAutoReleaseEnabled()` 成了死代码，根因同样在派单。** 主 AI 写「以及暴露启用状态的 getter」，之后契约修正把计算层移到 `ProxyServer`（门闸不知 `holdWhenNoAccount`），却未回收已建符号 → 零生产调用者（git 检索 + 文件系统级双向确认）。已派清理并顺带核另三个新符号的接线状态。**教训：契约修正时必须回收被它作废的符号，否则留下 E-052 形态的死代码。**
- 2026-08-09 · **W4 转给全体的测试纪律**：任何 `singleFlight` / 去重类断言，若不显式阻塞被包裹的调用，则该断言是常量值、什么都不证明（它自己那条「双击去重」初版就是恒真：桩同步返回，第一次执行的 `finally` 在第二次请求到达前已清键，计数必然为 2）。已加闸使断言有意义。
  - 默认间隔 **8 分钟**，界面可改（用户「后续我自己观察哪个时间较合理」）
  - `holdAutoReleaseEnabled` 默认 **`true`**（原设计为 `false`，用户裁决改为默认开启）。§3 已改；测试 2 的理由随之从「默认关」改为「开关语义」
  - 超时策略联动 → **保持现状 + 界面提示**（不自动改用户设置、不禁止组合）。理由：静默改设置会让用户下次看到下拉框变化时莫名；禁止组合会拦住有意为之的配置
  - 累计口径 → **本次「启动服务」到「停止服务」之间累计，停止归零**（用户「类似于额度那个」）—— 与既有 `stats` 生命周期一致，无需新机制
  - 手机面板 → **能看能点、不能改配置**（与 §3 手机端契约一致）
- 2026-08-10 · **T-3 读数出口执行（SUB W2 · 服务端→IPC→preload 段）**。
  - 交付：`proxyServer.ts` 导出 `HoldAutoReleaseState` / `HeldRequestsInfo` 两个类型 + `getHoldAutoReleaseState()` 访问器 + **私有 `buildHeldRequestsInfo()` 单一构造点**；`HOLD_KEYS`（现 `proxyServer.ts:820-826`）补入 `holdAutoReleaseEnabled` / `holdAutoReleaseIntervalMs` 并在命中时调 `applyAutoReleaseConfig`（D1 重建 timer）；`index.ts:6418` IPC 返回形状扩三字段（含 `!proxyServer` 与 catch 两条兜底路径均齐备三字段）；preload `index.ts` / `index.d.ts` 改为复用 `HeldRequestsInfo` 类型而非手抄字面量。
  - **两个发射点的处置**：没有各自手抄字段，而是都改为 `this.events.onHeldRequestsChanged?.(this.buildHeldRequestsInfo())`（`proxyServer.ts:472` + `:521`，evidence 见下）。§3 第 6 跳的失败行为「两个发射点形状不一致 → 字段时有时无」在结构上不再可能出现，而非靠纪律维持。
  - **Evidence** · verify：`npx tsc --noEmit -p tsconfig.node.json`（W1 契约探针在场时）EXIT=2，剩余 2 条错误全部落在 `holdConfig.ts:11/65`（W1 owned，改动前基线即红）—— W2 侧 5 条错误全清；`npx vitest run test/main/proxy/` EXIT=1 · **Test Files 1 failed | 23 passed**，`Tests 7 failed | 235 passed`，7 条失败**全部**为 `gate.getNextAutoReleaseAt / getAutoReleaseCount / applyAutoReleaseConfig is not a function`（W1 未落地，预期红）；**9 个 exercise `proxyServer` 的测试文件全绿**（`holdGateStreamWiring` / `holdGateMultiPathWiring` / `holdGateFalsePositive` / `holdGateFallbackCrossRegion` / `proxyActivation` / `quotaFalsePositive429` / `netGuardWiring` / `contentFilterRetry` / `sessionAffinityInvalidate`）= 本轮改动未破坏既有反代行为。files：`src/main/proxy/proxyServer.ts` · `src/main/index.ts` · `src/preload/index.ts` · `src/preload/index.d.ts`。
  - **链路第 6 跳已闭合（非仅"我这侧写好了"）**：`ProxyPanel.tsx:501-507` 实测同时消费两条路径（`proxyGetHeldRequests()` 拉取 + `onProxyHeldRequestsChanged` 推送），且消费的字段名 `nextAutoReleaseAt` / `autoReleaseCount` 与本侧生产的逐字一致 → 生产者与消费者对齐，无 E-052「建好未接线」形态。
  - 遗留依赖（**非本 SUB 缺口，W1 落地即消**）：`ProxyConfig` 两个新字段（`types.ts`）+ `HoldGate` 三个方法（`holdGate.ts`）+ `holdConfig.ts` 的 `HOLD_DEFAULTS` 补两字段。W2 按契约写就，未越界改这三个文件。
  - 客户端侧效果仍标 `unverified`（沿用 2026-08-09 用户裁决，E1-E4 未跑）；本条只声明「服务端读数出口逻辑已接线 + 类型/既有测试无回归」。
- 2026-08-10 · **T-2 执行(SUB executor · W1 侧)**:`HoldGate` 自动放行调度器 + `holdConfig` clamp + `ProxyConfig` 两字段落地。red 基线 `7 failed | 34 passed` EXIT=1 → green `41 passed` EXIT=0;全 main 套件 `81 files passed` EXIT=0(新增的 `holdConfig → proxyLogger` 导入无回归);`typecheck:node` / `typecheck:web` 双 EXIT=0。
  - **实现要点**:调度器为**独立第二个 timer**(D3 不与兜底轮询合并);timer 回调**刻意不查 `isPoolAvailable()`** —— 若查了,恰好在「账号一直受限」这个目标场景下永不触发 = 功能等于没做,该 rationale 已写进代码注释;生命周期跟随挂起集合(`enterHold` 起表 / `claim` 空则停表),复用既有 `releaseAll()`(I2 不新增第三入口);计数只在 timer 回调自增,`releaseAll()` 内部不动 → 手动放行天然不计入;`applyAutoReleaseConfig` 先算新 `nextAt` 再赋值(A6 重建瞬间不出现中间 null)。
  - **`holdConfig`**:间隔 clamp `[60000, BUDGET_MAX]` 再受 `totalBudgetMs` 截断 → 预算 < 60s 时间隔自然取预算值(边界表第一条,靠既有截断写法覆盖,未新增分支);`LAYER_C_FIRST_CHUNK_TIMEOUT_MS_ASSUMED = 200000` + `LAYER_C_SAFETY_RATIO = 0.75` 常量化,超式**只 warn 不下调**(注册门禁三条已落 1/2,第 3 条是 Layer C 落地方义务)。
  - **审查发现(执行中已被上游修正)**:测试 7/9 初始 fixture `autoReleaseIntervalMs: 60000` 与 `totalBudgetMs: 100000, graceMs: 15000`(deadline 触发点 85000)时间线自相矛盾 —— 首次 tick 落 60000 早于 85000,条目在 `advance(90000)` 前已被放行离集合,`getHeldCount()` 不可能为 1。已用受控实验取证(唯一变量 = 间隔:60000 红 / 90000 绿,两场景同时翻转),确认是 fixture 取值问题而非实现缺陷;期间上游将其改为 `100000`,与实验隔离出的根因一致,故未改测试。
  - **`isAutoReleaseEnabled()`** 目前零生产 caller(`proxyServer` 走 `holdRuntimeConfig.autoReleaseEnabled && holdWhenNoAccount` 合成生效值,不读门闸自身开关)—— 形态上属可疑冗余,留给主 AI 裁决删除或由 T-3/T-4 消费,**未自行删除**(跨 SUB 边界)。
  - 客户端侧效果仍标 `unverified`(沿用 2026-08-09 用户裁决,E1-E4 未跑);本条只声明「服务端调度器逻辑单测已验 + 类型与既有测试无回归」。
- 2026-08-10 · **T-5 手机面板执行（SUB W3 · 面板读数三字段 + 手动放行端点）**。
  - 交付：`panelProxyDeps.ts` 扩 `PanelProxyStatus` 三个可选字段 + `ProxyServerRef` 新增 `getHoldAutoReleaseState` / `releaseHeldRequests` + 新 dep `proxyReleaseHeld`（复用既有 `ProxyServer.releaseHeldRequests()`，**不新建第三个放行入口**，守 I2）；`routes.ts` 在 `routeProxyApi` 内加 `POST /api/proxy/release-held`（走既有 `singleFlight('proxy-release-held')`，形态照 `proxy-start`）；`webPanelWiring.ts` 补 dep 透传；`webPanel/api/panel.ts` 加 `releaseHeldRequests()` + 三字段类型；`format.ts` 加 `formatCountdown()`；`ui/ProxyPanel.tsx` 加倒计时（本地每秒自减）+ 累计次数 + `h-11` 立即放行按钮。
  - **契约逐格核对结果**：`singleFlight`(routes.ts:221) · `mapProxyFailure` 409 映射(routes.ts:332-337) · `guard()`(auth.ts:187 → server.ts:314 早退，routePanelApi 在 :346 之后才可达，**无路由级绕过口**) · `releaseHeldRequests()`(proxyServer.ts:445) 全部命中真实代码。**唯一未锚定格 = 读数生产者方法名**：派单未给出 `ProxyServer` 出口的方法名，我先按 `getAutoReleaseStatus` 起了个名并做成可选 —— 随后发现 W2 已落地真名 `getHoldAutoReleaseState()`（proxyServer.ts:497，返回 `HoldAutoReleaseState` 三字段与面板字段**逐字同名**），当场改为绑真名 + `import type` 复用其类型（不手抄字面量，SSOT）+ 去掉 `?`。
  - **可选性已撤销的理由**：留 `?.()` 会让「忘接线」表现为界面永久显示「未开启」且编译期零报错（P-01 形态）。改为必填后 `index.ts:4429` 的真实 `ProxyServer` 必须满足该签名 —— typecheck 即是接线证据。
  - **Evidence** · verify：`npm run typecheck` **EXIT=0**（node + web 双 project）；`npx vitest run test/main/webPanel/` **EXIT=0 · 250 passed**；面板+deps+UI+产物闸门四组 **EXIT=0 · 308 passed**；全仓 `npx vitest run --reporter=json` **numTotalTests=1097 / numPassed=1097 / numFailed=0 / success=True**。红态留证：`proxyRoutes` 首轮 4 failed（全为 HTTP 404 = 路由缺失）· `panelProxyDeps` 首轮 6/6 failed（`proxyReleaseHeld is not a function`）· UI 首轮 9 failed / 12 passed（既有用例未回归）。
  - **产物新鲜度**：`npm run build:webpanel` EXIT=0（改完源码后重跑）；`webpanel_build_assets.test.ts` 10/10 **✓ 真跑非 skip**（含「产物不得旧于面板源码」一条，`it.skipIf(!built)` 在产物存在时才生效，已用 `--reporter=verbose` 确认标记为 ✓）。
  - **评审发现（单飞测试的假绿）**：初版「连点放行」用例断言 `releaseCalls===1` 却让替身同步返回 —— 第一次执行早在第二次到达前就 `finally` 清掉了去重键，`releaseCalls` 必然是 2。这不是实现 bug 而是**测试造不出重叠**：`singleFlight` 去重的是 in-flight 重叠，不是「短时间内两次」。已给替身加放行闸门制造真实重叠窗口后才有意义。**同类隐患提示 W1/W2**：任何断言 `singleFlight` 的用例若不显式阻塞被包裹的执行，都是恒真/恒假的假绿。
  - **越界一处（已判为必要）**：`webPanelWiring.ts:buildPanelRouteDeps` 是派单 scope 未列出的**第二个装配节点**，不补则 `PanelRouteDeps` 缺字段、编译不过且链路死在装配层。它属面板边界内（非 `src/main/proxy/**` 或 `index.ts`），故补齐；`src/main/index.ts` / `src/preload/**` / `src/renderer/**` **零改动**。
  - 客户端侧效果仍标 `unverified: 用户裁决不跑 E1-E4`（沿用 2026-08-09 裁决）。本条只声明「面板读数与放行端点的服务端逻辑 + UI 行为已单测验证、类型与全仓测试无回归」；手机上真机点一次放行**未实测**。
  - 手机面板边界遵守：**只看 + 只放一次**，无间隔 / 无开关 / 无任何配置写入（`routes.ts:364-378` 既有决策原样保留）。

- 2026-08-10 · **缺陷修复:自动放行累计次数不随「停止服务→启动服务」归零**(SUB executor)。
  - **缺陷**:计数器 `autoReleaseCount` 是 `HoldGate` 实例字段(`holdGate.ts:116`),而 `HoldGate` 在 `ProxyServer` **构造函数**里建一次(`proxyServer.ts:455`)、**不随 stop/start 重建**;`start()` 明确重置了 `sessionStats`(`proxyServer.ts:647`「重置会话统计(每次 start 开启一个新会话)」)却没人重置门闸会话态 → 同一实例 start→放行 2 次→stop→start,桌面与面板都显示 `2` 而非 `0`,违反本卡 §3 字段契约「反代停止归零」与用户口径「类似于额度那个」。
  - **根源在旧注释**:`autoReleaseCount` 原注释写「随实例生命周期归零(反代 stop/start 即新实例)」—— 该前提**是错的**(实例不重建),T-2 实施时按这句话就没做显式归零。已改写该注释并注明它正是本缺陷的来源,避免下一个人重复该假设。
  - **修复层次**:在门闸上加权威复位入口 `HoldGate.resetSessionState()`(清残留条目 + 停自动放行调度器与兜底轮询 + 计数归零),由 `ProxyServer` 在**服务会话两端**调用 —— `start()` 的 `listen` 回调内、紧挨重置 `sessionStats` 那几行(`proxyServer.ts:656`),以及 `stop()` 的 `finish()` 内、紧挨 `activeRequests.clear()` / 清 `cleanupTimer` 那组收尾(`proxyServer.ts:784`)。**未在 DTO / UI 层假装归零**(那样 IPC 仍会报旧值,且违反 §3「面板不自己推算」)。
  - **复位语义 = 作废不驱动**(与 `abort` 同类、与 `releaseAll` 不同类):不调任何 hooks —— 不 resume(服务已停,重试无处可去)、不发 error/graceful_stop(停服收尾由 `activeRequests.forEach(abort)` 负责,门闸不越权替它给客户端发信号)。`seq` **刻意不重置**,条目 id 全实例单调,防上一会话残留 abort 监听器迟到打中新会话条目。
  - **顺带发现并修掉的同源问题(会话态残留三件)**:① 停服后自动放行调度器**仍在跑**(对着一个已停的服务定时放行,且是 timer 泄漏);② 停服后挂起条目**仍留在集合**里,`getHeldRequestsCount()` 停服后还返回 1;③ 归零只在主进程内存里、**界面看不到** —— 桌面端只在挂载时拉一次、之后靠 `onHeldRequestsChanged` 推送,故 start/stop 两处复位后各补一次 `emitHeldRequestsChanged()`,否则界面会一直显示上一会话累计值直到下次挂起活动才被动刷新。`nextAutoReleaseAt` 原本已由 `stopAutoRelease()` 归 null,但仅在集合被认领空时触发,停服路径不经过它。
  - **Evidence** · red 基线:`npx vitest run test/main/proxy/holdGateSessionLifecycle.test.ts` EXIT=1 · `Tests 7 failed (7)` —— 4 条 `TypeError: gate.resetSessionState is not a function`(方法未建),3 条**直接钉住缺陷本体**:`expected 2 to be +0`(stop→start 后累计次数)、`expected 1 to be +0`(停服后挂起数)、`expected 0 to be greater than 0`(start 未推送读数)。green:同命令 EXIT=0 · `Tests 7 passed (7)`。回归:`npx vitest run test/main/proxy/` EXIT=0 · **31 files / 298 passed**(含既有 `holdGate.test.ts` 41 例与 9 个 exercise `ProxyServer` 的接线测试);全仓 `npx vitest run --reporter=json` **numTotalTests=1151 / numPassed=1151 / numFailed=0 / success=True**;`npm run typecheck:node` EXIT=0 · `npm run typecheck:web` EXIT=0。files:`src/main/proxy/holdGate.ts` · `src/main/proxy/proxyServer.ts` · 新增 `test/main/proxy/holdGateSessionLifecycle.test.ts`。commit: pending(主 AI 提交)。
  - **为什么 start + stop 两端都放而不是只放一端**:只放 stop 会漏掉「上一次是崩溃/强杀退出、stop 的 `finish()` 没跑到」的情况(`stop()` 在 `!this.server` 时直接 early return);只放 start 则停服后仍留一个空转调度器与假的挂起数。两端都复位是幂等的,代价是一次 Map 清空。
  - 客户端侧效果仍标 `unverified: 用户裁决不跑 E1-E4`(沿用 2026-08-09 裁决)。本条只声明「计数的会话生命周期已单测验证」;桌面/手机上真机 start→stop→start **未实测**。

---

## Update Log · R2 阶段（sonnet 实现审查处置 · 主 AI 汇总）

- 2026-08-10 · **R1 审查处置汇总**（sonnet reviewer · NEEDS_CHANGES · critical=4 important=2 minor=2）：
  - `C1 任务清单缺四元证据` → **采纳，主 AI 补完**：T-1~T-10 全部勾选并补 `commit pending` / `verify: <cmd> → EXIT 或计数` / `files: path:lines` / `AC: <段落引用>`。审查未见过的 T-7~T-10 一并补齐。
  - `C2 链路表未结晶` → **采纳，主 AI 补完**：§3 两张表所有单元格换成真实 `file:line`，`待建` 与近似行号全部清除；补最终 sink、实跑姿态、逐符号生产调用锚点。
  - `C3 会话计数不归零` → **采纳，已修**（T-8）。**根因是一句错注释而非漏调用**，另连带查出三处同类问题（详见 T-8 条目）。
  - `C4 手机端跨周期失同步` → **采纳，已修**（T-9）。截止时刻武装重取 + 后台冻结重对齐；「倒计时不轮询」纪律保持不变，成本每周期 1 次请求。
  - `Important-1 范围污染` → **部分采纳，一半驳回**：分开提交采纳（两次提交：自动放行 / 账号池相关），但「退回给所属任务」驳回 —— 那些修复已完成且红→绿验证过，退回等于把已验证成果搁置。范围此后按用户明确指示进一步扩大（额度喂入本轮亦落地）。
  - `Important-2 定时器竞争缺测试` → **采纳，已修**（T-10）。含变异验证；并**纠正了主 AI 派单里的计数语义**（见 §3 计数口径的规则边界补充）。
  - `Minor-1 React act 警告` → **采纳，已修**，另修了第二处不同根因的同类警告。
  - `Minor-2 成功响应字段可选化` → **采纳，进行中**（判别联合按 running 判别位）。

- 2026-08-10 · **验证口径全局修正（影响本卡此前若干 EXIT 声明）**：`npx vitest ... | Select-String; $LASTEXITCODE` 读到的是**管道最后一个命令**的退出码，非 vitest 的 —— 该写法本轮产出过假绿（发现它的 SUB 自己头三次也读到 EXIT=0 而套件实际在失败）。已全线改为 `npx vitest run --reporter=json --outputFile=X.json` 后读 `numFailedTests`。主 AI 用该口径复核：**1151 passed / 0 failed**，`typecheck:node` 与 `typecheck:web` 均干净。**该教训可跨项目泛化，收尾时评估写入全局错误日志 COMMAND 流。**

- 2026-08-10 · **本卡范围外、但本轮查清的既有缺陷**（各有独立台账项，均不阻塞本卡交付）：
  - 断网导致账号误杀（`persistCheckResult.ts:258-259` 把任何 `!item.success` 含超时/DNS/连接被拒写成 `status='error'`，而 `activation.ts:186` 硬过滤非 active 出池 → 一次离线扫描可永久踢掉健康账号）。**取证确认当前配置零受损**（1 账号 / 0 error），唯一历史足迹是诊断信息被覆盖；但机制成立，且当前无损只因「所有 fetch failed 恰落在已过期账号」这一时机运气。修复进行中（池准入判据与显示字段解耦）。
  - 临时风控被当永久封禁（`TEMPORARILY_SUSPENDED` 与永久原因共用同一判定分支、写盘点拍平）。
  - 手机面板无解除封禁入口（无头形态硬阻塞）。
  - 低额度谓词无消费者（额度喂入按决策卡选项 A 刻意未实现，避免 E-052 死代码）。
  - 换号决策仍在渲染进程（无头形态下主动换号阈值失效）。
