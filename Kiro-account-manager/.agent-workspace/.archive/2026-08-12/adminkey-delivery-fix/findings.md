# adminKey 交付与校验修复（P1-5 / P1-4 / P1-2）

- 日期：2026-08-12
- 基线：`3354d50`（`git status` 确认 `src/main/server`、`test/main/server` 工作区干净）
- 范围：`src/main/server/adminKeyStore.ts` + `test/main/server/adminKeyStore.test.ts`
- **未改** `entry.ts`（见 P1-2 决定：拒启点落在密钥文件权限闸门内，不需要入口层平台判定）

## 权威规则核对（decision-card.md:458-470，逐字读过）

| 卡上规则 | 与本轮三条缺陷的关系 |
|---|---|
| 生成时机：首启无密钥 → **生成并打印到标准输出一次** | P1-4 的机制是卡明文裁决的，故不推翻机制 |
| 一次性展示：仅首次生成时打印 —— **否则容器日志里长期留着有效凭据** | ⚠️ 卡自己点名了 P1-4 的威胁，却只用「以后不再打印」来缓解。第一次打印那份副本本身就已经在 journal 里了 —— 这是卡的推理缺口，也是代码文案自相矛盾的来源 |
| 持久化权限：`0600`，**若无法设置该权限则拒绝启动** | P1-2 直接失守：win32 告警放行 |
| 支持预置：允许环境变量预置 | P1-5 的入口。卡没有对预置值提任何强度要求 —— 这是卡的**空缺**，不是卡的裁决，故可以补 |

## 前置事实（都实际核实过，不靠记忆）

1. `generateAdminKey()`（`src/main/webPanel/auth.ts:213-215`）= `randomBytes(32).toString('base64url')` → 43 字符。
2. `rotateAdminKey()`（`auth.ts:133-138`）**只**用 `generateAdminKey()` 的输出调 `set()`；运行时不存在「运维直接 set 一个弱值」的生产路径。
   → 推论：收紧校验不会打断轮换；但 `set()` 若放过弱值并落盘，**下次启动会被新校验拒启** = 把运维锁在面板外。故 `set()` 必须共用同一个校验器（这不是镀金，是防止造出不可启动状态）。
3. 登录侧已有限流：`loginThrottle.ts:18-22` = 每 IP 5 次失败后指数锁定，上限 30 分钟。
   → 推论：adminKey 的威胁模型是**在线**猜测（无离线密文可爆破），故「足够长」即可，不需要熵评分器。
4. 项目内已有同类口令策略先例：`secureBackupCipher.aesGcm.ts:47,99-103` = `MIN_BACKUP_KEY_LENGTH = 32`，只判长度、不做复杂度评分，错误文案讲清「弱口令等于没加密」。
   → 采用同一形状 = 全项目一套口令故事，不引入第二套判据。
5. 全仓 caller 核实（`git grep`）：`createServerAdminKeyStore` 只有 `entry.ts:70` 一个生产调用点；`test/main/architecture/server_bundle_esm_interop.test.ts:134` 用 `KIRO_ADMIN_KEY: 'interop-probe-key-not-a-real-secret-000000'`（41 字符）预置。
   → 推论 A：41 字符 ≥ 32，min-length 策略下该越界测试**不受影响**；若改用「必须是 43 字符 base64url」的严格格式策略，它会红 —— 而那是本轮范围外的文件。这是选 min-length 而非严格格式的一条实测理由。
   → 推论 B：该测试走 env 预置 + 无密钥文件，因此也不受 P1-2 的 win32 拒启影响（enforce 只在「文件已存在」或「刚写完文件」时被调）。

## 决定

### P1-5 → 单点强度校验，策略 = 最小长度 32，env 与 file 完全同判
- 新增纯函数 `classifyAdminKeyStrength(key)`，三态：`ok` / `too-short` / `bad-chars`。
- 三个入口共用它：env 预置、盘上文件、`set()` 轮换写入。
- **不**要求生成器格式（43 字符 base64url），理由：① 会误拒密码管理器给的 64 字符 hex 等高熵值；② 会红掉范围外的 interop 测试（前置事实 5）；③ min-32 已足以挡掉 `KIRO_ADMIN_KEY=x` 与任何人手打的口令，而这就是缺陷本体。
- 附带拒绝控制字符与内部空白：那不是熵判据，是格式风险（该值要进 HTTP 头/URL/env）。
- 退出码：env 弱值 → `EXIT.USAGE(64)`（与「env 已设置但为空」同族）；文件弱值 → `EXIT.DATA_ERROR(65)`（与「文件内容为空」同族）。
- 兼容性：旧版本写出的文件必是生成器格式（43 字符），收紧不影响任何让它自动生成过的人。

