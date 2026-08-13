# Linux 服务器安装与 systemd 运行合同

本文从 Git 根目录 `F:\Kiro-account-manager` 下的一层嵌套代码目录
`Kiro-account-manager/` 出发。所有 npm 命令都必须在该嵌套目录执行；Git 根目录不是
Node 包根目录。

## 1. 支持范围与交付物

- 支持 Node.js `^20.19.0 || >=22.12.0`。这是 `package.json#engines` 的真实合同：
  产物是 CJS，并依赖 Node 在这两个下限开始支持的 `require(ESM)` 行为。低版本不是
  “可能能跑”，而是不受支持。
- 推荐新部署使用 Node 22 LTS，且版本不得低于 22.12.0。
- 唯一正式部署路径是 systemd。当前不提供正式容器镜像：容器会新增镜像构建、宿主端口、
  数据卷、secret、日志轮转和升级回滚的第二套合同，却没有现成 Linux CI/镜像签名链证明
  它。先把一条 systemd 路径做实，比维护两条未验证路径可靠。
- 交付物是 `npm run release:server` 生成的整个目录：
  `out/release/kiro-account-manager-server-v<package version>/`。不得只复制
  `out/server/index.js`：第三方运行时依赖是 external，面板还依赖同级的
  `out/webPanel/`。

发布目录包含：

| 路径                                | 用途                                        |
| ----------------------------------- | ------------------------------------------- |
| `out/server/index.js`、`.map`       | Node 服务和可读生产栈                       |
| `out/webPanel/`                     | 手机管理面板静态资源                        |
| `package.json`、`package-lock.json` | 锁定目标机生产依赖                          |
| `scripts/postinstall.mjs`           | 使 `npm ci --omit=dev` 不依赖 Electron 工具 |
| `deploy/systemd/`                   | unit 与环境变量模板                         |
| `RELEASE.json`                      | 包版本、Git 提交、构建 Node、是否 dirty     |
| `SHA256SUMS`                        | 传输完整性校验                              |

构建必须发生在构建机，不在生产目标机：TypeScript、Vite 和类型定义都在
`devDependencies`，目标机刻意只安装生产依赖。发布目录记录 `sourceTreeDirty`；正式发布
必须为 `false`，否则版本号不能唯一对应源码。

## 2. 在构建机产生制品

以下命令从 Git 根目录开始：

```bash
cd Kiro-account-manager
node --version
npm --version
npm ci
npm run release:server
cd out/release/kiro-account-manager-server-v1.7.6
sha256sum -c SHA256SUMS
node -p "require('./RELEASE.json')"
```

不要手写 `v1.7.6` 作为自动化输入；实际目录名取当前 `package.json#version`。发布前确认
`RELEASE.json.sourceTreeDirty` 为 `false`，并把整个目录原样传到服务器。

## 3. 全新 Linux 主机安装

以下示例以版本 `1.7.6` 为路径示意。命令需以 root 执行；Node 的安装方式由发行版决定。

### 3.1 验证 Node

```bash
node --version
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);process.exit((a===20&&(b>19||(b===19&&c>=0)))||(a===22&&(b>12||(b===12&&c>=0)))||a>22?0:1)"
```

第二条命令必须退出 0。Node 21 和低于 20.19/22.12 的版本不在 engines 范围内。

### 3.2 建立服务账户和目录

```bash
useradd --system --home-dir /var/lib/kiro-account-manager \
  --shell /usr/sbin/nologin kiro
install -d -o root -g root -m 0755 /opt/kiro-account-manager/releases
install -d -o root -g root -m 0755 /etc/kiro-account-manager
```

将完整发布目录上传为
`/opt/kiro-account-manager/releases/kiro-account-manager-server-v1.7.6`，然后：

```bash
cd /opt/kiro-account-manager/releases/kiro-account-manager-server-v1.7.6
sha256sum -c SHA256SUMS
npm ci --omit=dev
test -f out/server/index.js
test -f out/webPanel/index.html
test ! -d node_modules/electron
node -p "const r=require('./RELEASE.json'); r.releaseId+' '+r.gitCommit+(r.sourceTreeDirty?' DIRTY':'')"
chown -R root:root .
ln -sfnT /opt/kiro-account-manager/releases/kiro-account-manager-server-v1.7.6 \
  /opt/kiro-account-manager/current
```

每条命令都应退出 0；版本命令不得显示 `DIRTY`。`npm ci` 必须在发布目录运行，而不是
`/opt/kiro-account-manager` 或 Git 根目录。

### 3.3 配置

```bash
install -m 0600 -o root -g root \
  deploy/systemd/server.env.example /etc/kiro-account-manager/server.env
editor /etc/kiro-account-manager/server.env
```

实际可设变量以源码为准：

