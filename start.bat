@echo off
title OmniBridge - Initialization
color 0B

echo.
echo ==================================================================
echo                   OMNIBRIDGE INITIALIZATION
echo ==================================================================
echo.
echo [SYSTEM] Booting up Antigravity Control Interface...
echo [SYSTEM] Establishing connection...
echo.

:: Automatically set the working directory to the script's location
cd /d "%~dp0"

npm start

echo.
echo [ERROR] OmniBridge Process Terminated unexpectedly.
pause