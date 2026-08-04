/**
 * 路径穿越防线 —— 本文件是这个包里**唯一承重的安全测试**。
 *
 * 静态托管一旦上局域网,`GET /panel/../../../etc/passwd` 就是最经典的读取洞。
 * 这组用例的判据刻意是**「逃逸真的失败了」**,不是「正常路径能取到」——
 * 后者任何实现都能绿,前者才是这层存在的理由。
 *
 * ## 为什么必须逐编码列举,而不是「写个正则挡 ..」
 *
 * 解码顺序错一次就全线失守:先归一化再解码,`%2e%2e%2f` 就绕过了 `..` 检查。
 * 所以判据落在**解码之后**的实测结果上,并把每种编码形态钉成独立用例 ——
 * 哪天有人换实现,红的会是具体哪一种编码,而不是笼统一句「穿越测试失败」。
 */
import { describe, it, expect } from 'vitest'
import { resolveAssetPath } from '../../../src/main/webPanel/staticAssets'

/** 一个跨平台稳定的假根 —— 断言只看「结果是否仍在 root 内」,不碰真实盘 */
const ROOT = process.platform === 'win32' ? 'C:\\app\\out\\webPanel' : '/app/out/webPanel'

/**
 * 逃逸样本表。每条都是真实攻击载荷的形态,注释写明它绕的是哪种幼稚实现。
 * `urlPath` 是**已去掉 `/panel/` 前缀后**交给托管层的部分(与生产调用点一致)。
 */
const ESCAPES: Array<{ label: string; urlPath: string; beats: string }> = [
  // ---- 明文 ----
  { label: '明文 ../ 三级', urlPath: '../../../etc/passwd', beats: '完全不做校验' },
  {
    label: '明文 ../ 嵌在中段',
    urlPath: 'assets/../../../../etc/passwd',
    beats: '只看开头是否为 ..'
  },
  { label: '仅一级 ../', urlPath: '../package.json', beats: '只挡深层穿越' },

  // ---- 单次百分号编码 ----
  {
    label: '%2e%2e%2f 全编码',
    urlPath: '%2e%2e%2f%2e%2e%2fpackage.json',
    beats: '先查 ".." 再 decode(顺序反了)'
  },
  { label: '..%2f 混合', urlPath: '..%2f..%2fpackage.json', beats: '只挡字面 "../" 三字符串' },
  { label: '%2e%2e/ 混合', urlPath: '%2e%2e/%2e%2e/package.json', beats: '同上,另一半编码' },
  { label: '大写 %2E%2E%2F', urlPath: '%2E%2E%2Fpackage.json', beats: '正则大小写敏感' },

  // ---- 二次编码 ----
  {
    label: '双重编码 %252e%252e%252f',
    urlPath: '%252e%252e%252fpackage.json',
    beats: '解码两次的实现(必须只解一次)'
  },

  // ---- 反斜杠(Windows 分隔符,也是 Node path 在 win32 的合法分隔符)----
  { label: '反斜杠 ..\\', urlPath: '..\\..\\package.json', beats: '只把 "/" 当分隔符' },
  { label: '编码反斜杠 %5c', urlPath: '..%5c..%5cpackage.json', beats: '同上 + 编码' },

  // ---- 绝对路径 / 盘符 ----
  {
    label: 'Unix 绝对路径',
    urlPath: '/etc/passwd',
    beats: 'join(root, "/etc/passwd") 在 posix 下仍拼接,但 resolve 会跳根'
  },
  {
    label: 'Windows 盘符绝对路径',
    urlPath: 'C:\\Windows\\win.ini',
    beats: 'win32 下 resolve 会直接跳到 C:\\'
  },
  { label: 'Windows 编码盘符', urlPath: 'C%3A%5CWindows%5Cwin.ini', beats: '同上 + 编码' },
  { label: 'UNC 路径', urlPath: '//attacker/share/x', beats: '未拒绝网络路径' },

  // ---- 空字节 ----
  {
    label: '空字节截断',
    urlPath: 'index.html%00.txt',
    beats: '把 NUL 当普通字符传给 fs(旧 Node 可截断)'
  },
  { label: '空字节 + 穿越', urlPath: '..%00/../package.json', beats: '同上' },

  // ---- Windows ADS(备用数据流)----
  {
    label: 'ADS ::$DATA',
    urlPath: 'index.html::$DATA',
    beats: '未拒绝 ADS —— 可绕过扩展名白名单读原文'
  },
  { label: 'ADS 编码冒号', urlPath: 'index.html%3A%3A%24DATA', beats: '同上 + 编码' },

  // ---- 畸形编码 ----
  {
    label: '不完整百分号',
    urlPath: '%',
    beats: 'decodeURIComponent 抛异常未被捕获 → 500 而非 400'
  },
  { label: '非法编码序列', urlPath: '%zz', beats: '同上' },
  { label: '超长 ../ 链', urlPath: '../'.repeat(40) + 'etc/passwd', beats: '限定层数的实现' }
]

describe('静态资源 · 路径穿越防线(逃逸必须失败)', () => {
  for (const { label, urlPath, beats } of ESCAPES) {
    it(`拒绝:${label}`, () => {
      const result = resolveAssetPath(ROOT, urlPath)
      expect(
        result.ok,
        `穿越载荷被放行 —— 绕过了「${beats}」这种实现。` +
          `载荷=${JSON.stringify(urlPath)} 解析结果=${JSON.stringify(result)}`
      ).toBe(false)
    })
  }

  it('逃逸样本表本身非空且覆盖各主要形态(防表被清空后闸门空跑)', () => {
    // 这条治的是「上面的循环因为表为空而永远绿」。
    expect(ESCAPES.length).toBeGreaterThanOrEqual(20)
    const all = ESCAPES.map((e) => e.urlPath).join('|')
    expect(all).toContain('%2e')
    expect(all).toContain('%00')
    expect(all).toContain('::$DATA')
    expect(all).toContain('\\')
  })
})

describe('静态资源 · 合法路径必须通过(防「一律拒绝」的假安全)', () => {
  // 只挡不放等于面板永远白屏 —— 这组是上一组的对偶,缺了它「全部 return false」也能绿。
  const LEGIT = ['index.html', 'assets/index-C_sieKU2.js', 'assets/index-DGSNEg0M.css', '']

  for (const urlPath of LEGIT) {
    it(`放行:${JSON.stringify(urlPath)}`, () => {
      const result = resolveAssetPath(ROOT, urlPath)
      expect(result.ok, `合法路径被拒 —— 实现退化成「一律拒绝」`).toBe(true)
    })
  }

  it('放行的路径解析结果必须仍在 root 内(正向不变量)', () => {
    for (const urlPath of LEGIT) {
      const result = resolveAssetPath(ROOT, urlPath)
      if (!result.ok) continue
      expect(result.absPath.startsWith(ROOT)).toBe(true)
    }
  })

  it('百分号编码的合法文件名能被正确解码(编码不等于攻击)', () => {
    const result = resolveAssetPath(ROOT, 'assets/my%20file.js')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.relPath).toContain('my file.js')
  })
})
