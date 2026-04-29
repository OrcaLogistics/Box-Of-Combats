@echo off
echo ============================================
echo   Box of Combats - Setup
echo ============================================
echo.
echo This will install all required dependencies.
echo Make sure Node.js is installed first!
echo (Download from https://nodejs.org if needed)
echo.
pause

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org
    echo Then run this script again.
    echo.
    pause
    exit /b 1
)

echo.
echo Node.js found:
node --version
echo.

echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm install failed.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo Next steps:
echo   1. Run START_SERVER.bat  (start the server)
echo   2. Run START_CLIENT.bat  (start the app)
echo.
pause
