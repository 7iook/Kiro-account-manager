# 备份、恢复、升级、回滚与日志

安装/发布物替换和 systemd unit 由 [`docs/deployment/linux-systemd.md`](../deployment/linux-systemd.md)、`deploy/` 定义。本文只覆盖有状态数据和运营动作。

示例变量：

```sh
SERVICE=kiro-account-manager
SERVICE_USER=kiro
DATA_DIR=/var/lib/kiro-account-manager
BACKUP_ROOT=/srv/backup/kiro-account-manager
RELEASE_ROOT=/opt/kiro-account-manager
```

## 1. 必须备份什么

### 数据目录

冷备整个 `$KIRO_DATA_DIR`，而不是只挑一个 JSON：

- `kiro-accounts.json`：账号、代理配置、统计和运行状态的主 store；文件名及路径规则见 `src/main/persistence/accountStorePort.ts:72-82,128-130`。
- `adminKey`：仅文件管理模式存在；与主数据分离（`src/main/server/adminKeyStore.ts:69-85`）。
- `kiro-accounts.backup.enc` 或旧 `kiro-accounts.backup.json`：应用级容灾副本，写路径保证正常时至多保留一种载体（`src/main/secureBackup.ts:17-33,52-59,123-147`）。
- 同目录内其他运行状态，例如 K-Proxy 数据、自签证书或未来版本新增文件。整目录冷备避免清单随版本漂移。

不要求把高容量运行日志与恢复备份混在一起；日志有独立保留策略。

### 数据目录之外的秘密与配置

另行备份到 secret manager/受控配置库：

- `/etc/kiro-account-manager/server.env` 的配置结构；
- `KIRO_BACKUP_KEY`；
- 环境管理模式下的 `KIRO_ADMIN_KEY`；
- Caddy 配置和域名/DNS 记录。

不要把这些秘密和数据 tar 放在同一非加密位置。主数据硬编码 `encryptionKey` 只是混淆；拿到文件的人可从程序获得同一个常量（`src/main/persistence/accountStorePort.ts:60-66`）。

## 2. 创建一致的冷备

账号/token/统计会在运行时写回。为了得到可证明的一致点，先停服务；停机流程会停止面板与反代、停止自动换号调度器、drain 持久化队列并 flush 日志（`src/main/server/assembly.ts:447-475`）。

```sh
set -eu
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"

sudo systemctl stop "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE" && {
  echo "service still active; abort" >&2
  exit 1
}

sudo install -d -o root -g root -m 0700 "$DEST"
sudo tar --xattrs --acls --numeric-owner \
  -C "$(dirname "$DATA_DIR")" \
  -cpf "$DEST/data.tar" "$(basename "$DATA_DIR")"
sudo sha256sum "$DEST/data.tar" | sudo tee "$DEST/SHA256SUMS" >/dev/null
sudo chmod 0600 "$DEST/data.tar" "$DEST/SHA256SUMS"
sudo systemctl start "$SERVICE"
```

若 stop 超时或日志出现“部分凭据可能尚未落盘”，不要把本次归档标为成功；修复停机问题后重做。第二次 SIGTERM 会强制退出并明确说明可能丢在途写入（`src/main/server/entry.ts:244-266`）。

unverified: `tar --xattrs --acls --numeric-owner`、systemd 停机时序和目标文件系统的 rename/fsync 语义未在本 Windows 主机实测；必须在实际 Linux/备份存储上验证。

## 3. 验证“可恢复”，而不只是“文件存在”

每份备份都执行三层验证：

### 层 1：传输完整性

```sh
cd "$DEST"
sudo sha256sum -c SHA256SUMS
sudo tar -tf data.tar >/dev/null
```

两条都必须退出 0。

### 层 2：隔离解密与形状

解包到一次性目录，不覆盖生产：

```sh
VERIFY_DIR="$(mktemp -d)"
sudo tar -C "$VERIFY_DIR" -xpf "$DEST/data.tar"
sudo chown -R "$USER:$USER" "$VERIFY_DIR"
RESTORED_DIR="$VERIFY_DIR/$(basename "$DATA_DIR")"

cd /opt/kiro-account-manager/current
DATA_DIR="$RESTORED_DIR" node --input-type=module <<'NODE'
import Conf from 'conf'
const store = new Conf({
  cwd: process.env.DATA_DIR,
  configName: 'kiro-accounts',
  encryptionKey: 'kiro-account-manager-secret-key'
})
const data = store.get('accountData')
if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad accountData')
const accounts = data.accounts
if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw new Error('bad accounts')
console.log(`RESTORE_DECRYPT_OK accounts=${Object.keys(accounts).length}`)
NODE
```

