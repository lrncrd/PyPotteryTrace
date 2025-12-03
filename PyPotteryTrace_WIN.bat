@echo off
setlocal
TITLE PyPotteryTrace Interactive

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

REM Check/Create Virtual Environment
if not exist ".venv" (
    echo [*] Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo [!] Error: Failed to create virtual environment
        pause
        exit /b 1
    )
    echo [✓] Virtual environment created
) else (
    echo [✓] Virtual environment found
)

echo.
echo [*] Activating virtual environment...
call .venv\Scripts\activate.bat
if errorlevel 1 (
    echo [!] Error: Failed to activate virtual environment
    pause
    exit /b 1
)

echo.
echo [*] Checking dependencies...
python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo [*] Installing dependencies from requirements.txt...
    echo     This may take a few minutes...
    python -m pip install --upgrade pip
    pip install -r requirements.txt
    if errorlevel 1 (
        echo [!] Error: Failed to install dependencies
        pause
        exit /b 1
    )
    echo [✓] Dependencies installed successfully
) else (
    echo [✓] Dependencies already installed
)

echo.
echo ======================================================
echo Starting PyPotteryTrace Interactive...
echo ======================================================
echo.
echo The application will be available at:
echo   http://localhost:5004
echo.
echo Press Ctrl+C to stop the server
echo ======================================================
echo.

python app.py

pause
