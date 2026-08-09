// Layer B 回归测试:tool_result 智能压缩(RTK)
//
// 真实案例:一个 SUB 任务把 28 文件 1800 行的 git diff 作为单条 tool_result 返回,
// 这类块在 history 里累积 → 撑爆上游体积上限;而其「信息量」(哪些文件、哪些 hunk、
// 大致改了什么)扛得住重度压缩。
//
// 本文件锁死的硬边界:
//   - 只压 history,**绝不碰 currentMessage**(用户当前消息必须逐字节原样出站)
//   - 出错的 tool_result 不压(错误栈诊断价值高)
//   - 压完不比原文短 → 保留原文
//   - 任何抛错 → 原 payload 一个字节都不许被改(原子性)
//   - 压过的块带 [rtk-compressed:<filter>] 前缀,让模型看得见「这块被压过」

import { describe, it, expect, vi, afterEach } from 'vitest'
import { compressToolResults } from '@main/proxy/rtk/index'
import { MIN_COMPRESS_SIZE } from '@main/proxy/rtk/constants'
import type { KiroPayload, KiroHistoryMessage, KiroToolResult } from '@main/proxy/types'

afterEach(() => {
  vi.unstubAllEnvs()
})

// ============ fixtures(按仓库真实 KiroPayload 类型构造,不自造形状)============

function makeToolResult(
  text: string,
  status: 'success' | 'error' = 'success',
  toolUseId = 'tu-1'
): KiroToolResult {
  return { toolUseId, status, content: [{ text }] }
}

/** 造真实 Kiro 嵌套:conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text */
function makePayload(
  historyToolResults: KiroToolResult[][],
  currentToolResults: KiroToolResult[] = []
): KiroPayload {
  const history: KiroHistoryMessage[] = []
  historyToolResults.forEach((toolResults, i) => {
    history.push({
      userInputMessage: {
        content: '',
        modelId: 'claude-opus-5',
        origin: 'AI_EDITOR',
        userInputMessageContext: { toolResults }
      }
    })
    history.push({ assistantResponseMessage: { content: `ack-${i}` } })
  })
  const currentMessage: KiroPayload['conversationState']['currentMessage'] = {
    userInputMessage: {
      content: 'go',
      modelId: 'claude-opus-5',
      origin: 'AI_EDITOR',
      ...(currentToolResults.length
        ? { userInputMessageContext: { toolResults: currentToolResults } }
        : {})
    }
  }
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'conv-1',
      currentMessage,
      history
    }
  }
}

/** 28 文件 × N 行的 unified diff —— 复刻真实报障样本形态 */
function makeGitDiff(files = 28, changePairsPerFile = 60): string {
  const out: string[] = []
  for (let f = 0; f < files; f++) {
    const path = `src/mod${f}/file${f}.ts`
    out.push(`diff --git a/${path} b/${path}`)
    out.push('index 1111111..2222222 100644')
    out.push(`--- a/${path}`)
    out.push(`+++ b/${path}`)
    out.push(`@@ -1,${changePairsPerFile} +1,${changePairsPerFile} @@ function mod${f}()`)
    for (let l = 0; l < changePairsPerFile; l++) {
      out.push(`-  const removed${l} = ${'r'.repeat(60)}`)
      out.push(`+  const added${l} = ${'a'.repeat(60)}`)
    }
  }
  return out.join('\n')
}

/** 大段无结构行转储(非 git、非 grep、非行号) */
function makePlainDump(lines = 800): string {
  return Array.from({ length: lines }, (_, i) => `record ${i} ${'payload-'.repeat(20)}`).join('\n')
}

/** 每行一个独立文件的 grep 输出 —— grep filter 分组后反而更长(用于验「不许变长」双保险) */
function makeNonShrinkableGrep(lines = 700): string {
  return Array.from({ length: lines }, (_, i) => `file${i}.ts:1:${'q'.repeat(100)}`).join('\n')
}

function firstHistoryText(payload: KiroPayload): string {
  return payload.conversationState.history![0].userInputMessage!.userInputMessageContext!
    .toolResults![0].content[0].text
}

