$ErrorActionPreference = 'Stop'
$root = 'F:\Kiro-account-manager\Kiro-account-manager'
Set-Location $root

# 1) 我追加的内容用的是 LF 还是 CRLF?文件原本是什么?
$bytes = [System.IO.File]::ReadAllBytes("$root\test\main\server\adminKeyStore.test.ts")
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$crlf = ([regex]::Matches($text, "`r`n")).Count
$lfOnly = ([regex]::Matches($text, "(?<!`r)`n")).Count
Write-Output "当前测试文件: CRLF=$crlf  LF-only=$lfOnly"

$b2 = [System.IO.File]::ReadAllBytes("$root\src\main\server\adminKeyStore.ts")
$t2 = [System.Text.Encoding]::UTF8.GetString($b2)
Write-Output ("当前源文件:   CRLF={0}  LF-only={1}" -f ([regex]::Matches($t2,"`r`n")).Count, ([regex]::Matches($t2,"(?<!`r)`n")).Count)

# 2) HEAD 版本的行尾(git show 会按 .gitattributes 输出)
$h = git show 'HEAD:Kiro-account-manager/test/main/server/adminKeyStore.test.ts' | Out-String
Write-Output ("HEAD 测试文件(经 git show): CRLF={0} LF-only={1}" -f ([regex]::Matches($h,"`r`n")).Count, ([regex]::Matches($h,"(?<!`r)`n")).Count)

# 3) .gitattributes / .prettierrc 怎么规定的
foreach ($f in @('.gitattributes','.prettierrc','.prettierrc.json','.prettierrc.yaml','.editorconfig')) {
  if (Test-Path $f) { Write-Output "--- $f ---"; Get-Content $f | Select-Object -First 15 }
}
