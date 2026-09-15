@echo off
rem Double-click to start the local SearXNG instance for LM Studio web-tools.
rem Runs start-searxng.ps1 with the execution policy relaxed for this process only (Windows
rem PowerShell's default policy blocks .ps1 files, even via "Run with PowerShell").
setlocal
set "SHELL_EXE=powershell.exe"
where pwsh.exe >nul 2>nul && set "SHELL_EXE=pwsh.exe"

"%SHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-searxng.ps1" %*
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo SearXNG did not start. Read the message above, then press any key to close.
  pause >nul
) else (
  rem Brief pause so the success message is readable; errors (e.g. no console) are harmless.
  timeout /t 3 >nul 2>nul
)
exit /b %RESULT%
