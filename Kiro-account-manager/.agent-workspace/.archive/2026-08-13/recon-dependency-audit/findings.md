# 生产依赖安全告警可达性侦察

日期：2026-08-13  
Git HEAD：`edcb42cdc302a705a66e636b522b00a2e48a70e6`  
代码根：`F:\Kiro-account-manager\Kiro-account-manager`  
范围：仅评估 `npm ci --omit=dev` 得到的生产依赖树；未升级、未编辑依赖清单、未暂存、未提交。

## 结论

- 使用单命令注册表覆盖 `--registry=https://registry.npmjs.org`，从官方 npm audit 端点复现了原记录的 **15 个包级 finding（2 moderate、13 high）**。这 15 项聚合了 38 条 advisory 记录；npm 的“15”不是 15 个独立 CVE。
- 15 个包中，**5 个会随服务端 bundle 顶层加载**（`ajv`、`fast-uri`、`node-forge`、`undici`、`uuid`），**1 个仅在配置 SOCKS 出口时加载**（`ip-address`），**9 个不会被生产服务端加载**，只是共享根 `package.json` 把桌面/构建依赖带进了服务器安装树。
- 在当前源码调用面上，**未发现任何一条 advisory 的受影响原语可由该部署路径触发**。这不等于可以长期忽略：`undici` 是真实的上游 AI 数据面热路径，应该最先修；其余项按下表暴露度排序。
- 所有 15 项都存在**不跨 major**的修复。一次性 Linux 容器中执行默认（无 `--force`）`npm audit fix --omit=dev` 后为 0 vulnerability，根 `package.json` 字节未变；15 个受影响包也全部保持原 major。
- 当前工作树并非 dispatch 所称的 clean：`git status` 显示既有的 unrelated 修改/未跟踪文件；但 HEAD 正确，且 `package.json` / `package-lock.json` 对工作树及昨天容器基线 `26dfc576...` 均无 diff，因此不影响本报告的依赖结论。

## 1. Plan assumptions list

1. 昨天 Linux 容器中的 15 项仍能由当前 lockfile 复现。
2. “在 `--omit=dev` 树里”不等于“会被 `out/server/index.js` 加载”，必须分别核验安装可达、模块加载可达、漏洞原语可达。
3. 当前服务部署在 Linux、面板经 TLS 终止反代供手机访问；服务自身默认 loopback，数据面向上游 AI API 发请求。
4. 修复可能要求 breaking major；需用真实 resolver 结果验证，而不是根据 `fixAvailable: true` 猜测。
5. 昨天制品与当前 lockfile 可能已经漂移；需先核验依赖文件差异。

## 2. Reality verification (plan vs reality)

### 2.1 命令证据

基线与依赖文件：

```text
> git rev-parse HEAD
edcb42cdc302a705a66e636b522b00a2e48a70e6

> git diff -- package.json package-lock.json
(no output)

> git diff 26dfc5765368b1e5fdb27de2eb255d10bfb4c523..HEAD -- package.json package-lock.json
(no output)
```

官方 registry 的生产树审计（没有修改 npm 全局配置）：

```text
> npm audit --omit=dev --json --registry=https://registry.npmjs.org
PACKAGE_FINDINGS=15 ADVISORY_RECORDS=38 MODERATE=2 HIGH=13
```

当前受影响包版本与生产依赖链：

```text
> npm ls --omit=dev --all ajv builder-util-runtime electron-updater fast-uri ip-address js-yaml nanoid node-forge picomatch piscina postcss rollup undici uuid vite

@tailwindcss/vite@4.1.17 -> vite@7.2.6
  -> picomatch@4.0.3
  -> postcss@8.5.6 -> nanoid@3.3.11
  -> rollup@4.53.3
conf@15.0.2 -> ajv@8.17.1 -> fast-uri@3.1.0
electron-updater@6.6.2 -> builder-util-runtime@9.3.1, js-yaml@4.1.1
node-forge@1.3.3
socks@2.8.9 -> ip-address@10.2.0
tlsclientwrapper@4.2.0 -> piscina@5.1.4
undici@7.28.0
uuid@13.0.0
```

实际服务端 bundle 顶层 external：

```text
out/server/index.js:6  require("conf")
out/server/index.js:7  require("uuid")
out/server/index.js:8  require("undici")
out/server/index.js:11 require("node-forge")
```

