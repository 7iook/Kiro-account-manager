# 反代编排闸门扩到服务端入口 —— 执行 findings

## 交付契约核验（下派未给 `[交付契约]` 块，按任务正文的成功态自行核验，逐格有锚点）

成功态（转自下派正文，未改写成实现视角）：
**NOT「测试文件里多了几行断言」，BUT「有人未来重写服务端入口、把同步池删掉或挪到
`proxy.start()` 之后时，闸门会红」**；负条件：闸门不得因为匹配了一个全仓已不存在的
名字而变绿（那与「不存在」不可区分）。

| 节点 | 生产者 | 消费者 | 核验 |
|---|---|---|---|
| 顺序不变量（面板） | `src/main/ipc/panelProxyDeps.ts:347-355` | 本闸门 `it:112` | ✅ 实读 |
| 顺序不变量（服务端） | `src/main/server/entry.ts:135-146` | 本闸门新增 `it` | ✅ 本轮接上 |
| 顺序不变量（桌面自启动） | `index.ts` 自启动块（`syncAccountsToPool()` → `server.start()`） | 本闸门新增发现式 `it` | ✅ 本轮接上 |
| 「出现新起点」信号 | `src/main/**` 全量扫描 | 发现式 `it`（数目锁定） | ✅ 本轮新建 |

---

## 1. 亲验：`syncPool(` **不是**陈旧名字（推翻下派的怀疑点 1）

下派提示 `:123` 的 `block.indexOf('syncPool(')` 可能在匹配一个已被改名的符号。
实测**不成立** —— 抽取导出函数时保留了一个同名薄封装：

```
panelProxyDeps.ts:215  export function syncProxyPoolFromStore(   ← 新的共用实现
panelProxyDeps.ts:237  function syncPool(impl, server): number   ← 薄封装,仍存在
panelProxyDeps.ts:350  const poolSize = syncPool(impl, server)   ← proxyStart 真的调它
```

⇒ 原断言**仍在测它声称测的东西**，没有「因匹配不到而变绿」。
但它确实**脆**：判据承重的是顺序，却把自己绑在一个特定名字上；下一次纯改名重构
（把薄封装删掉、面板直接调导出函数）就会让它给出「没有同步池」的**假失败**。

故本轮把它改成「两种写法都认」+ **反向自检**：匹配到的名字必须在该文件里真有
定义或 import，否则报「闸门匹配的是个不存在的名字」。这样「匹配不到」与
「不存在」不再不可区分 —— 这正是下派点出的本仓两次前例（`git grep` 零结果、
四种 electron import 只认一种）的病灶。

## 2. 服务端那一格：断言什么、以及刻意不断言什么

新增 `it('server/entry.ts 的自启动分支先同步池再启动')`：

| 断言 | 为什么 |
|---|---|
| 切片锚在 `if (shouldAutoStartProxy(` 内 | 文件里另有 `server.panel.start()`（⑤ 面板先于反代）。从全文件切片会把它算进来，那句「同步在 start 之前」就变成在比对面板启动的位置 |
| 下界锚在「紧随其后的顶层 `function`」 | 不用固定字符窗口 —— 窗口会随文案增删失效，而失效方向是**变绿** |
| `syncProxyPoolFromStore(` 存在 | 承重项 |
| `proxy.start()` 存在 | 防「切片切歪了导致两个 indexOf 都是 -1 却过关」 |
| syncIdx < startCallIdx | **本闸门的载荷** |
| 必须 import 自 `../ipc/panelProxyDeps` | 顺序不得有第二份实现（在服务端重抄一遍顺序 = 两处早晚分叉） |
| **`.not.toMatch(EMPTY_POOL)`** | 见下 |
| `poolSize` 出现在播报里 | 缺陷最贵的部分不是空池，是「只说反代已启动、指示灯全绿」 |
| `recordCount === 0` 分叉存在 | 三态里「盘上没号」与「有号但全不准入」要求的运维动作**相反** |
| `console.warn` ≥ 2 条 | 空池两态各需一条，少一条就有一态被静默 |

**刻意把 `EMPTY_POOL` 写成负向断言**，而不是「不要求」：读过
`.archive/2026-08-12/server-autostart-pool/findings.md` §5 的三条裁决后，服务端
照搬面板拒启是**错的**（会连带关掉 `assembly.ts:701` 的 `onPoolEmpty` 懒加载补池，
把「先起服务、后拷 `kiro-accounts.json`」这个合法首启态变成必须人工上面板点启动）。
把它写成 `.not.toMatch` 使这条刻意的分叉本身也被闸门保护 —— 未来有人「统一两端行为」
时会红，而不是静默把自愈路关掉。

## 3. 发现式判据：为什么不做成全自动，以及做成了什么

下派问「是否该对『每一处起反代』通用，而非手列文件」。**先数了一遍再决定**，
结论修正了上一轮的变体扫描：

全仓 `src/main/**`（112 个 .ts）里「有 `initProxyServer()` 且有 `(server|proxy).start()`」
的位置共 **5 处**，而上一轮 findings 只列了 4 处（把桌面侧当成 1 处自启动）。漏掉的两处：

| 位置 | 水合池? | 兜底 |
|---|---|---|
| `index.ts:1875` onToggleProxy（**托盘开关**） | ❌ 无 | `onPoolEmpty`（`index.ts:672`）；且是「屏幕前的人刚点了按钮」 |
| `index.ts:4593` `proxy-start` IPC（**渲染进程按钮**） | ❌ 无 | 同上 |

