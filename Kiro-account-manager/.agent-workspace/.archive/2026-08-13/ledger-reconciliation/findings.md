# 2026-08-13 台账对账与下一阶段任务

## 0. 结论摘要

- 对账基线：`main` 的 `d8f957e`；工作区另有 4 个已跟踪文件的未提交改动，内容为“服务端自动启动前预热账号池 + 架构门禁扩展”。这批改动是 **in-flight / unreviewed / uncommitted**，本报告不把它算进 `d8f957e` 的完成态。
- 服务器化骨架已经真实存在：Node 入口、零 Electron 生产依赖、持久化端口、管理面板、服务端 token 刷新和构建产物都已落地。它已超过“设计稿”阶段。
- 但批准的最终成功状态仍未达到。主要缺口是：无可复现的生产部署/进程托管交付；面板 C1～C4、C6 未实现；桌面 renderer 中的 C5 自动换号尚未迁入服务端；默认 480s 自动放行与 200s Layer C 首块超时冲突尚未修复。
- `feat/hold-gate-auto-release` 已并入 `main`：`git log main..feat/hold-gate-auto-release` 为空，反向日志显示其提交已在 main 历史内。`feat/proxy-context-safety-net` 也已并入；但注册在 detached `4d60c44` 的隔离 worktree 仍有 6 个文件、536 行新增/17 行删除的未提交独有改动。
- 明确回答：**今天不能让普通用户从一台全新的 Linux 机器，仅按仓库现有交付物稳定达到批准的成功状态。** 第一道阻塞是没有生产安装/配置/进程托管/TLS 前置/升级回滚的可执行交付合同；即使人工拼装运行，`d8f957e` 的服务端自动启动仍未在启动前预热账号池，且面板与无头自动换号能力不完整。

## 1. 对账口径

- `DONE`：当前代码存在可定位实现或通过的针对性测试；仅有提交说明不算。
- `PARTIAL`：骨架或底层能力已存在，但台账描述的用户可见结果尚未闭环。
- `NOT-STARTED`：当前生产代码没有实现该项目标。
- `OBSOLETE`：目标或原方案已被明确移除/替代。
- `BLOCKED`：需要产品决策或外部事实，工程不能自行定案。
- 源码行号以当前工作区为准；对未提交文件会明确标注，不能作为 `d8f957e` 的完成证据。

## 2. Deliverable 1：K-1～K-11 对账

