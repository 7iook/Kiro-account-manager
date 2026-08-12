$ErrorActionPreference='Continue'
Set-Location 'F:\Kiro-account-manager\Kiro-account-manager\.agent-workspace\hold-probe'
$cfg = Join-Path $PWD 'cfg-probe'
New-Item -ItemType Directory -Force -Path $cfg | Out-Null
Copy-Item 'probe-settings.json' (Join-Path $cfg 'settings.json') -Force

$env:CLAUDE_CONFIG_DIR = $cfg
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788'
$env:ANTHROPIC_API_KEY  = 'probe-dummy-key'
$env:ANTHROPIC_AUTH_TOKEN = 'probe-dummy-key'
$env:API_TIMEOUT_MS = '3600000'
$env:CLAUDE_CODE_MAX_RETRIES = '0'
$env:NO_PROXY = '127.0.0.1,localhost'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:DISABLE_TELEMETRY = '1'
$env:DISABLE_AUTOUPDATER = '1'

$sw = [Diagnostics.Stopwatch]::StartNew()
Write-Output "CLIENT_START $(Get-Date -Format o)"
& claude -p 'hi' --settings (Join-Path $PWD 'probe-settings.json') 2>&1 |
  ForEach-Object { Write-Output ("[{0}s] {1}" -f $sw.Elapsed.TotalSeconds.ToString('0.0'), $_) }
Write-Output ("CLIENT_EXIT code={0} after {1}s" -f $LASTEXITCODE, $sw.Elapsed.TotalSeconds.ToString('0.0'))
