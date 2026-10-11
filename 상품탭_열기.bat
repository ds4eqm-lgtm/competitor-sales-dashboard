@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Opening product pages from list...
for /f "usebackq tokens=1" %%u in (`findstr /b /i "http" "products.txt"`) do (
  start "" "chrome.exe" "%%u#autotrack"
  timeout /t 4 /nobreak >nul
)
timeout /t 30 /nobreak >nul
echo Uploading all results at once...
start "" "chrome.exe" "https://yongki9156.github.io/competitor-stock/#flush"

echo Waiting for background sync to finish...
timeout /t 45 /nobreak >nul

echo Syncing product list to GitHub...
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
    echo Push failed after several attempts. Run this file again later.
  )
) else (
  echo Sync successful.
)

echo Done.
pause