| id | 一句话描述 | 状态 | 证据锚点 | 还剩什么 |
|---|---|---|---|---|
| K-1 | 切断共享内核的 Electron 穿透链 | DONE | `src/main/proxy/logger.ts:1-31` 不再导入 Electron；`src/main/upstream/` 承载共享上游能力；`test/main/architecture/kernel_without_electron.test.ts:32-118` 构建依赖图并拒绝 Electron 依赖 | 无；继续保留架构门禁 |
| K-2 | 把 `app.getPath/isPackaged/getVersion` 等运行时能力抽成端口 | DONE | `src/main/runtime/capabilities.ts:1-76` 定义运行时能力；`src/main/server/runtime.ts:1-84` 提供 Node 实现；`src/main/server/assembly.ts` 注入实现 | 新增共享模块时必须继续走端口 |
| K-3 | 抽取持久化端口并保持原 encryptionKey/数据兼容 | DONE | `src/main/accountService/storage.ts:28-199` 的 `AccountStorePort`/注入入口；`src/main/server/accountStore.ts:1-196` 的 Conf 适配；`src/main/server/entry.ts:97-152` 四态失败处理 | 生产迁移、备份、恢复流程仍属于 K-10 |
| K-4 | 编译期强制共享内核不接触 Electron | DONE | `test/main/architecture/kernel_without_electron.test.ts:32-118` 的真实模块图门禁；`vite.server.config.ts:10-43` 的 server build Electron import gate | 台账原定“独立 tsconfig `types:[]` + lint”方案已被证伪后替换；ambient `Electron.*` 的额外静态检查可继续增强，但不影响当前目标完成 |
| K-5 | 建立纯 Node 服务入口和装配图 | DONE | `src/main/server/entry.ts:1-270`；`src/main/server/assembly.ts:1-247`；`package.json` 的 `start:server` | 自动启动前池预热修复仍只是未提交工作区改动，需评审后另行合入 |
| K-6 | 产出 server 与 webPanel 构建物并保持相对路径 | DONE | `vite.server.config.ts:26-57` 输出 `out/server`；`vite.webPanel.config.ts:7-29` 输出 `out/webPanel`；`src/main/server/entry.ts` 使用 web panel asset root | 尚缺可发布生产包/镜像及其校验、版本和升级策略 |
| K-7 | 桌面专属、服务端语义失效功能只做不可达 | DONE | `src/main/server/assembly.ts` 仅装配服务端所需 account/proxy/panel 依赖；server 入口不加载 tray、BrowserWindow、safeStorage、IDE watcher | 后续文档要列清哪些桌面行为在服务端有替代、哪些明确不存在 |
| K-8 | 原占位项 | OBSOLETE | `HANDOVER-2026-08-10.md:169` 明确“K-8 已移除——不可验收的占位” | 无 |
| K-9 | 面板补 C1～C4 + C6；C5 另行依赖 #10 | NOT-STARTED | `src/main/webPanel/routes.ts:245-508` 当前仅有列表、API key 导入、check/refresh/switch、proxy start/stop/sync/release；`src/webPanel/api/panel.ts:97-181` 同样无 C1～C4/C6 API | 实现账号新增/编辑/删除、文件导入、分组/标签/权重、备份恢复等已裁决能力；精确名称见原 decision card |
| K-10 | 运营注册 8 项 | PARTIAL | `src/main/server/entry.ts:43-88` 有稳定退出码；`src/main/server/adminKeyStore.ts:79-171` 有 0600 adminKey；`src/main/webPanel/server.ts:67-93` 有 health/鉴权基础；仓库中无 systemd/容器/生产安装/备份恢复交付物 | 补齐进程托管、日志、存活/就绪、TLS 前置、首次密钥引导、数据目录权限、备份恢复、升级回滚；并落实数据目录单实例锁 |
| K-11 | ADR 落盘 | DONE | `docs/architecture/ADR-0002-shared-kernel-extraction.md:1-181` | ADR 头部仍为 Proposed，应在实现验收后更新状态和实现偏差 |

## 3. Deliverable 1：39 项台账中的待办项对账

台账此前已标记完成的其余 24 项不在本次“剩余项”枚举中；以下覆盖用户指定的 15 项。

