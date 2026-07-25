@echo off
setlocal

cd /d "H:\Github Repositories\AIVideoMaker"
echo [%date% %time%] Publishing last uploaded YouTube video...

python publish_last_uploaded_video.py
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] Publish script finished with exit code %EXIT_CODE%.
exit /b %EXIT_CODE%
