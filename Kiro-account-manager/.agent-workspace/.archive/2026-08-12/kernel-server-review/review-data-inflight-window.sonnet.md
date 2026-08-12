# refreshInFlightIds 持久化窗口独立审查

## 审查问题
`refreshInFlightIds` 在网络任务结束时释放、切片稍后才持久化，是否能让后发的新 token 被先发的旧结果覆盖。

## 已核实源码事实
- `src/main/accountService/backgroundRefresh.ts:120-123`：按账号 ID 检查并加入共享 Set。
- `src/main/accountService/backgroundRefresh.ts:384-396`：成功结果先进入 `sliceResults`，随后 `finally` 立即删除账号 ID。
- `src/main/accountService/backgroundRefresh.ts:399-412`：只有整个切片 `Promise.allSettled` 后才调用持久化；因此多账号切片中，先完成账号存在“已释放、未落盘”窗口。
- `src/main/index.ts:1179-1183`：同 refresh token 的 single-flight 也在网络 Promise settle 时删除，不覆盖结果持久化。
- `src/main/accountService/persistRefreshBatchResults.ts:200-217`：持久化执行时读取当前盘面并逐账号 patch。
- `src/main/accountService/state.ts:169-189,209-213`：写任务串行执行且执行时重读盘面，但没有结果观察版本仲裁。

## 当前判定
窗口存在已经由源码证明；是否构成数据损坏仍待受控交错实验。关键判据不是两个写是否并发，而是：后发刷新结果先落盘后，先发但被同切片慢账号阻塞的结果能否随后覆盖 credentials。

## 验证状态
- 源码时序：已验证（上述行号）。
- 旧结果覆盖新 token：unverified，下一步运行 production-equivalent single-flight + shared Set + 双批次受控交错。
- Electron 启动：not applicable，本专项不评估桌面启动。
