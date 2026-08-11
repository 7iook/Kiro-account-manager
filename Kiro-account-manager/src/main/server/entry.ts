/**
 * 服务端进程入口 —— 这是整个服务器化工作里第一个真正有 `main()` 的东西。
 *
 * 职责边界（刻意很薄）：读环境变量 → 前置校验数据 → 装配（`assembly.ts`）→
 * 起面板 → 按配置起反代 → 装信号处理器。**没有一行业务逻辑**，也没有装配细节。
 *
 * ## 为什么入口与装配分成两个文件
 *
 * 侦察报告 §4 反对单文件（它会长成第二个 7000 行的 `index.ts`）。分界线是
 * **副作用**：本文件是唯一允许碰 `process.env` / `process.exit` / `process.on(signal)`
 * 的地方，`assembly.ts` 与 `config.ts` 是可测的纯装配与纯函数。于是测试能完整验
 * 装配契约而不需要真的起一个进程、占两个端口、装全局信号处理器。
 *
 * ## 启动顺序（每一步的位置都是承重的）
 *
 *   1. **读环境变量** —— 最便宜的失败。缺 `KIRO_DATA_DIR` 就没必要往下走。
 *   2. **数据前置校验** —— 四态 + 版本 + 写权限，带分类退出码（见 `config.ts`）。
 *      必须在装配**之前**：装配会构造 store 而构造会创建目录，
 *      而一次「拒绝启动」不该留下副作用。
 *   3. **adminKey 引导** —— 必须在面板启动之前。面板绑外网且无 adminKey 会拒启
 *      （`webPanel/server.ts:117` 的既有红线），而首启的密钥要打印给运维抄走。
 *   4. **装配** —— 建 store、注入写入收口、装 deps、建面板与反代工厂。
 *   5. **起面板** —— 先于反代。面板是唯一的管理入口：反代起不来时运维**需要**
 *      面板还活着才能去查原因、改配置。顺序反了就成了「反代挂 → 面板也没起 →
 *      只能 SSH」，而「不用碰服务器」正是本项目的原始需求。
 *   6. **起反代**（按 `enabled && autoStart`）—— 失败**不致命**：面板已经在跑，
 *      运维可以从手机上看到失败原因并重试。这是刻意的不对称。
 *   7. **装信号处理器** —— 最后。装早了会在启动失败的退出路径上被自己的
 *      handler 拦住。
 *
 * ## 未做的（有意的空缺，不是遗漏）
 *
 *   - **单实例锁**：决策卡已裁决「服务器上只有一个进程 → 不需要任何锁」。
 *     且 Electron 的 `requestSingleInstanceLock` 在纯 Node 下不存在，不得照搬。
 *   - **存活探针 HTTP 端点**：决策卡 DC14 定的本轮范围是「存活 + 进程托管」，
 *     而**面板本身就是存活信号** —— systemd / Docker 可以直接探面板端口。
 *     再加一个 `/healthz` 就是第二个「进程还活着」的真源，且没有额外消费者。
 *   - **TLS**：决策卡 DC9 已定服务内不做终止，由前置反代（Caddy / nginx）负责。
 */
import {
  EXIT,
  ENV,
  ServerConfigError,
  preflightForServerWithExitCode,
  readServerConfig
} from './config'
import { assembleServer, readPanelConfig, readProxyConfig, shouldAutoStartProxy } from './assembly'
import { createServerAdminKeyStore } from './adminKeyStore'
import { createServerPersistenceHooks } from './persistence'
import type { AssembledServer } from './assembly'

