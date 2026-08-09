// RTK 常量与 filter 类型
//
// 移植自 F:\9router\open-sse\rtk\constants.js(生产验证过的 JS 版),仅保留本层用到的 4 个 filter 参数。
// 与参考实现的故意偏离:MIN_COMPRESS_SIZE 从 500B 提到 50KB —— 本交付面向的是
// 「200KB+ 单块 tool_result」目标,小结果压了无收益且白白改写历史内容(破坏 prompt cache 的
// prefix 逐字节匹配,参 kiroApi.ts:1625 注释里 727be0b 的教训)。

/** 压缩输入下限:小于此值的 tool_result 不值得动(字节) */
export const MIN_COMPRESS_SIZE = 50 * 1024

/** 压缩输入上限:大于此值的病态输入直接跳过,避免 filter 本身成为 CPU 黑洞(字节) */
export const RAW_CAP = 10 * 1024 * 1024

/** autodetect 只看开头这么多字符,避免在 MB 级文本上跑正则 */
export const DETECT_WINDOW = 1024

/** gitDiff:单个 hunk 最多保留多少行正文 */
export const GIT_DIFF_HUNK_MAX_LINES = 100

/** gitDiff:输出总行数上限,触顶后给「more changes truncated」 */
export const GIT_DIFF_MAX_OUTPUT_LINES = 500

/** grep:单文件最多展示多少条命中 */
export const GREP_PER_FILE_MAX = 10

/** smartTruncate / readNumbered:头部保留行数 */
export const SMART_TRUNCATE_HEAD = 120

/** smartTruncate / readNumbered:尾部保留行数 */
export const SMART_TRUNCATE_TAIL = 60

/** 行数不达此值时 smartTruncate / readNumbered 不介入(原样返回) */
export const SMART_TRUNCATE_MIN_LINES = 250

/** readNumbered 判形的最低命中率:采样行中满足「N|content」的比例 */
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7

/** filter 名称字符串 SSOT —— 会随前缀标记进入真实请求体,不得随意改 */
export const FILTERS = {
  GIT_DIFF: 'git-diff',
  GREP: 'grep',
  READ_NUMBERED: 'read-numbered',
  SMART_TRUNCATE: 'smart-truncate'
} as const

export type FilterName = (typeof FILTERS)[keyof typeof FILTERS]

/** 一个 RTK filter:纯函数 string → string,携带自己的名字供日志/前缀使用 */
export type RtkFilter = ((input: string) => string) & { filterName: FilterName }

/** 把纯函数包成带 filterName 的 RtkFilter */
export function defineFilter(name: FilterName, fn: (input: string) => string): RtkFilter {
  return Object.assign(fn, { filterName: name })
}

/** 压缩过的文本前缀 —— 让模型能分辨「这块被压过」而不是默默收下一个被截断的谎 */
export function compressedPrefix(name: FilterName): string {
  return `[rtk-compressed:${name}]\n`
}
