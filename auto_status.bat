@echo off
echo ===== CompetitorStockHourly status =====
powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName 'CompetitorStockHourly' -ErrorAction SilentlyContinue; if (-not $t) { 'Status : OFF (not registered)' } else { $i = $t | Get-ScheduledTaskInfo; if ($t.State -eq 'Disabled') { 'Status : OFF (disabled)' } else { 'Status : ON (' + $t.State + ')' }; 'Last run : ' + $i.LastRunTime; 'Last result : ' + $i.LastTaskResult + '  (0 = OK)'; 'Next run : ' + $i.NextRunTime }"
echo.
pause
