# 证据脚本加固 · P1-1 / P1-2 / P2

- 仓库 `F:\Kiro-account-manager`(git root)· 代码 `Kiro-account-manager\`· HEAD `8c42227`
- 派单来源:`.agent-workspace/.archive/2026-08-12/review-extraction/review.sonnet.md`(Important ×2 + Minor ×1)
- 日期:2026-08-12 · 执行者:sub-agent(executor)

## 0. 开工基线(先取证,后动手)

三条命令的真实读数,全部 `*> file` + `$LASTEXITCODE` 取退出码,不走管道:

| 项 | 命令 | 结果 |
|---|---|---|
| 旧提取器 | `node extract-bodies.cjs` | **EXIT=1 · 抛异常** `not found: getRestApiBase in src/main/index.ts` |
| 旧分类器 | `node classify-diff.cjs` | `TOTAL CHANGED LINES=15 UNEXPECTED=0` · **EXIT=0** |
| 空白闸门 | `git diff --check af94451^ 8c42227 -- Kiro-account-manager/src/main` | **EXIT=2** · 17 处,锚点与评审所列逐一吻合 |

落盘:`before-extract.txt` / `before-classify.txt` / `ws-check-before.txt`(均在 `.archive/2026-08-12/`)。

## 1. 比评审所报更严重:提取器**当前已经跑不动**,而分类器照绿

评审把 P1-2 描述为「未来重跑可能截断 / 漏函数」的**潜在**缺陷。实测不是潜在,是**已经发生**:

- `8c42227` 已把这 20 个函数从 `index.ts` 删除(6467 → 5998 行),提取器的旧侧读的是**工作树**的 `src/main/index.ts`,所以第一个函数就 `throw` → EXIT=1。
- 但 `classify-diff.cjs` 读的是 `bodies/` 里**上一轮留下的缓存**,于是它在「生产者已经彻底失效」的情况下,依然输出 `UNEXPECTED=0` 且 **EXIT=0**。

即这套证据当前的真实状态是:**结论是对的(评审用独立 AST 证过 20/20),但产出结论的工具链已经断了,而断裂在输出里完全不可见。** 这正是本仓反复吃到的假绿形状(P-01/P-02),且比「漏一个函数」更彻底 —— 漏一个是少一份证据,这个是整份证据都来自无法再生的缓存。

### 1.1 附带发现:旧分类器**从不非零退出**

`classify-diff.cjs` 全文没有任何 `process.exitCode` 赋值。它数出 `unexpected` 并打印,但无论 N 多大都 EXIT=0。所以它**无法作为闸门接入任何流水线**——CI 只看退出码的话,`UNEXPECTED=99` 与全绿逐字同形。评审未提到这一点(它读的是 regex 锚定问题),但同属「判定器读数不可信」母题,一并修。

## 2. P1-1 分类器：整行锚定 + 非零退出 + 缓存出处校验 + 规则活性

改动(`upstream-api-extract/classify-diff.cjs`,原版留档 `.cjs.orig`):

1. **整行锚定**。两条 device-ID 规则由 `/getCurrentMachineId\(\)$/` 扩为三条整行锚定规则,覆盖真实数据里实际出现的三种形态(`accountMachineId ||` 两种 + 裸调用一种)。dedent 已由提取器归一,故行内缩进可以稳定写进正则。
2. **非零退出**。`unexpected>0` 或有死条款 → `process.exitCode=1`;缓存缺失/出处不符 → `exit 2`。原版恒 0。
3. **缓存出处校验**。要求 `bodies/PROVENANCE.json` 存在,且其 `names` 与 `bodies/old/` 目录内容一致;输出打印 `oldRev`/`newRev`/`generatedAt`。这一条直接堵住 §1 那个「生产者已死、消费者照绿」。
4. **规则活性自检**。每条 SEAM 规则必须在真实数据里 ≥1 命中,零命中报 `STALE_RULE` 并非零退出 —— 防止规则写了却永不触发(死条款,与放宽正则同形)。
5. 行尾空白不再产生差异行(`canonLine` trimEnd)。

### 负向控制(前后对照 · `negctl-classifier-old-vs-new.cjs`)

同一批样本喂旧/新两套规则表,唯一变量是正则锚定方式:

| 样本 | 旧 | 新 |
|---|---|---|
| 真实 seam(必须保持 SEAM) | SEAM | SEAM ✓ |
| **篡改前缀 `accountMachineId`→`attackerControlled`**(评审原始复现) | **SEAM** | **UNEXPECTED** ✓ |
| 篡改:丢掉 `accountMachineId` 兜底 | **SEAM** | **UNEXPECTED** ✓ |
| 篡改:注入 `leakToRemote() ||` | **SEAM** | **UNEXPECTED** ✓ |

`badSemanticChangeStillClassifiedSeam`:**旧 `true` → 新 `false`**(复现评审同名读数并翻转)。`REGRESSIONS=0`,EXIT=0。

### 内建自测(`--self-test`)

9 条:3 控制组(真 seam×2 / export×1 必须仍被接受)+ 6 负向(前缀篡改 / 丢兜底 / 条件取反 / 左值改名 / 比较字面量改动 / 行尾空白不算改动)。`TOTAL=9 PASSED=9 FAILED=0` EXIT=0。控制组和负向组同时在场——只有负向会让「把所有行都判 UNEXPECTED」这种过度修复也通过。

## 3. P1-2 提取器:锁 revision + AST 枚举 + 双向对账

改动(`extract-bodies.cjs`,原版留档 `.cjs.orig`):旧侧 `git show af94451^:...` 锁定;`--new-rev` 可把新侧也锁定;函数集合由 TypeScript AST 枚举;函数边界取 AST 节点;双向对账;行尾空白不参与判据;`--self-test` 与 `--tamper-drop <fn>` 两个负向入口;产出 `PROVENANCE.json`。

双向对账的判据(9 类 issue),核心三条:
- `DELETED_BUT_NOT_IN_NEW_MODULES` —— 旧侧删了、新模块没有、也不在 DI 白名单 ⇒ **漏搬**
- `IN_NEW_BUT_ABSENT_FROM_OLD` / `IN_NEW_BUT_STILL_IN_CURRENT_INDEX` —— 新模块多出的、或旧侧根本没删的 ⇒ 不是纯搬移
- `DI_WHITELIST_*` ×3 —— 那两个「被 DI 消除」的 helper 必须真被删且真不在新模块;白名单不得成为死条款

### 负向控制(前后对照)

**A · 漏搬一个函数**(`negctl-extractor-old-vs-new.cjs`,旧脚本给了最好条件:旧侧也读 `af94451^`,唯一变量是函数集合来源):

```
=== OLD extractor (hand-written CASES, ssoDeviceAuth omitted) ===
TOTAL=19 IDENTICAL=6 DIFFERING=13
ssoDeviceAuth compared? false
OLD_SILENTLY_ACCEPTS_OMISSION=true          ← 输出无任何缺失信号,exit 恒 0
```
```
=== NEW extractor, same omission (--tamper-drop ssoDeviceAuth) ===
PAIRS=19  ISSUES=1
  {"kind":"DELETED_BUT_NOT_IN_NEW_MODULES","name":"ssoDeviceAuth"}
