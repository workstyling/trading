@echo off
title Trading Server
echo Killing old node processes on port 3847...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3847 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Starting server with auto-restart...
node start.js
pause
