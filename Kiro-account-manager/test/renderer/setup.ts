import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// 每个 test 后清理 DOM,避免跨用例污染
afterEach(() => {
  cleanup()
})

// jsdom 缺 IntersectionObserver / ResizeObserver — 部分 UI 组件依赖
if (typeof globalThis.IntersectionObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return [] }
    root = null
    rootMargin = ''
    thresholds = []
  } as unknown as typeof IntersectionObserver
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// scrollIntoView 在 jsdom 里缺失
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn()
}

// matchMedia 在 jsdom 里缺失
if (typeof globalThis.matchMedia === 'undefined') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}
