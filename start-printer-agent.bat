@echo off
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul
if errorlevel 9009 goto NODE_MISSING
echo [printer-agent] starting... keep this window open while using the printers page.
echo [printer-agent] close this window to stop the service.
echo.
node server\printer-agent.js
echo.
echo [printer-agent] service exited. close this window to dismiss.
pause
exit /b 0

:NODE_MISSING
echo [printer-agent] ERROR: node.exe was not found on PATH.
echo   Install Node.js 22 or newer, then double-click this file again.
echo   Alternatively open a terminal in this folder and run: node server\printer-agent.js
pause
exit /b 1
