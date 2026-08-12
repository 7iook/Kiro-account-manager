const fs = require('fs')
const ts = require('typescript')
const oldPath = '.agent-workspace/review-old-index.ts'
const newPath = '.agent-workspace/review-new-index.ts'
const moved = new Set([
  'getRestApiBase','getFallbackRestApiBase','getNetworkAgent','fetchWithAppProxy',
  'kiroApiRequest','generateInvocationId','getKiroUserAgent','getKiroAmzUserAgent',
  'refreshOidcToken','refreshSocialToken','validateMicrosoftTokenEndpoint',
  'refreshExternalIdpToken','refreshTokenByMethod','refreshTokenByMethodInner',
  'ssoDeviceAuth','normalizeResetDate','fetchRestApi','getUsageLimitsRest',
  'getUsageAndLimits','getUserInfo'
])
const removed = new Set([...moved, 'getCurrentMachineId', 'getKProxyAgent'])
function analyze(path, oldSide) {
  const text = fs.readFileSync(path, 'utf8')
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const calls = []
  function visit(node, removedAncestor) {
    let blocked = removedAncestor
    if (oldSide && ts.isFunctionDeclaration(node) && node.name) {
      blocked ||= removed.has(node.name.text)
    }
    if (!blocked && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && moved.has(node.expression.text)) {
      let owner = node.parent
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
      const ownerName = owner && owner.name && ts.isIdentifier(owner.name)
        ? owner.name.text : '<module>'
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      calls.push({callee: node.expression.text, owner: ownerName,
        line: pos.line + 1, arity: node.arguments.length,
        args: node.arguments.map(a => a.getText(sf)), text: node.getText(sf)})
    }
    ts.forEachChild(node, child => visit(child, blocked))
  }
  visit(sf, false)
  return calls
}
const oldCalls = analyze(oldPath, true)
const newCalls = analyze(newPath, false)
const key = x => JSON.stringify([x.callee,x.owner,x.arity,x.args,x.text])
const oldMap = new Map(oldCalls.map(x => [key(x),x]))
const newMap = new Map(newCalls.map(x => [key(x),x]))
const result = {oldCount: oldCalls.length, newCount: newCalls.length,
  onlyOld: oldCalls.filter(x => !newMap.has(key(x))),
  onlyNew: newCalls.filter(x => !oldMap.has(key(x))), oldCalls, newCalls}
console.log(JSON.stringify(result, null, 2))
process.exit(result.onlyOld.length || result.onlyNew.length ? 1 : 0)
