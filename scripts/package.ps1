$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskManifest = Get-Content -Raw -Encoding UTF8 (Join-Path $taskRoot 'extension\manifest.json') | ConvertFrom-Json
$taskVersion = $taskManifest.version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid extension version' }
$taskDist = Join-Path $taskRoot 'dist'
$taskStage = Join-Path $taskDist ('stage-' + [guid]::NewGuid().ToString('N'))
$taskPackage = Join-Path $taskStage 'ChromeParallelDownload'
New-Item -ItemType Directory -Path "$taskPackage\extension","$taskPackage\native" -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $taskRoot 'extension') -File | Where-Object { $_.Extension -in '.js','.mjs','.html','.css','.json','.png','.svg','.ico' } | Copy-Item -Destination "$taskPackage\extension"
foreach($taskFile in @('host.py','folder_picker.py','build_local64.py','local64-source.patch')) { Copy-Item -LiteralPath (Join-Path $taskRoot "native\$taskFile") -Destination "$taskPackage\native" }
foreach($taskFile in @('install.cmd','install.ps1','uninstall.ps1','THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskPackage }
Copy-Item -LiteralPath (Join-Path $taskRoot 'licenses') -Destination "$taskPackage\licenses" -Recurse
Copy-Item -LiteralPath (Join-Path $taskRoot 'docs\USAGE.md') -Destination (Join-Path $taskPackage 'README.md')
Copy-Item -LiteralPath (Join-Path $taskRoot 'LICENSE') -Destination $taskPackage
$taskZip = Join-Path $taskDist "ChromeParallelDownload-$taskVersion.zip"
Compress-Archive -LiteralPath $taskPackage -DestinationPath $taskZip -Force
# Keep the staging folder as a directly loadable, versioned build snapshot.
Write-Output "Package: $taskZip"
Write-Output "Install from: $taskPackage"
Write-Output "Loadable extension: $taskPackage\extension"