| id | 一句话描述 | 状态 | 证据锚点 | 还剩什么 |
|---|---|---|---|---|
| #32 | 抽共享内核，作为服务器化主体 | DONE | `src/main/accountService/`、`src/main/upstream/`、`src/main/proxy/` 已被 Node 与 Electron 两个 shell 共享；`test/main/architecture/kernel_without_electron.test.ts:32-118` 验证依赖方向 | 面板和运营缺口应记到 #34/#35/K-10，而不是重新扩张 #32 |
| #33 | 加强登录安全，范围待用户定 | BLOCKED | 当前基线见 `src/main/webPanel/server.ts:95-153` 的 Bearer adminKey、`src/main/server/adminKeyStore.ts:79-171` 的权限/引导；ADR `docs/architecture/ADR-0002-shared-kernel-extraction.md:112-139` 规定 TLS 外置 | **产品决策**：是否只保留单 adminKey，还是需要多用户/会话/撤销/审计/速率限制；工程不能替用户扩 scope |
| #34 | 面板补六项必需能力 | PARTIAL | 面板基础、账号 check/refresh/switch 和 proxy 操作存在：`src/main/webPanel/routes.ts:245-508`；但 C1～C4、C6 的路由/前端 API 不存在，C5 仍在 renderer：`src/renderer/src/store/accounts.ts:686-784` | 完成 K-9；先完成 #10 才能交付无头 C5 |
| #35 | 面板开放裁决后的低风险配置 | NOT-STARTED | `src/main/webPanel/routes.ts:362-419` 的 proxy start 只启动，不接收配置；`src/webPanel/api/panel.ts:150-156` 明确 startProxy 无参数 | 实现配置 schema、白名单、校验、持久化、敏感字段遮蔽和变更审计 |
| #10 | 把换号决策迁到主进程并同时停 renderer 定时器 | NOT-STARTED | `src/renderer/src/store/accounts.ts:686-784` 仍持有 `checkAndAutoSwitch` 和阈值逻辑；server 入口没有对应调度器 | 同一变更中实现服务端唯一调度器并移除 renderer 定时器，避免双调度窗口 |
| #16 | 独立低额度谓词与候选排序，不污染 `isQuotaExhausted` | NOT-STARTED | `src/main/proxy/accountPool.ts:245-378` 的可用性/配额判断仍未提供台账要求的独立 low-quota 排序谓词 | 设计并测试排序；不得改写门闸的额度耗尽 SSOT |
| #20 | 池准入与 transient error/expired 状态解耦 | DONE | `src/main/proxy/activation.ts:47-121` 只拒绝后端封禁信号；`test/main/proxy/poolAdmission.test.ts:8-72` 覆盖 timeout/DNS/expired 仍入池、封禁仍排除 | 无 |
| #26 | 区分临时和永久封禁原因 | NOT-STARTED | `src/main/proxy/types.ts:460-465` 只有一组 `suspendedAt/reason/message`；`src/main/proxy/accountPool.ts:382-385` 只看 suspendedAt，不看临时/永久 | 建模临时、永久、可自动恢复、需人工恢复的不同状态和迁移 |
| #27 | 面板暴露解除封禁操作 | NOT-STARTED | `src/main/proxy/accountPool.ts` 已有 `clearSuspended` 底层能力；`src/main/webPanel/routes.ts:245-508` 无对应 route | 增加鉴权 API、确认交互、持久化和审计；依赖 #26 的语义 |
| #30 | 收敛四份已漂移的封禁关键词 | NOT-STARTED | 当前至少仍见 `src/main/proxy/activation.ts:47-90`、`src/renderer/src/components/accounts/AccountCard.tsx:356-386`、`src/renderer/src/components/accounts/_helpers.ts:158-175`、`src/renderer/src/components/proxy/AccountSelectDialog.tsx:70-108`、`src/webPanel/ui/format.ts:45-73`；集合不一致 | 建立共享分类器或后端输出结构化状态，删除 UI 字符串判定副本，并补契约测试 |
| #31 | 核实账号 id 是否可能跨账号复用 | NOT-STARTED | `src/main/server/accountStore.ts`/account persistence 仍以 id 合并；仓库内没有上游唯一性证明或碰撞测试 | 需要上游文档或实测样本；验证前不得把 id 当永久自然键作破坏性合并 |
| #36 | 解决 auto-release 与 Layer C 首块超时冲突 | NOT-STARTED | `src/main/proxy/holdConfig.ts:7-22,82-101` 默认 480000ms，只按假定 200000ms×0.75 告警；`src/main/proxy/streamWatchdog.ts:25-31` 从 `KIRO_STREAM_FIRST_CHUNK_TIMEOUT_MS` 读取真实默认 200000ms；无 clamp/共享配置/禁用关系 | **P0**：默认 480s > 150s，held request 可先被 Layer C 杀死。必须统一时间源并选定 clamp、暂停 watchdog 或缩短 release 的一种语义 |
| #37 | 引入 429 总耐受预算，但拒绝候选项目退避曲线 | NOT-STARTED | `src/main/proxy/proxyServer.ts`/`kiroApi.ts` 仍按现有 per-attempt/per-account 重试，没有跨请求或总耐受预算对象 | 定义预算边界、消耗/恢复、观测指标，并保持快速重试策略 |
| #38 | 状态码提取增加检索门禁，防止数字误判为 HTTP code | NOT-STARTED | 当前有状态优先分类，但架构测试中没有针对裸 `/(\d{3})/` 或“新增状态码提取器必须使用锚定 helper”的检索门禁 | 提取唯一 status parser，并加源码扫描/变异测试，覆盖 `Payload size: 402913` 不得判 402 |
| #39 | 核实 429 是否抬高 errorCount 退避基数 | DONE | `src/main/proxy/accountPool.ts:544-588` 的 `recordError` 对非 402（包括 429）递增 errorCount/冷却；注释明确 429 不是额度耗尽 | 这是“核实完成”，不是“行为正确”裁决；是否让 429 影响基数应与 #37 一并作产品/算法决策 |

