$ErrorActionPreference = 'Stop'
Set-Location 'F:\Kiro-account-manager\Kiro-account-manager'
$base = 'F:\Kiro-account-manager\Kiro-account-manager\.agent-workspace\.archive\2026-08-12\linux-smoke\ctx\app'

foreach ($n in @('head','wt')) {
  $j = (Get-Content "$base\package-lock.$n.json" -Raw) | ConvertFrom-Json -AsHashtable
  Write-Output "===== lockfile: $n  lockfileVersion=$($j.lockfileVersion) ====="
  foreach ($k in @('node_modules/electron','node_modules/electron-builder','node_modules/electron-store','node_modules/conf','node_modules/electron-vite','node_modules/vitest')) {
    if ($j.packages.ContainsKey($k)) {
      $p = $j.packages[$k]
      $dev = if ($p.ContainsKey('dev')) { $p['dev'] } else { '<no dev key>' }
      Write-Output ("  {0,-38} ver={1,-12} dev={2}" -f $k, $p.version, $dev)
    } else { Write-Output "  $k  <ABSENT>" }
  }
  $root = $j.packages['']
  Write-Output "  root.dependencies count=$($root.dependencies.Count)  devDependencies count=$($root.devDependencies.Count)"
  Write-Output "  root.dependencies.conf=$(if($root.dependencies.ContainsKey('conf')){$root.dependencies['conf']}else{'<absent>'})"
}
