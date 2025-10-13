@echo off
REM PyPotteryTrace Interactive - Windows Launch Script
REM This script launches the interactive web application

echo ======================================================
echo PyPotteryTrace Interactive
echo ======================================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo Error: Python is not installed or not in PATH
    echo Please install Python 3.8+ from python.org
    pause
    exit /b 1
)

echo Starting PyPotteryTrace Interactive...
echo.
echo The application will be available at:
echo   http://localhost:5000
echo.
echo Press Ctrl+C to stop the server
echo ======================================================
echo.

REM Run the launcher script
python launch_interactive.py

pause
