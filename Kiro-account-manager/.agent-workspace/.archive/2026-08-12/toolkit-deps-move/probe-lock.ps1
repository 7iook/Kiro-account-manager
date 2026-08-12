$ErrorActionPreference = 'Stop'
$lock = 'F:\Kiro-account-manager\Kiro-account-manager\package-lock.json'
$j = Get-Content $lock -Raw | ConvertFrom-Json -AsHashtable
$keys = @(
  'node_modules/electron',
  'node_modules/@electron-toolkit/utils',
  'node_modules/@electron-toolkit/preload',
  'node_modules/conf',
  'node_modules/undici',
  'node_modules/uuid',
  'node_modules/koffi',
  'node_modules/tlsclientwrapper',
  'node_modules/cbor-x',
  'node_modules/node-forge',
  'node_modules/socks'
)
foreach ($k in $keys) {
  $n = $j.packages[$k]
  if ($null -eq $n) { '{0,-45} MISSING' -f $k; continue }
  '{0,-45} dev={1} devOptional={2} optional={3}' -f $k, $n.dev, $n.devOptional, $n.optional
}
''
'--- root node dependency buckets ---'
$root = $j.packages['']
'deps contains toolkit/utils   : ' + $root.dependencies.ContainsKey('@electron-toolkit/utils')
'deps contains toolkit/preload : ' + $root.dependencies.ContainsKey('@electron-toolkit/preload')
'devDeps contains toolkit/utils   : ' + $root.devDependencies.ContainsKey('@electron-toolkit/utils')
'devDeps contains toolkit/preload : ' + $root.devDependencies.ContainsKey('@electron-toolkit/preload')
''
'--- count of packages by marker ---'
$all = $j.packages.Keys | Where-Object { $_ -ne '' }
'total      : ' + $all.Count
'dev=true   : ' + ($all | Where-Object { $j.packages[$_].dev -eq $true }).Count
'prod-only  : ' + ($all | Where-Object { -not $j.packages[$_].dev -and -not $j.packages[$_].devOptional }).Count
