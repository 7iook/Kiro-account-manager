# 密钥处理与恢复

本服务有三类故意分开的密钥。不要复用、不要互相替代：

| 材料                   | 用途                                                  | 来源                                           | 能否更改                                                                                                         |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 主数据 `encryptionKey` | 让桌面和服务器原生读取同一 `kiro-accounts.json` 格式  | 编译进代码的 `kiro-account-manager-secret-key` | **不能改**；这是兼容性常量，只是混淆，不是安全（`src/main/persistence/accountStorePort.ts:60-66,78-82`）         |
| `KIRO_BACKUP_KEY`      | 服务端 `kiro-accounts.backup.enc` 的 AES-256-GCM 口令 | 环境/secret manager，至少 32 字符              | 可轮换，但旧备份仍需旧值解密；服务器不用 OS keyring（`src/main/secureBackupCipher.aesGcm.ts:1-24,37-47,76-104`） |
| 面板 `adminKey`        | 登录手机管理面板                                      | `KIRO_ADMIN_KEY` 或 `$KIRO_DATA_DIR/adminKey`  | 按下述规则轮换（`src/main/server/adminKeyStore.ts:69-85`）                                                       |

安装和环境文件位置以 [`docs/deployment/linux-systemd.md`](../deployment/linux-systemd.md)、`deploy/systemd/kiro-account-manager.service` 为准。示例 unit 从 `/etc/kiro-account-manager/server.env` 读取环境，并以 `kiro` 用户运行（`deploy/systemd/kiro-account-manager.service:8-17`）。

## 首次启动：推荐无日志引导

推荐在第一次启动前预置 `KIRO_ADMIN_KEY`。值必须至少 32 个字符且只能含可打印 ASCII；短值、空值、空白或控制字符会拒绝启动（`src/main/server/adminKeyStore.ts:101-123,302-330`）。

先在密码管理器中分别生成两把随机值，再编辑配置：

```sh
sudo install -d -o root -g root -m 0700 /etc/kiro-account-manager
sudoedit /etc/kiro-account-manager/server.env
```

在文件中加入：

```text
KIRO_ADMIN_KEY=<密码管理器中保存的随机值>
KIRO_BACKUP_KEY=<另一把独立的、至少 32 字符的随机值>
```

然后：

```sh
sudo chown root:root /etc/kiro-account-manager/server.env
sudo chmod 0600 /etc/kiro-account-manager/server.env
sudo systemctl start kiro-account-manager
```

不要把 key 放进 shell history、命令行参数或会被采集的终端输出；通过 `sudoedit` 从密码管理器粘贴。

环境管理模式不会创建 `$KIRO_DATA_DIR/adminKey`，也不会打印 key（`src/main/server/adminKeyStore.ts:354-380`）。若环境变量和磁盘文件同时存在且值不同，服务拒绝猜优先级并退出 78（`src/main/server/adminKeyStore.ts:354-366`）。

## 未预置时：一次性 stdout 引导的陷阱

若既没有 `KIRO_ADMIN_KEY`，也没有 `$KIRO_DATA_DIR/adminKey`，服务会：

1. 生成 256-bit 随机 key；
2. 原子写入独立 `adminKey` 文件；
3. 验证文件权限；
4. **把有效 key 完整打印到 stdout 一次**（`src/main/server/adminKeyStore.ts:397-415`）。

systemd unit 把 stdout/stderr 写入 journal（`deploy/systemd/kiro-account-manager.service:35-37`），容器则通常进入 `docker logs`。因此“只打印一次”不等于“没有副本”：journal、容器日志、终端回滚缓冲、集中日志和其备份都可能永久保留这把仍有效的凭据；启动文案也明确警告这一点（`src/main/server/adminKeyStore.ts:809-829`）。

如果已走这条路径：

```sh
sudo journalctl -u kiro-account-manager -b --no-pager
```

取出 key 后立即登录，并在 TLS 面板里轮换。轮换后再按组织的留存政策清理或缩短旧日志；仅清本机 journal 不能撤回已经进入集中日志、备份或他人终端的副本。

## 在线轮换

端点：

```text
POST /panel/api/admin-key/rotate
Cookie: kam_panel_sid=<有效会话>
X-Panel-Request: 1
```

它必须同时通过有效会话和 CSRF 自定义头；匿名或缺头都返回 401。成功后：

- 先持久化新 key；
- 失效所有已有会话（包括当前会话）；
- 清当前 cookie；
- 以 `{ "key": "..." }` 返回新 key 一次；
- 响应带 `Cache-Control: no-store`（`src/main/webPanel/server.ts:345-380`；测试证据 `test/main/webPanel/adminKeyRotation.server.test.ts:59-101`）。