/**
 * 启动。**不自己调 `process.exit`** —— 退出决策留给 `main()`。
 *
 * 分开的理由是可测性：`bootstrap` 可以在测试里跑完整启动流程并断言结果，
 * 而一个内部会 `process.exit` 的函数在测试里会把 vitest 进程本身杀掉。
 */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<AssembledServer> {
  // ① 环境变量
  const config = readServerConfig(env)
  console.log(`[server] 数据目录: ${config.dataDir}`)

  // ② 数据前置校验（在装配之前 —— 拒启不该留副作用）
  preflightForServerWithExitCode(config.dataDir)

  // ③ adminKey 引导（在面板启动之前）
  //
  // `legacyDesktopKeyPresent` 回答运维最可能的困惑：「我拷了数据文件，
  // 为什么桌面上那个密钥登不进去」。服务端刻意不继承桌面密钥（它有未知暴露史：
  // 设置页展示过、随数据文件跨机搬运过），故打印里要明说旧钥匙不生效。
  const adminKeyStore = createServerAdminKeyStore({
    dataDir: config.dataDir,
    env,
    legacyDesktopKeyPresent: hasLegacyDesktopAdminKey(config.dataDir)
  })

  // ④ 装配
  //
  // `persistence` 必须传：不传时 `assembly.ts:buildProxyEvents` 的 `onAccountUpdate`
  // 是「告警一次后丢弃」—— 反代刷出的新 token 只进内存池，进程重启后用回盘上的旧的。
  // 而 IdP 轮换 refreshToken 时旧的一签发新的就当场作废 ⇒ 重启后刷新 401。
  // 这比「压根不刷新」更糟：token 有效期内它看起来完全正常。
  const server = assembleServer({
    config,
    adminKeyStore,
    persistence: createServerPersistenceHooks()
  })

  // ⑤ 面板（先于反代 —— 它是唯一的管理入口，见文件头启动顺序）
  const panelConfig = readPanelConfig(server.store, config)
  try {
    await server.panel.start()
  } catch (e) {
    // 面板起不来是**致命**的：没有管理入口的服务端等于一个黑盒。
    // 与反代的不对称是刻意的（见 ⑥）。
    throw new ServerConfigError(
      `面板启动失败（${messageOf(e)}）。\n` +
        `面板是服务端唯一的管理入口，起不来则整个服务无法运维，故拒绝继续。\n` +
        `常见原因：端口 ${panelConfig.port} 被占用（用 ${ENV.PANEL_PORT} 换一个）；` +
        `或绑定到了外网地址而 adminKey 不可用。`,
      EXIT.UNAVAILABLE
    )
  }

  // ⑥ 反代（按盘上配置；失败不致命）
  const proxyConfig = readProxyConfig(server.store)
  if (shouldAutoStartProxy(proxyConfig)) {
    try {
      const proxy = server.initProxyServer()
      await proxy.start()
      console.log(`[server] 反代已启动: ${proxyConfig.host}:${proxyConfig.port}`)
    } catch (e) {
      // 刻意不致命：面板已经在跑，运维能从手机上看到失败原因并重试。
      // 崩在这里反而会连管理入口一起带走 —— 那时他只剩 SSH，
      // 而「不用碰服务器」正是本项目要消除的东西。
      console.error(
        `[server] ⚠️ 反代自动启动失败: ${messageOf(e)}\n` +
          `[server]    面板仍在运行，可从面板查看原因并手动启动（常见：端口被占 / 空池）。`
      )
    }
  } else {
    console.log(
      `[server] 反代未自动启动（盘上 proxyConfig.enabled=${proxyConfig.enabled} ` +
        `autoStart=${proxyConfig.autoStart ?? false}）。可从面板手动启动。`
    )
  }

  return server
}

/**
 * 数据文件里是否带着桌面的 `webPanelAdminKey`。
 *
 * 只用于给运维一句更有用的提示，故**任何失败都当成 false** —— 这是提示文案的
 * 输入，不是安全判据；为了一句提示而让启动失败是荒唐的。数据文件本身的可用性
 * 已由 ② 的 preflight 判过，这里不重复那件事。
 */
