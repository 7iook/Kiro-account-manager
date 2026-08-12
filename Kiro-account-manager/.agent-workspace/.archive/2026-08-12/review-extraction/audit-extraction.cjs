const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ts = require('typescript')

const root = 'F:/Kiro-account-manager/Kiro-account-manager'
const work = path.join(root, '.agent-workspace')
const evidence = path.join(work, '.archive/2026-08-12/upstream-api-extract/bodies')
const files = {
  old: path.join(work, 'review-old-index.ts'),
  current: path.join(work, 'review-new-index.ts'),
  transport: path.join(work, 'review-transport.ts'),
  refresh: path.join(work, 'review-refresh.ts'),
  sso: path.join(work, 'review-sso.ts'),
  usage: path.join(work, 'review-usage.ts')
}
const movedFiles = ['transport', 'refresh', 'sso', 'usage']
const factories = new Set(['createTransport', 'createRefresh', 'createSso', 'createUsage'])

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}
function parse(file) {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return { text, sf }
}
function functionsIn(file) {
  const { text, sf } = parse(file)
  const out = new Map()
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const start = node.getStart(sf)
      const end = node.getEnd()
      const lineStart = sf.getLineStarts()[sf.getLineAndCharacterOfPosition(start).line]
      const indent = text.slice(lineStart, start)
      const full = text.slice(start, end).split(/\r?\n/)
        .map((line, i) => i === 0 || !line.startsWith(indent) ? line : line.slice(indent.length))
        .join('\n') + '\n'
      out.set(node.name.text, {
        full,
        body: text.slice(node.body.getStart(sf), node.body.getEnd()),
        startLine: sf.getLineAndCharacterOfPosition(start).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(end).line + 1
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const oldFns = functionsIn(files.old)
const currentFns = functionsIn(files.current)
const newFns = new Map()
const duplicateNewNames = []
for (const key of movedFiles) {
  for (const [name, data] of functionsIn(files[key])) {
    if (newFns.has(name)) duplicateNewNames.push(name)
    newFns.set(name, { ...data, file: key })
  }
}
const movedNames = [...newFns.keys()].filter((x) => !factories.has(x)).sort()
function normalize(s) {
  return s.replace(/\r\n/g, '\n')
}
function evidenceText(side, name) {
  return normalize(fs.readFileSync(path.join(evidence, side, `${name}.ts`), 'utf8'))
}
function firstDiff(a, b) {
  const aa = normalize(a).split('\n')
  const bb = normalize(b).split('\n')
  const n = Math.max(aa.length, bb.length)
  for (let i = 0; i < n; i++) {
    if (aa[i] !== bb[i]) return { line: i + 1, a: aa[i] ?? null, b: bb[i] ?? null }
  }
  return null
}

const cacheChecks = movedNames.map((name) => {
  const oldNode = oldFns.get(name)
  const newNode = newFns.get(name)
  const oldCache = evidenceText('old', name)
  const newCache = evidenceText('new', name)
  return {
    name,
    oldExists: !!oldNode,
    newFile: newNode?.file ?? null,
    oldCacheExactAstNode: !!oldNode && oldCache === normalize(oldNode.full),
    newCacheExactAstNode: !!newNode && newCache === normalize(newNode.full),
    oldFirstDiff: oldNode ? firstDiff(oldCache, oldNode.full) : null,
    newFirstDiff: newNode ? firstDiff(newCache, newNode.full) : null,
    oldLines: oldNode ? [oldNode.startLine, oldNode.endLine] : null,
    newLines: newNode ? [newNode.startLine, newNode.endLine] : null,
    oldSha256: sha(oldCache),
    oldAstSha256: oldNode ? sha(normalize(oldNode.full)) : null
  }
})

const strictSeams = new Set([
  'if (useKProxyForApi) {|if (deps.useKProxy()) {',
  'const kproxyService = getKProxyService()|const kproxyService = deps.getKProxyService()',
  'const deviceId = await getCurrentMachineId()|const deviceId = await deps.getDeviceIdForUa()',
  'const machineId = await getCurrentMachineId()|const machineId = await transport.getDeviceIdForUa()',
  'const agent = getKProxyAgent()|const agent = getNetworkAgent()',
  "if (currentUsageApiType === 'rest') {|if (getUsageApiType() === 'rest') {"
])
const semanticDiffs = []
const expectedDiffs = []
for (const name of movedNames) {
  const oldNode = oldFns.get(name)
  const newNode = newFns.get(name)
  if (!oldNode || !newNode) continue
  const a = normalize(oldNode.full).split('\n')
  const b = normalize(newNode.full).split('\n')
  if (a.length !== b.length) {
    semanticDiffs.push({ name, kind: 'line-count', old: a.length, new: b.length })
    continue
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    const pair = `${a[i].trim()}|${b[i].trim()}`
    const exportOnly = a[i].replace(/^\s*/, '') === b[i].replace(/^\s*export\s+/, '')
    const rec = { name, line: i + 1, old: a[i], new: b[i], exportOnly, strictSeam: strictSeams.has(pair) }
    if (rec.exportOnly || rec.strictSeam) expectedDiffs.push(rec)
    else semanticDiffs.push(rec)
  }
}

const evidenceOldNames = fs.readdirSync(path.join(evidence, 'old')).filter(x => x.endsWith('.ts')).map(x => x.slice(0, -3)).sort()
const evidenceNewNames = fs.readdirSync(path.join(evidence, 'new')).filter(x => x.endsWith('.ts')).map(x => x.slice(0, -3)).sort()
const result = {
  oldRevisionFileSha256: sha(fs.readFileSync(files.old)),
  movedCount: movedNames.length,
  deletedOldFunctionNames: [...oldFns.keys()].filter(x => !currentFns.has(x)).sort(),
  deletedOldNotCompared: [...oldFns.keys()].filter(x => !currentFns.has(x) && !movedNames.includes(x)).sort(),
  comparedNotDeleted: movedNames.filter(x => currentFns.has(x)).sort(),
  movedNames,
  oldMissingMovedNames: movedNames.filter(x => !oldFns.has(x)),
  evidenceOldNames,
  evidenceNewNames,
  evidenceOldExtra: evidenceOldNames.filter(x => !movedNames.includes(x)),
  evidenceOldMissing: movedNames.filter(x => !evidenceOldNames.includes(x)),
  evidenceNewExtra: evidenceNewNames.filter(x => !movedNames.includes(x)),
  evidenceNewMissing: movedNames.filter(x => !evidenceNewNames.includes(x)),
  duplicateNewNames,
  cacheChecks,
  expectedDiffCount: expectedDiffs.length,
  expectedDiffs,
  unexpectedDiffCount: semanticDiffs.length,
  unexpectedDiffs: semanticDiffs
}
console.log(JSON.stringify(result, null, 2))
if (result.oldMissingMovedNames.length || result.evidenceOldExtra.length || result.evidenceOldMissing.length ||
    result.evidenceNewExtra.length || result.evidenceNewMissing.length || duplicateNewNames.length ||
    cacheChecks.some(x => !x.oldCacheExactAstNode || !x.newCacheExactAstNode) || semanticDiffs.length) process.exitCode = 1
