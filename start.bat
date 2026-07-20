@echo off
echo Starting AeroSend...
echo Please ensure both devices are on the same WiFi network.
echo Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"
npm start
pause
