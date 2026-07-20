@echo off
echo ========================================
echo   AeroSend - Launching Web Application
echo ========================================
echo.
echo Starting browser at: http://localhost:3000/?testmode=true
echo.
timeout /t 2 /nobreak >nul
start http://localhost:3000/?testmode=true
echo.
echo Browser should open automatically!
echo If not, manually navigate to: http://localhost:3000/?testmode=true
echo.
pause
