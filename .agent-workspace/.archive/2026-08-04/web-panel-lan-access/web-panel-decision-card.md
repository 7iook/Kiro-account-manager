# Web 管理面板（局域网访问）· Boundary Decision Card

> 类型：✨ Feature flow · 状态：**服务端与桌面开关已交付并合入 main；面板 UI 与静态服务在途**
> 重建日期：2026-08-04 · 基线 commit：`8ce132d`

---

## ⚠️ 关于本文件：它是重建版，前身从未落盘

**这份卡在 2026-08-03/04 的整个开发过程中被反复引用，但它当时并不存在。**

主 AI 声称把它落在 `.archive/2026-08-03/web-panel-lan-access/`，并把该路径写进了每一个 SUB 的派发指令、多条提交信息、以及对用户的多次汇报（"已写入决策卡"/"已更正决策卡"）。2026-08-04 由 W7a executor 指出该路径不存在，主 AI 用 Everything 全盘索引核实：

- `web-panel-decision-card.md` —— 全机器零命中
- `recon-ipc-extraction.md` / `recon-revision-sync.md` / `recon-webpanel-build.md` / `recon-http-layer.md` —— 全部零命中
- `W1-reviewer-report.md` / `W1-T7T8T9-*` / `W1-fixround-*` / `W1-final-*` / `W1-final2-*` / `W2W4-*` —— 全部零命中
- `.archive/2026-08-03/` 整个日期目录不存在
- `git log --all -- "*web-panel-decision-card*"` 零提交

**根因（主 AI 自述）**：
1. 写完文件后从不核实它落在哪、是否还在 —— 工具返回成功即当已落盘。这与本项目反复治理的"闸门存在 ≠ 闸门有效"是同一个病灶，只是这次犯在自己身上。
2. 极可能是在某个 git worktree 的 cwd 下写的共享文档。每个 worktree 各有一份 `.agent-workspace`，随 `Invoke-SafeClean` 清理工作树一并移入 `F:\.ai-trash`。**共享文档必须写主仓，不能写工作树。**
3. 对 7 个工作树跑清理时只验了"主仓完好"，没验"被移走的目录里有没有唯一副本"。

**为什么交付质量没崩**：SUB 们发现给定路径读不到，转而**从实际源码推导约束**（W7a 明确记录："我改从 routes.ts / dto.ts / respond.ts / auth.ts / server.ts 读，因为它们大量引用了卡的 §1/§3/§5"）。也就是说约束确实存在于代码与注释里，SUB 绕过了主 AI 给的死路径。这是 SUB 的功劳，不是编排有效。

**本重建版的内容来源**：全部来自**已合入 main 的代码与其注释**（可核查），以及用户在对话中的原话。凡无法从代码或用户原话追溯的，一律标注为待确认，不再凭记忆填充。

**落盘纪律（本轮起强制）**：本文件必须 `git add` 并提交。`.agent-workspace` 未被 gitignore（已核实 `git check-ignore` 无命中），提交后才不会随工作树清理消失。

---

## 🏗️ 1. Boundary Decisions

### 成功状态（用户原话直接转写）

用户原话定调：**「现在桌面上有什么按钮，网页上有什么就行了，不要改变。你直接照搬最好。」**

用户的真实使用场景（原话）：**「我是反代出去别的客户端用。添加账号一般是添加那个 key，导入到账号列表，刷新额度，然后到代理管理那里启动反代，那里还可以选账号。外部端并不需要登录进 IDE 或者 CLI。」**

**NOT**「主进程多起了一个 HTTP 服务、接口能返回 JSON」，
**BUT**「用户在同一局域网的手机打开浏览器，看到账号列表与每个账号的额度，点"刷新额度"能拿到新数字」。

日常链路：粘贴 `ksk_` API Key 批量导入 → 账号列表刷新额度 → 反代面板选账号 → 启动反代 → 外部客户端调 `/v1/*`。

