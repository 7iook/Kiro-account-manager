import { describe, expect, it } from 'vitest'
import { mapModelId } from '@main/proxy/kiroApi'
import { resolveLoggedModel } from '@main/proxy/modelLogLabel'

/**
 * 请求日志必须体现「实际用了哪一档」。
 *
 * 现场(2026-08-12 用户截图):日志「模型」列显示 `gpt-5.6`,而 Kiro 上不存在该 id ——
 * 归一到 gpt-5.6-sol 才是真正被计费的那一档(2.4x)。日志记的是 request.model
 * (客户端原始名),归一发生在下游 mapModelId,从未回传到日志。
 * 后果:用户无法从日志判断自己在按哪档烧额度,也无法核对 credits 是否合理。
 */
describe('resolveLoggedModel · 日志显示实际档位', () => {
  it('归一改变了名字 → 同时给出实际档与客户端原始名', () => {
    expect(resolveLoggedModel('gpt-5.6')).toEqual({
      model: 'gpt-5.6-sol',
      requestedModel: 'gpt-5.6'
    })
    expect(resolveLoggedModel('gpt-4o')).toEqual({
      model: 'gpt-5.6-sol',
      requestedModel: 'gpt-4o'
    })
  })

  it('未知 GPT 名归一 → 同样留下原始名可追溯', () => {
    expect(resolveLoggedModel('gpt-5.7-sol')).toEqual({
      model: 'gpt-5.6-sol',
      requestedModel: 'gpt-5.7-sol'
    })
  })

  it('客户端已传 canonical id → 不产生冗余的 requestedModel', () => {
    expect(resolveLoggedModel('gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol' })
    expect(resolveLoggedModel('gpt-5.6-terra')).toEqual({ model: 'gpt-5.6-terra' })
    expect(resolveLoggedModel('claude-opus-5')).toEqual({ model: 'claude-opus-5' })
  })

  it('Claude 短横线归一(claude-opus-4-8 → 4.8)也算改变,要留痕', () => {
    expect(resolveLoggedModel('claude-opus-4-8')).toEqual({
      model: 'claude-opus-4.8',
      requestedModel: 'claude-opus-4-8'
    })
  })

  it('完全未知模型兜底 → 记录兜底目标 + 原始名(否则用户不知道请求被改过)', () => {
    expect(resolveLoggedModel('totally-bogus-model')).toEqual({
      model: 'claude-sonnet-4.5',
      requestedModel: 'totally-bogus-model'
    })
  })

  it('空 / undefined 模型名不炸,退化为 unknown 且不编造归一结果', () => {
    expect(resolveLoggedModel(undefined)).toEqual({ model: 'unknown' })
    expect(resolveLoggedModel('')).toEqual({ model: 'unknown' })
    expect(resolveLoggedModel('   ')).toEqual({ model: 'unknown' })
  })

  it('与 mapModelId 单一真源一致:model 字段恒等于 mapModelId 的结果', () => {
    for (const input of ['gpt-5.6', 'gpt-4o', 'gpt-5.7-sol', 'gpt-5.6-luna', 'claude-opus-5', 'claude-sonnet-4-5']) {
      expect(resolveLoggedModel(input).model).toBe(mapModelId(input))
    }
  })

  it('大小写差异不算「归一改变」——避免噪音式 requestedModel', () => {
    // GPT-5.6-SOL 与 gpt-5.6-sol 是同一档,只是大小写不同,不值得在 UI 上显示两个名字
    expect(resolveLoggedModel('GPT-5.6-SOL')).toEqual({ model: 'gpt-5.6-sol' })
  })
})
