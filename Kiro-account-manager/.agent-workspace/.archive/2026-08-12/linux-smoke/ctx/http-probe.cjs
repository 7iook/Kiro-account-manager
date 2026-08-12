// 用 node 做 HTTP 探测(slim 镜像没有 curl)
const http = require('node:http')
const fs = require('node:fs')

const BASE = process.env.PANEL_BASE || 'http://127.0.0.1:5599'
const KEY = process.env.PANEL_KEY || ''

function req(pathname, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, BASE)
    const headers = {}
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body) }
    if (cookie) headers['Cookie'] = cookie
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

;(async () => {
  const shell = await req('/panel/')
  console.log(`GET /panel/            HTTP=${shell.status} bytes=${shell.body.length} ctype=${shell.headers['content-type']}`)
  const html = shell.body.toString('utf-8')
  console.log('HTML_HEAD=' + JSON.stringify(html.slice(0, 160)))

  const m = html.match(/\/panel\/assets\/[A-Za-z0-9._-]+\.js/)
  const asset = m ? m[0] : null
  console.log('ASSET_REF=' + asset)
  if (asset) {
    const a = await req(asset)
    console.log(`GET ${asset}  HTTP=${a.status} bytes=${a.body.length} ctype=${a.headers['content-type']}`)
  }
  const cssM = html.match(/\/panel\/assets\/[A-Za-z0-9._-]+\.css/)
  if (cssM) {
    const c = await req(cssM[0])
    console.log(`GET ${cssM[0]}  HTTP=${c.status} bytes=${c.body.length}`)
  }

  const bad = await req('/panel/api/login', { method: 'POST', body: JSON.stringify({ adminKey: 'WRONG-KEY-0000' }) })
  console.log(`POST login(wrong)      HTTP=${bad.status} body=${bad.body.toString('utf-8').slice(0, 160)}`)

  const noauth = await req('/panel/api/accounts')
  console.log(`GET accounts(no auth)  HTTP=${noauth.status} body=${noauth.body.toString('utf-8').slice(0, 120)}`)

  const good = await req('/panel/api/login', { method: 'POST', body: JSON.stringify({ adminKey: KEY }) })
  const sc = good.headers['set-cookie']
  console.log(`POST login(correct)    HTTP=${good.status} body=${good.body.toString('utf-8').slice(0, 120)}`)
  console.log('SET_COOKIE=' + JSON.stringify(sc))
  if (!sc) { console.log('NO_COOKIE_ABORT'); process.exit(0) }
  const cookie = sc[0].split(';')[0]

  const acc = await req('/panel/api/accounts', { cookie })
  console.log(`GET accounts(auth)     HTTP=${acc.status} bytes=${acc.body.length}`)
  console.log('ACCOUNTS_BODY=' + acc.body.toString('utf-8').slice(0, 600))
})().catch((e) => { console.error('PROBE_FAILED', e.message); process.exit(1) })
