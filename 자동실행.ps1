#requires -version 5.1
# Windows Task Scheduler가 10분마다 실행: 설정 간격이 지났을 때만 Chrome 탭을 순차적으로 엽니다.
param([string]$DashboardUrl='')
$ErrorActionPreference='Stop'
$home = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $DashboardUrl) { $DashboardUrl=(Get-Content (Join-Path $home '대시보드주소.txt') -Raw).Trim() }
$DashboardUrl=$DashboardUrl.TrimEnd('/')+'/'
$uri=[Uri]$DashboardUrl
if ($uri.Scheme -ne 'https' -or $uri.Host -notmatch '^[a-z0-9-]+\.github\.io$') { throw '정상 GitHub Pages 주소를 입력하세요.' }
$mutex=New-Object System.Threading.Mutex($false,'Local\CompetitorInsightCollector')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  $settings=Invoke-RestMethod -Uri ($DashboardUrl+'config/settings.json?v='+(Get-Date).Ticks) -TimeoutSec 20
  $interval=[int]$settings.intervalMinutes
  if ($interval -notin @(10,20,30,40,50,60)) { throw '지원하지 않는 간격' }
  $state=Join-Path $home '마지막실행.txt'
  if (Test-Path $state) { try { $previous=[DateTime]::Parse((Get-Content $state -Raw).Trim()); if (((Get-Date)-$previous).TotalMinutes -lt ($interval-1)) { exit 0 } } catch {} }
  $chrome=@("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) { throw 'Chrome이 설치되어 있지 않습니다' }
  # 각 방문 탭은 Tampermonkey가 최대 네 개씩 생성·닫습니다.
  # 브라우저가 실행되는 로그인된 사용자 세션이 필수입니다.
  (Get-Date).ToString('o') | Set-Content -Path $state -Encoding UTF8
  Start-Process -FilePath $chrome -ArgumentList @('--new-window',($DashboardUrl+'#collect'))
  ('{0:o} 수집 실행 요청' -f (Get-Date)) | Add-Content (Join-Path $home '실행기록.log') -Encoding UTF8
} catch { ('{0:o} 오류 {1}' -f (Get-Date),$_.Exception.Message) | Add-Content (Join-Path $home '실행기록.log') -Encoding UTF8;throw }
finally { $mutex.ReleaseMutex();$mutex.Dispose() }
