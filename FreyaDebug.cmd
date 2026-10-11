@echo off
cd /d "%~dp0"
node scripts\debug-stack.mjs %*
if errorlevel 1 pause