⇒ **全自动判据（「每个起点都必须在 start() 前水合」）会立刻判红这两处**，而它们都在
`src/main/index.ts` —— 本轮约束禁止修改，且它们的行为是合理的（有人在屏幕前 + 有自愈路）。
那样的闸门会长期挂红，然后被人加一张豁免清单绕过 —— 回到手列名单，只是多绕了一圈。

**采用的形状**：不判「每个起点都必须水合」，而是**锁数目 + 归类**。扫全量、
`toEqual` 一张 `{文件: 命中数}` 期望表，失败信息不是「去改这张表」而是提问：
新增那条在 `start()` 前水合了吗？没有的话靠什么兜底？是「有人在屏幕前」还是
「开机无人在场」？——**无人在场的必须水合**（服务端入口漏掉它的后果正是本缺陷）。

即：名单**可以**有豁免项，但名单**不能悄悄过期**。这回答了下派的「若保留手列，
就加一个『出现新起点时会失败』的东西」。附带一条 `it` 把归类表里标「水合」的
桌面自启动那格也断言了顺序（它的 `initProxyServer()` 与 `start()` 相隔近百行，
中间夹着 2s..10s 重试逻辑 —— 任何固定字符窗口的判据都会漏掉它，故按显式锚点切片）。

## 4. 可证伪性证明（两个突变，各自实跑）

`entry.ts` 变更前 SHA-256 = `401437A8D940A0F24D85D6B061964ACF39E3514EB1844A9A8225FDF3DE3113D0`（16384 B）

| 轮次 | `entry.ts` 状态 | EXIT | 读数 | 红的那条 |
|---|---|---|---|---|
| 基线 | 原样（已含自启动修复） | **0** | 16/16 过 | — |
| 突变① | **删掉** `syncProxyPoolFromStore(...)`，改成 `const recordCount=0; const poolSize=0` | **1** | 15 过 / **1 红** | `服务端自启动没有同步池: expected -1 to be greater than -1` |
| 突变② | 同步**挪到** `await proxy.start()` **之后** | **1** | 15 过 / **1 红** | `同步池必须在 proxy.start() 之前: expected 166 to be less than 111` |
| 还原 | 恢复原顺序 | **0** | 21/21 过（含 5 个自启动用例） | — |

两个突变都**只红新增那一条**（其余 15 条仍绿）⇒ 闸门有辨别力，不是「一改就全红」。
突变②尤其重要：它是「同步还在、只是位置错了」的形态，纯 `toContain` 类判据抓不到。

**还原逐字节核验**（不是靠肉眼看 diff）：
```
SHA=401437A8D940A0F24D85D6B061964ACF39E3514EB1844A9A8225FDF3DE3113D0
BYTES=16384
RESTORE=IDENTICAL
```
`git diff --stat` 对 `entry.ts` 仍是 `52 insertions(+), 2 deletions(-)` —— 即上一轮
自启动修复本身，本轮未在其上留下任何残留。

## 5. 验证读数（全部实跑，`*> file` + `$LASTEXITCODE`，无管道）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck:node` | **EXIT=0** |
| 本闸门 + 自启动用例 | `npx vitest run test/main/architecture/proxy_orchestration_wiring.test.ts test/main/server/serverAutostartPoolSync.test.ts --reporter=json` | **EXIT=0** · 21/21 |
| 全套件 | `npx vitest run --reporter=json` | **EXIT=0** · 514 suites · **1679 passed / 0 failed / 6 skipped** |

基线 1676 + 本轮 3 条新用例 = 1679，与预期一致。

## 6. Review Findings（对下派任务的核对）

1. **纠正下派的怀疑点 1（Tier 1 自纠，未停下）**：`syncPool(` 并非陈旧名字，薄封装仍在，
   原断言没有「因匹配不到而变绿」。但它绑死单一名字这件事是真脆点，已改为
   「两种写法都认 + 匹配到的名字必须真有定义/导入」。**下派的结论方向对，理由不对**。
2. **修正上一轮 findings 的变体扫描**：全仓起反代位置是 **5 处**而非 4 处，
   遗漏了托盘开关（`index.ts:1875`）与 `proxy-start` IPC（`index.ts:4593`）。
   两处都不水合池、靠 `onPoolEmpty` 兜底 —— 这直接决定了发现式判据**不能**做成
   「每个起点都必须水合」（会判红两处受约束禁改且行为合理的代码）。
3. **未改任何受约束文件**：`src/main/proxy/**` · `src/renderer/**` · `src/main/index.ts` ·
   `src/main/ipc/panelProxyDeps.ts` 全部未动；`entry.ts` 仅瞬时突变后逐字节还原。
   未碰 `.archive/2026-08-12/upstream-api-extract/` 与 `src/main/upstreamApi/*.ts`。
   未 `git add` / `commit` / `stash`。
4. **隐藏风险（登记，未擅自处理）**：`index.ts` 那两处不水合的起点依赖
   `onPoolEmpty` 兜底。按上一轮 findings §4 亲验的结论，**单账号模式**下若账号全不准入，
   懒加载返回 0 ⇒ `proxyServer.ts:1895` 严格模式拒绝 fallback ⇒ 每个请求失败。
   即这两条路在「单账号 + 全不准入」时没有真正的兜底，只是「有人在屏幕前」降低了
   它的代价。是否要给它们补水合，属于产品裁决（会改桌面端行为、且需改受约束文件），
   本轮不动，记在此处。

## 7. 改动文件

| 文件 | 改动 |
|---|---|
| `test/main/architecture/proxy_orchestration_wiring.test.ts` | 面板断言去掉单一名字绑定 + 加名字存在性自检；新增服务端入口顺序 `it`；新增 `describe('发现式: 起反代的位置数目锁定')`（2 条 `it`）。净 +3 条用例 |