**负条件（必须不发生）**：
1. 绝不发明桌面端没有的功能。
2. 绝不改变现有操作的语义。
3. 面板绑定 0.0.0.0 时绝不允许无鉴权启动。
4. `accessToken` / `refreshToken` / `clientSecret` / `csrfToken` / `ksk_` 明文绝不出主进程。
5. 绝不让「能调反代 `/v1/*` 的凭证」自动获得账号管理权。

### 已交付的边界（可核查 · 均在 main 上）

| 关注点 | 落点 | 说明 |
|---|---|---|
| 并发写入仲裁 | `main/accountService/state.ts` | 集合级 revision 乐观锁，7 条写路径收口 |
| 三方合并 | `renderer/src/store/syncMerge.ts` | base/ours/theirs 记录级合并 |
| 冲突提示 | `renderer/src/components/SyncErrorNotice.tsx` | 用户裁决：弹窗告知（见下） |
| 账号业务 | `main/accountService/`（14 模块） | 从 `ipcMain.handle` 回调剥离，IPC 与 HTTP 共用 |
| 网络护栏 | `main/utils/netGuard.ts` | 常量时间比较 / IP 白名单 / CIDR，**必须保持无策略** |
| 会话与守卫 | `main/webPanel/{auth,session,cookie,loginThrottle}.ts` | 独立 adminKey，非复用反代 API Key |
| 脱敏收口 | `main/webPanel/{dto,respond}.ts` + `utils/redact.ts` | 白名单投影 + 兜底脱敏双层 |
| HTTP 服务 | `main/webPanel/{server,routes}.ts` | 纯 Node http，手工路由 |
| 装配接线 | `main/ipc/webPanelWiring.ts` + `index.ts` | autostart / dispose / IPC |
| 构建 | `vite.webPanel.config.ts` | **独立 Vite 构建**，非 electron-vite 多入口（见 §5） |
| 桌面开关 | `renderer/src/components/pages/WebPanelCard.tsx` | 开关由真实监听状态驱动 |

### 用户裁决记录

**冲突提示方式（2026-08-03）**：两端并发写导致自动合并失败时，**用弹窗立刻告知**——「这次改动没保存成功，界面已同步到最新，请重新操作」。用户原话选项："弹窗立刻告诉我"。

实现约束：照项目既有 `alert()` 方式（仓内 `git grep toast -- src/renderer/` 零命中），**不引入新提示系统**；不在 store 层调 `alert`（不合分层），由组件订阅后弹出。

---

## 📐 2. 照搬原则的豁免清单

凡偏离"桌面端有什么网页端就有什么"的地方，理由必须写在这里。

| 操作 | 桌面端 | 网页端 | 理由 |
|---|---|---|---|
| 复制凭证 | 完整字段 | 不提供，提示"请在桌面端复制" | 负条件 4 优先于按钮对齐 |
| **端点入参** | 多个 handler 以 `accessToken` 为第一个位置参数 | **一律按 `accountId` 寻址** | 照抄签名等于让浏览器把 token 发上局域网。这是最省力、也最像"忠于原实现"的错法，故必须显式记下 |
| 管理订阅 | 打开 BrowserWindow | 返回 URL 由浏览器打开 | **⚠️ 该豁免当前失效，见 §4 缺陷 2** |
| 打开本机配置文件夹 | `shell.openPath` | 只读展示路径 | 浏览器无本机文件访问权 |
| 添加账号 | `AddAccountDialog` | **暂不提供**，界面明示"请在桌面端操作" | `ksk_` 导入的装配逻辑（对象构造/判重/稳定 userId 派生）住在 renderer 的 `AddAccountDialog.tsx:1477-1545` 而非 `accountService`，`verifyApiKey` 只做校验。复制进面板会造第二个真源 |
| CA 证书 / Machine ID / 托盘 / autoUpdater / OAuth 回调 | Electron API | **仅桌面端** | 宿主机能力 |
| 导入 / 导出 | Electron dialog | 上传 / 下载 | 语义等价（W4 已把"选路径"与"读写内容"拆开，使这句话真成立） |

