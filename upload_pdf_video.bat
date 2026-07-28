@echo off
setlocal

cd /d "H:\Github Repositories\AIVideoMaker"
set "PYTHONIOENCODING=utf-8"

python scripts\upload_pdf_video.py %*
set "EXIT_CODE=%ERRORLEVEL%"

exit /b %EXIT_CODE%
