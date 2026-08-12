$ErrorActionPreference = 'Continue'
$tree = 'F:\_scratch\2026-08-12\toolkit-deps-move\prodtree'
$nm = Join-Path $tree 'node_modules'

'=== electron absence ==='
foreach ($p in 'electron', '@electron-toolkit/utils', '@electron-toolkit/preload', 'electron-builder', 'app-builder-lib') {
  $exists = Test-Path (Join-Path $nm $p)
  '{0,-32} present={1}' -f $p, $exists
}
''
'=== electron-* that legitimately remain (prod deps) ==='
Get-ChildItem $nm -Filter 'electron*' -Directory -ErrorAction SilentlyContinue | ForEach-Object { '  ' + $_.Name }
''
'=== any electron binary anywhere in tree ==='
$bins = Get-ChildItem $nm -Recurse -Filter 'electron.exe' -ErrorAction SilentlyContinue
'electron.exe count: ' + @($bins).Count
$dist = Get-ChildItem $nm -Recurse -Directory -Filter 'dist' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'electron[\\/]dist' }
'electron/dist dirs: ' + @($dist).Count
''
'=== tree size ==='
$sz = (Get-ChildItem $nm -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
'node_modules size MB: ' + [math]::Round($sz / 1MB, 1)
