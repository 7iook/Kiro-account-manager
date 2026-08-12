// 判定 require('conf') 在 CJS 下到底返回什么形状(node>=22.12 的 require(esm))
const m = require('conf')
console.log('typeof m       =', typeof m)
console.log('is function    =', typeof m === 'function')
console.log('keys           =', Object.keys(m).join(','))
console.log('typeof m.default =', typeof m.default)
console.log('Symbol.toStringTag =', String(m[Symbol.toStringTag]))
try { new m({ cwd: require('os').tmpdir() }); console.log('new m() => OK') }
catch (e) { console.log('new m() => THROWS:', e.message) }
try { const C = m.default; new C({ cwd: require('os').tmpdir(), configName: 'probe-x' }); console.log('new m.default() => OK') }
catch (e) { console.log('new m.default() => THROWS:', e.message) }
console.log('NODE', process.version, 'PLATFORM', process.platform)
