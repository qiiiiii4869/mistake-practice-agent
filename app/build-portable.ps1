# Run with PowerShell 7 (pwsh). Outputs contain binaries only, never local account data.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$NodeDirectory,
    [string]$Toolchain = 'stable-x86_64-pc-windows-gnu',
    [ValidateSet('debug','release')][string]$Profile = 'debug'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$taskMingwBin = Join-Path $env:USERPROFILE 'mingw64\bin'
$taskOriginalPath = $env:PATH
$taskOriginalApi = $env:MISTAKE_ACCOUNT_API_URL
$taskDestination = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Path -LiteralPath $taskDestination) -or (Test-Path -LiteralPath ($taskDestination + '.zip'))) {
    throw 'Choose a new output directory; existing packages are never overwritten.'
}
try {
    $env:PATH = "$taskCargoBin;$taskMingwBin;$taskOriginalPath"
    if ($NodeDirectory) { $env:PATH = ([IO.Path]::GetFullPath($NodeDirectory)) + ';' + $env:PATH }
    $taskNodeVersion = [version]((& node --version).TrimStart('v'))
    if ($LASTEXITCODE -ne 0 -or $taskNodeVersion -lt [version]'24.16.0') { throw 'Node.js >=24.16.0 is required. Use -NodeDirectory to select it.' }
    Push-Location $PSScriptRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        # Invoke in this PowerShell session; avoid legacy powershell.exe module discovery.
        & (Join-Path $PSScriptRoot 'apps\desktop\scripts\prepare-runtime.ps1')
        $env:MISTAKE_ACCOUNT_API_URL = 'https://codeqiqi.com/mistake-agent/'
        $taskCargoArgs = @("+$Toolchain", 'build', '--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--features', 'custom-protocol', '--bin', 'mistake-agent-desktop')
        if ($Profile -eq 'release') { $taskCargoArgs += '--release' }
        & cargo @taskCargoArgs
        if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    } finally { Pop-Location }
    $taskBuild = Join-Path $PSScriptRoot "apps\desktop\src-tauri\target\$Profile"
    $taskResources = Join-Path $taskBuild 'resources\typst'
    foreach ($taskRequired in @('mistake-agent-desktop.exe','WebView2Loader.dll','resources\typst\typst.exe','resources\typst\LICENSE','resources\typst\NOTICE')) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskBuild $taskRequired) -PathType Leaf)) { throw "Missing runtime file: $taskRequired" }
    }
    New-Item -ItemType Directory -Path $taskDestination | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskBuild 'mistake-agent-desktop.exe'),(Join-Path $taskBuild 'WebView2Loader.dll') -Destination $taskDestination
    New-Item -ItemType Directory -Path (Join-Path $taskDestination 'resources\typst') -Force | Out-Null
    foreach ($taskName in @('typst.exe','LICENSE','NOTICE')) { Copy-Item -LiteralPath (Join-Path $taskResources $taskName) -Destination (Join-Path $taskDestination 'resources\typst') }
    Copy-Item -LiteralPath (Join-Path $taskRoot 'THIRD_PARTY_NOTICES.md') -Destination $taskDestination
    @"
错题智能推送 · Windows x64 便携版
构建日期：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
构建配置：$Profile / $Toolchain

先解压整个压缩包，再双击 mistake-agent-desktop.exe。
请保留同目录 WebView2Loader.dll 和 resources 文件夹。
需要 Windows 10/11 x64、Microsoft Edge WebView2 Runtime 和系统中文字体。
账号连接正式服务 https://codeqiqi.com/mistake-agent/，使用原账号登录。
本包包含柔和蓝紫界面、独立 PDF 试卷入口及云端工作流开发测试面板。
整场正式生成、PDF 桌面交付和最终计次仍未完整接入，请以界面说明为准。
本包不含账号数据库、学生资料、登录令牌或模型密钥。
本机原账号资料继续保存在原来的 Windows 用户数据目录。
此包是便携版本，不包含安装向导；debug 为测试构建。
"@ | Set-Content -LiteralPath (Join-Path $taskDestination '使用说明.txt') -Encoding utf8
    $taskHashes = Get-ChildItem -LiteralPath $taskDestination -File -Recurse | ForEach-Object {
        $taskRelative = $_.FullName.Substring($taskDestination.Length + 1)
        '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $taskRelative
    }
    $taskHashes | Set-Content -LiteralPath (Join-Path $taskDestination 'SHA256SUMS.txt') -Encoding utf8
    Compress-Archive -LiteralPath $taskDestination -DestinationPath ($taskDestination + '.zip')
    Get-Item -LiteralPath ($taskDestination + '.zip') | Select-Object FullName, Length
} finally {
    $env:PATH = $taskOriginalPath
    $env:MISTAKE_ACCOUNT_API_URL = $taskOriginalApi
}