---

## 🔐 3. 授权与脱敏

### 独立授权域

**不得复用反代 API Key 做面板鉴权。** 已核实 `proxy/types.ts` 注释：`apiKeyAccountBindings` 是「该 API Key **可使用**的账号白名单」= 调用侧权限；它还绑着 credits 配额与按 key 限流。语义是"这个调用方能用哪些账号"，与"是否管理员"正交。复用即权限提升。

- 独立 `webPanel.adminKey`，首次启用时生成，**无默认密码**
- 会话：`HttpOnly` + `SameSite=Strict` + `Path=/panel`（HTTPS 时加 `Secure`），24h 绝对 + 2h 空闲双时钟
- 轮换 adminKey 立即失效所有既存会话（必须走 `rotateAdminKey()`，直写 store 会让轮换变成装饰）
- CSRF：写操作要求 `X-Panel-Request: 1`；**与会话校验在同一 guard 内返回单一布尔**（拆成两处迟早有端点只过一个）
- 登录端点按 IP 限流：**只计失败、成功清零**（反代那个滑动窗口连成功也计数，用于限制调用频次，直接复用会"要么锁死正常用户、要么拦不住猜测者"）

### `/panel` 前缀有四个消费者

Vite `base` / `WEB_PANEL_URL_PREFIX` / 服务器路由前缀 / cookie `Path`。**改一个必须四个一起改**，否则浏览器静默不发 cookie，表现为"登录成功但之后全 401"。目前仅两个被测试钉住，值得补一道静态闸门。

### 脱敏收口在 HTTP 响应层，不在数据源头

桌面 renderer 依赖明文工作，源头脱敏会打断它。两层：`dto.ts` 白名单投影决定给什么；`respond.ts` 的 `sendJson()` 无条件过 `redactValue` 兜底。

**静态闸门是唯一防线**：`accountService/accounts.ts:loadAccounts()` 返回 `Promise<unknown>`，TypeScript 拦不住 `res.end(JSON.stringify(内部对象))`。故 `test/main/architecture/webpanel_no_direct_res_end.test.ts` 禁止 `webPanel/` 下直接 `res.end`（`respond.ts` 自身白名单）。该闸门已验证会红。

---

## 🐛 4. 已知缺陷（W7a 报告 · 待处理）

### 缺陷 1 · 刷新额度不持久化

`accountService/check.ts:checkAccountStatus` 只返回数据；**持久化发生在 renderer store**（`store/accounts.ts:1996` 设值并保存）。面板经 `index.ts:4319` 调同一函数但没有那个 store，所以刷新后重新 `GET /accounts` 拿到的还是旧值。

W7a 的处理：把响应合并进内存列表态，使按钮在当次会话内诚实——但**刷新结果在页面重载后丢失，桌面端也看不到**。真正的修法是 check 之后服务端持久化，属 `accountService` 改动。

### 缺陷 2 · 订阅链接豁免被脱敏层击穿（两处设计互相矛盾）

两个独立问题叠加：
1. `subscription-url` 的 handler 从 `ctx.body` 读 `subscriptionType`，但 `server.ts` 只对 POST/PUT/PATCH 解析 body、从不解析 query string → 该参数永远 `undefined`
2. 即使拿到 URL 也不可用：`fetchSubscriptionToken` 返回的 `encodedVerificationUrl` 内含 JWT，而 `redactString` 规则 3 会打码任何 JWT 形状的子串。W7a 实测：
   ```
   in : https://kiro.dev/subscribe?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjft...
   out: https://kiro.dev/subscribe?token=eyJhbG***EjXk
   ```

**§2 的豁免（"返回 URL 由浏览器打开"）与强制脱敏层直接矛盾。** W7a 没做绕过（那会在安全边界上开洞），改为列出套餐并提示在桌面端管理订阅。

