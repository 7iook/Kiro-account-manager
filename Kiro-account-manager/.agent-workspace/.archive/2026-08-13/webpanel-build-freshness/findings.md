# WebPanel build freshness — executor findings

```text
成功状态: NOT「装了一个 hook / 加了一个脚本」, BUT「改完手机面板源码的人不需要记得跑构建 —— 要么产物自动跟上，要么在他提交前就被挡下、并且提示里就是那一条命令」
          不该发生：手机浏览器加载到旧版面板，而全套件是绿的；也不该发生：全套件因此变慢，或门禁被削弱/删除
          来源: 用户原话「接续推进下一波」下的实测复发 —— 2026-08-13 同一原因两次变红（两次都靠人发现后手工 `npm run build:webpanel`）
                + 门禁自身文案 test/main/architecture/webpanel_build_assets.test.ts:123「面板产物旧于源码 —— 手机端拿到的仍是旧代码」
```

## Status

**DONE.** 采用“正常 `postinstall` 自动安装 + `pre-commit` 只按暂存区命中并自动构建”的机制。没有新增依赖，没有改测试入口，也没有把构建塞进全套件。

最终工作树改动：

- `scripts/postinstall.mjs`：源码 checkout 中调用 hook 安装器；服务端发布目录缺少安装器时保持原行为。
- `scripts/install-git-hooks.mjs`：从嵌套包根定位真实 Git 根与有效 hooks 目录，安装受管 wrapper；不覆盖外来 `pre-commit`。
- `scripts/pre-commit-webpanel.mjs`：仅当暂存区含 `src/webPanel/**` 的 A/C/M/R/D 变化时运行 `npm run build:webpanel`；失败则阻止提交并打印这条命令。
- `.git/hooks/pre-commit`：已在当前 checkout 真实安装（工作树外的本地装配产物）。
- 本报告。

产品代码、三个被点名的测试/配置、`docs/**`、`deploy/**` 均无最终差异；未创建 commit。

## Delivery-contract verification

| 链路节点 | producer 核验 | consumer 核验 | 结果 |
|---|---|---|---|
| 面板源码变更 | `src/webPanel/main.tsx:19-26` 是真实入口代码；`src/webPanel/index.html:15` 引入它 | `vite.webPanel.config.ts:46-61` 以 `src/webPanel` 为 root 并输出到 `out/webPanel`；`package.json:27` 暴露真实构建命令 | verified |
| 构建产物 | `package.json:27` → `vite.webPanel.config.ts:60-62` | `src/main/webPanel/server.ts:31,332-342` 调用静态托管；`src/main/utils/webPanelAssetRoot.ts:95-104` 指向真实入口；`test/main/architecture/webpanel_build_assets.test.ts:82-128` 做现有新鲜度门禁 | verified |
| 新鲜度强制点 | `scripts/postinstall.mjs:59-79` → `scripts/install-git-hooks.mjs:94-120` 安装；`scripts/pre-commit-webpanel.mjs:49-87` 判暂存区并构建 | Git 真实 `pre-commit` 流程；本机生成的 `.git/hooks/pre-commit:4` 调用仓内脚本 | built and verified |
| 最终 sink | 恢复后真实执行 `npm run build:webpanel` | `out/webPanel/index.html:12` 引用 `out/webPanel/assets/index-BVaY0PP_.js`，静态服务器按上述调用链发送给手机 | verified |

链路没有 producer-only / consumer-only 断点。

## 机制选择与两个已知坑

### 选择

强制点不判断“产物是不是旧”，而判断“这次提交是否暂存了面板源码”：

1. `postinstall` 在正常开发依赖安装时把一个很薄的 wrapper 写入 Git 实际 hooks 目录。
2. `pre-commit` 用 `git diff --cached --quiet --diff-filter=ACMRD -- <包相对路径>/src/webPanel`。
3. 命中后无条件运行一次 `npm run build:webpanel`，并确认 `out/webPanel/index.html` 存在。
4. 构建失败时提交失败，提示包含唯一修复命令：`npm run build:webpanel`。
5. 未命中时只做一次 Git 暂存区查询，不跑 Vite、不跑测试。

理由：这是提交事实的单一入口，不需要给 ignored 产物发明额外状态文件，也不依赖 Husky/lefthook 等新依赖。

### `git checkout` 刷新 mtime