| 变量                              | 必需 | 默认/语义                                                               |
| --------------------------------- | ---: | ----------------------------------------------------------------------- |
| `KIRO_DATA_DIR`                   |   是 | 无默认值；unit 模板使用 `/var/lib/kiro-account-manager`                 |
| `KIRO_PANEL_HOST`                 |   否 | 盘上配置，最终兜底 `127.0.0.1`                                          |
| `KIRO_PANEL_PORT`                 |   否 | 盘上配置，最终兜底 `5590`；只接受 0–65535 整数                          |
| `KIRO_TRUSTED_TLS_PROXY_IPS`      |   否 | 默认关闭；逗号分隔的受控代理 hop IP/CIDR，不是客户端网段；非法值退出 64 |
| `KIRO_LOG_FULL`                   |   否 | 默认日志截断；`1/true/yes/on` 临时启用完整日志                          |
| `KIRO_ADMIN_KEY`                  |   否 | 预置至少 32 字符的密钥；不写日志、不落 `adminKey` 文件                  |
| `KIRO_ALLOW_UNPROTECTED_KEY_FILE` |   否 | 仅开发逃生门；Linux 生产禁止设置                                        |

`KIRO_TRUSTED_TLS_PROXY_IPS` 同时授权应用读取该 peer 写入的 `X-Forwarded-For`，并把经该 peer 到达的面板请求视为 TLS 上下文；声明、默认值和非法输入处理见 `src/main/server/config.ts:67-85,112-125,143-183`。同机 Caddy 常见值是后端实际看到的 `127.0.0.1`，但若 upstream 走 IPv6、容器 bridge 或异机/SNAT，必须按 socket 实测调整；多级代理还要列出右向左剥链所需的每个受控 hop，不能填写客户端网段。

生产装配会把该环境值作为只读覆盖注入面板与数据反代，并在持久化配置前剥离同名字段，盘上/UI 配置不能自行扩大信任边界（`src/main/server/assembly.ts:380-431,519-580`）。完整风险与验收见 [`../security/network-exposure.md`](../security/network-exposure.md)。

首次部署保持 `KIRO_PANEL_HOST=127.0.0.1`。不要为了“让手机能访问”直接改成
`0.0.0.0`：adminKey 经公网明文 HTTP 传输等同公开。公网/局域网访问必须先完成
[`../security/network-exposure.md`](../security/network-exposure.md)（TLS 前置、
转发头信任、防火墙与公网暴露判据在同一份里）。

数据从桌面迁移前，按 [`../operations/data-migration.md`](../operations/data-migration.md)
操作；本文不重复那份合同。密钥引导与轮换见
[`../operations/key-handling.md`](../operations/key-handling.md)，备份恢复与升级回滚见
[`../operations/backup-restore-upgrade.md`](../operations/backup-restore-upgrade.md)。面板账号编辑/删除和无头自动换号的运行边界见
[`../operations/account-management.md`](../operations/account-management.md)。若先空库启动，服务会明确告警但允许面板运行。

### 3.4 安装并启动 unit

```bash
install -m 0644 -o root -g root \
  deploy/systemd/kiro-account-manager.service \
  /etc/systemd/system/kiro-account-manager.service
systemctl daemon-reload
systemctl enable --now kiro-account-manager.service
systemctl status kiro-account-manager.service --no-pager
journalctl -u kiro-account-manager.service -b --no-pager
```

`active (running)` 证明进程/控制面存活。它不证明反代可接流量；继续做下一节。

## 4. 首次密钥与就绪验证

推荐在第一次启动前设置 `KIRO_ADMIN_KEY`，这样有效密钥从未进入 journal。此模式由环境
变量管理，运行时轮换端点会拒绝写文件；以后应更新环境文件并重启。

若未预置，服务会生成 `/var/lib/kiro-account-manager/adminKey`（0600）并只在首次 stdout
打印一次。立即完成：

1. `journalctl -u kiro-account-manager.service -b` 取得临时密钥；
2. 经已配置 TLS 的面板登录；
3. 调用面板的 `POST /panel/api/admin-key/rotate`（UI 使用同一端点）；
4. 保存响应中只显示一次的新密钥并重新登录；旧会话立即失效；
5. 按日志系统策略清理/缩短含旧临时密钥的 journal 保留期。

轮换后的密钥不会写日志。若使用 `KIRO_ADMIN_KEY`，不要调用运行时轮换；更新环境配置。

验证方式取决于是否启用了受信 TLS 前置代理。

尚未启用 `KIRO_TRUSTED_TLS_PROXY_IPS` 的隔离安装可本机直连诊断：

```bash
curl --fail-with-body http://127.0.0.1:5590/panel/
curl --silent --show-error --output /tmp/ready.json \
  --write-out '%{http_code}\n' http://127.0.0.1:5590/panel/readyz
cat /tmp/ready.json
```

启用受信 loopback peer 后，backend 直连请求没有 `X-Forwarded-For`，返回 400 才是 fail-closed 的正确结果；此时只用 `ss` 确认 5590/5580 仍绑定 loopback，成功验收必须走外部 HTTPS front：