记录账号数并与备份时的受控记录比较。此命令不得打印任何账号内容或 token。

### 层 3：真实恢复演练

至少每个发布周期在隔离 Linux VM/容器中，用相同发布物、服务用户和恢复目录启动一次：

1. 不连接生产域名，不开放公网端口；
2. 注入备份时对应的 `KIRO_BACKUP_KEY`/环境管理 `KIRO_ADMIN_KEY`；
3. 启动并确认没有退出 65/73/78；
4. 若未配置 `KIRO_TRUSTED_TLS_PROXY_IPS`，可经 SSH tunnel 直连面板；若已配置，必须启动与生产相同的隔离 TLS front 并经它登录，因为缺少 `X-Forwarded-For` 的 backend 直连应返回 400；
5. 确认 `/panel/readyz` 的 200/503 与反代真实状态一致；
6. 停止、再次启动，确认数据仍在。

只有完成层 3 才可标记“restorable”。层 1 只证明 tar 没坏，层 2 只证明主 store 可读。

unverified: 当前仓库没有证据表明本次文档编写时已在 fresh Linux 上完成上述层 3。必须由人工在真实 Linux 执行并保存日期、发布版本、备份 ID、账号数和退出码。

## 4. 恢复

恢复会覆盖当前服务器状态，先创建当前状态的救援副本：

```sh
set -eu
RESTORE_FROM=/srv/backup/kiro-account-manager/<timestamp>
WORK="$(mktemp -d)"

cd "$RESTORE_FROM"
sudo sha256sum -c SHA256SUMS
sudo tar -C "$WORK" -xpf data.tar
RESTORED_DIR="$WORK/$(basename "$DATA_DIR")"

sudo systemctl stop "$SERVICE"
sudo mv "$DATA_DIR" "$DATA_DIR.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"
sudo cp -a "$RESTORED_DIR"/. "$DATA_DIR"/
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
sudo find "$DATA_DIR" -type d -exec chmod 0700 {} +
sudo find "$DATA_DIR" -type f -exec chmod 0600 {} +
```

若使用文件管理 adminKey，确认：

```sh
sudo stat -c '%U:%G %a %n' "$DATA_DIR/adminKey"
```

应为 `kiro:kiro 600`。若使用 `KIRO_ADMIN_KEY`，不要同时恢复一个值不同的 `adminKey` 文件；两真源不一致会退出 78（`src/main/server/adminKeyStore.ts:354-366`）。

启动并验收：

```sh
sudo systemctl start "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager
sudo journalctl -u "$SERVICE" -b --no-pager
ss -ltnp | grep -E ':(443|5580|5590)\b'
curl --silent --show-error --output /tmp/ready.json \
  --write-out '%{http_code}\n' https://panel.example.com/panel/readyz
cat /tmp/ready.json
```

启用受信 loopback proxy 时，backend 直连缺少转发元数据并返回 400 是正确行为；恢复验收必须经 HTTPS front。未启用该模式的隔离恢复才可经 SSH tunnel 直连。登录后核对账号数和抽样状态。失败时停止服务，移走失败恢复目录，把 `before-restore.*` 原样移回，再检查 owner/mode 后启动。

## 5. 应用级 `.backup.enc` 的边界

服务端在账号保存路径上用 `KIRO_BACKUP_KEY` 写 AES-GCM 的 `kiro-accounts.backup.enc`；缺 key 默认拒绝写明文，只有显式 `KIRO_BACKUP_ALLOW_PLAINTEXT=1` 才退回明文（`src/main/secureBackupCipher.aesGcm.ts:69-104`；`src/main/server/assembly.ts:658-674`）。

它是补充副本，不替代上面的冷备：

- 旧 key 丢失后旧 `.enc` 无法恢复；
- 桌面 safeStorage `.enc` 不能在服务器直接解密；
- 当前服务端装配代码可写该备份，但没有已验证的无头自动恢复编排；不要假设“把 `.enc` 放回去重启”会自动还原。

因此正式恢复以整目录冷备中的主 `kiro-accounts.json` 为准。若只剩 `.backup.enc`，先在隔离环境用创建它的同版本代码和原 `KIRO_BACKUP_KEY` 解密验证，再由维护者按数据模型导入；不要覆盖唯一密文。

## 6. 升级

发布物安装细节见 [`docs/deployment/linux-systemd.md`](../deployment/linux-systemd.md)。运营顺序固定：

