# adminKey 写事务修复（P1-1 / P1-3）

审查报告：`.agent-workspace/.archive/2026-08-12/kernel-server-review/review-security.sonnet.md`
范围：`src/main/server/adminKeyStore.ts` 的写事务区域 + `test/main/server/adminKeyStore.test.ts`

## 1. 独立确认：两条缺陷都成立（读码 + 本机实测）

### P1-1 轮换三态分叉（`adminKeyStore.ts:365-380` / `:450-466`）
`writeKeyFileSecurely` 的顺序是 `写 temp → chmod temp → renameSync(temp,file) → enforceKeyFilePermission(statSync(file))`。
**`renameSync` 就是提交点**，权限复检在它之后。`set()` 传 `rollbackOnPermissionFailure:false`，
注释写「盘上仍是旧密钥，删了运维就彻底进不来」—— 该推理假定 rename 尚未发生，但它已经发生。
复检抛错时：内存 `current` 仍是旧值（`current = next` 在写之后，被抛错跳过）、
**盘上已是新值**、新值从未返回给调用方（`set()` 抛了）→ 重启后服务读新值，运维手上只有旧值 = 锁死。

### P1-3 首启先落盘后交付（`:241-247`）
`writeKeyFileSecurely(...)` 之后才 `print(...)`；`print` 可抛（stdout 关闭 / 容器日志驱动故障 / 注入异常）。
抛出后构造不返回，但**文件留下**；下次启动走 ⑥「文件已在」分支，按规则 2 永不打印 →
首次部署后运维没有凭据，也没有让它再出现的手段。

### 本机实测（win32 · node v22.20.0 · `tmp-rename-probe.mjs`，已删）
- rename 到只读目标 → **EPERM，提交前失败**，目标内容不变（`"OLD\n"`）
- rename 到被持有打开的目标 → EPERM
- **`chmod(0600)` 读回 `0666`；rename 前后 mode 不变（`666 → 666`）** ← 这条决定了设计

## 2. 设计：把「交付」纳入事务，并把权限闸门移到提交之前

不变量：**在密钥「既通过权限验证、又已交付给需要它的人」之前，绝不提交到盘上。**
交付的含义按路径不同 —— 生成 = 已打印；轮换 = 已回到调用方手里。

新顺序（`commitKeyFileTransactionally`）：
1. 快照目标现状（存在则连字节与 mode 一起记；读不出来 → 拒绝开始事务，因为无法保证回滚）
2. 写 temp → chmod temp → **复检 temp 的 mode**（就在同一目录，同一文件系统与 ACL 语义；
   实测 mode 跨 rename 不变，故这是等价证据）→ 失败则删 temp 抛错，**目标从未被碰过**
3. `renameSync(temp, file)` ← 提交点
4. 复检目标 mode（保留决策卡规则 3 的「回读校验」后半句）→ 失败则**恢复快照**再抛
5. `deliver()`（生成路径 = print）→ 抛则**恢复快照**再抛
6. 返回；调用方此后才更新内存状态

`rollbackOnPermissionFailure` 标志因此消失，不需要第三种模式：
- 生成路径快照 = 不存在 → 回滚 = 删除（正是原来 `true` 的行为，理由也一样：留下一把从未打印的钥匙 = 永久锁死）
- 轮换路径快照 = 旧密钥 → 回滚 = 把旧字节原子写回（这是原来 `false` **想要**但没做到的效果）

一份代码，两条路径的正确行为都从快照自然得出。

## 3. 几个必须说清的决定

**在内存里短暂持有旧密钥字节**：轮换路径的旧密钥本来就常驻内存（`makeStore` 的 `current`），
读一次文件不新增任何秘密暴露面；生成路径没有旧值。选择读盘而非直接用 `current`，
是因为回滚要恢复的是**盘上真实存在过的东西**（可能被外部改动过），内存值只是它的副本。

**rename 与复检之间崩溃 = 无法回滚**（进程已死，没有代码能跑）。留下的状态：
盘上是新密钥、内存是旧密钥、新密钥从未交付。运维可恢复，但只有一条路 ——
停服 → 删除密钥文件 → 重启（重新生成并打印），**这需要对该文件所在目录的文件系统访问权**，
只有面板入口的运维可能并不具备。把权限闸门移到提交前（步骤 2）正是为了压缩这个窗口：
最常见的失败因（该文件系统上 chmod 无效）现在完全不会触碰目标文件；
提交后仅剩「rename 成功但紧接着 stat 也失败」这一极窄区间。

**没有削弱权限检查**：闸门从「rename 后查目标」变为「rename 前查 temp + rename 后再查目标」，
判据（`classifyKeyFilePermission`）逐字未改，检查次数从 1 次变 2 次。

**`webPanel/auth.ts` 不改**（决定：会话失效缺口由本修复自然闭合，不属于这里）。
`rotateAdminKey()` 是 `set()` → `invalidateAll()`；原缺陷是「盘上已换但会话没失效」。
事务化之后 `set()` 抛错时盘上与内存都还是旧密钥 —— 轮换根本没发生，
既存会话继续有效**就是正确行为**，无需失效。且 `sessions` 是进程内状态，崩溃会隐式清空。
在 auth.ts 里加一层补偿只会掩盖「轮换是否真的发生过」这个已经被事务定义清楚的事实。

