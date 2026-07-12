import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

// 单元测试:双 project 共存
//  - main    : node env,覆盖 src/main + src/preload 的纯逻辑单元(不启 electron / 不真实网络)
//  - renderer: jsdom env,覆盖 src/renderer/src 的 React 组件与纯逻辑
// e2e-fullsuite 用自造 node runner (test/e2e-fullsuite/run.mjs),此 vitest 显式排除
export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      // 与 electron.vite.config.ts renderer 段一致:renderer 代码大量使用 `@/xxx`
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    // 顶层 exclude 覆盖两个 project
    exclude: [
      'test/e2e-fullsuite/**',
      'node_modules/**',
      'dist/**',
      'out/**'
    ],
    passWithNoTests: false,
    reporters: ['default'],
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: ['test/main/**/*.test.ts']
        }
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['test/renderer/**/*.test.{ts,tsx}'],
          setupFiles: [resolve(__dirname, 'test/renderer/setup.ts')],
          globals: true
        }
      }
    ]
  }
})