1. 记录当前 release 标识、Node 版本和 `readlink -f /opt/kiro-account-manager/current`。
2. 执行一份已通过三层验证策略的升级前冷备。
3. 把新 release 安装到新目录，不覆盖旧目录。
4. 在新 release 完成依赖安装/构建验证。
5. 停服务后原子切换 `current` symlink。
6. 启动；检查 systemd 状态、完整本次 boot journal、面板和数据面。
7. 经 TLS 做一次已鉴权面板读取和一次受控代理请求。

数据文件包含可选 `schemaVersion`；当前支持版本为 1，无字段视为兼容，更新版本会拒绝启动而不向下猜（`src/main/persistence/accountStorePort.ts:85-101,255-279`）。

不要把“进程 active”当升级成功。面板 readiness 动态读取反代真实句柄；反代启动失败时面板保持在线并明确进入 503 降级态（`src/main/server/entry.ts:138-140,204-214`；`src/main/webPanel/server.ts:313-322`）。

## 7. 回滚

二进制回滚与数据回滚必须一起判断：

- 新版尚未写数据、旧版仍支持当前 schema：停服务，切回旧 release，启动并验收。
- 新版可能写过主 store或提高 schema：停服务，切回旧 release，**同时恢复升级前冷备**。否则旧版应因版本过新退出 65；绕过闸门会丢未知字段。

```sh
sudo systemctl stop "$SERVICE"
sudo ln -sfn "$RELEASE_ROOT/releases/<old-release>" "$RELEASE_ROOT/current.new"
sudo mv -Tf "$RELEASE_ROOT/current.new" "$RELEASE_ROOT/current"
# 如需数据回滚，按第 4 节恢复升级前备份
sudo systemctl start "$SERVICE"
```

unverified: symlink 原子替换、release 布局及实际安装命令虽已与 `docs/deployment/linux-systemd.md` §7 的合同对齐，但尚未在真实 Linux 目标执行；不能把本节示例当成已验证。

## 8. 日志位置和轮转

### systemd

官方 unit 将应用 stdout/stderr 写入 journal，标识为 `kiro-account-manager`（`deploy/systemd/kiro-account-manager.service:40-42`）：

```sh
sudo journalctl -u kiro-account-manager -b
sudo journalctl -u kiro-account-manager --since '1 hour ago'
sudo journalctl --disk-usage
```

轮转/保留由 journald 管，不由应用管。生产机在 `/etc/systemd/journald.conf.d/kiro-retention.conf` 设置组织认可的全局或命名空间策略，例如：

```ini
[Journal]
SystemMaxUse=1G
MaxRetentionSec=14day
```

```sh
sudo systemctl restart systemd-journald
sudo journalctl --disk-usage
```

这些参数影响整台主机 journal，需由平台运维审批。首次自动生成的 adminKey 会进入 journal；留存越长，凭据副本暴露越久。首选预置 `KIRO_ADMIN_KEY`，否则首次登录后立即轮换；轮转日志不能替代凭据轮换。

### 容器

若另行采用容器，stdout/stderr 由容器日志驱动保存。必须在编排层设置大小和文件数，例如 Docker `json-file` 的 `max-size`/`max-file`；默认无限增长不可接受。容器不是当前 `deploy/` 的正式安装合同，具体参数须由容器交付物另行验证。

### 应用自身日志

服务器默认把 proxy 日志写到 console；日志 data 默认截断，`KIRO_LOG_FULL=1` 仅临时关闭截断，可能增加凭据和磁盘风险（`src/main/server/config.ts:80-85,155-159`；`src/main/proxy/logger.ts:54-84,194-226`）。

不要宣称服务器会自动轮转应用文件日志：`ProxyLogger` 的文件 sink 默认关闭，且启用时必须显式提供 `logDir`（`src/main/proxy/logger.ts:47-52,96-129`）。它内部虽有 10 MiB/5 文件逻辑，但当前生产装配没有启用该 sink（`src/main/proxy/logger.ts:159-191`）。运营真源是 journald/容器日志驱动。

服务端装配现在会在业务启动前以 `KIRO_DATA_DIR` 初始化 `proxyLogStore`，并在所有请求入口和自动换号调度器停止后执行最终 flush（`src/main/server/assembly.ts:328-338,447-475`）。因此 `$KIRO_DATA_DIR/proxy-logs.json` 不再使用空路径；store 自身以 10,000 条为上限、30 秒节流写盘，退出时强制保存（`src/main/proxy/logger.ts:317-342,366-459`）。它仍不是 systemd 的进程日志替代品：启动失败、stderr 和 unit 生命周期继续以 journal 为运营真源。