### 两个分支的合并事实

- `feat/hold-gate-auto-release`：`git log main..feat/hold-gate-auto-release --oneline` 为空；反向范围有 `7c63d4c` 等提交，因此功能已进入 main，#36 **不是 moot，而是当前生产默认值上的紧急冲突**。
- `feat/proxy-context-safety-net`：同样已被 main 包含，D3 主线能力已合入。隔离 worktree 的未提交差异不是分支合并状态，而是另一批尚未恢复/评审的增强。

## 4. Deliverable 2：距批准成功状态还差哪些 hop

| 顺序 | 缺口 | 消费者 | 类型 | 当前影响 |
|---|---|---|---|---|
| 1 | 可发布生产物和从零安装合同：支持的 Node 版本、构建机/目标机步骤、prod dependencies、版本标识、校验 | Linux 运维者/发布流水线 | build + docs | 目前有 `out/server`，没有“拿什么文件去服务器、怎样安装且可重复”的交付 |
| 2 | systemd/容器进程托管、自动重启、开机启动、优雅停止 | Linux init/容器运行时 | ops | 用户关机后当前机器上的手工 `npm start` 不是可靠常驻服务 |
| 3 | 数据迁移 runbook：定位桌面数据、复制 `kiro-accounts.json`/相关 config、权限/owner、解密验证、失败回退 | 运维者、AccountStore | ops + docs | 底层格式兼容不等于用户能安全迁移 |
| 4 | 数据目录单实例锁 | server process/桌面双开 | runtime | ADR 要求存在；当前只有进程内写锁，两个进程可并发写同一副本 |
| 5 | TLS 前置反代示例、默认 loopback、转发头信任规则、防火墙和公网暴露说明 | nginx/Caddy、手机浏览器、API 客户端 | ops + security docs | adminKey 通过明文公网 HTTP 会泄露；项目按设计不内置 TLS |
| 6 | 首次 adminKey 引导的实际操作、密钥保管/轮换/灾难恢复 | 手机面板用户/运维者 | ops + docs | 代码会生成/校验 0600，但没有完整交付流程 |
| 7 | 将未提交的 server autostart pool hydration 修复评审并合入 | server entry/proxy pool | runtime | `d8f957e` 自动启动时 pool 初始为空，只能等首次请求触发 lazy `onPoolEmpty` |
| 8 | 解决 #36 的 480s/200s 时序冲突 | held request、stream watchdog | runtime | 在默认设置下，自动放行对某些 held request 来不及生效 |
| 9 | 面板 C1～C4、C6 | 手机管理员 | runtime/product | 手机无法完成已批准的完整账号生命周期与管理能力 |
| 10 | #10：无头 C5 自动换号和唯一调度器 | server runtime | runtime | 用户关掉电脑后 renderer 定时器消失，低额度阈值自动换号行为随之丢失 |
| 11 | #35 低风险配置面板与初始化路径 | 手机管理员/运维者 | runtime + product | fresh server 无法从手机完成裁决范围内的代理配置；只能预制数据或手工改配置 |
| 12 | #26/#27/#30 封禁状态统一与无头解除 | 手机管理员/account pool | runtime | 无头环境遇到误封/临时封禁时无法可靠辨认和解除 |
| 13 | 服务端长期 token 生命周期验收：刷新后落盘、进程重启再读、长跑/轮换 refreshToken | account store/proxy | runtime test | 单元路径已实现，但缺真实 IdP 长跑与重启验收 |
| 14 | 备份/恢复、升级/回滚、日志轮转、磁盘满/只读故障演练 | 运维者 | ops | “持续服务”目前没有可接管、可恢复保证 |
| 15 | 端到端验收：全新 Linux、导入真实脱敏账号、手机操作、桌面断电、重启主机、实际流式请求 | 产品验收者 | acceptance | 现有测试没有证明整句成功状态 |

