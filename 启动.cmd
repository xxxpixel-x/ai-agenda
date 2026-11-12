@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 第一次运行，正在安装桌面窗口组件（约 100MB）...
  where node >nul 2>nul || (echo 没有找到 Node.js，请先安装 22.12.0 或以上版本：https://nodejs.org/ & pause & exit /b 1)
  where npm >nul 2>nul || (echo 没有找到 npm，请重新安装 Node.js：https://nodejs.org/ & pause & exit /b 1)
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)" || (echo 请升级 Node.js 到 22.12.0 或以上版本。 & pause & exit /b 1)
  if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm ci --no-fund --no-audit || (pause & exit /b 1)
  node node_modules\electron\install.js || (pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
