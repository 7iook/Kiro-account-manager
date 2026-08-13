# 生产依赖 lock refresh 执行报告

> [交付契约 · 成功状态原文]
>
> 成功状态: NOT「npm audit 清零」, BUT「部署到 Linux 服务器上的那棵生产依赖树没有已知公告，而反代的流式、代理、429 重试与自签证书生成行为一个不变」
>           不该发生：为了清 audit 而升出行为回归；不该发生：package.json 的 semver 范围被悄悄放宽以够到新版本
>           来源: 用户「接续推进下一波」+ 昨日真机容器安装实测报出 15 项公告（.agent-workspace/.archive/2026-08-13/deploy-release-contract/findings.md）

日期：2026-08-13  
Git HEAD：`edcb42c`  
执行者：executor  
最终结论：**PASS**。生产 lockfile 已在原 semver 范围内刷新；Linux `npm ci --omit=dev` 的实际安装树审计为 0，重点热路径、全套件、类型检查、服务端构建和容器启停合同均通过。

## 1. 交付契约逐项核验

| 节点 | producer 核验 | consumer 核验 | 结果 |
|---|---|---|---|
| 依赖版本 | `package-lock.json` 根清单仍保留原范围；具体安装节点见 `undici`、`node-forge` 等 lock 节点 | `scripts/package-server-release.mjs:21-29,47-49,71` 原样复制 package/lock 并声明 `npm ci --omit=dev`；`docs/deployment/linux-systemd.md:81-87` 在目标机消费 | 连通 |
| `undici` | `package-lock.json:12152-12159` 锁为 `7.29.0` | `src/main/upstreamApi/transport.ts:33,136-178,207-220` 的 `undiciFetch`、账号代理与应用代理路径；反代路径另见 `src/main/proxy/kiroApi.ts` | 连通 |
| `node-forge` | `package-lock.json:9774-9781` 锁为 `1.4.0` | `src/main/proxy/selfSignedCert.ts` 生成自签证书；`test/main/proxy/proxyServerDataPathInjection.test.ts:65-119` 真实生成证书并启动 HTTPS | 连通 |
| 审计洁净度 | 本轮生成的 `package-lock.json` | 本轮部署前检查与 Linux 容器内 `npm audit --omit=dev` 实际消费；未来发布流程尚未新增自动 gate | 本轮连通；自动化 gate 未宣称已建 |
| 最终 sink | 根 `package.json` + 刷新后的 lockfile | Linux `/work/node_modules`，由 Node 22 容器中的 `npm ci --omit=dev` 生成 | 已实跑 |

真实 e2e 姿势也已逐项核验：一次性 Linux 容器内安装生产树、执行生产审计、启动 `out/server/index.js`、请求 `/panel/readyz`、发送 SIGTERM 并等待退出。

## 2. 实际变更与版本迁移

执行命令：

```text
npm audit fix --omit=dev --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org
```

命令未使用 `--force`。`git diff --exit-code -- package.json` 为 0；根 manifest 字节未变，因而没有放宽任何 semver 范围。

按风险顺序列出生产树迁移：

| 顺序 | 包 | 迁移 |
|---:|---|---|
| 1 | `undici` | `7.28.0` → `7.29.0` |
| 2 | `node-forge` | `1.3.3` → `1.4.0` |
| 3 | `ip-address` | `10.2.0` → `10.5.0` |
| 4 | `uuid` | `13.0.0` → `13.0.2` |
| 5 | `ajv` | `8.17.1` → `8.20.0`（`conf` / `ajv-formats` 两个 lock 节点） |
| 6 | `fast-uri` | `3.1.0` → `3.1.5` |
| 7 | `electron-updater` | `6.6.2` → `6.8.9` |
| 8 | `builder-util-runtime` | `9.3.1` → `9.7.0` |
| 9 | `js-yaml` | `4.1.1` → `4.3.1` |
| 10 | `piscina` | `5.1.4` → `5.3.0` |
| 11 | `vite` | `7.2.6` → `7.3.6` |
| 12 | `rollup` | `4.53.3` → `4.62.4` |
| 13 | `postcss` | `8.5.6` → `8.5.26` |
| 14 | `picomatch` | `4.0.3` → `4.0.5` |
| 15 | `nanoid` | `3.3.11` → `3.3.18` |

刷新后的实际生产链由 `npm ls --omit=dev --all ...` 读取：

```text
@tailwindcss/vite@4.1.17 -> vite@7.3.6
  -> picomatch@4.0.5
  -> postcss@8.5.26 -> nanoid@3.3.18
  -> rollup@4.62.4
conf@15.0.2 -> ajv@8.20.0 -> fast-uri@3.1.5
electron-updater@6.8.9 -> builder-util-runtime@9.7.0, js-yaml@4.3.1
node-forge@1.4.0
socks@2.8.9 -> ip-address@10.5.0
tlsclientwrapper@4.2.0 -> piscina@5.3.0
undici@7.29.0
uuid@13.0.2
```