### Linux smoke 实际证明了什么

该记录对应较早的 `3adda90`，证明了：

- 在 Linux/Node 环境能够走到 server 启动路径和 Web panel 静态服务；
- POSIX 下 adminKey 0600 和数据失败退出语义可被实测；
- Windows Conf 数据到 Linux Conf 的基本格式兼容可行；
- 同时发现当时的两个真实阻塞：externalized ESM `conf` 的 `Conf is not a constructor`，以及 `npm ci --omit=dev` 时 postinstall 依赖 electron-builder。

后续代码已针对这两点加入 `vite.server.config.ts` 的 Rollup interop 和条件 postinstall，但那份 smoke **没有证明**：

- 当前 `d8f957e` 或当前未提交工作区在一台真正 fresh Linux 上从安装到长跑全链通过；
- systemd/容器、开机恢复、崩溃重启、TLS/公网手机访问；
- 真实账号导入、服务端 token 轮换后持久化并跨重启有效；
- 全部桌面代理行为等价，特别是 C5、#36、#26/#27/#30；
- 升级、回滚、备份恢复、并发双进程保护。

因此它是有价值的组件/环境 smoke，不是最终成功状态验收。

### `src/main/index.ts` 两个桌面启动点的判定

- tray toggle（约 `src/main/index.ts:1875`）和 `proxy-start` IPC（约 `src/main/index.ts:4593`）都直接 `start()`，没有显式预热。
- 当前 `ProxyServer` 的 `onPoolEmpty` lazy loader 让“第一次真实请求到来时再装池”通常能恢复，因此它对**最终能否处理请求**是一个可用 fallback。
- 但它不是严格等价：启动后状态会暂时报告 pool=0，无法在 start 时发现“存储有记录但全部准入失败”，首请求承担加载延迟/失败，运维就绪信号也会误导。
- 结论：fallback 是“功能兜底”，不是“运营/语义充分”。是否统一把桌面两个入口也改为 eager hydration 是 **产品决策**：若要求所有入口一致且 start 即 ready，应改；若保留 lazy 以减少桌面启动开销，需明确状态语义并加首请求测试。

## 5. Deliverable 3：有依赖顺序的下一阶段任务

### Phase 0：先冻结风险与回收现场

1. **P0-1 评审并处置当前未提交 autostart pool batch**  
   依赖：无。  
   文件：`src/main/server/entry.ts`、`src/main/ipc/panelProxyDeps.ts`、`test/main/architecture/kernel_without_electron.test.ts` 及对应测试。  
   与其它任务冲突：会与 K-9 后端 route/deps 接线冲突；应先完成。  
   验收：server autoStart 在 `start()` 前完成 sync；空库、全拒绝、部分准入、加载异常均有测试。

2. **P0-2 解决 #36，并消除“假定常量”**  
   依赖：无，可与 P0-1 并行。  
   文件：`src/main/proxy/holdConfig.ts`、`streamWatchdog.ts`，可能涉及 `proxyServer.ts`/`kiroApi.ts` 和 hold/watchdog 测试。  
   文件冲突：不要与 context-safety worktree 的 `kiroApi.ts`/`proxyServer.ts` 未提交差异并行写。  
   **产品决策**：held 阶段应暂停 Layer C、强制 auto-release 小于安全阈值，还是自动 clamp。建议单一共享 timing policy，不再复制 200s。

3. **P0-3 保存并评审 `proxy-safety-review-isolated` 的未提交工作**  
   依赖：无，可与 P0-1 并行，但不能与 P0-2 同时修改 proxy 核心文件。  
   文件：`index.ts`、`kiroApi.ts`、`proxyServer.ts`、`types.ts`、renderer ProxyPanel、`contextTrimGuard.test.ts`。  
   先导出 patch/归档，再决定拆分、丢弃或合并；当前内容是唯一未恢复工作。

