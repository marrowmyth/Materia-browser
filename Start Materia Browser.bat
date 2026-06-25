@echo off
title Materia Browser
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo Launching Materia Browser...
echo (Keep this window open while the browser is running.)
call npm start
echo.
echo Materia Browser closed. Press any key to exit.
pause >nul
