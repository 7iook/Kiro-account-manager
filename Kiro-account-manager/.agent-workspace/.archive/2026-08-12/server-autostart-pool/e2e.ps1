$ErrorActionPreference = 'Stop'
$root = 'F:\Kiro-account-manager\Kiro-account-manager'
$base = Join-Path $env:TEMP ("k5-e2e-" + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $base -Force | Out-Null
# CACHEDIR.TAG 让受管清理入口接受这棵临时树
[System.IO.File]::WriteAllText((Join-Path $base 'CACHEDIR.TAG'),
  "Signature: 8a477f597d28d172789f06886806bc55`n", [System.Text.UTF8Encoding]::new($false))

$dataDir = Join-Path $base 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

# 用项目自己的 conf + 同一加密密钥写一份真实数据文件(不碰机主 %APPDATA% 里那份活凭据)
$seedFile = Join-Path $root 'tmp-e2e-seed.mjs'

function Run-Server([string]$mode, [string]$dir) {
  Write-Output "===== mode=$mode ====="
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  & node $seedFile $dir $mode
  $out = Join-Path $base "$mode.out.log"
  $env:KIRO_DATA_DIR = $dir
  $env:KIRO_PANEL_PORT = '0'
  $env:KIRO_ADMIN_KEY = 'e2e-admin-key-0000000000000000000001'
  $env:KIRO_ALLOW_UNPROTECTED_KEY_FILE = '1'
  $p = Start-Process -FilePath 'node' -ArgumentList (Join-Path $root 'out\server\index.js') `
        -RedirectStandardOutput $out -RedirectStandardError "$out.err" `
        -NoNewWindow -PassThru
  Start-Sleep -Seconds 6
  Write-Output "--- stdout ---"; if (Test-Path $out) { Get-Content $out }
  Write-Output "--- stderr ---"; if (Test-Path "$out.err") { Get-Content "$out.err" }
  if (-not $p.HasExited) { taskkill /PID $p.Id /F | Out-Null; Write-Output "killed PID=$($p.Id)" }
  else { Write-Output "already exited code=$($p.ExitCode)" }
}

Run-Server 'admissible'   (Join-Path $base 'd1')
Run-Server 'empty'        (Join-Path $base 'd2')
Run-Server 'inadmissible' (Join-Path $base 'd3')
Write-Output "SCRATCH=$base"