加载 bundle（不启动监听）后的 Node 模块缓存：

```text
ajv CACHE_FILES=146
fast-uri CACHE_FILES=3
node-forge CACHE_FILES=42
undici CACHE_FILES=110
uuid CACHE_FILES=1

ip-address CACHE_FILES=0
js-yaml CACHE_FILES=0
nanoid CACHE_FILES=0
picomatch CACHE_FILES=0
piscina CACHE_FILES=0
postcss CACHE_FILES=0
rollup CACHE_FILES=0
vite CACHE_FILES=0
builder-util-runtime CACHE_FILES=0
electron-updater CACHE_FILES=0
socks CACHE_FILES=0
tlsclientwrapper CACHE_FILES=0
```

一次性 Linux 容器中的默认修复实验；容器退出后工作目录自动销毁，仓库只读挂载：

```text
> npm audit fix --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
added 3 packages, changed 20 packages, and audited 111 packages
found 0 vulnerabilities

ajv                 8.17.1 -> 8.20.0
builder-util-runtime 9.3.1 -> 9.7.0
electron-updater     6.6.2 -> 6.8.9
fast-uri              3.1.0 -> 3.1.5
ip-address           10.2.0 -> 10.5.0
js-yaml                4.1.1 -> 4.3.1
nanoid                3.3.11 -> 3.3.18
node-forge             1.3.3 -> 1.4.0
picomatch              4.0.3 -> 4.0.5
piscina                5.1.4 -> 5.3.0
postcss                8.5.6 -> 8.5.26
rollup                4.53.3 -> 4.62.4
undici                7.28.0 -> 7.29.0
uuid                  13.0.0 -> 13.0.2
vite                   7.2.6 -> 7.3.6

ROOT_PACKAGE_JSON_CHANGED=false
```

因此，表中每一项的“无需 major”都由 resolver 真执行支持，而不是只依赖 audit 的布尔字段。

### 2.2 Findings table

“包可达”表示服务端进程是否加载/调用该包；“漏洞原语”进一步判断 advisory 描述的受影响功能是否出现在当前调用面。优先级按题述 Linux + TLS 终止反代 + 上游 AI 数据面部署评定。

