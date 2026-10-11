@echo off
cd /d "%~dp0"
echo Registering hourly task: CompetitorStockHourly
schtasks /create /tn "CompetitorStockHourly" /sc hourly /mo 1 /st 00:01 /tr "\"%~dp0auto_open.bat\"" /f
if %ERRORLEVEL% EQU 0 (
  echo.
  echo OK. Product pages will open automatically at minute 01 of every hour.
  echo Test now: schtasks /run /tn "CompetitorStockHourly"
) else (
  echo.
  echo Failed. Right-click this file and choose Run as administrator.
)
pause
