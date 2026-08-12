/**
 * 请求日志的模型标签解析 —— 让日志体现「实际用了哪一档」。
 *
 * ## 为什么需要这一层
 *
 * 现场(2026-08-12 用户截图):请求日志「模型」列显示 `gpt-5.6`,可 Kiro 上**不存在**这个 id
 * (实测裸名直接 400 INVALID_MODEL_ID);真正被发上去、被计费的是归一后的 `gpt-5.6-sol`(2.4x)。
 * 根因:各 handler 记日志时传的是 `request.model`(客户端原始名),而归一发生在下游
 * `translator → mapModelId`,归一结果从未回流到日志侧。
 * 后果:用户无法从日志判断自己在按哪一档烧额度,也无法核对 credits 数字是否合理
 * (Sol 2.4x 与 Luna 0.1x 差 24 倍,而日志上看不出区别)。
 *
 * ## 设计约束
 *
 * - **不复制映射规则**:`model` 字段一律由 `mapModelId` 派生,本模块只负责「决定要不要
 *   额外保留原始名」。映射的单一真源仍是 `kiroApi.ts` 的 `MODEL_ID_MAP` / `GPT_CANONICAL_IDS`。
 * - **只在真的改了名字时才带 `requestedModel`**:客户端本就传 canonical id 时不产生冗余字段,
 *   UI 也就不会显示两个一样的名字。大小写差异不算「改变」(同一档,显示两个名字是噪音)。
 * - **空值不编造**:model 缺失时退化为 `'unknown'` 且不给 `requestedModel` ——
 *   否则会出现「原始名是空、实际档是 claude-sonnet-4.5」这种误导性记录。
 */
import { mapModelId } from './kiroApi'

export interface LoggedModel {
  /** 实际发往上游、真正计费的 canonical modelId(= mapModelId 的结果) */
  model: string
  /** 客户端原始请求名。仅当归一确实改变了名字时才出现,便于排障与追溯 */
  requestedModel?: string
}

/**
 * 由客户端请求的 model 名解析出「日志该显示什么」。
 *
 * @param requested 客户端请求里的 model 字段(可能为空/未定义)
 */
export function resolveLoggedModel(requested: string | undefined | null): LoggedModel {
  const raw = (requested ?? '').trim()
  // 没传 model:保持既有的 'unknown' 语义,且不编造归一结果
  if (!raw) return { model: 'unknown' }

  const resolved = mapModelId(raw)
  // 大小写不同视为同一档(不制造噪音式 requestedModel)
  if (resolved.toLowerCase() === raw.toLowerCase()) return { model: resolved }
  return { model: resolved, requestedModel: raw }
}
