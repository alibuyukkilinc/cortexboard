@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title Cortex - baslatici

:menu
cls
echo.
echo  ==========================================
echo    CORTEX - neyi baslatmak istiyorsun?
echo  ==========================================
echo.
echo   SUNUCULAR (yeni pencerede acilir)
echo    1) Board          node dist/cli.js start        (once build gerekir)
echo    2) Board (dev)    npm run dev -- start          (tsx, build gerekmez)
echo    3) UI gelistirme  API :4747 + Vite :5173        (iki pencere)
echo    4) Hub            node dist/cli.js hub start
echo    5) npx            npx cortexboard@latest start  (yayindaki surum)
echo.
echo   KOMUTLAR (bu pencerede calisir)
echo    6) Build          npm run build
echo    7) Test           npm test
echo    8) Typecheck      npm run typecheck
echo    9) Lint           npm run lint
echo   10) Login linki    node dist/cli.js login
echo   11) Reindex        node dist/cli.js reindex
echo   12) npm install
echo   13) Kontrol hepsi  typecheck + lint + test + build
echo.
echo    0) Cikis
echo.
set "choice="
set /p "choice=  Secimin: "

if "%choice%"=="1"  start "Cortex Board" cmd /k node dist/cli.js start & goto menu
if "%choice%"=="2"  start "Cortex Board (dev)" cmd /k npm run dev -- start & goto menu
if "%choice%"=="3"  goto uidev
if "%choice%"=="4"  start "Cortex Hub" cmd /k node dist/cli.js hub start & goto menu
if "%choice%"=="5"  start "Cortex (npx)" cmd /k npx cortexboard@latest start & goto menu
if "%choice%"=="6"  call :run npm run build
if "%choice%"=="7"  call :run npm test
if "%choice%"=="8"  call :run npm run typecheck
if "%choice%"=="9"  call :run npm run lint
if "%choice%"=="10" call :run node dist/cli.js login
if "%choice%"=="11" call :run node dist/cli.js reindex
if "%choice%"=="12" call :run npm install
if "%choice%"=="13" goto checkall
if "%choice%"=="0"  exit /b 0
goto menu

:uidev
start "Cortex API :4747" cmd /k npm run dev -- start
start "Cortex Vite :5173" cmd /k npm run dev:web
echo.
echo  Iki pencere acildi. Tarayicida: http://localhost:5173
pause
goto menu

:checkall
echo.
call npm run typecheck && call npm run lint && call npm test && call npm run build
if errorlevel 1 (echo. & echo  [HATA] Bir adim basarisiz oldu.) else (echo. & echo  [OK] Hepsi gecti.)
pause
goto menu

:run
echo.
echo  ^> %*
echo.
call %*
echo.
if errorlevel 1 (echo  [HATA] cikis kodu %errorlevel%) else (echo  [OK] bitti)
pause
goto :eof
