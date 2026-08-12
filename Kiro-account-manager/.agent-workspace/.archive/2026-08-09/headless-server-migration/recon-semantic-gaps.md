# 无头服务器形态 · 语义失效侦察报告

> 侦察范围受限：只读代码、未改任何业务文件。产出 = A 页面判定表 / B 重点功能处置 / C 面板覆盖差距。
> 前提（已定产品决策，不重新讨论）：账号池 + 反代 + Web 面板跑在 Linux 无桌面服务器，7×24；权限单一 adminKey；加号只留粘贴 ksk_。
> 工具预算受限，未覆盖项见 §D。

## 0. 证据锚点（本轮真跑过的检索）

| 结论 | 工具 + 查询 | 命中 |
|---|---|---|
| 侧栏 15 项导航 | `git grep -n "id: '" -- src/renderer/src/components/layout/Sidebar.tsx` | `Sidebar.tsx:18-33` |
| 页面 switch | `read_file src/renderer/src/App.tsx offset 425` | `App.tsx:428-462` |
| 16 个页面组件 | `list_directory .../components/pages` | AboutPage…WebPanelCard |
| 面板 API 全量面 | `git grep -n "path === " -- src/main/webPanel/routes.ts` | `routes.ts:388-556` |
| 切号写宿主机 | `read_file accountService/switch.ts:1-45` + `switchCli.ts:1-40` | `switchCli.ts:8-10` 明写「运行主进程那台机器」 |
| 反代配置刻意留桌面 | `read_file routes.ts offset 355` | `routes.ts:362-370` |
| machineId 反代消费点 | `git grep -n "machineId" -- src/main/proxy` | `kiroApi.ts:1745-1753` `getAccountMachineId` |
| 主进程只搬了 token 刷新一半 | `read_file index.ts:2435-2490` + `git grep autoSwitchEnabled` | `index.ts:2619` vs `store/accounts.ts:3084` |
| 面板无池/webhook 端点 | `git grep -rn "proxyPool\|webhook" -- src/main/webPanel` | **零命中** |

---

## A. 桌面端页面清单与逐页判定

侧栏 15 项（`Sidebar.tsx:18-33`），`App.tsx` switch 映射（`accounts` 走 `AccountManager`；`WebPanelCard` 是 SettingsPage 内嵌卡片，非导航页）。

| # | 页面 | 组件 | 判定 | 理由 |
|---|---|---|---|---|
| 1 | 主页 | `HomePage` | **需重定义** | 桌面版是本机总览（账户数/状态卡片）。服务器形态应重定义为「反代运行态 + 池健康度 + 请求量」的运维首页 |
| 2 | 账号 | `AccountManager` | **保留**（必须搬面板） | 账号池是核心资产。但增删改查只有 renderer 一条路，面板仅 list + import |
| 3 | 机器码 | `MachineIdPage` | **需重定义** | 见 §B.3：改本机 `/etc/machine-id` 无意义且有害；但「逐账号绑定 machineId」是反代请求头真源，必须保留 |
| 4 | Kiro 设置 | `KiroSettingsPage` | **去掉** | 读写本机 Kiro IDE 的 settings/MCP/steering（`window.api.getKiroSettings`）。服务器上没有 IDE，无消费方 |
| 5 | API 反代 | `ProxyPage` | **保留**（必须搬面板） | 端口/API Key/模型映射的唯一编辑入口，没有它反代装上就配不了 |
| 6 | K-Proxy | `KProxyPage` | **需重定义** | 见 §B.4：拦本机 IDE 流量的用法失效；但它同时持有 deviceId 映射表，被反代读（`kiroApi.ts:1748`） |
| 7 | 代理池 | `ProxyPoolPage` | **保留**（必须搬面板） | 出口代理是账号防关联的运行时依赖，与桌面无关。面板零端点 |
| 8 | 注册 | `RegisterPage` | **去掉**（转独立离线工具） | 见 §B.2：BrowserWindow 开 Proton 网页 + 人工过 hCaptcha/2FA，无头跑不通 |
| 9 | 批量订阅 | `SubscriptionPage` | **需重定义** | 底层是纯 HTTP（面板已有 `GET subscriptions` / `subscription-url` / `POST overage`），但批量编排 UI 只在桌面 |
| 10 | Webhook | `WebhooksPage` | **保留**（必须搬面板） | 7×24 无人值守下告警通道价值更高而非更低。面板零端点 |
| 11 | 一键诊断 | `DiagnosePage` | **需重定义** | 诊断项混了「本机 IDE 环境」与「账号/网络连通性」，前者失效后者必需，需拆（待确认，见 §D.4） |
| 12 | 配置同步 | `ConfigSyncPage` | **需重定义** | 导出/导入 JSON。服务器上退化为备份/恢复，需改成文件上传下载而非桌面文件对话框 |
| 13 | 系统日志 | `LogsPage` | **保留**（必须搬面板） | 无桌面 = 无法看日志，这是排障唯一窗口 |
| 14 | 设置 | `SettingsPage` | **需重定义** | 混装：主题/语言/隐私模式（渲染层，无意义）+ 自动刷新/换号阈值/全局代理/adminKey（必需）。必须拆 |
| 15 | 关于 | `AboutPage` | **去掉** | 版本号/赞赏码/更新检查。面板留一行版本号即可 |

