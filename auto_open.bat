@echo off
rem Hourly auto check (only lines starting with http are opened)
rem Each product tab saves its result inside Tampermonkey and closes right away.
rem At the end one dashboard tab (#flush) uploads all results to GitHub at once.
cd /d "%~dp0"
for /f "usebackq tokens=1" %%u in (`findstr /b /i "http" "products.txt"`) do (
  start "" "chrome.exe" "%%u#autotrack"
  timeout /t 4 /nobreak >nul
)
timeout /t 30 /nobreak >nul
start "" "chrome.exe" "https://yongki9156.github.io/competitor-stock/#flush"
exit