注：不含 JWT 的不透明 token 能穿过，故这是**潜在不一致**而非一律失败——取决于上游 token 格式。

### 缺陷 3 · 封禁判定被复制成两份

DTO 覆盖了桌面卡片显示的一切，除 `isBanned`：它原样送 `lastError`，故 W7a 不得不把 `_helpers.ts:167` 的关键词匹配逻辑复制进面板。两份分类器必然漂移。

干净的修法是 DTO 直接给布尔（"送结论不送原料"正是它自己的原则），但那是契约变更。

---

## 🧱 5. 构建与打包（W6c 推翻了原方案）

**面板不是 Electron renderer，走独立 Vite 构建。**

原方案（给 `electron.vite.config.ts` 的 renderer 加第二入口）实测构建失败：electron-vite 默认 `renderer.root = ./src/renderer`，`src/webPanel/` 在其外故 Rollup 拒绝 emit；把 root 抬到 `src` 会连带弄坏桌面端（现有 HTML 引根相对 `/src/main.tsx`，会解析成 `src/src/main.tsx`）。

**更要紧的第二个理由**：renderer 管线按 Electron 版本钉 `build.target`（Electron 38 → chrome140）。面板发给**任意手机浏览器**，chrome140 下界会 emit 老 Safari / Android WebView 解析不了的语法 —— 正是"我机器上好用、手机上白屏"。

故：`electron.vite.config.ts` **零改动**；`vite.webPanel.config.ts` 独立构建，`target: ['es2022','safari15.4']`，`base: '/panel/'`（绝对路径必须，用 `'./'` 时 `GET /panel` 无尾斜杠会把资源解析到 `/assets/*` → 404）。

`electron-builder.yml` 无需改动 —— 已在真 asar 里核到 5 条 webPanel 条目并回放读取成功。`files:` 是全否定列表且无一条排除 `out`；`asarUnpack` 是给原生 DLL 的，web 资源不可解包。

运行时定位 `utils/webPanelAssetRoot.ts`：**刻意不照抄 `tray.ts` 的 `app.isPackaged` 分支** —— 那个分支之所以必要是因为 `asarUnpack: resources/**` 把图标挪到 asar 之外；面板资源在 asar 之内、与 `out/main/index.js` 同处，故 `out/main → ../webPanel` 在 dev 与打包后完全相同（已在真 asar 验证）。加一个永不走到的分支是会腐烂成谎言的死路径。

顺带修一处既存断链：`build:mac` / `build:linux` 原先绕过 `npm run build`，既跳过 typecheck 也会让 mac/Linux 安装包**静默缺少面板资源**。

---

## 📋 6. 任务清单

> **Evidence 的回捞来源与诚实边界**：本清单原先 8 项只有 commit hash、无 `**Evidence**` 块（异构评审检索得 `NO_EVIDENCE_BLOCKS`）。2026-08-05 补齐时，`verify` 一律**从对应 commit body 里当时真跑过的验证段回捞**（`git log -1 --format=%B <sha>`，各 commit 均含"vitest N passed / M files EXIT=0 + typecheck 双 EXIT=0"字样），`files` 从 `git show --stat <sha>` 回捞。**没有回捞到的一律写 `not recovered`，不补一条像样的命令加一个退出码** —— 伪造的 EXIT 比承认缺口更糟。

