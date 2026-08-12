$ErrorActionPreference = 'Continue'
$root = 'F:\Kiro-account-manager\Kiro-account-manager'
Set-Location $root

# 基线:把 HEAD 版两个文件取到临时目录内的**同路径结构**下 lint 不可行(eslint 依赖项目配置),
# 故改为:统计当前文件的 prettier CRLF 警告数,与「HEAD 版本 CRLF 数」对照 ——
# 若 HEAD 本就 568 个 CRLF 且 editorconfig 要 LF,则那族警告是既存的,非本轮引入。

Write-Output "=== 当前两文件的 eslint 计数(按规则分组) ==="
$out = npx eslint "src/main/server/adminKeyStore.ts" "test/main/server/adminKeyStore.test.ts" -f json 2>$null | Out-String
$j = $out | ConvertFrom-Json
foreach ($f in $j) {
  Write-Output ("--- {0}" -f (Split-Path $f.filePath -Leaf))
  Write-Output ("    errors={0} warnings={1}" -f $f.errorCount, $f.warningCount)
  $f.messages | Group-Object ruleId | Sort-Object Count -Descending | Select-Object -First 5 |
    ForEach-Object { Write-Output ("      {0} x{1}" -f $_.Name, $_.Count) }
  $f.messages | Where-Object { $_.severity -eq 2 } |
    ForEach-Object { Write-Output ("      ERROR line {0}: {1} [{2}]" -f $_.line, $_.message, $_.ruleId) }
}
