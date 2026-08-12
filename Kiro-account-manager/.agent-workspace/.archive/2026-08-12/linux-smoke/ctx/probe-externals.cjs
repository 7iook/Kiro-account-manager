// 其余 external 包是否也踩 require(esm) interop(只有「当构造器/函数直接调用 default」才会炸)
const pkgs = ['conf', 'uuid', 'undici', 'node-forge', 'js-tiktoken']
for (const p of pkgs) {
  try {
    const m = require(p)
    const isNS = m && m[Symbol.toStringTag] === 'Module'
    console.log(
      `${p.padEnd(12)} typeof=${String(typeof m).padEnd(8)} isModuleNS=${String(isNS).padEnd(5)} hasDefault=${typeof m?.default}`
    )
  } catch (e) {
    console.log(`${p.padEnd(12)} REQUIRE_FAILED ${e.code || e.message}`)
  }
}
// 产物里这些包被怎么用的
const fs = require('node:fs')
const src = fs.readFileSync('/work/out/server/index.orig.js', 'utf-8')
for (const name of ['Conf', 'uuid', 'undici', 'forge', 'jsTiktoken']) {
  const re = new RegExp(`new ${name}\\(|${name}\\.[A-Za-z_$]+`, 'g')
  const hits = [...new Set((src.match(re) || []).slice(0, 6))]
  console.log(`用法 ${name}: ${hits.join(' , ') || '<none>'}`)
}