| 优先级 | 包（当前版本；生产链） | npm 严重度 / advisory | 包可达 | 漏洞原语与真实部署暴露 | 已验证修复；major？ |
|---:|---|---|---|---|---|
| 1 | `undici@7.28.0`（direct） | high；5 条：`GHSA-8xcm-r25x-g524`、`GHSA-4cwx-7wf7-3272`、`GHSA-m8rv-5g2x-5cg5`、`GHSA-jr45-8vmc-qm54`、`GHSA-v3r7-h72x-cjcm` | **是，热路径**。bundle 顶层加载；上游 API、账号 API、代理出站和客户端给出的 HTTP 图片 URL 都会走 fetch。 | **当前不可触发受影响原语**：源码没有 `interceptors.retry()` / `interceptors.cache()`；重试是应用层重复调用 fetch；所有 Undici 调用都是 `fetch`（CRLF advisory 明确说 fetch 不受影响）；POST body 是字符串或 `Buffer`，没有 duck-typed Blob；没有 Undici `setCookie` 调用。尽管如此，它直接面对远端上游响应，是真实暴露最高的一项。 | `7.29.0`；**无需 major** |
| 2 | `node-forge@1.3.3`（direct） | high；4 条：`GHSA-2328-f5f3-gj25`、`GHSA-q67f-28xg-22rw`、`GHSA-5m6q-g25r-mvwx`、`GHSA-ppp5-5v6c-4jwp` | **是，启动即加载；功能冷路径**。K-Proxy 与反代自签证书模块静态 import 它。 | 当前部署在前置反代终止 TLS，服务内 TLS 默认不用；K-Proxy 在 headless 装配中只构造、不启动。源码只生成/解析/签发本地 RSA 证书：没有 `verifyCertificateChain`、Ed25519 verify 或 RSA `publicKey.verify`。RSA 生成可在内部用 `modInverse`，但输入是库生成的非零素数，不接受远端零值。 | `1.4.0`；**无需 major** |
| 3 | `ip-address@10.2.0`（`socks`） | high；3 条：`GHSA-mwp4-54f8-5fhr`、`GHSA-4xrf-jv44-h6hh`、`GHSA-22jq-vg5j-6vgg` | **条件可达**：启动不加载；只有账号/环境出口配置为 SOCKS 时，`safeCreateProxyAgent` 才动态加载 `socks`，继而加载本包。 | `socks` 只用 `Address4/Address6` 做地址字节转换/IPv6 canonical form，且 IPv4 构造前先经过 Node `net.isIPv4`；没有把 `isPrivate` / special-use / CIDR 分类结果当 SSRF 或信任边界。当前 advisory 的分类绕过不参与安全决策。 | `10.5.0`；**无需 major** |
| 4 | `uuid@13.0.0`（direct） | moderate；`GHSA-w5hq-g745-h8pq` | **是，热路径**。反代响应 ID、会话 ID、上游 invocation ID 使用它。 | advisory 仅影响带外部 buffer/offset 的 `v3()`、`v5()`、`v6()`；服务端闭包全是无 buffer 参数的 `v4()`。受影响 API 不可达。 | `13.0.2`；**无需 major**（最小补丁为 `13.0.1`） |
| 5 | `ajv@8.17.1`（`conf`，两个安装节点） | moderate；`GHSA-2g4f-4pwh-qvx6` | **是，启动加载**。`conf` 顶层 import Ajv。 | advisory 必须启用 `{$data: true}`。服务端 `new Conf` 只传 `cwd/configName/encryptionKey`；`conf` 的 `#setupValidator` 在没有 `schema`、`ajvOptions`、`rootSchema` 时直接返回，根本不构造 Ajv。 | `8.20.0`；**无需 major** |
| 6 | `fast-uri@3.1.0`（`conf -> ajv`） | high；5 条 host-confusion/path-traversal advisory | **是，随 Ajv 模块加载**。 | 同上，当前没有 Ajv 实例、schema 编译或 URI resolver 调用；攻击者控制的 URI 不进入该包。 | `3.1.5`；**无需 major** |
| 7 | `electron-updater@6.6.2`（direct） | high；由 `builder-util-runtime` finding 传播 | **否**。服务端 Vite 配置把 `electron` / `electron-updater` 定为 forbidden import，解析到即构建失败；运行缓存为 0。 | 仅桌面自动更新器路径；headless Linux 服务没有更新器调用。 | `6.8.9`；**无需 major** |
| 8 | `builder-util-runtime@9.3.1`（`electron-updater`） | high；`GHSA-p2f4-r6v6-j797` | **否**。 | advisory 是跨源更新重定向泄漏 updater 凭据；服务端不加载 updater。 | `9.7.0`（由 `electron-updater@6.8.9` 带入）；**无需 major** |
| 9 | `js-yaml@4.1.1`（`electron-updater`） | high；3 条 YAML CPU DoS advisory | **否**。 | 服务端不加载 updater，也没有该链的 YAML 解析入口。 | `4.3.1`；**无需 major** |
| 10 | `piscina@5.1.4`（`tlsclientwrapper`） | high；`GHSA-x9g3-xrwr-cwfg` | **否**。`tlsclientwrapper` 只由桌面注册模块引用，未进入 server assembly/bundle；两者运行缓存均为 0。 | advisory 的 inherited `options.filename` worker 启动路径不存在于 headless 服务。 | `5.3.0`；**无需 major** |
| 11 | `vite@7.2.6`（生产中由 `@tailwindcss/vite` peer 链保留） | high；5 条 dev-server/path advisory | **否**。 | 已部署进程运行 `node out/server/index.js`，不启动 Vite dev server。其问题只在构建/开发阶段。 | `7.3.6`；**无需 major** |
| 12 | `rollup@4.53.3`（`vite`） | high；`GHSA-mw96-cpmx-2vgc` | **否**。 | 任意文件写是构建输出路径问题；运行中的服务器不加载 Rollup。 | `4.62.4`；**无需 major** |
| 13 | `postcss@8.5.6`（`vite`） | high；4 条 XSS/任意文件读 advisory | **否**。 | 只在 WebPanel CSS 构建时使用；服务器只托管已经构建好的静态文件。 | `8.5.26`；**无需 major** |
| 14 | `picomatch@4.0.3`（`vite -> fdir/tinyglobby`） | high；2 条 glob method-injection/ReDoS advisory | **否**。 | 只在构建文件匹配中使用；无运行时 glob 输入。 | `4.0.5`；**无需 major** |
| 15 | `nanoid@3.3.11`（`vite -> postcss`） | high；2 条负数/零长度生成器死循环 advisory | **否**。 | 服务端不加载 PostCSS；运行时 ID 使用 `uuid.v4` / Node `randomUUID`，不调用 nanoid。 | `3.3.18`；**无需 major** |

