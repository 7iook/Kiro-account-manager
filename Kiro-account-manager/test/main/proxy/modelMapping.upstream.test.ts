/**
 * 端到端集成:客户端 model 名 → translator → mapModelId → payload → 真实上游 → 内容。
 *
 * 为什么需要这个文件(评审 A2 指出的缺口):
 *   modelMapping.test.ts 只断言 mapModelId 的返回值(纯函数),
 *   而先前的手工探测只验证了归一「目标」(直接给上游发 gpt-5.6-sol)。
 *   两者都不能证明「客户端传 gpt-4o 时,这条归一路径真的走通并拿到内容」——
 *   即 E-052「单测绿 ≠ 真接线」。本文件补的正是穿过映射点的那一段。
 *
 * 默认跳过:需要真实 ksk + 网络 + 消耗额度。跑法(PowerShell):
 *   $env:KAM_E2E_KSK='ksk_...'; $env:KAM_E2E_REGION='eu-central-1'
 *   $env:KAM_E2E_PROXY='http://127.0.0.1:7897'   # 部分地区不走代理只返 6 个模型
 *   npx vitest run test/main/proxy/modelMapping.upstream.test.ts
 */
import { describe, expect, it } from 'vitest'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { openaiToKiro } from '@main/proxy/translator'

const KSK = process.env.KAM_E2E_KSK
const REGION = process.env.KAM_E2E_REGION || 'eu-central-1'
const PROXY = process.env.KAM_E2E_PROXY
const ARN = process.env.KAM_E2E_ARN

const MACHINE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const UA = `aws-sdk-js/1.0.7 ua/2.1 os/win32#10.0.26100 lang/js md/nodejs#20.18.1 api/codewhispererstreaming#1.0.34 m/E KiroIDE-1.0.116-${MACHINE}`

const agent = PROXY ? new ProxyAgent(PROXY) : undefined

/** 把 translator 产出的真实 payload 发给上游,返回 { status, firstBytes, errBody } */
async function sendToUpstream(payload: unknown): Promise<{ status: number; firstBytes: number; errBody: string }> {
  const res = await undiciFetch(`https://runtime.${REGION}.kiro.dev/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KSK}`,
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': 'KiroRuntimeService.GenerateAssistantResponse',
      TokenType: 'API_KEY',
      'User-Agent': UA,
      'x-amz-user-agent': UA,
      'x-amzn-kiro-agent-mode': 'vibe',
      'amz-sdk-invocation-id': crypto.randomUUID(),
      'amz-sdk-request': 'attempt=1; max=1'
    },
    body: JSON.stringify(payload),
    ...(agent ? { dispatcher: agent } : {})
  } as Parameters<typeof undiciFetch>[1])

  if (!res.ok) {
    const errBody = (await res.text().catch(() => '')).slice(0, 300)
    return { status: res.status, firstBytes: 0, errBody }
  }
  // 只读首帧确认真的出流,随即断开,尽量不烧额度
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const { value } = await reader.read()
  await reader.cancel().catch(() => {})
  return { status: res.status, firstBytes: value?.length ?? 0, errBody: '' }
}

/** 429 是账号级限流,与「model 名无效」无关,退避重试以免误判 */
async function sendWithBackoff(payload: unknown, attempts = 5) {
  let last = await sendToUpstream(payload)
  for (let i = 1; i < attempts && last.status === 429; i++) {
    await new Promise(r => setTimeout(r, 15000 * i))
    last = await sendToUpstream(payload)
  }
  return last
}

describe.skipIf(!KSK)('端到端:客户端 model 名穿过 translator 到真实上游', () => {
  // 每个用例都真发网络 + 可能退避重试,给足超时
  const TIMEOUT = 240_000

  it.each([
    // [客户端传的名, translator 应产出的 canonical id]
    ['gpt-4o', 'gpt-5.6-sol'],        // 原始投诉样本:老名,修复前指向 claude-sonnet-4.5
    ['gpt-5.6', 'gpt-5.6-sol'],       // 裸名:修复前原样透传 → 上游 400
    ['gpt-5.7-sol', 'gpt-5.6-sol'],   // 未来名:修复前原样透传 → 上游 400
    ['gpt-5.6-terra', 'gpt-5.6-terra'], // 正常对照:显式 tier 不得被改成 Sol
    ['gpt-5.6-luna', 'gpt-5.6-luna']    // 正常对照:同上
  ])('客户端传 %s → payload.modelId=%s 且上游返回内容', async (clientModel, expectedId) => {
    // 1) 走真实转换链(不是手搓 payload)
    const payload = openaiToKiro({
      model: clientModel,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 64
    } as Parameters<typeof openaiToKiro>[0], ARN)

    // 2) 断言映射点真的生效在进上游的那个字段上
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe(expectedId)

    // 3) 把这份真实 payload 发给上游,证明这条路走得通
    const r = await sendWithBackoff(payload)
    expect(r.status, `上游拒绝 ${clientModel}→${expectedId}: ${r.errBody}`).toBe(200)
    expect(r.firstBytes).toBeGreaterThan(0)
  }, TIMEOUT)

  it('Claude 入口对照:显式 canonical id 不受 GPT 归一影响', async () => {
    const payload = openaiToKiro({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 64
    } as Parameters<typeof openaiToKiro>[0], ARN)
    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-opus-5')
    const r = await sendWithBackoff(payload)
    expect(r.status, `上游拒绝 claude-opus-5: ${r.errBody}`).toBe(200)
    expect(r.firstBytes).toBeGreaterThan(0)
  }, TIMEOUT)
})