---

## B. 语义失效功能重点判定

### B.1 `switchAccountToIde` / `switchAccountToCli` —— 需重定义，**不建议直接删**

事实：`switchCli.ts:8-10` 文件头明写「写的是**运行主进程那台机器**的 `%LOCALAPPDATA%\kiro-cli\data.sqlite3`（Windows）或 `~/.local/share/kiro-cli/data.sqlite3`」；`routes.ts:499-501` 重复了同一告警。`switch.ts:15-21` 进一步说明写方与 `index.ts:1875/:1937` 的 `fs.watch` watcher 构成双向同步回路。

服务器形态语义：
- `switchAccountToIde`（写 SSO 缓存 + IDE machineid）→ **语义完全失效**：服务器上没有 Kiro IDE，没人读那个缓存，fs.watch watcher 永不触发。**但它不是死代码**——它是 v1.7.3 修过四个真实故障（bug A/C/D/F，`switch.ts:23-29`）的 token 刷新+落盘实现，`refreshedCredentials` 回传被反代 store 消费。
- `switchAccountToCli` → **可能仍有意义**：`~/.local/share/kiro-cli/data.sqlite3` 是 Linux 路径，若服务器真装了 kiro-cli，这是唯一入口。

处置建议：
1. **不删函数，改归属**。把「refresh token + 校验 + 回传 refreshedCredentials」从「写宿主机登录态」里剥开——前者是账号池日常必需，后者才是桌面语义。目前耦合在一个函数里，删外壳会连带丢掉 bug A/C/D 的修复。
2. 面板 `POST switch` / `POST switch-cli`（`routes.ts:503-519`）在服务器形态下**语义误导**：用户以为是「切反代当前账号」，实际是改服务器的 SSO 缓存文件。反代选号的正确端点是 `POST /api/proxy/active-account`。建议**下线这两个面板端点**，或改名 + 明确文案。
3. §0.17 分类：`switchAccountToIde` 外壳是 **D**（无消费方），内核是 **A**（token 生命周期）。

### B.2 注册流程 `registration/proton-mail-window.ts` —— 去掉（无头下不可运行）

事实（`proton-mail-window.ts:1-26`）：起 `BrowserWindow` 加载 `https://mail.proton.me/u/0/inbox`，靠官方网页自己完成 SRP 登录 + PGP 解密，再 `webContents.executeJavaScript` 读已解密 DOM 取 6 位码；**首次需用户在弹窗里手动登录（含 hCaptcha/2FA）**，之后靠 `partition='persist:proton'` 复用。

三重阻断：① 无显示器（BrowserWindow 需 X/Wayland 或 xvfb）；② 首次人工过 hCaptcha 无法 headless 完成；③ Proton DOM 选择器随改版失效需人工修（文件头 WARN 已注明）。

处置建议：**从服务器形态剔除**。注册是低频、需人工介入的批量作业，与「7×24 无人值守跑反代」是两种工作。保留桌面版作独立离线注册工具，产出 ksk_ 再粘贴进服务器面板——与「加号只留粘贴 ksk_」的既定决策天然吻合。

### B.3 `machineId.ts` —— 需重定义（**拆成两个语义，别当一件事**）

`machineId.ts` 混了两类完全不同的能力：
- **改本机系统机器码**：Windows 改注册表 MachineGuid（需管理员）、macOS 改 IOPlatformUUID、Linux 改 `/etc/machine-id` 或 `/var/lib/dbus/machine-id`（需 root），并同步写 Kiro IDE 的 `machineid` 文件。
- **逐账号绑定 machineId**：`MachineIdPage` 的 `bindMachineIdToAccount` / `randomizeAccountMachineId`，落在账号记录的 `machineId` 字段。

反代真实消费点（`kiroApi.ts:1745-1753`）：

```
function getAccountMachineId(accountId: string, accountMachineId?: string): string {
  if (accountMachineId) return accountMachineId
  const kproxyService = getKProxyService()
  if (kproxyService) { const deviceId = kproxyService.getDeviceIdForAccount(accountId); if (deviceId) return deviceId }
  return generateStableMachineId(accountId)   // sha256(`kiro-device-${accountId}`)
}
```

被至少 5 处请求头构造读（`kiroApi.ts:1761/3752/3844/3956/4156`），拼进 `user-agent: KiroIDE-<ver>-<machineId>` 与 `x-amz-user-agent`。

