/**
 * AWS Region SSOT(渲染进程侧 UI 用途)
 *
 * 数据来源:AddAccountDialog 原有 21-region 分组列表(2026-05 引入)。
 * 与主进程 `src/main/proxy/kiroApi.ts` 的 `KNOWN_SSO_OIDC_REGIONS` 保持内容同步 ——
 * 一处代表 UI 展示,一处代表 SSO OIDC 探测范围,新增 AWS region 时两处一起改。
 *
 * ⚠️ 请使用 {@link AWS_REGION_GROUPS} 或 {@link ALL_AWS_REGION_CODES} 引用,
 * 严禁在 dialog / 组件里内联 3-region / 21-region 硬编码(§4.3 SSOT 破坏)。
 *
 * 变体防复发:tests/architecture/edit_dialog_uses_awsRegions_ssot.ts 会 grep
 * 'us-east-1.*us-west-2' 强制引用本文件。
 */

export interface AwsRegionOption {
  /** region code · e.g. 'us-east-1' */
  value: string
  /** 短城市/描述,用于 label 显示 · e.g. 'N. Virginia' */
  city: string
}

export interface AwsRegionGroup {
  /** 分组标签 · 'US' / 'Europe' / 'Asia Pacific' / 'Other' */
  label: string
  /** i18n 中文分组标签(可选) */
  labelZh?: string
  regions: AwsRegionOption[]
}

export const AWS_REGION_GROUPS: AwsRegionGroup[] = [
  {
    label: 'US',
    labelZh: '美国',
    regions: [
      { value: 'us-east-1', city: 'N. Virginia' },
      { value: 'us-east-2', city: 'Ohio' },
      { value: 'us-west-1', city: 'N. California' },
      { value: 'us-west-2', city: 'Oregon' }
    ]
  },
  {
    label: 'Europe',
    labelZh: '欧洲',
    regions: [
      { value: 'eu-west-1', city: 'Ireland' },
      { value: 'eu-west-2', city: 'London' },
      { value: 'eu-west-3', city: 'Paris' },
      { value: 'eu-central-1', city: 'Frankfurt' },
      { value: 'eu-north-1', city: 'Stockholm' },
      { value: 'eu-south-1', city: 'Milan' }
    ]
  },
  {
    label: 'Asia Pacific',
    labelZh: '亚太',
    regions: [
      { value: 'ap-northeast-1', city: 'Tokyo' },
      { value: 'ap-northeast-2', city: 'Seoul' },
      { value: 'ap-northeast-3', city: 'Osaka' },
      { value: 'ap-southeast-1', city: 'Singapore' },
      { value: 'ap-southeast-2', city: 'Sydney' },
      { value: 'ap-south-1', city: 'Mumbai' },
      { value: 'ap-east-1', city: 'Hong Kong' }
    ]
  },
  {
    label: 'Other',
    labelZh: '其他',
    regions: [
      { value: 'ca-central-1', city: 'Canada' },
      { value: 'sa-east-1', city: 'São Paulo' },
      { value: 'me-south-1', city: 'Bahrain' },
      { value: 'af-south-1', city: 'Cape Town' }
    ]
  }
]

/** 21 个 region code 的扁平数组 · 供 `.includes(region)` 类判断使用 */
export const ALL_AWS_REGION_CODES: readonly string[] = AWS_REGION_GROUPS.flatMap(g =>
  g.regions.map(r => r.value)
)

/** 判断 region 是否在已知集合中(false = 自定义输入的值) */
export function isKnownAwsRegion(region: string | undefined | null): boolean {
  return !!region && ALL_AWS_REGION_CODES.includes(region)
}
