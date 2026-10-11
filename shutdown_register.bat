@echo off
rem ===== Change the time here (24h, HH:MM) =====
set SHUTDOWN_TIME=18:20
rem =============================================
echo Registering daily shutdown at %SHUTDOWN_TIME%
schtasks /create /tn "CompetitorStockShutdown" /sc daily /st %SHUTDOWN_TIME% /tr "shutdown /s /t 300 /c \"PC will shut down in 5 minutes. To cancel: Win+R, type shutdown /a\"" /f
if %ERRORLEVEL% EQU 0 (
  echo.
  echo OK. Every day at %SHUTDOWN_TIME% a 5-minute warning appears, then the PC shuts down.
  echo To cancel that day: press Win+R, type  shutdown /a  and press Enter.
) else (
  echo.
  echo Failed. Right-click this file and choose Run as administrator.
)
pause