### 2.3 关键源码锚点

- `scripts/package-server-release.mjs:21-29,47-49,71`：发布包原样复制根 `package.json` / lockfile，并让目标机执行 `npm ci --omit=dev`。这解释了为何桌面与构建依赖出现在生产树。
- `vite.server.config.ts:54-63,79-103`：`electron-updater` 不只是 external，而是服务端闭包一旦解析到就构建失败。
- `vite.server.config.ts:109-133`：除 Electron-only 外，根 `dependencies` 全部 external；因此“安装了”仍需靠 bundle 图判断“会不会 require”。
- `out/server/index.js:1-23`：真实产物的顶层 external 只有 `conf`、`uuid`、`undici`、`node-forge` 等运行包，没有 Vite/updater/tlsclientwrapper。
- `src/main/persistence/accountStore.conf.ts:78-93` 与 `node_modules/conf/dist/source/index.js:527-547`：Conf 没传 schema/Ajv options，validator 分支直接返回。
- `src/main/proxy/systemProxy.ts:134-207` 与 `node_modules/socks/build/common/helpers.js:147-159`：SOCKS 是动态条件路径；`ip-address` 用于字节转换，不承担本应用的信任分类。
- `src/main/proxy/kiroApi.ts:1-22,2293-2297,2357-2361`、`src/main/upstreamApi/transport.ts:162-220`、`src/main/proxy/proxyServer.ts:1136-1178`：Undici 是真实数据面；body 形态为 string/Buffer/GET，且调用的是 fetch。
- 全 `src/main` 精确检索没有 Undici `interceptors` / `RetryAgent` / `cacheStores` / `CookieJar` / `Blob` / `FormData` 调用；命中的 `setCookie` 是 WebPanel 自己生成 HTTP 响应头，不是 Undici API。
- 全 `src/main` 的 UUID 调用均为 `uuidv4()`；没有 `v3/v5/v6`。
- `src/main/proxy/selfSignedCert.ts:28-125`、`src/main/kproxy/certManager.ts:28-202`：node-forge 只做本地证书生成、读取和签发；全 `src/main` 没有 advisory 指向的验证 API。

## 3. Duplicate & reusable scan

- 内部已有可复用判定器：服务端构建的 Electron import fail-fast、真实 bundle external 列表、Linux `npm ci --omit=dev` smoke 路径。无需再造依赖可达性框架。
- 外部成熟修复路径就是 npm 官方 advisory + 默认 resolver。一次性容器已证明不需要 `--force`、不需要改 manifest、也不需要 major。
- `not applicable`：本任务不新增能力或库，不存在需要另选开源实现的工作。

## 4. Architecture / premise challenge + ordered recommendation

### Premise challenge

表面问题 Y 是“生产安装报 15 个 high/moderate”；真实问题 X 分两层：

1. **一个真实运行时补丁问题**：`undici` 等少数包确实进入服务端闭包，但当前 advisory 的具体受影响功能没有被调用。
2. **一个发布清单边界问题**：服务端制品复制整个桌面应用的根 manifest，导致 9/15 finding 来自运行时绝不会加载的 updater、注册 worker 和前端构建链。它们不是远程服务漏洞，却持续污染生产审计和供应链体积。

这不是“15 个公网可利用漏洞”，也不能反向解读成“全部误报”。最准确的结论是：**0 个已观察到的 advisory sink 暴露；1 个真实远程热包应优先补丁；其余按条件路径或清单噪声处理。**

### 按真实暴露排序的建议

1. **先做 `undici` 的同-major lockfile 更新（7.29.0+）并跑数据面回归。**  
   它直接处理上游 AI 响应与客户端指定的 HTTP 图片 URL。当前五条 advisory 的前置条件都缺失，但这是未来一次引入 cache/retry interceptor 就会改变的唯一热边界。回归至少覆盖：直连、HTTP/SOCKS 出口、流式与非流式、429 应用层重试、图片 URL。