没有任何 major 迁移。lock diff 为 `697 insertions / 144 deletions`；除上述公告包外，resolver 的关联变化包括：

- `@types/estree 1.0.8 → 1.0.9`，随 Rollup 更新；
- Rollup 的平台可选包统一到 `4.62.4`，并增加新平台条目及可选 `@napi-rs/lzma-linux-x64-gnu@1.5.1`；
- Vite 7.3.6 新增其私有 `esbuild@0.28.2` 及平台可选节点；
- npm 重新标注部分 `dev` / `optional` 元数据，并将本轮更新节点的 resolved URL 写为官方 registry。

这些关联节点也经过完整 `npm ci`、构建和 Linux 生产安装验证，不是只审了 15 个顶层版本号。

## 3. 审计清零证据

刷新前基线直接采用已授权的侦察结果：

```text
15 package findings
2 moderate / 13 high
```

刷新后本机显式执行：

```text
npm audit --omit=dev --registry=https://registry.npmjs.org --json
```

JSON 读数：

```json
{
  "info": 0,
  "low": 0,
  "moderate": 0,
  "high": 0,
  "critical": 0,
  "total": 0
}
```

同一份 package/lock 在 Linux 容器经 `npm ci --omit=dev` 后再次运行官方 registry 审计，输出同样为：

```text
found 0 vulnerabilities
```

因此“清零”不是只发生在 Windows 开发树，而是发生在最终要求的 Linux 生产安装树。

## 4. 热路径与全量回归读数

### 4.1 重点组

依约使用 default + JSON 双 reporter，覆盖以下 9 个文件：

- `test/main/upstreamApi/createUpstreamApi.test.ts`
- `test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts`
- `test/main/proxy/safetyNetWiring.test.ts`
- `test/main/proxy/streamWatchdog.test.ts`
- `test/main/proxy/endpointChainRetry.test.ts`
- `test/main/proxy/quotaFalsePositive429.test.ts`
- `test/main/proxy/holdGateStreamWiring.test.ts`
- `test/main/proxy/holdGateMultiPathWiring.test.ts`
- `test/main/proxy/proxyServerDataPathInjection.test.ts`

JSON：

```text
numTotalTests=128
numPassedTests=128
numFailedTests=0
numPendingTests=0
success=true
```

default reporter：

```text
Test Files  9 passed (9)
Tests       128 passed (128)
Duration    14.28s
```

行为读数：

- 代理优先级：账号绑定代理、K-Proxy、环境/用户代理及后续回落合同均通过；
- 流式：真实 `ReadableStream` 字节透传、Claude/OpenAI Responses/Gemini 流式接线和无重复输出通过；
- 看门狗：首字节、chunk 间静默、背压、abort 联动和 timer 清理通过；
- 429：概率式限流不误标额度耗尽、冷却保留、传输/端点整体重试边界通过；应用源码未改，默认 `8 次 / 400ms / fast` 配置未漂移；
- 自签 TLS：真实生成 PEM、重生成指纹变化、证书落盘并启动 HTTPS 通过。

说明：这组没有使用真实 Kiro 账号向公网发一条付费请求；“真流式”证据是实际 Web `ReadableStream` / 反代响应生命周期，而非纯静态源码断言。依赖更新任务未被授权使用生产凭据。

### 4.2 全套件

命令：

```text
npx vitest run --reporter=default --reporter=json --outputFile.json=<tmp>.json *> <tmp>.log
```

从 JSON 读取：

```text
numTotalTests=1766
numPassedTests=1760
numFailedTests=0
numPendingTests=6
success=true
```

default reporter：

```text
Test Files  164 passed | 1 skipped (165)
Tests       1760 passed | 6 skipped (1766)
Duration    61.07s
```

与题述基线 `1766 total / 1760 passed / 0 failed / 6 pending` 完全一致。所有 Vitest 临时 JSON/log 在读数后均已删除。

### 4.3 类型与构建

```text
npm run typecheck
EXIT=0
node typecheck=PASS
web typecheck=PASS
```

```text
npm run build:server
EXIT=0
vite v7.3.6 server: 80 modules, out/server/index.js 755.58 kB
vite v7.3.6 webPanel: 37 modules, build PASS
```

`git diff --check -- package-lock.json` 退出 0；仅有仓库既存的 Windows LF/CRLF 提示，无 whitespace error。

## 5. Linux 生产树 e2e

环境：

