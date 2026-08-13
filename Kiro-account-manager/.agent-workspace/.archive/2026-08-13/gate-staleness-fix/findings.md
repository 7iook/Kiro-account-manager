# 两个陈旧门禁的修复记录

日期：2026-08-13  
范围：只修改两个指定测试文件，并写本报告；未提交、未 stash、未回退共享工作树。

## 1. 安装文档门禁现在断言什么

`test/main/architecture/server_delivery_contract.test.ts` 不再把三个具体文件名当合同。现在：

1. 扫描 `docs/deployment/linux-systemd.md` 中所有指向本地 `.md` 的 Markdown 链接，排除外链和页内锚点。
2. 每个命中的目标都必须留在仓库内、真实存在且是文件；任何一个坏链都会列出原始 `href` 并让用例失败。
3. 将安装文档直接链接到的真实文档内容合并后，必须覆盖两组承重语义：
   - TLS、`KIRO_TRUSTED_TLS_PROXY_IPS`、`X-Forwarded-For`、防火墙、`/panel/readyz`；
   - 桌面到 Linux 的数据迁移、`kiro-accounts.json`、哈希校验、复制和失败回退。
4. 扫描器有受控自检：同一输入中的真实本地文档返回 `true`、刻意不存在的文档返回 `false`，外链和页内锚点不进入结果；TLS/暴露与迁移语义判据也各有正、负样本。

因此，文档改名并同步更新链接后仍会通过；文件名不再承重。反过来，只改链接文字、链接到不存在的文件，或链接到真实但不覆盖所需语义的文档，都不能蒙混过关。

## 2. 面板 UI 门禁现在断言什么

`test/renderer/web-panel-ui/panelApp.test.tsx` 的分组和用例名已改为当前能力：

- 页脚明确说明已有账号凭据不会发送到浏览器，备注、分组与删除由服务器完成；
- 页面没有“复制凭据”按钮，展开“更多操作”后却必须有“编辑账号”和“删除账号”按钮；
- 展开区继续说明凭据不会显示或通过手机编辑；
- 点击“管理订阅”并成功读取方案后，必须提示订阅升级/管理仍需桌面端。

这保留了原测试要守住的桌面端边界，但不再错误否认手机面板已经具备的元数据编辑与带确认/限时撤销的删除能力。

## 3. 变异证据：两个门禁都能变红

### 3.1 文档坏链

临时把一个真实 Markdown 目标：

`](../security/network-exposure.md)`

改为：

`](../security/__missing-network-exposure__.md)`

然后按指定的 default + JSON 双 reporter 运行架构测试：

- Vitest 退出码：1；
- JSON：`numFailedTests=1`、`numPassedTests=6`；
- default reporter：失败原因为“安装文档含未解析到仓库真实文件的内部文档链接”，并点名 `../security/__missing-network-exposure__.md`。

恢复后对 `docs/deployment/linux-systemd.md` 做 SHA-256 字节校验：

- 变异前：`C8B7541C6F0F2EB3F81C8FF52699D28529917704C65F7D06BA87E22433E3769F`
- 恢复后：`C8B7541C6F0F2EB3F81C8FF52699D28529917704C65F7D06BA87E22433E3769F`

第一次试验只改到了 Markdown 的可见标签，没有改 `href`，门禁保持绿色。该结果被拒绝作为变异证据，因为“标签写什么”和“链接实际指向哪里”不是同一件事；随后才按上面的真实目标变异重跑。

### 3.2 面板陈旧文案

在负责的 UI 测试内临时把当前页脚断言换回已经失真的旧说法，再运行整个 `panelApp.test.tsx`：

- Vitest 退出码：1；
- JSON：`numFailedTests=1`、`numPassedTests=19`；
- default reporter：目标用例因找不到旧说法而失败，DOM 中显示的是当前真实文案。

测试文件随后按字节恢复，SHA-256 前后均为：

`56F135A799F077323D6635B830C8DDEA2D7DB707FBDBD412F48DBE5702A4D5A1`

## 4. 哪些字面断言保留，哪些替换

保留以下字面断言，因为它们本身就是操作合同，而不是偶然命名：

| 字面值 | 保留原因 |
|---|---|
| `Kiro-account-manager/` | npm 命令必须从固定嵌套包根执行，跑错 Git 根会直接失败。 |
| `^20.19.0 || >=22.12.0` | 精确支持的 Node 下限；同时由 `package.json#engines` 的独立断言锁定。 |
| `npm run release:server` | 唯一正式的服务器制品入口，不能用随手构建代替。 |
| `npm ci --omit=dev` | 目标机只安装生产依赖，避免把 Electron/构建依赖带入运行环境。 |
| `RELEASE.json.sourceTreeDirty` | 运维必须检查的精确发布溯源字段。 |
| `不得重启服务` | readiness 503 时保留管理面的承重禁令；按要求没有改弱或改成近义的模糊提示。 |

替换掉的只有文件名耦合：

- `tls-front-proxy.md`
- `firewall-exposure.md`
- `data-migration.md`

前两个从未对应真实文件，TLS 与暴露合同实际合并在当前网络暴露文档中；第三个目前存在，但同样只是可重命名的路径，不应比语义和可解析性更权威。它们统一由“所有内部文档链接真实可解析 + 所链接内容覆盖承重语义”替代。

## 5. 生产文件与文档核对

- 当前 `src/webPanel/App.tsx` 页脚与现有能力一致：已有账号凭据不下发，备注/分组/删除走服务器。
- 当前 `AccountCard` 确实提供编辑、带标识符确认的删除和 10 分钟撤销；凭据复制/编辑仍未暴露给浏览器。
- 当前订阅入口只读取方案，升级/管理仍明确引导到桌面端，测试保留了这条边界。
- 当前 Linux 安装文档的本地文档链接均能解析，TLS/暴露与迁移指引内容完整。

没有发现需要越权修改的生产文件或文档。文档仅在变异测试期间短暂改动，已用上述哈希证明逐字节恢复。

⚡ 传播检查：全仓语义检索并逐一核对了 `App.tsx`、`AccountCard.tsx`、`ProxyPanel.tsx` 与 `panelApp.test.tsx` 的桌面端/凭据能力消费者；陈旧的是测试断言，当前生产文案和组件能力一致，旧断言已从负责测试中移除。

## 6. 明确拒绝的做法

- 拒绝把断言简单改成另一个具体文件名：这只会把本次陈旧延后到下次重命名。
- 拒绝只断言“文档里出现 TLS/防火墙字样”：安装文档自身就可能含这些词，不能证明它把读者引到一个真实存在的操作文档。
- 拒绝删除 UI 覆盖：改为同时断言手机已具备的编辑/删除入口，以及仍属桌面端的凭据复制和订阅管理。
- 拒绝改生产文案来迁就旧测试：生产文案描述的是已交付现实，错误在测试。
- 未触碰另一个已知的 `webpanel_build_assets.test.ts` 红灯；其制品重建由父任务单独处理。

## 7. 最终验证

从嵌套代码目录按要求运行两个目标文件，使用 default + JSON 双 reporter，并读取两份输出：

- Test Files：2 passed / 0 failed；
- JSON：`numPassedTests=27`、`numFailedTests=0`；
- default reporter：架构 7/7、面板 UI 20/20。

附加检查：

- 两个测试文件 ESLint：退出 0；
- 两个测试文件 Prettier check：通过；
- 两个测试文件 `git diff --check`：通过（仅有 Git 的 LF→CRLF 提示，无空白错误）；
- 所有 JSON/log 临时文件均已删除。
