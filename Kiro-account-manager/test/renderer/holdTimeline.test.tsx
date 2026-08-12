import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HoldTimeline } from '../../src/renderer/src/components/proxy/ProxyPanel'

afterEach(cleanup)

describe('桌面反代面板 · 挂起时间线契约', () => {
  it('使用未截断总数，并让保留行沿用真实序号', () => {
    const releases = Array.from({ length: 50 }, (_, i) => ({
      at: 1_800_000_000_000 + i * 1000,
      trigger: 'auto' as const,
      outcome: 're-held' as const,
      outcomeAt: 1_800_000_000_500 + i * 1000
    }))

    render(
      <HoldTimeline
        current={{
          id: 9,
          reason: 'pool-empty',
          detail: [],
          startedAt: releases[0].at,
          endedAt: null,
          totalReleaseCount: 60,
          totalAutoReleaseCount: 60,
          releases
        }}
        recent={[]}
        isEn={false}
      />
    )

    expect(screen.getByText('· 已放行 60 次')).toBeTruthy()
    expect(screen.getByText('仅显示最近 50 条，前 10 条已省略')).toBeTruthy()
    expect(screen.getByText('#60')).toBeTruthy()
    expect(screen.getByText('#11')).toBeTruthy()
    expect(screen.queryByText('#10')).toBeNull()
  })
})
