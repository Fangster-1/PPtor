@echo off
rem PPtor launcher - double click to start the desktop pet.
rem Uses %~dp0 so the script works from any folder, including paths with CJK characters.
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem Some IDEs inject this; it would degrade Electron into plain Node.
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo  [ERROR] Electron runtime not found.
  echo  Please run:  npm install
  echo.
  pause
  exit /b 1
)

echo Starting PPtor...
start "" "node_modules\electron\dist\electron.exe" . %*
exit /b 0
