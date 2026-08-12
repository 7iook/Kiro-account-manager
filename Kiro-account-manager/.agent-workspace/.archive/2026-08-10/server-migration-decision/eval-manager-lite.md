# 候选宿主评估:kiro-manager-lite

> 评估对象 `F:\kiro-manager-lite` · 评估目的:能否作为服务器化部署的宿主
> 只读侦察,未修改任何文件。日期 2026-08-10

## 0. 血缘裁定(一句话)

**接口层的同源后代 + 代码层的独立重写,方向是「本项目 → lite」,不是 git fork。**
它是**功能子集 + 技术栈不同**(Vue 3/Ant Design vs 本项目 React 19/Tailwind),
**不是宿主候选**。

证据锚点:

| 判据 | kiro-manager-lite | 本项目 | 结论 |
|---|---|---|---|
| git remote | `github.com/lucks-cloud/kiro-manager-lite` | `origin=chaogei/Kiro-account-manager` · `fork=7iook/...` | 不同仓库 |
| 根提交 | `90d7ea27c2c80fd5016e06d407aa4931ccc20259` | `89872d0ae719f53cf5bcaf719520a1a14724cbee` | **无共享历史,非 fork** |
| 自述血缘 | `CHANGELOG.md` `[1.0.0]`:「基于 [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)(AGPL-3.0)的**接口实现**,用 Vue 3 + Vite + Pinia + Ant Design Vue + Electron **重写**,并**裁剪为纯账户管理工具**」 | — | 单向派生,方向确定 |
| package name / version | `kiro-account-lite` 1.0.10 | `kiro-account-manager` 1.7.6 | 独立版本线 |
| 渲染层 | Vue 3.5 + ant-design-vue 4.2 + Pinia | React 19 + Tailwind 4 + zustand | **技术栈不兼容,无法直接搬运** |
| src 总行数 | **20,551** | **79,568** | 约 1/4 体量 |

目录形状同构(`src/main` + `src/preload` + `src/renderer` + `src/shared`),
electron-vite + electron-builder + cbor-x + undici 同款选型 —— 印证「照着接口重写」而非独立发明。

---

## 1. 不是宿主候选的原因(裁决)

**它在服务器化这件事上,处境比本项目更差,而不是更好。**

### 1.1 网关是「单 Key 透传代理」,不是账号池调度器

`src/main/keyGateway.ts`(595 行)整体职责,见文件头注释 L1-10:
把 IDE 请求的凭证**换成用户的单个 `ksk_` API Key**、剥掉 `profileArn`、转发到官方网关。
核心转发函数 `forwardGeneric()`(L343)拿的是**一个** `credential: KeyCredential`:

```ts
const headers = injectAuthHeaders(req.headers, target.host, credential.key)
// ...
recordForwarded(credential)
const upReq = https.request({ /* ... */ }, (upRes) => {
  const status = upRes.statusCode || 0
  const okStatus = status >= 200 && status < 300
  log(okStatus ? 'info' : 'warn', `[KeyGateway] <- [${label}] ${keyTag} HTTP ${status}`)
  res.writeHead(status || 502, stripHopByHop(upRes.headers))
  upRes.pipe(res)
```

**上游状态码只用来决定日志级别是 info 还是 warn,然后原样 `writeHead` + `pipe` 给下游。**
这一行就否掉了用户最看重的一整类能力:429 原样透传给 IDE、402 不区分、失败不换号、不重试。

### 1.2 用户最看重的能力,逐项核对结果

`git grep -n -i -E "429|402|retryAfter|too.?many|hold|freeze|挂起"` 在 `src/` 下
**对 429 / 402 / hold / freeze 零命中**(命中的全部是「重试」中文词,且都在
`accountService.ts` / `keyService.ts` 的**用量刷新**链路,不是代理转发链路);
`rotat|affinit|sticky|stall|prompt.?cache` 同样零命中 —— `pool` 的命中是渲染层的
`runPool`(`src/renderer/src/utils/format.ts:241`),一个批量刷新用的并发池,与请求调度无关。
(git grep 只覆盖已跟踪文件,已用 fast-context 语义检索复核,结论一致:
只返回 `keyGateway.ts` / `keyService.ts` / `accountService.ts` 三个文件,无调度层。)

