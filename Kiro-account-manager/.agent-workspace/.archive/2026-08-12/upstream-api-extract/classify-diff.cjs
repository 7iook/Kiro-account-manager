// 最终证据：列出 20 个函数体里**每一处**与 index.ts 旧实现不同的行，逐行分类。
// 分类只有三种合法值：EXPORT(加 export 关键字) / SEAM(状态注入缝位) / UNEXPECTED。
// 出现任何 UNEXPECTED = 抽取引入了非预期改动，必须回去修。
//
// 2026-08-12 加固（原版三个假绿缺口，见 ../evidence-scripts-fix/findings.md）：
//  1) **整行锚定**：原版两条 device-ID 规则只写 `/getCurrentMachineId\(\)$/`（仅锚行尾），
//     于是同一行 `=` 左侧任意语义改动仍被判 SEAM。控制实验：把
//     `const machineId = accountMachineId || deps.getDeviceIdForUa()` 改成
//     `const machineId = attackerControlled || deps.getDeviceIdForUa()` 照样 SEAM。
//     现在每条规则两端都用 `^...$` 锚定整行（缩进已由 dedent 归一）。
//  2) **非零退出**：原版全文没有 process.exitCode，UNEXPECTED=99 与全绿的退出码相同，
//     无法作为闸门。现在 unexpected>0 / 缓存缺失 / 出处不符 一律 EXIT≠0。
//  3) **缓存出处校验**：原版直接信任 bodies/ 目录。实测 8c42227 之后 extract-bodies.cjs
//     已经跑不动（旧函数不在工作树了），而本脚本仍读上一轮缓存输出 UNEXPECTED=0 —— 证据
//     链断裂而完全不可见。现在要求 PROVENANCE.json 存在、且其 names 与目录内容一致。
//  4) **规则活性自检**：每条 SEAM 规则必须在真实数据里至少命中一次；写了却零命中的规则
//     是死条款（要么抽取变了，要么规则写错），一律报 STALE_RULE 并非零退出。
//  5) `--self-test`：负向控制。前缀被篡改的 seam 行**必须**被判 UNEXPECTED。
//     没有这一步，下一个人放宽正则时不会有任何信号。
const fs = require('node:fs')
const path = require('node:path')

const OUT = 'F:/Kiro-account-manager/Kiro-account-manager/.agent-workspace/.archive/2026-08-12/upstream-api-extract/bodies'