```bash
ss -ltnp | grep -E ':(443|5580|5590)\b'
curl --silent --show-error --output /tmp/ready.json \
  --write-out '%{http_code}\n' https://panel.example.com/panel/readyz
cat /tmp/ready.json
```

- `200 {"status":"ready"}`：反代真实监听，可由前置代理导入业务流量。
- `503 {"status":"not_ready"}`：进程和管理面板仍活着，但反代未监听。此时应在面板修复，
  **不得重启服务**。常见原因包括反代端口冲突或盘上配置未启用/未自启。
- `400`：受信代理没有提供合法 `X-Forwarded-For`；这是代理元数据配置错误，不是数据面未就绪（面板拒绝路径 `src/main/webPanel/server.ts:266-280`）。

首次验收还必须通过浏览器确认 session cookie 带 `Secure`，并从允许与拒绝来源各测一次 IP policy；只测 readiness 不能证明客户端地址解析正确。

## 5. 监督合同（不可“简化”）

systemd 只监督进程存活。`/panel/readyz` 只供前置代理做流量 gating，绝不能用于
`ExecStartPost`、systemd watchdog、容器 restart probe 或外部“失败即重启”脚本。

启用受信代理后，前置代理对 `/panel/readyz` 的请求也必须携带其正常生成的合法 `X-Forwarded-For`。503 仍只表示数据面未就绪；400 表示受信代理元数据错误，二者都不能接成 systemd 重启条件。

原因：反代端口冲突时，服务刻意保持面板在线并让 readyz 返回 503。若按 readiness
重启，就会形成循环，同时杀掉手机上唯一能修复问题的管理入口。

unit 的关键行为：

- `Restart=on-failure`，退避 10 秒，5 分钟最多 5 次；
- 退出码 64（参数）、65（数据）、73（权限）、78（配置冲突）不自动重启；
- 退出码 69 保持可重启，因为未捕获运行时故障也归此类；反代启动失败本身不会退出进程；
- `SIGTERM` 触发有序停止；`TimeoutStopSec=30s` 明显高于凭据写入排空的 10 秒上界；
- stdout/stderr 进入 journald：`journalctl -u kiro-account-manager.service`；
- `systemctl enable` 保证主机启动时拉起服务。

## 6. 停止与故障识别

```bash
systemctl stop kiro-account-manager.service
journalctl -u kiro-account-manager.service -n 100 --no-pager
systemctl show kiro-account-manager.service \
  -p ActiveState -p SubState -p ExecMainStatus -p Result
```

日志应出现“收到 SIGTERM，开始停机”和“已停机”。不要在 30 秒内再次发送信号；第二次信号
按设计立即强退，可能丢失尚未落盘的统计或凭据。

退出码含义：

|  码 | 类别                        | 首要检查                                                                              |
| --: | --------------------------- | ------------------------------------------------------------------------------------- |
|   0 | 正常停止                    | 无                                                                                    |
|  64 | 环境变量非法                | `server.env`、端口格式、`KIRO_DATA_DIR`、`KIRO_TRUSTED_TLS_PROXY_IPS` 的 IP/CIDR 列表 |
|  65 | 数据不可解/版本过新         | 先备份，再按迁移 runbook 检查                                                         |
|  69 | 服务不可用/运行时致命错误   | journal 中端口或异常栈；systemd 会退避重启                                            |
|  73 | 数据目录/密钥文件权限       | owner、mode、只读挂载                                                                 |
|  78 | adminKey 来源冲突等配置矛盾 | env 与 `adminKey` 文件是否不一致                                                      |

## 7. 更新与回滚边界

每个版本安装到新的 `/opt/kiro-account-manager/releases/<releaseId>`，在该目录完成 checksum
和 `npm ci --omit=dev` 后，停服务、切换 `current` 软链接、再启动。应用回滚同理切回上一
目录。涉及数据格式变化时不得只切应用；必须遵守迁移文档中的兼容与备份规则。

## 8. 本文依赖的运行合同

本文依赖以下已存在的运行合同，不在此复制第二份：

- [`../operations/data-migration.md`](../operations/data-migration.md)：桌面数据定位、复制而非移动、owner/mode、解密验证和失败回退；
- [`../security/network-exposure.md`](../security/network-exposure.md)：TLS 终止、受信代理 opt-in、转发头、防火墙、readiness gating 和公网暴露判据；
- [`../operations/backup-restore-upgrade.md`](../operations/backup-restore-upgrade.md)：整目录冷备、恢复、升级与回滚；
- [`../operations/account-management.md`](../operations/account-management.md)：手机面板账号变更、限时撤销和服务器自动换号生命周期。

服务器入口在读取业务数据前获取规范化数据目录的跨进程锁；冲突映射为退出 69，成功启动后锁随完整 shutdown 生命周期释放（`src/main/server/entry.ts:80-101,224-230`）。unit 刻意允许 69 退避重试，并由启动频率限制阻止永久循环（`deploy/systemd/kiro-account-manager.service:26-33`）。