| 用户看重的能力 | lite | 证据 |
|---|---|---|
| 无可用账号时**挂起请求**(冻结而非失败) | ❌ 无 | 无任何 hold/freeze/队列;`forwardGeneric` 单发直转 |
| 429 重试策略 | ❌ 无 | 状态码只影响日志级别(keyGateway.ts:384-386) |
| 402 额度耗尽 vs 429 限流区分 | ❌ 无 | 两个字面量在 src 下均无出现 |
| 多账号池 / 轮换 | ❌ 无 | 网关持有单个 `credential`;换 Key 靠用户在界面上手点 |
| 真实额度反馈进选号 | ❌ 无选号 | 有额度采集(`keyService.ts`),但没有消费它的调度器 |
| 会话亲和 / prompt cache / SSE 卡死检测 | ❌ 无 | 零命中;`upRes.pipe(res)` 裸管道,无流监控 |
| 模型能力路由 | ❌ 无 | 无路由层,原样转发 `req.url` |
| Web / 管理面板 + 鉴权 | ❌ 无 | 无 express/fastify,无 `webPanel` 类目录 |

对照本项目已有:`src/main/proxy/proxyServer.ts` 4538 行、`src/main/proxy/accountPool.ts` 744 行、
`src/main/proxy/translator.ts` 1367 行、`src/main/webPanel/routes.ts` 514 行、
`src/main/kproxy/mitmProxy.ts` 487 行 —— lite 的**整个项目**(20.5k)不到本项目 proxy 目录+主进程的规模。

### 1.3 部署故事:比本项目更 Electron-耦合

- **无 Dockerfile / systemd unit / compose / Procfile**(`git ls-files` 匹配 docker|systemd|compose 零结果)。
- **无 headless / CLI 入口**:`process.argv` 仅两处使用,都是自定义协议唤起
  (`appProtocol.ts:29`、`index.ts:207`),不是服务模式开关。
- **`electron` import 遍布 main 层 16 个文件**,且**网关自己就 import 了 electron**:
  `keyGateway.ts:17 import { app } from 'electron'`(用 `app.getPath('userData')` 持久化 machineId)。
  也就是说 lite 的代理**同样无法脱离 Electron 独立起进程** —— 与本项目同病,但本项目至少已经有
  `webPanel` 这一层可远程访问的入口,lite 连这个都没有。

**结论:lite 能提供的服务器化价值为零。它没有本项目没有的东西,反而缺了服务器化最需要的调度、
挂起、Web 面板。若采用它,等于丢掉 §1.2 表里的全部能力。**

---

## 2. 值得反向借鉴的简化(剩余预算投向)

虽然不能当宿主,lite 有几处「更小更干净」的做法,对服务器化目标有实际价值:

### 2.1 主进程文件切分纪律(最值得借鉴)

lite 主进程最大文件 `keyService.ts` 601 行,网关 595 行,IPC 集中在 `ipc.ts` 449 行,
**按能力切成 26 个单文件**(accountService / keyService / keyGateway / kiroApi / kiroAuth /
kiroChat / kiroEndpoints / kiroSettings / kiroPermissions / kiroCapability / kiroProcess /
net / logger / store / tray / updater / onlineLogin / proactiveRenewal / usageHistory ...)。
对照本项目 `src/main/index.ts` **6634 行**。

**这正是用户服务器化的主要障碍的解法方向**:lite 证明了这套业务(账号管理 + 凭证轮换 +
网关接管 + 托盘 + 更新)**可以在主进程不出现单个巨型文件的前提下组织起来**。
借鉴动作:把 `index.ts` 的 IPC handler 按 lite 的 `ipc.ts` 模式抽成独立注册模块,
让 `index.ts` 只剩 app 生命周期 —— 这是服务器化拆分的前置条件,与 lite 的代码无关,只借结构。

