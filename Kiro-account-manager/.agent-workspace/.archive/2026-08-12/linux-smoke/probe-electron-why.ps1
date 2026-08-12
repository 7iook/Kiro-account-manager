$ErrorActionPreference = 'Stop'
$base = 'F:\Kiro-account-manager\Kiro-account-manager\.agent-workspace\.archive\2026-08-12\linux-smoke\ctx\app'
$j = (Get-Content "$base\package-lock.head.json" -Raw) | ConvertFrom-Json -AsHashtable

Write-Output "=== 谁把 electron 拉成非 dev(peer/prod 依赖链) ==="
foreach ($k in $j.packages.Keys) {
  $p = $j.packages[$k]
  $isDev = $p.ContainsKey('dev') -and $p['dev']
  foreach ($field in @('dependencies','peerDependencies','optionalDependencies')) {
    if ($p.ContainsKey($field) -and $p[$field] -and $p[$field].ContainsKey('electron')) {
      Write-Output ("  {0,-46} [{1,-20}] electron={2}  dev={3}" -f $k, $field, $p[$field]['electron'], $isDev)
    }
  }
}

Write-Output ""
Write-Output "=== electron 包条目全字段 ==="
$e = $j.packages['node_modules/electron']
foreach ($kk in $e.Keys) { Write-Output ("  {0} = {1}" -f $kk, ($e[$kk] | ConvertTo-Json -Compress -Depth 3)) }

Write-Output ""
Write-Output "=== root prod deps 里带 electron peer 的 ==="
foreach ($d in $j.packages[''].dependencies.Keys) {
  $key = "node_modules/$d"
  if ($j.packages.ContainsKey($key)) {
    $p = $j.packages[$key]
    if ($p.ContainsKey('peerDependencies') -and $p['peerDependencies'] -and $p['peerDependencies'].ContainsKey('electron')) {
      Write-Output ("  PROD DEP {0} peer electron={1}" -f $d, $p['peerDependencies']['electron'])
    }
  }
}