## 4. 验证证据（全部本轮真跑）

### 红（对 HEAD `3354d50` 的原始源码，未修复前）
```
npx vitest run test/main/server/adminKeyStore.test.ts --reporter=json --outputFile=tmp-tx-red.json
failed :: 首启打印失败 → 回滚：盘上不留文件，重启时重新生成并打印（P1-3）
     >> AssertionError: expected true to be false        ← 文件在 print 失败后仍留在盘上
failed :: 轮换时权限复检失败 → 三者一致留在旧密钥（P1-1 核心）
     >> AssertionError: expected 'rotated-but-never-delivered-...'
        to be 'focQuAebmr-VTBDkWUWbvs_s_J00rlmjkrc9F…'   ← 盘上是新钥匙，运维手里是旧钥匙
```
第二条的失败信息就是缺陷本身：**盘上那把没人拿到过，运维手上那把已失效。**

### 绿（修复后 · 与并发 agent 的 P1-2/P1-5 合并后）
```
npx vitest run test/main/server/adminKeyStore.test.ts --reporter=json
file total: passed=63 failed=0     （我的 6 条 + 对方 57 条）

npx tsc --noEmit -p tsconfig.node.json --composite false
TYPECHECK_EXIT=0                   （未经管道，直接读 exit code）

npx vitest run --reporter=json --outputFile=tmp-full2.json
FULL passed=1580 failed=0 total=1586 suitesFailed=0 pending=6
```
`pending=6` 是 `test/main/proxy/**` 里既有的 skip（GPT modelId 归一那组），与本轮无关。

### 红证据的一处诚实说明
第一次写的「提交后失败」那条测试，红的原因是**结构性**的（它依赖修复后「提交前+提交后各校验一次」
这个形状，对原始源码而言那个注入点根本不存在）—— 那等于在断言实现形状，不是断言结局。
已把它换成「轮换成功时三者一致前进 + 不留中间文件」，守的是回滚逻辑不要顺手把成功路径也挡住。
P1-1 的核心窗口由上面那条真红的测试覆盖。

## 5. 与并发 agent（P1-2 / P1-4 / P1-5）的合并

同一文件不同区域并行修改，实际发生过一次交叉，记录如下：

- 我为跑红证据把源码临时换回 HEAD 版本，期间对方落了盘。恢复时我用的是**自己的完整副本**，
  已核实对方的 `ALLOW_UNPROTECTED_KEY_FILE_ENV` / `MIN_ADMIN_KEY_LENGTH` / `classifyAdminKeyStrength`
  以及他们对 `enforceKeyFilePermission` 的第 5 参数改造**都在**，`[degraded]` 标记 0 处，事务四个锚点齐全。
- 对方把 win32 从「告警放行」改成「默认拒启 + 显式 opt-in」，我的 6 条 fixture 因此需要
  `allowUnprotectedKeyFile: true`（否则 store 根本构造不出来），注入的密钥字面量也要过 32 字符下界。
  已收进一个组内 `txStore()` 辅助函数 —— 他们下次再动这条契约，只需要改一处。
- 中途有一次全量跑到 `assertAdminKeyStrength is not defined` / `isTruthy is not defined`
  （对方正写到一半的瞬间状态）。等待后重跑即全绿 —— 不是真实缺陷，记录以免误判。

## 6. `webPanel/auth.ts` 未改（明确结论）

审查报告提到 `auth.ts:133-137` 在 `set()` 抛错时跳过 `sessions.invalidateAll()`。
**事务化之后这不再是缺口，故不改那个文件。**

理由：`rotateAdminKey()` = `set()` → `invalidateAll()`。原缺陷的形态是「盘上已换、会话没失效」；
现在 `set()` 抛错意味着盘上与内存都还是旧密钥 —— **轮换根本没发生过**，既存会话继续有效
就是正确行为，无需失效。在 auth.ts 再加一层补偿，只会掩盖「轮换到底成没成」这个
已经被事务边界定义清楚的事实。（`sessions` 还是进程内状态，崩溃会隐式清空。）

## 7. 残留风险

**rename 与提交后复校之间崩溃**：不可回滚（进程已死，没有代码能跑）。留下的状态是
「盘上新密钥 / 从未交付」。运维可恢复，但只有一条路 —— 停服 → 删除密钥文件 → 重启，
**这需要对 dataDir 的文件系统访问权**；只能从面板进来的运维不具备。
把最常见的失败因（该文件系统上 chmod 无声失效）前移到提交之前，就是为了让这个窗口
只剩「rename 成功、紧接着 stat 也失败」这一极窄区间。未进一步消除。

**回滚自身失败**：走 `warn` 明确上报「盘上现在是一把从未交付的新密钥」+ 自救三步，
不吞掉、也不掩盖原始错误（原始错误里才有 chmod 补救步骤）。
