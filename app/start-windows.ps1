$ErrorActionPreference = 'Stop'
$desktopExe = Join-Path $PSScriptRoot 'apps\desktop\src-tauri\target\debug\mistake-agent-desktop.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
    throw 'Build the desktop app first: cd app; npm ci; npm run desktop:build:debug'
}
# Open the interactive app requested by the teacher.
Start-Process -FilePath $desktopExe
