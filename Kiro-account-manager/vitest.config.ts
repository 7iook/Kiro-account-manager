import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

// 收录判据是「**占用真实操作系统资源**」,不是「绑端口」。三类都算:
//   ① 真实 listen / TLS 证书生成  ② 完整 bootstrap  ③ **spawn 真实子进程**
// ③ 是 2026-08-13 补进来的:`upstreamApiWithoutElectron.runtime` 与 `postinstall_conditional`
// 不绑任何端口,却在全套并行下被 CPU 饥饿撑过默认 5s(隔离跑最长单测仅 442ms)。
// 只按「绑端口」筛会漏掉它们,而漏掉的表现是随机红、每次换一条 —— 与真实回归同形。
const REAL_IO_TESTS = [
  'test/main/proxy/proxyServerDataPathInjection.test.ts',
  'test/main/proxy/holdGateSessionLifecycle.test.ts',
  'test/main/webPanel/importAccounts.server.test.ts',
  'test/main/webPanel/proxyRoutes.test.ts',
  'test/main/webPanel/server.test.ts',
  'test/main/webPanel/staticAssets.server.test.ts',
  'test/main/webPanel/readiness.server.test.ts',
  'test/main/webPanel/adminKeyRotation.server.test.ts',
  'test/main/accountService/checkPersistence.test.ts',
  'test/main/accountService/refreshPersistence.test.ts',
  'test/main/server/serverAutostartPoolSync.test.ts',
  'test/main/server/dataDirectoryLock.test.ts',
  'test/main/architecture/server_bundle_esm_interop.test.ts',
  'test/main/proxy/trustedTlsProxy.integration.test.ts',
  'test/main/upstreamApi/upstreamApiWithoutElectron.runtime.test.ts',
  'test/main/architecture/postinstall_conditional.test.ts'
]

// 单元测试:三个 project 共存
//  - main    : node env,覆盖 src/main + src/preload 的纯逻辑单元(不启 electron / 不真实网络)
//  - main-real-io:真实 HTTP/HTTPS/完整 bootstrap,普通并行组结束后单 worker 串行
//  - renderer: jsdom env,覆盖 src/renderer/src 的 React 组件与纯逻辑
// e2e-fullsuite 用自造 node runner (test/e2e-fullsuite/run.mjs),此 vitest 显式排除
export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      // 与 electron.vite.config.ts renderer 段一致:renderer 代码大量使用 `@/xxx`
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    // 顶层 exclude 覆盖三个 project
    exclude: ['test/e2e-fullsuite/**', 'node_modules/**', 'dist/**', 'out/**'],
    passWithNoTests: false,
    reporters: ['default'],
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: ['test/main/**/*.test.ts'],
          exclude: REAL_IO_TESTS,
          sequence: { groupOrder: 0 }
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
          globals: true,
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: 'main-real-io',
          environment: 'node',
          include: REAL_IO_TESTS,
          pool: 'forks',
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: {
            concurrent: false,
            // 资源组不能与普通并行 worker 同跑，否则单 worker 仍会被 CPU/网络风暴饿死。
            groupOrder: 1
          },
          testTimeout: 15_000,
          hookTimeout: 15_000,
          // 不用 retry 掩盖 ENOBUFS/超时；重试只会再制造 socket 与 RSA 工作。
          retry: 0
        }
      }
    ]
  }
})
