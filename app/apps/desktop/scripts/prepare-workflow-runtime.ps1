[CmdletBinding()]
param([string]$NodeExecutable=(Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$taskRuntime=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\resources\workflow-runtime'))
$taskVersion=(& $NodeExecutable --version).Trim()
if([version]$taskVersion.TrimStart('v') -lt [version]'24.16.0'){throw 'Node >=24.16.0 is required for packaged PDF export.'}
New-Item -ItemType Directory -Force -Path $taskRuntime,(Join-Path $taskRuntime 'tools'),(Join-Path $taskRuntime 'app\packages'),(Join-Path $taskRuntime 'app\node_modules\@napi-rs') | Out-Null
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $taskRuntime 'node.exe') -Force
# Freeze only source and runtime dependencies; never copy databases, env files or outputs.
foreach($taskScript in @('workflow-desktop-export.mjs','workflow-pdf-engine.mjs','workflow-pdf-worker.mjs')){Copy-Item -LiteralPath (Join-Path $taskRoot "tools\$taskScript") -Destination (Join-Path $taskRuntime 'tools') -Force}
Copy-Item -LiteralPath (Join-Path $taskRoot 'app\package.json') -Destination (Join-Path $taskRuntime 'app') -Force
foreach($taskPackage in @('agent','core','paper','knowledge','pdf')){
 $taskDestination=Join-Path $taskRuntime "app\packages\$taskPackage";New-Item -ItemType Directory -Force -Path $taskDestination | Out-Null
 Copy-Item -LiteralPath (Join-Path $taskRoot "app\packages\$taskPackage\src") -Destination $taskDestination -Recurse -Force
}
foreach($taskPackage in @('xstate','pdfjs-dist','@napi-rs\canvas','@napi-rs\canvas-win32-x64-msvc')){
 $taskSource=Join-Path $taskRoot "app\node_modules\$taskPackage";if(-not(Test-Path -LiteralPath $taskSource)){throw "Missing PDF runtime dependency: $taskPackage"}
 $taskParent=Split-Path -Parent (Join-Path $taskRuntime "app\node_modules\$taskPackage")
 Copy-Item -LiteralPath $taskSource -Destination $taskParent -Recurse -Force
}
$taskLicense=Join-Path $taskRoot "tmp\runtime-cache\node-$taskVersion-LICENSE.txt"
if(-not(Test-Path -LiteralPath $taskLicense)){Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$taskVersion/LICENSE" -OutFile $taskLicense}
Copy-Item -LiteralPath $taskLicense -Destination (Join-Path $taskRuntime 'NODE-LICENSE.txt') -Force
@{nodeVersion=$taskVersion;nodeSha256=(Get-FileHash -LiteralPath $NodeExecutable -Algorithm SHA256).Hash;preparedAt=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRuntime 'runtime-manifest.json') -Encoding utf8
Write-Output "Prepared local PDF runtime: $taskVersion"
