# 桌面数据迁移到 Linux

本流程只做一次初始化复制。桌面与服务器之后是两份完全独立的数据：不共享目录、不自动同步，也不要把服务器文件定期覆盖回桌面。主数据的 `encryptionKey` 是编译进程序的固定值；它只提供格式混淆，不是机密保护，不能更改，否则既有文件无法读取（`src/main/persistence/accountStorePort.ts:60-66,78-82`）。

安装、服务用户、systemd unit 和发布物布局先按 [`docs/deployment/linux-systemd.md`](../deployment/linux-systemd.md) 与 `deploy/systemd/` 完成；本文不重复安装步骤。以下示例采用该 unit 的默认值：

```sh
SERVICE=kiro-account-manager
SERVICE_USER=kiro
DATA_DIR=/var/lib/kiro-account-manager
```

## 1. 在桌面机定位源文件

桌面代码没有硬编码平台路径。它把 Electron 运行时返回的 `app.getPath('userData')` 作为目录，再由 `electron-store` 生成 `kiro-accounts.json`（`src/main/index.ts:1038-1075`）；服务端也明确要求同名文件（`src/main/persistence/accountStorePort.ts:72-82,128-130`）。构建产品名为 `Kiro Account Manager`（`electron-builder.yml:1-3`），但不要仅凭产品名猜目录：旧版本、开发版或改名安装包可能使用不同的运行时 app name。

先完全退出桌面应用，再在 Electron 的平台 userData 根下查找唯一的真实文件：

Windows PowerShell：

```powershell
Get-ChildItem -LiteralPath $env:APPDATA -Filter kiro-accounts.json -File -Recurse |
  Select-Object FullName,Length,LastWriteTime
```

macOS：

```sh
find "$HOME/Library/Application Support" -type f -name kiro-accounts.json -print
```

Linux 桌面：

```sh
find "${XDG_CONFIG_HOME:-$HOME/.config}" -type f -name kiro-accounts.json -print
```

这些根目录来自 Electron 的 `userData` 运行时能力；最终以文件内容、修改时间及桌面当前账号数核对结果。若找到多份，不要选“最新看起来像”的一份：重新启动桌面应用，做一次无敏感性的设置变更并正常退出，确认哪一份修改时间随之变化。

正式迁移只复制：

```text
kiro-accounts.json
```

不要复制以下文件作为初始迁移：

- `kiro-accounts.backup.enc`：桌面端使用 Electron `safeStorage`/系统 keyring，服务端使用 `KIRO_BACKUP_KEY` 的 AES-GCM，信封不兼容（`src/main/secureBackupCipher.safeStorage.ts:1-15`；`src/main/secureBackupCipher.aesGcm.ts:26-33,128-132`）。
- `kiro-accounts.backup.json`：可能是旧的明文回退副本，不能证明比主文件新（`src/main/secureBackup.ts:17-44,52-59`）。
- 桌面面板密钥：它位于主文件的 `webPanelAdminKey` 键，但服务端明确不采用，会生成或读取自己的独立 `adminKey` 文件（`src/main/server/adminKeyStore.ts:46-52,75-82`）。

## 2. 先固定源文件证据

在桌面机计算哈希，不移动、不重命名、不修改源文件：

