# Main-process token write safety review

> 审查基线：`main` @ `3354d50`；范围仅限 main-process batch refresh 持久化与同一事实的桌面双写。
> 状态：IN PROGRESS（以下结论会随实测更新，不是最终 verdict）。

## 核验方法与适用性
- Phase 1 Spec Conformance：适用；按用户指定的四项安全问题逐项验。
- Phase 2 Task-Ledger：待核对是否存在本变更对应 `tasks.md`。
- Phase 3 Code Quality：适用；重点检查写入 SSOT、串行化和错误处理。
- Phase 4 Domain Model：待核对仓库是否有对应 domain model。
- Phase 5 Upstream Root Cause：适用；竞态必须定位到最早的生命周期/排序责任层。
- Phase 6 Whole Path：适用；核对新持久化符号的生产 caller 与最终磁盘 sink。
- Phase 7 Business Reality：适用；能力来自无头服务必须保存轮换 token 的真实数据保全需求。

## 假设台账（持续更新）
| ID | 互斥候选 | 当前状态 | 证伪/确认条件 |
|---|---|---|---|
| A | `refreshInFlightIds` 在网络完成后、切片落盘前释放，允许同账号新刷新结果先落盘、旧结果后覆盖 | 待证 | 构造并实测旧批次在新批次之后入 FIFO；若旧批次必先入队则证伪 |
| B | `applyAccountDataMutation` 无 `expectedRevision` 导致两个 main 写者读同一快照并丢更新 | 初步证伪 | `state.ts:155-207` 在队列执行时读盘、mutate、set，整个 read-modify-write 位于 FIFO `run` 内 |
| C | `lastSavedData` 未被 main 新写路径同步，后续旁路保存复活旧 token | 初步证伪其前提 | `state.ts:183` 每次成功 `store.set` 后调用 `lastSavedDataSetter(toPersist)`；仍需审全部旁路是否使用队列外陈旧副本 |
| D | refresh 响应按完成/持久化时序而非请求发起时序排序，慢旧响应覆盖快新响应 | 待证 | 查同账号是否可能有两个网络请求并存；若 in-flight 严格互斥则 HLC 不需要 |

## 已确认源码事实
- `src/main/accountService/state.ts:155-207`：所有 `applyAccountDataMutation` 调用挂到模块级 `pending` FIFO；`get → mutate → set` 全在队列任务内。
- `src/main/accountService/state.ts:165-171`：`expectedRevision` 只用于拒绝外部陈旧快照；main 权威写不传时不拒绝，但仍在 FIFO 内基于执行时的最新 `prev` 合并。
- `src/main/accountService/persistRefreshBatchResults.ts:200-218`：切片 mutator 从执行时 `prev.accounts` 克隆，只覆盖命中账号，并保留同账号其余当前字段。
- `src/main/accountService/backgroundRefresh.ts:377-402`：每账号网络任务的 `finally` 先删除 in-flight ID；随后 `Promise.all` 返回后才持久化整个切片。该窗口真实存在，是否可形成逆序覆盖仍待调度实测。
