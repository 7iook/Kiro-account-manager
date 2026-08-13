# 状态码提取防扩散门禁

## 成功状态（上游原文）

成功状态: NOT「加一条正则门禁」, BUT「以后有人再写一个从错误文本抠状态码的地方，如果它绕开既有 SSOT 去裸抓三位数，在合并前就被挡住」
          不该发生：门禁匹配不到任何东西却是绿的（与「没有门禁」输出同形）；不该发生：把合法的锚定提取判红，导致人加豁免清单绕过它
          来源: 台账 #38「状态码提取加检索门禁（两个项目独立栽在同一处）」

## 结论

已新增 `test/main/architecture/status_code_extraction_gate.test.ts`。门禁用 TypeScript AST 扫描整个 `src/**` 的 TS/TSX/JS/JSX/MTS/CTS/MJS/CJS 源码，不改任何生产判据：

- 识别 `.match` / `.matchAll` / `.exec` 上的正则字面量、局部变量正则与静态 `RegExp(...)`。
- 识别 `\d{3}`、`[0-9]{3}`、`\d\d\d`、`[1-5]\d{2}` 等恰好三位数字形状。
- 只按正则本身是否带 `HTTP` / `status` / `API|Auth error` / `request|response code` 语义锚点放行，不按文件路径放行。
- 生产扫描必须至少命中一处既有锚定提取；零命中会失败，不能以“扫描器失明”冒充绿色。
- 当前生产树命中 5 个合法候选（`accountPool.ts` 3 个、`kiroApi.ts` 1 个、`chainProxy.ts` 1 个），裸提取 0 个。

这属于已由用户确认的 B 类稳定性门禁：开发者新增错误文本解析时被合并前测试拦截；最终避免正常账号因载荷数字或 errno 被误判额度耗尽/封禁。

## 交付契约逐格校验

- 状态码提取 SSOT producer：PASS，`src/main/proxy/accountPool.ts:30-38` 是唯一通用提取器，三种认可位置均带 HTTP 语义锚点。
- 状态码提取 SSOT consumer：PASS（Tier 1 校正一处上游锚点）：
  - import：`src/main/proxy/proxyServer.ts:27`
  - 实际调用：`:3607`、`:3879`、`:4956`、`:5036`
  - 上游所列 `:5043` 只是解释默认 500 的注释，不是第 5 个调用；实码是 4 个调用，不影响本任务方向。
- 已知反例 producer / consumer：PASS，`test/main/proxy/quotaFalsePositive429.test.ts:153-176` 自校验 `402913`、`429184`、`-4077` 不得被裸截，并覆盖三种锚定正例。
- 封禁语义 SSOT producer：PASS，`src/shared/accountSuspension.ts:97-103` 仍要求 `423` 与 `locked|suspended` 联合出现。
- 封禁语义 consumers：PASS，核验了上游给出的全部 import / 调用锚点：
  - `src/main/proxy/proxyServer.ts:55,2018,3609,3881,4267,4960`
  - `src/main/proxy/activation.ts:48,55`
  - `src/main/accountService/check.ts:35,292,315,352,493,582,616`
  - `src/main/accountService/backgroundRefresh.ts:36,354,365`
  - `src/main/accountService/autoSwitch.ts:16,103`
  - `src/main/index.ts:42,1623`
  - `src/renderer/src/store/accounts.ts:27,660`
  - `src/renderer/src/components/accounts/_helpers.ts:7,169`
- 合法锚定提取：PASS，`src/main/proxy/kiroApi.ts:2130-2133` 与 `src/main/registration/chainProxy.ts:267-270` 均被扫描为候选且因协议锚点放行。
- 防扩散门禁 producer：PASS，扫描与分类实现位于 `test/main/architecture/status_code_extraction_gate.test.ts:28-221`。
- 防扩散门禁 consumer：PASS，受控正负样本与生产全树断言位于同文件 `:224-275`，由 `vitest.config.ts:56` 的 `test/main/**/*.test.ts` 自动收录。

## 门禁形状与理由

1. **AST，不扫源码字符串**：注释里的旧事故示例 `/(\d{3})/` 不会制造假红；变量正则和静态 `RegExp` 不会被简单 grep 漏掉。
2. **形状判定，不列文件白名单**：`kiroApi` 与 `chainProxy` 之所以通过，是正则带 HTTP 协议锚点，不是文件名被豁免；以后新增同类协议边界也无需改名单。
3. **扫描器自证 + 生产非零命中**：受控正样本证明扫描器能抓，受控负样本证明锚定模式能过，生产断言再要求实际候选数大于零，堵住“匹配不存在目标而常绿”。
4. **只建门禁**：未改 `extractHttpStatusCode`、`classifyError`、`isQuotaExhausted`、`isSuspended`、429 判据或任何运行时路径。

## 变异证明

### 能红

临时加入（验证后已删除）：

```ts
export function unsafeStatusFromError(message: string): string | undefined {
  return message.match(/(\d{3})/)?.[1]
}
```

运行新增门禁：

- 进程 EXIT=1。
- JSON：`numTotalTests=3`、`numPassedTests=2`、`numFailedTests=1`。
- default 日志明确点名：
  `src/main/proxy/__status_gate_mutant.ts:2 message.match(/(\d{3})/)`。
- 失败的是“生产源码不得新增无 HTTP 语义锚点的三位数提取”；受控正负样本本身仍通过，证明不是编译/导入失败造成的红。

