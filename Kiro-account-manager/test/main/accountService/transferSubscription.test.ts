/**
 * accountService/transfer.ts + subscription.ts · 导入导出与订阅的可复用业务函数
 *
 * transfer 的重点 = 锁「宿主机部分(选路径)与可复用部分(读写)已分离」这个设计:
 *   web 端要能注入自己的 pickOpenPath/pickSavePath 而业务流程一行不改,
 *   决策卡 §3 才敢把「dialog → 上传/下载」判为语义等价。
 *
 * subscription 的重点 = 锁返回形状逐字不变(含失败时给空数组、set-overage 透传上游),
 *   renderer 多个组件已适配这种不统一,顺手统一会让调用方全线炸。
 */

import { describe, it, expect, vi } from 'vitest'
import {
  exportToFile,
  importFromFile,
  type ExportToFileDeps,
  type ImportFromFileDeps
} from '../../../src/main/accountService/transfer'
import {
  getAccountModels,
  getAccountSubscriptions,
  getAccountSubscriptionUrl,
  setAccountOverage
} from '../../../src/main/accountService/subscription'

describe('exportToFile · 导出账号数据', () => {
  it('用户选定路径后把内容写进去并回报成功', async () => {
    const writes: Array<{ path: string; data: string }> = []
    const deps: ExportToFileDeps = {
      pickSavePath: async () => '/home/u/backup.json',
      writeTextFile: async (path, data) => {
        writes.push({ path, data })
      }
    }

    const ok = await exportToFile(deps, '{"accounts":{}}', 'accounts-2026.json')

    expect(ok).toBe(true)
    expect(writes).toEqual([{ path: '/home/u/backup.json', data: '{"accounts":{}}' }])
  })

  it('用户取消保存时不写任何文件', async () => {
    const write = vi.fn()
    const deps: ExportToFileDeps = {
      pickSavePath: async () => null,
      writeTextFile: write
    }

    const ok = await exportToFile(deps, 'data', 'f.json')

    expect(ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('传入的默认文件名会交给选路径环节(桌面端据此预填保存框)', async () => {
    const seen: string[] = []
    const deps: ExportToFileDeps = {
      pickSavePath: async (defaultPath) => {
        seen.push(defaultPath)
        return null
      },
      writeTextFile: async () => {}
    }

    await exportToFile(deps, 'data', 'kiro-accounts-2026-08-03.json')

    expect(seen).toEqual(['kiro-accounts-2026-08-03.json'])
  })

  it('磁盘写入失败时回报 false 而不是抛异常', async () => {
    const deps: ExportToFileDeps = {
      pickSavePath: async () => '/readonly/x.json',
      writeTextFile: async () => {
        throw new Error('EROFS')
      }
    }

    await expect(exportToFile(deps, 'data', 'x.json')).resolves.toBe(false)
  })
})

describe('importFromFile · 导入账号数据', () => {
  it('返回文件内容与格式后缀,由调用方自行解析', async () => {
    const deps: ImportFromFileDeps = {
      pickOpenPath: async () => '/home/u/accounts.CSV',
      readTextFile: async () => 'email,token\r\na@b.c,ksk_x'
    }

    const result = await importFromFile(deps)

    expect(result).toEqual({ content: 'email,token\r\na@b.c,ksk_x', format: 'csv' })
  })

  it('用户取消选择时返回 null 且不读盘', async () => {
    const read = vi.fn()
    const deps: ImportFromFileDeps = { pickOpenPath: async () => null, readTextFile: read }

    expect(await importFromFile(deps)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('无扩展名文件的 format 回落为整个路径 —— 原实现既有行为,已登记为债,本轮不改', async () => {
    // `'…/accountsdump'.split('.').pop()` 得到整串(无点可分),`|| 'json'` 只在空串时才兜底。
    // 桌面端 dialog 有扩展名过滤器,实践中几乎碰不到;web 端上传任意文件名则会踩到。
    // 锁住现状而非理想行为:验收要求逐字节一致,修它属于行为变更,须另起一轮。
    const deps: ImportFromFileDeps = {
      pickOpenPath: async () => '/home/u/accountsdump',
      readTextFile: async () => '{}'
    }

    expect((await importFromFile(deps))?.format).toBe('/home/u/accountsdump')
  })

  it('读盘失败时返回 null 而不是抛异常', async () => {
    const deps: ImportFromFileDeps = {
      pickOpenPath: async () => '/gone.json',
      readTextFile: async () => {
        throw new Error('ENOENT')
      }
    }

    await expect(importFromFile(deps)).resolves.toBeNull()
  })

  it('选路径环节可被替换成非 dialog 实现,业务流程不变(web 端上传即走这条路)', async () => {
    // 模拟 HTTP 层:文件已被上传到临时路径,无需任何本机对话框
    const deps: ImportFromFileDeps = {
      pickOpenPath: async () => '/tmp/upload-abc123.json',
      readTextFile: async () => '{"accounts":{"A":{}}}'
    }

    expect(await importFromFile(deps)).toEqual({
      content: '{"accounts":{"A":{}}}',
      format: 'json'
    })
  })
})

const identity = { accessToken: 'tok', region: 'eu-west-1', accountId: 'acc-1' }

describe('getAccountModels · 账户可用模型列表', () => {
  it('把上游模型字段映射成前端消费的形状', async () => {
    const result = await getAccountModels(
      {
        fetchKiroModels: async () => [
          {
            modelId: 'claude-sonnet-4-5',
            modelName: 'Claude Sonnet 4.5',
            description: 'd',
            supportedInputTypes: ['text', 'image'],
            tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
            rateMultiplier: 1,
            rateUnit: 'request'
          }
        ]
      },
      identity
    )

    expect(result).toEqual({
      success: true,
      models: [
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet 4.5',
          description: 'd',
          inputTypes: ['text', 'image'],
          maxInputTokens: 200000,
          maxOutputTokens: 64000,
          rateMultiplier: 1,
          rateUnit: 'request'
        }
      ]
    })
  })

  it('上游报错时回报错误并给空数组(前端直接 .map 不会炸)', async () => {
    const result = await getAccountModels(
      {
        fetchKiroModels: async () => {
          throw new Error('403 Forbidden')
        }
      },
      identity
    )

    expect(result).toEqual({ success: false, error: '403 Forbidden', models: [] })
  })

  it('账号的 region 与 profileArn 透传给上游(丢 profileArn 会让上游 400)', async () => {
    const seen: Array<Record<string, unknown>> = []
    await getAccountModels(
      {
        fetchKiroModels: async (account) => {
          seen.push(account as unknown as Record<string, unknown>)
          return []
        }
      },
      { accessToken: 'tok', region: 'ap-southeast-1', profileArn: 'arn:aws:x:1', accountId: 'A' }
    )

    expect(seen[0].region).toBe('ap-southeast-1')
    expect(seen[0].profileArn).toBe('arn:aws:x:1')
    expect(seen[0].id).toBe('A')
  })

  it('没传 region 时回落 us-east-1', async () => {
    const seen: Array<Record<string, unknown>> = []
    await getAccountModels(
      {
        fetchKiroModels: async (a) => {
          seen.push(a as unknown as Record<string, unknown>)
          return []
        }
      },
      { accessToken: 'tok' }
    )

    expect(seen[0].region).toBe('us-east-1')
  })
})

describe('getAccountSubscriptions · 可用订阅列表', () => {
  it('上游返回订阅方案时连同免责声明一起给出', async () => {
    const result = await getAccountSubscriptions(
      {
        fetchAvailableSubscriptions: async () => ({
          subscriptionPlans: [{ type: 'PRO' }],
          disclaimer: 'terms apply'
        })
      },
      identity
    )

    expect(result).toEqual({
      success: true,
      plans: [{ type: 'PRO' }],
      disclaimer: 'terms apply'
    })
  })

  it('上游没给订阅方案时判失败并给空数组', async () => {
    const result = await getAccountSubscriptions(
      { fetchAvailableSubscriptions: async () => ({}) },
      identity
    )

    expect(result).toEqual({
      success: false,
      error: 'No subscription plans returned',
      plans: []
    })
  })

  it('上游抛错时回报错误并给空数组', async () => {
    const result = await getAccountSubscriptions(
      {
        fetchAvailableSubscriptions: async () => {
          throw new Error('timeout')
        }
      },
      identity
    )

    expect(result).toEqual({ success: false, error: 'timeout', plans: [] })
  })
})

describe('getAccountSubscriptionUrl · 订阅管理链接', () => {
  it('只返回链接与状态,不负责打开它(打开方式由调用端决定)', async () => {
    const result = await getAccountSubscriptionUrl(
      {
        fetchSubscriptionToken: async () => ({
          encodedVerificationUrl: 'https://kiro.dev/subscribe?t=abc',
          status: 'PENDING'
        })
      },
      identity
    )

    expect(result).toEqual({
      success: true,
      url: 'https://kiro.dev/subscribe?t=abc',
      status: 'PENDING'
    })
  })

  it('订阅类型透传给上游(不同套餐拿到不同链接)', async () => {
    const seen: Array<string | undefined> = []
    await getAccountSubscriptionUrl(
      {
        fetchSubscriptionToken: async (_a, subscriptionType) => {
          seen.push(subscriptionType)
          return { encodedVerificationUrl: 'https://x' }
        }
      },
      identity,
      'KIRO_PRO_PLUS'
    )

    expect(seen).toEqual(['KIRO_PRO_PLUS'])
  })

  it('上游没给链接时用上游的说明作为错误原因', async () => {
    const result = await getAccountSubscriptionUrl(
      { fetchSubscriptionToken: async () => ({ message: 'already subscribed' }) },
      identity
    )

    expect(result).toEqual({ success: false, error: 'already subscribed' })
  })
})

describe('setAccountOverage · 超额开关', () => {
  it('成功时原样透传上游结果(不包一层,renderer 直接消费上游形状)', async () => {
    const upstream = { success: true, preference: { overageStatus: 'ENABLED' } }

    const result = await setAccountOverage(
      { setUserPreference: async () => upstream },
      identity,
      'ENABLED'
    )

    expect(result).toBe(upstream)
  })

  it('开关值透传给上游', async () => {
    const seen: string[] = []
    await setAccountOverage(
      {
        setUserPreference: async (_a, status) => {
          seen.push(status)
          return {}
        }
      },
      identity,
      'DISABLED'
    )

    expect(seen).toEqual(['DISABLED'])
  })

  it('上游抛错时收敛成失败结果', async () => {
    const result = await setAccountOverage(
      {
        setUserPreference: async () => {
          throw new Error('429 Too Many Requests')
        }
      },
      identity,
      'ENABLED'
    )

    expect(result).toEqual({ success: false, error: '429 Too Many Requests' })
  })
})
