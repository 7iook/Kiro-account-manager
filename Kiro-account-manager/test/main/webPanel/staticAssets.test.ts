/**
 * 静态托管的**纯逻辑**判据 —— MIME 表 / 缓存分级 / SPA 回退边界 / CSP 内容
 *
 * 路径穿越那组在 `staticAssets.traversal.test.ts`;端到端 HTTP 在
 * `staticAssets.server.test.ts`。分三个文件是因为三者失败时要查的东西不同。
 */
import { describe, it, expect } from 'vitest'
import {
  contentTypeFor,
  cacheControlFor,
  shouldFallbackToShell,
  CONTENT_SECURITY_POLICY
} from '../../../src/main/webPanel/staticAssets'

describe('静态资源 · MIME 类型', () => {
  // 这几条是「错了就白屏」的:浏览器对 module 脚本的 MIME 检查是强制的,
  // Content-Type 不是 JS 类型时直接拒绝执行,控制台只有一句 MIME 报错。
  it('JS bundle 必须是可执行的 JS 类型(错了浏览器拒绝执行 module)', () => {
    expect(contentTypeFor('assets/index-C_sieKU2.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('assets/chunk.mjs')).toBe('text/javascript; charset=utf-8')
  })

  it('CSS 必须是 text/css(错了样式被忽略,页面裸奔)', () => {
    expect(contentTypeFor('assets/index-DGSNEg0M.css')).toBe('text/css; charset=utf-8')
  })

  it('HTML 带 charset=utf-8(缺了中文标题乱码)', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
  })

  it('覆盖 Vite 可能吐出的其余类型', () => {
    expect(contentTypeFor('assets/logo.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('assets/font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('manifest.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeFor('assets/index.js.map')).toBe('application/json; charset=utf-8')
    expect(contentTypeFor('favicon.ico')).toBe('image/x-icon')
    expect(contentTypeFor('assets/bg.png')).toBe('image/png')
    expect(contentTypeFor('assets/bg.webp')).toBe('image/webp')
  })

  it('扩展名大小写不敏感', () => {
    expect(contentTypeFor('assets/INDEX.JS')).toBe('text/javascript; charset=utf-8')
  })

  it('未知扩展名 / 无扩展名 → octet-stream,**绝不**默认成 text/html', () => {
    // 默认 text/html 是个安全洞:任意上传物都会被当页面解析(存储型 XSS 的经典成因)。
    // octet-stream 让浏览器下载而非解析,是未知类型唯一安全的处置。
    expect(contentTypeFor('weird.xyz')).toBe('application/octet-stream')
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream')
    expect(contentTypeFor('assets/noext')).toBe('application/octet-stream')
  })
})

describe('静态资源 · 缓存分级', () => {
  it('内容哈希产物 → immutable 长缓存(文件名变才内容变)', () => {
    expect(cacheControlFor('assets/index-C_sieKU2.js')).toBe('public, max-age=31536000, immutable')
    expect(cacheControlFor('assets/index-DGSNEg0M.css')).toBe('public, max-age=31536000, immutable')
  })

  it('入口 HTML **绝不**长缓存(否则升级后拿旧 shell → 引用已删的 bundle → 白屏)', () => {
    const cc = cacheControlFor('index.html')
    expect(cc).toBe('no-cache')
    expect(cc).not.toContain('immutable')
    expect(cc).not.toMatch(/max-age=[1-9]/)
  })

  it('assets/ 下但无哈希的文件也不长缓存(判据是哈希,不是目录)', () => {
    // 判据必须是「文件名里有没有内容哈希」。若按目录判,
    // 一个手工放进 assets/ 的 logo.svg 改了内容却永远不刷新。
    expect(cacheControlFor('assets/logo.svg')).toBe('no-cache')
  })

  it('根目录的未哈希资源不长缓存', () => {
    expect(cacheControlFor('favicon.ico')).toBe('no-cache')
    expect(cacheControlFor('manifest.webmanifest')).toBe('no-cache')
  })
})

describe('静态资源 · SPA 回退边界', () => {
  it('客户端路由路径 → 回退给 shell', () => {
    expect(shouldFallbackToShell('accounts')).toBe(true)
    expect(shouldFallbackToShell('settings/proxy')).toBe(true)
    expect(shouldFallbackToShell('a/b/c/deep/route')).toBe(true)
  })

  it('api/* **绝不**回退(未知 API 必须是 JSON 404,不是 HTML)', () => {
    // 回退成 HTML 后前端 res.json() 抛「Unexpected token '<'」——
    // 报错离真因隔两层,是最难调的那类失败。
    expect(shouldFallbackToShell('api')).toBe(false)
    expect(shouldFallbackToShell('api/accounts')).toBe(false)
    expect(shouldFallbackToShell('api/does/not/exist')).toBe(false)
  })

  it('带扩展名的路径**绝不**回退(缺失资源必须暴露成 404)', () => {
    // 回退会把「产物缺失」伪装成 200 HTML,浏览器再报 MIME 错。
    expect(shouldFallbackToShell('assets/index-OLD.js')).toBe(false)
    expect(shouldFallbackToShell('missing.css')).toBe(false)
    expect(shouldFallbackToShell('foo/bar.png')).toBe(false)
  })

  it('assets/ 目录下一律不回退(那底下只有真实文件)', () => {
    expect(shouldFallbackToShell('assets')).toBe(false)
    expect(shouldFallbackToShell('assets/whatever')).toBe(false)
  })
})

describe('静态资源 · CSP', () => {
  it('script-src 不含 unsafe-inline / unsafe-eval(这是 CSP 的全部意义)', () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src'))
    expect(scriptSrc).toBe("script-src 'self'")
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(scriptSrc).not.toContain('unsafe-eval')
  })

  it('default-src none(fail-closed:漏写的资源类型默认被拒)', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
  })

  it('禁止外发与嵌套:connect-src self / form-action none / frame-ancestors none', () => {
    // connect-src 'self' 是数据外泄的闸门:注入代码无法把账号数据 POST 到外部。
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
  })

  it('style-src 放宽到 unsafe-inline —— 明账,且仅限 style', () => {
    // React 的 style={{...}} 会落成内联 style 属性。这笔放宽是有意的,
    // 但必须**只**在 style 上;若哪天 script 也被放宽,上面第一条会红。
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self' 'unsafe-inline'")
  })
})