- [x] **W1** 跨端并发写入仲裁（四轮异构评审收敛：静默丢弃用户编辑 → 防线只堵一个入口 → 重放 base 取合并产物 → 对象别名污染）—— commit `aa03a94`
  - **Evidence**: commit `aa03a94` · verify `vitest` → 358 passed / 46 files EXIT=0（基线 304 → +54）· `typecheck:node` + `typecheck:web` → 双 EXIT=0（回捞自 commit body 验证段）· files `src/main/accountService/state.ts:1-207`（revision 乐观锁收口）· `src/renderer/src/store/syncMerge.ts:1-238`（三方合并）· `src/renderer/src/components/SyncErrorNotice.tsx:1-37` · `test/main/accountService/state.test.ts` + `test/renderer/cross-end-sync/{staleReplay,syncMerge,broadcastAndSettings,dirtyWindowGuard,syncErrorNotice}` 6 份 · AC 面板与桌面并发写同一账号时不静默丢弃任一端的用户编辑；冲突由 `SyncErrorNotice` 交用户裁决
- [x] **W2/W3/W4** 账号业务剥离（三独立工作树并行 · 互斥行区间）—— `5ed3d25` / `2b23d07` / `d05f21b` / 合并 `ef472df`
  - W3 顺带修掉真实产品缺陷：v1.4.5 `d9c3784` 的 PRO+/POWER 识别修复漏传播到 `check-account-status`（用户日常"刷新额度"路径），故 PRO+ 账号一直显示为 Pro
  - W4 更正一处不存在的机制：主 AI 曾写"切号备份至 `kiro_switch_backups`"，实测全仓零命中，该目录由本仓库之外的工具创建 → 切号**无回滚路径可继承**
  - **Evidence**: commit `5ed3d25`（W3）/ `2b23d07`（W4）/ `d05f21b`（W2）/ merge `ef472df` · verify W3 → `vitest` 386 passed / 47 files EXIT=0 + typecheck 双 EXIT=0 + 生产 caller 亲验在 `index.ts:3845/4073/4074`（非仅 tests）+ accountService 零 electron 依赖；W4 → 407 passed / 49 files EXIT=0 + typecheck 双 EXIT=0；W2 → 415 passed / 51 files EXIT=0 + typecheck 双 EXIT=0 + 零 electron 依赖（三者均标注"主 AI 独立亲跑复核"，回捞自各 commit body）· files W3 `src/main/accountService/{check.ts,parseUsage.ts,refresh.ts,types.ts}` + `index.ts`（-958）· W4 `src/main/accountService/{switch.ts,switchCli.ts,subscription.ts,transfer.ts}` · W2 `src/main/accountService/{accounts.ts,credentials.ts,verify.ts,usage.ts,index.ts}` · AC 账号业务不再依赖 `IpcMainInvokeEvent` / preload，IPC 与 HTTP 两个传输通道能复用同一份实现
- [x] **W5a** 网络护栏原语抽取 —— `eaa2d18`
  - **Evidence**: commit `eaa2d18` · verify `vitest` → 549 passed / 58 files EXIT=0（基线 500/56）· typecheck 双 EXIT=0 · **错接线反证**：把 wrapper 改成 `isIPAllowed(clientIP, {})` 即静默失效 IP 白名单，4 个接线测试精确转红（纯函数测试全绿 —— 这正是接线测试存在的理由），已还原并复验（回捞自 commit body）· files `src/main/utils/netGuard.ts:1-177`（新增）· `src/main/proxy/proxyServer.ts`（-131 收口）· `test/main/utils/netGuard.test.ts` + `test/main/proxy/netGuardWiring.test.ts` · AC 护栏原语由反代与面板共用一份，不各写一套 IP/端口判定
- [x] **W5b** 会话 + 守卫 + 登录限流 —— `2eb325c`
  - **Evidence**: commit `2eb325c` · verify `vitest` → 555 passed / 61 files EXIT=0（基线 500/56）· `typecheck:node` + `typecheck:web` → 双 EXIT=0（回捞自 commit body）· files `src/main/webPanel/auth.ts:1-211` · `session.ts:1-131` · `loginThrottle.ts:1-116` · `cookie.ts:1-84` · 闸门 `test/main/architecture/webpanel_auth_constraints.test.ts` · AC 负条件 3「绑定 0.0.0.0 时绝不允许无鉴权启动」由 `auth.ts` + 架构闸门共同守住；登录失败有限流
