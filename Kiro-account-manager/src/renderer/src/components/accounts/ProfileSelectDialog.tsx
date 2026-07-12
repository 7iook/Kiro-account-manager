/**
 * ProfileSelectDialog · 多 profile 导入选择框(决策卡 v2 §4 UX=C)
 *
 * 复用 AccountSelectDialog 的 overlay + Card 骨架,交互改为多选(checkbox list)。
 * §4.3 SSOT / §6.6:业务决策(哪些置灰 / 是否 disabled)靠 props 传入,不在此组件里判定。
 */
import { useEffect, useMemo, useState } from 'react'
import { X, Check } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import type { KiroProfileForSelect } from './profileImportHelpers'

interface ProfileSelectDialogProps {
  open: boolean
  profiles: KiroProfileForSelect[]
  alreadyImportedArns: Set<string>
  onConfirm: (selected: KiroProfileForSelect[]) => void
  onCancel: () => void
}

function displayLabel(p: KiroProfileForSelect): string {
  // 优先 profileName;缺则 accountName;都无则用 arn 尾段(/profile/xxx 或最后一段)
  if (p.profileName) return p.profileName
  if (p.accountName) return p.accountName
  const parts = p.profileArn.split('/')
  return parts[parts.length - 1] || p.profileArn
}

export function ProfileSelectDialog({
  open,
  profiles,
  alreadyImportedArns,
  onConfirm,
  onCancel
}: ProfileSelectDialogProps): React.ReactNode {
  const { t } = useTranslation()

  const availableArns = useMemo(
    () => profiles.filter(p => !alreadyImportedArns.has(p.profileArn)).map(p => p.profileArn),
    [profiles, alreadyImportedArns]
  )

  const [selectedArns, setSelectedArns] = useState<Set<string>>(new Set())

  // dialog 重新打开或 profiles 集合变化时重置选择(防止上次的勾选状态泄漏)
  useEffect(() => {
    if (open) setSelectedArns(new Set())
  }, [open, profiles])

  if (!open) return null

  const allAvailableSelected =
    availableArns.length > 0 && availableArns.every(arn => selectedArns.has(arn))

  const handleToggleAll = (): void => {
    if (allAvailableSelected) {
      setSelectedArns(new Set())
    } else {
      setSelectedArns(new Set(availableArns))
    }
  }

  const handleToggle = (arn: string): void => {
    setSelectedArns(prev => {
      const next = new Set(prev)
      if (next.has(arn)) next.delete(arn)
      else next.add(arn)
      return next
    })
  }

  const handleConfirm = (): void => {
    const selected = profiles.filter(p => selectedArns.has(p.profileArn))
    if (selected.length === 0) return
    onConfirm(selected)
  }

  const confirmDisabled = selectedArns.size === 0
  const toggleAllDisabled = availableArns.length === 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <Card className="relative w-[560px] max-h-[80vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-3 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{t('profileSelectDialog.title')}</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
              onClick={onCancel}
              aria-label={t('profileSelectDialog.cancel')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {t('profileSelectDialog.description')}
          </div>
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleToggleAll}
              disabled={toggleAllDisabled}
              data-testid="profile-select-toggle-all"
            >
              {t('profileSelectDialog.selectAll')} ({selectedArns.size}/{availableArns.length})
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-y-auto max-h-[50vh]">
          {profiles.map(profile => {
            const isImported = alreadyImportedArns.has(profile.profileArn)
            const isSelected = selectedArns.has(profile.profileArn)
            return (
              <label
                key={profile.profileArn}
                className={`flex items-center gap-3 p-4 border-b transition-colors ${
                  isImported
                    ? 'opacity-50 cursor-not-allowed'
                    : `cursor-pointer hover:bg-accent/50 ${isSelected ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`
                }`}
              >
                <input
                  type="checkbox"
                  checked={!isImported && isSelected}
                  disabled={isImported}
                  onChange={() => !isImported && handleToggle(profile.profileArn)}
                  data-testid={`profile-checkbox-${profile.profileArn}`}
                  className="h-4 w-4 rounded border-input"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{displayLabel(profile)}</div>
                  <div className="text-xs text-muted-foreground truncate font-mono">
                    {profile.profileArn}
                  </div>
                  {profile.region && (
                    <div className="text-xs text-muted-foreground">{profile.region}</div>
                  )}
                </div>
                {isImported ? (
                  <Badge className="text-xs bg-muted text-muted-foreground">
                    {t('profileSelectDialog.alreadyImported')}
                  </Badge>
                ) : isSelected ? (
                  <Check className="h-4 w-4 text-primary flex-shrink-0" />
                ) : null}
              </label>
            )
          })}
        </CardContent>
        <div className="flex items-center justify-end gap-2 p-4 border-t">
          <Button variant="outline" onClick={onCancel}>
            {t('profileSelectDialog.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="profile-select-confirm"
          >
            {t('profileSelectDialog.confirm')} ({selectedArns.size})
          </Button>
        </div>
      </Card>
    </div>
  )
}