新强制点完全不读 mtime。checkout 只改工作树时间、不产生暂存区 diff，因此不会触发构建或阻止提交。实测无相关暂存变化时：

```text
HOOK_EXIT=0
UNRELATED_HOOK_MS=444.4
ENTRY_MTIME_UNCHANGED=True
```

现有 `webpanel_build_assets.test.ts` 的 mtime 断言保持原样，仍只是全套件中的既有诊断层；本轮没有把它复用为提交强制判据，因此没有把它记录的 checkout 假红升级成每次提交都误报。

### `.ace-tool/` 等缓存

新强制点不递归文件系统，只看 Git 暂存区。ignored/untracked 的 `.ace-tool/` 不会进入该查询；缓存 mtime 再新也不会触发。即使缓存持续写入，跑 `npm run build:webpanel` 后也不存在“仍然红”的循环。

## Real E2E: red → green → restore

为了走真实 `git commit` 又遵守“不 commit”，探针期间临时安装了一个总是退出 1 的 `commit-msg` hook。这样 `pre-commit` 会真实执行，但对象写入前必定中止；探针后已删除该临时 blocker。

### Red（机制尚不存在）

基线：

```text
src/webPanel/main.tsx SHA256
72533B17C2E4AE319B98B61B788409A6E20CA5773FFB953600879CA9ED7EADF5

out/webPanel/index.html mtime
2026-08-13T02:00:37.9057354Z
SHA256
35197EF4D7451B119B3906A2C3C1CF9DBA17EAECA0DE3A629E5DC6C879E00152
```

把真实源码 `WEBPANEL_BUILD_MARKER` 暂时改为 `kiro-webpanel-bundle-ok-e2e-probe`、`git add` 后执行：

```text
git commit -m "test: webpanel hook red probe"
```

结果：

```text
[webpanel-hook-e2e] intentionally aborting probe commit
PROBE_COMMIT_EXIT=1
HEAD=5a09453fe052e93be662e4fe8980f37484e7da0d
ENTRY_MTIME_UTC=2026-08-13T02:00:37.9057354Z
ENTRY_SHA256=35197EF4D7451B119B3906A2C3C1CF9DBA17EAECA0DE3A629E5DC6C879E00152
```

失败原因正确：真实提交路径没有任何 pre-commit 构建，产物逐字节、mtime 都没动。

### Green（安装最终 pre-commit）

在同一个已暂存源码探针上再次执行真实 `git commit`：

```text
[pre-commit] 检测到已暂存的 src/webPanel/ 变更，自动运行 `npm run build:webpanel`。
> vite build --config vite.webPanel.config.ts
✓ 37 modules transformed.
../../out/webPanel/assets/index-BvVslnxJ.js   240.47 kB
✓ built in 682ms
[pre-commit] 手机面板产物已更新。
[webpanel-hook-e2e] intentionally aborting probe commit
PROBE_COMMIT_EXIT=1
HEAD=5a09453fe052e93be662e4fe8980f37484e7da0d
ENTRY_MTIME_UTC=2026-08-13T03:00:48.5344778Z
```

`pre-commit` 在真实提交过程中自动重建；随后临时 `commit-msg` blocker 按设计阻止对象落库，所以满足“不 commit”。

### Restore（逐字节）

恢复源码原字面量、重新 `git add` 让 index 回到 HEAD，再重建原始产物：

```text
SOURCE_SHA256=72533B17C2E4AE319B98B61B788409A6E20CA5773FFB953600879CA9ED7EADF5
ENTRY_SHA256=35197EF4D7451B119B3906A2C3C1CF9DBA17EAECA0DE3A629E5DC6C879E00152
SOURCE_RESTORED_EXIT=0
HEAD=5a09453fe052e93be662e4fe8980f37484e7da0d
```

源码 hash 与探针前一致；恢复后入口产物 hash 也与探针前一致。临时 `commit-msg` hook 已删除。

## Verification

按指定双 reporter / 重定向姿势运行，读取 JSON 的 `numFailedTests` 与 default 日志后删除临时文件：

```text
npx vitest run test/main/architecture/webpanel_build_assets.test.ts test/main/architecture/postinstall_conditional.test.ts test/main/architecture/server_delivery_contract.test.ts --reporter=default --reporter=json --outputFile.json=<tmp>.json *> <tmp>.log

VITEST_EXIT=0
numFailedTests=0
Test Files  3 passed (3)
Tests       27 passed (27)
```

