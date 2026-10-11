# The development shortcut opens the visible three-process debug console.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$mainBundle = Join-Path $root 'dist-electron\main.cjs'
$shortcut = Join-Path $root 'Freya.lnk'

if (-not (Test-Path $electron)) {
  throw "Freya's dependencies are not installed. Run 'npm install' in $root first."
}
if (-not (Test-Path $mainBundle)) {
  throw "Freya has not been built. Run 'npm run build' in $root first."
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $env:ComSpec
# electron.exe takes the app directory as its first argument, quoted because the
# path contains spaces.
$link.Arguments = '/c ""' + (Join-Path $root 'FreyaDebug.cmd') + '""'
$link.WorkingDirectory = $root
# The Electron icon, because Freya has no .ico of its own yet. Replaced by
# `build/icon.ico` the moment there is one.
$link.IconLocation = "$electron,0"
$link.Description = 'Freya'
$link.Save()

Write-Host "Created $shortcut"
Write-Host 'It points at this working copy — moving the checkout will break it.'