### P1-2 → 保留「无法证明就拒启」，但拒启点在密钥文件闸门，且给开发机显式 opt-in
- 不实现 NTFS ACL 读取。理由：纯 Node 无原生依赖时只能 shell 出 `icacls` / `Get-Acl` 并解析**本地化**输出，用它做安全裁决会静默误判；且会给一个刻意零依赖的内核模块引入 `child_process`。
- 改 `enforceKeyFilePermission`：`unenforceable` 由「告警放行」改为**拒启**（`EXIT.CANNOT_CREATE(73)`），除非显式设置 `KIRO_ALLOW_UNPROTECTED_KEY_FILE=1`（此时每次启动都告警，不是一次性）。
- `classifyKeyFilePermission` 本身不动 —— 它报的是平台事实（POSIX 位在 win32 不存在），该事实没变；变的是**据此做什么决定**。这也让既有分类器测试保持绿。
- 精确边界：Windows 上不被支持的是**密钥文件**，不是服务端形态本身。走 `KIRO_ADMIN_KEY` 预置（Docker secrets / systemd `Environment=`）时根本不落密钥文件，故在 Windows 上仍是受支持路径。开发机故事 = opt-in 变量。

### P1-4 → 保留 stdout 交付，但删掉代码声称的假威胁模型
- 卡明文裁决了 stdout，且无头机器上运维**没有**第二通道；换成需要第二通道的方案比现状更糟。故保留机制。
- 真正要修的是**文案在说谎**：现文案「之后启动不再打印它 —— 否则容器日志里长期留着有效凭据」暗示日志里没有它，而第一次打印早已留下持久副本。
- 改为：① 明说这把钥匙此刻已在终端回滚缓冲 / journal / 容器日志里，凡有日志读取权限者皆可见；② 建议首次登录后立刻在面板轮换（轮换走 `rotateAdminKey()`，**不打印**，故新钥匙从未碰过日志 —— 这是一条真实可用的闭环，不是空口建议）；③ 指出想彻底不经日志交付就用 `KIRO_ADMIN_KEY` 预置（该路径既不生成也不打印）。
- 不动写入事务/交付事务（另一 agent 正在做）；本轮只改 notice 文案与校验区域。

## 更新日志
（按实现进度追加）

---

## 实现结果与验证证据

### 改了什么

**`src/main/server/adminKeyStore.ts`**
- 新增导出：`classifyAdminKeyStrength()` / `MIN_ADMIN_KEY_LENGTH = 32` / `ALLOW_UNPROTECTED_KEY_FILE_ENV` / 类型 `AdminKeyStrengthVerdict`。
- 新增私有：`assertAdminKeyStrength()`（拒启闸门，退出码由调用方给）、`describeStrengthVerdict()`（文案，不含明文）、`isTruthy()`（镜像 `config.ts:isTruthyFlag`）。
- 新增选项：`allowUnprotectedKeyFile?: boolean`（与环境变量等价）。
- `enforceKeyFilePermission()` 多一个 `allowUnprotected` 参数；`unenforceable` 由「告警放行」改为**拒启**（`EXIT.CANNOT_CREATE`），opt-in 时放行且每次启动告警。
- `writeKeyFileSecurely()` 的 `opts` 多一个 `allowUnprotected`（另一 agent 的 `deliver` 事务保持原样，未改其语义）。
- 强度闸门接了三处：env 预置（`EXIT.USAGE`）、盘上文件（`EXIT.DATA_ERROR`）、`set()` 轮换（裸 `Error`，运行时失败无退出码）。
- `formatBootstrapNotice()` 文案重写（P1-4）。
- 文件头文档表同步（旧表还写着「Windows 告警放行」）。

**`test/main/server/adminKeyStore.test.ts`**
- `emptyEnv()` 改为自带 `KIRO_ALLOW_UNPROTECTED_KEY_FILE=1`；新增 `bareEnv()`（真空 env，用于断言 win32 默认拒启）。
  → 一处 helper 改动覆盖了全文件约 25 个 `platform:'win32'` 调用点（含另一 agent 的 P1-1 写事务测试），语义与它们原本「把权限变量中和掉」的意图一致。