随门禁保留的受控正样本有 4 个，读数为 **4 个候选 / 4 个违规**：

- `error.message.match(/(\d{3})/)`
- 变量间接调用 `STATUS.exec(errMsg)`，其中 `STATUS = /\b[0-9]{3}\b/`
- `new RegExp('(\\d{3})').exec(message)`
- `body.match(/([1-5]\d{2})/)`

### 不误红

删除临时 mutant 后，同一门禁：

- 进程 EXIT=0。
- JSON：`numTotalTests=3`、`numPassedTests=3`、`numFailedTests=0`。

随门禁保留的受控负样本有 4 个，读数为 **4 个候选 / 0 个违规**：

- `API|Auth error NNN`
- `status/statusCode = NNN`
- `HTTP NNN`
- `^HTTP/1.[01] NNN` 协议状态行（对应 `chainProxy.ts`）

另放入 `stamp.replace(/\.\d{3}Z$/, '.000Z')`，它不是状态码提取调用，不进入候选集。生产扫描同时放行 `kiroApi.ts:2130-2133` 与 `chainProxy.ts:267-270`。

## 回归验证

- 新门禁最终复核：3 passed / 0 failed。
- 全量 `test/main/proxy/**` + 新门禁：JSON `numTotalTests=519`、`numPassedTests=513`、`numFailedTests=0`、`numPendingTests=6`；default 日志为 52 files passed / 1 skipped。
- `npx eslint test/main/architecture/status_code_extraction_gate.test.ts`：EXIT=0，0 warning / 0 error。
- `npm run typecheck`：**EXIT=2，未通过且不是本任务引入**。两次重跑都只报并行未提交文件 `src/main/ipc/panelProxyDeps.ts:354`：`Property 'lastError' does not exist on type '{ status: string; }'`。该文件正在被面板 executor 修改，不在本任务所有权内，本 executor 未越权修补；本次新增测试文件也不在 `tsconfig.node.json` / `tsconfig.web.json` 的 include 内。

## `test/check_v161_proxyServer.ts` 判断

结论：**历史遗留快照，不是活的生产/测试代码**。

证据：

- 文件被 git 跟踪且有长期历史，但全仓没有任何 import、脚本或配置引用它。
- Vitest 只收 `test/main/**/*.test.ts` 与 `test/renderer/**/*.test.{ts,tsx}`；该文件位于 `test/` 根且不以 `.test.ts` 命名。
- `tsconfig.node.json` 只 include `src/main/**`、`src/preload/**`、`src/shared/**`；typecheck 不读取它。
- `package.json` 没有执行该文件的脚本。
- 与当前 `src/main/proxy/proxyServer.ts` 的 no-index diff 为 3158 insertions / 468 deletions，明显是旧版整文件副本。

因此 `:965-986` 的 `errMsg.includes('402')` 不会进入运行时、Vitest 或 typecheck，也不会影响最终 sink；按要求只报告、不修改。

## 越界发现

- 并行面板改动 `src/main/ipc/panelProxyDeps.ts` 当前破坏全仓 typecheck，具体见上节；本任务未触碰。
- 仓库根已有大量与本任务无关的未跟踪归档/临时材料；本任务只新增门禁测试并覆盖本报告，没有清理或纳入它们。
- 变异文件 `src/main/proxy/__status_gate_mutant.ts` 已删除，最终状态不存在。

## 驳回的做法

- **驳回“全仓文本 grep `/\d{3}/`”**：会把注释、毫秒时间戳与合法协议状态行混在一起，也漏掉变量/`RegExp` 间接写法。
- **驳回“禁止所有三位数字正则”**：会误伤 `kiroApi` 与 `chainProxy` 的合法锚定提取，逼出豁免名单。
- **驳回“允许文件白名单”**：把规则退化为手工维护路径；新增合法协议边界需要改名单，新增旁路也容易被顺手豁免。
- **驳回“只断言当前仓库零违规”**：扫描器若失明仍会绿；必须同时保留能命中的正样本、能放行的负样本和生产非零候选断言。
- **驳回顺手改 429 / 配额 / 封禁判据**：这会把架构护栏变成行为变更，且与 429 实测证据及本轮范围冲突。
- **驳回修改 `test/check_v161_proxyServer.ts`**：它是未接入任何执行链的历史副本，修改不能保护生产 sink。

## Review Findings

- Tier 1 校正：上游交付契约把 `proxyServer.ts:5043` 计作第 5 个 `extractHttpStatusCode` 调用；实码证明它只是注释，实际为 4 调用 + 1 import。
- 跨域触碰：仅 `test/main/architecture/status_code_extraction_gate.test.ts` 与本报告；未改生产文件。
- 隐含边界：门禁分析静态正则与静态 `RegExp`，不尝试求值运行时拼接出的动态正则；当前目标事故与受控变异均属静态形状。
- ⚡ 已按传播闸门列全 `extractHttpStatusCode`、封禁分类器及合法 `\d{3}` 消费点逐项核验；证据是上述 file:line 清单和生产扫描 5 个候选 / 0 违规。

## Update Log

- 2026-08-13 executor：新增 AST 状态码提取防扩散门禁；完成 1-fail 变异红、3-pass 复原绿、519-test proxy 回归；校正 `:5043` 非调用锚点；typecheck 被并行 `panelProxyDeps.ts:354` 的 TS2339 阻塞，未越界修补。
