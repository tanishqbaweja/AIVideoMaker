@echo off
setlocal

cd /d "H:\Github Repositories\AIVideoMaker\India"
echo [%date% %time%] Automation run starting...

powershell -NoProfile -ExecutionPolicy Bypass -File "H:\Github Repositories\AIVideoMaker\India\run_automation_headless.ps1" -ShowProgress
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] Automation run finished with exit code %EXIT_CODE%.
exit /b %EXIT_CODE%
