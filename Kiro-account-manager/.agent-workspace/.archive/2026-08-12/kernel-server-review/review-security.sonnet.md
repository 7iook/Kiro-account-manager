# AdminKeyStore / AES-GCM 独立安全审查

- 审查日期：2026-08-12
- 审查基线：`3354d50ff2904860cc3798f43ba5ead109371582`
- 实际 HEAD：`3354d50ff2904860cc3798f43ba5ead109371582`
- 范围：`src/main/server/adminKeyStore.ts`、`src/main/secureBackupCipher.aesGcm.ts` 及指定测试；被排除文件仅用于 caller/wiring 证据。
- 审查方式：只读；未修改业务代码，未 add/commit/stash，未读取真实账号凭据文件。

## Strengths

- `src/main/webPanel/auth.ts:214-215`：自动生成 adminKey 使用 32-byte CSPRNG 并编码为 43 字符 base64url，提供 256-bit 随机熵；正式测试覆盖格式与两次生成不相同。
- `src/main/server/adminKeyStore.ts:138-158`：POSIX 判据精确拒绝 group/other 的任意权限位；`src/main/server/adminKeyStore.ts:365-367` 在 rename 前写入并 chmod 临时文件，避免目标路径先以宽权限暴露。
- `src/main/server/adminKeyStore.ts:181-225`：正确区分“env 未定义”和“env 已定义但为空”，env/file 冲突错误只点名来源，不包含密钥明文。
- `src/main/secureBackupCipher.aesGcm.ts:109-116`：每次生成独立 16-byte salt、12-byte IV，并保存 16-byte authentication tag；没有固定 IV 或 tag 丢失。
- `src/main/secureBackupCipher.aesGcm.ts:119-152`：先校验信封长度和 magic，再设置 tag，由 `decipher.final()` 强制认证；错密钥、密文/tag 篡改均抛错。
- `src/main/secureBackup.ts:145-229`：`.enc` 存在但解密或解析失败时异常上浮，不会与“备份不存在”的 `null` 混淆。
- 没有证据要求把密文绑定到机器或路径；加入这类 AAD 会损害备份迁移性，因此不把“缺少路径/机器 AAD”制造成缺陷。

## Verification evidence

正式测试实际执行：

```text
npx vitest run test/main/server/adminKeyStore.test.ts test/main/secureBackup/aesGcmCipher.test.ts --reporter=json --outputFile=.agent-workspace/review-security-vitest.json
JSON: suites 13/13 passed; tests 49/49 passed; failed 0; success=true
```
独立故障注入实际执行（一次性 probe，报告完成前删除）：

```text
npx vitest run test/main/server/review-security-rotate-repro.test.ts --reporter=json --outputFile=.agent-workspace/review-security-rotate-repro.json
JSON: suites 2/2 passed; tests 2/2 passed; failed 0; success=true
passed: leaves runtime on old key, disk/restart on unreturned new key
passed: persists a generated key before a failing one-time print and never prints it on restart
```

Windows 权限最简实测：

```json
{"platform":"win32","mode":"666"}
```

限定 Git 验证：`git rev-parse HEAD` 返回基线 SHA；`git diff 3354d50..HEAD -- <四个范围文件>` 以及四个范围文件的工作区 diff 均为空。

## 7-Phase Check

### Phase 1 - Spec Conformance

未通过。POSIX 主路径、env/file 冲突和 AES-GCM 基本契约符合；但 Windows 放行直接违反决策卡“若无法设置 0600 则拒绝启动”，且首次输出失败窗口违反负向验收 ③。详见 P1-2、P1-3。

### Phase 2 - Task-Ledger Evidence Gate

not applicable：仓库不存在 `docs/specs/`，`git ls-files "docs/specs/**/tasks.md"` 无输出；本次权威 decision card 也没有 `## 任务清单`，因此没有 `[x]` Evidence 四项可核验。

### Phase 3 - Code Quality

未通过。AES-GCM 的端口分层、信封格式和错误语义清晰；AdminKeyStore 的 rotate 写入却把 rename、权限复检和内存提交拆成非事务状态，且注释与真实控制流相反。

### Phase 4 - Domain-Model Consistency

not applicable：仓库不存在 `docs/domain/*-model.md`。

### Phase 5 - Upstream Root Cause

未通过。P1-1 的最早正确责任层是 `writeKeyFileSecurely` 的替换事务边界；不能在 `PanelAuth` 下游用条件分支掩盖磁盘已提交的事实。P1-4 的根因位于引导交付契约，不应靠日志脱敏后继续声称用户收到密钥。
### Phase 6 - Whole-Path Completeness

