# Panel config UI resilience findings

> 成功状态: NOT「加个 null 判断让测试变绿」, BUT「配置还没加载回来、或者加载失败时，机主在手机上看到的是面板和一句说明，而不是白屏」
>           不该发生：面板任何一个区块抛错就把整页带崩；不该发生：把「加载中」和「加载失败」显示成同一个东西
>           来源: 实测 —— 新组件抛错导致整个 App 渲染失败，body 空成 `<div />`，一条无关测试因此找不到「选择账号」按钮

基线：HEAD `c781f02a759f2819cf68318ac06e5fe78678ec7e`，共享工作树含其他 executor 的未提交改动；本轮未提交、未修改 `src/main/**`、受害测试、Vitest 配置或包文件。

## 交付契约核验

| 链路节点 | 核验结果 |
|---|---|
| 配置 producer | 已存在：`src/main/webPanel/routes.ts:884-890` 的 `GET /api/proxy/config` 调用 `proxyGetConfig()`；这是另一 executor 的未提交代码，本轮只读核验。 |
| 配置 consumer | 已接通：`src/webPanel/api/panel.ts:450-453` 获取并校验投影，`src/webPanel/ui/ProxyConfigSection.tsx:68-88` 消费并建立 UI 状态。 |
| 加载/失败态 producer | 本轮完成：`ProxyConfigLoadState` 明确分为 `loading / missing / error / ready`，渲染位于 `ProxyConfigSection.tsx:142-173`。 |
| 区块级容错 producer | 本轮完成：`PanelSectionBoundary.tsx:19-55`；配置区块消费点 `ProxyPanel.tsx:496-498`，面板主要区块消费点 `App.tsx:257-353`。 |
| 最终 sink | 真实 `ProxyPanel` / `App` 组件树；测试从 `fetch` 边界喂响应并点击“选择账号”，没有 mock `api/panel.ts`。 |

链路完整，没有 producer/consumer 断点。业务现实分类为 **B · 稳定性**：手机面板是唯一远程管理入口，白屏会直接丢失控制面。

## 实现结果

### 三态在手机上的呈现

1. **加载中**：显示“正在读取反代配置…面板其他功能仍可使用。”，不显示失败提示，选号仍可打开。
2. **配置缺失/2xx 响应不完整**：API 边界将空值或缺少必填结构的响应识别为协议损坏；区块显示琥珀色“服务端没有返回完整的反代配置……”，并提供“重试读取配置”。
3. **GET/网络失败**：显示红色“读取反代配置失败……若持续失败，请检查电脑端面板服务”，并提供重试；不会继续伪装成转圈。

`PanelProxyConfigView` 只在运行时结构校验通过后进入 React state，因而不是在崩溃点追加一个 null 判断。加载、缺失、失败、成功也不再由可互相矛盾的多个 boolean/null 状态拼装。

### Error boundary 取舍

选择引入区块级 error boundary，理由如下：

- 单点数据校验只能防住当前已知的配置响应问题，不能证明以后其它区块的渲染代码永不抛错；手机唯一控制面不适合把这个风险交给一个全局白屏。
- 只放一个 App 级 boundary 仍会用整页 fallback 替换所有控制，因此采用两层隔离：反代配置内部单独包裹，保证它炸掉时选号/启停/管理密钥仍在；App 再分别包裹反代服务、账号导入和账号列表，保证任一主要区块不会拖垮另外两个。
- fallback 明确告诉机主“该区块暂时无法显示，其他功能仍可使用”，并提供区块重试。
- `componentDidCatch` 以区块名、原始错误和 React component stack 写入 `console.error`，没有静默吞异常。

边界只负责不可预判的 render/lifecycle 异常；HTTP 预期失败仍由显式加载状态处理，不拿 exception boundary 代替正常错误流。

## 红 → 绿证据

### Red 1：配置响应缺失复现原始白屏

命令：

```powershell
npx vitest run test/renderer/web-panel-ui/panelProxyConfig.test.tsx --reporter=default --reporter=json --outputFile.json="$env:TEMP\panel-config-ui-red.json" *> "$env:TEMP\panel-config-ui-red.log"
```