Windows：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\实际路径\kiro-accounts.json'
```

macOS/Linux：

```sh
sha256sum '/实际路径/kiro-accounts.json'
```

保存哈希、字节数、桌面当前账号数和时间。迁移后仍保留桌面源文件；这是回退的第一保证。

## 3. 复制到服务器暂存区

先复制到服务用户不能误读的暂存目录，不要直接覆盖运行中的数据目录：

```sh
install -d -m 0700 "$HOME/kiro-migration"
scp '/本机实际路径/kiro-accounts.json' server.example:"$HOME/kiro-migration/kiro-accounts.json"
ssh server.example 'chmod 0600 "$HOME/kiro-migration/kiro-accounts.json"; sha256sum "$HOME/kiro-migration/kiro-accounts.json"'
```

服务器哈希必须与源机一致。不同即停止；删除暂存副本后重新传输，不要尝试启动。

## 4. 离线验证能解密

在发布目录运行与生产相同的 `conf` 实现，只输出顶层形状和账号数，不打印账号、token 或代理凭据。服务端本身也是 `conf + configName=kiro-accounts + 同一 encryptionKey`（`src/main/persistence/accountStore.conf.ts:78-103`）。

```sh
cd /opt/kiro-account-manager/current
DATA_DIR="$HOME/kiro-migration" node --input-type=module <<'NODE'
import Conf from 'conf'
const store = new Conf({
  cwd: process.env.DATA_DIR,
  configName: 'kiro-accounts',
  encryptionKey: 'kiro-account-manager-secret-key'
})
const data = store.get('accountData')
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  throw new Error('解密成功但 accountData 缺失或形状错误')
}
const accounts = data.accounts
if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
  throw new Error('accountData.accounts 缺失或形状错误')
}
console.log(`DECRYPT_OK accounts=${Object.keys(accounts).length}`)
NODE
```

判定标准：

- 命令退出码必须为 0；
- 必须出现 `DECRYPT_OK accounts=N`；
- `N` 必须与桌面记录的账号数相同；
- 不得出现 `Unexpected token`、解密异常或空库。

该检查验证格式与账号数，但不验证服务用户权限、版本闸门和真实启动。主程序启动还会检查：目录/文件可写、文件可读、可解密、`schemaVersion` 不高于 1（`src/main/server/config.ts:200-257`；`src/main/persistence/accountStorePort.ts:260-279,309-336`）。

## 5. 安装目标副本并限制权限

```sh
sudo systemctl stop "$SERVICE"
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"

if sudo test -e "$DATA_DIR/kiro-accounts.json"; then
  sudo cp -a "$DATA_DIR/kiro-accounts.json" \
    "$DATA_DIR/kiro-accounts.json.pre-migration.$(date -u +%Y%m%dT%H%M%SZ)"
fi

sudo install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 \
  "$HOME/kiro-migration/kiro-accounts.json" "$DATA_DIR/kiro-accounts.json"
