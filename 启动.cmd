@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 第一次运行，正在安装桌面窗口组件（约 100MB）...
  where npm >nul 2>nul || (echo 没有找到 Node.js，请先安装：https://nodejs.org/ & pause & exit /b 1)
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --no-fund --no-audit || (pause & exit /b 1)
  node node_modules\electron\install.js || (pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
