@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "대시보드주소.txt" (echo 대시보드주소.txt 파일에 본인 GitHub Pages 주소를 입력하세요. & pause & exit /b 1)
rem Chrome/Tampermonkey는 로그인된 사용자 세션에서만 실행 가능. 네트워크 로그인 전 자동실행을 보장하지 않음.
schtasks /Create /TN "CompetitorInsightCollector" /SC MINUTE /MO 10 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0자동실행.ps1\"" /RU "%USERDOMAIN%\%USERNAME%" /IT /F
if errorlevel 1 (echo 등록 실패. 윈도우 작업 스케줄러에서 사용자 권한을 확인하세요.) else (echo 10분마다 검사하도록 예약됨. 실제 수집 간격은 대시보드 설정을 따릅니다.)
pause