通过生产 wiring 检查，但功能质量仍被下列 P1 阻断。执行顺序：先 `codegraph sync "F:\Kiro-account-manager\Kiro-account-manager" -q`，再查询 callers。原始输出如下。

```json
{
  "symbol": "createAesGcmBackupCipher",
  "callers": [
    {
      "name": "kernelWithoutElectron.runtime.test.ts",
      "kind": "file",
      "filePath": "test/main/kernelWithoutElectron.runtime.test.ts",
      "startLine": 1
    },
    {
      "name": "aesGcmCipher.test.ts",
      "kind": "file",
      "filePath": "test/main/secureBackup/aesGcmCipher.test.ts",
      "startLine": 1
    },
    {
      "name": "buildStoreDeps",
      "kind": "function",
      "filePath": "src/main/server/assembly.ts",
      "startLine": 430
    },
    {
      "name": "assembly.ts",
      "kind": "file",
      "filePath": "src/main/server/assembly.ts",
      "startLine": 1
    }
  ]
}
```
```json
{
  "symbol": "createServerAdminKeyStore",
  "callers": [
    {
      "name": "bootstrap",
      "kind": "function",
      "filePath": "src/main/server/entry.ts",
      "startLine": 57
    },
    {
      "name": "adminKeyStore.test.ts",
      "kind": "file",
      "filePath": "test/main/server/adminKeyStore.test.ts",
      "startLine": 1
    },
    {
      "name": "entry.ts",
      "kind": "file",
      "filePath": "src/main/server/entry.ts",
      "startLine": 1
    }
  ]
}
```

`assembly.ts` 与 `entry.ts` 仅作为 caller 位置证据，未评价其实现。两项工厂都有非测试生产 caller，不存在 E-052 式“只有测试调用”。

交付契约核验：权威 success/negative 条件仍在 `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:458-470`；该工件没有 `[交付契约]`/§0.16 link-table 形式，因此无法按新模板核验每格锚点，但这不是本次实现自行引入的缺失，不升级为代码 Critical。

### Phase 7 - Business Reality / YAGNI

通过。AdminKeyStore 回答无头服务管理员登录与轮换的真实运维需求；AES-GCM 回答服务器备份中 token/代理凭据的静态保护需求。没有发现为“架构对称”而创建的平行实现；不建议凭空增加机器/路径绑定或额外 read-path limiter。

## Issues

### Critical / P0 (Must Fix)

无。现有证据没有远程接管、不可恢复数据丢失或所有平台必现拒服；不为显得严格而制造 P0。
### Important / P1 (Should Fix)

#### P1-1 轮换在权限复检失败后形成内存/磁盘/重启三态分叉

- `src/main/server/adminKeyStore.ts:365-380,450-466`
- **What**：`renameSync(temp, file)` 已把新 key 提交到目标路径，随后权限复检抛错；`rollbackOnPermissionFailure:false` 不恢复旧文件，`current = next` 又不会执行。注释“盘上仍是旧密钥”与控制流相反。
- **Why**：故障注入复现为当前进程仍接受旧 key、磁盘和重启后改用调用方从未收到的新 key；`src/main/webPanel/auth.ts:133-137` 还会因 `set()` 抛错而跳过 session invalidation。运维可能在重启后突然失去管理入口，既存会话却在重启前继续有效。
- **Reproduction**：上述 JSON probe 的 `leaves runtime on old key, disk/restart on unreturned new key` 已真实通过。
- **How**：在 `writeKeyFileSecurely` 的事务边界保存并可恢复旧目标，只有权限复检成功后才提交磁盘/内存状态；增加 post-rename 复检失败的正式回归测试。

#### P1-2 Windows 无法证明密钥仅服务账户可读，却只告警放行

- `src/main/server/adminKeyStore.ts:138-158,312-324`；权威规则 `.agent-workspace/.archive/2026-08-10/server-migration-decision/decision-card.md:458-470`
- **What**：win32 固定返回 `unenforceable`，`enforceKeyFilePermission` 告警后继续；这直接违背“若无法设置 0600 则拒绝启动”。本机实测 `chmodSync(0600)` 后 mode 为 `0666`，证明 POSIX 位不能作为保护证据。
- **Why**：共享 Windows 主机若 dataDir 继承了宽 NTFS ACL，同机其他账户可读取有效管理员凭据；告警不能建立访问控制。
- **How**：在 Windows 读取并验证实际 NTFS ACL、无法证明仅服务账户可读时拒启；若产品明确不支持 Windows 服务端，应在入口和契约中显式拒绝而不是安全降级。