2. **随后更新 `node-forge` 到 1.4.0。**  
   目标部署由前置反代终止 TLS，所以当前远程暴露低；但包启动即加载，且服务内 TLS/K-Proxy 一旦被开启就会走证书代码。回归自签证书生成、既有 PEM 读取、CA/host cert 生成即可。

3. **更新条件/热但受影响 API 未用的 `ip-address`、`uuid`、`ajv`、`fast-uri`。**  
   都是同-major：分别验证 SOCKS 出口、ID 形状、既有 `kiro-accounts.json` 读写。不要仅因当前 sink 不可达而永久保留已知脆弱版本。

4. **把 updater / Vite 构建链 / Piscina 组作为低紧急度但同一 lock refresh 一并清掉。**  
   它们没有服务器运行时暴露；默认 audit fix 已证明可无 major 清零。风险主要是桌面 updater 和构建产物回归，不是 Linux 服务遭远程利用。

5. **中期单独设计 server-specific production manifest。**  
   由真实 external import 闭包生成或维护最小运行依赖，并用 release smoke 锁住“manifest 中每个包都可解释、bundle require 的每个包都存在”。这样未来生产 audit 不再被桌面/构建链淹没。此项是结构改善，不应阻塞眼前的同-major 安全更新。

没有任何 finding 要求 major bump，因此“major 会破坏什么”在本轮为 **not applicable**。需要注意的是，默认 fix 虽不改 `package.json`，仍会在 lockfile 中改 20 个包并新增 3 个传递包；实施时必须评审完整 lock diff，不能把“同-major”误当成“无需测试”。

## 5. True modification scope

本轮是只读评估，实际修改范围为：

- 仅新增本报告。
- 未修改 `package.json`、`package-lock.json`、源码、部署文件或 npm 全局配置。
- 所有安装与 fix 验证均发生在 `docker run --rm` 的一次性 `/work` 中，仓库以 readonly mount 挂载。

若后续获准修复，最小实现范围是 lockfile 同-major refresh + 运行时/桌面/build 回归；server-specific manifest 是独立后续设计，不应混进紧急补丁。

## 6. Executable split

`not applicable: 本 dispatch 只授权 read-only assessment，未授权实施或并行 executor 工作包。`

## 7. Risk-intersection zones & dispatch recommendation

- 根 lockfile 同时服务桌面 Electron、WebPanel 构建和 headless server；一次 `npm audit fix` 会跨三者变化。
- `electron-updater` 修复虽对服务器不可达，却会改变桌面更新路径；必须跑桌面 updater 合同。
- Vite/Rollup/PostCSS 修复只影响构建期，但可能改变 bundle 产物；必须重建并复跑 release smoke。
- Undici 修复处于上游数据面；必须优先验证流式 framing、代理 dispatcher 和手写重试。
- 建议串行：先 lock refresh + 完整 diff 审阅，再并行跑 server data-plane、desktop updater、web build 三组回归；不要让三个 executor 同时改同一 lockfile。

## 8. Domain-model reconciliation / diff

`not applicable: 本任务不改变持久化、状态机、接口或跨层领域模型；仅评估依赖树与现有调用可达性。`

## Advisory 来源

- npm 官方审计端点：`npm audit --omit=dev --json --registry=https://registry.npmjs.org`
- GitHub reviewed advisory API（用于核验受影响功能前置条件）：
  - `https://api.github.com/advisories/GHSA-8xcm-r25x-g524`
  - `https://api.github.com/advisories/GHSA-4cwx-7wf7-3272`
  - `https://api.github.com/advisories/GHSA-m8rv-5g2x-5cg5`
  - `https://api.github.com/advisories/GHSA-jr45-8vmc-qm54`
  - `https://api.github.com/advisories/GHSA-v3r7-h72x-cjcm`
  - `https://api.github.com/advisories/GHSA-2328-f5f3-gj25`
  - `https://api.github.com/advisories/GHSA-q67f-28xg-22rw`
  - `https://api.github.com/advisories/GHSA-5m6q-g25r-mvwx`
  - `https://api.github.com/advisories/GHSA-ppp5-5v6c-4jwp`
  - `https://api.github.com/advisories/GHSA-2g4f-4pwh-qvx6`
  - `https://api.github.com/advisories/GHSA-w5hq-g745-h8pq`
  - `https://api.github.com/advisories/GHSA-mwp4-54f8-5fhr`