```text
Docker 29.5.3
image=node:22.20.0-bookworm
repo mount=readonly
container lifecycle=--rm
```

容器内按最终 sink 顺序实跑：

1. 把根 `package.json`、刷新后的 `package-lock.json`、生产 `postinstall`、刚构建的 server/WebPanel 放入空 `/work`；
2. `npm ci --omit=dev --registry=https://registry.npmjs.org`；
3. 验证 `node_modules/electron` 不存在；
4. `npm audit --omit=dev --registry=https://registry.npmjs.org`；
5. 启动 `node --enable-source-maps out/server/index.js`；
6. 请求 `/panel/readyz`；
7. 发送 SIGTERM，等待进程退出并检查停机日志。

关键输出：

```text
added 111 packages, and audited 112 packages
found 0 vulnerabilities

node-forge@1.4.0
undici@7.29.0
uuid@13.0.2

READYZ status=503 body={"status":"not_ready"}
[server] 收到 SIGTERM，开始停机...
[server] 已停机
CONTAINER_E2E=PASS
```

空数据目录、`proxyConfig.enabled=false` 时 readyz=503 是既有合同中的正确降级态：面板已监听，反代尚未监听；它不是启动失败。SIGTERM 后进程退出码为 0。命令结束后 `docker ps` 无该镜像运行容器，`--rm` 已销毁容器工作目录。

## 6. Review Findings

### 已纠正的派单偏差

Tier 1 自校正：派单称工作树干净且本轮改动应为唯一脏项，实际起手即存在：

- 已跟踪修改：`.agent-workspace/TASKS-2026-08-13.md`；
- 多个既有未跟踪归档、临时 JSON、`.codegraph/` 等。

`package.json` 与 `package-lock.json` 起手均无 diff，HEAD 也确为 `edcb42c`，所以该偏差不影响依赖刷新。本轮没有碰、暂存、stash 或回退这些既有项。

### 契约传播复核

按动作闸门补跑 `git grep`，逐项枚举了依赖合同的消费点：

- manifest 范围：`package.json` 中 `undici` / `node-forge` 仍是原范围；
- 运行时：`src/main/index.ts`、`ipc/proxyPool.ts`、`proxy/kiroApi.ts`、`proxy/proxyServer.ts`、`proxy/systemProxy.ts`、`upstreamApi/*` 等 Undici 消费点；
- 证书：`proxy/selfSignedCert.ts` 与 `kproxy/certManager.ts` 的 node-forge 消费点；
- 部署：release packager、postinstall、Linux 文档和部署合同测试中的 `npm ci --omit=dev` 消费点；
- 回归：Undici mock/错误形状、无 Electron 生产树和真实 ProxyTLS 测试。

针对旧热包制品条目执行精确检索，结果为：

```text
undici-7.28.0.tgz: 0
node-forge-1.3.3.tgz: 0
```

lockfile 中仍有别的包恰好使用通用版本号 `7.28.0` / `1.3.3`（如 Babel helper、`array.prototype.flat`）；它们不是旧 Undici/node-forge 节点，不能机械删除。消费点无需改源码，均通过同一包名解析到新 lock 节点。

### TDD / 变更边界

TDD red→green **跳过**：本轮只更新 npm 生成的第三方 lockfile，不新增或修复业务实现；按 test-first gate 的 generated/config 例外处理。替代证据是刷新后重点组、全套件、类型检查、构建和 Linux 生产安装 e2e。

本轮实际写入：

- `package-lock.json`；
- 本报告（派单明确要求的持久化输出）。

未修改：

- `package.json`；
- `src/**`、`test/**`、`docs/**`、`deploy/**`；
- Git 配置、暂存区和提交历史。

### 驳回、停止点与剩余风险

- 没有需要停止的包：全部修复均落在现有 semver 范围和原 major 内。
- 未使用 `--force`，未接受 manifest range widening；这两条路径均不需要。
- lockfile 是声明式解析结果，15 项由一次已在侦察中验证过的默认 resolver 事务完成；风险核验和回归严格按 `undici → node-forge → 其余` 顺序进行。
- 未来发布流程里仍没有持久化的自动 `npm audit --omit=dev` gate；本轮约束只允许 lockfile，故只实跑并记录证据，没有越权修改发布脚本或文档。
- 根 manifest 仍把桌面/构建依赖带进服务器生产安装树；这是侦察已识别的独立架构债，不应混入本次安全补丁。

## Update Log

- 2026-08-13 · executor：在不改 manifest 范围的前提下刷新生产 lock，15 项公告归零；重点组 128/128、全套件 1760 passed/0 failed/6 pending、typecheck/build 和 Linux `npm ci → audit → readyz → SIGTERM` 全部通过；无 commit。
