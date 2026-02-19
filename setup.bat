@echo off
echo Setting up woodbury...
echo.

echo [1/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    exit /b 1
)

echo.
echo [2/3] Building...
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Build failed
    exit /b 1
)

echo.
echo [3/3] Linking globally...
call npm link
if %errorlevel% neq 0 (
    echo ERROR: npm link failed
    exit /b 1
)

echo.
echo Setup complete! You can now run "woodbury" from any directory.
echo.
echo Quick start:
echo   woodbury                          Interactive REPL mode
echo   woodbury "describe this project"  One-shot mode
echo   woodbury --help                   Show all options