浏览器面板是首选，因为它会维护会话与 CSRF 头。若自动化调用，先登录并保存 cookie，再轮换；绝不要把新 key 输出到 CI 日志：

```sh
umask 077
COOKIE_JAR="$(mktemp)"
RESPONSE="$(mktemp)"

curl --fail --silent --show-error \
  -c "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -H 'X-Panel-Request: 1' \
  --data '{"adminKey":"<current-key>"}' \
  https://panel.example.com/panel/api/login >/dev/null

curl --fail --silent --show-error \
  -b "$COOKIE_JAR" \
  -H 'X-Panel-Request: 1' \
  -X POST \
  -o "$RESPONSE" \
  https://panel.example.com/panel/api/admin-key/rotate
```

从权限为 0600 的 `$RESPONSE` 导入密码管理器，核对新 key 可登录后安全删除临时文件。不要使用 `curl -v`、`set -x` 或把响应交给日志采集器。

写盘失败时端点返回 500，旧 key 和旧会话保持有效，不会半轮换把管理员锁在门外（`src/main/webPanel/server.ts:369-380`；`test/main/webPanel/adminKeyRotation.server.test.ts:104-120`）。

### 环境管理模式拒绝在线轮换

若 key 来自 `KIRO_ADMIN_KEY`，运行时轮换会返回 500。服务故意拒绝写 `adminKey` 文件，因为那会制造两个不一致的真源并导致下次启动拒绝（`src/main/server/adminKeyStore.ts:872-880`）。

正确流程：

1. 在密码管理器/secret manager 生成新值；
2. 更新 `/etc/kiro-account-manager/server.env` 或容器 secret；
3. 保持文件 0600；
4. 重启服务；
5. 用旧 key 验证失败、新 key 验证成功。

重启会丢弃内存会话，因此旧会话不再有效。

## 文件权限硬门

文件管理模式的路径为：

```text
$KIRO_DATA_DIR/adminKey
```

Linux 上应为服务用户所有、mode 0600：

```sh
sudo chown kiro:kiro /var/lib/kiro-account-manager/adminKey
sudo chmod 0600 /var/lib/kiro-account-manager/adminKey
sudo stat -c '%U:%G %a %n' /var/lib/kiro-account-manager/adminKey
```

代码检查 group/other 的任一权限位；比 0600 更开放会拒绝启动，而不是只告警（`src/main/server/adminKeyStore.ts:137-144,264-267,338-351`）。`KIRO_ALLOW_UNPROTECTED_KEY_FILE=1` 是无法施加 POSIX 权限的平台上的开发逃生口，不得用于 Linux 生产（`src/main/server/adminKeyStore.ts:87-99`）。

unverified: mode 0600、rename 后权限保持、ACL 和网络文件系统语义未在本 Windows 主机上实测。必须在真实 Linux 目标上执行 `stat/getfacl`，并确认备份代理、监控代理和其他组成员不能读取。

## 丢失 adminKey 的恢复

没有、也不应有“未认证 HTTP 重置”端点：允许未认证请求重置认证本身就是自我引用的认证绕过。

恢复权来自服务器文件系统权限：

文件管理模式：

```sh
sudo systemctl stop kiro-account-manager
sudo install -d -m 0700 /root/kiro-key-recovery
sudo cp -a /var/lib/kiro-account-manager/adminKey \
  /root/kiro-key-recovery/adminKey.$(date -u +%Y%m%dT%H%M%SZ)
sudo rm /var/lib/kiro-account-manager/adminKey
sudo systemctl start kiro-account-manager
sudo journalctl -u kiro-account-manager -b --no-pager
```

服务会生成并打印新 key；立即通过 TLS 登录并在线轮换，使日志中的 bootstrap key 失效。删除 `adminKey` 不会改动 `kiro-accounts.json`（独立文件设计见 `src/main/server/adminKeyStore.ts:75-82`）。

环境管理模式：

更新 `KIRO_ADMIN_KEY` 的 secret 后重启，不要删除主数据文件。若磁盘上意外同时存在 `adminKey`，先备份现场并明确选择单一来源；不要让两者并存且不一致。

## 丢失 `KIRO_BACKUP_KEY`

丢失该值不会改变主 `kiro-accounts.json` 的兼容性，但旧的 `kiro-accounts.backup.enc` 将无法恢复；GCM 会明确报密钥不一致或文件损坏（`src/main/secureBackupCipher.aesGcm.ts:141-151`）。保留旧 key 直到对应备份全部超过保留期。轮换时先用旧 key 验证旧备份，再用新 key产生并验证一份新备份；不要原地覆盖唯一可恢复副本。