function hasLegacyDesktopAdminKey(dataDir: string): boolean {
  try {
    const { decoded } = preflightForServerWithExitCode(dataDir)
    const raw = decoded?.['webPanelAdminKey']
    return typeof raw === 'string' && raw.length > 0
  } catch {
    return false
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 装 SIGTERM / SIGINT 处理器。
 *
 * ## 为什么需要「第二次信号强退」
 *
 * `systemd stop` 与 `docker stop` 都是「先 SIGTERM，等 `TimeoutStopSec` /
 * `--time`，然后 SIGKILL」。若优雅停机卡住（一个在途的流式请求迟迟不结束），
 * 运维会再按一次 Ctrl-C —— 此时若我们仍在「优雅等待」，他会以为进程僵死了。
 * 故第二次信号立刻退，并说明是他自己要求的强退。
 *
 * ## 为什么要 `resolve` 而不是在 handler 里 `process.exit`
 *
 * `process.exit` 会立刻终止事件循环，**丢掉正在进行的写盘**（会话归档 + 防抖统计
 * 的 flush 都在 `shutdown()` 里）。让 handler 只触发 shutdown、由 `main()` 在
 * await 之后再退，写盘才有机会完成。
 *
 * @returns 收到信号并停机完成后 resolve 的 promise
 */
export function installShutdownHandlers(server: AssembledServer): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false
    const onSignal = (signal: string): void => {
      if (stopping) {
        // 第二次信号：运维在催。立刻退，别让他以为进程僵死了。
        console.error(`[server] 再次收到 ${signal}，强制退出（在途请求与未落盘的统计会丢失）。`)
        process.exit(EXIT.OK)
      }
      stopping = true
      console.log(`[server] 收到 ${signal}，开始停机...`)
      server
        .shutdown()
        .then(() => {
          console.log('[server] 已停机')
          resolve()
        })
        .catch((e) => {
          // 停机路径上的异常不该变成「进程挂住不退」—— 那比停机不干净更糟：
          // systemd 会等到超时再 SIGKILL，而运维看到的是「stop 卡了 90 秒」。
          console.error('[server] 停机过程出错:', e)
          resolve()
        })
    }
    process.once('SIGTERM', () => onSignal('SIGTERM'))
    process.once('SIGINT', () => onSignal('SIGINT'))
  })
}

/**
 * 进程主函数。**唯一**调 `process.exit` 的地方。
 *
 * 未捕获异常与未处理 rejection 也在这里收口：默认行为下 Node 对
 * unhandledRejection 只打印警告然后继续跑 —— 那会让一个已经半死的服务
 * 继续对外提供服务（面板还在监听，但内部状态已经不对了）。服务器上
 * 「快速失败 + 进程托管重启」远好于「带着未知损坏继续跑」。
 */
export async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    console.error('[server] 未处理的 Promise rejection（进程将退出，交由进程托管重启）:', reason)
    process.exit(EXIT.UNAVAILABLE)
  })
  process.on('uncaughtException', (error) => {
    console.error('[server] 未捕获异常（进程将退出，交由进程托管重启）:', error)
    process.exit(EXIT.UNAVAILABLE)
  })

  let server: AssembledServer
  try {
    server = await bootstrap()
  } catch (e) {
    // 启动期失败：把分类退出码交给进程托管，把原因写给运维。
    // stderr 而非 stdout —— journalctl / docker logs 都按流分色，
    // 且 stdout 那一行留给首启的 adminKey（运维要从日志里抄它）。
    const exitCode = e instanceof ServerConfigError ? e.exitCode : EXIT.UNAVAILABLE
    console.error(`\n[server] 启动失败（退出码 ${exitCode}）:\n${messageOf(e)}\n`)
    process.exit(exitCode)
    return
  }

  const address = server.panelAddress()
  console.log(
    `[server] 就绪。面板: http://${readPanelConfig(server.store, readServerConfig()).host}:${
      address?.port ?? '?'
    }/panel`
  )

  await installShutdownHandlers(server)
  process.exit(EXIT.OK)
}

/**
 * 仅当本文件是进程入口时才跑 `main()`。
 *
 * 判据用 `require.main === module`（CJS）—— 服务端产物由 electron-vite/rollup 打成
 * CJS（`out/server/index.js`），与 `out/main/index.js` 同形态。
 * 不写成裸调用 `main()`：那样任何 `import` 本文件的测试都会**真的启动一台服务器**，
 * 而这正是把入口与装配拆开要避免的事。
 */
if (typeof require !== 'undefined' && require.main === module) {
  void main()
}
