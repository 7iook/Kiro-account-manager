// 列出所有「纯空白差异」的行：新旧 rstrip 后相等但原文不等。
// 目的：把被 write_file 顺手去掉的行尾空白复原，让最终 diff 里只剩下有意的缝位改动。
const fs = require('node:fs')
const path = require('node:path')
const OUT = 'F:/Kiro-account-manager/Kiro-account-manager/.agent-workspace/.archive/2026-08-12/upstream-api-extract/bodies'

for (const f of fs.readdirSync(path.join(OUT, 'old'))) {
  const o = fs.readFileSync(path.join(OUT, 'old', f), 'utf-8').split('\n')
  const n = fs.readFileSync(path.join(OUT, 'new', f), 'utf-8').split('\n')
  if (o.length !== n.length) { console.log(`${f}: LINE COUNT ${o.length} vs ${n.length}`); continue }
  for (let i = 0; i < o.length; i++) {
    if (o[i] === n[i]) continue
    if (o[i].replace(/\s+$/, '') === n[i].replace(/\s+$/, '')) {
      console.log(`${f}  body-line ${i + 1}  WS-ONLY  old=${JSON.stringify(o[i])} new=${JSON.stringify(n[i])}`)
    }
  }
}
