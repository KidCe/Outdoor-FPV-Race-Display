@echo off
setlocal
title FPV Race Day Hub Starter
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found on PATH.
    echo Install Node.js 20 or newer, then run this starter again.
    pause
    exit /b 1
)

set "LIVETIME_QUE_ROOT=%~dp0..\LiveTimeQue"
if not defined FPV_HUB_SOURCE_URL set "FPV_HUB_SOURCE_URL=https://techdroneleague.livefpv.com/"
if not defined FPV_HUB_WRITE_PASSWORD set "FPV_HUB_WRITE_PASSWORD=local-race-day"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%~dp0';" ^
    "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4185 -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run web' -WorkingDirectory $root }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%~dp0'; $connectorRoot = Join-Path $root '..\LiveTimeQue';" ^
    "Start-Sleep -Seconds 1;" ^
    "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4174 -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run server' -WorkingDirectory $connectorRoot }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%~dp0';" ^
    "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4175 -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run hub' -WorkingDirectory $root }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$urls = @(" ^
    "  'http://127.0.0.1:4175/admin'," ^
    "  'http://127.0.0.1:4185/?hub=http://127.0.0.1:4175'," ^
    "  'http://127.0.0.1:4174/?backend=hub&hub=http://127.0.0.1:4175&variant=A'" ^
    ");" ^
    "$deadline = (Get-Date).AddSeconds(30);" ^
    "while ((Get-Date) -lt $deadline) {" ^
    "  $ready = $true;" ^
    "  foreach ($url in $urls) { try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) { $ready = $false } } catch { $ready = $false } }" ^
    "  if ($ready) { foreach ($url in $urls) { Start-Process $url }; exit 0 }" ^
    "  Start-Sleep -Milliseconds 500" ^
    "}" ^
    "Write-Host 'One or more race-day services did not become ready within 30 seconds.' -ForegroundColor Red;" ^
    "exit 1"

if errorlevel 1 (
    echo Check the FPV Race Display Server and Race Data Hub console windows for details.
    pause
    exit /b 1
)

echo Race Data Hub, Race Display Control Desk, and LiveTimeQue were opened.
echo Hub announcements: http://127.0.0.1:4175/admin
echo Local announcement password: local-race-day
exit /b 0
