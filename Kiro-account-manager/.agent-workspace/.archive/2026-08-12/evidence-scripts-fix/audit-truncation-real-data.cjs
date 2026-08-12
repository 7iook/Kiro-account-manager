// 截断风险的真实性核查：旧启发式（第一行同缩进孤立 }）vs AST 节点边界，
// 在**全部 20 个真实函数**上逐一比对行数。自测已证明该启发式在合成 fixture 上会截断，
// 但本仓真实数据是否真的被截断，必须实测 —— 不能把「原理上会」写成「已经发生」。
const { execFileSync } = require('node:child_process')
const ts = require('typescript')
const GIT_ROOT = 'F:/Kiro-account-manager'
const show = (rev, rel) =>
  execFileSync('git', ['-C', GIT_ROOT, 'show', `${rev}:Kiro-account-manager/${rel}`], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })

function oldHeuristic(text, name) {
  const lines = text.split(/\r?\n/)
  const s = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function ${name}\\b`).test(l))
  if (s < 0) return null
  const indent = lines[s].match(/^(\s*)/)[1]
  for (let i = s + 1; i < lines.length; i++) if (lines[i] === indent + '}') return i - s + 1
  return null
}
function astAll(text, label) {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out = new Map()
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      out.set(node.name.text, text.slice(node.getStart(sf), node.getEnd()).split('\n').length)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const oldIndex = show('af94451^', 'src/main/index.ts')
const oldAst = astAll(oldIndex, 'old')
const mods = ['transport', 'refresh', 'sso', 'usage'].map((m) => [m, show('8c42227', `src/main/upstreamApi/${m}.ts`)])
const newAst = new Map()
for (const [m, t] of mods) for (const [k, v] of astAll(t, m)) newAst.set(k, { lines: v, mod: m, text: t })

const NAMES = ['getRestApiBase','getFallbackRestApiBase','getNetworkAgent','fetchWithAppProxy','kiroApiRequest',
  'generateInvocationId','getKiroUserAgent','getKiroAmzUserAgent','refreshOidcToken','refreshSocialToken',
  'validateMicrosoftTokenEndpoint','refreshExternalIdpToken','refreshTokenByMethod','refreshTokenByMethodInner',
  'ssoDeviceAuth','normalizeResetDate','fetchRestApi','getUsageLimitsRest','getUsageAndLimits','getUserInfo']

let truncatedOld = 0, truncatedNew = 0
console.log('function'.padEnd(32) + 'oldAST'.padEnd(8) + 'oldHeur'.padEnd(9) + 'newAST'.padEnd(8) + 'newHeur')
for (const n of NAMES) {
  const oa = oldAst.get(n), oh = oldHeuristic(oldIndex, n)
  const na = newAst.get(n)?.lines, nh = oldHeuristic(newAst.get(n).text, n)
  if (oa !== oh) truncatedOld++
  if (na !== nh) truncatedNew++
  const flag = (oa !== oh || na !== nh) ? '  <-- MISMATCH' : ''
  console.log(n.padEnd(32) + String(oa).padEnd(8) + String(oh).padEnd(9) + String(na).padEnd(8) + String(nh) + flag)
}
console.log(`\nTRUNCATED_OLD_SIDE=${truncatedOld}  TRUNCATED_NEW_SIDE=${truncatedNew}  (0/0 = 本仓真实数据未被截断)`)