#### P1-3 首次生成在持久化后才输出，输出失败会留下永不再次展示的 key

- `src/main/server/adminKeyStore.ts:241-247,350-393`
- **What**：新 key 先 rename 落盘，再调用可抛的 `print`；print 失败时构造未返回，但文件保留，下一次启动按“已有文件”路径不再输出。
- **Why**：stdout/journal sink 断开、容器日志驱动失败或测试注入异常时，首次部署违反负向验收 ③。运维若没有直接读取服务账户私有文件的通道，会表现为服务启动失败后再启动却没有登录凭据。
- **Reproduction**：上述 JSON probe 的 `persists a generated key before a failing one-time print and never prints it on restart` 已真实通过。
- **How**：把“凭据已可靠交付”纳入 bootstrap 事务；输出失败时回滚尚未交付的生成文件，或使用可确认的一次性交付介质并在确认后提交。
#### P1-4 把长期有效管理员凭据写入 stdout，使“一次打印”变成日志系统中的长期副本

- `src/main/server/adminKeyStore.ts:397-424`
- **What**：bootstrap notice 将完整 adminKey 写到 stdout；在 systemd、Docker 和集中日志场景中，写一次并不等于只保留一次，journal/collector/备份会持久化并扩大可读者范围。
- **Why**：能读运维日志但不应有面板管理权限的支持人员或日志系统账号，可直接取得长期有效凭据；这与文案声称“之后不打印，否则容器日志长期留有效凭据”的威胁模型自相矛盾。
- **How**：上游修改首次交付契约：优先写服务账户专属 secret 文件并只输出路径/指纹，或使用有 TTL/消费即删的一次性通道；若必须经日志交付，则必须明确访问控制、保留期和强制首次轮换。

#### P1-5 预置 adminKey 只检查非空，允许单字符管理员密码

- `src/main/server/adminKeyStore.ts:181-225`
- **What**：自动生成路径有 256-bit 强度，但 env/file 预置路径只 trim 和判空；`KIRO_ADMIN_KEY=x` 会被接受为公网面板管理员凭据。
- **Why**：运维 typo 或弱配置把强随机默认值降级为可在线猜测的共享秘密；错误不会在启动期暴露，直到登录被撞开才可见。
- **How**：在来源归一化的单一入口验证统一格式/最小强度，优先要求与生成器相同的 32-byte base64url 值；如必须支持 passphrase，定义明确长度策略并在 env/file 两条路径一致执行。

### Minor / P2 (Nice to Have)

#### P2-1 AES 仅用字符数作为口令护栏，明显低熵的 32 字符值仍通过

- `src/main/secureBackupCipher.aesGcm.ts:51-55,79-104,172-175`
- **What**：`'a'.repeat(32)` 满足门槛；scrypt 增加离线猜测成本，但不会把低熵口令变成高熵秘密。
- **Why**：备份可被复制后无限离线攻击，重复字符或常见长口令仍可能暴露 token 与代理凭据。不过可靠“熵检测”不可由简单规则完成，故不升级为 P1。
- **How**：部署文档和启动提示要求密码管理器生成的随机值，提供生成命令并新增明显退化值的策略测试；不要以复杂度评分器冒充真实熵证明。

## Checked without findings

- `classifyKeyFilePermission(0o000, 'linux')` 返回 ok 符合“不得比 0600 更宽”的保密上界；普通服务用户的实际可读性会在更早的 `readFileSync` 暴露，不构成权限放宽。
- AES-GCM 的 IV 长度、每次随机性、tag 处理、32-byte 派生 key、截断信封、错 key/tamper 失败语义均有源码和实际测试证据。
- AES 解密失败不会被 `secureBackup.ts` 降级为“备份不存在”。
- 错误文本未包含 env/file adminKey 明文；真正的明文泄露面是刻意的 bootstrap stdout，已单列 P1-4。
## Severity summary

- P0 / Critical：0
- P1 / Important：5
- P2 / Minor：1

## VERDICT
status: NEEDS_CHANGES
critical_count: 0
important_count: 5
minor_count: 1
ready_to_merge: WITH_FIXES
one_line: AES-GCM 核心构造与生产接线成立，但 AdminKeyStore 存在可复现的轮换/首启事务缺口、Windows 权限契约失守及凭据交付风险。
