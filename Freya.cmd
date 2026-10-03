@echo off
rem Double-clickable launcher for Freya, and the slower way in.
rem
rem This is a batch file, so double-clicking it starts cmd.exe first: a console
rem window that takes the foreground, runs the line below, and closes. It works,
rem and it means every launch pulls focus off whatever was being typed in and
rem hands it back a second later. That cannot be fixed here — the console IS the
rem program, and it exists before anything in it runs.
rem
rem For a launch with no console at all, make a shortcut once:
rem
rem   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
rem
rem It points straight at electron.exe, which is a GUI binary, so Windows gives
rem it a window and nothing else.
rem
rem Nothing is installed and nothing is copied. electron.exe is handed this
rem directory, and the entry point it looks for — dist-electron\main.cjs — is
rem named in package.json. So the working copy is the application, and the only
rem prerequisite is having built it once.
setlocal

set "FREYA_ROOT=%~dp0"
set "FREYA_ELECTRON=%FREYA_ROOT%node_modules\electron\dist\electron.exe"

if not exist "%FREYA_ELECTRON%" (
  echo Freya's dependencies are not installed yet.
  echo.
  echo   cd "%FREYA_ROOT%"
  echo   npm install
  echo.
  rem Held open on purpose: a launcher that closes instantly on failure is
  rem indistinguishable from one that did nothing.
  pause
  exit /b 1
)

if not exist "%FREYA_ROOT%dist-electron\main.cjs" (
  echo Freya has not been built yet.
  echo.
  echo   cd "%FREYA_ROOT%"
  echo   npm run build
  echo.
  pause
  exit /b 1
)

rem `start ""` with an explicit empty title: without it, the first quoted string
rem becomes the window title and the launch is unreliable.
rem
rem The `.` is load-bearing. %~dp0 ends in a backslash, so "%~dp0" would hand
rem Windows a path whose final character escapes the closing quote, and the app
rem directory arrives malformed. "%~dp0." is the same directory, spelled so that
rem nothing trails into the quote.
start "" "%FREYA_ELECTRON%" "%~dp0."
exit /b 0
