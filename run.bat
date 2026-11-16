@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0resources\app.pending.asar" (
  copy /Y "%~dp0resources\app.pending.asar" "%~dp0resources\app.asar" >nul
  if not errorlevel 1 del /Q "%~dp0resources\app.pending.asar" >nul 2>&1
)
set "MUSE_AUTOMATION_HOME=%~dp0"
start "Muse Automation" /D "%~dp0" "%~dp0Muse Automation.exe"
endlocal

