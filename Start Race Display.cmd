@echo off
setlocal
title FPV Race Display Starter
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found on PATH.
    echo Install Node.js 20 or newer, then run this starter again.
    pause
    exit /b 1
)

start "FPV Race Display Server" /D "%~dp0" cmd.exe /k npm run web

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$url = 'http://127.0.0.1:4185/';" ^
    "$deadline = (Get-Date).AddSeconds(20);" ^
    "while ((Get-Date) -lt $deadline) {" ^
    "    try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { Start-Process $url; exit 0 } } catch {}" ^
    "    Start-Sleep -Milliseconds 250" ^
    "}" ^
    "Write-Host 'The FPV Race Display server did not become ready within 20 seconds.' -ForegroundColor Red;" ^
    "exit 1"

if errorlevel 1 (
    echo The server did not start. Check the FPV Race Display Server window for the error.
    pause
    exit /b 1
)

echo The WebUI was opened at http://127.0.0.1:4185/
exit /b 0
