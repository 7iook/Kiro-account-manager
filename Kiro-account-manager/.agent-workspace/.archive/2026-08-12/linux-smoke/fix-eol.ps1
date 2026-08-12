$ErrorActionPreference = 'Stop'
$root = 'F:\Kiro-account-manager\Kiro-account-manager'
$files = @(
  "$root\src\main\server\adminKeyStore.ts",
  "$root\test\main\server\adminKeyStore.test.ts"
)
foreach ($f in $files) {
  $t = [System.IO.File]::ReadAllText($f)
  # 先全部归一成 LF,再统一成 CRLF —— 与文件既有形态(HEAD 为 CRLF)一致,消除混合行尾
  $t = $t -replace "`r`n", "`n"
  $t = $t -replace "`n", "`r`n"
  [System.IO.File]::WriteAllText($f, $t, [System.Text.UTF8Encoding]::new($false))
  $b = [System.IO.File]::ReadAllBytes($f)
  $s = [System.Text.Encoding]::UTF8.GetString($b)
  Write-Output ("{0}: CRLF={1} LF-only={2} BOM={3}" -f (Split-Path $f -Leaf),
    ([regex]::Matches($s,"`r`n")).Count,
    ([regex]::Matches($s,"(?<!`r)`n")).Count,
    ($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191))
}