结果：`EXIT=1`，JSON `numFailedTests=1`。default 日志显示：

- `<body><div /></body>`
- `TypeError: Cannot read properties of undefined (reading 'editable')`
- 新增用例“配置响应为空时显示缺失说明，且选号仍可交互”失败。

### Red 2：任一区块渲染异常仍会带崩整页

命令同上，输出改为 `panel-config-boundary-red.*`。

结果：`EXIT=1`，JSON `numFailedTests=1`。default 日志再次显示 `<body><div /></body>`，并报：

- `TypeError: Cannot read properties of undefined (reading 'configured')`
- 用例“配置区块渲染异常时只替换该区块，选号仍可交互”失败。

### Green：要求范围最终复跑

```powershell
npx vitest run test/renderer/usage-percent-ssot/percentUsedUnit.test.tsx test/renderer/web-panel-ui --reporter=default --reporter=json --outputFile.json="$env:TEMP\panel-config-final-green.json" *> "$env:TEMP\panel-config-final-green.log"
```

结果：`EXIT=0`；JSON `numFailedTests=0`，`63/63` tests、`5/5` files 通过。

- `panelProxyConfig.test.tsx`：`9/9`，覆盖配置缺失、GET 失败、加载中、真实渲染异常隔离及既有 happy path。
- 受害者 `percentUsedUnit.test.tsx`：`6/6`；三条选号行为用例自行恢复，没有修改受害测试。
- 其余 `test/renderer/web-panel-ui/**`：全部通过。

附加验证：

- `npm run typecheck:web` → `EXIT=0`
- `npm run typecheck:node` → `EXIT=0`
- 本轮文件 `prettier --check` → `EXIT=0`

按派单说明未跑全套件，也未重建 webpanel 产物；已知 `webpanel_build_assets.test.ts` 的产物过期由主 agent 处理。

## 契约缺口判断

不建议给 `PanelProxyConfigView` 增加“未加载/加载失败”字段：这两者是浏览器请求生命周期与 transport failure，不是服务端配置领域状态；塞入 DTO 会把服务端真值和客户端过程态混在一起。共享类型名与形状本轮均未改。

实际缺口是 **TypeScript 泛型没有运行时约束力**：此前 2xx 空响应或 `{ success: true }` 会被强制当成 `PanelProxyConfigView`。本轮在浏览器 API 边界增加运行时结构校验和本地 `PanelProxyConfigResponseError`。如果后续要统一所有面板 DTO，建议引入统一的 runtime decoder；这不是本轮应自行扩展的共享后端契约。

## Review Findings

- **Tier 1 自校正**：派单把故障概括为 config `undefined`；实际受害测试的兜底桩对新路由返回 `{ success: true }`，真实缺失的是 `editable` 等投影结构。两者都是“不完整 2xx”，故按完整结构校验处理，并用受害套件确认。
- 当前组件并非完全没有加载/失败文案；真正问题是它先把未校验响应写入 state，导致已有文案来不及显示，React 树已崩。本轮修的是 API 边界与状态模型，而非只补文案。
- 触及文件：`src/webPanel/App.tsx`、`src/webPanel/api/panel.ts`、`src/webPanel/ui/ProxyPanel.tsx`、`src/webPanel/ui/ProxyConfigSection.tsx`、新增 `src/webPanel/ui/PanelSectionBoundary.tsx`、`test/renderer/web-panel-ui/panelProxyConfig.test.tsx`。
- 隐含风险：`PanelProxyConfigResult` 等其它成功响应仍主要依赖静态类型；本轮的区块 boundary 保证 malformed render 不会白屏，但若要在 UI 中把每一种 malformed 写响应都区分成专用文案，需要后续把 runtime decoder 扩到所有 config-bearing 响应。
- 未发现需要修改共享契约类型名或 `src/main/**` 的方向冲突。

## Update Log

- 2026-08-13 · executor · 完成配置三态、API 运行时校验和区块级容错；红灯两次均复现 `<div />` 白屏，最终要求范围 `63/63`、两项 typecheck 均 `EXIT=0`。
