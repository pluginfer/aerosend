@echo off
echo ========================================
echo   AeroSend Desktop - Quick Launcher
echo ========================================
echo.
echo Starting AeroSend Desktop App...
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo [ERROR] Dependencies not installed!
    echo Please run install.bat first.
    pause
    exit /b 1
)

REM Launch Electron
npm run electron

pause
