$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $PSVersionTable.PSEdition -ne 'Desktop') { throw 'This runtime preparation currently targets Windows.' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$taskCache = Join-Path $taskRoot 'tmp\runtime-cache'
$taskResources = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\resources\typst'))
New-Item -ItemType Directory -Force -Path $taskCache,$taskResources | Out-Null
$taskZip = Join-Path $taskCache 'typst-0.15.1-windows-x64.zip'
$taskExpected = '19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736'
if (-not (Test-Path -LiteralPath $taskZip)) {
    $taskExisting = Join-Path $taskRoot 'tmp\typst-windows.zip'
    if (Test-Path -LiteralPath $taskExisting) { Copy-Item -LiteralPath $taskExisting -Destination $taskZip }
    else { Invoke-WebRequest -Uri 'https://github.com/typst/typst/releases/download/v0.15.1/typst-x86_64-pc-windows-msvc.zip' -OutFile $taskZip }
}
if ((Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw 'Typst checksum mismatch; build stopped.' }
$taskExtract = Join-Path $taskCache 'typst-0.15.1'
Expand-Archive -LiteralPath $taskZip -DestinationPath $taskExtract -Force
$taskSource = Join-Path $taskExtract 'typst-x86_64-pc-windows-msvc'
foreach ($taskName in @('typst.exe','LICENSE','NOTICE')) { Copy-Item -LiteralPath (Join-Path $taskSource $taskName) -Destination (Join-Path $taskResources $taskName) -Force }
Write-Output 'Verified Typst 0.15.1 runtime prepared.'
& (Join-Path $PSScriptRoot 'prepare-workflow-runtime.ps1')