- [x] **W5c** 脱敏收口 + 静态闸门 —— `9a7291f`
  - **Evidence**: commit `9a7291f` · verify `vitest` → 541 passed / 60 files EXIT=0 · `typecheck:node` → EXIT=0（commit body 只记了 node 一侧，**web 侧未回捞到** → `typecheck:web: not recovered`）· **闸门真红验证**：闸门精确报出 `dto.ts:229` 违规行及内容，EXIT=1 转红（回捞自 commit body）· files `src/main/webPanel/dto.ts:1-226`（allowlist 投影）· `respond.ts:1-87`（denylist 兜底）· `src/main/utils/redact.ts` · 闸门 `test/main/architecture/webpanel_no_direct_res_end.test.ts` · AC 负条件 4「凭据明文绝不出主进程」——两层（白名单投影 + 无条件脱敏）+ 第三层静态闸门禁止绕过
- [x] **W6a** HTTP 服务器 + 路由 + 装配接线 —— `a6548c7`
  - 抓到只在组合处存在的缺陷：DTO 的 `hasRefreshToken` 布尔被脱敏层按子串匹配改写成 `'***'`（truthy），两个模块各自测试都抓不到
  - **Evidence**: commit `a6548c7` · verify `vitest` → 677 passed / 70 files EXIT=0（基线 645/67）· typecheck 双 EXIT=0（回捞自 commit body）· files `src/main/webPanel/server.ts:1-390` · `routes.ts:1-320` · `src/main/ipc/webPanelWiring.ts:1-347`（生产装配）· `src/main/index.ts`（+93 接线）· 组合缺陷回归 `test/main/webPanel/dtoRedactComposition.test.ts` · 装配闸门 `test/main/architecture/webpanel_production_wiring.test.ts` · AC 面板与 IPC 经 `buildPanelRouteDeps` 复用同一批 accountService 函数（生产装配点 `index.ts:4358`），非各自实现
- [x] **W6b** 桌面设置页开关 —— `8ce132d`
  - **Evidence**: commit `8ce132d` · verify `vitest` → 714 passed / 4 skipped / 73 files EXIT=0（基线 703/4/72）· typecheck 双 EXIT=0 · 顺带钉住一条真实约束：renderer 不能直接引 main 的类型（`tsconfig.web.json` 不含 `src/main/**`，`@preload` 别名只存在于 `vitest.config.ts` ⇒ 走它会「测试过、typecheck:web 与打包炸」）（回捞自 commit body）· files `src/renderer/src/components/pages/WebPanelCard.tsx:1-455` · `SettingsPage.tsx` · `src/preload/index.{ts,d.ts}` · `i18n/locales/{zh,en}.ts` · `test/renderer/web-panel-settings/WebPanelCard.test.tsx` · AC 用户能在桌面设置页开关面板、看到访问地址与 adminKey
- [x] **W6c** 独立 Vite 构建 + 打包接通 —— `3d93507`
  - **Evidence**: commit `3d93507` · verify `vitest` → 654 passed / 68 files EXIT=0（基线 645/67）· **推翻原方案的实测**：给 renderer 加第二入口构建 EXIT=1（Rollup 拒绝 emit `src/webPanel/`）· 真 asar 回放：核到 5 条 webPanel 条目并读取成功 · 顺带修断链：`build:mac` / `build:linux` 原先绕过 `npm run build`，既跳过 typecheck 也让 mac/Linux 安装包静默缺面板资源（回捞自 commit body）· files `vite.webPanel.config.ts:1-71` · `src/main/utils/webPanelAssetRoot.ts:1-106` · `src/webPanel/{index.html,main.tsx,styles.css}` · `package.json`（四个打包脚本全经 `npm run build`）· `tsconfig.{web,node}.json`（纳入 `src/webPanel/**/*`，否则面板源码根本没被检查）· 闸门 `test/main/architecture/webpanel_build_assets.test.ts` · AC 面板产物 `target: ['es2022','safari15.4']`，手机浏览器不因 chrome140 下界白屏；打包后资源在 asar 内可定位
