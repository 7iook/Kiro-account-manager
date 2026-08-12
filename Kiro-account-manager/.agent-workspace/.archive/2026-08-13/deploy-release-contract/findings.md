# Headless Node 生产交付合同工作记录

日期：2026-08-13  
Git 基线：`26dfc57`  
代码根：`F:\Kiro-account-manager\Kiro-account-manager`（Git 根下一层）

## 结论

本轮把“源码能构建”推进为一条可执行的 systemd 交付路径：构建机生成带版本、Git 提交和
checksum 的完整发布目录；Linux 目标机只安装生产依赖；systemd 以进程存活监督、在启动时
拉起、SIGTERM 优雅停止并写 journald。readiness 明确只做流量 gating，绝不触发重启。

这仍不是题述最终成功状态的完整验收：真实账号、代理 ready=200、手机公网 TLS、桌面数据
迁移、主机重启和升级回滚演练均未执行。

## 创建/修改

- `package.json`
  - 新增 `release:server`：先 `build:server`，再组装发布目录。
- `scripts/package-server-release.mjs`
  - 产出 `out/release/kiro-account-manager-server-v<version>/`；
  - 包含 server、webPanel、锁文件、生产 postinstall、systemd 文件；
  - 写 `RELEASE.json`（版本/commit/dirty/Node engines）和 `SHA256SUMS`；
  - 已存在同名目录时拒绝覆盖，避免无声替换旧制品。
- `deploy/systemd/kiro-account-manager.service`
  - start-on-boot、进程 liveness restart、10 秒退避和 StartLimit；
  - 永久配置错误 64/65/73/78 不重启，69 保持运行时故障可重启；
  - 不使用 readyz 决定重启；
  - `TimeoutStopSec=30s`，覆盖 10 秒凭据写入 drain；
  - stdout/stderr 进入 journald。
- `deploy/systemd/server.env.example`
  - loopback 默认、安全的 adminKey 和日志说明。
- `docs/deployment/linux-systemd.md`
  - Node 版本、构建机/目标机分工、完整 fresh-box 命令、每步验证、版本识别；
  - 首次密钥生成/轮换、退出码、更新/回滚边界；
  - 明确不正式支持容器，避免维护第二条未验证路径。
- `docs/deployment/verification.md`
  - 真执行证据与 `unverified:` 清单。
- `test/main/architecture/server_delivery_contract.test.ts`
  - 锁 npm 脚本、制品内容、systemd 退出码、readiness/liveness 分离、停止窗口、
    loopback 默认和文档关键合同。

未编辑 `src/main/server/entry.ts` 或其他 `src/**`。

## 真执行

1. `npm run release:server`
   - 第一次在组装阶段发现 `createHash` 导入错误，EXIT=1；
   - 修正后 EXIT=0；
   - server 720.15 kB，source map 1,849.16 kB，webPanel 构建成功；
   - 本轮真实生成 release 目录、`RELEASE.json`、`SHA256SUMS`。
2. Linux Docker `node:22.20.0-bookworm`
   - `sha256sum -c SHA256SUMS`：全部 OK；
   - 空 `/work` 执行 `npm ci --omit=dev`：EXIT=0，安装 110 packages；
   - postinstall 明确走服务端跳过分支；
   - `node_modules/electron` 不存在；
   - 空数据目录启动，面板监听 `127.0.0.1:5590`；
   - `/panel/readyz` 返回 `503 {"status":"not_ready"}`（默认反代未启用）；
   - `kill -TERM` 后日志出现“收到 SIGTERM，开始停机”和“已停机”，退出码 0。
3. Debian bookworm 容器中 `systemd-analyze verify`
   - EXIT=0；
   - 只有 Windows bind mount 权限映射警告；正式安装命令固定 mode 0644。
4. `npm run typecheck`
   - EXIT=0（node + web）。
5. Vitest（按 default + JSON 双 reporter）
   - `server_delivery_contract`、`server_build_target`、
     `prod_tree_has_no_electron`、`postinstall_conditional`；
   - 最终：4 files passed，43 tests passed；
   - JSON：`numFailedTests=0`、`numPendingTests=0`；
   - 临时 JSON 已删除。

生产 `npm ci` 同时报告 15 个 audit finding（2 moderate、13 high）。未运行自动修复，因为
依赖升级超出本任务且会改变 lockfile；这应作为发布审批的独立安全项。

## 只推理/未验证

- `unverified: 没有 systemd 作为 PID 1 的 fresh Linux VM`：未真跑 enable、boot、
  journald 持久化、StartLimit 和 RestartPreventExitStatus 的运行态。
- `unverified: 没有真实账号数据`：未证明代理监听后的 readyz 200、真实流式请求和 token
  跨重启。
- `unverified: 没有手机公网 TLS 测试`。
- `unverified: 没有执行桌面数据迁移、主机重启、应用升级/回滚和数据恢复演练`。
- `unverified: 数据目录单实例锁由并行 owner 实现`：本轮只假设其最终在入口获取锁并以
  已分类非零码拒绝第二实例。

## 对并行 owner 文档的假设

只引用，未创建或编辑：

- `docs/deployment/data-migration.md`：桌面数据定位、复制、权限、解密验证、失败回退；
- `docs/deployment/tls-front-proxy.md`：TLS 终止，readyz 仅流量 gating；
- `docs/deployment/firewall-exposure.md`：端口暴露矩阵和明文公网禁令。

若最终文件名不同，必须同步更新 `linux-systemd.md` 和架构门禁，不能留下死链接。

## 有意未做

- 未提供 Dockerfile/Compose：当前没有镜像 CI、签名、数据卷/secret/日志/升级合同；第二条
  官方路径会扩大维护面，systemd 已满足单机 Linux 常驻目标。
- 未把 readyz 接进 systemd restart：503 是可运维降级态，重启会杀掉手机面板并形成循环。
- 未自动 `npm audit fix`：不能用未评审依赖漂移换“0 漏洞”表象。
- 未改 `src/**`：交付合同不需要侵入运行时，且入口/锁由并行 owner 持有。
- 未提交、未 stash、未 revert。

## 契约传播检查

语义检索列出了 `build:server`、`start:server`、`out/server/index.js` 与 readyz 的现有消费点：
package scripts、Vite server 配置、server build 架构测试、webPanel readiness 测试和本轮发布
脚本。新增门禁把 release 脚本、systemd、文档与 `src/main/server/config.ts#EXIT` 接到同一
合同，防止路径/退出码/探针用途漂移。
