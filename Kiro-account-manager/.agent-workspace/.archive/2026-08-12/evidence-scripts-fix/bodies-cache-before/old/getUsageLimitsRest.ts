async function getUsageLimitsRest(
  accessToken: string,
  profileArn?: string,
  accountMachineId?: string,  // 账户绑定的设备 ID
  ssoRegion?: string,         // SSO 区域，用于选择正确的 REST API 端点
  email?: string,             // 用于日志标识
  authMethod?: string         // external_idp (Azure AD) 需传入以加 TokenType header
): Promise<UsageLimitsResponse> {
  // 优先使用账户绑定的设备 ID，其次使用 K-Proxy 全局设备 ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || 'default'}`)

  // 2026-07 迁移:V1 legacy Enterprise fallback ARN(610548660232:VNECVYCYYAWN)已废,
  // 后端拒 400 "Invalid profileArn";isPlaceholderProfileArn 识别后自动 fallback 到 V2 真实值。
  // 实测证据:eu 账户 + V2 fallback (316704942615:H3A4HCGR4WEC) + management.eu-central-1 返 200。
  if (profileArn && isPlaceholderProfileArn(profileArn)) {
    const fallbackArn = getEnterpriseFallbackArn(ssoRegion)
    console.log(`[Kiro REST API] Legacy V1 profileArn detected, using V2 fallback: ${fallbackArn}`)
    profileArn = fallbackArn
  } else if (!profileArn && ssoRegion?.startsWith('eu-') && authMethod !== 'api_key') {
    // EU management API 后端强制要求 profileArn(2026-07),不传直接 400 Invalid profileArn
    // 无存量时自动 fallback 到本 region V2 真实值(实测 316704942615:H3A4HCGR4WEC 在任一 EU Enterprise account 下都接受)
    //
    // ⚠️ 必须排除网页 API Key(ksk_)账户(RCA 2026-08-02 ksk-eu-fallback-arn):
    //   ksk 天生无 profileArn(STANDALONE 订阅 GetProfile 返 400 = 既定 feature gate),
    //   注入这个属于别人 AWS 账号(316704942615)的 ARN → ksk 无权使用 → 403 "Invalid token"。
    //   受控对照(同一 ksk + management.eu-central-1 + TokenType:API_KEY,只改 profileArn 一个变量):
    //     无 profileArn → 200 完整额度 / 带该 fallback ARN → 403。
    //   即「EU 强制要求 profileArn」这个前提对 api_key 不成立 —— ksk 不带 ARN 就是合法请求。
    //   与 kiroApi.resolveProfileArn 的 api_key 分支同一语义(SSOT:ksk 绝不回退占位/固定 ARN)。
    profileArn = getEnterpriseFallbackArn(ssoRegion)
    console.log(`[Kiro REST API] EU account missing profileArn, using V2 EU fallback: ${profileArn}`)
  }
  
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  if (profileArn) {
    params.set('profileArn', profileArn)
  }
  const path = `/getUsageLimits?${params.toString()}`

  // 跨 region 账户修复:host 必须按 profileArn 的真实数据面 region 选,而非 account.region(ssoRegion)。
  // 与 stream 路径(kiroApi.callKiroApiStream 的 dataPlaneRegion)保持一致的 SSOT。
  // Bug 现场:account.region=us-east-2 但 profile 在 eu-central-1 → 用 ssoRegion 选 us 主机 403 →
  //          回退 q.us-east-1 → 400 "Improperly formed request"(间歇性,每次用量刷新都触发)。
  // 此处覆盖所有走 getUsageAndLimits → getUsageLimitsRest 的调用方(check-status/批量/verify/订阅)。
  // ⚠️ 仅对"真实" profileArn 生效:社交固定 ARN(KIRO_SOCIAL_PROFILE_ARN)与 BuilderId 占位 ARN
  //    恒为 us-east-1,不代表账户真实 region,必须排除,否则 EU 社交/BuilderId 账户被误路由到 us 而 403。
  const isFixedOrPlaceholderArn =
    !!profileArn && (isPlaceholderProfileArn(profileArn) || profileArn === KIRO_SOCIAL_PROFILE_ARN)
  const arnRegion = isFixedOrPlaceholderArn ? undefined : parseRegionFromProfileArn(profileArn)
  const effectiveRegion = arnRegion || ssoRegion
  if (effectiveRegion !== ssoRegion && isKiroApiDebug()) {
    console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region override: ssoRegion=${ssoRegion} → dataPlaneRegion=${effectiveRegion} (from profileArn)`)
  }

  // 根据数据面 region 选择主端点
  const primaryBase = getRestApiBase(effectiveRegion)
  const fallbackBase = getFallbackRestApiBase(effectiveRegion)
  
  let response = await fetchRestApi(primaryBase, path, accessToken, machineId, authMethod)

  // 如果主端点返回 403，尝试备用端点
  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback → ${fallbackBase}`)
    response = await fetchRestApi(fallbackBase, path, accessToken, machineId, authMethod)
  }

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`, errorText)
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }
  
  const result = await response.json()
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] → ${response.status}`, result)
  return result
}
