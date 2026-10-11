@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo Uploading products.txt to GitHub (no tabs are opened)...
git add products.txt
git commit -m "update product list"
set RETRY=0
:PUSHLOOP
git pull origin main --no-rebase --no-edit
git push
if !ERRORLEVEL! NEQ 0 (
  set /a RETRY+=1
  if !RETRY! LSS 5 (
    echo Push conflict, retrying in 5 seconds... attempt !RETRY!
    timeout /t 5 /nobreak >nul
    goto PUSHLOOP
  ) else (
    echo FAILED. Take a photo of this window and send it.
  )
) else (
  echo.
  echo OK. Dashboard will show the change within about 5 minutes.
)
pause
