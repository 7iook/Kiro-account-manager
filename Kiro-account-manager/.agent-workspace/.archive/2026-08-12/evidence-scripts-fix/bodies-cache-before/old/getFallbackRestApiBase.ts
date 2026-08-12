function getFallbackRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS_V1_FALLBACK['us-east-1']
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS_V1_FALLBACK['eu-central-1']
  return KIRO_REST_API_ENDPOINTS_V1_FALLBACK['us-east-1']
}
