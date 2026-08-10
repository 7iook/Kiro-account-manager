# ADR-0002: 抽取不依赖 Electron 的共享内核(Shared Kernel)

- **Status**: Proposed (2026-08-10 · 决策卡两轮异构评审已处置 15 条，待用户裁决是否开工)
- **Date**: 2026-08-10
- **Deciders**: 项目所有者(宿主选型由其裁决) · 反代/账号服务/面板各层维护者
- **Related**: `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md`(Boundary Decision Card) · 同目录 `eval-rust-candidates.md` / `eval-node-go-candidates.md` / `eval-manager-lite.md` / `inventory-our-proxy-edge.md`(四份候选评估与独特能力盘点) · `decision-card.review1.codex.md` / `review2.codex.md`(两轮评审)
- **Scope**: 全仓分层边界 · `src/main/proxy` + `src/main/accountService` + `src/main/webPanel`(内核) vs `src/main/index.ts`(桌面壳) + 新建 Node 服务端壳

---

## Context

用户诉求："不依赖我的电脑一直开机" —— 账号池、反代、管理面板要能在一台 Linux 服务器上
7×24 自治运行，手机上能管账号；同时**保留本项目在反代上积累的全部优化**(用户原话
"我保留我们这个对反代的一些优化")。

现状阻碍：这些能力都跑在 Electron 主进程内，与 `index.ts`(6634 行、含一百多个桌面专属
IPC handler)的组装图绑在一起。但**业务层本身几乎不碰 Electron** —— 实测 `src/main/proxy`
27 个文件里仅 `logger.ts:4` 一处 `import { app }`，`accountService/` 与 `webPanel/`
零命中(后者的 `auth.ts:23` 注释明写"持久化端口，由 index.ts 注入"、`webPanelAssetRoot.ts`
头部写"让本函数在纯 node 下可直接调用，不需要 mock electron" —— 前人已按此方向铺路)。

因此这不是"移植"而是"把已经解耦的部分正式分层"。以下三条决策**不易逆转**：feature flag
能回退运行形态(桌面 vs 服务端)，但撤不掉依赖方向、端口抽象与数据模型的语义。故以 ADR 记录。

---

## Decision 1 · 抽取共享内核，而非无头 Electron，也不换宿主

**选定**：内核(零 electron) + 两层薄壳(Electron 桌面壳 / Node 服务端壳)，两端注入不同的
运行时端口实现。

**排除无头 Electron**：`electron/electron#38126`("enable new headless mode")于
2025-11-26 被维护者以"maintainers do not have the capacity"关闭；`#29164` 判重关闭。
该选项**在上游不存在**，只剩 xvfb workaround，而 Electron 已 Wayland-native、X11 正从
GNOME/KDE 移除 —— 其运维面只会越来越窄。同类项目的部署文档亦把 "Node-only daemon,
no Xvfb" 列为生产 VPS 推荐，headless Electron 排最后并注明需 Electron 运行时依赖 + Xvfb。

**排除换宿主**(用户裁决 2026-08-10，四份候选评估为依据)：

| 候选 | 关键事实 | 排除理由 |
|---|---|---|
| `E:\kiro.rs` | 与 `kiro.rs-admin` 共享根提交，落后 54 个提交 | 选它等于主动丢弃已合并的 54 个提交 |
| `F:\kiro.rs-admin` | 最新、功能面最全、Docker 即用 | **无请求挂起**(凭据全灭时"重置失败计数、重新启用全部凭据"，注释写"等价于重启" —— 缺挂起能力的粗暴补偿)；额度未参与选号；无会话粘性 |
| `F:\kiro-rs` | 单提交 squash 快照 | 无法考古、无法跟上游；且**明确反向设计**：凭据全冷却时直接返 429 |
| `F:\Kiro-Go-main` | **已有更精细的挂起门闸**(六分钟预算/20s 单次上限/full jitter/兄弟号优先轮换，注释带 922 次 429 实测)，额度已参与候选筛选 | 管理台鉴权仅单层 key **且无 key 时放行**；无 git 历史；TypeScript 全重写 |
| `F:\kiro-manager-lite` | 接口层同源后代(Vue 重写) | 服务器化处境**比本项目更差**：网关是单 key 透传代理而非调度器 |

**决定性判据**：行业对重写的例外条件是"迁移到全新技术是获得所需功能的必要手段" ——
本例**不成立**(Node 在服务器上与 Go/Rust 无差别，拦路的只是装配层)。而重写案例中最常
丢失的正是"来之不易的教训"，而本项目价值恰在此：429 与 402 的语义分离(实测单账号 471
请求/147 次 429，其中 146 次即 99.3% 在 60s 内同号就有 200 成功 → 429 不是额度信号)、
EU 端点矩阵(EU 非 200 率 41% vs US 1%)、prompt cache 保真(注入时间戳致缓存 100% miss，
credits 2.5-3.0→0.5-0.7，修法是删三行)、快速重试(Kiro 是概率式限流，密集重试穿透率
高于指数退避 —— 与教科书相反)。**这些在新代码里看不出来，只有踩一遍才知道。**

**代价与可逆性**：内核已就绪故成本集中在装配层重写(非搬运)；最集中的耦合点是 13 处
`app.getPath`，也是最易一次收口处 —— 但路径写错等于账号数据丢失，是主要回归风险。
可逆性：分层本身不可逆(改回单体等于放弃服务端形态)，但**运行形态可逆** —— 桌面端继续
可用，且停止条件命中时有降级路径(仅抽反代，满足"关机后反代仍在"但不满足"手机管账号")。

---

## Decision 2 · 依赖方向由编译期强制，而非约定

