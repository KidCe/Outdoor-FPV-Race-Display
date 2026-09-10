@echo off
setlocal
title FPV Race-Day Simulator Starter
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found on PATH.
    echo Install Node.js 20 or newer, then run this starter again.
    pause
    exit /b 1
)

set "LIVETIMEQUE_ROOT=%~dp0..\LiveTimeQue"
set "FIXTURE_STATE=%~dp0data\e2e-fixture-state.json"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%~dp0';" ^
    "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4185 -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run web' -WorkingDirectory $root }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%~dp0'; $connectorRoot = Join-Path $root '..\LiveTimeQue';" ^
    "Start-Sleep -Seconds 1;" ^
    "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4174 -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run server' -WorkingDirectory $connectorRoot }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%~dp0'; $state = Join-Path $root 'data\e2e-fixture-state.json';" ^
    "if (-not (Get-NetTCPConnection -State Listen -LocalPort 4175 -ErrorAction SilentlyContinue)) { $env:FPV_E2E_PORT = '4175'; $env:FPV_E2E_STATE_PATH = $state; $env:FPV_E2E_EPOCH = 'race-day-simulator'; $env:FPV_E2E_SEED = '1'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'node scripts\race-day-fixture-server.mjs' -WorkingDirectory $root } else { Write-Host 'Port 4175 is already in use. The simulator requires the Fixture Hub on this port.' -ForegroundColor Yellow }"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$urls = @('http://127.0.0.1:4175/simulator','http://127.0.0.1:4185/?hub=http://127.0.0.1:4175','http://127.0.0.1:4174/?backend=hub&hub=http://127.0.0.1:4175&variant=A');" ^
    "$deadline = (Get-Date).AddSeconds(30);" ^
    "while ((Get-Date) -lt $deadline) { $ready = $true; foreach ($url in $urls) { try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) { $ready = $false } } catch { $ready = $false } }; if ($ready) { foreach ($url in $urls) { Start-Process $url }; exit 0 }; Start-Sleep -Milliseconds 500 };" ^
    "Write-Host 'One or more simulator services did not become ready within 30 seconds.' -ForegroundColor Red; exit 1"

if errorlevel 1 (
    echo Check the local server console windows for details.
    pause
    exit /b 1
)

echo Race-Day Simulator, Race Display Control Desk, and LiveTimeQue were opened.
echo Simulator: http://127.0.0.1:4175/simulator
exit /b 0