// 旧 → 新，四项状态归属裁决的落点。两端一律整行锚定（^...$）。
// dedent 已由 extract-bodies.cjs 归一到函数声明行，故行内缩进是稳定的、可以写进正则。
const SEAM = [
  [/^  if \(useKProxyForApi\) \{$/, /^  if \(deps\.useKProxy\(\)\) \{$/],
  [/^    const kproxyService = getKProxyService\(\)$/, /^    const kproxyService = deps\.getKProxyService\(\)$/],
  [/^  const machineId = accountMachineId \|\| getCurrentMachineId\(\)$/, /^  const machineId = accountMachineId \|\| deps\.getDeviceIdForUa\(\)$/],
  [/^  const machineId = accountMachineId \|\| getCurrentMachineId\(\)$/, /^  const machineId = accountMachineId \|\| transport\.getDeviceIdForUa\(\)$/],
  [/^  const machineId = getCurrentMachineId\(\)$/, /^  const machineId = transport\.getDeviceIdForUa\(\)$/],
  [/^  const agent = getKProxyAgent\(\)$/, /^  const agent = getNetworkAgent\(\)$/],
  [/^  if \(currentUsageApiType === 'rest'\) \{$/, /^  if \(getUsageApiType\(\) === 'rest'\) \{$/]
]

// 行尾空白不参与判据（等价性由 AST 对账证明，见 extract-bodies.cjs 头部 5）
const canonLine = (l) => l.replace(/[ \t]+$/, '')

function classify(oldLines, newLines, hits) {
  const rows = []
  let unexpected = 0
  if (oldLines.length !== newLines.length) {
    return { rows, unexpected: 1, lineCountMismatch: [oldLines.length, newLines.length] }
  }
  for (let i = 0; i < oldLines.length; i++) {
    const o = canonLine(oldLines[i])
    const n = canonLine(newLines[i])
    if (o === n) continue
    let kind = 'UNEXPECTED'
    if (n === 'export ' + o) kind = 'EXPORT'
    else {
      const idx = SEAM.findIndex(([ro, rn]) => ro.test(o) && rn.test(n))
      if (idx >= 0) {
        kind = 'SEAM'
        if (hits) hits[idx] = (hits[idx] || 0) + 1
      }
    }
    if (kind === 'UNEXPECTED') unexpected++
    rows.push({ kind, line: i + 1, old: o, new: n })
  }
  return { rows, unexpected, lineCountMismatch: null }
}

// ---------- 负向自测 ----------
function selfTest() {
  const cases = []
  const check = (label, oldL, newL, wantKind) => {
    const { rows } = classify(oldL, newL, null)
    const got = rows.map((r) => r.kind)
    cases.push({ label, pass: got.length === 1 && got[0] === wantKind, want: wantKind, got })
  }

  // 控制组：真实 seam 必须判 SEAM
  check('CONTROL genuine device-id seam ⇒ SEAM',
    ['  const machineId = accountMachineId || getCurrentMachineId()'],
    ['  const machineId = accountMachineId || deps.getDeviceIdForUa()'], 'SEAM')
  check('CONTROL genuine useKProxy seam ⇒ SEAM',
    ['  if (useKProxyForApi) {'], ['  if (deps.useKProxy()) {'], 'SEAM')
  check('CONTROL export-only ⇒ EXPORT',
    ['function getRestApiBase(ssoRegion?: string): string {'],
    ['export function getRestApiBase(ssoRegion?: string): string {'], 'EXPORT')

  // 负向 1：评审给出的原始复现 —— 前缀被换成别的来源，原版判 SEAM，现在必须 UNEXPECTED
  check('TAMPERED prefix (attackerControlled) ⇒ UNEXPECTED',
    ['  const machineId = accountMachineId || getCurrentMachineId()'],
    ['  const machineId = attackerControlled || deps.getDeviceIdForUa()'], 'UNEXPECTED')
  // 负向 2：丢掉 accountMachineId 兜底（真实行为改变：账号级 ID 不再优先）
  check('DROPPED accountMachineId fallback ⇒ UNEXPECTED',
    ['  const machineId = accountMachineId || getCurrentMachineId()'],
    ['  const machineId = deps.getDeviceIdForUa()'], 'UNEXPECTED')
  // 负向 3：条件被取反
  check('NEGATED condition ⇒ UNEXPECTED',
    ['  if (useKProxyForApi) {'], ['  if (!deps.useKProxy()) {'], 'UNEXPECTED')
  // 负向 4：赋值目标被改名（左值漂移）
  check('RENAMED assignment target ⇒ UNEXPECTED',
    ['  const agent = getKProxyAgent()'], ['  const proxyAgent = getNetworkAgent()'], 'UNEXPECTED')
  // 负向 5：usageApiType 比较值被改
  check('CHANGED compared literal ⇒ UNEXPECTED',
    ["  if (currentUsageApiType === 'rest') {"], ["  if (getUsageApiType() === 'cbor') {"], 'UNEXPECTED')
  // 负向 6：行尾空白差异不得被当成改动
  {
    const { rows } = classify(['  const x = 1   '], ['  const x = 1'], null)
    cases.push({ label: 'TRAILING WS ⇒ no row at all', pass: rows.length === 0, want: '(none)', got: rows.map((r) => r.kind) })
  }

  for (const c of cases) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.pass ? '' : `  [want=${c.want} got=${JSON.stringify(c.got)}]`}`)
  const failed = cases.filter((c) => !c.pass).length
  console.log(`\nSELFTEST TOTAL=${cases.length} PASSED=${cases.length - failed} FAILED=${failed}`)
  return failed === 0
}

// ---------- main ----------
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}

// 缓存出处校验（堵「生产者已死、消费者照绿」）
const provPath = path.join(OUT, 'PROVENANCE.json')
if (!fs.existsSync(provPath)) {
  console.log('!! MISSING PROVENANCE.json — bodies/ 不是由当前版 extract-bodies.cjs 产出。')
  console.log('   先跑: node extract-bodies.cjs --new-rev <rev>')
  console.log('\nTOTAL CHANGED LINES=0  UNEXPECTED=0  STALE_RULES=0  PROVENANCE=MISSING')
  process.exit(2)
}
const prov = JSON.parse(fs.readFileSync(provPath, 'utf-8'))
const onDisk = fs.readdirSync(path.join(OUT, 'old')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort()
const claimed = [...prov.names].sort()
if (JSON.stringify(onDisk) !== JSON.stringify(claimed)) {
  console.log(`!! PROVENANCE MISMATCH: json lists ${claimed.length} names, old/ has ${onDisk.length}`)
  process.exit(2)
}

const hits = {}
let unexpected = 0
const printed = []
for (const f of onDisk) {
  const o = fs.readFileSync(path.join(OUT, 'old', `${f}.ts`), 'utf-8').split('\n')
  const n = fs.readFileSync(path.join(OUT, 'new', `${f}.ts`), 'utf-8').split('\n')
  const { rows, unexpected: u, lineCountMismatch } = classify(o, n, hits)
  if (lineCountMismatch) {
    console.log(`!! ${f}: LINE COUNT ${lineCountMismatch[0]} vs ${lineCountMismatch[1]}`)
    unexpected += u
    continue
  }
  unexpected += u
  for (const r of rows) {
    printed.push(`${r.kind.padEnd(11)} ${f.padEnd(30)} L${String(r.line).padEnd(4)} - ${r.old.trim()}\n${''.padEnd(49)}+ ${r.new.trim()}`)
  }
}
console.log(printed.join('\n'))

// 规则活性：写了却零命中的 SEAM 规则是死条款
const staleRules = SEAM.map((r, i) => (hits[i] ? null : i)).filter((i) => i !== null)
if (staleRules.length) {
  console.log('\nSTALE SEAM RULES (0 hits — 死条款，规则或抽取已漂移):')
  for (const i of staleRules) console.log(`  [${i}] ${SEAM[i][0].source}  →  ${SEAM[i][1].source}`)
}

console.log(`\nSOURCE oldRev=${prov.oldRev} newRev=${prov.newRev} generatedAt=${prov.generatedAt}`)
console.log(`TOTAL CHANGED LINES=${printed.length}  UNEXPECTED=${unexpected}  STALE_RULES=${staleRules.length}  PROVENANCE=OK`)
if (unexpected || staleRules.length) process.exitCode = 1
