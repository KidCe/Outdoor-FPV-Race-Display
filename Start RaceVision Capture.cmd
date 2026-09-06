@echo off
setlocal
title RaceVision LiveTime Capture
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-racevision-capture.ps1"
set "CAPTURE_EXIT=%ERRORLEVEL%"
echo.
if not "%CAPTURE_EXIT%"=="0" echo Capture stopped with exit code %CAPTURE_EXIT%.
pause
exit /b %CAPTURE_EXIT%