**选定**：内核层不得 import electron，由**独立 tsconfig(`"types": []`) + lint
`no-restricted-imports`** 强制，并需**证伪验证**(故意在内核层加一行 import，确认构建
真的失败)。

**为什么不靠注释**：本项目已经在靠注释(`auth.ts:23`、`webPanelAssetRoot.ts` 头部)，
而注释挡不住下一个人。外部同类项目正是用编译期规则实现这条(独立 tsconfig 限制 path
alias + ESLint 禁止 core 层引入 electron/react/DB 驱动)。

**已知检索陷阱(必须写进门禁)**：耦合面是 **13 个文件而非 11 个** —— `git grep
"from 'electron'"` 只匹配 ESM 形态，漏掉两个用 CJS `require('electron')` 的主链路
承重文件(`proxy/proxyServer.ts:648/668/680` 取 userData 给自签证书、
`registration/registrar.ts:314`)。门禁扫描须**同时覆盖 ESM / CJS / 动态 import 三形态**。

**必须先断的一条穿透链**：`accountService/verify.ts:19-24 → proxy/kiroApi.ts:19 →
proxy/logger.ts:4 import { app }`。是**值导入非类型导入**，故纯 Node 下在**加载阶段**
即抛。`logger.ts` 只用 2 个 electron 符号且都在方法体内 → 换注入即断链，是性价比最高
的一刀。

---

## Decision 3 · 数据模型：两端各自独立副本，不共享不同步

**选定**：服务器与本地各持独立数据副本；初始数据靠**一次性人工复制**(原始
`kiro-accounts.json` 直拷)；迁移后双向变更**不合并**。

**为什么不共享同一份**：`electron-store` 是本地 JSON，跨机器共享需要网络文件系统或
数据库 —— 那等于自造分布式存储。而**已核实的并发风险**：`accountService/state.ts:124-179`
的锁注释自证是"**进程内**串行锁"(防"定时器与 IPC 在同一 tick 交错读改写")，revision
仲裁是应用层的**且只在调用方显式传 `expectedRevision` 时启用**，而主进程侧的权威写入
(如 token 刷新)刻意不传。故两个独立进程各持自己的锁、互不可见 → 后写者整体覆盖先写者。

**同机双开的处置**：按数据目录的**单实例锁**，第二个进程明确报"已有实例占用此数据目录"
并退出。这是 Electron / Wails 官方提供的机制(`requestSingleInstanceLock()` / 命名互斥体
+ dbus)。反面教材 `eclipse-theia/theia#10890`：默认未开单实例锁 → 第二进程拿不到数据库
文件锁 → **自己造了一份新的，所有应用级设置被重置**。另注 `electron/electron#33975`：
连官方那把锁在跨用户会话时都出过崩溃 —— 自造跨进程互斥的风险高于采用现成机制。
**故不做**跨进程真互斥锁，也不把桌面端降为只读(后者要逐个判定"哪些算写"，token 自动
刷新在定时器里也是写，改动面大且易遗漏)。

**服务器形态下此锁等于不存在** —— 只有一个进程，锁永远拿得到。

---

## Consequences

**正面**：TypeScript 全保留(测试、事故知识、注释里的 why 全部随代码走)；面板鉴权
(无密钥拒绝放行 / 外部绑定+无密钥拒绝启动 / 轮换即失效全部会话 / CSRF 双防 / 登录限流
用失败计数+指数退避锁定)已强于所有候选，无需重建；桌面端形态不受影响。

**负面 / 需持续承担**：
- 装配层需重写而非搬运，`index.ts` 里一百多个桌面专属 IPC 要逐个判去留。
- 六个运行时端口成为长期契约面，新增桌面能力时需判断是否入端口。
- **不提供 HTTPS 开箱能力** —— 面板经公网访问必须前置 TLS 终止；adminKey 在明文 HTTP 上
  传输等于公开。此项必须写进部署文档。
- **主数据加密是混淆不是安全**(`encryptionKey` 硬编码在源码内)。服务器上真正的保护层是
  文件系统权限。迁移不改变这一点(改了老数据读不开)；若要真加密，正路是自管密钥，属独立议题。
- 服务端**不使用 keyring**(`safeStorage` 是 Electron API)，备份加密密钥来自环境变量；
  未设置且用户未显式接受明文时**拒绝生成备份**，而非静默写明文。

**验证边界(诚实标注)**：Linux 上 keyring 行为、服务器时区/locale 对时间戳的影响、
长跑内存基准均**只能实跑确认**(外部先例未给内存基准，不编造数字)。

---

## Alternatives Considered

1. **无头 Electron** —— 上游提案已关闭，仅剩 xvfb workaround。排除，理由见 Decision 1。
2. **换宿主(Kiro-Go / kiro.rs-admin)** —— 用户裁决排除；四份评估为依据。Kiro-Go 的
   429 耐受机制与我方挂起门闸经核实为**相邻而非同一**(我方池级：零账号可用才触发，且判据
   明确不认 429 那类瞬时退避 → 429 风暴永远打不开我方门闸；它是请求级：本账号被限流且无
   兄弟号就绪才等)。其"429 总耐受预算"概念已采纳但列为**独立后续**，其 1s→20s 几何退避
   **拒绝**(我方有相反实地证据)。
3. **仅抽反代**(降级路径) —— 反代是纠缠度最低的一层，成本远低于全量，但不满足"手机管账号"。
   保留为停止条件命中时的退路。
4. **桌面端降为只读 + 允许双开** —— 排除：需逐个判定"哪些算写"，token 自动刷新在定时器里
   也是写，改动面大且易遗漏。
