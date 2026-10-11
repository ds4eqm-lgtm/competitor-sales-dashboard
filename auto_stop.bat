@echo off
echo Removing hourly task: CompetitorStockHourly
schtasks /delete /tn "CompetitorStockHourly" /f
pause
