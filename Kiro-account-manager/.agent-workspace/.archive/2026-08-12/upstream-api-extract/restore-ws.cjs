// 复原被 write_file 顺手剥掉的行尾空白，使新实现的函数体与 index.ts 旧实现**逐字节**相等。
// 做法：按函数在新文件里的起始行定位，把 WS-ONLY 的那几行原样写回旧内容。
// 为什么值得做：验收判据是逐字节等价；「顺手规整空白」正是任务书禁止的那种改动，
// 哪怕它无害，也会让 diff 里混入噪声，削弱这份证据本身。
const fs = require('node:fs')
const path = require('node:path')
const ROOT = 'F:/Kiro-account-manager/Kiro-account-manager'
const OUT = path.join(ROOT, '.agent-workspace/.archive/2026-08-12/upstream-api-extract/bodies')

// 函数名 → 新文件
const LOC = {
  kiroApiRequest: 'src/main/upstreamApi/transport.ts',
  refreshSocialToken: 'src/main/upstreamApi/refresh.ts',
  ssoDeviceAuth: 'src/main/upstreamApi/sso.ts',
  getUsageLimitsRest: 'src/main/upstreamApi/usage.ts'
}

let fixed = 0
for (const [name, file] of Object.entries(LOC)) {
  const abs = path.join(ROOT, file)
  const lines = fs.readFileSync(abs, 'utf-8').split('\n')
  const startIdx = lines.findIndex((l) =>
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function ${name}\\b`).test(l)
  )
  if (startIdx < 0) throw new Error(`not found: ${name}`)
  const indent = lines[startIdx].match(/^(\s*)/)[1]

  const oldBody = fs.readFileSync(path.join(OUT, 'old', `${name}.ts`), 'utf-8').split('\n')
  const newBody = fs.readFileSync(path.join(OUT, 'new', `${name}.ts`), 'utf-8').split('\n')
  if (oldBody.length !== newBody.length) throw new Error(`line count mismatch: ${name}`)

  for (let i = 0; i < oldBody.length; i++) {
    if (oldBody[i] === newBody[i]) continue
    if (oldBody[i].replace(/\s+$/, '') !== newBody[i].replace(/\s+$/, '')) continue // 有意的缝位差异，不动
    const target = startIdx + i
    if (lines[target].trim() !== '') throw new Error(`unexpected non-blank at ${file}:${target + 1}`)
    lines[target] = indent + oldBody[i] // 旧体已 dedent，补回基准缩进
    fixed++
  }
  fs.writeFileSync(abs, lines.join('\n'))
}
console.log(`restored ${fixed} whitespace-only lines`)
