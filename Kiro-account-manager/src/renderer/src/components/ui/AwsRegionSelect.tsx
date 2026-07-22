import { AWS_REGION_GROUPS, isKnownAwsRegion } from '@/lib/awsRegions'
import { useTranslation } from '@/hooks/useTranslation'

interface AwsRegionSelectProps {
  value: string
  onChange: (value: string) => void
  /** select 元素额外 className(容器 flex-1 由外层控制) */
  className?: string
  /** 自定义 region 输入框 className(容器 flex-1 由外层控制) */
  customInputClassName?: string
  /** 自定义输入框宽度(默认 w-28)· 用 tailwind 类 */
  customInputWidth?: string
  /** select id · 无障碍关联 label 用途 */
  id?: string
  /** 隐藏"自定义输入"选项 · 默认 false */
  hideCustom?: boolean
}

/**
 * AWS Region 选择器 · SSOT 组件
 *
 * 展示 21 个 AWS 商用 region + 自定义输入,数据来源 `@/lib/awsRegions`。
 * 用在所有需要用户选 region 的 dialog(AddAccountDialog / EditAccountDialog),
 * 避免"数组 SSOT + optgroup 硬编码"的双重维护。
 *
 * 反变体机制:tests/architecture/edit_dialog_uses_awsRegions_ssot.ts 强制引用本组件。
 */
export function AwsRegionSelect({
  value,
  onChange,
  className = '',
  customInputClassName = '',
  customInputWidth = 'w-28',
  id,
  hideCustom = false
}: AwsRegionSelectProps) {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const isCustom = !isKnownAwsRegion(value)

  return (
    <div className="flex gap-2">
      <select
        id={id}
        value={isCustom ? 'custom' : value}
        onChange={(e) => {
          if (e.target.value !== 'custom') onChange(e.target.value)
        }}
        className={`flex-1 h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${className}`}
      >
        {AWS_REGION_GROUPS.map((g) => (
          <optgroup key={g.label} label={isEn ? g.label : (g.labelZh || g.label)}>
            {g.regions.map((r) => (
              <option key={r.value} value={r.value}>
                {r.value} ({r.city})
              </option>
            ))}
          </optgroup>
        ))}
        {!hideCustom && (
          <optgroup label={isEn ? 'Custom' : '自定义'}>
            <option value="custom">{isEn ? '-- Custom Input --' : '-- 自定义输入 --'}</option>
          </optgroup>
        )}
      </select>
      {!hideCustom && (
        <input
          type="text"
          value={isCustom ? value : ''}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder={isEn ? 'e.g., cn-north-1' : '例如: cn-north-1'}
          className={`${customInputWidth} h-10 px-2 text-sm rounded-xl border border-input bg-background/50 ${customInputClassName}`}
        />
      )}
    </div>
  )
}
