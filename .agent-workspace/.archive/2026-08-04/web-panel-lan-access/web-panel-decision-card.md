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

- [x] **W1** 跨端并发写入仲裁（四轮异构评审收敛：静默丢弃用户编辑 → 防线只堵一个入口 → 重放 base 取合并产物 → 对象别名污染）—— commit `aa03a94`
- [x] **W2/W3/W4** 账号业务剥离（三独立工作树并行 · 互斥行区间）—— `5ed3d25` / `2b23d07` / `d05f21b` / 合并 `ef472df`
  - W3 顺带修掉真实产品缺陷：v1.4.5 `d9c3784` 的 PRO+/POWER 识别修复漏传播到 `check-account-status`（用户日常"刷新额度"路径），故 PRO+ 账号一直显示为 Pro
  - W4 更正一处不存在的机制：主 AI 曾写"切号备份至 `kiro_switch_backups`"，实测全仓零命中，该目录由本仓库之外的工具创建 → 切号**无回滚路径可继承**
- [x] **W5a** 网络护栏原语抽取 —— `eaa2d18`
- [x] **W5b** 会话 + 守卫 + 登录限流 —— `2eb325c`
- [x] **W5c** 脱敏收口 + 静态闸门 —— `9a7291f`
- [x] **W6a** HTTP 服务器 + 路由 + 装配接线 —— `a6548c7`
  - 抓到只在组合处存在的缺陷：DTO 的 `hasRefreshToken` 布尔被脱敏层按子串匹配改写成 `'***'`（truthy），两个模块各自测试都抓不到
- [x] **W6b** 桌面设置页开关 —— `8ce132d`
- [x] **W6c** 独立 Vite 构建 + 打包接通 —— `3d93507`
- [ ] **W7a** 面板 UI —— 已交付待合并（本轮）
- [ ] **W7b** 静态资源服务 —— 在途
- [ ] **W8** 真机 e2e（手机浏览器全链路）—— 单测绿 ≠ 接通已证
- [ ] **W9** 处理 §4 三个缺陷 + §9.1.1 回写（CHANGELOG / ARCHITECTURE 演进索引）

---

## Update Log

- **2026-08-04 · 本文件重建**。前身从未落盘（详见文件头）。内容来源：已合入 main 的代码与注释、用户对话原话。所有 recon 报告与 reviewer 报告同样从未落盘，其结论已被吸收进本卡对应章节与各次 commit message —— 那些 commit message 是当前唯一可核查的决策记录载体。
- **落盘纪律**：本文件已 `git add` 提交。今后共享文档一律写主仓、写完即核实、随代码一同提交。