describe('RTK Layer B · compressToolResults', () => {
  it('B1 全部 history tool_result 都低于阈值 → nothing_to_compress 且 payload 完全没被改', () => {
    const payload = makePayload([[makeToolResult('x'.repeat(1024))]])
    const before = JSON.stringify(payload)

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    expect(result.applied === false && result.reason).toBe('nothing_to_compress')
    expect(JSON.stringify(payload)).toBe(before)
  })

  it('B2 超阈值 git diff → 命中 gitDiff filter,带前缀标记,hunk 头与 +X -Y 汇总保留', () => {
    const diff = makeGitDiff()
    expect(Buffer.byteLength(diff, 'utf-8')).toBeGreaterThan(MIN_COMPRESS_SIZE)
    const payload = makePayload([[makeToolResult(diff)]])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(true)
    if (result.applied !== true) return
    expect(result.stats.hits[0].filter).toBe('git-diff')
    expect(result.stats.hits[0].saved).toBeGreaterThan(0)
    expect(result.stats.bytesAfter).toBeLessThan(result.stats.bytesBefore)

    const text = firstHistoryText(payload)
    expect(text.startsWith('[rtk-compressed:git-diff]\n')).toBe(true)
    // 信息量存活:文件名 / hunk 头 / 增删汇总
    expect(text).toContain('src/mod0/file0.ts')
    expect(text).toContain('@@ -1,60 +1,60 @@')
    expect(text).toContain('+60 -60')
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(Buffer.byteLength(diff, 'utf-8'))
  })

  it('B3 超阈值无结构行转储 → smartTruncate:头尾保留 + 截断提示', () => {
    const dump = makePlainDump()
    expect(Buffer.byteLength(dump, 'utf-8')).toBeGreaterThan(MIN_COMPRESS_SIZE)
    const payload = makePayload([[makeToolResult(dump)]])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(true)
    if (result.applied !== true) return
    expect(result.stats.hits[0].filter).toBe('smart-truncate')

    const text = firstHistoryText(payload)
    expect(text.startsWith('[rtk-compressed:smart-truncate]\n')).toBe(true)
    expect(text).toContain('record 0 ') // 头部保留
    expect(text).toContain('record 799 ') // 尾部保留
    expect(text).toMatch(/\.\.\. \+\d+ lines truncated/)
    expect(text).not.toContain('record 400 ') // 中段被丢
  })

  it('B4 status=error 的 tool_result 即便 100KB+ 也绝不压缩', () => {
    const diff = makeGitDiff()
    const payload = makePayload([[makeToolResult(diff, 'error')]])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    expect(firstHistoryText(payload)).toBe(diff)
  })

  it('B4b is_error=true 的 tool_result 即便 100KB+ 也绝不压缩(Claude 形状泄漏防御)', () => {
    const diff = makeGitDiff()
    const tr = makeToolResult(diff)
    ;(tr as KiroToolResult & { is_error?: boolean }).is_error = true
    const payload = makePayload([[tr]])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    expect(firstHistoryText(payload)).toBe(diff)
  })

  it('B5 顶层抛错 → applied:false/reason:error,且原 payload 与调用前快照逐字节一致(原子性硬闸)', () => {
    const diff = makeGitDiff()
    const payload = makePayload([[makeToolResult(diff)]])
    const snapshot = JSON.stringify(payload)

    // 制造顶层抛错:循环引用让深拷贝 JSON.stringify 抛「Converting circular structure」
    ;(payload as KiroPayload & { selfRef?: unknown }).selfRef = payload

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    expect(result.applied === false && result.reason).toBe('error')
    expect(result.applied === false && typeof result.error).toBe('string')

    delete (payload as KiroPayload & { selfRef?: unknown }).selfRef
    expect(JSON.stringify(payload)).toBe(snapshot)
  })

  it('B5b 压缩循环只碰克隆体 → 原 payload 结构上不可能被写坏(拷贝式原子性的机制级证明)', () => {
    const diff = makeGitDiff()
    const payload = makePayload([
      [makeToolResult(diff)],
      [makeToolResult(diff, 'success', 'tu-two')]
    ])

    // 本测试的由来:原版试图用「取 text 就抛错的 getter」造出「遍历到一半爆掉」,
    // 以此证明前半段已压的结果不溢出到原 payload。实测该场景**不可达**,原因在机制上:
    //
    //   1. hasCandidate() 预扫(index.ts:60)先读 text,且一命中就 return —— 无条件抛的
    //      getter 在这里就爆了,clone 与压缩循环根本没跑过(原版因此测的是「预扫抛错」,
    //      与 B5a 重复,证明不了原子性);
    //   2. clonePayload 走 JSON.parse(JSON.stringify(...)):stringify 会调 getter,但把
    //      **返回值**写成克隆体上的普通属性。于是压缩循环读到的是克隆体上无 getter 的
    //      普通字符串 —— 原 payload 的 getter 在遍历期一次都不会被读到。
    //
    // ⇒ 「遍历中段抛错」在当前实现下结构上不存在:循环全程只碰克隆体。这比「抛错时能
    //    回滚」更强 —— 原 payload 在单次赋值(index.ts:78)之前根本没有被写入的路径。
    //    下面直接钉这个更强的性质,而不是伪造一个够不到的抛错点。
    const originalFirst = firstHistoryText(payload)
    const firstTr =
      payload.conversationState.history![0].userInputMessage!.userInputMessageContext!
        .toolResults![0]
    const originalPart = firstTr.content[0]

    const result = compressToolResults(payload)

    // 压缩确实发生了(否则下面的「原对象未被改写」是空转)
    expect(result.applied).toBe(true)
    expect(firstHistoryText(payload).startsWith('[rtk-compressed')).toBe(true)

    // 关键:换入是**整棵 conversationState 单次赋值**,不是就地改写原来的 content 对象。
    // 原 part 对象仍持有未压缩的原文 —— 证明压缩循环从未写过原 payload 的任何节点。
    expect(originalPart.text).toBe(originalFirst)
    expect(originalPart.text.startsWith('[rtk-compressed')).toBe(false)
    // 且原 part 已不在换入后的树上(被克隆体的同位节点取代)
    expect(
      payload.conversationState.history![0].userInputMessage!.userInputMessageContext!
        .toolResults![0].content[0]
    ).not.toBe(originalPart)
  })

  it('B6 压缩结果不比原文短 → 保留原文(grep 分组反而变长的真实场景)', () => {
    const input = makeNonShrinkableGrep()
    expect(Buffer.byteLength(input, 'utf-8')).toBeGreaterThan(MIN_COMPRESS_SIZE)
    const payload = makePayload([[makeToolResult(input)]])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    expect(result.applied === false && result.reason).toBe('nothing_to_compress')
    expect(firstHistoryText(payload)).toBe(input)
  })

  it('B7 正确遍历真实 Kiro 嵌套:多条 history 消息、多个 toolResults、多个 content 分片', () => {
    const diff = makeGitDiff()
    const dump = makePlainDump()
    const payload = makePayload([
      [makeToolResult(diff, 'success', 'tu-a'), makeToolResult('small', 'success', 'tu-b')],
      [{ toolUseId: 'tu-c', status: 'success', content: [{ text: 'tiny' }, { text: dump }] }]
    ])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(true)
    if (result.applied !== true) return
    expect(result.stats.hits.map((h) => h.filter).sort()).toEqual(['git-diff', 'smart-truncate'])

    const trs0 =
      payload.conversationState.history![0].userInputMessage!.userInputMessageContext!.toolResults!
    expect(trs0[0].content[0].text.startsWith('[rtk-compressed:git-diff]\n')).toBe(true)
    expect(trs0[1].content[0].text).toBe('small') // 小块原样

    const trs1 =
      payload.conversationState.history![2].userInputMessage!.userInputMessageContext!.toolResults!
    expect(trs1[0].content[0].text).toBe('tiny') // 同一 tool_result 内的小分片原样
    expect(trs1[0].content[1].text.startsWith('[rtk-compressed:smart-truncate]\n')).toBe(true)
  })

  it('B8 硬闸:currentMessage 里 500KB 的 tool_result 绝不压缩(用户当前消息必须原样)', () => {
    const huge = makeGitDiff(100, 60)
    expect(Buffer.byteLength(huge, 'utf-8')).toBeGreaterThan(500 * 1024)
    const payload = makePayload([], [makeToolResult(huge)])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    const current =
      payload.conversationState.currentMessage.userInputMessage.userInputMessageContext!
        .toolResults!
    expect(current[0].content[0].text).toBe(huge)
  })

  it('B8b history 有可压块 + currentMessage 也超大 → 只压 history,currentMessage 逐字节不动', () => {
    const huge = makeGitDiff(100, 60)
    const diff = makeGitDiff()
    const payload = makePayload([[makeToolResult(diff)]], [makeToolResult(huge)])

    const result = compressToolResults(payload)

    expect(result.applied).toBe(true)
    expect(firstHistoryText(payload)).not.toBe(diff)
    const current =
      payload.conversationState.currentMessage.userInputMessage.userInputMessageContext!
        .toolResults!
    expect(current[0].content[0].text).toBe(huge)
  })

  it('B9 KIRO_PROXY_LAYER_B=false → 完全 no-op', () => {
    vi.stubEnv('KIRO_PROXY_LAYER_B', 'false')
    const diff = makeGitDiff()
    const payload = makePayload([[makeToolResult(diff)]])
    const before = JSON.stringify(payload)

    const result = compressToolResults(payload)

    expect(result.applied).toBe(false)
    expect(result.applied === false && result.reason).toBe('nothing_to_compress')
    expect(JSON.stringify(payload)).toBe(before)
  })

  it('options.minCompressSize 可下调阈值(供调用方/测试收紧)', () => {
    const dump = makePlainDump(300)
    const payload = makePayload([[makeToolResult(dump)]])

    const result = compressToolResults(payload, { minCompressSize: 1024 })

    expect(result.applied).toBe(true)
  })

  it('options.rawCap 之上的病态输入直接跳过', () => {
    const dump = makePlainDump()
    const payload = makePayload([[makeToolResult(dump)]])

    const result = compressToolResults(payload, { rawCap: 1024 })

    expect(result.applied).toBe(false)
    expect(firstHistoryText(payload)).toBe(dump)
  })

  it('没有 history / history 为空 → nothing_to_compress', () => {
    const payload = makePayload([])
    expect(compressToolResults(payload).applied).toBe(false)
    delete payload.conversationState.history
    expect(compressToolResults(payload).applied).toBe(false)
  })
})
