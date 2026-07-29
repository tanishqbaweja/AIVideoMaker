@echo off
setlocal

cd /d "H:\Github Repositories\AIVideoMaker"
echo [%date% %time%] PDFomni upload starting...

powershell -NoProfile -ExecutionPolicy Bypass -File "H:\Github Repositories\AIVideoMaker\run_automation_headless.ps1" -ShowProgress -PdfOnly
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] PDFomni upload finished with exit code %EXIT_CODE%.
exit /b %EXIT_CODE%