### Phase 1：形成可部署的最小闭环

4. **P1-1 生产发行与 Linux runbook**  
   依赖：P0-1。可与 P0-2 并行，前提是不改 proxy 源码。  
   新文件优先：`deploy/`、`docs/deployment/`、systemd unit/容器文件、发布脚本；可能改 `package.json`。  
   验收：全新 Linux VM 仅按文档完成安装、数据目录、adminKey、启动、停止、重启。

5. **P1-2 数据目录单实例锁 + 故障退出语义**  
   依赖：P1-1 定下数据目录。  
   文件：`src/main/server/entry.ts`、server runtime/storage、新 lock 模块及测试。  
   冲突：与任何仍改 `entry.ts` 的 P0-1 串行。

6. **P1-3 TLS 前置、权限、防火墙、密钥与迁移 runbook**  
   依赖：P1-1，可与 P1-2 并行。  
   主要新增 docs/deploy 文件，无需改业务源码。  
   **产品决策**：官方示例选 Caddy、nginx 还是两者；是否正式支持容器。

7. **P1-4 fresh-Linux 自动 smoke**  
   依赖：P1-1～P1-3、P0-2。  
   新增 CI/smoke 脚本，避免改 panel/proxy 核心。  
   验收至少包括：prod install、boot、health、鉴权、pool hydration、proxy request、SIGTERM、restart、数据保留。

### Phase 2：补齐“关掉电脑后行为不丢”

8. **P2-1 #10 服务端唯一自动换号调度器**  
   依赖：产品确认阈值/触发语义。可与 P1 运营工作并行。  
   文件：`src/main/accountService`、`src/main/server/assembly.ts`、`src/renderer/src/store/accounts.ts`；可能触及 activation/accountPool。  
   验收：renderer 定时器与 server 调度器在同一提交完成交接；无双调度窗口；服务端重启恢复。

9. **P2-2 #16 低额度谓词与候选排序**  
   依赖：P2-1 的决策模型。  
   文件：`accountPool.ts`、activation/selection 测试。  
   冲突：与 #37/#39 同属 accountPool 策略，必须串行或单 owner。

10. **P2-3 K-9/#34 面板 C1～C4、C6**  
    依赖：P0-1；C5 依赖 P2-1。  
    文件热点：`src/main/webPanel/routes.ts`、`src/webPanel/api/panel.ts`、`src/webPanel/ui/App.tsx`。  
    不建议按 capability 派多个 agent 同时写这三个单体文件；应一个 owner 串行，或先拆 route/UI 模块再并行。

11. **P2-4 #35 低风险配置**  
    依赖：人类确认最终白名单；可在 K-9 backend API 稳定后开始。  
    文件与 P2-3 高冲突，串行。  
    **产品决策**：可远程改哪些项；端口/bind/adminKey/API key/转发头信任是否一律禁止或需二次确认。

12. **P2-5 #26 → #27 → #30 封禁语义闭环**  
    依赖顺序：先数据模型，再解除 API，最后删除 UI 副本。  
    文件：`types.ts`、`accountPool.ts`、`activation.ts`、web panel routes/UI、renderer UI helpers。  
    与 P2-3/P2-4 的 panel 文件冲突；后端模型部分可先做，UI 接线串行。

### Phase 3：策略债和最终验收

13. **P3-1 #37 + #39：429 总预算与 errorCount 决策**  
    依赖：P0-2 稳定时序；最好在 P2-2 后。  
    文件：`kiroApi.ts`、`proxyServer.ts`、`accountPool.ts`、重试测试。  
    **产品/算法决策**：预算作用域（请求/账号/全局）、恢复窗口、429 是否抬高冷却基数。

14. **P3-2 #38 状态码提取门禁**  
    依赖：无，可与不修改 proxy classifier 的运营任务并行。  
    文件：共享 error classifier/helper、architecture test。  
    若需改 `kiroApi.ts`，不要与 P3-1 并行。

