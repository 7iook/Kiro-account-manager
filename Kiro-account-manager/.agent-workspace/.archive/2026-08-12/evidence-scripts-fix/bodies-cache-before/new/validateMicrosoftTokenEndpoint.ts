export function validateMicrosoftTokenEndpoint(rawEndpoint?: string): string {
  const tokenEndpoint = (rawEndpoint || '').trim()
  if (!tokenEndpoint) throw new Error('缺少 tokenEndpoint')
  let parsed: URL
  try {
    parsed = new URL(tokenEndpoint)
  } catch {
    throw new Error('tokenEndpoint 不是合法 URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('tokenEndpoint 必须使用 https')
  if (!MICROSOFT_TOKEN_ENDPOINT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('tokenEndpoint 必须是微软登录端点 (login.microsoftonline.com 等)')
  }
  return parsed.toString()
}