- 新增 3 个 describe / 22 条测试（P1-5 十条 · P1-2 七条 · P1-4 五条）。
- 修 1 条既有测试：「env 与文件一致 → 放行」用的是内联 env，没走 `emptyEnv()`，win32+文件存在会撞上新拒启 → 加 `...emptyEnv()`。这是我的改动造成的真实缺口，不是过时断言。

**未改**：`entry.ts`（不需要 —— 拒启点落在密钥文件权限闸门内，Windows 上 env 预置路径仍完全可用，不需要入口层平台判定）、`index.ts`、`proxy/**`、`renderer/**`。

### 验证证据（全部实跑，JSON 读 numFailedTests）

```text
RED（实现前）  test/main/server/adminKeyStore.test.ts
  failed=21 passed=42 total=63
  失败原因分两类：ReferenceError(新符号未实现) + AssertionError(行为未实现)
  ⚠️ 其中 2 条红是另一 agent 的 P1-1 写事务测试（chmodSync 未 import / rotate 事务未落地），不是我的

GREEN（实现后）test/main/server/adminKeyStore.test.ts
  green1: failed=1 passed=62  ← 暴露「env 与文件一致」那条真实缺口
  green2: failed=0 passed=63  ← 修掉缺口
  green3: failed=0 passed=65  ← 补 2 条字母表/非 ASCII 断言后

typecheck:node  exit=0（两次：实现中 + 最终）
eslint src/main/server/adminKeyStore.ts + 测试  0 errors, 2283 warnings(全是 prettier CRLF)
  → 对照：未改动的 src/main/server/config.ts 同样 262 warnings/0 errors
  → 且 `git diff --numstat` = 497/56 与 668/5（行级改动，非整文件重写）→ 行尾未被我改动

全量套件  npx vitest run
  full1: failed=0 passed=1578 total=1584 suitesFailed=0
  full2: failed=0 passed=1580 total=1586 suitesFailed=0 suitesPassed=481
  基线 1525 → 现 1580（+55：我 22 条 + 另一 agent 的 P1-1 若干 + 既有）
  interop 那条「产物真的能启动一台服务端」实跑 passed（未 skip）—— 它走 KIRO_ADMIN_KEY
  预置（41 字符 ≥ 32），既不受强度闸门影响、也不落密钥文件故不受 win32 拒启影响
```

### 判据的真实行为（一次性 probe 实测，probe 已删）

```text
MIN=32
generated(43)  -> ok      hex64(64)      -> ok      exactly32(32) -> ok
base64url -_   -> ok      base64 +/=     -> ok
single-x(1)    -> too-short
空格/tab/NUL/DEL/换行 插入 -> bad-chars
CJK(40)        -> bad-chars   ← 白名单可打印 ASCII 的**有意**后果，已单独立测钉住
```

### 未能验证的（诚实标注）

- **NTFS ACL 真实读取**：`unverified` —— 刻意没做（理由见代码注释：只能 shell 出本地化输出的 `icacls`/`Get-Acl`，会静默误判，且给零依赖内核模块引进 `child_process`）。故不存在「ACL 路径能用」的声明。
- **Linux 上真 0600 文件的端到端放行**：`unverified on this machine` —— 本机是 Windows，`chmodSync(0600)` 读回 `0o666`，造不出真 0600 文件。已覆盖的是纯函数 `classifyKeyFilePermission(0o600,'linux') = ok`（既有测试）；端到端那条只能在 Linux 上跑。
- **systemd/Docker 下 journal 真的留副本**：`unverified` —— 这是 P1-4 的前提事实，属公知行为，未在本机搭 systemd 验证。文案措辞按「已在标准输出里」陈述，不声称测过日志系统。

## 三条缺陷的最终裁决

| 缺陷 | 裁决 | 与决策卡的关系 |
|---|---|---|
| P1-5 | 修：单点 `classifyAdminKeyStrength`，min-32，env/file/set 三处同判，启动期拒启 | 卡对预置值强度**无规定** → 补空缺，不违卡 |
| P1-2 | 修：`unenforceable` 改拒启 + `KIRO_ALLOW_UNPROTECTED_KEY_FILE` opt-in（开发机故事） | 卡规则 3「无法设置 0600 则拒绝启动」→ 原实现违卡，本轮回归卡 |
| P1-4 | **保留 stdout 机制，改掉说谎的文案** | 卡明文裁决 stdout → 机制不推翻；但卡自己「否则容器日志留有效凭据」的推理有缺口（第一次打印那份副本已经在那里），代码照抄了这个缺口 → 修文案 + 给真实补救（轮换不打印）+ 给不经日志的路（env 预置） |