CAUGHT_OMISSION=true
```

**这是本轮最强的一条证据**:旧版少比一个函数,`TOTAL` 只是从 20 变成 19,而 20 与 19 都没有独立含义(它就等于 `CASES.length`),所以「缺席」与「成功」在输出里逐字同形。新版把「应该有多少」从手写清单改成 git 事实推导(旧侧删了什么),缺席才有了信号。

**B · 内建自测** `--self-test`:8 条(1 控制组 + 5 负向 + 2 白名单活性)。`TOTAL=8 PASSED=8 FAILED=0` EXIT=0。
> 自测第一版曾 `FAILED=1` —— 我自己写的白名单校验硬绑模块常量,在合成 fixture 上必然误报。改成可传参后 8/8。**负向自测在第一次运行就抓到了我自己的缺陷**,这正是它存在的理由。

## 4. 对评审 P1-2「截断」一条的定性修正(实测后降级)

评审说提取器「以第一行同缩进的孤立 `}` 结束函数,会截断带同缩进嵌套块的函数」。分三种情形核实,结论是**机制成立,但本仓真实数据未命中** —— 属评审给的三档里的第二档:

**机制成立**(`audit-truncation-mechanism.cjs`):两种形态都真截断,且丢掉的正是 `return`:

| 形态 | 截断 | 捕获 | 丢失的尾部 |
|---|---|---|---|
| A 顶层函数体内出现 0 格 `}` | **true** | 4/6 行 | `["  return cfg.a + \"\"", "}"]` |
| B 工厂闭包内 2 格缩进同款 | **true** | 4/7 行 | `["    )", "    return t.length", "  }"]` |

**但真实数据零命中**(`audit-truncation-real-data.cjs`):20 个函数 × 旧/新两侧 = 40 次比对,旧启发式行数与 AST 节点行数**全部一致**,`TRUNCATED_OLD_SIDE=0 TRUNCATED_NEW_SIDE=0`。含 `ssoDeviceAuth` 172 行、`getUsageAndLimits` 144 行、`getUsageLimitsRest` 82 行、`kiroApiRequest` 73 行这些最深嵌套的块,旧启发式也没截断。

**定性**:这是**潜在缺陷、本轮未命中**,不是「已交付的等价证据不完整」。已交付那 20 份 `bodies/` 缓存的函数边界是完整的(评审自己的独立 AST 也已确认 20/20 等于完整 AST 节点,与本轮 40/40 行数一致互为交叉验证)。修法(AST 边界)仍然值得做——它把「这次恰好没触发」变成「结构上不可能触发」——但严重性应从「证据不完整」降到「证据脆弱」。

**与 §1 的严重性对比**:评审把「读工作树」和「截断」并列为同一条 P1-2 的三个子问题。实测下来两者相差很远——读工作树**已经**让提取器在 HEAD 上完全失效(EXIT=1),而截断**从未**发生。真正的 P0 级假绿是前者(且评审未指出「分类器仍照绿」这一半),截断只是第三顺位。

## 5. P2 · 17 处尾随空白:先修脚本,后删空白(顺序及理由)

**我选的顺序:P1-2 先、P2 后。** 理由不是偏好,是依赖关系:

删空白是否安全,取决于「逐字节等价」这个判据还在不在承重。原实现者当初**特意**用 `restore-ws.cjs` 把 `write_file` 剥掉的 9 行空白写回去,其判据原文是「验收判据是逐字节等价;顺手规整空白正是任务书禁止的那类改动」。核查后确认这个坚持有事实基础:`af94451^` 的 `index.ts` 对应行**本身就带尾随空白**(`freeTrialExpiry ... 'number' ` 与 `expiresAt ... 'number' ` 各 2 处命中),所以抽取确实是逐字节忠实搬移,不是把空白搬错了。

在那个判据下先删空白,会让当时唯一的等价证明当场失效。修完 P1-2 之后判据变了——新提取器与新分类器两侧都对每行 `trimEnd` 后再比,等价性由 AST 节点边界 + 双向对账证明,不再依赖空白。**故顺序只能是先换判据、再清空白**;反过来会有一段时间「证据已失效而空白已删」,那正是本轮要消灭的假绿形态。

删法:`edit_lines replace_pattern`(行号寻址,载荷纯 ASCII,不经 shell —— 非 ASCII 载荷过命令行是本机实测 4× 损坏率的那一类)。

### 结果与副作用核查

| 项 | 命令 | 前 | 后 |
|---|---|---|---|
| 空白闸门(工作树) | `git diff --check -- .../upstreamApi` | EXIT=2 · 17 处 | **EXIT=0 · 0 处** |
| 忽略空白的 diff | `git diff -w --stat -- .../upstreamApi` | — | **空**(证明只改了空白) |
| 改动行数 | `git diff --numstat` | — | 3/1/2/11 = **17 行,增删对称** |
| EOL | `[IO.File]::ReadAllBytes` 逐字节数 | — | **CRLF=0,bareLF=240/190/256/332**,首字节 `47,42,42`(`/**`,无 BOM) |

`git` 打的 `LF will be replaced by CRLF` 是本仓 `core.autocrlf` 的既有提示(四个文件在我改之前就是纯 LF,改后仍是纯 LF),不是我引入的换行改动。

## 6. 全套件与构建(生产代码必须保持绿)

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck:node` | **EXIT=0** |
| 服务端构建 | `npm run build:server` | **EXIT=0**(webPanel 亦成功) |
| 全套件 | `npx vitest run --reporter=json` | **1676 passed / 0 failed / 6 skipped**,suites **513/513**,`success=true`,**EXIT=0** |

派单给的底线是 1671 passed;实测 1676 —— 高出的 5 条来自另一 agent 本轮新增的 server 自启测试(`test/main/server/`),不是我的改动。退出码一律 `*> file` + `$LASTEXITCODE`,不走管道。

## 7. 重跑真实数据:原结论仍成立(未出现新发现)

更严格的两版脚本跑在**已清空白**的工作树上:

```
OLD_REV=af94451^ (66 fns)  NEW=worktree (index.ts now 44 fns)
DELETED_FROM_OLD=22  MOVED_IN_NEW_MODULES=20  PAIRS=20
TOTAL=20 IDENTICAL=7 DIFFERING=13
ISSUES=0                                    EXIT=0

SOURCE oldRev=af94451^ newRev=(worktree)
TOTAL CHANGED LINES=15  UNEXPECTED=0  STALE_RULES=0  PROVENANCE=OK   EXIT=0
```

**20 函数 / 15 处预期差异 / 零意外 —— 与原结论一致,严格化没有翻出新东西。** 且这次的 20 是从「旧侧删了 22 个 = 20 搬移 + 2 DI helper」双向推导出来的,不再是手写清单的长度;15 处的构成仍是 7 EXPORT + 8 SEAM,七条 SEAM 规则全部有命中(`STALE_RULES=0`)。

顺带确认「清空白不削弱证据」不是推理而是实测:同一套脚本在清空白**之前**(`--new-rev 8c42227`,即带空白的提交)和**之后**(工作树)都给出 `TOTAL=20 / 15 / UNEXPECTED=0 / ISSUES=0`。

### 缓存出处闸门的负向控制

把 `PROVENANCE.json` 藏起来(复刻 §1 那个「生产者已死、消费者照绿」的真实形态):

```
!! MISSING PROVENANCE.json — bodies/ 不是由当前版 extract-bodies.cjs 产出。
TOTAL CHANGED LINES=0  UNEXPECTED=0  STALE_RULES=0  PROVENANCE=MISSING
EXIT=2                     ← 旧版在同一情形下输出 UNEXPECTED=0 且 EXIT=0
```
恢复后立即回绿 EXIT=0。

## 8. 遗留 · 未验证 · 边界

- `unverified: 桌面应用未真跑`。本轮结论均为源码级 / AST 级 / 单测级。生产代码只被删了 17 处行尾空白,`git diff -w` 为空,故行为风险实质为零,但「真跑一次桌面」这件事本轮没做。
- 生产改动仅限四个 `src/main/upstreamApi/*.ts` 的行尾空白。`src/main/index.ts` / `proxy/**` / `renderer/**` / `server/**` 零改动(`git status` 显示 `server/entry.ts` 与 `ipc/panelProxyDeps.ts` 的 ` M` 属另一 agent)。
- 未 `git add` / `git commit` / `git stash`。
- 原版脚本留档 `upstream-api-extract/*.cjs.orig`,旧 `bodies/` 缓存留档 `evidence-scripts-fix/bodies-cache-before/`,供复核前后差异。
- 新提取器会 `rmSync` 重建 `bodies/`(旧版是叠加写),故「上一轮残留文件冒充本轮产物」这条路也一并断了。
- **建议(未做,超出本轮范围)**:这两个脚本现在都有非零退出与 `--self-test`,已具备接入 pre-commit / CI 的条件。但它们锚定 `af94451^` 这个历史 revision,属一次性抽取的验收工具,长期价值在于「下次做同类抽取时复用」,不适合常驻闸门。若要常驻,应改为参数化 revision + 函数集合。

## Update Log

- 2026-08-12 · executor · P1-1 / P1-2 / P2 三项修完。**关键发现:提取器在 HEAD 上已经完全失效(EXIT=1),而分类器仍读旧缓存输出 `UNEXPECTED=0` 且 EXIT=0 —— 比评审所报的「未来可能」严重,是已经发生的证据链断裂,且断裂在输出里不可见。** 修法:提取器锁 git revision + AST 枚举 + 双向对账 + `PROVENANCE.json`;分类器整行锚定 + 非零退出 + 出处校验 + 规则活性自检;两者各带 `--self-test`(8/8、9/9 全过)。负向控制均给出前后对照:`badSemanticChangeStillClassifiedSeam` 旧 true → 新 false;漏搬 `ssoDeviceAuth` 旧 `TOTAL=19` 静默放行 → 新 `DELETED_BUT_NOT_IN_NEW_MODULES` 拦下;藏掉 provenance 旧照绿 → 新 EXIT=2。**对评审一条定性下修**:「同缩进 `}` 截断」机制实测成立(两种形态都丢 `return`),但真实 20 函数 × 两侧 = 40 次比对**零命中**,属「潜在缺陷本轮未触发」,不是已交付证据不完整。P2 顺序选「先修脚本后删空白」,因删空白的安全性依赖判据已从逐字节改为 AST 语义;实测 `af94451^` 原文确实带这些尾随空白,原实现者的坚持有事实基础。踩到的坑:① 我自己写的白名单校验硬绑模块常量,负向自测第一次运行就抓到(FAILED=1),改成可传参后 8/8 —— 自测的价值当场兑现;② `edit_lines` 的 `expectedLines` 是「实际改动行数」不是「范围跨度」,首次传范围行数被拒(文件未变),按提示改正。
