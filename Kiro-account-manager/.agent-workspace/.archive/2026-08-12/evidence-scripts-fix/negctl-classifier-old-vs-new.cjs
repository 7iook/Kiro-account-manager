// 负向控制：证明「旧脚本接受、新脚本拒绝」同一个被篡改的 seam 行。
// 不改任何真实文件 —— 把两版的分类逻辑各自复刻一份最小切片，喂同一条篡改行。
// 篡改样本取自 review.sonnet.md 的原始复现：
//   accountMachineId  →  attackerControlled
const OLD_SEAM = [
  [/^  if \(useKProxyForApi\) \{$/, /^  if \(deps\.useKProxy\(\)\) \{$/],
  [/^    const kproxyService = getKProxyService\(\)$/, /^    const kproxyService = deps\.getKProxyService\(\)$/],
  [/getCurrentMachineId\(\)$/, /deps\.getDeviceIdForUa\(\)$/],       // ← 仅锚行尾
  [/getCurrentMachineId\(\)$/, /transport\.getDeviceIdForUa\(\)$/],  // ← 仅锚行尾
  [/^  const agent = getKProxyAgent\(\)$/, /^  const agent = getNetworkAgent\(\)$/],
  [/^  if \(currentUsageApiType === 'rest'\) \{$/, /^  if \(getUsageApiType\(\) === 'rest'\) \{$/]
]
const NEW_SEAM = [
  [/^  if \(useKProxyForApi\) \{$/, /^  if \(deps\.useKProxy\(\)\) \{$/],
  [/^    const kproxyService = getKProxyService\(\)$/, /^    const kproxyService = deps\.getKProxyService\(\)$/],
  [/^  const machineId = accountMachineId \|\| getCurrentMachineId\(\)$/, /^  const machineId = accountMachineId \|\| deps\.getDeviceIdForUa\(\)$/],
  [/^  const machineId = accountMachineId \|\| getCurrentMachineId\(\)$/, /^  const machineId = accountMachineId \|\| transport\.getDeviceIdForUa\(\)$/],
  [/^  const machineId = getCurrentMachineId\(\)$/, /^  const machineId = transport\.getDeviceIdForUa\(\)$/],
  [/^  const agent = getKProxyAgent\(\)$/, /^  const agent = getNetworkAgent\(\)$/],
  [/^  if \(currentUsageApiType === 'rest'\) \{$/, /^  if \(getUsageApiType\(\) === 'rest'\) \{$/]
]
const kindOf = (table, o, n) =>
  n === 'export ' + o ? 'EXPORT' : table.some(([ro, rn]) => ro.test(o) && rn.test(n)) ? 'SEAM' : 'UNEXPECTED'

const SAMPLES = [
  { label: 'genuine seam (must stay SEAM in both)',
    old: '  const machineId = accountMachineId || getCurrentMachineId()',
    new: '  const machineId = accountMachineId || deps.getDeviceIdForUa()' },
  { label: 'TAMPERED prefix — review repro',
    old: '  const machineId = accountMachineId || getCurrentMachineId()',
    new: '  const machineId = attackerControlled || deps.getDeviceIdForUa()' },
  { label: 'TAMPERED — accountMachineId fallback dropped',
    old: '  const machineId = accountMachineId || getCurrentMachineId()',
    new: '  const machineId = deps.getDeviceIdForUa()' },
  { label: 'TAMPERED — arbitrary call injected before',
    old: '  const machineId = getCurrentMachineId()',
    new: '  const machineId = leakToRemote() || transport.getDeviceIdForUa()' }
]

console.log('sample'.padEnd(46) + 'OLD'.padEnd(13) + 'NEW')
console.log('-'.repeat(72))
let regressions = 0
for (const s of SAMPLES) {
  const o = kindOf(OLD_SEAM, s.old, s.new)
  const n = kindOf(NEW_SEAM, s.old, s.new)
  const tampered = s.label.startsWith('TAMPERED')
  const fixed = tampered ? o === 'SEAM' && n === 'UNEXPECTED' : o === 'SEAM' && n === 'SEAM'
  if (!fixed) regressions++
  console.log(s.label.padEnd(46) + o.padEnd(13) + n + (fixed ? '   ✓' : '   ✗ NOT FIXED'))
}
console.log(`\nbadSemanticChangeStillClassifiedSeam(old)=${SAMPLES.filter((s) => s.label.startsWith('TAMPERED')).every((s) => kindOf(OLD_SEAM, s.old, s.new) === 'SEAM')}`)
console.log(`badSemanticChangeStillClassifiedSeam(new)=${SAMPLES.filter((s) => s.label.startsWith('TAMPERED')).some((s) => kindOf(NEW_SEAM, s.old, s.new) === 'SEAM')}`)
console.log(`REGRESSIONS=${regressions}`)
process.exitCode = regressions ? 1 : 0
