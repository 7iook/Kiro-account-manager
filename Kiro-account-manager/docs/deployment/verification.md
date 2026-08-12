# 生产交付合同验证记录

本文件区分“真执行”与“只审阅”。最后执行日期：2026-08-13；源码基线
`26dfc5765368b1e5fdb27de2eb255d10bfb4c523`，工作树含本交付合同的未提交变更，因此
生成的 `RELEASE.json.sourceTreeDirty=true`。这只用于验证，不能作为正式发布物。

## 已真执行

### 构建与发布目录

在 Windows 构建机、嵌套代码目录 `F:\Kiro-account-manager\Kiro-account-manager` 执行：

```text
npm run release:server
```

结果：

- `typecheck:node` EXIT=0；
- Vite server 构建成功，`out/server/index.js` 720.15 kB，map 1,849.16 kB；
- webPanel 构建成功；
- 发布目录生成在
  `out/release/kiro-account-manager-server-v1.7.6/`；
- `RELEASE.json` 记录版本 `1.7.6`、提交 `26dfc576...` 和 `dirty=true`；
- `SHA256SUMS` 覆盖运行文件、依赖锁、systemd 文件和元数据。

第一次真跑发现 `createHash` 错从 `node:fs` 导入，脚本在打包阶段退出 1。修正为
`node:crypto` 后重跑成功。这是为何“脚本存在”不能算验证。

### Linux 干净生产安装、启动、探测、SIGTERM

使用 Docker Linux 容器 `node:22.20.0-bookworm`，把制品只读挂载后复制到空的 `/work`，
真执行：

```text
sha256sum -c SHA256SUMS
npm ci --omit=dev
test ! -d node_modules/electron
node --enable-source-maps out/server/index.js
GET http://127.0.0.1:5590/panel/readyz
kill -TERM <node-pid>
wait <node-pid>
```

结果：

- 所有 checksum 为 `OK`；
- 安装 110 packages，postinstall 明确跳过 Electron builder，Electron 目录不存在；
- 空数据目录启动成功，面板监听 `127.0.0.1:5590`；
- 因默认反代禁用，readyz 如设计返回
  `503 {"status":"not_ready"}`，证明管理面在降级态仍存活；
- SIGTERM 日志包含“收到 SIGTERM，开始停机”和“已停机”；
- Node 进程退出码为 0。

该安装同时报告当前 lockfile 的生产树有 15 个 npm audit finding（2 moderate、13 high）。
本任务没有运行 `npm audit fix`，因为它会改变已锁定依赖且超出部署合同范围；发布审批必须
单独审阅这些 finding，不能把“可安装”误写成“依赖无漏洞”。

### systemd unit 静态校验

在 Debian bookworm 容器安装 systemd 后执行：

```text
systemd-analyze verify /contract/kiro-account-manager.service
```

EXIT=0。Windows bind mount 使文件在容器里显示为 executable/world-writable，校验器对此
给出警告；正式安装命令使用 `install -m 0644`，不继承该挂载权限。

### 类型与架构门禁

```text
npm run typecheck
npx vitest run \
  test/main/architecture/server_delivery_contract.test.ts \
  test/main/architecture/server_build_target.test.ts \
  test/main/architecture/prod_tree_has_no_electron.test.ts \
  test/main/architecture/postinstall_conditional.test.ts \
  --reporter=default --reporter=json \
  --outputFile.json=.agent-workspace-review-deploy-contract-final.json
```

结果：

- `npm run typecheck` EXIT=0；
- default reporter：4 files passed，42 tests passed；
- JSON：`numFailedTests=0`、`numPendingTests=0`；
- 临时 JSON 已删除。

## 未验证

- `unverified: 当前主机没有以 systemd 作为 PID 1 的 fresh Linux VM`：没有真执行
  `systemctl enable --now`、开机自启、journald 持久日志、StartLimit 或
  `RestartPreventExitStatus` 的运行态行为；只做了 unit 语法校验。
- `unverified: 本次使用空账号库且默认反代禁用`：readyz 的 503 路径已真跑，真实账号
  加载、代理端口监听后的 200 路径和实际流式请求不在本任务可用数据内。
- `unverified: 没有执行手机经公网 TLS 访问`：依赖
  [`../security/network-exposure.md`](../security/network-exposure.md)。
- `unverified: 没有桌面真实数据样本`：未执行
  [`../operations/data-migration.md`](../operations/data-migration.md) 的复制、解密、回退。
- `unverified: 没有真做主机重启、应用升级、软链接回滚和数据恢复演练`。
- `unverified: 并行 owner 的数据目录单实例锁尚未在本验证中出现`：本文假设其最终接入
  `entry.ts`，未编辑或抢占该文件。

这些未验证项通过前，不能把“发布目录可安装并能优雅退出”扩大成题述整句最终成功状态。