### 2.2 `shared/refreshPolicy` 单一判定源

lite 1.0.10 把「哪些失败该跳过重试」收敛到 `src/shared/refreshPolicy.ts`,
四条刷新路径(账号自动/手动、Key 自动/手动)共用同一份判定,CHANGELOG 明确点出动机是
消除「手动跳过了、自动还在刷」的口径漂移。
**判据本身对服务器化直接有用**:确定性失败(凭证被拒/403/封禁)vs 临时故障(限流/5xx/超时/网络)
的二分,正是账号池「摘除 vs 冷却」需要的分类。本项目若已有等价判定,应确认它是否也是单一真源;
若分散在多处,这是一个可借鉴的收敛目标。

### 2.3 端点守护(endpoint guard)

lite 1.0.6 引入:接管期间监视 `settings.json`,端点被 Kiro IDE 外部改写就自动改回本地网关
(动机见 CHANGELOG 1.0.6「网关接管检测」段:IDE 启动时会按自身内存把端点回写清空)。
服务器化后若仍需接管本机 IDE 场景,这个「写后守护」比「写后校验」更稳。

### 2.4 一个负面教训,直接可用

lite 1.0.3 明确移除了 JS 混淆链路,理由写在 CHANGELOG:
「混淆让产物体积膨胀约 219%,却使打包版彻底不可诊断」。
同一条目还记录了 `drop_console: true` 导致**打包版丢失全部渲染进程日志**、
从而无法判断自动刷新是否执行的事故。服务器化部署后可观测性只会更重要 ——
若本项目构建配置里有 `drop_console` 或类似激进裁剪,值得复核。

### 2.5 Kiro 版本能力探测(判据设计值得抄,不是代码)

lite 1.0.10 新增:判断 IDE 是否支持网关接管,**判据是「kiro-agent 扩展是否真的读取
krsEndpoints / cpsEndpoints」,而不是比较版本号大小**;并记录了旧版 Kiro(0.11.133)
走 CodeWhisperer 端点体系(`q.<region>.amazonaws.com`)导致「提示写入成功、实际仍走官方额度」
的假成功缺陷。本项目近期提交 `a67b295 fix(proxy): EU 账号补 q.eu-central-1 端点` 说明
同一套端点体系问题也在本项目辖区内 —— 这条 CHANGELOG 记录可当作现成的情报,而非要抄的代码。

---

## 3. 采用它会失去什么(为完整性保留)

不适用 —— 已判定非宿主候选,不存在采用场景。若强行以 lite 为底,失去项:
§1.2 表中全部 8 项能力 + 79.5k 行 src 中除账号管理外的一切(注册器 `registrar.ts` 1620 行、
邮件服务 996 行、翻译层 1367 行、MITM 代理、Web 面板、tlsclientwrapper 指纹链路、
js-tiktoken 计费、e2e 测试套件),并且渲染层 React→Vue 需整体重写。

---

## 4. 给主调度者的建议

1. **关闭 lite 这条线**,不再花预算做深评。它是本项目账号管理部分的 Vue 重写子集。
2. 服务器化的真实障碍未被它解决,仍需自己拆:`src/main/index.ts` 6634 行 +
   `proxy/` 与 `electron` 的耦合。**lite 唯一的正面贡献是证明了主进程可以不出现巨型文件**
   (§2.1),可作为拆分目标形态的参照。
3. 若还要评估其它候选宿主,判据应直接锁死在两条:
   ① 代理是否已是可独立起进程的服务(不 import electron);② 是否有账号池调度 + 挂起语义。
   lite 两条全否,且第①条的反例锚点很短:`keyGateway.ts:17`。

## Update Log

- 2026-08-10 初次侦察并落盘。方法:package.json/CHANGELOG 对读 → 双仓根提交对比(否掉 fork)
  → 目录与行数普查 → keyGateway.ts 精读 → git grep + fast-context 双路复核能力缺口。
  未修改被评估项目任何文件。