- [ ] **W7a** 面板 UI —— 已交付待合并（本轮）
- [ ] **W7b** 静态资源服务 —— 在途
- [ ] **W8** 真机 e2e（手机浏览器全链路）—— 单测绿 ≠ 接通已证
- [ ] **W9** 处理 §4 三个缺陷 + §9.1.1 回写（CHANGELOG / ARCHITECTURE 演进索引）

---

## 🔗 7. 链路表：「刷新」两条链的 producer → consumer（2026-08-05 补）

> 补的理由：本卡原缺 §0.15B 要求的链路表，而「刷新额度」与「刷新 Token」两条链正是**同一形状的缺陷各出现一次**——业务函数只返回、落盘长在 renderer store 里，面板走 HTTP 调同一函数却没有那个 store。每个 `existing` 跳都给 `file:line` 锚点（可 grep 复核）。

### 链路 A · 刷新额度（W8 已接通 · commit `1305a17`）

| 节点 | producer | consumer |
|---|---|---|
| 面板按钮 | `src/webPanel/` UI | `POST /api/accounts/:id/check` |
| HTTP 路由 | `src/main/webPanel/routes.ts:453`（`case 'POST check'`） | `deps.checkAccountStatus` |
| 生产装配 | `src/main/ipc/webPanelWiring.ts:314` + `src/main/index.ts:4357` | 同一业务函数 |
| 业务函数 | `src/main/accountService/check.ts:183`（`checkAccountStatus`） | `persistCheckResult` |
| 落盘 | `src/main/accountService/persistCheckResult.ts:172`（→ `persistAccountPatch`） | `applyAccountDataMutation` |
| 写入收口 | `src/main/accountService/state.ts:145`（revision 乐观锁 + 串行锁） | `storeRef.set('accountData')` + 广播 |
| **最终 sink** | electron-store 磁盘 blob | 面板重新 `GET /api/accounts`（用户重载页面）· 桌面端 `accounts-data-changed` → `reloadFromStorageQuiet` |

### 链路 B · 刷新 Token（本轮接通 · 见下方 Update Log）

| 节点 | producer | consumer |
|---|---|---|
| 面板按钮 | `src/webPanel/` UI | `POST /api/accounts/:id/refresh-token` |
| HTTP 路由 | `src/main/webPanel/routes.ts:462`（`case 'POST refresh-token'`） | `deps.refreshAccountToken` |
| 生产装配 | `src/main/ipc/webPanelWiring.ts:319` + `src/main/index.ts:4358` | 同一业务函数 |
| 业务函数 | `src/main/accountService/refresh.ts:47`（`refreshAccountToken`） | `persistRefreshResult` |
| 落盘 | `src/main/accountService/persistRefreshResult.ts:96` | `persistAccountPatch` |
| 补丁收口（本轮新增 SSOT） | `src/main/accountService/persistAccountPatch.ts:75` | `applyAccountDataMutation` |
| 写入收口 | `src/main/accountService/state.ts:145` | `storeRef.set` + 广播 |
| **最终 sink** | electron-store 磁盘 blob 的 `accounts[id].credentials.refreshToken` | 下一次 OIDC 续期（`refreshTokenByMethod` 用它换新 token）· 面板 DTO `expiresAt`（`dto.ts:182`）· 桌面端广播回流 |

**旁路（刻意不合并 · 两个关注点）**：`refresh.ts:119-170` 条件写 Kiro IDE 的 `kiro-auth-token.json`——仅当该账号是 IDE 当前激活账号（磁盘 refreshToken 匹配 或 `lastSwitchedAccountId` 匹配）。它写的是 **IDE 的 SSO 缓存**，与上表写的 **本应用 accountData** 是不同的 sink；一个账号可以不是 IDE 激活账号（不写 IDE 文件）但凭据依然必须落盘。

