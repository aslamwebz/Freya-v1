@echo off
setlocal
rem Visible feature-worktree debug launcher. Uses the existing Electron launcher,
rem a separate test profile, and port 9235 so the original app can remain open.
cd /d "%~dp0."
if not exist "dist-electron\main.cjs" (
  echo Build this feature copy first with npm run build.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo Build this feature copy first with npm run build.
  pause
  exit /b 1
)
node scripts\dev-kilo.mjs --port=9235 --profile=.kilo\chat-evolution-profile --no-build
if errorlevel 1 pause
