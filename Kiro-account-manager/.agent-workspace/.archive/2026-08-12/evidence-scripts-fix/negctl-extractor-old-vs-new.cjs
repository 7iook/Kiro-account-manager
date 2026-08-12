// P1-2 负向控制：同一个「漏搬 ssoDeviceAuth」的情形，旧提取器静默放行、新提取器拦下。
// 旧侧一律从 af94451^ 读（给旧脚本最好的条件 —— 否则它在 HEAD 上连第一个函数都找不到），
// 唯一变量是「函数集合怎么来的」：手写 CASES 少一行 vs AST 枚举 + 双向对账。
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const GIT_ROOT = 'F:/Kiro-account-manager'
const PREFIX = 'Kiro-account-manager'
const show = (rev, rel) =>
  execFileSync('git', ['-C', GIT_ROOT, 'show', `${rev}:${PREFIX}/${rel}`], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })

// ---- 旧提取器的原始提取逻辑（逐字复刻 extract-bodies.cjs.orig 的 extract()）----
function oldExtract(text, name) {
  const lines = text.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function ${name}\\b`).test(l))
  if (startIdx < 0) throw new Error(`not found: ${name}`)
  const indent = lines[startIdx].match(/^(\s*)/)[1]
  const closer = indent + '}'
  let endIdx = -1
  for (let i = startIdx + 1; i < lines.length; i++) if (lines[i] === closer) { endIdx = i; break }
  if (endIdx < 0) throw new Error(`no closer for ${name}`)
  return lines.slice(startIdx, endIdx + 1).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n') + '\n'
}

// 旧脚本的手写 CASES —— 故意删掉 ssoDeviceAuth，模拟「搬了但忘了登记」
const CASES_WITH_OMISSION = [
  ['getRestApiBase', 'transport'], ['getFallbackRestApiBase', 'transport'], ['getNetworkAgent', 'transport'],
  ['fetchWithAppProxy', 'transport'], ['kiroApiRequest', 'transport'], ['generateInvocationId', 'transport'],
  ['getKiroUserAgent', 'transport'], ['getKiroAmzUserAgent', 'transport'],
  ['refreshOidcToken', 'refresh'], ['refreshSocialToken', 'refresh'], ['validateMicrosoftTokenEndpoint', 'refresh'],
  ['refreshExternalIdpToken', 'refresh'], ['refreshTokenByMethod', 'refresh'], ['refreshTokenByMethodInner', 'refresh'],
  /* ['ssoDeviceAuth', 'sso'],  <-- 漏登记 */
  ['normalizeResetDate', 'usage'], ['fetchRestApi', 'usage'], ['getUsageLimitsRest', 'usage'],
  ['getUsageAndLimits', 'usage'], ['getUserInfo', 'usage']
]

const oldIndex = show('af94451^', 'src/main/index.ts')
const mods = Object.fromEntries(['transport', 'refresh', 'sso', 'usage'].map((m) => [m, show('8c42227', `src/main/upstreamApi/${m}.ts`)]))

let identical = 0
const differing = []
for (const [name, mod] of CASES_WITH_OMISSION) {
  const o = oldExtract(oldIndex, name)
  const n = oldExtract(mods[mod], name)
  if (o === n) identical++
  else differing.push(name)
}
console.log('=== OLD extractor (hand-written CASES, ssoDeviceAuth omitted) ===')
console.log(`TOTAL=${CASES_WITH_OMISSION.length} IDENTICAL=${identical} DIFFERING=${differing.length}`)
console.log('ssoDeviceAuth compared? ' + CASES_WITH_OMISSION.some(([n]) => n === 'ssoDeviceAuth'))
console.log('=> 输出里没有任何字样表明少比了一个函数；exit code 恒 0（原版全文无 process.exitCode）')
console.log('OLD_SILENTLY_ACCEPTS_OMISSION=true')

// ---- 旧提取器的第二个缺口：同缩进独立闭合块导致截断 ----
// 用真实的 ssoDeviceAuth（172 行，含多层嵌套）验它有没有被截断
const ssoOld = oldExtract(oldIndex, 'ssoDeviceAuth')
const sf = ts.createSourceFile('sso', mods.sso, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let astLines = null
const visit = (node) => {
  if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'ssoDeviceAuth' && node.body) {
    astLines = mods.sso.slice(node.getStart(sf), node.getEnd()).split('\n').length
  }
  ts.forEachChild(node, visit)
}
visit(sf)
const ssoNewOldWay = oldExtract(mods.sso, 'ssoDeviceAuth').split('\n').length - 1
console.log(`\n=== truncation check on ssoDeviceAuth (new module side) ===`)
console.log(`AST node lines=${astLines}  old-heuristic lines=${ssoNewOldWay}  match=${astLines === ssoNewOldWay}`)
console.log(`old index side lines=${ssoOld.split('\n').length - 1}`)