额外验证：

```text
npm run postinstall
[git-hooks] pre-commit 已是最新：F:\Kiro-account-manager\.git\hooks\pre-commit
electron-builder install-app-deps completed

npx eslint scripts/install-git-hooks.mjs scripts/pre-commit-webpanel.mjs scripts/postinstall.mjs
exit 0

npx prettier --check scripts/install-git-hooks.mjs scripts/pre-commit-webpanel.mjs scripts/postinstall.mjs package.json
All matched files use Prettier code style!

node --check <三个脚本>
exit 0
```

全套件未运行：本轮改动不接入 `test`、不修改 Vitest 配置，针对性覆盖为 27/27；因此不能把“全套件全绿”冒充为已验证事实。它不会因本机制变慢这一点由配置差异直接成立：测试脚本和 `vitest.config.ts` 零改动。

## Rejected approaches

1. **把 mtime 判据搬进 pre-commit**：驳回。checkout 假红与缓存永远更新会直接复制现有两个已知坑。
2. **每次 `npm test` 先 build**：驳回。它把局部提交问题转嫁给全套件，明确违反“不让全套件变慢”。
3. **只阻止并要求人手工 build**：驳回。`out/` ignored，单纯运行构建后没有可靠的暂存态证据让下一次 hook 放行；需要再造 stamp。自动构建更短、更可靠。
4. **新增 Husky/lefthook/simple-git-hooks 依赖**：驳回。本仓只有一个小 hook，Node + Git 已足够；新增依赖和 lockfile 变化没有业务收益。
5. **独立 `prepare` lifecycle**：实现中发现后驳回并撤销。`scripts/package-server-release.mjs:47-50` 会把 `package.json` 与 `postinstall.mjs` 放进服务端制品，却不复制 hook 安装器；目标机 `npm ci --omit=dev` 会引用缺失脚本。最终接入既有 `postinstall`，并以安装器存在性区分源码 checkout / 服务端制品。
6. **覆盖未知现有 pre-commit**：驳回。安装器遇到非本项目管理的 hook 会失败并要求人工合并，不静默删除别人的门禁。

## Review Findings

- Tier 1 自校正：dispatch 写的 HEAD `e5a42e0` 已被一个纯文档提交推进为 `5a09453`；相关构建/门禁代码在两者间无变化，按当前 HEAD 执行。
- Tier 1 自校正：全仓并非字面“完全干净”，存在多批先前未跟踪调查产物；已跟踪工作树在本轮开始时干净。本轮没有触碰那些既有项。
- 发现并纠正一次跨链装配错误：初稿 `prepare` 会弄坏服务端发布包安装，最终未保留。
- 发现并纠正一次 Windows 进程错误：直接 `spawnSync npm.cmd` 返回 `EINVAL`；最终用固定字面量经 `cmd.exe /d /s /c` 执行，无参数注入面、无 Node deprecation warning。
- 发现并纠正一次嵌套仓路径错误：`git ls-files` 从包根执行时必须使用 `:(top,literal)`；最终 `npm run postinstall` 真跑验证安装成功。
- ⚡ 契约关键词检查：语义检索列出 `WEBPANEL_BUILD_MARKER` 定义及测试消费点；临时探针最终恢复，`git diff -- src/webPanel` 为零，probe 字面量在产品源码中无残留。
- 最终跨域改动仅构建/hook：`scripts/postinstall.mjs`、`scripts/install-git-hooks.mjs`、`scripts/pre-commit-webpanel.mjs`。产品、测试、文档、部署文件均未改。
- 现有 mtime 单测的 checkout 噪声仍是已知限制；本轮范围不授权改其判据。关键改进是新提交强制点不依赖它。
- 显式绕过风险：`git commit --no-verify` 或 `npm --ignore-scripts` 能绕过任何本地 hook；这是 Git/npm 的主动逃生门，不被伪装成已消除。正常安装与正常提交路径已闭环。

## Update Log

- 2026-08-13 11:20 UTC+8 · executor · 以暂存区驱动的自动 build pre-commit 闭环替换 BLOCKED 报告；真实 commit red/green、源码/产物 SHA256 恢复、27/27 定向回归均有证据；未 commit。
