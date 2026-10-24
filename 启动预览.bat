@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if "%PY%"=="" ( where py >nul 2>nul && set "PY=py" )
if "%PY%"=="" if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if "%PY%"=="" (
  echo.
  echo   没有找到 Python。可以直接双击 out\SpendLens.html 打开，
  echo   只是"直连本机目录"可能被浏览器拦下，改用"拖入或选择文件夹"即可。
  echo.
  pause
  exit /b 1
)

echo.
echo   workbuddy-spendLens · 我帮你省钱
echo   地址： http://127.0.0.1:8765/workbuddy-spendLens.html
echo   关闭这个窗口即停止服务。
echo.

start "" "http://127.0.0.1:8765/workbuddy-spendLens.html"
%PY% -m http.server 8765 --bind 127.0.0.1 --directory out