- 「改本机系统机器码」→ **语义失效且危险**。服务器的 `/etc/machine-id` 与 Kiro 账号防关联毫无关系（反代请求头用的是**账号绑定值**，不读系统机器码）；改它会影响 systemd/dbus。属 §0.17 **D 类，明确不做**。
- 「逐账号绑定 machineId」→ **A 类必需**，直接决定出网指纹。

处置建议：服务器形态下 `MachineIdPage` **只保留逐账号绑定那一半**（查看/随机生成/手工填/清空），系统机器码整块去掉。注意 fallback 链已能在无绑定时自愈（`generateStableMachineId`），所以面板不提供绑定入口不会崩——但会失去「换指纹」这个手段，账号被关联后无从补救。

### B.4 `kproxy` MITM 代理 —— 需重定义（**两个身份，只有一个失效**）

- 身份一（MITM 服务器）：`mitmProxy.ts:14-17` 用 `MACHINE_ID_REGEX = /[a-f0-9]{64}/gi` + `KIRO_UA_REGEX` 拦流量，替换请求头/body 里的 machineId。前提是**有客户端把它设为 HTTP 代理**——桌面场景下那个客户端是本机 Kiro IDE。
- 身份二（deviceId 映射表 + 反代出网通道）：`kiroApi.ts:170-175`（`useKProxyForApi` 时反代自己的调用走 kproxy）、`kiroApi.ts:1748-1751`（读 `getDeviceIdForAccount`）、`proxyServer.ts:1628/1651-1669`（切号时 `syncKProxyDeviceId` → `switchToAccount` / `addDeviceIdMapping` / `setDeviceId`）。

身份一在服务器上**失效**（没有 IDE 把流量指向它）；身份二**仍在被反代主路径读**。

处置建议：**保留服务、重定义 UI**。`KProxyPage` 不再是「给 IDE 用的代理」，而是「账号↔deviceId 映射表 + 反代是否经它出网」的配置页。未验证点见 §D.1。

### B.5 托盘 / 开机自启 —— 托盘去掉，自启换机制

事实：`index.ts:110-118` 导入 `createTray/destroyTray/updateTrayMenu/setTrayTooltip/updateTrayLanguage`；`index.ts:2631/2692/2715` 是 traySettings 加载/保存/初始化；`index.ts:486-490` 有 `debouncedUpdateTrayMenu`。**值得注意**：`panelProxyDeps.ts:58-59` 有一条依赖——「托盘菜单状态刷新（桌面端启停后会做，面板启停也要做，否则托盘显示与实际不符）」，即面板反代启停当前会回调托盘更新；它已声明为可选（`updateTrayMenu?:`），设计上无头安全。

托盘 = 桌面 shell 概念，Linux 无桌面上 `Tray` 构造会失败或静默无效。开机自启：本轮 grep `setLoginItemSettings\|openAtLogin` 在 `src/main` **零命中**（见 §D.2），服务器形态的正确答案是 **systemd unit**（`Restart=always`），不是应用内自启开关。

处置建议：无头启动时不 `initTray`，`updateTrayMenu` 依赖点保持可选注入；7×24 存活交给 systemd，应用内不做进程守护。

---

## C. 面板功能覆盖差距（页面级）

面板现有 API 全量（`routes.ts` 实测）：`GET /api/accounts`、`POST /api/accounts`（导入 ksk_）、`POST /api/local/logout`、`GET /api/proxy/status`、`POST /api/proxy/{start,stop,sync-pool,active-account}`、每账号 `POST {check,refresh-token,switch,switch-cli}` / `GET {models,subscriptions,subscription-url}` / `POST overage`。前端 4 个 UI 组件：`LoginScreen` / `AccountCard` / `ImportPanel` / `ProxyPanel`。

判据 = 用户能不能完成日常工作，不是功能对称。

### 必需（缺了服务器形态无法日常运作）