sudo -u "$SERVICE_USER" test -r "$DATA_DIR/kiro-accounts.json"
sudo -u "$SERVICE_USER" test -w "$DATA_DIR/kiro-accounts.json"
sudo -u "$SERVICE_USER" test -w "$DATA_DIR"
sudo sha256sum "$DATA_DIR/kiro-accounts.json"
```

最后一个哈希仍须与源机一致。服务端写入前会同时检查目录和文件可写；任一失败会退出 73，而不是带着只读数据运行（`src/main/persistence/accountStorePort.ts:306-335`）。

unverified: 上述 `chmod/chown/test -w` 与 systemd `User=kiro` 的真实行为未在本 Windows 主机上执行；必须在目标 Linux 文件系统上验证，特别是 NFS、CIFS、容器 bind mount 和带 ACL 的目录。

## 6. 隔离验收后再导流

保持 Caddy/nginx 停止，防火墙只开放 SSH；确认 `KIRO_PANEL_HOST=127.0.0.1`。这一阶段还没有 front proxy，因此 `KIRO_TRUSTED_TLS_PROXY_IPS` 必须保持未设置；否则 backend 直连和 SSH tunnel 会因缺少代理生成的 `X-Forwarded-For` 而按设计返回 400。启用 TLS front 时再按 [`../security/network-exposure.md`](../security/network-exposure.md) 同步设置并验收。

注意反代 host 来自复制文件中的 `proxyConfig`，没有环境变量覆盖（`src/main/server/assembly.ts:380-388,555-580`）。还要检查迁移数据中的自动换号开关：无头服务装配后会立即启动共享 scheduler，而不是等桌面 renderer 在线（`src/main/server/assembly.ts:395-420`）。先用上一节的离线脚本打印 `proxyConfig.host/port/enabled/autoStart` 和非敏感的自动换号设置；若 host 不是 loopback，先在**目标副本**上改为 `127.0.0.1`，不得改桌面源文件：

```sh
cd /opt/kiro-account-manager/current
sudo -u "$SERVICE_USER" env DATA_DIR="$DATA_DIR" node --input-type=module <<'NODE'
import Conf from 'conf'
const store = new Conf({
  cwd: process.env.DATA_DIR,
  configName: 'kiro-accounts',
  encryptionKey: 'kiro-account-manager-secret-key'
})
const p = store.get('proxyConfig', {})
const a = store.get('accountData', {})
console.log(`before host=${p.host ?? 'default'} port=${p.port ?? 'default'} autoStart=${p.autoStart === true}`)
console.log(`autoSwitch enabled=${a.autoSwitchEnabled === true} interval=${a.autoSwitchInterval ?? 'default'} threshold=${a.autoSwitchThreshold ?? 'default'}`)
if (p.host && !['127.0.0.1', '::1', 'localhost'].includes(String(p.host))) {
  store.set('proxyConfig', { ...p, host: '127.0.0.1' })
  console.log('target copy changed: proxyConfig.host=127.0.0.1')
}
NODE
```

这一步可能修改服务器副本的 `proxyConfig`，因此先前源哈希不再适合作为目标文件最终哈希；保留迁移前哈希和变更日志即可。它不触碰桌面源数据。

若输出 `autoSwitch enabled=true`，首次启动会立即检查当前账号，满足阈值时可能在操作员首次登录前切换 active 账号并推进服务器反代。若这不是预期，停止迁移，在桌面源应用中关闭自动换号后重新复制；不要把“关掉桌面电脑”当作暂停服务器 scheduler 的方法。运行语义见 [`account-management.md`](account-management.md)。

启动并检查：

```sh
sudo systemctl start "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager
sudo journalctl -u "$SERVICE" -b --no-pager
curl -fsS http://127.0.0.1:5590/panel/readyz || true
```

操作员实际看到的四态：

- 文件不存在：stderr 明确打印“未找到账号数据文件”和“以空账号库启动”，进程继续（`src/main/server/config.ts:213-224`）。
- 无法读取或不可写：打印具体文件/目录及原因，拒绝启动，退出 73（`src/main/server/config.ts:206-234`）。
- 无法解密/解析：打印“拒绝以空库启动”，提示先备份，退出 65（`src/main/server/config.ts:236-243`）。
- 版本过新：打印盘上版本与支持版本，拒绝启动，退出 65（`src/main/persistence/accountStorePort.ts:260-277`）。

`/panel/readyz` 返回 200 只代表反代真实监听；反代未启动时返回 503，但面板仍应可管理（`src/main/webPanel/server.ts:313-322`）。在尚未启用受信代理的本节隔离阶段，通过 SSH 端口转发打开面板，登录后核对账号数和几个非敏感标识：

```sh
ssh -L 5590:127.0.0.1:5590 server.example
```

浏览器访问 `http://127.0.0.1:5590/panel`。账号数、抽样账号标识、代理配置及一次受控测试请求均正确后，才按 `docs/security/network-exposure.md` 启用 TLS 前置代理和防火墙导流。

## 7. 失败回退

任何数量、解密、权限或抽样行为不一致都视为迁移失败：

```sh
sudo systemctl stop "$SERVICE"
sudo mv "$DATA_DIR/kiro-accounts.json" \
  "$DATA_DIR/kiro-accounts.json.failed.$(date -u +%Y%m%dT%H%M%SZ)"

# 仅当第 5 步创建过 pre-migration 文件时恢复它：
sudo cp -a "$DATA_DIR"/kiro-accounts.json.pre-migration.* "$DATA_DIR/kiro-accounts.json"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/kiro-accounts.json"
sudo chmod 0600 "$DATA_DIR/kiro-accounts.json"
```

没有旧服务器数据时，保持服务停止并保留失败副本供分析；不要用空文件占位，也不要在失败副本上导入新账号。桌面源文件始终未被修改，桌面应用可继续独立运行。