**真实 e2e 姿态**：`test/main/accountService/refreshPersistence.test.ts` 真起 `WebPanelServer`（真 `http.Server` + 真 `fetch`）→ 真 POST → 直读盘面断言。**仍未验的一跳**：未在真实 Electron 双进程里跑过「手机点刷新 → 桌面端界面变化」，本仓单测栈不启 electron，这一跳要人工验（与链路 A 同一边界）。

---

## Update Log

- **2026-08-04 · 本文件重建**。前身从未落盘（详见文件头）。内容来源：已合入 main 的代码与注释、用户对话原话。所有 recon 报告与 reviewer 报告同样从未落盘，其结论已被吸收进本卡对应章节与各次 commit message —— 那些 commit message 是当前唯一可核查的决策记录载体。
- **落盘纪律**：本文件已 `git add` 提交。今后共享文档一律写主仓、写完即核实、随代码一同提交。
- **2026-08-05 · executor · 面板刷新 Token 落盘 + 偿还任务清单证据债**。
  - **代码**：`refreshAccountToken` 原先只返回新凭据不落盘（`refresh.ts` 自己在 return 块注释里把落盘外包给 renderer），面板 `routes.ts:462` 走 HTTP 调它却没有 renderer store ⇒ IdP 轮换出的新 refreshToken 只出现在 HTTP 响应里、随渲染丢弃，盘上留一个已被上游作废的死凭据。新增 `persistRefreshResult.ts`（字段清单逐字段对齐 renderer 基线 `store/accounts.ts:1843-1866`，含 `profileArn` 三级回退次序与 `||` 保留语义）+ `persistAccountPatch.ts`（把「盘面遍历 / 账号不存在中止 / 仲裁异常」从 `persistCheckResult` 抽成两条刷新链共用的 SSOT，避免第二个调用方复制一遍那段 traversal）；`refresh.ts` 在返回成功**之前**落盘，落不了盘即整次刷新失败（照 `check.ts:190` 同一顺序）。桌面 renderer 那次 `saveToStorage()` 删除（双写且更旧的快照会覆盖刚写的），依据是 `syncMerge.ts:184` 对 credentials 的字段级例外——「我没改过凭据而别人改了」采纳 theirs。两个调用方现已收敛到同一条持久化路径。
  - **验证（真跑）**：新增 `test/main/accountService/refreshPersistence.test.ts` 12 例（真起 `WebPanelServer` + 真 fetch + 直读盘面）。红：8 failed / 4 passed，全部为 `expected 'refresh-v1' to be 'refresh-v2'`（缺持久化，非 setup 错）。绿：12 passed EXIT=0。全量 `npx vitest run` → **88 files / 946 tests passed EXIT=0**（基线 87/934）。`npx tsc --noEmit -p tsconfig.node.json --composite false` EXIT=0 · `-p tsconfig.web.json --composite false` EXIT=0。
  - **未验**：`unverified: 未在真实 Electron 双进程里跑过「手机点刷新 Token → 桌面端界面同步」`——本仓单测栈不启 electron（与链路 A 同一边界，广播已在测试中确认发出且 payload 不含凭据）。
  - **文档**：§6 任务清单 8 个 `[x]` 项补齐四要素 `**Evidence**`（commit / verify / files / AC），来源为各 commit body 的验证段与 `git show --stat`；`W5c` 的 `typecheck:web` 当时未记录，写作 `not recovered` 而非补造。新增 §7 链路表（两条刷新链的 producer→consumer + 最终 sink + 未验的一跳）。
  - **踩到的坑**：直接跑 `npx tsc --noEmit -p tsconfig.web.json` 会报一片 TS6307，那是**缺了项目自己的 `--composite false`**（见 `package.json` 的 `typecheck:web` 脚本），不是代码问题。复核 typecheck 必须用项目脚本的完整参数。
