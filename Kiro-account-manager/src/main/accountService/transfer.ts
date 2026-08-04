/**
 * accountService/transfer.ts · 账号数据导入 / 导出的可复用业务实现
 *
 * 从 `index.ts` 的 `export-to-file` / `import-from-file` 抽出。
 *
 * ⚠️ 这两个 handler 的**宿主机部分与可复用部分必须分开**,这是本文件的核心设计:
 *
 *   宿主机能力(浏览器物理上做不到)     可复用部分(两端共用)
 *   ─────────────────────────────    ──────────────────────────
 *   Electron dialog 弹本机文件选择框    「把内容写进这个路径」
 *   Electron dialog 弹本机保存框        「从这个路径读内容 + 判格式后缀」
 *
 *   桌面端 = dialog 选路径 → 读写;web 端 = HTTP 上传/下载给路径或直接给内容 → 同一读写。
 *   决策卡 §3 豁免清单把「导入导出 dialog → 上传/下载」判为**语义等价**,前提正是
 *   「返回形状相同」——`exportToFile` 返 boolean、`importFromFile` 返 `{content, format} | null`。
 *   故本文件把「选路径」抽成 deps 注入的 `pickSavePath` / `pickOpenPath`:
 *   桌面端注入 dialog 实现,将来 HTTP 层注入「直接返回上传文件路径」的实现,业务流程一行不改。
 *
 * 抽离契约同 switch.ts:不依赖 preload / 不接受 IpcMainInvokeEvent / 不 import electron。
 */

export interface ExportToFileDeps {
  /**
   * 让用户选择保存路径(桌面端 = `dialog.showSaveDialog`,宿主机能力)。
   * 用户取消时返回 null。
   */
  pickSavePath: (defaultPath: string) => Promise<string | null>
  /** 写文件(utf-8) */
  writeTextFile: (filePath: string, data: string) => Promise<void>
}

/**
 * 导出账号数据到文件。
 *
 * 返回 boolean —— `true` 已写盘,`false` 用户取消**或**出错。原实现就是这样把两种情况
 * 合并成 false(renderer 只用它决定要不要提示"已导出"),保持不变。
 */
export async function exportToFile(
  deps: ExportToFileDeps,
  data: string,
  filename: string
): Promise<boolean> {
  try {
    const filePath = await deps.pickSavePath(filename)
    if (!filePath) return false
    await deps.writeTextFile(filePath, data)
    return true
  } catch (error) {
    console.error('Failed to export:', error)
    return false
  }
}

export interface ImportFromFileResult {
  content: string
  /** 文件扩展名(小写),解析格式用;无扩展名时回落 'json' */
  format: string
}

export interface ImportFromFileDeps {
  /**
   * 让用户选择要导入的文件(桌面端 = `dialog.showOpenDialog`,宿主机能力)。
   * 用户取消时返回 null。
   */
  pickOpenPath: () => Promise<string | null>
  /** 读文件(utf-8) */
  readTextFile: (filePath: string) => Promise<string>
}

/**
 * 从文件导入账号数据 —— 只**返回内容与格式**,不落盘、不解析。
 * 解析与入库由 renderer 完成(它拿到 content 后自行解析再调 save-accounts),此语义不变。
 *
 * 返回 null = 用户取消**或**出错(同 exportToFile,原实现合并了两种情况)。
 */
export async function importFromFile(
  deps: ImportFromFileDeps
): Promise<ImportFromFileResult | null> {
  try {
    const filePath = await deps.pickOpenPath()
    if (!filePath) return null
    const content = await deps.readTextFile(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() || 'json'
    return { content, format: ext }
  } catch (error) {
    console.error('Failed to import:', error)
    return null
  }
}
