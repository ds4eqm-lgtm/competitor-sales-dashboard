@echo off
cd /d "%~dp0"

echo Running stock check...
python track.py

echo Uploading to GitHub...
git add data
git commit -m "stock update"
git push

echo Done.
pause
