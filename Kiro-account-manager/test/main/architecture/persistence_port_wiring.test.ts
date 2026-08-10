/**
 * 持久化装配闸门 —— 防 E-052「建而未接」：端口能翻译 ≠ 桌面真的经过它。
 *
 * ## 为什么需要源码级断言，而不是只测端口本体
 *
 * 本轮修的缺陷（`set(key, undefined)` 在 `conf` 上抛 TypeError 且旧值留在盘上）
 * 已经由 `test/main/persistence/accountStorePort.test.ts` 从行为侧钉死。但那些断言
 * 只证明**端口**翻译正确 —— 桌面端如果仍然把 `electron-store` 实例直接赋给 `store`
 * （原本就是 `store = storeInstance as unknown as typeof store`），
 * 端口测试照样全绿，而 `index.ts` 里那三处 orphan 清理照样清不掉。
 * 这正是本仓 E-052 的形态：缺陷与修复在测试眼里毫无区别。
 *
 * `index.ts` 是 electron 主进程入口（顶层就 `import { app } from 'electron'` 并注册
 * IPC），在 vitest 里 import 它不现实，故与本目录既有 `*_wiring.test.ts` 同姿态走源码断言。
 *
 * ## 第二条不变量：写权限闸门**不得**出现在桌面启动路径
 *
 * 决策卡 `decision-card.md:103-106` 的四态位于该卡的**服务器迁移**章节，是服务端启动
 * 语义。写权限那一条在服务器上真实存在（挂载权限 / 容器卷 / 服务用户不拥有拷进来的
 * 文件），在桌面上是「装了应用、它写自己的 %APPDATA%」—— 那个处境几乎不存在。
 * 把它加到桌面启动路径 = 给桌面多一条拒绝启动的路，换守一件桌面不会发生的事。
 *
 * 这条断言的作用是让「顺手让两边一致」这个动作变红：`assertAccountStoreWritable`
 * 与 `preflightAccountStoreForServer` 都不该在 `index.ts` 出现。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

/** 去掉注释，避免「注释里提到了」被当成真实代码（本轮注释大量讨论这些符号名） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('装配闭环: 桌面 store 引用经端口适配器（防 set(k, undefined) 静默不清除）', () => {
  it('index.ts 确实 import 并调用了 adaptRawStoreToPort', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(src, 'adaptRawStoreToPort 未被 import —— 端口的 undefined→delete 翻译到不了桌面').toMatch(
      /adaptRawStoreToPort/
    )
    expect(src, 'adaptRawStoreToPort 只被 import 没被调用 = 死代码').toMatch(
      /adaptRawStoreToPort\s*\(/
    )
  })

  it('桌面 store 不再是 electron-store 实例直赋（那条路绕过翻译）', () => {
    const src = stripComments(read('src/main/index.ts'))
    // 原形态：`store = storeInstance as unknown as typeof store`
    expect(
      src,
      'store 被直接赋成 electron-store 实例 —— set(key, undefined) 会抛 TypeError 且旧值留在盘上'
    ).not.toMatch(/store\s*=\s*storeInstance\s+as\s+unknown/)
  })

  it('store 的赋值语句本身就是适配器调用（不是赋完再包一层的形态）', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(src).toMatch(/store\s*=\s*adaptRawStoreToPort\s*\(/)
  })

  it('适配器拿到了底层 delete —— 没有它就翻译不成真正的清除', () => {
    const src = stripComments(read('src/main/index.ts'))
    const idx = src.indexOf('adaptRawStoreToPort(')
    expect(idx).toBeGreaterThan(-1)
    const call = src.slice(idx, idx + 500)
    expect(call, '适配器入参缺 delete —— undefined 会退回 conf 的 TypeError 行为').toMatch(
      /delete\s*:/
    )
    expect(call).toMatch(/storeInstance\.delete/)
  })
})

describe('装配闭环: 写权限闸门只在服务端启动路径，桌面不查', () => {
  it('index.ts 走的是不含写权限的 preflightAccountStore', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(src).toMatch(/preflightAccountStore\s*\(/)
  })

  it('index.ts 不调 assertAccountStoreWritable（桌面不因只读文件拒绝启动）', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(
      src,
      '写权限闸门是服务端启动语义 —— 桌面上那个处境几乎不存在，加上它只是多一条拒绝启动的路'
    ).not.toMatch(/assertAccountStoreWritable/)
  })

  it('index.ts 不调 preflightAccountStoreForServer（它 = 三态 + 写权限）', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(src).not.toMatch(/preflightAccountStoreForServer/)
  })

  it('端口的共用 preflight 本体里没有写权限闸门（防从另一头把它加回桌面）', () => {
    const src = stripComments(read('src/main/persistence/accountStorePort.ts'))
    const fnIdx = src.indexOf('export function preflightAccountStore(')
    expect(fnIdx, 'preflightAccountStore 不存在').toBeGreaterThan(-1)
    // 只截到下一个 export 为止 —— 后面紧跟的 ...ForServer 本来就该含它
    const nextExport = src.indexOf('export function', fnIdx + 30)
    const body = src.slice(fnIdx, nextExport > -1 ? nextExport : src.length)
    expect(
      body,
      '写权限闸门回到了桌面也走的那条 preflight 里 —— 桌面会因此多一条拒绝启动的路'
    ).not.toMatch(/assertAccountStoreWritable/)
  })

  it('服务端那条 preflight 确实含写权限闸门（防修裁决 1 时把服务端能力一并删掉）', () => {
    const src = stripComments(read('src/main/persistence/accountStorePort.ts'))
    const fnIdx = src.indexOf('export function preflightAccountStoreForServer(')
    expect(fnIdx, 'preflightAccountStoreForServer 不存在 —— 服务端失去写权限闸门').toBeGreaterThan(
      -1
    )
    const body = src.slice(fnIdx, fnIdx + 400)
    expect(body).toMatch(/assertAccountStoreWritable/)
  })

  it('服务端实现走的是 ...ForServer（否则闸门保留了但没人调）', () => {
    const src = stripComments(read('src/main/persistence/accountStore.conf.ts'))
    expect(src).toMatch(/preflightAccountStoreForServer\s*\(/)
  })
})
