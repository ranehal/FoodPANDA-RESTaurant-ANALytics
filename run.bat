@echo off
title FoodPANDA // Restaurant Intelligence
cd /d "%~dp0"

echo  ==========================================
echo   FoodPANDA // Restaurant Intelligence
echo  ==========================================
echo.
echo  [1] Run Scraper
echo  [2] Start Dashboard
echo  [3] Run Scraper + Dashboard
echo  [4] Scrape + Dashboard (Auto-Open)
echo.
set /p choice="Select (1-4): "

if "%choice%"=="1" goto scraper
if "%choice%"=="2" goto dashboard
if "%choice%"=="3" goto both
if "%choice%"=="4" goto autoopen
goto dashboard

:scraper
echo.
echo [SCRAPER] Starting FoodPANDA menu scraper...
python scrape_menus.py
echo.
echo [SCRAPER] Done. Press any key to exit.
pause >nul
exit /b 0

:dashboard
echo.
echo [DASHBOARD] Starting on http://localhost:8081
echo [DASHBOARD] Press Ctrl+C to stop.
echo.
cd /d "%~dp0restaurant_dashboard"
python -m http.server 8081
pause
exit /b 0

:both
echo.
echo [SCRAPER] Running scraper first...
python scrape_menus.py
echo.
echo [DASHBOARD] Starting dashboard on http://localhost:8081
echo.
cd /d "%~dp0restaurant_dashboard"
python -m http.server 8081
pause
exit /b 0

:autoopen
echo.
echo [SCRAPER] Running scraper first...
python scrape_menus.py
echo.
echo [DASHBOARD] Starting dashboard on http://localhost:8081
echo [BROWSER] Opening http://localhost:8081 in browser...
cd /d "%~dp0restaurant_dashboard"
start "" "http://localhost:8081"
python -m http.server 8081
pause
exit /b 0