15. **P3-3 #31 账号 id 唯一性取证**  
    依赖：无，纯研究可全程并行。  
    输出：上游合同、实测碰撞矩阵、失败安全迁移建议。  
    `unverified` 直到拿到外部证据。

16. **P3-4 最终 Linux 断电等价验收**  
    依赖：上述产品目标项完成。  
    场景：手机完成账号生命周期和配置；桌面关机；持续流式代理；自动换号；封禁恢复；Linux 主机重启；token 跨轮换；备份恢复/升级回滚。  
    此任务通过前不得宣称批准成功状态已达成。

## 6. Deliverable 4：仓库卫生分类

| 材料 | 分类 | 理由与处置 |
|---|---|---|
| `tmp-interop-probe/` | safe to delete | 针对 `conf` CJS/ESM interop 的一次性实验目录；修复已进入 `vite.server.config.ts`，Linux smoke 也保留了结论。删除前只需确认没有唯一原始测量数据 |
| `tmp-perm-probe.mjs` | safe to delete | adminKey/POSIX mode 一次性探针；生产实现和测试已覆盖 |
| `tmp-orphan-forensics.mjs` | must be archived first | 名称表明它用于孤儿工作取证；脚本本身可能是恢复方法。先与对应输出一起压缩归档，再删工作副本 |
| `.agent-workspace-review-*.json` | must be archived first | 大体积 reviewer 原始输出，通常不属于产品源码，但可能是唯一审查证据。压缩后移到外部/正式 archive，并生成索引和校验值 |
| `wip-copy-2026-08-09*` 各目录 | must be archived first | 是多轮 WIP 快照，不应直接假定已全部被 main 覆盖。抽样 no-index diff 显示旧快照很稀疏且与当前 `streamWatchdog` 等文件不同；应先生成每个快照对 main 的 manifest/diff，再判定是否删除 |
| `proxy-safety-review-isolated/` | must be kept | 它是 git 注册的 detached worktree，HEAD `4d60c44`；当前有 6 个文件未提交差异，`536 insertions / 17 deletions`，涉及 context trim 安全网，属于唯一未恢复工作。必须先导出 patch、评审和决定归属，不能删除目录或 `git worktree remove` |
| `change-report.txt`、`cleanup-report.txt`、`final-response.txt`、`R5-exchange.txt`、`commit10-full-response.txt` 等大 transcript | must be archived first | 它们是过程证据而非运行时资产；可能包含唯一决策/审查上下文。建议压缩、建立来源/日期索引和 hash 后从 repo 工作区移走 |
| `.agent-workspace/.archive/**/findings.md` 等正式侦察结果 | must be kept | 当前仍是决策和缺陷来源；不要与临时 transcript 一起清理 |
| `TASKS-2026-08-13.md` 等新任务汇总 | needs human decision | 若是本次对账的并行草稿，先与本报告去重；若被团队当作活台账则保留并指定唯一 SSOT，避免双台账漂移 |

### worktree 的 uncommitted / unmerged 判定

- `git -C F:/Kiro-account-manager/proxy-safety-review-isolated status --short` 显示 6 个 tracked 文件有修改。
- `git diff --stat`：536 insertions、17 deletions。
- `4d60c44` 本身已在 main 历史/祖先关系中，不是一个待 merge 的提交分支；但上述 working-tree diff **未提交、未合并、未在 main 恢复**，因此必须视为唯一 unrecovered work。

## 7. 未能完全验证的事项

- `unverified`：#31 的账号 id 跨账号唯一性；仓库代码不能证明上游身份系统合同。
- `unverified`：当前 `d8f957e` 在真实 fresh Linux 上的端到端启动，因为本轮遵守只读侦察，没有创建 VM/容器或修改环境；既有 smoke 针对较早提交。
- `unverified`：每个 `wip-copy-2026-08-09*` 是否 100% 已被 main 覆盖；在删除前必须逐快照生成 no-index diff，而不能凭目录名推断。
- `unverified`：未提交 autostart pool batch 的评审结论；按用户说明它由另外两位 reviewer 负责，本报告只记录状态。