| # | 差距 | 现状证据 | 为什么必需 |
|---|---|---|---|
| C1 | **反代配置编辑**（端口 / API Key / 模型映射 / agent 模式 / 日志开关） | `routes.ts:362-370` 明写「都留在桌面端…从手机误触的代价远大于收益」；IPC 侧 `index.ts:5893 proxy-update-config` | 服务器上桌面端不存在。API Key 是客户端接入凭据，端口要避让、模型映射随上游变。**没有任何入口 = 反代装上就改不了** |
| C2 | **账号删除 / 编辑** | 面板只有 list + import，无 DELETE / PATCH | 账号会封、会过期、会重复。只能加不能删 → 死号越堆越多，`sync-pool` 每次都带上它们 |
| C3 | **代理池管理** | `git grep proxyPool -- src/main/webPanel` **零命中** | 出口代理是防关联运行时依赖，代理会失效需要换。桌面 `ProxyPoolPage` 是唯一入口 |
| C4 | **日志查看** | 面板无日志端点 | 无桌面 = 无 GUI 日志。反代 429/挂起/断流全靠日志定位。可退化为 `journalctl`，但那要求 SSH，与「面板运维」形态矛盾 |
| C5 | **自动刷新 / 自动换号的调度与阈值** | 主进程只搬了 token 刷新一半（`index.ts:2619` `mainPoolRefreshTimer` 60s）；`checkAndAutoSwitch` / `autoSwitchEnabled` 阈值判定仍在 renderer store（`accounts.ts:3084-3086`、`:2488`、`:3054`） | **最隐蔽的一条**：无头下 renderer 不存在，token 刷新那半还在跑，但「余额低自动换号」「信息同步」整块不再执行。`index.ts:2443` 注释自己写明「渲染进程定时器保留做信息同步/自动换号」。不搬 = 静默失能，表面无报错 |
| C6 | **adminKey 修改 / 面板监听配置** | 在 `SettingsPage` / `WebPanelCard`（桌面） | 首次部署要设 key，泄露要换 key。没入口 = 只能改配置文件重启 |

**C1 的追问「必需项还是有别的办法」：是必需项，但不必然是面板 UI。** 三条路——① 面板加配置页（一致性最好，但 `routes.ts:362-370` 的顾虑真实存在：`proxy-update-config` 有 steering 重载 / agent 模式 / payload 上限等副作用分支）；② 配置文件 + 重启（`panelProxyDeps.ts:107-110` 已有 `persistProxyConfig` 落 store，盘上有真源，人工编辑可行，但 7×24 下「改配置=重启断服」代价高）；③ 面板只暴露**低副作用子集**（端口 / API Key / 日志开关），高副作用项（模型映射 / agent 模式 / payload 上限）留配置文件 + 重启。**建议 ③** —— 同时尊重原注释的顾虑与服务器形态的刚需。属产品决策，交主 AI / 用户裁决。

### 可延后

| # | 差距 | 为什么可延后 |
|---|---|---|
| C7 | Webhook 管理 | 告警是增益不是刚需，可先靠日志。但 7×24 无人值守下优先级比桌面时代**更高**，不建议延太久 |
| C8 | 批量订阅编排 | 底层端点面板已有，逐个操作能完成工作，只是慢 |
| C9 | 配置同步导出/导入 | 备份可直接拷服务器上的 `accountData`，不必经 UI |
| C10 | 一键诊断 | 排障加速器；`GET /api/proxy/status` + `POST check` 已能手工完成等价判断 |
| C11 | 账号分组 / 标签 | 组织手段，不阻断日常操作 |
| C12 | 主页总览重定义 | `ProxyPanel` 已能看到 running / 端口 / 池大小 / 当前账号 |

### 架构级提示（§0.18A 信号 5）

C5 暴露的不是「面板缺个页面」，而是**调度逻辑的真源分裂**：token 刷新已搬主进程（`index.ts:2439-2443` 有明确迁移注释），自动换号 / 信息同步留在 renderer。桌面形态下这是「两边协同 + `poolRefreshInFlightIds` 去重」的合理设计；无头形态下 renderer 缺席，同一份职责变成「一半在跑一半不在」。

**建议实施顺序：先决定所有池调度统一收口到主进程，再谈面板 UI。** 若先做 UI 后搬调度，面板会显示「自动换号已开启」而实际不执行——绿灯假象，最难自查的一类。

---

## D. 未覆盖 / 待确认（工具预算受限，如实标注）

1. **`useKProxyForApi` 的设置入口未定位**。只找到 `kiroApi.ts:35 setUseKProxyForApiInProxy`，未查调用方，因此「反代经 kproxy 出网」这条路在服务器形态下是否可用、由谁开启，未验证。
2. **开机自启机制未确认**。`git grep "setLoginItemSettings\|openAtLogin" -- src/main` 零命中，可能未实现或用了 electron-builder 的安装期机制。B.5 关于自启的判定基于「未找到应用内实现」，不是「已确认不存在」。
3. **页面实现未逐个读**（按任务约束）。A 表「需重定义」页的内部混装比例（如 `SettingsPage` 多少项属渲染层、多少属服务器必需）只做抽样判断，未逐项清点。
4. **`DiagnosePage` 诊断项清单未读**，A 表第 11 行「混了两类」是基于页面命名与同类惯例的推断，待确认。
5. **面板前端 4 个 UI 组件的能力边界未逐个读**，C 表差距以 `routes.ts` 的 API 面反推（API 不存在 → UI 必然不能做，此方向可靠；反向「API 存在但 UI 未接」未核查）。
6. **`HomePage` / `AboutPage` / `WebPanelCard` 未读**，判定基于命名与 i18n 文案（`zh.ts` home 段）。
