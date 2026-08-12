// 逐函数体对比：旧 index.ts 实现 vs upstreamApi/* 新实现。
// 判据不是「测试绿」而是「函数体语义等价」（抽取的预期行为变化为零，
// 故 diff 比测试更强的证据 —— 测试只能证明它跑过的那些路径）。
//
// 2026-08-12 加固（原版三个假绿缺口，见 ../evidence-scripts-fix/findings.md）：
//  1) 旧侧从**锁定的 git revision** 读，不读工作树 —— 原版读工作树，而 8c42227
//     已把这 20 个函数从 index.ts 删除，于是原版在 HEAD 上直接 throw（EXIT=1），
//     而 classify-diff.cjs 仍读 bodies/ 旧缓存输出 UNEXPECTED=0 —— 证据链已断而不可见。
//  2) 函数集合由 **TypeScript AST 枚举**得出，不再用手写 CASES —— 原版漏列的函数
//     既不会被比对，也不会让 TOTAL 变化，「缺席」与「成功」逐字同形。
//  3) **双向对账**：旧侧删除集合 ⇄ 新模块函数集合必须互相闭合，任何一侧多出/缺失
//     即 EXIT≠0。这才是堵住「静默漏一个函数」的那一步。
//  4) 函数边界由 AST 节点给出，不再是「第一行同缩进的孤立 }」—— 原版遇到函数体内
//     与声明同缩进的独立闭合块会提前截断。
//  5) 行尾空白不参与判据（逐行 trimEnd 后比较）：等价性由 AST/语义对账证明，不靠保留
//     空白。故 src/main/upstreamApi/*.ts 可以清理行尾空白而不削弱本证据。
//  6) --self-test：负向控制。四种假绿情形（漏函数 / 多函数 / 体被截断 / 语义改动）
//     必须各自被判为 issue。没有这一步，下一个人放宽判据时不会有任何信号。
//
// 用法：
//   node extract-bodies.cjs                    旧侧 af94451^ · 新侧工作树
//   node extract-bodies.cjs --new-rev 8c42227  新侧也锁 revision（可复现的定版证据）
//   node extract-bodies.cjs --self-test        只跑负向自测，不碰真实数据
//   node extract-bodies.cjs --tamper-drop <fn> 负向控制：在内存里从新模块侧摘掉一个真实
//                                              函数，断言双向对账必须拦下（EXIT≠0）。
//                                              不写盘，只用于证明闸门在真实数据上是活的。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const GIT_ROOT = 'F:/Kiro-account-manager'
const PREFIX = 'Kiro-account-manager'
const CODE_ROOT = path.join(GIT_ROOT, PREFIX)
const OUT = path.join(CODE_ROOT, '.agent-workspace/.archive/2026-08-12/upstream-api-extract/bodies')

const OLD_REV = 'af94451^'
const INDEX_FILE = 'src/main/index.ts'
const NEW_MODULES = ['transport', 'refresh', 'sso', 'usage'].map((m) => `src/main/upstreamApi/${m}.ts`)

// 旧侧被删除但**不该**出现在新模块里的函数：抽取时被依赖注入消除的两个 helper。
// 依据 review-extraction/review.sonnet.md「旧删除 22 个 = 20 搬移 + 2 DI helper」。
const DI_ELIMINATED = new Set(['getCurrentMachineId', 'getKProxyAgent'])
// 新模块里**不**来自旧 index.ts 的函数：抽取时新建的工厂。
const FACTORY_ONLY = new Set(['createTransport', 'createRefresh', 'createSso', 'createUsage'])

// ---------- 读取：git object 优先，工作树次之 ----------
function readAtRev(rev, repoRelPath) {
  return execFileSync('git', ['-C', GIT_ROOT, 'show', `${rev}:${PREFIX}/${repoRelPath}`], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024
  })
}
function readSource(rev, repoRelPath) {
  return rev ? readAtRev(rev, repoRelPath) : fs.readFileSync(path.join(CODE_ROOT, repoRelPath), 'utf-8')
}

