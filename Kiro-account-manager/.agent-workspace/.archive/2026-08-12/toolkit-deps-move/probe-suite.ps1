$ErrorActionPreference = 'Stop'
$p = 'F:\Kiro-account-manager\Kiro-account-manager\.agent-workspace\.archive\2026-08-12\toolkit-deps-move\suite.json'
$j = Get-Content $p -Raw | ConvertFrom-Json
'numTotalTests   : ' + $j.numTotalTests
'numPassedTests  : ' + $j.numPassedTests
'numFailedTests  : ' + $j.numFailedTests
'numPendingTests : ' + $j.numPendingTests
'numTotalSuites  : ' + $j.numTotalTestSuites
'numFailedSuites : ' + $j.numFailedTestSuites
'success         : ' + $j.success
''
'--- failing files (if any) ---'
$fail = $j.testResults | Where-Object { $_.status -ne 'passed' }
if (-not $fail) { '  (none)' } else { $fail | ForEach-Object { '  ' + $_.name + ' :: ' + $_.status } }
''
'--- adminKeyStore file result ---'
$j.testResults | Where-Object { $_.name -match 'adminKeyStore' } | ForEach-Object {
  $t = $_.assertionResults.Count
  $f = ($_.assertionResults | Where-Object { $_.status -eq 'failed' }).Count
  '  {0} status={1} tests={2} failed={3}' -f (Split-Path $_.name -Leaf), $_.status, $t, $f
}
''
'--- new gate file result ---'
$j.testResults | Where-Object { $_.name -match 'prod_tree_has_no_electron' } | ForEach-Object {
  '  {0} status={1} tests={2}' -f (Split-Path $_.name -Leaf), $_.status, $_.assertionResults.Count
}
