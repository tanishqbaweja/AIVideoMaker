@echo off
setlocal EnableDelayedExpansion

cd /d "H:\Github Repositories\AIVideoMaker"
set "ATTEMPT=%~1"
if not defined ATTEMPT set "ATTEMPT=1"
set "MAX_ATTEMPTS=%~2"
if not defined MAX_ATTEMPTS set "MAX_ATTEMPTS=10"

:retry
echo [%date% %time%] Contingency retry attempt !ATTEMPT! of !MAX_ATTEMPTS! starting...

set "SHOW_PRE_RENDER_ALERT=0"
if !ATTEMPT! GEQ !MAX_ATTEMPTS! set "SHOW_PRE_RENDER_ALERT=1"

powershell -NoProfile -Command "& { $env:VGEN_SHOW_PRE_RENDER_ALERT='!SHOW_PRE_RENDER_ALERT!'; $utf8 = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $utf8; Remove-Item 'automation.log' -Force -ErrorAction SilentlyContinue; python scripts/automate.py --contingency-retry 2>&1 | ForEach-Object { $line = $_.ToString(); Write-Host $line; $line | Out-File -FilePath 'automation.log' -Encoding utf8 -Append }; $code = $LASTEXITCODE; exit $code }"
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] Contingency retry finished with exit code %EXIT_CODE%.

if "%EXIT_CODE%"=="10" (
  if !ATTEMPT! GEQ !MAX_ATTEMPTS! (
    echo [%date% %time%] Pre-video failure limit reached after !MAX_ATTEMPTS! attempts.
    exit /b 10
  )
  set /a ATTEMPT+=1
  echo [%date% %time%] Pre-video failure happened again. Relaunching attempt !ATTEMPT! of !MAX_ATTEMPTS!...
  goto retry
)

exit /b %EXIT_CODE%