// ---------- AST：枚举顶层与嵌套的 FunctionDeclaration，边界由节点给出 ----------
function functionsIn(text, label) {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out = new Map()
  const dupes = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const start = node.getStart(sf)
      const end = node.getEnd()
      const lineStarts = sf.getLineStarts()
      const startLine = sf.getLineAndCharacterOfPosition(start).line
      const indent = text.slice(lineStarts[startLine], start)
      // dedent：去掉该函数声明行的基准缩进（新实现在工厂闭包内整体多两格）
      const full = text
        .slice(start, end)
        .split(/\r?\n/)
        .map((l, i) => (i === 0 || !l.startsWith(indent) ? l : l.slice(indent.length)))
        .join('\n')
      const name = node.name.text
      if (out.has(name)) dupes.push(name)
      out.set(name, { full: full + '\n', startLine: startLine + 1, endLine: sf.getLineAndCharacterOfPosition(end).line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { fns: out, dupes }
}

// 行尾空白不参与判据（见头部 5）
const canon = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')

// ---------- 核心对账 ----------
function reconcile({ oldIndexText, newIndexText, newModuleTexts, diEliminated = DI_ELIMINATED, factoryOnly = FACTORY_ONLY }) {
  const issues = []
  const oldSide = functionsIn(oldIndexText, 'old/index.ts')
  const curSide = functionsIn(newIndexText, 'new/index.ts')

  const newFns = new Map()
  for (const [rel, text] of Object.entries(newModuleTexts)) {
    const { fns, dupes } = functionsIn(text, rel)
    for (const d of dupes) issues.push({ kind: 'DUPLICATE_IN_MODULE', name: d, file: rel })
    for (const [name, data] of fns) {
      if (newFns.has(name)) issues.push({ kind: 'DUPLICATE_ACROSS_MODULES', name, file: rel, alsoIn: newFns.get(name).file })
      newFns.set(name, { ...data, file: rel })
    }
  }

  // 集合 A：新模块里、且源自旧 index.ts 的函数 = 应当被比对的搬移集合
  const movedFromNew = [...newFns.keys()].filter((n) => !factoryOnly.has(n)).sort()
  // 集合 B：旧 index.ts 有、现 index.ts 已无 = 实际被删除的集合
  const deletedFromOld = [...oldSide.fns.keys()].filter((n) => !curSide.fns.has(n)).sort()

  // === 双向对账（堵「静默漏一个函数」）===
  // B \ (A ∪ DI_ELIMINATED)：删掉了却没在新模块出现，也不是已知被 DI 消除的 → 漏搬
  for (const n of deletedFromOld) {
    if (!movedFromNew.includes(n) && !diEliminated.has(n)) {
      issues.push({ kind: 'DELETED_BUT_NOT_IN_NEW_MODULES', name: n })
    }
  }
  // A \ B：新模块里声称搬来的，旧侧却没被删（或旧侧根本没有）→ 不是纯搬移
  for (const n of movedFromNew) {
    if (!oldSide.fns.has(n)) issues.push({ kind: 'IN_NEW_BUT_ABSENT_FROM_OLD', name: n, file: newFns.get(n).file })
    else if (!deletedFromOld.includes(n)) issues.push({ kind: 'IN_NEW_BUT_STILL_IN_CURRENT_INDEX', name: n, file: newFns.get(n).file })
  }
  // 白名单必须真的被删且真的不在新模块 —— 白名单不得成为死条款
  for (const n of diEliminated) {
    if (!oldSide.fns.has(n)) issues.push({ kind: 'DI_WHITELIST_STALE_NOT_IN_OLD', name: n })
    else if (!deletedFromOld.includes(n)) issues.push({ kind: 'DI_WHITELIST_NOT_ACTUALLY_DELETED', name: n })
    if (newFns.has(n)) issues.push({ kind: 'DI_WHITELIST_RESURFACED_IN_NEW', name: n, file: newFns.get(n).file })
  }

  const pairs = movedFromNew
    .filter((n) => oldSide.fns.has(n))
    .map((n) => ({ name: n, file: newFns.get(n).file, oldBody: canon(oldSide.fns.get(n).full), newBody: canon(newFns.get(n).full) }))

  return { issues, pairs, movedFromNew, deletedFromOld, oldCount: oldSide.fns.size, curCount: curSide.fns.size }
}

// ---------- 负向自测（--self-test）----------
function selfTest() {
  const OLD = `
function alpha(a: number): number {
  if (a > 0) {
    return a
  }
  return 0
}
function beta(): string {
  const m: Record<string, string> = {
    k: 'v'
  }
  return m.k
}
function keeper(): void {}
`.trimStart()
  const CUR = 'function keeper(): void {}\n'
  const NEW_OK = `
export function createTransport() {
  function alpha(a: number): number {
    if (a > 0) {
      return a
    }
    return 0
  }
  function beta(): string {
    const m: Record<string, string> = {
      k: 'v'
    }
    return m.k
  }
  return { alpha, beta }
}
`.trimStart()

  // fixture 自带白名单/工厂集合：本函数验的是对账逻辑，不是真实数据的白名单是否新鲜
  const run = (newText, opts = {}) =>
    reconcile({
      oldIndexText: OLD,
      newIndexText: CUR,
      newModuleTexts: { 'm.ts': newText },
      diEliminated: new Set(),
      factoryOnly: new Set(['createTransport']),
      ...opts
    })
  const cases = []
  const add = (label, res, wantIssueKind, extra) => {
    const kinds = res.issues.map((i) => i.kind)
    const ok = wantIssueKind === null ? res.issues.length === 0 && extra(res) : kinds.includes(wantIssueKind) && (!extra || extra(res))
    cases.push({ label, pass: ok, want: wantIssueKind ?? '(no issues)', gotIssues: kinds })
    return ok
  }

  // 控制组：正确搬移 → 零 issue、2 对、逐对等价
  add('CONTROL clean move ⇒ no issues + 2 pairs equal', run(NEW_OK), null,
    (r) => r.pairs.length === 2 && r.pairs.every((p) => p.oldBody === p.newBody))
  // 负向 1：漏搬一个函数（原版会保持 TOTAL 不变、静默放行）
  add('OMITTED function ⇒ DELETED_BUT_NOT_IN_NEW_MODULES',
    run(NEW_OK.replace(/  function beta\(\): string \{[\s\S]*?\n  \}\n/, '')), 'DELETED_BUT_NOT_IN_NEW_MODULES')
  // 负向 2：新模块多出旧侧不存在的函数
  add('EXTRA function ⇒ IN_NEW_BUT_ABSENT_FROM_OLD',
    run(NEW_OK.replace('  return { alpha, beta }', '  function gamma(): void {}\n  return { alpha, beta, gamma }')),
    'IN_NEW_BUT_ABSENT_FROM_OLD')
  // 负向 3：函数体含与声明同缩进的独立闭合块 —— 原版按「第一个同缩进 }」会截断到
  //          `  }` 处，丢掉后面的 return；AST 边界必须完整覆盖到真正的函数末尾。
  {
    const r = run(NEW_OK)
    const beta = r.pairs.find((p) => p.name === 'beta')
    const ok = !!beta && beta.newBody.includes('return m.k') && beta.oldBody.includes('return m.k')
    cases.push({ label: 'NO TRUNCATION at same-indent inner } ⇒ body reaches return', pass: ok, want: 'full body', gotIssues: [] })
  }
  // 负向 4：语义改动必须以 diff 形式暴露（分类器负责定性，这里只需「不等价」可见）
  {
    const r = run(NEW_OK.replace('return a', 'return a + 1'))
    const alpha = r.pairs.find((p) => p.name === 'alpha')
    cases.push({ label: 'SEMANTIC change ⇒ pair not byte-equal', pass: !!alpha && alpha.oldBody !== alpha.newBody, want: 'inequality', gotIssues: [] })
  }
  // 负向 5：行尾空白**不得**产生差异（P2 排序依据：清理空白不削弱本证据）
  {
    const r = run(NEW_OK.replace('    return a\n', '    return a   \n'))
    const alpha = r.pairs.find((p) => p.name === 'alpha')
    cases.push({ label: 'TRAILING WS ⇒ ignored, still equal', pass: !!alpha && alpha.oldBody === alpha.newBody, want: 'equality', gotIssues: [] })
  }

  // 负向 6/7：白名单自身必须可被证伪（防它变成死条款：写了却永不触发）
  add('STALE DI whitelist (name not in old) ⇒ DI_WHITELIST_STALE_NOT_IN_OLD',
    run(NEW_OK, { diEliminated: new Set(['ghostHelper']) }), 'DI_WHITELIST_STALE_NOT_IN_OLD')
  add('DI-whitelisted name resurfacing in new modules ⇒ DI_WHITELIST_RESURFACED_IN_NEW',
    run(NEW_OK, { diEliminated: new Set(['alpha']) }), 'DI_WHITELIST_RESURFACED_IN_NEW')

  for (const c of cases) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.pass ? '' : `  [want=${c.want} got=${JSON.stringify(c.gotIssues)}]`}`)
  const failed = cases.filter((c) => !c.pass).length
  console.log(`\nSELFTEST TOTAL=${cases.length} PASSED=${cases.length - failed} FAILED=${failed}`)
  return failed === 0
}

// ---------- main ----------
const argv = process.argv.slice(2)
if (argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}
const newRevIdx = argv.indexOf('--new-rev')
const NEW_REV = newRevIdx >= 0 ? argv[newRevIdx + 1] : null

const oldIndexText = readSource(OLD_REV, INDEX_FILE)
const newIndexText = readSource(NEW_REV, INDEX_FILE)
const newModuleTexts = Object.fromEntries(NEW_MODULES.map((rel) => [rel, readSource(NEW_REV, rel)]))

// --tamper-drop <fn>：负向控制。从新模块侧删掉一个真实函数的声明，双向对账必须报
// DELETED_BUT_NOT_IN_NEW_MODULES 并非零退出。用 AST 定位边界，不用正则啃括号。
const dropIdx = argv.indexOf('--tamper-drop')
if (dropIdx >= 0) {
  const victim = argv[dropIdx + 1]
  let removedFrom = null
  for (const rel of NEW_MODULES) {
    const text = newModuleTexts[rel]
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let range = null
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === victim && node.body) {
        range = [node.getStart(sf), node.getEnd()]
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (range) {
      newModuleTexts[rel] = text.slice(0, range[0]) + text.slice(range[1])
      removedFrom = rel
      break
    }
  }
  if (!removedFrom) {
    console.log(`TAMPER FAILED: ${victim} not found in new modules — 负向控制本身无效`)
    process.exit(3)
  }
  console.log(`[TAMPER] dropped ${victim} from ${removedFrom} (in memory only)`)
  const r = reconcile({ oldIndexText, newIndexText, newModuleTexts })
  const caught = r.issues.some((i) => i.kind === 'DELETED_BUT_NOT_IN_NEW_MODULES' && i.name === victim)
  console.log(`PAIRS=${r.pairs.length}  ISSUES=${r.issues.length}`)
  for (const i of r.issues) console.log('  ' + JSON.stringify(i))
  console.log(`\nCAUGHT_OMISSION=${caught}`)
  process.exit(caught ? 0 : 1)
}

const { issues, pairs, movedFromNew, deletedFromOld, oldCount, curCount } = reconcile({ oldIndexText, newIndexText, newModuleTexts })

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'old'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'new'), { recursive: true })
// CACHEDIR.TAG：让 Invoke-SafeClean 认得这棵临时树（首 43 字节精确匹配）
fs.writeFileSync(
  path.join(OUT, 'CACHEDIR.TAG'),
  'Signature: 8a477f597d28d172789f06886806bc55\n# temp extraction-diff tree, safe to remove\n'
)
// 出处元数据：让下游（classify-diff.cjs）能验证缓存是不是本轮、由哪个 revision 产出
fs.writeFileSync(
  path.join(OUT, 'PROVENANCE.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), oldRev: OLD_REV, newRev: NEW_REV ?? '(worktree)', pairCount: pairs.length, names: pairs.map((p) => p.name) },
    null, 2
  ) + '\n'
)

let identical = 0
const differing = []
for (const p of pairs) {
  fs.writeFileSync(path.join(OUT, 'old', `${p.name}.ts`), p.oldBody)
  fs.writeFileSync(path.join(OUT, 'new', `${p.name}.ts`), p.newBody)
  if (p.oldBody === p.newBody) identical++
  else differing.push(p.name)
}

console.log(`OLD_REV=${OLD_REV} (${oldCount} fns)  NEW=${NEW_REV ?? 'worktree'} (index.ts now ${curCount} fns)`)
console.log(`DELETED_FROM_OLD=${deletedFromOld.length}  MOVED_IN_NEW_MODULES=${movedFromNew.length}  PAIRS=${pairs.length}`)
console.log(`TOTAL=${pairs.length} IDENTICAL=${identical} DIFFERING=${differing.length}`)
if (differing.length) console.log('DIFFERING: ' + differing.join(', '))
if (issues.length) {
  console.log('\nRECONCILIATION ISSUES:')
  for (const i of issues) console.log('  ' + JSON.stringify(i))
}
console.log(`\nISSUES=${issues.length}`)
// 无法产出任何配对，或双向对账不闭合 ⇒ 证据不成立，必须非零退出
if (issues.length || pairs.length === 0) process.exitCode = 1
