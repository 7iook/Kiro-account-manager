$ErrorActionPreference = 'Stop'
Set-Location 'F:\Kiro-account-manager\Kiro-account-manager'

function Show([string]$label, $obj) {
  $root = $obj.packages['']
  $hasConfDep = $root.dependencies.ContainsKey('conf')
  $confVer = if ($hasConfDep) { $root.dependencies['conf'] } else { '<absent>' }
  $hasConfPkg = $obj.packages.ContainsKey('node_modules/conf')
  $confPkgVer = if ($hasConfPkg) { $obj.packages['node_modules/conf'].version } else { '<absent>' }
  $confDev = if ($hasConfPkg) { [bool]$obj.packages['node_modules/conf'].dev } else { $false }
  Write-Output "$label rootDeps.conf=$confVer  nm/conf=$confPkgVer  nm/conf.dev=$confDev"
}

$headRaw = (git show 'HEAD:Kiro-account-manager/package-lock.json') -join "`n"
$headJson = $headRaw | ConvertFrom-Json -AsHashtable
Show 'HEAD  ' $headJson

$wtJson = (Get-Content 'package-lock.json' -Raw) | ConvertFrom-Json -AsHashtable
Show 'WTREE ' $wtJson

# also check electron-store's nested conf
foreach ($k in $wtJson.packages.Keys) {
  if ($k -like '*conf*') { Write-Output "WT key: $k  ver=$($wtJson.packages[$k].version) dev=$($wtJson.packages[$k].dev)" }
}
