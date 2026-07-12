/**
 * ProfileSelectDialog · 覆盖决策卡 v2 §4 B3-B7
 *  B3 渲染所有 profile
 *  B4 已导入置灰 + 默认不勾选
 *  B5 取消回调 onCancel 不触发 onConfirm
 *  B6 勾选 M 个 → onConfirm 携带正确元素
 *  B7 全选 / 全不选切换
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProfileSelectDialog } from '@/components/accounts/ProfileSelectDialog'
import type { KiroProfileForSelect } from '@/components/accounts/profileImportHelpers'

const P1: KiroProfileForSelect = {
  profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/P1',
  profileName: 'ProfileOne',
  accountName: 'AcctOne',
  region: 'us-east-1'
}
const P2: KiroProfileForSelect = {
  profileArn: 'arn:aws:codewhisperer:us-east-1:222:profile/P2',
  profileName: 'ProfileTwo',
  accountName: 'AcctTwo',
  region: 'us-east-1'
}
const P3: KiroProfileForSelect = {
  profileArn: 'arn:aws:codewhisperer:eu-central-1:333:profile/P3',
  profileName: 'ProfileThree',
  accountName: 'AcctThree',
  region: 'eu-central-1'
}

function renderDialog(overrides?: {
  profiles?: KiroProfileForSelect[]
  alreadyImportedArns?: Set<string>
  onConfirm?: (selected: KiroProfileForSelect[]) => void
  onCancel?: () => void
  open?: boolean
}) {
  const onConfirm = overrides?.onConfirm ?? vi.fn()
  const onCancel = overrides?.onCancel ?? vi.fn()
  const utils = render(
    <ProfileSelectDialog
      open={overrides?.open ?? true}
      profiles={overrides?.profiles ?? [P1, P2, P3]}
      alreadyImportedArns={overrides?.alreadyImportedArns ?? new Set()}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
  return { ...utils, onConfirm, onCancel }
}

describe('ProfileSelectDialog', () => {
  it('B3: 应渲染传入的所有 profile 名称与 arn', () => {
    renderDialog()
    expect(screen.getByText('ProfileOne')).toBeInTheDocument()
    expect(screen.getByText('ProfileTwo')).toBeInTheDocument()
    expect(screen.getByText('ProfileThree')).toBeInTheDocument()
    // 各 profile 有一个 checkbox
    expect(screen.getByTestId(`profile-checkbox-${P1.profileArn}`)).toBeInTheDocument()
    expect(screen.getByTestId(`profile-checkbox-${P2.profileArn}`)).toBeInTheDocument()
    expect(screen.getByTestId(`profile-checkbox-${P3.profileArn}`)).toBeInTheDocument()
  })

  it('B4: 已导入的 profileArn 应 disabled 且默认不勾选', () => {
    renderDialog({ alreadyImportedArns: new Set([P1.profileArn]) })
    const cb1 = screen.getByTestId(`profile-checkbox-${P1.profileArn}`) as HTMLInputElement
    const cb2 = screen.getByTestId(`profile-checkbox-${P2.profileArn}`) as HTMLInputElement
    expect(cb1.disabled).toBe(true)
    expect(cb1.checked).toBe(false)
    expect(cb2.disabled).toBe(false)
    expect(cb2.checked).toBe(false)
  })

  it('B5: 点取消 → 触发 onCancel,不触发 onConfirm', async () => {
    const user = userEvent.setup()
    const { onCancel, onConfirm } = renderDialog()
    // 页面上有 2 处 cancel(header 关闭 X + footer 取消按钮),两处都要保底走 onCancel
    const cancelBtn = screen.getAllByRole('button', { name: /取消|Cancel/i })[0]
    await user.click(cancelBtn)
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('B6: 勾选 M 个 → 点确认时 onConfirm 收到正确的 M 个 profile', async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderDialog()
    await user.click(screen.getByTestId(`profile-checkbox-${P1.profileArn}`))
    await user.click(screen.getByTestId(`profile-checkbox-${P3.profileArn}`))
    const confirmBtn = screen.getByTestId('profile-select-confirm')
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false)
    await user.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const args = onConfirm.mock.calls[0][0] as KiroProfileForSelect[]
    const arns = args.map(p => p.profileArn).sort()
    expect(arns).toEqual([P1.profileArn, P3.profileArn].sort())
  })

  it('B6 (guard): 未勾选任何 profile → 确认按钮 disabled', () => {
    renderDialog()
    const confirmBtn = screen.getByTestId('profile-select-confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  it('B7: 全选按钮 → 只勾未导入的;再次点击 → 全部取消', async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderDialog({ alreadyImportedArns: new Set([P2.profileArn]) })
    const toggleAll = screen.getByTestId('profile-select-toggle-all')

    // 全选(P2 已导入应跳过,只勾 P1 + P3)
    await user.click(toggleAll)
    const cb1 = screen.getByTestId(`profile-checkbox-${P1.profileArn}`) as HTMLInputElement
    const cb2 = screen.getByTestId(`profile-checkbox-${P2.profileArn}`) as HTMLInputElement
    const cb3 = screen.getByTestId(`profile-checkbox-${P3.profileArn}`) as HTMLInputElement
    expect(cb1.checked).toBe(true)
    expect(cb2.checked).toBe(false)  // 已导入,永不勾
    expect(cb3.checked).toBe(true)

    // 点确认应携带 P1 + P3
    await user.click(screen.getByTestId('profile-select-confirm'))
    const args = onConfirm.mock.calls[0][0] as KiroProfileForSelect[]
    const arns = args.map(p => p.profileArn).sort()
    expect(arns).toEqual([P1.profileArn, P3.profileArn].sort())
  })

  it('B7: 再次点全选 → 全部取消', async () => {
    const user = userEvent.setup()
    renderDialog()
    const toggleAll = screen.getByTestId('profile-select-toggle-all')
    await user.click(toggleAll)  // all-on
    await user.click(toggleAll)  // all-off
    const cb1 = screen.getByTestId(`profile-checkbox-${P1.profileArn}`) as HTMLInputElement
    const cb3 = screen.getByTestId(`profile-checkbox-${P3.profileArn}`) as HTMLInputElement
    expect(cb1.checked).toBe(false)
    expect(cb3.checked).toBe(false)
  })

  it('边界: open=false 时不渲染 dialog', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId(`profile-checkbox-${P1.profileArn}`)).not.toBeInTheDocument()
  })

  it('边界: 全部 profile 已导入 → 确认按钮 disabled + 全选按钮 disabled', () => {
    renderDialog({ alreadyImportedArns: new Set([P1.profileArn, P2.profileArn, P3.profileArn]) })
    const confirm = screen.getByTestId('profile-select-confirm') as HTMLButtonElement
    const toggleAll = screen.getByTestId('profile-select-toggle-all') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(toggleAll.disabled).toBe(true)
  })
})
