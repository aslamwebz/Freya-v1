# Create Freya.lnk — the launcher with no console behind it.
#
# Why this exists rather than a shortcut made by hand: a shortcut straight at
# electron.exe has no console, because electron.exe is a GUI binary and Windows
# gives it a window and nothing else. Freya.cmd cannot promise that — it *is* a
# batch file, so cmd.exe exists before anything in it runs. This is the same
# launch without the flash.
#
# Run once, after `npm install` and `npm run build`:
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
#
# The shortcut points at this working copy, so moving or deleting the checkout
# breaks it. That is the deliberate trade: nothing is installed and nothing is
# copied, so there is nothing to keep in sync but the directory itself.

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
$link.TargetPath = $electron
# electron.exe takes the app directory as its first argument, quoted because the
# path contains spaces.
$link.Arguments = '"' + $root + '"'
$link.WorkingDirectory = $root
# The Electron icon, because Freya has no .ico of its own yet. Replaced by
# `build/icon.ico` the moment there is one.
$link.IconLocation = "$electron,0"
$link.Description = 'Freya'
$link.Save()

Write-Host "Created $shortcut"
Write-Host 'It points at this working copy — moving the checkout will break it.'
